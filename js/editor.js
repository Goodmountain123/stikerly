// editor.js — sticker editing surface.
// Drop-in replacement for the broken main/js/editor.js.

import { putProject } from "./storage.js";
import {
  STICKER_BASE,
  ZOOM,
  canvasSizeFromImage,
  newStickerItem,
  newTextItem,
  projectCanvasSize,
} from "./model.js";
import { getPacks, findSticker, loadImage } from "./packs.js";
import { buildItemGroup } from "./sticker.js";
import { buildTextGroup } from "./text.js";
import { exportPNG, renderProjectDataURL } from "./export.js";
import {
  getBackgrounds,
  adjustableCoverCrop,
  backgroundSrc,
  loadBgImage,
} from "./backgrounds.js";

const PAD = 56;
const PAN_MARGIN = 80;
const UI_ICON_ROOT = "./assets/ui";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const clone = (v) => JSON.parse(JSON.stringify(v));
const DEFAULT_TEXT_COLOR = "hsl(340 82% 62%)";
const uiIconCache = new Map();

function uiIcon(name, onload) {
  if (!name) return null;
  if (uiIconCache.has(name)) return uiIconCache.get(name);
  const img = new Image();
  img.onload = () => {
    if (onload) onload();
  };
  img.src = `${UI_ICON_ROOT}/${name}`;
  uiIconCache.set(name, img);
  return img;
}

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
    this.cb = callbacks;
    this.refs = new Map();
    this.selectedId = null;
    this.selectedPart = "art";
    this.zoom = ZOOM.base;
    this.worldBase = 1;
    this.bgNode = null;
    this.bgImage = null;
    this.bgDirty = false;
    this.effectsOpen = false;
    this.openEffectKey = null;
    this.history = [this.snapshot()];
    this.hIndex = 0;
    this.savedIndex = 0;
    this.cleanup = [];
    this.pinch = null;
    this.touchCanvasPan = null;
    this.pinchDragStates = null;
    this.handleGesture = null;
    this.menuManuallyPositioned = false;
    this.inlineTextInput = null;
    this.zoomReadoutTimer = null;
    this.autoSaveTimer = null;
    this.saveVersion = 0;
  }

  mount() {
    this.host = document.getElementById("stage-host");
    this.wrap = document.getElementById("stage-wrap");
    this.menuEl = document.getElementById("sticker-menu");
    this.zoomReadout = document.getElementById("zoom-readout");
    this.fitCanvasButton = document.getElementById("fit-canvas");
    this.deleteDropZone = document.getElementById("delete-drop-zone");
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
    this.inlineTextInput?.remove();
    this.inlineTextInput = null;
    clearTimeout(this.zoomReadoutTimer);
    clearTimeout(this.autoSaveTimer);
    this.hideMenu();
    this.refs.forEach((ref) => ref.group.destroy());
    this.refs.clear();
    if (this.stage) this.stage.destroy();
  }

  // ---------- stage / viewport ----------

  buildStage() {
    const spec = projectCanvasSize(this.project);
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
    this.buildFlipControls();

    this.stage.on("click tap", (e) => {
      if (this.isCanvasTarget(e.target)) this.deselect();
    });

    this.bindCanvasNavigation();

    let portrait = window.innerHeight > window.innerWidth;
    let orientationTimer;
    const onResize = () => {
      const nextPortrait = window.innerHeight > window.innerWidth;
      if (nextPortrait !== portrait) {
        portrait = nextPortrait;
        clearTimeout(orientationTimer);
        orientationTimer = setTimeout(() => {
          this.zoom = ZOOM.base;
          this.resize();
        }, 180);
        return;
      }
      this.resize();
    };
    window.addEventListener("resize", onResize);
    this.cleanup.push(() => {
      clearTimeout(orientationTimer);
      window.removeEventListener("resize", onResize);
    });

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
    this.updateZoomReadout(false);
    this.stage.batchDraw();
  }

  syncTransformerScale(scale) {
    const s = Math.max(scale, 0.0001);
    // Konva keeps the Transformer border in screen pixels already.
    // Inversely scaling it made the box look thicker when zoomed out.
    this.transformer.borderStrokeWidth(1.5);
    this.transformHandle.radius(9 / s);
    this.transformHandle.strokeWidth(2 / s);
    this.positionTransformHandle();
    this.positionFlipControls();
  }

  buildFlipControls() {
    const makeButton = (label, action, ariaLabel, iconName = null) => {
      const group = new Konva.Group({ visible: false, name: "flip-control" });
      const circle = new Konva.Circle({
        radius: 16,
        fill: "#ffffff",
        stroke: "#3D7DFF",
        strokeWidth: 2,
        shadowColor: "rgba(36,31,46,.25)",
        shadowBlur: 6,
        shadowOffsetY: 2,
      });
      const text = new Konva.Text({
        text: label,
        fontSize: 21,
        fontStyle: "bold",
        fill: "#3D7DFF",
          width: 32,
          height: 32,
          offsetX: 16,
          offsetY: 16,
          align: "center",
          verticalAlign: "middle",
      });
      group.add(circle);
      if (iconName) {
        const image = new Konva.Image({
          image: uiIcon(iconName, () => this.layer?.batchDraw()),
          width: 24,
          height: 24,
          offsetX: 12,
          offsetY: 12,
        });
        group.add(image);
      } else {
        group.add(text);
      }
      group.on("click tap", (event) => {
        event.cancelBubble = true;
        action();
      });
      group.setAttr("ariaLabel", ariaLabel);
      this.layer.add(group);
      return group;
    };
    this.flipHorizontalControl = makeButton("↔", () => this.flipSelected("flipH"), "좌우 반전", "horizontal.png");
    this.flipVerticalControl = makeButton("↕", () => this.flipSelected("flipV"), "상하 반전", "vertical.png");
    this.textColorControl = makeButton("●", () => {
      const ref = this.selectedRef();
      if (!ref?.isText) return;
      if (!this.menuEl.hidden && this.menuEl.dataset.menuType === "text-color") {
        this.hideMenu();
      } else {
        this.openTextColorPicker(ref.item.id);
      }
    }, "글자 색상");
    this.textColorDot = this.textColorControl.findOne("Text");
    this.textColorControl.findOne("Circle").radius(12);
    this.textColorDot.fontSize(24);
    this.textColorDot.width(24);
    this.textColorDot.height(24);
    this.textColorDot.offset({ x: 12, y: 12 });
    this.textEditControl = makeButton("✎", () => {
      const ref = this.selectedRef();
      if (ref?.isText) this.beginInlineTextEdit(ref);
    }, "글자 수정", "edit.png");
    this.textEditControl.findOne("Circle").radius(12);
    const editIcon = this.textEditControl.findOne("Text");
    if (editIcon) {
      editIcon.fontSize(17);
      editIcon.width(24);
      editIcon.height(24);
      editIcon.offset({ x: 12, y: 12 });
    }
  }

  flipSelected(key) {
    const ref = this.selectedRef();
    if (!ref || ref.isText || this.selectedPart !== "art") return;
    ref.item[key === "flipH" ? "flipX" : "flipY"] =
      !ref.item[key === "flipH" ? "flipX" : "flipY"];
    ref.refresh();
    this.transformer.forceUpdate();
    this.positionTransformHandle();
    this.positionFlipControls();
    this.layer.batchDraw();
    this.commit();
  }

  positionFlipControls() {
    const ref = this.selectedRef();
    const visible = ref && !ref.isText && this.selectedPart === "art";
    const textVisible = ref?.isText && this.selectedPart === "art";
    [this.flipHorizontalControl, this.flipVerticalControl].forEach((control) => {
      if (control) control.visible(!!visible);
    });
    this.textColorControl?.visible(!!textVisible);
    this.textEditControl?.visible(!!textVisible);
    if (!visible && !textVisible) return;

    const scale = Math.max(this.stage.scaleX(), 0.0001);
    const buttonScale = 1 / scale;
    const buttonRotation = ref.item.rotation || 0;
    const rotatedPoint = (localX, localY) => {
      const rotation = buttonRotation * Math.PI / 180;
      const itemScale = ref.item.scale || 1;
      const x = localX * itemScale;
      const y = localY * itemScale;
      return {
        x: ref.group.x() + x * Math.cos(rotation) - y * Math.sin(rotation),
        y: ref.group.y() + x * Math.sin(rotation) + y * Math.cos(rotation),
      };
    };
    const left = -ref.size.w / 2;
    const right = ref.size.w / 2;
    const top = -ref.size.h / 2;
    const bottom = ref.size.h / 2;
    if (textVisible) {
      this.textColorControl.scale({ x: buttonScale, y: buttonScale });
      this.textColorControl.rotation(buttonRotation);
      this.textColorControl.position(rotatedPoint(left, bottom));
      this.textEditControl.scale({ x: buttonScale, y: buttonScale });
      this.textEditControl.rotation(buttonRotation);
      this.textEditControl.position(rotatedPoint(right, bottom));
      this.textColorDot.fill(ref.item.color || DEFAULT_TEXT_COLOR);
      this.textColorControl.moveToTop();
      this.textEditControl.moveToTop();
      return;
    }
    this.flipHorizontalControl.scale({ x: buttonScale, y: buttonScale });
    this.flipHorizontalControl.rotation(buttonRotation);
    this.flipVerticalControl.scale({ x: buttonScale, y: buttonScale });
    this.flipVerticalControl.rotation(buttonRotation);
    this.flipHorizontalControl.position(rotatedPoint(0, bottom));
    this.flipVerticalControl.position(rotatedPoint(left, 0));
    this.flipHorizontalControl.moveToTop();
    this.flipVerticalControl.moveToTop();
  }

  changeCanvasSize(spec, { repositionItems = true } = {}) {
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

    this.project.canvasWidth = spec.w;
    this.project.canvasHeight = spec.h;
    this.canvasW = spec.w;
    this.canvasH = spec.h;
    this.page.size({ width: spec.w, height: spec.h });
    this.fitView();
    this.transformer.forceUpdate();
    this.positionTransformHandle();
    this.layer.batchDraw();
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

    if (this.selectedPart === "shadow" && ref.shadow) {
      const rect = ref.shadow.getClientRect({ relativeTo: this.layer });
      this.transformHandle.position({ x: rect.x + rect.width, y: rect.y });
      this.transformHandle.visible(true);
      this.transformHandle.moveToTop();
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
      if (ref.shadow) ref.shadow.draggable(false);
      this.hideMenu();
      if (this.selectedPart === "shadow" && ref.shadow) {
        const center = {
          x: ref.group.x() + ref.shadow.x(),
          y: ref.group.y() + ref.shadow.y(),
        };
        this.handleGesture = {
          mode: "shadow",
          ref,
          center,
          startScale: ref.item.effects.floorShadow.scale || 1,
          startDistance: Math.max(1, Math.hypot(pointer.x - center.x, pointer.y - center.y)),
        };
        return;
      }
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
      if (gesture.mode === "shadow") {
        const distance = Math.max(
          1,
          Math.hypot(pointer.x - gesture.center.x, pointer.y - gesture.center.y)
        );
        ref.item.effects.floorShadow.scale = clamp(
          gesture.startScale * (distance / gesture.startDistance),
          0.2,
          5
        );
        ref.refresh();
        this.transformer.forceUpdate();
        this.positionTransformHandle();
        this.positionFlipControls();
        this.layer.batchDraw();
        return;
      }
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
      this.positionFlipControls();
      this.layer.batchDraw();
      this.repositionMenu();
    });

    this.transformHandle.on("dragend", (e) => {
      e.cancelBubble = true;
      const gesture = this.handleGesture;
      if (!gesture) return;
      gesture.ref.group.draggable(true);
      if (gesture.ref.shadow && this.selectedPart === "shadow") {
        gesture.ref.shadow.draggable(true);
      }
      gesture.ref.refresh();
      this.handleGesture = null;
      this.positionTransformHandle();
      this.positionFlipControls();
      this.commit();
    });
  }

  updateZoomReadout(show = true) {
    this.zoomReadout.textContent = Math.round(this.zoom * 100) + "%";
    if (!show) return;
    this.zoomReadout.hidden = false;
    clearTimeout(this.zoomReadoutTimer);
    this.zoomReadoutTimer = setTimeout(() => {
      this.zoomReadout.hidden = true;
    }, 900);
  }

  fitCanvasToView() {
    this.zoom = ZOOM.base;
    this.fitView();
    this.updateZoomReadout(true);
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
    this.updateZoomReadout(true);
    this.stage.batchDraw();
    this.repositionMenu();
  }

  bindCanvasNavigation() {
    // Wheel zoom: desktop trackpad / mouse.
    this.stage.on("wheel", (e) => {
      e.evt.preventDefault();
      const pointer = this.stage.getPointerPosition();
      if (!pointer) return;
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      this.zoomAround(pointer, this.stage.scaleX() * (1 + direction * 0.12));
    });

    // Left drag pans empty canvas; middle-button drag pans from anywhere.
    let panning = false;
    let last = null;
    let middlePan = false;

    this.stage.on("mousedown", (e) => {
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
    if (e.touches.length === 1) {
      const point = this.touchPoints(e)[0];
      const target = this.stage.getIntersection(point);
      if (!target || this.isCanvasTarget(target)) {
        this.touchCanvasPan = point;
        this.hideMenu();
        e.preventDefault();
      }
      return;
    }
    this.touchCanvasPan = null;
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
    if (e.touches.length === 1 && this.touchCanvasPan) {
      const point = this.touchPoints(e)[0];
      this.stage.position({
        x: this.stage.x() + point.x - this.touchCanvasPan.x,
        y: this.stage.y() + point.y - this.touchCanvasPan.y,
      });
      this.touchCanvasPan = point;
      this.clampStagePosition();
      this.stage.batchDraw();
      this.repositionMenu();
      e.preventDefault();
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
    this.updateZoomReadout(true);
    this.stage.batchDraw();
    this.repositionMenu();
  }

  onTouchEnd(e) {
    if (e && e.touches && e.touches.length >= 2) {
      const g = this.gestureInfo(e);
      if (g) this.beginPinch(g);
      return;
    }

    this.restoreItemDragging();
    this.pinch = null;
    this.touchCanvasPan = null;
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
    const { group, art, shadow } = ref;

    art.on("click tap", (e) => {
      e.cancelBubble = true;
      if (this.highlightedTrayItemId !== ref.item.id) {
        this.clearTrayItemHighlight();
      }
      const promoted = this.promoteItem(ref.item.id);
      if (!ref.isText) this.hideMenu();
      this.select(ref.item.id);
      if (promoted) this.commit();
    });

    group.on("dragstart", () => {
      if (this.highlightedTrayItemId !== ref.item.id) {
        this.clearTrayItemHighlight();
      }
      this.hideMenu();
      this.promoteItem(ref.item.id);
      this.select(ref.item.id);
      if (!ref.isText) {
        requestAnimationFrame(() => this.animateStickerPickup(ref));
      }
      this.deleteDropZone.hidden = false;
    });

    group.on("dragmove", () => {
      this.transformer.forceUpdate();
      this.positionTransformHandle();
      this.positionFlipControls();
      this.repositionMenu();
      this.updateDeleteDropZone(group);
    });

    group.on("dragend", () => {
      const shouldDelete = this.isGroupOverDeleteZone(group);
      this.deleteDropZone.hidden = true;
      this.deleteDropZone.classList.remove("is-over");
      if (shouldDelete) {
        this.removeItem(ref.item.id);
        return;
      }
      ref.item.x = group.x();
      ref.item.y = group.y();
      if (!ref.isText) this.animateStickerLanding(ref);
      this.commit();
    });

    art.on("dblclick dbltap", (e) => {
      e.cancelBubble = true;
      this.select(ref.item.id);
      this.revealItemInTray(ref.item);
    });

    art.on("transform", () => {
      ref.item.rotation = art.rotation();
      ref.transformOnly();
      this.positionTransformHandle();
      this.positionFlipControls();
    });

    art.on("transformend", () => {
      ref.item.rotation = art.rotation();
      ref.refresh();
      this.positionTransformHandle();
      this.positionFlipControls();
      this.commit();
    });

    if (shadow) {
      shadow.on("click tap", (e) => {
        e.cancelBubble = true;
        if (!ref.item.effects.floorShadow.enabled) return;
        this.select(ref.item.id, "shadow");
      });
      shadow.on("dragstart", (e) => {
        e.cancelBubble = true;
        group.draggable(false);
        this.select(ref.item.id, "shadow");
      });
      shadow.on("dragmove", (e) => {
        e.cancelBubble = true;
        const fs = ref.item.effects.floorShadow;
        fs.x = shadow.x();
        fs.y = shadow.y() - (ref.size.h / 2) * ref.item.scale - 12 * ref.item.scale;
        this.transformer.forceUpdate();
        this.positionTransformHandle();
        this.positionFlipControls();
        this.layer.batchDraw();
      });
      shadow.on("dragend", (e) => {
        e.cancelBubble = true;
        group.draggable(true);
        ref.refresh();
        this.commit();
      });
    }
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
    this.flipHorizontalControl?.moveToTop();
    this.flipVerticalControl?.moveToTop();
    this.textColorControl?.moveToTop();
    this.textEditControl?.moveToTop();
  }

  promoteItem(id) {
    const item = this.allItems().find((candidate) => candidate.id === id);
    if (!item) return false;
    const maxZ = this.allItems().reduce((max, candidate) =>
      Math.max(max, candidate.zIndex || 0), -1);
    if ((item.zIndex || 0) >= maxZ) return false;
    item.zIndex = maxZ + 1;
    this.reorderLayer();
    return true;
  }

  isGroupOverDeleteZone(group) {
    if (!this.deleteDropZone || this.deleteDropZone.hidden) return false;
    const zone = this.deleteDropZone.getBoundingClientRect();
    const scale = this.stage.scaleX();
    const wrap = this.wrap.getBoundingClientRect();
    const x = wrap.left + this.stage.x() + group.x() * scale;
    const y = wrap.top + this.stage.y() + group.y() * scale;
    return x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom;
  }

  updateDeleteDropZone(group) {
    this.deleteDropZone?.classList.toggle("is-over", this.isGroupOverDeleteZone(group));
  }

  select(id, part = "art") {
    const ref = this.refs.get(id);
    if (!ref) return;
    const previous = this.selectedRef();
    if (previous?.shadow && previous !== ref) previous.shadow.draggable(false);
    this.selectedId = id;
    this.selectedPart = part === "shadow" && ref.shadow ? "shadow" : "art";
    if (ref.shadow) ref.shadow.draggable(this.selectedPart === "shadow");
    this.transformer.nodes([this.selectedPart === "shadow" ? ref.shadow : ref.art]);
    this.transformer.moveToTop();
    this.positionTransformHandle();
    this.positionFlipControls();
    this.layer.batchDraw();
    this.repositionMenu();
  }

  deselect() {
    const ref = this.selectedRef();
    if (ref?.shadow) ref.shadow.draggable(false);
    this.selectedId = null;
    this.selectedPart = "art";
    this.transformer.nodes([]);
    this.transformHandle.visible(false);
    this.positionFlipControls();
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
    const ref = await this.spawnNode(item);
    this.reorderLayer();
    this.select(item.id);
    if (ref) this.animateStickerLanding(ref);
    this.commit();
  }

  animateStickerLanding(ref) {
    const targetScaleX = ref.art.scaleX();
    const targetScaleY = ref.art.scaleY();
    const visual = this.makeStickerMotionVisual(ref);
    visual.scale({
      x: targetScaleX * 1.24,
      y: targetScaleY * 1.24,
    });
    visual.to({
      scaleX: targetScaleX * 0.92,
      scaleY: targetScaleY * 0.92,
      duration:0.06,
      easing:Konva.Easings.EaseInOut,
      onFinish:() => {
        visual.to({
          scaleX:targetScaleX,
          scaleY:targetScaleY,
          duration:0.08,
          easing:Konva.Easings.BackEaseOut,
          onFinish:() => this.finishStickerMotionVisual(ref, visual),
        });
      },
    });
  }

  animateStickerPickup(ref) {
    const targetScaleX = ref.art.scaleX();
    const targetScaleY = ref.art.scaleY();
    const visual = this.makeStickerMotionVisual(ref);
    visual.to({
      scaleX:targetScaleX * 1.2,
      scaleY:targetScaleY * 1.2,
      duration:0.06,
      easing:Konva.Easings.BackEaseOut,
      onFinish:() => {
        visual.to({
          scaleX:targetScaleX,
          scaleY:targetScaleY,
          duration:0.09,
          easing:Konva.Easings.EaseInOut,
          onFinish:() => this.finishStickerMotionVisual(ref, visual),
        });
      },
    });
  }

  makeStickerMotionVisual(ref) {
    if (ref.motionVisual) {
      ref.motionVisual.destroy();
      ref.motionVisual = null;
    }
    ref.art.opacity(1);
    const visual = ref.art.clone({ listening:false });
    visual.opacity(1);
    ref.group.add(visual);
    ref.art.opacity(0);
    ref.motionVisual = visual;
    this.layer.batchDraw();
    return visual;
  }

  finishStickerMotionVisual(ref, visual) {
    if (ref.motionVisual !== visual) return;
    ref.art.opacity(1);
    visual.destroy();
    ref.motionVisual = null;
    this.layer.batchDraw();
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
    this.editorScreen = document.getElementById("screen-editor");
    this.tray = document.querySelector(".tray");
    this.trayResizer = document.getElementById("tray-resizer");
    this.packCarousel = document.getElementById("pack-carousel");
    this.packSearchWrap = document.getElementById("pack-search-wrap");
    this.packSearch = document.getElementById("pack-search");
    this.stickerCarousel = document.getElementById("sticker-carousel");
    this.stickerPackDetail = document.getElementById("sticker-pack-detail");
    this.stickerPackBack = document.getElementById("sticker-pack-back");
    this.stickerPackTitle = document.getElementById("sticker-pack-title");

    const packs = getPacks();
    this.activePackId = null;
    this.packCarousel.innerHTML = "";

    packs.forEach((pack) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "pack-card";
      chip.dataset.searchName = (pack.name || "").toLocaleLowerCase("ko");

      if (pack.thumbnailUrl) {
        const thumb = document.createElement("span");
        thumb.className = "pack-card__thumb";
        const img = document.createElement("img");
        img.src = pack.thumbnailUrl;
        img.alt = "";
        thumb.appendChild(img);
        chip.appendChild(thumb);
      }

      const label = document.createElement("span");
      label.className = "pack-card__name";
      const labelText = document.createElement("span");
      labelText.className = "pack-card__name-text";
      labelText.textContent = pack.name;
      label.appendChild(labelText);
      chip.appendChild(label);
      requestAnimationFrame(() => {
        const overflow = Math.max(0, labelText.scrollWidth - label.clientWidth);
        label.classList.toggle("is-overflowing", overflow > 1);
        label.style.setProperty("--pack-name-shift", `${overflow}px`);
      });

      chip.addEventListener("click", () => this.activatePack(pack.id));
      this.packCarousel.appendChild(chip);
    });

    const showPacks = () => this.showStickerPacks();
    const filterPacks = () => {
      const query = this.packSearch.value.trim().toLocaleLowerCase("ko");
      this.packCarousel.querySelectorAll(".pack-card").forEach((card) => {
        card.hidden = !!query && !card.dataset.searchName.includes(query);
      });
    };
    this.stickerPackBack.addEventListener("click", showPacks);
    this.packSearch.addEventListener("input", filterPacks);
    const clearHighlightOutsideCard = (event) => {
      if (!event.target.closest(".is-item-highlighted")) {
        this.clearTrayItemHighlight();
      }
    };
    this.tray.addEventListener("pointerdown", clearHighlightOutsideCard);
    this.cleanup.push(() => {
      this.stickerPackBack.removeEventListener("click", showPacks);
      this.packSearch.removeEventListener("input", filterPacks);
      this.tray.removeEventListener("pointerdown", clearHighlightOutsideCard);
    });
    this.bindTrayResize();
    this.bindPointerScroller(this.packCarousel, "y");
    this.showStickerPacks();
  }

  bindTrayResize() {
    const cardWidth = 89;
    const cardGap = 8;
    const trayPadding = 27;
    const minimumWidth = cardWidth + trayPadding;
    const minimumHeight = 150;
    const snapWidths = [1, 2, 3].map((columns) =>
      columns * cardWidth + (columns - 1) * cardGap + trayPadding
    );
    const snapHeights = [150, 240, 330];
    const snapRange = 34;
    const storedSize = (key) => {
      const value = localStorage.getItem(key);
      if (value === null) return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    };
    const savedWidth = storedSize("stickerly-tray-width");
    const savedHeight = storedSize("stickerly-tray-height");
    const isPortraitTray = () =>
      window.matchMedia("(max-width: 760px) and (orientation: portrait)").matches;
    const nearestSnap = (value, snaps, collapsedRange) => {
      if (value <= collapsedRange) return 0;
      let closest = value;
      let distance = Infinity;
      snaps.forEach((snap) => {
        const nextDistance = Math.abs(value - snap);
        if (nextDistance < distance) {
          distance = nextDistance;
          closest = snap;
        }
      });
      return distance <= snapRange ? closest : value;
    };
    const applySize = (value, portrait = isPortraitTray()) => {
      const property = portrait ? "--tray-height" : "--tray-width";
      this.editorScreen.style.setProperty(property, `${value}px`);
      this.editorScreen.classList.toggle("tray-collapsed", value === 0);
    };
    const initialPortrait = isPortraitTray();
    const initialValue = initialPortrait
      ? (savedHeight ?? minimumHeight)
      : (savedWidth ?? minimumWidth);
    applySize(initialValue, initialPortrait);

    let dragging = false;
    let moved = false;
    let portraitDrag = false;
    let startPointer = 0;
    let currentSize = initialValue;
    let frame = 0;
    const move = (event) => {
      if (!dragging) return;
      event.preventDefault();
      const rect = this.editorScreen.getBoundingClientRect();
      const pointer = portraitDrag ? event.clientY : event.clientX;
      const maxSize = portraitDrag
        ? Math.min(420, rect.height * 0.6)
        : Math.min(520, rect.width * 0.55);
      const size = Math.round(clamp(
        portraitDrag ? rect.bottom - event.clientY : rect.right - event.clientX,
        0,
        maxSize
      ));
      moved ||= Math.abs(pointer - startPointer) > 5;
      currentSize = size;
      applySize(size, portraitDrag);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => this.resize());
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("is-resizing-tray");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const minimumSize = portraitDrag ? minimumHeight : minimumWidth;
      const collapsedRange = Math.round(minimumSize * 0.48);
      const snaps = portraitDrag ? snapHeights : snapWidths;
      let finalSize = currentSize;
      if (!moved) {
        finalSize = this.editorScreen.classList.contains("tray-collapsed")
          ? minimumSize
          : currentSize <= minimumSize
            ? 0
            : currentSize;
      } else if (currentSize < collapsedRange) {
        finalSize = 0;
      } else {
        finalSize = nearestSnap(currentSize, snaps, collapsedRange);
      }
      this.editorScreen.classList.add("tray-snapping");
      void this.editorScreen.offsetWidth;
      applySize(finalSize, portraitDrag);
      localStorage.setItem(
        portraitDrag ? "stickerly-tray-height" : "stickerly-tray-width",
        String(finalSize)
      );
      setTimeout(() => this.editorScreen.classList.remove("tray-snapping"), 240);
      requestAnimationFrame(() => this.resize());
    };
    const down = (event) => {
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      moved = false;
      portraitDrag = isPortraitTray();
      startPointer = portraitDrag ? event.clientY : event.clientX;
      currentSize = parseFloat(
        getComputedStyle(this.editorScreen).getPropertyValue(
          portraitDrag ? "--tray-height" : "--tray-width"
        )
      ) || 0;
      document.body.classList.add("is-resizing-tray");
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };
    let previousPortrait = initialPortrait;
    const syncOrientation = () => {
      const portrait = isPortraitTray();
      if (portrait === previousPortrait || dragging) return;
      previousPortrait = portrait;
      const saved = storedSize(
        portrait ? "stickerly-tray-height" : "stickerly-tray-width"
      );
      applySize(
        saved ?? (portrait ? minimumHeight : minimumWidth),
        portrait
      );
      requestAnimationFrame(() => this.resize());
    };
    this.trayResizer.addEventListener("pointerdown", down);
    window.addEventListener("resize", syncOrientation);
    this.cleanup.push(() => {
      cancelAnimationFrame(frame);
      up();
      this.trayResizer.removeEventListener("pointerdown", down);
      window.removeEventListener("resize", syncOrientation);
    });
  }

  activatePack(id) {
    this.activePackId = id;
    const pack = getPacks().find((item) => item.id === id);
    this.packCarousel.hidden = true;
    this.packSearchWrap.hidden = true;
    this.stickerPackDetail.hidden = false;
    this.stickerPackTitle.textContent = pack?.name || "";
    this.renderStickerStrip();
  }

  showStickerPacks() {
    this.activePackId = null;
    this.packCarousel.hidden = false;
    this.packSearchWrap.hidden = false;
    this.stickerPackDetail.hidden = true;
    this.stickerCarousel.innerHTML = "";
  }

  renderStickerStrip() {
    const pack = getPacks().find((p) => p.id === this.activePackId);
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

  bindPointerScroller(container, axis = "x") {
    if (!container || container.dataset.dragScrollBound) return;
    container.dataset.dragScrollBound = "true";
    let state = null;
    const down = (e) => {
      if (e.button !== 0) return;
      state = {
        x: e.clientX,
        y: e.clientY,
        left: container.scrollLeft,
        top: container.scrollTop,
        moved: false,
      };
      window.addEventListener("pointermove", move, { passive: false });
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };
    const move = (e) => {
      if (!state) return;
      const dx = e.clientX - state.x;
      const dy = e.clientY - state.y;
      if (Math.hypot(dx, dy) > 5) state.moved = true;
      if (!state.moved) return;
      e.preventDefault();
      if (axis === "y") container.scrollTop = state.top - dy;
      else container.scrollLeft = state.left - dx;
    };
    const up = () => {
      if (state?.moved) {
        const blockClick = (e) => {
          e.preventDefault();
          e.stopPropagation();
        };
        container.addEventListener("click", blockClick, { capture: true, once: true });
      }
      state = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    container.addEventListener("pointerdown", down);
    this.cleanup.push(() => {
      container.removeEventListener("pointerdown", down);
      delete container.dataset.dragScrollBound;
    });
  }

  bindTrayDrag() {
    const ghost = document.getElementById("drag-ghost");
    const stickerPreview = document.getElementById("sticker-preview");
    const textGhost = document.getElementById("text-drag-ghost");
    const tray = document.querySelector(".tray");
    let gesture = null;

    const moveGhost = (x, y) => {
      ghost.style.left = x + "px";
      ghost.style.top = y + "px";
    };
    const sizeGhostForCanvas = () => {
      const size = STICKER_BASE * this.stage.scaleX();
      ghost.style.width = `${size}px`;
      ghost.style.height = `${size}px`;
    };
    const showStickerPreview = (url, x, y, touch = false) => {
      stickerPreview.src = url;
      stickerPreview.style.left = x + "px";
      stickerPreview.style.top = y + "px";
      stickerPreview.classList.toggle("is-touch", touch);
      stickerPreview.hidden = false;
    };
    const hideStickerPreview = () => {
      stickerPreview.hidden = true;
      stickerPreview.classList.remove("is-touch");
    };
    const clearStickerHold = () => {
      if (!gesture?.holdTimer) return;
      clearTimeout(gesture.holdTimer);
      gesture.holdTimer = null;
    };
    const isInsideTray = (e) => {
      const rect = tray.getBoundingClientRect();
      return e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom;
    };

    const onDown = (e) => {
      const chip = e.target.closest(".sticker-chip");
      if (!chip) return;
      e.preventDefault();
      hideStickerPreview();
      const chipRect = chip.getBoundingClientRect();
      const insetX = chipRect.width * 0.2;
      const insetY = chipRect.height * 0.18;
      const canExtract =
        e.clientX >= chipRect.left + insetX &&
        e.clientX <= chipRect.right - insetX &&
        e.clientY >= chipRect.top + insetY &&
        e.clientY <= chipRect.bottom - insetY;
      gesture = {
        type: "sticker",
        pack: chip.dataset.pack,
        asset: chip.dataset.asset,
        url: chip.dataset.url,
        startX: e.clientX,
        startY: e.clientY,
        pointerType: e.pointerType,
        lastY: e.clientY,
        canExtract,
        previewActive: false,
        holdTimer: null,
        extracting: false,
      };
      if (canExtract && e.pointerType === "mouse") {
        gesture.previewActive = true;
        gesture.extracting = true;
        ghost.src = gesture.url;
        sizeGhostForCanvas();
        ghost.classList.remove("is-popping");
        void ghost.offsetWidth;
        ghost.classList.add("is-popping");
        ghost.hidden = false;
        moveGhost(e.clientX, e.clientY);
      } else if (canExtract) {
        const pendingGesture = gesture;
        gesture.holdTimer = setTimeout(() => {
          if (gesture !== pendingGesture || gesture.extracting) return;
          gesture.holdTimer = null;
          gesture.previewActive = true;
          ghost.src = gesture.url;
          sizeGhostForCanvas();
          ghost.classList.remove("is-popping");
          void ghost.offsetWidth;
          ghost.classList.add("is-popping");
          ghost.hidden = false;
          moveGhost(gesture.startX, gesture.startY);
        }, 96);
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    };

    const onMove = (e) => {
      if (!gesture || gesture.type !== "sticker") return;
      const moved = Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY) > 5;
      if (!gesture.extracting && isInsideTray(e)) {
        if (gesture.previewActive) {
          moveGhost(e.clientX, e.clientY);
          return;
        }
        if (moved) {
          clearStickerHold();
          this.stickerCarousel.scrollTop -= e.clientY - gesture.lastY;
        }
        gesture.lastY = e.clientY;
        return;
      }
      const canStartExtraction =
        gesture.canExtract &&
        (gesture.pointerType === "mouse" ? moved : gesture.previewActive);
      if (!canStartExtraction) return;
      if (!gesture.extracting) {
        clearStickerHold();
        gesture.extracting = true;
        ghost.src = gesture.url;
        sizeGhostForCanvas();
        ghost.classList.remove("is-popping");
        void ghost.offsetWidth;
        ghost.classList.add("is-popping");
        ghost.hidden = false;
      }
      moveGhost(e.clientX, e.clientY);
    };

    const onUp = (e) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      clearStickerHold();
      ghost.hidden = true;
      ghost.classList.remove("is-popping");
      hideStickerPreview();
      if (!gesture || gesture.type !== "sticker") return;

      const rect = this.host.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;

      if (gesture.extracting && inside) {
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const world = {
          x: (sx - this.stage.x()) / this.stage.scaleX(),
          y: (sy - this.stage.y()) / this.stage.scaleX(),
        };
        this.addSticker(gesture.pack, gesture.asset, world.x, world.y);
      }
      gesture = null;
    };

    const onStickerHoverMove = (e) => {
      if (e.pointerType !== "mouse" || gesture) return;
      const chip = e.target.closest(".sticker-chip");
      if (!chip) {
        hideStickerPreview();
        return;
      }
      showStickerPreview(chip.dataset.url, e.clientX, e.clientY);
    };
    const onStickerHoverLeave = () => {
      if (!gesture) hideStickerPreview();
    };

    this.stickerCarousel.addEventListener("pointerdown", onDown);
    this.stickerCarousel.addEventListener("pointermove", onStickerHoverMove);
    this.stickerCarousel.addEventListener("pointerleave", onStickerHoverLeave);
    const onTextDown = (e) => {
      const chip = e.target.closest(".text-chip");
      if (!chip) return;
      e.preventDefault();
      gesture = {
        font: chip.dataset.font,
        type: "text",
        lastY: e.clientY,
        extracting: false,
      };
      textGhost.style.fontFamily = chip.dataset.font;
      textGhost.style.color = this.project.lastTextColor || DEFAULT_TEXT_COLOR;
      window.addEventListener("pointermove", onTextMove);
      window.addEventListener("pointerup", onTextUp);
      window.addEventListener("pointercancel", onTextUp);
    };

    const moveTextGhost = (x, y) => {
      textGhost.style.left = x + "px";
      textGhost.style.top = y + "px";
    };

    const onTextMove = (e) => {
      if (!gesture || gesture.type !== "text") return;
      if (!gesture.extracting && isInsideTray(e)) {
        this.textCarousel.scrollTop -= e.clientY - gesture.lastY;
        gesture.lastY = e.clientY;
        return;
      }
      if (!gesture.extracting) {
        gesture.extracting = true;
        textGhost.hidden = false;
      }
      moveTextGhost(e.clientX, e.clientY);
    };

    const onTextUp = (e) => {
      window.removeEventListener("pointermove", onTextMove);
      window.removeEventListener("pointerup", onTextUp);
      window.removeEventListener("pointercancel", onTextUp);
      textGhost.hidden = true;
      if (!gesture || gesture.type !== "text") return;

      const rect = this.host.getBoundingClientRect();
      const inside =
        e.clientX >= rect.left &&
        e.clientX <= rect.right &&
        e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      if (gesture.extracting && inside) {
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        this.addText(
          gesture.font,
          (sx - this.stage.x()) / this.stage.scaleX(),
          (sy - this.stage.y()) / this.stage.scaleX()
        );
      }
      gesture = null;
    };

    this.textCarousel.addEventListener("pointerdown", onTextDown);
    this.cleanup.push(() => {
      this.stickerCarousel.removeEventListener("pointerdown", onDown);
      this.stickerCarousel.removeEventListener("pointermove", onStickerHoverMove);
      this.stickerCarousel.removeEventListener("pointerleave", onStickerHoverLeave);
      this.textCarousel.removeEventListener("pointerdown", onTextDown);
      hideStickerPreview();
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
    if (this.editorScreen?.classList.contains("tray-collapsed")) {
      const portrait = window.matchMedia(
        "(max-width: 760px) and (orientation: portrait)"
      ).matches;
      const size = portrait ? 150 : 116;
      this.editorScreen.style.setProperty(
        portrait ? "--tray-height" : "--tray-width",
        `${size}px`
      );
      this.editorScreen.classList.remove("tray-collapsed");
      localStorage.setItem(
        portrait ? "stickerly-tray-height" : "stickerly-tray-width",
        String(size)
      );
      requestAnimationFrame(() => this.resize());
    }
    const stickers = name === "stickers";
    const background = name === "background";
    const text = name === "text";
    this.tabStickers.classList.toggle("is-on", stickers);
    this.tabBg.classList.toggle("is-on", background);
    this.tabText.classList.toggle("is-on", text);
    this.panelStickers.hidden = !stickers;
    this.panelBg.hidden = !background;
    this.panelText.hidden = !text;
  }

  revealItemInTray(item) {
    if (!item) return;
    this.clearTrayItemHighlight();

    let target = null;
    if (item.type === "text") {
      this.switchTab("text");
      target = [...this.textCarousel.querySelectorAll(".text-chip")]
        .find((card) => card.dataset.font === item.fontFamily);
    } else {
      this.switchTab("stickers");
      this.activatePack(item.packId);
      target = [...this.stickerCarousel.querySelectorAll(".sticker-chip")]
        .find((card) =>
          card.dataset.pack === String(item.packId) &&
          card.dataset.asset === String(item.assetId)
        );
    }

    if (!target) return;
    this.highlightedTrayItemId = item.id;
    target.classList.add("is-item-highlighted");
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    });
  }

  clearTrayItemHighlight() {
    this.tray?.querySelectorAll(".is-item-highlighted").forEach((card) => {
      card.classList.remove("is-item-highlighted");
    });
    this.highlightedTrayItemId = null;
  }

  buildBackgroundPanel() {
    this.bgCarousel = document.getElementById("bg-carousel");
    this.bgSearch = document.getElementById("bg-search");
    this.bgFileInput = document.getElementById("bg-file");

    this.bgCarousel.innerHTML = "";
    const makeActionChip = (id, icon, label, onClick) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.id = id;
      chip.className = "bg-chip bg-chip--action";
      const symbol = document.createElement("span");
      symbol.className = "bg-chip__action-icon";
      symbol.textContent = icon;
      const text = document.createElement("span");
      text.className = "bg-chip__action-label";
      text.textContent = label;
      chip.appendChild(symbol);
      chip.appendChild(text);
      chip.addEventListener("click", onClick);
      this.bgCarousel.appendChild(chip);
      return chip;
    };

    const pickBg = () => this.bgFileInput.click();
    this.bgUploadBtn = makeActionChip("bg-upload-btn", "+", "내 사진", pickBg);

    getBackgrounds().forEach((bg) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "bg-chip";
      chip.dataset.bgId = bg.id;
      chip.dataset.searchName = (bg.name || "").toLocaleLowerCase("ko");
      const thumb = document.createElement("span");
      thumb.className = "bg-chip__thumb";
      const image = document.createElement("img");
      image.src = bg.url;
      image.alt = "";
      thumb.appendChild(image);
      chip.appendChild(thumb);
      const label = document.createElement("span");
      label.className = "bg-chip__label";
      label.textContent = bg.name || "배경";
      chip.appendChild(label);
      chip.addEventListener("click", () => {
        const selected = this.project.background?.type === "asset"
          && this.project.background.id === bg.id;
        this.setBackground(selected ? null : { type: "asset", id: bg.id, url: bg.url });
      });
      this.bgCarousel.appendChild(chip);
    });

    const onFile = (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) this.onPhotoPick(file);
      this.bgFileInput.value = "";
    };
    const filterBackgrounds = () => {
      const query = this.bgSearch.value.trim().toLocaleLowerCase("ko");
      this.bgCarousel.querySelectorAll(".bg-chip:not(.bg-chip--action)").forEach((card) => {
        card.hidden = !!query && !card.dataset.searchName.includes(query);
      });
    };

    this.bgFileInput.addEventListener("change", onFile);
    this.bgSearch.addEventListener("input", filterBackgrounds);
    this.cleanup.push(() => {
      this.bgFileInput.removeEventListener("change", onFile);
      this.bgSearch.removeEventListener("input", filterBackgrounds);
    });

    this.bindPointerScroller(this.bgCarousel, "y");
    this.markBgActive();
  }

  async setBackground(bg) {
    this.project.background = bg
      ? { ...bg, transform: { zoom: 1, x: 0, y: 0 } }
      : null;
    this.markBgActive();
    if (!bg && this.bgNode) {
      const previousBgNode = this.bgNode;
      await this.animateBackgroundCollapse(previousBgNode);
      if (this.bgNode === previousBgNode) this.bgNode = null;
      this.bgImage = null;
    }
    this.bgDirty = true;
    if (bg) {
      await this.renderBackground({ animate: true });
    } else {
      this.changeCanvasSize({ w: 1080, h: 1080 });
      await this.renderBackground({ animate: true });
    }
    this.commit();
  }

  animateBackgroundCollapse(node) {
    return new Promise((resolve) => {
      node.position({ x:this.canvasW / 2, y:this.canvasH / 2 });
      node.offset({ x:this.canvasW / 2, y:this.canvasH / 2 });
      node.to({
        scaleX:0.02,
        scaleY:0.02,
        opacity:0.15,
        duration:0.25,
        easing:Konva.Easings.EaseIn,
        onFinish:() => {
          node.destroy();
          this.layer.batchDraw();
          resolve();
        },
      });
    });
  }

  async onPhotoPick(file) {
    toast("사진을 불러오는 중…");
    try {
      const dataUrl = await fileToScaledDataUrl(file, 2000);
      await this.setBackground({ type: "photo", dataUrl });
    } catch (err) {
      console.error(err);
      toast("사진을 불러오지 못했어요");
    }
  }

  async renderBackground({ animate = false } = {}) {
    const previousBgNode = this.bgNode;
    this.bgNode = null;
    this.bgImage = null;
    if (!animate) previousBgNode?.destroy();

    const bg = this.project.background;
    if (bg) {
      try {
        const src = backgroundSrc(bg);
        const img = await loadBgImage(src);
        const nextSize = canvasSizeFromImage(img.width, img.height);
        if (nextSize.w !== this.canvasW || nextSize.h !== this.canvasH) {
          this.changeCanvasSize(nextSize);
        }
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

    let transitionNode = this.bgNode;
    let removeTransitionNode = false;
    if (animate && !transitionNode) {
      transitionNode = new Konva.Rect({
        x:0,
        y:0,
        width:this.canvasW,
        height:this.canvasH,
        fill:"#ffffff",
        shadowColor:"rgba(52,38,72,.24)",
        shadowBlur:32,
        shadowOpacity:0.7,
        listening:false,
        name:"background-transition",
      });
      this.layer.add(transitionNode);
      removeTransitionNode = true;
    }

    this.reorderLayer();
    this.layer.batchDraw();
    this.markBgActive();
    if (animate && transitionNode) {
      this.animateBackgroundSwap(transitionNode, previousBgNode, removeTransitionNode);
    } else {
      previousBgNode?.destroy();
    }
  }

  animateBackgroundSwap(node, previousNode, removeAtEnd = false) {
    const centerNode = (target) => {
      target.position({ x:this.canvasW / 2, y:this.canvasH / 2 });
      target.offset({ x:this.canvasW / 2, y:this.canvasH / 2 });
    };
    const revealNext = () => {
      previousNode?.destroy();
      centerNode(node);
      node.opacity(1);
      node.scale({ x:0.02, y:0.02 });
      node.to({
        scaleX:1.08,
        scaleY:1.08,
        duration:0.28,
        easing:Konva.Easings.BackEaseOut,
        onFinish:() => {
          node.to({
            scaleX:1,
            scaleY:1,
            duration:0.13,
            easing:Konva.Easings.EaseInOut,
            onFinish:() => {
              if (removeAtEnd) {
                node.destroy();
              } else {
                node.position({ x:0, y:0 });
                node.offset({ x:0, y:0 });
                node.scale({ x:1, y:1 });
              }
              this.reorderLayer();
              this.layer.batchDraw();
            },
          });
        },
      });
    };

    node.opacity(0);
    if (!previousNode) {
      revealNext();
      return;
    }
    centerNode(previousNode);
    previousNode.to({
      scaleX:0.02,
      scaleY:0.02,
      opacity:0.15,
      duration:0.25,
      easing:Konva.Easings.EaseIn,
      onFinish:revealNext,
    });
  }

  markBgActive() {
    const bg = this.project.background;
    const activeId = bg && bg.type === "asset" ? bg.id : null;

    if (this.bgCarousel) {
      [...this.bgCarousel.children].forEach((el) => {
        el.classList.toggle("is-active", el.dataset.bgId === activeId);
      });
    }
    if (this.bgUploadBtn) this.bgUploadBtn.classList.toggle("is-active", !!bg && bg.type === "photo");
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
            if (this.selectedPart === "shadow") {
              this.transformer.forceUpdate();
              this.positionTransformHandle();
            }
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
            title: "블러",
            min: 0,
            max: 1,
            step: 0.01,
            value: fx.blur ?? 0.5,
            format: (value) => String(Math.round(value * 100)),
            onInput: (value) => {
              fx.blur = value;
            },
          });
        }
        this.menuEl.appendChild(controls);
        if (this.openEffectKey === "outglow") {
          this.menuEl.appendChild(this.buildGlowColorPicker(ref, fx));
        }
      }
    }

    if (this.openEffectKey === "floorShadow" && ref.item.effects.floorShadow.enabled) {
      this.select(id, "shadow");
    }
    this.repositionMenu();
  }

  buildGlowColorPicker(ref, fx) {
    const editor = document.createElement("div");
    editor.className = "text-editor glow-color-editor";
    const color = parseHsl(
      fx.color || this.project.lastGlowColor || "hsl(205 100% 74%)"
    );

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
    hue.setAttribute("aria-label", "아웃글로우 색상");

    const palette = document.createElement("div");
    palette.className = "color-palette";
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "color-palette__add";
    addButton.textContent = "+";
    addButton.setAttribute("aria-label", "현재 글로우 색상을 팔레트에 추가");

    const positionCursor = () => {
      cursor.style.left = color.s + "%";
      cursor.style.top = (100 - color.l) + "%";
    };
    const applyColor = () => {
      fx.color = hslString(color.h, color.s, color.l);
      ref.refresh();
      this.layer.batchDraw();
    };
    const rememberColor = () => {
      this.project.lastGlowColor = hslString(color.h, color.s, color.l);
      this.commit();
    };
    const addToPalette = () => {
      const next = hslString(color.h, color.s, color.l);
      fx.color = next;
      this.project.lastGlowColor = next;
      this.project.glowPalette = [
        next,
        ...(this.project.glowPalette || []).filter((value) => value !== next),
      ].slice(0, 8);
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
        rememberColor();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
    };
    const renderPalette = () => {
      palette.innerHTML = "";
      (this.project.glowPalette || []).forEach((value) => {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "color-swatch" + (value === fx.color ? " is-active" : "");
        swatch.style.background = value;
        swatch.setAttribute("aria-label", `최근 글로우 색상 ${value}`);
        swatch.addEventListener("click", () => {
          Object.assign(color, parseHsl(value));
          hue.value = String(color.h);
          box.style.setProperty("--hue", color.h);
          positionCursor();
          applyColor();
          rememberColor();
          renderPalette();
        });
        palette.appendChild(swatch);
      });
      palette.appendChild(addButton);
    };

    box.addEventListener("pointerdown", beginColorDrag);
    hue.addEventListener("input", () => {
      color.h = Number(hue.value);
      box.style.setProperty("--hue", color.h);
      applyColor();
    });
    hue.addEventListener("change", rememberColor);
    addButton.addEventListener("click", addToPalette);

    positionCursor();
    renderPalette();
    editor.appendChild(box);
    editor.appendChild(hue);
    editor.appendChild(palette);
    return editor;
  }

  beginInlineTextEdit(ref) {
    if (!ref?.isText) return;
    this.hideMenu();
    this.inlineTextInput?.blur();

    const item = ref.item;
    const original = item.text || "텍스트";
    const stageScale = this.stage.scaleX();
    const visualScale = item.scale * stageScale;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 40;
    input.value = original;
    input.className = "canvas-text-input";
    input.style.left = `${this.stage.x() + ref.group.x() * stageScale}px`;
    input.style.top = `${this.stage.y() + ref.group.y() * stageScale}px`;
    input.style.width = `${Math.max(90, ref.size.w * visualScale + 24)}px`;
    input.style.height = `${Math.max(42, ref.size.h * visualScale + 8)}px`;
    input.style.fontFamily = item.fontFamily;
    input.style.fontSize = `${Math.max(18, 120 * visualScale)}px`;
    input.style.color = item.color;
    input.style.transform = `translate(-50%, -50%) rotate(${item.rotation}deg)`;

    ref.art.visible(false);
    this.transformer.nodes([]);
    this.textColorControl?.visible(false);
    this.textEditControl?.visible(false);
    this.wrap.appendChild(input);
    this.inlineTextInput = input;

    const update = () => {
      item.text = input.value || "텍스트";
      ref.refresh();
      input.style.width = `${Math.max(90, ref.size.w * visualScale + 24)}px`;
    };
    const finish = (cancel = false) => {
      if (!input.isConnected) return;
      if (cancel) item.text = original;
      else update();
      input.remove();
      this.inlineTextInput = null;
      ref.art.visible(true);
      ref.refresh();
      this.select(item.id);
      this.commit();
    };

    input.addEventListener("input", update);
    input.addEventListener("blur", () => finish(false), { once: true });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(true);
      }
    });
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  openTextColorPicker(id) {
    this.select(id);
    const ref = this.refs.get(id);
    if (!ref || !ref.isText) return;

    this.menuEl.hidden = false;
    this.menuEl.dataset.menuType = "text-color";
    this.menuEl.innerHTML = "";
    this.menuManuallyPositioned = false;

    const editor = document.createElement("div");
    editor.className = "text-editor";

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
      this.positionFlipControls();
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
    this.positionFlipControls();
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
      if (!fx.enabled) {
        this.openEffectKey = null;
        this.select(id, "art");
      }
    } else {
      this.openEffectKey = key;
      fx.enabled = true;
      if (key === "brightness") {
        if (!fx.intensity) fx.intensity = 0.25;
      } else if (!fx.intensity || fx.intensity <= 0) {
        fx.intensity = 0.5;
      }
      if (key === "outglow") {
        fx.color = this.project.lastGlowColor || fx.color || "hsl(205 100% 74%)";
      }
    }

    ref.refresh();
    this.layer.batchDraw();
    this.openMenu(id);
    if (key === "floorShadow" && fx.enabled) this.select(id, "shadow");
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
    return {
      left: pad,
      top: pad,
      right: Math.max(pad + menuWidth, viewWidth - pad),
      bottom: Math.max(pad + menuHeight, viewHeight - pad),
    };
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
    if (this.menuEl) delete this.menuEl.dataset.menuType;
    this.menuManuallyPositioned = false;
    this.effectsOpen = false;
    this.openEffectKey = null;
  }

  // ---------- history / persistence ----------

  snapshot() {
    return JSON.stringify({
      title: this.project.title,
      canvasWidth: this.canvasW,
      canvasHeight: this.canvasH,
      background: this.project.background || null,
      stickerItems: clone(this.project.stickerItems || []),
      textItems: clone(this.project.textItems || []),
      lastTextColor: this.project.lastTextColor || DEFAULT_TEXT_COLOR,
      textPalette: clone(this.project.textPalette || []),
      lastGlowColor: this.project.lastGlowColor || "hsl(205 100% 74%)",
      glowPalette: clone(this.project.glowPalette || []),
    });
  }

  async restoreSnapshot() {
    const snap = JSON.parse(this.history[this.hIndex]);
    this.project.title = snap.title || this.project.title || "제목 없는 프로젝트";
    this.project.canvasWidth = snap.canvasWidth || this.project.canvasWidth || 1080;
    this.project.canvasHeight = snap.canvasHeight || this.project.canvasHeight || 1080;
    this.project.background = snap.background || null;
    this.project.stickerItems = snap.stickerItems || [];
    this.project.textItems = snap.textItems || [];
    this.project.lastTextColor = snap.lastTextColor || DEFAULT_TEXT_COLOR;
    this.project.textPalette = snap.textPalette || [];
    this.project.lastGlowColor = snap.lastGlowColor || "hsl(205 100% 74%)";
    this.project.glowPalette = snap.glowPalette || [];
    this.titleInput.value = this.project.title;
    this.changeCanvasSize(
      { w: this.project.canvasWidth, h: this.project.canvasHeight },
      { repositionItems: false }
    );
    await this.renderBackground();
    await this.renderAllItems();
    this.hideMenu();
    this.updateHistoryButtons();
    this.scheduleAutoSave();
  }

  commit() {
    const next = this.snapshot();
    if (next === this.history[this.hIndex]) return;
    this.history = this.history.slice(0, this.hIndex + 1);
    this.history.push(next);
    this.hIndex = this.history.length - 1;
    this.updateHistoryButtons();
    this.scheduleAutoSave();
  }

  scheduleAutoSave() {
    clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = setTimeout(() => {
      this.save();
    }, 250);
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
    document.getElementById("btn-export").onclick = () => this.doExport();
    document.getElementById("btn-back").onclick = () => this.exit();
    this.fitCanvasButton.onclick = () => this.fitCanvasToView();

    this.titleInput.oninput = () => {
      this.project.title = this.titleInput.value.trim() || "제목 없는 프로젝트";
      this.commit();
    };

    const deleteSelectedWithKeyboard = (event) => {
      if (event.key !== "Delete" || !this.selectedId) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable
      ) return;
      event.preventDefault();
      this.removeItem(this.selectedId);
    };
    window.addEventListener("keydown", deleteSelectedWithKeyboard);
    this.cleanup.push(() =>
      window.removeEventListener("keydown", deleteSelectedWithKeyboard)
    );
  }

  async save() {
    const saveVersion = ++this.saveVersion;
    const projectSnapshot = clone(this.project);
    try {
      const thumbnail = await renderProjectDataURL(projectSnapshot, {
        maxSize: 360,
        mimeType: "image/jpeg",
        quality: 0.82,
      });
      if (saveVersion !== this.saveVersion) return;
      this.project.thumbnail = thumbnail;
    } catch (err) {
      console.warn("프로젝트 미리보기를 만들지 못했어요.", err);
    }
    if (saveVersion !== this.saveVersion) return;
    this.project.updatedAt = Date.now();
    await putProject(this.project);
    this.savedIndex = this.hIndex;
    this.bgDirty = false;
    if (this.cb.onSaved) this.cb.onSaved(this.project);
  }

  async doExport() {
    toast("멋진 작품을 준비하는 중…");
    try {
      const result = await exportPNG(this.project);
      if (result === "shared") toast("사진으로 저장해 주세요!");
      if (result === "downloaded") toast("완성한 그림을 저장했어요!");
    } catch (err) {
      console.error(err);
      toast("그림 저장에 실패했어요");
    }
  }

  async exit() {
    clearTimeout(this.autoSaveTimer);
    await this.save();
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
