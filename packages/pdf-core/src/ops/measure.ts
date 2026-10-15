/**
 * Measurement tools — the ruler, the perimeter chain, the area polygon — and the
 * real PDF `/Measure` annotations they become (`M` = measure: "measurement tools,
 * ruler/grid/snap").
 *
 * ## The three coordinate spaces, and why this file names all of them
 *
 * Two coordinate-space defects once made every text edit silent, and the
 * annotation writer already settled the rule for this
 * app: a pointer produces **one** space, and it is converted once, explicitly.
 *
 *  - **app space** — what `ViewerApi.pointToPage` answers and therefore what
 *    `AnnotationMark.quads` and `PageRect` hold: pdf.js's own
 *    `PageViewport.convertToPdfPoint`, so zoom, the spread layout and `/Rotate`
 *    are already undone, with `x` in PDF user space and `y` flipped to run
 *    downwards from the **top of the page box**. `appToUserPoint` inverts that
 *    flip; the map is an involution, so it is the same call in both directions.
 *    Every measurement entry point here takes its points in this space.
 *  - **user space** — the PDF's own space (origin at the box's lower-left, `y`
 *    up). Every `/Rect`, `/L` and `/Vertices` written by this module is in it.
 *  - **display space** — the *displayed* page: origin at the top-left corner
 *    after `/Rotate`, `u` right, `v` down. That is the space `ops/link-edit.ts`
 *    and `ops/outline-edit.ts` document, and the space a caller that measures on
 *    the rendered page (the link tool's rectangle) already has.
 *    `measureDisplayToUserPoint` is that file's table re-stated here, so the
 *    measurement's geometry and the link's geometry cannot drift;
 *    `appToDisplayPoint` composes the two.
 *
 * The composite is derived from **pdf.js's own `PageViewport` transform**
 * (`pdfjs-dist@6.3.289`, `build/pdf.mjs:810`) rather than from a drawn picture:
 * for a page box `(x1, y1, x2, y2)` with `W = x2 − x1`, `H = y2 − y1` and an app
 * point `(X, Y)`, the displayed coordinates are
 *
 *   | rotation | `u`          | `v`          |
 *   |---------:|--------------|--------------|
 *   | 0        | `X − x1`     | `Y`          |
 *   | 90       | `y2 − Y`     | `X − x1`     |
 *   | 180      | `x2 − X`     | `H − Y`      |
 *   | 270      | `Y`          | `x2 − X`     |
 *
 * and every row is checked against that transform
 * for an **offset** box (`/MediaBox [20 30 420 630]`), which is the case where a
 * flip about `page.getSize().height` — instead of about the box's own top — is
 * silently off by the box origin.
 *
 * ## What a measurement is
 *
 * Distance, perimeter and area are computed in **user space**, after the
 * conversion. The app→user map is a reflection, so lengths, perimeters and areas
 * are the same number in either space: the conversion matters for the *written*
 * geometry, not for the arithmetic — which is exactly why the probe exercises a
 * rotated page against the written bytes instead of assuming it away.
 *
 * ## The file side
 *
 * A finished measurement is a real annotation carrying a `/Measure` dictionary
 * in the form ISO 32000-1 §12.9 defines (Tables 261–263), so a reader opens our
 * ruler as a measurement instead of as a stray line:
 *
 *   | measurement | annotation `/Subtype` |
 *   |---|---|
 *   | distance (two points) | `/Line` (+ `/L`) |
 *   | perimeter (open chain) | `/PolyLine` (+ `/Vertices`) |
 *   | area (two corners) | `/Square` (+ `/Vertices`) |
 *   | area (three or more points) | `/Polygon` (+ `/Vertices`) |
 *
 * Whatever the kind, the dictionary is `/Type /Measure /Subtype /RL` — the one
 * coordinate-system subtype ISO 32000-1 defines; what separates a distance from
 * an area is which number format array a reader applies, not a subtype:
 *
 *  - `/R` is the scale as **text**: `(1 cm = 5 m)` or `(1:100)`;
 *  - `/X`, `/D` and `/A` are **arrays** of number format dictionaries, each
 *    `/Type /NumberFormat /U (unit label) /C factor /D precision /FD true`. `/X`'s
 *    `/C` converts user-space units (`/UserUnit`-aware) into real-world units,
 *    `/D`'s and `/A`'s `/C` are 1 because the unit is the same one squared for
 *    area (the standard defines them as "from the first element of `/X`");
 *    `/D` is the decimal precision (`100` = two digits) and `/FD true` keeps
 *    trailing zeros, which is how the readout prints them.
 *
 * What the probe proves is that the dictionary, its three arrays, the ratio text,
 * the unit and the geometry survive a real write and a re-read of the produced
 * bytes (`measure.test.ts`). No independent reader's rendering of the dictionary
 * was observed in this environment.
 *
 * ## `/UserUnit`
 *
 * A page's `/UserUnit` (ISO 32000-1 Table 30) is the size of one user-space unit
 * in multiples of 1/72 inch — a CAD sheet with `/UserUnit 10` draws 720 ppi. Every
 * distance and area in this file is in user-space units, and every conversion
 * into real-world units multiplies by it: one user-space unit is `UserUnit / 72`
 * inch of paper, not always `1 / 72`.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  openForWrite,
  pageObjects,
  pdfDate,
  resolved,
  saveRewrite,
  text,
  visibleBox,
} from '../engines/mupdf-write';
import { hexToRgb, markerFor } from './annotations';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
} from './types';

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

/**
 * Every entry point here is bounded: a chain is a user gesture,
 * not a path tracer, and a document cannot be asked to carry an unbounded number
 * of new annotations in one call.
 */
export const MEASURE_LIMITS = {
  /** Marks one call will write. */
  marks: 200,
  /** Points in one chain. */
  points: 128,
  /** A measurement shorter than this (user-space points) is a click, not a mark. */
  minPoints: 1,
  /** Largest absolute coordinate accepted, in points. */
  maxCoordinate: 100000,
  /** Largest scale ratio accepted (`1:10000000`). */
  maxRatio: 1e7,
  /** Smallest scale ratio accepted (`10000000:1`). */
  minRatio: 1e-7,
} as const;

// ---------------------------------------------------------------------------
// the scale
// ---------------------------------------------------------------------------

/** Real-world units a measurement can be printed in. */
export type MeasureUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const MEASURE_UNITS: readonly MeasureUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];

const POINTS_PER_INCH = 72;

/** Inches in one unit — the only table the scale arithmetic needs. */
const INCHES_PER_UNIT: Readonly<Record<MeasureUnit, number>> = {
  mm: 1 / 25.4,
  cm: 1 / 2.54,
  m: 1000 / 25.4,
  in: 1,
  ft: 12,
};

/** PDF points that one *drawn* unit of length occupies on paper (72 for `in`). */
function drawnPointsPerUnit(unit: MeasureUnit): number {
  return POINTS_PER_INCH * INCHES_PER_UNIT[unit];
}

/**
 * Unit words accepted in the `1 cm = 5 m` form. The canonical SI/imperial symbols
 * first, then the words a Turkish or English user types; a word that is not here
 * makes the whole string unreadable (`null`), it is never guessed.
 */
const UNIT_ALIASES: Readonly<Record<string, MeasureUnit>> = {
  mm: 'mm',
  milimetre: 'mm',
  milimeter: 'mm',
  millimeter: 'mm',
  cm: 'cm',
  santim: 'cm',
  santimetre: 'cm',
  centimeter: 'cm',
  centimetre: 'cm',
  m: 'm',
  metre: 'm',
  meter: 'm',
  in: 'in',
  inc: 'in',
  inç: 'in',
  inch: 'in',
  inches: 'in',
  ft: 'ft',
  fit: 'ft',
  foot: 'ft',
  feet: 'ft',
};

/**
 * A drawing scale: how many PDF points represent one real-world unit, plus the
 * unit itself and the dimensionless ratio behind both.
 */
export interface MeasureScale {
  /** Real-world unit the measurement is printed in. */
  readonly unit: MeasureUnit;
  /** PDF points that represent **one** real-world unit (`1:100` in cm → 0.2835). */
  readonly pointsPerUnit: number;
  /** Real length ÷ drawn length: 100 for `1:100`, 12 for `1 in = 10 ft`. */
  readonly ratio: number;
  /** The ratio as a user writes it: `1:500`. */
  readonly ratioText: string;
  /** The string this scale was read from, normalised (the equation form when given). */
  readonly expression: string;
}

const NUMBER_TOKEN = String.raw`\d{1,9}(?:[.,]\d{1,6})?`;
const UNIT_TOKEN = '[A-Za-zÇĞİÖŞÜçğıöşü]{1,12}';
/** A leading label such as `Ölçek` / `Scale =` — letters and separators, no digits. */
const LABEL_LENGTH = 24;
const RATIO_FORM = new RegExp(`^(${NUMBER_TOKEN})\\s*[:/]\\s*(${NUMBER_TOKEN})$`);
const EQUATION_FORM = new RegExp(
  `^(${NUMBER_TOKEN})\\s*(${UNIT_TOKEN})\\s*=\\s*(${NUMBER_TOKEN})\\s*(${UNIT_TOKEN})$`,
);

/** `12,5` and `12.5` both read as twelve and a half; `1.234,5` is refused, not guessed. */
function parseDecimal(token: string): number | null {
  // `NUMBER_TOKEN` admits digits with at most one `.` or `,` and a digit on each side of it, so
  // the token is always a plain decimal; the one thing left to refuse is zero.
  const value = Number(token.replace(',', '.'));
  return value > 0 ? value : null;
}

/** A scale, built from a ratio this module computed. */
export function scaleForRatio(ratio: number, unit: MeasureUnit = 'cm'): MeasureScale {
  if (!(Number.isFinite(ratio) && ratio > 0)) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `measurement ratio is not a positive number: ${ratio}`,
    });
  }
  if (ratio > MEASURE_LIMITS.maxRatio || ratio < MEASURE_LIMITS.minRatio) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `measurement ratio ${ratio} is outside 1:${MEASURE_LIMITS.maxRatio}`,
    });
  }
  const rounded = roundRatio(ratio);
  const pointsPerUnit = drawnPointsPerUnit(unit) / rounded;
  return {
    unit,
    pointsPerUnit,
    ratio: rounded,
    ratioText: `1:${formatRatioNumber(rounded)}`,
    expression: `1:${formatRatioNumber(rounded)} ${unit}`,
  };
}

/** Six significant digits: enough for any drawing scale, few enough to write plainly. */
function roundRatio(ratio: number): number {
  return Number(ratio.toPrecision(6));
}

/** Ratios are printed with at most four decimals and no trailing zeros. */
function formatRatioNumber(ratio: number): string {
  return Number(ratio.toPrecision(6)).toString();
}

/**
 * Read a drawing scale from the strings a user types: `1:100`, `1 / 250`,
 * `1 cm = 5 m`, `1 in = 10 ft`, `Ölçek 1:50`.
 *
 * `unit` supplies the real-world unit for the **ratio forms**, which carry none
 * (the unit is a separate setting in the tool, as it is in Acrobat). The
 * equation form names its own unit on the right-hand side and that unit wins.
 *
 * Anything this cannot read honestly returns `null` — a wrong scale silently
 * misstates every measurement in the document, so it is never guessed.
 */
export function parseScale(text: string, unit: MeasureUnit = 'cm'): MeasureScale | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const firstDigit = trimmed.search(/\d/);
  const body = trimmed.slice(Math.min(firstDigit < 0 ? trimmed.length : firstDigit, LABEL_LENGTH)).trim();

  // The groups cast below are mandatory in both patterns, so a match always holds all of them.
  const ratioForm = RATIO_FORM.exec(body);
  if (ratioForm !== null) {
    const drawn = parseDecimal(ratioForm[1] as string);
    const real = parseDecimal(ratioForm[2] as string);
    if (drawn === null || real === null) return null;
    // `1:100` states "one drawn unit is 100 real units"; `2:1` is an enlargement.
    return normaliseScale(real / drawn, unit, `1:${formatRatioNumber(real / drawn)} ${unit}`);
  }

  const equation = EQUATION_FORM.exec(body);
  if (equation !== null) {
    const drawn = parseDecimal(equation[1] as string);
    const real = parseDecimal(equation[3] as string);
    const drawnUnit = UNIT_ALIASES[(equation[2] as string).toLocaleLowerCase('tr')];
    const realUnit = UNIT_ALIASES[(equation[4] as string).toLocaleLowerCase('tr')];
    if (drawn === null || real === null || drawnUnit === undefined || realUnit === undefined) return null;
    // Both sides in inches: `1 in = 10 ft` is `12 real inches ÷ 1 drawn inch` = 1:12.
    const inchesReal = real * INCHES_PER_UNIT[realUnit];
    const inchesDrawn = drawn * INCHES_PER_UNIT[drawnUnit];
    return normaliseScale(
      inchesReal / inchesDrawn,
      realUnit,
      `${formatRatioNumber(drawn)} ${drawnUnit} = ${formatRatioNumber(real)} ${realUnit}`,
    );
  }

  return null;
}

/** The bounds check both parse paths end in, so no path can return a nonsense scale. */
function normaliseScale(ratio: number, unit: MeasureUnit, expression: string): MeasureScale | null {
  // Both sides of the ratio are positive and at most fifteen digits, so it is positive and finite.
  if (ratio > MEASURE_LIMITS.maxRatio || ratio < MEASURE_LIMITS.minRatio) return null;
  // Six significant digits, and the *same* number everywhere: `/Measure /R` is
  // written from `ratio`, so a ratio of 500.00000000000006 (the honest result of
  // `5 m ÷ 1 cm` through inches) would put a number in the file that the readout
  // prints as `1:500`. One ratio, printed and written identically.
  const rounded = roundRatio(ratio);
  const pointsPerUnit = drawnPointsPerUnit(unit) / rounded;
  return {
    unit,
    pointsPerUnit,
    ratio: rounded,
    ratioText: `1:${formatRatioNumber(rounded)}`,
    expression,
  };
}

export function isMeasureUnit(value: string): value is MeasureUnit {
  return (MEASURE_UNITS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// geometry: the conversions
// ---------------------------------------------------------------------------

/** The four values `/Rotate` can hold. */
export type MeasureRotation = 0 | 90 | 180 | 270;

/** A page box in PDF user space (`{x, y, width, height}`, as `visibleBox` reports one). */
export interface MeasureBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What every conversion needs: the visible box (CropBox, MediaBox as fallback —
 * the same box pdf.js hands its viewport as `viewBox`, which is what makes the
 * app space and the written geometry two views of one page) and its `/Rotate`.
 */
export interface MeasurePageGeometry {
  readonly rotation: MeasureRotation;
  readonly box: MeasureBox;
  /**
   * The page's `/UserUnit`: the size of one user-space unit in multiples of 1/72 inch
   * (ISO 32000-1 Table 30). Omitted means the default, 1. A caller that only draws (the
   * overlay's grid, the pointer conversions) never needs it; the readout and the writer
   * do, because it scales every real-world number.
   */
  readonly userUnit?: number;
}

/** A point, in whichever of the three spaces the function's name says. */
export interface MeasurePoint {
  readonly x: number;
  readonly y: number;
}

/** `/Rotate` is a multiple of 90; anything else is rounded to the nearest quarter turn. */
export function quarterTurns(angle: number): MeasureRotation {
  const normalized = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

/** The page geometry, read the one way this codebase reads it (`ops/link-edit.ts`). */
export function measureGeometry(page: PDFObject): MeasurePageGeometry {
  const rotate = resolved(page.getInheritable('Rotate'));
  // `/UserUnit` is a page-level key, not an inheritable one (ISO 32000-1 Table 30).
  const userUnit = resolved(page.get('UserUnit'));
  return {
    rotation: quarterTurns(rotate?.isNumber() === true ? rotate.asNumber() : 0),
    box: visibleBox(page),
    userUnit: normaliseUserUnit(userUnit?.isNumber() === true ? userUnit.asNumber() : undefined),
  };
}

/**
 * A `/UserUnit` as a usable factor: the default 1 for an absent, zero, negative or
 * non-finite value — the standard requires a positive number, and a file that holds
 * anything else is read as if the key were not there rather than scaling every
 * measurement by nonsense.
 */
function normaliseUserUnit(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * App space → PDF user space, and back: one flip about the page box's top edge.
 *
 * The map is its own inverse (`y = box.y + box.height − y` twice is the identity),
 * which is why `userToAppPoint` is the same function and not a second table. An
 * app point's `x` is already a user-space `x` — pdf.js's `convertToPdfPoint`
 * answers user space, only its `y` is measured downwards.
 */
export function appToUserPoint(geometry: MeasurePageGeometry, point: MeasurePoint): MeasurePoint {
  return { x: point.x, y: geometry.box.y + geometry.box.height - point.y };
}

/** The inverse of {@link appToUserPoint}; the same map. */
export const userToAppPoint = appToUserPoint;

/**
 * Display space → PDF user space, for the four rotations.
 *
 * The table is `ops/link-edit.ts`'s (and `ops/page-boxes.ts`'s `pageSpaceToUser`)
 * to the letter, so a point the link tool measured and a point the ruler measured
 * convert identically. `W`/`H` are the box extents **before** the rotation.
 */
export function measureDisplayToUserPoint(geometry: MeasurePageGeometry, u: number, v: number): MeasurePoint {
  const { x, y, width, height } = geometry.box;
  switch (geometry.rotation) {
    case 90:
      return { x: x + v, y: y + u };
    case 180:
      return { x: x + width - u, y: y + v };
    case 270:
      return { x: x + width - v, y: y + height - u };
    default:
      return { x: x + u, y: y + height - v };
  }
}

/** Display space → app space: the same table, then the flip into the app's origin. */
export function displayToAppPoint(geometry: MeasurePageGeometry, u: number, v: number): MeasurePoint {
  const user = measureDisplayToUserPoint(geometry, u, v);
  return appToUserPoint(geometry, user);
}

/**
 * App space → display space, in one step — the rows in this file's header, which
 * are pdf.js's own `PageViewport` transform written out. The overlay draws with
 * this and nothing else.
 */
export function appToDisplayPoint(
  geometry: MeasurePageGeometry,
  point: MeasurePoint,
): { readonly u: number; readonly v: number } {
  const { x, y, width, height } = geometry.box;
  const x2 = x + width;
  const _y2 = y + height;
  switch (geometry.rotation) {
    case 90:
      // `u` runs with the user-space `y` (the page is turned clockwise, so the
      // page's top edge becomes the displayed page's right edge), which is why it
      // is the *height* the app's downward `y` is subtracted from — not `y2`.
      return { u: height - point.y, v: point.x - x };
    case 180:
      return { u: x2 - point.x, v: height - point.y };
    case 270:
      return { u: point.y, v: x2 - point.x };
    default:
      return { u: point.x - x, v: point.y };
  }
}

/** The displayed size of a page in points — width and height swap for 90/270. */
export function displaySize(geometry: MeasurePageGeometry): {
  readonly width: number;
  readonly height: number;
} {
  const swapped = geometry.rotation === 90 || geometry.rotation === 270;
  return swapped
    ? { width: geometry.box.height, height: geometry.box.width }
    : { width: geometry.box.width, height: geometry.box.height };
}

// ---------------------------------------------------------------------------
// geometry: the measurement
// ---------------------------------------------------------------------------

export type MeasureMode = 'distance' | 'perimeter' | 'area';

export const MEASURE_MODES: readonly MeasureMode[] = ['distance', 'perimeter', 'area'];

export interface Measurement {
  readonly mode: MeasureMode;
  /**
   * The chain in PDF user space, in click order. An area given as two corners is
   * stored as its four corners, so the chain and the polygon are the same list.
   */
  readonly points: readonly MeasurePoint[];
  /** Bounding box of the chain, user space, ascending (`[x0, y0, x1, y1]`). */
  readonly rect: readonly [number, number, number, number];
  /** The open chain's length: the ruler's distance, or a chain's total length. */
  readonly length: number;
  /** The closed boundary's length (area mode) — the chain, plus the closing segment. */
  readonly perimeter: number;
  /**
   * Shoelace area of the closed chain; 0 for the open modes, and `NaN` when the
   * boundary crosses itself ({@link Measurement.selfIntersecting}) — the signed
   * sum then cancels one lobe against the other, so any number it gave would be a
   * wrong area presented as a right one.
   */
  readonly area: number;
  /**
   * Whether the closed boundary of an area chain of three or more clicked points
   * crosses or touches itself (a bow-tie). Always `false` for the open modes and for
   * the rectangle two corners span.
   */
  readonly selfIntersecting: boolean;
  /** Direction of the first segment, degrees counter-clockwise from `+x`, 0…360. */
  readonly bearing: number;
  /**
   * The page's `/UserUnit` the chain was measured on (1 when it has none): every
   * length above is in user-space units, each of which is `userUnit / 72` inch.
   */
  readonly userUnit: number;
}

/** The four corners of the rectangle two points span, ascending, in click order. */
export function squareCorners(a: MeasurePoint, b: MeasurePoint): readonly MeasurePoint[] {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const bottom = Math.min(a.y, b.y);
  const top = Math.max(a.y, b.y);
  return [
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: right, y: top },
    { x: left, y: top },
  ];
}

function requirePoint(point: MeasurePoint, where: string): MeasurePoint {
  const { x, y } = point;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `${where}: point is not a finite number (${String(x)}, ${String(y)})`,
    });
  }
  if (Math.abs(x) > MEASURE_LIMITS.maxCoordinate || Math.abs(y) > MEASURE_LIMITS.maxCoordinate) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `${where}: point ${x},${y} is outside ±${MEASURE_LIMITS.maxCoordinate} pt`,
    });
  }
  return { x, y };
}

/**
 * Measure a chain **in PDF user space**. An area of two points is expanded to its
 * four corners first, so the returned `points` are always the polygon the
 * annotation will carry.
 *
 * A chain that cannot be measured raises a `ToolError` instead of returning a
 * number nobody can act on: fewer than two points, a non-finite coordinate, or a
 * `distance` that is not exactly two points. An area whose boundary crosses itself
 * is the one case that is *reported* rather than thrown — `selfIntersecting` is
 * `true` and `area` is `NaN` — because the live readout asks for it on every
 * pointer move while the polygon is still being drawn and must show "no value yet",
 * not fail; the writer is the one that refuses it.
 *
 * `userUnit` is the page's `/UserUnit`; the geometry is in user-space units either
 * way, it only travels with the result for the conversion into real-world units.
 */
export function measureChain(points: readonly MeasurePoint[], mode: MeasureMode, userUnit = 1): Measurement {
  const where = 'measure.measureChain';
  if (points.length < 2) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: `${where}: a measurement needs at least two points (got ${points.length})`,
    });
  }
  if (points.length > MEASURE_LIMITS.points) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `${where}: ${points.length} points is more than ${MEASURE_LIMITS.points}`,
    });
  }

  const checked = points.map((point) => requirePoint(point, where));
  const first = checked[0] as MeasurePoint;
  const second = checked[1] as MeasurePoint;

  // Two clicked corners are a rectangle, not a polygon: the same shape the
  // `/Square` branch of the writer draws, measured here so the readout the user
  // sees while dragging and the geometry that reaches the file are one number.
  const chain = mode === 'area' && checked.length === 2 ? squareCorners(first, second) : checked;

  if (mode === 'distance' && chain.length !== 2) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `${where}: a distance is two points (got ${chain.length})`,
    });
  }
  // An area has at least three points here: two clicked corners were expanded to four above.

  let length = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [index, point] of chain.entries()) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
    const previous = chain[index - 1];
    if (previous !== undefined) length += Math.hypot(point.x - previous.x, point.y - previous.y);
  }

  const closed = mode === 'area';
  // The closing segment is measured on the *chain*, not on the clicked points: a
  // two-corner area was expanded to its four corners, and the last clicked point
  // is the corner the chain already contains.
  const last = chain[chain.length - 1] as MeasurePoint;
  const start = chain[0] as MeasurePoint;
  const perimeter = closed ? length + Math.hypot(start.x - last.x, start.y - last.y) : length;
  // The rectangle two corners span cannot cross itself; only a clicked polygon can.
  const selfIntersecting = closed && checked.length > 2 && crossesItself(chain);
  let area = 0;
  if (closed) area = selfIntersecting ? Number.NaN : shoelace(chain);

  return {
    mode,
    points: chain,
    rect: [minX, minY, maxX, maxY],
    length,
    perimeter,
    area,
    selfIntersecting,
    bearing: bearingDegrees(first, second),
    userUnit: normaliseUserUnit(userUnit),
  };
}

/** The absolute polygon area, `0.5·|Σ (xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ)|`. Only meaningful for a simple polygon. */
function shoelace(points: readonly MeasurePoint[]): number {
  let sum = 0;
  for (const [index, point] of points.entries()) {
    const next = points[(index + 1) % points.length] as MeasurePoint;
    sum += point.x * next.y - next.x * point.y;
  }
  return Math.abs(sum) / 2;
}

/** Twice the signed area of the triangle `a b c`: positive when `c` lies left of `a → b`. */
function orientation(a: MeasurePoint, b: MeasurePoint, c: MeasurePoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Whether `p`, which is collinear with `a b`, lies within the segment's bounding box. */
function withinSegment(a: MeasurePoint, b: MeasurePoint, p: MeasurePoint): boolean {
  return (
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  );
}

/** Whether two segments share a point: a proper crossing, a touch, or a collinear overlap. */
function segmentsMeet(a: MeasurePoint, b: MeasurePoint, c: MeasurePoint, d: MeasurePoint): boolean {
  const abc = orientation(a, b, c);
  const abd = orientation(a, b, d);
  const cda = orientation(c, d, a);
  const cdb = orientation(c, d, b);
  if (((abc > 0 && abd < 0) || (abc < 0 && abd > 0)) && ((cda > 0 && cdb < 0) || (cda < 0 && cdb > 0))) {
    return true;
  }
  return (
    (abc === 0 && withinSegment(a, b, c)) ||
    (abd === 0 && withinSegment(a, b, d)) ||
    (cda === 0 && withinSegment(c, d, a)) ||
    (cdb === 0 && withinSegment(c, d, b))
  );
}

/**
 * Whether a closed polygon's boundary crosses or touches itself.
 *
 * The shoelace sum is a *signed* area: the two lobes of a bow-tie wind in opposite
 * directions and cancel, so a bow-tie of two equal triangles measures ≈ 0 and a
 * lopsided one measures the difference of its lobes — never the area a person
 * would call "inside". Every pair of edges that are not neighbours is tested
 * (`n ≤ MEASURE_LIMITS.points`, so at most a few thousand tests); neighbouring
 * edges share exactly their common vertex by construction. Touching counts: a
 * figure-eight pinched at a vertex cancels just the same.
 *
 * The ring is cleaned first. A repeated click is a zero-length edge, and clicking the
 * first point again to close the polygon (what snapping to the chain's own vertices
 * invites) puts its start at the end too: neither is a crossing, and the second would
 * otherwise read as the last edge touching the first.
 */
function crossesItself(polygon: readonly MeasurePoint[]): boolean {
  const ring: MeasurePoint[] = [];
  for (const point of polygon) {
    const previous = ring[ring.length - 1];
    if (previous === undefined || previous.x !== point.x || previous.y !== point.y) ring.push(point);
  }
  const head = ring[0];
  const tail = ring[ring.length - 1];
  if (ring.length > 1 && head !== undefined && tail !== undefined && head.x === tail.x && head.y === tail.y) {
    ring.pop();
  }
  const count = ring.length;
  for (let first = 0; first < count; first += 1) {
    const a = ring[first] as MeasurePoint;
    const b = ring[(first + 1) % count] as MeasurePoint;
    for (let second = first + 2; second < count; second += 1) {
      // The last edge closes onto the first: they are neighbours too.
      if (first === 0 && second === count - 1) continue;
      const c = ring[second] as MeasurePoint;
      const d = ring[(second + 1) % count] as MeasurePoint;
      if (segmentsMeet(a, b, c, d)) return true;
    }
  }
  return false;
}

/** The first segment's direction in degrees, counter-clockwise from `+x`, normalised to 0…360. */
export function bearingDegrees(from: MeasurePoint, to: MeasurePoint): number {
  const degrees = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
  return ((degrees % 360) + 360) % 360;
}

/** A chain in **app space** (`ViewerApi.pointToPage`) → its measurement in user space. */
export function measureMark(
  geometry: MeasurePageGeometry,
  points: readonly MeasurePoint[],
  mode: MeasureMode,
): Measurement {
  const userPoints = points.map((point) => appToUserPoint(geometry, point));
  return measureChain(userPoints, mode, geometry.userUnit);
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

/**
 * The product's default locale is Turkish; a formatter called without a locale prints
 * with it. A caller that has the interface's locale passes it — the written
 * `/Contents` (`writeMeasureAnnotations`) and the live readout both do, so what a
 * person reads is in the language they use.
 */
export const DEFAULT_MEASURE_LOCALE = 'tr';

/**
 * What a formatter prints when the number is not one — `NaN`, `±Infinity`.
 * A ruler that reads `NaN cm` is worse than one that admits it has no value.
 */
export const UNMEASURED = '—';

const MIN_DECIMALS = 0;
const MAX_DECIMALS = 6;

export interface MeasureFormatOptions {
  /** BCP-47 tag for the number format. */
  readonly locale?: string;
  /** Digits after the decimal point, instead of the magnitude rule. */
  readonly decimals?: number;
  /**
   * The page's `/UserUnit` (1 when omitted) for the formatters that take a bare
   * user-space number; a {@link Measurement} carries its own.
   */
  readonly userUnit?: number;
}

/**
 * Digits after the decimal point for a value: the readout keeps roughly four
 * significant digits, so `352,8 cm` does not pretend to millimetre precision
 * while `0,284 pt` keeps them.
 */
export function significantDecimals(value: number): number {
  const magnitude = Math.abs(value);
  if (!Number.isFinite(magnitude)) return 0;
  if (magnitude >= 1000) return 0;
  if (magnitude >= 100) return 1;
  if (magnitude >= 10) return 2;
  if (magnitude >= 1) return 2;
  return 3;
}

/**
 * One formatter per locale and precision: the live readout runs on pointer moves,
 * and `Intl.NumberFormat` construction is an order of magnitude more expensive
 * than `format()` (no avoidable work in a render loop).
 */
const FORMATTERS = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, decimals: number): Intl.NumberFormat {
  const key = `${locale}|${decimals}`;
  const cached = FORMATTERS.get(key);
  if (cached !== undefined) return cached;
  // Grouping stays on: the digits are printed the way the reader of that locale writes them
  // (`1,234.5` in English, `1.234,5` in Turkish), which is what the file's `/Contents` must
  // read like to someone who opens it in a viewer that knows nothing of this app.
  const format = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  FORMATTERS.set(key, format);
  return format;
}

function clampDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) return 2;
  return Math.min(Math.max(Math.round(decimals), MIN_DECIMALS), MAX_DECIMALS);
}

/** A number with a fixed number of decimals and a real `NaN` guard. */
export function formatNumber(value: number, decimals: number, locale = DEFAULT_MEASURE_LOCALE): string {
  if (!Number.isFinite(value)) return UNMEASURED;
  return numberFormat(locale, clampDecimals(decimals)).format(value);
}

function formatValue(value: number, options: MeasureFormatOptions | undefined): string {
  const locale = options?.locale ?? DEFAULT_MEASURE_LOCALE;
  const decimals = options?.decimals ?? significantDecimals(value);
  return formatNumber(value, decimals, locale);
}

/**
 * User-space units that stand for **one real-world unit**. `scale.pointsPerUnit` counts
 * 1/72-inch points of paper; a page whose `/UserUnit` is `u` has user-space units of
 * `u` points each, so it takes `1/u` as many of them. Not finite and positive means the
 * scale cannot convert anything (`NaN`, `0`, `±Infinity` all fail the same test).
 */
function userUnitsPerReal(scale: MeasureScale, userUnit: number | undefined): number {
  return scale.pointsPerUnit / normaliseUserUnit(userUnit);
}

/** A user-space length in real-world units: `352,8 cm`. */
export function formatLength(userUnits: number, scale: MeasureScale, options?: MeasureFormatOptions): string {
  const perUnit = userUnitsPerReal(scale, options?.userUnit);
  if (!Number.isFinite(userUnits) || !Number.isFinite(perUnit) || perUnit <= 0) return UNMEASURED;
  return `${formatValue(userUnits / perUnit, options)} ${scale.unit}`;
}

/** A user-space area in real-world square units: `1,25 m²`. */
export function formatArea(
  squareUserUnits: number,
  scale: MeasureScale,
  options?: MeasureFormatOptions,
): string {
  const perUnit = userUnitsPerReal(scale, options?.userUnit);
  if (!Number.isFinite(squareUserUnits) || !Number.isFinite(perUnit) || perUnit <= 0) return UNMEASURED;
  return `${formatValue(squareUserUnits / (perUnit * perUnit), options)} ${scale.unit}²`;
}

/** A direction: `45,0°`. */
export function formatAngle(degrees: number, options?: MeasureFormatOptions): string {
  if (!Number.isFinite(degrees)) return UNMEASURED;
  const normalized = ((degrees % 360) + 360) % 360;
  return `${formatNumber(normalized, options?.decimals ?? 1, options?.locale ?? DEFAULT_MEASURE_LOCALE)}°`;
}

/**
 * The number a measurement reads as in real-world units — the value every
 * formatter prints and whose digits the writer records as the `/D` precision.
 *
 * One function, because a file whose `/D` precision disagreed with the digits the
 * measure tool shows would be a silent lie about precision. The page's `/UserUnit`
 * (`Measurement.userUnit`) is applied here, through the same conversion
 * `formatLength` and `formatArea` use.
 */
export function measuredValue(measurement: Measurement, scale: MeasureScale): number {
  const perUnit = userUnitsPerReal(scale, measurement.userUnit);
  if (!Number.isFinite(perUnit) || perUnit <= 0) return Number.NaN;
  return measurement.mode === 'area' ? measurement.area / (perUnit * perUnit) : measurement.length / perUnit;
}

/** The unit symbol a measurement's value carries, squared for an area. */
export function measurementUnit(measurement: Measurement, scale: MeasureScale): string {
  return measurement.mode === 'area' ? `${scale.unit}²` : scale.unit;
}

/**
 * The sentence a measurement reads as: the distance, the chain's length or the
 * area. The secondary number (`Measurement.perimeter` in area mode) is the
 * caller's to show — a single string cannot say both without inventing a layout.
 */
export function formatMeasurement(
  measurement: Measurement,
  scale: MeasureScale,
  options?: MeasureFormatOptions,
): string {
  const value = measuredValue(measurement, scale);
  if (!Number.isFinite(value)) return UNMEASURED;
  return `${formatValue(value, options)} ${measurementUnit(measurement, scale)}`;
}

// ---------------------------------------------------------------------------
// the writer
// ---------------------------------------------------------------------------

/**
 * A text string as `/R` states the scale: the equation the user typed (`1 cm = 5 m`,
 * ISO 32000-1 Table 262's own example form) or, for the ratio form that names no
 * drawn unit, the ratio itself (`1:100`, also one of the standard's examples).
 */
function scaleText(scale: MeasureScale): string {
  return scale.expression.includes('=') ? scale.expression : scale.ratioText;
}

/**
 * One number format dictionary (ISO 32000-1 Table 263), the single element of each of
 * `/X`, `/D` and `/A`:
 *
 *  - `/U` the unit label a reader prints after the number;
 *  - `/C` the conversion factor — for `/X` from user-space units to this unit, for `/D`
 *    and `/A` from `/X`'s unit (squared, for an area) to this one;
 *  - `/D` the decimal precision, a power of ten (`100` = two digits);
 *  - `/FD true`, so a reader keeps the trailing zeros the readout prints (`91,50 ft`).
 */
function numberFormatDictionary(doc: PDFDocument, unit: string, factor: number, precision: number) {
  return { Type: 'NumberFormat', U: text(doc, unit), C: factor, D: precision, FD: true };
}

/**
 * The `/Measure` dictionary, the same rectilinear form for every kind of measurement:
 * `/X`, `/D` and `/A` are all written because the standard requires all three, and a
 * reader that measures further on the annotation then finds the units it expects.
 *
 * `/X`'s factor is real-world units per user-space unit — `userUnit / pointsPerUnit`, so
 * a page with `/UserUnit 2` converts twice as much per unit. `/D` and `/A` convert from
 * `/X`'s unit to the same unit and the same unit squared, which is a factor of one. The
 * precision is one for all three: the digits the readout shows for this measurement.
 */
function measureDictionary(doc: PDFDocument, mark: MeasureMark, measurement: Measurement) {
  const unit = mark.scale.unit;
  const precision = 10 ** significantDecimals(measuredValue(measurement, mark.scale));
  return {
    Type: 'Measure',
    Subtype: 'RL',
    R: text(doc, scaleText(mark.scale)),
    X: [numberFormatDictionary(doc, unit, measurement.userUnit / mark.scale.pointsPerUnit, precision)],
    D: [numberFormatDictionary(doc, unit, 1, precision)],
    A: [numberFormatDictionary(doc, `${unit}²`, 1, precision)],
  };
}

/**
 * A measurement the session holds but the file does not yet.
 *
 * `points` are in the app space (`ViewerApi.pointToPage`) — the same space
 * `AnnotationMark.quads` uses, so one overlay rule covers both features and the
 * pointer conversion stays in the viewer.
 */
export interface MeasureMark {
  readonly id: string;
  /** 0-based. */
  readonly pageIndex: number;
  readonly mode: MeasureMode;
  readonly points: readonly MeasurePoint[];
  readonly scale: MeasureScale;
  /** `#rrggbb`. */
  readonly color: string;
  /** 0 … 1. */
  readonly opacity: number;
  /** Stroke width in points; one point when omitted. */
  readonly thickness?: number;
  readonly author: string;
  /** The user's own note; the measurement itself is prepended to `/Contents`. */
  readonly contents: string;
  /** ISO 8601, fixed at creation so a draft round-trip keeps the original date. */
  readonly createdAt: string;
}

export interface MeasureOutcome extends OperationOutcome {
  /** Marker lines of the annotations appended, in write order. */
  readonly written: readonly string[];
}

export interface MeasureWriteOptions {
  /**
   * BCP-47 tag of the interface language the measurement text in `/Contents` is
   * printed in (`1,234.5 m` for `en`, `1.234,5 m` for `tr`). The caller passes the
   * shell's `Translator.locale`; the product default, Turkish, applies when omitted.
   */
  readonly locale?: string;
}

/**
 * Append one measure annotation per mark, with its appearance stream.
 *
 * Written through MuPDF's object model for the same reason
 * `ops/annotation-shapes.ts` is: pdf.js has no writer for these subtypes, and a
 * measurement annotation's dictionary is not something the high-level API can
 * express. The appearance stream is drawn explicitly because a reader that finds
 * no `/AP` should construct one from the annotation's attributes — and readers
 * honour that very unevenly, which for a ruler means a line that may be invisible.
 *
 * Appearance syntax, because the numbers are not obvious: the stream paints in
 * **annotation space** (origin at the `/Rect`'s lower-left corner, `y` up), so
 * every vertex is the user-space vertex minus the rect's origin — a plain
 * translation, no flip, since both spaces are `y`-up.
 */
export async function writeMeasureAnnotations(
  bytes: Uint8Array,
  marks: readonly MeasureMark[],
  context: OperationContext,
  options: MeasureWriteOptions = {},
): Promise<MeasureOutcome> {
  abortIf(context.signal);
  if (marks.length === 0) return { ...(await nothingToDo(bytes)), written: [] };
  if (marks.length > MEASURE_LIMITS.marks) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `measure.write: ${marks.length} marks is more than ${MEASURE_LIMITS.marks}`,
    });
  }

  context.onProgress?.({
    phase: 'measure',
    labelKey: 'op.progress.measure',
    done: 0,
    total: marks.length,
  });

  const { doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    const written: string[] = [];
    try {
      for (const [index, mark] of marks.entries()) {
        abortIf(context.signal);
        const page = pages[mark.pageIndex];
        if (page === undefined) {
          throw new ToolError('selection-empty', {
            engine: 'mupdf',
            pageIndex: mark.pageIndex,
            engineMessage: `measure.write: the document has no page ${mark.pageIndex}`,
          });
        }

        const measurement = requireMeasurable(mark, measureGeometry(page));
        const subtype = annotationSubtype(mark);
        const stroke = strokeWidth(mark.thickness);
        const rect = annotateRect(measurement, stroke);
        const opacity = Math.min(Math.max(mark.opacity, 0), 1);
        const appearance = doc.addStream(measureAppearance(measurement, rect, stroke, mark, subtype), {
          Type: 'XObject',
          Subtype: 'Form',
          FormType: 1,
          // The stream paints in annotation space (origin at the rect's lower-left), so the
          // box is the rect's size from the origin — the rect's own coordinates would clip it away.
          BBox: [0, 0, rect[2] - rect[0], rect[3] - rect[1]],
          Matrix: [1, 0, 0, 1, 0, 0],
        });
        const dict = doc.addObject({
          Type: 'Annot',
          Subtype: subtype,
          Rect: rect,
          P: page,
          // Print flag on, so an exported file prints the measurement it shows.
          F: 4,
          Border: [0, 0, 0],
          BS: { W: stroke, S: 'S' },
          C: [...hexToRgb(mark.color)],
          CA: opacity,
          // Text strings through `text()` (`newString`): a plain JS string would become a
          // *name*, and Turkish letters must survive (`Çatı alanı`, `measure.test.ts`).
          T: text(doc, mark.author),
          // A PDF date, as `/M` requires (not the ISO string).
          M: text(doc, pdfDate(new Date(mark.createdAt))),
          NM: text(doc, markerFor(mark.id)),
          Contents: text(doc, contentsFor(mark, measurement, options.locale)),
          AP: { N: appearance },
          Measure: measureDictionary(doc, mark, measurement),
        });
        dict.put(subtype === 'Line' ? 'L' : 'Vertices', [...flatPoints(measurement.points)]);
        annotsOf(doc, page, true)?.push(dict);
        written.push(markerFor(mark.id));
        context.onProgress?.({
          phase: 'measure',
          labelKey: 'op.progress.measure',
          done: index + 1,
          total: marks.length,
        });
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw mapMupdfError(error, 'measure.write');
    }

    const saved = saveRewrite(doc, 'measure.write');
    const report: OperationReport = {
      engine: 'mupdf',
      steps: ['load', 'measure.write', 'save'],
      notes: measureNotes(written.length),
      inputBytes: bytes.byteLength,
      outputBytes: saved.byteLength,
      pageCount: pages.length,
      // A rewrite re-serialises the file: the incremental fast path ends here,
      // and the report says so.
      incremental: false,
    };
    return { bytes: saved, written, report };
  } finally {
    doc.destroy();
  }
}

/**
 * Abort as the mapped error contract.
 *
 * `ops/types.ts`'s `throwIfAborted` raises a plain `Error` named `AbortError`,
 * which `toToolError` maps to `internal`; this module promises the
 * `ToolError` contract for everything it throws, so cancellation is raised as
 * `ToolError('aborted')`. The dialog host reads `signal.aborted` for its own
 * cancelled state, so the code is what the shell shows, not what it detects.
 */
function abortIf(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolError('aborted', { engine: 'mupdf', engineMessage: 'measure.write aborted' });
  }
}

/** A measurement nobody can act on is refused, never written as an empty annotation. */
function requireMeasurable(mark: MeasureMark, geometry: MeasurePageGeometry): Measurement {
  const where = `measure.write[${mark.id}]`;
  if (!MEASURE_MODES.includes(mark.mode)) {
    throw new ToolError('unsupported', {
      engine: 'model',
      engineMessage: `${where}: unknown measurement mode ${String(mark.mode)}`,
    });
  }
  // `/X`'s conversion factor is `userUnit / pointsPerUnit`: a scale that is not a positive
  // number would put `NaN` or `Infinity` into the file where a reader reads a number.
  if (!(Number.isFinite(mark.scale.pointsPerUnit) && mark.scale.pointsPerUnit > 0)) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      pageIndex: mark.pageIndex,
      engineMessage: `${where}: scale converts ${mark.scale.pointsPerUnit} pt per unit, which is not a positive number`,
    });
  }
  const measurement = measureMark(geometry, mark.points, mark.mode);
  if (measurement.length < MEASURE_LIMITS.minPoints) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      pageIndex: mark.pageIndex,
      engineMessage: `${where}: chain length ${measurement.length} pt is below ${MEASURE_LIMITS.minPoints} pt`,
    });
  }
  // A bow-tie has no area a reader could be told: the signed sum cancels its lobes, so
  // writing one would put a confident, wrong number in the file. Refused, not clamped.
  if (measurement.selfIntersecting) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      pageIndex: mark.pageIndex,
      engineMessage: `${where}: the area polygon crosses itself, so its area cannot be measured`,
    });
  }
  if (mark.mode === 'area' && measurement.area < 1) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      pageIndex: mark.pageIndex,
      engineMessage: `${where}: area ${measurement.area} pt² is too small to measure`,
    });
  }
  return measurement;
}

/** `/Subtype`: two clicked corners are a rectangle, a chain is a polyline/polygon. */
function annotationSubtype(mark: MeasureMark): string {
  if (mark.mode === 'distance') return 'Line';
  if (mark.mode === 'perimeter') return 'PolyLine';
  return mark.points.length === 2 ? 'Square' : 'Polygon';
}

/**
 * The annotation's `/Rect`: the chain's box, grown by half the stroke width plus a
 * hair.
 *
 * Growing the rect is what keeps a stroke inside its own annotation — the earlier
 * `annotation-shapes.ts` approach clamped the *stroke* against the shape instead,
 * which for a horizontal ruler (a box with no height) silently reduced a requested
 * 2 pt line to 0.5 pt. A measurement is often exactly that: a straight line.
 */
function annotateRect(measurement: Measurement, stroke: number): readonly [number, number, number, number] {
  const [x0, y0, x1, y1] = measurement.rect;
  const pad = stroke / 2 + 0.5;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/** A stroke a user can see and a reader can draw: 0.5 … 24 pt. */
function strokeWidth(thickness: number | undefined): number {
  const requested = thickness ?? 1;
  if (!Number.isFinite(requested)) return 1;
  return Math.min(Math.max(requested, 0.5), 24);
}

/** The PDF content-stream operators the appearance uses (`PDF 32000-1` Table A.1). */
const OP = {
  SetLineWidth: 'w',
  SetLineCapStyle: 'J',
  SetLineJoinStyle: 'j',
  StrokingColorRgb: 'RG',
  MoveTo: 'm',
  LineTo: 'l',
  ClosePath: 'h',
  StrokePath: 'S',
} as const;

/**
 * The appearance stream of one measurement, in annotation space.
 *
 * `stroke` arrives already clamped and `rect` is the padded `/Rect`, so the path
 * is drawn inset by half the stroke for a line (a stroke centred on the boundary
 * of its own box is clipped) and plain — the box already contains it — for a
 * chain.
 */
function measureAppearance(
  measurement: Measurement,
  rect: readonly [number, number, number, number],
  stroke: number,
  mark: MeasureMark,
  subtype: string,
): string {
  const [rectLeft, rectBottom] = rect;
  const [red, green, blue] = hexToRgb(mark.color);
  const num = (value: number) => value.toFixed(3);
  const local = measurement.points.map((point) => ({
    x: point.x - rectLeft,
    y: point.y - rectBottom,
  }));

  const header = [
    `${num(stroke)} ${OP.SetLineWidth}`,
    `1 ${OP.SetLineCapStyle}`,
    `1 ${OP.SetLineJoinStyle}`,
    `${num(red)} ${num(green)} ${num(blue)} ${OP.StrokingColorRgb}`,
    '',
  ].join('\n');

  if (subtype === 'Line') {
    const from = local[0] as MeasurePoint;
    const to = local[1] as MeasurePoint;
    const half = stroke / 2;
    const dx = Math.sign(to.x - from.x);
    const dy = Math.sign(to.y - from.y);
    return [
      header,
      `${num(from.x + half * dx)} ${num(from.y + half * dy)} ${OP.MoveTo}`,
      `${num(to.x - half * dx)} ${num(to.y - half * dy)} ${OP.LineTo}`,
      OP.StrokePath,
      '',
    ].join('\n');
  }

  const closed = subtype !== 'PolyLine';
  const body: string[] = [];
  for (const [index, point] of local.entries()) {
    body.push(`${num(point.x)} ${num(point.y)} ${index === 0 ? OP.MoveTo : OP.LineTo}`);
  }
  if (closed) body.push(OP.ClosePath);
  body.push(OP.StrokePath);
  return [header, ...body, ''].join('\n');
}

/** A chain as the flat `[x, y, …]` array `/L` and `/Vertices` are written as. */
function flatPoints(points: readonly MeasurePoint[]): number[] {
  const flat: number[] = [];
  for (const point of points) flat.push(point.x, point.y);
  return flat;
}

/**
 * `/Contents`: the measurement, then the user's note. A reader shows the whole string,
 * which is the point — the measurement belongs to the annotation, not only to the
 * session that made it. The marker that tells this app's annotations from the
 * document's own is the annotation's name (`/NM`), which readers do not print.
 *
 * The number is printed in the interface's `locale`: the text lives in the file and is
 * read by the person who made the measurement, in the language they work in.
 */
function contentsFor(mark: MeasureMark, measurement: Measurement, locale: string | undefined): string {
  const body = mark.contents.trim();
  const value = formatMeasurement(measurement, mark.scale, { locale });
  return `${value}${body === '' ? '' : ` ${body}`}`;
}

/**
 * The report's sentences; the keys live in the measurement dictionary part
 * (`i18n/parts/measure.ts`, with its English twin in `en-parts`).
 */
function measureNotes(count: number): readonly OperationNote[] {
  return [
    note('changed', 'op.note.measure.written', { count }),
    // The one thing worth saying about the file: the /Measure dictionary is the ISO 32000-1
    // form, and a reader without measurement support shows only the line and the comment.
    note('warning', 'op.note.measure.readers'),
  ];
}

/**
 * A call that had nothing to write: same bytes, and the report says so.
 *
 * The report carries the document's **real** page count. A batch chain caches
 * `report.pageCount` and resolves the next step's `'all'` against it, so a `0` here
 * made every later page-scoped step select no pages at all.
 */
async function nothingToDo(bytes: Uint8Array): Promise<OperationOutcome> {
  const { doc } = await openForWrite(bytes);
  try {
    return {
      bytes,
      report: {
        engine: 'mupdf',
        steps: ['measure.write.skipped'],
        notes: [note('warning', 'op.note.measure.nothing')],
        inputBytes: bytes.byteLength,
        outputBytes: bytes.byteLength,
        pageCount: doc.countPages(),
        incremental: true,
      },
    };
  } catch (error) {
    throw mapMupdfError(error, 'measure.write');
  } finally {
    doc.destroy();
  }
}
