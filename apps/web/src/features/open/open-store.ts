/**
 * What the shell shows while documents are being opened: the start screen, the "opening"
 * overlay, the password question, which tabs were opened with a password, the pages ticked in
 * the page panel, and the tool a start-screen pick is waiting to run. None of it is document
 * data — it belongs to the window, so a tab switch leaves it alone (the page selection is
 * cleared by the gestures that mean "another document").
 */

import { createStore, type Equality, useStore } from '../store';

/** A protected file waiting for its open password. */
export interface PasswordPrompt {
  readonly file: File;
  /** Kept so the retry opens the same file and in-place save still works. */
  readonly handle?: FileSystemFileHandle;
  /** The last password was refused. */
  readonly incorrect: boolean;
}

export interface OpenState {
  /** The start screen covers the editor (it always does while no document is open). */
  readonly showHomeScreen: boolean;
  /** A file is being read and parsed: the overlay says so until its tab exists. */
  readonly opening: boolean;
  /** A protected file waiting for its open password, and whether the last one was refused. */
  readonly passwordPrompt: PasswordPrompt | null;
  /**
   * Tabs opened with a password, and that password — **in memory only**, never in a draft.
   * Such a tab is read-only: a protected file cannot be rewritten without dropping or
   * re-applying its protection, a decision the user makes with "create unlocked copy".
   */
  readonly lockedTabs: ReadonlyMap<string, string>;
  /** The pages ticked in the page panel, in document order of the user's gestures. */
  readonly selectedPages: readonly number[];
  /**
   * The command a start-screen tool promised to run once its document is open: the tool was
   * picked first and the file asked for after, so the command waits for the tab.
   */
  readonly pendingHomeCommand: string | null;
}

const NO_PAGES: readonly number[] = [];

export const initialOpenState = (): OpenState => ({
  showHomeScreen: true,
  opening: false,
  passwordPrompt: null,
  lockedTabs: new Map(),
  selectedPages: NO_PAGES,
  pendingHomeCommand: null,
});

export const openStore = createStore<OpenState>(initialOpenState());

/** The part of the open state a component reads (see `useStore` for the selector rules). */
export function useOpen<T>(selector: (state: OpenState) => T, equality?: Equality<T>): T {
  return useStore(openStore, selector, equality);
}

/** The start screen is shown again (the header's Home). */
export function showStartScreen(): void {
  openStore.set({ showHomeScreen: true });
}

/** A document is on screen: the start screen steps aside. */
export function hideStartScreen(): void {
  openStore.set({ showHomeScreen: false });
}

/** A file is being read; the overlay says so. */
export function beginOpening(): void {
  openStore.set({ opening: true });
}

export function endOpening(): void {
  openStore.set({ opening: false });
}

/** Ask for `file`'s open password; `incorrect` when the last one was refused. */
export function askPassword(prompt: PasswordPrompt): void {
  openStore.set({ passwordPrompt: prompt });
}

export function dismissPasswordPrompt(): void {
  openStore.set({ passwordPrompt: null });
}

/** `tabId` was opened with `password`: it stays read-only. */
export function lockTab(tabId: string, password: string): void {
  openStore.set((state) => ({ lockedTabs: new Map(state.lockedTabs).set(tabId, password) }));
}

/** The page panel's ticked pages. */
export function selectPages(pages: readonly number[]): void {
  openStore.set({ selectedPages: pages });
}

export function selectAllPages(pageCount: number): void {
  openStore.set({ selectedPages: Array.from({ length: pageCount }, (_page, index) => index) });
}

export function clearPageSelection(): void {
  openStore.set({ selectedPages: NO_PAGES });
}

/**
 * The page selection as a handler reads it: always the current value, never the one a render
 * captured (a control rendered in an earlier commit holds that commit's closure).
 */
export const selectedPagesNow: { readonly current: readonly number[] } = {
  get current() {
    return openStore.get().selectedPages;
  },
};

/** A start-screen tool waits for the file that is about to be asked for. */
export function awaitHomeCommand(commandId: string): void {
  openStore.set({ pendingHomeCommand: commandId });
}

/** No document comes of the pick: the waiting tool must not run on a later one. */
export function dropHomeCommand(): void {
  openStore.set({ pendingHomeCommand: null });
}
