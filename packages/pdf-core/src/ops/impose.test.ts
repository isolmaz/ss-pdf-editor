/**
 * Imposition against real bytes. The wrong answers that matter: pages in the wrong cells
 * (a booklet that does not fold into reading order, a duplex back side that lands behind
 * the wrong front cell), a turned source page placed sideways, cropped content brought
 * back, and text that stops being text on the sheet.
 */

import { createTranslator, isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { PRODUCER_LINE } from '../engines/mupdf-write';
import {
  buildPrintDocument,
  type ImposeOptions,
  imposeDocument,
  type PrintImpositionOptions,
  planImposition,
  planPrintSheets,
} from './impose';

const run = { signal: new AbortController().signal };

/**
 * `count` A5-ish portrait pages, page `n` showing the word `Pn` near its top-left
 * corner; `turned` pages carry /Rotate 90, `cropped` pages a CropBox that hides a
 * `HIDDEN` word.
 */
async function source(count: number, turned: readonly number[] = [], cropped: readonly number[] = []) {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  for (let index = 0; index < count; index += 1) {
    const content = `BT /F 24 Tf 40 500 Td (P${index + 1}) Tj ET BT /F 24 Tf 40 20 Td (HIDDEN) Tj ET`;
    const page = doc.addPage(
      [0, 0, 400, 560],
      turned.includes(index) ? 90 : 0,
      { Font: { F: font } },
      content,
    );
    if (cropped.includes(index)) page.put('CropBox', [0, 100, 400, 560]);
    doc.insertPage(index, page);
  }
  doc.setMetaData('info:Title', 'Kitapçık');
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Every sheet: its displayed size and the words on it with their displayed boxes. */
async function sheets(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return Array.from({ length: doc.countPages() }, (_unused, index) => {
      const page = doc.loadPage(index);
      const bounds = page.getBounds();
      const json = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
        blocks: { lines?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] }[];
      };
      return {
        width: Math.round(bounds[2] - bounds[0]),
        height: Math.round(bounds[3] - bounds[1]),
        words: json.blocks.flatMap((block) => block.lines ?? []),
      };
    });
  } finally {
    doc.destroy();
  }
}

const labels = (sheet: { words: { text: string; bbox: { x: number } }[] }) =>
  sheet.words
    .filter((word) => /^P\d+$/.test(word.text))
    .sort((left, right) => left.bbox.x - right.bbox.x)
    .map((word) => word.text);

describe('imposeDocument', () => {
  it('puts two portrait pages side by side on a landscape sheet, as text', async () => {
    const out = await imposeDocument(
      await source(3),
      {
        mode: 'nup',
        pages: [0, 1, 2],
        perSheet: 2,
        paper: 'a4',
        orientation: 'auto',
        gutterMm: 5,
        marginMm: 5,
        rotateContent: false,
      },
      run,
    );
    const result = await sheets(out.bytes);
    expect(result.map((sheet) => [sheet.width, sheet.height])).toEqual([
      [842, 595],
      [842, 595],
    ]);
    expect(labels(result[0] ?? { words: [] })).toEqual(['P1', 'P2']);
    expect(labels(result[1] ?? { words: [] })).toEqual(['P3']);
    // Every report line reads as a sentence: the producer note once printed `{producer}`.
    const say = createTranslator();
    const lines = out.report.notes.map((entry) => say(entry.key, entry.params));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(/\{[a-zA-Z]+\}/);
    const producer = out.report.notes.findIndex((entry) => entry.key === 'op.note.metadata.producerKept');
    expect(producer).toBeGreaterThanOrEqual(0);
    expect(lines[producer]).toContain(PRODUCER_LINE);
  });

  it('orders a booklet so the folded sheets read 1…N', async () => {
    const out = await imposeDocument(
      await source(4),
      { mode: 'booklet', pages: [0, 1, 2, 3], paper: 'a4', gutterMm: 0, marginMm: 0 },
      run,
    );
    expect((await sheets(out.bytes)).map(labels)).toEqual([
      ['P4', 'P1'],
      ['P2', 'P3'],
    ]);
  });

  it('keeps a turned page upright and a crop cropped', async () => {
    const out = await imposeDocument(
      await source(2, [0], [1]),
      {
        mode: 'nup',
        pages: [0, 1],
        perSheet: 2,
        paper: 'a4',
        orientation: 'landscape',
        gutterMm: 0,
        marginMm: 0,
        rotateContent: false,
      },
      run,
    );
    const [sheet] = await sheets(out.bytes);
    // The turned page is shown as a reader shows it: its words run top to bottom. Its
    // HIDDEN word is the only one left — the cropped page's is outside its CropBox.
    const hidden = sheet?.words.filter((word) => word.text === 'HIDDEN') ?? [];
    expect(hidden).toHaveLength(1);
    expect((hidden[0]?.bbox.h ?? 0) > (hidden[0]?.bbox.w ?? 0)).toBe(true);
    // …and turned the way `/Rotate 90` turns it, clockwise: the page's top-left label
    // ends up at the top right of its cell. A counter-clockwise turn is just as
    // vertical, and put the label at the bottom left — the page upside down.
    const label = sheet?.words.find((word) => word.text === 'P1');
    expect(label).toBeDefined();
    const cellWidth = (sheet?.width ?? 0) / 2;
    expect((label?.bbox.x ?? 0) + (label?.bbox.w ?? 0) / 2).toBeGreaterThan(cellWidth / 2);
    expect((label?.bbox.y ?? 0) + (label?.bbox.h ?? 0) / 2).toBeLessThan((sheet?.height ?? 0) / 2);
  });

  it('tiles a poster over columns × rows sheets', async () => {
    const out = await imposeDocument(
      await source(1),
      { mode: 'poster', pages: [0], paper: 'a4', columns: 2, rows: 2, overlapMm: 10, cropMarks: true },
      run,
    );
    const result = await sheets(out.bytes);
    expect(result).toHaveLength(4);
    // The top-left tile carries the top-left corner of the enlarged page.
    expect(labels(result[0] ?? { words: [] })).toEqual(['P1']);
    expect(labels(result[3] ?? { words: [] })).toEqual([]);
    // …and the bottom-left tile its bottom edge: the whole page is on the grid.
    expect(result[2]?.words.map((word) => word.text)).toContain('HIDDEN');
  });

  it('tiles a page the file turns clockwise the way a reader shows it', async () => {
    const out = await imposeDocument(
      await source(1, [0]),
      { mode: 'poster', pages: [0], paper: 'a4', columns: 2, rows: 2, overlapMm: 0, cropMarks: false },
      run,
    );
    // `/Rotate 90` carries the page's top-left label to the top right, so it is on the
    // top-right tile; turned the other way, the poster was upside down and it was on the
    // bottom-left one.
    expect((await sheets(out.bytes)).map(labels)).toEqual([[], ['P1'], [], []]);
  });
});

describe('imposeDocument poster overlap and crop marks', () => {
  /** One 800×560 page with the word LEFT at x = 80 and RIGHT at x = 600, both near the top. */
  async function wide(): Promise<Uint8Array> {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    const font = doc.addObject({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: 'WinAnsiEncoding',
    });
    doc.insertPage(
      0,
      doc.addPage(
        [0, 0, 800, 560],
        0,
        { Font: { F: font } },
        'BT /F 24 Tf 80 500 Td (LEFT) Tj ET BT /F 24 Tf 600 500 Td (RIGHT) Tj ET',
      ),
    );
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    return bytes;
  }

  const poster = (overlapMm: number, cropMarks: boolean) =>
    ({ mode: 'poster', pages: [0], paper: 'a4', columns: 2, rows: 1, overlapMm, cropMarks }) as const;

  it('places the tiles one sheet-minus-overlap apart, on one scale for the whole grid', async () => {
    const A4_WIDTH = 595.276;
    const overlap = 50 * (72 / 25.4);
    const pitch = A4_WIDTH - overlap;
    // One uniform scale fits the 800-pt-wide page into two sheets that share the overlap
    // (the height, 560 × scale, still fits one A4 sheet).
    const scale = (2 * A4_WIDTH - overlap) / 800;
    const out = await imposeDocument(await wide(), poster(50, false), run);
    const [left, right] = await sheets(out.bytes);
    const at = (sheet: Awaited<ReturnType<typeof sheets>>[number] | undefined, text: string) =>
      sheet?.words.find((word) => word.text === text)?.bbox.x;
    expect(at(left, 'LEFT')).toBeCloseTo(80 * scale, -1);
    expect(at(right, 'RIGHT')).toBeCloseTo(600 * scale - pitch, -1);
    expect(at(right, 'LEFT')).toBeUndefined();
  });

  it('draws crop marks on the tiles only when asked', async () => {
    const ink = async (cropMarks: boolean) => {
      const out = await imposeDocument(await wide(), poster(10, cropMarks), run);
      const mupdf = await import('mupdf');
      const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
      try {
        const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false);
        // Hairlines are antialiased to light greys, so any pixel that is not white counts.
        return Array.from(pixmap.getPixels()).filter((value) => value < 250).length;
      } finally {
        doc.destroy();
      }
    };
    const plain = await ink(false);
    expect(await ink(true)).toBeGreaterThan(plain + 20);
  });
});

describe('buildPrintDocument', () => {
  it('leaves a long-edge landscape 2-up back side in place: the flip changes nothing in a single row', async () => {
    const out = await buildPrintDocument(
      await source(4),
      {
        pages: [0, 1, 2, 3],
        perSheet: 2,
        paper: 'a4',
        duplex: 'long-edge',
        landscape: true,
        scale: 'fit',
        marginMm: 5,
        cropMarks: false,
        booklet: false,
      },
      run,
    );
    const result = await sheets(out.bytes);
    expect(result).toHaveLength(2);
    // A landscape sheet flipped about its long (horizontal) edge: the two cells side by
    // side stay in place, so the back reads P3, P4 left to right.
    expect(result.map(labels)).toEqual([
      ['P1', 'P2'],
      ['P3', 'P4'],
    ]);
  });

  it('prints a page the file turns clockwise the way a reader shows it', async () => {
    const out = await buildPrintDocument(
      await source(1, [0]),
      {
        pages: [0],
        perSheet: 1,
        paper: 'a4',
        duplex: 'simplex',
        landscape: true,
        scale: 'fit',
        marginMm: 0,
        cropMarks: false,
        booklet: false,
      },
      run,
    );
    const [sheet] = await sheets(out.bytes);
    // `/Rotate 90` carries the top-left label to the top right; the print once turned the
    // page the other way, upside down.
    const label = sheet?.words.find((word) => word.text === 'P1');
    expect(label).toBeDefined();
    expect((label?.bbox.x ?? 0) + (label?.bbox.w ?? 0) / 2).toBeGreaterThan((sheet?.width ?? 0) / 2);
    expect((label?.bbox.y ?? 0) + (label?.bbox.h ?? 0) / 2).toBeLessThan((sheet?.height ?? 0) / 2);
  });

  /** The page labels of a sheet as rows (top to bottom), each left to right. */
  const rows = (sheet: { words: { text: string; bbox: { x: number; y: number } }[] } | undefined) => {
    const words = (sheet?.words ?? [])
      .filter((word) => /^P\d+$/.test(word.text))
      .sort((left, right) => left.bbox.y - right.bbox.y);
    const grouped: (typeof words)[] = [];
    for (const word of words) {
      const last = grouped.at(-1);
      if (last !== undefined && Math.abs((last[0]?.bbox.y ?? 0) - word.bbox.y) < 20) last.push(word);
      else grouped.push([word]);
    }
    return grouped.map((row) =>
      row.sort((left, right) => left.bbox.x - right.bbox.x).map((word) => word.text),
    );
  };

  it.each([
    // The file header's table: the back's slot k is drawn at c' = C-1-c (mirrored columns) or
    // r' = R-1-r (mirrored rows), depending on which edge the sheet flips about.
    {
      duplex: 'long-edge',
      landscape: false,
      back: [
        ['P6', 'P5'],
        ['P8', 'P7'],
      ],
    },
    {
      duplex: 'short-edge',
      landscape: false,
      back: [
        ['P7', 'P8'],
        ['P5', 'P6'],
      ],
    },
    {
      duplex: 'long-edge',
      landscape: true,
      back: [
        ['P7', 'P8'],
        ['P5', 'P6'],
      ],
    },
    {
      duplex: 'short-edge',
      landscape: true,
      back: [
        ['P6', 'P5'],
        ['P8', 'P7'],
      ],
    },
  ] as const)(
    'draws the $duplex back side of a landscape=$landscape 2x2 sheet in the mirrored cells',
    async ({ duplex, landscape, back }) => {
      const out = await buildPrintDocument(
        await source(8),
        {
          pages: [0, 1, 2, 3, 4, 5, 6, 7],
          perSheet: 4,
          paper: 'a4',
          duplex,
          landscape,
          scale: 'fit',
          marginMm: 5,
          cropMarks: false,
          booklet: false,
        },
        run,
      );
      const result = await sheets(out.bytes);
      expect(result).toHaveLength(2);
      expect(rows(result[0])).toEqual([
        ['P1', 'P2'],
        ['P3', 'P4'],
      ]);
      expect(rows(result[1])).toEqual(back);
    },
  );
});

// ---------------------------------------------------------------------------
// planning, refusals, stops and the paths the first tests do not take
// ---------------------------------------------------------------------------

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
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

function refusalOf(call: () => unknown): ToolError {
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

const nup = (overrides: Partial<Extract<ImposeOptions, { mode: 'nup' }>> = {}): ImposeOptions => ({
  mode: 'nup',
  pages: [0, 1],
  perSheet: 2,
  paper: 'a4',
  orientation: 'auto',
  gutterMm: 0,
  marginMm: 0,
  rotateContent: false,
  ...overrides,
});

const print = (overrides: Partial<PrintImpositionOptions> = {}): PrintImpositionOptions => ({
  pages: [0, 1, 2, 3],
  perSheet: 1,
  booklet: false,
  duplex: 'simplex',
  marginMm: 0,
  paper: 'a4',
  landscape: false,
  cropMarks: false,
  scale: 'fit',
  ...overrides,
});

describe('planImposition', () => {
  it('counts the sheets of each mode and the pages a signature pads', () => {
    expect(planImposition(5, nup({ perSheet: 2 }))).toEqual({ sheets: 3, perSheet: 2, padded: 0 });
    expect(planImposition(5, { mode: 'booklet', pages: [], paper: 'a4', gutterMm: 0, marginMm: 0 })).toEqual({
      sheets: 2,
      perSheet: 4,
      padded: 3,
    });
    expect(
      planImposition(2, {
        mode: 'poster',
        pages: [],
        paper: 'a4',
        columns: 2,
        rows: 3,
        overlapMm: 0,
        cropMarks: false,
      }),
    ).toEqual({ sheets: 12, perSheet: 1, padded: 0 });
  });

  it.each([[-1], [1.5], [Number.NaN]])('refuses a source page count of %s', (count) => {
    expect(refusalOf(() => planImposition(count, nup())).details.engineMessage).toBe(
      'invalid source page count',
    );
  });

  it.each([[0], [11]])('refuses a poster of %s columns', (columns) => {
    const error = refusalOf(() =>
      planImposition(1, {
        mode: 'poster',
        pages: [],
        paper: 'a4',
        columns,
        rows: 1,
        overlapMm: 0,
        cropMarks: false,
      }),
    );
    expect(error.details.engineMessage).toBe('columns must be between 1 and 10');
  });
});

describe('a poster grid is whole tiles', () => {
  it.each([
    ['columns', { columns: 1.5, rows: 1 }],
    ['rows', { columns: 1, rows: 2.5 }],
  ])('refuses a fractional number of %s', async (field, grid) => {
    const options: ImposeOptions = {
      mode: 'poster',
      pages: [0],
      paper: 'a4',
      overlapMm: 0,
      cropMarks: false,
      ...grid,
    };
    expect(refusalOf(() => planImposition(1, options)).details.engineMessage).toBe(
      `${field} must be a whole number`,
    );
    const error = await refusal(imposeDocument(await source(1), options, run));
    expect(error.code).toBe('range-invalid');
    expect(error.details.engineMessage).toBe(`${field} must be a whole number`);
  });
});

describe('imposeDocument refuses what it cannot lay out', () => {
  it.each([
    ['no page', nup({ pages: [] }), 'selection-empty', 'no pages to impose'],
    ['a page the file lacks', nup({ pages: [0, 9] }), 'range-invalid', 'page index out of bounds'],
    ['a fractional page', nup({ pages: [0.5] }), 'range-invalid', 'page index out of bounds'],
    [
      'a margin that is not allowed',
      nup({ marginMm: 200 }),
      'range-invalid',
      'marginMm must be between 0 and 100',
    ],
    [
      'a gutter that is not a number',
      nup({ gutterMm: Number.NaN }),
      'range-invalid',
      'gutterMm must be between 0 and 100',
    ],
    [
      'margins that leave no cell',
      nup({ gutterMm: 100, perSheet: 16 }),
      'range-invalid',
      'margins and gutter leave no room for cells',
    ],
    [
      'a poster overlap that is too big',
      { mode: 'poster', pages: [0], paper: 'a4', columns: 1, rows: 1, overlapMm: 60, cropMarks: false },
      'range-invalid',
      'overlapMm must be between 0 and 50',
    ],
  ] as const)('refuses %s', async (_name, options, code, message) => {
    const error = await refusal(imposeDocument(await source(2), options as ImposeOptions, run));
    expect(error.code).toBe(code);
    expect(error.details.engineMessage).toBe(message);
  });

  it('stops at an aborted signal in every mode, and between sheets', async () => {
    const bytes = await source(4);
    const before = new AbortController();
    before.abort();
    await expect(imposeDocument(bytes, nup(), { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const modes: ImposeOptions[] = [
      nup({ pages: [0, 1, 2, 3], perSheet: 2 }),
      { mode: 'booklet', pages: [0, 1, 2, 3], paper: 'a4', gutterMm: 0, marginMm: 0 },
      { mode: 'poster', pages: [0], paper: 'a4', columns: 2, rows: 2, overlapMm: 0, cropMarks: false },
    ];
    for (const options of modes) {
      const midway = new AbortController();
      await expect(
        imposeDocument(bytes, options, { signal: midway.signal, onProgress: () => midway.abort() }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    }
  });
});

describe('imposeDocument layouts the first tests do not take', () => {
  it('draws one page twice on a sheet from the same embedded form', async () => {
    const out = await imposeDocument(await source(1), nup({ pages: [0, 0] }), run);
    const [sheet] = await sheets(out.bytes);
    expect(labels(sheet as NonNullable<typeof sheet>)).toEqual(['P1', 'P1']);
  });

  it('chooses a portrait sheet for wide pages and a landscape one for tall pages', async () => {
    const wide = await imposeDocument(await source(2, [0, 1]), nup(), run);
    expect((await sheets(wide.bytes))[0]).toMatchObject({ width: 595, height: 842 });
    const tall = await imposeDocument(await source(2), nup(), run);
    expect((await sheets(tall.bytes))[0]).toMatchObject({ width: 842, height: 595 });
  });

  it('turns a page whose aspect fights its cell, and says how many', async () => {
    const out = await imposeDocument(
      await source(2),
      nup({ orientation: 'portrait', rotateContent: true }),
      run,
    );
    expect(out.report.notes.find((entry) => entry.key === 'op.note.impose.rotated')?.params).toEqual({
      count: 2,
    });
    const plain = await imposeDocument(await source(2), nup({ orientation: 'portrait' }), run);
    expect(plain.report.notes.map((entry) => entry.key)).not.toContain('op.note.impose.rotated');
  });

  it('pads a booklet of three pages with a blank, and says so', async () => {
    const out = await imposeDocument(
      await source(3),
      { mode: 'booklet', pages: [0, 1, 2], paper: 'a4', gutterMm: 0, marginMm: 0 },
      run,
    );
    expect(out.report.notes.find((entry) => entry.key === 'op.note.impose.padded')?.params).toEqual({
      count: 1,
    });
    expect(out.report.pageCount).toBe(2);
    expect((await sheets(out.bytes)).map(labels)).toEqual([['P1'], ['P2', 'P3']]);
  });
});

describe('planPrintSheets', () => {
  it.each([[-1], [1.5]])('refuses a page count of %s', (count) => {
    const error = refusalOf(() => planPrintSheets(count, print()));
    expect(error.details.engineMessage).toBe('invalid source page count');
    expect(error.details.path).toBe(String(count));
  });

  it('refuses a booklet that is not 4-up, or that is printed on one side', () => {
    expect(
      refusalOf(() => planPrintSheets(4, print({ booklet: true, duplex: 'long-edge', perSheet: 2 }))).details
        .engineMessage,
    ).toContain('perSheet must be 4, not 2');
    const simplex = refusalOf(() => planPrintSheets(4, print({ booklet: true, perSheet: 4 })));
    expect(simplex.code).toBe('unsupported');
  });

  it('lays a signature out in reading order, stacked for a long-edge fold and side by side for a short-edge one', () => {
    const long = planPrintSheets(4, print({ booklet: true, perSheet: 4, duplex: 'long-edge' }));
    expect(long).toEqual({
      sheets: [{ front: [3, 0], back: [1, 2] }],
      columns: 1,
      rows: 2,
      orientation: 'portrait',
      padded: 0,
    });
    const short = planPrintSheets(
      3,
      print({ booklet: true, perSheet: 4, duplex: 'short-edge', pages: [0, 1, 2] }),
    );
    expect(short).toEqual({
      sheets: [{ front: [null, 0], back: [1, 2] }],
      columns: 2,
      rows: 1,
      orientation: 'landscape',
      padded: 1,
    });
  });

  it('gives a duplex sheet no back when nothing is left for it, and pads a short block with blanks', () => {
    const plan = planPrintSheets(3, print({ pages: [0, 1, 2], perSheet: 2, duplex: 'long-edge' }));
    expect(plan.sheets).toEqual([
      { front: [0, 1], back: [2, null].map((page, slot) => (slot === 0 ? page : page)) },
    ]);
    const lone = planPrintSheets(1, print({ pages: [0], perSheet: 1, duplex: 'long-edge' }));
    expect(lone.sheets).toEqual([{ front: [0], back: null }]);
    const simplex = planPrintSheets(3, print({ pages: [0, 1, 2], perSheet: 2 }));
    expect(simplex.sheets).toEqual([
      { front: [0, 1], back: null },
      { front: [2, null], back: null },
    ]);
  });
});

describe('buildPrintDocument beyond the plan', () => {
  it('cuts a page at its cell when it is printed at actual size, and says how many it cut', async () => {
    const out = await buildPrintDocument(await source(4), print({ perSheet: 4, scale: 'actual' }), run);
    expect(out.report.notes.find((entry) => entry.key === 'print.note.actual')?.params).toEqual({ count: 4 });
    const fit = await buildPrintDocument(await source(4), print({ perSheet: 4, scale: 'fit' }), run);
    expect(fit.report.notes.map((entry) => entry.key)).not.toContain('print.note.actual');
    const shrunk = await buildPrintDocument(
      await source(4),
      print({ perSheet: 4, scale: 'shrink-to-fit' }),
      run,
    );
    expect(shrunk.report.notes.map((entry) => entry.key)).not.toContain('print.note.actual');
  });

  it('names the way each job is printed in its report', async () => {
    const keys = async (options: Partial<PrintImpositionOptions>) =>
      (
        await buildPrintDocument(await source(3), print({ pages: [0, 1, 2], ...options }), run)
      ).report.notes.map((entry) => entry.key);
    expect(await keys({ duplex: 'simplex' })).toContain('print.note.simplex');
    expect(await keys({ duplex: 'long-edge', perSheet: 2 })).toContain('print.note.duplexLong');
    expect(await keys({ duplex: 'short-edge', perSheet: 2 })).toContain('print.note.duplexShort');
    const booklet = await keys({ duplex: 'long-edge', perSheet: 4, booklet: true });
    expect(booklet).toEqual(expect.arrayContaining(['print.note.booklet', 'print.note.padded']));
    expect(await keys({ cropMarks: true })).toContain('print.note.cropMarks');
    expect(await keys({})).not.toContain('print.note.cropMarks');
  });

  it('draws crop marks at the corners of every cell', async () => {
    const plain = await buildPrintDocument(await source(1), print({ pages: [0] }), run);
    const marked = await buildPrintDocument(await source(1), print({ pages: [0], cropMarks: true }), run);
    expect(marked.bytes.byteLength).toBeGreaterThan(plain.bytes.byteLength);
  });

  it('stops at an aborted signal, before and between sheets', async () => {
    const bytes = await source(3);
    const before = new AbortController();
    before.abort();
    await expect(buildPrintDocument(bytes, print(), { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const midway = new AbortController();
    await expect(
      buildPrintDocument(bytes, print({ pages: [0, 1, 2] }), {
        signal: midway.signal,
        onProgress: () => midway.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('buildPrintDocument refuses what it cannot lay out', () => {
  it.each([
    ['no page', print({ pages: [] }), 'selection-empty', 'no pages to impose'],
    ['a page the file lacks', print({ pages: [0, 9] }), 'range-invalid', 'page index out of bounds'],
    [
      'a booklet printed on one side',
      print({ pages: [0, 1], booklet: true, perSheet: 4 }),
      'unsupported',
      'duplex must be long-edge or short-edge',
    ],
  ] as const)('refuses %s', async (_name, options, code, message) => {
    const error = await refusal(buildPrintDocument(await source(2), options, run));
    expect(error.code).toBe(code);
    expect(error.details.engineMessage).toContain(message);
  });

  it('pads a booklet of one page with three blanks', () => {
    const plan = planPrintSheets(1, print({ pages: [0], booklet: true, perSheet: 4, duplex: 'long-edge' }));
    expect(plan.sheets).toEqual([{ front: [null, 0], back: [null, null] }]);
    expect(plan.padded).toBe(3);
  });
});

describe('a poster of a page the file turns half round', () => {
  it('keeps the page upright on its tiles', async () => {
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument((await source(1)).slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    doc.findPage(0).put('Rotate', 180);
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const out = await imposeDocument(
      bytes,
      { mode: 'poster', pages: [0], paper: 'a4', columns: 1, rows: 1, overlapMm: 0, cropMarks: false },
      run,
    );
    const [tile] = await sheets(out.bytes);
    const label = tile?.words.find((word) => word.text === 'P1');
    expect(label).toBeDefined();
    // Turned half round, the top-left label lands at the bottom right of the sheet.
    expect((label?.bbox.x ?? 0) + (label?.bbox.w ?? 0) / 2).toBeGreaterThan((tile?.width ?? 0) / 2);
    expect((label?.bbox.y ?? 0) + (label?.bbox.h ?? 0) / 2).toBeGreaterThan((tile?.height ?? 0) / 2);
  });
});
