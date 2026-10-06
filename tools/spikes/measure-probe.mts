/**
 * The measurement engine, engine only (`packages/pdf-core/src/ops/measure.ts`).
 *
 * Four questions, each answered from a number rather than from a shape:
 *
 *  1. does a scale string read the way the user wrote it (`1:100`, `Ölçek 1:50`,
 *     `1 cm = 5 m`, `1 in = 10 ft`), and does something unreadable stay `null`?
 *  2. does distance/perimeter/area come out right on a page whose `/MediaBox` is
 *     **offset** and on a page with `/Rotate 90`, in the user space the file is
 *     written in — not in the space a pointer happens to answer?
 *  3. do the app ↔ display rows this module carries match **pdf.js's own
 *     `PageViewport` transform** (`build/pdf.mjs:810`), for all four rotations?
 *  4. do the bytes that leave the writer really carry `/Subtype`, `/Measure`
 *     `/R`, `/X`, `/L` and `/Vertices`, read back out of the produced file?
 *
 * The fixture is built here with MuPDF: page 1 is a plain 400×600 page, page 2
 * is the same size with `/MediaBox [20 30 420 630]` and `/Rotate 90` — the offset
 * origin is what separates a flip about the page box's own top from a flip about
 * `page.getSize().height`, and the rotation is what separates written user space
 * from displayed page space.
 *
 * Usage: npx tsx tools/spikes/measure-probe.mts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as mupdf from 'mupdf';
import {
  appToDisplayPoint,
  appToUserPoint,
  displayToAppPoint,
  formatAngle,
  formatArea,
  formatLength,
  formatMeasurement,
  formatNumber,
  isMeasureUnit,
  MEASURE_LIMITS,
  MEASURE_UNITS,
  type MeasureMark,
  type MeasurePageGeometry,
  measureChain,
  measureDisplayToUserPoint,
  measureGeometry,
  measureMark,
  parseScale,
  scaleForRatio,
  significantDecimals,
  squareCorners,
  UNMEASURED,
  userToAppPoint,
  writeMeasureAnnotations,
} from '../../packages/pdf-core/src/ops/measure';
import { isToolError } from '../../packages/shared/src/errors';
import { createFixture, readFixture } from './mupdf-fixture.mjs';
import { installMupdfHook } from './node-mupdf-hook.mjs';

// The writer loads MuPDF by its served URL; in Node that resolves to the installed package.
installMupdfHook();

// ---------------------------------------------------------------------------
// the harness
// ---------------------------------------------------------------------------

const checks: { name: string; ok: boolean; detail: string }[] = [];

async function check(name: string, fn: () => Promise<string> | string): Promise<void> {
  let ok = true;
  let detail: string;
  try {
    detail = await fn();
  } catch (error) {
    ok = false;
    detail = String((error as Error)?.message ?? error).slice(0, 400);
  }
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

function fail(message: string): never {
  throw new Error(message);
}

function expect(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

/** `a` and `b` equal within `tolerance`, with both numbers named on failure. */
function expectNear(actual: number, expected: number, tolerance: number, what: string): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    fail(`${what}: ${actual} ≠ ${expected} (±${tolerance})`);
  }
}

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) fail(`${what}: ${String(actual)} ≠ ${String(expected)}`);
}

/** A number token out of a formatted measurement (`705,6 cm` → 705.6). */
function numberIn(text: string): number {
  const match = /-?\d+(?:,\d+)?/.exec(text);
  if (match === null) fail(`no number in ${JSON.stringify(text)}`);
  return Number(match[0].replace(',', '.'));
}

// ---------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 400;
const PAGE_HEIGHT = 600;
/** The second page's MediaBox origin — the offset every conversion has to carry. */
const SECOND_X = 20;
const SECOND_Y = 30;

const dir = join(tmpdir(), `pdf-editor-measure-${process.pid}`);
mkdirSync(dir, { recursive: true });
const fixturePath = join(dir, 'measure-fixture.pdf');

function buildFixture(path: string): void {
  const doc = createFixture(mupdf);
  doc.addPage(PAGE_WIDTH, PAGE_HEIGHT).rect({ x: 20, y: 20, width: 100, height: 60 });
  const second = doc.addPage(PAGE_WIDTH, PAGE_HEIGHT, { rotate: 90 });
  second.object.put('MediaBox', [SECOND_X, SECOND_Y, SECOND_X + PAGE_WIDTH, SECOND_Y + PAGE_HEIGHT]);
  second.rect({ x: 40, y: 40, width: 100, height: 60 });
  writeFileSync(path, doc.save());
}

buildFixture(fixturePath);
const bytes = new Uint8Array(readFileSync(fixturePath));
const context = { signal: new AbortController().signal, onProgress: () => {} };

/** Page geometry, read from the fixture the way the writer reads it. */
const fixtureDoc = readFixture(mupdf, bytes).doc;
const plainGeometry: MeasurePageGeometry = measureGeometry(fixtureDoc.findPage(0));
const rotatedGeometry: MeasurePageGeometry = measureGeometry(fixtureDoc.findPage(1));

// ---------------------------------------------------------------------------
// 1. the scale
// ---------------------------------------------------------------------------

await check('scale: `1:100` is 0.2835 pt/cm, and the ratio form carries no unit of its own', () => {
  const scale = parseScale('1:100');
  if (scale === null) fail('`1:100` did not parse');
  expectEqual(scale.unit, 'cm', 'default unit');
  expectEqual(scale.ratio, 100, 'ratio');
  expectEqual(scale.ratioText, '1:100', 'printed ratio');
  // 1 cm on paper is 72/2.54 pt; at 1:100 one real cm is a hundredth of that.
  expectNear(scale.pointsPerUnit, 72 / 2.54 / 100, 1e-12, 'points per real cm');
  const mm = parseScale('1:100', 'mm');
  if (mm === null) fail('`1:100` in mm did not parse');
  expectNear(mm.pointsPerUnit, 72 / 25.4 / 100, 1e-12, 'points per real mm');
  return `1:100 → ${scale.pointsPerUnit.toFixed(10)} pt/cm · 1:100 in mm → ${mm.pointsPerUnit.toFixed(10)} pt/mm`;
});

await check('scale: a leading label, the equation forms and a Turkish decimal comma', () => {
  const labelled = parseScale('Ölçek 1:50');
  if (labelled === null) fail('`Ölçek 1:50` did not parse');
  expectEqual(labelled.ratio, 50, 'labelled ratio');

  // `1 cm = 5 m`: one drawn cm is five real metres, so the drawing is 1:500.
  const metric = parseScale('1 cm = 5 m');
  if (metric === null) fail('`1 cm = 5 m` did not parse');
  expectEqual(metric.unit, 'm', 'unit from the right-hand side');
  expectEqual(metric.ratio, 500, 'ratio of 1 cm = 5 m');
  expectNear(metric.pointsPerUnit, (72 * (1000 / 25.4)) / 500, 1e-12, 'points per real metre');

  // `1 in = 10 ft`: 1 drawn inch is ten real feet — 120 real inches — so 1:120.
  const imperial = parseScale('1 in = 10 ft');
  if (imperial === null) fail('`1 in = 10 ft` did not parse');
  expectEqual(imperial.unit, 'ft', 'imperial unit');
  expectEqual(imperial.ratio, 120, 'ratio of 1 in = 10 ft');
  expectNear(imperial.pointsPerUnit, (72 * 12) / 120, 1e-12, 'points per real foot');

  const comma = parseScale('1,5 cm = 3 m');
  if (comma === null) fail('`1,5 cm = 3 m` did not parse');
  expectNear(comma.ratio, 200, 1e-9, 'ratio of 1,5 cm = 3 m');

  const zero = parseScale('1:0');
  const words = parseScale('ikiye bir');
  const ratio = parseScale('1.234,5');
  expectEqual(zero, null, '`1:0`');
  expectEqual(words, null, '`ikiye bir`');
  expectEqual(ratio, null, '`1.234,5` (both separators)');
  expectEqual(parseScale(''), null, 'empty string');
  return `Ölçek 1:50 → 1:50 · 1 cm = 5 m → 1:500 · 1 in = 10 ft → 1:120 · 1,5 cm = 3 m → 1:${comma.ratio.toFixed(3)}`;
});

// ---------------------------------------------------------------------------
// 2. the geometry, in the space the file is written in
// ---------------------------------------------------------------------------

await check('app → user: the flip is about the page box top, and is its own inverse', () => {
  // Page 1: MediaBox [0 0 400 600] — a point at the top of the page is y = 600.
  expectNear(appToUserPoint(plainGeometry, { x: 100, y: 0 }).y, PAGE_HEIGHT, 1e-9, 'page 1 top');
  expectNear(appToUserPoint(plainGeometry, { x: 100, y: PAGE_HEIGHT }).y, 0, 1e-9, 'page 1 bottom');

  // Page 2: MediaBox [20 30 420 630] — the top of the box is y = 630, not 600.
  const top = appToUserPoint(rotatedGeometry, { x: 50, y: 0 });
  expectNear(top.y, SECOND_Y + PAGE_HEIGHT, 1e-9, 'offset box top');
  expectNear(top.x, 50, 1e-9, 'x is already user space');
  const back = userToAppPoint(rotatedGeometry, top);
  expectNear(back.y, 0, 1e-9, 'round trip y');
  expectNear(back.x, 50, 1e-9, 'round trip x');

  expectEqual(rotatedGeometry.rotation, 90, 'fixture page 2 rotation');
  expectNear(rotatedGeometry.box.x, SECOND_X, 1e-9, 'fixture page 2 box x');
  expectNear(rotatedGeometry.box.y, SECOND_Y, 1e-9, 'fixture page 2 box y');
  return 'page 1 top → y=600 · page 2 top → y=630 (box origin 30) · round trip exact';
});

await check('distance on an unrotated page: 200 pt at 1:100 reads 705,6 cm', () => {
  const scale = parseScale('1:100');
  if (scale === null) fail('`1:100` did not parse');
  const measurement = measureMark(
    plainGeometry,
    [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
    ],
    'distance',
  );
  expectNear(measurement.length, 200, 1e-9, 'length in points');
  expectNear(measurement.rect[1], 500, 1e-9, 'rect bottom (user space)');
  expectNear(measurement.rect[3], 500, 1e-9, 'rect top (user space)');
  expectNear(measurement.bearing, 0, 1e-9, 'bearing');
  const text = formatMeasurement(measurement, scale);
  expectEqual(text, '705,6 cm', 'formatted distance');
  return `200 pt → ${text} · /Rect ${measurement.rect.join(', ')} (user space)`;
});

await check('perimeter and area: a two-corner area is its rectangle, a chain is a path', () => {
  const scale = scaleForRatio(10, 'cm');
  // Two clicked corners, in app space: 50 pt apart in x and y.
  const area = measureMark(
    plainGeometry,
    [
      { x: 50, y: 500 },
      { x: 100, y: 550 },
    ],
    'area',
  );
  expectEqual(area.points.length, 4, 'corners of a two-corner area');
  expectNear(area.area, 2500, 1e-9, 'area in pt²');
  expectNear(area.perimeter, 200, 1e-9, 'closed perimeter');
  // 50 pt = 50/(72/2.54/10) cm real = 50/2.8346… → the square is 17,64 cm a side.
  expectNear(numberIn(formatArea(area.area, scale)), 2500 / (72 / 2.54 / 10) ** 2, 0.05, 'area in cm²');
  expectEqual(formatArea(area.area, scale).endsWith(' cm²'), true, 'area unit suffix');
  expectEqual(
    squareCorners({ x: 100, y: 550 }, { x: 50, y: 500 })
      .map((point) => `${point.x}/${point.y}`)
      .join(' '),
    '50/500 100/500 100/550 50/550',
    'square corners ascending',
  );

  const chain = measureChain(
    [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
    ],
    'perimeter',
  );
  expectNear(chain.length, 200, 1e-9, 'open chain length');
  expectNear(chain.perimeter, 200, 1e-9, 'open chain perimeter');
  expectNear(chain.area, 0, 1e-9, 'an open chain has no area');
  expectNear(
    measureChain(
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      'distance',
    ).bearing,
    45,
    1e-9,
    'diagonal bearing',
  );
  expectEqual(formatAngle(45), '45,0°', 'formatted bearing');
  return `50×50 pt → ${formatMeasurement(area, scale)}, perimeter ${formatLength(area.perimeter, scale)} · chain 200 pt · 45° → ${formatAngle(45)}`;
});

await check('rotated page: the same length, and written geometry in unrotated user space', () => {
  const scale = parseScale('1:100');
  if (scale === null) fail('`1:100` did not parse');
  const app = [
    { x: 50, y: 300 },
    { x: 150, y: 300 },
    { x: 150, y: 400 },
  ];
  const rotated = measureMark(rotatedGeometry, app, 'perimeter');
  const plain = measureMark(
    { rotation: 0, box: { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT } },
    app,
    'perimeter',
  );
  // A reflection is an isometry: the rotation cannot change a length, and that is
  // exactly why the *written* coordinates are the evidence, not the number.
  expectNear(rotated.length, plain.length, 1e-9, 'rotated vs unrotated length');
  expectNear(rotated.length, 200, 1e-9, 'chain length');
  const vertices = rotated.points.map((point) => `${point.x}/${point.y}`).join(' ');
  expectEqual(vertices, '50/330 150/330 150/230', 'user-space vertices on the rotated page');

  // On screen the same points sit elsewhere: display space is u right, v down
  // from the *displayed* top-left, which rotation 90 puts at the page's left edge.
  // u therefore runs with the user-space y: u = uy − y1, with uy = y2 − appY.
  const display = appToDisplayPoint(rotatedGeometry, app[0] as { x: number; y: number });
  expectNear(display.u, PAGE_HEIGHT - 300, 1e-9, 'displayed u');
  expectNear(display.v, 50 - SECOND_X, 1e-9, 'displayed v');
  const roundTrip = displayToAppPoint(rotatedGeometry, display.u, display.v);
  expectNear(roundTrip.x, 50, 1e-9, 'display round trip x');
  expectNear(roundTrip.y, 300, 1e-9, 'display round trip y');
  return `200 pt on the rotated page (user ${vertices}) · displayed (${display.u.toFixed(1)}, ${display.v.toFixed(1)}) is a different space`;
});

await check('app → display matches pdf.js PageViewport, for all four rotations', () => {
  // `PageViewport` (pdfjs-dist 6.3.289, build/pdf.mjs:810): rotateA/B/C/D per
  // rotation, the two offsets from the view box centre, then
  // `applyInverseTransform` — written out here so the module's rows are checked
  // against the engine's matrix and not against themselves.
  const matrices: Record<number, readonly [number, number, number, number]> = {
    0: [1, 0, 0, -1],
    90: [0, 1, 1, 0],
    180: [-1, 0, 0, 1],
    270: [0, -1, -1, 0],
  };
  const box = { x: SECOND_X, y: SECOND_Y, width: PAGE_WIDTH, height: PAGE_HEIGHT };
  const rows: string[] = [];
  for (const rotation of [0, 90, 180, 270] as const) {
    const matrix = matrices[rotation] as readonly [number, number, number, number];
    const [rotateA, rotateB, rotateC, rotateD] = matrix;
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const swapped = rotateA === 0;
    const offsetCanvasX = (swapped ? Math.abs(centerY - box.y) : Math.abs(centerX - box.x)) * 1;
    const offsetCanvasY = (swapped ? Math.abs(centerX - box.x) : Math.abs(centerY - box.y)) * 1;
    const tx = offsetCanvasX - rotateA * centerX - rotateC * centerY;
    const ty = offsetCanvasY - rotateB * centerX - rotateD * centerY;
    const canvasX = (ux: number, uy: number) => rotateA * ux + rotateC * uy + tx;
    const canvasY = (ux: number, uy: number) => rotateB * ux + rotateD * uy + ty;

    const geometry: MeasurePageGeometry = { rotation, box };
    for (const app of [
      { x: SECOND_X, y: 0 },
      { x: 250, y: 375 },
      { x: 420, y: 600 },
    ]) {
      const user = appToUserPoint(geometry, app);
      const display = appToDisplayPoint(geometry, app);
      expectNear(display.u, canvasX(user.x, user.y), 1e-9, `rotation ${rotation} u`);
      expectNear(display.v, canvasY(user.x, user.y), 1e-9, `rotation ${rotation} v`);
      // The two conversions must be each other's inverse, whichever space a caller
      // arrives from: the link tool hands over displayed points.
      const back = measureDisplayToUserPoint(geometry, display.u, display.v);
      expectNear(back.x, user.x, 1e-9, `rotation ${rotation} inverse x`);
      expectNear(back.y, user.y, 1e-9, `rotation ${rotation} inverse y`);
    }
    rows.push(`${rotation}° ok`);
  }
  return `offset box, 3 points × 4 rotations vs the engine matrix — ${rows.join(' · ')}`;
});

await check('formatters never print a number that is not one', () => {
  const scale = scaleForRatio(100, 'cm');
  const outputs = [
    formatLength(Number.NaN, scale),
    formatArea(Number.POSITIVE_INFINITY, scale),
    formatNumber(Number.NaN, 2),
    formatAngle(Number.NaN),
    formatLength(Number.NaN, { ...scale, pointsPerUnit: 0 }),
  ];
  for (const output of outputs) {
    expectEqual(/\d/.test(output), false, `a non-number printed as ${JSON.stringify(output)}`);
  }
  expectEqual(outputs[0], UNMEASURED, 'the unmeasured marker');
  // A real zero is a number: the readout shows it instead of the fallback.
  expectEqual(formatLength(0, scale).startsWith('0'), true, 'zero is measured');
  expectEqual(significantDecimals(0.2845), 3, 'sub-unit precision');
  expectEqual(significantDecimals(352.8), 1, 'hundreds precision');
  return `${outputs.map((output) => JSON.stringify(output)).join(' ')} · 0 → ${formatLength(0, scale)}`;
});

// ---------------------------------------------------------------------------
// 3. the write
// ---------------------------------------------------------------------------

const scale100 = scaleForRatio(100, 'cm');
const scale10 = scaleForRatio(10, 'cm');

function markOf(overrides: Partial<MeasureMark> & Pick<MeasureMark, 'mode' | 'points'>): MeasureMark {
  return {
    id: 'm-measure',
    pageIndex: 0,
    scale: scale100,
    color: '#d13438',
    opacity: 0.9,
    thickness: 2,
    author: 'Ölçüm',
    contents: '',
    createdAt: '2026-09-16T09:00:00.000Z',
    ...overrides,
  };
}

const marks: readonly MeasureMark[] = [
  markOf({
    id: 'm-distance',
    mode: 'distance',
    points: [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
    ],
  }),
  markOf({
    id: 'm-area',
    mode: 'area',
    scale: scale10,
    points: [
      { x: 50, y: 500 },
      { x: 100, y: 550 },
    ],
    contents: 'Çatı alanı',
  }),
  markOf({
    id: 'm-perimeter',
    mode: 'perimeter',
    pageIndex: 1,
    points: [
      { x: 50, y: 300 },
      { x: 150, y: 300 },
      { x: 150, y: 400 },
    ],
  }),
];

const written = await writeMeasureAnnotations(bytes, marks, context);
const producedPath = join(dir, 'measure-written.pdf');
writeFileSync(producedPath, written.bytes);

await check('write: three marks become three annotations, with the writer’s own report', () => {
  expectEqual(written.report.engine, 'mupdf', 'engine');
  expectEqual(written.report.incremental, false, 'a full rewrite ends the incremental path');
  expectEqual(written.written.length, 3, 'markers reported');
  expectEqual(written.report.notes.length, 2, 'report notes');
  expectEqual(written.bytes.byteLength > bytes.byteLength, true, 'the file grew');
  expectEqual(written.bytes.byteLength !== bytes.byteLength, true, 'new bytes');
  return `${written.report.steps.join(' → ')} · ${bytes.byteLength} → ${written.bytes.byteLength} B · notes ${written.report.notes
    .map((entry) => `${entry.kind}:${entry.key}`)
    .join(', ')}`;
});

type PdfObject = import('mupdf').PDFObject;

/** One annotation dictionary of a page, by index. */
function annotDict(doc: import('mupdf').PDFDocument, pageIndex: number, at: number): PdfObject {
  const refs = doc.findPage(pageIndex).get('Annots');
  if (!refs.isArray()) fail(`page ${pageIndex + 1} carries no /Annots`);
  if (at >= refs.length) fail(`page ${pageIndex + 1} has no annotation ${at}`);
  return refs.get(at);
}

function dictOf(dict: PdfObject, key: string): PdfObject {
  const value = dict.get(key);
  if (!value.isDictionary()) fail(`/${key} is not a dictionary`);
  return value;
}

function nameOf(dict: PdfObject, key: string): string {
  const value = dict.get(key);
  if (!value.isName()) fail(`/${key} is not a name`);
  return value.asName();
}

/** A text string of either encoding: PDFDocEncoding (`(...)`) or UTF-16BE (`<FEFF…>`). */
function textOf(dict: PdfObject, key: string): string {
  const value = dict.get(key);
  if (value.isString()) return value.asString();
  return fail(`/${key} is not a text string`);
}

function numberOf(dict: PdfObject, key: string): number {
  const value = dict.get(key);
  if (!value.isNumber()) fail(`/${key} is not a number`);
  return value.asNumber();
}

function numbersOf(dict: PdfObject, key: string): number[] {
  const value = dict.get(key);
  if (!value.isArray()) fail(`/${key} is not an array`);
  const numbers: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value.get(index);
    if (!entry.isNumber()) fail(`/${key}[${index}] is not a number`);
    numbers.push(entry.asNumber());
  }
  return numbers;
}

await check('write: /Subtype, /Rect, /L and /Vertices land in unrotated user space', () => {
  const { doc } = readFixture(mupdf, written.bytes);
  const distance = annotDict(doc, 0, 0);
  const area = annotDict(doc, 0, 1);
  const perimeter = annotDict(doc, 1, 0);

  expectEqual(nameOf(distance, 'Subtype'), 'Line', 'distance subtype');
  const rect = numbersOf(distance, 'Rect');
  // Page 1 in user space is y = 600 − app y, so the chain sits at y = 500; a 2 pt
  // stroke pads the rect by 1.5 (half the stroke plus a hair).
  expectEqual(rect.join(','), '98.5,498.5,301.5,501.5', 'distance /Rect');
  expectEqual(numbersOf(distance, 'L').join(','), '100,500,300,500', 'distance /L');

  expectEqual(nameOf(area, 'Subtype'), 'Square', 'a two-corner area is a Square');
  expectEqual(numbersOf(area, 'Vertices').join(','), '50,50,100,50,100,100,50,100', 'area /Vertices');

  expectEqual(nameOf(perimeter, 'Subtype'), 'PolyLine', 'perimeter subtype');
  expectEqual(numbersOf(perimeter, 'Vertices').join(','), '50,330,150,330,150,230', 'rotated page /Vertices');
  const rotatedRect = numbersOf(perimeter, 'Rect');
  expectEqual(rotatedRect.join(','), '48.5,228.5,151.5,331.5', 'rotated page /Rect');
  return `Line ${rect.join(',')} /L ${numbersOf(distance, 'L').join(',')} · Square · PolyLine on the /Rotate 90 page`;
});

await check('write: /Measure carries the subtype, the ratio, the unit and the measurement', () => {
  const { doc } = readFixture(mupdf, written.bytes);
  const distance = annotDict(doc, 0, 0);
  const area = annotDict(doc, 0, 1);
  const perimeter = annotDict(doc, 1, 0);

  const measures = [
    { dict: distance, subtype: 'RL', unit: 'cm', decimals: 1, text: '705,6 cm', ratio: 100 },
    { dict: area, subtype: 'A', unit: 'cm²', decimals: 1, text: '311,1 cm²', ratio: 10 },
    { dict: perimeter, subtype: 'P', unit: 'cm', decimals: 1, text: '705,6 cm', ratio: 100 },
  ] as const;

  const seen: string[] = [];
  for (const { dict, subtype, unit, decimals, text, ratio: expected } of measures) {
    const measure = dictOf(dict, 'Measure');
    expectEqual(nameOf(measure, 'Subtype'), subtype, '/Measure /Subtype');
    const ratio = numbersOf(measure, 'R');
    expectEqual(ratio.length, 2, '/R is the two-number form');
    expectEqual(ratio[0], 1, '/R numerator');
    expectEqual(ratio[1], expected, '/R denominator');
    const format = dictOf(measure, 'X');
    const unitString = textOf(format, 'U');
    expectEqual(unitString, unit, '/X /U');
    const digits = numberOf(format, 'D');
    expectEqual(digits, decimals, '/X /D');
    const contents = textOf(dict, 'Contents');
    expect(startsWith(contents, 'pdf-editor-ann:'), `/Contents has no marker: ${contents}`);
    expect(contents.includes(text), `/Contents does not carry the measurement: ${contents}`);
    seen.push(`${subtype} R[1 ${ratio[1]}] X(${unit}/${digits}) “${contents}”`);
  }

  // Turkish content is the product's default locale: `/Contents` is a text string,
  // and a label that loses `ı`/`ş` on the way into the file is a wrong document.
  const areaContents = textOf(area, 'Contents');
  expect(areaContents.includes('Çatı alanı'), `Turkish text did not survive: ${areaContents}`);
  return seen.join(' · ');
});

function startsWith(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length) === prefix;
}

await check('write: a call with nothing to write keeps the bytes, and cancellation is mapped', async () => {
  const empty = await writeMeasureAnnotations(bytes, [], context);
  expect(empty.bytes === bytes, 'the no-op returned different bytes');
  expectEqual(empty.report.incremental, true, 'a no-op stays incremental');
  expectEqual(empty.written.length, 0, 'no markers');
  expectEqual(empty.report.notes[0]?.key, 'op.note.measure.nothing', 'the no-op sentence');

  const controller = new AbortController();
  controller.abort();
  const aborted = await rejection(() => writeMeasureAnnotations(bytes, marks, { signal: controller.signal }));
  const page = await rejection(() =>
    writeMeasureAnnotations(
      bytes,
      [markOf({ mode: 'distance', points: [...(marks[0]?.points ?? [])], pageIndex: 9 })],
      context,
    ),
  );
  const lonely = await rejection(() =>
    writeMeasureAnnotations(bytes, [markOf({ mode: 'perimeter', points: [{ x: 10, y: 10 }] })], context),
  );
  const huge = await rejection(() =>
    writeMeasureAnnotations(
      bytes,
      [
        markOf({
          mode: 'distance',
          points: [
            { x: 10, y: 10 },
            { x: MEASURE_LIMITS.maxCoordinate + 1, y: 10 },
          ],
        }),
      ],
      context,
    ),
  );
  const many = await rejection(() =>
    writeMeasureAnnotations(
      bytes,
      Array.from({ length: MEASURE_LIMITS.marks + 1 }, () => marks[0] ?? markOf()),
      context,
    ),
  );
  const token = await rejection(() =>
    writeMeasureAnnotations(
      bytes,
      [
        markOf({
          mode: 'distance',
          points: [
            { x: 10, y: 10 },
            { x: 10.2, y: 10 },
          ],
        }),
      ],
      context,
    ),
  );
  expectEqual(aborted.code, 'aborted', 'cancellation code');
  expectEqual(page.code, 'selection-empty', 'missing page');
  expectEqual(lonely.code, 'selection-empty', 'one point');
  expectEqual(huge.code, 'value-out-of-range', 'coordinate bound');
  expectEqual(many.code, 'value-out-of-range', 'mark bound');
  expectEqual(token.code, 'value-out-of-range', 'a 0,2 pt “measurement”');
  return `no-op keeps ${bytes.byteLength} B · ${[aborted.code, page.code, lonely.code, huge.code, many.code, token.code].join(', ')}`;
});

/** The `ToolError` a call threw, or a loud failure naming what it threw instead. */
async function rejection(run: () => Promise<unknown>): Promise<{ readonly code: string }> {
  try {
    await run();
  } catch (error) {
    if (!isToolError(error)) fail(`threw a non-ToolError: ${String(error)}`);
    return { code: error.code };
  }
  return fail('the call did not throw');
}

await check('units: the five the tool offers, and the guard that keeps them honest', () => {
  for (const unit of MEASURE_UNITS) {
    const scale = scaleForRatio(1, unit);
    expectNear(
      scale.pointsPerUnit,
      72 *
        (unit === 'mm'
          ? 1 / 25.4
          : unit === 'cm'
            ? 1 / 2.54
            : unit === 'm'
              ? 1000 / 25.4
              : unit === 'in'
                ? 1
                : 12),
      1e-9,
      `1:1 in ${unit}`,
    );
    expectEqual(isMeasureUnit(unit), true, `isMeasureUnit(${unit})`);
  }
  expectEqual(isMeasureUnit('km'), false, 'km is not offered yet');
  let refused = '';
  try {
    scaleForRatio(0);
  } catch (error) {
    refused = isToolError(error) ? error.code : 'not a ToolError';
  }
  expectEqual(refused, 'value-out-of-range', 'a zero ratio');
  return `${MEASURE_UNITS.join(', ')} at 1:1 → ${MEASURE_UNITS.map((unit) => scaleForRatio(1, unit).pointsPerUnit.toFixed(3)).join(' / ')} pt per unit`;
});

// ---------------------------------------------------------------------------
// the verdict
// ---------------------------------------------------------------------------

const passed = checks.filter((entry) => entry.ok).length;
const failed = checks.length - passed;
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const entry of checks.filter((c) => !c.ok)) console.log(`  FAILED  ${entry.name} — ${entry.detail}`);
  process.exitCode = 1;
}
