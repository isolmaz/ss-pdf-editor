/**
 * The common layer's selection: target keys across all four mark families, in the one identity
 * space `annotation-interaction.ts` builds. Nothing else may hold a "selected mark" — the
 * single-id state this replaced mixed session mark ids, engine storage keys and pdf.js
 * annotation ids in one string.
 */

import { createStore, type Equality, useStore } from '../store';

export interface SelectionState {
  /** The selected marks' keys. */
  readonly selectedKeys: readonly string[];
  /** A mark just written: selected as soon as the re-read inventory lists it. */
  readonly afterWrite: string | null;
}

const NONE: readonly string[] = [];

/** The state a fresh page starts in: nothing selected, nothing waiting to be. */
export function initialSelectionState(): SelectionState {
  return { selectedKeys: NONE, afterWrite: null };
}

export const selectionStore = createStore<SelectionState>(initialSelectionState());

/** The part of the selection a component reads (see `useStore` for the selector rules). */
export function useSelection<T>(selector: (state: SelectionState) => T, equality?: Equality<T>): T {
  return useStore(selectionStore, selector, equality);
}

/** The selection as it is now, for a handler (never a copy captured at render). */
export function selectedMarkKeys(): readonly string[] {
  return selectionStore.get().selectedKeys;
}

/** The marks the user (or a command) picked become the whole selection. */
export function selectMarks(keys: readonly string[]): void {
  selectionStore.set({ selectedKeys: keys });
}

/** Nothing is selected. */
export function clearMarkSelection(): void {
  selectionStore.set({ selectedKeys: NONE });
}

/** Select `key` once the re-read inventory lists it (`settlePendingSelection`). */
export function selectAfterWrite(key: string): void {
  selectionStore.set({ afterWrite: key });
}

/** The mark waiting to be selected, if the inventory now lists it: it becomes the selection. */
export function settlePendingSelection(targets: readonly { readonly key: string }[]): void {
  const { afterWrite } = selectionStore.get();
  if (afterWrite === null || !targets.some((target) => target.key === afterWrite)) return;
  selectionStore.set({ afterWrite: null, selectedKeys: [afterWrite] });
}

/** Keep only the selected keys that still name a mark: a removal removes its own, an undo can bring others back. */
export function pruneSelection(targets: readonly { readonly key: string }[]): void {
  selectionStore.set((state) => {
    if (state.selectedKeys.length === 0) return {};
    const live = new Set(targets.map((target) => target.key));
    const kept = state.selectedKeys.filter((key) => live.has(key));
    return kept.length === state.selectedKeys.length ? {} : { selectedKeys: kept };
  });
}
