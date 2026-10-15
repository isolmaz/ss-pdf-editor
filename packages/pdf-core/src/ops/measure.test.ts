/**
 * Measurement annotations, against real bytes. The wrong answers that matter: a line
 * whose endpoints land somewhere else than they were drawn, a measure dictionary that
 * loses its ratio or its unit, a Turkish comment mangled, and a polygon written without
 * its vertices.
 */

import type { PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { readAnnotations } from './annotations';
import { handPdf } from './forms.fixtures';
import {
  formatArea,
  formatNumber,
  type MeasureMark,
  measureChain,
  measuredValue,
  measureGeometry,
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
    const numbers = (value: PDFObject) => {
      if (value.isNull()) return null;
      const array = value.resolve();
      return Array.from({ length: array.length }, (_unused, index) => array.get(index).asNumber());
    };
    return Array.from({ length: annots.length }, (_unused, index) => {
      const dict = annots.get(index).resolve();
      const measure = dict.get('Measure').resolve();
      /** A number format array, element by element — `null` when the entry is not an array. */
      const formats = (value: PDFObject) => {
        const array = value.resolve();
        if (!array.isArray()) return null;
        return Array.from({ length: array.length }, (_item, at) => {
          const format = array.get(at).resolve();
          return {
            type: format.get('Type').asName(),
            unit: format.get('U').asString(),
            factor: format.get('C').asNumber(),
            precision: format.get('D').asNumber(),
            keepZeros: format.get('FD').asBoolean(),
          };
        });
      };
      return {
        subtype: dict.get('Subtype').asName(),
        line: numbers(dict.get('L')),
        vertices: numbers(dict.get('Vertices')),
        contents: dict.get('Contents').asString(),
        measureType: measure.get('Type').asName(),
        measureSubtype: measure.get('Subtype').asName(),
        // `/R` is a text string (Table 262), not a number array.
        ratio: measure.get('R').isString() ? measure.get('R').asString() : null,
        x: formats(measure.get('X')),
        distance: formats(measure.get('D')),
        area: formats(measure.get('A')),
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
    // 1:100 in cm: one user-space unit is 2.54 / 72 × 100 = 3.5278 cm.
    const perUnit = (2.54 / 72) * 100;
    // App space is top-left: y = 100 on a 500-high page is 400 in the file.
    expect(distance).toMatchObject({
      subtype: 'Line',
      line: [50, 400, 250, 400],
      // 200 pt is 705.6 cm; the text is in Turkish unless a locale is passed.
      contents: '705,6 cm Çatı alanı',
      appearance: true,
    });
    expect(area).toMatchObject({
      subtype: 'Polygon',
      vertices: [50, 300, 150, 300, 150, 200],
      // 5000 pt² is 62 226 cm²; four significant digits leave no decimals above 1000.
      contents: '62.226 cm² Çatı alanı',
      appearance: true,
    });
    // ISO 32000-1 Tables 261–263, field by field, for both kinds: the one rectilinear subtype,
    // the ratio as text, and three arrays of number format dictionaries.
    for (const entry of [distance, area]) {
      expect(entry).toMatchObject({ measureType: 'Measure', measureSubtype: 'RL', ratio: '1:100' });
    }
    const format = (unit: string, factor: number | ReturnType<typeof expect.closeTo>, precision: number) => ({
      type: 'NumberFormat',
      unit,
      factor,
      precision,
      keepZeros: true,
    });
    // /X converts user-space units to the unit; /D and /A convert from /X's unit, so their
    // factor is 1. /D is the precision (a power of ten): 10 = one digit, 1 = none.
    expect(distance?.x).toEqual([format('cm', expect.closeTo(perUnit, 4), 10)]);
    expect(distance?.distance).toEqual([format('cm', 1, 10)]);
    expect(distance?.area).toEqual([format('cm²', 1, 10)]);
    expect(area?.x).toEqual([format('cm', expect.closeTo(perUnit, 4), 1)]);
    expect(area?.distance).toEqual([format('cm', 1, 1)]);
    expect(area?.area).toEqual([format('cm²', 1, 1)]);
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

describe('the /Measure dictionary as a reader and the app read it back', () => {
  const ruler = [
    { x: 50, y: 100 },
    { x: 250, y: 100 },
  ];

  it('states an equation scale as the text the user typed, in the real unit of its right-hand side', async () => {
    const scale = parseScale('1 cm = 5 m');
    if (scale === null) throw new Error('the equation must parse');
    const out = await writeMeasureAnnotations(
      await blank(),
      [mark({ id: 'e', mode: 'distance', points: ruler, scale })],
      run,
    );
    const [entry] = await read(out.bytes);
    expect(entry?.ratio).toBe('1 cm = 5 m');
    // One user-space unit is 5 m ÷ 1 cm of paper: 500 × 2.54 / 72 / 100 m.
    expect(entry?.x).toEqual([
      {
        type: 'NumberFormat',
        unit: 'm',
        factor: expect.closeTo(1 / scale.pointsPerUnit, 4),
        precision: 100,
        keepZeros: true,
      },
    ]);
  });

  it('reads back through the annotation reader of the app with its geometry, comment and marker', async () => {
    const out = await writeMeasureAnnotations(
      await blank(),
      [mark({ id: 'rb', mode: 'distance', points: ruler })],
      run,
    );
    const handle = await openWithPdfjs(out.bytes);
    try {
      const found = (await readAnnotations(handle, run)).find((entry) => entry.subtype === 'Line');
      expect(found).toMatchObject({
        subtype: 'Line',
        contents: '705,6 cm Çatı alanı',
        vertices: [50, 400, 250, 400],
      });
      expect(found?.marker).not.toBeNull();
    } finally {
      await handle.destroy();
    }
  });
});

describe('an area whose edges cross', () => {
  /** Two lobes of different size: the signed shoelace sum is 10 000 pt², an area nobody drew. */
  const bowTie = [
    { x: 0, y: 0 },
    { x: 200, y: 200 },
    { x: 200, y: 0 },
    { x: 0, y: 100 },
  ];

  it('has no area, instead of the difference of its lobes', () => {
    const measurement = measureChain(bowTie, 'area');
    expect(measurement.selfIntersecting).toBe(true);
    expect(measurement.area).toBeNaN();
    expect(measuredValue(measurement, scaleForRatio(100, 'cm'))).toBeNaN();
  });

  it('is not mistaken for a simple polygon: a concave one, a closing click and a corner pair are fine', () => {
    const concave = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 50, y: 50 },
      { x: 50, y: 100 },
      { x: 0, y: 100 },
    ];
    expect(measureChain(concave, 'area')).toMatchObject({ selfIntersecting: false, area: 7500 });
    // Clicking the first point again to close the polygon repeats it at the end.
    const closed = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
      { x: 0, y: 0 },
    ];
    expect(measureChain(closed, 'area')).toMatchObject({ selfIntersecting: false, area: 5000 });
    expect(
      measureChain(
        [
          { x: 0, y: 0 },
          { x: 100, y: 50 },
        ],
        'area',
      ),
    ).toMatchObject({ selfIntersecting: false, area: 5000 });
    // An open chain may cross itself: only a closed boundary has an area to get wrong.
    expect(measureChain(bowTie, 'perimeter').selfIntersecting).toBe(false);
  });

  it('counts a pinch at a shared vertex as crossing', () => {
    const pinched = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 50, y: 50 },
    ];
    expect(measureChain(pinched, 'area').selfIntersecting).toBe(true);
  });

  it('is refused by the writer, which writes nothing for it', async () => {
    await expect(
      writeMeasureAnnotations(await blank(), [mark({ id: 'bow', mode: 'area', points: bowTie })], run),
    ).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { engineMessage: expect.stringContaining('crosses itself') },
    });
  });
});

describe('the interface locale in /Contents', () => {
  const at = (length: number) => [
    { x: 20, y: 100 },
    { x: 20 + length, y: 100 },
  ];

  it('prints English numbers for en and Turkish ones by default', async () => {
    const marks = [
      mark({ id: 'a', mode: 'distance', points: at(35), contents: '' }),
      mark({ id: 'b', mode: 'distance', points: at(350), contents: '' }),
    ];
    const english = await writeMeasureAnnotations(await blank(), marks, run, { locale: 'en' });
    expect((await read(english.bytes)).map((entry) => entry.contents)).toEqual(['123.5 cm', '1,235 cm']);
    const turkish = await writeMeasureAnnotations(await blank(), marks, run);
    expect((await read(turkish.bytes)).map((entry) => entry.contents)).toEqual(['123,5 cm', '1.235 cm']);
  });

  it('groups thousands the way the locale does', () => {
    expect(formatNumber(1234.5, 1, 'en')).toBe('1,234.5');
    expect(formatNumber(1234.5, 1, 'tr')).toBe('1.234,5');
  });
});

describe('/UserUnit', () => {
  const page = (extra: string) =>
    handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      3: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 500]${extra}>>`,
    });
  const fifty = [
    { x: 20, y: 100 },
    { x: 70, y: 100 },
  ];

  it('doubles every distance on a page whose user unit is 2, and the /X factor with it', async () => {
    const plain = await writeMeasureAnnotations(
      page(''),
      [mark({ id: 'u', mode: 'distance', points: fifty, contents: '' })],
      run,
    );
    const doubled = await writeMeasureAnnotations(
      page('/UserUnit 2'),
      [mark({ id: 'u', mode: 'distance', points: fifty, contents: '' })],
      run,
    );
    const [one] = await read(plain.bytes);
    const [two] = await read(doubled.bytes);
    // 50 pt at 1:100 in cm is 176.4 cm; a user-space unit of 2/72 inch makes it 352.8 cm.
    expect([one?.contents, two?.contents]).toEqual(['176,4 cm', '352,8 cm']);
    expect(two?.x?.[0]?.factor).toBeCloseTo(2 * (one?.x?.[0]?.factor ?? 0), 4);
  });

  it('reads the key from the page, and treats a missing or non-positive value as 1', async () => {
    const { openForWrite } = await import('../engines/mupdf-write');
    const userUnitOf = async (extra: string): Promise<number | undefined> => {
      const { doc } = await openForWrite(page(extra));
      try {
        return measureGeometry(doc.findPage(0)).userUnit;
      } finally {
        doc.destroy();
      }
    };
    expect([await userUnitOf('/UserUnit 2'), await userUnitOf(''), await userUnitOf('/UserUnit -3')]).toEqual(
      [2, 1, 1],
    );
    const measurement = measureChain(fifty, 'distance', 2);
    expect(measuredValue(measurement, scaleForRatio(100, 'cm'))).toBeCloseTo(
      2 * measuredValue(measureChain(fifty, 'distance'), scaleForRatio(100, 'cm')),
      9,
    );
  });
});

describe('writeMeasureAnnotations with nothing to write', () => {
  it('reports the real page count of the document, which a batch chain resolves its next all against', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R 4 0 R 5 0 R]/Count 3>>',
      3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>',
      4: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>',
      5: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>',
    });
    const out = await writeMeasureAnnotations(bytes, [], run);
    expect(out.bytes).toBe(bytes);
    expect(out.report.pageCount).toBe(3);
  });
});
