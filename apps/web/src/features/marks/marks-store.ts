/**
 * Every mark the page shows, in the common layer's identity space: the session's annotations,
 * its measurements, its redaction intents and the annotations the file itself carries. The list
 * is derived from the model (`mark-targets.ts`) and published here, so a handler reads the
 * targets as they are at the moment it runs instead of from the render that created it.
 */

import type { MarkTarget } from 'pdf-ui/tools';
import { createStore, type Equality, useStore } from '../store';

export interface MarksState {
  readonly targets: readonly MarkTarget[];
}

/** The state a fresh page starts in. */
export function initialMarksState(): MarksState {
  return { targets: [] };
}

export const marksStore = createStore<MarksState>(initialMarksState());

/** The part of the marks state a component reads (see `useStore` for the selector rules). */
export function useMarks<T>(selector: (state: MarksState) => T, equality?: Equality<T>): T {
  return useStore(marksStore, selector, equality);
}

/** The targets the page shows changed. */
export function markTargetsPublished(targets: readonly MarkTarget[]): void {
  marksStore.set({ targets });
}

/** The targets the page shows now. */
export function currentMarkTargets(): readonly MarkTarget[] {
  return marksStore.get().targets;
}
