import {
  supabase,
  supabaseConfigured,
  signedAssetUrl,
} from "./supabase.js?v=20260623-2";

const $ = (selector) => document.querySelector(selector);
const setup = $("#setup");
const login = $("#login");
const dashboard = $("#dashboard");
const logout = $("#logout");
const selectedPacks = new Map();
const selectedBackgrounds = new Map();
const DEFAULT_WELCOME_MESSAGES = [
  "오늘은 뭘 하고 놀까요?",
  "어서오세요, 반가워요!",
  "예쁘게 꾸며봐요!",
];
let musicPlaylist = [];
let musicPreview = null;
let previewTrackId = null;
let modalMode = null;
let modalPack = null;
let moveAssetState = null;

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
}

async function setAssetPreview(image, storagePath) {
  if (!image || !storagePath) return;
  try {
    const url = await signedAssetUrl(storagePath);
    if (image.isConnected) image.src = url;
  } catch (error) {
    console.error("Asset preview failed", error);
  }
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

function bindSortable(container, itemSelector, table) {
  let dragged = null;
  let changed = false;

  container.addEventListener("dragstart", (event) => {
    const item = event.target.closest(itemSelector);
    const draggingPackBody =
      itemSelector === ".pack" && event.target.closest(".pack__body");
    if (!item || event.target.closest("input, button") || draggingPackBody) {
      event.preventDefault();
      return;
    }
    dragged = item;
    changed = false;
    if ("open" in item) item.open = false;
    item.classList.add("is-sorting");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.dataset.sortId);
  });

  container.addEventListener("dragover", (event) => {
    if (!dragged) return;
    event.preventDefault();
    const target = event.target.closest(itemSelector);
    if (!target || target === dragged) return;
    const rect = target.getBoundingClientRect();
    const sameRow = event.clientY > rect.top && event.clientY < rect.bottom;
    const before = sameRow
      ? event.clientX < rect.left + rect.width / 2
      : event.clientY < rect.top + rect.height / 2;
    container.insertBefore(dragged, before ? target : target.nextSibling);
    changed = true;
  });

  container.addEventListener("drop", (event) => event.preventDefault());
  container.addEventListener("dragend", async () => {
    if (!dragged) return;
    dragged.classList.remove("is-sorting");
    dragged = null;
    if (!changed) return;

    const items = [...container.querySelectorAll(itemSelector)];
    const results = await Promise.all(items.map((item, position) =>
      supabase.from(table).update({ position }).eq("id", item.dataset.sortId)
    ));
    if (results.some((result) => result.error)) {
      toast("순서를 저장하지 못했어요.");
      return;
    }
    toast("순서를 저장했어요.");
  });
}

function updatePackSelection() {
  $("#pack-selection-count").textContent = `선택 ${selectedPacks.size}개`;
  $("#delete-selected-packs").disabled = selectedPacks.size === 0;
}

function updateBackgroundSelection() {
  $("#background-selection-count").textContent = `선택 ${selectedBackgrounds.size}개`;
  $("#delete-selected-backgrounds").disabled = selectedBackgrounds.size === 0;
  $("#move-selected-unassigned-backgrounds").disabled = selectedBackgrounds.size === 0;
}

function openAssetModal(mode, pack = null) {
  modalMode = mode;
  modalPack = pack;
  $("#asset-modal-title").textContent =
    mode === "pack" ? "새 어셋 팩" : mode === "background" ? "배경 추가" : "스티커 추가";
  const nameInput = $("#asset-modal-name");
  nameInput.value = "";
  nameInput.placeholder =
    mode === "pack" ? "어셋 팩 이름" : mode === "background" ? "배경 이름" : "스티커 이름";
  nameInput.required = mode !== "sticker";
  const files = $("#asset-modal-files");
  files.value = "";
  files.hidden = mode === "pack";
  files.required = mode !== "pack";
  files.multiple = mode === "sticker";
  $("#asset-modal").hidden = false;
  $("#asset-modal-name").focus();
}

function closeAssetModal() {
  $("#asset-modal").hidden = true;
  modalMode = null;
  modalPack = null;
}

async function openMoveAssetsModal(sourcePack, assets, type) {
  let query = supabase.from("sticker_packs").select("id,name").order("position");
  if (sourcePack?.id) query = query.neq("id", sourcePack.id);
  const { data: packs, error } = await query;
  const canMoveToUnassigned = type === "background" && Boolean(sourcePack);
  if (error || (!packs?.length && !canMoveToUnassigned)) {
    return toast("이동할 다른 팩이 없어요.");
  }
  moveAssetState = { sourcePack, assets, type };
  const target = $("#move-stickers-target");
  target.innerHTML = [
    canMoveToUnassigned ? `<option value="">미분류 배경</option>` : "",
    ...(packs || []).map((pack) =>
      `<option value="${pack.id}">${escapeHtml(pack.name)}</option>`
    ),
  ].join("");
  $("#move-assets-title").textContent = type === "background" ? "배경 이동" : "스티커 이동";
  $("#move-assets-description").textContent =
    `선택한 ${type === "background" ? "배경" : "스티커"}을 이동할 팩을 골라 주세요.`;
  $("#move-stickers-modal").hidden = false;
}

function closeMoveAssetsModal() {
  $("#move-stickers-modal").hidden = true;
  moveAssetState = null;
}

function safeFileName(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ".png";
  return `${crypto.randomUUID()}${ext.replace(/[^a-z0-9.]/g, "")}`;
}

function safeAudioName(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ".mp3";
  return `${crypto.randomUUID()}${ext.replace(/[^a-z0-9.]/g, "")}`;
}

function trackNameFromFile(file) {
  return file.name.replace(/\.[^.]+$/, "").trim() || "Music";
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
    $("#messages-panel").hidden = tab.dataset.tab !== "messages";
    $("#music-panel").hidden = tab.dataset.tab !== "music";
  });
});

$("#save-welcome-messages").addEventListener("click", async () => {
  const messages = $("#welcome-messages").value
    .split("\n")
    .map((message) => message.trim())
    .filter(Boolean);
  if (!messages.length) return toast("문구를 한 개 이상 입력해 주세요.");
  const { error } = await supabase.from("app_settings").upsert({
    key: "welcome_messages",
    value: messages,
  });
  if (error) return toast("문구를 저장하지 못했어요.");
  toast("환영 문구를 저장했어요.");
});

$("#upload-music").addEventListener("click", () => $("#music-files").click());
$("#music-files").addEventListener("change", async () => {
  const files = [...$("#music-files").files];
  if (!files.length) return;
  $("#upload-music").disabled = true;
  try {
    for (const file of files) {
      const path = `music/${safeAudioName(file.name)}`;
      const upload = await supabase.storage
        .from("assets")
        .upload(path, file, { contentType: file.type || "audio/mpeg" });
      if (upload.error) throw upload.error;
      musicPlaylist.push({
        id: crypto.randomUUID(),
        name: trackNameFromFile(file),
        storage_path: path,
      });
    }
    await saveMusicPlaylist();
    renderMusicList();
    toast("음악을 추가했어요.");
  } catch (error) {
    console.error(error);
    toast("음악 업로드에 실패했어요.");
  } finally {
    $("#music-files").value = "";
    $("#upload-music").disabled = false;
  }
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
  const { data: packs, error: packsError } = await supabase
    .from("sticker_packs").select("id,legacy_id");
  if (packsError) throw packsError;
  const packIds = new Map((packs || []).map((pack) => [pack.legacy_id, pack.id]));
  for (const [index, background] of backgrounds.entries()) {
    const path = `legacy/backgrounds/${storageSegment(background.file)}`;
    const blob = await fetchAsset(`./assets/backgrounds/${background.file}`);
    const { error: uploadError } = await supabase.storage
      .from("assets").upload(path, blob, { contentType: blob.type, upsert: true });
    if (uploadError) throw uploadError;
    const { error } = await supabase.from("backgrounds").upsert({
      pack_id: packIds.get(background.packId) || null,
      legacy_id: background.id,
      name: background.name,
      storage_path: path,
      position: index,
    }, { onConflict: "legacy_id" });
    if (error) throw error;
  }
}

$("#open-pack-modal").addEventListener("click", () => openAssetModal("pack"));
$("#open-background-modal").addEventListener("click", () => openAssetModal("background"));
$("#asset-modal-cancel").addEventListener("click", closeAssetModal);
$("#asset-modal").addEventListener("click", (event) => {
  if (event.target.id === "asset-modal") closeAssetModal();
});
$("#move-stickers-cancel").addEventListener("click", closeMoveAssetsModal);
$("#move-stickers-modal").addEventListener("click", (event) => {
  if (event.target.id === "move-stickers-modal") closeMoveAssetsModal();
});
$("#move-stickers-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!moveAssetState?.assets.length) return;
  const targetPackId = $("#move-stickers-target").value || null;
  const basePosition = Date.now();
  const table = moveAssetState.type === "background" ? "backgrounds" : "stickers";
  const assetIds = moveAssetState.assets.map((asset) => asset.id);
  const moved = await supabase.from(table)
    .update({ pack_id: targetPackId, position: basePosition })
    .in("id", assetIds)
    .select("id,pack_id");
  if (moved.error) {
    console.error("Asset move failed", moved.error);
    const missingColumn = moved.error.code === "42703" ||
      String(moved.error.message || "").includes("pack_id");
    return toast(missingColumn
      ? "최신 schema.sql을 Supabase에서 실행해 주세요."
      : "어셋을 이동하지 못했어요.");
  }
  if ((moved.data || []).length !== assetIds.length) {
    return toast("일부 어셋이 이동되지 않았어요. 관리자 권한을 확인해 주세요.");
  }
  if (moveAssetState.type === "background" && !moveAssetState.sourcePack) {
    selectedBackgrounds.clear();
  }
  closeMoveAssetsModal();
  toast("선택한 어셋을 이동했어요.");
  await Promise.all([renderPacks(), renderBackgrounds()]);
});
$("#asset-modal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("#asset-modal-name").value.trim();
  const files = [...$("#asset-modal-files").files];
  if (modalMode === "pack") {
    const { error } = await supabase.from("sticker_packs").insert({ name, position: Date.now() });
    if (error) return toast("팩을 추가하지 못했어요.");
    await renderPacks();
  } else if (modalMode === "background") {
    const file = files[0];
    const path = `backgrounds/${safeFileName(file.name)}`;
    const upload = await supabase.storage.from("assets").upload(path, file);
    if (upload.error) return toast("이미지 업로드에 실패했어요.");
    const { error } = await supabase.from("backgrounds").insert({
      pack_id: modalPack?.id || null,
      name, storage_path: path, position: Date.now(),
    });
    if (error) {
      await supabase.storage.from("assets").remove([path]);
      return toast("배경을 등록하지 못했어요.");
    }
    await Promise.all([renderPacks(), renderBackgrounds()]);
  } else if (modalMode === "sticker" && modalPack) {
    const baseName = name || modalPack.name || "스티커";
    const { count } = await supabase
      .from("stickers")
      .select("id", { count:"exact", head:true })
      .eq("pack_id", modalPack.id);
    const startNumber = (count || 0) + 1;
    for (const [index, file] of files.entries()) {
      const path = `stickers/${modalPack.id}/${safeFileName(file.name)}`;
      const uploaded = await supabase.storage.from("assets").upload(path, file);
      if (uploaded.error) continue;
      const stickerName = name
        ? files.length === 1 ? name : `${name} ${index + 1}`
        : `${baseName} ${startNumber + index}`;
      const inserted = await supabase.from("stickers").insert({
        pack_id: modalPack.id,
        name: stickerName,
        storage_path: path,
        position: Date.now() + index,
      });
      if (inserted.error) await supabase.storage.from("assets").remove([path]);
    }
    await renderPacks();
  }
  closeAssetModal();
});

$("#delete-selected-packs").addEventListener("click", async () => {
  if (!selectedPacks.size || !confirm(`선택한 스티커팩 ${selectedPacks.size}개를 제거할까요?`)) return;
  for (const pack of selectedPacks.values()) {
    const backgrounds = pack.backgrounds || [];
    if (backgrounds.length) {
      const { error: backgroundError } = await supabase
        .from("backgrounds").delete().in("id", backgrounds.map((item) => item.id));
      if (backgroundError) return toast("팩의 배경을 제거하지 못했어요.");
    }
    const { error } = await supabase.from("sticker_packs").delete().eq("id", pack.id);
    if (error) return toast("일부 팩을 제거하지 못했어요.");
    const paths = [
      ...pack.stickers.map((item) => item.storage_path),
      ...backgrounds.map((item) => item.storage_path),
    ];
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

$("#move-selected-unassigned-backgrounds").addEventListener("click", () => {
  if (!selectedBackgrounds.size) return;
  openMoveAssetsModal(null, [...selectedBackgrounds.values()], "background");
});

async function renderAll() {
  await Promise.all([renderPacks(), renderBackgrounds(), renderWelcomeMessages(), renderMusicPlaylist()]);
}

async function renderWelcomeMessages() {
  const { data } = await supabase
    .from("app_settings").select("value").eq("key", "welcome_messages").maybeSingle();
  const messages = Array.isArray(data?.value) ? data.value : DEFAULT_WELCOME_MESSAGES;
  $("#welcome-messages").value = messages.join("\n");
}

async function saveMusicPlaylist() {
  const { error } = await supabase.from("app_settings").upsert({
    key: "music_playlist",
    value: musicPlaylist,
  });
  if (error) throw error;
}

async function renderMusicPlaylist() {
  const { data } = await supabase
    .from("app_settings").select("value").eq("key", "music_playlist").maybeSingle();
  musicPlaylist = Array.isArray(data?.value) ? data.value : [];
  renderMusicList();
}

function renderMusicList() {
  if (musicPreview) {
    musicPreview.pause();
    musicPreview = null;
    previewTrackId = null;
  }
  const list = $("#music-list");
  if (!list) return;
  list.innerHTML = "";
  if (!musicPlaylist.length) {
    list.innerHTML = `<p class="empty-music">아직 음악이 없어요.</p>`;
    return;
  }
  musicPlaylist.forEach((track, index) => {
    const item = document.createElement("div");
    item.className = "music-track";
    item.innerHTML = `
      <span class="music-track__number">${index + 1}</span>
      <input class="music-track__name" value="${escapeHtml(track.name || "Music")}" aria-label="음악 이름">
      <div class="music-track__actions">
        <button class="button music-preview" type="button" aria-label="미리듣기">▶</button>
        <button class="button secondary music-up" type="button" ${index === 0 ? "disabled" : ""}>↑</button>
        <button class="button secondary music-down" type="button" ${index === musicPlaylist.length - 1 ? "disabled" : ""}>↓</button>
        <button class="button danger music-remove" type="button">삭제</button>
      </div>
    `;
    autoSave(item.querySelector(".music-track__name"), async (name) => {
      musicPlaylist[index] = { ...musicPlaylist[index], name };
      try {
        await saveMusicPlaylist();
        return null;
      } catch (error) {
        return error;
      }
    });
    const previewButton = item.querySelector(".music-preview");
    previewButton.onclick = async () => {
      if (previewTrackId === track.id && musicPreview) {
        if (!musicPreview.paused) {
          musicPreview.pause();
          return;
        }
        try {
          await musicPreview.play();
        } catch (error) {
          console.error(error);
          toast("음악을 재생하지 못했어요.");
        }
        return;
      }
      if (musicPreview) musicPreview.pause();
      musicPreview = new Audio(
        track.storage_path ? await signedAssetUrl(track.storage_path) : track.url
      );
      previewTrackId = track.id;
      musicPreview.preload = "auto";
      musicPreview.volume = 0.7;
      const syncPreviewButton = () => {
        list.querySelectorAll(".music-preview").forEach((button) => {
          button.textContent = "▶";
          button.classList.remove("is-playing");
        });
        if (!musicPreview.paused && previewTrackId === track.id) {
          previewButton.textContent = "❚❚";
          previewButton.classList.add("is-playing");
        }
      };
      musicPreview.addEventListener("play", syncPreviewButton);
      musicPreview.addEventListener("pause", syncPreviewButton);
      musicPreview.addEventListener("ended", () => {
        musicPreview.currentTime = 0;
        syncPreviewButton();
      });
      try {
        await musicPreview.play();
      } catch (error) {
        console.error(error);
        toast("음악을 재생하지 못했어요.");
      }
    };
    item.querySelector(".music-up").onclick = async () => moveMusicTrack(index, index - 1);
    item.querySelector(".music-down").onclick = async () => moveMusicTrack(index, index + 1);
    item.querySelector(".music-remove").onclick = async () => removeMusicTrack(index);
    list.appendChild(item);
  });
}

async function moveMusicTrack(from, to) {
  const next = [...musicPlaylist];
  const [track] = next.splice(from, 1);
  next.splice(to, 0, track);
  musicPlaylist = next;
  await saveMusicPlaylist();
  renderMusicList();
}

async function removeMusicTrack(index) {
  const [track] = musicPlaylist.splice(index, 1);
  if (track?.storage_path) await supabase.storage.from("assets").remove([track.storage_path]);
  await saveMusicPlaylist();
  renderMusicList();
  toast("음악을 삭제했어요.");
}

async function renderPacks() {
  let { data: packs, error } = await supabase
    .from("sticker_packs").select("*, stickers(*)").order("position");
  if (error) return toast("팩을 불러오지 못했어요.");
  const backgroundResult = await supabase
    .from("backgrounds").select("*").not("pack_id", "is", null).order("position");
  const backgroundsByPack = new Map();
  if (!backgroundResult.error) {
    (backgroundResult.data || []).forEach((background) => {
      const items = backgroundsByPack.get(background.pack_id) || [];
      items.push(background);
      backgroundsByPack.set(background.pack_id, items);
    });
  }
  packs = (packs || []).map((pack) => ({
    ...pack,
    stickers: [...(pack.stickers || [])].sort((a, b) => a.position - b.position),
    backgrounds: backgroundsByPack.get(pack.id) || [],
  }));
  const list = $("#pack-list");
  list.innerHTML = "";
  packs.forEach((pack) => list.appendChild(packCard(pack)));
  updatePackSelection();
}

function packCard(pack) {
  const card = document.createElement("details");
  card.className = "pack";
  card.dataset.sortId = pack.id;
  card.draggable = true;
  const thumbnailPath = pack.stickers[0]?.storage_path
    || pack.backgrounds?.[0]?.storage_path
    || "";
  card.innerHTML = `
    <summary class="pack__summary">
      <span class="sort-grip" aria-hidden="true">⋮⋮</span>
      <input class="select-box pack-select" type="checkbox" aria-label="팩 선택">
      ${thumbnailPath ? `<img alt="">` : `<span class="pack__empty">＋</span>`}
      <span class="pack__summary-main">
        <span class="pack__summary-name">${escapeHtml(pack.name)}</span>
        <span class="pack__summary-count">스티커 ${pack.stickers.length}개 · 배경 ${(pack.backgrounds || []).length}개</span>
      </span>
      <span class="pack__chevron">⌄</span>
    </summary>
    <div class="pack__body">
      <div class="pack__top">
        <input class="pack-name" value="${escapeHtml(pack.name)}" aria-label="팩 이름">
        <span class="auto-save-note">자동 저장</span>
      </div>
      <section class="pack-assets-section">
        <div class="pack-assets-heading">
          <h3>스티커</h3>
          <button class="button sticker-add">＋ 스티커 추가</button>
        </div>
        <div class="pack-tools">
          <span class="sticker-selection-count">선택 0개</span>
          <div class="pack-tool-actions">
            <button class="button secondary clear-selected-stickers" disabled>선택 취소</button>
            <button class="button move-selected-stickers" disabled>이동</button>
            <button class="button danger delete-selected-stickers" disabled>선택한 스티커 제거</button>
          </div>
        </div>
        <div class="stickers"></div>
      </section>
      <section class="pack-assets-section">
        <div class="pack-assets-heading">
          <h3>배경</h3>
          <button class="button background-add">＋ 배경 추가</button>
        </div>
        <div class="pack-tools">
          <span class="background-selection-count">선택 0개</span>
          <div class="pack-tool-actions">
            <button class="button secondary clear-selected-pack-backgrounds" disabled>선택 취소</button>
            <button class="button move-selected-backgrounds" disabled>이동</button>
            <button class="button danger delete-selected-pack-backgrounds" disabled>선택한 배경 제거</button>
          </div>
        </div>
        <div class="pack-backgrounds"></div>
      </section>
    </div>`;

  const packSelect = card.querySelector(".pack-select");
  if (pack.stickers[0]) {
    setAssetPreview(
      card.querySelector(".pack__summary img"),
      pack.stickers[0].storage_path,
    );
  } else if (pack.backgrounds?.[0]) {
    setAssetPreview(
      card.querySelector(".pack__summary img"),
      pack.backgrounds[0].storage_path,
    );
  }
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

  card.querySelector(".sticker-add").onclick = () => openAssetModal("sticker", pack);
  card.querySelector(".background-add").onclick = () => openAssetModal("background", pack);
  const selectedStickers = new Map();
  const deleteSelected = card.querySelector(".delete-selected-stickers");
  const clearSelected = card.querySelector(".clear-selected-stickers");
  const moveSelected = card.querySelector(".move-selected-stickers");
  const selectionCount = card.querySelector(".sticker-selection-count");
  const updateStickerSelection = () => {
    selectionCount.textContent = `선택 ${selectedStickers.size}개`;
    [deleteSelected, clearSelected, moveSelected].forEach((button) => {
      button.disabled = selectedStickers.size === 0;
    });
  };
  clearSelected.onclick = () => {
    selectedStickers.clear();
    card.querySelectorAll(".stickers .asset").forEach((item) => {
      item.classList.remove("is-selected");
      item.querySelector(".select-box").checked = false;
    });
    updateStickerSelection();
  };
  moveSelected.onclick = () =>
    openMoveAssetsModal(pack, [...selectedStickers.values()], "sticker");
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
  bindSortable(stickerList, ".asset", "stickers");

  const selectedPackBackgrounds = new Map();
  const backgroundList = card.querySelector(".pack-backgrounds");
  const backgroundCount = card.querySelector(".background-selection-count");
  const clearBackgrounds = card.querySelector(".clear-selected-pack-backgrounds");
  const moveBackgrounds = card.querySelector(".move-selected-backgrounds");
  const deleteBackgrounds = card.querySelector(".delete-selected-pack-backgrounds");
  const updatePackBackgroundSelection = () => {
    backgroundCount.textContent = `선택 ${selectedPackBackgrounds.size}개`;
    [clearBackgrounds, moveBackgrounds, deleteBackgrounds].forEach((button) => {
      button.disabled = selectedPackBackgrounds.size === 0;
    });
  };
  clearBackgrounds.onclick = () => {
    selectedPackBackgrounds.clear();
    backgroundList.querySelectorAll(".asset").forEach((item) => {
      item.classList.remove("is-selected");
      item.querySelector(".select-box").checked = false;
    });
    updatePackBackgroundSelection();
  };
  moveBackgrounds.onclick = () =>
    openMoveAssetsModal(pack, [...selectedPackBackgrounds.values()], "background");
  deleteBackgrounds.onclick = async () => {
    if (!selectedPackBackgrounds.size) return;
    const backgrounds = [...selectedPackBackgrounds.values()];
    const { error } = await supabase
      .from("backgrounds").delete().in("id", backgrounds.map((item) => item.id));
    if (error) return toast("배경을 제거하지 못했어요.");
    await supabase.storage
      .from("assets").remove(backgrounds.map((item) => item.storage_path));
    await renderPacks();
  };
  (pack.backgrounds || []).forEach((background) =>
    backgroundList.appendChild(
      backgroundCard(background, selectedPackBackgrounds, updatePackBackgroundSelection)
    ));
  bindSortable(backgroundList, ".asset", "backgrounds");
  return card;
}

function stickerCard(sticker, selection, updateSelection) {
  const item = document.createElement("div");
  item.className = "asset";
  item.dataset.sortId = sticker.id;
  item.draggable = true;
  item.innerHTML = `
    <span class="sort-grip asset-sort-grip" aria-hidden="true">⋮⋮</span>
    <input class="select-box" type="checkbox" aria-label="스티커 선택">
    <img alt="">
    <input class="asset-name" value="${escapeHtml(sticker.name)}" aria-label="스티커 이름">`;
  const checkbox = item.querySelector(".select-box");
  setAssetPreview(item.querySelector("img"), sticker.storage_path);
  const setSelected = (selected) => {
    checkbox.checked = selected;
    if (checkbox.checked) selection.set(sticker.id, sticker);
    else selection.delete(sticker.id);
    item.classList.toggle("is-selected", checkbox.checked);
    updateSelection();
  };
  checkbox.addEventListener("click", (event) => event.stopPropagation());
  checkbox.onchange = () => setSelected(checkbox.checked);
  item.addEventListener("click", (event) => {
    if (event.target.closest(".asset-name")) return;
    setSelected(!checkbox.checked);
  });
  autoSave(item.querySelector(".asset-name"), async (name) => {
    const { error } = await supabase.from("stickers").update({ name }).eq("id", sticker.id);
    return error;
  });
  return item;
}

function backgroundCard(background, selection, updateSelection) {
  const item = document.createElement("div");
  item.className = "asset";
  item.dataset.sortId = background.id;
  item.draggable = true;
  item.innerHTML = `
    <span class="sort-grip asset-sort-grip" aria-hidden="true">⋮⋮</span>
    <input class="select-box" type="checkbox" aria-label="배경 선택">
    <img alt="">
    <input class="asset-name" value="${escapeHtml(background.name)}" aria-label="배경 이름">`;
  const checkbox = item.querySelector(".select-box");
  setAssetPreview(item.querySelector("img"), background.storage_path);
  const setSelected = (selected) => {
    checkbox.checked = selected;
    if (selected) selection.set(background.id, background);
    else selection.delete(background.id);
    item.classList.toggle("is-selected", selected);
    updateSelection();
  };
  checkbox.addEventListener("click", (event) => event.stopPropagation());
  checkbox.onchange = () => setSelected(checkbox.checked);
  item.addEventListener("click", (event) => {
    if (event.target.closest(".asset-name")) return;
    setSelected(!checkbox.checked);
  });
  autoSave(item.querySelector(".asset-name"), async (name) => {
    const { error } = await supabase
      .from("backgrounds").update({ name }).eq("id", background.id);
    return error;
  });
  return item;
}

async function renderBackgrounds() {
  let { data, error } = await supabase
    .from("backgrounds").select("*").is("pack_id", null).order("position");
  if (error) {
    const fallback = await supabase.from("backgrounds").select("*").order("position");
    data = fallback.data;
    error = fallback.error;
  }
  if (error) return toast("배경을 불러오지 못했어요.");
  const list = $("#background-list");
  list.innerHTML = "";
  data.forEach((background) => {
    const item = backgroundCard(background, selectedBackgrounds, updateBackgroundSelection);
    const checkbox = item.querySelector(".select-box");
    checkbox.checked = selectedBackgrounds.has(background.id);
    item.classList.toggle("is-selected", checkbox.checked);
    list.appendChild(item);
  });
  updateBackgroundSelection();
}

bindSortable($("#pack-list"), ".pack", "sticker_packs");
bindSortable($("#background-list"), ".asset", "backgrounds");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

updateSession();

import "./admin-v2.js?v=20260624-user-table";
