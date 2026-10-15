// @vitest-environment happy-dom
/**
 * The runs of a panel: each one has its own controller, which is aborted when the run ends
 * and when the panel goes away, and a run the panel's leaving cut short is told apart from
 * one that ended by itself.
 */

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAbortableRuns } from './useAbortableRuns';

afterEach(cleanup);

describe('useAbortableRuns', () => {
  it('hands every run a controller of its own, open until the run ends', () => {
    const { result } = renderHook(() => useAbortableRuns());
    const first = result.current.begin();
    const second = result.current.begin();
    expect(first).not.toBe(second);
    expect([first.signal.aborted, second.signal.aborted]).toEqual([false, false]);

    expect(result.current.end(first)).toBe(false);
    expect([first.signal.aborted, second.signal.aborted]).toEqual([true, false]);
  });

  it('aborts every run still going when the panel goes away, and calls them abandoned', () => {
    const { result, unmount } = renderHook(() => useAbortableRuns());
    const running = result.current.begin();
    const finished = result.current.begin();
    result.current.end(finished);
    const { end } = result.current;

    unmount();
    expect(running.signal.aborted).toBe(true);
    expect(end(running)).toBe(true);
  });

  it('is the same object across renders, so a callback built on it is not rebuilt', () => {
    const { result, rerender } = renderHook(() => useAbortableRuns());
    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });
});
