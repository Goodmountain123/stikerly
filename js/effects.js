// effects.js — sticker effect rendering helpers built on Konva filters.
//
// Effects: projected shadow, blur, brightness adjustment, and outer glow.

const SHADOW_RGB = [46, 40, 58];      // ground-shadow tint
const SHADOW_MAX_OPACITY = 0.5;
const SHADOW_SQUASH = 0.42;           // how flat the shadow lies
const SHADOW_SKEW = 0.55;             // horizontal projection slant
const SHADOW_MAX_BLUR = 16;

// Turn every opaque pixel into the shadow colour, keeping alpha as the mask.
function DarkTint(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = SHADOW_RGB[0];
    d[i + 1] = SHADOW_RGB[1];
    d[i + 2] = SHADOW_RGB[2];
  }
}

function normalizeEffect(effect, defaults = {}) {
  return { ...defaults, ...(effect || {}) };
}

// Fill in effects added after older projects were saved.
export function ensureEffects(effects) {
  const source = effects || {};
  return {
    ...source,
    floorShadow: normalizeEffect(source.floorShadow, {
      enabled: false,
      intensity: 0.5,
      offsetY: 0,
    }),
    blur: normalizeEffect(source.blur, { enabled: false, intensity: 0.5 }),
    brightness: normalizeEffect(source.brightness, {
      enabled: false,
      intensity: 0.25,
    }),
    outglow: normalizeEffect(source.outglow, {
      enabled: false,
      intensity: 0.5,
    }),
  };
}

// Configure the foreground art node: blur, brightness, and outer glow.
export function configureArt(artNode, effects) {
  const e = ensureEffects(effects);
  const filters = [];
  const blurOn = e.blur && e.blur.enabled && e.blur.intensity > 0;
  const brightnessOn = e.brightness.enabled && Math.abs(e.brightness.intensity) > 0.001;

  if (blurOn) filters.push(Konva.Filters.Blur);
  if (brightnessOn) filters.push(Konva.Filters.Brighten);

  artNode.filters(filters);
  if (blurOn) artNode.blurRadius(e.blur.intensity * 14);
  artNode.brightness(brightnessOn ? e.brightness.intensity * 0.85 : 0);

  const glowOn = e.outglow.enabled && e.outglow.intensity > 0;
  if (glowOn) {
    artNode.shadowColor("#7CCBFF");
    artNode.shadowBlur(8 + e.outglow.intensity * 34);
    artNode.shadowOpacity(Math.min(0.9, 0.25 + e.outglow.intensity * 0.65));
    artNode.shadowOffset({ x: 0, y: 0 });
    artNode.shadowForStrokeEnabled(false);
  } else {
    artNode.shadowOpacity(0);
    artNode.shadowBlur(0);
  }

  if (filters.length) artNode.cache();
  else artNode.clearCache();
}

// Build the floor-shadow node for an item (created once per item group).
export function makeShadowNode(image) {
  return new Konva.Image({
    image,
    listening: false,
    filters: [DarkTint, Konva.Filters.Blur],
  });
}

// Update the shadow node from the current art geometry + effect intensity.
// w,h are the art node's unscaled display size; scale/flipX from the item.
export function updateShadow(shadowNode, { w, h, scale, flipX, effects }) {
  const fs = ensureEffects(effects).floorShadow;
  if (!fs || !fs.enabled || fs.intensity <= 0) {
    shadowNode.visible(false);
    shadowNode.clearCache();
    return;
  }
  shadowNode.visible(true);
  shadowNode.size({ width: w, height: h });
  shadowNode.offset({ x: w / 2, y: h / 2 });
  const verticalOffset = (fs.offsetY || 0) * h * scale;
  shadowNode.position({ x: 0, y: (h / 2) * scale + verticalOffset });
  shadowNode.scaleX(scale * (flipX ? -1 : 1));
  // Flip the previous floor-shadow rendering vertically.
  shadowNode.scaleY(scale * SHADOW_SQUASH);
  shadowNode.skewX(SHADOW_SKEW);
  shadowNode.opacity(fs.intensity * SHADOW_MAX_OPACITY);
  shadowNode.blurRadius(2 + fs.intensity * SHADOW_MAX_BLUR);
  shadowNode.cache();
}

// Default effect block for a new sticker.
export function defaultEffects() {
  return {
    floorShadow: { enabled: false, intensity: 0.5, offsetY: 0 },
    blur: { enabled: false, intensity: 0.5 },
    brightness: { enabled: false, intensity: 0.25 },
    outglow: { enabled: false, intensity: 0.5 },
  };
}
