import { describe, expect, it } from 'vitest';
import { arrowDelta, clickSelection, dropIndex, gridColumns, shiftIndex } from './page-select';

describe('clickSelection', () => {
  const base = { selection: [1, 4], anchor: 4, page: 2, shift: false, toggle: false };

  it('selects only the page clicked, and makes it the anchor', () => {
    expect(clickSelection(base)).toEqual({ selection: [2], anchor: 2, plain: true });
  });

  it('adds a page that is not selected and removes one that is, anchoring on it', () => {
    expect(clickSelection({ ...base, toggle: true })).toEqual({
      selection: [1, 4, 2],
      anchor: 2,
      plain: false,
    });
    expect(clickSelection({ ...base, page: 4, toggle: true })).toEqual({
      selection: [1],
      anchor: 4,
      plain: false,
    });
  });

  it('takes the range between the anchor and the page, in either direction, keeping the anchor', () => {
    expect(clickSelection({ ...base, shift: true })).toEqual({
      selection: [2, 3, 4],
      anchor: 4,
      plain: false,
    });
    expect(clickSelection({ ...base, anchor: 0, page: 2, shift: true }).selection).toEqual([0, 1, 2]);
  });

  it('treats Shift without an anchor as a plain click, and Shift over a toggle as a range', () => {
    expect(clickSelection({ ...base, anchor: null, shift: true })).toEqual({
      selection: [2],
      anchor: 2,
      plain: true,
    });
    expect(clickSelection({ ...base, shift: true, toggle: true }).selection).toEqual([2, 3, 4]);
  });
});

describe('dropIndex', () => {
  it('counts positions in the order that remains: dragged pages before the gap are subtracted', () => {
    // Pages 0 and 1 dragged to the gap after page 3: they land after the two pages 2 and 3.
    expect(dropIndex([0, 1], 4, 6)).toBe(2);
    // A page dragged to a gap before itself keeps the gap's index.
    expect(dropIndex([3], 1, 5)).toBe(1);
    // The gap just after the dragged page is the page's own place.
    expect(dropIndex([3], 4, 5)).toBe(3);
  });

  it('stays inside 0 … remaining', () => {
    expect(dropIndex([0, 1], 9, 3)).toBe(3);
    expect(dropIndex([], -2, 3)).toBe(0);
  });
});

describe('shiftIndex', () => {
  it('moves the first page of the block by the delta', () => {
    expect(shiftIndex(2, 1, 5)).toBe(3);
    expect(shiftIndex(2, -1, 5)).toBe(1);
  });

  it('clamps to the ends and reports no move when it would stay where it is', () => {
    expect(shiftIndex(1, -4, 5)).toBe(0);
    expect(shiftIndex(4, 4, 5)).toBe(5);
    expect(shiftIndex(0, -1, 5)).toBeNull();
    expect(shiftIndex(5, 3, 5)).toBeNull();
  });
});

describe('gridColumns', () => {
  it('counts the columns auto-fill makes of the width that is left after the padding', () => {
    // 3 cells of 100 and 2 gaps of 10 need 320; two paddings of 12 make it 344.
    expect(gridColumns(344, 100, 10, 12)).toBe(3);
    expect(gridColumns(343, 100, 10, 12)).toBe(2);
  });

  it('is at least one column', () => {
    expect(gridColumns(0, 100, 10, 12)).toBe(1);
  });
});

describe('arrowDelta', () => {
  it('steps one page left and right and a row up and down', () => {
    expect(arrowDelta('ArrowRight', 4, false)).toBe(1);
    expect(arrowDelta('ArrowLeft', 4, false)).toBe(-1);
    expect(arrowDelta('ArrowDown', 4, false)).toBe(4);
    expect(arrowDelta('ArrowUp', 4, false)).toBe(-4);
  });

  it('reverses left and right in a right-to-left interface, not up and down', () => {
    expect(arrowDelta('ArrowRight', 4, true)).toBe(-1);
    expect(arrowDelta('ArrowLeft', 4, true)).toBe(1);
    expect(arrowDelta('ArrowDown', 4, true)).toBe(4);
  });

  it('is null for any other key', () => {
    expect(arrowDelta('Enter', 4, false)).toBeNull();
    expect(arrowDelta('a', 4, false)).toBeNull();
  });
});
