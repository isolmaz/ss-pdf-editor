/**
 * Moving and turning annotations: the pure geometry the planner shares, and the
 * persisted writer that has to turn a *real* file.
 *
 * The PDF cases are the ones that matter, because the pure helpers cannot tell a
 * correct transform from a plausible one: a rect that swapped its extents proves
 * nothing about a note's glyphs, an underline's bar or a diagonal `/L`. So the
 * fixture carries a `/FreeText` note with a visible string in its appearance, a
 * diagonal `/Line`, an `/Ink` stroke, two highlights **sharing one appearance
 * stream**, a form field with a value and a `/Popup` beside the note — and the
 * expectations are computed from what the file had, through the same public
 * helpers the renderer and the planner use.
 */
import type { PDFDocument, PDFObject } from 'mupdf';
import { ColorSpace, Document as RasterDocument, PDFDocument as RasterPdfDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { writeStrokeHighlights } from './annotation-shapes';
import {
  annotationBounds,
  type MarkTransform,
  transformAnnotationMark,
  transformPdfAnnotations,
  transformPoint,
} from './annotation-transform';
import type { AnnotationMark, MarkBox } from './annotations';
import type { OperationContext } from './types';

const CONTEXT: OperationContext = { signal: new AbortController().signal };

/** The fixture's page; `PAGE_HEIGHT` is the top edge every ordinate flips through. */
const PAGE_HEIGHT = 500;

const STEPS = ['load', 'annotations.transform', 'save', 'verify'];

/** A highlight over text, one quad per line run. */
function highlightMark(overrides: Partial<AnnotationMark> = {}): AnnotationMark {
  return {
    id: 'mark-1',
    kind: 'highlight',
    pageIndex: 0,
    quads: [[10, 20, 60, 30]],
    color: '#ffd400',
    opacity: 0.4,
    contents: '',
    author: '',
    createdAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// the pure geometry
// ---------------------------------------------------------------------------

describe('transformPoint', () => {
  /** A 10×20 box: its centre is (5, 10), which is the pivot of every turn. */
  const BOUNDS: MarkBox = [0, 0, 10, 20];

  it('turns clockwise about the bounds centre, then offsets, in a y-down space', () => {
    // Right of the centre ends up *below* it after a clockwise quarter turn in a
    // space whose y grows downward: (10, 10) → (5, 15).
    expect(transformPoint({ x: 10, y: 10 }, BOUNDS, { dx: 0, dy: 0, rotation: 90 })).toEqual({
      x: 5,
      y: 15,
    });
    expect(transformPoint({ x: 10, y: 10 }, BOUNDS, { dx: 0, dy: 0, rotation: 180 })).toEqual({
      x: 0,
      y: 10,
    });
    expect(transformPoint({ x: 10, y: 10 }, BOUNDS, { dx: 0, dy: 0, rotation: 270 })).toEqual({
      x: 5,
      y: 5,
    });
    // The offset is applied after the turn, so it is a plain page-space nudge.
    expect(transformPoint({ x: 10, y: 10 }, BOUNDS, { dx: 5, dy: -2, rotation: 90 })).toEqual({
      x: 10,
      y: 13,
    });
    expect(transformPoint({ x: 10, y: 10 }, BOUNDS, { dx: 5, dy: -2, rotation: 0 })).toEqual({
      x: 15,
      y: 8,
    });
  });

  it('refuses a turn that is not a quarter', () => {
    expect(() => transformPoint({ x: 0, y: 0 }, BOUNDS, { dx: 0, dy: 0, rotation: 45 as 0 })).toThrow();
  });
});

describe('annotationBounds', () => {
  it('is the box around the stored geometry: quads, a rect or every stroke point', () => {
    expect(annotationBounds(highlightMark())).toEqual([10, 20, 60, 30]);
    expect(annotationBounds(highlightMark({ kind: 'ink', quads: [], strokes: [[5, 5, 40, 25]] }))).toEqual([
      5, 5, 40, 25,
    ]);
    expect(annotationBounds(highlightMark({ kind: 'shapes', quads: [], rect: [2, 3, 4, 9] }))).toEqual([
      2, 3, 4, 9,
    ]);
  });

  it('refuses a mark with no geometry at all', () => {
    expect(() => annotationBounds(highlightMark({ quads: [], rect: undefined }))).toThrow();
  });
});

describe('transformAnnotationMark', () => {
  it('moves the stored points and carries the turn in rotation, never both', () => {
    const moved = transformAnnotationMark(highlightMark(), { dx: 3, dy: -4, rotation: 90 });
    // The quads are translated, not turned: the overlay applies `rotation` itself.
    expect(moved.quads).toEqual([[13, 16, 63, 26]]);
    expect(moved.rotation).toBe(90);

    // A second turn accumulates, and landing back on 0 leaves no key behind.
    const twice = transformAnnotationMark(moved, { dx: 0, dy: 0, rotation: 270 });
    expect(twice.rotation).toBeUndefined();
    expect('rotation' in twice).toBe(false);

    // Strokes move point by point, and the original mark is never written to.
    const ink = transformAnnotationMark(highlightMark({ kind: 'ink', quads: [], strokes: [[1, 2, 3, 4]] }), {
      dx: 1,
      dy: 1,
      rotation: 0,
    });
    expect(ink.strokes).toEqual([[2, 3, 4, 5]]);
    expect(ink.quads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the persisted writer
// ---------------------------------------------------------------------------

/** A written file, opened with MuPDF's object model. The caller destroys it. */
function open(bytes: Uint8Array): PDFDocument {
  return new RasterPdfDocument(bytes.slice());
}

/** The id a page lists for the annotation carrying this comment, in pdf.js spelling. */
function idOf(doc: PDFDocument, pageIndex: number, comment: string): string {
  for (const [id, dict] of annotationsOf(doc, pageIndex)) {
    if (textOf(dict.get('Contents')) === comment) return id;
  }
  throw new Error(`the fixture carries no annotation commented ${JSON.stringify(comment)}`);
}

/** Every annotation of a page as `[reference id, dictionary]`. */
function annotationsOf(doc: PDFDocument, pageIndex: number): readonly (readonly [string, PDFObject])[] {
  const annots = doc.findPage(pageIndex).get('Annots');
  const found: (readonly [string, PDFObject])[] = [];
  if (annots.isNull()) return found;
  const array = annots.resolve();
  for (let position = 0; position < array.length; position += 1) {
    const entry = array.get(position);
    if (!entry.isIndirect()) continue;
    found.push([`${entry.asIndirect()}R`, entry.resolve()]);
  }
  return found;
}

/** One annotation's dictionary in a given file. */
function dictOf(doc: PDFDocument, pageIndex: number, comment: string): PDFObject {
  for (const [, dict] of annotationsOf(doc, pageIndex)) {
    if (textOf(dict.get('Contents')) === comment) return dict;
  }
  throw new Error(`the produced file carries no annotation commented ${JSON.stringify(comment)}`);
}

/** A string value's text, resolving a reference on the way. */
function textOf(value: PDFObject): string {
  if (value.isNull()) return '';
  const resolved = value.resolve();
  return resolved.isString() ? resolved.asString() : '';
}

/** An array entry's numbers, resolving any references in the way. */
function numbersOf(value: PDFObject): number[] {
  if (value.isNull()) return [];
  const array = value.resolve();
  if (!array.isArray()) return [];
  const numbers: number[] = [];
  for (let index = 0; index < array.length; index += 1) {
    const number = array.get(index).resolve();
    if (number.isNumber()) numbers.push(number.asNumber());
  }
  return numbers;
}

/** A `/Rect` as four numbers, whatever the file spelled. */
function rectOf(dict: PDFObject): [number, number, number, number] {
  const numbers = numbersOf(dict.get('Rect'));
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 0];
}

/** A text field's `/V`, read through the AcroForm by its name. */
function fieldValue(doc: PDFDocument, name: string): string {
  const fields = doc.getTrailer().get('Root', 'AcroForm', 'Fields').resolve();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields.get(index).resolve();
    if (field.get('T').asString() === name) return field.get('V').asString();
  }
  return '';
}

/** A PDF-space rect as the app's top-left-origin bounds (the page's own flip). */
function appBounds(rect: readonly [number, number, number, number]): MarkBox {
  return [rect[0], PAGE_HEIGHT - rect[3], rect[2], PAGE_HEIGHT - rect[1]];
}

/** A flat run of app-space points → the PDF-space `/L` or stroke the file must carry. */
function toPdfPoints(run: readonly number[]): { readonly x: number; readonly y: number }[] {
  const points: { readonly x: number; readonly y: number }[] = [];
  for (let index = 0; index + 1 < run.length; index += 2) {
    points.push({ x: run[index] ?? 0, y: PAGE_HEIGHT - (run[index + 1] ?? 0) });
  }
  return points;
}

/** An appearance form whose BBox maps onto its rect at scale 1. */
function appearance(doc: PDFDocument, box: MarkBox, content: string, font?: PDFObject): PDFObject {
  return doc.addStream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, box[2] - box[0], box[3] - box[1]],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: font === undefined ? {} : { Font: { Helv: font } },
  });
}

/**
 * One page with every kind a transform has to handle — and beside them what it
 * must not touch: a form field with a value, a comment's popup, a square, and a
 * second highlight sharing the first one's appearance stream.
 */
async function annotatedDocument(): Promise<Uint8Array> {
  const doc = new RasterPdfDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  doc.insertPage(
    0,
    doc.addPage(
      [0, 0, 400, PAGE_HEIGHT],
      0,
      { Font: { Helv: font } },
      'BT /Helv 18 Tf 40 460 Td (Alpha page) Tj ET',
    ),
  );
  const page = doc.findPage(0);
  page.put('Annots', []);

  const attach = (dict: Record<string, unknown>): PDFObject => {
    const ref = doc.addObject(dict);
    page.get('Annots').push(ref);
    return ref;
  };
  // Comments as indirect strings, the shape a producer that shares them writes.
  const contents = (value: string): PDFObject => doc.addObject(doc.newString(value));
  const shared = appearance(doc, [0, 0, 160, 30], '0 1 0 rg 0 0 160 30 re f');

  attach({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [40, 400, 200, 430],
    QuadPoints: [40, 430, 200, 430, 40, 400, 200, 400],
    Contents: contents('turn highlight'),
    C: [1, 1, 0],
    CA: 0.5,
    F: 4,
    AP: { N: shared },
  });
  attach({
    Type: 'Annot',
    Subtype: 'Ink',
    Rect: [40, 300, 200, 340],
    InkList: [[50, 310, 90, 330, 130, 310]],
    BS: { W: 3 },
    Contents: contents('turn ink'),
    F: 4,
  });
  attach({
    Type: 'Annot',
    Subtype: 'Line',
    Rect: [40, 100, 200, 140],
    L: [50, 110, 190, 130],
    Contents: contents('turn line'),
    F: 4,
    AP: { N: appearance(doc, [0, 0, 160, 40], '0 0 1 RG 2 w 0 20 m 160 0 l S') },
  });
  const note = attach({
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: [40, 60, 160, 90],
    Contents: contents('turn note'),
    DA: doc.newString('/Helv 10 Tf 0 g'),
    F: 4,
    AP: { N: appearance(doc, [0, 0, 120, 30], 'BT /Helv 10 Tf 2 2 Td (Note text) Tj ET', font) },
  });
  const popup = attach({
    Type: 'Annot',
    Subtype: 'Popup',
    Rect: [40, 60, 160, 110],
    Parent: note,
    Contents: contents('turn note popup'),
    F: 4,
  });
  note.put('Popup', popup);

  attach({
    Type: 'Annot',
    Subtype: 'Square',
    Rect: [250, 400, 330, 460],
    Contents: contents('keep square'),
    F: 4,
  });
  attach({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [250, 340, 360, 370],
    QuadPoints: [250, 370, 360, 370, 250, 340, 360, 340],
    Contents: contents('keep highlight'),
    F: 4,
    AP: { N: shared },
  });

  // A text field whose dictionary is its widget, with a value and an appearance.
  const field = attach({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Tx',
    T: doc.newString('customer'),
    V: doc.newString('Ada Lovelace'),
    DA: doc.newString('/Helv 12 Tf 0 g'),
    Rect: [40, 20, 220, 40],
    P: page,
    F: 4,
    AP: {
      N: appearance(doc, [0, 0, 180, 20], '/Tx BMC BT /Helv 12 Tf 2 5 Td (Ada Lovelace) Tj ET EMC', font),
    },
  });
  doc
    .getTrailer()
    .get('Root')
    .put('AcroForm', { Fields: [field], DR: { Font: { Helv: font } } });

  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** The refusal a request must produce; a request that succeeds is a failure here. */
async function refusalOf(
  bytes: Uint8Array,
  targets: readonly { readonly pageIndex: number; readonly id: string }[],
  transform: MarkTransform,
): Promise<ToolError> {
  try {
    const outcome = await transformPdfAnnotations(bytes, { targets, transform }, CONTEXT);
    throw new Error(`the transform was accepted and produced ${outcome.bytes.byteLength} bytes`);
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
}

/** Render the appearance a PDF consumer sees, not the writer's chosen wrapper layout. */
function rasterAnnotation(bytes: Uint8Array, comment: string) {
  const document = new RasterPdfDocument(bytes);
  const page = document.loadPage(0);
  const annotations = page.getAnnotations();
  try {
    const annotation = annotations.find((value) => value.getContents() === comment);
    if (annotation === undefined) throw new Error(`missing annotation: ${comment}`);
    const pixmap = annotation.toPixmap([1, 0, 0, 1, 0, 0], ColorSpace.DeviceRGB, true);
    try {
      return {
        width: pixmap.getWidth(),
        height: pixmap.getHeight(),
        components: pixmap.getNumberOfComponents(),
        pixels: pixmap.getPixels().slice(),
      };
    } finally {
      pixmap.destroy();
    }
  } finally {
    for (const annotation of annotations) annotation.destroy();
    page.destroy();
    document.destroy();
  }
}

describe('transformPdfAnnotations', () => {
  it('turns the geometry AND the appearance of every kind, and leaves the rest of the file alone', async () => {
    const bytes = await annotatedDocument();
    const before = open(bytes);
    const first = 0;
    const highlightId = idOf(before, first, 'turn highlight');
    const inkId = idOf(before, first, 'turn ink');
    const lineId = idOf(before, first, 'turn line');
    const noteId = idOf(before, first, 'turn note');
    const widgetId = idOf(before, first, '');
    const popupId = idOf(before, first, 'turn note popup');

    const transform: MarkTransform = { dx: 5, dy: -7, rotation: 90 };
    const targets = [
      { pageIndex: 0, id: highlightId },
      { pageIndex: 0, id: inkId },
      { pageIndex: 0, id: lineId },
      { pageIndex: 0, id: noteId },
    ];
    const outcome = await transformPdfAnnotations(bytes, { targets, transform }, CONTEXT);

    expect(outcome.transformed).toEqual([highlightId, inkId, lineId, noteId]);
    expect(outcome.report.engine).toBe('mupdf');
    expect(outcome.report.steps).toEqual(STEPS);
    expect(outcome.report.incremental).toBe(false);
    expect(outcome.report.pageCount).toBe(1);
    expect(outcome.report.notes).toContainEqual({
      kind: 'changed',
      key: 'ann.transformed',
      params: { count: targets.length },
    });
    expect(outcome.bytes).not.toBe(bytes);

    const after = open(outcome.bytes);
    const produced = 0;
    const rectIn = (doc: PDFDocument, page: number, comment: string) => rectOf(dictOf(doc, page, comment));

    for (const comment of ['turn highlight', 'turn ink', 'turn line', 'turn note']) {
      const [wasX0, wasY0, wasX1, wasY1] = rectIn(before, first, comment);
      const [nowX0, nowY0, nowX1, nowY1] = rectIn(after, produced, comment);
      // The turn is about each annotation's own box centre, so the centre moves by
      // the offset alone — and a quarter turn swaps the box's extents.
      expect((nowX0 + nowX1) / 2, `${comment} centre x`).toBeCloseTo((wasX0 + wasX1) / 2 + transform.dx, 3);
      expect((nowY0 + nowY1) / 2, `${comment} centre y`).toBeCloseTo((wasY0 + wasY1) / 2 - transform.dy, 3);
      expect(nowX1 - nowX0, `${comment} width`).toBeCloseTo(wasY1 - wasY0, 3);
      expect(nowY1 - nowY0, `${comment} height`).toBeCloseTo(wasX1 - wasX0, 3);
    }

    // A diagonal `/L` and an ink stroke are geometry the public helper predicts
    // exactly: read it from the file, convert to the app's space, turn it, convert
    // back. A transform that only swapped the box would leave both pointing the old
    // way — which is the whole reason this case exists.
    const lineRun = numbersOf(dictOf(before, first, 'turn line').get('L'));
    const expectedLine = toPdfPoints(lineRun).flatMap((point) => {
      const turned = transformPoint(point, appBounds(rectIn(before, first, 'turn line')), transform);
      return [turned.x, PAGE_HEIGHT - turned.y];
    });
    expect(numbersOf(dictOf(after, produced, 'turn line').get('L')).map(round3)).toEqual(
      expectedLine.map(round3),
    );

    const inkRun = numbersOf(dictOf(before, first, 'turn ink').get('InkList').resolve().get(0));
    const inkBounds = appBounds(rectIn(before, first, 'turn ink'));
    const expectedInk: number[] = [];
    for (let index = 0; index + 1 < inkRun.length; index += 2) {
      const turned = transformPoint(
        { x: inkRun[index] ?? 0, y: PAGE_HEIGHT - (inkRun[index + 1] ?? 0) },
        inkBounds,
        transform,
      );
      expectedInk.push(turned.x, PAGE_HEIGHT - turned.y);
    }
    const inkAfter = dictOf(after, produced, 'turn ink').get('InkList').resolve().get(0);
    expect(numbersOf(inkAfter).map(round3)).toEqual(expectedInk.map(round3));

    // Rotating the rectangle but leaving the note's text or line upright must fail.
    // MuPDF renders the independent reader's result; a transform may live in an
    // appearance matrix OR its content stream, neither representation is prescribed.
    for (const comment of ['turn note', 'turn line']) {
      const oldRaster = rasterAnnotation(bytes, comment);
      const newRaster = rasterAnnotation(outcome.bytes, comment);
      expect(newRaster.width).toBe(oldRaster.height);
      expect(newRaster.height).toBe(oldRaster.width);
      expect(newRaster.components).toBe(oldRaster.components);
      let difference = 0;
      let energy = 0;
      for (let y = 0; y < oldRaster.height; y += 1) {
        for (let x = 0; x < oldRaster.width; x += 1) {
          for (let channel = 0; channel < oldRaster.components; channel += 1) {
            const expected =
              oldRaster.pixels[(y * oldRaster.width + x) * oldRaster.components + channel] ?? 0;
            const actual =
              newRaster.pixels[
                (x * newRaster.width + oldRaster.height - 1 - y) * newRaster.components + channel
              ] ?? 0;
            energy += expected;
            difference += Math.abs(actual - expected);
          }
        }
      }
      expect(energy, `${comment} has a real painted appearance`).toBeGreaterThan(1000);
      expect(difference / energy, `${comment} rotates its painted pixels`).toBeLessThan(0.1);
    }
    // The unselected mark shared its appearance with a selected one. It must keep
    // exactly the same pixels, regardless of how the writer stores its references.
    expect(rasterAnnotation(outcome.bytes, 'keep highlight')).toEqual(
      rasterAnnotation(bytes, 'keep highlight'),
    );
    expect(rectIn(after, produced, 'keep highlight')).toEqual(rectIn(before, first, 'keep highlight'));

    // Non-targets, the form and the page itself are untouched.
    expect(rectIn(after, produced, 'keep square')).toEqual(rectIn(before, first, 'keep square'));
    expect(rectIn(after, produced, 'turn note popup')).toEqual(rectIn(before, first, 'turn note popup'));
    expect(after.countPages()).toBe(1);
    expect(fieldValue(after, 'customer')).toBe('Ada Lovelace');
    expect(annotationsOf(after, produced).some(([id]) => id === widgetId)).toBe(true);
    before.destroy();
    after.destroy();

    // Refusals name what cannot be transformed: a field's visible half, a reader's
    // popup window, and a turn that is not a quarter.
    expect((await refusalOf(bytes, [{ pageIndex: 0, id: widgetId }], transform)).code).toBe('unsupported');
    expect((await refusalOf(bytes, [{ pageIndex: 0, id: popupId }], transform)).code).toBe('unsupported');
    expect(
      (await refusalOf(bytes, [{ pageIndex: 0, id: highlightId }], { ...transform, rotation: 45 as 0 })).code,
    ).toBe('unsupported');
  });

  it('resolves a target on the page it names, and only there', async () => {
    const bytes = await annotatedDocument();
    const before = open(bytes);
    const highlightId = idOf(before, 0, 'turn highlight');
    before.destroy();
    const turn: MarkTransform = { dx: 0, dy: 0, rotation: 90 };

    // The id resolves on page 1 and the target says page 2: a stale target fails
    // rather than resolving to whatever shares its id.
    expect((await refusalOf(bytes, [{ pageIndex: 1, id: highlightId }], turn)).code).toBe('range-invalid');
    expect((await refusalOf(bytes, [{ pageIndex: 0, id: '9999R' }], turn)).code).toBe('selection-empty');
    // pdf.js's synthetic id for a directly-stored dictionary is not an address.
    expect((await refusalOf(bytes, [{ pageIndex: 0, id: 'annot_12' }], turn)).code).toBe('unsupported');

    // A request that changes nothing writes nothing.
    const identity = await transformPdfAnnotations(
      bytes,
      { targets: [{ pageIndex: 0, id: highlightId }], transform: { dx: 0, dy: 0, rotation: 0 } },
      CONTEXT,
    );
    expect(identity.bytes).toBe(bytes);
    expect(identity.transformed).toEqual([]);
    expect(identity.report.steps).toEqual([]);
  });
});

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

describe('freehand marker appearance', () => {
  it('paints continuously through the last endpoint at the chosen opacity', async () => {
    const source = new RasterPdfDocument();
    source.insertPage(0, source.addPage([0, 0, 300, 300], 0, {}, ''));
    const sourceBytes = new Uint8Array(source.saveToBuffer('').asUint8Array());
    source.destroy();
    const mark = highlightMark({
      quads: [[50, 100, 250, 100]],
      strokes: [[50, 100, 80, 100, 110, 100, 140, 100, 170, 100, 200, 100, 250, 100]],
      thickness: 20,
      color: '#ffff00',
      opacity: 0.5,
    });
    const outcome = await writeStrokeHighlights(sourceBytes, [mark], CONTEXT);
    const document = RasterDocument.openDocument(outcome.bytes, 'application/pdf');
    const page = document.loadPage(0);
    const pixmap = page.toPixmap([1, 0, 0, 1, 0, 0], ColorSpace.DeviceRGB, false, true);
    try {
      const pixels = pixmap.getPixels();
      for (let x = 52; x < 248; x += 1) {
        const offset = 100 * pixmap.getStride() + x * pixmap.getNumberOfComponents();
        expect(pixels[offset], `red at ${x}`).toBeGreaterThan(240);
        expect(pixels[offset + 1], `green at ${x}`).toBeGreaterThan(240);
        expect(pixels[offset + 2], `blue at ${x}`).toBeGreaterThan(100);
        expect(pixels[offset + 2], `blue at ${x}`).toBeLessThan(150);
      }
    } finally {
      pixmap.destroy();
      page.destroy();
      document.destroy();
    }
  });
});
