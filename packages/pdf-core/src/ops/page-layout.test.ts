/**
 * The layout reader the Office export stands on, on pages built in the test: text with its
 * size and weight in top-left coordinates, ruled tables with their merged cells, tables
 * read from spacing alone, vector drawings found as figures and rendered as a picture.
 * A wrong cell box or a missed rule moves a table's text into the wrong cell.
 */

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
