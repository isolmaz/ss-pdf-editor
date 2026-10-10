/**
 * The window's own surfaces: the command palette, the settings dialog and the tab being renamed.
 * None of it is document data.
 */

import { selectTool } from '../core/core-store';
import { createStore, type Equality, useStore } from '../store';

export interface ShellState {
  /** The command palette is open. */
  readonly paletteOpen: boolean;
  /** Language, theme, interface mode, privacy and offline preferences — one dialog. */
  readonly settingsOpen: boolean;
  /** The tab whose name is being edited in the header, or `null`. */
  readonly renamingId: string | null;
}

export const initialShellState = (): ShellState => ({
  paletteOpen: false,
  settingsOpen: false,
  renamingId: null,
});

export const shellStore = createStore<ShellState>(initialShellState());

/** The part of the shell state a component reads (see `useStore` for the selector rules). */
export function useShell<T>(selector: (state: ShellState) => T, equality?: Equality<T>): T {
  return useStore(shellStore, selector, equality);
}

/** Open the palette from a surface that is not a gesture of the canvas (a header or home button). */
export function openPalette(): void {
  shellStore.set({ paletteOpen: true });
}

/**
 * Open the palette from the command or the keyboard layer. A modal surface takes the pointer:
 * the measure overlay covers the viewer, so a tool left armed would swallow the palette's own
 * clicks. No tool stays armed under it.
 */
export function summonPalette(): void {
  selectTool('select');
  openPalette();
}

export function closePalette(): void {
  shellStore.set({ paletteOpen: false });
}

export function openSettings(): void {
  shellStore.set({ settingsOpen: true });
}

export function closeSettings(): void {
  shellStore.set({ settingsOpen: false });
}

/** Start editing the name of tab `id` (`null` stops). */
export function renameTab(id: string | null): void {
  shellStore.set({ renamingId: id });
}
