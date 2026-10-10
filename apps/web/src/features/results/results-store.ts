/**
 * What the shell shows about a produced result: whether the print dialog and the camera
 * scanner are open, and the progress line of the operation that is running. None of it is
 * document data — it belongs to the window, so a tab switch leaves it alone.
 */

import type { OperationProgress } from 'pdf-core/ops/types';
import { createStore, type Equality, useStore } from '../store';

export interface ResultsState {
  /** The print dialog is open. */
  readonly printOpen: boolean;
  /** The camera scanner is open. */
  readonly scanOpen: boolean;
  /** The running operation's progress, or `null` when nothing reports any. */
  readonly progress: OperationProgress | null;
}

export const initialResultsState = (): ResultsState => ({
  printOpen: false,
  scanOpen: false,
  progress: null,
});

export const resultsStore = createStore<ResultsState>(initialResultsState());

/** The part of the results state a component reads (see `useStore` for the selector rules). */
export function useResults<T>(selector: (state: ResultsState) => T, equality?: Equality<T>): T {
  return useStore(resultsStore, selector, equality);
}

export function openPrintDialog(): void {
  resultsStore.set({ printOpen: true });
}

export function closePrintDialog(): void {
  resultsStore.set({ printOpen: false });
}

export function openScanDialog(): void {
  resultsStore.set({ scanOpen: true });
}

export function closeScanDialog(): void {
  resultsStore.set({ scanOpen: false });
}

/** Operations hand this to the engine as `onProgress`; `null` clears the line. */
export function setProgress(progress: OperationProgress | null): void {
  resultsStore.set({ progress });
}
