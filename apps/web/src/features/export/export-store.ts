/**
 * What the shell shows about leaving the document: whether the export dialog is open, and the
 * context menu on the canvas with the place it was opened at. Neither is document data — they
 * belong to the window, so a tab switch leaves them alone.
 */

import { createStore, type Equality, useStore } from '../store';

/** Where the context menu opened, and what the browser had selected when it did. */
export interface ContextMenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly hasSelection: boolean;
  readonly selectedText?: string;
}

export interface ExportState {
  /** The export dialog is open. */
  readonly exportOpen: boolean;
  /** The open context menu, or `null` when there is none. */
  readonly contextMenu: ContextMenuAnchor | null;
}

export const initialExportState = (): ExportState => ({ exportOpen: false, contextMenu: null });

export const exportStore = createStore<ExportState>(initialExportState());

/** The part of the export state a component reads (see `useStore` for the selector rules). */
export function useExport<T>(selector: (state: ExportState) => T, equality?: Equality<T>): T {
  return useStore(exportStore, selector, equality);
}

export function openExportDialog(): void {
  exportStore.set({ exportOpen: true });
}

export function closeExportDialog(): void {
  exportStore.set({ exportOpen: false });
}

export function openContextMenu(anchor: ContextMenuAnchor): void {
  exportStore.set({ contextMenu: anchor });
}

export function closeContextMenu(): void {
  exportStore.set({ contextMenu: null });
}
