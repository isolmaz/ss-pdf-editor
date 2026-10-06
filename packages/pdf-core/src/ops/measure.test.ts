/**
 * Measurement annotations, against real bytes. The wrong answers that matter: a line
 * whose endpoints land somewhere else than they were drawn, a measure dictionary that
 * loses its ratio or its unit, a Turkish comment mangled, and a polygon written without
 * its vertices.
 */

import { describe, expect, it } from 'vitest';
import {
  formatArea,
  formatNumber,
  type MeasureMark,
  measureChain,
  measuredValue,
  parseScale,
  quarterTurns,
  scaleForRatio,
  squareCorners,
  writeMeasureAnnotations,
} from './measure';

const run = { signal: new AbortController().signal };

async function blank(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function mark(overrides: Partial<MeasureMark> & Pick<MeasureMark, 'id' | 'mode' | 'points'>): MeasureMark {
  return {
    pageIndex: 0,
    scale: scaleForRatio(100, 'cm'),
    color: '#ff0000',
    opacity: 1,
    author: 'Ayşe',
    contents: 'Çatı alanı',
    createdAt: '2026-01-02T03:04:05.000Z',
    ...overrides,
  };
}

/** Every annotation's subtype, geometry, comment and measure dictionary, as MuPDF reads them. */
async function read(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const annots = doc.findPage(0).get('Annots').resolve();
    const numbers = (value: import('mupdf').PDFObject) => {
      if (value.isNull()) return null;
      const array = value.resolve();
      return Array.from({ length: array.length }, (_unused, index) => array.get(index).asNumber());
    };
    return Array.from({ length: annots.length }, (_unused, index) => {
      const dict = annots.get(index).resolve();
      const measure = dict.get('Measure').resolve();
      return {
        subtype: dict.get('Subtype').asName(),
        line: numbers(dict.get('L')),
        vertices: numbers(dict.get('Vertices')),
        contents: dict.get('Contents').asString(),
        ratio: numbers(measure.get('R')),
        unit: measure.get('X').resolve().get('U').asString(),
        appearance: dict.get('AP').resolve().get('N').isStream(),
      };
    });
  } finally {
    doc.destroy();
  }
}

describe('writeMeasureAnnotations', () => {
  it('writes a distance and an area where they were drawn, with their scale, unit and comment', async () => {
    const out = await writeMeasureAnnotations(
      await blank(),
      [
        mark({
          id: 'd',
          mode: 'distance',
          points: [
            { x: 50, y: 100 },
            { x: 250, y: 100 },
          ],
        }),
        mark({
          id: 'a',
          mode: 'area',
          points: [
            { x: 50, y: 200 },
            { x: 150, y: 200 },
            { x: 150, y: 300 },
          ],
        }),
      ],
      run,
    );
    const [distance, area] = await read(out.bytes);
    // App space is top-left: y = 100 on a 500-high page is 400 in the file.
    expect(distance).toMatchObject({
      subtype: 'Line',
      line: [50, 400, 250, 400],
      ratio: [1, 100],
      unit: 'cm',
      appearance: true,
    });
    expect(distance?.contents).toContain('Çatı alanı');
    expect(area).toMatchObject({
      subtype: 'Polygon',
      vertices: [50, 300, 150, 300, 150, 200],
      ratio: [1, 100],
      // An area is read in square units of the scale's unit.
      unit: 'cm²',
      appearance: true,
    });
    expect(out.written).toHaveLength(2);
  });

  it('paints the ruler and the outline where they were drawn, in the mark colour', async () => {
    const out = await writeMeasureAnnotations(
      await blank(),
      [
        mark({
          id: 'd',
          mode: 'distance',
          points: [
            { x: 50, y: 100 },
            { x: 250, y: 100 },
          ],
        }),
        mark({
          id: 'a',
          mode: 'area',
          points: [
            { x: 50, y: 200 },
            { x: 150, y: 200 },
            { x: 150, y: 300 },
          ],
        }),
      ],
      run,
    );
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
      const pixels = pixmap.getPixels();
      const width = pixmap.getWidth();
      /** Whether a red-tinted pixel lies within one pixel of the point (a hairline antialiases to pink). */
      const red = (x: number, y: number): boolean => {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const at = ((y + dy) * width + x + dx) * pixmap.getNumberOfComponents();
            if ((pixels[at] ?? 0) > 200 && (pixels[at] ?? 0) - (pixels[at + 1] ?? 255) > 60) return true;
          }
        }
        return false;
      };
      // The ruler runs along y = 100 from x = 50 to 250, and ends there.
      expect([red(60, 100), red(150, 100), red(245, 100)]).toEqual([true, true, true]);
      expect([red(150, 90), red(150, 110), red(280, 100)]).toEqual([false, false, false]);
      // The polygon's three edges: top, right and the hypotenuse; nothing outside the triangle.
      expect([red(100, 200), red(150, 250), red(100, 250)]).toEqual([true, true, true]);
      expect([red(60, 290), red(100, 280), red(200, 250)]).toEqual([false, false, false]);
    } finally {
      doc.destroy();
    }
  });

  it('refuses a mark on a page the document does not have', async () => {
    await expect(
      writeMeasureAnnotations(
        await blank(),
        [
          mark({
            id: 'x',
            mode: 'distance',
            pageIndex: 3,
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 0 },
            ],
          }),
        ],
        run,
      ),
    ).rejects.toMatchObject({ code: 'selection-empty' });
  });
});

describe('parseScale', () => {
  it('reads the ratio forms with the unit the tool is set to', () => {
    expect(parseScale('1:100')).toMatchObject({ ratio: 100, unit: 'cm', ratioText: '1:100' });
    expect(parseScale(' Ölçek 1 / 250 ', 'm')).toMatchObject({ ratio: 250, unit: 'm' });
    expect(parseScale('2:1')).toMatchObject({ ratio: 0.5 });
  });

  it('reads an equation, whose own right-hand unit wins', () => {
    expect(parseScale('1 cm = 5 m', 'mm')).toMatchObject({ ratio: 500, unit: 'm' });
    expect(parseScale('1 in = 10 ft')).toMatchObject({ ratio: 120, unit: 'ft' });
  });

  it('refuses what it cannot read honestly', () => {
    expect(parseScale('')).toBeNull();
    expect(parseScale('   ')).toBeNull();
    expect(parseScale(42 as never)).toBeNull();
    expect(parseScale('0:100')).toBeNull();
    expect(parseScale('1:0')).toBeNull();
    expect(parseScale('0 cm = 5 m')).toBeNull();
    expect(parseScale('1 cm = 0 m')).toBeNull();
    expect(parseScale('1 cm = 5 parsec')).toBeNull();
    expect(parseScale('1 foo = 5 m')).toBeNull();
    expect(parseScale('1:100000000')).toBeNull();
  });
});

describe('scaleForRatio bounds', () => {
  it('accepts the limits themselves and refuses a ratio beyond them', () => {
    expect(scaleForRatio(1e7).ratio).toBe(1e7);
    expect(scaleForRatio(1e-7).ratio).toBe(1e-7);
    expect(() => scaleForRatio(1e8)).toThrowError(expect.objectContaining({ code: 'value-out-of-range' }));
    expect(() => scaleForRatio(1e-8)).toThrowError(expect.objectContaining({ code: 'value-out-of-range' }));
    expect(() => scaleForRatio(0)).toThrowError(expect.objectContaining({ code: 'value-out-of-range' }));
  });
});

describe('page geometry helpers', () => {
  it('turns any /Rotate into the nearest quarter turn within 0…270', () => {
    expect([0, 90, 180, 270, 360, 450, -90, -180, 100, 40].map(quarterTurns)).toEqual([
      0, 90, 180, 270, 0, 90, 270, 180, 90, 0,
    ]);
  });

  it('spans a rectangle between two corners in either click order', () => {
    const expected = [
      { x: 10, y: 20 },
      { x: 50, y: 20 },
      { x: 50, y: 70 },
      { x: 10, y: 70 },
    ];
    expect(squareCorners({ x: 10, y: 20 }, { x: 50, y: 70 })).toEqual(expected);
    expect(squareCorners({ x: 50, y: 70 }, { x: 10, y: 20 })).toEqual(expected);
    expect(squareCorners({ x: 10, y: 70 }, { x: 50, y: 20 })).toEqual(expected);
  });
});

describe('measurement readouts', () => {
  const scale = scaleForRatio(100, 'cm');
  const line = measureChain(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    'distance',
  );

  it('has no value under a scale that cannot convert points', () => {
    expect(measuredValue(line, scale)).toBeCloseTo(100 / scale.pointsPerUnit, 6);
    for (const pointsPerUnit of [0, -2, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(measuredValue(line, { ...scale, pointsPerUnit })).toBeNaN();
    }
  });

  it('prints an area as — under a scale that cannot convert points', () => {
    expect(formatArea(10000, scale)).toMatch(/cm²$/);
    for (const pointsPerUnit of [0, -2, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(formatArea(10000, { ...scale, pointsPerUnit })).toBe('—');
    }
    expect(formatArea(Number.NaN, scale)).toBe('—');
  });

  it('keeps the requested number of decimals, within 0…6', () => {
    expect(formatNumber(1.5, 2)).toBe('1,50');
    expect(formatNumber(1.5, 0)).toBe('2');
    expect(formatNumber(1.5, -3)).toBe('2');
    expect(formatNumber(1.5, 99)).toBe('1,500000');
    expect(formatNumber(1.5, Number.NaN)).toBe('1,50');
  });
});

describe('writeMeasureAnnotations refusals and stroke', () => {
  const ruler = [
    { x: 50, y: 100 },
    { x: 250, y: 100 },
  ];

  it('refuses a negative or fractional page index', async () => {
    for (const pageIndex of [-1, 0.5]) {
      await expect(
        writeMeasureAnnotations(
          await blank(),
          [mark({ id: 'x', mode: 'distance', pageIndex, points: ruler })],
          run,
        ),
      ).rejects.toMatchObject({ code: 'selection-empty' });
    }
  });

  it('draws the stroke at the requested width, between 0.5 and 24 points', async () => {
    const widthOf = async (thickness: number): Promise<string> => {
      const out = await writeMeasureAnnotations(
        await blank(),
        [mark({ id: 'w', mode: 'distance', points: ruler, thickness })],
        run,
      );
      const mupdf = await import('mupdf');
      const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
      if (doc === null) throw new Error('not a PDF');
      try {
        const annotation = doc.findPage(0).get('Annots').resolve().get(0).resolve();
        return annotation.get('AP').resolve().get('N').readStream().asString().split('\n')[0] ?? '';
      } finally {
        doc.destroy();
      }
    };
    expect(await widthOf(2)).toBe('2.000 w');
    expect(await widthOf(0.1)).toBe('0.500 w');
    expect(await widthOf(100)).toBe('24.000 w');
  });
});
