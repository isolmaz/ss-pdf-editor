/**
 * The editor chunk's loader. The home screen is all the first paint needs; the editor layout and
 * its tool strip (`editor.ts`) load while a document opens, and `main.tsx` warms them on idle so
 * the first open does not wait for the network.
 *
 * A surface is never rendered through `React.lazy`: a lazy boundary commits its fallback for at
 * least one frame even when the module is already cached. The shell shows the home screen, with
 * the "document opening" overlay it already shows while a file is read, until `surfaces` is in
 * the store, and renders the editor in the same commit that finds it there.
 */

import { type Translator, toToolError } from 'pdf-shared';
import { failureNotices, noticeLine } from '../../notices';
import { showNotice } from '../core/core-store';
import { createStore, useStore } from '../store';
import type * as EditorModule from './editor';

/** The module's exports: the components only an open document shows. */
export type EditorSurfaces = typeof EditorModule;

export interface EditorState {
  /** The loaded module, or `null` until the chunk has arrived. */
  readonly surfaces: EditorSurfaces | null;
  /** The request in flight or settled, shared by every caller; `null` before the first one. */
  readonly loading: Promise<EditorSurfaces> | null;
}

export const initialEditorState = (): EditorState => ({ surfaces: null, loading: null });

export const editorStore = createStore<EditorState>(initialEditorState());

/**
 * Fetch the editor chunk (once: callers share the request) and publish it to the store. A failed
 * fetch is forgotten, so the next call asks again where the browser allows it.
 */
export function loadEditor(): Promise<EditorSurfaces> {
  const current = editorStore.get().loading;
  if (current !== null) return current;
  const loading = import('./editor').then(
    (surfaces) => {
      editorStore.set({ surfaces });
      return surfaces;
    },
    (error: unknown) => {
      editorStore.set({ loading: null });
      throw error;
    },
  );
  editorStore.set({ loading });
  return loading;
}

/**
 * Ask for the editor chunk because a document is opening or open. A chunk the browser cannot
 * fetch (offline, cache evicted) is the same "this part of the editor is not on this device"
 * sentence every other lazy surface gives, shown as the notice, not an unhandled rejection.
 */
export function requestEditor(t: Translator): void {
  loadEditor().catch((error: unknown) => {
    showNotice(noticeLine(failureNotices(toToolError(error), 'error.internal.message'), t));
  });
}

/** The loaded editor surfaces, or `null` while the home screen has to stand in. */
export function useEditorSurfaces(): EditorSurfaces | null {
  return useStore(editorStore, (state) => state.surfaces);
}
