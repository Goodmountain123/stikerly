let installed = false;
const pools = new Map();

const files = {
  page: new URL("../assets/sfx/page.mp3", import.meta.url).href,
  flip: new URL("../assets/sfx/flip.mp3", import.meta.url).href,
  trash: new URL("../assets/sfx/trash.mp3", import.meta.url).href,
  pop: new URL("../assets/sfx/pop.mp3", import.meta.url).href,
  finish: new URL("../assets/sfx/finish.mp3", import.meta.url).href,
  undo: new URL("../assets/sfx/undu.mp3", import.meta.url).href,
  click: new URL("../assets/sfx/click.mp3", import.meta.url).href,
  button: new URL("../assets/sfx/button.mp3", import.meta.url).href,
  punch: new URL("../assets/sfx/punch.mp3", import.meta.url).href,
};

function play(name, volume = 0.65) {
  const src = files[name];
  if (!src) return;
  const pool = pools.get(name) || [];
  let audio = pool.find((item) => item.paused || item.ended);
  if (!audio) {
    audio = new Audio(src);
    audio.preload = "auto";
    pool.push(audio);
    if (pool.length > 4) pool.shift();
    pools.set(name, pool);
  }
  audio.currentTime = 0;
  audio.volume = volume;
  audio.play().catch(() => {});
}

export const sounds = {
  tap() {},
  softTap() {},
  page() {
    play("page", 0.55);
  },
  pop() {
    play("pop", 0.68);
  },
  pickup() {
    play("click", 0.65);
  },
  packOpen() {
    play("button", 0.62);
  },
  packClose() {
    play("punch", 0.62);
  },
  drop() {
    play("pop", 0.68);
  },
  flip() {
    play("flip", 0.58);
  },
  swooshIn() {
    play("page", 0.52);
  },
  swooshOut() {},
  delete() {
    play("trash", 0.7);
  },
  undo() {
    play("undo", 0.62);
  },
  success() {
    play("finish", 0.65);
  },
};

export function installUiSounds() {
  if (installed) return;
  installed = true;
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (
      button.classList.contains("tray-tab") &&
      !button.classList.contains("is-on")
    ) {
      sounds.flip();
    } else if (
      button.id === "btn-undo" ||
      button.id === "btn-undo-delete"
    ) {
      sounds.undo();
    }
  }, { passive:true });
}
