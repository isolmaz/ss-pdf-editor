/**
 * PDF → Word / Excel / CSV on a page built in the test (heading, paragraphs, a ruled
 * table), unzipped and read with independent readers. The wrong answers that matter:
 * text out of reading order, a table that comes out as loose paragraphs, a heading that
 * is not a heading, a number written as text (or `007` as a number), a CSV that an
 * RFC 4180 reader splits differently from what was written, and a page with no text
 * reported as a success.
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { docxToHtml, xlsxToHtml } from './convert-ooxml';
import { parseCsv } from './convert-text';
import { cellNumber, exportOffice, wordFontName } from './export-office';
import { fixturePage, gridOperators, reportPage, TABLE_ROWS, TABLE_XS, TABLE_YS } from './layout-fixtures';

const run = { signal: new AbortController().signal };
const options = { pages: [0], baseName: 'rapor.pdf' } as const;

/** The paragraphs of `word/document.xml`: the text of each `w:p`, empty ones dropped. */
async function paragraphs(bytes: Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await (zip.file('word/document.xml')?.async('string') ?? Promise.resolve(''));
  return xml
    .split('</w:p>')
    .map((part) =>
      [...part.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
        .map((match) => match[1] ?? '')
        .join('')
        .replace(/&amp;/g, '&'),
    )
    .filter((text) => text !== '');
}

describe('exportOffice', () => {
  it('exports DOCX with the text in reading order, a real heading and a real table', async () => {
    const { file, notes } = await exportOffice(await reportPage(), { ...options, format: 'docx' }, run);
    expect(file.name).toBe('rapor.docx');
    expect(await paragraphs(file.bytes)).toEqual([
      'Üretim Raporu',
      'Bu bir paragraf metnidir.',
      ...TABLE_ROWS.flat(),
      'Tablo sonrasi metin.',
    ]);
    const zip = await JSZip.loadAsync(file.bytes);
    const document = (await zip.file('word/document.xml')?.async('string')) ?? '';
    expect(document).toMatch(/<w:pStyle w:val="Heading1"\/>[\s\S]*Üretim Raporu/);
    expect(document.match(/<w:tbl>/g)).toHaveLength(1);
    expect(document.match(/<w:tr[ >]/g)).toHaveLength(3);
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.tables')?.params).toMatchObject({
      count: 1,
    });
    // An independent reader (mammoth, through the converter) sees the same table.
    const html = (await docxToHtml(file.bytes, 'rapor.docx')).parts[0]?.html ?? '';
    expect(html).toContain('<td><p>Ürün</p></td><td><p>Adet</p></td><td><p>Fiyat</p></td>');
    expect(html).toContain('<td><p>Çay</p></td><td><p>5</p></td><td><p>8</p></td>');
  });

  it('exports XLSX with the ruled table as one sheet and numbers as numbers', async () => {
    const { file, notes } = await exportOffice(await reportPage(), { ...options, format: 'xlsx' }, run);
    expect(file.name).toBe('rapor.xlsx');
    const zip = await JSZip.loadAsync(file.bytes);
    const sheet = (await zip.file('xl/worksheets/sheet1.xml')?.async('string')) ?? '';
    // `12,5` is a number (12.5) and `3` is 3; `Adet` stays text.
    expect(sheet).toContain('<c r="B2"><v>3</v></c><c r="C2"><v>12.5</v></c>');
    expect(sheet).toContain('<t xml:space="preserve">Adet</t>');
    const html = (await xlsxToHtml(file.bytes, 'rapor.xlsx')).parts[0]?.html ?? '';
    expect(html).toBe(
      '<h2>Table 1</h2><table class="sheet">' +
        '<tr><td>Ürün</td><td>Adet</td><td>Fiyat</td></tr>' +
        '<tr><td>Elma</td><td class="n">3</td><td class="n">12.5</td></tr>' +
        '<tr><td>Çay</td><td class="n">5</td><td class="n">8</td></tr></table>',
    );
    // The heading and paragraphs outside the table are not in a cell, and the report says so.
    expect(notes.map((entry) => entry.key)).toContain('op.note.exportOffice.outsideText');
  });

  it('exports CSV with a BOM, the chosen separator and quoting that an RFC 4180 reader undoes', async () => {
    const semicolon = await exportOffice(
      await reportPage(),
      { ...options, format: 'csv', csvDelimiter: ';' },
      run,
    );
    expect(semicolon.file.name).toBe('rapor.csv');
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(semicolon.file.bytes);
    expect([...semicolon.file.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toBe('﻿Ürün;Adet;Fiyat\r\nElma;3;12,5\r\nÇay;5;8\r\n');
    expect(parseCsv(text.slice(1), ';').slice(0, 3)).toEqual(TABLE_ROWS.map((row) => [...row]));
    // With a comma separator the decimal comma must be quoted, not split into two cells.
    const comma = await exportOffice(
      await reportPage(),
      { ...options, format: 'csv', csvDelimiter: ',' },
      run,
    );
    const commaText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(comma.file.bytes);
    expect(commaText).toBe('﻿Ürün,Adet,Fiyat\r\nElma,3,"12,5"\r\nÇay,5,8\r\n');
    expect(parseCsv(commaText.slice(1), ',')[1]).toEqual(['Elma', '3', '12,5']);
  });

  it('opens a cell a spreadsheet would run as a formula as text, and leaves negative numbers alone', async () => {
    const rows = [
      ['Ad', 'Hücre', 'Fark'],
      ['A', '=1+2', '-7'],
      ['B', '@SUM(A1)', '+5'],
    ];
    const page = await fixturePage(
      rows.flatMap((row, rowIndex) =>
        row.map((text, column) => ({
          text,
          x: (TABLE_XS[column] ?? 0) + 8,
          y: (TABLE_YS[rowIndex] ?? 0) - 20,
          size: 10,
        })),
      ),
      gridOperators(TABLE_XS, TABLE_YS),
    );
    const { file, notes } = await exportOffice(page, { ...options, format: 'csv', csvDelimiter: ';' }, run);
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.bytes);
    expect(text).toBe("\uFEFFAd;Hücre;Fark\r\nA;'=1+2;-7\r\nB;'@SUM(A1);'+5\r\n");
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.csvFormulas')?.params).toMatchObject({
      count: 3,
    });
  });

  it('reads a numeral as a number only when it reads one way', () => {
    expect(cellNumber('12,5')).toBe(12.5);
    expect(cellNumber('1.234,5')).toBe(1234.5);
    expect(cellNumber('1,234.5')).toBe(1234.5);
    expect(cellNumber('-7')).toBe(-7);
    // A thousand in one locale and a fraction in the other: left as text.
    expect(cellNumber('1.234')).toBeNull();
    expect(cellNumber('1,234')).toBeNull();
    // Identifiers and non-numbers stay text.
    expect(cellNumber('007')).toBeNull();
    expect(cellNumber('1234567890123456')).toBeNull();
    expect(cellNumber('12a')).toBeNull();
    expect(cellNumber('+5')).toBeNull();
  });

  it('refuses an empty page selection and reports a page with no text instead of a success with nothing', async () => {
    await expect(
      exportOffice(await reportPage(), { ...options, pages: [], format: 'docx' }, run),
    ).rejects.toMatchObject({
      code: 'selection-empty',
    });
    const blank = await fixturePage([]);
    await expect(exportOffice(blank, { ...options, format: 'xlsx' }, run)).rejects.toMatchObject({
      code: 'no-text',
    });
    const docx = await exportOffice(blank, { ...options, format: 'docx' }, run);
    expect(docx.notes.find((entry) => entry.key === 'op.note.exportOffice.noText')?.params).toMatchObject({
      pages: '1',
    });
  });

  it('names common PDF families as Word knows them', () => {
    expect(wordFontName('Helvetica')).toBe('Arial');
    expect(wordFontName('NimbusRoman')).toBe('Times New Roman');
    expect(wordFontName('Calibri')).toBe('Calibri');
  });
});
