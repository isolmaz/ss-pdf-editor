/**
 * pdf.js adapter (`PLAN.md §3.1`): the only place that talks to pdf.js.
 *
 * Components and panels never import `pdfjs-dist` directly — they use this
 * adapter, so the engine's error vocabulary is mapped once (Turkish user text,
 * see `pdf-shared`), assets are wired once (CMaps/standard fonts/wasm) and the
 * `K15` rule is enforced: engines receive a **disposable copy** of the bytes,
 * never the app-owned master buffer (pdf.js may transfer/detach it).
 */

import { ToolError, toToolError } from 'pdf-shared';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFJS_ASSETS } from '../assets';

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsModule: Promise<PdfjsModule> | null = null;

/**
 * pdf.js is an **engine chunk, loaded lazily** (`PLAN.md §3.6`, budget in §7):
 * the shell must paint without dragging a 1.5 MB parser into the first paint.
 * The import is cached, so opening a second document does not re-fetch it.
 *
 * A **failed** import is not cached: `warmPdfjs()` has already run at idle on this
 * page, so one transient chunk failure would otherwise keep every later open
 * failing until a hard refresh. The slot is cleared only while it still holds the
 * attempt that failed — a blanket clear would throw away a newer in-flight load.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (pdfjsModule !== null) return pdfjsModule;
  const attempt = import('pdfjs-dist').then((module) => {
    module.GlobalWorkerOptions.workerSrc = PDFJS_ASSETS.worker;
    return module;
  });
  pdfjsModule = attempt;
  attempt.catch(() => {
    if (pdfjsModule === attempt) pdfjsModule = null;
  });
  return attempt;
}

/**
 * Loads the engine chunk before a document exists, so the first file the user picks does
 * not pay for downloading and parsing it on the critical path. The bundle's fetch and
 * parse are same-origin and already part of the app, so this adds no network behaviour —
 * it only moves the work to a moment when the shell is idle.
 *
 * Failure is deliberately silent: a warmup that cannot run must not disturb anything.
 */
export function warmPdfjs(): void {
  void loadPdfjs().catch(() => undefined);
}

/**
 * The shape pdf.js accepts for `getDocument({ annotationStorage })`: the storage
 * is seeded from a plain map before the document proxy exists, which is how a
 * reopened document gets its unsaved annotation layer back (`PLAN.md §3.5`).
 * Values are pdf.js's own serializable annotation records.
 */
export interface PdfAnnotationStorageInit {
  readonly map: Map<unknown, unknown>;
  readonly hash: string;
  readonly transfer?: unknown[];
}

export interface PdfOpenOptions {
  readonly password?: string;
  readonly signal?: AbortSignal;
  /** Receives the pdf.js password reason (1 = needs password, 2 = wrong). */
  readonly onPasswordRequest?: (reason: 'needed' | 'incorrect') => void;
  readonly onProgress?: (loaded: number, total: number) => void;
  /** Seeds the engine's annotation storage before the document is created. */
  readonly annotationStorage?: PdfAnnotationStorageInit;
}

export interface PdfRenderOptions {
  readonly scale: number;
  readonly rotation?: number;
  readonly devicePixelRatio?: number;
  readonly background?: string;
  readonly signal?: AbortSignal;
}

export interface PdfPageSize {
  readonly width: number;
  readonly height: number;
  /** Effective rotation (source rotation + requested rotation), in degrees. */
  readonly rotation: number;
}

/** One outline entry the shell can render: title plus its 0-based target page. */
export interface PdfOutlineEntry {
  readonly title: string;
  readonly pageIndex: number | null;
  readonly children: readonly PdfOutlineEntry[];
}

/**
 * One text run of a page — pdf.js's `TextItem`, renamed and flattened for the
 * callers that need more than `getPageText`'s joined string.
 *
 * Everything here is **PDF user space** (bottom-left origin, `y` up): a page's
 * `/Rotate` is applied by the viewport, never by the item geometry, so a consumer
 * that also has the page box can convert without knowing the rotation (`x`/`y` are
 * the run's baseline start, `transform` is the raw text matrix).
 */
export interface TextItemData {
  readonly text: string;
  /** Baseline start x in PDF user space. */
  readonly x: number;
  /** Baseline start y in PDF user space. */
  readonly y: number;
  /** Advance width of the run. */
  readonly width: number;
  readonly height: number;
  /** Key into {@link TextContentPage.styles}. */
  readonly fontName: string;
  /** `ltr`, `rtl` or `ttb`. */
  readonly dir: string;
  /** The run ends a line in the content stream. */
  readonly hasEOL: boolean;
  /** The raw text matrix `[a, b, c, d, e, f]`. */
  readonly transform: readonly number[];
}

/** A font the page's text runs use, as pdf.js measured it. */
export interface TextContentStyle {
  readonly fontFamily: string;
  readonly ascent: number;
  readonly descent: number;
  readonly vertical?: boolean;
}

/** One page's text content plus the geometry needed to place it. */
export interface TextContentPage {
  readonly items: TextItemData[];
  readonly styles: Record<string, TextContentStyle>;
  /** The unrotated page size (`scale: 1`) and the rotation a reader applies. */
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly rotation: 0 | 90 | 180 | 270;
  };
}

/** One page's parsed content operators; `fnArray[i]` and `argsArray[i]` pair up. */
export interface PageOperatorList {
  readonly fnArray: number[];
  readonly argsArray: unknown[][];
}

export interface PdfDocumentHandle {
  readonly pageCount: number;
  readonly fingerprint: string | null;
  getPageSize(pageIndex: number, scale: number, rotation?: number): Promise<PdfPageSize>;
  renderPage(pageIndex: number, canvas: HTMLCanvasElement, options: PdfRenderOptions): Promise<void>;
  getPageText(pageIndex: number): Promise<string>;
  /**
   * Document outline with destinations resolved to 0-based page indices
   * (`PLAN.md §5/Phase 1`). Entries whose destination cannot be resolved —
   * external URLs, unresolvable named destinations — keep `pageIndex: null` and
   * stay visible rather than being dropped silently.
   */
  getOutline(): Promise<readonly PdfOutlineEntry[]>;
  /**
   * The page's text runs with their geometry (`PLAN.md §5/Phase 4f`): the read
   * side of the text writer's own verification and of any selection path that
   * needs positions rather than one joined string. Coordinates stay in PDF user
   * space — the rotation a reader applies is reported beside them, not baked in.
   */
  textContent(pageIndex: number): Promise<TextContentPage>;
  /**
   * The page's parsed content operators (`page.getOperatorList()`), for geometry
   * walks that need what was drawn rather than what it says — image selection and
   * the text writer's diagnostics.
   */
  operatorList(pageIndex: number): Promise<PageOperatorList>;
  /**
   * `K14` path 1 — incremental **file format**, full-size buffer in memory.
   * The buffer is `ArrayBuffer`-backed on purpose: the File System Access
   * writable stream accepts exactly `ArrayBufferView<ArrayBuffer>`.
   */
  saveDocument(): Promise<Uint8Array<ArrayBuffer>>;
  destroy(): Promise<void>;
  /** Escape hatch for prototypes and pdf-core internals only. */
  readonly raw: PDFDocumentProxy;
}

const PASSWORD_INCORRECT = 2;

/** pdf.js exception names -> our contract. Never let the raw name reach the UI. */
function mapPdfjsError(error: unknown): ToolError {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  const rawCode: unknown =
    error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = typeof rawCode === 'number' ? rawCode : undefined;
  switch (name) {
    case 'PasswordException':
      return new ToolError(
        code === PASSWORD_INCORRECT ? 'wrong-password' : 'password-required',
        { engine: 'pdfjs', engineMessage: message },
        { cause: error },
      );
    case 'InvalidPDFException':
      return new ToolError('corrupt-document', { engine: 'pdfjs', engineMessage: message }, { cause: error });
    case 'MissingPDFException':
    case 'UnexpectedResponseException':
      return new ToolError(
        'unsupported-format',
        { engine: 'pdfjs', engineMessage: message },
        { cause: error },
      );
    case 'AbortException':
    case 'RenderingCancelledException':
      return new ToolError('aborted', { engine: 'pdfjs', engineMessage: message }, { cause: error });
    default:
      return toToolError(error, 'pdfjs');
  }
}

function abortError(): ToolError {
  return new ToolError('aborted', { engine: 'pdfjs', engineMessage: 'signal aborted' });
}

export async function openWithPdfjs(
  bytes: Uint8Array,
  options: PdfOpenOptions = {},
): Promise<PdfDocumentHandle> {
  const { signal } = options;
  if (signal?.aborted) throw abortError();

  const pdfjs = await loadPdfjs();
  // Loading the chunk is asynchronous too, and an abort that arrives during it must not
  // start a parse the caller has already given up on (`F12`).
  if (signal?.aborted) throw abortError();
  const loadingTask = pdfjs.getDocument({
    // Disposable copy: the caller keeps the master buffer (K15).
    data: bytes.slice(),
    password: options.password,
    cMapUrl: PDFJS_ASSETS.cmaps,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_ASSETS.standardFonts,
    wasmUrl: PDFJS_ASSETS.wasm,
    verbosity: pdfjs.VerbosityLevel.WARNINGS,
    // **On purpose, and it is the difference between smooth and unusable scrolling.**
    // Turning this off (an earlier workaround for a render stall) forbids pdf.js from
    // decoding images into `ImageBitmap`s in the worker: it then ships raw RGB to the
    // main thread, which converts it with `convertRGBToRGBA` **in JavaScript** — a
    // measured ~170 ms per 1240x1754 page, i.e. 16 s of main-thread work inside a 19.7 s
    // scroll of a 130-page image-heavy document, and 45 % of all JS time
    // (`tools/spikes/measure-scroll.mjs --profile`, `WORKLOG.md §4`). With it on, the
    // images arrive as bitmaps and the main thread only blits them.
    isOffscreenCanvasSupported: true,
    // Seeded before the document exists, so a restored annotation layer is part
    // of the render from the first page paint (`PLAN.md §3.5` drafts).
    ...(options.annotationStorage === undefined ? {} : { annotationStorage: options.annotationStorage }),
    // Embedded document JavaScript stays inert: pdf.js core never executes it —
    // execution needs a PDFScriptingManager that we deliberately do not attach
    // (`PLAN.md §3.7`).
  });

  let destroyed = false;
  const onAbort = () => {
    destroyed = true;
    void loadingTask.destroy().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  /**
   * pdf.js settles the loading task **only** through this callback: `updatePassword` takes
   * a string to try again, or an `Error` to fail the load (its own `PasswordRequest`
   * handler rejects the password capability with whatever it is given). The previous
   * version answered with the same rejected password, or with nothing at all, so a
   * password-protected document left `loadingTask.promise` pending forever — and every
   * `await openWithPdfjs(...)` in the application with it (`F12`).
   *
   * One attempt per supplied password, then the honest failure: `wrong-password` when the
   * engine said the previous one was wrong, `password-required` when none was supplied.
   */
  let passwordAttempts = 0;
  loadingTask.onPassword = (updatePassword: (password: string | Error) => void, reason: number) => {
    options.onPasswordRequest?.(reason === PASSWORD_INCORRECT ? 'incorrect' : 'needed');
    const supplied = options.password;
    if (supplied !== undefined && passwordAttempts === 0) {
      passwordAttempts += 1;
      updatePassword(supplied);
      return;
    }
    const rejected = new Error(
      reason === PASSWORD_INCORRECT ? 'the supplied password was refused' : 'a password is required',
    );
    // The name and the code are the contract `mapPdfjsError` reads; the message is what
    // reaches the diagnostics, never the UI text.
    rejected.name = 'PasswordException';
    (rejected as Error & { code?: number }).code = reason;
    updatePassword(rejected);
  };
  if (options.onProgress) {
    const onProgress = options.onProgress;
    loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) =>
      onProgress(loaded, total);
  }

  let document: PDFDocumentProxy;
  try {
    document = await loadingTask.promise;
  } catch (error) {
    // A task that failed is torn down here: leaving it alive keeps a worker and a partial
    // document for a file the user will never see (`F12`). Best-effort — the mapped error
    // is what the caller must receive.
    await loadingTask.destroy().catch(() => undefined);
    throw mapPdfjsError(error);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (destroyed || signal?.aborted) {
    // The loading task owns the worker and the transport, so that is what releases them.
    await loadingTask.destroy().catch(() => undefined);
    throw abortError();
  }

  const { numPages, fingerprints } = document;

  const handle: PdfDocumentHandle = {
    pageCount: numPages,
    fingerprint: fingerprints?.[0] ?? null,
    raw: document,

    async getPageSize(pageIndex, scale, rotation) {
      const page = await document.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale, ...(rotation === undefined ? {} : { rotation }) });
      return { width: viewport.width, height: viewport.height, rotation: viewport.rotation };
    },

    async renderPage(pageIndex, canvas, renderOptions) {
      if (renderOptions.signal?.aborted) throw abortError();
      const page = await document.getPage(pageIndex + 1);
      const pixelRatio =
        renderOptions.devicePixelRatio ?? (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
      const viewport = page.getViewport({
        scale: renderOptions.scale * pixelRatio,
        ...(renderOptions.rotation === undefined ? {} : { rotation: renderOptions.rotation }),
      });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`;
      // pdf.js writes the viewport transform onto the context and restores it only when the
      // render *completes*. A cancelled task therefore leaves the transform (and the page
      // background) behind: the next render on the same canvas draws into that state and the
      // result is visibly skewed — the owner saw a page come back upside down after a panel
      // switch. Resetting the canvas before handing it to pdf.js makes every render start
      // from a known context.
      const context = canvas.getContext('2d');
      if (context !== null) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
      }

      const task = page.render({
        canvas,
        viewport,
        ...(renderOptions.background === undefined ? {} : { background: renderOptions.background }),
      });
      const onAbort = () => task.cancel();
      renderOptions.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await task.promise;
      } catch (error) {
        throw mapPdfjsError(error);
      } finally {
        renderOptions.signal?.removeEventListener('abort', onAbort);
      }
    },

    async getPageText(pageIndex) {
      const page = await document.getPage(pageIndex + 1);
      const content = await page.getTextContent();
      return content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
    },

    async textContent(pageIndex) {
      const page = await document.getPage(pageIndex + 1);
      try {
        const content = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        const items: TextItemData[] = [];
        for (const item of content.items) {
          // Marked-content entries carry no text; the union is what pdf.js types,
          // even though they only appear when `includeMarkedContent` is set.
          if (!('str' in item)) continue;
          items.push({
            text: item.str,
            x: item.transform[4] ?? 0,
            y: item.transform[5] ?? 0,
            width: item.width,
            height: item.height,
            fontName: item.fontName,
            dir: item.dir,
            hasEOL: item.hasEOL,
            // The worker hands each item its own matrix: passing it on is a move.
            transform: item.transform,
          });
        }
        return {
          items,
          styles: content.styles,
          viewport: {
            width: viewport.width,
            height: viewport.height,
            // pdf.js already reduces the page's `/Rotate` mod 360 (and refuses a
            // value that is not a quarter turn); the cast states that contract.
            rotation: (((viewport.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270,
          },
        };
      } catch (error) {
        throw mapPdfjsError(error);
      }
    },

    async operatorList(pageIndex) {
      const page = await document.getPage(pageIndex + 1);
      try {
        const list = await page.getOperatorList();
        // pdf.js types `argsArray` as `any[]`; every entry is that operator's
        // argument array, which is the shape a caller indexes with `fnArray`.
        return { fnArray: list.fnArray, argsArray: list.argsArray as unknown[][] };
      } catch (error) {
        throw mapPdfjsError(error);
      }
    },

    async getOutline() {
      // pdf.js gives destinations as a named string or an explicit array whose
      // first element is the page reference; both resolve through getPageIndex
      // (0-based), everything else stays null instead of guessing.
      const resolvePageIndex = async (dest: string | unknown[] | null): Promise<number | null> => {
        if (dest === null) return null;
        try {
          const explicit = typeof dest === 'string' ? await document.getDestination(dest) : dest;
          const target = explicit?.[0];
          if (target !== undefined && target !== null && typeof target === 'object') {
            return await document.getPageIndex(target as Parameters<typeof document.getPageIndex>[0]);
          }
          return null;
        } catch {
          // Unresolvable destination (external file, broken reference): keep the
          // entry, drop the target — never let one bad node hide the outline.
          return null;
        }
      };

      // pdf.js answers  for a document without an outline (the loose types say
      // `Array`); both browsers threw 'not iterable' on that until this was handled.
      const nodes = (await document.getOutline()) ?? [];
      const walk = async (entries: typeof nodes): Promise<PdfOutlineEntry[]> => {
        const result: PdfOutlineEntry[] = [];
        for (const entry of entries) {
          result.push({
            title: entry.title,
            pageIndex: await resolvePageIndex(entry.dest),
            children: entry.items.length === 0 ? [] : await walk(entry.items as typeof nodes),
          });
        }
        return result;
      };
      return walk(nodes);
    },

    async saveDocument() {
      try {
        // Nothing in the engine's storage means nothing to save: the document's own
        // bytes are the answer. pdf.js serialises anyway when asked and warns that
        // `getData` was meant — measured on every export without a form edit.
        if (document.annotationStorage.size === 0) return new Uint8Array(await document.getData());
        // v6 returns the full buffer (originalData.length + delta) — incremental
        // file format, full-size memory (K14, §3.3/2).
        return new Uint8Array(await document.saveDocument());
      } catch (error) {
        throw mapPdfjsError(error);
      }
    },

    async destroy() {
      // The loading task owns the worker and the transport.
      await loadingTask.destroy();
    },
  };

  return handle;
}
