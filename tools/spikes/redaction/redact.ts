/**
 * The redaction step of spike #4 (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * The exact MuPDF call sequence, recorded so the audit can name it:
 *   1. `page.search(token, {})`        → where the occurrence is (quad list)
 *   2. `page.createAnnotation("Redact")` + `setRect(bbox)` + `update()`
 *   3. `page.applyRedactions(blackBoxes, imageMethod, lineArtMethod, textMethod)`
 *   4. `doc.canBeSavedIncrementally()` (before and after step 3)
 *   5. `doc.saveToBuffer("incremental")` probe — what a second save does
 *   6. `doc.saveToBuffer(<cleanup options>)` → the exported file
 */
import { type Mupdf, openPdf, type PdfAnnot, type PdfDoc, type PdfPage, savePdf, trySavePdf } from './engine';

/** `page.search` yields a quad list per hit; a single hit may span quads. */
type Quad = [number, number, number, number, number, number, number, number];
/** `[x0, y0, x1, y1]` — the shape `PDFAnnotation.setRect` expects. */
type Rect = [number, number, number, number];

export interface RedactAttempt {
  readonly saveOptions: string;
  readonly applyRedactionsArgs: string;
  readonly blackBoxes: boolean;
  readonly searchCalls: number;
  readonly hitsFound: number;
  readonly boxes: Rect[];
  readonly annotationsCreated: number;
  readonly beforeCanBeSavedIncrementally: boolean;
  readonly afterCanBeSavedIncrementally: boolean;
  readonly hasUnsavedChanges: boolean;
  readonly incrementalProbe: string;
  readonly incrementalProbeBytes: number | null;
  /** Bytes of the second save (`saveToBuffer("incremental")`), when it produced any. */
  readonly incrementalProbeOutput: Uint8Array | null;
  readonly bytes: Uint8Array | null;
  readonly error: string | null;
  readonly elapsedMs: number;
}

function boundingBox(quads: Quad[]): Rect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x0, y0, x1, y1, x2, y2, x3, y3] of quads) {
    xs.push(x0, x1, x2, x3);
    ys.push(y0, y1, y2, y3);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function normalizeHits(raw: unknown): Quad[][] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // 1.28.1 returns Quad[][] (one array of quads per hit); a flat Quad[] is
  // accepted as a single hit so the spike survives either shape.
  return Array.isArray(raw[0]) ? (raw as Quad[][]) : [raw as Quad[]];
}

export async function redactToken(
  mupdf: Mupdf,
  input: Uint8Array,
  token: string,
  pageIndex: number,
  saveOptions: string,
  probeIncremental = true,
  blackBoxes = false,
): Promise<RedactAttempt> {
  const started = performance.now();
  const doc: PdfDoc = openPdf(mupdf, input);
  const before = doc.canBeSavedIncrementally();

  const page: PdfPage = doc.loadPage(pageIndex);
  let hits: Quad[][] = [];
  let searchCalls = 0;
  try {
    searchCalls += 1;
    hits = normalizeHits(page.search(token, {}) as unknown);
    if (hits.length === 0) {
      // Some builds want the options object explicitly typed; retry once.
      searchCalls += 1;
      hits = normalizeHits(page.search(token, { max: 64 }) as unknown);
    }
  } catch (error) {
    page.destroy();
    doc.destroy();
    return failed(saveOptions, before, searchCalls, `search threw: ${message(error)}`, started);
  }

  const imageMethod = mupdf.PDFPage.REDACT_IMAGE_NONE;
  const lineArtMethod = mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_TOUCHED;
  const textMethod = mupdf.PDFPage.REDACT_TEXT_REMOVE;

  const boxes: Rect[] = [];
  const annotations: PdfAnnot[] = [];
  for (const hit of hits) {
    const box = boundingBox(hit);
    boxes.push(box);
    const annotation = page.createAnnotation('Redact');
    annotation.setRect(box);
    annotation.update();
    annotations.push(annotation);
  }

  page.applyRedactions(blackBoxes, imageMethod, lineArtMethod, textMethod);
  const after = doc.canBeSavedIncrementally();
  const unsaved = doc.hasUnsavedChanges();

  let incrementalProbe = 'not probed';
  let incrementalProbeBytes: number | null = null;
  let incrementalProbeOutput: Uint8Array | null = null;
  if (probeIncremental) {
    const probe = trySavePdf(doc, 'incremental');
    if (probe.bytes) {
      incrementalProbeBytes = probe.bytes.byteLength;
      incrementalProbeOutput = probe.bytes;
      incrementalProbe = `SUCCEEDED (${probe.bytes.byteLength} bytes) — retained for audit`;
    } else {
      incrementalProbe = `threw: ${probe.error}`;
    }
  }

  const save = trySavePdf(doc, saveOptions);
  for (const annotation of annotations) annotation.destroy();
  page.destroy();
  doc.destroy();

  return {
    saveOptions,
    applyRedactionsArgs: `page.applyRedactions(${blackBoxes}, ${imageMethod} /*REDACT_IMAGE_NONE*/, ${lineArtMethod} /*REDACT_LINE_ART_REMOVE_IF_TOUCHED*/, ${textMethod} /*REDACT_TEXT_REMOVE*/)`,
    blackBoxes,
    searchCalls,
    hitsFound: hits.length,
    boxes,
    annotationsCreated: annotations.length,
    beforeCanBeSavedIncrementally: before,
    afterCanBeSavedIncrementally: after,
    hasUnsavedChanges: unsaved,
    incrementalProbe,
    incrementalProbeBytes,
    incrementalProbeOutput,
    bytes: save.bytes,
    error: save.error,
    elapsedMs: Math.round(performance.now() - started),
  };
}

function failed(
  saveOptions: string,
  before: boolean,
  searchCalls: number,
  error: string,
  started: number,
): RedactAttempt {
  return {
    saveOptions,
    applyRedactionsArgs: 'not reached',
    blackBoxes: false,
    searchCalls,
    hitsFound: 0,
    boxes: [],
    annotationsCreated: 0,
    beforeCanBeSavedIncrementally: before,
    afterCanBeSavedIncrementally: false,
    hasUnsavedChanges: false,
    incrementalProbe: 'not reached',
    incrementalProbeBytes: null,
    incrementalProbeOutput: null,
    bytes: null,
    error,
    elapsedMs: Math.round(performance.now() - started),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export interface IncrementalResave {
  readonly canBeSavedIncrementally: boolean;
  readonly bytes: Uint8Array | null;
  readonly error: string | null;
}

/**
 * The ordinary "save again" path on a file that was already written: reopen the
 * exported bytes, stamp the producer line (product policy, `PLAN.md §2.1/6`) and
 * ask for an incremental write.
 */
export function incrementalResave(mupdf: Mupdf, input: Uint8Array, producerLine: string): IncrementalResave {
  const doc = openPdf(mupdf, input);
  const canBeSavedIncrementally = doc.canBeSavedIncrementally();
  doc.setMetaData(mupdf.Document.META_INFO_PRODUCER, producerLine);
  const { bytes, error } = trySavePdf(doc, 'incremental');
  doc.destroy();
  return { canBeSavedIncrementally, bytes, error };
}

/** `saveToBuffer` without redaction — the control that shows what cleanup alone does. */
export function saveWithoutRedaction(
  mupdf: Mupdf,
  input: Uint8Array,
  saveOptions: string,
): { bytes: Uint8Array | null; error: string | null } {
  const doc = openPdf(mupdf, input);
  const result = {
    bytes: null as Uint8Array | null,
    error: null as string | null,
  };
  try {
    result.bytes = savePdf(doc, saveOptions);
  } catch (error) {
    result.error = message(error);
  }
  doc.destroy();
  return result;
}
