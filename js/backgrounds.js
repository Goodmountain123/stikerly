import { supabase, supabaseConfigured, publicAssetUrl } from "./supabase.js";
import { filterEnabledBackgrounds } from "./asset-prefs.js";

// backgrounds.js — Supabase backgrounds + bundled fallback assets.
const ROOT = "./assets/backgrounds";

let _bgs = null; // [{id, name, url}]

export async function loadBackgrounds() {
  if (_bgs) return _bgs;
  let remoteBackgrounds = [];
  let useRemoteOnly = false;
  if (supabaseConfigured) {
    let [{ data, error }, { data: sourceSetting }] = await Promise.all([
      supabase.from("backgrounds").select("*, pack:sticker_packs(legacy_id)").order("position"),
      supabase.from("app_settings").select("value").eq("key", "assets_source").maybeSingle(),
    ]);
    if (error) {
      const fallback = await supabase.from("backgrounds").select("*").order("position");
      data = fallback.data;
      error = fallback.error;
    }
    useRemoteOnly = sourceSetting?.value === "supabase";
    if (!error && data?.length) {
      remoteBackgrounds = data.map((item) => ({
        id: item.legacy_id || item.id,
        packId: item.pack?.legacy_id || item.pack_id || null,
        name: item.name,
        url: publicAssetUrl(item.storage_path),
      }));
    }
    if (useRemoteOnly) {
      _bgs = remoteBackgrounds;
      return _bgs;
    }
  }
  const idx = await fetch(`${ROOT}/index.json`).then((r) => r.json());
  const localBackgrounds = idx.map((b) => ({
    id: b.id,
    packId: b.packId || null,
    name: b.name,
    url: `${ROOT}/${b.file}`,
  }));
  _bgs = [...remoteBackgrounds, ...localBackgrounds];
  return _bgs;
}

export function getBackgrounds() { return _bgs || []; }
export function getEnabledBackgrounds() {
  return filterEnabledBackgrounds(_bgs || []);
}

export function findBackground(id) {
  return (_bgs || []).find((b) => b.id === id) || null;
}

// Resolve the source URL for a project's background record.
export function backgroundSrc(bg) {
  if (!bg) return null;
  if (bg.type === "photo") return bg.dataUrl;
  const found = findBackground(bg.id);
  return found ? found.url : bg.url; // fall back to stored url
}

// "object-fit: cover" — source rect to use so the image fills WxH without distortion.
export function coverCrop(iw, ih, W, H) {
  const ar = iw / ih, par = W / H;
  if (ar > par) {
    const cw = ih * par;
    return { x: (iw - cw) / 2, y: 0, width: cw, height: ih };
  }
  const ch = iw / par;
  return { x: 0, y: (ih - ch) / 2, width: iw, height: ch };
}

// Cover crop with user-controlled zoom and normalized pan (-1..1).
export function adjustableCoverCrop(iw, ih, W, H, transform = {}) {
  const base = coverCrop(iw, ih, W, H);
  const zoom = Math.max(1, Math.min(5, transform.zoom || 1));
  const width = base.width / zoom;
  const height = base.height / zoom;
  const panX = Math.max(-1, Math.min(1, transform.x || 0));
  const panY = Math.max(-1, Math.min(1, transform.y || 0));
  const maxX = Math.max(0, iw - width);
  const maxY = Math.max(0, ih - height);
  return {
    x: maxX * (panX + 1) / 2,
    y: maxY * (panY + 1) / 2,
    width,
    height,
  };
}

// Load an image from a url or data URL (no caching — photo data URLs can be large).
export function loadBgImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("배경 이미지를 불러오지 못했어요"));
    img.src = src;
  });
}
