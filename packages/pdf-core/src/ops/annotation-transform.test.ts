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
import { generationFivePdf } from './annotation.fixtures';
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

// ---------------------------------------------------------------------------
// untrusted input: transforms and requests that are not what the types promise
// ---------------------------------------------------------------------------

/** A value the types forbid, handed over the way a script or a damaged request would. */
const untyped = (value: unknown): never => value as never;

/** The `ToolError` a synchronous call throws; anything else (or no throw) fails the test. */
function thrownBy(call: () => unknown): ToolError {
  let outcome: { readonly error: unknown } | null = null;
  try {
    call();
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the call returned instead of throwing');
  if (!isToolError(outcome.error)) throw outcome.error;
  return outcome.error;
}

/** The `ToolError` a promise rejects with; anything else (or no rejection) fails the test. */
async function rejectionOf(promise: Promise<unknown>): Promise<ToolError> {
  let outcome: { readonly error: unknown } | null = null;
  try {
    await promise;
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the call resolved instead of rejecting');
  if (!isToolError(outcome.error)) throw outcome.error;
  return outcome.error;
}

const BOUNDS: MarkBox = [0, 0, 10, 20];

describe('a transform that is not two finite offsets and a quarter turn', () => {
  it('refuses a missing, NaN or null offset with the path of the transform', () => {
    for (const transform of [
      { dx: Number.NaN, dy: 0, rotation: 0 },
      { dy: 0, rotation: 0 },
      { dx: 0, rotation: 0 },
      { dx: 0, dy: Number.POSITIVE_INFINITY, rotation: 0 },
      { dx: '3', dy: 0, rotation: 0 },
    ]) {
      const error = thrownBy(() => transformPoint({ x: 1, y: 1 }, BOUNDS, untyped(transform)));
      expect(error.code).toBe('value-out-of-range');
      expect(error.details.path).toBe('request.transform');
    }
    const nothing = thrownBy(() => transformAnnotationMark(highlightMark(), untyped(null)));
    expect(nothing.code).toBe('value-out-of-range');
    expect(nothing.details.engineMessage).toContain('{"dx":null,"dy":null}');
    const missing = thrownBy(() => transformPoint({ x: 1, y: 1 }, BOUNDS, untyped({ dy: 0 })));
    expect(missing.details.engineMessage).toContain('{"dx":null,"dy":0}');
  });

  it('reads a negative or full-circle turn as the quarter it equals and a missing turn as none', () => {
    const at = (rotation: number) =>
      transformPoint({ x: 10, y: 10 }, BOUNDS, { dx: 0, dy: 0, rotation: untyped(rotation) });
    expect(at(-90)).toEqual({ x: 5, y: 5 });
    expect(at(450)).toEqual({ x: 5, y: 15 });
    expect(at(-180)).toEqual({ x: 0, y: 10 });
    expect(transformPoint({ x: 10, y: 10 }, BOUNDS, untyped({ dx: 1, dy: 2 }))).toEqual({ x: 11, y: 12 });
  });

  it('refuses a turn that is NaN, infinite or between quarters, naming where it came from', () => {
    for (const rotation of [Number.NaN, Number.POSITIVE_INFINITY, 45, 90.5]) {
      const error = thrownBy(() =>
        transformPoint({ x: 0, y: 0 }, BOUNDS, { dx: 0, dy: 0, rotation: untyped(rotation) }),
      );
      expect(error.code).toBe('unsupported');
      expect(error.details.path).toBe('request.transform.rotation');
      expect(error.details.engineMessage).toContain(String(rotation));
    }
    // A mark whose own turn is damaged is refused under the mark's path.
    const stored = thrownBy(() =>
      transformAnnotationMark(highlightMark({ rotation: untyped(30) }), { dx: 0, dy: 0, rotation: 90 }),
    );
    expect(stored.details.path).toBe('mark.rotation');
  });
});

describe('transformAnnotationMark on shapes with a rect and odd strokes', () => {
  it('moves a rect as the box around its moved corners, whichever way it was written', () => {
    const moved = transformAnnotationMark(highlightMark({ kind: 'shapes', quads: [], rect: [4, 9, 2, 3] }), {
      dx: 1,
      dy: 1,
      rotation: 0,
    });
    expect(moved.rect).toEqual([3, 4, 5, 10]);
    expect(moved.quads).toEqual([]);
  });

  it('keeps the trailing value of an odd stroke and leaves it out of the bounds', () => {
    const odd = highlightMark({ kind: 'ink', quads: [], strokes: [[5, 5, 40]] });
    expect(annotationBounds(odd)).toEqual([5, 5, 5, 5]);
    expect(transformAnnotationMark(odd, { dx: 1, dy: 2, rotation: 0 }).strokes).toEqual([[6, 7, 40]]);
  });
});

// ---------------------------------------------------------------------------
// planner refusals
// ---------------------------------------------------------------------------

describe('transformPdfAnnotations request planning', () => {
  const TURN: MarkTransform = { dx: 3, dy: 0, rotation: 0 };
  const idOfComment = async (bytes: Uint8Array, comment: string): Promise<string> => {
    const doc = open(bytes);
    try {
      return idOf(doc, 0, comment);
    } finally {
      doc.destroy();
    }
  };

  it('refuses a request without a targets array before touching the file', async () => {
    const bytes = await annotatedDocument();
    for (const request of [
      null,
      undefined,
      {},
      { targets: 'a', transform: TURN },
      { targets: { length: 1 } },
    ]) {
      const error = await rejectionOf(transformPdfAnnotations(bytes, untyped(request), CONTEXT));
      expect(error.code).toBe('internal');
      expect(error.details.path).toBe('request.targets');
    }
  });

  it('refuses a page index that is not a non-negative integer', async () => {
    const bytes = await annotatedDocument();
    const id = await idOfComment(bytes, 'turn ink');
    for (const pageIndex of [-1, 1.5, Number.NaN]) {
      const error = await refusalOf(bytes, [{ pageIndex, id }], TURN);
      expect(error.code).toBe('value-out-of-range');
      expect(error.details.path).toBe('request.targets[0].pageIndex');
    }
  });

  it('refuses an id that is not an object reference, naming the target', async () => {
    const bytes = await annotatedDocument();
    const id = await idOfComment(bytes, 'turn ink');
    const ids: unknown[] = [
      17,
      null,
      '0R',
      'R',
      '99999999999999999999R',
      '1R99999999999999999999',
      'x17R',
      '17R-1',
    ];
    for (const bad of ids) {
      const error = await refusalOf(
        bytes,
        [
          { pageIndex: 0, id },
          { pageIndex: 0, id: untyped(bad) },
        ],
        TURN,
      );
      expect(error.code, String(bad)).toBe('unsupported');
      expect(error.details.path).toBe('request.targets[1].id');
    }
  });

  it('moves a target once however often and however spelled the request names it', async () => {
    const bytes = await annotatedDocument();
    const id = await idOfComment(bytes, 'turn ink');
    const progress: unknown[] = [];
    const outcome = await transformPdfAnnotations(
      bytes,
      {
        targets: [
          { pageIndex: 0, id },
          { pageIndex: 0, id: `  ${id.replace('R', 'R0')}  ` },
          { pageIndex: 0, id },
        ],
        transform: { dx: 0.5, dy: 0, rotation: 0 },
      },
      { ...CONTEXT, onProgress: (event) => progress.push([event.done, event.total]) },
    );
    expect(outcome.transformed).toEqual([id]);
    expect(progress).toEqual([[1, 1]]);
    const before = open(bytes);
    const after = open(outcome.bytes);
    // A fractional offset is a valid nudge; the rect moves by exactly that much.
    const was = rectOf(dictOf(before, 0, 'turn ink'));
    const now = rectOf(dictOf(after, 0, 'turn ink'));
    expect(now).toEqual([was[0] + 0.5, was[1], was[2] + 0.5, was[3]]);
    before.destroy();
    after.destroy();
  });

  it('returns the input untouched for an empty target list or a transform that does nothing', async () => {
    const bytes = await annotatedDocument();
    const id = await idOfComment(bytes, 'turn ink');
    const empty = await transformPdfAnnotations(bytes, { targets: [], transform: TURN }, CONTEXT);
    expect(empty.bytes).toBe(bytes);
    expect(empty.report.notes).toEqual([{ kind: 'warning', key: 'op.note.annotate.nothing' }]);
    const still = await transformPdfAnnotations(
      bytes,
      { targets: [{ pageIndex: 0, id }], transform: { dx: 0, dy: 0, rotation: 0 } },
      CONTEXT,
    );
    expect(still.bytes).toBe(bytes);
  });

  it('refuses a transform that is not finite offsets before reading the file', async () => {
    const bytes = await annotatedDocument();
    const id = await idOfComment(bytes, 'turn ink');
    const error = await rejectionOf(
      transformPdfAnnotations(bytes, { targets: [{ pageIndex: 0, id }], transform: untyped(null) }, CONTEXT),
    );
    expect(error.code).toBe('value-out-of-range');
    expect(error.details.path).toBe('request.transform');
  });

  it('stops at an aborted signal, before the call and from inside the progress callback', async () => {
    const bytes = await annotatedDocument();
    const doc = open(bytes);
    const first = idOf(doc, 0, 'turn ink');
    const second = idOf(doc, 0, 'turn line');
    doc.destroy();
    const targets = [
      { pageIndex: 0, id: first },
      { pageIndex: 0, id: second },
    ];

    const before = new AbortController();
    before.abort();
    await expect(
      transformPdfAnnotations(bytes, { targets, transform: TURN }, { signal: before.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Aborted by the first target's progress event: the second target stops the loop,
    // and the abort is not rewritten into an engine error.
    const midway = new AbortController();
    let events = 0;
    await expect(
      transformPdfAnnotations(
        bytes,
        { targets, transform: TURN },
        {
          signal: midway.signal,
          onProgress: () => {
            events += 1;
            midway.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toBe(1);

    // Aborted by the last target's event: the save is the next thing to stop.
    const last = new AbortController();
    await expect(
      transformPdfAnnotations(
        bytes,
        { targets: [targets[0] as (typeof targets)[number]], transform: TURN },
        { signal: last.signal, onProgress: () => last.abort() },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ---------------------------------------------------------------------------
// odd documents
// ---------------------------------------------------------------------------

interface Builder {
  readonly doc: RasterPdfDocument;
  readonly page: PDFObject;
  /** Add an annotation dictionary to `/Annots` and return its reference. */
  readonly attach: (dict: Record<string, unknown>) => PDFObject;
  readonly stream: (content: string, box?: readonly number[]) => PDFObject;
}

/** A one-page file (400×500) whose annotations the callback adds. */
function pdfWith(build: (builder: Builder) => void): Uint8Array {
  const doc = new RasterPdfDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, PAGE_HEIGHT], 0, {}, '0 g 10 10 20 20 re f'));
  const page = doc.findPage(0);
  page.put('Annots', []);
  build({
    doc,
    page,
    attach: (dict) => {
      const contents = dict.Contents;
      const ref = doc.addObject(
        typeof contents === 'string' ? { ...dict, Contents: doc.newString(contents) } : dict,
      );
      page.get('Annots').push(ref);
      return ref;
    },
    stream: (content, box) =>
      doc.addStream(content, {
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        ...(box === undefined ? {} : { BBox: [...box] }),
      }),
  });
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Move the annotation carrying `comment` (and optionally others) and open the result. */
async function moveComments(
  bytes: Uint8Array,
  comments: readonly string[],
  transform: MarkTransform,
): Promise<{
  readonly before: PDFDocument;
  readonly after: PDFDocument;
  readonly transformed: readonly string[];
}> {
  const before = open(bytes);
  const targets = comments.map((comment) => ({ pageIndex: 0, id: idOf(before, 0, comment) }));
  const outcome = await transformPdfAnnotations(bytes, { targets, transform }, CONTEXT);
  return { before, after: open(outcome.bytes), transformed: outcome.transformed };
}

/** The id of the stream a wrapper form paints, in pdf.js spelling. */
function paintedBy(wrapper: PDFObject): string {
  return `${wrapper.resolve().get('Resources').get('XObject').get('Fm0').asIndirect()}R`;
}

describe('transformPdfAnnotations on unusual appearances', () => {
  it('wraps every state of an appearance state dictionary and keeps what is not a stream', async () => {
    let on = '';
    let off = '';
    let down = '';
    const bytes = pdfWith(({ attach, stream }) => {
      const onStream = stream('1 0 0 rg 0 0 100 50 re f', [0, 0, 100, 50]);
      const offStream = stream('0 0 1 rg 0 0 100 50 re f', [0, 0, 100, 50]);
      const downStream = stream('0 1 0 rg 0 0 100 50 re f', [0, 0, 100, 50]);
      on = `${onStream.asIndirect()}R`;
      off = `${offStream.asIndirect()}R`;
      down = `${downStream.asIndirect()}R`;
      attach({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [100, 100, 200, 150],
        Contents: 'states',
        AP: { N: { On: onStream, Off: offStream, Note: 7 }, D: downStream, R: 3, Extra: 'kept' },
      });
    });
    const { before, after } = await moveComments(bytes, ['states'], { dx: 10, dy: 0, rotation: 0 });
    const ap = dictOf(after, 0, 'states').get('AP');
    const normal = ap.get('N');
    expect(normal.get('Note').asNumber()).toBe(7);
    expect(paintedBy(normal.get('On'))).toBe(on);
    expect(paintedBy(normal.get('Off'))).toBe(off);
    expect(paintedBy(ap.get('D'))).toBe(down);
    // A number where a state dictionary was expected, and a key no reader follows, stay as written.
    expect(ap.get('R').asNumber()).toBe(3);
    expect(ap.get('Extra').asName()).toBe('kept');
    // The wrappers are new streams: the original appearances are still in the file as they were.
    expect(`${normal.get('On').asIndirect()}R`).not.toBe(on);
    expect(rectOf(dictOf(after, 0, 'states'))).toEqual([110, 100, 210, 150]);
    expect(rectOf(dictOf(before, 0, 'states'))).toEqual([100, 100, 200, 150]);
    before.destroy();
    after.destroy();
  });

  it('maps a stream with no BBox, or a zero-width one, as a reader does: 1:1 along a side that has no size', async () => {
    const bytes = pdfWith(({ attach, stream }) => {
      attach({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [100, 100, 200, 150],
        Contents: 'no box',
        AP: { N: stream('0 g 0 0 5 5 re f') },
      });
      attach({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [100, 100, 200, 150],
        Contents: 'flat box',
        AP: { N: stream('0 g 0 0 5 5 re f', [0, 0, 0, 10]) },
      });
      attach({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [100, 100, 200, 150],
        Contents: 'thin box',
        AP: { N: stream('0 g 0 0 5 5 re f', [0, 0, 30, 0]) },
      });
    });
    const { before, after } = await moveComments(bytes, ['no box', 'flat box', 'thin box'], {
      dx: 10,
      dy: 0,
      rotation: 0,
    });
    const wrapperOf = (comment: string) => dictOf(after, 0, comment).get('AP').get('N');
    // The wrapper's space is the new rect's size, anchored at its own origin.
    expect(numbersOf(wrapperOf('no box').get('BBox'))).toEqual([0, 0, 100, 50]);
    expect(wrapperOf('no box').readStream().asString()).toBe('q\n1 0 0 1 -100 -100 cm\n/Fm0 Do\nQ\n');
    // No width → scale 1 across; the height still scales 10 → 50.
    expect(wrapperOf('flat box').readStream().asString()).toBe('q\n1 0 0 5 0 0 cm\n/Fm0 Do\nQ\n');
    // No height → scale 1 down; the width still scales 30 → 100, written to six decimals.
    expect(wrapperOf('thin box').readStream().asString()).toBe('q\n3.333333 0 0 1 0 0 cm\n/Fm0 Do\nQ\n');
    before.destroy();
    after.destroy();
  });

  it('keeps an /AP that is not a dictionary as it was and writes no wrapper for it', async () => {
    const bytes = pdfWith(({ attach }) => {
      attach({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 200, 150], Contents: 'bad ap', AP: 5 });
    });
    const { before, after } = await moveComments(bytes, ['bad ap'], { dx: 4, dy: 0, rotation: 0 });
    expect(dictOf(after, 0, 'bad ap').get('AP').asNumber()).toBe(5);
    expect(rectOf(dictOf(after, 0, 'bad ap'))).toEqual([104, 100, 204, 150]);
    before.destroy();
    after.destroy();
  });
});

describe('transformPdfAnnotations on unusual geometry', () => {
  it("turns odd Vertices, a 6-number QuadPoints and a run the file broke, keeping each one's shape", async () => {
    const bytes = pdfWith(({ doc, attach }) => {
      attach({
        Type: 'Annot',
        Subtype: 'Polygon',
        Rect: [100, 100, 200, 200],
        Vertices: [100, 100, 200, 100, 150],
        Contents: 'odd vertices',
      });
      attach({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [100, 300, 200, 330],
        QuadPoints: [100, 330, 200, 330, 100, 300],
        Contents: 'six quad',
      });
      attach({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [100, 400, 200, 430],
        QuadPoints: [100, 430, doc.newName('x'), 430, 100, 400, 200, 400],
        Contents: 'name quad',
      });
    });
    const { before, after } = await moveComments(bytes, ['odd vertices', 'six quad'], {
      dx: 10,
      dy: 0,
      rotation: 0,
    });
    expect(numbersOf(dictOf(after, 0, 'odd vertices').get('Vertices'))).toEqual([110, 100, 210, 100, 150]);
    expect(numbersOf(dictOf(after, 0, 'six quad').get('QuadPoints'))).toEqual([110, 330, 210, 330, 110, 300]);
    before.destroy();
    after.destroy();

    // A QuadPoints array holding a non-number is not geometry the writer can turn: it stays
    // exactly as the file had it, while the rect (which it can turn) moves.
    const named = await moveComments(bytes, ['name quad'], { dx: 10, dy: 0, rotation: 0 });
    const quad = dictOf(named.after, 0, 'name quad').get('QuadPoints');
    expect(quad.length).toBe(8);
    expect(quad.get(2).asName()).toBe('x');
    expect(rectOf(dictOf(named.after, 0, 'name quad'))).toEqual([110, 400, 210, 430]);
    named.before.destroy();
    named.after.destroy();
  });

  it('leaves an /InkList whose run is not an array exactly as it was', async () => {
    const bytes = pdfWith(({ attach }) => {
      attach({
        Type: 'Annot',
        Subtype: 'Ink',
        Rect: [100, 100, 200, 200],
        InkList: [[100, 100, 200, 200], 7],
        Contents: 'broken ink',
      });
      attach({
        Type: 'Annot',
        Subtype: 'Ink',
        Rect: [100, 300, 200, 400],
        InkList: 4,
        Contents: 'scalar ink',
      });
    });
    const { before, after } = await moveComments(bytes, ['broken ink', 'scalar ink'], {
      dx: 10,
      dy: 0,
      rotation: 0,
    });
    const ink = dictOf(after, 0, 'broken ink').get('InkList');
    expect(numbersOf(ink.get(0))).toEqual([100, 100, 200, 200]);
    expect(ink.get(1).asNumber()).toBe(7);
    expect(dictOf(after, 0, 'scalar ink').get('InkList').asNumber()).toBe(4);
    expect(rectOf(dictOf(after, 0, 'broken ink'))).toEqual([110, 100, 210, 200]);
    before.destroy();
    after.destroy();
  });

  it('refuses an annotation with no usable /Rect, however much other geometry it has', async () => {
    const bytes = pdfWith(({ attach }) => {
      attach({ Type: 'Annot', Subtype: 'Square', Contents: 'no rect' });
      attach({ Type: 'Annot', Subtype: 'Square', Rect: [1, 2, 3], Contents: 'short rect' });
      attach({
        Type: 'Annot',
        Subtype: 'Highlight',
        QuadPoints: [100, 130, 200, 130, 100, 100, 200, 100],
        Contents: 'quads only',
      });
    });
    const doc = open(bytes);
    const ids = ['no rect', 'short rect', 'quads only'].map((comment) => idOf(doc, 0, comment));
    doc.destroy();
    for (const id of ids) {
      const error = await refusalOf(bytes, [{ pageIndex: 0, id }], { dx: 1, dy: 1, rotation: 0 });
      expect(error.code, id).toBe('selection-empty');
      expect(error.details.engineMessage).toContain(`annotation ${id} on page 1 carries no geometry`);
    }
  });
});

describe('transformPdfAnnotations on an annotation of a later generation', () => {
  it("addresses it by pdf.js's 17R5 spelling and by no other", async () => {
    const bytes = generationFivePdf('gen five');
    const outcome = await transformPdfAnnotations(
      bytes,
      { targets: [{ pageIndex: 0, id: '17R5' }], transform: { dx: 5, dy: 0, rotation: 0 } },
      CONTEXT,
    );
    expect(outcome.transformed).toEqual(['17R5']);
    const after = open(outcome.bytes);
    const rect = numbersOf(after.findPage(0).get('Annots').get(0).resolve().get('Rect'));
    after.destroy();
    expect(rect).toEqual([15, 10, 55, 50]);
    // Generation 0 is a different object: the file has no `17 0 R`.
    const error = await refusalOf(bytes, [{ pageIndex: 0, id: '17R' }], { dx: 5, dy: 0, rotation: 0 });
    expect(error.code).toBe('selection-empty');
  });
});

describe('transformPdfAnnotations on a page without annotations', () => {
  it('finds nothing on a page that has no /Annots and moves the annotation on the page that has them', async () => {
    const doc = new RasterPdfDocument();
    doc.insertPage(0, doc.addPage([0, 0, 400, PAGE_HEIGHT], 0, {}, ''));
    doc.insertPage(1, doc.addPage([0, 0, 400, PAGE_HEIGHT], 0, {}, ''));
    const second = doc.findPage(1);
    second.put('Annots', []);
    second.get('Annots').push(
      doc.addObject({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [100, 100, 200, 150],
        Contents: doc.newString('on two'),
      }),
    );
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const reading = open(bytes);
    const id = `${reading.findPage(1).get('Annots').get(0).asIndirect()}R`;
    reading.destroy();

    const error = await refusalOf(bytes, [{ pageIndex: 0, id }], { dx: 5, dy: 0, rotation: 0 });
    expect(error.code).toBe('selection-empty');
    expect(error.details.pageIndex).toBe(0);

    const outcome = await transformPdfAnnotations(
      bytes,
      { targets: [{ pageIndex: 1, id }], transform: { dx: 5, dy: 0, rotation: 0 } },
      CONTEXT,
    );
    const after = open(outcome.bytes);
    expect(rectOf(dictOf(after, 1, 'on two'))).toEqual([105, 100, 205, 150]);
    expect(after.findPage(0).get('Annots').isNull()).toBe(true);
    after.destroy();
  });
});

describe('transformPdfAnnotations on unusual page structure', () => {
  it('refuses an /Annots entry that is not a dictionary, and moves one past a direct dictionary', async () => {
    let scalar = '';
    const bytes = pdfWith(({ doc, page, attach }) => {
      page.get('Annots').push(doc.newDictionary()); // direct dictionary: no reference to address it by
      const number = doc.addObject(5);
      scalar = `${number.asIndirect()}R`;
      page.get('Annots').push(number);
      attach({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 200, 150], Contents: 'after direct' });
    });
    const error = await refusalOf(bytes, [{ pageIndex: 0, id: scalar }], { dx: 1, dy: 0, rotation: 0 });
    expect(error.code).toBe('corrupt-document');
    expect(error.details.engineMessage).toBe(`annotation ${scalar} on page 1 is not a dictionary`);

    const { before, after } = await moveComments(bytes, ['after direct'], { dx: 2, dy: 0, rotation: 0 });
    expect(rectOf(dictOf(after, 0, 'after direct'))).toEqual([102, 100, 202, 150]);
    // The direct dictionary and the scalar are still there, in place.
    const annots = after.findPage(0).get('Annots');
    expect(annots.length).toBe(3);
    expect(annots.get(0).isDictionary()).toBe(true);
    expect(annots.get(1).resolve().asNumber()).toBe(5);
    before.destroy();
    after.destroy();
  });

  it('survives a page with a /Contents array, a CropBox and a Rotate, and a form with odd fields', async () => {
    const bytes = pdfWith(({ doc, page, attach, stream }) => {
      page.put('Contents', [stream('0 g 5 5 10 10 re f'), stream('0 g 30 30 10 10 re f')]);
      page.put('CropBox', [10, 10, 390, 490]);
      page.put('Rotate', 90);
      attach({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 200, 150], Contents: 'cropped' });
      // Widgets whose values are a name, a number and an array: unrelated to the move.
      const named = attach({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Btn',
        T: doc.newString('named'),
        V: doc.newName('Yes'),
        Rect: [1, 1, 20, 20],
      });
      const numbered = attach({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: doc.newString('numbered'),
        V: 42,
        Rect: [1, 30, 20, 50],
      });
      const arrayed = attach({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Ch',
        T: doc.newString('arrayed'),
        V: [1, 2],
        Rect: [1, 60, 20, 80],
      });
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', { Fields: [named, numbered, arrayed, 9, doc.addObject(11)] });
    });
    const { before, after } = await moveComments(bytes, ['cropped'], { dx: 5, dy: 0, rotation: 0 });
    expect(rectOf(dictOf(after, 0, 'cropped'))).toEqual([105, 100, 205, 150]);
    expect(after.findPage(0).getInheritable('Rotate').asNumber()).toBe(90);
    expect(numbersOf(after.findPage(0).getInheritable('CropBox'))).toEqual([10, 10, 390, 490]);
    expect(after.findPage(0).get('Contents').length).toBe(2);
    before.destroy();
    after.destroy();
  });

  it('moves an annotation of a file whose AcroForm has no /Fields', async () => {
    const bytes = pdfWith(({ doc, attach }) => {
      attach({ Type: 'Annot', Subtype: 'Square', Rect: [100, 100, 200, 150], Contents: 'no fields' });
      doc.getTrailer().get('Root').put('AcroForm', { NeedAppearances: true });
    });
    const { before, after } = await moveComments(bytes, ['no fields'], { dx: 5, dy: 0, rotation: 0 });
    expect(rectOf(dictOf(after, 0, 'no fields'))).toEqual([105, 100, 205, 150]);
    expect(after.getTrailer().get('Root').get('AcroForm').get('NeedAppearances').asBoolean()).toBe(true);
    before.destroy();
    after.destroy();
  });
});

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
