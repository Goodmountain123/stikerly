import { supabase, supabaseConfigured, publicAssetUrl } from "./supabase.js";

const $ = (selector) => document.querySelector(selector);
const setup = $("#setup");
const login = $("#login");
const dashboard = $("#dashboard");
const logout = $("#logout");
const selectedPacks = new Map();
const selectedBackgrounds = new Map();

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
}

function autoSave(input, save) {
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!input.value.trim()) return;
      const error = await save(input.value.trim());
      input.classList.toggle("has-error", Boolean(error));
    }, 500);
  });
}

function updatePackSelection() {
  $("#pack-selection-count").textContent = `선택 ${selectedPacks.size}개`;
  $("#delete-selected-packs").disabled = selectedPacks.size === 0;
}

function updateBackgroundSelection() {
  $("#background-selection-count").textContent = `선택 ${selectedBackgrounds.size}개`;
  $("#delete-selected-backgrounds").disabled = selectedBackgrounds.size === 0;
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
  setup.hidden = true;
  const isAdmin = await ensureAdmin();
  login.hidden = isAdmin;
  dashboard.hidden = !isAdmin;
  logout.hidden = !isAdmin;
  if (isAdmin) {
    const { data } = await supabase
      .from("app_settings").select("value").eq("key", "assets_source").maybeSingle();
    $("#import-box").hidden = data?.value === "supabase";
    await renderAll();
  }
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
    $("#import-box").hidden = true;
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

$("#delete-selected-packs").addEventListener("click", async () => {
  if (!selectedPacks.size || !confirm(`선택한 스티커팩 ${selectedPacks.size}개를 제거할까요?`)) return;
  for (const pack of selectedPacks.values()) {
    const { error } = await supabase.from("sticker_packs").delete().eq("id", pack.id);
    if (error) return toast("일부 팩을 제거하지 못했어요.");
    const paths = pack.stickers.map((item) => item.storage_path);
    if (paths.length) await supabase.storage.from("assets").remove(paths);
  }
  selectedPacks.clear();
  updatePackSelection();
  await renderPacks();
});

$("#delete-selected-backgrounds").addEventListener("click", async () => {
  if (!selectedBackgrounds.size || !confirm(`선택한 배경 ${selectedBackgrounds.size}개를 제거할까요?`)) return;
  for (const background of selectedBackgrounds.values()) {
    const { error } = await supabase.from("backgrounds").delete().eq("id", background.id);
    if (error) return toast("일부 배경을 제거하지 못했어요.");
    await supabase.storage.from("assets").remove([background.storage_path]);
  }
  selectedBackgrounds.clear();
  updateBackgroundSelection();
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
  updatePackSelection();
}

function packCard(pack) {
  const card = document.createElement("details");
  card.className = "pack";
  const thumbnail = pack.stickers[0]
    ? publicAssetUrl(pack.stickers[0].storage_path)
    : "";
  card.innerHTML = `
    <summary class="pack__summary">
      <input class="select-box pack-select" type="checkbox" aria-label="팩 선택">
      ${thumbnail ? `<img src="${thumbnail}" alt="">` : `<span class="pack__empty">＋</span>`}
      <span class="pack__summary-main">
        <span class="pack__summary-name">${escapeHtml(pack.name)}</span>
        <span class="pack__summary-count">스티커 ${pack.stickers.length}개</span>
      </span>
      <span class="pack__chevron">⌄</span>
    </summary>
    <div class="pack__body">
      <div class="pack__top">
        <input class="pack-name" value="${escapeHtml(pack.name)}" aria-label="팩 이름">
        <span class="auto-save-note">자동 저장</span>
      </div>
      <form class="upload">
        <strong>스티커 추가</strong>
        <div class="form">
          <input class="sticker-files" type="file" accept="image/*" multiple required>
          <button class="button">선택한 이미지 추가</button>
        </div>
      </form>
      <div class="pack-tools">
        <span class="sticker-selection-count">선택 0개</span>
        <button class="button danger delete-selected-stickers" disabled>선택한 스티커 제거</button>
      </div>
      <div class="stickers"></div>
    </div>`;

  const packSelect = card.querySelector(".pack-select");
  packSelect.checked = selectedPacks.has(pack.id);
  packSelect.addEventListener("click", (event) => event.stopPropagation());
  packSelect.addEventListener("change", () => {
    if (packSelect.checked) selectedPacks.set(pack.id, pack);
    else selectedPacks.delete(pack.id);
    updatePackSelection();
  });
  card.addEventListener("toggle", () => {
    if (!card.open) return;
    card.parentElement.querySelectorAll(".pack[open]").forEach((other) => {
      if (other !== card) other.open = false;
    });
  });

  const packName = card.querySelector(".pack-name");
  autoSave(packName, async (name) => {
    const { error } = await supabase.from("sticker_packs").update({ name }).eq("id", pack.id);
    if (!error) card.querySelector(".pack__summary-name").textContent = name;
    return error;
  });

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
  const selectedStickers = new Map();
  const deleteSelected = card.querySelector(".delete-selected-stickers");
  const selectionCount = card.querySelector(".sticker-selection-count");
  const updateStickerSelection = () => {
    selectionCount.textContent = `선택 ${selectedStickers.size}개`;
    deleteSelected.disabled = selectedStickers.size === 0;
  };
  deleteSelected.onclick = async () => {
    if (!selectedStickers.size || !confirm(`선택한 스티커 ${selectedStickers.size}개를 제거할까요?`)) return;
    const stickers = [...selectedStickers.values()];
    const { error } = await supabase.from("stickers").delete().in("id", stickers.map((item) => item.id));
    if (error) return toast("스티커를 제거하지 못했어요.");
    await supabase.storage.from("assets").remove(stickers.map((item) => item.storage_path));
    renderPacks();
  };
  const stickerList = card.querySelector(".stickers");
  pack.stickers.forEach((sticker) =>
    stickerList.appendChild(stickerCard(sticker, selectedStickers, updateStickerSelection)));
  return card;
}

function stickerCard(sticker, selection, updateSelection) {
  const item = document.createElement("div");
  item.className = "asset";
  item.innerHTML = `
    <input class="select-box" type="checkbox" aria-label="스티커 선택">
    <img src="${publicAssetUrl(sticker.storage_path)}" alt="">
    <input class="asset-name" value="${escapeHtml(sticker.name)}" aria-label="스티커 이름">`;
  const checkbox = item.querySelector(".select-box");
  checkbox.onchange = () => {
    if (checkbox.checked) selection.set(sticker.id, sticker);
    else selection.delete(sticker.id);
    item.classList.toggle("is-selected", checkbox.checked);
    updateSelection();
  };
  autoSave(item.querySelector(".asset-name"), async (name) => {
    const { error } = await supabase.from("stickers").update({ name }).eq("id", sticker.id);
    return error;
  });
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
      <input class="select-box" type="checkbox" aria-label="배경 선택">
      <img src="${publicAssetUrl(background.storage_path)}" alt="">
      <input class="asset-name" value="${escapeHtml(background.name)}" aria-label="배경 이름">`;
    const checkbox = item.querySelector(".select-box");
    checkbox.checked = selectedBackgrounds.has(background.id);
    item.classList.toggle("is-selected", checkbox.checked);
    checkbox.onchange = () => {
      if (checkbox.checked) selectedBackgrounds.set(background.id, background);
      else selectedBackgrounds.delete(background.id);
      item.classList.toggle("is-selected", checkbox.checked);
      updateBackgroundSelection();
    };
    autoSave(item.querySelector(".asset-name"), async (name) => {
      const { error: saveError } = await supabase.from("backgrounds")
        .update({ name }).eq("id", background.id);
      return saveError;
    });
    list.appendChild(item);
  });
  updateBackgroundSelection();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

updateSession();
