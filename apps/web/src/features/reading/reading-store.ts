/**
 * What the reader's overlays are showing: the reading pane, the snapshot menu, the magnifier
 * lens, and the language the open document declares (the reading pane's voice is matched on
 * it). They are the shell's only reading state, and none of it is document data: it belongs
 * to the window, so a tab switch leaves it alone.
 */

import { createStore, type Equality, useStore } from '../store';

export interface ReadingState {
  /** The reading pane is open. */
  readonly reading: boolean;
  /** The snapshot menu is open. */
  readonly snapshotOpen: boolean;
  /** The magnifier lens follows the pointer. */
  readonly magnifierOn: boolean;
  /** The lens's magnification. */
  readonly lensZoom: number;
  /**
   * The primary language subtag the open document declares (catalog `/Lang`); `null` while
   * unread or when it declares none.
   */
  readonly documentLanguage: string | null;
}

export const readingStore = createStore<ReadingState>({
  reading: false,
  snapshotOpen: false,
  magnifierOn: false,
  lensZoom: 4,
  documentLanguage: null,
});

/** The part of the reading state a component reads (see `useStore` for the selector rules). */
export function useReading<T>(selector: (state: ReadingState) => T, equality?: Equality<T>): T {
  return useStore(readingStore, selector, equality);
}

/** The header, the page bar, the menu and the shortcut all flip the pane with this. */
export function toggleReading(): void {
  readingStore.set((state) => ({ reading: !state.reading }));
}

export function closeReading(): void {
  readingStore.set({ reading: false });
}

export function openSnapshot(): void {
  readingStore.set({ snapshotOpen: true });
}

export function closeSnapshot(): void {
  readingStore.set({ snapshotOpen: false });
}

export function toggleMagnifier(): void {
  readingStore.set((state) => ({ magnifierOn: !state.magnifierOn }));
}

export function setLensZoom(zoom: number): void {
  readingStore.set({ lensZoom: zoom });
}

/** The language the document on screen declares, or `null` for none (see `useDocumentLanguage`). */
export function setDocumentLanguage(language: string | null): void {
  readingStore.set({ documentLanguage: language });
}
