/**
 * What the annotation feature keeps between gestures: the look the next mark is drawn with,
 * the engine-side form values a draft restored and the viewer has not taken yet, the
 * annotations the open file already carries (as the last read described them), and the
 * orphan sweep in flight. The marks themselves are **not** here — they are the active tab's
 * pending overlay in the session (`annotation-marks.ts`).
 *
 * Handlers read it with `annotationsStore.get()` at the moment they run.
 */

import type { ExistingAnnotation } from 'pdf-core';
import type { EngineValuesDraft } from 'pdf-model';
import { createStore, type Equality, useStore } from '../store';

/** The look every annotation tool draws with; the ruler shares colour, opacity, thickness and author. */
export interface AnnotationStyle {
  /** The marker's colour. */
  readonly color: string;
  /** Typed text is ink, not a marker: its own colour … */
  readonly textColor: string;
  /** … and size. */
  readonly fontSize: number;
  readonly opacity: number;
  readonly thickness: number;
  /** Who a new mark is by; empty until the user types a name. */
  readonly author: string;
}

export interface AnnotationsState {
  readonly style: AnnotationStyle;
  /**
   * Engine-side deltas restored from drafts, keyed by tab: they can only be applied once the
   * viewer has loaded that tab's document, so they wait here until the pane reports ready for
   * the tab. Replaced, never mutated.
   */
  readonly engineValues: ReadonlyMap<string, EngineValuesDraft>;
  /**
   * The file's annotations for the bytes on screen — `null` while the read is in flight, or
   * when it describes a version that is no longer current.
   */
  readonly existing: readonly ExistingAnnotation[] | null;
  /**
   * The orphan sweep in flight, if any. The sweep replaces the working version and holds the
   * operation lock while it runs, but a gesture that lands during it is not one to refuse:
   * the removal path waits for this promise instead of reporting a busy document.
   */
  readonly sweep: Promise<void> | null;
}

/** The state a fresh page starts in. */
export function initialAnnotationsState(): AnnotationsState {
  return {
    style: { color: '#ffd400', textColor: '#000000', fontSize: 12, opacity: 0.4, thickness: 2, author: '' },
    engineValues: new Map(),
    existing: null,
    sweep: null,
  };
}

export const annotationsStore = createStore<AnnotationsState>(initialAnnotationsState());

/** The part of the annotation state a component reads (see `useStore` for the selector rules). */
export function useAnnotations<T>(selector: (state: AnnotationsState) => T, equality?: Equality<T>): T {
  return useStore(annotationsStore, selector, equality);
}

/** The look the annotation tools draw with; the same object until a value changes. */
export function useAnnotationStyle(): AnnotationStyle {
  return useAnnotations((state) => state.style);
}

/** Change some of the style values; a value that is already the current one changes nothing. */
function restyle(change: Partial<AnnotationStyle>): void {
  annotationsStore.set((state) => {
    const entries = Object.entries(change) as [keyof AnnotationStyle, never][];
    return entries.every(([key, value]) => Object.is(state.style[key], value))
      ? {}
      : { style: { ...state.style, ...change } };
  });
}

export const chooseColor = (color: string): void => restyle({ color });
export const chooseTextColor = (textColor: string): void => restyle({ textColor });
export const chooseFontSize = (fontSize: number): void => restyle({ fontSize });
export const chooseOpacity = (opacity: number): void => restyle({ opacity });
export const chooseThickness = (thickness: number): void => restyle({ thickness });
export const chooseAuthor = (author: string): void => restyle({ author });

/** The file's annotations the last read found for the bytes on screen (`null`: unknown). */
export function existingAnnotationsRead(existing: readonly ExistingAnnotation[] | null): void {
  annotationsStore.set({ existing });
}

/** The annotations of the open file as last read, or `null` while they are unknown. */
export function knownExistingAnnotations(): readonly ExistingAnnotation[] | null {
  return annotationsStore.get().existing;
}

/**
 * Keep `values` for `tabId` until its viewer can take them; `undefined` forgets what was kept
 * (the tab's pending overlay carries none).
 */
export function holdEngineValues(tabId: string, values: EngineValuesDraft | undefined): void {
  annotationsStore.set((state) => {
    if (values === undefined) return releasedEngineValues(state, tabId);
    return { engineValues: new Map(state.engineValues).set(tabId, values) };
  });
}

/** The values waiting for `tabId`'s viewer, if any. */
export function heldEngineValues(tabId: string): EngineValuesDraft | undefined {
  return annotationsStore.get().engineValues.get(tabId);
}

/** The viewer took the values, or the tab is gone: nothing is kept for it. */
export function releaseEngineValues(tabId: string): void {
  annotationsStore.set((state) => releasedEngineValues(state, tabId));
}

function releasedEngineValues(state: AnnotationsState, tabId: string): Partial<AnnotationsState> {
  if (!state.engineValues.has(tabId)) return {};
  const next = new Map(state.engineValues);
  next.delete(tabId);
  return { engineValues: next };
}

/** The orphan sweep in flight, or `null`. */
export function orphanSweepInFlight(): Promise<void> | null {
  return annotationsStore.get().sweep;
}

/** A sweep started: it is the one in flight until it settles. */
export function orphanSweepStarted(sweep: Promise<void>): void {
  annotationsStore.set({ sweep });
}

/** `sweep` settled: it stops being the one in flight, unless a newer one has taken its place. */
export function orphanSweepSettled(sweep: Promise<void>): void {
  annotationsStore.set((state) => (state.sweep === sweep ? { sweep: null } : {}));
}
