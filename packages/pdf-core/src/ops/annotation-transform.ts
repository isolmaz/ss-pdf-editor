/**
 * Moving and turning annotations (`PLAN.md §5/Phase 3`; the select → move/rotate half
 * of the mark feature, next to `ops/annotation-remove.ts`).
 *
 * ## The one rule about rotation
 *
 * A turn is a property of the **mark**, never of its stored geometry:
 * `AnnotationMark.rotation` is a clockwise quarter turn about the mark's own
 * bounding-box centre, and `quads`, `rect` and `strokes` stay exactly as they were
 * drawn. The overlay draws the stored geometry turned by that angle, so a mark
 * never has two geometries that could drift apart, and rotating twice is a number
 * addition rather than a re-projection of already-projected points.
 *
 * A PDF annotation, however, **has no rotation key of its own**: a reader paints
 * its `/AP`, and only falls back to the geometry when there is none. A turn has to
 * reach the file as turned geometry *and* a turned appearance, which is what
 * `transformPdfAnnotations` above the persisted path does — and what
 * `writeAnnotationsToFile` uses for the marks this session is writing: the copy
 * goes into the file unturned, and the freshly written annotations are then handed
 * to this module, grouped by their mark's rotation.
 *
 * That indirection is the point. Turning a mark's *fields* is not the same as
 * turning the mark: a text note's box maps onto itself at 90°, an underline's bar
 * or a `/Line`'s diagonal would keep its old direction inside the same box, and a
 * `/FreeText` appearance would still draw its text upright. Rotating the appearance
 * instead turns every one of them the way the screen showed it, through one
 * implementation rather than an approximation per kind.
 *
 * ## Spaces
 *
 * Two spaces meet here, and mixing them is the only way to get this wrong:
 *
 *  - **app page points** — top-left origin, `y` growing downward, in points. Every
 *    `AnnotationMark`, `MeasureMark` and redaction rectangle is expressed in it, and
 *    `MarkTransform` is expressed in it.
 *  - **PDF user space** — bottom-left origin, `y` growing upward, exactly what
 *    `/Rect`, `/QuadPoints`, `/InkList`, `/Vertices` and `/L` hold.
 *
 * The two differ by a `y` flip (`pdfY = pageTop − appY`) and by the handedness that
 * flip implies: **a clockwise turn in app space is `rotation` degrees
 * counter-clockwise in PDF space**, so the persisted writer's `y` offset is
 * `−dy` and its matrix is a quarter turn the other way round. Emitting the app
 * angle straight into PDF space turns every annotation the wrong way on the page
 * while leaving a plausible-looking rectangle behind — which is why the persisted
 * path is verified by re-opening the produced file rather than trusted.
 *
 * ## What a persisted transform covers
 *
 * `transformPdfAnnotations` resolves each target as a **pdf.js annotation id on a
 * stated page** — the same pair `ops/annotation-remove.ts` removes by, read the
 * same way (`ExistingAnnotation.id`, an object reference like `17R`) — and refuses
 * a target it cannot resolve rather than moving whatever shares its id. `/Widget`
 * and `/Popup` are refused outright: a widget is a form field's visible half and a
 * popup is viewer chrome, and neither is a mark a selection may translate.
 *
 * For a resolved target the whole annotated geometry moves: `/Rect`, the
 * `/QuadPoints` of every quad (re-normalised to the spec's upper-left-first
 * order), every `/InkList` run, `/Vertices` and `/L`. `/QuadPoints` is transformed
 * rather than re-derived because it *is* the geometry — a highlight whose rect
 * moved but whose quads did not paints where it always did.
 *
 * ## Appearances
 *
 * An annotation whose file carries an `/AP` is drawn from that stream, so a
 * geometry-only transform would leave it looking untouched. `/AP /N` (and `/R`,
 * `/D`) is therefore re-pointed at a **new wrapper form** that paints the
 * original stream through the transform's matrix. The original stream is
 * referenced, never rewritten: two annotations may share one appearance stream,
 * and mutating it to move one of them would drag the other along. Wrapping also
 * avoids re-encoding somebody else's content stream — the bytes stay exactly as
 * the producing application wrote them.
 *
 * ## The read-back
 *
 * The produced bytes are re-opened and compared against what the call predicted:
 * the page count and every page's boxes and content streams, every annotation id
 * on every page (nothing added, nothing lost, nothing reordered), the geometry of
 * every target, a fresh wrapper in place of each target's appearance (still
 * pointing at the original stream), the dictionary of every *non*-target
 * annotation, and the form's fields with their values. A mismatch is
 * `verification-failed` and the caller keeps the original file
 * (`PLAN.md §3.3` rule 5/6).
 *
 * The write is MuPDF's rewrite (`engines/mupdf-write.ts`), which regenerates no
 * appearance stream — regenerating field appearances would rewrite the form this
 * operation promises to leave alone — and keeps object numbers, so every annotation
 * keeps the pdf.js id the panel listed it under.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  openForWrite,
  PRODUCER_LINE,
  pageObjects,
  readName,
  readNumbers,
  resolved,
  saveRewrite,
} from '../engines/mupdf-write';
import type { AnnotationMark, MarkBox } from './annotations';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

// ---------------------------------------------------------------------------
// the transform
// ---------------------------------------------------------------------------

/** The four turns a mark and a request may carry. */
export type QuarterTurn = 0 | 90 | 180 | 270;

/**
 * One selection-wide move and turn, in **app page points**.
 *
 * `rotation` is clockwise and about **each mark's own bounding-box centre**, not
 * about the selection's: two marks of different sizes turn in place rather than
 * orbiting a shared origin, which is the only behaviour that keeps a multi-mark
 * rotation from scattering them. `dx`/`dy` are applied after the turn, so the
 * offset is a plain page-space nudge rather than something that depends on the
 * angle.
 */
export interface MarkTransform {
  readonly dx: number;
  readonly dy: number;
  /** Clockwise, about each mark's own bounds centre. */
  readonly rotation: QuarterTurn;
}

/**
 * `cos`/`sin` per turn.
 *
 * Exact values on purpose: `Math.cos(Math.PI / 2)` is `6.1e-17`, and a highlight
 * written with that in its matrix lands a fraction of a pixel off — which a
 * round-trip comparison sees. A quarter turn has four exact answers, so they are
 * spelled out.
 */
const TURN_COS: Readonly<Record<QuarterTurn, number>> = { 0: 1, 90: 0, 180: -1, 270: 0 };
const TURN_SIN: Readonly<Record<QuarterTurn, number>> = { 0: 0, 90: 1, 180: 0, 270: -1 };

/** `value` as one of the four turns, or a failure naming where the bad number came from. */
function quarterTurn(value: number, path: string): QuarterTurn {
  if (!Number.isFinite(value) || value % 90 !== 0) {
    throw new ToolError('unsupported', {
      engine: 'ui',
      path,
      engineMessage: `a turn must be 0, 90, 180 or 270 degrees, got ${String(value)}`,
    });
  }
  const normalised = ((value % 360) + 360) % 360;
  switch (normalised) {
    case 0:
    case 90:
    case 180:
    case 270:
      return normalised;
    /* c8 ignore next 2 -- `value % 90 === 0` above leaves nothing else to reach */
    default:
      throw new ToolError('unsupported', { engine: 'ui', path, engineMessage: `bad turn ${String(value)}` });
  }
}

/** A point turned clockwise about `(cx, cy)` in a y-down space. */
function turnPoint(
  x: number,
  y: number,
  cx: number,
  cy: number,
  rotation: QuarterTurn,
): { readonly x: number; readonly y: number } {
  const cos = TURN_COS[rotation];
  const sin = TURN_SIN[rotation];
  const offsetX = x - cx;
  const offsetY = y - cy;
  return { x: cx + offsetX * cos - offsetY * sin, y: cy + offsetX * sin + offsetY * cos };
}

/** The box around every point given; `null` when there are none. */
function boundsOfPoints(points: readonly (readonly [number, number])[]): MarkBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/** Every point a mark's **stored** geometry is made of: rect corners, quads, ink strokes. */
function storedPoints(mark: AnnotationMark): readonly (readonly [number, number])[] {
  const points: (readonly [number, number])[] = [];
  const addBox = (box: MarkBox | undefined): void => {
    if (box === undefined) return;
    points.push([box[0], box[1]], [box[2], box[3]]);
  };
  addBox(mark.rect);
  for (const quad of mark.quads) addBox(quad);
  for (const stroke of mark.strokes ?? []) {
    for (let index = 0; index + 1 < stroke.length; index += 2) {
      points.push([stroke[index] ?? 0, stroke[index + 1] ?? 0]);
    }
  }
  return points;
}

/**
 * The mark's own bounding box — **stored** geometry, unrotated.
 *
 * It is the pivot every turn is measured from, and that is the point: a turn about
 * this centre leaves the centre where it is, so the box around a rotated mark has
 * the same centre as this one. A caller that has to place a rotated mark on screen
 * turns this box's corners with `transformPoint` rather than expecting the turn to
 * be in here.
 */
export function annotationBounds(mark: AnnotationMark): MarkBox {
  const bounds = boundsOfPoints(storedPoints(mark));
  if (bounds === null) {
    throw new ToolError('selection-empty', {
      engine: 'ui',
      engineMessage: `annotation ${mark.id} (${mark.kind}) carries no geometry to place`,
    });
  }
  return bounds;
}

/** The request's transform, judged once: two finite offsets and one of four turns. */
function checkedTransform(transform: MarkTransform | undefined): MarkTransform {
  const dx = transform?.dx;
  const dy = transform?.dy;
  if (typeof dx !== 'number' || !Number.isFinite(dx) || typeof dy !== 'number' || !Number.isFinite(dy)) {
    throw new ToolError('value-out-of-range', {
      engine: 'ui',
      path: 'request.transform',
      engineMessage:
        `a mark transform needs finite dx and dy offsets, got ` +
        `${JSON.stringify({ dx: dx ?? null, dy: dy ?? null })}`,
    });
  }
  return { dx, dy, rotation: quarterTurn(transform?.rotation ?? 0, 'request.transform.rotation') };
}

/**
 * One point moved by `transform`: turned clockwise about the centre of `bounds`,
 * then offset by `dx`/`dy`.
 *
 * `bounds` is the mark's own box (`annotationBounds`), which is what makes a
 * selection-wide turn rotate each mark in place. Both the measurement and the
 * redaction paths in the app reach this through their own corners, so a
 * measurement turns about the same centre its highlight would.
 */
export function transformPoint(
  point: { readonly x: number; readonly y: number },
  bounds: MarkBox,
  transform: MarkTransform,
): { readonly x: number; readonly y: number } {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = bounds;
  const { dx, dy, rotation } = checkedTransform(transform);
  const turned = turnPoint(point.x, point.y, (x0 + x1) / 2, (y0 + y1) / 2, rotation);
  return { x: turned.x + dx, y: turned.y + dy };
}

/** A flat `[x, y, …]` run moved by `place`, its shape kept (a trailing odd value included). */
function placeRun(
  run: readonly number[],
  place: (x: number, y: number) => { readonly x: number; readonly y: number },
): number[] {
  const moved: number[] = [];
  for (let index = 0; index + 1 < run.length; index += 2) {
    const point = place(run[index] ?? 0, run[index + 1] ?? 0);
    moved.push(point.x, point.y);
  }
  if (run.length % 2 === 1) moved.push(run[run.length - 1] ?? 0);
  return moved;
}

/** A box moved by `place`, as the box around its moved corners. */
function placeBox(
  box: MarkBox,
  place: (x: number, y: number) => { readonly x: number; readonly y: number },
): MarkBox {
  const bounds = boundsOfPoints([
    (() => {
      const corner = place(box[0], box[1]);
      return [corner.x, corner.y] as const;
    })(),
    (() => {
      const corner = place(box[2], box[3]);
      return [corner.x, corner.y] as const;
    })(),
  ]);
  /* c8 ignore next -- two finite corners always bound a box */
  return bounds ?? box;
}

/** `mark` with `rotation` replaced by `turn`; a turn of 0 leaves no key at all. */
function withTurn(mark: AnnotationMark, turn: QuarterTurn): AnnotationMark {
  const next: { -readonly [K in keyof AnnotationMark]: AnnotationMark[K] } = { ...mark };
  if (turn === 0) Reflect.deleteProperty(next, 'rotation');
  else next.rotation = turn;
  return next;
}

/**
 * `mark` moved by `transform`, its turn accumulated in `rotation`.
 *
 * The stored points are **translated only**: the turn rides the mark's own
 * `rotation`, and the overlay applies it about the centre of these very points. A
 * second rotation therefore adds two quarter turns instead of turning
 * already-turned coordinates and rounding them twice on the way.
 */
export function transformAnnotationMark(mark: AnnotationMark, transform: MarkTransform): AnnotationMark {
  const { dx, dy, rotation } = checkedTransform(transform);
  const place = (x: number, y: number) => ({ x: x + dx, y: y + dy });
  const moved: AnnotationMark = {
    ...mark,
    quads: mark.quads.map((quad) => placeBox(quad, place)),
    ...(mark.rect === undefined ? {} : { rect: placeBox(mark.rect, place) }),
    ...(mark.strokes === undefined ? {} : { strokes: mark.strokes.map((stroke) => placeRun(stroke, place)) }),
  };
  return withTurn(moved, quarterTurn((mark.rotation ?? 0) + rotation, 'mark.rotation'));
}

// ---------------------------------------------------------------------------
// the persisted writer
// ---------------------------------------------------------------------------

/**
 * One annotation to move: an id `readAnnotations()` reported, on the page it
 * reported it for. The pair is the identity — the same id on another page is a
 * different annotation and is never touched.
 */
export interface AnnotationTransformTarget {
  /** 0-based page the annotation was read from. */
  readonly pageIndex: number;
  /** pdf.js annotation id: the object reference (`17R`, `17R5`). */
  readonly id: string;
}

export interface TransformAnnotationsRequest {
  readonly targets: readonly AnnotationTransformTarget[];
  readonly transform: MarkTransform;
}

export interface AnnotationTransformOutcome extends OperationOutcome {
  /**
   * The ids actually transformed, in request order and de-duplicated — what a
   * caller may now treat as moved on its own side.
   */
  readonly transformed: readonly string[];
}

/** pdf.js's own reference spelling (`Ref.toString`): `17R` for generation 0. */
const REFERENCE_ID = /^(\d+)R(\d*)$/;

/** MuPDF's spelling of an indirect reference: `17 0 R`. */
const MUPDF_REFERENCE = /^(\d+) (\d+) R$/;

/** The appearance keys a transform follows: normal, rollover, down. */
const APPEARANCE_KEYS: Readonly<Record<string, true>> = { N: true, R: true, D: true };
const CONTENT_STREAM_NAME = 'Fm0';
const WIDGET = '/Widget';
const POPUP = '/Popup';

/** Two ordinates are the same when they are this close: a point is 1/72 inch. */
const EPSILON = 1e-4;

interface Reference {
  readonly objectNumber: number;
  readonly generationNumber: number;
}

/**
 * The id pdf.js reports for an object reference — the *only* spelling this module
 * matches against, and the same spelling `ops/annotation-remove.ts` resolves.
 * Generation 0 is `17R`, every other generation is `17R5` (`Ref.toString`,
 * `build/pdf.mjs`).
 */
function referenceId(ref: Reference): string {
  return ref.generationNumber === 0 ? `${ref.objectNumber}R` : `${ref.objectNumber}R${ref.generationNumber}`;
}

/**
 * The pdf.js id of an indirect entry, generation included (read off the engine's own
 * `17 5 R` spelling — `asIndirect()` answers only the number), or `null` for a direct
 * value or a missing key.
 */
function idOf(value: PDFObject | null | undefined): string | null {
  if (value === null || value === undefined || !value.isIndirect()) return null;
  const match = MUPDF_REFERENCE.exec(value.toString());
  return referenceId(
    match === null
      ? { objectNumber: value.asIndirect(), generationNumber: 0 }
      : { objectNumber: Number(match[1]), generationNumber: Number(match[2]) },
  );
}

/** The reference an id names, or `null` when the id is not an object reference. */
function parseReferenceId(id: string): Reference | null {
  const match = REFERENCE_ID.exec(id.trim());
  if (match === null) return null;
  const objectNumber = Number.parseInt(match[1] as string, 10);
  if (!Number.isSafeInteger(objectNumber) || objectNumber <= 0) return null;
  const digits = match[2] as string;
  const generationNumber = digits.length === 0 ? 0 : Number.parseInt(digits, 10);
  return Number.isSafeInteger(generationNumber) && generationNumber >= 0
    ? { objectNumber, generationNumber }
    : null;
}

/** One target, judged without the document: a page and a canonical reference id. */
function planTargets(request: TransformAnnotationsRequest | undefined): readonly AnnotationTransformTarget[] {
  const requested = request?.targets;
  if (!Array.isArray(requested)) {
    throw new ToolError('internal', {
      engine: 'mupdf',
      path: 'request.targets',
      engineMessage: 'transformPdfAnnotations expects a targets array',
    });
  }
  const targets: AnnotationTransformTarget[] = [];
  const seen = new Set<string>();
  for (const [index, target] of requested.entries()) {
    const path = `request.targets[${index}]`;
    if (!Number.isInteger(target.pageIndex) || target.pageIndex < 0) {
      throw new ToolError('value-out-of-range', {
        engine: 'mupdf',
        path: `${path}.pageIndex`,
        engineMessage: `page index must be a non-negative integer, got ${String(target.pageIndex)}`,
      });
    }
    const parsed = typeof target.id === 'string' ? parseReferenceId(target.id) : null;
    if (parsed === null) {
      throw new ToolError('unsupported', {
        engine: 'mupdf',
        path: `${path}.id`,
        engineMessage:
          `annotation id ${JSON.stringify(String(target.id))} is not an object reference (e.g. 17R); ` +
          'an annotation the file stores as a direct dictionary cannot be addressed for a transform',
      });
    }
    const id = referenceId(parsed);
    const key = `${target.pageIndex}|${id}`;
    // The same annotation named twice is one move, not two.
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ pageIndex: target.pageIndex, id });
  }
  return targets;
}

/** A `[a b c d e f]` PDF matrix: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`. */
interface Matrix {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** `outer ∘ inner`: the point is moved by `inner` first. */
function multiply(outer: Matrix, inner: Matrix): Matrix {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

/** `cm` wants six numbers; integers stay integral so a matrix reads back exactly. */
function formatMatrix(matrix: Matrix): string {
  const num = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(6));
  return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map(num).join(' ');
}

/** A flat run of finite numbers out of a PDF array, or `null` when it is not one. */
function numbersOf(value: PDFObject | null | undefined): number[] | null {
  const array = resolved(value);
  if (array === null || !array.isArray()) return null;
  const numbers: number[] = [];
  for (let index = 0; index < array.length; index += 1) {
    const number = resolved(array.get(index));
    if (number === null || !number.isNumber()) return null;
    numbers.push(number.asNumber());
  }
  return numbers;
}

/** `/InkList`: one flat run per stroke. */
function inkListsOf(value: PDFObject | null | undefined): number[][] | null {
  const array = resolved(value);
  if (array === null || !array.isArray()) return null;
  const runs: number[][] = [];
  for (let index = 0; index < array.length; index += 1) {
    const run = numbersOf(array.get(index));
    if (run === null) return null;
    runs.push(run);
  }
  return runs;
}

/** Four numbers as a normalised box, or `null` when the key is absent or malformed. */
function boxOf(value: PDFObject | null | undefined): MarkBox | null {
  const numbers = numbersOf(value);
  if (numbers === null || numbers.length !== 4) return null;
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = numbers;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** The geometric keys one annotation dictionary carries, as read. */
interface ReadGeometry {
  readonly rect: MarkBox | null;
  readonly quadPoints: number[] | null;
  readonly inkLists: number[][] | null;
  readonly vertices: number[] | null;
  readonly line: number[] | null;
}

function readGeometry(dict: PDFObject): ReadGeometry {
  return {
    rect: boxOf(dict.get('Rect')),
    quadPoints: numbersOf(dict.get('QuadPoints')),
    inkLists: inkListsOf(dict.get('InkList')),
    vertices: numbersOf(dict.get('Vertices')),
    line: numbersOf(dict.get('L')),
  };
}

/** The same keys after the transform — what the produced file must carry. */
interface WrittenGeometry {
  readonly rect: MarkBox;
  readonly quadPoints: number[] | null;
  readonly inkLists: number[][] | null;
  readonly vertices: number[] | null;
  readonly line: number[] | null;
}

/** The turn's centre: the box around every geometric point the annotation has. */
function pivotOf(geometry: ReadGeometry): { readonly x: number; readonly y: number } | null {
  const points: (readonly [number, number])[] = [];
  const addBox = (box: MarkBox | null): void => {
    if (box === null) return;
    points.push([box[0], box[1]], [box[2], box[3]]);
  };
  const addRun = (run: readonly number[] | null): void => {
    if (run === null) return;
    for (let index = 0; index + 1 < run.length; index += 2) {
      points.push([run[index] ?? 0, run[index + 1] ?? 0]);
    }
  };
  addBox(geometry.rect);
  addRun(geometry.quadPoints);
  for (const run of geometry.inkLists ?? []) addRun(run);
  addRun(geometry.vertices);
  addRun(geometry.line);
  const bounds = boundsOfPoints(points);
  if (bounds === null) return null;
  return { x: (bounds[0] + bounds[2]) / 2, y: (bounds[1] + bounds[3]) / 2 };
}

/**
 * One `[x0, y0, x1, y1]` group of `/QuadPoints` in the order the spec wants them:
 * upper-left, upper-right, lower-left, lower-right.
 *
 * A turn moves a rectangle to a rectangle, so normalising after the turn is what
 * keeps a rotated highlight's points in the same spelling pdf.js and this module
 * write in the first place — the order is a convention readers rely on, and
 * letting a turn permute it would leave a technically-valid quadrilateral that
 * some readers draw as a bow tie.
 */
function normaliseQuad(group: readonly number[]): number[] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 1 < group.length; index += 2) {
    const x = group[index] ?? 0;
    const y = group[index + 1] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return [minX, maxY, maxX, maxY, minX, minY, maxX, minY];
}

/** A run of numbers as a fresh PDF array. */
function numberArray(doc: PDFDocument, values: readonly number[]): PDFObject {
  const array = doc.newArray();
  for (const value of values) array.push(value);
  return array;
}

/**
 * Rewrite the target's geometric keys through `place`, and say what was written.
 *
 * Only the keys the annotation already had are written: a shape with no
 * `/QuadPoints` must not gain one, or a reader that trusts the presence of a key
 * draws something else. `/Rect` is required by the caller, because it is what
 * makes the annotation placeable at all.
 */
function writeGeometry(
  doc: PDFDocument,
  dict: PDFObject,
  geometry: ReadGeometry & { readonly rect: MarkBox },
  place: (x: number, y: number) => { readonly x: number; readonly y: number },
): WrittenGeometry {
  const rect = placeBox(geometry.rect, place);
  dict.put('Rect', numberArray(doc, rect));
  let quadPoints: number[] | null = null;
  if (geometry.quadPoints !== null) {
    const moved = placeRun(geometry.quadPoints, place);
    // A length that is not a whole number of quads is somebody's malformed data:
    // the points are still turned, but there is no group to re-order.
    quadPoints =
      moved.length % 8 === 0
        ? moved.flatMap((_value, index) =>
            index % 8 === 0 ? normaliseQuad(moved.slice(index, index + 8)) : [],
          )
        : moved;
    dict.put('QuadPoints', numberArray(doc, quadPoints));
  }
  let inkLists: number[][] | null = null;
  if (geometry.inkLists !== null) {
    inkLists = geometry.inkLists.map((run) => placeRun(run, place));
    const runs = doc.newArray();
    for (const run of inkLists) runs.push(numberArray(doc, run));
    dict.put('InkList', runs);
  }
  let vertices: number[] | null = null;
  if (geometry.vertices !== null) {
    vertices = placeRun(geometry.vertices, place);
    dict.put('Vertices', numberArray(doc, vertices));
  }
  let line: number[] | null = null;
  if (geometry.line !== null) {
    line = placeRun(geometry.line, place);
    dict.put('L', numberArray(doc, line));
  }
  return { rect, quadPoints, inkLists, vertices, line };
}

/** One appearance stream as it will be re-pointed: the original and the wrapper's box. */
interface WrappedAppearance {
  /** The ref id of the stream the file already had. */
  readonly original: string;
  /** The wrapper's `/BBox`, in the wrapper's own space. */
  readonly boundingBox: MarkBox;
}

/** The `/AP` rewrite: a fresh dictionary plus what it points at. */
interface AppearanceRewrite {
  readonly dict: PDFObject;
  readonly wrapped: readonly WrappedAppearance[];
}

/** What the appearance rewrite needs: the old rect, the new one, the point mapping and the turn. */
interface AppearanceFrame {
  /** The annotation's `/Rect` before the transform. */
  readonly rect: MarkBox;
  /** The transformed `/Rect` the wrapper's own space is anchored to. */
  readonly newRect: MarkBox;
  /** App page space → PDF page space, with the turn already in it. */
  readonly place: (x: number, y: number) => { readonly x: number; readonly y: number };
  readonly rotation: QuarterTurn;
}

/** A dictionary's entries as `[key, value]` pairs, keys without their slash. */
function entriesOf(dict: PDFObject): [string, PDFObject][] {
  const entries: [string, PDFObject][] = [];
  dict.forEach((value, key) => {
    if (typeof key === 'string') entries.push([key, value]);
  });
  return entries;
}

/**
 * `/AP` re-pointed at a wrapper form per appearance stream.
 *
 * Every stream the original `/AP` held is *referenced* by its wrapper, so a file
 * whose two annotations share one appearance keeps sharing it — only the targeted
 * annotation's dictionary changes. The wrapper's matrix is the composition that
 * matters:
 *
 *  1. the reader's own mapping of that stream's `/BBox` onto the annotation's
 *     `/Rect` (a scale and a translate — how the appearance is displayed today),
 *  2. this operation's turn and offset in page space,
 *  3. a shift into the new annotation's space, whose origin is the new `/Rect`.
 *
 * The wrapper's `/BBox` is the new rect's size, so the reader maps it back at
 * scale 1 and the content lands where the matrix put it.
 *
 * Streams are recognised on the entry itself: MuPDF reports a stream only through its
 * indirect reference (`engines/mupdf-write.ts`), and a conforming file stores every
 * stream indirectly.
 */
function rewriteAppearance(
  doc: PDFDocument,
  appearance: PDFObject,
  frame: AppearanceFrame,
): AppearanceRewrite | null {
  const source = resolved(appearance);
  if (source === null || !source.isDictionary()) return null;
  const dict = doc.newDictionary();
  const wrapped: WrappedAppearance[] = [];
  for (const [key, value] of entriesOf(source)) {
    if (APPEARANCE_KEYS[key] !== true) {
      dict.put(key, value);
      continue;
    }
    if (value.isStream()) {
      const target = wrapStream(doc, value, frame);
      dict.put(key, target.ref);
      wrapped.push(target.wrapped);
      continue;
    }
    // An appearance *state* dictionary (`/Off`, `/On`, …): every state is a stream.
    const states = resolved(value);
    if (states === null || !states.isDictionary()) {
      dict.put(key, value);
      continue;
    }
    const rewritten = doc.newDictionary();
    for (const [stateKey, stateValue] of entriesOf(states)) {
      if (!stateValue.isStream()) {
        rewritten.put(stateKey, stateValue);
        continue;
      }
      const stateTarget = wrapStream(doc, stateValue, frame);
      rewritten.put(stateKey, stateTarget.ref);
      wrapped.push(stateTarget.wrapped);
    }
    dict.put(key, rewritten);
  }
  return { dict, wrapped };
}

/** One stream behind a wrapper form. `source` is the stream's indirect reference. */
function wrapStream(
  doc: PDFDocument,
  source: PDFObject,
  frame: AppearanceFrame,
): { readonly ref: PDFObject; readonly wrapped: WrappedAppearance } {
  const box = boxOf(resolved(source)?.get('BBox')) ?? frame.rect;
  const boxWidth = box[2] - box[0];
  const boxHeight = box[3] - box[1];
  const rectWidth = frame.rect[2] - frame.rect[0];
  const rectHeight = frame.rect[3] - frame.rect[1];
  const scaleX = boxWidth === 0 ? 1 : rectWidth / boxWidth;
  const scaleY = boxHeight === 0 ? 1 : rectHeight / boxHeight;
  // 1. what a reader does today with this stream: `/BBox` → `/Rect`.
  const ontoRect: Matrix = {
    a: scaleX,
    b: 0,
    c: 0,
    d: scaleY,
    e: frame.rect[0] - box[0] * scaleX,
    f: frame.rect[1] - box[1] * scaleY,
  };
  // 2. and 3. this operation's turn and offset, then the new origin at `newRect`.
  const corner = frame.place(frame.rect[0], frame.rect[1]);
  const cos = TURN_COS[frame.rotation];
  const sin = TURN_SIN[frame.rotation];
  const ontoNewRect: Matrix = {
    a: cos,
    b: -sin,
    c: sin,
    d: cos,
    // `ontoRect` already supplies the old origin. Remove its rotated contribution
    // here, otherwise the composed matrix translates the appearance twice.
    e: corner.x - frame.newRect[0] - cos * frame.rect[0] - sin * frame.rect[1],
    f: corner.y - frame.newRect[1] + sin * frame.rect[0] - cos * frame.rect[1],
  };
  const matrix = multiply(ontoNewRect, ontoRect);
  const bbox: MarkBox = [0, 0, frame.newRect[2] - frame.newRect[0], frame.newRect[3] - frame.newRect[1]];
  const resources = doc.newDictionary();
  const xobjects = doc.newDictionary();
  xobjects.put(CONTENT_STREAM_NAME, source);
  resources.put('XObject', xobjects);
  const header = doc.newDictionary();
  header.put('Type', 'XObject');
  header.put('Subtype', 'Form');
  header.put('FormType', 1);
  header.put('BBox', numberArray(doc, bbox));
  header.put('Resources', resources);
  // Stored plain and deflated by the save (`MUPDF_REWRITE_OPTIONS`).
  const ref = doc.addStream(`q\n${formatMatrix(matrix)} cm\n/${CONTENT_STREAM_NAME} Do\nQ\n`, header);
  return { ref, wrapped: { original: idOf(source) ?? 'direct', boundingBox: bbox } };
}

/** The wrapper streams a written `/AP` holds, in the order `rewriteAppearance` wrote them. */
interface ReadAppearance {
  readonly ref: string;
  readonly form: string | null;
  readonly boundingBox: MarkBox | null;
}

function readAppearance(appearance: PDFObject): ReadAppearance[] {
  const source = resolved(appearance);
  if (source === null || !source.isDictionary()) return [];
  const found: ReadAppearance[] = [];
  const readStream = (value: PDFObject): void => {
    if (!value.isStream()) return;
    const stream = resolved(value);
    if (stream === null) return;
    const resources = resolved(stream.get('Resources'));
    const xobjects = resources === null ? null : resolved(resources.get('XObject'));
    found.push({
      ref: idOf(value) ?? 'direct',
      form: xobjects === null ? null : idOf(xobjects.get(CONTENT_STREAM_NAME)),
      boundingBox: boxOf(stream.get('BBox')),
    });
  };
  for (const [key, value] of entriesOf(source)) {
    if (APPEARANCE_KEYS[key] !== true) continue;
    if (value.isStream()) {
      readStream(value);
      continue;
    }
    const states = resolved(value);
    if (states === null || !states.isDictionary()) continue;
    for (const [, stateValue] of entriesOf(states)) readStream(stateValue);
  }
  return found;
}

/** A name's text with its slash (`/Widget`), or `''`. */
function nameOf(value: PDFObject): string {
  const name = readName(value);
  return name === null ? '' : `/${name}`;
}

/** A string-ish value's text: strings decode, names and numbers stringify. */
function textOf(value: PDFObject): string {
  const target = resolved(value);
  if (target === null) return '';
  if (target.isString()) return target.asString();
  if (target.isName()) return `/${target.asName()}`;
  if (target.isNumber()) return String(target.asNumber());
  return target.toString();
}

/**
 * Everything about one annotation that a transform of *another* annotation must
 * leave alone — geometry, identity, comment, appearance reference and, for a
 * widget, its field value.
 */
function annotationDigest(dict: PDFObject): string {
  return JSON.stringify({
    subtype: nameOf(dict.get('Subtype')),
    contents: textOf(dict.get('Contents')),
    author: textOf(dict.get('T')),
    rect: numbersOf(dict.get('Rect')),
    quadPoints: numbersOf(dict.get('QuadPoints')),
    inkLists: inkListsOf(dict.get('InkList')),
    vertices: numbersOf(dict.get('Vertices')),
    line: numbersOf(dict.get('L')),
    appearance: idOf(dict.get('AP')),
    parent: idOf(dict.get('Parent')),
    value: textOf(dict.get('V')),
    fieldType: nameOf(dict.get('FT')),
  });
}

/** The page's own facts: its boxes, its rotation and the content streams it draws. */
function pageDigest(page: PDFObject): string {
  const contents = page.get('Contents');
  const resolvedContents = resolved(contents);
  const streams =
    resolvedContents?.isArray() === true
      ? Array.from({ length: resolvedContents.length }, (_unused, index) => idOf(resolvedContents.get(index)))
      : [idOf(contents)];
  const media = readNumbers(page.getInheritable('MediaBox'));
  const crop = readNumbers(page.getInheritable('CropBox'));
  const rotate = resolved(page.getInheritable('Rotate'));
  return JSON.stringify({
    contents: streams,
    mediaBox: media,
    cropBox: crop.length === 4 ? crop : media,
    rotate: rotate?.isNumber() === true ? rotate.asNumber() : 0,
  });
}

/** The form's fields and their values — the facts a widget survives with. */
function formDigest(doc: PDFDocument): string {
  const catalog = resolved(doc.getTrailer().get('Root'));
  const formRef = catalog === null ? null : catalog.get('AcroForm');
  const form = resolved(formRef);
  if (formRef === null || form === null || !form.isDictionary()) return 'none';
  const fields = resolved(form.get('Fields'));
  const entries: unknown[] = [];
  if (fields?.isArray() === true) {
    for (let index = 0; index < fields.length; index += 1) {
      const entry = fields.get(index);
      const dict = resolved(entry);
      const isDict = dict?.isDictionary() === true;
      entries.push({
        id: idOf(entry),
        name: isDict && dict !== null ? textOf(dict.get('T')) : '',
        value: isDict && dict !== null ? textOf(dict.get('V')) : '',
        fieldType: isDict && dict !== null ? nameOf(dict.get('FT')) : '',
      });
    }
  }
  return JSON.stringify({ form: idOf(formRef), fields: entries });
}

/** What one target must look like in the produced file. */
interface TargetExpectation {
  readonly pageIndex: number;
  readonly id: string;
  readonly subtype: string;
  readonly contents: string;
  readonly geometry: WrittenGeometry;
  readonly wrapped: readonly WrappedAppearance[];
}

/** What the read-back compares the produced file against. */
interface TransformExpectation {
  readonly pageCount: number;
  /** Per-page digests: boxes, rotation and content streams. */
  readonly pages: readonly string[];
  /** Reference ids per page, in `/Annots` order, read before any mutation. */
  readonly pageIds: readonly (readonly string[])[];
  /** Digests of the annotations this call must not touch, by page. */
  readonly untouched: ReadonlyMap<number, ReadonlyMap<string, string>>;
  readonly form: string;
  readonly targets: readonly TargetExpectation[];
}

/** A request that changes nothing: the input comes back as it was. */
function nothingToDo(bytes: Uint8Array): AnnotationTransformOutcome {
  return {
    bytes,
    transformed: [],
    report: {
      engine: 'mupdf',
      // No engine pass ran, so no step id is claimed: the report says the call
      // changed nothing (`PLAN.md §3.3` rule 3) instead of naming work nobody did.
      steps: [],
      notes: [note('warning', 'op.note.annotate.nothing')],
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount: 0,
      incremental: true,
    },
  };
}

/** The ids one page lists, in `/Annots` order, indirect references only. */
function pageIds(doc: PDFDocument, page: PDFObject): readonly string[] {
  const annots = annotsOf(doc, page);
  if (annots === null) return [];
  const ids: string[] = [];
  for (let position = 0; position < annots.length; position += 1) {
    const id = idOf(annots.get(position));
    if (id !== null) ids.push(id);
  }
  return ids;
}

/** The annotation dictionary an id names on one page, with its position. */
function findOnPage(
  doc: PDFDocument,
  page: PDFObject,
  id: string,
): { readonly position: number; readonly dict: PDFObject | null } {
  const annots = annotsOf(doc, page);
  if (annots === null) return { position: -1, dict: null };
  for (let position = 0; position < annots.length; position += 1) {
    const entry = annots.get(position);
    if (idOf(entry) !== id) continue;
    const dict = resolved(entry);
    return { position, dict: dict?.isDictionary() === true ? dict : null };
  }
  return { position: -1, dict: null };
}

/** Two runs of ordinates are the same to within `EPSILON`. */
function numbersClose(actual: readonly number[] | null, expected: readonly number[] | null): boolean {
  if (actual === null || expected === null) return actual === expected;
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) <= EPSILON);
}

/** Whether the geometry a produced file carries is what the call wrote. */
function geometryMatches(dict: PDFObject, written: WrittenGeometry): boolean {
  const read = readGeometry(dict);
  return (
    read.rect !== null &&
    numbersClose(read.rect, written.rect) &&
    numbersClose(read.quadPoints, written.quadPoints) &&
    numbersClose(read.vertices, written.vertices) &&
    numbersClose(read.line, written.line) &&
    (read.inkLists === null || written.inkLists === null
      ? read.inkLists === written.inkLists
      : read.inkLists.length === written.inkLists.length &&
        read.inkLists.every((run, index) => numbersClose(run, written.inkLists?.[index] ?? null)))
  );
}

function verificationFailed(message: string, pageIndex?: number): ToolError {
  return new ToolError('verification-failed', {
    engine: 'mupdf',
    ...(pageIndex === undefined ? {} : { pageIndex }),
    engineMessage: message,
  });
}

/** One target's read-back: identity, geometry and a fresh wrapper per appearance. */
function verifyTarget(doc: PDFDocument, page: PDFObject, target: TargetExpectation): void {
  const { dict } = findOnPage(doc, page, target.id);
  if (dict === null) {
    throw verificationFailed(
      `annotation ${target.id} is not on page ${target.pageIndex + 1} after the transform`,
      target.pageIndex,
    );
  }
  if (nameOf(dict.get('Subtype')) !== target.subtype || textOf(dict.get('Contents')) !== target.contents) {
    throw verificationFailed(`annotation ${target.id} lost its subtype or its comment`, target.pageIndex);
  }
  if (!geometryMatches(dict, target.geometry)) {
    throw verificationFailed(
      `annotation ${target.id} does not carry the geometry the transform wrote: ` +
        JSON.stringify(readGeometry(dict)),
      target.pageIndex,
    );
  }
  const appearances = readAppearance(dict.get('AP'));
  if (appearances.length !== target.wrapped.length) {
    throw verificationFailed(
      `annotation ${target.id} has ${appearances.length} appearance streams, expected ${target.wrapped.length}`,
      target.pageIndex,
    );
  }
  for (const [index, want] of target.wrapped.entries()) {
    const got = appearances[index];
    if (got === undefined || got.form !== want.original) {
      throw verificationFailed(
        `appearance ${index} of annotation ${target.id} does not paint the original stream ` +
          `(${String(got?.form)} vs ${want.original})`,
        target.pageIndex,
      );
    }
    if (got.ref === want.original) {
      throw verificationFailed(
        `appearance ${index} of annotation ${target.id} is the original stream itself, ` +
          'so a shared appearance would have been rewritten',
        target.pageIndex,
      );
    }
    if (!numbersClose(got.boundingBox, want.boundingBox)) {
      throw verificationFailed(
        `appearance ${index} of annotation ${target.id} has BBox ${JSON.stringify(got.boundingBox)}, ` +
          `expected ${JSON.stringify(want.boundingBox)}`,
        target.pageIndex,
      );
    }
  }
}

/**
 * Re-open the produced bytes and check what the call predicted.
 *
 * A file that does not parse, a page count that moved, a page whose boxes,
 * content streams or annotation list changed, a non-target annotation whose
 * dictionary moved, a form that lost a field or a value, a target whose geometry
 * is not what was written, and an appearance that is not a fresh wrapper still
 * pointing at the original stream — each is `verification-failed`, and the caller
 * keeps the original file.
 */
async function verifyTransform(produced: Uint8Array, expected: TransformExpectation): Promise<void> {
  let doc: PDFDocument;
  try {
    ({ doc } = await openForWrite(produced));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw verificationFailed(`produced file does not re-open: ${message}`);
  }
  try {
    const pages = pageObjects(doc);
    if (pages.length !== expected.pageCount) {
      throw verificationFailed(`produced file has ${pages.length} pages, expected ${expected.pageCount}`);
    }
    for (const [index, page] of pages.entries()) {
      if (pageDigest(page) !== (expected.pages[index] ?? '')) {
        throw verificationFailed(`page ${index + 1} lost content, a box or its rotation`, index);
      }
      const ids = pageIds(doc, page);
      const before = expected.pageIds[index] ?? [];
      if (ids.length !== before.length || ids.some((id, position) => id !== before[position])) {
        throw verificationFailed(
          `page ${index + 1} annotation list changed: [${ids.join(', ')}] vs [${before.join(', ')}]`,
          index,
        );
      }
      const untouched = expected.untouched.get(index);
      if (untouched === undefined) continue;
      for (const [id, digest] of untouched) {
        const { position, dict } = findOnPage(doc, page, id);
        if (position < 0) continue;
        if (dict === null || annotationDigest(dict) !== digest) {
          throw verificationFailed(
            `annotation ${id} on page ${index + 1} changed although it was not a target`,
            index,
          );
        }
      }
    }
    if (formDigest(doc) !== expected.form)
      throw verificationFailed('the form or one of its field values changed');
    for (const target of expected.targets) {
      const page = pages[target.pageIndex];
      if (page === undefined) {
        throw verificationFailed(
          `page ${target.pageIndex + 1} is missing from the produced file`,
          target.pageIndex,
        );
      }
      verifyTarget(doc, page, target);
    }
  } finally {
    doc.destroy();
  }
}

/** Resolve one target on its page and refuse what a selection may not move. */
function resolveTarget(
  doc: PDFDocument,
  pages: readonly PDFObject[],
  target: AnnotationTransformTarget,
): { readonly dict: PDFObject; readonly subtype: string } {
  const page = pages[target.pageIndex];
  if (page === undefined) {
    throw new ToolError('range-invalid', {
      engine: 'mupdf',
      pageIndex: target.pageIndex,
      engineMessage: `annotation ${target.id} targets page ${target.pageIndex + 1} of ${pages.length}`,
    });
  }
  const { position, dict } = findOnPage(doc, page, target.id);
  if (position < 0) {
    throw new ToolError('selection-empty', {
      engine: 'mupdf',
      pageIndex: target.pageIndex,
      engineMessage: `annotation ${target.id} is not on page ${target.pageIndex + 1}`,
    });
  }
  if (dict === null) {
    throw new ToolError('corrupt-document', {
      engine: 'mupdf',
      pageIndex: target.pageIndex,
      engineMessage: `annotation ${target.id} on page ${target.pageIndex + 1} is not a dictionary`,
    });
  }
  const subtype = nameOf(dict.get('Subtype'));
  if (subtype === WIDGET || subtype === POPUP) {
    throw new ToolError('unsupported', {
      engine: 'mupdf',
      pageIndex: target.pageIndex,
      engineMessage:
        subtype === WIDGET
          ? `annotation ${target.id} is a form field widget (${WIDGET}); transforming it would move a field's visible half`
          : `annotation ${target.id} is a popup window (${POPUP}); its position is the reader's, not the page's`,
    });
  }
  return { dict, subtype };
}

/**
 * Move and turn persisted annotations, all of them or none.
 *
 * Bytes in, bytes out, through MuPDF: the input is never mutated (`K15`) and the
 * produced file is verified before it is returned. Every target is resolved on the
 * page it names, `/Widget` and `/Popup` targets are refused, and the geometry and
 * appearance of each resolved annotation are rewritten together — a rect that moved
 * while its `/QuadPoints` or its appearance stayed put is exactly the bug this
 * module exists to prevent. The first failure throws and produces no bytes.
 */
export async function transformPdfAnnotations(
  bytes: Uint8Array,
  request: TransformAnnotationsRequest,
  context: OperationContext,
): Promise<AnnotationTransformOutcome> {
  throwIfAborted(context.signal);
  const targets = planTargets(request);
  const transform = checkedTransform(request?.transform);
  if (targets.length === 0 || (transform.dx === 0 && transform.dy === 0 && transform.rotation === 0)) {
    return nothingToDo(bytes);
  }

  const { doc } = await openForWrite(bytes);
  let saved: Uint8Array;
  let expectation: TransformExpectation;
  const transformed: string[] = [];
  try {
    try {
      const pages = pageObjects(doc);
      const pageCount = pages.length;
      // Everything below is read before the first mutation: a digest taken afterwards
      // would describe the values the writer is about to change.
      const pageFacts = pages.map((page) => pageDigest(page));
      const beforeIds = pages.map((page) => [...pageIds(doc, page)]);
      const form = formDigest(doc);
      const untouched = new Map<number, Map<string, string>>();
      for (const [index, page] of pages.entries()) {
        const digests = new Map<string, string>();
        for (const id of pageIds(doc, page)) {
          const { dict } = findOnPage(doc, page, id);
          if (dict !== null) digests.set(id, annotationDigest(dict));
        }
        untouched.set(index, digests);
      }

      const targetExpectations: TargetExpectation[] = [];
      for (const [index, target] of targets.entries()) {
        throwIfAborted(context.signal);
        const { dict, subtype } = resolveTarget(doc, pages, target);
        const geometry = readGeometry(dict);
        const rect = geometry.rect;
        const pivot = pivotOf(geometry);
        if (rect === null || pivot === null) {
          throw new ToolError('selection-empty', {
            engine: 'mupdf',
            pageIndex: target.pageIndex,
            engineMessage: `annotation ${target.id} on page ${target.pageIndex + 1} carries no geometry to move`,
          });
        }
        // A selected object has its own geometry/appearance expectations below.
        // Only the remaining objects must match their original digest unchanged.
        untouched.get(target.pageIndex)?.delete(target.id);
        // The app's `y` grows downward and PDF's upward, so the turn keeps its angle
        // and the offset flips: a `+5`-point nudge down the page is `−5` in `/Rect`.
        // Written out rather than taken from `turnPoint`, because that helper speaks
        // the app's y-down space and this mapping is the PDF-space form of the same
        // turn: a clockwise app-space turn is `−sin` here, not `+sin`.
        const place = (x: number, y: number) => {
          const cos = TURN_COS[transform.rotation];
          const sin = TURN_SIN[transform.rotation];
          const offsetX = x - pivot.x;
          const offsetY = y - pivot.y;
          return {
            x: pivot.x + offsetX * cos + offsetY * sin + transform.dx,
            y: pivot.y - offsetX * sin + offsetY * cos - transform.dy,
          };
        };
        const newRect = placeBox(rect, place);
        const written = writeGeometry(doc, dict, { ...geometry, rect }, place);
        const appearance = rewriteAppearance(doc, dict.get('AP'), {
          rect,
          newRect,
          place,
          rotation: transform.rotation,
        });
        if (appearance !== null) dict.put('AP', appearance.dict);

        targetExpectations.push({
          pageIndex: target.pageIndex,
          id: target.id,
          subtype,
          contents: textOf(dict.get('Contents')),
          geometry: written,
          wrapped: appearance?.wrapped ?? [],
        });
        transformed.push(target.id);
        context.onProgress?.({
          phase: 'annotate',
          labelKey: 'op.progress.annotate',
          done: index + 1,
          total: targets.length,
        });
      }
      expectation = {
        pageCount,
        pages: pageFacts,
        pageIds: beforeIds,
        untouched,
        form,
        targets: targetExpectations,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'annotations.transform');
    }

    throwIfAborted(context.signal);
    saved = saveRewrite(doc, 'annotations.transform');
  } finally {
    doc.destroy();
  }
  await verifyTransform(saved, expectation);

  return {
    bytes: saved,
    transformed,
    report: {
      engine: 'mupdf',
      steps: ['load', 'annotations.transform', 'save', 'verify'],
      notes: [
        // The operation's own result first: what the selection moved. The producer
        // line is still merged (metadata survives the rewrite) and still reported,
        // but it never stands in for the result.
        note('changed', 'ann.transformed', { count: transformed.length }),
        note('preserved', 'op.note.metadata.producerKept', { producer: PRODUCER_LINE }),
      ],
      inputBytes: bytes.byteLength,
      outputBytes: saved.byteLength,
      pageCount: expectation.pageCount,
      incremental: false,
    },
  };
}
