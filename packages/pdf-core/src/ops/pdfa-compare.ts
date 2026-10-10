/**
 * Before and after, for the PDF/A conversion: does the output show the same text and the same
 * picture as the input?
 *
 * Ghostscript rebuilds every page, so "it wrote a PDF/A file" says nothing about whether the
 * pages still look like the originals. Two independent readings answer that, both through
 * MuPDF on the input and on the output:
 *
 *  - **Text.** The extracted text of a page, as the multiset of its words: the share of the
 *    input's words the output still has (`wordRecall`). Order and spacing may differ between two
 *    equivalent files, so they are not compared.
 *  - **Picture.** Each sampled page's content (not its annotations: their count is compared
 *    separately, and MuPDF draws a rescaled sticky-note icon differently from the viewers) is
 *    rendered to grey at the same width and the two images are compared pixel by pixel: the
 *    mean difference over the page, and the worst 16 × 16 block, so one missing picture or
 *    paragraph on a mostly white page is not averaged away.
 *
 * The numbers are reported as they are measured; this module only decides which pages to look
 * at (`samplePageIndices`) and does the arithmetic.
 */

import type { PDFDocument } from 'mupdf';
import type { Mupdf } from '../engines/mupdf';
import { readName, resolved } from '../engines/mupdf-write';

/** Render width in pixels: small enough to be fast on a 300-page file, large enough for text blocks. */
const RENDER_WIDTH = 360;
const BLOCK = 16;

export interface PageComparison {
  readonly pageIndex: number;
  /** Mean absolute difference over the page, 0 (identical) to 1. */
  readonly mean: number;
  /** The largest mean difference of any 16 × 16 pixel block. */
  readonly worstBlock: number;
  /** The two pages are not the same shape (their aspect ratios differ by more than 1 %). */
  readonly shapeDiffers: boolean;
}

/**
 * Up to `limit` page indices spread over the document, always including the first and the last.
 * `limit` is a whole number; a document of more pages than that is sampled at `limit` distinct pages.
 */
export function samplePageIndices(pageCount: number, limit: number): number[] {
  if (pageCount <= 0) return [];
  if (pageCount <= limit) return Array.from({ length: pageCount }, (_, index) => index);
  const picked = new Set<number>([0, pageCount - 1]);
  for (let step = 1; picked.size < limit; step += 1) {
    picked.add(Math.min(pageCount - 1, Math.round((step * (pageCount - 1)) / limit)));
  }
  return [...picked].sort((left, right) => left - right);
}

/** A page's words, lower-cased, in reading order. */
export function pageWords(doc: PDFDocument, pageIndex: number): string[] {
  const page = doc.loadPage(pageIndex);
  try {
    const structured = page.toStructuredText('preserve-whitespace');
    try {
      return structured
        .asText()
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word !== '');
    } finally {
      structured.destroy();
    }
  } finally {
    page.destroy();
  }
}

/**
 * The share of `source`'s words that `output` still has, counting each word as often as the
 * source has it; `null` when the source has no words to lose.
 */
export function wordRecall(source: readonly string[], output: readonly string[]): number | null {
  if (source.length === 0) return null;
  const available = new Map<string, number>();
  for (const word of output) available.set(word, (available.get(word) ?? 0) + 1);
  let kept = 0;
  for (const word of source) {
    const left = available.get(word) ?? 0;
    if (left > 0) {
      kept += 1;
      available.set(word, left - 1);
    }
  }
  return kept / source.length;
}

interface Grey {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

function renderGrey(mupdf: Mupdf, doc: PDFDocument, pageIndex: number): Grey {
  const page = doc.loadPage(pageIndex);
  try {
    const [x0 = 0, , x1 = 0] = page.getBounds();
    const scale = RENDER_WIDTH / Math.max(1, x1 - x0);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, false);
    try {
      return { width: pixmap.getWidth(), height: pixmap.getHeight(), pixels: pixmap.getPixels().slice() };
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
}

/** Compare one page of `before` with the same page of `after`. */
export function comparePage(
  mupdf: Mupdf,
  before: PDFDocument,
  after: PDFDocument,
  pageIndex: number,
): PageComparison {
  const left = renderGrey(mupdf, before, pageIndex);
  const right = renderGrey(mupdf, after, pageIndex);
  const shapeDiffers =
    Math.abs(left.height / Math.max(1, left.width) - right.height / Math.max(1, right.width)) > 0.01;
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  let total = 0;
  let worst = 0;
  for (let top = 0; top < height; top += BLOCK) {
    for (let leftEdge = 0; leftEdge < width; leftEdge += BLOCK) {
      let blockTotal = 0;
      let blockCount = 0;
      for (let y = top; y < Math.min(height, top + BLOCK); y += 1) {
        for (let x = leftEdge; x < Math.min(width, leftEdge + BLOCK); x += 1) {
          // x and y are inside both renders (the loops stop at the smaller width and height).
          const difference = Math.abs(
            (left.pixels[y * left.width + x] as number) - (right.pixels[y * right.width + x] as number),
          );
          blockTotal += difference;
          blockCount += 1;
        }
      }
      total += blockTotal;
      worst = Math.max(worst, blockTotal / blockCount / 255);
    }
  }
  return {
    pageIndex,
    mean: width * height === 0 ? 1 : total / (width * height) / 255,
    worstBlock: worst,
    shapeDiffers,
  };
}

/**
 * How many annotations of each subtype the document's pages carry. `Popup` is left out: it is
 * only the window of another annotation, and an engine may drop and rebuild it. A page's
 * `/Annots` is read as the file has it, so a document is compared with the file it came from.
 */
export function annotationCounts(doc: PDFDocument): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < doc.countPages(); index += 1) {
    const annotations = resolved(doc.findPage(index).get('Annots'));
    if (annotations === null || !annotations.isArray()) continue;
    for (let at = 0; at < annotations.length; at += 1) {
      const annotation = resolved(annotations.get(at));
      if (annotation === null || !annotation.isDictionary()) continue;
      const subtype = readName(annotation.get('Subtype')) ?? '?';
      if (subtype === 'Popup') continue;
      counts.set(subtype, (counts.get(subtype) ?? 0) + 1);
    }
  }
  return counts;
}
