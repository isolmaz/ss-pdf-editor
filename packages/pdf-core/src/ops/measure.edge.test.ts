/**
 * The measurement module at its edges: scale text a user can type wrongly, numbers the
 * readout must refuse to print, chains that cannot be measured, and marks the writer must
 * reject before it touches the file. The wrong answers that matter: a scale guessed from text
 * that is not one, a `NaN` printed as a length, an annotation written with no length, and a
 * line whose appearance is clipped or missing when its ends share a coordinate.
 */

import { describe, expect, it } from 'vitest';
import { openForWrite } from '../engines/mupdf-write';
import { handPdf } from './forms.fixtures';
import {
  appToDisplayPoint,
  displaySize,
  displayToAppPoint,
  formatAngle,
  formatArea,
  formatLength,
  formatMeasurement,
  formatNumber,
  isMeasureUnit,
  MEASURE_LIMITS,
  type MeasureMark,
  measureChain,
  measureDisplayToUserPoint,
  measureGeometry,
  parseScale,
  scaleForRatio,
  significantDecimals,
  UNMEASURED,
  writeMeasureAnnotations,
} from './measure';

const run = { signal: new AbortController().signal };

describe('parseScale', () => {
  it('reads ratios with a decimal comma or point, a leading label and spaces', () => {
    expect(parseScale('1:100')?.ratio).toBe(100);
    expect(parseScale('1 / 2,5')?.ratio).toBe(2.5);
    expect(parseScale('Ölçek 2.5 : 5')?.ratio).toBe(2);
    expect(parseScale('Scale = 1:50', 'm')).toMatchObject({ ratio: 50, unit: 'm', expression: '1:50 m' });
  });

  it('reads an equation with its own units, in either direction', () => {
    expect(parseScale('1 cm = 5 m')).toMatchObject({ ratio: 500, unit: 'm', expression: '1 cm = 5 m' });
    expect(parseScale('1 in = 10 ft')).toMatchObject({ ratio: 120, unit: 'ft' });
  });

  it.each([
    ['empty text', ''],
    ['blank text', '   '],
    ['words only', 'Ölçek'],
    ['a label with nothing after it', 'Scale ='],
    ['a ratio with a zero', '0:100'],
    ['a ratio over zero', '1:0'],
    ['a ratio with two separators', '1:1.234,5'],
    ['an equation in an unknown unit', '1 cm = 5 parsec'],
    ['an equation with an unknown drawn unit', '1 zork = 5 m'],
    ['an equation with a zero', '0 cm = 5 m'],
    ['a ratio beyond the limits', '1:99999999'],
    ['a ratio below the limits', '99999999:1'],
    ['an equation beyond the limits', '1 mm = 99999 m'],
  ])('refuses %s instead of guessing', (_name, text) => {
    expect(parseScale(text)).toBeNull();
  });

  it('refuses a value that is not text', () => {
    expect(parseScale(5 as never)).toBeNull();
  });

  it('cuts a label at 24 characters, so a longer one leaves digits it cannot read as a scale', () => {
    expect(parseScale(`${'x'.repeat(30)}1:100`)).toBeNull();
    expect(parseScale(`${'x'.repeat(24)}1:100`)?.ratio).toBe(100);
  });
});

describe('scaleForRatio', () => {
  it('names the ratio and the unit, rounded to six significant digits', () => {
    expect(scaleForRatio(500.00000000000006, 'm')).toMatchObject({
      ratio: 500,
      ratioText: '1:500',
      expression: '1:500 m',
    });
    expect(scaleForRatio(1 / 3).ratio).toBe(0.333333);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses the ratio %s as not positive', (ratio) => {
    expect(() => scaleForRatio(ratio)).toThrow(
      expect.objectContaining({
        code: 'value-out-of-range',
        details: { engine: 'model', engineMessage: `measurement ratio is not a positive number: ${ratio}` },
      }),
    );
  });

  it('refuses a ratio outside the limits, naming the larger bound', () => {
    for (const ratio of [MEASURE_LIMITS.maxRatio * 10, MEASURE_LIMITS.minRatio / 10]) {
      expect(() => scaleForRatio(ratio)).toThrow(
        expect.objectContaining({
          code: 'value-out-of-range',
          details: {
            engine: 'model',
            engineMessage: `measurement ratio ${ratio} is outside 1:${MEASURE_LIMITS.maxRatio}`,
          },
        }),
      );
    }
  });

  it('knows its units', () => {
    expect(['mm', 'cm', 'm', 'in', 'ft'].every(isMeasureUnit)).toBe(true);
    expect(isMeasureUnit('furlong')).toBe(false);
  });
});

describe('page geometry', () => {
  const geometry = (rotation: 0 | 90 | 180 | 270) => ({
    rotation,
    box: { x: 10, y: 20, width: 200, height: 100 },
  });

  it('reads /Rotate through the page tree, and none as upright', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2/Rotate 450>>',
      3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>',
      4: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Rotate 0>>',
    });
    const { doc } = await openForWrite(bytes);
    try {
      expect(measureGeometry(doc.findPage(0)).rotation).toBe(90);
      expect(measureGeometry(doc.findPage(1)).rotation).toBe(0);
    } finally {
      doc.destroy();
    }
    const bare = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>',
    });
    const opened = await openForWrite(bare);
    try {
      expect(measureGeometry(opened.doc.findPage(0)).rotation).toBe(0);
    } finally {
      opened.doc.destroy();
    }
  });

  it('turns display points into user space and back through all four rotations', () => {
    const user = {
      0: { x: 15, y: 110 },
      90: { x: 20, y: 25 },
      180: { x: 205, y: 30 },
      270: { x: 200, y: 115 },
    } as const;
    for (const rotation of [0, 90, 180, 270] as const) {
      expect(measureDisplayToUserPoint(geometry(rotation), 5, 10)).toEqual(user[rotation]);
      const app = displayToAppPoint(geometry(rotation), 5, 10);
      expect(appToDisplayPoint(geometry(rotation), app)).toEqual({ u: 5, v: 10 });
    }
    expect(displaySize(geometry(0))).toEqual({ width: 200, height: 100 });
    expect(displaySize(geometry(90))).toEqual({ width: 100, height: 200 });
    expect(displaySize(geometry(270))).toEqual({ width: 100, height: 200 });
    expect(displaySize(geometry(180))).toEqual({ width: 200, height: 100 });
  });
});

describe('measureChain refusals', () => {
  const line = [
    { x: 0, y: 0 },
    { x: 30, y: 40 },
  ];

  it.each([
    [
      'one point',
      [{ x: 0, y: 0 }],
      'distance',
      'selection-empty',
      'a measurement needs at least two points (got 1)',
    ],
    [
      'a point that is not a number',
      [
        { x: 0, y: 0 },
        { x: Number.NaN, y: 1 },
      ],
      'distance',
      'value-out-of-range',
      'point is not a finite number (NaN, 1)',
    ],
    [
      'a point far off the page',
      [
        { x: 0, y: 0 },
        { x: 1e9, y: 1 },
      ],
      'distance',
      'value-out-of-range',
      `point 1000000000,1 is outside ±${MEASURE_LIMITS.maxCoordinate} pt`,
    ],
    [
      'a distance of three points',
      [...line, { x: 1, y: 1 }],
      'distance',
      'value-out-of-range',
      'a distance is two points (got 3)',
    ],
  ] as const)('refuses %s', (_name, points, mode, code, message) => {
    expect(() => measureChain(points, mode)).toThrow(
      expect.objectContaining({
        code,
        details: expect.objectContaining({ engineMessage: expect.stringContaining(message) }),
      }),
    );
  });

  it('refuses more points than the limit', () => {
    const many = Array.from({ length: MEASURE_LIMITS.points + 1 }, (_value, at) => ({ x: at, y: 0 }));
    expect(() => measureChain(many, 'perimeter')).toThrow(
      expect.objectContaining({ code: 'value-out-of-range' }),
    );
  });

  it('measures an area of two corners as the rectangle they span and an open chain by its length', () => {
    const area = measureChain(line, 'area');
    expect(area).toMatchObject({ area: 1200, perimeter: 140, length: 100 });
    expect(measureChain([...line, { x: 30, y: 0 }], 'perimeter').length).toBe(50 + 40);
  });
});

describe('formatting measurements', () => {
  const scale = scaleForRatio(1, 'cm');
  const broken = { ...scale, pointsPerUnit: 0 };

  it('keeps about four significant digits, whatever the magnitude', () => {
    expect([0.5, 5, 50, 500, 5000, Number.NaN, Number.POSITIVE_INFINITY].map(significantDecimals)).toEqual([
      3, 2, 2, 1, 0, 0, 0,
    ]);
  });

  it('prints nothing for a value that is not a number, instead of "NaN"', () => {
    expect(formatNumber(Number.NaN, 2)).toBe(UNMEASURED);
    expect(formatNumber(1.5, Number.NaN, 'en')).toBe('1.50');
    expect(formatNumber(1.23456, 99, 'en')).toBe('1.234560');
    expect(formatNumber(1.5, -3, 'en')).toBe('2');
    expect(formatLength(Number.NaN, scale)).toBe(UNMEASURED);
    expect(formatLength(10, broken)).toBe(UNMEASURED);
    expect(formatLength(10, { ...scale, pointsPerUnit: Number.NaN })).toBe(UNMEASURED);
    expect(formatArea(Number.NaN, scale)).toBe(UNMEASURED);
    expect(formatArea(10, broken)).toBe(UNMEASURED);
    expect(formatAngle(Number.NaN)).toBe(UNMEASURED);
    const measurement = measureChain(
      [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ],
      'distance',
    );
    expect(formatMeasurement(measurement, broken)).toBe(UNMEASURED);
  });

  it('prints angles in 0 … 360 with the locale’s separator, and lengths with their unit', () => {
    expect(formatAngle(-90, { locale: 'en' })).toBe('270.0°');
    expect(formatAngle(450, { decimals: 0 })).toBe('90°');
    expect(formatAngle(45)).toBe('45,0°');
    expect(formatLength(72, scaleForRatio(1, 'in'), { locale: 'en', decimals: 1 })).toBe('1.0 in');
  });
});

describe('writeMeasureAnnotations refuses what it cannot write', () => {
  async function blank(extra = ''): Promise<Uint8Array> {
    return handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      3: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 500]${extra}>>`,
    });
  }
  const mark = (over: Partial<MeasureMark>): MeasureMark => ({
    id: 'm1',
    pageIndex: 0,
    mode: 'distance',
    points: [
      { x: 10, y: 10 },
      { x: 110, y: 10 },
    ],
    scale: scaleForRatio(100, 'cm'),
    color: '#336699',
    opacity: 1,
    author: 'A',
    contents: '',
    createdAt: '2026-01-02T03:04:05.000Z',
    ...over,
  });

  it('returns the bytes untouched, and says so, for no marks', async () => {
    const bytes = await blank();
    const out = await writeMeasureAnnotations(bytes, [], run);
    expect(out.bytes).toBe(bytes);
    expect(out.written).toEqual([]);
    expect(out.report).toMatchObject({ steps: ['measure.write.skipped'], pageCount: 0, incremental: true });
    expect(out.report.notes.map((entry) => entry.key)).toEqual(['op.note.measure.nothing']);
  });

  it('refuses more marks than the limit, a page the document lacks, and an aborted signal', async () => {
    const bytes = await blank();
    await expect(
      writeMeasureAnnotations(
        bytes,
        Array.from({ length: MEASURE_LIMITS.marks + 1 }, () => mark({})),
        run,
      ),
    ).rejects.toMatchObject({ code: 'value-out-of-range' });
    await expect(writeMeasureAnnotations(bytes, [mark({ pageIndex: 3 })], run)).rejects.toMatchObject({
      code: 'selection-empty',
      details: { pageIndex: 3, engineMessage: 'measure.write: the document has no page 3' },
    });
    await expect(writeMeasureAnnotations(bytes, [mark({ pageIndex: -1 })], run)).rejects.toMatchObject({
      code: 'selection-empty',
    });
    await expect(
      writeMeasureAnnotations(bytes, [mark({})], { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({
      code: 'aborted',
      details: { engineMessage: 'measure.write aborted' },
    });
  });

  it('refuses an unknown mode, a chain that is too short and an area that is too small', async () => {
    const bytes = await blank();
    await expect(
      writeMeasureAnnotations(bytes, [mark({ mode: 'volume' as never })], run),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: 'measure.write[m1]: unknown measurement mode volume' },
    });
    const near = [
      { x: 10, y: 10 },
      { x: 10.01, y: 10 },
    ];
    await expect(writeMeasureAnnotations(bytes, [mark({ points: near })], run)).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { engineMessage: expect.stringContaining('is below') },
    });
    const sliver = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 0.001 },
    ];
    await expect(
      writeMeasureAnnotations(bytes, [mark({ mode: 'area', points: sliver })], run),
    ).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { engineMessage: expect.stringContaining('is too small to measure') },
    });
  });

  it('draws a line whose ends share a coordinate, clamps a bad stroke and a bad opacity, and closes only an area', async () => {
    const vertical = [
      { x: 50, y: 10 },
      { x: 50, y: 110 },
    ];
    const chain = [
      { x: 10, y: 10 },
      { x: 110, y: 10 },
      { x: 110, y: 90 },
    ];
    const out = await writeMeasureAnnotations(
      await blank(),
      [
        mark({ id: 'a', points: vertical, thickness: Number.NaN, opacity: 7 }),
        mark({ id: 'b', mode: 'perimeter', points: chain, thickness: 0.1 }),
        mark({ id: 'c', mode: 'area', points: chain, thickness: 99, opacity: -1 }),
        mark({
          id: 'd',
          mode: 'area',
          points: [
            { x: 10, y: 10 },
            { x: 110, y: 60 },
          ],
        }),
      ],
      run,
    );
    expect(out.written).toHaveLength(4);
    const { doc } = await openForWrite(out.bytes);
    try {
      const annots = doc.findPage(0).get('Annots');
      const read = (at: number) => {
        const dict = annots.get(at).resolve();
        return {
          subtype: dict.get('Subtype').asName(),
          width: dict.get('BS').get('W').asNumber(),
          opacity: dict.get('CA').asNumber(),
          stream: dict.get('AP').get('N').readStream().asString(),
        };
      };
      const [line, polyline, polygon, square] = [read(0), read(1), read(2), read(3)];
      // Two clicked corners of an area are a rectangle, not a polygon.
      expect([line.subtype, polyline.subtype, polygon.subtype, square.subtype]).toEqual([
        'Line',
        'PolyLine',
        'Polygon',
        'Square',
      ]);
      expect([line.width, polyline.width, polygon.width]).toEqual([1, 0.5, 24]);
      expect([line.opacity, polygon.opacity]).toEqual([1, 0]);
      // A vertical line stays vertical: both ends have the same x, and are inset along y by half the stroke.
      expect(line.stream).toContain('1.000 100.500 m');
      expect(line.stream).toContain('1.000 1.500 l');
      expect(polyline.stream).not.toContain('\nh\n');
      expect(polygon.stream).toContain('\nh\n');
    } finally {
      doc.destroy();
    }
  });
});
