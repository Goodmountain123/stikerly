// backgrounds.js — bundled background assets + helpers.
const ROOT = "./assets/backgrounds";

let _bgs = null; // [{id, name, url}]

export async function loadBackgrounds() {
  if (_bgs) return _bgs;
  const idx = await fetch(`${ROOT}/index.json`).then((r) => r.json());
  _bgs = idx.map((b) => ({ id: b.id, name: b.name, url: `${ROOT}/${b.file}` }));
  return _bgs;
}

export function getBackgrounds() { return _bgs || []; }

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

// Load an image from a url or data URL (no caching — photo data URLs can be large).
export function loadBgImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("배경 이미지를 불러오지 못했어요"));
    img.src = src;
  });
}
