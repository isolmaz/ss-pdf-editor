/**
 * The view-history stack (page + zoom), as pure data.
 *
 * Back/forward over *views*, browser-style: recording a new view after going
 * back drops the forward tail, and the stack keeps only its newest `limit`
 * entries. Kept out of the hook so the bounded-stack behaviour is checkable
 * without a browser.
 */

export interface ViewEntry {
  /** 0-based page index — the same index `ViewerApi.goToPage` takes. */
  readonly page: number;
  /** Effective viewer scale at the time (`ViewerApi.getZoom`). */
  readonly zoom: number;
}

export interface ViewStack {
  readonly entries: readonly ViewEntry[];
  /** Index of the current view; `-1` while the stack is empty. */
  readonly cursor: number;
}

export interface ViewStep {
  readonly entry: ViewEntry;
  /** Cursor after the step. */
  readonly cursor: number;
}

export const EMPTY_VIEW_STACK: ViewStack = { entries: [], cursor: -1 };

/**
 * Scale difference below which two entries are the same view. pdf.js re-applies
 * a fit (and rounds the resulting factor) whenever the container is re-measured,
 * so a raw float comparison turns one view into a run of near-identical entries —
 * and a step "back" to one of those moves nothing on screen.
 */
const SAME_SCALE = 0.01;

export { SAME_SCALE };

function sameView(left: ViewEntry, right: ViewEntry): boolean {
  return left.page === right.page && Math.abs(left.zoom - right.zoom) < SAME_SCALE;
}

/**
 * Records a view jump.
 *
 * An entry is a **page transition** that carries the scale in effect when the
 * page was reached: staying on a page while the scale changes folds into that
 * entry instead of appending a new one. That keeps two properties the controls
 * depend on — every step `back`/`forward` takes lands on a different page (the
 * one thing a probe, a status bar or a reader can see), and the zoom of the page
 * is still restored with it. A scale-only append is what made `back` look inert:
 * the entry behind the cursor was the same page at a slightly different fit.
 *
 * A new jump drops everything ahead of the cursor, and the oldest entries fall
 * out past `limit`.
 */
export function recordView(stack: ViewStack, entry: ViewEntry, limit: number): ViewStack {
  const current = stack.entries[stack.cursor];
  if (current !== undefined) {
    if (current.page === entry.page) {
      // Same page: the reader zoomed (or pdf.js re-applied a fit). Keep the page's
      // entry, update its scale — no new entry, no cursor move.
      if (Math.abs(current.zoom - entry.zoom) < SAME_SCALE) return stack;
      const entries = [...stack.entries];
      entries[stack.cursor] = { page: current.page, zoom: entry.zoom };
      return { entries, cursor: stack.cursor };
    }
  }
  const behind = stack.entries.slice(0, stack.cursor + 1);
  const entries = [...behind, entry];
  const bounded = entries.length > limit ? entries.slice(entries.length - limit) : entries;
  return { entries: bounded, cursor: bounded.length - 1 };
}

/**
 * The next view `delta` steps away that is *not* the one already on screen, or
 * `null` at either end of the stack. Skipping entries equal to the current one is
 * what makes `canGoBack`/`canGoForward` trustworthy: an enabled control always
 * moves the document, never to the view the reader is looking at.
 */
export function stepView(stack: ViewStack, delta: number): ViewStep | null {
  const from = stack.entries[stack.cursor];
  if (from === undefined) return null;
  for (let cursor = stack.cursor + delta; cursor >= 0 && cursor < stack.entries.length; cursor += delta) {
    const entry = stack.entries[cursor];
    if (entry === undefined) break;
    if (!sameView(entry, from)) return { entry, cursor };
  }
  return null;
}
