/**
 * The interface mode: the simple/advanced switch.
 *
 * **Simple** is the default. It is a *discovery* filter, not a permission system: it
 * decides which commands the palette and the menus offer, which tools rail groups are
 * shown, and which dock tabs appear. Nothing is removed from the build and no keyboard
 * shortcut stops working, because a mode that silently disabled a capability would turn
 * a preference into a bug report.
 *
 * The preference is global and persists in `localStorage` like the theme and the
 * language, and it announces itself on `window` so every surface reacts without prop
 * drilling — the same mechanism `ThemeSelector` and `LanguageSelector` already use.
 */

import type { InterfaceMode } from './commands';

const STORAGE_KEY = 'pdf_editor_interface_mode_v1';

/** The event the switch dispatches and the shell listens for. */
export const MODE_CHANGE_EVENT = 'pdf-mode-change';

/** The mode the user last chose, or `simple` for a first visit. */
export function readStoredMode(): InterfaceMode {
  try {
    const stored = globalThis.localStorage.getItem(STORAGE_KEY);
    return stored === 'advanced' ? 'advanced' : 'simple';
  } catch {
    // A disabled or full `localStorage` costs the preference, never the application.
    return 'simple';
  }
}

/** Persist the choice and tell every surface about it. */
export function storeMode(mode: InterfaceMode): void {
  try {
    globalThis.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // The session keeps the choice in memory; only persistence is lost.
  }
  globalThis.dispatchEvent?.(
    new CustomEvent<{ mode: InterfaceMode }>(MODE_CHANGE_EVENT, { detail: { mode } }),
  );
}
