/**
 * Optimisation (defects 3 and 16).
 *
 * Two modes, and the report says plainly which one ran:
 *  - `structure` — a MuPDF rewrite that drops unused and duplicate objects, compresses
 *    streams, fonts and images losslessly and packs objects into object streams,
 *    optionally dropping Info metadata;
 *  - `raster` — every selected page is rendered and replaced by an image of itself,
 *    which is lossy and therefore carries explicit `lost` notes.
 *
 * The source project reported `gained: false` while writing a **larger** file;
 * here the size delta is measured and a growth is stated as
 * such — never presented as a win.
 *
 * Engine facts this file depends on:
 *  - the structure rewrite leaves form-field appearances as they are: MuPDF does not
 *    regenerate them on save (the pdf-lib writer did, and warned about it);
 *  - a rasterised page is replaced **in place** (`assembleRaster`): the page object
 *    keeps its place in the page tree, so the pages that were not selected, the
 *    outline and every other catalog entry stay exactly as they were. The page's own
 *    annotations go with its old content — the render already painted them;
 *  - pdf.js's render contract takes an `HTMLCanvasElement` (the adapter sets
 *    `canvas.style`), so raster mode renders on the main thread; an `OffscreenCanvas`
 *    path needs a worker contract in the adapter first.
 */

import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  openForWrite,
  pageObjects,
  pdfNumber,
  producerKeptNote,
  resolved,
  saveRewrite,
} from '../engines/mupdf-write';
import { openWithPdfjs, type PdfDocumentHandle } from '../engines/pdfjs-handle';
import {
  formatBytes,
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

export interface StructureCompressOptions {
  readonly mode: 'structure';
  readonly stripMetadata: boolean;
  /** Producer line survives every clean-up. */
  readonly keepProducer: boolean;
}

export interface RasterCompressOptions {
  readonly mode: 'raster';
  readonly pages: readonly number[];
  readonly dpi: number;
  readonly quality: number;
  readonly greyscale: boolean;
}

export type CompressOptions = StructureCompressOptions | RasterCompressOptions;

/** The source project's raster range, kept because it is what the dialog offered. */
const RASTER_DPI = { min: 72, max: 300 };
const RASTER_QUALITY = { min: 0.3, max: 0.95 };

/**
 * The structure rewrite, measured on mupdf 1.28.1: unused objects dropped and
 * duplicates merged, every stream, font and image compressed losslessly, and objects
 * packed into object streams. An unknown option is a hard error in MuPDF, so the string
 * is fixed here rather than assembled.
 */
const STRUCTURE_SAVE_OPTIONS = 'garbage=deduplicate,compress,compress-fonts,compress-images,objstms';

function requireRange(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `${field} must be between ${min} and ${max}`,
    });
  }
  return value;
}

/**
 * Size delta, reported the way the user experiences it: a smaller file is a win,
 * an equal or larger file is stated as such.
 */
function sizeNotes(inputBytes: number, outputBytes: number): OperationNote[] {
  const before = formatBytes(inputBytes);
  const after = formatBytes(outputBytes);
  if (outputBytes > inputBytes) return [note('warning', 'optimize.grew', { before, after })];
  if (outputBytes === inputBytes) return [note('warning', 'optimize.noGain', { before, after })];
  return [
    note('changed', 'optimize.saved', {
      before,
      after,
      percent: Math.round((1 - outputBytes / inputBytes) * 100),
    }),
  ];
}

export async function compressDocument(
  bytes: Uint8Array,
  options: CompressOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  return options.mode === 'structure'
    ? compressStructure(bytes, options, context)
    : compressRaster(bytes, options, context);
}

async function compressStructure(
  bytes: Uint8Array,
  options: StructureCompressOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  if (options.stripMetadata && !options.keepProducer) {
    // The producer line is product policy, not a preference:
    // "strip the metadata but not keep the producer line" is unsatisfiable, and
    // failing loudly beats silently ignoring one of the two halves.
    throw new ToolError('unsupported', {
      engine: 'model',
      engineMessage: 'the producer line cannot be stripped',
    });
  }

  const { doc } = await openForWrite(bytes);
  const notes: OperationNote[] = [];
  const steps: string[] = ['load', 'structure'];
  let out: Uint8Array;
  let pageCount: number;
  try {
    pageCount = doc.countPages();
    if (options.stripMetadata) {
      // Every Info key but the producer line, which `saveRewrite` sets again: "clean
      // metadata" never removes the notice.
      const info = resolved(doc.getTrailer().get('Info'));
      if (info?.isDictionary() === true) {
        const keys: string[] = [];
        info.forEach((_value, key) => {
          if (String(key) !== 'Producer') keys.push(String(key));
        });
        for (const key of keys) info.delete(key);
      }
      steps.push('metadata');
      notes.push(note('lost', 'op.note.compress.infoDropped'));
    } else {
      notes.push(note('preserved', 'op.note.compress.infoKept'));
    }
    notes.push(producerKeptNote());
    notes.push(note('preserved', 'op.note.compress.structureContent'));

    throwIfAborted(context.signal);
    out = saveRewrite(doc, 'compress', STRUCTURE_SAVE_OPTIONS);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'compress');
  } finally {
    doc.destroy();
  }
  steps.push('save');
  notes.push(...sizeNotes(bytes.byteLength, out.byteLength));

  const report: OperationReport = {
    engine: 'mupdf',
    steps,
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: out.byteLength,
    pageCount,
    // Re-serialised: the incremental fast path is over.
    incremental: false,
  };
  return { bytes: out, report };
}

/** One rendered page: its JPEG and the size in points the page keeps. */
export interface RasterPage {
  readonly jpeg: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Replace each listed page, in place, by an image of itself: the page keeps its place
 * in the page tree (outline destinations and links to it still land), and loses its
 * content, resources, annotations and every box but a MediaBox of the rendered size.
 * `/Rotate` becomes 0, because the render already shows the page turned.
 */
export async function assembleRaster(
  bytes: Uint8Array,
  rendered: ReadonlyMap<number, RasterPage>,
  context: OperationContext,
): Promise<{ readonly bytes: Uint8Array; readonly pageCount: number }> {
  const { mupdf, doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    for (const [done, [pageIndex, raster]] of [...rendered].sort((a, b) => a[0] - b[0]).entries()) {
      throwIfAborted(context.signal);
      const page = pages[pageIndex];
      if (page === undefined) throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex });
      let image: import('mupdf').PDFObject;
      try {
        const decoded = new mupdf.Image(raster.jpeg);
        try {
          image = doc.addImage(decoded);
        } finally {
          decoded.destroy();
        }
      } catch (error) {
        throw mapMupdfError(error, 'embed rasterised page');
      }
      for (const key of ['CropBox', 'TrimBox', 'BleedBox', 'ArtBox', 'Annots', 'Group']) {
        page.delete(key);
      }
      page.put('MediaBox', [0, 0, raster.width, raster.height]);
      // Written, not deleted: a /Rotate inherited from a /Pages node would still turn it.
      page.put('Rotate', 0);
      page.put('Resources', { XObject: { Im0: image } });
      const size = `${pdfNumber(raster.width)} 0 0 ${pdfNumber(raster.height)} 0 0`;
      page.put('Contents', doc.addStream(`q ${size} cm /Im0 Do Q`, {}));
      context.onProgress?.({
        phase: 'assemble',
        labelKey: 'op.progress.compress.assemble',
        done: done + 1,
        total: rendered.size,
      });
    }
    return { bytes: saveRewrite(doc, 'compress'), pageCount: pages.length };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'compress');
  } finally {
    doc.destroy();
  }
}

/**
 * One page's pixels as JPEG bytes. `canvas.toDataURL` is used instead of
 * `toBlob`: it keeps the render loop synchronous per page and avoids the
 * promise-executor form the repository's rules keep out of product code. The
 * base64 round trip costs ~1.4x the JPEG size transiently, which is small next to
 * the canvas backstore itself.
 */
function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Uint8Array {
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image/jpeg') || comma < 0) {
    throw new ToolError('internal', { engine: 'pdfjs', engineMessage: 'canvas produced no JPEG data' });
  }
  const binary = atob(dataUrl.slice(comma + 1));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** Rec. 601 luma, in place — the weighting a greyscale printer applies. */
function applyGreyscale(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new ToolError('internal', { engine: 'pdfjs', engineMessage: 'render canvas has no 2d context' });
  }
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  for (let index = 0; index < data.length; index += 4) {
    const luma =
      0.299 * (data[index] as number) +
      0.587 * (data[index + 1] as number) +
      0.114 * (data[index + 2] as number);
    data[index] = luma;
    data[index + 1] = luma;
    data[index + 2] = luma;
  }
  context.putImageData(image, 0, 0);
}

async function compressRaster(
  bytes: Uint8Array,
  options: RasterCompressOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  const dpi = requireRange(options.dpi, RASTER_DPI.min, RASTER_DPI.max, 'dpi');
  const quality = requireRange(options.quality, RASTER_QUALITY.min, RASTER_QUALITY.max, 'quality');
  if (options.pages.length === 0) {
    throw new ToolError('selection-empty', { engine: 'model', engineMessage: 'no pages to compress' });
  }

  const notes: OperationNote[] = [];
  const steps: string[] = ['load', 'render'];
  const scale = dpi / 72;
  const rendered = new Map<number, RasterPage>();
  const baked: number[] = [];
  let pageCount: number;
  const handle: PdfDocumentHandle = await openWithPdfjs(bytes, { signal: context.signal });

  try {
    pageCount = handle.pageCount;
    const selected = new Set<number>();
    for (const page of options.pages) {
      if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) {
        throw new ToolError('range-invalid', {
          engine: 'model',
          engineMessage: 'page index out of bounds',
          pageIndex: page,
        });
      }
      selected.add(page);
    }
    const ordered = [...selected].sort((a, b) => a - b);
    for (const [index, pageIndex] of ordered.entries()) {
      throwIfAborted(context.signal);
      const size = await handle.getPageSize(pageIndex, 1);
      const canvas = document.createElement('canvas');
      try {
        await handle.renderPage(pageIndex, canvas, {
          scale,
          // A HiDPI screen must not inflate the raster: the requested DPI is the contract.
          devicePixelRatio: 1,
          background: '#ffffff',
          signal: context.signal,
        });
        if (options.greyscale) applyGreyscale(canvas);
        rendered.set(pageIndex, {
          jpeg: canvasJpeg(canvas, quality),
          width: Math.round(canvas.width / scale),
          height: Math.round(canvas.height / scale),
        });
      } finally {
        // Release the backstore right away: one page's bitmap at a time.
        canvas.width = 0;
        canvas.height = 0;
      }
      if (size.rotation !== 0) baked.push(pageIndex);
      context.onProgress?.({
        phase: 'render',
        labelKey: 'op.progress.compress.render',
        done: index + 1,
        total: ordered.length,
      });
    }
  } finally {
    // The handle owns a pdf.js worker; leaking it leaks the whole document copy.
    await handle.destroy();
  }

  throwIfAborted(context.signal);
  steps.push('assemble');
  const assembled = await assembleRaster(bytes, rendered, context);
  steps.push('save');

  const untouchedCount = pageCount - rendered.size;
  notes.push(note('lost', 'op.note.compress.rasterized', { count: rendered.size }));
  if (options.greyscale) notes.push(note('changed', 'op.note.compress.greyscale'));
  if (baked.length > 0)
    notes.push(note('changed', 'op.note.compress.rotationBaked', { count: baked.length }));
  if (untouchedCount > 0)
    notes.push(note('preserved', 'op.note.compress.otherPages', { count: untouchedCount }));
  notes.push(note('preserved', 'op.note.compress.infoCopied'));
  notes.push(producerKeptNote());
  notes.push(...sizeNotes(bytes.byteLength, assembled.bytes.byteLength));

  const report: OperationReport = {
    engine: 'pdfjs',
    steps,
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: assembled.bytes.byteLength,
    pageCount: assembled.pageCount,
    // Re-serialised: never incremental.
    incremental: false,
  };
  return { bytes: assembled.bytes, report };
}
