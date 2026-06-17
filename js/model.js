// model.js — data shapes + factories. Designed to extend later (paid packs, etc.).
import { defaultEffects } from "./effects.js";

// Native export resolutions per canvas type (zoom never changes these).
export const CANVAS = {
  phone: { w: 1080, h: 1920, ratio: "9 : 16" },
  tablet: { w: 1620, h: 2160, ratio: "3 : 4" },
};

// Longest side of a freshly dropped sticker, in canvas units, at scale 1.
export const STICKER_BASE = 260;

export const ZOOM = { min: 0.5, base: 1.0, max: 2.0 };

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function newProject(title, canvasType) {
  const now = Date.now();
  return {
    id: uid("prj"),
    title: title || "제목 없는 프로젝트",
    canvasType: canvasType === "tablet" ? "tablet" : "phone",
    createdAt: now,
    updatedAt: now,
    stickerItems: [],
  };
}

export function newStickerItem(packId, assetId, x, y, zIndex) {
  return {
    id: uid("stk"),
    packId,
    assetId,
    x, y,
    scale: 1,
    rotation: 0,
    flipX: false,
    flipY: false,
    zIndex,
    effects: defaultEffects(),
  };
}
