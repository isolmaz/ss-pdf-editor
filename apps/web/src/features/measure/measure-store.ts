/**
 * The measure tool's own state: which measurement is armed, the scale the document is drawn
 * at, the grid and snapping settings and the live reading under the pointer. None of it is
 * document data — the marks themselves are the session's `measures` overlay
 * (`measure-marks.ts`) — so a tab switch leaves it alone.
 *
 * Colour, opacity, thickness and author are not here: they are the annotation style. A ruler
 * and a highlighter are the same kind of mark, and two colour pickers would be two answers to
 * one question.
 */

import { type MeasureMode, type MeasureScale, scaleForRatio } from 'pdf-core/ops/measure';
import type { MeasureReading } from 'pdf-ui';
import { selectTool, useCore } from '../core/core-store';
import { createStore, type Equality, useStore } from '../store';

export interface MeasureState {
  /**
   * Which measurement is armed while the ruler owns the pointer. A *sub*-choice, not a second
   * active tool: `useMeasureMode()` is `null` unless the canvas tool is `'measure'`, so the
   * strip and the menu check cannot disagree with the pointer.
   */
  readonly subMode: MeasureMode;
  /** The scale the document is drawn at. */
  readonly scale: MeasureScale;
  readonly grid: boolean;
  /** The grid's spacing, in points. */
  readonly spacing: number;
  readonly snapGrid: boolean;
  readonly snapPoints: boolean;
  /** What the ruler reads under the pointer now; `null` when it is not measuring. */
  readonly reading: MeasureReading | null;
}

/** The state a window starts with (a function: the default scale is built, not shared). */
export function initialMeasureState(): MeasureState {
  return {
    subMode: 'distance',
    scale: scaleForRatio(100),
    grid: false,
    spacing: 36,
    snapGrid: false,
    snapPoints: false,
    reading: null,
  };
}

export const measureStore = createStore<MeasureState>(initialMeasureState());

/** The part of the measure state a component reads (see `useStore` for the selector rules). */
export function useMeasure<T>(selector: (state: MeasureState) => T, equality?: Equality<T>): T {
  return useStore(measureStore, selector, equality);
}

/** Which measurement is armed; `null` whenever the ruler does not own the pointer. */
export function useMeasureMode(): MeasureMode | null {
  const armed = useCore((state) => state.canvasTool === 'measure');
  const subMode = useMeasure((state) => state.subMode);
  return armed ? subMode : null;
}

/**
 * Arm the ruler with one measurement — the one value the rail, the palette, the menu and the
 * strip all write, so arming it from any of them cannot leave two answers behind.
 */
export function armMeasure(mode: MeasureMode): void {
  measureStore.set({ subMode: mode });
  selectTool('measure');
}

/**
 * The strip's own toggle: it reports `null` when the armed mode is clicked again, which is the
 * same stop as its Stop button.
 */
export function chooseMeasureMode(mode: MeasureMode | null): void {
  if (mode === null) {
    stopMeasure();
    return;
  }
  armMeasure(mode);
}

export function stopMeasure(): void {
  selectTool('select');
}

export function setMeasureScale(scale: MeasureScale): void {
  measureStore.set({ scale });
}

export function setMeasureGrid(grid: boolean): void {
  measureStore.set({ grid });
}

export function setMeasureSpacing(spacing: number): void {
  measureStore.set({ spacing });
}

export function setMeasureSnapGrid(snapGrid: boolean): void {
  measureStore.set({ snapGrid });
}

export function setMeasureSnapPoints(snapPoints: boolean): void {
  measureStore.set({ snapPoints });
}

export function setMeasureReading(reading: MeasureReading | null): void {
  measureStore.set({ reading });
}
