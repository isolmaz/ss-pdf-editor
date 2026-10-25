/**
 * Page tidy-up: finding the blank pages of a document and splitting two-up scans.
 *
 * ## Blank pages
 *
 * A page is blank only when **nothing on it can be seen or read**, and each check errs on the
 * side of keeping the page:
 *
 *  - any annotation keeps it (a note, a link, a stamp, a form field — a widget is an annotation);
 *  - any letter or digit of extractable text keeps it, visible or not: an OCR layer or white text
 *    is content someone put there. Punctuation alone does not, so the specks an OCR engine reads
 *    out of a blank sheet do not hold the page;
 *  - what is left is judged on the rendered page, not on the content stream: a page whose
 *    stream draws a white rectangle, or an image of an empty sheet, is blank to a reader and
 *    must be blank here. The page is drawn small in grey and counted: pixels clearly darker
 *    than paper are ink, and a few of them — dust and scanner noise, a speck averaged down
 *    to a fraction of a pixel — do not make a page. A page whose paper itself is dark has
 *    ink everywhere and is never blank.
 *
 * ## Two-up scans
 *
 * A landscape page that holds two portrait pages side by side becomes two pages, **by
 * windowing, not by drawing**: the page dictionary is copied (the content streams and the
 * resources are shared by reference, so the file does not grow by a second copy of the
 * scan) and each of the two is given the half of the page as its `/MediaBox` and `/CropBox`.
 * Nothing is rasterised and nothing is re-encoded. The halves are found in **displayed**
 * space and mapped back through the page's own rotation, so a turned scan splits left to
 * right as the reader shows it.
 *
 * A page that carries annotations is left whole: a link or a form field belongs to one half,
 * and sharing the object between two pages (or guessing which half it is on) would corrupt
 * it. The report names those pages.
 */

import type { PDFDocument, PDFObject, Pixmap } from 'mupdf';
import { mapMupdfError } from '../engines/mupdf';
import { openForWrite, pageObjects, producerKeptNote, resolved, saveRewrite } from '../engines/mupdf-write';
import { composeLabelRanges, type LabelPlacement, readLabelRanges, replaceLabelRanges } from './page-labels';
import { formatPageRanges } from './page-ranges';
import { displayToUserPoint, type PageGeometry, pageGeometry } from './stamp';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

/** The resolution a page is drawn at to be judged: enough for a hairline, small enough to be quick. */
const BLANK_DPI = 50;

/** No side of the judged bitmap is longer than this, so a poster-sized page stays a modest bitmap. */
const BLANK_MAX_SIDE_PX = 2000;

/** A grey level below this is always ink; paper, tinted paper and a noisy scan of paper are above it. */
const INK_BELOW = 200;

/**
 * How much darker than the page's own paper (its median grey) a pixel may be and still be paper.
 * On white paper this makes a light-grey logo or gridline ink (grey 204, and a thin line of it
 * drawn lighter still at this resolution), which `INK_BELOW` alone would take for paper; it never
 * makes the test less strict than `INK_BELOW`.
 */
const PAPER_MARGIN = 25;

/** The share of the pixels that may be ink on a blank page: scanner dust, not content. */
const INK_TOLERANCE = 0.0001;

/** The page dictionary keys a split copy must not inherit from the page it was copied from. */
const NOT_COPIED = new Set(['Parent', 'Thumb', 'StructParents']);

/** Whether a page carries any annotation, which is where its notes, links and form fields live. */
function hasAnnotations(page: PDFObject): boolean {
  const annots = resolved(page.get('Annots'));
  return annots?.isArray() === true && annots.length > 0;
}

/** Whether the pixmap (one grey byte per pixel) holds more than a speck of ink. */
function isBlankPixmap(pixmap: Pixmap): boolean {
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const stride = pixmap.getStride();
  const pixels = pixmap.getPixels();
  const histogram = new Uint32Array(256);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const grey = pixels[row + x] as number;
      histogram[grey] = (histogram[grey] as number) + 1;
    }
  }
  let paper = 0;
  for (let seen = 0; paper < 255; paper += 1) {
    seen += histogram[paper] as number;
    if (seen * 2 >= width * height) break;
  }
  const inkBelow = Math.max(INK_BELOW, paper - PAPER_MARGIN);
  let ink = 0;
  for (let grey = 0; grey < inkBelow; grey += 1) ink += histogram[grey] as number;
  return ink <= Math.floor(width * height * INK_TOLERANCE);
}

/** The 0-based indexes of the pages with nothing on them to see or read, ascending. */
export async function findBlankPages(
  bytes: Uint8Array,
  context: OperationContext,
): Promise<readonly number[]> {
  throwIfAborted(context.signal);
  const { mupdf, doc } = await openForWrite(bytes);
  const blank: number[] = [];
  try {
    const pages = pageObjects(doc);
    for (const [index, object] of pages.entries()) {
      throwIfAborted(context.signal);
      if (!hasAnnotations(object)) {
        const page = doc.loadPage(index);
        try {
          const structured = page.toStructuredText('preserve-whitespace');
          let readable: boolean;
          try {
            readable = /[\p{L}\p{N}]/u.test(structured.asText());
          } finally {
            structured.destroy();
          }
          if (!readable) {
            const { display } = pageGeometry(object);
            const scale = Math.min(
              BLANK_DPI / 72,
              BLANK_MAX_SIDE_PX / Math.max(display.width, display.height),
            );
            const pixmap = page.toPixmap(
              mupdf.Matrix.scale(scale, scale),
              mupdf.ColorSpace.DeviceGray,
              false,
              false,
            );
            try {
              if (isBlankPixmap(pixmap)) blank.push(index);
            } finally {
              pixmap.destroy();
            }
          }
        } finally {
          page.destroy();
        }
      }
      context.onProgress?.({
        phase: 'tidy',
        labelKey: 'tidy.progress.scan',
        done: index + 1,
        total: pages.length,
      });
      // Rendering a page is synchronous work on the main thread: let the progress bar and a
      // cancel through between pages.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'blank-pages');
  } finally {
    doc.destroy();
  }
  return blank;
}

/** The corners of a window of the displayed page as the box they span in unrotated user space. */
function userBox(geometry: PageGeometry, left: number, right: number): [number, number, number, number] {
  const first = displayToUserPoint(geometry, left, 0);
  const second = displayToUserPoint(geometry, right, geometry.display.height);
  return [
    Math.min(first.x, second.x),
    Math.min(first.y, second.y),
    Math.max(first.x, second.x),
    Math.max(first.y, second.y),
  ];
}

/** Window a page to a box: it is that page's media and crop box, and the finer boxes no longer apply. */
function windowPage(page: PDFObject, box: readonly number[]): void {
  page.put('MediaBox', [...box]);
  page.put('CropBox', [...box]);
  for (const key of ['TrimBox', 'BleedBox', 'ArtBox']) page.delete(key);
}

/**
 * A second page dictionary with the same content: every entry shared by reference, so the
 * content streams, the images and the fonts exist once. `Resources` and `Rotate` are
 * inheritable and the copy may land under another `/Pages` node, so the page owns them first.
 */
function copyPage(doc: PDFDocument, page: PDFObject): PDFObject {
  for (const key of ['Resources', 'Rotate']) {
    const inherited = page.getInheritable(key);
    if (page.get(key).isNull() && !inherited.isNull()) page.put(key, inherited);
  }
  const copy = doc.newDictionary();
  page.forEach((value, key) => {
    if (!NOT_COPIED.has(String(key))) copy.put(key, value);
  });
  return doc.addObject(copy);
}

export interface SplitTwoUpOutcome extends OperationOutcome {
  /** The pages that were split, 0-based, in the numbering of the input. */
  readonly split: readonly number[];
}

/**
 * Split the landscape pages among `pages` (0-based, ascending) into a left and a right
 * page. A page that is not landscape is left as it is, and so is one with annotations; the
 * report says how many of each. The input is returned untouched when no page was split.
 */
export async function splitTwoUpPages(
  bytes: Uint8Array,
  pages: readonly number[],
  context: OperationContext,
): Promise<SplitTwoUpOutcome> {
  throwIfAborted(context.signal);
  const { mupdf, doc } = await openForWrite(bytes);
  const split: number[] = [];
  const portrait: number[] = [];
  const annotated: number[] = [];
  let produced: Uint8Array;
  let pageCount: number;
  try {
    const originalCount = doc.countPages();
    const objects = pageObjects(doc);
    // Last page first: a page inserted after page `n` moves only the pages behind it.
    for (const [position, index] of [...pages].reverse().entries()) {
      throwIfAborted(context.signal);
      const page = objects[index] as PDFObject;
      const geometry = pageGeometry(page);
      if (geometry.display.width <= geometry.display.height) portrait.push(index);
      else if (hasAnnotations(page)) annotated.push(index);
      else {
        const half = geometry.display.width / 2;
        const copy = copyPage(doc, page);
        // The left page keeps the original dictionary, so links to it from the outline
        // and from other pages still lead to the first half.
        windowPage(copy, userBox(geometry, half, geometry.display.width));
        windowPage(page, userBox(geometry, 0, half));
        doc.insertPage(index + 1, copy);
        split.push(index);
      }
      context.onProgress?.({
        phase: 'tidy',
        labelKey: 'tidy.progress.split',
        done: position + 1,
        total: pages.length,
      });
    }
    split.reverse();
    portrait.reverse();
    annotated.reverse();
    pageCount = originalCount + split.length;

    if (split.length === 0) {
      return {
        bytes: bytes.slice(),
        split,
        report: {
          engine: 'mupdf',
          steps: ['load'],
          notes: skippedNotes(portrait, annotated),
          inputBytes: bytes.byteLength,
          outputBytes: bytes.byteLength,
          pageCount,
          incremental: true,
        },
      };
    }

    // Insertions moved the pages behind them, and a label belongs to the page it was
    // written for: every output page takes the label its source page had.
    const ranges = readLabelRanges(doc);
    if (ranges.length > 0) {
      const placements: LabelPlacement[] = [];
      for (let index = 0; index < originalCount; index += 1) {
        const before = split.filter((page) => page < index).length;
        placements.push({ source: 0, page: index, position: index + before });
        if (split.includes(index)) placements.push({ source: 0, page: index, position: index + before + 1 });
      }
      replaceLabelRanges(mupdf, doc, composeLabelRanges([ranges], placements));
    }
    produced = saveRewrite(doc, 'split-two-up');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'split-two-up');
  } finally {
    doc.destroy();
  }
  throwIfAborted(context.signal);

  return {
    bytes: produced,
    split,
    report: {
      engine: 'mupdf',
      steps: ['load', 'split-two-up', 'save'],
      notes: [
        note('changed', 'tidy.split.done', { count: split.length, pages: formatPageRanges(split) }),
        note('preserved', 'tidy.split.lossless'),
        ...skippedNotes(portrait, annotated),
        producerKeptNote(),
      ],
      inputBytes: bytes.byteLength,
      outputBytes: produced.byteLength,
      pageCount,
      incremental: false,
    },
  };
}

/** What was left whole and why: a page that is not landscape is expected, one with annotations is a warning. */
function skippedNotes(portrait: readonly number[], annotated: readonly number[]): OperationNote[] {
  const notes: OperationNote[] = [];
  if (portrait.length > 0) notes.push(note('preserved', 'tidy.split.portrait', { count: portrait.length }));
  if (annotated.length > 0) {
    notes.push(
      note('warning', 'tidy.split.annotated', {
        count: annotated.length,
        pages: formatPageRanges(annotated),
      }),
    );
  }
  return notes;
}
