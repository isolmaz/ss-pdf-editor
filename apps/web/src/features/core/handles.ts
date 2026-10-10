/**
 * The engine handle each open tab renders, and the rules for letting one go.
 *
 * A handle is a pdf.js worker and its parsed document: an object with an identity, never a
 * value, so the registry is a plain `Map` beside the reactive store rather than state inside
 * it. Components that read a handle subscribe to the store's `handleVersion`, which every swap
 * bumps (`useDocumentHandle`).
 *
 * Replacing a handle does not destroy the old one at once: the viewer still paints it until the
 * replacement's pixels are ready, and it says so by releasing it. A handle is destroyed when it
 * is both **retired** (replaced) and **released** (the viewer let go), whichever happens last —
 * a fixed timeout could destroy it in the middle of a slow page delete.
 */

import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import type { Translator } from 'pdf-shared';
import { bumpHandleVersion, showNotice, useCore } from './core-store';

const handles = new Map<string, PdfDocumentHandle>();
const retired = new Set<PdfDocumentHandle>();
const released = new WeakSet<PdfDocumentHandle>();

/** The handle `tabId` renders, if it has one. */
export function handleFor(tabId: string): PdfDocumentHandle | undefined {
  return handles.get(tabId);
}

/** Register the handle a tab just opened with. Nothing to retire: the tab had none. */
export function adoptHandle(tabId: string, handle: PdfDocumentHandle): void {
  handles.set(tabId, handle);
}

/** Forget `tabId`'s handle and hand it back, for the caller to destroy. */
export function dropHandle(tabId: string): PdfDocumentHandle | undefined {
  const handle = handles.get(tabId);
  handles.delete(tabId);
  return handle;
}

/** The viewer let `handle` go: destroy it if it was already replaced. */
export function handleReleased(handle: PdfDocumentHandle, onDestroyFailed: () => void): void {
  released.add(handle);
  if (!retired.delete(handle)) return;
  void handle.destroy().catch(onDestroyFailed);
}

/** The viewer is showing `handle` again (it mounted the document): it is not released. */
export function handleInUse(handle: PdfDocumentHandle): void {
  released.delete(handle);
}

/**
 * Swap `tabId`'s handle for `handle` (an operation produced new bytes) and re-render whoever
 * reads it. The previous handle is retired, and destroyed now if the viewer already let it go.
 */
export function replaceHandle(tabId: string, handle: PdfDocumentHandle, onDestroyFailed: () => void): void {
  const previous = handles.get(tabId);
  handles.set(tabId, handle);
  bumpHandleVersion();
  if (previous !== undefined && previous !== handle) {
    retired.add(previous);
    if (released.has(previous)) handleReleased(previous, onDestroyFailed);
  }
}

/**
 * An operation produced `handle` for `tabId`: swap it in. A previous handle that would not
 * shut down says so on the status line, in the language of `t`.
 */
export function swapHandle(t: Translator, tabId: string, handle: PdfDocumentHandle): void {
  replaceHandle(tabId, handle, () => showNotice(t('notice.engineReleaseFailed')));
}

/** The viewer let `handle` go; a handle that would not shut down says so, in the language of `t`. */
export function releaseHandle(t: Translator, handle: PdfDocumentHandle): void {
  handleReleased(handle, () => showNotice(t('notice.engineReleaseFailed')));
}

/** The handle of `tabId` (`null` for no tab or no handle yet), re-read whenever one is swapped. */
export function useDocumentHandle(tabId: string | null): PdfDocumentHandle | null {
  useCore((state) => state.handleVersion);
  return tabId === null ? null : (handles.get(tabId) ?? null);
}
