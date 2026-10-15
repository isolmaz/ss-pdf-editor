/**
 * Straighten scanned pages: measure how far the text lines of a page are tilted and turn the
 * page's content back by that angle.
 *
 * **Measuring.** Each page is drawn by MuPDF as a greyscale picture 1400 pixels along its
 * long side, without annotations: small enough to be quick, and below the size at which the OCR's
 * skew search (`ocr-preprocess.ts`) would shrink it again. The search is that module's: the ink is
 * thresholded (Otsu), pictures, rules, frames and slivers are left out, and the angle is the one
 * at which the ink points, projected across the lines, make the sharpest histogram — a coarse
 * step of 0.5° over ±15° and a fine step of 0.05° around the best. On generated pages and scans it lands within the fine step
 * (`deskew.test.ts`). The answer is trusted only when the peak stands clearly above the rest
 * (`SKEW_CONFIDENCE`): a page without clear lines of text — blank, a photograph, one line, a
 * form of boxes — is reported as such and left alone.
 *
 * **Turning, losslessly.** Nothing is re-encoded. The page's existing content streams are
 * wrapped, as they are, between a first stream `q a b c d e f cm q` and a last `Q Q`
 * (`wrapPageContent`), where `cm` is a rotation about the centre of the visible page; the
 * scan's picture, its OCR text layer and any vector content turn together. `/MediaBox`,
 * `/CropBox` and the other boxes are not touched: the page keeps its size, the corners that
 * leave it are scan margin, and the ones that come in are the page's own background.
 *
 * Three rules keep that honest:
 *
 *  - **Nothing is pushed off the page.** The tilted text lines are turned in the measuring
 *    frame first; if any of their ink would land outside the page the page is skipped
 *    (`edge`) instead of cutting text off. Growing the page to make room would change a
 *    scan's size, which a scan's other tools (printing, signatures, annotations) rely on.
 *  - **The turn is about the page centre, in user space.** A page's `/Rotate` is a rigid turn
 *    of the whole displayed page, so a counter-clockwise turn in user space is a
 *    counter-clockwise turn on screen for every `/Rotate`; the angle measured on the displayed
 *    picture applies as it is.
 *  - **Annotations are not moved.** A highlight, a link or a form field keeps its rectangle:
 *    turning one correctly means rewriting its appearance as well, and a rectangle turned
 *    without its appearance would be wrong in a new way. The report says how many pages carry
 *    annotations that no longer sit on the content.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { type Mupdf, mapMupdfError } from '../engines/mupdf';
import {
  pdfNumber as num,
  openForWrite,
  pageObjects,
  pageOutOfRange,
  producerKeptNote,
  resolved,
  saveRewrite,
  visibleBox,
  wrapPageContent,
} from '../engines/mupdf-write';
import { type Grey, type InkPoints, inkPoints, SKEW_CONFIDENCE, skewOfPoints } from './ocr-preprocess';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

/** The skews that are corrected: from the measuring step up to this window either side of level. */
export const DESKEW_MAX_ANGLE = 15;
/** A page that is off by less than this is level: the turn would not be seen, and it would resample the scan on screen. */
export const DESKEW_MIN_ANGLE = 0.1;
/** The long side, in pixels, of the picture a page is measured on. */
const MEASURE_LONG_SIDE = 1400;
/** The share of the ink points that may fall off the page in a turn before the page is left as it is. */
const EDGE_SHARE = 0.001;

export interface DeskewOptions {
  /** 0-based page indexes. */
  readonly pages: readonly number[];
}

/**
 * What became of one page: `straightened` — its content was turned; `level` — it is straight
 * already; `unclear` — no clear lines of text to measure; `edge` — the turn would push text
 * off the page.
 */
export type DeskewVerdict = 'straightened' | 'level' | 'unclear' | 'edge';

export interface DeskewAssessment {
  readonly verdict: DeskewVerdict;
  /** Degrees; positive when the text lines descend to the right. Zero when the page is `unclear`. */
  readonly angle: number;
}

export interface DeskewPageResult extends DeskewAssessment {
  readonly pageIndex: number;
}

export interface DeskewOutcome extends OperationOutcome {
  readonly pages: readonly DeskewPageResult[];
}

/**
 * Whether the ink, once the lines descending by `angle` degrees are made level about the centre of
 * the frame they were measured in (the map `turnImage` samples by), is still inside that frame. A
 * few points may leave: dust and specks outside the text are not text, and the share lets a
 * page number cut at the edge still count.
 */
function staysInside(points: InkPoints, angle: number): boolean {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = points.width / 2;
  const halfHeight = points.height / 2;
  let outside = 0;
  for (let i = 0; i < points.xs.length; i += 1) {
    const x = points.xs[i] as number;
    const y = points.ys[i] as number;
    if (Math.abs(x * cos + y * sin) > halfWidth || Math.abs(y * cos - x * sin) > halfHeight) outside += 1;
  }
  return outside <= EDGE_SHARE * points.xs.length;
}

/** What to do with a page, from its greyscale picture. */
export function assessPage(grey: Grey): DeskewAssessment {
  const points = inkPoints(grey);
  if (points === null) return { verdict: 'unclear', angle: 0 };
  const skew = skewOfPoints(points, DESKEW_MAX_ANGLE);
  // The fine search steps past the window by up to half the coarse step: a peak out there
  // belongs to a skew the window does not cover.
  if (skew.confidence < SKEW_CONFIDENCE || Math.abs(skew.angle) > DESKEW_MAX_ANGLE) {
    return { verdict: 'unclear', angle: 0 };
  }
  if (Math.abs(skew.angle) < DESKEW_MIN_ANGLE) return { verdict: 'level', angle: skew.angle };
  return { verdict: staysInside(points, skew.angle) ? 'straightened' : 'edge', angle: skew.angle };
}

/** The page as the viewer shows it, as greyscale pixels, annotations left out. */
function renderGrey(mupdf: Mupdf, doc: PDFDocument, pageIndex: number): Grey {
  const page = doc.loadPage(pageIndex);
  try {
    const [x0, y0, x1, y1] = page.getBounds();
    const scale = MEASURE_LONG_SIDE / Math.max(x1 - x0, y1 - y0);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, false);
    try {
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const stride = pixmap.getStride();
      const pixels = pixmap.getPixels();
      const data = new Uint8Array(width * height);
      for (let y = 0; y < height; y += 1)
        data.set(pixels.subarray(y * stride, y * stride + width), y * width);
      return { width, height, data };
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
}

/** Wrap the page's content in a counter-clockwise turn of `degrees` about the centre of its visible box. */
function turnContent(doc: PDFDocument, page: PDFObject, degrees: number): void {
  const box = visibleBox(page);
  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const matrix = [
    cos,
    sin,
    -sin,
    cos,
    centreX - (cos * centreX - sin * centreY),
    centreY - (sin * centreX + cos * centreY),
  ];
  wrapPageContent(doc, page, `q ${matrix.map(num).join(' ')} cm`, 'Q');
}

function hasAnnotations(page: PDFObject): boolean {
  const annots = resolved(page.get('Annots'));
  return annots?.isArray() === true && annots.length > 0;
}

function describePage(result: DeskewPageResult): OperationNote {
  const page = result.pageIndex + 1;
  const angle = Math.abs(result.angle);
  switch (result.verdict) {
    case 'straightened':
      return note('changed', 'deskew.note.straightened', { page, angle });
    case 'level':
      return note('preserved', 'deskew.note.level', { page });
    case 'unclear':
      return note('warning', 'deskew.note.unclear', { page });
    case 'edge':
      return note('warning', 'deskew.note.edge', { page, angle });
  }
}

/**
 * Straighten the listed pages. A document in which no page needed or allowed a turn comes back
 * as the bytes it came in with, and the result lists why for each page.
 */
export async function deskewPages(
  bytes: Uint8Array,
  options: DeskewOptions,
  context: OperationContext,
): Promise<DeskewOutcome> {
  throwIfAborted(context.signal);
  const targets = [...new Set(options.pages)].sort((a, b) => a - b);
  if (targets.length === 0) {
    throw new ToolError('selection-empty', { engine: 'model', engineMessage: 'straightening needs a page' });
  }

  const { mupdf, doc } = await openForWrite(bytes);
  const results: DeskewPageResult[] = [];
  let annotated = 0;
  let produced: Uint8Array | null = null;
  let pageCount: number;
  try {
    const pages = pageObjects(doc);
    pageCount = pages.length;
    for (const pageIndex of targets) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
        throw pageOutOfRange(pageIndex, 'deskew');
      }
    }
    for (const [position, pageIndex] of targets.entries()) {
      throwIfAborted(context.signal);
      const assessment = assessPage(renderGrey(mupdf, doc, pageIndex));
      results.push({ pageIndex, ...assessment });
      if (assessment.verdict === 'straightened') {
        const page = pages[pageIndex] as PDFObject;
        turnContent(doc, page, assessment.angle);
        if (hasAnnotations(page)) annotated += 1;
      }
      context.onProgress?.({
        phase: 'deskew',
        labelKey: 'op.progress.deskew',
        done: position + 1,
        total: targets.length,
      });
      // The measuring is a few tens of milliseconds a page on the main thread: let the
      // progress bar and a cancel through between pages.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (results.some((result) => result.verdict === 'straightened')) {
      throwIfAborted(context.signal);
      produced = saveRewrite(doc, 'deskew');
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'deskew');
  } finally {
    doc.destroy();
  }

  const notes: OperationNote[] = results.map(describePage);
  if (produced === null) notes.push(note('warning', 'deskew.note.unchanged'));
  else {
    notes.push(note('preserved', 'deskew.note.lossless'));
    if (annotated > 0) notes.push(note('warning', 'deskew.note.annotations', { count: annotated }));
    notes.push(producerKeptNote());
  }
  return {
    bytes: produced ?? bytes.slice(),
    pages: results,
    report: {
      engine: 'mupdf',
      steps: produced === null ? ['render'] : ['render', 'deskew', 'save'],
      notes,
      inputBytes: bytes.byteLength,
      outputBytes: (produced ?? bytes).byteLength,
      pageCount,
      incremental: produced === null,
    },
  };
}
