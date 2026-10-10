/**
 * The text tool's state. The tool itself is **derived** from the core store's `canvasTool`
 * (`'text'` mounts the block overlay); what is held here is what the overlay and the dialog
 * share: the working bytes the page model is read from, and the block the user pointed at.
 */

import type { OperationRunContext } from 'pdf-ui/ui';
import { createStore, type Equality, useStore } from '../store';

/** The block the user pointed at, as the text-edit dialog's run context carries it. */
export type TextEditSelection = NonNullable<OperationRunContext['textEdit']>;

export interface TextToolState {
  /**
   * The block selection that belongs to exactly one run: the dialog's `run` must edit the
   * model the user pointed at, not one re-read from the bytes after the fact.
   */
  readonly edit: TextEditSelection | null;
  /**
   * The working bytes the page model is read from. Materialised when the tool is armed rather
   * than on every render: `materializeBase` runs the engine's own deltas, which is real work,
   * and the model must describe the document as it is when the user points at a paragraph.
   */
  readonly bytes: Uint8Array | null;
}

/** The state a fresh page starts in: no block picked, no bytes frozen. */
export function initialTextToolState(): TextToolState {
  return { edit: null, bytes: null };
}

export const textToolStore = createStore<TextToolState>(initialTextToolState());

/** The part of the text tool's state a component reads (see `useStore` for the selector rules). */
export function useTextTool<T>(selector: (state: TextToolState) => T, equality?: Equality<T>): T {
  return useStore(textToolStore, selector, equality);
}

/** The user clicked a paragraph: the dialog will edit exactly this block. */
export function textBlockPicked(selection: TextEditSelection): void {
  textToolStore.set({
    edit: {
      pageIndex: selection.pageIndex,
      block: selection.block,
      model: selection.model,
      fonts: selection.fonts,
    },
  });
}

/** The block selection is spent or abandoned: a later `text-edit` must not open on it. */
export function clearTextEdit(): void {
  textToolStore.set({ edit: null });
}

/** The working bytes the tool was armed on, or `null` once it is not armed or they could not be read. */
export function textToolBytesFrozen(bytes: Uint8Array | null): void {
  textToolStore.set({ bytes });
}
