// packs.js — loads sticker packs bundled in /assets and caches loaded images.
const ROOT = "./assets/sticker_packs";

let _packs = null;                 // [{id, name, thumbnail, thumbnailUrl, stickers:[{assetId,url}]}]
const _imageCache = new Map();     // url -> HTMLImageElement (loaded)

export async function loadPacks() {
  if (_packs) return _packs;
  const index = await fetch(`${ROOT}/index.json`).then((r) => r.json());
  const packs = await Promise.all(
    index.map(async (folder) => {
      const meta = await fetch(`${ROOT}/${folder}/pack.json`).then((r) => r.json());
      const base = `${ROOT}/${folder}`;
      return {
        id: meta.id,
        folder,
        name: meta.name,
        thumbnailUrl: `${base}/${meta.thumbnail}`,
        stickers: meta.stickers.map((assetId) => ({
          assetId,
          url: `${base}/${assetId}`,
        })),
      };
    })
  );
  _packs = packs;
  return packs;
}

export function getPacks() { return _packs || []; }

export function findSticker(packId, assetId) {
  const pack = (_packs || []).find((p) => p.id === packId);
  if (!pack) return null;
  return pack.stickers.find((s) => s.assetId === assetId) || null;
}

// Load (and cache) an HTMLImageElement for a sticker URL.
export function loadImage(url) {
  if (_imageCache.has(url)) {
    const img = _imageCache.get(url);
    if (img.complete) return Promise.resolve(img);
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { _imageCache.set(url, img); resolve(img); };
    img.onerror = () => reject(new Error("이미지를 불러오지 못했어요: " + url));
    img.src = url;
  });
}
