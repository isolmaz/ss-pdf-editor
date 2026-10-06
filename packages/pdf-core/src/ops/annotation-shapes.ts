/**
 * The geometric shapes pdf.js cannot write.
 *
 * The engine's new-annotation writer (`AnnotationFactory.saveNewAnnotations`,
 * `build/pdf.worker.mjs:53115`) dispatches on five editor types only —
 * `FREETEXT`, `HIGHLIGHT`, `INK`, `STAMP`, `SIGNATURE` — and those are the four
 * text-markup kinds plus freehand drawing. Squares, circles and lines have **no**
 * writer anywhere in the engine, so their dictionary **and** their appearance
 * stream are built here. That is the other half of the annotation writer: the engine supplies the
 * layer and the write path for the types it has, and this module finishes the ones
 * it does not.
 *
 * Why an appearance stream and not just the dictionary: PDF 32000-2 says a
 * conforming reader that finds no `/AP` should construct the appearance from the
 * annotation's other attributes, and readers honour that very unevenly. A
 * rectangle drawn over erased content that renders as nothing in one reader is the
 * one outcome this feature cannot ship, so the stroke is painted explicitly.
 *
 * Written through MuPDF's object model (`engines/mupdf-write.ts`): `addObject` and
 * `addStream` create the dictionary and its appearance, the page object is the `/P`
 * back-pointer, and the annotation is appended to the page's `/Annots` — nothing else
 * on the page is touched (pdf-lib's `addAnnot`, the previous path, also rewrote the
 * page's content array to wrap it in `q`/`Q`).
 *
 * The combined write of *all* mark kinds lives at the bottom
 * (`writeAnnotationsToFile`), because the three steps have a dependency order and
 * one caller must own it.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  openForWrite,
  PRODUCER_LINE,
  pageObjects,
  pdfDate,
  saveRewrite,
  text,
  visibleBox,
} from '../engines/mupdf-write';
import { writeFreeTextAnnotations } from './annotation-freetext';
import type { ReviewRecordRequest } from './annotation-review';
import { type QuarterTurn, transformPdfAnnotations } from './annotation-transform';
import {
  type AnnotationMark,
  type AnnotationWriteHandle,
  annotationIdsOf,
  boxesOf,
  contentsFor,
  type ExistingAnnotation,
  hexToRgb,
  isStrokedHighlight,
  type MarkBox,
  markerFor,
  markerTargets,
  markRect,
  OWNED_KINDS,
  retagTextMarkup,
  writeAnnotations,
} from './annotations';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

/** `/Subtype` for each shape kind this module builds. */
const SHAPE_SUBTYPES: Readonly<Record<string, string>> = {
  square: 'Square',
  circle: 'Circle',
  line: 'Line',
};

/** Opacity floor: a mark the user can see is the point of the feature. */
const MIN_OPACITY = 0.02;

/** Control-point constant of a four-arc Bézier circle (the standard approximation). */
const KAPPA = 0.5523;

/**
 * The PDF content-stream operators a shape appearance uses, spelled out.
 *
 * Spelled out as data rather than taken from an engine module: a value import from an
 * engine package would drag it into the first-paint chunk (the entry once measured
 * 440 KiB gzip against a 250 KiB budget); engines load lazily.
 *
 * PDF 32000-1 Table A.1 is the source for each mnemonic.
 */
const OP = {
  SetLineWidth: 'w',
  SetLineCapStyle: 'J',
  SetLineJoinStyle: 'j',
  SetGraphicsState: 'gs',
  StrokingColorRgb: 'RG',
  MoveTo: 'm',
  LineTo: 'l',
  AppendBezierCurve: 'c',
  ClosePath: 'h',
  StrokePath: 'S',
} as const;

export interface ShapesOutcome extends OperationOutcome {
  /** Marker lines of the annotations appended. */
  readonly written: readonly string[];
}

/**
 * Append one annotation per shape mark, with its appearance stream.
 *
 * Appearance syntax notes, because the numbers are not obvious:
 *  - the stream paints in **annotation space** — origin at the `/Rect`'s
 *    lower-left corner, units in points, y growing upward;
 *  - the box arrives in the module's page space (top-left origin, y downward), so
 *    it is flipped, inset by half the stroke width (a stroke centred on the
 *    boundary is clipped by the box), then translated;
 *  - the opacity is written on the annotation's `/CA` and, through `/GS0`, in the
 *    appearance itself, which is the half the readers actually paint.
 *
 * The geometry is the mark's stored one: a mark's own `rotation` is applied by
 * `writeAnnotationsToFile` after this step, through `transformPdfAnnotations`,
 * which turns the fields *and* the appearance. Turning the box alone would leave
 * a diagonal `/L` pointing the old way inside a rotated rectangle.
 */
export async function writeShapeAnnotations(
  bytes: Uint8Array,
  marks: readonly AnnotationMark[],
  context: OperationContext,
): Promise<ShapesOutcome> {
  const shapes = marks.filter((mark) => mark.kind === 'shapes');
  if (shapes.length === 0) return { ...nothingToDo(bytes, 'shapes'), written: [] };

  const { doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    const written: string[] = [];
    try {
      for (const mark of shapes) {
        throwIfAborted(context.signal);
        const page = pages[mark.pageIndex];
        const box = boxesOf(mark)[0];
        if (page === undefined) {
          throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex: mark.pageIndex });
        }
        if (box === undefined) {
          throw new ToolError('selection-empty', { engine: 'mupdf', pageIndex: mark.pageIndex });
        }
        const subtype = SHAPE_SUBTYPES[mark.shape ?? 'square'];
        if (subtype === undefined) {
          throw new ToolError('unsupported-format', { engine: 'mupdf', pageIndex: mark.pageIndex });
        }

        const crop = visibleBox(page);
        const pageTop = crop.y + crop.height;
        const stroke = Math.max(mark.thickness ?? 2, 1);
        const rect = markRect({ ...mark, thickness: stroke }, pageTop);
        const opacity = Math.max(mark.opacity, MIN_OPACITY);

        const appearance = doc.addStream(shapeAppearance(subtype, box, rect, pageTop, stroke, mark), {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, (rect[2] ?? 0) - (rect[0] ?? 0), (rect[3] ?? 0) - (rect[1] ?? 0)],
          Matrix: [1, 0, 0, 1, 0, 0],
          // The stroke's alpha rides the appearance too: pdf.js and PDFium paint the
          // `/AP` and ignore the annotation's `/CA`, so a 40 % rectangle exported opaque.
          Resources: { ExtGState: { GS0: { Type: 'ExtGState', CA: opacity, ca: opacity } } },
        });
        const dict = doc.addObject({
          ...commonFields(doc, page, mark),
          Subtype: subtype,
          Rect: rect,
          C: [...hexToRgb(mark.color)],
          CA: opacity,
          AP: { N: appearance },
        });
        if (subtype === 'Line') dict.put('L', [...lineEndpoints(box, pageTop)]);
        attach(doc, page, dict);
        written.push(markerFor(mark.id));
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'annotations.shapes');
    }

    const saved = saveRewrite(doc, 'annotations.shapes');
    return {
      bytes: saved,
      written,
      report: {
        engine: 'mupdf',
        steps: ['load', 'annotations.shapes', 'save'],
        notes: [
          note('changed', 'op.note.annotate.shapes', { count: written.length }),
          note('warning', 'op.note.annotate.shapesPerspective'),
        ],
        inputBytes: bytes.byteLength,
        outputBytes: saved.byteLength,
        pageCount: pages.length,
        incremental: false,
      },
    };
  } finally {
    doc.destroy();
  }
}

export interface NotesOutcome extends OperationOutcome {
  /** Marker lines of the notes appended. */
  readonly written: readonly string[];
}

/** A note's icon never fades below this: a note nobody can find is no note at all. */
const NOTE_MIN_OPACITY = 0.6;

/**
 * Append one sticky note (`/Text`) per note mark, with an icon the reader paints.
 *
 * A note used to go through the engine as an **empty** `/FreeText`, whose appearance
 * types `()`: the comment survived in `/Contents`, but nothing was drawn, so the note was
 * invisible in every other reader and in the app itself once the file was reopened. A
 * `/Text` annotation is what a PDF calls a note — readers list it with the comments and
 * open its `/Contents` on click — and the icon is drawn here as an appearance stream,
 * because a reader that finds no `/AP` draws its own icon or nothing at all.
 */
export async function writeNoteAnnotations(
  bytes: Uint8Array,
  marks: readonly AnnotationMark[],
  context: OperationContext,
): Promise<NotesOutcome> {
  const notes = marks.filter((mark) => mark.kind === 'note');
  if (notes.length === 0) return { ...nothingToDo(bytes, 'notes'), written: [] };

  const { doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    const written: string[] = [];
    try {
      for (const mark of notes) {
        throwIfAborted(context.signal);
        const page = pages[mark.pageIndex];
        if (page === undefined) {
          throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex: mark.pageIndex });
        }
        const crop = visibleBox(page);
        const rect = markRect({ ...mark, thickness: 0 }, crop.y + crop.height);
        const width = (rect[2] ?? 0) - (rect[0] ?? 0);
        const height = (rect[3] ?? 0) - (rect[1] ?? 0);
        const opacity = Math.max(mark.opacity, NOTE_MIN_OPACITY);
        const appearance = doc.addStream(noteAppearance(width, height, hexToRgb(mark.color)), {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, width, height],
          Matrix: [1, 0, 0, 1, 0, 0],
          Resources: { ExtGState: { GS0: { Type: 'ExtGState', CA: opacity, ca: opacity } } },
        });
        const dict = doc.addObject({
          ...commonFields(doc, page, mark),
          Subtype: 'Text',
          Name: 'Comment',
          Open: false,
          Rect: rect,
          C: [...hexToRgb(mark.color)],
          CA: opacity,
          AP: { N: appearance },
        });
        attach(doc, page, dict);
        written.push(markerFor(mark.id));
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'annotations.notes');
    }

    const saved = saveRewrite(doc, 'annotations.notes');
    return {
      bytes: saved,
      written,
      report: {
        engine: 'mupdf',
        steps: ['load', 'annotations.notes', 'save'],
        notes: [note('changed', 'op.note.annotate.notes', { count: written.length })],
        inputBytes: bytes.byteLength,
        outputBytes: saved.byteLength,
        pageCount: pages.length,
        incremental: false,
      },
    };
  } finally {
    doc.destroy();
  }
}

/**
 * A note's icon in annotation space: a sheet in the mark's colour with its top-right
 * corner folded, outlined dark enough to read on any page, and three lines of "text".
 */
function noteAppearance(width: number, height: number, color: readonly number[]): string {
  const num = (value: number) => value.toFixed(3);
  const inset = 0.75;
  const fold = Math.min(width, height) * 0.3;
  const left = inset;
  const bottom = inset;
  const right = width - inset;
  const top = height - inset;
  const lines: string[] = [];
  for (const share of [0.62, 0.45, 0.28]) {
    const y = num(height * share);
    lines.push(
      `${num(width * 0.2)} ${y} ${OP.MoveTo}`,
      `${num(width * (share > 0.6 ? 0.55 : 0.75))} ${y} ${OP.LineTo}`,
    );
  }
  return [
    `/GS0 ${OP.SetGraphicsState}`,
    `${num(color[0] ?? 1)} ${num(color[1] ?? 1)} ${num(color[2] ?? 0)} rg`,
    `0.25 0.25 0.25 ${OP.StrokingColorRgb}`,
    `1 ${OP.SetLineWidth}`,
    `1 ${OP.SetLineJoinStyle}`,
    `${num(left)} ${num(bottom)} ${OP.MoveTo}`,
    `${num(right)} ${num(bottom)} ${OP.LineTo}`,
    `${num(right)} ${num(top - fold)} ${OP.LineTo}`,
    `${num(right - fold)} ${num(top)} ${OP.LineTo}`,
    `${num(left)} ${num(top)} ${OP.LineTo}`,
    `${OP.ClosePath} B`,
    `${num(right - fold)} ${num(top)} ${OP.MoveTo}`,
    `${num(right - fold)} ${num(top - fold)} ${OP.LineTo}`,
    `${num(right)} ${num(top - fold)} ${OP.LineTo}`,
    OP.StrokePath,
    `0.75 ${OP.SetLineWidth}`,
    ...lines,
    OP.StrokePath,
    '',
  ].join('\n');
}

/** The fields every annotation this module writes carries, as MuPDF values. */
function commonFields(doc: PDFDocument, page: PDFObject, mark: AnnotationMark): Record<string, unknown> {
  return {
    Type: 'Annot',
    P: page,
    // Print flag on, so an exported file prints what the screen shows.
    F: 4,
    Border: [0, 0, 0],
    T: text(doc, mark.author),
    M: text(doc, pdfDate(new Date(mark.createdAt))),
    Contents: text(doc, contentsFor(mark)),
  };
}

/** Append one annotation to the page's `/Annots`, creating the array when absent. */
function attach(doc: PDFDocument, page: PDFObject, annotation: PDFObject): void {
  annotsOf(doc, page, true)?.push(annotation);
}

/** A step that had nothing to write: same bytes, and the report says so. */
function nothingToDo(bytes: Uint8Array, step: string): OperationOutcome {
  return {
    bytes,
    report: {
      engine: 'mupdf',
      steps: [`annotations.${step}.skipped`],
      notes: [note('warning', 'op.note.annotate.nothing')],
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount: 0,
      incremental: true,
    },
  };
}

/** The `/L` line for a line annotation, in PDF user space, in drag order. */
function lineEndpoints(box: MarkBox, pageTop: number): readonly number[] {
  return [box[0], pageTop - box[1], box[2], pageTop - box[3]];
}

/**
 * The appearance stream of one shape, in annotation space.
 *
 * The content is written as operator text rather than through an engine's
 * `PDFOperator` builders: the builders produce the same bytes from the same enum,
 * but a concatenated string keeps the whole drawing visible in one place next to
 * the PDF 32000-2 table it comes from, and a shape's appearance needs no
 * resources of its own (the colour is a literal in the stream).
 *
 * `box` is the module's page space (top-left origin), `rect` the annotation's PDF
 * rect, so the flip is `v = pageTop - yPage - rectBottom`.
 * The Rect is padded by half the stroke: do not inset the intended path again.
 */
function shapeAppearance(
  subtype: string,
  box: MarkBox,
  rect: readonly number[],
  pageTop: number,
  stroke: number,
  mark: AnnotationMark,
): string {
  const rectLeft = rect[0] ?? 0;
  const rectBottom = rect[1] ?? 0;
  const left = Math.min(box[0], box[2]) - rectLeft;
  const right = Math.max(box[0], box[2]) - rectLeft;
  const top = pageTop - Math.min(box[1], box[3]) - rectBottom;
  const bottom = pageTop - Math.max(box[1], box[3]) - rectBottom;
  const [red, green, blue] = hexToRgb(mark.color);
  const num = (value: number) => value.toFixed(3);

  const header = [
    `/GS0 ${OP.SetGraphicsState}`,
    `${num(stroke)} ${OP.SetLineWidth}`,
    `1 ${OP.SetLineCapStyle}`,
    `${num(red)} ${num(green)} ${num(blue)} ${OP.StrokingColorRgb}`,
    '',
  ].join('\n');

  if (subtype === 'Circle') {
    const cx = (left + right) / 2;
    const cy = (bottom + top) / 2;
    const rx = Math.abs(right - left) / 2;
    const ry = Math.abs(top - bottom) / 2;
    const vertical = KAPPA * ry;
    const horizontal = KAPPA * rx;
    const curve = (a: number[]) =>
      `${num(a[0] ?? 0)} ${num(a[1] ?? 0)} ${num(a[2] ?? 0)} ${num(a[3] ?? 0)} ${num(a[4] ?? 0)} ${num(a[5] ?? 0)} ${OP.AppendBezierCurve}`;
    return [
      header,
      `${num(cx - rx)} ${num(cy)} ${OP.MoveTo}`,
      curve([cx - rx, cy + vertical, cx - horizontal, cy + ry, cx, cy + ry]),
      curve([cx + horizontal, cy + ry, cx + rx, cy + vertical, cx + rx, cy]),
      curve([cx + rx, cy - vertical, cx + horizontal, cy - ry, cx, cy - ry]),
      curve([cx - horizontal, cy - ry, cx - rx, cy - vertical, cx - rx, cy]),
      OP.ClosePath,
      OP.StrokePath,
      '',
    ].join('\n');
  }

  if (subtype === 'Line') {
    const endpoints = lineEndpoints(box, pageTop);
    const x0 = (endpoints[0] ?? 0) - rectLeft;
    const y0 = (endpoints[1] ?? 0) - rectBottom;
    const x1 = (endpoints[2] ?? 0) - rectLeft;
    const y1 = (endpoints[3] ?? 0) - rectBottom;
    return [
      header,
      `${num(x0)} ${num(y0)} ${OP.MoveTo}`,
      `${num(x1)} ${num(y1)} ${OP.LineTo}`,
      OP.StrokePath,
      '',
    ].join('\n');
  }

  return [
    header,
    `${num(left)} ${num(bottom)} ${OP.MoveTo}`,
    `${num(right)} ${num(bottom)} ${OP.LineTo}`,
    `${num(right)} ${num(top)} ${OP.LineTo}`,
    `${num(left)} ${num(top)} ${OP.LineTo}`,
    OP.ClosePath,
    OP.StrokePath,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// the marker's own shape
// ---------------------------------------------------------------------------

export interface HighlightsOutcome extends OperationOutcome {
  /** Marker lines of the annotations appended. */
  readonly written: readonly string[];
}

/**
 * Append one `/Highlight` per mark that carries a stroke — the marker.
 *
 * ## Why this is not the engine's highlight writer
 *
 * pdf.js writes a highlight by *filling* polygons: a text selection's line boxes,
 * and for a free highlight the band its outliner built. A marker stroke handed to
 * that writer would arrive as its bounding box and be painted as one solid
 * rectangle over everything the pointer crossed. So the dictionary and the
 * appearance are built here, and the appearance is the stroke itself:
 *
 *  - `/Subtype /Highlight` — the mark keeps its kind, so it reads back as the
 *    highlight it is rather than as ink;
 *  - the path is stroked with round caps and joins at the mark's width, which is
 *    continuous by construction: the painted result no longer depends on how
 *    densely the outliner sampled the pointer;
 *  - `/BM /Multiply` (an `/ExtGState` the appearance selects with `gs`) is what
 *    lets dark text stay readable under the band, and what keeps a crossing
 *    stroke from darkening where it overlaps itself;
 *  - `/QuadPoints` follows the path — one quad per drawn segment, padded by half
 *    the stroke — so a reader's hit test and this module's own read-back see the
 *    band's shape rather than a page-sized box.
 *
 * The opacity is written twice, exactly as the engine's own highlight writer does
 * (`HighlightAnnotation.createNewAppearanceStream`, `build/pdf.worker.mjs`): on the
 * annotation's `/CA`, and as `ca`/`CA` in the appearance's `/ExtGState`. Once an
 * `/AP` is present the annotation's `/CA` is metadata to some readers — the stream
 * is what they paint — so relying on it alone can export an opaque marker.
 */
export async function writeStrokeHighlights(
  bytes: Uint8Array,
  marks: readonly AnnotationMark[],
  context: OperationContext,
): Promise<HighlightsOutcome> {
  const markers = marks.filter(isStrokedHighlight);
  if (markers.length === 0) return { ...nothingToDo(bytes, 'highlights'), written: [] };

  const { doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    const written: string[] = [];
    try {
      for (const mark of markers) {
        throwIfAborted(context.signal);
        const page = pages[mark.pageIndex];
        if (page === undefined) {
          throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex: mark.pageIndex });
        }

        const crop = visibleBox(page);
        const pageTop = crop.y + crop.height;
        const stroke = Math.max(mark.thickness ?? 6, 1);
        // Pad the rect by the width actually painted (the shape writer does the
        // same): `markRect` pads by `thickness ?? 0`, so a marker without a stored
        // thickness would clip its own round caps against the form's `/BBox`.
        const rect = markRect({ ...mark, thickness: stroke }, pageTop);
        const opacity = Math.max(mark.opacity, MIN_OPACITY);
        const runs = (mark.strokes ?? []).map((run) => [...run]);
        const quads = markerQuads(runs, pageTop, stroke);
        // `/QuadPoints` is required on a highlight, and a one-point stroke has no
        // segment to follow: the padded rect is the honest answer for it.
        const quadPoints =
          quads.length > 0
            ? quads
            : [
                rect[0] ?? 0,
                rect[3] ?? 0,
                rect[2] ?? 0,
                rect[3] ?? 0,
                rect[0] ?? 0,
                rect[1] ?? 0,
                rect[2] ?? 0,
                rect[1] ?? 0,
              ];
        const [red, green, blue] = hexToRgb(mark.color);

        const appearance = doc.addStream(markerAppearance(runs, rect, pageTop, stroke, [red, green, blue]), {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          BBox: [0, 0, (rect[2] ?? 0) - (rect[0] ?? 0), (rect[3] ?? 0) - (rect[1] ?? 0)],
          Matrix: [1, 0, 0, 1, 0, 0],
          // `Multiply` is what keeps the page's own dark text readable under the
          // band, and what stops a crossing stroke from darkening where it overlaps
          // itself; `ca`/`CA` are the stroke's own alpha, which the stream has to
          // carry because several readers ignore the annotation's `/CA` once an
          // appearance exists (PDF 32000-1 §11.6.4.4).
          Resources: {
            ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', ca: opacity, CA: opacity } },
          },
        });
        const dict = doc.addObject({
          ...commonFields(doc, page, mark),
          Subtype: 'Highlight',
          Rect: rect,
          QuadPoints: quadPoints,
          C: [red, green, blue],
          CA: opacity,
          AP: { N: appearance },
        });
        attach(doc, page, dict);
        written.push(markerFor(mark.id));
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'annotations.highlights');
    }

    const saved = saveRewrite(doc, 'annotations.highlights');
    return {
      bytes: saved,
      written,
      report: {
        engine: 'mupdf',
        steps: ['load', 'annotations.highlights', 'save'],
        notes: [
          note('changed', 'op.note.annotate.highlights', { count: written.length }),
          note('preserved', 'op.note.metadata.producerKept', { producer: PRODUCER_LINE }),
        ],
        inputBytes: bytes.byteLength,
        outputBytes: saved.byteLength,
        pageCount: pages.length,
        incremental: false,
      },
    };
  } finally {
    doc.destroy();
  }
}

/** A segment shorter than this is not worth a quad: the padding already covers it. */
const MIN_QUAD_LENGTH = 0.5;

/**
 * One quad per drawn segment, in PDF user space, upper-left corner first.
 *
 * The quads are the highlight's *geometry*: a reader that ignores the appearance,
 * a hit test and `readAnnotations` all read this and nothing else. Following the
 * path is what makes them a band instead of a box, and segments below
 * `MIN_QUAD_LENGTH` are skipped because each quad is padded by half the stroke
 * width — a gap smaller than that is already covered by its neighbours.
 */
function markerQuads(runs: readonly (readonly number[])[], pageTop: number, stroke: number): number[] {
  const pad = stroke / 2;
  const quads: number[] = [];
  for (const run of runs) {
    for (let index = 0; index + 3 < run.length; index += 2) {
      const x0 = run[index] ?? 0;
      const y0 = run[index + 1] ?? 0;
      const x1 = run[index + 2] ?? 0;
      const y1 = run[index + 3] ?? 0;
      if (Math.hypot(x1 - x0, y1 - y0) < MIN_QUAD_LENGTH) continue;
      const left = Math.min(x0, x1) - pad;
      const right = Math.max(x0, x1) + pad;
      const top = pageTop - Math.min(y0, y1) + pad;
      const bottom = pageTop - Math.max(y0, y1) - pad;
      quads.push(left, top, right, top, left, bottom, right, bottom);
    }
  }
  return quads;
}

/** The marker's appearance: the drawn path, stroked, with `Multiply` across it. */
function markerAppearance(
  runs: readonly (readonly number[])[],
  rect: readonly number[],
  pageTop: number,
  stroke: number,
  color: readonly number[],
): string {
  const rectLeft = rect[0] ?? 0;
  const rectBottom = rect[1] ?? 0;
  const num = (value: number) => value.toFixed(3);
  const buffer = [
    `/GS0 ${OP.SetGraphicsState}`,
    `${num(stroke)} ${OP.SetLineWidth}`,
    `1 ${OP.SetLineCapStyle}`,
    `1 ${OP.SetLineJoinStyle}`,
    `${num(color[0] ?? 0)} ${num(color[1] ?? 0)} ${num(color[2] ?? 0)} ${OP.StrokingColorRgb}`,
  ];
  for (const run of runs) {
    if (run.length < 2) continue;
    let opened = false;
    for (let index = 0; index + 1 < run.length; index += 2) {
      const x = (run[index] ?? 0) - rectLeft;
      const y = pageTop - (run[index + 1] ?? 0) - rectBottom;
      buffer.push(`${num(x)} ${num(y)} ${opened ? OP.LineTo : OP.MoveTo}`);
      opened = true;
    }
    if (opened && run.length === 2) {
      // A lone point is still a mark: repeat it as a zero-length segment, which a
      // round cap paints as the dot the user tapped — without this the annotation
      // exists, its `/QuadPoints` claim the area, and nothing is drawn at all.
      const x = (run[0] ?? 0) - rectLeft;
      const y = pageTop - (run[1] ?? 0) - rectBottom;
      buffer.push(`${num(x)} ${num(y)} ${OP.LineTo}`);
    }
  }
  buffer.push(OP.StrokePath, '');
  return buffer.join('\n');
}

// ---------------------------------------------------------------------------
// the save step
// ---------------------------------------------------------------------------

/**
 * The whole annotation write, in dependency order.
 *
 * Three steps, because the engines own different halves:
 *  1. **Engine step** — text markup and ink go into the document through
 *     `saveDocument()`, which writes the dictionaries and their appearance
 *     streams and keeps the file incremental.
 *  2. **Subtype step** — underline / strikeout / squiggly are the same geometry
 *     under a different `/Subtype`, and the engine only writes `/Highlight`.
 *  3. **Shape step** — squares, circles and lines have no engine writer at all.
 *  4. **Marker step** — a highlight painted as a stroke (the marker) is built
 *     here too, because the engine fills polygons and would paint the stroke's
 *     bounding box.
 *
 * After the rotation step below, the replies and review states the session holds on
 * its marks are written as `/IRT` records (`ops/annotation-review.ts`): a reply needs
 * the reference its comment was given, which only exists once the comment is written.
 *
 * Steps 2 to 4 are MuPDF rewrites, so they end the incremental fast path
 * and the report says so; a session holding only marks the engine
 * can write keeps it.
 *
 * ## Rotation
 *
 * The four steps write each mark's **stored** geometry, and the marks that carry a
 * `rotation` are turned afterwards as a fifth step: their freshly written
 * annotations are resolved to the object references the file gave them
 * (`markerTargets`) and handed to `transformPdfAnnotations`, grouped by their
 * turn. Nothing is baked twice — the unturned copy is what the transform starts
 * from — and annotations the file already carried (`skipIds`) are never targets.
 *
 * That indirection is not optional. There is no universal annotation rotation key:
 * a reader paints its `/AP`, and turning only the fields leaves a text note's glyphs
 * upright, an underline's bar flat and a `/Line`'s diagonal pointing the old way,
 * because those boxes map onto themselves at 90°. Turning the annotation and its
 * appearance together is what makes the export match the screen for a note, a
 * highlight, an ink stroke, a marker, a line or a shape.
 */
export async function writeAnnotationsToFile(
  handle: AnnotationWriteHandle,
  marks: readonly AnnotationMark[],
  context: OperationContext,
  existing: readonly ExistingAnnotation[] = [],
): Promise<OperationOutcome> {
  const present = new Set(annotationIdsOf(existing));
  const markers = marks.filter((mark) => isStrokedHighlight(mark) && !present.has(mark.id));
  const engineMarks = marks.filter(
    (mark) =>
      mark.kind !== 'shapes' &&
      mark.kind !== 'freetext' &&
      mark.kind !== 'note' &&
      !isStrokedHighlight(mark) &&
      !present.has(mark.id),
  );
  const shapes = marks.filter((mark) => mark.kind === 'shapes' && !present.has(mark.id));
  const stickies = marks.filter((mark) => mark.kind === 'note' && !present.has(mark.id));
  // Typed text is written with its own font and appearance (`annotation-freetext.ts`);
  // a box the user left empty is not a mark and is not written.
  const texts = marks.filter(
    (mark) => mark.kind === 'freetext' && mark.contents.trim() !== '' && !present.has(mark.id),
  );
  const steps: string[] = [];
  const notes: OperationNote[] = [];

  if (
    engineMarks.length === 0 &&
    shapes.length === 0 &&
    stickies.length === 0 &&
    markers.length === 0 &&
    texts.length === 0
  ) {
    const bytes = await handle.saveDocument();
    return {
      bytes,
      report: {
        engine: 'pdfjs',
        steps: [],
        notes: [note('warning', 'op.note.annotate.nothing')],
        inputBytes: bytes.byteLength,
        outputBytes: bytes.byteLength,
        pageCount: handle.pageCount,
        incremental: true,
      },
    };
  }

  let bytes: Uint8Array;
  if (engineMarks.length > 0) {
    const written = await writeAnnotations(
      handle,
      { marks: engineMarks, skipIds: annotationIdsOf(existing) },
      context,
    );
    bytes = written.bytes;
    steps.push(...written.report.steps);
    notes.push(...written.report.notes);

    const retagged = await retagTextMarkup(bytes, engineMarks, context);
    bytes = retagged.bytes;
    steps.push(...retagged.report.steps);
    notes.push(...retagged.report.notes);
  } else {
    bytes = await handle.saveDocument();
  }

  if (shapes.length > 0) {
    const shaped = await writeShapeAnnotations(bytes, shapes, context);
    bytes = shaped.bytes;
    steps.push(...shaped.report.steps);
    notes.push(...shaped.report.notes);
  }

  if (stickies.length > 0) {
    const stuck = await writeNoteAnnotations(bytes, stickies, context);
    bytes = stuck.bytes;
    steps.push(...stuck.report.steps);
    notes.push(...stuck.report.notes);
  }

  if (texts.length > 0) {
    const typed = await writeFreeTextAnnotations(bytes, texts, context);
    bytes = typed.bytes;
    steps.push(...typed.report.steps);
    notes.push(...typed.report.notes);
  }

  if (markers.length > 0) {
    const marked = await writeStrokeHighlights(bytes, markers, context);
    bytes = marked.bytes;
    steps.push(...marked.report.steps);
    notes.push(...marked.report.notes);
  }

  const turned = marks.filter((mark) => (mark.rotation ?? 0) !== 0 && !present.has(mark.id));
  if (turned.length > 0) {
    const targets = await markerTargets(bytes, turned, context);
    const resolved = new Set(targets.map((target) => target.markId));
    if (turned.some((mark) => !resolved.has(mark.id))) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: 'a written mark could not be resolved for its requested rotation',
      });
    }
    const groups = new Map<QuarterTurn, { pageIndex: number; id: string }[]>();
    for (const target of targets) {
      const mark = turned.find((candidate) => candidate.id === target.markId);
      if (mark === undefined) continue;
      const rotation: QuarterTurn = mark.rotation ?? 0;
      const group = groups.get(rotation) ?? [];
      group.push(target);
      groups.set(rotation, group);
    }
    for (const [rotation, group] of groups) {
      throwIfAborted(context.signal);
      const applied = await transformPdfAnnotations(
        bytes,
        { targets: group, transform: { dx: 0, dy: 0, rotation } },
        context,
      );
      bytes = applied.bytes;
      steps.push(...applied.report.steps);
      notes.push(...applied.report.notes);
    }
  }

  const answered = marks.filter(
    (mark) =>
      !present.has(mark.id) &&
      ((mark.replies?.length ?? 0) > 0 || (mark.review !== undefined && mark.review.state !== 'None')),
  );
  if (answered.length > 0) {
    const targets = await markerTargets(bytes, answered, context);
    const records: ReviewRecordRequest[] = [];
    for (const mark of answered) {
      const target = targets.find((candidate) => candidate.markId === mark.id);
      if (target === undefined) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `the comment ${mark.id} could not be resolved for its replies`,
        });
      }
      const base = { pageIndex: target.pageIndex, parentId: target.id } as const;
      for (const reply of mark.replies ?? []) {
        records.push({
          ...base,
          kind: 'reply',
          id: reply.id,
          author: reply.author,
          createdAt: reply.createdAt,
          contents: reply.contents,
        });
      }
      if (mark.review !== undefined && mark.review.state !== 'None') {
        records.push({
          ...base,
          kind: 'state',
          id: `${mark.id}-state`,
          author: mark.review.author,
          createdAt: mark.review.at,
          state: mark.review.state,
        });
      }
    }
    // Loaded here, not at the top: most saves carry no reply, and the entry chunk stays lean.
    const { writeCommentReview } = await import('./annotation-review');
    const reviewed = await writeCommentReview(bytes, records, context);
    bytes = reviewed.bytes;
    steps.push(...reviewed.report.steps);
    notes.push(...reviewed.report.notes);
  }

  return {
    bytes,
    report: {
      engine:
        shapes.length > 0 ||
        markers.length > 0 ||
        texts.length > 0 ||
        turned.length > 0 ||
        answered.length > 0
          ? 'mupdf'
          : 'pdfjs',
      steps,
      notes,
      inputBytes: handle.pageCount === 0 ? 0 : bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount: handle.pageCount,
      incremental:
        shapes.length === 0 &&
        markers.length === 0 &&
        texts.length === 0 &&
        turned.length === 0 &&
        answered.length === 0 &&
        !engineMarks.some((mark) => OWNED_KINDS.includes(mark.kind)),
    },
  };
}

/** Kept for callers that only need the `/Subtype` vocabulary. */
export function ownedSubtypeFor(kind: AnnotationMark['kind']): string | null {
  return SHAPE_SUBTYPES[kind] ?? null;
}
