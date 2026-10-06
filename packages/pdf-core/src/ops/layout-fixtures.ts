/**
 * Pages built in a test for the layout reader and the Office export
 * (`page-layout.test.ts`, `export-office.test.ts`): standard-14 fonts, so no font asset
 * is needed, and strokes for the table rules.
 */

import { loadMupdf } from '../engines/mupdf';

/** One text line: its baseline from the page's bottom edge, its font and size. */
export interface FixtureText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly bold?: boolean;
}

const escapePdf = (value: string): string => value.replace(/[\\()]/g, (character) => `\\${character}`);

/** `BT … ET` for the lines, in WinAnsi (`\\xNN` for Latin-1 letters such as Ü). */
function textOperators(lines: readonly FixtureText[]): string {
  return lines
    .map((line) => {
      const spelled = [...escapePdf(line.text)]
        .map((character) => {
          const code = character.charCodeAt(0);
          return code > 127 ? `\\${code.toString(8).padStart(3, '0')}` : character;
        })
        .join('');
      return `BT /${line.bold === true ? 'F2' : 'F1'} ${line.size} Tf ${line.x} ${line.y} Td (${spelled}) Tj ET`;
    })
    .join('\n');
}

/** Ruling lines of a grid: `xs` columns by `ys` rows, 0.5 pt strokes. */
export function gridOperators(xs: readonly number[], ys: readonly number[]): string {
  const first = xs[0] ?? 0;
  const last = xs[xs.length - 1] ?? 0;
  const top = ys[0] ?? 0;
  const bottom = ys[ys.length - 1] ?? 0;
  return [
    '0.5 w 0 G',
    ...ys.map((y) => `${first} ${y} m ${last} ${y} l S`),
    ...xs.map((x) => `${x} ${top} m ${x} ${bottom} l S`),
  ].join('\n');
}

/** A 400×500 page from text lines and extra content operators. */
export async function fixturePage(lines: readonly FixtureText[], extra = ''): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const regular = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const bold = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica-Bold',
    Encoding: 'WinAnsiEncoding',
  });
  doc.insertPage(
    0,
    doc.addPage(
      [0, 0, 400, 500],
      0,
      { Font: { F1: regular, F2: bold } },
      `${extra}\n${textOperators(lines)}`,
    ),
  );
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

export const TABLE_XS = [50, 150, 250, 350] as const;
export const TABLE_YS = [380, 350, 320, 290] as const;
export const TABLE_ROWS = [
  ['Ürün', 'Adet', 'Fiyat'],
  ['Elma', '3', '12,5'],
  ['Çay', '5', '8'],
] as const;

/** A heading, a paragraph, a ruled 3×3 table and a closing paragraph. */
export function reportPage(): Promise<Uint8Array> {
  const cells: FixtureText[] = TABLE_ROWS.flatMap((row, rowIndex) =>
    row.map((text, column) => ({
      text,
      x: (TABLE_XS[column] ?? 0) + 8,
      y: (TABLE_YS[rowIndex] ?? 0) - 20,
      size: 10,
    })),
  );
  return fixturePage(
    [
      { text: 'Üretim Raporu', x: 50, y: 450, size: 24, bold: true },
      { text: 'Bu bir paragraf metnidir.', x: 50, y: 425, size: 11 },
      ...cells,
      { text: 'Tablo sonrasi metin.', x: 50, y: 250, size: 11 },
    ],
    gridOperators(TABLE_XS, TABLE_YS),
  );
}
