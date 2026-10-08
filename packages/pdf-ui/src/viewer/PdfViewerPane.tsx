import { PDFJS_ASSETS, type PdfDocumentHandle, pdfOptionalContentConfig } from 'pdf-core';
import { decodeEngineValues, type EngineValuesDraft, encodeEngineValues } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import type { EventBus, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { hideEditorMarkers } from './marker-text';

/**
 * The reader half of the shell: pdf.js's own `PDFViewer` stack
 * — continuous virtualized scrolling, the text layer with
 * real selection, and `PDFFindController` for search with match highlighting.
 * Hand-rolling those layers is the "engine called from a component" pattern this
 * repository forbids, and the pdf.js layers are the ones the reading half is
 * meant to reuse.
 *
 * The viewer stack is an **engine chunk, loaded lazily** the way `pdf-core`
 * loads the pdf.js core: the shell paints without it, and the CSS ships
 * with the chunk. The component owns the viewer lifetime and exposes the
 * imperative actions the shell needs (zoom, find) through `onReady`; document
 * state stays in the session model.
 *
 * The engine's **annotation editors are never enabled** (`annotationEditorMode:
 * DISABLE`): they are the one part of the stack this app does not use, because
 * entering an editing mode rebuilds the page's editor layer, repaints the base canvas
 * and raises pdf.js's own toolbar — while the mark it would draw is the shell's own
 * (`ops/AnnotationLayer.tsx`). The file's annotations, form widgets and links are
 * still displayed; only their *editing* is the shell's.
 */

export interface ViewerApi {
  /**
   * The engine document this viewer draws with (pdf-core adapter). Slices that render
   * pages the viewer never painted (print, snapshot) or read page text (reading mode)
   * need exactly this handle, so it travels here instead of being re-parsed.
   */
  readonly document: PdfDocumentHandle;
  setZoom(value: number | 'page-width' | 'page-fit' | 'auto'): void;
  getZoom(): number;
  find(query: string): void;
  /** 0-based page navigation (panels, thumbnails, outline, shortcuts). */
  goToPage(pageIndex: number): void;
  /** Reading layout: one page, odd spreads (book) or even spreads. */
  setSpreadMode(mode: 'single' | 'book' | 'book-even'): void;
  /** Opens the find bar and focuses the field (Ctrl+F and the toolbar button). */
  openFind(): void;
  /**
   * The engine-side delta of this document — form values and annotation edits that
   * only reach the file on save (the draft carries model data, so it
   * carries exactly this and not the bytes).
   */
  captureEngineValues(): Promise<EngineValuesDraft>;
  /** Puts a restored delta back into the engine; returns how many entries were applied. */
  applyEngineValues(values: EngineValuesDraft): Promise<number>;
  /**
   * Re-applies the document's optional-content configuration so the viewer repaints.
   * pdf.js's own layer toggle works by re-assigning this promise
   * (`pdf_viewer.mjs`: `setOCGState` then `optionalContentConfigPromise = Promise.resolve(config)`):
   * mutating the config alone leaves the canvas exactly as it was, which is what the
   * layer panel measured before this existed.
   */
  refreshOptionalContent(): Promise<void>;
  /**
   * Map a viewport point (client coordinates) to a page and a point in that page's
   * **unrotated user space**, with the origin at the top-left — MuPDF's page space,
   * which is also what the redaction marks are expressed in.
   *
   * pdf.js does the hard part: `PageViewport.convertToPdfPoint` already undoes the
   * zoom, the page's `/Rotate` and the view box offset, so this method only flips
   * the y axis between PDF's bottom-left origin and the top-left origin every
   * overlay and the redaction engine use.
   */
  pointToPage(
    clientX: number,
    clientY: number,
  ): { readonly pageIndex: number; readonly x: number; readonly y: number } | null;
  /**
   * The page's box and rotation, which is what turns a top-left-origin mark into
   * the `/QuadPoints` a PDF annotation carries: `viewBox` is `[x0, y0, x1, y1]`
   * in user space and `rotation` the page's own `/Rotate` (one of 0/90/180/270).
   */
  pageGeometry(pageIndex: number): {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly rotation: 0 | 90 | 180 | 270;
  } | null;
  /**
   * The origin of the **scrolled content**, in client coordinates, and a page element's
   * rectangle — the pair an overlay positions marks with. `pageRect - containerRect` is
   * the page's offset inside the scrolled content, which does not change while the reader
   * scrolls. That is the point: the overlays are mounted *inside* the scroll container
   * (the pane's `overlay` slot), so the browser carries them with the pages on the
   * compositor. The earlier contract answered the scroll container's *viewport* box and
   * the layers sat outside it; a mark was then placed once per React render and stayed
   * where it was on screen while the page scrolled away underneath it.
   */
  containerRect(): {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  pageRect(
    pageIndex: number,
  ): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  /**
   * New annotations the engine holds in its storage, as plain records
   * (`annotationStorage.serializable`), and the removal of one after the app has
   * taken ownership of it. The engine's storage is the channel `saveDocument()`
   * writes from, so an entry left here would be written twice.
   *
   * Empty on documents this app authored — every mark is created by the shell's own
   * layers and never enters engine storage — and non-empty only where a draft
   * restored entries an older session left there. Form values share the same storage
   * and are filtered out: they are not annotations.
   */
  captureAnnotationEntries(): readonly { readonly id: string; readonly value: Record<string, unknown> }[];
  dropAnnotationEntry(id: string): void;
}

export interface PdfViewerPaneProps {
  readonly document: PdfDocumentHandle;
  readonly t: Translator;
  readonly handTool?: boolean;
  /**
   * The **document's** stable identity — the shell's tab id, not the byte version.
   *
   * A rewritten document (a persisted-annotation edit producing new bytes, any
   * operation that swaps the handle for the same tab) mounts a fresh pdf.js stack in
   * this pane; the reader must not lose the page, the zoom or the scroll position to
   * that write. Pass the tab id here for the exact answer: a rewrite resumes the view,
   * a different key starts at page 1 / fit-width.
   *
   * Without the prop the pane falls back to the handle's `fingerprint` — pdf.js's own
   * content identity (the trailer's `/ID[0]`, or an MD5 of the file's first 1024 bytes,
   * `pdf.worker.mjs`), which a rewrite preserves — so the view survives an ordinary
   * in-place write even before the shell names the document. The fallback cannot tell
   * two tabs holding the *same file* apart; the tab id can.
   */
  readonly documentKey?: string;
  /** Called once per document with the imperative API, and with null on teardown. */
  readonly onReady?: (api: ViewerApi | null) => void;
  /** The pane no longer uses this handle, including its retained painted predecessor. */
  readonly onDocumentReleased?: (document: PdfDocumentHandle) => void;
  readonly onCurrentPageChange?: (pageIndex: number) => void;
  /** Present when the document can be edited: the find bar offers find and replace with its query. */
  readonly onReplace?: (query: string) => void;
  /** Fires whenever pdf.js changes the scale (zoom buttons, fit, resize). */
  readonly onScaleChange?: (scale: number) => void;
  /**
   * Fires on the first engine-side modification of this document (a form value, an
   * annotation) — the shell turns that into the tab's dirty flag, which is
   * what decides whether Save/Export writes the current version.
   */
  readonly onModifiedChange?: () => void;
  /**
   * The mark layers (annotation, selection, measurement, redaction, text blocks). They
   * render inside the scroll container, in a host sized to the laid-out pages, so they
   * scroll with the document instead of being re-placed after it moved.
   */
  readonly overlay?: ReactNode;
  /**
   * The pages' layout changed without a scroll: a zoom, a spread change, a resize, a
   * rewritten document. The overlays measure pages when they render, so the shell
   * re-renders them on this signal.
   */
  readonly onLayoutChange?: () => void;
}

interface FindState {
  readonly open: boolean;
  readonly query: string;
  readonly matches: number;
  readonly current: number;
}

const INITIAL_FIND: FindState = { open: false, query: '', matches: 0, current: 0 };

/**
 * pdf.js `LinkTarget.BLANK`: an external link opens in a new tab. The default (none) would
 * navigate the editor's own tab away from the open document and its unsaved marks.
 */
const LINK_TARGET_BLANK = 2;

// pdf.js `FindState` (pdf_viewer.mjs): FOUND 0 · NOT_FOUND 1 · WRAPPED 2 · PENDING 3.
const FIND_NOT_FOUND = 1;

/**
 * pdf.js's annotation-editor and annotation modes, as the numbers the engine built
 * itself with.
 *
 * `web/pdf_viewer.mjs` re-exports its viewer classes but **not** these enums: they
 * are defined in `build/pdf.mjs` (`AnnotationEditorType` = {DISABLE −1, NONE 0,
 * FREETEXT 3, HIGHLIGHT 9, STAMP 13, INK 15, POPUP 16, SIGNATURE 101, COMMENT 102};
 * `AnnotationMode` = {DISABLE 0, ENABLE 1, ENABLE_FORMS 2, ENABLE_STORAGE 3}), and
 * reading them off that module would make the whole 1.7 MB engine a static import —
 * the entry chunk measured 237 → 582 kB gzip when it was (the
 * reason this shim exists at all). The numbers therefore live here, as the one
 * place the app spells them.
 *
 * `DISABLE` is the value this pane passes, and it is load-bearing rather than tidy:
 * `PDFViewer` only constructs its `AnnotationEditorUIManager` when this option is
 * anything else (`pdf_viewer.mjs` `setDocument`), and that manager is what builds the
 * per-page editor layer, repaints the base canvas when a mode is armed, and raises
 * pdf.js's own toolbar. With `DISABLE` there is no editor layer and no toolbar at
 * all, and the marks the tools draw are the shell's own (`ops/AnnotationLayer.tsx`)
 * — including the freehand ink, which the engine's own editor used to create and
 * whose sampled path the hand-off then read as one stroke per point (a continuous
 * pen stroke arriving as a trail of dots). `annotationMode` below still displays the
 * file's own annotations and form widgets.
 */
const ANNOTATION_EDITOR_DISABLE = -1;
const ANNOTATION_MODE_ENABLE_FORMS = 2;

/**
 * The engine's annotation storage, as the two channels this app needs it to be.
 *
 * `AnnotationStorage` publishes `onSetModified`/`onAnnotationEditor` as *properties*
 * pdf.js's own viewer assigns (`build/pdf.mjs`), but the published typings declare
 * both as `null`-only literals — so the bridge is typed here and the assignment is
 * the one place a cast is truthful.
 */
interface EngineAnnotationStorage {
  onSetModified: (() => void) | null;
  onAnnotationEditor: ((type: string | null) => void) | null;
  readonly serializable: unknown;
  [Symbol.iterator](): Iterator<[string, unknown]>;
}

/**
 * Where the reader left a document: the page, the zoom **as pdf.js's own scale
 * value** (`'page-width'` survives as `'page-width'`, a numeric zoom as its number)
 * and the page's own top edge relative to the visible top of the scroll container —
 * the offset a rewritten document has to reproduce.
 */
interface ViewerViewState {
  readonly scaleValue: string | null;
  readonly pageNumber: number;
  readonly offsetInPage: number;
  readonly spreadMode: number;
  readonly scrollLeft: number;
}

/**
 * One live pdf.js stack: the slot it draws in, the document it belongs to, and the
 * three things the pane does with it.
 *
 * A stack is built to be *replaced* — a rewritten document (a persisted-annotation
 * move or delete writing bytes, any operation that swaps the handle for the same tab)
 * needs a fresh `PDFViewer` for the new bytes. Replacing it naively means the reader
 * watches the pages blank out and paint again, so the old stack is **frozen** instead:
 * out of flow, still painted, its canvases untouched and no bitmap copied, while the
 * replacement is built in the other slot. The freeze lifts on the engine's own signal
 * that the replacement has a page on screen (`pagerendered`). `pagesloaded` only
 * guarantees fetched page objects, not painted pixels, so it must not release the old
 * view. Empty documents and disposal release it explicitly. No timer or placeholder.
 */
interface LiveStack {
  /** Which of the pane's two `.pdfViewer` slots this stack owns. */
  readonly slot: 0 | 1;
  /**
   * The document's identity (`documentKey`, else the handle's fingerprint): a
   * replacement may only freeze a stack that belongs to the *same* document — a
   * different tab must never inherit the previous tab's pixels.
   */
  readonly identity: string | null;
  /** Has any page actually been painted? Only a painted stack is worth keeping up. */
  painted: boolean;
  /** Read the reader's place (page, zoom, offset) out of this stack. */
  captureView(): void;
  /** Out of flow and still painted: the replacement draws beside it, not over it. */
  freeze(): void;
  /** Drop the listeners, the engine state and the pixels; the slot is free again. */
  dispose(preservePredecessor?: boolean): void;
}

export function PdfViewerPane({
  document,
  documentKey,
  t,
  handTool = false,
  onReady,
  onDocumentReleased,
  onCurrentPageChange,
  onScaleChange,
  onModifiedChange,
  overlay,
  onLayoutChange,
  onReplace,
}: PdfViewerPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** The overlay host: inside the scroll container, sized to the laid-out pages. */
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  /**
   * The second page slot. A rewritten document builds its replacement stack here (or
   * in the first slot, alternately) so the stack on screen can keep its painted pages
   * until the replacement has really drawn one — see {@link LiveStack}.
   */
  const spareViewerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const eventBusRef = useRef<EventBus | null>(null);
  const viewerHandleRef = useRef<PDFViewer | null>(null);
  const [find, setFind] = useState<FindState>(INITIAL_FIND);
  const [findState, setFindState] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  /**
   * Has the stack on screen painted a page yet? Until it has, the overlays stay hidden
   * and the pane says it is preparing the pages: marks drawn over an empty sheet read as
   * marks without a document (measured on a slow open — the annotation layer arrived
   * before the first canvas). A rewrite of the same document keeps the frozen pixels on
   * screen, so it never goes back to "not painted".
   */
  const [painted, setPainted] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{
    clientX: number;
    clientY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);

  /**
   * The engine callbacks, read through a ref.
   *
   * The pdf.js stack is built once per document: its load effect must not re-run
   * because a tool setting or a selected mark changed the identity of a callback the
   * shell passed down. It did — the takeover callback closes over the annotation
   * style state, so picking a colour rebuilt the whole document.
   * The ref is refreshed every render, so the closure that runs is still the
   * shell's current one.
   */
  const callbacksRef = useRef({
    onReady,
    onDocumentReleased,
    onCurrentPageChange,
    onScaleChange,
    onModifiedChange,
    onLayoutChange,
  });
  callbacksRef.current = {
    onReady,
    onDocumentReleased,
    onCurrentPageChange,
    onScaleChange,
    onModifiedChange,
    onLayoutChange,
  };

  /**
   * The overlay host follows the pages' own extent. It is sized from the **active**
   * slot rather than from `scrollHeight`, because the host is itself content of the
   * scroll container: measuring the container would include the host and the size
   * could only ever grow. Every size change is also a layout change the overlays have
   * to be re-rendered for (zoom, fit-width on a resize, a spread change, a rewrite).
   */
  useEffect(() => {
    const container = containerRef.current;
    const host = overlayRef.current;
    const slots = [viewerRef.current, spareViewerRef.current];
    if (container === null || host === null) return undefined;
    let frame = 0;
    let last = '';
    let containerWidth = container.clientWidth;
    const measure = (): void => {
      frame = 0;
      // A preset zoom (fit width, fit page, auto) is a promise about the *container*, so
      // a new container width re-applies it — pdf.js's own application does this on
      // window resize, and without it a narrowed window cut the page's right edge off.
      if (container.clientWidth !== containerWidth) {
        containerWidth = container.clientWidth;
        const viewer = viewerHandleRef.current;
        const preset = viewer?.currentScaleValue;
        if (viewer !== null && viewer !== undefined && viewer.pagesCount > 0) {
          if (preset === 'page-width' || preset === 'page-fit' || preset === 'auto') {
            viewer.currentScaleValue = preset;
          }
        }
      }
      const active =
        slots.find((slot) => slot?.hasAttribute('data-active-viewer') === true) ?? slots[0] ?? null;
      const width = Math.max(container.clientWidth, active?.scrollWidth ?? 0);
      const height = Math.max(container.clientHeight, (active?.offsetTop ?? 0) + (active?.offsetHeight ?? 0));
      host.style.width = `${width}px`;
      host.style.height = `${height}px`;
      const signature = `${width}x${height}:${active?.firstElementChild?.getBoundingClientRect().width ?? 0}`;
      if (signature === last) return;
      last = signature;
      callbacksRef.current.onLayoutChange?.();
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    // A zoom, a spread change or a new document changes the slot's own box, so
    // observing the two slots and the container covers every layout change.
    for (const slot of slots) if (slot !== null) observer.observe(slot);
    schedule();
    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  /**
   * The view the last engine stack was left at, kept for the next stack this pane
   * mounts — one slot, because the only case that needs it is the immediate rewrite
   * of the same document. The slot is keyed by the document's identity (the shell's
   * `documentKey`, else the handle's fingerprint), so a genuinely different document
   * still starts at page 1 / fit-width.
   */
  const viewStateRef = useRef<{
    readonly identity: string | null;
    readonly state: ViewerViewState;
  } | null>(null);

  /**
   * The stack on screen, and which of the two slots it draws in.
   *
   * Owned by the document effect rather than by React state: the *next* stack needs
   * it to decide whether it may keep the current pixels on screen, and a cleanup that
   * tore it down would leave it nothing to hand over. The last one out disposes of it
   * (the unmount effect below).
   */
  const liveStackRef = useRef<LiveStack | null>(null);
  const frozenStackRef = useRef<LiveStack | null>(null);

  /**
   * Unmount: the last stack has no successor to hand its pixels to.
   */
  useEffect(
    () => () => {
      liveStackRef.current?.dispose();
      liveStackRef.current = null;
      frozenStackRef.current?.dispose();
      frozenStackRef.current = null;
      callbacksRef.current.onReady?.(null);
    },
    [],
  );

  const handlePanMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!handTool || event.button !== 0 || containerRef.current === null) return;
      setIsPanning(true);
      panStartRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        scrollLeft: containerRef.current.scrollLeft,
        scrollTop: containerRef.current.scrollTop,
      };
    },
    [handTool],
  );

  // The popups pdf.js builds show `/Contents`; our identity marker stays in the file only.
  useEffect(() => {
    const container = containerRef.current;
    return container === null ? undefined : hideEditorMarkers(container);
  }, []);

  useEffect(() => {
    if (!isPanning) return undefined;
    const onMouseMove = (event: MouseEvent) => {
      const container = containerRef.current;
      const start = panStartRef.current;
      if (container === null || start === null) return;
      const dx = event.clientX - start.clientX;
      const dy = event.clientY - start.clientY;
      container.scrollLeft = start.scrollLeft - dx;
      container.scrollTop = start.scrollTop - dy;
    };
    const onMouseUp = () => {
      setIsPanning(false);
      panStartRef.current = null;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isPanning]);

  useEffect(() => {
    const container = containerRef.current;
    const primary = viewerRef.current;
    const spare = spareViewerRef.current;
    if (container === null || primary === null || spare === null) return undefined;
    const slots: readonly [HTMLDivElement, HTMLDivElement] = [primary, spare];

    let disposed = false;

    /**
     * What this stack's document *is*, as opposed to which bytes it currently has:
     * the shell's key when it names one, otherwise pdf.js's own content identity
     * (`fingerprint` = the trailer's `/ID[0]`, else an MD5 of the first 1024 bytes —
     * `pdf.worker.mjs`), which an in-place rewrite preserves. `null` means the pane
     * has no way to recognise the document again, and the next stack starts fresh.
     */
    const viewIdentity = documentKey ?? document.fingerprint;

    /**
     * The stack this run replaces. The **same** document rewritten — a persisted mark
     * moved or deleted, a journal step that produced bytes for the tab already on
     * screen — hands its pixels over instead of giving them up: frozen out of flow they
     * stay visible until the replacement has a page of its own, because a document
     * rewrite is not a reason for the reader to watch the viewer blank out and paint
     * again. Anything else — a different document, or a stack that never painted — is
     * disposed out of hand.
     */
    const previous = liveStackRef.current;
    const retained = frozenStackRef.current;
    const candidate = retained ?? previous;
    const frozen =
      candidate?.painted && candidate.identity !== null && candidate.identity === viewIdentity
        ? candidate
        : null;
    const slot: 0 | 1 = frozen === null ? 0 : frozen.slot === 0 ? 1 : 0;
    if (previous !== null && previous !== frozen) previous.dispose(frozen !== null);
    if (frozen === null) {
      // Taking the screen over rather than inheriting it, so the shell is told the
      // stack it holds is going away: an api over a dead viewer is worse than none,
      // and every overlay mounted with it must follow. The freeze path says nothing —
      // the pane stays live across the write, and a `null` in between would unmount
      // the very layers whose mounting is part of the fix.
      retained?.dispose();
      frozenStackRef.current = null;
      liveStackRef.current = null;
      if (previous !== null) {
        callbacksRef.current.onReady?.(null);
        setReady(false);
      }
      setPainted(false);
    } else {
      frozenStackRef.current = frozen;
      frozen.captureView();
      frozen.freeze();
    }

    void (async () => {
      const [{ EventBus, PDFFindController, PDFLinkService, PDFViewer }, _styles] = await Promise.all([
        import('pdfjs-dist/web/pdf_viewer.mjs'),
        import('pdfjs-dist/web/pdf_viewer.css'),
      ]);
      if (disposed) return;
      // Both slots keep pdf.js styling while one is frozen, but DOM consumers
      // (printing and canvas tools) must follow only the current stack.
      primary.removeAttribute('data-active-viewer');
      spare.removeAttribute('data-active-viewer');
      slots[slot].setAttribute('data-active-viewer', '');

      const eventBus = new EventBus();
      const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LINK_TARGET_BLANK });
      const findController = new PDFFindController({ eventBus, linkService });
      const viewer = new PDFViewer({
        container,
        viewer: slots[slot],
        eventBus,
        linkService,
        findController,
        // Forms and the file's own annotations stay displayed; the engine's **editors
        // are off**. `PDFViewer` builds its `AnnotationEditorUIManager` only when this
        // option is anything but `DISABLE`, and that manager is what adds a per-page
        // editor layer, rebuilds it and repaints the base canvas whenever a tool is
        // armed, and raises pdf.js's own toolbar. The tools create every mark
        // themselves (`ops/AnnotationLayer.tsx`), so none of it is wanted.
        annotationMode: ANNOTATION_MODE_ENABLE_FORMS,
        annotationEditorMode: ANNOTATION_EDITOR_DISABLE,
        // A file's `/Text` note is drawn with pdf.js's own icon; the default path is
        // relative to the page and answered 404 with the editor's HTML.
        imageResourcesPath: PDFJS_ASSETS.images,
        // Cap a page's backing store. pdf.js scales by `devicePixelRatio` and only
        // stops at 16 Mpx (≈64 MB per canvas); on a DPR-1.5 display that is ~4.7 Mpx per
        // letter page and 16 s of main-thread painting inside a 19.7 s scroll of a
        // 130-page image-heavy document. 4 Mpx keeps full detail at
        // 100 % on a normal display and clamps the DPR blow-up where it matters.
        maxCanvasPixels: 4 * 1024 * 1024,
      });
      linkService.setViewer(viewer);
      eventBusRef.current = eventBus;
      viewerHandleRef.current = viewer;

      /** A frozen stack stops speaking for the pane: see `LiveStack.freeze`. */
      let frozenStack = false;
      let stackDisposed = false;

      /**
       * Give the frozen predecessor back — the replacement has pixels of its own, or
       * this stack is being disposed and must not leave it on screen. `setDocument(null)`
       * inside the release is also what clears that slot's DOM (`_resetView` →
       * `viewer.textContent = ""`), which is exactly why the release waits for a paint.
       */
      let frozenReleased = frozen === null;
      const releaseFrozen = (): void => {
        if (frozenReleased) return;
        frozenReleased = true;
        eventBus.off('pagerendered', releaseWhenPainted);
        if (frozenStackRef.current === frozen) frozenStackRef.current = null;
        frozen?.dispose();
      };
      const paintedPages = new Set<number>();
      const releaseWhenPainted = (event: { pageNumber: number; error?: unknown }): void => {
        if (event.error) return;
        paintedPages.add(event.pageNumber);
        const viewport = container.getBoundingClientRect();
        let visible = 0;
        for (let index = 0; index < viewer.pagesCount; index += 1) {
          const page = viewer.getPageView(index);
          if (page === undefined) continue;
          const rect = page.div.getBoundingClientRect();
          if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
          if (rect.right <= viewport.left || rect.left >= viewport.right) continue;
          visible += 1;
          if (!paintedPages.has(index + 1)) return;
        }
        // One painted page is not enough in a spread or between page boundaries.
        if (visible > 0) releaseFrozen();
      };

      /**
       * The reader's place, read while this stack still holds the DOM. A rewritten
       * document rebuilds the view from it, so the reader must not be thrown back to
       * page 1 by a write: `offsetInPage` is the page's own top edge against the visible
       * top of the scroll container, and pdf.js's page scroll lands on that same edge.
       */
      const captureView = (): void => {
        const viewedPage = viewer.getPageView(viewer.currentPageNumber - 1);
        const pageBounds = viewedPage?.div.getBoundingClientRect();
        const containerBounds = container.getBoundingClientRect();
        viewStateRef.current = {
          identity: viewIdentity,
          state: {
            scaleValue: viewer.currentScaleValue,
            pageNumber: viewer.currentPageNumber,
            offsetInPage: pageBounds === undefined ? 0 : pageBounds.top - containerBounds.top,
            spreadMode: viewer.spreadMode,
            scrollLeft: container.scrollLeft,
          },
        };
      };

      /** The engine's own signal that this stack has pixels, which makes it freezable. */
      const markPainted = (): void => {
        if (stack.painted) return;
        stack.painted = true;
        if (!disposed) setPainted(true);
      };

      const stack: LiveStack = {
        slot,
        identity: viewIdentity,
        painted: false,
        captureView,
        freeze: () => {
          if (frozenStack) return;
          // Out of flow, above the replacement and transparent to the pointer: the
          // reader keeps the pixels it was looking at while the replacement paints, and
          // the first press after the write belongs to the new document. The width is
          // the one this element measured in flow, so the frozen pages keep the exact
          // geometry (and the scroll offset) they had.
          const element = slots[slot];
          const measured = element.getBoundingClientRect();
          element.style.position = 'absolute';
          element.style.top = '0';
          element.style.left = '0';
          element.style.width = `${measured.width}px`;
          // `0`, not `1`: the overlay host comes later in the same stacking context,
          // so the session's marks stay painted above the frozen pixels during the
          // swap instead of blinking out under them.
          element.style.zIndex = '0';
          element.style.pointerEvents = 'none';
          frozenStack = true;
        },
        dispose: (preservePredecessor = false) => {
          if (stackDisposed) return;
          stackDisposed = true;
          if (!preservePredecessor) releaseFrozen();
          release();
          // The slot is React's element, reused by the next stack; only the styles this
          // pane and pdf.js wrote on it belong to the stack that just went away.
          slots[slot].style.cssText = '';
          callbacksRef.current.onDocumentReleased?.(document);
        },
      };

      const onPagesInit = () => {
        // A count belongs to the document it was found in: the new one has not been
        // searched, and the next Enter in the find box starts a fresh search of it.
        setFind((previous) =>
          previous.matches === 0 && previous.current === 0
            ? previous
            : { ...previous, matches: 0, current: 0 },
        );
        setFindState(null);
        // A rewritten document (same identity: the shell's `documentKey`, else the
        // handle's fingerprint) resumes where the reader was; a first open or a
        // different document starts at fit-width on page 1, exactly as this pane
        // always did.
        const remembered = viewStateRef.current;
        viewStateRef.current = null;
        const restore =
          remembered !== null && viewIdentity !== null && remembered.identity === viewIdentity
            ? remembered.state
            : null;
        if (restore === null) {
          viewer.currentScaleValue = 'page-width';
        } else {
          viewer.spreadMode = restore.spreadMode;
          viewer.currentScaleValue =
            restore.scaleValue === null || restore.scaleValue === '' ? 'page-width' : restore.scaleValue;
          // The page count can shrink under an operation, so the remembered page is
          // clamped rather than trusted (`goToPage` does the same against the engine).
          viewer.currentPageNumber = Math.min(
            Math.max(restore.pageNumber, 1),
            Math.max(viewer.pagesCount, 1),
          );
          const applyPageOffset = () => {
            if (disposed) return;
            const pageView = viewer.getPageView(viewer.currentPageNumber - 1);
            if (pageView === undefined) return;
            const pageBounds = pageView.div.getBoundingClientRect();
            const containerBounds = container.getBoundingClientRect();
            container.scrollTop += pageBounds.top - containerBounds.top - restore.offsetInPage;
            container.scrollLeft = restore.scrollLeft;
          };
          applyPageOffset();
          // One frame later the pages this scale re-rendered have their final
          // geometry; without it a fractional offset drifts by a few pixels.
          requestAnimationFrame(applyPageOffset);
        }
        viewer.update();
      };
      const onPageChanging = (payload: { pageNumber: number }) => {
        // A frozen stack keeps running (its scroll listener still fires), but it no
        // longer speaks for the pane: the replacement is the document on screen now.
        if (frozenStack) return;
        callbacksRef.current.onCurrentPageChange?.(payload.pageNumber - 1);
      };
      const onMatches = (payload: { matchesCount: { total: number; current: number } }) => {
        setFind((previous) => ({
          ...previous,
          matches: payload.matchesCount.total,
          current: payload.matchesCount.current,
        }));
      };
      // pdf.js reports the settled state and the count together on
      // `updatefindcontrolstate` (the `updatefindmatchescount` event only fires on
      // match changes, so "next match" and "not found" arrive here).
      const onControlState = (payload: {
        state: number;
        matchesCount?: { total: number; current: number };
      }) => {
        setFindState(payload.state);
        if (payload.matchesCount !== undefined) {
          setFind((previous) => ({
            ...previous,
            matches: payload.matchesCount?.total ?? 0,
            current: payload.matchesCount?.current ?? 0,
          }));
        }
      };
      const onScaleChanging = (payload: { scale: number }) => {
        if (frozenStack) return;
        callbacksRef.current.onScaleChange?.(payload.scale);
      };
      let editQueued = false;
      const onEngineEdit = () => {
        if (editQueued || frozenStack) return;
        editQueued = true;
        // Storage callbacks run inside setValue(), before its editor index exists.
        // Observe after the mutation finishes, never remove an editor re-entrantly.
        queueMicrotask(() => {
          editQueued = false;
          if (!disposed) callbacksRef.current.onModifiedChange?.();
        });
      };
      container.addEventListener('input', onEngineEdit, true);
      container.addEventListener('change', onEngineEdit, true);

      eventBus.on('pagesinit', onPagesInit);
      eventBus.on('pagechanging', onPageChanging);
      eventBus.on('updatefindmatchescount', onMatches);
      eventBus.on('updatefindcontrolstate', onControlState);
      eventBus.on('scalechanging', onScaleChanging);
      eventBus.on('pagerendered', markPainted);

      // pdf.js semantics, read from `pdf_viewer.mjs#onFind`: the transport channel is
      // always 'find'; the *payload* type decides what happens — '' starts a new
      // search, 'again' walks the current matches, 'highlightallchange' toggles
      // the all-page highlight pass.
      const dispatchFind = (type: '' | 'again', query: string, findPrevious: boolean) => {
        if (query.length === 0) return;
        eventBus.dispatch('find', {
          type,
          query,
          caseSensitive: false,
          entireWord: false,
          highlightAll: true,
          matchDiacritics: true,
          phraseSearch: true,
          findPrevious,
        });
      };

      const openFind = () => {
        setFind((previous) => ({ ...previous, open: true }));
        requestAnimationFrame(() => inputRef.current?.select());
      };

      const api: ViewerApi = {
        document,
        openFind,
        setZoom: (value) => {
          viewer.currentScaleValue = typeof value === 'number' ? String(value) : value;
        },
        getZoom: () => viewer.currentScale,
        setSpreadMode: (mode) => {
          viewer.spreadMode = mode === 'single' ? 0 : mode === 'book' ? 1 : 2;
        },
        goToPage: (pageIndex) => {
          // pdf.js clamps through its own setter; +1 because the viewer is 1-based.
          viewer.currentPageNumber = Math.min(Math.max(pageIndex + 1, 1), viewer.pagesCount);
        },
        find: (query) => {
          setFind((previous) => ({ ...previous, open: true, query }));
          dispatchFind('', query, false);
        },
        // The engine-side delta: pdf.js keeps form values and
        // annotation edits in `annotationStorage` until a save writes them, and its
        // `serializable` getter is the one projection that is safe to clone — editor
        // instances become plain objects there, bitmaps included.
        captureEngineValues: async () => {
          const serializable = document.raw.annotationStorage?.serializable;
          const map = serializable?.map;
          return encodeEngineValues(map instanceof Map ? map.entries() : []);
        },
        applyEngineValues: async (values) => {
          const storage = document.raw.annotationStorage;
          if (storage === undefined) return 0;
          let applied = 0;
          for (const [key, value] of decodeEngineValues(values)) {
            storage.setValue(key, value);
            applied += 1;
          }
          return applied;
        },
        // The layer panel writes through `setVisibility()`; the canvas only follows when
        // the viewer's config promise is re-assigned (pdf.js's own toggle path, above) —
        // and it must carry the **cached** instance the toggle mutated, not a fresh one
        // from the engine, or the repaint would render the document's defaults.
        refreshOptionalContent: async () => {
          const config = await pdfOptionalContentConfig(document);
          viewer.optionalContentConfigPromise = Promise.resolve(config);
        },
        captureAnnotationEntries: () => {
          // Read through `serializable`, not the entry iterator: iterating yields
          // the **live** `AnnotationEditor` objects, whose `quadPoints` is still
          // `null` (a highlight's geometry is produced by `serialize()`, which is
          // what the `serializable` getter calls — `build/pdf.mjs`). Reading the
          // live objects produced empty captures and a highlight that never
          // reached the file.
          const serializable = document.raw.annotationStorage?.serializable as unknown as
            | { map?: unknown }
            | undefined;
          const map = serializable?.map;
          if (!(map instanceof Map)) return [];
          const entries: { id: string; value: Record<string, unknown> }[] = [];
          for (const [key, value] of map) {
            if (typeof key !== 'string' || value === null || typeof value !== 'object') continue;
            const record = value as Record<string, unknown>;
            // Form values share annotationStorage but are not annotation editors.
            // Keeping them here would mistake form edits for recovered annotation marks.
            if (typeof record.annotationType !== 'number' && record.deleted !== true) continue;
            entries.push({ id: key, value: record });
          }
          return entries;
        },
        dropAnnotationEntry: (id) => {
          // The storage entry is the only part of a taken-over annotation this app has
          // to remove: the mark itself is the session's now, and the entry would
          // otherwise be written to the file a second time by `saveDocument()`. Nothing
          // engine-side has to be disposed with it — the engine's editors never existed
          // here — and no React-owned `[data-ann]` node is ever touched.
          document.raw.annotationStorage?.remove(id);
        },
        containerRect: () => {
          // The scrolled content's origin: the padding box moved by the scroll offset.
          // The overlay host sits at exactly this point, so an overlay coordinate is
          // `client - containerRect` and does not change while the document scrolls.
          const bounds = container.getBoundingClientRect();
          return {
            x: bounds.x + container.clientLeft - container.scrollLeft,
            y: bounds.y + container.clientTop - container.scrollTop,
            width: container.scrollWidth,
            height: container.scrollHeight,
          };
        },
        pageRect: (pageIndex) => {
          const pageView = viewer.getPageView(pageIndex);
          if (pageView === undefined) return null;
          // The page element carries a **transparent border** — `--page-border`, pdf.js's
          // own CSS: 9px normally, 1px in high contrast, 2px in presentation mode — and
          // the canvas, the text layer and every mark live inside it. Overlays and hit
          // tests therefore measure the content box (`clientLeft`/`clientTop` +
          // `clientWidth`/`clientHeight`), never the border box, which is only correct
          // where the border happens to be zero. The reader's own scroll restoration
          // deliberately keeps using the outer box.
          const bounds = pageView.div.getBoundingClientRect();
          return {
            x: bounds.left + pageView.div.clientLeft,
            y: bounds.top + pageView.div.clientTop,
            width: pageView.div.clientWidth,
            height: pageView.div.clientHeight,
          };
        },
        pageGeometry: (pageIndex) => {
          const pageView = viewer.getPageView(pageIndex);
          if (pageView === undefined) return null;
          const viewBox = pageView.viewport.viewBox;
          const x0 = viewBox[0] ?? 0;
          const y0 = viewBox[1] ?? 0;
          const x1 = viewBox[2] ?? 0;
          const y1 = viewBox[3] ?? 0;
          const rotation = pageView.viewport.rotation;
          return {
            x: Math.min(x0, x1),
            y: Math.min(y0, y1),
            width: Math.abs(x1 - x0),
            height: Math.abs(y1 - y0),
            rotation: rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0,
          };
        },
        pointToPage: (clientX, clientY) => {
          for (let index = 0; index < viewer.pagesCount; index += 1) {
            const pageView = viewer.getPageView(index);
            if (pageView === undefined) continue;
            const bounds = pageView.div.getBoundingClientRect();
            // The border is transparent and outside the page content, so both the
            // containment test and the conversion start at the content box — the same
            // frame `pageRect` reports and the canvas paints in.
            const left = bounds.left + pageView.div.clientLeft;
            const top = bounds.top + pageView.div.clientTop;
            if (
              clientX < left ||
              clientX > left + pageView.div.clientWidth ||
              clientY < top ||
              clientY > top + pageView.div.clientHeight
            ) {
              continue;
            }
            const [pdfX, pdfY] = pageView.viewport.convertToPdfPoint(clientX - left, clientY - top);
            if (pdfX === undefined || pdfY === undefined) continue;
            // PDF user space has its origin at the bottom-left and a y axis that
            // grows upward; MuPDF's page space (and therefore every redaction
            // mark) starts at the top-left corner of the page box.
            const viewBox = pageView.viewport.viewBox;
            const pdfTop = viewBox[3] ?? pageView.div.clientHeight;
            return { pageIndex: index, x: pdfX, y: pdfTop - pdfY };
          }
          return null;
        },
      };
      viewer.setDocument(document.raw);
      // pdf.js's own application hands the document to the link service too —
      // `PDFViewer.setDocument` only forwards it to the find controller. Without
      // this `linkService.pagesCount` stays 0, `#extractText()` walks no pages and
      // every search reports "not found" (verified against pdfjs-dist 6.3.289).
      linkService.setDocument(document.raw);
      if (frozen !== null) {
        // Page objects can finish loading before the canvas paints. Keep the old
        // pixels until the replacement's render event (also emitted on render failure),
        // rather than exposing its empty backing store on `pagesloaded`.
        eventBus.on('pagerendered', releaseWhenPainted);
        if (document.pageCount === 0) releaseFrozen();
      }
      if (document.pageCount === 0) {
        // Nothing will ever paint: an empty document is not "still loading".
        setPainted(true);
      }
      // Engine-side edits mark the document dirty. Two channels, because they catch
      // different things: the engine's form widgets are DOM inputs, so a capture-phase
      // listener sees them; an annotation the editor commits is *not* an input event,
      // and the only signal pdf.js offers is the storage's own callbacks
      // (`AnnotationStorage.onSetModified` / `onAnnotationEditor`, `build/pdf.mjs`) —
      // without them a freshly drawn highlight left the tab clean and the mark uncaptured.
      const storage = document.raw.annotationStorage as unknown as EngineAnnotationStorage | undefined;
      const previousSetModified = storage?.onSetModified ?? null;
      const previousEditor = storage?.onAnnotationEditor ?? null;
      if (storage !== undefined) {
        storage.onSetModified = () => {
          previousSetModified?.();
          onEngineEdit();
        };
        storage.onAnnotationEditor = (type: string | null) => {
          previousEditor?.(type);
          onEngineEdit();
        };
      }

      /**
       * Everything this stack owns, given back: its listeners, its storage hooks and the
       * engine's own teardown. `setDocument(null)` is also what clears this slot's DOM
       * (`_resetView` → `viewer.textContent = ""`), which is exactly why the release of
       * a frozen stack waits for its replacement to have painted.
       */
      const release = (): void => {
        eventBus.off('pagesinit', onPagesInit);
        eventBus.off('pagechanging', onPageChanging);
        eventBus.off('updatefindmatchescount', onMatches);
        eventBus.off('updatefindcontrolstate', onControlState);
        eventBus.off('scalechanging', onScaleChanging);
        eventBus.off('pagerendered', markPainted);
        container.removeEventListener('input', onEngineEdit, true);
        container.removeEventListener('change', onEngineEdit, true);
        if (storage !== undefined) {
          storage.onSetModified = previousSetModified;
          storage.onAnnotationEditor = previousEditor;
        }
        viewer.setDocument(null);
        linkService.setDocument(null);
        viewer.cleanup();
        // A released stack gives the globals back only when they are still *its*: a
        // frozen stack is released after its replacement published, and clearing these
        // blindly would leave the shell holding nothing.
        if (eventBusRef.current === eventBus) eventBusRef.current = null;
        if (viewerHandleRef.current === viewer) viewerHandleRef.current = null;
        eventBus.off('pagerendered', releaseWhenPainted);
      };
      if (!disposed) liveStackRef.current = stack;
      callbacksRef.current.onReady?.(api);
      setReady(true);
    })();

    return () => {
      // The stack this run built is handed over to the next run — which either freezes
      // it for one paint or disposes it — so nothing is torn down here; the unmount
      // effect above is what disposes of the last one. `disposed` only stops this run's
      // body from publishing a stack that is already superseded.
      disposed = true;
    };
    // The document and its identity build the engine stack; the shell's callbacks
    // travel through `callbacksRef`, so a new colour or a new selection cannot tear
    // down the pdf.js document, its annotation storage and every editor in it.
  }, [document, documentKey]);

  const runAgain = useCallback(
    (reverse: boolean) => {
      const bus = eventBusRef.current;
      if (bus === null || find.query.length === 0) return;
      bus.dispatch('find', {
        type: 'again',
        query: find.query,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        matchDiacritics: true,
        phraseSearch: true,
        findPrevious: reverse,
      });
    },
    [find.query],
  );

  const closeFind = useCallback(() => {
    eventBusRef.current?.dispatch('findbarclose', { query: '' });
    setFind(INITIAL_FIND);
    setFindState(null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFind((previous) => ({ ...previous, open: true }));
        requestAnimationFrame(() => inputRef.current?.select());
        return;
      }
      if (event.key === 'Escape') {
        setFind((previous) => (previous.open ? INITIAL_FIND : previous));
        return;
      }
      if (find.open && event.key === 'F3') {
        event.preventDefault();
        runAgain(event.shiftKey);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [find.open, runAgain]);

  const countLabel =
    find.query.length === 0
      ? ''
      : find.matches > 0
        ? t('viewer.find.matches', { current: find.current, total: find.matches })
        : findState === FIND_NOT_FOUND
          ? t('viewer.find.noMatches')
          : t('viewer.find.scanning');

  return (
    <div className="relative h-full w-full">
      {find.open ? (
        <search className="pdf-floating-shadow absolute end-3 top-3 z-40 flex items-center gap-1 rounded-md border border-kumo-line bg-kumo-base px-2 py-1">
          <input
            ref={inputRef}
            type="text"
            value={find.query}
            aria-label={t('viewer.find.label')}
            placeholder={t('viewer.find.placeholder')}
            onChange={(event) => setFind((previous) => ({ ...previous, query: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              const query = event.currentTarget.value;
              if (query.length === 0) return;
              if (query === find.query && find.matches > 0) {
                runAgain(event.shiftKey);
                return;
              }
              setFind((previous) => ({ ...previous, query }));
              eventBusRef.current?.dispatch('find', {
                type: '',
                query,
                caseSensitive: false,
                entireWord: false,
                highlightAll: true,
                matchDiacritics: true,
                phraseSearch: true,
                findPrevious: false,
              });
            }}
            className="h-6 w-52 rounded-sm border border-kumo-line bg-kumo-base px-2 text-xs text-kumo-default outline-none focus:ring-1 focus:ring-kumo-focus"
          />
          <span className="min-w-16 text-center text-xs tabular-nums text-kumo-subtle">{countLabel}</span>
          <button
            type="button"
            aria-label={t('viewer.find.previous')}
            disabled={find.matches === 0}
            onClick={() => runAgain(true)}
            className="grid size-6 place-items-center rounded-sm text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40"
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={t('viewer.find.next')}
            disabled={find.matches === 0}
            onClick={() => runAgain(false)}
            className="grid size-6 place-items-center rounded-sm text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default disabled:opacity-40"
          >
            ↓
          </button>
          {onReplace === undefined ? null : (
            <button
              type="button"
              onClick={() => onReplace(find.query)}
              className="h-6 rounded-sm px-2 text-xs text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
            >
              {t('findReplace.fromFindBar')}
            </button>
          )}
          <button
            type="button"
            aria-label={t('viewer.find.close')}
            onClick={closeFind}
            className="grid size-6 place-items-center rounded-sm text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
          >
            ×
          </button>
        </search>
      ) : null}
      {/* pdf.js requires an absolutely positioned container with a `.pdfViewer` child. `isolate`
          keeps the mark layers (z-20 inside it) below the find bar and the shell chrome. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pan drag gesture container */}
      <div
        ref={containerRef}
        onMouseDown={handlePanMouseDown}
        className={`absolute inset-0 isolate overflow-auto bg-pdf-surround ${
          handTool ? (isPanning ? 'cursor-grabbing select-none' : 'cursor-grab select-none') : ''
        }`}
      >
        <div ref={viewerRef} className="pdfViewer" />
        {/* The second slot: a rewritten document builds its stack here (see `LiveStack`)
            so the one on screen keeps its painted pages until the replacement draws. An
            empty slot is an empty box, so only one of the two ever carries pages. */}
        <div ref={spareViewerRef} className="pdfViewer" />
        {/* The overlay host: at the scrolled content's origin, sized to the pages by the
            effect above, never a z-index of its own — the highlight layer multiplies
            against the page canvas, and a stacking context here would isolate it. */}
        <div
          ref={overlayRef}
          data-viewer-overlay=""
          className="pointer-events-none absolute left-0 top-0"
          style={painted ? undefined : { visibility: 'hidden' }}
        >
          {overlay}
        </div>
      </div>
      {ready && painted ? null : (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute inset-0 z-30 grid place-items-center"
        >
          <div className="pdf-floating-shadow flex items-center gap-2 rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-xs text-kumo-subtle">
            <span
              aria-hidden="true"
              className="size-3.5 animate-spin rounded-full border-2 border-kumo-line border-t-pdf-accent motion-reduce:animate-none"
            />
            {t('viewer.rendering')}
          </div>
        </div>
      )}
    </div>
  );
}
