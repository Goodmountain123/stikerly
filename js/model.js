// model.js — data shapes + factories. Designed to extend later (paid packs, etc.).
import { defaultEffects } from "./effects.js";

// Native export resolutions per canvas type (zoom never changes these).
export const CANVAS = {
  square: { w: 1080, h: 1080, ratio: "1 : 1", label: "정사각형" },
  portrait45: { w: 1080, h: 1350, ratio: "4 : 5", label: "세로형" },
  portrait34: { w: 1080, h: 1440, ratio: "3 : 4", label: "세로형" },
  story: { w: 1080, h: 1920, ratio: "9 : 16", label: "스토리" },
  landscape169: { w: 1920, h: 1080, ratio: "16 : 9", label: "와이드" },
  landscape43: { w: 1440, h: 1080, ratio: "4 : 3", label: "가로형" },
  // Backward-compatible aliases for existing saved projects.
  phone: { w: 1080, h: 1920, ratio: "9 : 16", label: "스토리" },
  tablet: { w: 1080, h: 1440, ratio: "3 : 4", label: "세로형" },
};

export const CANVAS_CHOICES = [
  "square",
  "portrait45",
  "portrait34",
  "story",
  "landscape169",
  "landscape43",
];

export function normalizeCanvasType(type) {
  if (type === "phone") return "story";
  if (type === "tablet") return "portrait34";
  return CANVAS_CHOICES.includes(type) ? type : "square";
}

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
    canvasType: normalizeCanvasType(canvasType),
    createdAt: now,
    updatedAt: now,
    background: null,        // null | {type:"asset", id, url} | {type:"photo", dataUrl}
    stickerItems: [],
    textItems: [],
    lastTextColor: "hsl(340 82% 62%)",
    textPalette: [],
    lastGlowColor: "hsl(205 100% 74%)",
    glowPalette: [],
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

export function newTextItem(fontFamily, x, y, zIndex, color) {
  return {
    id: uid("txt"),
    type: "text",
    text: "텍스트",
    fontFamily,
    color: color || "hsl(340 82% 62%)",
    x, y,
    scale: 1,
    rotation: 0,
    zIndex,
  };
}
