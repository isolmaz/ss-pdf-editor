/**
 * The pure half of page selection and reordering, shared by the page list and the organize
 * grid so the two cannot disagree about what a click, a drop or an arrow key means. Everything
 * here maps indices to indices; the components own the events.
 */

export interface ClickInput {
  readonly selection: readonly number[];
  /** The last page clicked or toggled, the start of a `Shift` range. */
  readonly anchor: number | null;
  readonly page: number;
  readonly shift: boolean;
  /** `Ctrl`/`Cmd`, or the grid's "select several" mode. */
  readonly toggle: boolean;
}

export interface ClickResult {
  readonly selection: readonly number[];
  readonly anchor: number | null;
  /** A click that neither extended nor toggled: it selects one page and may also open it. */
  readonly plain: boolean;
}

/** What clicking `page` does to the selection: a range, a toggle or just that page. */
export function clickSelection({ selection, anchor, page, shift, toggle }: ClickInput): ClickResult {
  if (shift && anchor !== null) {
    const from = Math.min(anchor, page);
    const to = Math.max(anchor, page);
    return {
      selection: Array.from({ length: to - from + 1 }, (_unused, offset) => from + offset),
      anchor,
      plain: false,
    };
  }
  if (toggle) {
    return {
      selection: selection.includes(page) ? selection.filter((item) => item !== page) : [...selection, page],
      anchor: page,
      plain: false,
    };
  }
  return { selection: [page], anchor: page, plain: true };
}

/**
 * Where a drop lands. `gap` counts pages in the current order (0 is before the first page);
 * the move action counts positions in the order that remains once the dragged pages are taken
 * out, so the dragged pages before the gap are subtracted.
 */
export function dropIndex(dragging: readonly number[], gap: number, remaining: number): number {
  const before = dragging.filter((page) => page < gap).length;
  return Math.max(0, Math.min(gap - before, remaining));
}

/**
 * The position a keyboard move puts a block at, `delta` places from where its first page is
 * now, or `null` when it cannot move that way. Clamped to the ends, so a move of a whole row
 * from the second row lands on the first.
 */
export function shiftIndex(first: number, delta: number, remaining: number): number | null {
  const to = Math.max(0, Math.min(first + delta, remaining));
  return to === first ? null : to;
}

/** How many equal columns `auto-fill` makes of a container `width` wide. */
export function gridColumns(width: number, cell: number, gap: number, padding: number): number {
  return Math.max(1, Math.floor((width - 2 * padding + gap) / (cell + gap)));
}

const ARROWS: readonly string[] = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

/**
 * How many pages an arrow key steps in a grid `columns` wide: left and right by one (reversed
 * in a right-to-left interface), up and down by a row. `null` for any other key.
 */
export function arrowDelta(key: string, columns: number, rtl: boolean): number | null {
  if (!ARROWS.includes(key)) return null;
  if (key === 'ArrowUp') return -columns;
  if (key === 'ArrowDown') return columns;
  return (key === 'ArrowRight') !== rtl ? 1 : -1;
}
