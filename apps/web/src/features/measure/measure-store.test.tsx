// @vitest-environment happy-dom
/**
 * The measure store: what each action writes, that arming the ruler is one intent across the
 * measure and core stores, and that the armed mode follows the canvas tool.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { scaleForRatio } from 'pdf-core/ops/measure';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { coreStore, initialCoreState, selectTool } from '../core/core-store';
import {
  armMeasure,
  chooseMeasureMode,
  initialMeasureState,
  measureStore,
  setMeasureGrid,
  setMeasureReading,
  setMeasureScale,
  setMeasureSnapGrid,
  setMeasureSnapPoints,
  setMeasureSpacing,
  stopMeasure,
  useMeasure,
  useMeasureMode,
} from './measure-store';

beforeEach(() => {
  coreStore.set(initialCoreState());
  measureStore.set(initialMeasureState());
});
afterEach(cleanup);

describe('the measure store', () => {
  it('starts with a distance ruler at 1:100, no grid, no snapping and no reading', () => {
    expect(measureStore.get()).toEqual({
      subMode: 'distance',
      scale: scaleForRatio(100),
      grid: false,
      spacing: 36,
      snapGrid: false,
      snapPoints: false,
      reading: null,
    });
  });

  it('writes each setting without touching the others', () => {
    const scale = scaleForRatio(50, 'm');
    const reading = { primary: '3 m', secondary: null, angle: '90°', points: 2 };
    setMeasureScale(scale);
    setMeasureGrid(true);
    setMeasureSpacing(20);
    setMeasureSnapGrid(true);
    setMeasureSnapPoints(true);
    setMeasureReading(reading);
    expect(measureStore.get()).toEqual({
      subMode: 'distance',
      scale,
      grid: true,
      spacing: 20,
      snapGrid: true,
      snapPoints: true,
      reading,
    });
    setMeasureReading(null);
    expect(measureStore.get().reading).toBeNull();
  });
});

describe('arming the ruler', () => {
  it('sets the sub-mode and arms the measure tool in one action', () => {
    armMeasure('area');
    expect(measureStore.get().subMode).toBe('area');
    expect(coreStore.get().canvasTool).toBe('measure');
  });

  it('arms the clicked mode and stops on a repeated click (the strip reports null)', () => {
    chooseMeasureMode('perimeter');
    expect(measureStore.get().subMode).toBe('perimeter');
    expect(coreStore.get().canvasTool).toBe('measure');
    chooseMeasureMode(null);
    expect(coreStore.get().canvasTool).toBe('select');
    expect(measureStore.get().subMode).toBe('perimeter');
  });

  it('stops by putting the pointer back in select', () => {
    armMeasure('distance');
    stopMeasure();
    expect(coreStore.get().canvasTool).toBe('select');
  });
});

describe('useMeasureMode and useMeasure', () => {
  function Probe() {
    const mode = useMeasureMode();
    const grid = useMeasure((state) => state.grid);
    return (
      <output>
        {String(mode)}/{String(grid)}
      </output>
    );
  }

  it('is null until the ruler owns the pointer, then the armed sub-mode, then null again', () => {
    render(<Probe />);
    expect(screen.getByText('null/false')).toBeTruthy();

    act(() => armMeasure('area'));
    expect(screen.getByText('area/false')).toBeTruthy();

    act(() => setMeasureGrid(true));
    expect(screen.getByText('area/true')).toBeTruthy();

    act(() => selectTool('select'));
    expect(screen.getByText('null/true')).toBeTruthy();
  });
});
