import { buildPrintDocument, type PrintImpositionOptions } from 'pdf-core/ops/impose';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { type PrintPageSize, resolvePrintSource } from './printSource';
import './print.css';

/**
 * `window.print()` for the shell (`PLAN.md §5/Phase 1`, Phase 3: "range, scale,
 * N-up, booklet, duplex, margins and produce the PDF to print").
 *
 * Two actions share one hook:
 *
 *  - `start` rasterises the selected pages through the engine document behind the
 *    viewer, one page at a time, into a container that is hidden on screen and is
 *    the only thing the print stylesheet lets through. A 500-page job therefore
 *    allocates one canvas, not 500; it reports progress as it goes, stops on an
 *    `AbortSignal`, and takes its container and object URLs away again after
 *    `afterprint`.
 *  - `produce` builds the file that goes with those settings: the pages imposed on
 *    sheets (`buildPrintDocument`) — N-up, a saddle-stitch signature, duplex
 *    sides, margins, crop marks — and hands the bytes back instead of printing
 *    them. The browser's own print dialog is where sheet imposition normally
 *    happens, and it cannot do any of this: it prints one page per sheet, cannot
 *    write a signature order, and treats a duplex job as a printer setting rather
 *    than as a file.
 *
 * The two are deliberately separate: `start` keeps printing exactly what the
 * viewer shows (archived spike `browser-check-slices.mjs` verifies that path), and
 * the imposition settings belong to the produced file, which the dialog says.
 */

/**
 * How a page meets the sheet: `fit` scales it into A4 portrait either way,
 * `shrink-to-fit` only shrinks it, `actual` prints it at 100 %.
 */
export type PrintScale = 'fit' | 'shrink-to-fit' | 'actual';

/** One job: the pages to render (1-based, ascending — `parsePageRange`) and the sheet mapping. */
export interface PrintRequest {
  readonly pages: readonly number[];
  readonly scale: PrintScale;
  /** Cells on one side of a produced sheet (`1` = one page per side). */
  readonly perSheet: PrintImpositionOptions['perSheet'];
  readonly booklet: boolean;
  readonly duplex: PrintImpositionOptions['duplex'];
  readonly marginMm: number;
  /** N-up sheet orientation; a signature decides its own from `duplex`. */
  readonly landscape?: boolean;
  readonly cropMarks?: boolean;
}

/** A produced file, ready for the shell to open, keep or hand to a printer. */
export interface PrintProducedFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type PrintPhase = 'idle' | 'preparing' | 'printing' | 'producing';

export interface PrintFailure {
  /** 1-based page whose rasterisation failed. */
  readonly page: number;
}

export interface UsePrintingOptions {
  /** The shell's own cancellation, on top of {@link PrintController.cancel}. */
  readonly signal?: AbortSignal;
  /** After the browser's print dialog closed and the sheets are gone. */
  readonly onFinished?: () => void;
}

export interface PrintController {
  readonly phase: PrintPhase;
  /** Pages already rasterised, and how many this job will render. */
  readonly done: number;
  readonly total: number;
  readonly failure: PrintFailure | null;
  start(request: PrintRequest): void;
  /**
   * Produce the imposed file instead of printing (`PLAN.md §5/Phase 3`). Resolves
   * with the produced bytes for the caller to open or keep, or `null` when there
   * is nothing to impose; a failure throws the operation's own `ToolError`.
   */
  produce(request: PrintRequest): Promise<Uint8Array | null>;
  cancel(): void;
}

interface PrintState {
  readonly phase: PrintPhase;
  readonly done: number;
  readonly total: number;
  readonly failure: PrintFailure | null;
}

interface ActiveJob {
  readonly controller: AbortController;
  /** Removes the container, revokes the object URLs, drops the listeners. */
  teardown(): void;
}

const IDLE: PrintState = { phase: 'idle', done: 0, total: 0, failure: null };

/** Painted only by `print.css` — and what keeps a second job from stacking sheets. */
const PRINT_ROOT_CLASS = 'pdf-print-root';
const PRINT_PAGE_CLASS = 'pdf-print-page';

/**
 * pdf.js viewports are measured in PDF points (1/72") while the sheet is laid out
 * in CSS pixels (1/96"): printing at 100 % is 4/3 CSS px per point, so an A4 page
 * comes out physically A4 instead of 72/96 of it.
 */
const CSS_PX_PER_POINT = 96 / 72;

/** The "fit" target: A4 portrait in CSS pixels (210 × 297 mm at 96 dpi). */
const A4_WIDTH_PX = (210 / 25.4) * 96;
const A4_HEIGHT_PX = (297 / 25.4) * 96;

/**
 * Backing-store multiplier: `PdfDocumentHandle.renderPage` sizes the canvas by
 * `scale × devicePixelRatio` and its CSS box by `scale`, so the sheet stays A4
 * while the raster carries twice the linear resolution — 96 dpi rasterised once
 * more by the printer is visibly soft.
 */
const PRINT_PIXEL_RATIO = 2;

/**
 * Where one page meets the sheet. 100 % is {@link CSS_PX_PER_POINT}, so
 * `shrink-to-fit` is the A4 fit clamped at it: a page smaller than A4 is printed
 * as it is instead of blown up to fill the sheet.
 */
function sheetScale(mode: PrintScale, size: PrintPageSize): number {
  if (mode === 'actual') return CSS_PX_PER_POINT;
  const fitted = Math.min(A4_WIDTH_PX / size.width, A4_HEIGHT_PX / size.height);
  return mode === 'shrink-to-fit' ? Math.min(fitted, CSS_PX_PER_POINT) : fitted;
}

/** The operation options a produce request stands for (`PrintRequest` → `pdf-core`). */
function impositionOf(request: PrintRequest): PrintImpositionOptions {
  return {
    // `PrintRequest.pages` are 1-based (`parsePageRange`); the engine counts from 0.
    pages: request.pages.map((page) => page - 1),
    perSheet: request.perSheet,
    booklet: request.booklet,
    duplex: request.duplex,
    marginMm: request.marginMm,
    // A4 is the sheet both actions work in: the browser path fits to A4 portrait
    // (`print.css`), and the produced file is A4 unless the caller says otherwise.
    paper: 'a4',
    landscape: request.landscape ?? false,
    cropMarks: request.cropMarks ?? false,
    scale: request.scale,
  };
}

export function usePrinting(viewer: ViewerApi | null, options: UsePrintingOptions = {}): PrintController {
  const { signal, onFinished } = options;
  const [state, setState] = useState<PrintState>(IDLE);
  const jobRef = useRef<ActiveJob | null>(null);
  const produceRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    produceRef.current?.abort();
    produceRef.current = null;
    const job = jobRef.current;
    if (job === null) return;
    job.teardown();
    setState(IDLE);
  }, []);

  // Unmounting must not leave sheets in `document.body`, object URLs in memory or
  // a render task running.
  useEffect(
    () => () => {
      produceRef.current?.abort();
      produceRef.current = null;
      jobRef.current?.teardown();
      jobRef.current = null;
    },
    [],
  );

  const start = useCallback(
    (request: PrintRequest) => {
      const source = resolvePrintSource(viewer);
      if (source === null || request.pages.length === 0) return;

      // A second call must not stack containers: the previous job's sheets go first.
      cancel();

      const controller = new AbortController();
      const root = document.createElement('div');
      root.className = PRINT_ROOT_CLASS;
      document.body.append(root);
      const urls: string[] = [];

      /** Idempotent: `afterprint`, `cancel()`, unmount and the caller's signal all end here. */
      const teardown = () => {
        // The render loop stops on this, so a torn-down job can never keep drawing
        // into a container that is no longer in the document.
        controller.abort();
        window.removeEventListener('afterprint', onAfterPrint);
        signal?.removeEventListener('abort', onExternalAbort);
        root.remove();
        for (const url of urls) URL.revokeObjectURL(url);
        urls.length = 0;
        if (jobRef.current?.controller === controller) jobRef.current = null;
      };
      const onAfterPrint = () => {
        teardown();
        setState(IDLE);
        onFinished?.();
      };
      // The caller's signal ends the job exactly like `cancel()` does.
      const onExternalAbort = () => {
        teardown();
        setState(IDLE);
      };

      jobRef.current = { controller, teardown };
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      window.addEventListener('afterprint', onAfterPrint, { once: true });
      setState({ phase: 'preparing', done: 0, total: request.pages.length, failure: null });

      void (async () => {
        // One canvas for the whole job: sequential `await`, so a 500-page print
        // never holds 500 backing stores.
        const canvas = document.createElement('canvas');
        let rendered = 0;
        try {
          for (const pageNumber of request.pages) {
            if (controller.signal.aborted) return;
            const size = await source.getPageSize(pageNumber - 1, 1);
            const scale = sheetScale(request.scale, size);
            await source.renderPage(pageNumber - 1, canvas, {
              scale,
              devicePixelRatio: PRINT_PIXEL_RATIO,
              signal: controller.signal,
            });
            if (controller.signal.aborted) return;
            const url = await toImageUrl(canvas);
            urls.push(url);
            root.append(printSheet(url, size, scale, request.scale));
            rendered += 1;
            setState({ phase: 'preparing', done: rendered, total: request.pages.length, failure: null });
          }
          // The print engine may rasterise before the images decode; waiting here is
          // what keeps the first sheet from coming out blank. One image at a time, so
          // the wait cannot turn into a second copy of the whole job in memory.
          for (const image of root.querySelectorAll('img')) await image.decode();
          if (controller.signal.aborted) return;
          setState({ phase: 'printing', done: rendered, total: request.pages.length, failure: null });
          window.print();
        } catch {
          // An abort is control flow, not a failure: whoever aborted has already
          // torn the job down and reset the state.
          if (controller.signal.aborted) return;
          const page = request.pages[rendered] ?? request.pages[request.pages.length - 1] ?? 1;
          teardown();
          setState({ phase: 'idle', done: rendered, total: request.pages.length, failure: { page } });
        }
      })();
    },
    [cancel, onFinished, signal, viewer],
  );

  /**
   * Build the imposed file (`PLAN.md §5/Phase 3`) instead of printing it. The
   * document bytes come from the engine document behind the viewer — the same
   * bytes `start` rasterises — so what the user asked to print is what gets
   * imposed, unsaved annotations and form values included.
   */
  const produce = useCallback(
    async (request: PrintRequest): Promise<Uint8Array | null> => {
      const source = resolvePrintSource(viewer);
      if (source === null || viewer === null || request.pages.length === 0) return null;

      // A second job must not run beside the first — neither sheets nor an
      // imposition of the same pages.
      cancel();
      const controller = new AbortController();
      produceRef.current = controller;
      setState({ phase: 'producing', done: 0, total: request.pages.length, failure: null });
      try {
        // The bytes come from the engine document itself (`ViewerApi.document` is
        // the `PdfDocumentHandle` the raster loop above draws with; `printSource.ts`
        // explains why the handle *is* the page source), so unsaved annotations and
        // form values are part of what gets imposed.
        const bytes = await viewer.document.saveDocument();
        if (controller.signal.aborted) return null;
        const outcome = await buildPrintDocument(bytes, impositionOf(request), {
          signal: controller.signal,
          onProgress: (progress) =>
            setState({
              phase: 'producing',
              done: progress.done ?? 0,
              total: progress.total ?? request.pages.length,
              failure: null,
            }),
        });
        if (controller.signal.aborted) return null;
        return outcome.bytes;
      } finally {
        if (produceRef.current === controller) produceRef.current = null;
        setState(IDLE);
      }
    },
    [cancel, viewer],
  );

  return { ...state, start, produce, cancel };
}

/**
 * One sheet per page. "Fit" leaves the size to the stylesheet (`width: 100%` with
 * `object-fit: contain` resolves to the same box the fit scale computed, because
 * the raster carries the page's aspect ratio); "actual size" and
 * "shrink-to-fit" pin the page's own size and the sheet centres it.
 */
function printSheet(url: string, size: PrintPageSize, scale: number, mode: PrintScale): HTMLDivElement {
  const sheet = document.createElement('div');
  sheet.className = PRINT_PAGE_CLASS;
  const image = document.createElement('img');
  image.src = url;
  image.alt = '';
  if (mode !== 'fit') {
    image.style.width = `${Math.round(size.width * scale)}px`;
    image.style.height = `${Math.round(size.height * scale)}px`;
  }
  sheet.append(image);
  return sheet;
}

/** A rasterised page as an object URL the sheet can show; revoked on teardown. */
function toImageUrl(canvas: HTMLCanvasElement): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  canvas.toBlob((blob) => {
    if (blob === null) {
      reject(new Error('canvas.toBlob produced no image'));
      return;
    }
    resolve(URL.createObjectURL(blob));
  }, 'image/png');
  return promise;
}
