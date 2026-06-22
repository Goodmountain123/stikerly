import { supabase, supabaseConfigured, publicAssetUrl } from "./supabase.js";

let audio = null;
let playlist = [];
let currentIndex = 0;
let playing = false;
let repeatOne = false;
let volumeLevel = 0.5;
let muted = false;
let initialized = false;
let preloadedTracks = [];
const MUTE_COOKIE = "stickerly_music_muted";
const PLAY_COOKIE = "stickerly_music_playing";
const REPEAT_COOKIE = "stickerly_music_repeat_one";

function readBooleanCookie(name, fallback = false) {
  const prefix = `${name}=`;
  const entry = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (!entry) return fallback;
  return entry.slice(prefix.length) === "1";
}

function readMuteCookie() {
  return readBooleanCookie(MUTE_COOKIE);
}

function saveBooleanCookie(name, value) {
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${name}=${value ? "1" : "0"}; max-age=${maxAge}; path=/; SameSite=Lax`;
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
    const volumeSlider = root.querySelector("[data-music-volume-slider]");
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
      volume.setAttribute(
        "aria-label",
        root.classList.contains("is-volume-open") ? "볼륨 닫기" : "볼륨 조절"
      );
    }
    if (volumeSlider) {
      const percent = muted ? 0 : Math.round(volumeLevel * 100);
      volumeSlider.value = String(percent / 100);
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
  } catch {
    playing = false;
    saveBooleanCookie(PLAY_COOKIE, false);
    syncUi();
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
      <div class="music-player__volume-wrap">
        <button class="music-player__btn music-player__volume" data-music-volume type="button" aria-label="볼륨 조절"><img src="./assets/ui/music-volume.png" alt=""></button>
        <div class="music-player__volume-popover">
          <input data-music-volume-slider type="range" min="0" max="1" step="0.05" value="${muted ? 0 : volumeLevel}" aria-label="음악 볼륨">
        </div>
      </div>
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
      } catch {
        playing = false;
      }
    } else {
      audio.pause();
    }
    saveBooleanCookie(PLAY_COOKIE, !audio.paused);
    syncUi();
  });
  root.querySelector("[data-music-repeat]").addEventListener("click", () => {
    repeatOne = !repeatOne;
    audio.loop = repeatOne;
    saveBooleanCookie(REPEAT_COOKIE, repeatOne);
    syncUi();
  });
  root.querySelector("[data-music-volume]").addEventListener("click", () => {
    root.classList.toggle("is-volume-open");
    root.classList.remove("is-list-open");
    syncUi();
  });
  root.querySelector("[data-music-volume-slider]").addEventListener("input", (event) => {
    const nextVolume = Number(event.target.value);
    muted = nextVolume <= 0;
    if (!muted) volumeLevel = nextVolume;
    audio.muted = muted;
    audio.volume = muted ? volumeLevel : nextVolume;
    saveBooleanCookie(MUTE_COOKIE, muted);
    roots().forEach((player) => {
      const slider = player.querySelector("[data-music-volume-slider]");
      if (slider && slider !== event.target) slider.value = event.target.value;
    });
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
  playing = readBooleanCookie(PLAY_COOKIE, true);
  repeatOne = readBooleanCookie(REPEAT_COOKIE);
  audio.muted = muted;
  audio.loop = repeatOne;
  audio.addEventListener("ended", () => {
    if (!repeatOne) playAt(currentIndex + 1);
  });
  audio.addEventListener("pause", () => {
    playing = false;
    saveBooleanCookie(PLAY_COOKIE, false);
    syncUi();
  });
  audio.addEventListener("play", () => {
    playing = true;
    saveBooleanCookie(PLAY_COOKIE, true);
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
  if (playing) startRandomTrack();

  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || event.target.closest("[data-music-player]")) return;
    roots().forEach((root) => {
      root.classList.remove("is-open", "is-list-open", "is-volume-open");
    });
  });
}
