let context = null;
let installed = false;

function audioContext() {
  if (!context) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    context = new AudioContextClass();
  }
  if (context.state === "suspended") context.resume();
  return context;
}

function tone({
  frequency = 660,
  endFrequency = frequency,
  duration = 0.08,
  delay = 0,
  volume = 0.035,
  type = "sine",
}) {
  const ctx = audioContext();
  if (!ctx) return;
  const start = ctx.currentTime + delay;
  const end = start + duration;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, endFrequency), end);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + Math.min(0.018, duration / 3));
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(end + 0.02);
}

export const sounds = {
  tap() {
    tone({ frequency:760, endFrequency:900, duration:0.055, volume:0.022 });
  },
  softTap() {
    tone({ frequency:540, endFrequency:650, duration:0.045, volume:0.016 });
  },
  pop() {
    tone({ frequency:420, endFrequency:760, duration:0.09, volume:0.035, type:"triangle" });
    tone({ frequency:820, endFrequency:1040, duration:0.07, delay:0.035, volume:0.018 });
  },
  drop() {
    tone({ frequency:620, endFrequency:360, duration:0.1, volume:0.03, type:"triangle" });
    tone({ frequency:470, endFrequency:610, duration:0.075, delay:0.075, volume:0.02 });
  },
  flip() {
    tone({ frequency:520, endFrequency:1050, duration:0.075, volume:0.025, type:"triangle" });
  },
  swooshIn() {
    tone({ frequency:520, endFrequency:150, duration:0.22, volume:0.025, type:"triangle" });
  },
  swooshOut() {
    tone({ frequency:180, endFrequency:720, duration:0.22, volume:0.027, type:"triangle" });
    tone({ frequency:760, endFrequency:980, duration:0.08, delay:0.18, volume:0.015 });
  },
  delete() {
    tone({ frequency:420, endFrequency:150, duration:0.16, volume:0.027, type:"square" });
  },
  undo() {
    tone({ frequency:420, endFrequency:680, duration:0.1, volume:0.022, type:"triangle" });
  },
  success() {
    [660, 830, 1040].forEach((frequency, index) => {
      tone({ frequency, endFrequency:frequency * 1.04, duration:0.12, delay:index * 0.075, volume:0.026 });
    });
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
      button.id === "btn-delete-mode" ||
      button.classList.contains("btn--danger")
    ) {
      sounds.delete();
    } else if (
      button.id === "btn-undo" ||
      button.id === "btn-redo" ||
      button.id === "btn-undo-delete"
    ) {
      sounds.undo();
    } else if (
      button.classList.contains("tray-tab") ||
      button.classList.contains("card__info-toggle")
    ) {
      sounds.softTap();
    } else {
      sounds.tap();
    }
  }, { passive:true });
}
