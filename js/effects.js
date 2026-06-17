// effects.js — sticker effect rendering helpers built on Konva filters.
//
// MVP base effect = Floor Shadow (a squashed silhouette on the "ground"
// beneath the sticker, not a generic drop shadow). Blur, colour correction
// and outline are included via Konva built-ins / node shadow as extensions.

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

// Configure the foreground art node: blur, colour correction, outline glow.
export function configureArt(artNode, effects) {
  const e = effects || {};
  const filters = [];
  const blurOn = e.blur && e.blur.enabled && e.blur.intensity > 0;
  const ccOn = e.colorCorrection && e.colorCorrection.enabled && e.colorCorrection.intensity > 0;

  if (blurOn) filters.push(Konva.Filters.Blur);
  if (ccOn) filters.push(Konva.Filters.HSL);

  artNode.filters(filters);
  if (blurOn) artNode.blurRadius(e.blur.intensity * 14);
  if (ccOn) {
    // boost saturation + a touch of brightness as a simple "colour correction"
    artNode.saturation(e.colorCorrection.intensity * 1.6);
    artNode.luminance(e.colorCorrection.intensity * 0.12);
  }

  // Outline → tight glow around the alpha shape using the node's shadow.
  const outOn = e.outline && e.outline.enabled && e.outline.intensity > 0;
  if (outOn) {
    artNode.shadowColor("#ffffff");
    artNode.shadowBlur(2 + e.outline.intensity * 10);
    artNode.shadowOpacity(Math.min(1, 0.4 + e.outline.intensity));
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
  const fs = effects && effects.floorShadow;
  if (!fs || !fs.enabled || fs.intensity <= 0) {
    shadowNode.visible(false);
    shadowNode.clearCache();
    return;
  }
  shadowNode.visible(true);
  shadowNode.size({ width: w, height: h });
  shadowNode.offset({ x: w / 2, y: h / 2 });
  // Anchor the shadow's top at the sticker's bottom-centre, then squash + flip
  // downward (negative scaleY mirrors it onto the "floor") and skew sideways.
  shadowNode.position({ x: 0, y: (h / 2) * scale });
  shadowNode.scaleX(scale * (flipX ? -1 : 1));
  shadowNode.scaleY(-scale * SHADOW_SQUASH);
  shadowNode.skewX(SHADOW_SKEW);
  shadowNode.opacity(fs.intensity * SHADOW_MAX_OPACITY);
  shadowNode.blurRadius(2 + fs.intensity * SHADOW_MAX_BLUR);
  shadowNode.cache();
}

// Default effect block for a new sticker.
export function defaultEffects() {
  return {
    floorShadow: { enabled: false, intensity: 0.5 },
    outline: { enabled: false, intensity: 0.5 },
    blur: { enabled: false, intensity: 0.5 },
    colorCorrection: { enabled: false, intensity: 0.5 },
  };
}
