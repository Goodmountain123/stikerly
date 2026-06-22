const STORAGE_KEY = "stickerly-disabled-pack-ids";

function readDisabledIds() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
}

let disabledIds = readDisabledIds();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...disabledIds]));
  } catch {
    // Storage can be unavailable in private browsing; keep the session state.
  }
  window.dispatchEvent(new CustomEvent("stickerly:pack-visibility-change"));
}

export function isPackEnabled(packId) {
  return !disabledIds.has(String(packId));
}

export function setPackEnabled(packId, enabled) {
  const id = String(packId);
  if (enabled) disabledIds.delete(id);
  else disabledIds.add(id);
  save();
}

export function filterEnabledPacks(packs) {
  return packs.filter((pack) => isPackEnabled(pack.id));
}

export function filterEnabledBackgrounds(backgrounds) {
  return backgrounds.filter((background) =>
    !background.packId || isPackEnabled(background.packId)
  );
}
