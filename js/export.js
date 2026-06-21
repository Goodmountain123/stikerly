// export.js — render the project to a PNG at native canvas size (ignores zoom).
import { projectCanvasSize } from "./model.js";
import { findSticker, loadImage } from "./packs.js";
import { adjustableCoverCrop, backgroundSrc, loadBgImage } from "./backgrounds.js";
import { buildItemGroup } from "./sticker.js";
import { buildTextGroup } from "./text.js";

function safeName(name) {
  return (name || "sticker").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "sticker";
}

function isMobileDevice() {
  return navigator.userAgentData?.mobile
    ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function renderProjectDataURL(project, {
  maxSize = null,
  mimeType = "image/png",
  quality = 1,
} = {}) {
  const { w, h } = projectCanvasSize(project);

  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-99999px;top:0;";
  document.body.appendChild(host);

  const stage = new Konva.Stage({ container: host, width: w, height: h });
  const layer = new Konva.Layer();
  layer.clip({ x: 0, y: 0, width: w, height: h });
  stage.add(layer);
  layer.add(new Konva.Rect({ x: 0, y: 0, width: w, height: h, fill: "#ffffff" }));

  if (project.background) {
    try {
      const img = await loadBgImage(backgroundSrc(project.background));
      const crop = adjustableCoverCrop(
        img.width,
        img.height,
        w,
        h,
        project.background.transform
      );
      layer.add(new Konva.Image({ image: img, x: 0, y: 0, width: w, height: h, crop }));
    } catch (err) {
      console.error("배경 내보내기 실패", err);
    }
  }

  const items = [
    ...(project.stickerItems || []),
    ...(project.textItems || []),
  ].sort((a, b) => a.zIndex - b.zIndex);
  for (const item of items) {
    if (item.type === "text") {
      await document.fonts?.load(`120px "${item.fontFamily}"`);
      const { group } = buildTextGroup(item, { interactive: false });
      layer.add(group);
      continue;
    }
    const s = findSticker(item.packId, item.assetId);
    if (!s) continue;
    const img = await loadImage(s.url);
    const { group } = buildItemGroup(item, img, { interactive: false });
    layer.add(group);
  }
  layer.draw();

  const pixelRatio = maxSize ? Math.min(1, maxSize / Math.max(w, h)) : 1;
  const dataURL = stage.toDataURL({
    x: 0,
    y: 0,
    width: w,
    height: h,
    pixelRatio,
    mimeType,
    quality,
  });
  stage.destroy();
  host.remove();
  return dataURL;
}

export async function exportPNG(project) {
  const dataURL = await renderProjectDataURL(project);
  const blob = await (await fetch(dataURL)).blob();
  const file = new File([blob], safeName(project.title) + ".png", {
    type: "image/png",
  });

  if (
    isMobileDevice()
    && navigator.share
    && navigator.canShare?.({ files: [file] })
  ) {
    try {
      await navigator.share({
        files: [file],
        title: project.title || "완성한 그림",
      });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
      console.warn("사진 저장 화면을 열지 못해 파일로 저장합니다.", err);
    }
  }

  downloadFile(file);
  return "downloaded";
}
