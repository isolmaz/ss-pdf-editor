/**
 * Text the user types onto a page — the `/FreeText` annotation ("Metin ekle").
 *
 * pdf.js can write a `/FreeText`, but the engine draws the visible text with a WinAnsi
 * base font that has no `ş ğ ı İ`.
 * Text the user can read on the page therefore cannot go through the engine: this module
 * writes the dictionary **and** its appearance stream itself, with the pinned Noto Sans
 * embedded, the same font every other writer that draws text uses (`engines/noto.ts`),
 * through MuPDF (`engines/mupdf-write.ts` `embedNotoSans`: a Type0 Identity-H font
 * with a `/ToUnicode` map, so the text stays selectable and searchable).
 *
 * Two functions, the repository's usual pair:
 *
 * - {@link planFreeTextLayout} is pure: it wraps the text into lines no wider than the
 *   box, given any width measure. The overlay shows the same box the file will carry, so
 *   the arithmetic lives in one place and is tested without an engine.
 * - {@link writeFreeTextAnnotations} performs it and **reads its own output back**: every
 *   written annotation has to be found again by its marker as a `/FreeText` with an
 *   appearance, or the write is `verification-failed`.
 *
 * The face is embedded once per write and cut to the glyphs the boxes draw before the
 * save (`subsetEmbeddedFaces`), so a save that adds a few words grows the file by tens of
 * kilobytes, not by the whole 629 KB program.
 */

import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  embedNotoSans,
  openForWrite,
  pageObjects,
  pdfDate,
  readName,
  resolved,
  saveRewrite,
  subsetEmbeddedFaces,
  text,
  visibleBox,
} from '../engines/mupdf-write';
import { type AnnotationMark, hexToRgb, markerFor, markerOf } from './annotations';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

/** The size a new text box starts at, in points. */
export const FREETEXT_DEFAULT_SIZE = 12;
export const FREETEXT_MIN_SIZE = 6;
export const FREETEXT_MAX_SIZE = 72;
/** Line pitch as a multiple of the size: the overlay's CSS `line-height` uses the same. */
export const FREETEXT_LINE_HEIGHT = 1.25;
/** Inner padding of the box, in points, on every side. */
export const FREETEXT_PADDING = 2;

export interface FreeTextLayout {
  readonly lines: readonly string[];
  /** The box's height in points: the lines plus the padding above and below. */
  readonly height: number;
}

/**
 * Wrap `text` into lines that fit `width` points at `size`, measured by `measure`.
 *
 * Hard line breaks are kept. A word wider than the box is broken between characters
 * rather than allowed to run past the edge — the appearance is clipped to its box by
 * every reader, so an overflowing word would silently lose letters.
 */
export function planFreeTextLayout(
  text: string,
  width: number,
  size: number,
  measure: (value: string) => number,
): FreeTextLayout {
  const inner = Math.max(width - 2 * FREETEXT_PADDING, size);
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/)) {
      if (word === '') continue;
      const candidate = line + word;
      if (measure(candidate) <= inner) {
        line = candidate;
        continue;
      }
      if (line.trim() !== '') lines.push(line.trimEnd());
      line = '';
      if (/^\s+$/.test(word)) continue;
      // The word alone does not fit: break it between characters.
      let piece = '';
      for (const character of word) {
        if (piece !== '' && measure(piece + character) > inner) {
          lines.push(piece);
          piece = '';
        }
        piece += character;
      }
      line = piece;
    }
    lines.push(line.trimEnd());
  }
  const height = lines.length * size * FREETEXT_LINE_HEIGHT + 2 * FREETEXT_PADDING;
  return { lines, height };
}

export interface FreeTextOutcome extends OperationOutcome {
  /** Marker lines of the annotations appended. */
  readonly written: readonly string[];
}

/** The size a mark is drawn at, clamped to the range the strip offers. */
export function freeTextSize(mark: AnnotationMark): number {
  const size = mark.fontSize ?? FREETEXT_DEFAULT_SIZE;
  return Math.min(Math.max(size, FREETEXT_MIN_SIZE), FREETEXT_MAX_SIZE);
}

/**
 * Append one `/FreeText` per mark, each with a Noto Sans appearance.
 *
 * The mark's `rect` fixes the box's top-left corner and its width (page space, top-left
 * origin); the height follows the wrapped text, so a box never cuts off the last line.
 * `/NM` carries the session marker and `/Contents` the text alone, the convention every
 * mark this app writes follows — the name is how a later edit finds the annotation again.
 */
export async function writeFreeTextAnnotations(
  bytes: Uint8Array,
  marks: readonly AnnotationMark[],
  context: OperationContext,
): Promise<FreeTextOutcome> {
  const boxes = marks.filter((mark) => mark.kind === 'freetext' && mark.contents.trim() !== '');
  if (boxes.length === 0) {
    return {
      bytes,
      written: [],
      report: {
        engine: 'mupdf',
        steps: ['annotations.freetext.skipped'],
        notes: [note('warning', 'op.note.annotate.nothing')],
        inputBytes: bytes.byteLength,
        outputBytes: bytes.byteLength,
        pageCount: 0,
        incremental: true,
      },
    };
  }

  const { mupdf, doc } = await openForWrite(bytes);
  let saved: Uint8Array;
  let pageCount: number;
  const written: string[] = [];
  try {
    const font = await embedNotoSans(mupdf, doc);
    const pages = pageObjects(doc);
    pageCount = pages.length;
    try {
      for (const mark of boxes) {
        throwIfAborted(context.signal);
        const page = pages[mark.pageIndex];
        if (page === undefined) {
          throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex: mark.pageIndex });
        }
        const box = mark.rect ?? mark.quads[0];
        if (box === undefined) {
          throw new ToolError('selection-empty', { engine: 'mupdf', pageIndex: mark.pageIndex });
        }
        const size = freeTextSize(mark);
        const left = Math.min(box[0], box[2]);
        const width = Math.max(Math.abs(box[2] - box[0]), size + 2 * FREETEXT_PADDING);
        const top = Math.min(box[1], box[3]);
        const layout = planFreeTextLayout(mark.contents, width, size, (value) =>
          font.widthOfTextAtSize(value, size),
        );

        const crop = visibleBox(page);
        const pageTop = crop.y + crop.height;
        const rect = [left, pageTop - top - layout.height, left + width, pageTop - top];
        const [red, green, blue] = hexToRgb(mark.color);
        const num = (value: number) => value.toFixed(3);

        // Annotation space: origin at the rect's lower-left, y up. Each line box is one
        // pitch tall with the glyphs centred in it (CSS's half-leading, which is how the
        // overlay draws the same box), so a baseline sits half the leading plus one ascent
        // below the top of its line.
        const ascent = font.heightAtSize(size, { descender: false });
        const content = font.heightAtSize(size);
        const pitch = size * FREETEXT_LINE_HEIGHT;
        const operators: string[] = [
          'q',
          'BT',
          `/F1 ${num(size)} Tf`,
          `${num(red)} ${num(green)} ${num(blue)} rg`,
        ];
        layout.lines.forEach((line, index) => {
          const lineTop = layout.height - FREETEXT_PADDING - index * pitch;
          const baseline = lineTop - (pitch - content) / 2 - ascent;
          operators.push(`1 0 0 1 ${num(FREETEXT_PADDING)} ${num(baseline)} Tm`);
          if (line !== '') operators.push(`${font.encode(line)} Tj`);
        });
        operators.push('ET', 'Q');

        const appearance = doc.addStream(operators.join('\n'), {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, width, layout.height],
          Matrix: [1, 0, 0, 1, 0, 0],
          Resources: { Font: { F1: font.ref } },
        });
        const opacity = Math.min(Math.max(mark.opacity, 0.02), 1);
        const dict = doc.addObject({
          Type: 'Annot',
          Subtype: 'FreeText',
          Rect: rect,
          P: page,
          // Print flag on, so an exported file prints what the screen shows.
          F: 4,
          Border: [0, 0, 0],
          // `/DA` is required for a free text annotation; a reader that regenerates the
          // appearance falls back to Helvetica, the `/AP` above is what they all show.
          DA: text(doc, `/Helv ${num(size)} Tf ${num(red)} ${num(green)} ${num(blue)} rg`),
          CA: opacity,
          T: text(doc, mark.author),
          M: text(doc, pdfDate(new Date(mark.createdAt))),
          // The typed words, and the marker as the annotation's name: `/Contents` is what
          // every reader prints.
          NM: text(doc, markerFor(mark.id)),
          Contents: text(doc, mark.contents.trim()),
          AP: { N: appearance },
        });
        annotsOf(doc, page, true)?.push(dict);
        written.push(markerFor(mark.id));
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'annotations.freetext');
    }
    subsetEmbeddedFaces(mupdf, doc, [font]);
    saved = saveRewrite(doc, 'annotations.freetext');
  } finally {
    doc.destroy();
  }
  await verifyFreeText(saved, boxes, context);
  return {
    bytes: saved,
    written,
    report: {
      engine: 'mupdf',
      steps: ['load', 'annotations.freetext', 'save'],
      notes: [note('changed', 'op.note.annotate.freetext', { count: written.length })],
      inputBytes: bytes.byteLength,
      outputBytes: saved.byteLength,
      pageCount,
      incremental: false,
    },
  };
}

/**
 * Read the written file back: every mark must come back as a `/FreeText` on its own
 * page, carrying its marker and a normal appearance. Anything less is a write that did
 * not happen, and is reported as such rather than as success.
 */
async function verifyFreeText(
  bytes: Uint8Array,
  marks: readonly AnnotationMark[],
  context: OperationContext,
): Promise<void> {
  const { doc } = await openForWrite(bytes);
  const found = new Set<string>();
  try {
    for (const [pageIndex, page] of pageObjects(doc).entries()) {
      throwIfAborted(context.signal);
      const annots = annotsOf(doc, page);
      if (annots === null) continue;
      for (let position = 0; position < annots.length; position += 1) {
        const dict = resolved(annots.get(position));
        if (dict === null || !dict.isDictionary() || readName(dict.get('Subtype')) !== 'FreeText') continue;
        const id = markerOf(dict);
        const appearance = resolved(dict.get('AP'));
        // A stream is recognised on its reference (`engines/mupdf-write.ts`).
        if (id === null || appearance === null || !appearance.get('N').isStream()) continue;
        found.add(`${pageIndex}|${id}`);
      }
    }
  } finally {
    doc.destroy();
  }
  const missing = marks.filter((mark) => !found.has(`${mark.pageIndex}|${mark.id}`));
  if (missing.length > 0) {
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: `${missing.length} free text annotation(s) were not found in the written file`,
    });
  }
}
