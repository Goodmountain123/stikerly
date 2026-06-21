// sticker.js — builds the Konva node tree for one StickerItem.
// Used by both the interactive editor and the static PNG export.
import { STICKER_BASE } from "./model.js";
import { configureArt, ensureEffects, makeShadowNode, updateShadow } from "./effects.js";

// Fit the image into STICKER_BASE (longest side) and return display w/h.
function displaySize(image) {
  const ratio = image.width / image.height;
  if (ratio >= 1) return { w: STICKER_BASE, h: STICKER_BASE / ratio };
  return { w: STICKER_BASE * ratio, h: STICKER_BASE };
}

// item: StickerItem, image: loaded HTMLImageElement
// opts.interactive: wire pointer/drag affordances (editor) vs static (export)
export function buildItemGroup(item, image, opts = {}) {
  const { w, h } = displaySize(image);
  item.effects = ensureEffects(item.effects);

  const group = new Konva.Group({
    x: item.x,
    y: item.y,
    draggable: !!opts.interactive,
    name: "item-group",
  });
  group.setAttr("itemId", item.id);

  const shadow = makeShadowNode();
  const art = new Konva.Image({
    image,
    width: w,
    height: h,
    offsetX: w / 2,
    offsetY: h / 2,
    name: "item-art",
  });
  art.setAttr("itemId", item.id);

  group.add(shadow);
  group.add(art);

  function applyTransform() {
    art.rotation(item.rotation);
    art.scaleX(item.scale * (item.flipX ? -1 : 1));
    art.scaleY(item.scale * (item.flipY ? -1 : 1));
  }

  // Cheap live update (used during pinch/rotate): moves the art + shadow
  // without re-caching the art's pixel filters.
  function transformOnly() {
    applyTransform();
    updateShadow(shadow, { w, h, scale: item.scale, effects: item.effects });
  }

  // Full update: transform + re-apply pixel effects.
  function refresh() {
    applyTransform();
    configureArt(art, item.effects);
    if (opts.interactive) {
      // Konva normally treats an image's full rectangle as clickable.
      // Build the hit area from the PNG alpha channel instead.
      if (!art.isCached()) art.cache();
      art.drawHitFromCache(8);
    }
    updateShadow(shadow, { w, h, scale: item.scale, effects: item.effects });
  }
  refresh();

  return { group, art, shadow, size: { w, h }, refresh, transformOnly };
}
