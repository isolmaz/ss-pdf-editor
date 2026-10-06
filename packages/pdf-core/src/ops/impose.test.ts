/**
 * Imposition against real bytes. The wrong answers that matter: pages in the wrong cells
 * (a booklet that does not fold into reading order, a duplex back side that lands behind
 * the wrong front cell), a turned source page placed sideways, cropped content brought
 * back, and text that stops being text on the sheet.
 */

import { createTranslator } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { buildPrintDocument, imposeDocument } from './impose';

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
    for (const entry of out.report.notes) expect(say(entry.key, entry.params)).not.toMatch(/\{[a-zA-Z]+\}/);
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
