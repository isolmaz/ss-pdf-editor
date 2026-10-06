/**
 * Types for pdf.js's viewer stack.
 *
 * `pdfjs-dist@6.3.289` ships `web/pdf_viewer.mjs` but its published declaration
 * file (`web/pdf_viewer.d.mts`) describes a different, smaller surface — checked
 * directly against the installed package, where `PDFViewer#setDocument`,
 * `PDFFindController` and `EventBus` are absent from it. Rather than sprinkle
 * casts through the component, this module declares **exactly the surface the
 * shell uses**: an engine upgrade that changes one of these members fails the
 * typecheck instead of failing at runtime in the browser.
 *
 * The find flow goes through the `EventBus` — the same channel pdf.js's own find
 * bar uses (`eventBus.dispatch('find', …)` → `PDFFindController.#onFind`), so we
 * are not reaching into a private API.
 *
 * **Only what the module actually exports is declared here.** `AnnotationEditorType`,
 * `AnnotationMode` and `AnnotationEditorParamsType` are *not* among `web/pdf_viewer.mjs`'s
 * exports (they live in `build/pdf.mjs`); declaring them here once let a runtime
 * `undefined.NONE` through the typecheck and cost a render (`WORKLOG.md §4`, 2026-09-16).
 * Their numbers live in `viewer/PdfViewerPane.tsx` as named constants instead.
 */
declare module 'pdfjs-dist/web/pdf_viewer.mjs' {
  import type { PDFDocumentProxy } from 'pdfjs-dist';

  export class EventBus {
    on<T = unknown>(eventName: string, listener: (payload: T) => void): void;
    off<T = unknown>(eventName: string, listener: (payload: T) => void): void;
    /**
     * `payload` is the event's own shape. The channel the shell uses is `'find'`
     * (`{ type, query, caseSensitive, … }` → `PDFFindController.#onFind`), which is the
     * same one pdf.js's own find bar drives — not a private path. (pdf.js's editor
     * toolbar channel, `'switchannotationeditorparams'`, is not used here: this app
     * never enables the annotation editors, see `annotationEditorMode` below.)
     */
    dispatch(eventName: string, payload?: unknown): void;
  }

  export class PDFLinkService {
    constructor(options: { eventBus: EventBus; externalLinkTarget?: number });
    setViewer(viewer: PDFViewer): void;
    setDocument(pdfDocument: PDFDocumentProxy | null, hash?: string): void;
    readonly pagesCount: number;
    readonly page: number;
  }

  export interface FindStatePayload {
    source?: unknown;
    type?: string;
    query: string;
    caseSensitive?: boolean;
    entireWord?: boolean;
    highlightAll?: boolean;
    matchDiacritics?: boolean;
    findPrevious?: boolean;
    phraseSearch?: boolean;
  }

  /** One highlight run: `index`/`length` inside the page's extracted text. */
  export interface FindMatch {
    readonly index: number;
    readonly length: number;
  }

  export class PDFFindController {
    constructor(options: { eventBus: EventBus; linkService: PDFLinkService; delay?: number });
    setDocument(pdfDocument: PDFDocumentProxy | null): void;
    onIsPageVisible: ((pageNumber: number) => boolean) | null;
    readonly state: FindStatePayload | null;
    readonly pageMatches: (FindMatch[] | undefined)[];
    readonly pageMatchesLength: (number[] | undefined)[];
    readonly highlightMatches: boolean;
  }

  export interface PDFViewerOptions {
    container: HTMLDivElement;
    viewer: HTMLDivElement;
    eventBus: EventBus;
    linkService: PDFLinkService;
    findController?: PDFFindController;
    annotationMode?: number;
    /**
     * pdf.js `AnnotationEditorType`. **This shell always passes `DISABLE` (-1)**, which
     * is what stops pdf.js from ever constructing its `AnnotationEditorUIManager`: with
     * a manager absent there is no per-page editor layer, no base-canvas repaint when a
     * mode would be armed, and no pdf.js toolbar. `NONE` (0) would mean "available but no
     * tool armed", i.e. exactly the machinery the shell's own mark tools replace
     * (`ops/AnnotationLayer.tsx`), so no caller sets this to anything else.
     */
    annotationEditorMode?: number;
    /**
     * `name=#RRGGBB,…`. Required in practice: without it pdf.js's highlight
     * telemetry reads a colour name from a `null` map and the drag throws.
     */
    annotationEditorHighlightColors?: string;
    annotationEditorHighlightColors?: Record<string, string>;
    /**
     * Upper bound on a page canvas backing store, in device pixels. Default in pdf.js is
     * 16 Mpx (~64 MB per canvas); we pass 4 Mpx so a DPR-scaled page cannot blow the paint
     * budget (measured: 16 s of main-thread painting in a 19.7 s scroll, `WORKLOG.md §4`).
     */
    maxCanvasPixels?: number;
  }

  export class PDFViewer {
    constructor(options: PDFViewerOptions);
    setDocument(pdfDocument: PDFDocumentProxy | null): void;
    cleanup(): void;
    update(): void;
    currentScale: number;
    /**
     * The scale **as it was asked for**: `'page-width'`, `'page-fit'`, `'auto'` or the
     * numeric zoom as a string (`pdf_viewer.mjs` stores `newValue.toString()`), which is
     * what makes it the right thing to remember across a document rewrite. `null` until
     * the first scale is set (`#reset` initialises it to `null`).
     */
    currentScaleValue: string | null;
    /** 1-based page the viewer is showing; assigning scrolls to that page. */
    currentPageNumber: number;
    /** 0 = single page, 1 = odd spreads, 2 = even spreads (pdf.js SpreadMode). */
    spreadMode: number;
    /**
     * Re-assigning this promise is how pdf.js applies a changed optional-content
     * configuration (its own layer toggle does exactly this, `pdf_viewer.mjs`
     * `setOCGState` → `optionalContentConfigPromise = Promise.resolve(config)`).
     */
    optionalContentConfigPromise: Promise<unknown>;
    readonly pagesCount: number;
    /**
     * The page view for a 0-based index, or `undefined` before it is rendered.
     * `div` is the page element in the scrolling column and `viewport` converts
     * between its CSS pixels and PDF user space — the pair a coordinate-mapping
     * overlay (redaction marking) needs.
     */
    getPageView(index: number): PDFPageView | undefined;
    /**
     * The editor's mode — an **asymmetric pair**, exactly as the engine declares it
     * (`pdf_viewer.mjs`): the getter answers the `AnnotationEditorType` **number**
     * (`DISABLE` while no editor UI manager exists), the setter takes an **object**
     * (`{ mode, editId?, isFromKeyboard?, mustEnterInEditMode?, editComment? }`).
     *
     * Both halves of the mismatch cost something: reading `.mode` off the getter's
     * number is `undefined` (so "is the engine already in this mode?" is always no),
     * and assigning a number to the setter silently does nothing. The setter returns
     * without doing anything when the mode is unchanged, ignores an assignment before
     * `setDocument()`, and throws while the editor UI manager is absent — and the
     * switch into an editing mode is **asynchronous** (it waits for the pages that
     * carry edited annotations to repaint before the mode is applied).
     */
    get annotationEditorMode(): number;
    set annotationEditorMode(options: {
      mode: number;
      editId?: string | null;
      isFromKeyboard?: boolean;
      mustEnterInEditMode?: boolean;
      editComment?: boolean;
    });
  }

  export interface PDFPageView {
    readonly div: HTMLDivElement;
    readonly viewport: PDFPageViewport;
  }

  export interface PDFPageViewport {
    /** `[x0, y0, x1, y1]` of the page box in PDF user space (unrotated). */
    readonly viewBox: number[];
    /** Effective rotation in degrees: the page's own `/Rotate`, one of 0/90/180/270. */
    readonly rotation: number;
    readonly width: number;
    readonly height: number;
    /** CSS pixel offset inside the page element → PDF user space point. */
    convertToPdfPoint(x: number, y: number): number[];
  }
}
