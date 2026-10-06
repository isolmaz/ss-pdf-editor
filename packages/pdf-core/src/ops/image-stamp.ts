/**
 * A picture on the page: a signature someone drew, typed or photographed, initials, or
 * any image the user places.
 *
 * ## Why an annotation, written at once
 *
 * The picture becomes a `/Stamp` annotation whose normal appearance draws the image — the
 * shape every reader shows and prints (the print flag is set), and the one pdf.js's own
 * stamp and signature editors write. It is written into the file the moment it is placed,
 * as one undoable step, rather than held as a session mark: a session mark lives in the
 * journal's JSON, and a photo carried there would be copied into every later journal entry
 * and draft. Once written it is one of the file's own annotations, so the common selection
 * already moves, turns and deletes it (`annotation-transform.ts`, `annotation-remove.ts`),
 * and {@link resizeImageStamp} changes its size.
 *
 * ## Upright on a turned page
 *
 * The caller hands the box as it shows on screen — upright, `width × height` — and the
 * page's own `/Rotate`. On a turned page that box is turned in page space, so `/Rect` takes
 * the swapped extents and the appearance form carries the counter-turn as its `/Matrix`: a
 * reader maps the form's transformed `/BBox` onto `/Rect`, and the picture then reads the
 * way it was placed.
 *
 * ## Resizing
 *
 * A reader scales an appearance to its `/Rect` (ISO 32000-1, 12.5.5, algorithm 8.1), so a
 * new size is a new `/Rect` and nothing else: the image is not re-encoded and the
 * appearance is untouched.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  openForWrite,
  pageObjects,
  pdfDate,
  readName,
  readNumbers,
  resolved,
  saveRewrite,
  text,
  visibleBox,
} from '../engines/mupdf-write';
import { markerFor } from './annotations';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

/** What the picture is; it becomes the stamp's `/Name` and the comment readers list. */
export type ImageStampRole = 'signature' | 'initials' | 'image';

const STAMP_NAMES: Readonly<Record<ImageStampRole, string>> = {
  signature: 'SsSignature',
  initials: 'SsInitials',
  image: 'SsImage',
};

/** The smallest side a stamp may have, in points; a click-sized picture is a mistake. */
export const MIN_STAMP_SIDE = 4;

export interface ImageStampRequest {
  /** Session-unique id; it is the marker in `/Contents`, so the stamp can be found again. */
  readonly id: string;
  readonly pageIndex: number;
  /** Centre of the stamp in app space: unrotated page points, origin top-left, y down. */
  readonly center: { readonly x: number; readonly y: number };
  /** Size as it shows on screen, upright, in points. */
  readonly width: number;
  readonly height: number;
  /** The image file: PNG (alpha kept as a soft mask) or JPEG. */
  readonly image: Uint8Array;
  readonly role: ImageStampRole;
  /** The words a reader lists for the stamp ("Signature"); the marker goes in front. */
  readonly label: string;
  readonly author: string;
}

export interface ImageStampOutcome extends OperationOutcome {
  /** The new annotation's id in pdf.js's spelling (`17R`), for the selection. */
  readonly annotationId: string;
}

type Turn = 0 | 90 | 180 | 270;

/** The counter-turn of a page turned `turn` clockwise, as a PDF (y-up) matrix. */
const COUNTER_TURN: Readonly<Record<Turn, readonly [number, number, number, number, number, number]>> = {
  0: [1, 0, 0, 1, 0, 0],
  90: [0, 1, -1, 0, 0, 0],
  180: [-1, 0, 0, -1, 0, 0],
  270: [0, -1, 1, 0, 0, 0],
};

function pageTurn(page: PDFObject): Turn {
  const value = page.getInheritable('Rotate');
  const raw = value.isNumber() ? value.asNumber() : 0;
  const turn = (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
  return turn as Turn;
}

function sniffFormat(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new ToolError('range-invalid', { engine: 'model', engineMessage: `${name} is not a number` });
  }
  return value;
}

/**
 * Place a picture on a page as a `/Stamp` annotation (see the module header).
 */
export async function addImageStamp(
  bytes: Uint8Array,
  request: ImageStampRequest,
  context: OperationContext,
): Promise<ImageStampOutcome> {
  throwIfAborted(context.signal);
  const width = finite(request.width, 'width');
  const height = finite(request.height, 'height');
  if (width < MIN_STAMP_SIDE || height < MIN_STAMP_SIDE) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `a stamp of ${width}×${height} pt is smaller than ${MIN_STAMP_SIDE} pt`,
    });
  }
  const format = sniffFormat(request.image);
  if (format === null) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      engineMessage: 'a stamp image must be PNG or JPEG',
    });
  }
  const mupdf = await loadMupdf();
  const { doc } = await openForWrite(bytes);
  let saved: Uint8Array;
  let annotationId: string;
  let pageCount: number;
  try {
    try {
      const pages = pageObjects(doc);
      pageCount = pages.length;
      const page = pages[request.pageIndex];
      if (page === undefined) {
        throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex: request.pageIndex });
      }
      const turn = pageTurn(page);
      const box = visibleBox(page);
      const top = box.y + box.height;
      // Extents in unrotated page space: a quarter turn swaps them.
      const [spanX, spanY] = turn === 90 || turn === 270 ? [height, width] : [width, height];
      const cx = finite(request.center.x, 'center.x');
      const cy = top - finite(request.center.y, 'center.y');
      const rect = [cx - spanX / 2, cy - spanY / 2, cx + spanX / 2, cy + spanY / 2];

      const decoded = new mupdf.Image(request.image.slice());
      let imageRef: PDFObject;
      try {
        imageRef = doc.addImage(decoded);
      } finally {
        decoded.destroy();
      }
      const appearance = doc.addStream(`q ${num(width)} 0 0 ${num(height)} 0 0 cm /Im0 Do Q`, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: [0, 0, width, height],
        Matrix: [...COUNTER_TURN[turn]],
        Resources: { XObject: { Im0: imageRef } },
      });
      const now = pdfDate(new Date());
      const label = request.label.trim();
      const dict = doc.addObject({
        Type: 'Annot',
        Subtype: 'Stamp',
        Name: STAMP_NAMES[request.role],
        P: page,
        Rect: rect,
        // Print on; the picture is part of what the page shows.
        F: 4,
        T: text(doc, request.author),
        M: text(doc, now),
        CreationDate: text(doc, now),
        Contents: text(doc, label.length > 0 ? `${markerFor(request.id)} ${label}` : markerFor(request.id)),
        AP: { N: appearance },
      });
      annotsOf(doc, page, true)?.push(dict);
      annotationId = `${dict.asIndirect()}R`;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'annotations.stamp');
    }
    throwIfAborted(context.signal);
    saved = saveRewrite(doc, 'annotations.stamp');
  } finally {
    doc.destroy();
  }
  await verifyStamp(saved, request.pageIndex, annotationId);
  return {
    bytes: saved,
    annotationId,
    report: {
      engine: 'mupdf',
      steps: ['load', 'annotations.stamp', 'save', 'verify'],
      notes: [note('changed', 'op.note.stamp.added', { kind: request.label })],
      inputBytes: bytes.byteLength,
      outputBytes: saved.byteLength,
      pageCount,
      incremental: false,
    },
  };
}

export interface ResizeStampRequest {
  readonly pageIndex: number;
  /** pdf.js annotation id (`17R`). */
  readonly id: string;
  /** The new box in app space (unrotated page points, origin top-left, y down). */
  readonly rect: readonly [number, number, number, number];
}

/**
 * Give a `/Stamp` a new `/Rect`. Only stamps: for every other subtype the geometry lives
 * in more keys than the rectangle (`/QuadPoints`, `/InkList`, `/L`, `/RD`), and a new
 * rectangle alone would leave those where they were.
 */
export async function resizeImageStamp(
  bytes: Uint8Array,
  request: ResizeStampRequest,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const [x0, y0, x1, y1] = request.rect.map((value, index) => finite(value, `rect[${index}]`));
  const left = Math.min(x0 ?? 0, x1 ?? 0);
  const right = Math.max(x0 ?? 0, x1 ?? 0);
  const upper = Math.min(y0 ?? 0, y1 ?? 0);
  const lower = Math.max(y0 ?? 0, y1 ?? 0);
  if (right - left < MIN_STAMP_SIDE || lower - upper < MIN_STAMP_SIDE) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: 'the new stamp box is too small',
    });
  }
  const { doc } = await openForWrite(bytes);
  let saved: Uint8Array;
  let pageCount: number;
  let written: number[];
  try {
    try {
      const pages = pageObjects(doc);
      pageCount = pages.length;
      const page = pages[request.pageIndex];
      if (page === undefined) {
        throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex: request.pageIndex });
      }
      const dict = stampOnPage(doc, page, request.id);
      const box = visibleBox(page);
      const top = box.y + box.height;
      written = [left, top - lower, right, top - upper];
      dict.put('Rect', written);
      dict.put('M', text(doc, pdfDate(new Date())));
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'annotations.resize');
    }
    saved = saveRewrite(doc, 'annotations.resize');
  } finally {
    doc.destroy();
  }
  // Read back: the stamp is still there and carries exactly the rectangle written.
  const check = await openForWrite(saved);
  try {
    const page = pageObjects(check.doc)[request.pageIndex];
    const rect = page === undefined ? [] : readNumbers(stampOnPage(check.doc, page, request.id).get('Rect'));
    if (rect.length !== 4 || rect.some((value, index) => Math.abs(value - (written[index] ?? 0)) > 0.01)) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `stamp ${request.id} does not carry the rectangle written`,
      });
    }
  } finally {
    check.doc.destroy();
  }
  return {
    bytes: saved,
    report: {
      engine: 'mupdf',
      steps: ['load', 'annotations.resize', 'save', 'verify'],
      notes: [note('changed', 'op.note.stamp.resized')],
      inputBytes: bytes.byteLength,
      outputBytes: saved.byteLength,
      pageCount,
      incremental: false,
    },
  };
}

/** The `/Stamp` with this pdf.js id on this page, or a refusal naming why it is not one. */
function stampOnPage(doc: PDFDocument, page: PDFObject, id: string): PDFObject {
  const match = /^(\d+)R(\d*)$/.exec(id.trim());
  const annots = annotsOf(doc, page);
  if (match !== null && annots !== null) {
    for (let position = 0; position < annots.length; position += 1) {
      const entry = annots.get(position);
      if (!entry.isIndirect() || entry.asIndirect() !== Number(match[1])) continue;
      const dict = resolved(entry);
      if (dict === null || !dict.isDictionary()) break;
      if (readName(dict.get('Subtype')) !== 'Stamp') {
        throw new ToolError('unsupported', {
          engine: 'mupdf',
          engineMessage: `annotation ${id} is not a stamp; only stamps are resized`,
        });
      }
      return dict;
    }
  }
  throw new ToolError('selection-empty', {
    engine: 'mupdf',
    engineMessage: `stamp ${id} is not on that page`,
  });
}

/** The written stamp is on its page, with an appearance that draws an image. */
async function verifyStamp(bytes: Uint8Array, pageIndex: number, id: string): Promise<void> {
  const { doc } = await openForWrite(bytes);
  try {
    const page = pageObjects(doc)[pageIndex];
    const dict = page === undefined ? null : stampOnPage(doc, page, id);
    const normal = resolved(resolved(dict?.get('AP'))?.get('N'));
    const image = resolved(resolved(resolved(normal?.get('Resources'))?.get('XObject'))?.get('Im0'));
    if (readName(image?.get('Subtype')) !== 'Image') {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `stamp ${id} has no image appearance after the write`,
      });
    }
  } finally {
    doc.destroy();
  }
}

function num(value: number): string {
  return Number(value.toFixed(4)).toString();
}
