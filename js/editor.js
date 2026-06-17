// editor.js — the sticker editing surface.
import { putProject } from "./storage.js";
import { CANVAS, ZOOM, newStickerItem } from "./model.js";
import { getPacks, findSticker, loadImage } from "./packs.js";
import { buildItemGroup } from "./sticker.js";
import { exportPNG } from "./export.js";
import { getBackgrounds, backgroundSrc, coverCrop, loadBgImage } from "./backgrounds.js";

const PAD = 56;            // viewport padding around the page when fitting
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const ICONS = {
  flipH: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M7 8 3 12l4 4"/><path d="M17 8l4 4-4 4"/></svg>`,
  flipV: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18"/><path d="M8 7 12 3l4 4"/><path d="M8 17l4 4 4-4"/></svg>`,
  forward: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="13" height="13" rx="2"/><path d="M3 8v11a2 2 0 0 0 2 2h11" opacity=".5"/></svg>`,
  backward: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="13" height="13" rx="2"/><path d="M21 16V5a2 2 0 0 0-2-2H8" opacity=".5"/></svg>`,
  effects: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 4.7L18 8.2l-3.5 3 1 4.8L12 13.8 8.5 16l1-4.8L6 8.2l4.2-1.5z"/></svg>`,
  delete: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>`,
  floorShadow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="4" width="8" height="9" rx="1.5"/><ellipse cx="12" cy="18" rx="8" ry="2.2" fill="currentColor" stroke="none" opacity=".55"/></svg>`,
  outline: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>`,
  blur: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9" opacity=".25"/><circle cx="12" cy="12" r="5.5" opacity=".55"/><circle cx="12" cy="12" r="2.4"/></svg>`,
  colorCorrection: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" stroke="none"/></svg>`,
};

const MENU_ACTIONS = [
  { key: "flipH", tip: "좌우 반전" },
  { key: "flipV", tip: "상하 반전" },
  { key: "forward", tip: "앞으로 가져오기" },
  { key: "backward", tip: "뒤로 보내기" },
  { key: "effects", tip: "효과" },
  { key: "delete", tip: "삭제", danger: true },
];

const EFFECT_KEYS = [
  { key: "floorShadow", tip: "바닥 그림자" },
  { key: "outline", tip: "외곽선" },
  { key: "blur", tip: "블러" },
  { key: "colorCorrection", tip: "색상 보정" },
];

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
    this.refs = new Map();        // itemId -> node ref from buildItemGroup
    this.selectedId = null;
    this.zoom = ZOOM.base;
    this.worldBase = 1;
    this.history = [JSON.stringify(project.stickerItems)];
    this.hIndex = 0;
    this.savedIndex = 0;
    this.openEffectKey = null;
    this.bgNode = null;
    this.bgDirty = false;
  }

  // ---------- lifecycle ----------
  mount() {
    this.host = document.getElementById("stage-host");
    this.host.style.touchAction = "none";
    this.wrap = document.getElementById("stage-wrap");
    this.menuEl = document.getElementById("sticker-menu");
    this.zoomReadout = document.getElementById("zoom-readout");
    this.titleInput = document.getElementById("title-input");
    this.titleInput.value = this.project.title;

    this.buildStage();
    this.buildTray();
    this.bindTrayTabs();
    this.buildBgPanel();
    this.renderAllItems();
    this.renderBackground();
    this.bindChrome();
    this.bindStageGestures();
    this.bindTrayDrag();
    this.updateHistoryButtons();
  }

  destroy() {
    if (this.stage) this.stage.destroy();
    if (this._onResize) window.removeEventListener("resize", this._onResize);
    this.hideMenu();
    this.refs.clear();
  }

  // ---------- stage ----------
  buildStage() {
    const { w, h } = CANVAS[this.project.canvasType];
    this.canvasW = w; this.canvasH = h;

    this.stage = new Konva.Stage({
      container: this.host,
      width: this.host.clientWidth,
      height: this.host.clientHeight,
    });
    this.layer = new Konva.Layer();
    this.stage.add(this.layer);

    this.page = new Konva.Rect({
      x: 0, y: 0, width: w, height: h, fill: "#ffffff", name: "page",
      shadowColor: "rgba(36,31,46,1)", shadowBlur: 30, shadowOpacity: 0.12,
      shadowOffsetY: 8, cornerRadius: 4,
    });
    this.layer.add(this.page);

    this.transformer = new Konva.Transformer({
      resizeEnabled: false,
      rotateEnabled: true,
      rotateAnchorOffset: 30,
      borderStroke: "#3D7DFF",
      borderStrokeWidth: 1.5,
      anchorStroke: "#3D7DFF",
      anchorFill: "#ffffff",
      anchorSize: 14,
      anchorCornerRadius: 7,
      name: "transformer",
    });
    this.layer.add(this.transformer);

    // empty-area tap deselects
    this.stage.on("click tap", (e) => {
      if (e.target === this.stage || e.target === this.page) this.deselect();
    });

    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
    this.fitView();
  }

  resize() {
    this.stage.size({ width: this.host.clientWidth, height: this.host.clientHeight });
    this.fitView();
    this.repositionMenu();
  }

  fitView() {
    const cw = this.stage.width(), ch = this.stage.height();
    this.worldBase = Math.min((cw - PAD) / this.canvasW, (ch - PAD) / this.canvasH);
    this.applyView(true);
  }

  // Re-center the page; keep current zoom factor.
  applyView(recenter) {
    const scale = this.worldBase * this.zoom;
    this.stage.scale({ x: scale, y: scale });
    if (recenter) {
      this.stage.position({
        x: (this.stage.width() - this.canvasW * scale) / 2,
        y: (this.stage.height() - this.canvasH * scale) / 2,
      });
    }
    this.syncTransformerScale(scale);
    this.updateZoomReadout();
    this.stage.batchDraw();
  }

  syncTransformerScale(scale) {
    // keep handle/border roughly constant on screen regardless of zoom
    this.transformer.anchorSize(14 / scale);
    this.transformer.rotateAnchorOffset(30 / scale);
    this.transformer.borderStrokeWidth(1.5 / scale);
    this.transformer.anchorStrokeWidth(1.5 / scale);
  }

  updateZoomReadout() {
    this.zoomReadout.textContent = Math.round(this.zoom * 100) + "%";
  }

  // ---------- items ----------
  renderAllItems() {
    for (const ref of this.refs.values()) ref.group.destroy();
    this.refs.clear();
    this.transformer.nodes([]);
    this.selectedId = null;

    const items = [...this.project.stickerItems].sort((a, b) => a.zIndex - b.zIndex);
    Promise.all(items.map((item) => this.spawnNode(item))).then(() => {
      this.reorderLayer();
      this.layer.batchDraw();
    });
  }

  async spawnNode(item) {
    const s = findSticker(item.packId, item.assetId);
    if (!s) return;
    const img = await loadImage(s.url);
    const ref = buildItemGroup(item, img, { interactive: true });
    ref.item = item;
    this.wireItem(ref);
    this.layer.add(ref.group);
    this.refs.set(item.id, ref);
    return ref;
  }

  wireItem(ref) {
    const { group, art } = ref;
    art.on("click tap", () => this.select(ref.item.id));
    group.on("dragstart", () => { this.hideMenu(); this.select(ref.item.id); });
    group.on("dragmove", () => this.transformer.forceUpdate());
    group.on("dragend", () => {
      ref.item.x = group.x();
      ref.item.y = group.y();
      this.commit();
    });
    art.on("dbltap dblclick", () => { this.select(ref.item.id); this.openMenu(ref.item.id); });
    // live rotation via the transformer handle
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
      this.bgNode.moveToBottom();   // bg to index 0
      this.page.moveToBottom();     // page back under bg → page(0), bg(1)
    }
    const items = [...this.project.stickerItems].sort((a, b) => a.zIndex - b.zIndex);
    for (const item of items) {
      const ref = this.refs.get(item.id);
      if (ref) ref.group.moveToTop();
    }
    this.transformer.moveToTop();
  }

  // ---------- selection ----------
  select(id) {
    const ref = this.refs.get(id);
    if (!ref) return;
    this.selectedId = id;
    this.transformer.nodes([ref.art]);
    this.transformer.moveToTop();
    this.layer.batchDraw();
    if (!this.menuEl.hidden) this.repositionMenu();
  }

  deselect() {
    this.selectedId = null;
    this.transformer.nodes([]);
    this.hideMenu();
    this.layer.batchDraw();
  }

  selectedRef() { return this.selectedId ? this.refs.get(this.selectedId) : null; }

  // ---------- gestures: pan / zoom / pinch ----------
  bindStageGestures() {
    // desktop wheel zoom around cursor
    this.stage.on("wheel", (e) => {
      e.evt.preventDefault();
      const pointer = this.stage.getPointerPosition();
      const oldScale = this.stage.scaleX();
      const dir = e.evt.deltaY > 0 ? -1 : 1;
      const factor = 1 + dir * 0.12;
      this.zoomAround(pointer, oldScale * factor);
    });

    // desktop empty-area drag-pan
    let panning = false, last = null;
    this.stage.on("mousedown", (e) => {
      if (e.target === this.stage || e.target === this.page) {
        panning = true;
        last = this.stage.getPointerPosition();
      }
    });
    this.stage.on("mousemove", () => {
      if (!panning) return;
      const p = this.stage.getPointerPosition();
      this.stage.position({
        x: this.stage.x() + (p.x - last.x),
        y: this.stage.y() + (p.y - last.y),
      });
      last = p;
      this.stage.batchDraw();
      this.repositionMenu();
    });
    const endPan = () => { panning = false; };
    this.stage.on("mouseup", endPan);

    // touch: 1-finger empty pan + 2-finger pinch (canvas or selected sticker)
    this.pinch = null;
    this.host.addEventListener("touchmove", (e) => this.onTouchMove(e), { passive: false });
    this.host.addEventListener("touchend", () => this.onTouchEnd());
    this.host.addEventListener("touchcancel", () => this.onTouchEnd());
  }

  zoomAround(screenPoint, newScaleRaw) {
    const min = this.worldBase * ZOOM.min, max = this.worldBase * ZOOM.max;
    const newScale = clamp(newScaleRaw, min, max);
    const oldScale = this.stage.scaleX();
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
    this.syncTransformerScale(newScale);
    this.updateZoomReadout();
    this.stage.batchDraw();
    this.repositionMenu();
  }

  touchPoints(e) {
    const r = this.host.getBoundingClientRect();
    return [...e.touches].map((t) => ({ x: t.clientX - r.left, y: t.clientY - r.top }));
  }

  onTouchMove(e) {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    const pts = this.touchPoints(e);
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };

    if (!this.pinch) {
      // begin: cancel any sticker drag, decide target
      for (const ref of this.refs.values()) ref.group.stopDrag();
      this.hideMenu();
      const ref = this.selectedRef();
      const overSel = ref && this.shapeAt(pts[0]) &&
        this.shapeAt(pts[0]).getAttr("itemId") === this.selectedId;
      this.pinch = {
        mode: overSel ? "sticker" : "canvas",
        startDist: dist,
        startScale: this.stage.scaleX(),
        startItemScale: ref ? ref.item.scale : 1,
        startMid: mid,
      };
      return;
    }

    const p = this.pinch;
    if (p.mode === "sticker") {
      const ref = this.selectedRef();
      if (!ref) return;
      const factor = dist / p.startDist;
      ref.item.scale = clamp(p.startItemScale * factor, 0.1, 8);
      ref.transformOnly();
      this.transformer.forceUpdate();
      this.layer.batchDraw();
    } else {
      // canvas pan + zoom around the gesture midpoint
      const factor = dist / p.startDist;
      const min = this.worldBase * ZOOM.min, max = this.worldBase * ZOOM.max;
      const newScale = clamp(p.startScale * factor, min, max);
      const world = {
        x: (p.startMid.x - this.stage.x()) / this.stage.scaleX(),
        y: (p.startMid.y - this.stage.y()) / this.stage.scaleX(),
      };
      this.stage.scale({ x: newScale, y: newScale });
      this.stage.position({ x: mid.x - world.x * newScale, y: mid.y - world.y * newScale });
      this.zoom = newScale / this.worldBase;
      this.syncTransformerScale(newScale);
      this.updateZoomReadout();
      this.layer.batchDraw();
    }
  }

  onTouchEnd() {
    if (this.pinch && this.pinch.mode === "sticker") {
      const ref = this.selectedRef();
      if (ref) ref.refresh();
      this.commit();
    }
    this.pinch = null;
  }

  shapeAt(point) {
    return this.stage.getIntersection(point);
  }

  // ---------- tray (pack + sticker carousels) ----------
  buildTray() {
    this.packCarousel = document.getElementById("pack-carousel");
    this.stickerCarousel = document.getElementById("sticker-carousel");
    this.packTab = document.getElementById("active-pack-tab");

    const packs = getPacks();
    this.activePackId = packs[0] ? packs[0].id : null;

    this.packCarousel.innerHTML = "";
    packs.forEach((pack) => {
      const chip = document.createElement("button");
      chip.className = "pack-chip" + (pack.id === this.activePackId ? " is-active" : "");
      chip.innerHTML = `<span class="pack-chip__thumb"><img src="${pack.thumbnailUrl}" alt=""></span>
        <span class="pack-chip__name">${pack.name}</span>`;
      chip.addEventListener("click", () => this.activatePack(pack.id));
      this.packCarousel.appendChild(chip);
    });
    this.renderStickerStrip();
  }

  activatePack(id) {
    this.activePackId = id;
    [...this.packCarousel.children].forEach((c, i) => {
      c.classList.toggle("is-active", getPacks()[i].id === id);
    });
    this.renderStickerStrip();
  }

  renderStickerStrip() {
    const pack = getPacks().find((p) => p.id === this.activePackId);
    this.packTab.textContent = pack ? pack.name : "";
    this.stickerCarousel.innerHTML = "";
    if (!pack) return;
    pack.stickers.forEach((s) => {
      const chip = document.createElement("div");
      chip.className = "sticker-chip";
      chip.dataset.pack = pack.id;
      chip.dataset.asset = s.assetId;
      chip.dataset.url = s.url;
      chip.innerHTML = `<img src="${s.url}" alt="">`;
      this.stickerCarousel.appendChild(chip);
    });
  }

  // drag a sticker out of the tray and drop it onto the canvas
  bindTrayDrag() {
    const ghost = document.getElementById("drag-ghost");
    let dragging = null;

    const move = (x, y) => { ghost.style.left = x + "px"; ghost.style.top = y + "px"; };

    const onDown = (e) => {
      const chip = e.target.closest(".sticker-chip");
      if (!chip) return;
      e.preventDefault();
      dragging = { pack: chip.dataset.pack, asset: chip.dataset.asset, url: chip.dataset.url };
      ghost.src = chip.dataset.url;
      ghost.hidden = false;
      move(e.clientX, e.clientY);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    const onMove = (e) => { if (dragging) move(e.clientX, e.clientY); };
    const onUp = (e) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      ghost.hidden = true;
      if (!dragging) return;
      const rect = this.host.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right &&
        e.clientY >= rect.top && e.clientY <= rect.bottom;
      if (inside) {
        const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
        const world = {
          x: (sx - this.stage.x()) / this.stage.scaleX(),
          y: (sy - this.stage.y()) / this.stage.scaleX(),
        };
        this.addSticker(dragging.pack, dragging.asset, world.x, world.y);
      }
      dragging = null;
    };
    this.stickerCarousel.addEventListener("pointerdown", onDown);
  }

  async addSticker(packId, assetId, x, y) {
    const maxZ = this.project.stickerItems.reduce((m, it) => Math.max(m, it.zIndex), -1);
    const item = newStickerItem(packId, assetId, x, y, maxZ + 1);
    this.project.stickerItems.push(item);
    await this.spawnNode(item);
    this.reorderLayer();
    this.select(item.id);
    this.commit();
  }

  // ---------- background ----------
  bindTrayTabs() {
    this.tabStickers = document.getElementById("tab-stickers");
    this.tabBg = document.getElementById("tab-bg");
    this.panelStickers = document.getElementById("panel-stickers");
    this.panelBg = document.getElementById("panel-bg");
    this.tabStickers.addEventListener("click", () => this.switchTab("stickers"));
    this.tabBg.addEventListener("click", () => this.switchTab("background"));
  }

  switchTab(name) {
    const stickers = name === "stickers";
    this.tabStickers.classList.toggle("is-on", stickers);
    this.tabBg.classList.toggle("is-on", !stickers);
    this.panelStickers.hidden = !stickers;
    this.panelBg.hidden = stickers;
  }

  buildBgPanel() {
    this.bgCarousel = document.getElementById("bg-carousel");
    this.bgNoneBtn = document.getElementById("bg-none");
    this.bgUploadBtn = document.getElementById("bg-upload-btn");
    this.bgFileInput = document.getElementById("bg-file");

    this.bgCarousel.innerHTML = "";
    getBackgrounds().forEach((bg) => {
      const chip = document.createElement("button");
      chip.className = "bg-chip";
      chip.dataset.bgId = bg.id;
      chip.style.backgroundImage = `url("${bg.url}")`;
      chip.innerHTML = `<span class="bg-chip__name">${bg.name}</span>`;
      chip.addEventListener("click", () =>
        this.setBackground({ type: "asset", id: bg.id, url: bg.url }));
      this.bgCarousel.appendChild(chip);
    });

    this.bgNoneBtn.addEventListener("click", () => this.setBackground(null));
    this.bgUploadBtn.addEventListener("click", () => this.bgFileInput.click());
    this.bgFileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) this.onPhotoPick(file);
      this.bgFileInput.value = "";
    });
    this.markBgActive();
  }

  setBackground(bg) {
    this.project.background = bg;
    this.bgDirty = true;
    this.renderBackground();
  }

  async onPhotoPick(file) {
    toast("사진을 불러오는 중…");
    try {
      const dataUrl = await fileToScaledDataUrl(file, 2000);
      this.setBackground({ type: "photo", dataUrl });
    } catch (err) {
      toast("사진을 불러오지 못했어요");
      console.error(err);
    }
  }

  async renderBackground() {
    if (this.bgNode) { this.bgNode.destroy(); this.bgNode = null; }
    const bg = this.project.background;
    if (bg) {
      try {
        const img = await loadBgImage(backgroundSrc(bg));
        const crop = coverCrop(img.width, img.height, this.canvasW, this.canvasH);
        this.bgNode = new Konva.Image({
          image: img, x: 0, y: 0, width: this.canvasW, height: this.canvasH,
          crop, listening: false, name: "bg",
        });
        this.layer.add(this.bgNode);
      } catch (err) {
        console.error(err);
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
      [...this.bgCarousel.children].forEach((c) =>
        c.classList.toggle("is-active", c.dataset.bgId === activeId));
    }
    if (this.bgNoneBtn) this.bgNoneBtn.classList.toggle("is-active", !bg);
    if (this.bgUploadBtn) this.bgUploadBtn.classList.toggle("is-active", !!bg && bg.type === "photo");
  }

  // ---------- double-tap menu ----------
  openMenu(id) {
    this.select(id);
    const ref = this.refs.get(id);
    if (!ref) return;
    this.openEffectKey = this.openEffectKey || null;
    this.menuEl.hidden = false;
    this.menuEl.innerHTML = "";

    // main action row
    const row = document.createElement("div");
    row.className = "menu-row";
    MENU_ACTIONS.forEach((a) => row.appendChild(this.menuButton(a, () => this.onMenuAction(a.key, id))));
    this.menuEl.appendChild(row);

    // effects sub-row + slider
    if (this._effectsOpen) {
      const erow = document.createElement("div");
      erow.className = "menu-row";
      EFFECT_KEYS.forEach((fx) => {
        const on = ref.item.effects[fx.key] && ref.item.effects[fx.key].enabled;
        const btn = this.menuButton(fx, () => this.toggleEffect(id, fx.key), on);
        erow.appendChild(btn);
      });
      this.menuEl.appendChild(erow);

      if (this.openEffectKey) {
        const fx = ref.item.effects[this.openEffectKey];
        const slider = document.createElement("div");
        slider.className = "menu-slider";
        slider.innerHTML = `<input type="range" min="0" max="1" step="0.01" value="${fx.intensity}">
          <span>${Math.round(fx.intensity * 100)}</span>`;
        const input = slider.querySelector("input");
        const label = slider.querySelector("span");
        input.addEventListener("input", () => {
          fx.intensity = parseFloat(input.value);
          fx.enabled = fx.intensity > 0;
          label.textContent = Math.round(fx.intensity * 100);
          ref.refresh();
          this.layer.batchDraw();
        });
        input.addEventListener("change", () => this.commit());
        this.menuEl.appendChild(slider);
      }
    }

    this.repositionMenu();
  }

  menuButton(def, onClick, isOn) {
    const btn = document.createElement("button");
    btn.className = "menu-btn" + (def.danger ? " is-danger" : "") + (isOn ? " is-on" : "");
    btn.innerHTML = ICONS[def.key];
    btn.dataset.tip = def.tip;
    btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    this.attachLongPress(btn);
    return btn;
  }

  attachLongPress(btn) {
    let t = null;
    const start = () => { t = setTimeout(() => btn.classList.add("show-tip"), 420); };
    const end = () => { clearTimeout(t); btn.classList.remove("show-tip"); };
    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", end);
    btn.addEventListener("pointerleave", end);
  }

  onMenuAction(key, id) {
    const ref = this.refs.get(id);
    if (!ref) return;
    const item = ref.item;
    switch (key) {
      case "flipH": item.flipX = !item.flipX; ref.refresh(); this.commit(); break;
      case "flipV": item.flipY = !item.flipY; ref.refresh(); this.commit(); break;
      case "forward": this.restack(id, +1); break;
      case "backward": this.restack(id, -1); break;
      case "delete": this.removeItem(id); return;
      case "effects":
        this._effectsOpen = !this._effectsOpen;
        if (!this._effectsOpen) this.openEffectKey = null;
        this.openMenu(id);
        return;
    }
    this.layer.batchDraw();
    this.repositionMenu();
  }

  toggleEffect(id, key) {
    const ref = this.refs.get(id);
    const fx = ref.item.effects[key];
    if (this.openEffectKey === key) {
      // second tap on the open effect → toggle it off
      fx.enabled = !fx.enabled;
      if (!fx.enabled) this.openEffectKey = null;
    } else {
      this.openEffectKey = key;
      fx.enabled = true;
      if (fx.intensity <= 0) fx.intensity = 0.5;
    }
    ref.refresh();
    this.layer.batchDraw();
    this.openMenu(id);
    this.commit();
  }

  restack(id, dir) {
    const sorted = [...this.project.stickerItems].sort((a, b) => a.zIndex - b.zIndex);
    const idx = sorted.findIndex((it) => it.id === id);
    const swap = idx + dir;
    if (swap < 0 || swap >= sorted.length) return;
    [sorted[idx], sorted[swap]] = [sorted[swap], sorted[idx]];
    sorted.forEach((it, i) => { it.zIndex = i; });
    this.reorderLayer();
    this.layer.batchDraw();
    this.commit();
  }

  removeItem(id) {
    const ref = this.refs.get(id);
    if (ref) ref.group.destroy();
    this.refs.delete(id);
    this.project.stickerItems = this.project.stickerItems.filter((it) => it.id !== id);
    this.deselect();
    this.commit();
  }

  repositionMenu() {
    if (this.menuEl.hidden) return;
    const ref = this.selectedRef();
    if (!ref) return;
    const box = ref.art.getClientRect();
    this.menuEl.style.left = (box.x + box.width / 2) + "px";
    this.menuEl.style.top = Math.max(54, box.y - 12) + "px";
  }

  hideMenu() {
    this.menuEl.hidden = true;
    this._effectsOpen = false;
    this.openEffectKey = null;
  }

  // ---------- history ----------
  commit() {
    this.history = this.history.slice(0, this.hIndex + 1);
    this.history.push(JSON.stringify(this.project.stickerItems));
    this.hIndex = this.history.length - 1;
    this.updateHistoryButtons();
  }

  restoreHistory() {
    this.project.stickerItems = JSON.parse(this.history[this.hIndex]);
    this.renderAllItems();
    this.hideMenu();
    this.updateHistoryButtons();
  }

  undo() { if (this.hIndex > 0) { this.hIndex--; this.restoreHistory(); } }
  redo() { if (this.hIndex < this.history.length - 1) { this.hIndex++; this.restoreHistory(); } }

  updateHistoryButtons() {
    document.getElementById("btn-undo").disabled = this.hIndex <= 0;
    document.getElementById("btn-redo").disabled = this.hIndex >= this.history.length - 1;
  }

  // ---------- chrome ----------
  bindChrome() {
    document.getElementById("btn-undo").onclick = () => this.undo();
    document.getElementById("btn-redo").onclick = () => this.redo();
    document.getElementById("btn-save").onclick = () => this.save();
    document.getElementById("btn-export").onclick = () => this.doExport();
    document.getElementById("btn-back").onclick = () => this.exit();
    this.titleInput.oninput = () => { this.project.title = this.titleInput.value.trim() || "제목 없는 프로젝트"; };
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
      toast("내보내기에 실패했어요");
      console.error(err);
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
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

// Read an uploaded image file, downscale to maxDim (longest side), return a JPEG data URL.
function fileToScaledDataUrl(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("이미지 디코딩 실패"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
