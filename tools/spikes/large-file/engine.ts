/**
 * pdf.js access for spike #5 (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * This spike talks to pdf.js **directly** instead of through `pdf-core`'s
 * adapter, because the measurement needs two things the product adapter
 * deliberately hides: the raw `annotationStorage` (a save with an empty storage
 * returns `null`, so there would be nothing to measure) and the render task
 * handle (to cancel a render under memory pressure). Loader options are copied
 * from the adapter so the spike runs the production configuration — worker from
 * `/engines/pdfjs/**`, CMaps, standard fonts, wasm, scripting off.
 */
import { PDFJS_ASSETS } from 'pdf-core';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { GlobalWorkerOptions, getDocument, VerbosityLevel } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = PDFJS_ASSETS.worker;

export type { PDFDocumentProxy } from 'pdfjs-dist';

export interface OpenedDocument {
  readonly document: PDFDocumentProxy;
  readonly loadingTask: PDFDocumentLoadingTask;
  readonly openMs: number;
  /** pdf.js may transfer the typed array to the worker — then the caller's handle is empty (`K15`). */
  readonly dataDetached: boolean;
}

/**
 * Opens a document. The caller passes a **disposable copy** and keeps its own
 * master buffer, exactly as the product's source vault does (`K15`).
 */
export async function openDocument(source: Uint8Array): Promise<OpenedDocument> {
  const started = performance.now();
  const loadingTask = getDocument({
    data: source,
    cMapUrl: PDFJS_ASSETS.cmaps,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_ASSETS.standardFonts,
    wasmUrl: PDFJS_ASSETS.wasm,
    verbosity: VerbosityLevel.WARNINGS,
  });
  const document = await loadingTask.promise;
  return {
    document,
    loadingTask,
    openMs: performance.now() - started,
    dataDetached: source.byteLength === 0,
  };
}

export interface RenderResult {
  readonly ms: number;
  readonly width: number;
  readonly height: number;
}

export async function renderPageToCanvas(
  proxy: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
  canvas: HTMLCanvasElement,
): Promise<RenderResult> {
  const started = performance.now();
  const page = await proxy.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const width = Math.floor(viewport.width);
  const height = Math.floor(viewport.height);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable');
  const task = page.render({ canvas, canvasContext: context, viewport });
  await task.promise;
  page.cleanup();
  return { ms: performance.now() - started, width, height };
}

/** A render that stays cancellable, so the degradation probe can test cancel responsiveness. */
export interface CancellableRender {
  readonly started: number;
  cancel(): void;
  readonly done: Promise<{ cancelled: boolean; ms: number; error: string | null }>;
}

export async function startCancellableRender(
  proxy: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
): Promise<CancellableRender> {
  const page = await proxy.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable');
  const started = performance.now();
  const task = page.render({ canvas, canvasContext: context, viewport });
  const { promise, resolve } = Promise.withResolvers<{
    cancelled: boolean;
    ms: number;
    error: string | null;
  }>();
  task.promise.then(
    () => resolve({ cancelled: false, ms: performance.now() - started, error: null }),
    (error: unknown) => {
      const name = error instanceof Error ? error.name : '';
      resolve({
        cancelled: name.includes('Cancel'),
        ms: performance.now() - started,
        error: error instanceof Error ? `${name}: ${error.message}` : String(error),
      });
    },
  );
  return {
    started,
    cancel: () => task.cancel(),
    done: promise,
  };
}

export interface AnnotationProbe {
  readonly found: boolean;
  readonly id: string | null;
  readonly keys: readonly string[];
  readonly fieldName: unknown;
  readonly fieldValue: unknown;
}

/** Reads page 1's widget data — the source of the annotation-storage key used for the save step. */
export async function probeFieldAnnotation(
  proxy: PDFDocumentProxy,
  fieldName: string,
): Promise<AnnotationProbe> {
  const page = await proxy.getPage(1);
  const annotations = (await page.getAnnotations({ intent: 'display' })) as Array<Record<string, unknown>>;
  const widget = annotations.find((entry) => entry.fieldName === fieldName);
  page.cleanup();
  if (!widget) return { found: false, id: null, keys: [], fieldName: null, fieldValue: null };
  return {
    found: true,
    id: typeof widget.id === 'string' ? widget.id : null,
    keys: Object.keys(widget).sort(),
    fieldName: widget.fieldName,
    fieldValue: widget.fieldValue,
  };
}

export interface SaveAttempt {
  readonly keyUsed: string | null;
  readonly keysTried: readonly string[];
  readonly output: Uint8Array | null;
  readonly ms: number | null;
  readonly error: string | null;
}

/**
 * Fills a form field through `annotationStorage` and saves. Candidate keys are
 * tried in order because the storage key is the annotation id as pdf.js reports
 * it — the spike discovers that id at runtime rather than assuming a format.
 */
export async function saveWithFormValue(
  proxy: PDFDocumentProxy,
  keyCandidates: readonly string[],
  value: string,
): Promise<SaveAttempt> {
  const keysTried: string[] = [];
  let lastError: string | null = null;

  for (const key of keyCandidates) {
    if (key.length === 0) continue;
    keysTried.push(key);
    proxy.annotationStorage.setValue(key, { value });
    const started = performance.now();
    try {
      const output = (await proxy.saveDocument()) as Uint8Array | null | undefined;
      if (output && output.byteLength > 0) {
        proxy.annotationStorage.resetModified();
        return { keyUsed: key, keysTried, output, ms: performance.now() - started, error: null };
      }
      lastError = 'saveDocument() returned no data (annotation storage change was not picked up)';
      proxy.annotationStorage.remove(key);
      proxy.annotationStorage.resetModified();
    } catch (caught) {
      lastError = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
      proxy.annotationStorage.remove(key);
      proxy.annotationStorage.resetModified();
    }
  }

  return {
    keyUsed: null,
    keysTried,
    output: null,
    ms: null,
    error: lastError ?? 'no key candidate available',
  };
}

/** True when `output` is `input` with an appended incremental update. */
export function isIncrementalOver(output: Uint8Array, input: Uint8Array): boolean {
  if (output.byteLength <= input.byteLength) return false;
  for (let index = 0; index < input.byteLength; index += 1) {
    if (output[index] !== input[index]) return false;
  }
  return true;
}

/**
 * Looks for a marker in the appended tail, in both PDF string encodings (literal
 * bytes and UTF-16BE-with-BOM). Cheaper than re-opening a 300 MB file just to
 * confirm the save landed.
 */
export function findMarkerInTail(bytes: Uint8Array, marker: string, tailBytes = 4 * 1024 * 1024): number {
  const from = Math.max(0, bytes.byteLength - tailBytes);
  const tail = bytes.subarray(from);
  const ascii = new TextEncoder().encode(marker);
  const utf16 = new Uint8Array(2 + marker.length * 2);
  utf16[0] = 0xfe;
  utf16[1] = 0xff;
  for (let index = 0; index < marker.length; index += 1) {
    utf16[2 + index * 2] = 0;
    utf16[3 + index * 2] = marker.charCodeAt(index) & 0xff;
  }
  return Math.max(indexOfBytes(tail, ascii), indexOfBytes(tail, utf16));
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.byteLength === 0 || haystack.byteLength < needle.byteLength) return -1;
  const first = needle[0] ?? 0;
  const limit = haystack.byteLength - needle.byteLength;
  outer: for (let index = 0; index <= limit; index += 1) {
    if (haystack[index] !== first) continue;
    for (let offset = 1; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}
