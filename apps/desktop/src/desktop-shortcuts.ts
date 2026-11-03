import { isTauri } from "@tauri-apps/api/core";

/** Browser commands are not application commands; preserve editing and OS shortcuts. */
export function preventBrowserShortcuts(event: KeyboardEvent): void {
  const key = event.key.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  if (key === "f5" || key === "f7" || key === "f12" ||
      (modifier && ["f", "g", "h", "j", "l", "n", "o", "p", "r", "s", "u", "+", "-", "=", "0"].includes(key)) ||
      (modifier && event.shiftKey && ["i", "j", "c"].includes(key)) ||
      (event.altKey && ["arrowleft", "arrowright", "home"].includes(key))) {
    event.preventDefault();
  }
}

export function installDesktopShortcuts(): void {
  if (!isTauri()) return;
  window.addEventListener("keydown", preventBrowserShortcuts, { capture: true });
  window.addEventListener("contextmenu", event => event.preventDefault());
  window.addEventListener("wheel", event => { if (event.ctrlKey || event.metaKey) event.preventDefault(); }, { passive: false });
}
