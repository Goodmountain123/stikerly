// editor.js — sticker editing surface.
// Drop-in replacement for the broken main/js/editor.js.

import { putProject } from "./storage.js";
import {
  CANVAS,
  ZOOM,
  newStickerItem,
  newTextItem,
  normalizeCanvasType,
} from "./model.js";
import { getPacks, findSticker, loadImage } from "./packs.js";
import { buildItemGroup } from "./sticker.js";
import { buildTextGroup } from "./text.js";
import { exportPNG } from "./export.js";
import {
  getBackgrounds,
  adjustableCoverCrop,
  backgroundSrc,
  loadBgImage,
} from "./backgrounds.js";

const PAD = 56;
const PAN_MARGIN = 80;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clone = (v) => JSON.parse(JSON.stringify(v));
const DEFAULT_TEXT_COLOR = "hsl(340 82% 62%)";

const MENU_ACTIONS = [
  { key: "flipH", icon: "horizontal.png", tip: "좌우 반전" },
  { key: "flipV", icon: "vertical.png", tip: "상하 반전" },
  { key: "forward", icon: "up.png", tip: "앞으로" },
  { key: "backward", icon: "down.png", tip: "뒤로" },
  { key: "effects", icon: "effect.png", tip: "효과" },
  { key: "delete", icon: "delete.png", tip: "삭제", danger: true },
];

const EFFECTS = [
  { key: "floorShadow", icon: "shadow.png", tip: "그림자" },
  { key: "blur", icon: "blur.png", tip: "블러" },
  { key: "brightness", icon: "brightness.png", tip: "밝기" },
  { key: "outglow", icon: "outglow.png", tip: "아웃글로우" },
];

const TEXT_MENU_ACTIONS = MENU_ACTIONS.filter((item) =>
  ["forward", "backward", "delete"].includes(item.key)
);

function hslString(h, s, l) {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

function parseHsl(value) {
  const match = String(value || "").match(/hsl\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%\s*\)/i);
  return match
    ? { h: Number(match[1]), s: Number(match[2]), l: Number(match[3]) }
    : { h: 340, s: 82, l: 62 };
}

let app = null;

export function openEditor(project, callbacks = {}) {
  if (app) app.destroy();
  app = new Editor(project, callbacks);
  app.mount();
}

class Editor {
  constructor(project, callbacks) {
    this.project = project;
    this.project.canvasType = normalizeCanvasType(this.project.canvasType);
    this.cb = callbacks;
    this.refs = new Map();
    this.selectedId = null;
    this.zoom = ZOOM.base;
    this.worldBase = 1;
    this.bgNode = null;
    this.bgImage = null;
    this.bgAdjustMode = false;
    this.bgGesture = null;
    this.bgWheelTimer = null;
    this.bgDirty = false;
    this.effectsOpen = false;
    this.openEffectKey = null;
    this.history = [this.snapshot()];
    this.hIndex = 0;
    this.savedIndex = 0;
    this.cleanup = [];
    this.pinch = null;
    this.pinchDragStates = null;
    this.handleGesture = null;
    this.menuManuallyPositioned = false;
  }

  mount() {
    this.host = document.getElementById("stage-host");
    this.wrap = document.getElementById("stage-wrap");
    this.menuEl = document.getElementById("sticker-menu");
    this.zoomReadout = document.getElementById("zoom-readout");
    this.titleInput = document.getElementById("title-input");

    this.host.style.touchAction = "none";
    this.titleInput.value = this.project.title || "제목 없는 프로젝트";

    this.buildStage();
    this.bindChrome();
    this.bindTrayTabs();
    this.buildTray();
    this.buildBackgroundPanel();
    this.renderAllItems();
    this.renderBackground();
    this.bindTrayDrag();
    this.bindMenuDrag();
    this.updateHistoryButtons();
  }

  destroy() {
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
    clearTimeout(this.bgWheelTimer);
    this.hideMenu();
    this.refs.forEach((ref) => ref.group.destroy());
    this.refs.clear();
    if (this.stage) this.stage.destroy();
  }

  // ---------- stage / viewport ----------

  buildStage() {
    const spec = CANVAS[this.project.canvasType] || CANVAS.square;
    this.canvasW = spec.w;
    this.canvasH = spec.h;

    this.stage = new Konva.Stage({
      container: this.host,
      width: this.host.clientWidth,
      height: this.host.clientHeight,
    });

    this.layer = new Konva.Layer();
    this.stage.add(this.layer);

    this.page = new Konva.Rect({
      x: 0,
      y: 0,
      width: this.canvasW,
      height: this.canvasH,
      fill: "#ffffff",
      name: "page",
      shadowColor: "rgba(36,31,46,1)",
      shadowBlur: 30,
      shadowOpacity: 0.12,
      shadowOffsetY: 8,
      cornerRadius: 4,
    });
    this.layer.add(this.page);

    this.transformer = new Konva.Transformer({
      resizeEnabled: false,
      rotateEnabled: false,
      enabledAnchors: [],
      borderStroke: "#3D7DFF",
      borderStrokeWidth: 1.5,
      listening: false,
      name: "transformer",
    });
    this.layer.add(this.transformer);

    this.transformHandle = new Konva.Circle({
      radius: 9,
      fill: "#ffffff",
      stroke: "#3D7DFF",
      strokeWidth: 2,
      draggable: true,
      visible: false,
      name: "transform-handle",
    });
    this.layer.add(this.transformHandle);
    this.bindTransformHandle();

    this.stage.on("click tap", (e) => {
      if (this.isCanvasTarget(e.target)) this.deselect();
    });

    this.bindCanvasNavigation();

    const onResize = () => this.resize();
    window.addEventListener("resize", onResize);
    this.cleanup.push(() => window.removeEventListener("resize", onResize));

    this.fitView();
  }

  isCanvasTarget(target) {
    return target === this.stage || target === this.page || target === this.bgNode;
  }

  resize() {
    this.stage.size({
      width: this.host.clientWidth,
      height: this.host.clientHeight,
    });
    this.fitView();
    this.repositionMenu();
  }

  fitView() {
    const vw = Math.max(1, this.stage.width());
    const vh = Math.max(1, this.stage.height());
    this.worldBase = Math.min((vw - PAD) / this.canvasW, (vh - PAD) / this.canvasH);
    this.applyView(true);
  }

  applyView(recenter = false) {
    const scale = this.worldBase * this.zoom;
    this.stage.scale({ x: scale, y: scale });
    if (recenter) {
      this.stage.position({
        x: (this.stage.width() - this.canvasW * scale) / 2,
        y: (this.stage.height() - this.canvasH * scale) / 2,
      });
    } else {
      this.clampStagePosition();
    }
    this.syncTransformerScale(scale);
    this.updateZoomReadout();
    this.stage.batchDraw();
  }

  syncTransformerScale(scale) {
    const s = Math.max(scale, 0.0001);
    this.transformer.borderStrokeWidth(1.5 / s);
    this.transformHandle.radius(9 / s);
    this.transformHandle.strokeWidth(2 / s);
    this.positionTransformHandle();
  }

  async changeCanvasType(type, { repositionItems = true, commit = true } = {}) {
    const nextType = normalizeCanvasType(type);
    const spec = CANVAS[nextType];
    if (!spec) return;

    const oldW = this.canvasW || spec.w;
    const oldH = this.canvasH || spec.h;
    if (repositionItems && (oldW !== spec.w || oldH !== spec.h)) {
      const scaleX = spec.w / oldW;
      const scaleY = spec.h / oldH;
      this.allItems().forEach((item) => {
        item.x *= scaleX;
        item.y *= scaleY;
        const ref = this.refs.get(item.id);
        if (ref) ref.group.position({ x: item.x, y: item.y });
      });
    }

    this.project.canvasType = nextType;
    this.canvasW = spec.w;
    this.canvasH = spec.h;
    this.page.size({ width: spec.w, height: spec.h });
    this.ratioSelect.value = nextType;
    await this.renderBackground();
    this.fitView();
    this.transformer.forceUpdate();
    this.positionTransformHandle();
    this.layer.batchDraw();
    if (commit) this.commit();
  }

  pointerInCanvas() {
    const pointer = this.stage.getPointerPosition();
    if (!pointer) return null;
    const scale = this.stage.scaleX();
    return {
      x: (pointer.x - this.stage.x()) / scale,
      y: (pointer.y - this.stage.y()) / scale,
    };
  }

  positionTransformHandle() {
    const ref = this.selectedRef();
    if (!ref || !this.transformHandle) {
      if (this.transformHandle) this.transformHandle.visible(false);
      return;
    }

    const rotation = ref.item.rotation * Math.PI / 180;
    const cornerX = (ref.size.w / 2) * ref.item.scale;
    const cornerY = -(ref.size.h / 2) * ref.item.scale;
    this.transformHandle.position({
      x: ref.group.x() + cornerX * Math.cos(rotation) - cornerY * Math.sin(rotation),
      y: ref.group.y() + cornerX * Math.sin(rotation) + cornerY * Math.cos(rotation),
    });
    this.transformHandle.visible(true);
    this.transformHandle.moveToTop();
  }

  bindTransformHandle() {
    this.transformHandle.on("dragstart", (e) => {
      e.cancelBubble = true;
      const ref = this.selectedRef();
      const pointer = this.pointerInCanvas();
      if (!ref || !pointer) return;

      ref.group.draggable(false);
      this.hideMenu();
      const dx = pointer.x - ref.item.x;
      const dy = pointer.y - ref.item.y;
      this.handleGesture = {
        ref,
        startScale: ref.item.scale,
        startRotation: ref.item.rotation,
        startDistance: Math.max(1, Math.hypot(dx, dy)),
        startAngle: Math.atan2(dy, dx),
      };
    });

    this.transformHandle.on("dragmove", (e) => {
      e.cancelBubble = true;
      const gesture = this.handleGesture;
      const pointer = this.pointerInCanvas();
      if (!gesture || !pointer) return;

      const { ref } = gesture;
      const dx = pointer.x - ref.item.x;
      const dy = pointer.y - ref.item.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const angle = Math.atan2(dy, dx);
      const angleDelta = (angle - gesture.startAngle) * 180 / Math.PI;

      ref.item.scale = clamp(
        gesture.startScale * (distance / gesture.startDistance),
        0.1,
        8
      );
      ref.item.rotation = gesture.startRotation + angleDelta;
      ref.transformOnly();
      this.transformer.forceUpdate();
      this.positionTransformHandle();
      this.layer.batchDraw();
      this.repositionMenu();
    });

    this.transformHandle.on("dragend", (e) => {
      e.cancelBubble = true;
      const gesture = this.handleGesture;
      if (!gesture) return;
      gesture.ref.group.draggable(true);
      gesture.ref.refresh();
      this.handleGesture = null;
      this.positionTransformHandle();
      this.commit();
    });
  }

  updateZoomReadout() {
    this.zoomReadout.textContent = Math.round(this.zoom * 100) + "%";
  }

  clampStagePosition() {
    const scale = this.stage.scaleX();
    const pageW = this.canvasW * scale;
    const pageH = this.canvasH * scale;
    const viewW = this.stage.width();
    const viewH = this.stage.height();

    let x = this.stage.x();
    let y = this.stage.y();

    if (pageW <= viewW - PAN_MARGIN * 2) {
      x = (viewW - pageW) / 2;
    } else {
      x = clamp(x, viewW - pageW - PAN_MARGIN, PAN_MARGIN);
    }

    if (pageH <= viewH - PAN_MARGIN * 2) {
      y = (viewH - pageH) / 2;
    } else {
      y = clamp(y, viewH - pageH - PAN_MARGIN, PAN_MARGIN);
    }

    this.stage.position({ x, y });
  }

  zoomAround(screenPoint, newScaleRaw) {
    const min = this.worldBase * ZOOM.min;
    const max = this.worldBase * ZOOM.max;
    const oldScale = this.stage.scaleX();
    const newScale = clamp(newScaleRaw, min, max);
    const world = {
      x: (screenPoint.x - this.stage.x()) / oldScale,
      y: (screenPoint.y - this.stage.y()) / oldScale,
    };

    this.stage.scale({ x: newScale, y: newScale });
    this.stage.position({
      x: screenPoint.x - world.x * newScale,
      y: screenPoint.y - world.y * newScale,
    });
    this.zoom = newScale / this.worldBase;
    this.clampStagePosition();
    this.syncTransformerScale(newScale);
    this.updateZoomReadout();
    this.stage.batchDraw();
    this.repositionMenu();
  }

  bindCanvasNavigation() {
    // Wheel zoom: desktop trackpad / mouse.
    this.stage.on("wheel", (e) => {
      e.evt.preventDefault();
      if (this.bgAdjustMode) {
        this.adjustBackgroundZoom(e.evt.deltaY > 0 ? 0.92 : 1.08);
        clearTimeout(this.bgWheelTimer);
        this.bgWheelTimer = setTimeout(() => this.commit(), 180);
        return;
      }
      const pointer = this.stage.getPointerPosition();
      if (!pointer) return;
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      this.zoomAround(pointer, this.stage.scaleX() * (1 + direction * 0.12));
    });

    // Left drag pans empty canvas; middle-button drag pans from anywhere.
    let panning = false;
    let last = null;
    let middlePan = false;
    let backgroundPanning = false;

    this.stage.on("mousedown", (e) => {
      if (this.bgAdjustMode && e.evt.button === 0) {
        backgroundPanning = true;
        last = this.stage.getPointerPosition();
        this.host.style.cursor = "grabbing";
        e.evt.preventDefault();
        return;
      }
      const middleButton = e.evt.button === 1;
      if (!middleButton && !this.isCanvasTarget(e.target)) return;
      if (middleButton) {
        e.evt.preventDefault();
        middlePan = true;
        this.freezeItemDragging();
        this.host.style.cursor = "grabbing";
      }
      panning = true;
      last = this.stage.getPointerPosition();
      this.hideMenu();
    });

    this.stage.on("mousemove", () => {
      if (backgroundPanning && last) {
        const p = this.stage.getPointerPosition();
        if (!p) return;
        this.adjustBackgroundPan(p.x - last.x, p.y - last.y);
        last = p;
        return;
      }
      if (!panning || !last) return;
      const p = this.stage.getPointerPosition();
      if (!p) return;
      this.stage.position({
        x: this.stage.x() + p.x - last.x,
        y: this.stage.y() + p.y - last.y,
      });
      last = p;
      this.clampStagePosition();
      this.stage.batchDraw();
      this.repositionMenu();
    });

    const stopMousePan = () => {
      if (backgroundPanning) {
        backgroundPanning = false;
        this.host.style.cursor = "";
        this.commit();
      }
      panning = false;
      last = null;
      if (middlePan) {
        middlePan = false;
        this.restoreItemDragging();
        this.host.style.cursor = "";
      }
    };
    this.stage.on("mouseup mouseleave", stopMousePan);
    const preventMiddleClick = (e) => {
      if (e.button === 1) e.preventDefault();
    };
    this.host.addEventListener("auxclick", preventMiddleClick);
    this.cleanup.push(() => this.host.removeEventListener("auxclick", preventMiddleClick));

    // Touch navigation: two fingers only. Start on touchstart so the gesture
    // has a stable reference point and does not jump on the first touchmove.
    const start = (e) => this.onTouchStart(e);
    const move = (e) => this.onTouchMove(e);
    const end = (e) => this.onTouchEnd(e);
    this.host.addEventListener("touchstart", start, { passive: false });
    this.host.addEventListener("touchmove", move, { passive: false });
    this.host.addEventListener("touchend", end, { passive: false });
    this.host.addEventListener("touchcancel", end, { passive: false });
    this.cleanup.push(() => {
      this.host.removeEventListener("touchstart", start);
      this.host.removeEventListener("touchmove", move);
      this.host.removeEventListener("touchend", end);
      this.host.removeEventListener("touchcancel", end);
    });
  }

  touchPoints(e) {
    const rect = this.host.getBoundingClientRect();
    return [...e.touches].map((t) => ({
      x: t.clientX - rect.left,
      y: t.clientY - rect.top,
    }));
  }

  gestureInfo(e) {
    const pts = this.touchPoints(e);
    if (pts.length < 2) return null;
    return {
      pts,
      dist: Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)),
      mid: {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      },
    };
  }

  freezeItemDragging() {
    if (this.pinchDragStates) return;
    this.pinchDragStates = [];
    this.refs.forEach((ref) => {
      this.pinchDragStates.push([ref.group, ref.group.draggable()]);
      ref.group.stopDrag();
      ref.group.draggable(false);
    });
  }

  restoreItemDragging() {
    if (!this.pinchDragStates) return;
    this.pinchDragStates.forEach(([group, draggable]) => group.draggable(draggable));
    this.pinchDragStates = null;
  }

  onTouchStart(e) {
    if (this.bgAdjustMode) {
      if (e.touches.length === 1) {
        const point = this.touchPoints(e)[0];
        this.bgGesture = { mode: "pan", last: point };
        e.preventDefault();
      } else if (e.touches.length === 2) {
        const g = this.gestureInfo(e);
        if (!g) return;
        this.bgGesture = { mode: "zoom", startDist: g.dist };
        e.preventDefault();
      }
      return;
    }
    if (e.touches.length !== 2) return;
    const g = this.gestureInfo(e);
    if (!g) return;
    e.preventDefault();
    this.beginPinch(g);
  }

  beginPinch(g) {
    this.freezeItemDragging();
    this.hideMenu();

    const stageScale = this.stage.scaleX();
    const stagePos = { x: this.stage.x(), y: this.stage.y() };

    this.pinch = {
      mode: "canvas",
      startDist: g.dist,
      startScale: stageScale,
      startMid: g.mid,
      startStage: stagePos,
      startWorld: {
        x: (g.mid.x - stagePos.x) / stageScale,
        y: (g.mid.y - stagePos.y) / stageScale,
      },
    };
  }

  onTouchMove(e) {
    if (this.bgAdjustMode) {
      if (e.touches.length === 1 && this.bgGesture?.mode === "pan") {
        const point = this.touchPoints(e)[0];
        this.adjustBackgroundPan(
          point.x - this.bgGesture.last.x,
          point.y - this.bgGesture.last.y
        );
        this.bgGesture.last = point;
        e.preventDefault();
      } else if (e.touches.length === 2) {
        const g = this.gestureInfo(e);
        if (!g) return;
        if (this.bgGesture?.mode !== "zoom") {
          this.bgGesture = { mode: "zoom", startDist: g.dist };
        } else {
          const factor = g.dist / this.bgGesture.startDist;
          this.adjustBackgroundZoom(factor);
          this.bgGesture.startDist = g.dist;
        }
        e.preventDefault();
      }
      return;
    }
    if (e.touches.length !== 2) return;
    const g = this.gestureInfo(e);
    if (!g) return;
    e.preventDefault();

    if (!this.pinch) this.beginPinch(g);
    const p = this.pinch;
    const factor = g.dist / p.startDist;

    const min = this.worldBase * ZOOM.min;
    const max = this.worldBase * ZOOM.max;
    const newScale = clamp(p.startScale * factor, min, max);

    this.stage.scale({ x: newScale, y: newScale });
    this.stage.position({
      x: g.mid.x - p.startWorld.x * newScale,
      y: g.mid.y - p.startWorld.y * newScale,
    });
    this.zoom = newScale / this.worldBase;
    this.clampStagePosition();
    this.syncTransformerScale(newScale);
    this.updateZoomReadout();
    this.stage.batchDraw();
    this.repositionMenu();
  }

  onTouchEnd(e) {
    if (this.bgAdjustMode) {
      if (!e.touches || e.touches.length === 0) {
        this.bgGesture = null;
        this.commit();
      } else if (e.touches.length === 1) {
        this.bgGesture = { mode: "pan", last: this.touchPoints(e)[0] };
      }
      return;
    }
    if (e && e.touches && e.touches.length >= 2) {
      const g = this.gestureInfo(e);
      if (g) this.beginPinch(g);
      return;
    }

    this.restoreItemDragging();
    this.pinch = null;
  }

  // ---------- stickers ----------

  allItems() {
    return [
      ...(this.project.stickerItems || []),
      ...(this.project.textItems || []),
    ];
  }

  async renderAllItems() {
    this.refs.forEach((ref) => ref.group.destroy());
    this.refs.clear();
    this.selectedId = null;
    this.transformer.nodes([]);
    this.transformHandle.visible(false);

    const items = this.allItems().sort((a, b) => a.zIndex - b.zIndex);
    await Promise.all(items.map((item) => this.spawnNode(item)));
    this.reorderLayer();
    this.layer.batchDraw();
  }

  async spawnNode(item) {
    if (item.type === "text") {
      await document.fonts?.load(`120px "${item.fontFamily}"`);
      const ref = buildTextGroup(item, { interactive: true });
      this.wireItem(ref);
      this.layer.add(ref.group);
      this.refs.set(item.id, ref);
      return ref;
    }

    const sticker = findSticker(item.packId, item.assetId);
    if (!sticker) return null;
    const img = await loadImage(sticker.url);
    const ref = buildItemGroup(item, img, { interactive: true });
    ref.item = item;
    this.wireItem(ref);
    this.layer.add(ref.group);
    this.refs.set(item.id, ref);
    return ref;
  }

  wireItem(ref) {
    const { group, art } = ref;

    art.on("click tap", (e) => {
      e.cancelBubble = true;
      if (this.bgAdjustMode) return;
      this.select(ref.item.id);
    });

    group.on("dragstart", () => {
      this.hideMenu();
      this.select(ref.item.id);
    });

    group.on("dragmove", () => {
      this.transformer.forceUpdate();
      this.positionTransformHandle();
      this.repositionMenu();
    });

    group.on("dragend", () => {
      ref.item.x = group.x();
      ref.item.y = group.y();
      this.commit();
    });

    art.on("dblclick dbltap", (e) => {
      e.cancelBubble = true;
      if (this.bgAdjustMode) return;
      this.select(ref.item.id);
      if (ref.isText) this.openTextEditor(ref.item.id);
      else this.openMenu(ref.item.id);
    });

    art.on("transform", () => {
      ref.item.rotation = art.rotation();
      ref.transformOnly();
    });

    art.on("transformend", () => {
      ref.item.rotation = art.rotation();
      ref.refresh();
      this.commit();
    });
  }

  reorderLayer() {
    this.page.moveToBottom();
    if (this.bgNode) {
      this.bgNode.moveToTop();
    }

    const sorted = this.allItems().sort((a, b) => a.zIndex - b.zIndex);
    sorted.forEach((item) => {
      const ref = this.refs.get(item.id);
      if (ref) ref.group.moveToTop();
    });
    this.transformer.moveToTop();
    this.transformHandle.moveToTop();
  }

  select(id) {
    const ref = this.refs.get(id);
    if (!ref) return;
    this.selectedId = id;
    this.transformer.nodes([ref.art]);
    this.transformer.moveToTop();
    this.positionTransformHandle();
    this.layer.batchDraw();
    this.repositionMenu();
  }

  deselect() {
    this.selectedId = null;
    this.transformer.nodes([]);
    this.transformHandle.visible(false);
    this.hideMenu();
    this.layer.batchDraw();
  }

  selectedRef() {
    return this.selectedId ? this.refs.get(this.selectedId) : null;
  }

  async addSticker(packId, assetId, x, y) {
    const maxZ = this.allItems().reduce((m, it) => Math.max(m, it.zIndex || 0), -1);
    const item = newStickerItem(packId, assetId, x, y, maxZ + 1);
    this.project.stickerItems = this.project.stickerItems || [];
    this.project.stickerItems.push(item);
    await this.spawnNode(item);
    this.reorderLayer();
    this.select(item.id);
    this.commit();
  }

  async addText(fontFamily, x, y) {
    const maxZ = this.allItems().reduce((m, it) => Math.max(m, it.zIndex || 0), -1);
    const color = this.project.lastTextColor || DEFAULT_TEXT_COLOR;
    const item = newTextItem(fontFamily, x, y, maxZ + 1, color);
    this.project.textItems = this.project.textItems || [];
    this.project.textItems.push(item);
    await document.fonts?.load(`120px "${fontFamily}"`);
    await this.spawnNode(item);
    this.reorderLayer();
    this.select(item.id);
    this.commit();
  }

  // ---------- tray ----------

  buildTray() {
    this.packCarousel = document.getElementById("pack-carousel");
    this.stickerCarousel = document.getElementById("sticker-carousel");
    this.packTab = document.getElementById("active-pack-tab");

    const packs = getPacks();
    this.activePackId = packs[0]?.id || null;
    this.packCarousel.innerHTML = "";

    packs.forEach((pack) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "pack-chip" + (pack.id === this.activePackId ? " is-active" : "");

      if (pack.thumbnailUrl) {
        const img = document.createElement("img");
        img.src = pack.thumbnailUrl;
        img.alt = "";
        chip.appendChild(img);
      }

      const label = document.createElement("span");
      label.textContent = pack.name;
      chip.appendChild(label);

      chip.addEventListener("click", () => this.activatePack(pack.id));
      this.packCarousel.appendChild(chip);
    });

    this.renderStickerStrip();
  }

  activatePack(id) {
    this.activePackId = id;
    [...this.packCarousel.children].forEach((el) => {
      el.classList.toggle("is-active", el.textContent.trim() === (getPacks().find((p) => p.id === id)?.name || ""));
    });
    this.renderStickerStrip();
  }

  renderStickerStrip() {
    const pack = getPacks().find((p) => p.id === this.activePackId);
    this.packTab.textContent = pack ? pack.name : "";
    this.stickerCarousel.innerHTML = "";
    if (!pack) return;

    pack.stickers.forEach((sticker) => {
      const chip = document.createElement("div");
      chip.className = "sticker-chip";
      chip.dataset.pack = pack.id;
      chip.dataset.asset = sticker.assetId;
      chip.dataset.url = sticker.url;

      const img = document.createElement("img");
      img.src = sticker.url;
      img.alt = "";
      chip.appendChild(img);

      this.stickerCarousel.appendChild(chip);
    });
  }

  bindTrayDrag() {
    const ghost = document.getElementById("drag-ghost");
    const textGhost = document.getElementById("text-drag-ghost");
    let dragging = null;

    const moveGhost = (x, y) => {
      ghost.style.left = x + "px";
      ghost.style.top = y + "px";
    };

    const onDown = (e) => {
      const chip = e.target.closest(".sticker-chip");
      if (!chip) return;
      e.preventDefault();
      dragging = {
        pack: chip.dataset.pack,
        asset: chip.dataset.asset,
        url: chip.dataset.url,
      };
      ghost.src = dragging.url;
      ghost.hidden = false;
      moveGhost(e.clientX, e.clientY);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };

    const onMove = (e) => {
      if (!dragging) return;
      moveGhost(e.clientX, e.clientY);
    };

    const onUp = (e) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      ghost.hidden = true;
      if (!dragging) return;

      const rect = this.host.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;

      if (inside) {
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const world = {
          x: (sx - this.stage.x()) / this.stage.scaleX(),
          y: (sy - this.stage.y()) / this.stage.scaleX(),
        };
        this.addSticker(dragging.pack, dragging.asset, world.x, world.y);
      }
      dragging = null;
    };

    this.stickerCarousel.addEventListener("pointerdown", onDown);
    const onTextDown = (e) => {
      const chip = e.target.closest(".text-chip");
      if (!chip) return;
      e.preventDefault();
      dragging = { font: chip.dataset.font, type: "text" };
      textGhost.style.fontFamily = chip.dataset.font;
      textGhost.style.color = this.project.lastTextColor || DEFAULT_TEXT_COLOR;
      textGhost.hidden = false;
      moveTextGhost(e.clientX, e.clientY);
      window.addEventListener("pointermove", onTextMove);
      window.addEventListener("pointerup", onTextUp);
    };

    const moveTextGhost = (x, y) => {
      textGhost.style.left = x + "px";
      textGhost.style.top = y + "px";
    };

    const onTextMove = (e) => {
      if (!dragging || dragging.type !== "text") return;
      moveTextGhost(e.clientX, e.clientY);
    };

    const onTextUp = (e) => {
      window.removeEventListener("pointermove", onTextMove);
      window.removeEventListener("pointerup", onTextUp);
      textGhost.hidden = true;
      if (!dragging || dragging.type !== "text") return;

      const rect = this.host.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (inside) {
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        this.addText(
          dragging.font,
          (sx - this.stage.x()) / this.stage.scaleX(),
          (sy - this.stage.y()) / this.stage.scaleX()
        );
      }
      dragging = null;
    };

    this.textCarousel.addEventListener("pointerdown", onTextDown);
    this.cleanup.push(() => {
      this.stickerCarousel.removeEventListener("pointerdown", onDown);
      this.textCarousel.removeEventListener("pointerdown", onTextDown);
    });
  }

  // ---------- background ----------

  bindTrayTabs() {
    this.tabStickers = document.getElementById("tab-stickers");
    this.tabBg = document.getElementById("tab-bg");
    this.tabText = document.getElementById("tab-text");
    this.panelStickers = document.getElementById("panel-stickers");
    this.panelBg = document.getElementById("panel-bg");
    this.panelText = document.getElementById("panel-text");
    this.textCarousel = document.getElementById("text-carousel");

    const showStickers = () => this.switchTab("stickers");
    const showBg = () => this.switchTab("background");
    const showText = () => this.switchTab("text");
    this.tabStickers.addEventListener("click", showStickers);
    this.tabBg.addEventListener("click", showBg);
    this.tabText.addEventListener("click", showText);
    this.cleanup.push(() => {
      this.tabStickers.removeEventListener("click", showStickers);
      this.tabBg.removeEventListener("click", showBg);
      this.tabText.removeEventListener("click", showText);
    });
  }

  switchTab(name) {
    const stickers = name === "stickers";
    const background = name === "background";
    const text = name === "text";
    this.tabStickers.classList.toggle("is-on", stickers);
    this.tabBg.classList.toggle("is-on", background);
    this.tabText.classList.toggle("is-on", text);
    this.panelStickers.hidden = !stickers;
    this.panelBg.hidden = !background;
    this.panelText.hidden = !text;
    if (!background && this.bgAdjustMode) {
      this.setBackgroundAdjustMode(false);
      this.commit();
    }
  }

  buildBackgroundPanel() {
    this.bgCarousel = document.getElementById("bg-carousel");
    this.bgNoneBtn = document.getElementById("bg-none");
    this.bgUploadBtn = document.getElementById("bg-upload-btn");
    this.bgAdjustBtn = document.getElementById("bg-adjust-btn");
    this.bgFileInput = document.getElementById("bg-file");

    this.bgCarousel.innerHTML = "";
    getBackgrounds().forEach((bg) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "bg-chip";
      chip.dataset.bgId = bg.id;
      chip.style.backgroundImage = `url("${bg.url}")`;
      chip.style.backgroundSize = "contain";
      chip.style.backgroundPosition = "center";
      chip.style.backgroundRepeat = "no-repeat";
      chip.textContent = bg.name || "배경";
      chip.addEventListener("click", () => this.setBackground({ type: "asset", id: bg.id, url: bg.url }));
      this.bgCarousel.appendChild(chip);
    });

    const clearBg = () => this.setBackground(null);
    const pickBg = () => this.bgFileInput.click();
    const toggleAdjust = () => this.toggleBackgroundAdjust();
    const onFile = (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) this.onPhotoPick(file);
      this.bgFileInput.value = "";
    };

    this.bgNoneBtn.addEventListener("click", clearBg);
    this.bgUploadBtn.addEventListener("click", pickBg);
    this.bgAdjustBtn.addEventListener("click", toggleAdjust);
    this.bgFileInput.addEventListener("change", onFile);
    this.cleanup.push(() => {
      this.bgNoneBtn.removeEventListener("click", clearBg);
      this.bgUploadBtn.removeEventListener("click", pickBg);
      this.bgAdjustBtn.removeEventListener("click", toggleAdjust);
      this.bgFileInput.removeEventListener("change", onFile);
    });

    this.markBgActive();
  }

  setBackground(bg) {
    this.setBackgroundAdjustMode(false);
    this.project.background = bg
      ? { ...bg, transform: { zoom: 1, x: 0, y: 0 } }
      : null;
    this.bgDirty = true;
    this.renderBackground();
    this.commit();
  }

  async onPhotoPick(file) {
    toast("사진을 불러오는 중…");
    try {
      const dataUrl = await fileToScaledDataUrl(file, 2000);
      this.setBackground({ type: "photo", dataUrl });
    } catch (err) {
      console.error(err);
      toast("사진을 불러오지 못했어요");
    }
  }

  async renderBackground() {
    if (this.bgNode) {
      this.bgNode.destroy();
      this.bgNode = null;
      this.bgImage = null;
    }

    const bg = this.project.background;
    if (bg) {
      try {
        const src = backgroundSrc(bg);
        const img = await loadBgImage(src);
        bg.transform = {
          zoom: 1,
          x: 0,
          y: 0,
          ...(bg.transform || {}),
        };
        const crop = adjustableCoverCrop(
          img.width,
          img.height,
          this.canvasW,
          this.canvasH,
          bg.transform
        );
        this.bgImage = img;
        this.bgNode = new Konva.Image({
          image: img,
          x: 0,
          y: 0,
          width: this.canvasW,
          height: this.canvasH,
          crop,
          listening: false,
          name: "bg",
        });
        this.layer.add(this.bgNode);
      } catch (err) {
        console.error("배경 렌더 실패", err);
      }
    }

    this.reorderLayer();
    this.layer.batchDraw();
    this.markBgActive();
  }

  markBgActive() {
    const bg = this.project.background;
    const activeId = bg && bg.type === "asset" ? bg.id : null;

    if (this.bgCarousel) {
      [...this.bgCarousel.children].forEach((el) => {
        el.classList.toggle("is-active", el.dataset.bgId === activeId);
      });
    }
    if (this.bgNoneBtn) this.bgNoneBtn.classList.toggle("is-active", !bg);
    if (this.bgUploadBtn) this.bgUploadBtn.classList.toggle("is-active", !!bg && bg.type === "photo");
    if (this.bgAdjustBtn) {
      this.bgAdjustBtn.disabled = !bg;
      this.bgAdjustBtn.classList.toggle("is-active", this.bgAdjustMode && !!bg);
      this.bgAdjustBtn.textContent = this.bgAdjustMode ? "조정 완료" : "배경 조정";
    }
  }

  refreshBackgroundCrop() {
    const bg = this.project.background;
    if (!bg || !this.bgNode || !this.bgImage) return;
    this.bgNode.crop(adjustableCoverCrop(
      this.bgImage.width,
      this.bgImage.height,
      this.canvasW,
      this.canvasH,
      bg.transform
    ));
    this.layer.batchDraw();
  }

  setBackgroundAdjustMode(enabled) {
    this.bgAdjustMode = !!enabled && !!this.project.background;
    this.bgGesture = null;
    if (this.project.background) {
      this.project.background.transform = {
        zoom: 1,
        x: 0,
        y: 0,
        ...(this.project.background.transform || {}),
      };
    }
    this.host.classList.toggle("is-bg-adjusting", this.bgAdjustMode);
    if (this.bgAdjustMode) {
      this.deselect();
      this.hideMenu();
      this.freezeItemDragging();
    } else {
      this.restoreItemDragging();
    }
    this.markBgActive();
  }

  toggleBackgroundAdjust() {
    if (!this.project.background) return;
    const wasAdjusting = this.bgAdjustMode;
    this.setBackgroundAdjustMode(!wasAdjusting);
    if (wasAdjusting) this.commit();
  }

  adjustBackgroundPan(dxScreen, dyScreen) {
    const bg = this.project.background;
    if (!bg) return;
    const stageScale = Math.max(0.0001, this.stage.scaleX());
    const dx = dxScreen / stageScale;
    const dy = dyScreen / stageScale;
    bg.transform.x = clamp((bg.transform.x || 0) - dx / this.canvasW * 2, -1, 1);
    bg.transform.y = clamp((bg.transform.y || 0) - dy / this.canvasH * 2, -1, 1);
    this.refreshBackgroundCrop();
  }

  adjustBackgroundZoom(factor) {
    const bg = this.project.background;
    if (!bg) return;
    bg.transform.zoom = clamp((bg.transform.zoom || 1) * factor, 1, 5);
    this.refreshBackgroundCrop();
  }

  // ---------- menu / effects ----------

  openMenu(id) {
    this.select(id);
    const ref = this.refs.get(id);
    if (!ref) return;

    this.menuEl.hidden = false;
    this.menuEl.innerHTML = "";
    this.menuManuallyPositioned = false;

    const row = document.createElement("div");
    row.className = "menu-row";
    MENU_ACTIONS.forEach((def) => {
      row.appendChild(this.menuButton(def, () => this.onMenuAction(def.key, id)));
    });
    this.menuEl.appendChild(row);

    if (this.effectsOpen) {
      const erow = document.createElement("div");
      erow.className = "menu-row";
      EFFECTS.forEach((def) => {
        const fx = ref.item.effects?.[def.key];
        erow.appendChild(this.menuButton(def, () => this.toggleEffect(id, def.key), !!fx?.enabled));
      });
      this.menuEl.appendChild(erow);

      if (this.openEffectKey) {
        const fx = ref.item.effects[this.openEffectKey];
        const controls = document.createElement("div");
        controls.className = "effect-controls";

        const addSlider = ({ title, min, max, step, value, format, onInput }) => {
          const row = document.createElement("div");
          row.className = "menu-slider";
          const name = document.createElement("strong");
          name.textContent = title;
          const input = document.createElement("input");
          input.type = "range";
          input.min = String(min);
          input.max = String(max);
          input.step = String(step);
          input.value = String(value);
          const label = document.createElement("span");
          label.textContent = format(Number(input.value));
          input.addEventListener("input", () => {
            const next = Number(input.value);
            label.textContent = format(next);
            onInput(next);
            ref.refresh();
            this.layer.batchDraw();
          });
          input.addEventListener("change", () => this.commit());
          row.appendChild(name);
          row.appendChild(input);
          row.appendChild(label);
          controls.appendChild(row);
        };

        const brightness = this.openEffectKey === "brightness";
        addSlider({
          title: brightness ? "밝기" : "강도",
          min: brightness ? -1 : 0,
          max: 1,
          step: 0.01,
          value: fx.intensity ?? (brightness ? 0.25 : 0.5),
          format: (value) =>
            brightness
              ? `${value >= 0 ? "+" : ""}${Math.round(value * 100)}`
              : String(Math.round(value * 100)),
          onInput: (value) => {
            fx.intensity = value;
            fx.enabled = brightness ? Math.abs(value) > 0.001 : value > 0;
          },
        });

        if (this.openEffectKey === "floorShadow") {
          addSlider({
            title: "위치",
            min: -0.8,
            max: 0.8,
            step: 0.01,
            value: fx.offsetY ?? 0,
            format: (value) => `${value >= 0 ? "+" : ""}${Math.round(value * 100)}`,
            onInput: (value) => {
              fx.offsetY = value;
            },
          });
        }
        this.menuEl.appendChild(controls);
      }
    }

    this.repositionMenu();
  }

  openTextEditor(id) {
    this.select(id);
    const ref = this.refs.get(id);
    if (!ref || !ref.isText) return;

    this.menuEl.hidden = false;
    this.menuEl.innerHTML = "";
    this.menuManuallyPositioned = false;

    const actions = document.createElement("div");
    actions.className = "menu-row";
    TEXT_MENU_ACTIONS.forEach((def) => {
      actions.appendChild(this.menuButton(def, () => this.onMenuAction(def.key, id)));
    });
    this.menuEl.appendChild(actions);

    const editor = document.createElement("div");
    editor.className = "text-editor";

    const textInput = document.createElement("input");
    textInput.className = "text-editor__input";
    textInput.type = "text";
    textInput.maxLength = 40;
    textInput.value = ref.item.text || "텍스트";
    textInput.setAttribute("aria-label", "텍스트 내용");

    const color = parseHsl(ref.item.color);
    const box = document.createElement("div");
    box.className = "hsl-box";
    box.style.setProperty("--hue", color.h);
    const cursor = document.createElement("span");
    cursor.className = "hsl-box__cursor";
    box.appendChild(cursor);

    const hue = document.createElement("input");
    hue.className = "hsl-hue";
    hue.type = "range";
    hue.min = "0";
    hue.max = "360";
    hue.value = String(color.h);
    hue.setAttribute("aria-label", "색상");

    const palette = document.createElement("div");
    palette.className = "color-palette";
    const addColorButton = document.createElement("button");
    addColorButton.type = "button";
    addColorButton.className = "color-palette__add";
    addColorButton.textContent = "+";
    addColorButton.setAttribute("aria-label", "현재 색상을 팔레트에 추가");

    const positionCursor = () => {
      cursor.style.left = color.s + "%";
      cursor.style.top = (100 - color.l) + "%";
    };

    const applyColor = () => {
      ref.item.color = hslString(color.h, color.s, color.l);
      ref.refresh();
      this.transformer.forceUpdate();
      this.positionTransformHandle();
      this.layer.batchDraw();
    };

    const rememberLastColor = () => {
      const next = hslString(color.h, color.s, color.l);
      this.project.lastTextColor = next;
      this.commit();
    };

    const addColorToPalette = () => {
      const next = hslString(color.h, color.s, color.l);
      this.project.lastTextColor = next;
      const paletteValues = [
        next,
        ...(this.project.textPalette || []).filter((value) => value !== next),
      ].slice(0, 8);
      this.project.textPalette = paletteValues;
      renderPalette();
      this.commit();
    };

    const updateFromPointer = (event) => {
      const rect = box.getBoundingClientRect();
      color.s = clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100);
      color.l = clamp(100 - ((event.clientY - rect.top) / rect.height) * 100, 0, 100);
      positionCursor();
      applyColor();
    };

    const beginColorDrag = (event) => {
      event.preventDefault();
      updateFromPointer(event);
      const move = (e) => updateFromPointer(e);
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        rememberLastColor();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
    };

    const renderPalette = () => {
      palette.innerHTML = "";
      (this.project.textPalette || []).forEach((value) => {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "color-swatch" + (value === ref.item.color ? " is-active" : "");
        swatch.style.background = value;
        swatch.setAttribute("aria-label", `최근 색상 ${value}`);
        swatch.addEventListener("click", () => {
          const selected = parseHsl(value);
          Object.assign(color, selected);
          hue.value = String(color.h);
          box.style.setProperty("--hue", color.h);
          positionCursor();
          applyColor();
          rememberLastColor();
          renderPalette();
        });
        palette.appendChild(swatch);
      });
      palette.appendChild(addColorButton);
    };

    textInput.addEventListener("input", () => {
      ref.item.text = textInput.value || "텍스트";
      ref.refresh();
      this.transformer.forceUpdate();
      this.positionTransformHandle();
      this.layer.batchDraw();
      this.repositionMenu();
    });
    textInput.addEventListener("change", () => this.commit());
    box.addEventListener("pointerdown", beginColorDrag);
    hue.addEventListener("input", () => {
      color.h = Number(hue.value);
      box.style.setProperty("--hue", color.h);
      applyColor();
    });
    hue.addEventListener("change", rememberLastColor);
    addColorButton.addEventListener("click", addColorToPalette);

    positionCursor();
    renderPalette();
    editor.appendChild(textInput);
    editor.appendChild(box);
    editor.appendChild(hue);
    editor.appendChild(palette);
    this.menuEl.appendChild(editor);
    this.repositionMenu();
  }

  menuButton(def, onClick, isOn = false) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-btn" + (def.danger ? " is-danger" : "") + (isOn ? " is-on" : "");
    btn.setAttribute("aria-label", def.tip);
    if (def.icon) {
      const img = document.createElement("img");
      img.src = `./assets/menu-icons/${def.icon}`;
      img.alt = "";
      img.draggable = false;
      btn.appendChild(img);
    } else {
      btn.textContent = def.label;
    }
    btn.dataset.tip = def.tip;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  onMenuAction(key, id) {
    const ref = this.refs.get(id);
    if (!ref) return;
    const item = ref.item;

    if (key === "flipH") item.flipX = !item.flipX;
    if (key === "flipV") item.flipY = !item.flipY;
    if (key === "forward") return this.restack(id, 1);
    if (key === "backward") return this.restack(id, -1);
    if (key === "delete") return this.removeItem(id);
    if (key === "effects") {
      this.effectsOpen = !this.effectsOpen;
      if (!this.effectsOpen) this.openEffectKey = null;
      this.openMenu(id);
      return;
    }

    ref.refresh();
    this.transformer.forceUpdate();
    this.positionTransformHandle();
    this.layer.batchDraw();
    this.commit();
    this.repositionMenu();
  }

  toggleEffect(id, key) {
    const ref = this.refs.get(id);
    if (!ref) return;
    const fx = ref.item.effects[key];

    if (this.openEffectKey === key) {
      fx.enabled = !fx.enabled;
      if (!fx.enabled) this.openEffectKey = null;
    } else {
      this.openEffectKey = key;
      fx.enabled = true;
      if (key === "brightness") {
        if (!fx.intensity) fx.intensity = 0.25;
      } else if (!fx.intensity || fx.intensity <= 0) {
        fx.intensity = 0.5;
      }
    }

    ref.refresh();
    this.layer.batchDraw();
    this.openMenu(id);
    this.commit();
  }

  restack(id, dir) {
    const sorted = this.allItems().sort((a, b) => a.zIndex - b.zIndex);
    const idx = sorted.findIndex((item) => item.id === id);
    const swap = idx + dir;
    if (idx < 0 || swap < 0 || swap >= sorted.length) return;

    [sorted[idx], sorted[swap]] = [sorted[swap], sorted[idx]];
    sorted.forEach((item, i) => {
      item.zIndex = i;
    });
    this.reorderLayer();
    this.layer.batchDraw();
    this.commit();
  }

  removeItem(id) {
    const ref = this.refs.get(id);
    if (ref) ref.group.destroy();
    this.refs.delete(id);
    this.project.stickerItems = (this.project.stickerItems || []).filter((item) => item.id !== id);
    this.project.textItems = (this.project.textItems || []).filter((item) => item.id !== id);
    this.deselect();
    this.commit();
  }

  menuBounds(menuWidth, menuHeight) {
    const pad = 12;
    const viewWidth = this.wrap.clientWidth;
    const viewHeight = this.wrap.clientHeight;
    const scale = this.stage.scaleX();
    const page = {
      left: this.stage.x(),
      top: this.stage.y(),
      right: this.stage.x() + this.canvasW * scale,
      bottom: this.stage.y() + this.canvasH * scale,
    };

    let bounds = {
      left: Math.max(pad, page.left + pad),
      top: Math.max(pad, page.top + pad),
      right: Math.min(viewWidth - pad, page.right - pad),
      bottom: Math.min(viewHeight - pad, page.bottom - pad),
    };
    if (bounds.right - bounds.left < menuWidth || bounds.bottom - bounds.top < menuHeight) {
      bounds = { left: pad, top: pad, right: viewWidth - pad, bottom: viewHeight - pad };
    }
    return bounds;
  }

  clampMenuPosition(x, y) {
    const width = this.menuEl.offsetWidth;
    const height = this.menuEl.offsetHeight;
    const bounds = this.menuBounds(width, height);
    return {
      x: clamp(x, bounds.left, Math.max(bounds.left, bounds.right - width)),
      y: clamp(y, bounds.top, Math.max(bounds.top, bounds.bottom - height)),
    };
  }

  bindMenuDrag() {
    const onPointerDown = (event) => {
      if (this.menuEl.hidden || event.button !== 0) return;
      if (event.target.closest("button, input, .hsl-box")) return;

      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = parseFloat(this.menuEl.style.left) || 0;
      const startTop = parseFloat(this.menuEl.style.top) || 0;
      this.menuManuallyPositioned = true;
      this.menuEl.classList.add("is-dragging");

      const move = (e) => {
        const next = this.clampMenuPosition(
          startLeft + e.clientX - startX,
          startTop + e.clientY - startY
        );
        this.menuEl.style.left = next.x + "px";
        this.menuEl.style.top = next.y + "px";
      };
      const end = () => {
        this.menuEl.classList.remove("is-dragging");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    };

    this.menuEl.addEventListener("pointerdown", onPointerDown);
    this.cleanup.push(() => this.menuEl.removeEventListener("pointerdown", onPointerDown));
  }

  repositionMenu() {
    if (!this.menuEl || this.menuEl.hidden) return;
    if (this.menuManuallyPositioned) {
      const position = this.clampMenuPosition(
        parseFloat(this.menuEl.style.left) || 0,
        parseFloat(this.menuEl.style.top) || 0
      );
      this.menuEl.style.left = position.x + "px";
      this.menuEl.style.top = position.y + "px";
      return;
    }
    const ref = this.selectedRef();
    if (!ref) return;
    const box = ref.art.getClientRect();
    const width = this.menuEl.offsetWidth;
    const height = this.menuEl.offsetHeight;
    const gap = 14;
    const bounds = this.menuBounds(width, height);
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const candidates = [
      { x: centerX - width / 2, y: box.y - gap - height },
      { x: centerX - width / 2, y: box.y + box.height + gap },
      { x: box.x + box.width + gap, y: centerY - height / 2 },
      { x: box.x - gap - width, y: centerY - height / 2 },
    ];
    const overlapArea = (candidate) => {
      const left = Math.max(candidate.x, box.x);
      const top = Math.max(candidate.y, box.y);
      const right = Math.min(candidate.x + width, box.x + box.width);
      const bottom = Math.min(candidate.y + height, box.y + box.height);
      return Math.max(0, right - left) * Math.max(0, bottom - top);
    };
    const overflow = (candidate) =>
      Math.max(0, bounds.left - candidate.x) +
      Math.max(0, bounds.top - candidate.y) +
      Math.max(0, candidate.x + width - bounds.right) +
      Math.max(0, candidate.y + height - bounds.bottom);

    candidates.sort((a, b) =>
      overflow(a) * 1000 + overlapArea(a) - (overflow(b) * 1000 + overlapArea(b))
    );
    const position = this.clampMenuPosition(candidates[0].x, candidates[0].y);
    this.menuEl.style.left = position.x + "px";
    this.menuEl.style.top = position.y + "px";
  }

  hideMenu() {
    if (this.menuEl) this.menuEl.hidden = true;
    this.menuManuallyPositioned = false;
    this.effectsOpen = false;
    this.openEffectKey = null;
  }

  // ---------- history / persistence ----------

  snapshot() {
    return JSON.stringify({
      title: this.project.title,
      canvasType: this.project.canvasType,
      background: this.project.background || null,
      stickerItems: clone(this.project.stickerItems || []),
      textItems: clone(this.project.textItems || []),
      lastTextColor: this.project.lastTextColor || DEFAULT_TEXT_COLOR,
      textPalette: clone(this.project.textPalette || []),
    });
  }

  async restoreSnapshot() {
    const snap = JSON.parse(this.history[this.hIndex]);
    this.project.title = snap.title || this.project.title || "제목 없는 프로젝트";
    this.project.canvasType = normalizeCanvasType(snap.canvasType || this.project.canvasType);
    this.project.background = snap.background || null;
    this.project.stickerItems = snap.stickerItems || [];
    this.project.textItems = snap.textItems || [];
    this.project.lastTextColor = snap.lastTextColor || DEFAULT_TEXT_COLOR;
    this.project.textPalette = snap.textPalette || [];
    this.titleInput.value = this.project.title;
    await this.changeCanvasType(this.project.canvasType, {
      repositionItems: false,
      commit: false,
    });
    await this.renderAllItems();
    this.hideMenu();
    this.updateHistoryButtons();
  }

  commit() {
    const next = this.snapshot();
    if (next === this.history[this.hIndex]) return;
    this.history = this.history.slice(0, this.hIndex + 1);
    this.history.push(next);
    this.hIndex = this.history.length - 1;
    this.updateHistoryButtons();
  }

  undo() {
    if (this.hIndex <= 0) return;
    this.hIndex--;
    this.restoreSnapshot();
  }

  redo() {
    if (this.hIndex >= this.history.length - 1) return;
    this.hIndex++;
    this.restoreSnapshot();
  }

  updateHistoryButtons() {
    document.getElementById("btn-undo").disabled = this.hIndex <= 0;
    document.getElementById("btn-redo").disabled = this.hIndex >= this.history.length - 1;
  }

  bindChrome() {
    this.ratioSelect = document.getElementById("canvas-ratio-select");
    this.ratioSelect.value = this.project.canvasType;
    this.ratioSelect.onchange = () => this.changeCanvasType(this.ratioSelect.value);

    const screen = document.getElementById("screen-editor");
    const toggleUi = document.getElementById("btn-toggle-ui");
    screen.classList.remove("ui-hidden");
    toggleUi.textContent = "⌄";
    toggleUi.setAttribute("aria-label", "UI 숨기기");
    toggleUi.title = "UI 숨기기";
    toggleUi.onclick = () => {
      const hidden = screen.classList.toggle("ui-hidden");
      toggleUi.textContent = hidden ? "⌃" : "⌄";
      toggleUi.setAttribute("aria-label", hidden ? "UI 펼치기" : "UI 숨기기");
      toggleUi.title = hidden ? "UI 펼치기" : "UI 숨기기";
      requestAnimationFrame(() => this.resize());
    };

    document.getElementById("btn-undo").onclick = () => this.undo();
    document.getElementById("btn-redo").onclick = () => this.redo();
    document.getElementById("btn-save").onclick = () => this.save();
    document.getElementById("btn-export").onclick = () => this.doExport();
    document.getElementById("btn-back").onclick = () => this.exit();

    this.titleInput.oninput = () => {
      this.project.title = this.titleInput.value.trim() || "제목 없는 프로젝트";
      this.commit();
    };
  }

  async save() {
    this.project.updatedAt = Date.now();
    await putProject(this.project);
    this.savedIndex = this.hIndex;
    this.bgDirty = false;
    toast("저장했어요");
    if (this.cb.onSaved) this.cb.onSaved(this.project);
  }

  async doExport() {
    toast("PNG를 만드는 중…");
    try {
      await exportPNG(this.project);
    } catch (err) {
      console.error(err);
      toast("내보내기에 실패했어요");
    }
  }

  exit() {
    if (this.hIndex !== this.savedIndex || this.bgDirty) {
      if (!confirm("저장하지 않은 변경 사항이 있어요. 목록으로 나갈까요?")) return;
    }
    this.destroy();
    app = null;
    if (this.cb.onExit) this.cb.onExit();
  }
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 1800);
}

function fileToScaledDataUrl(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("이미지 디코딩 실패"));
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
