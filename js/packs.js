import { supabase, supabaseConfigured, publicAssetUrl } from "./supabase.js";
import { filterEnabledPacks } from "./asset-prefs.js";

// packs.js — loads sticker packs from Supabase, with bundled assets as fallback.
const ROOT = "./assets/sticker_packs";

let _packs = null;                 // [{id, name, thumbnail, thumbnailUrl, stickers:[{assetId,url}]}]
const _imageCache = new Map();     // url -> HTMLImageElement (loaded)

export async function loadPacks() {
  if (_packs) return _packs;
  let remotePacks = [];
  let useRemoteOnly = false;
  if (supabaseConfigured) {
    let [{ data, error }, { data: sourceSetting }] = await Promise.all([
      supabase.from("sticker_packs").select("*, stickers(*), backgrounds(*)")
        .order("position"),
      supabase.from("app_settings").select("value").eq("key", "assets_source").maybeSingle(),
    ]);
    if (error) {
      const fallback = await supabase.from("sticker_packs").select("*, stickers(*)")
        .order("position");
      data = fallback.data;
      error = fallback.error;
    }
    useRemoteOnly = sourceSetting?.value === "supabase";
    if (!error && data?.length) {
      remotePacks = data.map((pack) => ({
        id: pack.legacy_id || pack.id,
        folder: pack.id,
        name: pack.name,
        thumbnailUrl: pack.stickers[0] ? publicAssetUrl(pack.stickers[0].storage_path) : "",
        backgrounds: [...(pack.backgrounds || [])]
          .sort((a, b) => a.position - b.position)
          .map((background) => ({
          id: background.legacy_id || background.id,
          name: background.name,
          url: publicAssetUrl(background.storage_path),
        })),
        stickers: [...(pack.stickers || [])]
          .sort((a, b) => a.position - b.position)
          .map((sticker) => ({
          assetId: sticker.legacy_asset_id || sticker.id,
          name: sticker.name,
          url: publicAssetUrl(sticker.storage_path),
        })),
      }));
    }
    if (useRemoteOnly) {
      _packs = remotePacks;
      return _packs;
    }
  }
  const [index, backgroundIndex] = await Promise.all([
    fetch(`${ROOT}/index.json`).then((r) => r.json()),
    fetch("./assets/backgrounds/index.json").then((r) => r.json()),
  ]);
  const localBackgrounds = new Map(backgroundIndex.map((background) => [
    background.id,
    {
      id: background.id,
      name: background.name,
      url: `./assets/backgrounds/${background.file}`,
    },
  ]));
  const localPacks = await Promise.all(
    index.map(async (folder) => {
      const meta = await fetch(`${ROOT}/${folder}/pack.json`).then((r) => r.json());
      const base = `${ROOT}/${folder}`;
      return {
        id: meta.id,
        folder,
        name: meta.name,
        thumbnailUrl: `${base}/${meta.thumbnail}`,
        backgrounds: (meta.backgrounds || [])
          .map((backgroundId) => localBackgrounds.get(backgroundId))
          .filter(Boolean),
        stickers: meta.stickers.map((assetId) => ({
          assetId,
          url: `${base}/${assetId}`,
        })),
      };
    })
  );
  _packs = [...remotePacks, ...localPacks];
  return _packs;
}

export function getPacks() { return _packs || []; }
export function getEnabledPacks() { return filterEnabledPacks(_packs || []); }

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
