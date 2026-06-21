// main.js — app entry: project list, new-project modal, screen routing.
import { listProjects, getProject, putProject, deleteProject } from "./storage.js";
import { loadPacks, findSticker } from "./packs.js";
import {
  loadBackgrounds,
  backgroundSrc,
} from "./backgrounds.js";
import { newProject, projectCanvasSize } from "./model.js";
import { openEditor } from "./editor.js";
import { supabase, supabaseConfigured } from "./supabase.js";

const DEFAULT_WELCOME_MESSAGES = [
  "오늘은 뭘 하고 놀까요?",
  "어서오세요, 반가워요!",
  "예쁘게 꾸며봐요!",
];

const screenProjects = document.getElementById("screen-projects");
const screenEditor = document.getElementById("screen-editor");
const grid = document.getElementById("project-grid");
const emptyState = document.getElementById("empty-state");
const deleteModeButton = document.getElementById("btn-delete-mode");
const undoDeleteButton = document.getElementById("btn-undo-delete");
const deleteZone = document.getElementById("project-delete-zone");
let deleteMode = false;
let deletedProjects = [];

const modal = document.getElementById("modal-new");
const newTitle = document.getElementById("new-title");
const newCreate = document.getElementById("new-create");

async function startWelcomeTicker() {
  let messages = DEFAULT_WELCOME_MESSAGES;
  if (supabaseConfigured) {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "welcome_messages")
      .maybeSingle();
    if (Array.isArray(data?.value) && data.value.some((item) => String(item).trim())) {
      messages = data.value.map((item) => String(item).trim()).filter(Boolean);
    }
  }

  const ticker = document.getElementById("welcome-ticker");
  const text = document.getElementById("welcome-ticker-text");
  let currentIndex = Math.floor(Math.random() * messages.length);
  text.textContent = messages[currentIndex];
  if (messages.length < 2) return;

  setInterval(() => {
    let nextIndex = currentIndex;
    while (nextIndex === currentIndex) {
      nextIndex = Math.floor(Math.random() * messages.length);
    }
    ticker.classList.add("is-rolling");
    setTimeout(() => {
      currentIndex = nextIndex;
      text.textContent = messages[currentIndex];
    }, 300);
    setTimeout(() => ticker.classList.remove("is-rolling"), 650);
  }, 10000);
}

function showScreen(which) {
  screenProjects.classList.toggle("is-active", which === "projects");
  screenEditor.classList.toggle("is-active", which === "editor");
}

function fmtDate(ts) {
  const d = new Date(ts), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
}

async function renderList() {
  const projects = await listProjects();
  grid.innerHTML = "";
  emptyState.hidden = projects.length > 0;

  for (const p of projects) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.projectId = p.id;
    card.__project = p;

    // Saved canvas preview, with a legacy fallback for older projects.
    let thumbInner = "";
    if (p.thumbnail) {
      thumbInner = `<img class="card__preview" src="${p.thumbnail}" alt="">`;
    } else {
      const top = [...(p.stickerItems || [])].sort((a, b) => b.zIndex - a.zIndex)[0];
      if (top) {
        const s = findSticker(top.packId, top.assetId);
        if (s) thumbInner = `<img src="${s.url}" alt="">`;
      }
    }
    const size = projectCanvasSize(p);
    const bgStyle = p.thumbnail
      ? ` style="aspect-ratio:${size.w}/${size.h}"`
      : p.background
      ? ` style="aspect-ratio:${size.w}/${size.h};background-image:url(&quot;${backgroundSrc(p.background)}&quot;);background-size:cover;background-position:center"`
      : ` style="aspect-ratio:${size.w}/${size.h}"`;
    const stickerCount = (p.stickerItems || []).length;
    const textCount = (p.textItems || []).length;

    card.innerHTML = `
      <div class="card__thumb"${bgStyle}>${thumbInner}</div>
      <div class="card__body">
        <div class="card__title-row">
          <span class="card__name">${escapeHtml(p.title)}</span>
          <button class="card__info-toggle" type="button" aria-label="프로젝트 정보 펼치기">⌄</button>
        </div>
        <div class="card__meta" hidden>
          <span>스티커 ${stickerCount}개 · 텍스트 ${textCount}개 · ${fmtDate(p.updatedAt)}</span>
          <button class="card__duplicate" type="button">복제</button>
        </div>
      </div>`;

    card.querySelector(".card__name").addEventListener("click", () => {
      if (!deleteMode) open(p.id);
    });
    const infoToggle = card.querySelector(".card__info-toggle");
    const meta = card.querySelector(".card__meta");
    infoToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      meta.hidden = !meta.hidden;
      infoToggle.classList.toggle("is-open", !meta.hidden);
      infoToggle.textContent = meta.hidden ? "⌄" : "⌃";
      infoToggle.setAttribute("aria-label", meta.hidden
        ? "프로젝트 정보 펼치기"
        : "프로젝트 정보 접기");
    });
    card.querySelector(".card__duplicate").addEventListener("click", async (event) => {
      event.stopPropagation();
      const duplicate = {
        ...structuredClone(p),
        ...newProject(`${p.title} 복사본`, p.background, projectCanvasSize(p)),
        stickerItems: structuredClone(p.stickerItems || []),
        textItems: structuredClone(p.textItems || []),
        lastTextColor: p.lastTextColor,
        textPalette: structuredClone(p.textPalette || []),
        lastGlowColor: p.lastGlowColor,
        glowPalette: structuredClone(p.glowPalette || []),
      };
      await putProject(duplicate);
      await renderList();
    });
    card.querySelector(".card__thumb").addEventListener("click", () => {
      if (!deleteMode) open(p.id);
    });
    bindProjectDeleteDrag(card, p);
    grid.appendChild(card);
  }
}

function projectDateTitle(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

async function open(id) {
  const project = await getProject(id);
  if (!project) return;
  showScreen("editor");
  openEditor(project, {
    onExit: () => { showScreen("projects"); renderList(); },
    onSaved: () => {},
  });
}

function setDeleteMode(enabled) {
  deleteMode = enabled;
  if (!enabled) {
    deletedProjects = [];
  }
  screenProjects.classList.toggle("delete-mode", enabled);
  deleteZone.hidden = !enabled;
  undoDeleteButton.hidden = !enabled || deletedProjects.length === 0;
  deleteModeButton.classList.toggle("is-on", enabled);
}

function bindProjectDeleteDrag(card, project) {
  card.addEventListener("pointerdown", (event) => {
    if (!deleteMode || event.button !== 0 || event.target.closest("input, button")) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let ghost = null;
    const move = (e) => {
      if (!ghost && Math.hypot(e.clientX - startX, e.clientY - startY) < 6) {
        return;
      }
      if (!ghost) {
        ghost = card.cloneNode(true);
        ghost.className = "card project-drag-ghost";
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
      const zone = deleteZone.getBoundingClientRect();
      deleteZone.classList.toggle("is-over",
        e.clientX >= zone.left && e.clientX <= zone.right &&
        e.clientY >= zone.top && e.clientY <= zone.bottom);
    };
    const end = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!ghost) return;
      ghost.remove();
      const dropped = deleteZone.classList.contains("is-over");
      deleteZone.classList.remove("is-over");
      if (dropped) {
        deletedProjects.push(structuredClone(project));
        await deleteProject(project.id);
        undoDeleteButton.hidden = false;
        await renderList();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });
}

// ---------- new project modal ----------
function openModal() {
  newTitle.value = "";
  modal.hidden = false;
  newTitle.focus();
}
function closeModal() { modal.hidden = true; }

document.getElementById("btn-new").addEventListener("click", openModal);
deleteModeButton.addEventListener("click", () => setDeleteMode(!deleteMode));
undoDeleteButton.addEventListener("click", async () => {
  const project = deletedProjects.pop();
  if (!project) return;
  await putProject(project);
  undoDeleteButton.hidden = deletedProjects.length === 0;
  await renderList();
});
document.getElementById("new-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
newCreate.addEventListener("click", async () => {
  const title = newTitle.value.trim() || projectDateTitle();
  const project = newProject(title, null);
  await putProject(project);
  closeModal();
  showScreen("editor");
  openEditor(project, {
    onExit: () => { showScreen("projects"); renderList(); },
    onSaved: () => {},
  });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- boot ----------
(async function boot() {
  try {
    await Promise.all([loadPacks(), loadBackgrounds()]);
  } catch (err) {
    console.error("에셋을 불러오지 못했어요", err);
  }
  await renderList();
  startWelcomeTicker();
  showScreen("projects");
})();
