import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import {
  EMPTY_VIEW_STACK,
  recordView,
  SAME_SCALE,
  stepView,
  type ViewEntry,
  type ViewStack,
} from './history';
import { findViewerDom, pageIndexAtTop } from './viewer-dom';

/**
 * Back/forward over view jumps (`PLAN.md §5/Phase 1`).
 *
 * The hook reads the viewer instead of owning it (`K23`): a *view* is the page at
 * the top of the scroll container plus the viewer's effective scale. It samples
 * that pair whenever the container scrolls, its layout mutates (pdf.js rewrites
 * the page geometry on every scale change, so zoom, fit-width and window resizes
 * all land here) or the container is resized. Scroll bursts are debounced, so a
 * continuous scroll is one entry, and the stack is bounded (`options.limit`,
 * default 50).
 *
 * Restoring goes through the same pane API the shell uses — `setZoom(entry.zoom)`
 * then `goToPage(entry.page)` — so the viewer keeps being the only place document
 * state lives; the hook never calls pdf.js and never touches the DOM itself.
 *
 * **Gap:** `ViewerApi` cannot restore a scroll offset, so an entry carries page +
 * zoom only: going back returns to the top of the previous page at its previous
 * scale, not to the exact pixel the reader was parked on. Fixing that needs a
 * scroll accessor on the pane (the hook has no sanctioned way to set
 * `scrollTop`), which is why the offset is not recorded either.
 */

const DEFAULT_LIMIT = 50;
const DEFAULT_DEBOUNCE_MS = 400;
/** How long a restored view is given to settle before signals count as real jumps. */
const SETTLE_MS = 700;

export interface ViewHistoryOptions {
  /** Entries kept; older views fall out of the front of the stack. */
  readonly limit?: number;
  /** Quiet time after the last scroll/layout signal before a view is recorded. */
  readonly debounceMs?: number;
  /**
   * 0-based page pdf.js reports through the pane's `onCurrentPageChange` — the
   * shell already holds it, and it is the engine's own answer. Without it the
   * page is read from the scroll container's layout.
   */
  readonly page?: number;
}

export interface ViewHistory {
  readonly back: () => void;
  readonly forward: () => void;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export function useViewHistory(viewer: ViewerApi | null, options: ViewHistoryOptions = {}): ViewHistory {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const [stack, setStack] = useState<ViewStack>(EMPTY_VIEW_STACK);
  const settleUntil = useRef(0);
  // Read through a ref: the watcher below must not re-subscribe on every page
  // change, and a sample must see the page the shell knows *at sample time*.
  const reportedPage = useRef(options.page);
  useEffect(() => {
    reportedPage.current = options.page;
  });

  const record = useCallback(
    (entry: ViewEntry) => {
      setStack((current) => recordView(current, entry, limit));
    },
    [limit],
  );

  const sample = useCallback((): ViewEntry | null => {
    if (viewer === null) return null;
    const zoom = viewer.getZoom();
    if (!Number.isFinite(zoom) || zoom <= 0) return null;
    const page = reportedPage.current;
    if (page !== undefined) return { page, zoom };
    const dom = findViewerDom(viewer);
    if (dom === null || dom.pages.length === 0) return null;
    return { page: pageIndexAtTop(dom), zoom };
  }, [viewer]);

  useEffect(() => {
    if (viewer === null) return undefined;
    const dom = findViewerDom(viewer);
    if (dom === null) return undefined;

    let timer: number | null = null;
    /**
     * Debounce, not throttle: every signal re-arms the timer, so a continuous
     * scroll — including the style and scroll churn pdf.js produces for hundreds
     * of milliseconds after a jump — is recorded as the one view the reader
     * ends on.
     */
    const schedule = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        if (performance.now() < settleUntil.current) {
          // A restored view is still settling; look again instead of recording
          // pdf.js's own scroll transition as a jump.
          schedule();
          return;
        }
        const entry = sample();
        if (entry !== null) record(entry);
      }, debounceMs);
    };

    const initial = sample();
    if (initial !== null) record(initial);

    dom.container.addEventListener('scroll', schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(dom.container);
    const mutations = new MutationObserver(schedule);
    mutations.observe(dom.viewer, {
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
      childList: true,
    });

    return () => {
      dom.container.removeEventListener('scroll', schedule);
      resize.disconnect();
      mutations.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [viewer, sample, record, debounceMs]);

  // A closed document has no views to go back to.
  useEffect(() => {
    if (viewer === null) setStack(EMPTY_VIEW_STACK);
  }, [viewer]);

  /**
   * The engine's own page signal (the shell already holds it): record the view as
   * soon as pdf.js reports the page instead of waiting for a layout signal, so an
   * entry is the page being *entered* and never a stale one. The debounced layout
   * sample below then records the same view again and `recordView` drops it.
   */
  useEffect(() => {
    if (viewer === null || options.page === undefined) return;
    const zoom = viewer.getZoom();
    if (!Number.isFinite(zoom) || zoom <= 0) return;
    record({ page: options.page, zoom });
  }, [viewer, options.page, record]);

  const jump = useCallback(
    (delta: number) => {
      const next = stepView(stack, delta);
      if (next === null || viewer === null) return;
      setStack({ entries: stack.entries, cursor: next.cursor });
      settleUntil.current = performance.now() + SETTLE_MS;
      // Page first, scale second, and only if the scale really differs. pdf.js
      // re-scrolls to the page it considers current *whenever the scale is
      // applied* (`PDFViewer#setScaleUpdatePages` → `scrollPageIntoView`), and
      // that scroll lands after this call — so a scale written before the page
      // would drag the view straight back to the page being left, which is a
      // silent no-op. Navigating first makes pdf.js's own re-scroll land on the
      // page we asked for; skipping a scale that is already within a percent
      // (the same tolerance entries use) removes the re-scroll entirely.
      viewer.goToPage(next.entry.page);
      if (Math.abs(viewer.getZoom() - next.entry.zoom) >= SAME_SCALE) viewer.setZoom(next.entry.zoom);
    },
    [stack, viewer],
  );

  const back = useCallback(() => jump(-1), [jump]);
  const forward = useCallback(() => jump(1), [jump]);

  return {
    back,
    forward,
    // The enabled state and the action answer the same question, so an enabled
    // control can never be a dead click (the failure a stale entry produced).
    canGoBack: stepView(stack, -1) !== null,
    canGoForward: stepView(stack, 1) !== null,
  };
}
