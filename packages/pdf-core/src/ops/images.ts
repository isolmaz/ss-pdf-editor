/**
 * Images in and out.
 *
 * EXIF orientation is honoured (parsed from the JPEG APP1 segment by hand — no
 * dependency), the fit mode is selectable instead of a fixed 1 pt/px, and the
 * conversion is cancellable with progress. A page too large to export fails with a
 * message that names the limit, the offending page and a workable DPI.
 *
 * What the hand-written EXIF reader covers, and what it does not — the limits are
 * part of the contract, because a silently ignored orientation is exactly the
 * defect being fixed:
 *  - it reads tag 274 out of the **first APP1 segment whose payload starts with
 *    `Exif\0\0`** and stops there: a second EXIF segment, a packet spread over
 *    several segments (>64 KB) or an orientation inside a sub-IFD is not read;
 *  - PNG `eXIf` chunks are not read at all (only JPEG carries EXIF here), and
 *    PNG has no orientation in the format's main chunks;
 *  - every malformed input (truncated segment, unknown byte order, missing IFD,
 *    a value outside 1…8) degrades to "normal" instead of throwing: a broken
 *    metadata block must not stop a user's image from landing on a page;
 *  - all eight orientations, the mirroring ones (2, 4, 5, 7) included, are one
 *    unit-square matrix each (`ORIENTATION_MATRIX`), drawn into the footprint the
 *    displayed picture occupies;
 *  - the embedded JPEG's own tag is then set to 1 (`neutraliseOrientation`): a PDF
 *    image has no orientation, pdf.js and Acrobat ignore the tag, but MuPDF-based
 *    readers apply it — and would turn an already upright picture a second time;
 *  - JFIF/EXIF resolution tags are deliberately not read: `pageSize: 'fit'` is
 *    defined as the pixel size at 72 dpi.
 */

import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError } from '../engines/mupdf';
import { saveRewrite } from '../engines/mupdf-write';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OutputFile,
  throwIfAborted,
} from './types';

export type ImageFit = 'contain' | 'cover' | 'stretch';

export interface ImagesToPdfOptions {
  readonly images: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  /** `fit` uses each image's own pixel size at 72 dpi. */
  readonly pageSize: 'fit' | 'a4' | 'letter';
  readonly fit: ImageFit;
  readonly marginMm: number;
  /** EXIF orientation tag 274 is applied unless this is false. */
  readonly applyExif: boolean;
  /**
   * With `pageSize: 'fit'`, scale every page so its long side is this many points (the
   * aspect ratio stays the image's). Without it a page is the image's pixel size in
   * points, which makes a 12-megapixel photograph a page of several metres.
   */
  readonly fitLongSidePt?: number;
}

export async function imagesToPdf(
  options: ImagesToPdfOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  if (options.images.length === 0) {
    throw new ToolError('input-missing', { engine: 'model', engineMessage: 'no images were handed in' });
  }
  const margin = marginPoints(options.marginMm);
  const mupdf = await loadMupdf();
  const document = new mupdf.PDFDocument();
  const notes: OperationNote[] = [];
  let embedded = 0;
  let oriented = 0;
  let inputBytes = 0;
  let bytes: Uint8Array;

  try {
    for (const [index, image] of options.images.entries()) {
      throwIfAborted(context.signal);
      inputBytes += image.bytes.length;
      context.onProgress?.({
        phase: 'embed',
        labelKey: 'op.progress.images.embed',
        done: index,
        total: options.images.length,
      });

      const format = sniffImage(image.bytes);
      if (format === null) {
        notes.push(note('warning', 'op.note.images.unsupported', { name: image.name }));
        continue;
      }
      const exif = format === 'jpeg' ? readExifOrientation(image.bytes) : null;
      const orientation = options.applyExif && exif !== null ? exif.value : 1;

      let picture: {
        readonly ref: import('mupdf').PDFObject;
        readonly width: number;
        readonly height: number;
      };
      try {
        // A disposable copy, with the orientation tag neutralised (file header).
        const copy = exif === null ? image.bytes.slice() : neutraliseOrientation(image.bytes, exif);
        const decoded = new mupdf.Image(copy);
        try {
          picture = {
            ref: document.addImage(decoded),
            width: decoded.getWidth(),
            height: decoded.getHeight(),
          };
        } finally {
          decoded.destroy();
        }
      } catch {
        // Documented skip, and the deliberate contract of this operation: one
        // unreadable image is reported as a warning and the rest of the batch is
        // still embedded. A file that passes the signature check and still fails is
        // damaged, not "unsupported", hence the separate note.
        notes.push(note('warning', 'op.note.images.failed', { name: image.name }));
        continue;
      }

      const [pageWidth, pageHeight] = pageSizeFor(
        options.pageSize,
        picture,
        orientation,
        options.fitLongSidePt,
      );
      const box = drawBox(pageWidth, pageHeight, margin);
      const footprint = placeImage(picture, orientation, box, options.fit);
      const operators = paintOperators(footprint, orientation, options.fit === 'cover' ? box : null);
      const page = document.addPage(
        [0, 0, pageWidth, pageHeight],
        0,
        { XObject: { Im0: picture.ref } },
        operators,
      );
      document.insertPage(document.countPages(), page);
      embedded += 1;
      if (orientation !== 1) oriented += 1;
    }

    if (embedded === 0) {
      throw new ToolError('unsupported-format', {
        engine: 'mupdf',
        engineMessage: `${options.images.length} image(s) handed in, none embeddable (PNG and JPEG only)`,
      });
    }
    if (oriented > 0) notes.push(note('changed', 'op.note.images.exif', { count: oriented }));
    bytes = saveRewrite(document, 'imagesToPdf');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'imagesToPdf');
  } finally {
    document.destroy();
  }

  return {
    bytes,
    report: {
      engine: 'mupdf',
      steps: ['images.create', 'images.embed', 'save'],
      notes,
      inputBytes,
      outputBytes: bytes.length,
      pageCount: embedded,
      // A brand-new file: never an incremental update.
      incremental: false,
    },
  };
}

export type ImageExportFormat = 'png' | 'jpeg' | 'webp';

export interface ImageExportOptions {
  readonly pages: readonly number[];
  readonly format: ImageExportFormat;
  readonly dpi: number;
  /** `baseName` is expanded with `-NNN` and the format's extension. */
  readonly baseName: string;
  /** Megapixel ceiling per page (the 16 MP budget). */
  readonly maxMegapixels: number;
}

/** One file per page; a page that would exceed the megapixel budget raises `file-too-large`. */
export async function exportImages(
  bytes: Uint8Array,
  options: ImageExportOptions,
  context: OperationContext,
): Promise<{ readonly files: readonly OutputFile[]; readonly pageCount: number }> {
  throwIfAborted(context.signal);
  if (options.pages.length === 0) {
    throw new ToolError('selection-empty', { engine: 'model', engineMessage: 'no page was selected' });
  }
  if (!Number.isFinite(options.maxMegapixels) || options.maxMegapixels <= 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `megapixel budget ${options.maxMegapixels} is not a positive number`,
    });
  }
  if (!Number.isFinite(options.dpi) || options.dpi <= 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `resolution ${options.dpi} DPI is not a positive number`,
    });
  }

  // The document is opened once: rendering needs a live pdf.js document, and the
  // same handle keeps every page's viewport and rotation consistent.
  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  let canvas: HTMLCanvasElement | null = null;
  try {
    for (const pageIndex of options.pages) {
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= handle.pageCount) {
        throw new ToolError('range-invalid', {
          engine: 'model',
          engineMessage: `page ${pageIndex + 1} is outside the ${handle.pageCount}-page document`,
        });
      }
    }

    const files: OutputFile[] = [];
    const scale = options.dpi / 72;
    for (const [sequence, pageIndex] of options.pages.entries()) {
      throwIfAborted(context.signal);
      context.onProgress?.({
        phase: 'render',
        labelKey: 'op.progress.images.render',
        done: sequence,
        total: options.pages.length,
      });

      // The page's own rotation is already in the viewport, so the exported image
      // is the page as the user sees it.
      const points = await handle.getPageSize(pageIndex, 1);
      const width = Math.max(1, Math.floor(points.width * scale));
      const height = Math.max(1, Math.floor(points.height * scale));
      const megapixels = (width * height) / 1_000_000;
      if (megapixels > options.maxMegapixels) {
        // The caller can act on this: `pageIndex` names the failing page, and the
        // largest DPI that still fits the budget follows from the same page size,
        // so the UI can offer "try {suggested} DPI".
        const maxScale = Math.sqrt((options.maxMegapixels * 1_000_000) / (points.width * points.height));
        const suggestedDpi = Math.max(1, Math.floor(maxScale * 72));
        throw new ToolError('file-too-large', {
          engine: 'pdfjs',
          pageIndex,
          engineMessage:
            `page ${pageIndex + 1} at ${options.dpi} DPI is ${width}x${height} px = ${megapixels.toFixed(1)} MP, ` +
            `over the ${options.maxMegapixels} MP budget; the largest DPI that fits is ${suggestedDpi}`,
        });
      }

      canvas ??= document.createElement('canvas');
      // The adapter sizes the canvas from the viewport; the device pixel ratio
      // stays 1 because the DPI alone decides the pixel size.
      await handle.renderPage(pageIndex, canvas, {
        scale,
        devicePixelRatio: 1,
        signal: context.signal,
      });
      files.push({
        name: imageFileName(options.baseName, sequence, options.pages.length, options.format),
        bytes: await encodeCanvas(canvas, options.format),
        mime: MIME_BY_FORMAT[options.format],
      });
    }
    return { files, pageCount: handle.pageCount };
  } finally {
    if (canvas !== null) {
      // Release the backstore right away: a 16 MP page is a 64 MB canvas.
      canvas.width = 0;
      canvas.height = 0;
    }
    await handle.destroy();
  }
}

const MM_TO_PT = 72 / 25.4;

const PAGE_SIZES: Record<'a4' | 'letter', readonly [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

const MIME_BY_FORMAT: Record<ImageExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * EXIF orientation → where the stored picture's unit square lands in the displayed one.
 * `[a, b, c, d, e, f]` maps a stored point `(u, v)` (PDF image space: `u` right, `v` up,
 * `v = 1` the stored top row) to the displayed `(a·u + c·v + e, b·u + d·v + f)`. Each row
 * is the tag's own definition — which displayed edge the stored row 0 and column 0 become:
 *
 *   1 row 0 top, column 0 left      5 row 0 left, column 0 top
 *   2 row 0 top, column 0 right     6 row 0 right, column 0 top      (turn 90° clockwise)
 *   3 row 0 bottom, column 0 right  7 row 0 right, column 0 bottom
 *   4 row 0 bottom, column 0 left   8 row 0 left, column 0 bottom    (turn 90° anticlockwise)
 *
 * Tag 6 is a clockwise quarter-turn and tag 8 an anticlockwise one; reading them as
 * rotations of +90° and +270° (anticlockwise-positive in PDF space) would turn an
 * orientation 6 photo upside down.
 */
type OrientationMatrix = readonly [number, number, number, number, number, number];

const ORIENTATION_MATRIX: Readonly<Record<number, OrientationMatrix>> = {
  1: [1, 0, 0, 1, 0, 0],
  2: [-1, 0, 0, 1, 1, 0],
  3: [-1, 0, 0, -1, 1, 1],
  4: [1, 0, 0, -1, 0, 1],
  5: [0, -1, -1, 0, 1, 1],
  6: [0, -1, 1, 0, 0, 1],
  7: [0, 1, 1, 0, 0, 0],
  8: [0, 1, -1, 0, 1, 0],
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const EXIF_MAGIC = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
const TIFF_ORIENTATION_TAG = 0x0112;
const TIFF_SHORT = 3;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return 'png';
  return null;
}

function marginPoints(marginMm: number): number {
  if (!Number.isFinite(marginMm) || marginMm < 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `margin ${marginMm} mm is not a positive length`,
    });
  }
  return marginMm * MM_TO_PT;
}

function drawBox(pageWidth: number, pageHeight: number, margin: number): Box {
  const width = pageWidth - margin * 2;
  const height = pageHeight - margin * 2;
  if (width <= 0 || height <= 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `a margin of ${margin} pt leaves no drawing area on a ${pageWidth}x${pageHeight} pt page`,
    });
  }
  return { x: margin, y: margin, width, height };
}

/** `fit` = the pixel size at 72 dpi, so one pixel is one point. */
function pageSizeFor(
  size: ImagesToPdfOptions['pageSize'],
  picture: { readonly width: number; readonly height: number },
  orientation: number,
  longSidePt?: number,
): readonly [number, number] {
  if (size === 'fit') {
    const [width, height] = displaySize(picture.width, picture.height, orientation);
    if (longSidePt === undefined) return [width, height];
    const factor = longSidePt / Math.max(width, height);
    return [width * factor, height * factor];
  }
  return PAGE_SIZES[size];
}

/** Orientations 5…8 turn a portrait stored image into a landscape page. */
function displaySize(pixelWidth: number, pixelHeight: number, orientation: number): [number, number] {
  return orientation >= 5 && orientation <= 8 ? [pixelHeight, pixelWidth] : [pixelWidth, pixelHeight];
}

/**
 * The footprint of one image on one page: the axis-aligned box the **displayed**
 * picture occupies, centred inside the drawing area. `stretch` fills the area;
 * `contain` and `cover` keep the displayed aspect ratio.
 */
function placeImage(
  picture: { readonly width: number; readonly height: number },
  orientation: number,
  box: Box,
  fit: ImageFit,
): Box {
  if (fit === 'stretch') return box;
  const [displayWidth, displayHeight] = displaySize(picture.width, picture.height, orientation);
  const scale =
    fit === 'cover'
      ? Math.max(box.width / displayWidth, box.height / displayHeight)
      : Math.min(box.width / displayWidth, box.height / displayHeight);
  const width = displayWidth * scale;
  const height = displayHeight * scale;
  return { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
}

/** A content-stream number: four decimals at most, no trailing zeros. */
function num(value: number): string {
  // `Number` drops the trailing zeros, and the sign of a negative zero (`-0.0000`).
  return Number(value.toFixed(4)).toString();
}

/**
 * The page's content: the image's unit square through the orientation matrix, scaled
 * into the footprint. `cover` deliberately spills outside the drawing area, so it is
 * clipped to it first.
 */
function paintOperators(footprint: Box, orientation: number, clip: Box | null): string {
  // The orientation is 1 … 8 (`orientationFromTiff` admits nothing else, and the default is 1).
  const [a, b, c, d, e, f] = ORIENTATION_MATRIX[orientation] as OrientationMatrix;
  const { x, y, width, height } = footprint;
  const matrix = [a * width, b * height, c * width, d * height, e * width + x, f * height + y];
  const operators = ['q'];
  if (clip !== null) operators.push(`${[clip.x, clip.y, clip.width, clip.height].map(num).join(' ')} re W n`);
  operators.push(`${matrix.map(num).join(' ')} cm`, '/Im0 Do', 'Q');
  return operators.join('\n');
}

/** `baseName-NNN.ext`: never fewer than three digits, wider for long documents. */
function imageFileName(baseName: string, index: number, total: number, format: ImageExportFormat): string {
  const stem = baseName.replace(/\.pdf$/i, '');
  const width = Math.max(3, String(total).length);
  return `${stem}-${String(index + 1).padStart(width, '0')}.${format === 'jpeg' ? 'jpg' : format}`;
}

/**
 * Encode a rendered page. No quality argument is passed: `ImageExportOptions` has
 * none, so the browser default is the only value we can honestly claim.
 */
async function encodeCanvas(canvas: HTMLCanvasElement, format: ImageExportFormat): Promise<Uint8Array> {
  const mime = MIME_BY_FORMAT[format];
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime));
  if (blob === null) {
    throw new ToolError('internal', { engine: 'pdfjs', engineMessage: 'the canvas could not be encoded' });
  }
  if (blob.type !== mime) {
    // `toBlob` silently falls back to PNG for a type the browser cannot write,
    // which would hand the user PNG bytes under a `.webp` name.
    throw new ToolError('unsupported-format', {
      engine: 'pdfjs',
      engineMessage: `this browser encoded ${blob.type} instead of ${mime}`,
    });
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/** Where an EXIF orientation value sits, and the byte order it is written in. */
interface ExifOrientation {
  readonly value: number;
  readonly at: number;
  readonly littleEndian: boolean;
}

/**
 * EXIF orientation (tag 274) of a JPEG and the byte offset of its value, or `null` when
 * there is nothing to read. A metadata block must never be the reason an image fails to
 * be embedded, so every unrecognised byte pattern answers `null` (the neutral value).
 */
function readExifOrientation(bytes: Uint8Array): ExifOrientation | null {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    // The loop condition keeps `offset + 3` inside the file, so these reads are in bounds.
    const marker = bytes[offset + 1] as number;
    // Start of scan / end of image: everything from here on is entropy-coded
    // data, so no metadata segment can follow.
    if (marker === 0xda || marker === 0xd9) return null;
    // Fill bytes and the segment-less markers (TEM, RSTn, SOI) carry no length.
    // A marker may be preceded by any number of `0xFF` fill bytes: skip one, and the next byte is read
    // as the marker (`FF FF E1` is a fill byte and then APP1).
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (marker === 0xe1 && hasExifMagic(bytes, offset + 4)) {
      return orientationFromTiff(bytes, offset + 10, offset + 2 + length);
    }
    offset += 2 + length;
  }
  return null;
}

function hasExifMagic(bytes: Uint8Array, at: number): boolean {
  return EXIF_MAGIC.every((byte, index) => bytes[at + index] === byte);
}

/** TIFF header + IFD0 of an `Exif\0\0` payload, bounded by the segment end. */
function orientationFromTiff(bytes: Uint8Array, start: number, end: number): ExifOrientation | null {
  if (start + 8 > end) return null;
  const littleEndian = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  const bigEndian = bytes[start] === 0x4d && bytes[start + 1] === 0x4d;
  if (!littleEndian && !bigEndian) return null;

  // Every read below is bounded by `end`, which is inside the file, so none can throw.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number): number => view.getUint16(at, littleEndian);
  const u32 = (at: number): number => view.getUint32(at, littleEndian);

  if (u16(start + 2) !== 0x002a) return null;
  const directory = start + u32(start + 4);
  if (directory + 2 > end) return null;
  const entries = u16(directory);
  for (let index = 0; index < entries; index += 1) {
    const entry = directory + 2 + index * 12;
    if (entry + 12 > end) return null;
    if (u16(entry) !== TIFF_ORIENTATION_TAG) continue;
    // Orientation is a single SHORT; anything else in that slot is not a spec
    // orientation, so the neutral value is the honest answer.
    if (u16(entry + 2) !== TIFF_SHORT || u32(entry + 4) !== 1) return null;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? { value, at: entry + 8, littleEndian } : null;
  }
  return null;
}

/**
 * A copy of the JPEG whose orientation value reads 1: a SHORT in the byte order the TIFF
 * header named.
 */
function neutraliseOrientation(bytes: Uint8Array, exif: ExifOrientation): Uint8Array {
  const copy = bytes.slice();
  copy[exif.at] = exif.littleEndian ? 1 : 0;
  copy[exif.at + 1] = exif.littleEndian ? 0 : 1;
  return copy;
}
