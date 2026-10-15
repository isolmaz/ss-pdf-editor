/**
 * The export reads its own output back with independent readers (mammoth for the DOCX, the
 * RFC 4180 parser for the CSV) and takes a picture from MuPDF's drawing of it. The real
 * readers agree with the writer, so these tests wrap them at their module seams: the bytes
 * are real, but the reader fails, miscounts, or cannot draw. The export must then refuse to
 * hand back a file it could not confirm (`verification-failed`), and leave out a picture that
 * could not be drawn instead of writing a broken one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { circle, line, officeDocument, picture } from './export-office-fixtures';

const state: {
  mammoth: 'real' | 'throw' | 'throw-text' | 'short';
  csvRows: number | null;
  dropPng: boolean;
  /** What the XML reader is handed instead of a worksheet or workbook part: the part as written, or one damaged. */
  xlsx:
    | 'real'
    | 'drop-cell'
    | 'shift-cell'
    | 'wrong-number'
    | 'no-number'
    | 'other-text'
    | 'broken'
    | 'renamed'
    | 'merge-added'
    | 'merge-changed';
  /** What the XLSX package is written as: as it is, or without a part, with an empty one, or not a ZIP at all. */
  workbook: 'real' | 'garbage' | 'no-workbook' | 'no-sheet' | 'empty-part';
} = {
  mammoth: 'real',
  csvRows: null,
  dropPng: false,
  xlsx: 'real',
  workbook: 'real',
};

vi.mock('@xmldom/xmldom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xmldom/xmldom')>();
  class DOMParser extends actual.DOMParser {
    override parseFromString(source: string, mimeType?: string) {
      let text = source;
      if (text.includes('<sheetData>')) {
        if (state.xlsx === 'drop-cell') text = text.replace(/<c [^>]*>.*?<\/c>/, '');
        else if (state.xlsx === 'shift-cell') text = text.replace('r="A1"', 'r="B1"');
        else if (state.xlsx === 'wrong-number') text = text.replace(/<v>[^<]*<\/v>/, '<v>999</v>');
        else if (state.xlsx === 'no-number') text = text.replace(/<v>[^<]*<\/v>/, '');
        else if (state.xlsx === 'other-text') text = text.replace('two words', 'two other');
        else if (state.xlsx === 'broken') text = text.replace('</sheetData>', '</sheetDat>');
        else if (state.xlsx === 'merge-added') {
          text = text.replace(
            '</worksheet>',
            '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>',
          );
        } else if (state.xlsx === 'merge-changed') text = text.replace('A1:B1', 'A1:C1');
      } else if (text.includes('<sheets>') && state.xlsx === 'renamed') {
        text = text.replace(/ name="[^"]*"/, ' name="Other"');
      }
      return super.parseFromString(text, mimeType);
    }
  }
  return { ...actual, DOMParser };
});

/** The parts a damaged package leaves out. */
const LEFT_OUT = { 'no-workbook': 'xl/workbook.xml', 'no-sheet': 'xl/worksheets/sheet1.xml' } as const;

vi.mock('./docx-drawing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./docx-drawing')>();
  return {
    ...actual,
    zipped: (files: Readonly<Record<string, string | Uint8Array>>) => {
      if (state.workbook === 'garbage') return Promise.resolve(new Uint8Array([1, 2, 3]));
      const kept = Object.entries(files)
        .filter(([name]) => name !== LEFT_OUT[state.workbook as keyof typeof LEFT_OUT])
        .map(([name, data]): [string, string | Uint8Array] => [
          name,
          state.workbook === 'empty-part' && name === 'docProps/core.xml' ? ' ' : data,
        ]);
      return actual.zipped(Object.fromEntries(kept));
    },
  };
});

vi.mock('mammoth', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('mammoth') }>();
  const extractRawText: (typeof actual.default)['extractRawText'] = async (input) => {
    if (state.mammoth === 'throw') throw new Error('the reader broke');
    if (state.mammoth === 'throw-text') throw 'plain text failure';
    if (state.mammoth === 'short') return { value: 'one', messages: [] };
    return actual.default.extractRawText(input);
  };
  return { ...actual, default: { ...actual.default, extractRawText } };
});

vi.mock('./convert-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./convert-text')>();
  return {
    ...actual,
    parseCsv: (text: string, delimiter: string) => {
      const rows = actual.parseCsv(text, delimiter);
      return state.csvRows === null ? rows : rows.slice(0, state.csvRows);
    },
  };
});

vi.mock('./page-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./page-layout')>();
  return {
    ...actual,
    readPageLayout: (...args: Parameters<typeof actual.readPageLayout>) => {
      const layout = actual.readPageLayout(...args);
      if (!state.dropPng) return layout;
      return {
        ...layout,
        blocks: layout.blocks.map((block) => (block.kind === 'image' ? { ...block, png: null } : block)),
      };
    },
  };
});

const { exportOffice } = await import('./export-office');
const run = { signal: new AbortController().signal };

afterEach(() => {
  state.mammoth = 'real';
  state.csvRows = null;
  state.dropPng = false;
  state.xlsx = 'real';
  state.workbook = 'real';
});

const page = () => officeDocument([{ content: line('courier', 10, 50, 470, 'two words') }]);

describe('exportOffice read-back and picture faults', () => {
  it('refuses a DOCX whose independent reader fails, naming the reader error', async () => {
    state.mammoth = 'throw';
    await expect(
      exportOffice(await page(), { pages: [0], baseName: 'a.pdf', format: 'docx' }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      message: expect.stringContaining('docx read-back failed: the reader broke'),
    });
    state.mammoth = 'throw-text';
    await expect(
      exportOffice(await page(), { pages: [0], baseName: 'a.pdf', format: 'docx' }, run),
    ).rejects.toMatchObject({
      message: expect.stringContaining('docx read-back failed: plain text failure'),
    });
  });

  it('refuses a DOCX whose reader finds other words than were written', async () => {
    state.mammoth = 'short';
    await expect(
      exportOffice(await page(), { pages: [0], baseName: 'a.pdf', format: 'docx' }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      message: expect.stringContaining('docx read-back found 1 words, 2 were written'),
    });
  });

  it('refuses a CSV whose reader finds other rows than were written', async () => {
    state.csvRows = 0;
    await expect(
      exportOffice(await page(), { pages: [0], baseName: 'a.pdf', format: 'csv' }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      message: expect.stringContaining('csv read-back found 0 rows, 1 were written'),
    });
  });

  it('reads an XLSX back before offering it: the real reader agrees, so the step is reported', async () => {
    const { steps, file } = await exportOffice(
      await page(),
      { pages: [0], baseName: 'a.pdf', format: 'xlsx' },
      run,
    );
    expect(steps).toEqual(['office.read', 'office.tables', 'office.write', 'verify']);
    expect(file.name).toBe('a.xlsx');
  });

  it.each([
    ['drop-cell', 'xlsx read-back found 0 cells in sheet 1, 1 were written'],
    ['shift-cell', 'xlsx read-back found cell B1 in sheet 1 where A1 was written'],
    ['broken', 'xlsx read-back could not read xl/worksheets/sheet1.xml'],
    ['other-text', 'xlsx read-back found other text in A1 of sheet 1 than was written'],
    ['renamed', 'xlsx read-back found the sheets [Other], [Page 1] were written'],
    ['merge-added', 'xlsx read-back found the merged ranges [A1:B1] in sheet 1, [] were written'],
  ] as const)('refuses an XLSX whose reader finds a damaged sheet (%s)', async (damage, message) => {
    state.xlsx = damage;
    await expect(
      exportOffice(await page(), { pages: [0], baseName: 'a.pdf', format: 'xlsx' }, run),
    ).rejects.toMatchObject({ code: 'verification-failed', message: expect.stringContaining(message) });
  });

  it.each([
    ['garbage', 'xlsx read-back could not open the package: Error: '],
    ['no-workbook', 'xlsx read-back found no xl/workbook.xml'],
    ['no-sheet', 'xlsx read-back found no xl/worksheets/sheet1.xml'],
    ['empty-part', 'xlsx read-back could not read docProps/core.xml: empty XML'],
  ] as const)('refuses an XLSX package that is damaged as a package (%s)', async (damage, message) => {
    state.workbook = damage;
    await expect(
      exportOffice(await page(), { pages: [0], baseName: 'a.pdf', format: 'xlsx' }, run),
    ).rejects.toMatchObject({ code: 'verification-failed', message: expect.stringContaining(message) });
  });

  it('refuses an XLSX whose reader finds a number cell with no value, and one with other merged ranges', async () => {
    state.xlsx = 'no-number';
    const numbers = await officeDocument([{ content: line('courier', 10, 50, 470, '12,5') }]);
    await expect(
      exportOffice(numbers, { pages: [0], baseName: 'a.pdf', format: 'xlsx' }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      message: expect.stringContaining('xlsx read-back found no number in A1 of sheet 1, 12.5 was written'),
    });
    // A ruled table of 3 × 3 cells with two merges, A1:B1 and C2:C3 (the first table of `twoTablesPage`).
    const rules = [
      '0.5 w 0 G',
      '50 450 m 350 450 l S',
      '50 420 m 350 420 l S',
      '50 390 m 250 390 l S',
      '50 360 m 350 360 l S',
      '50 450 m 50 360 l S',
      '150 420 m 150 360 l S',
      '250 450 m 250 360 l S',
      '350 450 m 350 360 l S',
    ].join('\n');
    const merged = await officeDocument([
      {
        content: [
          line('courier', 10, 58, 430, 'Toplam'),
          line('courier', 10, 258, 430, 'Fiyat'),
          line('courier', 10, 58, 400, 'Elma'),
          line('courier', 10, 158, 400, '3'),
          line('courier', 10, 258, 400, '12,5'),
          line('courier', 10, 58, 370, 'Cay'),
          rules,
        ].join('\n'),
      },
    ]);
    state.xlsx = 'real';
    const real = await exportOffice(merged, { pages: [0], baseName: 'a.pdf', format: 'xlsx' }, run);
    expect(real.steps).toContain('verify');
    state.xlsx = 'merge-changed';
    await expect(
      exportOffice(merged, { pages: [0], baseName: 'a.pdf', format: 'xlsx' }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      message: expect.stringContaining(
        'xlsx read-back found the merged ranges [A1:C1, C2:C3] in sheet 1, [A1:B1, C2:C3] were written',
      ),
    });
  });

  it('refuses an XLSX whose reader finds another number than was written', async () => {
    state.xlsx = 'wrong-number';
    const bytes = await officeDocument([{ content: line('courier', 10, 50, 470, '12,5') }]);
    await expect(
      exportOffice(bytes, { pages: [0], baseName: 'a.pdf', format: 'xlsx' }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      message: expect.stringContaining('xlsx read-back found 999 in A1 of sheet 1, 12.5 was written'),
    });
  });

  it('leaves out a picture that MuPDF could not draw, drawing or not, and says so', async () => {
    state.dropPng = true;
    const bytes = await officeDocument([
      {
        images: { Im1: { width: 2, height: 2, rgb: [1, 2, 3] } },
        content: [
          line('courier', 10, 50, 470, 'text'),
          picture('Im1', 300, 420, 20, 20),
          circle(200, 200, 5),
        ].join('\n'),
      },
    ]);
    const { file, notes } = await exportOffice(bytes, { pages: [0], baseName: 'a.pdf', format: 'docx' }, run);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(file.bytes);
    expect((await zip.file('word/document.xml')?.async('string')) ?? '').not.toContain('<w:drawing>');
    expect(notes.map((entry) => entry.key)).not.toContain('op.note.exportOffice.pictures');
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.picturesLost')).toMatchObject({
      kind: 'lost',
      params: { count: 1 },
    });
  });
});
