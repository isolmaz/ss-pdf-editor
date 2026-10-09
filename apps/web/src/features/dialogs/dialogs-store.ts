/**
 * Which dialog the shell is showing: the operation dialog in the tools panel and the bytes it
 * was frozen with, the standalone operation in its modal, the batch dialog and the shortcut
 * list. None of it is document data — it belongs to the window — except `dialogInput`, which
 * names the tab and working version it was frozen from so a dialog that outlived its document
 * can be dismissed.
 */

import type { FieldValue } from 'pdf-ui';
import type { OperationDialogSpec } from 'pdf-ui/ui';
import { createStore, type Equality, useStore } from '../store';

/**
 * What an open operation dialog runs against: frozen bytes plus the identity of
 * the tab and working version they were frozen from. A dialog whose input is no
 * longer that exact version applies nothing.
 */
export interface DialogInput {
  readonly tabId: string;
  readonly workingId: string;
  readonly name: string;
  readonly pageCount: number;
  readonly bytes: Uint8Array;
  /** Field values the opener chose before the form existed (the export choice's image format). */
  readonly presets?: Readonly<Record<string, FieldValue>>;
}

export interface DialogsState {
  /** The batch dialog is open. */
  readonly batchOpen: boolean;
  /** The operation shown in the tools panel, or `null`. */
  readonly dialogSpec: OperationDialogSpec | null;
  /**
   * The frozen input of the open dialog. Storing the origin here — instead of reading the
   * *active* tab when the dialog renders — is what stops a tab switch during materialisation
   * from pairing one document's bytes with another document's name, page count and handle, and
   * it makes an operation that landed behind the dialog a reason to dismiss rather than a
   * silent mismatch.
   */
  readonly dialogInput: DialogInput | null;
  /** The standalone operation shown in its modal (`StartDialog`), or `null`. */
  readonly startSpec: OperationDialogSpec | null;
  /** The shortcut list is open. Its own state: help is not a document operation. */
  readonly shortcutsOpen: boolean;
  /**
   * What had the focus when the list opened. It is usually still there when the list closes
   * (the Help menu trigger), but a palette search field is gone by then.
   */
  readonly shortcutsTrigger: HTMLElement | null;
}

export const initialDialogsState = (): DialogsState => ({
  batchOpen: false,
  dialogSpec: null,
  dialogInput: null,
  startSpec: null,
  shortcutsOpen: false,
  shortcutsTrigger: null,
});

export const dialogsStore = createStore<DialogsState>(initialDialogsState());

/** The part of the dialogs state a component reads (see `useStore` for the selector rules). */
export function useDialogs<T>(selector: (state: DialogsState) => T, equality?: Equality<T>): T {
  return useStore(dialogsStore, selector, equality);
}

export function openBatchDialog(): void {
  dialogsStore.set({ batchOpen: true });
}

export function closeBatchDialog(): void {
  dialogsStore.set({ batchOpen: false });
}

/** An operation dialog opened on `input` in the tools panel. */
export function operationDialogOpened(input: DialogInput, spec: OperationDialogSpec): void {
  dialogsStore.set({ dialogInput: input, dialogSpec: spec });
}

/** The operation dialog is done, or was dismissed: nothing stays frozen. */
export function dismissOperationDialog(): void {
  dialogsStore.set({ dialogInput: null, dialogSpec: null });
}

export function startDialogOpened(spec: OperationDialogSpec): void {
  dialogsStore.set({ startSpec: spec });
}

export function closeStartDialog(): void {
  dialogsStore.set({ startSpec: null });
}

/** The shortcut list opened over `trigger`, the element to give focus back to (if any). */
export function shortcutsOpened(trigger: HTMLElement | null): void {
  dialogsStore.set({ shortcutsOpen: true, shortcutsTrigger: trigger });
}

export function shortcutsClosed(): void {
  dialogsStore.set({ shortcutsOpen: false });
}
