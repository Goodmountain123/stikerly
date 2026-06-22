import { supabase, supabaseConfigured, publicAssetUrl } from "./supabase.js";

let audio = null;
let playlist = [];
let currentIndex = 0;
let playing = false;
let repeatOne = false;
let volumeLevel = 0.5;
let muted = false;
let initialized = false;
let autoplayRetry = null;
let preloadedTracks = [];
const MUTE_COOKIE = "stickerly_music_muted";

function readMuteCookie() {
  return document.cookie
    .split(";")
    .map((part) => part.trim())
    .some((part) => part === `${MUTE_COOKIE}=1`);
}

function saveMuteCookie() {
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${MUTE_COOKIE}=${muted ? "1" : "0"}; max-age=${maxAge}; path=/; SameSite=Lax`;
}

function clearAutoplayRetry() {
  if (!autoplayRetry) return;
  document.removeEventListener("pointerdown", autoplayRetry, true);
  document.removeEventListener("touchstart", autoplayRetry, true);
  document.removeEventListener("keydown", autoplayRetry, true);
  autoplayRetry = null;
}

function normalizeTrack(track) {
  if (!track) return null;
  const name = String(track.name || "Music").trim();
  const storagePath = track.storage_path || track.storagePath || "";
  const url = storagePath ? publicAssetUrl(storagePath) : String(track.url || "");
  if (!url) return null;
  return { ...track, name, url };
}

async function loadPlaylist() {
  if (!supabaseConfigured) return [];
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "music_playlist")
    .maybeSingle();
  return Array.isArray(data?.value)
    ? data.value.map(normalizeTrack).filter(Boolean)
    : [];
}

function roots() {
  return [...document.querySelectorAll("[data-music-player]")];
}

function closeOtherPanels(activeRoot) {
  roots().forEach((root) => {
    if (root !== activeRoot) {
      root.classList.remove("is-open", "is-list-open", "is-volume-open");
    }
  });
}

function syncUi() {
  const track = playlist[currentIndex];
  roots().forEach((root) => {
    root.hidden = playlist.length === 0;
    if (!track) return;
    const title = root.querySelector(".music-player__title-text");
    const play = root.querySelector(".music-player__play");
    const repeat = root.querySelector("[data-music-repeat]");
    const volume = root.querySelector("[data-music-volume]");
    const list = root.querySelector(".music-player__list");
    if (title) title.textContent = track.name;
    if (play) {
      play.textContent = playing ? "❚❚" : "▶";
      play.setAttribute("aria-label", playing ? "일시정지" : "재생");
    }
    if (repeat) {
      repeat.classList.toggle("is-on", repeatOne);
      repeat.setAttribute("aria-pressed", String(repeatOne));
    }
    if (volume) {
      volume.setAttribute("aria-label", muted ? "음소거 해제" : "음소거");
      volume.setAttribute("aria-pressed", String(muted));
    }
    if (list) {
      [...list.children].forEach((item, index) => {
        item.classList.toggle("is-current", index === currentIndex);
      });
    }
    root.classList.toggle("is-playing", playing);
    root.classList.toggle("has-volume", !muted);
  });
}

async function playAt(index) {
  if (!playlist.length) return;
  currentIndex = (index + playlist.length) % playlist.length;
  audio.src = playlist[currentIndex].url;
  try {
    await audio.play();
    playing = true;
    clearAutoplayRetry();
  } catch {
    playing = false;
  }
  syncUi();
}

async function startRandomTrack() {
  if (!playlist.length) return;
  currentIndex = Math.floor(Math.random() * playlist.length);
  audio.src = playlist[currentIndex].url;
  syncUi();
  try {
    await audio.play();
    clearAutoplayRetry();
  } catch {
    autoplayRetry = async (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-music-play]")
      ) return;
      try {
        await audio.play();
      } catch {
        return;
      }
      clearAutoplayRetry();
    };
    document.addEventListener("pointerdown", autoplayRetry, true);
    document.addEventListener("touchstart", autoplayRetry, true);
    document.addEventListener("keydown", autoplayRetry, true);
  }
}

function renderList(root) {
  const list = root.querySelector(".music-player__list");
  list.innerHTML = "";
  playlist.forEach((track, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "music-player__track";
    button.textContent = track.name;
    button.addEventListener("click", () => {
      playAt(index);
      root.classList.remove("is-list-open");
    });
    list.appendChild(button);
  });
}

function render(root) {
  root.innerHTML = `
    <button class="music-player__mobile-toggle" type="button" aria-label="음악 재생창 열기"><img src="./assets/ui/music-mobile.png" alt=""></button>
    <div class="music-player__panel">
      <button class="music-player__btn music-player__play" data-music-play type="button" aria-label="재생">▶</button>
      <button class="music-player__title" data-music-list-toggle type="button" aria-label="곡 목록 열기"><span class="music-player__title-menu" aria-hidden="true">☰</span><span class="music-player__title-text"></span></button>
      <button class="music-player__btn music-player__repeat" data-music-repeat type="button" aria-label="한 곡 반복" aria-pressed="false"><img src="./assets/ui/music-repeat-one.png" alt=""></button>
      <button class="music-player__btn music-player__volume" data-music-volume type="button" aria-label="음소거" aria-pressed="false"><img src="./assets/ui/music-volume.png" alt=""></button>
      <div class="music-player__list"></div>
    </div>
  `;
  renderList(root);
  root.querySelector(".music-player__mobile-toggle").addEventListener("click", () => {
    const opening = !root.classList.contains("is-open");
    closeOtherPanels(root);
    root.classList.toggle("is-open", opening);
  });
  root.querySelector("[data-music-play]").addEventListener("click", async () => {
    if (!playlist.length) return;
    if (!audio.src) return playAt(currentIndex);
    if (audio.paused) {
      try {
        await audio.play();
        playing = true;
        clearAutoplayRetry();
      } catch {
        playing = false;
      }
    } else {
      audio.pause();
    }
    syncUi();
  });
  root.querySelector("[data-music-repeat]").addEventListener("click", () => {
    repeatOne = !repeatOne;
    audio.loop = repeatOne;
    syncUi();
  });
  root.querySelector("[data-music-volume]").addEventListener("click", () => {
    muted = !muted;
    audio.muted = muted;
    saveMuteCookie();
    syncUi();
  });
  root.querySelector("[data-music-list-toggle]").addEventListener("click", () => {
    root.classList.toggle("is-list-open");
    root.classList.remove("is-volume-open");
  });
}

export async function initMusicPlayers() {
  if (initialized) return;
  initialized = true;
  audio = new Audio();
  audio.preload = "auto";
  audio.autoplay = true;
  audio.playsInline = true;
  audio.volume = volumeLevel;
  muted = readMuteCookie();
  audio.muted = muted;
  audio.addEventListener("ended", () => {
    if (!repeatOne) playAt(currentIndex + 1);
  });
  audio.addEventListener("pause", () => {
    playing = false;
    syncUi();
  });
  audio.addEventListener("play", () => {
    playing = true;
    syncUi();
  });
  playlist = await loadPlaylist();
  preloadedTracks = playlist.map((track) => {
    const preload = new Audio();
    preload.preload = "auto";
    preload.src = track.url;
    preload.load();
    return preload;
  });
  roots().forEach(render);
  syncUi();
  startRandomTrack();

  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || event.target.closest("[data-music-player]")) return;
    roots().forEach((root) => {
      root.classList.remove("is-open", "is-list-open", "is-volume-open");
    });
  });
}
