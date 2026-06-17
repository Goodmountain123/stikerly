// export.js — render the project to a PNG at native canvas size (ignores zoom).
import { CANVAS } from "./model.js";
import { findSticker, loadImage } from "./packs.js";
import { buildItemGroup } from "./sticker.js";

function safeName(name) {
  return (name || "sticker").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "sticker";
}

export async function exportPNG(project) {
  const { w, h } = CANVAS[project.canvasType];

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;";
  document.body.appendChild(host);

  const stage = new Konva.Stage({ container: host, width: w, height: h });
  const layer = new Konva.Layer();
  stage.add(layer);
  layer.add(new Konva.Rect({ x: 0, y: 0, width: w, height: h, fill: "#ffffff" }));

  const items = [...project.stickerItems].sort((a, b) => a.zIndex - b.zIndex);
  for (const item of items) {
    const s = findSticker(item.packId, item.assetId);
    if (!s) continue;
    const img = await loadImage(s.url);
    const { group } = buildItemGroup(item, img, { interactive: false });
    layer.add(group);
  }
  layer.draw();

  const dataURL = stage.toDataURL({ pixelRatio: 1, mimeType: "image/png" });
  stage.destroy();
  host.remove();

  const a = document.createElement("a");
  a.href = dataURL;
  a.download = safeName(project.title) + ".png";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
