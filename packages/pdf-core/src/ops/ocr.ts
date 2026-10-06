/**
 * OCR.
 *
 * Two source defects are closed here by construction:
 *  - the DPI the UI offers is the DPI the engine gets (the UI
 *    offered 120–400 while the core silently rejected >300);
 *  - rotation is applied **once**: the render uses the page's own rotation and
 *    the text layer is written in unrotated page space, so a rotated scan does
 *    not end up with a rotated text layer.
 *
 * The invisible layer is written with MuPDF (`writeOcrLayer`): the embedded Noto Sans
 * is an Identity-H font with a `/ToUnicode` CMap (`engines/mupdf-write.ts`), so the
 * words are selectable and searchable while the rendering stays invisible (an
 * `/ExtGState` with `ca 0`). One page's words are one new content stream.
 *
 * **Rotation, the single decision worth spelling out.** A scan of a landscape
 * sheet is usually stored rotated, i.e. the page has `/Rotate 90` and the content
 * stream is in an upright-but-different frame. Two things must then be true at
 * once: the bitmap handed to tesseract must be the way the user sees the page
 * (otherwise OCR reads sideways text), and the text layer must land where the
 * user sees the words. This file therefore:
 *
 *  1. renders through `page.getViewport({ scale })`, which includes `/Rotate`, so
 *     tesseract sees an upright image;
 *  2. maps every box back with the **unit** viewport of the same page,
 *     `convertToPdfPoint()` — the inverse of that same transform, so the rotation
 *     cancel out exactly once and the writing happens in unrotated PDF user space;
 *  3. derives the glyph direction from the two mapped corners, so a rotated page's
 *     layer is drawn rotated by the same angle and the viewer's own `/Rotate`
 *     application puts it back on top of the words.
 *
 * Measured on the pinned toolchain (spike #3 and the MuPDF probe): `search()` and
 * `toStructuredText()` report MuPDF page space, the viewer's canvas is that space
 * times the render scale, and `convertToPdfPoint` inverts it without a y-flip
 * appearing anywhere in this file.
 */

import { ToolError } from 'pdf-shared';
import type { PDFPageProxy } from 'pdfjs-dist';
import { mapMupdfError } from '../engines/mupdf';
import {
  addPageResource,
  appendPageContent,
  embedNotoSans,
  pdfNumber as num,
  openForWrite,
  pageObjects,
  saveRewrite,
} from '../engines/mupdf-write';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import {
  isOcrLanguageAvailable,
  type OcrWord,
  recognizePage,
  terminateOcrWorkers,
} from '../engines/tesseract';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

export type OcrQuality = 'fast' | 'best';

/** Language packs that ship pinned; more can be added without code changes. */
export const OCR_LANGUAGES = ['tur', 'eng'] as const;
export type OcrLanguage = (typeof OCR_LANGUAGES)[number];

export interface OcrOptions {
  readonly pages: readonly number[];
  readonly languages: readonly OcrLanguage[];
  readonly quality: OcrQuality;
  /** 150–300; values outside the range are rejected, never silently clamped. */
  readonly dpi: number;
  /** What to do on pages that already carry text. */
  readonly existingText: 'skip' | 'overwrite';
}

export interface OcrPageResult {
  readonly pageIndex: number;
  readonly words: number;
  readonly confidence: number;
  readonly skipped: boolean;
}

export interface OcrOutcome extends OperationOutcome {
  readonly pages: readonly OcrPageResult[];
}

/**
 * The documented working range of the pinned cores: below 150
 * the LSTM loses small glyphs, above 300 the render cost explodes with no measured
 * accuracy gain. Outside the range the operation **fails** — the source tool quietly
 * clamped values and produced text that did not match the page.
 */
const MIN_DPI = 150;
const MAX_DPI = 300;

/** Tesseract confidence is 0–100; below this the page carries a report warning. */
const LOW_CONFIDENCE = 60;

const MIN_WORD_SIZE = 1;
const MIN_SQUEEZE = 10;
const MAX_SQUEEZE = 1000;

export async function ocrDocument(
  bytes: Uint8Array,
  options: OcrOptions,
  context: OperationContext,
): Promise<OcrOutcome> {
  throwIfAborted(context.signal);
  if (!Number.isFinite(options.dpi) || options.dpi < MIN_DPI || options.dpi > MAX_DPI) {
    throw new ToolError('range-invalid', {
      engine: 'tesseract',
      engineMessage: `dpi ${options.dpi} outside the supported ${MIN_DPI}-${MAX_DPI} range`,
    });
  }
  if (options.languages.length === 0) {
    throw new ToolError('unsupported', {
      engine: 'tesseract',
      engineMessage: 'no OCR language selected',
    });
  }
  // Argument checks come before the availability probe: a user who selected nothing
  // must hear "select a page", not "the language pack is missing".
  if (options.pages.length === 0) {
    throw new ToolError('selection-empty', { engine: 'tesseract', engineMessage: 'no page selected' });
  }
  for (const language of options.languages) {
    if (!(await isOcrLanguageAvailable(language, options.quality))) {
      throw new ToolError('ocr-language-missing', {
        engine: 'tesseract',
        engineMessage: `${language} (${options.quality}) is not available at its pinned path`,
      });
    }
  }
  throwIfAborted(context.signal);

  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  try {
    const pageCount = handle.pageCount;
    const targets = [...new Set(options.pages)].sort((a, b) => a - b);
    for (const pageIndex of targets) {
      if (pageIndex < 0 || pageIndex >= pageCount) {
        throw new ToolError('range-invalid', {
          engine: 'tesseract',
          pageIndex,
          engineMessage: `page index ${pageIndex} outside 0..${pageCount - 1}`,
        });
      }
    }

    const scale = options.dpi / 72;

    const results: OcrPageResult[] = [];
    const layers: OcrLayerPage[] = [];
    let totalWords = 0;
    let skipped = 0;
    let alreadyTextual = 0;
    for (const [position, pageIndex] of targets.entries()) {
      throwIfAborted(context.signal);
      context.onProgress?.({ phase: 'ocr', labelKey: 'ocr.running', done: position, total: targets.length });

      const existingText = await handle.getPageText(pageIndex);
      if (options.existingText === 'skip' && existingText.length > 0) {
        skipped += 1;
        results.push({ pageIndex, words: 0, confidence: 0, skipped: true });
        continue;
      }
      if (existingText.length > 0) alreadyTextual += 1;

      const rawPage = await handle.raw.getPage(pageIndex + 1);
      const image = await renderPageImage(rawPage, scale, context.signal);
      const recognized = await recognizePage({
        image,
        scale,
        languages: options.languages,
        quality: options.quality,
        signal: context.signal,
        onProgress: (fraction) => {
          context.onProgress?.({
            phase: 'ocr',
            labelKey: 'ocr.running',
            done: position + fraction,
            total: targets.length,
          });
        },
      });
      throwIfAborted(context.signal);

      // The unit viewport is the inverse map used for every word on this page; it is
      // built once because building it per word would re-parse the rotation each time.
      const viewport = rawPage.getViewport({ scale: 1 });
      layers.push({
        pageIndex,
        words: recognized.words,
        toPdfPoint: (x, y) => viewport.convertToPdfPoint(x, y) as [number, number],
      });

      totalWords += recognized.words.length;
      results.push({
        pageIndex,
        words: recognized.words.length,
        confidence: recognized.confidence,
        skipped: false,
      });
      context.onProgress?.({
        phase: 'ocr',
        labelKey: 'ocr.running',
        done: position + 1,
        total: targets.length,
      });
    }

    if (totalWords === 0 && skipped === 0) {
      throw new ToolError('unsupported', {
        engine: 'tesseract',
        engineMessage: 'no words recognized on the selected pages',
      });
    }

    context.onProgress?.({ phase: 'ocr', labelKey: 'op.progress.ocr.save', done: 0, total: 1 });
    const produced = await writeOcrLayer(bytes, layers, context);
    context.onProgress?.({ phase: 'ocr', labelKey: 'op.progress.ocr.save', done: 1, total: 1 });

    const low = results.filter(
      (page) => !page.skipped && page.confidence > 0 && page.confidence < LOW_CONFIDENCE,
    );
    return {
      bytes: produced,
      pages: results,
      report: {
        engine: 'tesseract',
        steps: ['render', 'ocr', 'ocr.layer', 'save'],
        notes: [
          note('changed', 'op.note.ocr.layerAdded', {
            pages: results.length - skipped,
            words: totalWords,
            dpi: options.dpi,
          }),
          ...(skipped > 0 ? [note('warning', 'op.note.ocr.skippedPages', { count: skipped })] : []),
          ...(options.existingText === 'overwrite' && alreadyTextual > 0
            ? [note('warning', 'op.note.ocr.overwriteIsAdditive', { count: alreadyTextual })]
            : []),
          ...low.map((page) =>
            note('warning', 'op.note.ocr.lowConfidence', {
              page: page.pageIndex + 1,
              confidence: Math.round(page.confidence),
            }),
          ),
          note('preserved', 'op.note.ocr.hiddenLayer'),
        ],
        inputBytes: bytes.byteLength,
        outputBytes: produced.byteLength,
        // The file is re-serialised: the incremental fast path ends here.
        incremental: false,
        pageCount,
      },
    };
  } finally {
    // pdf.js and the OCR worker both hold wasm heaps; releasing them here keeps the
    // operation accountable for what it allocated.
    await handle.destroy().catch(() => undefined);
    await terminateOcrWorkers();
  }
}

/** Pages whose text layer is empty — what the OCR dialog pre-selects and reports. */
export async function detectScannedPages(
  bytes: Uint8Array,
  context: OperationContext,
): Promise<readonly number[]> {
  throwIfAborted(context.signal);
  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  try {
    const pages: number[] = [];
    for (let pageIndex = 0; pageIndex < handle.pageCount; pageIndex += 1) {
      throwIfAborted(context.signal);
      context.onProgress?.({
        phase: 'detect',
        labelKey: 'op.progress.ocr.detect',
        done: pageIndex,
        total: handle.pageCount,
      });
      // `getPageText` already collapses whitespace and trims, so a page carrying a
      // single stray space still counts as scanned — which is the honest answer for
      // an image-only page whose producer wrote an empty content stream.
      const text = await handle.getPageText(pageIndex);
      if (text.length === 0) pages.push(pageIndex);
    }
    context.onProgress?.({
      phase: 'detect',
      labelKey: 'op.progress.ocr.detect',
      done: handle.pageCount,
      total: handle.pageCount,
    });
    return pages;
  } finally {
    await handle.destroy().catch(() => undefined);
  }
}

/**
 * Render one page to a PNG blob at `scale` pixels per point.
 *
 * The canvas is created here rather than through `PdfDocumentHandle.renderPage`
 * because that helper also writes `canvas.style`, which an `OffscreenCanvas` does
 * not have; the raw page proxy is the supported escape hatch for exactly this
 * (`pdfjs-handle.ts`).
 */
async function renderPageImage(page: PDFPageProxy, scale: number, signal: AbortSignal): Promise<Blob> {
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  // pdf.js answers a 2D context from either canvas type, but its `RenderParameters`
  // type names HTMLCanvasElement only, so the offscreen instance is kept in its own
  // local and cast once, at the boundary where pdf.js takes it.
  const offscreen = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(width, height);
  const canvas = (offscreen ?? createDomCanvas(width, height)) as unknown as HTMLCanvasElement;

  const task = page.render({ canvas, viewport });
  const onAbort = () => task.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await task.promise;
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw new ToolError('internal', {
      engine: 'pdfjs',
      pageIndex: page.pageNumber - 1,
      engineMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  throwIfAborted(signal);

  if (offscreen !== null) {
    return offscreen.convertToBlob({ type: 'image/png' });
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(
          new ToolError('internal', { engine: 'pdfjs', engineMessage: 'canvas.toBlob produced no blob' }),
        );
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

function createDomCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function abortError(): Error {
  const error = new Error('OCR aborted');
  error.name = 'AbortError';
  return error;
}

/** One page's recognized words and the map from rendered pixels to PDF user space. */
export interface OcrLayerPage {
  readonly pageIndex: number;
  readonly words: readonly OcrWord[];
  /** The unit viewport's inverse (`PageViewport.convertToPdfPoint`), `/Rotate` included. */
  readonly toPdfPoint: (x: number, y: number) => readonly [number, number];
}

/**
 * Write every recognized word as invisible, selectable text: one content stream per
 * page, each word its own text object with the font size of its box height, `Tz`
 * squeezing its advance to the box width, and a text matrix turned by the direction
 * of the box's bottom edge — which is what puts a rotated page's layer back on top of
 * the words once the viewer applies `/Rotate`.
 */
export async function writeOcrLayer(
  bytes: Uint8Array,
  layers: readonly OcrLayerPage[],
  context: OperationContext,
): Promise<Uint8Array> {
  const { mupdf, doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    const font = await embedNotoSans(mupdf, doc);
    for (const layer of layers) {
      throwIfAborted(context.signal);
      if (layer.words.length === 0) continue;
      const page = pages[layer.pageIndex];
      if (page === undefined) {
        throw new ToolError('range-invalid', {
          engine: 'mupdf',
          pageIndex: layer.pageIndex,
          engineMessage: `page ${layer.pageIndex} missing from the document`,
        });
      }
      const fontKey = addPageResource(doc, page, 'Font', 'OcrFont', font.ref);
      const invisible = addPageResource(
        doc,
        page,
        'ExtGState',
        'OcrLayer',
        doc.addObject({ Type: 'ExtGState', ca: 0, CA: 0 }),
      );
      const operators: string[] = [];
      for (const word of layer.words) {
        // Baseline anchor: tesseract reports a word's **bounding box**, so the bottom
        // edge is the closest available stand-in for the baseline (its `Line.baseline`
        // belongs to the line, not the word, and the frozen `OcrWord` shape carries no
        // per-word baseline).
        const start = layer.toPdfPoint(word.x0, word.y1);
        const end = layer.toPdfPoint(word.x1, word.y1);
        const radians = Math.atan2(end[1] - start[1], end[0] - start[0]);
        const size = Math.max(MIN_WORD_SIZE, word.y1 - word.y0);
        const natural = font.widthOfTextAtSize(word.text, size);
        const target = word.x1 - word.x0;
        // Squeeze the run to the measured box width: the glyph height stays the box
        // height, only the horizontal advance is scaled, which is what keeps a word
        // selection aligned with the pixels underneath instead of overflowing the cell.
        const squeeze = clamp(
          natural > 0 && target > 0 ? (target / natural) * 100 : 100,
          MIN_SQUEEZE,
          MAX_SQUEEZE,
        );
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        operators.push(
          `q /${invisible} gs BT /${fontKey} ${num(size)} Tf ${num(squeeze)} Tz`,
          `${[cos, sin, -sin, cos, start[0], start[1]].map(num).join(' ')} Tm ${font.encode(word.text)} Tj ET Q`,
        );
      }
      appendPageContent(doc, page, operators.join('\n'));
    }
    return saveRewrite(doc, 'ocr.layer');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'ocr.layer');
  } finally {
    doc.destroy();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
