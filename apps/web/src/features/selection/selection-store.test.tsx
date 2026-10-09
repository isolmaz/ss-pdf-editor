// @vitest-environment happy-dom
/**
 * The selection's transitions: what a pick, a clear, a write that selects itself afterwards and
 * the pruning after a new version leave behind, and who is told.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMarkSelection,
  initialSelectionState,
  pruneSelection,
  selectAfterWrite,
  selectedMarkKeys,
  selectionStore,
  selectMarks,
  settlePendingSelection,
  useSelection,
} from './selection-store';

const targets = (...keys: string[]) => keys.map((key) => ({ key }));

beforeEach(() => selectionStore.set(initialSelectionState()));
afterEach(cleanup);

describe('picking and clearing', () => {
  it('starts with nothing selected and nothing waiting', () => {
    expect(selectedMarkKeys()).toEqual([]);
    expect(selectionStore.get().afterWrite).toBeNull();
  });

  it('makes the picked keys the whole selection, replacing the last one', () => {
    selectMarks(['a', 'b']);
    expect(selectedMarkKeys()).toEqual(['a', 'b']);
    selectMarks(['c']);
    expect(selectedMarkKeys()).toEqual(['c']);
  });

  it('empties the selection, and tells nobody when it was already empty', () => {
    const listener = vi.fn();
    selectionStore.subscribe(listener);
    clearMarkSelection();
    expect(listener).not.toHaveBeenCalled();
    selectMarks(['a']);
    clearMarkSelection();
    expect(selectedMarkKeys()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    clearMarkSelection();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('a mark selected once its write is listed', () => {
  it('stays waiting while the inventory does not list it, and selects it when it does', () => {
    selectAfterWrite('existing:1:stamp-1');
    settlePendingSelection(targets('other'));
    expect(selectedMarkKeys()).toEqual([]);
    expect(selectionStore.get().afterWrite).toBe('existing:1:stamp-1');

    settlePendingSelection(targets('other', 'existing:1:stamp-1'));
    expect(selectedMarkKeys()).toEqual(['existing:1:stamp-1']);
    expect(selectionStore.get().afterWrite).toBeNull();
  });

  it('does nothing when no write is waiting', () => {
    selectMarks(['a']);
    settlePendingSelection(targets('b'));
    expect(selectedMarkKeys()).toEqual(['a']);
  });
});

describe('pruning to what still exists', () => {
  it('keeps only the keys that are still listed', () => {
    selectMarks(['a', 'b', 'c']);
    pruneSelection(targets('a', 'c', 'z'));
    expect(selectedMarkKeys()).toEqual(['a', 'c']);
  });

  it('leaves the selection untouched, same array, when every key is still listed or none is selected', () => {
    const listener = vi.fn();
    pruneSelection(targets('a'));
    selectMarks(['a']);
    const before = selectedMarkKeys();
    selectionStore.subscribe(listener);
    pruneSelection(targets('a', 'b'));
    expect(selectedMarkKeys()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('useSelection', () => {
  it('re-renders the reader of the keys, and not for a waiting write', () => {
    const view = renderHook(() => useSelection((state) => state.selectedKeys));
    expect(view.result.current).toEqual([]);
    const renders = vi.fn();
    renderHook(() => renders(useSelection((state) => state.selectedKeys)));
    const before = renders.mock.calls.length;
    act(() => selectAfterWrite('x'));
    expect(renders.mock.calls.length).toBe(before);
    act(() => selectMarks(['a']));
    expect(view.result.current).toEqual(['a']);
  });
});
