// main.js — app entry: project list, new-project modal, screen routing.
import { listProjects, getProject, putProject, deleteProject } from "./storage.js";
import { loadPacks, findSticker } from "./packs.js";
import { loadBackgrounds, backgroundSrc } from "./backgrounds.js";
import { newProject } from "./model.js";
import { openEditor } from "./editor.js";

const screenProjects = document.getElementById("screen-projects");
const screenEditor = document.getElementById("screen-editor");
const grid = document.getElementById("project-grid");
const emptyState = document.getElementById("empty-state");

const modal = document.getElementById("modal-new");
const newTitle = document.getElementById("new-title");
let newCanvas = "phone";

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

    // thumbnail: background (if any) + topmost sticker, or empty mat
    let thumbInner = "";
    const top = [...(p.stickerItems || [])].sort((a, b) => b.zIndex - a.zIndex)[0];
    if (top) {
      const s = findSticker(top.packId, top.assetId);
      if (s) thumbInner = `<img src="${s.url}" alt="">`;
    }
    const bgStyle = p.background
      ? ` style="background-image:url(&quot;${backgroundSrc(p.background)}&quot;);background-size:cover;background-position:center"`
      : "";
    const badge = p.canvasType === "tablet" ? "태블릿" : "스마트폰";
    const stickerCount = (p.stickerItems || []).length;
    const textCount = (p.textItems || []).length;

    card.innerHTML = `
      <div class="card__thumb"${bgStyle}><span class="card__badge">${badge}</span>${thumbInner}</div>
      <div class="card__body">
        <p class="card__name">${escapeHtml(p.title)}</p>
        <p class="card__meta">스티커 ${stickerCount}개 · 텍스트 ${textCount}개 · ${fmtDate(p.updatedAt)}</p>
        <div class="card__row">
          <button class="iconbtn" data-act="rename" title="이름 변경">✎</button>
          <button class="iconbtn" data-act="delete" title="삭제">🗑</button>
        </div>
      </div>`;

    card.querySelector(".card__thumb").addEventListener("click", () => open(p.id));
    card.querySelector(".card__name").addEventListener("click", () => open(p.id));
    card.querySelector('[data-act="rename"]').addEventListener("click", (e) => {
      e.stopPropagation(); rename(p);
    });
    card.querySelector('[data-act="delete"]').addEventListener("click", (e) => {
      e.stopPropagation(); remove(p);
    });
    grid.appendChild(card);
  }
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

async function rename(p) {
  const name = prompt("새 이름", p.title);
  if (name == null) return;
  p.title = name.trim() || p.title;
  p.updatedAt = Date.now();
  await putProject(p);
  renderList();
}

async function remove(p) {
  if (!confirm(`"${p.title}"을(를) 삭제할까요?`)) return;
  await deleteProject(p.id);
  renderList();
}

// ---------- new project modal ----------
function openModal() {
  newTitle.value = "";
  newCanvas = "phone";
  modal.querySelectorAll(".choice__opt").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.canvas === "phone"));
  modal.hidden = false;
  newTitle.focus();
}
function closeModal() { modal.hidden = true; }

document.getElementById("btn-new").addEventListener("click", openModal);
document.getElementById("new-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
modal.querySelectorAll(".choice__opt").forEach((btn) => {
  btn.addEventListener("click", () => {
    newCanvas = btn.dataset.canvas;
    modal.querySelectorAll(".choice__opt").forEach((b) => b.classList.toggle("is-on", b === btn));
  });
});
document.getElementById("new-create").addEventListener("click", async () => {
  const project = newProject(newTitle.value.trim(), newCanvas);
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
  showScreen("projects");
})();
