/**
 * What the save path and the viewer share: the save lock, the viewer's imperative API, the
 * zoom and page the viewer reports, the close-document question and the layout counter.
 *
 * None of it is document data. The viewer API is what the shortcut layer, the dock panels and
 * the save handlers reach the engine's view through; a handler reads it with `currentViewer()`
 * **at call time**, and a component that has to re-render when it arrives reads `viewer` with
 * `useSave`.
 */

import type { ViewerApi } from 'pdf-ui/viewer';
import { createStore, type Equality, useStore } from '../store';

export interface SaveState {
  /**
   * A save owns the document. Taken before the save's first `await` and released in its `finally`:
   * the file picker can stay open for minutes, and a second Save started meanwhile would run a
   * second preparation and a second write against the same document.
   */
  readonly saveLock: boolean;
  /** The viewer API of the document on screen, replaced with every document; `null` before one loads. */
  readonly viewer: ViewerApi | null;
  /** The scale the viewer reports. */
  readonly zoom: number;
  /** The page being read, 0-based. */
  readonly currentPage: number;
  /**
   * Counts the viewer's layout changes (zoom, fit-width on a resize, a spread change, a rewritten
   * document). The overlays measure the pages when they render, so a layout change needs one
   * render of the shell, and this counter is that render.
   */
  readonly layoutRevision: number;
  /** The tab the close-document question is about, or `null` while none is asked. */
  readonly closeRequest: string | null;
  /** What had the focus when the question opened: it gets the focus back when the question closes. */
  readonly closeTrigger: HTMLElement | null;
}

export const initialSaveState = (): SaveState => ({
  saveLock: false,
  viewer: null,
  zoom: 1,
  currentPage: 0,
  layoutRevision: 0,
  closeRequest: null,
  closeTrigger: null,
});

export const saveStore = createStore<SaveState>(initialSaveState());

/** The part of the save state a component reads (see `useStore` for the selector rules). */
export function useSave<T>(selector: (state: SaveState) => T, equality?: Equality<T>): T {
  return useStore(saveStore, selector, equality);
}

/** The viewer API of the document on screen, for a handler. */
export function currentViewer(): ViewerApi | null {
  return saveStore.get().viewer;
}

/**
 * The viewer API as the `{ current }` reference the panels and hosts take. It is a view onto the
 * store, not a copy of it: `current` is read each time it is asked for.
 */
export const viewerRef: { readonly current: ViewerApi | null } = {
  get current() {
    return currentViewer();
  },
};

export function isSaveLocked(): boolean {
  return saveStore.get().saveLock;
}

/** A save took ownership of the document. */
export function saveLocked(): void {
  saveStore.set({ saveLock: true });
}

/** The save is over, on whichever path it ended. */
export function saveReleased(): void {
  saveStore.set({ saveLock: false });
}

/** The viewer handed back its API for a document (or `null` as it went away). */
export function viewerChanged(viewer: ViewerApi | null): void {
  saveStore.set({ viewer });
}

export function zoomChanged(zoom: number): void {
  saveStore.set({ zoom });
}

/** Show page `page`, or the page `update` derives from the current one. */
export function setCurrentPage(page: number | ((current: number) => number)): void {
  saveStore.set((state) => ({ currentPage: typeof page === 'function' ? page(state.currentPage) : page }));
}

/** The viewer's layout changed: the overlays that measure the pages render again. */
export function layoutChanged(): void {
  saveStore.set((state) => ({ layoutRevision: state.layoutRevision + 1 }));
}

/** Ask whether to save `tabId` before it closes; `trigger` gets the focus back afterwards. */
export function closeRequested(tabId: string, trigger: HTMLElement | null): void {
  saveStore.set({ closeRequest: tabId, closeTrigger: trigger });
}

/** The close-document question is answered or dismissed. */
export function closeDismissed(): void {
  saveStore.set({ closeRequest: null });
}
