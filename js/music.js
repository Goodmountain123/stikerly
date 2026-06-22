import { supabase, supabaseConfigured, publicAssetUrl } from "./supabase.js";

let audio = null;
let playlist = [];
let currentIndex = 0;
let playing = false;
let initialized = false;

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

function syncUi() {
  const track = playlist[currentIndex];
  roots().forEach((root) => {
    root.hidden = playlist.length === 0;
    if (!track) return;
    const title = root.querySelector(".music-player__title");
    const play = root.querySelector(".music-player__play");
    if (title) title.textContent = track.name;
    if (play) play.textContent = playing ? "Ⅱ" : "▶";
    root.classList.toggle("is-playing", playing);
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

function render(root) {
  root.innerHTML = `
    <button class="music-player__btn" data-music-prev type="button" aria-label="이전 곡">‹</button>
    <button class="music-player__btn music-player__play" data-music-play type="button" aria-label="재생">▶</button>
    <span class="music-player__title"></span>
    <button class="music-player__btn" data-music-next type="button" aria-label="다음 곡">›</button>
  `;
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
      playing = false;
    }
    syncUi();
  });
  root.querySelector("[data-music-prev]").addEventListener("click", () => playAt(currentIndex - 1));
  root.querySelector("[data-music-next]").addEventListener("click", () => playAt(currentIndex + 1));
}

export async function initMusicPlayers() {
  if (initialized) return;
  initialized = true;
  audio = new Audio();
  audio.preload = "metadata";
  audio.addEventListener("ended", () => playAt(currentIndex + 1));
  audio.addEventListener("pause", () => {
    playing = false;
    syncUi();
  });
  audio.addEventListener("play", () => {
    playing = true;
    syncUi();
  });
  playlist = await loadPlaylist();
  roots().forEach(render);
  syncUi();
}
