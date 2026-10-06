import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { findViewerDom, pageIndexAtTop } from './viewer-dom';
import './tools.css';

/**
 * Presentation mode (`PLAN.md §5/Phase 1`): the document alone, page by page.
 *
 * Full screen is the **browser's** state, not React state — `apps/web/src/App.tsx`
 * owns its full-screen toggle through `document.fullscreenElement` and has no
 * state field for it — so the hook requests full screen on the viewer's own scroll
 * container. That is what makes "no chrome" true without touching the shell: the
 * toolbar, tab strip, dock and status bar are outside that element. Leaving full
 * screen by any route (Escape, F11, another window taking over) is treated as
 * leaving presentation, and when the browser refuses the request the layout still
 * works in-page — the same capability contract the File System Access split
 * follows (`K10`).
 *
 * Nothing here renders: the caller draws the toggle with `tools.present` /
 * `tools.presentExit`. Everything that changes what the document shows goes
 * through `ViewerApi` (`setSpreadMode`, `setZoom`, `goToPage`) — no pdf.js calls
 * and no second source of document state (`K23`).
 *
 * Two details follow pdf.js's own rules rather than ours: **entering full screen
 * resizes the container**, and pdf.js recomputes a `page-width` fit only when
 * that value is re-applied (its resize observer just updates the container
 * height) — so the fit is re-applied on container resize while the reader has not
 * zoomed away from it. And the reader's own scale is remembered, so leaving
 * presentation gives the pane the view it had.
 *
 * **Gaps:** `ViewerApi` has no `getSpreadMode`, so exiting cannot restore the
 * reader's previous layout (the shell's own spread buttons do) — and there is no
 * scroll-mode API, so "single page" means `setSpreadMode('single')` with
 * continuous scrolling, not pdf.js's own page-snapped presentation scroll mode.
 */

/** The class pdf.js's presentation styles hang off (`pdf_viewer.css`): it drops the viewer's bottom padding and page margins so the page fills the screen. */
const PRESENTATION_CLASS = 'pdfPresentationMode';

type MoveKind = 'next' | 'previous' | 'first' | 'last';

/** Page keys, resolved before the shell's own bindings get a chance (`apps/web/src/useShortcuts.ts`). */
const PAGE_KEYS: Readonly<Record<string, MoveKind>> = {
  ArrowRight: 'next',
  Space: 'next',
  PageDown: 'next',
  ArrowLeft: 'previous',
  PageUp: 'previous',
  Home: 'first',
  End: 'last',
};

/**
 * Editing contexts win: a form widget pdf.js renders must keep its own arrow
 * keys. The shell's copy of this guard is private to `apps/web`, which is not
 * ours to change.
 */
function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface PresentationOptions {
  /** Called after the presentation layout is on, before full screen is requested. */
  readonly onEnter?: () => void;
  /** Called after the layout is back to normal and our full screen is released. */
  readonly onExit?: () => void;
}

export interface Presentation {
  readonly active: boolean;
  /** 0-based page the presentation is showing — the index `goToPage` takes. */
  readonly page: number;
  readonly enter: () => void;
  readonly exit: () => void;
  readonly toggle: () => void;
}

/**
 * Was the pane showing a width fit? The fit is computed against the container, so
 * a page as wide as the container answers it without reaching into pdf.js's scale
 * bookkeeping (and without a `ViewerApi` accessor that does not exist).
 */
function isWidthFit(
  pages: readonly { readonly canvas: HTMLCanvasElement | null }[],
  container: HTMLElement,
): boolean {
  const canvas = pages[0]?.canvas;
  if (canvas === undefined || canvas === null) return false;
  const width = canvas.getBoundingClientRect().width;
  return width > 0 && Math.abs(width - container.clientWidth) <= 2;
}

export function usePresentation(viewer: ViewerApi | null, options: PresentationOptions = {}): Presentation {
  const [active, setActive] = useState(false);
  const [page, setPage] = useState(0);
  const viewerRef = useRef(viewer);
  const activeRef = useRef(false);
  /** Full screen is released only when this hook is what took it. */
  const ownsFullscreen = useRef(false);
  /** The reader's own scale, restored on exit. */
  const restoreScale = useRef<number | 'page-width'>('page-width');
  const optionsRef = useRef(options);

  useEffect(() => {
    viewerRef.current = viewer;
  }, [viewer]);
  useEffect(() => {
    optionsRef.current = options;
  });

  const release = useCallback(() => {
    const current = viewerRef.current;
    if (current !== null) findViewerDom(current)?.container.classList.remove(PRESENTATION_CLASS);
    if (!ownsFullscreen.current) return;
    ownsFullscreen.current = false;
    if (document.fullscreenElement === null) return;
    // The document may already be out of full screen — the user pressed Escape
    // first, which is how presentation is meant to end; there is nothing to
    // release then.
    void document.exitFullscreen().catch(() => {});
  }, []);

  const exit = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setActive(false);
    // The reader gets the view they had: a fixed scale survives the round trip,
    // and a width fit (the pane's opening state) is asked for as a fit again.
    viewerRef.current?.setZoom(restoreScale.current);
    release();
    optionsRef.current.onExit?.();
  }, [release]);

  const enter = useCallback(() => {
    const current = viewerRef.current;
    if (current === null || activeRef.current) return;
    const dom = findViewerDom(current);
    if (dom === null) return;
    restoreScale.current = isWidthFit(dom.pages, dom.container) ? 'page-width' : current.getZoom();
    current.setSpreadMode('single');
    current.setZoom('page-width');
    setPage(pageIndexAtTop(dom));
    activeRef.current = true;
    setActive(true);
    dom.container.classList.add(PRESENTATION_CLASS);
    optionsRef.current.onEnter?.();
    if (typeof dom.container.requestFullscreen === 'function') {
      ownsFullscreen.current = true;
      void dom.container.requestFullscreen().catch(() => {
        // The browser refused full screen (a document not allowed to take it);
        // presentation keeps working in-page and Escape still exits.
        ownsFullscreen.current = false;
      });
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const container =
      viewerRef.current === null ? null : (findViewerDom(viewerRef.current)?.container ?? null);

    /**
     * Entering full screen resizes the container, and pdf.js re-applies a
     * `page-width` fit only when the value is set again (its own resize observer
     * just updates the container height). Re-apply the fit — unless the reader
     * zoomed away from it in the meantime, whose scale is theirs to keep.
     */
    let fitted = viewerRef.current?.getZoom() ?? null;
    const refit = () => {
      const current = viewerRef.current;
      if (current === null || fitted === null) return;
      if (Math.abs(current.getZoom() - fitted) > 1e-6) return;
      current.setZoom('page-width');
      fitted = current.getZoom();
    };
    const sizes = new ResizeObserver(refit);
    if (container !== null) sizes.observe(container);

    const move = (kind: MoveKind) => {
      const current = viewerRef.current;
      const dom = current === null ? null : findViewerDom(current);
      if (current === null || dom === null || dom.pages.length === 0) return;
      const last = dom.pages.length - 1;
      const from = kind === 'next' || kind === 'previous' ? pageIndexAtTop(dom) : 0;
      const step = kind === 'next' ? 1 : kind === 'previous' ? -1 : 0;
      const target = kind === 'first' ? 0 : kind === 'last' ? last : Math.min(Math.max(from + step, 0), last);
      current.goToPage(target);
      setPage(target);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        exit();
        return;
      }
      const kind = PAGE_KEYS[event.key];
      if (kind === undefined || isEditing(event.target)) return;
      event.preventDefault();
      // Capture phase, before the bubble-phase handlers the shell registers on
      // `window`: one key press must move exactly one page.
      event.stopPropagation();
      move(kind);
    };

    const onFullscreenChange = () => {
      if (document.fullscreenElement === null) exit();
    };

    const onScroll = () => {
      const current = viewerRef.current;
      const dom = current === null ? null : findViewerDom(current);
      if (dom === null) return;
      setPage(pageIndexAtTop(dom));
    };

    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    container?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      container?.removeEventListener('scroll', onScroll);
      sizes.disconnect();
    };
  }, [active, exit]);

  const toggle = useCallback(() => {
    if (activeRef.current) exit();
    else enter();
  }, [enter, exit]);

  // The viewer going away (document closed, tab switched) must not leave the
  // browser in a presentation this hook can no longer control.
  useEffect(() => {
    if (viewer === null) exit();
  }, [viewer, exit]);

  // Unmount is the last cleanup path: whoever took full screen has to release it.
  useEffect(
    () => () => {
      if (!activeRef.current) return;
      activeRef.current = false;
      release();
    },
    [release],
  );

  return { active, page, enter, exit, toggle };
}
