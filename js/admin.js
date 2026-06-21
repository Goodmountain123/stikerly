import { supabase, supabaseConfigured, publicAssetUrl } from "./supabase.js";

const $ = (selector) => document.querySelector(selector);
const setup = $("#setup");
const login = $("#login");
const dashboard = $("#dashboard");
const logout = $("#logout");

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
}

function safeFileName(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ".png";
  return `${crypto.randomUUID()}${ext.replace(/[^a-z0-9.]/g, "")}`;
}

function storageSegment(value) {
  return encodeURIComponent(value).replaceAll("%", "_");
}

async function fetchAsset(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`파일을 불러오지 못했어요: ${url}`);
  return response.blob();
}

async function ensureAdmin() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return false;
  const { data } = await supabase
    .from("admin_users").select("user_id").eq("user_id", user.id).maybeSingle();
  return Boolean(data);
}

async function updateSession() {
  if (!supabaseConfigured) {
    setup.hidden = false;
    login.hidden = true;
    return;
  }
  const isAdmin = await ensureAdmin();
  login.hidden = isAdmin;
  dashboard.hidden = !isAdmin;
  logout.hidden = !isAdmin;
  if (isAdmin) await renderAll();
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { error } = await supabase.auth.signInWithPassword({
    email: $("#email").value,
    password: $("#password").value,
  });
  if (error) return toast("로그인 정보를 확인해 주세요.");
  if (!await ensureAdmin()) {
    await supabase.auth.signOut();
    return toast("관리자 권한이 없어요.");
  }
  updateSession();
});

logout.addEventListener("click", async () => {
  await supabase.auth.signOut();
  updateSession();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("is-on", item === tab));
    $("#packs-panel").hidden = tab.dataset.tab !== "packs";
    $("#backgrounds-panel").hidden = tab.dataset.tab !== "backgrounds";
  });
});

$("#import-local-assets").addEventListener("click", async () => {
  const button = $("#import-local-assets");
  if (!confirm("기존 스티커팩과 배경을 Supabase로 가져올까요?")) return;
  button.disabled = true;
  button.textContent = "가져오는 중…";
  try {
    await importLocalPacks();
    await importLocalBackgrounds();
    const { error } = await supabase.from("app_settings").upsert({
      key: "assets_source",
      value: "supabase",
    });
    if (error) throw error;
    toast("모든 기존 어셋을 가져왔어요.");
    await renderAll();
  } catch (error) {
    console.error(error);
    toast("가져오지 못했어요. 최신 SQL을 다시 실행해 주세요.");
  } finally {
    button.disabled = false;
    button.textContent = "기존 어셋 가져오기";
  }
});

async function importLocalPacks() {
  const folders = await fetch("./assets/sticker_packs/index.json").then((response) => response.json());
  for (const [packIndex, folder] of folders.entries()) {
    const base = `./assets/sticker_packs/${folder}`;
    const meta = await fetch(`${base}/pack.json`).then((response) => response.json());
    const { data: pack, error: packError } = await supabase
      .from("sticker_packs")
      .upsert({
        legacy_id: meta.id,
        name: meta.name,
        position: packIndex,
      }, { onConflict: "legacy_id" })
      .select()
      .single();
    if (packError) throw packError;

    for (const [stickerIndex, fileName] of meta.stickers.entries()) {
      const path = `legacy/stickers/${storageSegment(meta.id)}/${storageSegment(fileName)}`;
      const blob = await fetchAsset(`${base}/${fileName}`);
      const { error: uploadError } = await supabase.storage
        .from("assets").upload(path, blob, { contentType: blob.type, upsert: true });
      if (uploadError) throw uploadError;
      const { error: stickerError } = await supabase.from("stickers").upsert({
        pack_id: pack.id,
        legacy_asset_id: fileName,
        name: fileName.replace(/\.[^.]+$/, ""),
        storage_path: path,
        position: stickerIndex,
      }, { onConflict: "pack_id,legacy_asset_id" });
      if (stickerError) throw stickerError;
    }
  }
}

async function importLocalBackgrounds() {
  const backgrounds = await fetch("./assets/backgrounds/index.json").then((response) => response.json());
  for (const [index, background] of backgrounds.entries()) {
    const path = `legacy/backgrounds/${storageSegment(background.file)}`;
    const blob = await fetchAsset(`./assets/backgrounds/${background.file}`);
    const { error: uploadError } = await supabase.storage
      .from("assets").upload(path, blob, { contentType: blob.type, upsert: true });
    if (uploadError) throw uploadError;
    const { error } = await supabase.from("backgrounds").upsert({
      legacy_id: background.id,
      name: background.name,
      storage_path: path,
      position: index,
    }, { onConflict: "legacy_id" });
    if (error) throw error;
  }
}

$("#pack-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const { error } = await supabase.from("sticker_packs").insert({
    name: $("#pack-name").value.trim(),
    position: Date.now(),
  });
  if (error) return toast("팩을 추가하지 못했어요.");
  event.target.reset();
  await renderPacks();
});

$("#background-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = $("#background-file").files[0];
  const path = `backgrounds/${safeFileName(file.name)}`;
  const upload = await supabase.storage.from("assets").upload(path, file);
  if (upload.error) return toast("이미지 업로드에 실패했어요.");
  const { error } = await supabase.from("backgrounds").insert({
    name: $("#background-name").value.trim(),
    storage_path: path,
    position: Date.now(),
  });
  if (error) {
    await supabase.storage.from("assets").remove([path]);
    return toast("배경을 등록하지 못했어요.");
  }
  event.target.reset();
  await renderBackgrounds();
});

async function renderAll() {
  await Promise.all([renderPacks(), renderBackgrounds()]);
}

async function renderPacks() {
  const { data: packs, error } = await supabase
    .from("sticker_packs").select("*, stickers(*)")
    .order("position").order("position", { referencedTable: "stickers" });
  if (error) return toast("스티커팩을 불러오지 못했어요.");
  const list = $("#pack-list");
  list.innerHTML = "";
  packs.forEach((pack) => list.appendChild(packCard(pack)));
}

function packCard(pack) {
  const card = document.createElement("article");
  card.className = "pack";
  card.innerHTML = `
    <div class="pack__top">
      <input class="pack-name" value="${escapeHtml(pack.name)}" aria-label="팩 이름">
      <button class="button save-pack">이름 저장</button>
      <button class="button danger delete-pack">팩 제거</button>
    </div>
    <form class="upload">
      <strong>스티커 추가</strong>
      <div class="form">
        <input class="sticker-files" type="file" accept="image/*" multiple required>
        <button class="button">선택한 이미지 추가</button>
      </div>
    </form>
    <div class="stickers"></div>`;

  card.querySelector(".save-pack").onclick = async () => {
    const { error } = await supabase.from("sticker_packs")
      .update({ name: card.querySelector(".pack-name").value.trim() }).eq("id", pack.id);
    toast(error ? "이름 변경에 실패했어요." : "팩 이름을 바꿨어요.");
  };
  card.querySelector(".delete-pack").onclick = async () => {
    if (!confirm(`"${pack.name}" 팩과 스티커를 모두 제거할까요?`)) return;
    const paths = pack.stickers.map((item) => item.storage_path);
    const { error } = await supabase.from("sticker_packs").delete().eq("id", pack.id);
    if (error) return toast("팩을 제거하지 못했어요.");
    if (paths.length) await supabase.storage.from("assets").remove(paths);
    renderPacks();
  };
  card.querySelector(".upload").onsubmit = async (event) => {
    event.preventDefault();
    const files = [...card.querySelector(".sticker-files").files];
    for (const file of files) {
      const path = `stickers/${pack.id}/${safeFileName(file.name)}`;
      const uploaded = await supabase.storage.from("assets").upload(path, file);
      if (uploaded.error) continue;
      const inserted = await supabase.from("stickers").insert({
        pack_id: pack.id,
        name: file.name.replace(/\.[^.]+$/, ""),
        storage_path: path,
        position: Date.now(),
      });
      if (inserted.error) await supabase.storage.from("assets").remove([path]);
    }
    await renderPacks();
  };
  const stickerList = card.querySelector(".stickers");
  pack.stickers.forEach((sticker) => stickerList.appendChild(stickerCard(sticker)));
  return card;
}

function stickerCard(sticker) {
  const item = document.createElement("div");
  item.className = "asset";
  item.innerHTML = `
    <img src="${publicAssetUrl(sticker.storage_path)}" alt="">
    <input value="${escapeHtml(sticker.name)}" aria-label="스티커 이름">
    <div class="asset__actions">
      <button class="button save">저장</button>
      <button class="button danger remove">제거</button>
    </div>`;
  item.querySelector(".save").onclick = async () => {
    const { error } = await supabase.from("stickers")
      .update({ name: item.querySelector("input").value.trim() }).eq("id", sticker.id);
    toast(error ? "변경에 실패했어요." : "이름을 바꿨어요.");
  };
  item.querySelector(".remove").onclick = async () => {
    if (!confirm("이 스티커를 제거할까요?")) return;
    const { error } = await supabase.from("stickers").delete().eq("id", sticker.id);
    if (error) return toast("제거하지 못했어요.");
    await supabase.storage.from("assets").remove([sticker.storage_path]);
    renderPacks();
  };
  return item;
}

async function renderBackgrounds() {
  const { data, error } = await supabase.from("backgrounds").select("*").order("position");
  if (error) return toast("배경을 불러오지 못했어요.");
  const list = $("#background-list");
  list.innerHTML = "";
  data.forEach((background) => {
    const item = document.createElement("div");
    item.className = "asset";
    item.innerHTML = `
      <img src="${publicAssetUrl(background.storage_path)}" alt="">
      <input value="${escapeHtml(background.name)}" aria-label="배경 이름">
      <div class="asset__actions">
        <button class="button save">저장</button>
        <button class="button danger remove">제거</button>
      </div>`;
    item.querySelector(".save").onclick = async () => {
      const { error: saveError } = await supabase.from("backgrounds")
        .update({ name: item.querySelector("input").value.trim() }).eq("id", background.id);
      toast(saveError ? "변경에 실패했어요." : "이름을 바꿨어요.");
    };
    item.querySelector(".remove").onclick = async () => {
      if (!confirm("이 배경을 제거할까요?")) return;
      const { error: removeError } = await supabase.from("backgrounds").delete().eq("id", background.id);
      if (removeError) return toast("제거하지 못했어요.");
      await supabase.storage.from("assets").remove([background.storage_path]);
      renderBackgrounds();
    };
    list.appendChild(item);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

updateSession();
