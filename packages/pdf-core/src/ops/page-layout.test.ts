/**
 * The layout reader the Office export stands on, on pages built in the test: text with its
 * size and weight in top-left coordinates, ruled tables with their merged cells, tables
 * read from spacing alone, vector drawings found as figures and rendered as a picture.
 * A wrong cell box or a missed rule moves a table's text into the wrong cell.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { fixturePage, gridOperators, reportPage, TABLE_XS, TABLE_YS } from './layout-fixtures';
import {
  findFigures,
  findTables,
  findTextTables,
  fontFamily,
  type PageLayout,
  readPageLayout,
  renderRegion,
  rgb,
  textRows,
} from './page-layout';

async function layoutOf(
  bytes: Uint8Array,
): Promise<{ layout: PageLayout; png: (box: readonly number[]) => Uint8Array }> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  const page = doc.loadPage(0);
  return {
    layout: readPageLayout(mupdf, page, { images: false }),
    png: (box) => renderRegion(mupdf, page, box as [number, number, number, number]),
  };
}

const cellTexts = (table: { cells: readonly { text: string }[] }) => table.cells.map((cell) => cell.text);

describe('page layout', () => {
  it('reads text with its size, weight and position from the top-left corner', async () => {
    const { layout } = await layoutOf(await reportPage());
    expect([layout.width, layout.height]).toEqual([400, 500]);
    const lines = layout.blocks.flatMap((block) => (block.kind === 'text' ? block.lines : []));
    const heading = lines.find((line) => line.chars.map((char) => char.c).join('') === 'Üretim Raporu');
    expect(heading?.chars[0]).toMatchObject({ size: 24, bold: true, italic: false, font: 'Helvetica' });
    // Baseline 450 from the bottom of a 500 pt page: the line sits near y = 50 from the top.
    expect(heading?.box[1]).toBeGreaterThan(20);
    expect(heading?.box[3]).toBeLessThan(60);
    const paragraph = lines.find((line) =>
      line.chars
        .map((char) => char.c)
        .join('')
        .startsWith('Bu bir'),
    );
    expect(paragraph?.chars[0]).toMatchObject({ size: 11, bold: false });
    // 4 horizontal and 4 vertical rules.
    expect(layout.rulings).toHaveLength(8);
  });

  it('finds a ruled table with its rows, columns and the text of every cell', async () => {
    const { layout } = await layoutOf(await reportPage());
    const tables = findTables(layout);
    expect(tables).toHaveLength(1);
    const [table] = tables;
    expect(table?.ruled).toBe(true);
    expect(table?.xs.map(Math.round)).toEqual([...TABLE_XS]);
    // Rows from the top: page height minus the PDF y of each rule.
    expect(table?.ys.map(Math.round)).toEqual(TABLE_YS.map((y) => 500 - y));
    expect(table?.cells.map((cell) => [cell.row, cell.column, cell.text])).toEqual([
      [0, 0, 'Ürün'],
      [0, 1, 'Adet'],
      [0, 2, 'Fiyat'],
      [1, 0, 'Elma'],
      [1, 1, '3'],
      [1, 2, '12,5'],
      [2, 0, 'Çay'],
      [2, 1, '5'],
      [2, 2, '8'],
    ]);
  });

  it('merges a cell across a column rule that is not drawn', async () => {
    const verticals = [
      `${TABLE_XS[0]} ${TABLE_YS[0]} m ${TABLE_XS[0]} ${TABLE_YS[3]} l S`,
      // The rule between columns 0 and 1 starts below the first row.
      `${TABLE_XS[1]} ${TABLE_YS[1]} m ${TABLE_XS[1]} ${TABLE_YS[3]} l S`,
      `${TABLE_XS[2]} ${TABLE_YS[0]} m ${TABLE_XS[2]} ${TABLE_YS[3]} l S`,
      `${TABLE_XS[3]} ${TABLE_YS[0]} m ${TABLE_XS[3]} ${TABLE_YS[3]} l S`,
    ];
    const horizontals = TABLE_YS.map((y) => `${TABLE_XS[0]} ${y} m ${TABLE_XS[3]} ${y} l S`);
    const bytes = await fixturePage(
      [
        { text: 'Toplam', x: 58, y: 360, size: 10 },
        { text: 'Fiyat', x: 258, y: 360, size: 10 },
        { text: 'A', x: 58, y: 330, size: 10 },
        { text: 'B', x: 158, y: 330, size: 10 },
      ],
      ['0.5 w', ...horizontals, ...verticals].join('\n'),
    );
    const [table] = findTables((await layoutOf(bytes)).layout);
    const total = table?.cells.find((cell) => cell.text === 'Toplam');
    expect([total?.row, total?.column, total?.rowSpan, total?.columnSpan]).toEqual([0, 0, 1, 2]);
    const b = table?.cells.find((cell) => cell.text === 'B');
    expect([b?.row, b?.column, b?.columnSpan]).toEqual([1, 1, 1]);
  });

  it('reads a table from spacing when it has no rules, and leaves a lone paragraph out', async () => {
    const row = (y: number, a: string, b: string, c: string) => [
      { text: a, x: 50, y, size: 10 },
      { text: b, x: 170, y, size: 10 },
      { text: c, x: 290, y, size: 10 },
    ];
    const bytes = await fixturePage([
      { text: 'Bu satir tek basina bir paragraf.', x: 50, y: 460, size: 10 },
      ...row(400, 'Ad', 'Adet', 'Fiyat'),
      ...row(385, 'Elma', '3', '12'),
      ...row(370, 'Armut', '5', '8'),
    ]);
    const { layout } = await layoutOf(bytes);
    expect(findTables(layout)).toEqual([]);
    const tables = findTextTables(layout, []);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.ruled).toBe(false);
    expect(cellTexts(tables[0] ?? { cells: [] })).toEqual([
      'Ad',
      'Adet',
      'Fiyat',
      'Elma',
      '3',
      '12',
      'Armut',
      '5',
      '8',
    ]);
    // Text rows keep the paragraph as one cell and align the table's pieces on shared columns.
    const rows = textRows(layout, []);
    expect(rows[0]?.cells).toEqual([[0, 'Bu satir tek basina bir paragraf.']]);
    expect(rows[1]?.cells.map(([column]) => column)).toEqual([0, 1, 2]);
  });

  it('finds a vector drawing as a figure outside the table and renders it as a PNG', async () => {
    // A filled circle of radius 40 centred at (200, 150) from the bottom, drawn with curves.
    const k = 0.5523 * 40;
    const circle = [
      '0.2 0.4 0.8 rg',
      '240 150 m',
      `240 ${150 + k} ${200 + k} 190 200 190 c`,
      `${200 - k} 190 160 ${150 + k} 160 150 c`,
      `160 ${150 - k} ${200 - k} 110 200 110 c`,
      `${200 + k} 110 240 ${150 - k} 240 150 c f`,
    ].join('\n');
    const bytes = await fixturePage(
      [{ text: 'Tablo', x: 50, y: 450, size: 10 }],
      `${gridOperators([50, 150], [440, 420])}\n${circle}`,
    );
    const { layout, png } = await layoutOf(bytes);
    const tables = findTables(layout);
    const figures = findFigures(
      layout,
      tables.map((table) => table.box),
    );
    expect(figures).toHaveLength(1);
    const [x0, y0, x1, y1] = figures[0] ?? [0, 0, 0, 0];
    expect([x0, y0, x1, y1].map(Math.round)).toEqual([160, 310, 240, 390]);
    const image = png(figures[0] ?? [0, 0, 0, 0]);
    expect([...image.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('names a font family without its subset tag or style and converts colours', () => {
    expect(fontFamily('ABCDEF+Arial-BoldMT')).toBe('Arial');
    expect(fontFamily('TimesNewRomanPS-ItalicMT')).toBe('TimesNewRomanPS');
    expect(fontFamily('')).toBe('Arial');
    expect(rgb([1, 0.5, 0])).toBe(0xff8000);
    expect(rgb([0.2])).toBe(0x333333);
    expect(rgb([0, 0, 0, 1])).toBe(0x000000);
    expect(rgb([0, 1, 1, 0])).toBe(0xff0000);
    expect(rgb(null)).toBe(0);
  });
});

type Mupdf = Awaited<ReturnType<typeof loadMupdf>>;

/** A 400×500 page whose resources and content the test builds with MuPDF's object model. */
async function builtPage(
  build: (
    mupdf: Mupdf,
    doc: PDFDocument,
  ) => { content: string; xobjects?: Record<string, PDFObject>; shadings?: Record<string, PDFObject> },
): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const { content, xobjects = {}, shadings = {} } = build(mupdf, doc);
  doc.insertPage(
    0,
    doc.addPage([0, 0, 400, 500], 0, { Font: { F1: font }, XObject: xobjects, Shading: shadings }, content),
  );
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

/** An image XObject of `width × height` samples (RGB, grey or 1-bit), optionally with a soft mask. */
function imageObject(
  mupdf: Mupdf,
  doc: PDFDocument,
  spec: { width: number; height: number; samples: number[]; space: 'rgb' | 'gray'; mask?: PDFObject },
): PDFObject {
  const colorSpace = spec.space === 'rgb' ? mupdf.ColorSpace.DeviceRGB : mupdf.ColorSpace.DeviceGray;
  const pixmap = new mupdf.Pixmap(colorSpace, [0, 0, spec.width, spec.height], false);
  pixmap.getPixels().set(spec.samples);
  const image = new mupdf.Image(pixmap);
  const object = doc.addImage(image);
  image.destroy();
  pixmap.destroy();
  if (spec.mask !== undefined) object.put('SMask', spec.mask);
  return object;
}

/** The RGBA samples `png` decodes to, with its size. */
function decoded(
  mupdf: Mupdf,
  png: Uint8Array,
): { width: number; height: number; at: (x: number, y: number) => number[] } {
  const image = new mupdf.Image(png);
  const pixmap = image.toPixmap();
  const [width, height, stride, n] = [
    pixmap.getWidth(),
    pixmap.getHeight(),
    pixmap.getStride(),
    pixmap.getNumberOfComponents(),
  ];
  const samples = pixmap.getPixels().slice();
  image.destroy();
  pixmap.destroy();
  return { width, height, at: (x, y) => [...samples.subarray(y * stride + x * n, y * stride + x * n + n)] };
}

async function imageBlocks(bytes: Uint8Array) {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const layout = readPageLayout(mupdf, doc.loadPage(0), { images: true });
    return {
      mupdf,
      layout,
      images: layout.blocks.flatMap((block) => (block.kind === 'image' ? [block] : [])),
    };
  } finally {
    doc.destroy();
  }
}

describe('pictures in the layout', () => {
  /** A 2×2 picture drawn 40 pt square at (50, 300) from the page's bottom-left corner. */
  const place = 'q 40 0 0 40 50 300 cm /Im Do Q';
  const QUARTERS = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0];

  it('draws a picture without a mask as an opaque PNG in its own box', async () => {
    const bytes = await builtPage((mupdf, doc) => ({
      content: place,
      xobjects: { Im: imageObject(mupdf, doc, { width: 2, height: 2, samples: QUARTERS, space: 'rgb' }) },
    }));
    const { mupdf, images } = await imageBlocks(bytes);
    expect(images).toHaveLength(1);
    expect(images[0]?.box.map(Math.round)).toEqual([50, 160, 90, 200]);
    const picture = decoded(mupdf, images[0]?.png ?? new Uint8Array());
    // Top-left quarter red, top-right green, bottom-left blue, fully opaque.
    expect(picture.at(2, 2)).toEqual([255, 0, 0, 255]);
    expect(picture.at(picture.width - 3, 2)).toEqual([0, 255, 0, 255]);
    expect(picture.at(2, picture.height - 3)).toEqual([0, 0, 255, 255]);
  });

  it('folds a soft mask into the alpha channel, whatever the base colour space and mask size', async () => {
    const cases = [
      {
        name: 'RGB base, same-size mask',
        base: 'rgb' as const,
        samples: QUARTERS,
        mask: [255, 0, 0, 255],
        maskSize: 2,
      },
      {
        name: 'grey base, same-size mask',
        base: 'gray' as const,
        samples: [200, 200, 200, 200],
        mask: [255, 0, 0, 255],
        maskSize: 2,
      },
      {
        name: 'RGB base, mask of another size',
        base: 'rgb' as const,
        samples: QUARTERS,
        mask: [255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255],
        maskSize: 4,
      },
    ];
    for (const spec of cases) {
      const bytes = await builtPage((mupdf, doc) => {
        const mask = imageObject(mupdf, doc, {
          width: spec.maskSize,
          height: spec.maskSize,
          samples: spec.mask,
          space: 'gray',
        });
        return {
          content: place,
          xobjects: {
            Im: imageObject(mupdf, doc, {
              width: 2,
              height: 2,
              samples: spec.samples,
              space: spec.base,
              mask,
            }),
          },
        };
      });
      const { mupdf, images } = await imageBlocks(bytes);
      const picture = decoded(mupdf, images[0]?.png ?? new Uint8Array());
      // Opaque where the mask is 255 (top-left), transparent where it is 0 (top-right).
      const opaque = picture.at(2, 2)[3] ?? -1;
      const clear = picture.at(picture.width - 3, 2)[3] ?? 255;
      if (spec.maskSize === 2) expect([opaque, clear], spec.name).toEqual([255, 0]);
      // A mask of another size is resampled, so its edges are soft rather than exact.
      else expect(opaque - clear, spec.name).toBeGreaterThan(30);
    }
  });

  it('keeps a picture MuPDF cannot decode as a block without pixels', async () => {
    const bytes = await builtPage((_mupdf, doc) => ({
      content: place,
      xobjects: {
        Im: doc.addStream(new Uint8Array([1, 2, 3, 4, 5]), {
          Type: 'XObject',
          Subtype: 'Image',
          Width: 2,
          Height: 2,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 3,
        }),
      },
    }));
    const { images } = await imageBlocks(bytes);
    expect(images.map((image) => [image.png, image.box.map(Math.round)])).toEqual([
      [null, [50, 160, 90, 200]],
    ]);
  });
});

describe('what the page draws, as marks', () => {
  const marksOf = async (bytes: Uint8Array) =>
    (await layoutOf(bytes)).layout.marks.map((mark) => ({ box: mark.box.map(Math.round), seed: mark.seed }));

  it('marks a shading and an image mask as seeds at the place they are painted', async () => {
    const bytes = await builtPage((mupdf, doc) => {
      const shading = doc.addObject({
        ShadingType: 2,
        ColorSpace: 'DeviceRGB',
        Coords: [0, 0, 100, 0],
        BBox: [100, 100, 200, 160],
        Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
      });
      const mask = doc.addStream(new Uint8Array([0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55]), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 8,
        Height: 8,
        ImageMask: true,
        BitsPerComponent: 1,
      });
      void mupdf;
      return {
        content: '/Sh sh\n0 0 1 rg q 60 0 0 60 250 300 cm /Mask Do Q',
        shadings: { Sh: shading },
        xobjects: { Mask: mask },
      };
    });
    expect(await marksOf(bytes)).toEqual([
      { box: [100, 340, 200, 400], seed: true },
      { box: [250, 140, 310, 200], seed: true },
    ]);
  });

  it('reads a closed path through its closing segment: four rules from three line-tos and a close', async () => {
    const bytes = await fixturePage([], '0.5 w 0 G 50 50 m 150 50 l 150 100 l 50 100 l h S');
    const { layout } = await layoutOf(bytes);
    expect(layout.rulings.map((rule) => [rule.x0, rule.y0, rule.x1, rule.y1].map(Math.round))).toEqual([
      [50, 450, 150, 450],
      [150, 400, 150, 450],
      [50, 400, 150, 400],
      [50, 400, 50, 450],
    ]);
  });

  it('treats a closed slanted shape as a drawing', async () => {
    const bytes = await fixturePage([], '0.2 0.4 0.8 rg 100 100 m 200 120 l 150 200 l h f');
    expect(await marksOf(bytes)).toEqual([{ box: [100, 300, 200, 400], seed: true }]);
  });
});

const STROKE = '0.5 w 0 G';
const pieces = (y: number, ...cells: [number, string][]) =>
  cells.map(([x, text]) => ({ text, x, y, size: 10 }));

describe('what the page draws, as rules and figures', () => {
  const rulesOf = async (extra: string) =>
    (await layoutOf(await fixturePage([], extra))).layout.rulings.map((rule) =>
      [rule.x0, rule.y0, rule.x1, rule.y1].map(Math.round),
    );

  it('reads every subpath of one path, and draws nothing for a path that is empty', async () => {
    expect(await rulesOf(`${STROKE} 50 50 m 150 50 l 50 80 m 150 80 l S\nS\nf\nn`)).toEqual([
      [50, 450, 150, 450],
      [50, 420, 150, 420],
    ]);
  });

  it('reads a thin filled rectangle as a rule, whichever way it lies, and ignores a short or thick one', async () => {
    const rules = await rulesOf(
      '0 g 50 100 100 1 re f 200 100 1 80 re f 50 300 100 20 re f 50 200 3 3 re f 300 300 40 40 re f',
    );
    expect(rules).toEqual([
      [50, 400, 150, 400],
      [201, 320, 201, 400],
    ]);
  });

  it('leaves a diagonal stroke out of the rules', async () => {
    expect(await rulesOf(`${STROKE} 50 50 m 150 120 l S`)).toEqual([]);
  });

  it('ignores a fill that covers most of the page and a mark too small to see', async () => {
    const bytes = await fixturePage(
      [],
      '0.9 g 0 0 400 500 re f 0 g 100 100 0.2 0.2 re f 0.2 0.4 0.8 rg 100 100 m 200 120 l 150 200 l h f',
    );
    expect((await layoutOf(bytes)).layout.marks.map((mark) => mark.box.map(Math.round))).toEqual([
      [100, 300, 200, 400],
    ]);
  });

  it('keeps the first font of a run for every character that follows in it', async () => {
    const { layout } = await layoutOf(
      await fixturePage([{ text: 'Aa', x: 50, y: 400, size: 12, bold: true }]),
    );
    const chars = layout.blocks.flatMap((block) =>
      block.kind === 'text' ? block.lines.flatMap((line) => line.chars) : [],
    );
    expect(chars.map((char) => [char.c, char.bold, char.font])).toEqual([
      ['A', true, 'Helvetica'],
      ['a', true, 'Helvetica'],
    ]);
  });

  /** `count` diagonal strokes inside a 100 × 100 region at (100, 100), one mark each. */
  const strokes = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `${100 + (index % 100)} 100 m ${101 + (index % 100)} ${150 + (index % 50)} l S`,
    ).join('\n');

  it('treats a page of thousands of paths as one drawing', async () => {
    const { layout } = await layoutOf(await fixturePage([], `${STROKE}\n${strokes(2001)}`));
    const figures = findFigures(layout, []);
    expect(figures).toHaveLength(1);
    expect((figures[0] ?? []).map(Math.round)).toEqual([100, 301, 200, 400]);
  });

  it('leaves out a drawing of thousands of paths that holds a line of prose, or lies on a table', async () => {
    const prose = 'Bu bir cizimin uzerindeki uzun bir aciklama satiridir ve duzyazidir.';
    const { layout } = await layoutOf(
      await fixturePage([{ text: prose, x: 100, y: 150, size: 4 }], `${STROKE}\n${strokes(2001)}`),
    );
    expect(findFigures(layout, [])).toEqual([]);
    const plain = (await layoutOf(await fixturePage([], `${STROKE}\n${strokes(2001)}`))).layout;
    expect(findFigures(plain, [[0, 0, 400, 500]])).toEqual([]);
  });

  it('leaves out a drawing smaller than an icon and one that fills most of the page', async () => {
    const small = (await layoutOf(await fixturePage([], '0.2 0.4 0.8 rg 100 100 m 110 105 l 105 112 l h f')))
      .layout;
    expect(findFigures(small, [])).toEqual([]);
    const big = (await layoutOf(await fixturePage([], `${STROKE} 10 10 m 390 20 l S 10 490 m 20 10 l S`)))
      .layout;
    expect(findFigures(big, [])).toEqual([]);
  });
});

describe('tables from rules and from spacing, in the cases that are not tables', () => {
  it('joins a rule drawn in touching pieces and one drawn twice a pixel apart into one table', async () => {
    const xs = [50, 150, 250];
    const ys = [400, 370, 340];
    const bytes = await fixturePage(
      [...pieces(380, [58, 'A'], [158, 'B']), ...pieces(350, [58, 'C'], [158, 'D'])],
      [
        STROKE,
        // Horizontal rules: the first in two touching halves, the second doubled.
        `50 ${ys[0]} m 150 ${ys[0]} l S 150 ${ys[0]} m 250 ${ys[0]} l S`,
        `50 ${ys[1]} m 250 ${ys[1]} l S 50 ${(ys[1] ?? 0) + 2.4} m 250 ${(ys[1] ?? 0) + 2.4} l S`,
        `50 ${ys[2]} m 250 ${ys[2]} l S`,
        // Vertical rules: the middle one in two touching halves.
        `${xs[0]} 400 m ${xs[0]} 340 l S`,
        `${xs[1]} 400 m ${xs[1]} 370 l S ${xs[1]} 370 m ${xs[1]} 340 l S`,
        `${xs[2]} 400 m ${xs[2]} 340 l S`,
      ].join('\n'),
    );
    const tables = findTables((await layoutOf(bytes)).layout);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.xs.map(Math.round)).toEqual(xs);
    expect(tables[0]?.ys.map(Math.round)).toEqual([100, 129, 160]);
    expect(cellTexts(tables[0] ?? { cells: [] })).toEqual(['A', 'B', 'C', 'D']);
  });

  it('does not take a frame around one paragraph for a table', async () => {
    const bytes = await fixturePage(
      [{ text: 'Kisa', x: 58, y: 380, size: 10 }],
      gridOperators([50, 150, 250], [400, 360, 320]),
    );
    expect(findTables((await layoutOf(bytes)).layout)).toEqual([]);
  });
});

describe('tables from spacing, in the cases that are not tables', () => {
  const tablesOf = async (lines: Parameters<typeof fixturePage>[0]) =>
    findTextTables((await layoutOf(await fixturePage(lines))).layout, []);

  it('finds none in a single row, in rows of long text, and in rows with one column', async () => {
    expect(await tablesOf(pieces(400, [50, 'Ad'], [170, 'Adet'], [290, 'Fiyat']))).toEqual([]);
    const long = 'Bu hucre bir paragrafin icindeki uzun bir cumledir ve tablo degildir.';
    expect(
      await tablesOf([...pieces(400, [50, long], [250, long]), ...pieces(385, [50, long], [250, long])]),
    ).toEqual([]);
    const twentyOne = (y: number) =>
      pieces(y, ...Array.from({ length: 21 }, (_, index): [number, string] => [10 + index * 18, 'a']));
    expect(await tablesOf([...twentyOne(400), ...twentyOne(388)])).toEqual([]);
  });

  it('moves a piece whose left edge snaps to the column of the piece before it into the next column', async () => {
    // At 4 pt a gap between pieces is only 4.8 pt, so `i` and `j` start 8 pt apart: one
    // column anchor, two pieces.
    const small = [
      { text: 'i', x: 50, y: 400, size: 4 },
      { text: 'j', x: 58, y: 400, size: 4 },
    ];
    const rows = textRows((await layoutOf(await fixturePage(small))).layout, []);
    expect(rows.map((row) => row.cells)).toEqual([
      [
        [0, 'i'],
        [1, 'j'],
      ],
    ]);
  });

  /** Rows whose pieces share one wide piece's column: its neighbours are bridged into it. */
  const bridged = [
    ...pieces(400, [50, 'ab'], [80, 'cd']),
    ...pieces(388, [50, 'ef'], [80, 'gh']),
    ...pieces(376, [50, 'a wide piece of text'], [200, 'zz']),
  ];

  it('finds none when only one row has two filled columns', async () => {
    expect(await tablesOf(bridged)).toEqual([]);
  });

  it('puts two pieces that fall in one column into the next free column of the row', async () => {
    const rows = textRows((await layoutOf(await fixturePage(bridged))).layout, []);
    expect(rows.map((row) => row.cells.map(([column, text]) => [column, text]))).toEqual([
      [
        [0, 'ab'],
        [1, 'cd'],
      ],
      [
        [0, 'ef'],
        [1, 'gh'],
      ],
      [
        [0, 'a wide piece of text'],
        [2, 'zz'],
      ],
    ]);
  });
});
