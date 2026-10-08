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
import { circle, line, officeDocument, picture } from './export-office-fixtures';
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

/** `word/document.xml` of a DOCX. */
async function documentXml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return (await zip.file('word/document.xml')?.async('string')) ?? '';
}

/** The children of `w:body`, in order: paragraphs, tables and the closing `w:sectPr`. */
function bodyBlocks(document: string): string[] {
  const body = document.slice(document.indexOf('<w:body>') + 8, document.indexOf('</w:body>'));
  return (
    body.match(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p>[\s\S]*?<\/w:p>|<w:p\/>|<w:sectPr>[\s\S]*?<\/w:sectPr>/g) ?? []
  );
}

/** A paragraph block as its `w:pPr` content and the text of its runs. */
function paragraphOf(block: string): { props: string; text: string; runs: string[] } {
  const runs = [...block.matchAll(/<w:r>([\s\S]*?)<\/w:r>/g)].map((match) => match[1] ?? '');
  return {
    props: /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(block)?.[1] ?? '',
    text: runs
      .map((run) => [...run.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1] ?? '').join(''))
      .join(''),
    runs,
  };
}

/** The paragraphs of a DOCX body as `[properties, text]`, tables and the section left out. */
async function paragraphProps(bytes: Uint8Array): Promise<[string, string][]> {
  return bodyBlocks(await documentXml(bytes))
    .filter((block) => block.startsWith('<w:p>'))
    .map((block) => {
      const { props, text } = paragraphOf(block);
      return [props, text];
    });
}

interface DocxCell {
  readonly props: string;
  /** Each paragraph of the cell as `[w:pPr content, text]`; `<w:p/>` is `['', '']`. */
  readonly paragraphs: [string, string][];
}

/** A table block as rows of cells. */
function tableRows(table: string): DocxCell[][] {
  return (table.match(/<w:tr>[\s\S]*?<\/w:tr>/g) ?? []).map((row) =>
    (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((cell) => ({
      props: /<w:tcPr>([\s\S]*?)<\/w:tcPr>/.exec(cell)?.[1] ?? '',
      paragraphs: (cell.match(/<w:p>[\s\S]*?<\/w:p>|<w:p\/>/g) ?? []).map((block) => {
        const { props, text } = paragraphOf(block);
        return [props, text];
      }),
    })),
  );
}

const courier = (x: number, y: number, text: string): string => line('courier', 10, x, y, text);
const docxOptions = { pages: [0], baseName: 'a.pdf', format: 'docx' } as const;

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
    const read = (text: string): number | null => cellNumber(text);
    expect(
      [
        '42',
        ' 42 ',
        '0',
        '-7',
        '12,5',
        '0.5',
        '-0,25',
        '1234.567',
        '1.234,5',
        '1,234.5',
        '1.234.567',
        '1,234,567',
      ].map(read),
    ).toEqual([42, 42, 0, -7, 12.5, 0.5, -0.25, 1234.567, 1234.5, 1234.5, 1234567, 1234567]);
    // A thousand in one locale and a fraction in the other: left as text.
    expect(['1.234', '1,234', '12.345', '0,001'].map(read)).toEqual([null, null, null, null]);
    // Identifiers and other non-numbers stay text: leading zeros, a sign other than `-`, letters,
    // more than fifteen digits, spaces inside, marks without digits or with an empty part.
    expect(
      [
        '007',
        '00.5',
        '+5',
        '12a',
        '1234567890123456',
        '1 234',
        '',
        '-',
        '-.',
        ',',
        '1.',
        '.5',
        '1..2',
        '1.23.4',
      ].map(read),
    ).toEqual(Array.from({ length: 14 }, () => null));
    // Both marks: the later is the decimal one and the other must group thousands in threes.
    expect(['1.234,', '1,234.', '12.34,5', '1,2.3,4', '1.2,3.4', '1.5,2.5'].map(read)).toEqual(
      Array.from({ length: 6 }, () => null),
    );
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

  it('answers the families Word does not ship with the standard font of their kind', () => {
    for (const sans of ['HelveticaWorld', 'HelveticaNeueLTStd', 'Univers', 'MyriadPro', 'Frutiger']) {
      expect(wordFontName(sans)).toBe('Arial');
    }
    for (const serif of ['MinionPro', 'Garamond', 'PalatinoLinotype', 'TimesTen']) {
      expect(wordFontName(serif)).toBe('Times New Roman');
    }
    expect(wordFontName('CourierStd')).toBe('Courier New');
    for (const kept of ['SegoeUI', 'TrebuchetMS', 'CalibriLight', 'NotoSans', 'Verdana']) {
      expect(wordFontName(kept, { serif: true, mono: false })).toBe(kept.replace(/([a-z])([A-Z])/g, '$1 $2'));
    }
  });

  it('falls back to the class of an unknown family, and only when told the class', () => {
    expect(wordFontName('Mystery')).toBe('Mystery');
    expect(wordFontName('Mystery', { serif: false, mono: false })).toBe('Arial');
    expect(wordFontName('Mystery', { serif: true, mono: false })).toBe('Times New Roman');
    expect(wordFontName('Mystery', { serif: true, mono: true })).toBe('Courier New');
    // A table entry beats the class.
    expect(wordFontName('HelveticaWorld', { serif: true, mono: false })).toBe('Arial');
  });
});

describe('exportOffice → DOCX paragraphs', () => {
  it('measures alignment, justification and indents from the lines of each paragraph', async () => {
    const bytes = await officeDocument([
      {
        content: [
          // The anchor sets the text column: 50 → 350.
          courier(50, 470, 'W'.repeat(50)),
          courier(140, 440, 'C'.repeat(20)),
          courier(230, 410, 'R'.repeat(20)),
          // Two full lines and a short one: justified.
          courier(50, 370, 'J'.repeat(50)),
          courier(50, 358, 'K'.repeat(50)),
          courier(50, 346, 'tail'),
          // The first line starts 12 pt in: a first-line indent.
          courier(62, 300, 'I'.repeat(30)),
          courier(50, 288, 'i'.repeat(30)),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    expect(await paragraphProps(file.bytes)).toEqual([
      ['<w:spacing w:before="0" w:after="0"/>', 'W'.repeat(50)],
      ['<w:spacing w:before="350" w:after="0"/><w:jc w:val="center"/>', 'C'.repeat(20)],
      ['<w:spacing w:before="350" w:after="0"/><w:jc w:val="right"/>', 'R'.repeat(20)],
      [
        '<w:spacing w:before="550" w:after="0" w:line="240" w:lineRule="atLeast"/><w:jc w:val="both"/>',
        `${'J'.repeat(50)} ${'K'.repeat(50)} tail`,
      ],
      [
        '<w:spacing w:before="670" w:after="0" w:line="240" w:lineRule="atLeast"/><w:ind w:firstLine="240"/>',
        `${'I'.repeat(30)} ${'i'.repeat(30)}`,
      ],
    ]);
  });

  it('joins a word broken by a hyphen, whatever style the hyphen is set in', async () => {
    const lead = courier(50, 470, 'J'.repeat(50));
    const stem = 'k'.repeat(44);
    /** Three lines whose last two end near the right edge: one paragraph. */
    const wrapped = (second: string, third: string, extra = ''): string =>
      [lead, courier(50, 458, second), extra, courier(50, 446, third)].join('\n');
    const bytes = await officeDocument([
      // A bold hyphen after regular letters.
      { content: wrapped(`${stem}inter`, 'national', line('courierBold', 10, 50 + 49 * 6, 458, '-')) },
      // A hyphen in the letters' own style.
      { content: wrapped(`${stem}inter-`, 'national') },
      // A soft hyphen, here U+00AD through the font's ToUnicode map.
      {
        content: [
          lead,
          line('courierMapped', 10, 50, 458, `${stem}inter\u0003`),
          courier(50, 446, 'national'),
        ].join('\n'),
      },
      // The next line starts upper-case: a dash between two words, kept.
      { content: wrapped(`${stem}inter-`, 'National') },
      // A hyphen that does not follow a letter is kept.
      { content: wrapped(`${'k'.repeat(43)}ab12-`, 'national') },
    ]);
    const { file } = await exportOffice(bytes, { ...docxOptions, pages: [0, 1, 2, 3, 4] }, run);
    const joined = `${'J'.repeat(50)} ${stem}international`;
    expect((await paragraphProps(file.bytes)).map(([, text]) => text)).toEqual([
      joined,
      joined,
      joined,
      `${'J'.repeat(50)} ${stem}inter- National`,
      `${'J'.repeat(50)} ${'k'.repeat(43)}ab12- national`,
    ]);
  });

  it('starts a paragraph at a bullet and at a numbered line, not at a decimal or a year', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(50, 470, '\u2022 first bullet'),
          courier(50, 458, '2. numbered'),
          courier(50, 446, '12) twelve'),
          courier(50, 434, '2.5 kg tall'),
          courier(50, 422, '1990. years'),
          courier(50, 410, '\u2013 a dash'),
          courier(50, 398, '* a star'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    expect((await paragraphProps(file.bytes)).map(([, text]) => text)).toEqual([
      '\u2022 first bullet',
      '2. numbered',
      '12) twelve 2.5 kg tall 1990. years',
      '\u2013 a dash',
      '* a star',
    ]);
  });

  it('turns the larger or bold-and-larger paragraphs into headings of up to three levels', async () => {
    const bytes = await officeDocument([
      {
        size: [1100, 800],
        content: [
          line('helveticaBold', 24, 20, 770, 'Big'),
          line('helvetica', 18, 20, 740, 'Mid'),
          line('helvetica', 15, 20, 720, 'Small'),
          line('helvetica', 13.5, 20, 700, 'Smaller'),
          // Bold and 20 % larger than the body counts as a heading.
          line('helveticaBold', 12, 20, 680, 'Bold lead'),
          // Four lines at the heading size are a paragraph, not a heading; so are 210 characters.
          ...[0, 1, 2, 3].map((row) => line('helvetica', 24, 20, 600 - row * 30, 'Line')),
          ...[0, 1, 2].map((row) => line('helvetica', 24, 20, 440 - row * 30, 'x'.repeat(70))),
          // The body, 420 characters at 10 pt.
          ...Array.from({ length: 6 }, (_unused, row) => courier(20, 300 - row * 12, 'b'.repeat(70))),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    expect(
      (await paragraphProps(file.bytes)).map(([props, text]) => [
        /w:pStyle w:val="(\w+)"/.exec(props)?.[1] ?? null,
        text.slice(0, 12),
      ]),
    ).toEqual([
      ['Heading1', 'Big'],
      ['Heading2', 'Mid'],
      ['Heading3', 'Small'],
      ['Heading3', 'Smaller'],
      ['Heading3', 'Bold lead'],
      [null, 'Line Line Li'],
      [null, 'xxxxxxxxxxxx'],
      [null, 'bbbbbbbbbbbb'],
    ]);
  });

  it('keeps the font, size, weight, slant and colour of every run, and the document language and title', async () => {
    const bytes = await officeDocument(
      [
        {
          content: [
            courier(50, 470, 'Plain '),
            line('courierBold', 10, 86, 470, 'Bold'),
            line('timesItalic', 10, 110, 470, ' Italic '),
            line('helvetica', 10, 136.1, 470, 'Red', '1 0 0'),
          ].join('\n'),
        },
      ],
      { title: '  Üretim <A&B> ', lang: 'tr-TR' },
    );
    const { file } = await exportOffice(bytes, docxOptions, run);
    const zip = await JSZip.loadAsync(file.bytes);
    const [paragraph] = bodyBlocks(await documentXml(file.bytes)).map(paragraphOf);
    const size = '<w:sz w:val="20"/><w:szCs w:val="20"/>';
    const fonts = (name: string) => `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:cs="${name}"/>`;
    expect(paragraph?.runs).toEqual([
      `<w:rPr>${fonts('Courier New')}${size}</w:rPr><w:t xml:space="preserve">Plain </w:t>`,
      // A space takes the style of the run it follows.
      `<w:rPr>${fonts('Courier New')}<w:b/><w:bCs/>${size}</w:rPr><w:t xml:space="preserve">Bold </w:t>`,
      `<w:rPr>${fonts('Times New Roman')}<w:i/><w:iCs/>${size}</w:rPr><w:t xml:space="preserve">Italic </w:t>`,
      `<w:rPr>${fonts('Arial')}<w:color w:val="FF0000"/>${size}</w:rPr><w:t xml:space="preserve">Red</w:t>`,
    ]);
    expect(await zip.file('docProps/core.xml')?.async('string')).toContain(
      '<dc:title>Üretim &lt;A&amp;B&gt;</dc:title>',
    );
    expect(await zip.file('word/styles.xml')?.async('string')).toContain('<w:lang w:val="tr-TR"/>');
  });

  it('puts the text of a two-column page in its own column: a heading centred over the first, indents measured from each', async () => {
    const bytes = await officeDocument([
      {
        size: [450, 500],
        content: [
          // Centred over the left column (50 → 194), which the right column's lines (250 →) bound.
          line('courierBold', 14, 109.4, 470, 'Hdr'),
          courier(50, 440, 'a'.repeat(24)),
          courier(50, 428, 'b'.repeat(24)),
          courier(50, 416, 'c'.repeat(10)),
          // The right column is set off a little, so its lines are not read as table rows.
          courier(250, 435, 'd'.repeat(24)),
          courier(250, 423, 'e'.repeat(24)),
          courier(250, 411, 'f'.repeat(10)),
          // Neither column: it spans both, and its indent is measured from the page edge.
          courier(170, 300, 'M'.repeat(24)),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    expect(await paragraphProps(file.bytes)).toEqual([
      ['<w:pStyle w:val="Heading1"/><w:spacing w:before="0" w:after="0"/><w:jc w:val="center"/>', 'Hdr'],
      [
        '<w:spacing w:before="304" w:after="0" w:line="240" w:lineRule="atLeast"/><w:jc w:val="both"/>',
        `${'a'.repeat(24)} ${'b'.repeat(24)} ${'c'.repeat(10)}`,
      ],
      [
        '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="atLeast"/><w:jc w:val="both"/>',
        `${'d'.repeat(24)} ${'e'.repeat(24)} ${'f'.repeat(10)}`,
      ],
      ['<w:spacing w:before="960" w:after="0"/><w:ind w:left="2400"/>', 'M'.repeat(24)],
    ]);
  });

  it('centres a paragraph of two lines that are centred on the column, and leaves left, with its indent, one whose lines merely start together', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(50, 470, 'W'.repeat(50)),
          // Centred on 200: 16 and 20 characters.
          courier(152, 440, 'c'.repeat(16)),
          courier(140, 428, 'C'.repeat(20)),
          // Two equal lines, starting together, that happen to be centred.
          courier(140, 380, 'e'.repeat(20)),
          courier(140, 368, 'E'.repeat(20)),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    expect(await paragraphProps(file.bytes)).toEqual([
      ['<w:spacing w:before="0" w:after="0"/>', 'W'.repeat(50)],
      [
        '<w:spacing w:before="350" w:after="0" w:line="240" w:lineRule="atLeast"/><w:jc w:val="center"/>',
        `${'c'.repeat(16)} ${'C'.repeat(20)}`,
      ],
      [
        '<w:spacing w:before="710" w:after="0" w:line="240" w:lineRule="atLeast"/><w:ind w:left="1800"/>',
        `${'e'.repeat(20)} ${'E'.repeat(20)}`,
      ],
    ]);
  });
});

describe('exportOffice → DOCX tables', () => {
  /** A 3 × 3 grid whose first row joins columns 0 and 1 and whose first column joins rows 1 and 2. */
  function mergedGrid(): string {
    return [
      '0.5 w 0 G',
      '50 380 m 350 380 l S',
      '50 350 m 350 350 l S',
      '150 320 m 350 320 l S',
      '50 290 m 350 290 l S',
      '50 380 m 50 290 l S',
      '150 350 m 150 290 l S',
      '250 380 m 250 290 l S',
      '350 380 m 350 290 l S',
    ].join('\n');
  }

  it('writes a ruled table with its merged cells, row heights, alignment, and no indents inside the cells', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(300, 470, 'Heading text'),
          courier(58, 360, 'Toplam'),
          courier(258, 360, 'Fiyat'),
          courier(58, 330, 'Grup'),
          // Centred in the merged cell, in a second paragraph.
          courier(100, 300, 'x'),
          // Flush right in its cell.
          courier(316.5, 330, 'RRRRR'),
          // Two blocks in one cell: the second line 12 pt in.
          courier(158, 308, 'D1'),
          courier(170, 296, 'D2'),
          // Two lines that start a third of the way across the cell.
          courier(290, 308, 'p'),
          courier(290, 296, 'q'),
          courier(50, 250, 'after'),
          mergedGrid(),
        ].join('\n'),
      },
    ]);
    const { file, notes } = await exportOffice(bytes, docxOptions, run);
    const blocks = bodyBlocks(await documentXml(file.bytes));
    const table = blocks.find((block) => block.startsWith('<w:tbl>')) ?? '';
    const sides = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`)
      .join('');
    expect(table.split('<w:tr>')[0]).toBe(
      '<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/>' +
        `<w:tblBorders>${sides}</w:tblBorders><w:tblLayout w:type="fixed"/>` +
        '<w:tblCellMar><w:left w:w="57" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar>' +
        '</w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>',
    );
    expect(table.match(/<w:trHeight w:val="600" w:hRule="atLeast"\/>/g)).toHaveLength(3);
    const plain = '<w:spacing w:before="0" w:after="0"/>';
    const spaced = '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="atLeast"/>';
    expect(tableRows(table)).toEqual([
      [
        { props: '<w:tcW w:w="4000" w:type="dxa"/><w:gridSpan w:val="2"/>', paragraphs: [[plain, 'Toplam']] },
        { props: '<w:tcW w:w="2000" w:type="dxa"/>', paragraphs: [[plain, 'Fiyat']] },
      ],
      [
        {
          props: '<w:tcW w:w="2000" w:type="dxa"/><w:vMerge w:val="restart"/>',
          paragraphs: [
            [plain, 'Grup'],
            [`${plain}<w:jc w:val="center"/>`, 'x'],
          ],
        },
        // Nothing in it: an empty paragraph, as Word wants one.
        { props: '<w:tcW w:w="2000" w:type="dxa"/>', paragraphs: [['', '']] },
        {
          props: '<w:tcW w:w="2000" w:type="dxa"/>',
          paragraphs: [[`${plain}<w:jc w:val="right"/>`, 'RRRRR']],
        },
      ],
      [
        { props: '<w:tcW w:w="2000" w:type="dxa"/><w:vMerge/>', paragraphs: [['', '']] },
        { props: '<w:tcW w:w="2000" w:type="dxa"/>', paragraphs: [[spaced, 'D1 D2']] },
        { props: '<w:tcW w:w="2000" w:type="dxa"/>', paragraphs: [[spaced, 'p q']] },
      ],
    ]);
    // Above the table a spacer of the 48 pt gap (capped), then the table, then the paragraph.
    expect(blocks.map((block) => /^<w:(\w+)/.exec(block)?.[1])).toEqual(['p', 'p', 'tbl', 'p', 'sectPr']);
    expect(blocks[1]).toBe(
      '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="960" w:lineRule="exact"/></w:pPr></w:p>',
    );
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.tables')?.params).toEqual({ count: 1 });
  });

  it('keeps pages as sections: a table cannot carry a break or a section, so a hairline paragraph does', async () => {
    const xs = [50, 150, 250, 350];
    const cells = (ys: readonly number[]): string[] =>
      [
        ['a', 'b', 'c'],
        ['d', 'e', 'f'],
        ['g', 'h', 'i'],
      ].flatMap((row, r) => row.map((text, c) => courier((xs[c] ?? 0) + 8, (ys[r] ?? 0) - 20, text)));
    const first = [200, 170, 140, 110];
    const second = [380, 350, 320, 290];
    const last = [250, 220, 190, 160];
    const bytes = await officeDocument([
      // Ends on a table: the section's properties go on a hairline paragraph after it.
      { content: [courier(50, 470, 'First page'), ...cells(first), gridOperators(xs, first)].join('\n') },
      // Begins with a table, on a landscape page.
      {
        size: [500, 400],
        content: [...cells(second), gridOperators(xs, second), courier(50, 250, 'Landscape tail')].join('\n'),
      },
      // Nothing on it: it stays a page.
      { content: '' },
      // The last page's section is the body's own.
      { content: [courier(50, 470, 'Last page'), ...cells(last), gridOperators(xs, last)].join('\n') },
    ]);
    const { file, notes } = await exportOffice(bytes, { ...docxOptions, pages: [0, 1, 2, 3] }, run);
    const blocks = bodyBlocks(await documentXml(file.bytes)).map((block) =>
      block.startsWith('<w:tbl>') ? 'table' : block,
    );
    const margins = (top: number, right: number, bottom: number, left: number) =>
      `<w:pgMar w:top="${top}" w:right="${right}" w:bottom="${bottom}" w:left="${left}" w:header="0" w:footer="0" w:gutter="0"/>`;
    const portrait = `<w:sectPr><w:pgSz w:w="8000" w:h="10000"/>${margins(414, 1000, 720, 1000)}</w:sectPr>`;
    const spacer = '<w:spacing w:before="0" w:after="0" w:line="960" w:lineRule="exact"/>';
    const hairline = '<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>';
    expect(blocks).toEqual([
      '<w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">First page</w:t></w:r></w:p>',
      `<w:p><w:pPr>${spacer}</w:pPr></w:p>`,
      'table',
      `<w:p><w:pPr>${hairline}${portrait}</w:pPr></w:p>`,
      `<w:p><w:pPr><w:pageBreakBefore/>${hairline}</w:pPr></w:p>`,
      'table',
      `<w:p><w:pPr><w:spacing w:before="614" w:after="0"/><w:sectPr><w:pgSz w:w="10000" w:h="8000" w:orient="landscape"/>${margins(400, 3000, 720, 1000)}</w:sectPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">Landscape tail</w:t></w:r></w:p>`,
      // The empty page: 72 pt margins all round, clamped to Word-sized ones.
      `<w:p><w:pPr><w:pageBreakBefore/><w:sectPr><w:pgSz w:w="8000" w:h="10000"/>${margins(1440, 1440, 720, 1440)}</w:sectPr></w:pPr></w:p>`,
      '<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">Last page</w:t></w:r></w:p>',
      `<w:p><w:pPr>${spacer}</w:pPr></w:p>`,
      'table',
      portrait,
    ]);
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.noText')?.params).toEqual({
      pages: '3',
    });
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.tables')?.params).toEqual({ count: 3 });
  });

  it('keeps a blank first page as a page of its own', async () => {
    const bytes = await officeDocument([{ content: '' }, { content: courier(50, 470, 'Second') }]);
    const { file } = await exportOffice(bytes, { ...docxOptions, pages: [0, 1] }, run);
    const blocks = bodyBlocks(await documentXml(file.bytes));
    const margins =
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="720" w:left="1440" w:header="0" w:footer="0" w:gutter="0"/>';
    expect(blocks[0]).toBe(
      `<w:p><w:pPr><w:sectPr><w:pgSz w:w="8000" w:h="10000"/>${margins}</w:sectPr></w:pPr></w:p>`,
    );
    expect(paragraphOf(blocks[1] ?? '').props).toBe(
      '<w:pageBreakBefore/><w:spacing w:before="0" w:after="0"/>',
    );
  });

  it('writes a table read from spacing without rules or alignment, indented to where it stands', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(50, 470, 'W'.repeat(50)),
          courier(70, 400, 'Ad'),
          courier(190, 400, 'Adet'),
          courier(304, 400, 'Fiyat'),
          courier(70, 385, 'Elma'),
          courier(190, 385, '3'),
          // Flush right in a column of numbers: a ruled cell would say so.
          courier(334, 385, '5'),
          courier(70, 370, 'Armut'),
          courier(190, 370, '55'),
          courier(322, 370, '100'),
        ].join('\n'),
      },
    ]);
    const { file, notes } = await exportOffice(bytes, docxOptions, run);
    const table =
      bodyBlocks(await documentXml(file.bytes)).find((block) => block.startsWith('<w:tbl>')) ?? '';
    const nil = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="nil"/>`)
      .join('');
    expect(table.split('<w:tr>')[0]).toBe(
      '<w:tbl><w:tblPr><w:tblW w:w="5480" w:type="dxa"/><w:tblInd w:w="360" w:type="dxa"/>' +
        `<w:tblBorders>${nil}</w:tblBorders><w:tblLayout w:type="autofit"/>` +
        '<w:tblCellMar><w:left w:w="57" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar>' +
        '</w:tblPr><w:tblGrid><w:gridCol w:w="1540"/><w:gridCol w:w="2280"/><w:gridCol w:w="1660"/></w:tblGrid>',
    );
    expect(table).not.toContain('<w:jc');
    expect(tableRows(table).map((row) => row.map((cell) => cell.paragraphs[0]?.[1]))).toEqual([
      ['Ad', 'Adet', 'Fiyat'],
      ['Elma', '3', '5'],
      ['Armut', '55', '100'],
    ]);
    const keys = notes.map((entry) => entry.key);
    expect(keys).toContain('op.note.exportOffice.streamTables');
    expect(keys).not.toContain('op.note.exportOffice.tables');
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.streamTables')?.params).toEqual({
      count: 1,
    });
  });

  it('narrows a table that is wider than the page lets it be, keeping its proportions', async () => {
    const xs = [50, 150, 250, 395];
    const ys = [380, 350, 320, 290];
    const bytes = await officeDocument([
      {
        content: [
          gridOperators(xs, ys),
          ...[
            ['a', 'b', 'c'],
            ['d', 'e', 'f'],
          ].flatMap((row, r) => row.map((text, c) => courier((xs[c] ?? 0) + 8, (ys[r] ?? 0) - 20, text))),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const table =
      bodyBlocks(await documentXml(file.bytes)).find((block) => block.startsWith('<w:tbl>')) ?? '';
    // 345 pt of rules into the 332 pt between the margins (50 on the left, 18 on the right).
    expect(table).toContain('<w:tblW w:w="6640" w:type="dxa"/>');
    expect([...table.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((match) => Number(match[1]))).toEqual([
      1925, 1925, 2791,
    ]);
    // No table above it, none below: it starts the page with no spacer.
    expect(bodyBlocks(await documentXml(file.bytes))[0]).toMatch(/^<w:tbl>/);
  });

  it('writes a table read from spacing next to ruled ones in the reading order, and counts both', async () => {
    const bytes = await officeDocument([
      {
        content: [
          gridOperators([50, 110, 170], [450, 430, 410]),
          courier(58, 436, 'a'),
          courier(118, 436, 'b'),
          courier(58, 416, 'c'),
          courier(118, 416, 'd'),
          courier(50, 300, 'Kalem'),
          courier(200, 300, 'Adet'),
          courier(50, 285, 'Silgi'),
          courier(200, 285, '4'),
        ].join('\n'),
      },
    ]);
    const { file, notes } = await exportOffice(bytes, docxOptions, run);
    const document = await documentXml(file.bytes);
    expect(document.match(/<w:tbl>/g)).toHaveLength(2);
    expect(document.match(/<w:tblLayout w:type="fixed"\/>/g)).toHaveLength(1);
    expect(document.match(/<w:tblLayout w:type="autofit"\/>/g)).toHaveLength(1);
    expect(notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.exportOffice.done', { format: 'DOCX', pages: 1 }],
      ['op.note.exportOffice.docxApproximate', undefined],
      ['op.note.exportOffice.tables', { count: 1 }],
      ['op.note.exportOffice.streamTables', { count: 1 }],
    ]);
  });
});

describe('exportOffice → DOCX pictures', () => {
  const red = { width: 4, height: 4, rgb: [255, 0, 0] } as const;
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  /** The `wp:extent` of every inline picture, in points. */
  const extents = (document: string): [number, number][] =>
    [...document.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map((match) => [
      Number(match[1]) / 12700,
      Number(match[2]) / 12700,
    ]);

  it('places a picture inline at its size and indent, with its PNG, relationship and content type', async () => {
    const bytes = await officeDocument([
      {
        images: { Im1: red },
        content: [
          courier(50, 470, 'W'.repeat(50)),
          picture('Im1', 100, 300, 120, 80),
          courier(50, 250, 'after'),
        ].join('\n'),
      },
    ]);
    const { file, notes } = await exportOffice(bytes, docxOptions, run);
    const zip = await JSZip.loadAsync(file.bytes);
    const document = await documentXml(file.bytes);
    expect(extents(document)).toEqual([[120, 80]]);
    const blocks = bodyBlocks(document);
    expect(blocks[1]).toMatch(
      /^<w:p><w:pPr><w:spacing w:before="960" w:after="0"\/><w:ind w:left="1000"\/><\/w:pPr><w:r><w:drawing>/,
    );
    expect(blocks[1]).toContain('<wp:docPr id="1" name="Picture 1"/>');
    expect(blocks[1]).toContain('<a:blip r:embed="rIdImage1"/>');
    expect([
      ...((await zip.file('word/media/image1.png')?.async('uint8array')) ?? new Uint8Array()).subarray(0, 8),
    ]).toEqual(PNG_SIGNATURE);
    expect(await zip.file('word/_rels/document.xml.rels')?.async('string')).toContain(
      '<Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>',
    );
    expect(await zip.file('[Content_Types].xml')?.async('string')).toContain(
      '<Default Extension="png" ContentType="image/png"/>',
    );
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.pictures')?.params).toEqual({
      count: 1,
    });
  });

  it('says so when a picture inside a ruled table is left out, since cells hold text only', async () => {
    const bytes = await officeDocument([
      {
        images: { Im1: red },
        content: [
          courier(58, 360, 'Ad'),
          courier(208, 360, 'Logo'),
          courier(58, 320, 'Ada'),
          picture('Im1', 210, 300, 30, 30),
          '0.5 w 0 G',
          '50 380 m 350 380 l S',
          '50 340 m 350 340 l S',
          '50 290 m 350 290 l S',
          '50 380 m 50 290 l S',
          '200 380 m 200 290 l S',
          '350 380 m 350 290 l S',
        ].join('\n'),
      },
    ]);
    const { file, notes } = await exportOffice(bytes, docxOptions, run);
    expect(await documentXml(file.bytes)).not.toContain('<w:drawing>');
    expect(notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.exportOffice.done', { format: 'DOCX', pages: 1 }],
      ['op.note.exportOffice.docxApproximate', undefined],
      ['op.note.exportOffice.tables', { count: 1 }],
      ['op.note.exportOffice.picturesLost', { count: 1 }],
    ]);
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.picturesLost')?.kind).toBe('lost');
  });

  it('shrinks a picture that is wider than its column, and moves its page break and section onto it', async () => {
    const bytes = await officeDocument([
      {
        size: [450, 500],
        images: { Im1: red },
        content: [
          // Two columns: the second starts at 250.
          courier(50, 440, 'a'.repeat(24)),
          courier(50, 428, 'b'.repeat(24)),
          courier(50, 416, 'c'.repeat(10)),
          courier(250, 435, 'd'.repeat(24)),
          courier(250, 423, 'e'.repeat(24)),
          courier(250, 411, 'f'.repeat(10)),
          // 150 pt wide from 247.5: it begins just left of the second column and is cut to fit it.
          picture('Im1', 247.5, 200, 150, 75),
        ].join('\n'),
      },
      { images: { Im1: red }, content: picture('Im1', 60, 300, 40, 40) },
    ]);
    const { file } = await exportOffice(bytes, { ...docxOptions, pages: [0, 1] }, run);
    const document = await documentXml(file.bytes);
    expect(extents(document)).toEqual([
      [147.5, 73.75],
      [40, 40],
    ]);
    const pictures = bodyBlocks(document).filter((block) => block.includes('<w:drawing>'));
    // The first is the last item of its page: it carries the page's section; the second begins page 2.
    expect(pictures[0]).toContain('<w:sectPr><w:pgSz w:w="9000" w:h="10000"/>');
    expect(pictures[1]).toMatch(/^<w:p><w:pPr><w:pageBreakBefore\/>/);
    expect(pictures[1]).toContain('<wp:docPr id="2" name="Picture 2"/>');
  });

  it('writes a drawing as one picture in its reading place, replacing the pictures inside it', async () => {
    const bytes = await officeDocument([
      {
        images: { Im1: red, Im2: red },
        content: [
          courier(50, 470, 'W'.repeat(50)),
          circle(200, 300, 40),
          // Two pictures inside the drawing: they are part of its picture, which is one.
          picture('Im1', 185, 285, 15, 15),
          picture('Im2', 200, 300, 15, 15),
          courier(50, 250, 'after'),
        ].join('\n'),
      },
      // A drawing without pictures goes before the first item below its top...
      {
        content: [
          courier(50, 470, 'W'.repeat(50)),
          courier(50, 400, 'before'),
          circle(200, 300, 40),
          courier(50, 100, 'after'),
        ].join('\n'),
      },
      // ...and after everything when nothing is below it.
      { content: [courier(50, 470, 'top'), circle(200, 100, 40)].join('\n') },
    ]);
    const { file, notes } = await exportOffice(bytes, { ...docxOptions, pages: [0, 1, 2] }, run);
    const document = await documentXml(file.bytes);
    const order = bodyBlocks(document)
      .filter((block) => !block.startsWith('<w:sectPr'))
      .map((block) => (block.includes('<w:drawing>') ? 'picture' : paragraphOf(block).text.slice(0, 6)));
    expect(order).toEqual([
      'WWWWWW',
      'picture',
      'after',
      'WWWWWW',
      'before',
      'picture',
      'after',
      'top',
      'picture',
    ]);
    expect(extents(document)).toEqual([
      [80, 80],
      [80, 80],
      [80, 80],
    ]);
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.pictures')?.params).toEqual({
      count: 3,
    });
  });

  it('writes an icon-sized picture as it is, and leaves out the pictures inside a table', async () => {
    const xs = [50, 150, 250, 350];
    const ys = [380, 350, 320, 290];
    const bytes = await officeDocument([
      {
        images: { Im1: red },
        content: [
          courier(50, 470, 'W'.repeat(50)),
          // 20 pt: smaller than a figure, so it is a picture of its own, not a drawing.
          picture('Im1', 300, 420, 20, 20),
          courier(58, 360, 'a'),
          courier(158, 360, 'b'),
          courier(58, 330, 'c'),
          courier(158, 330, 'd'),
          // Inside a cell, small and large: the table is the cell's text; the pictures are not carried.
          picture('Im1', 260, 325, 20, 20),
          picture('Im1', 260, 295, 80, 25),
          gridOperators(xs, ys),
        ].join('\n'),
      },
    ]);
    const { file, notes } = await exportOffice(bytes, docxOptions, run);
    const zip = await JSZip.loadAsync(file.bytes);
    expect(extents(await documentXml(file.bytes))).toEqual([[20, 20]]);
    expect(
      Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !name.endsWith('/')),
    ).toEqual(['word/media/image1.png']);
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.pictures')?.params).toEqual({
      count: 1,
    });
  });
});

/** The sheets of an XLSX as `[name, sheet XML]`, in workbook order. */
async function sheetsOfXlsx(bytes: Uint8Array): Promise<[string, string][]> {
  const zip = await JSZip.loadAsync(bytes);
  const workbook = (await zip.file('xl/workbook.xml')?.async('string')) ?? '';
  const names = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((match) => match[1] ?? '');
  return Promise.all(
    names.map(
      async (name, index): Promise<[string, string]> => [
        name,
        (await zip.file(`xl/worksheets/sheet${index + 1}.xml`)?.async('string')) ?? '',
      ],
    ),
  );
}

/** The `<sheetData>` of a sheet XML and its `<mergeCells>`. */
const sheetData = (sheet: string): string => /<sheetData>[\s\S]*<\/sheetData>/.exec(sheet)?.[0] ?? '';
const textCell = (ref: string, text: string, style = ''): string =>
  `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${text}</t></is></c>`;
const numberCell = (ref: string, value: string): string => `<c r="${ref}"><v>${value}</v></c>`;

/** Two ruled tables: the first with a merged row head and a merged column, the second plain. */
async function twoTablesPage(): Promise<Uint8Array> {
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
    '50 300 m 250 300 l S',
    '50 270 m 250 270 l S',
    '50 240 m 250 240 l S',
    '50 300 m 50 240 l S',
    '150 300 m 150 240 l S',
    '250 300 m 250 240 l S',
  ].join('\n');
  return officeDocument(
    [
      {
        content: [
          courier(58, 430, 'Toplam'),
          courier(258, 430, 'Fiyat'),
          courier(58, 400, 'Elma <1>'),
          courier(158, 400, '3'),
          courier(258, 400, '12,5'),
          courier(58, 370, 'Cay'),
          // Two lines in one cell.
          courier(158, 380, 'ilk'),
          courier(158, 369, 'ikinci'),
          courier(58, 280, 'Kod'),
          courier(158, 280, 'Tutar'),
          courier(58, 250, '007'),
          courier(158, 250, '1.234,5'),
          courier(50, 480, 'outside text'),
          // A drawing: Word keeps it as a picture, a spreadsheet has no place for it.
          circle(300, 150, 30),
          rules,
        ].join('\n'),
      },
    ],
    { title: 'Raporlar' },
  );
}

describe('exportOffice → XLSX', () => {
  it('writes one sheet per ruled table with its merges, column widths, numbers and multi-line cells', async () => {
    const { file, notes, steps } = await exportOffice(
      await twoTablesPage(),
      { pages: [0], baseName: 'a.pdf', format: 'xlsx' },
      run,
    );
    expect(file.name).toBe('a.xlsx');
    expect(file.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(steps).toEqual(['office.read', 'office.tables', 'office.write']);
    const sheets = await sheetsOfXlsx(file.bytes);
    expect(sheets.map(([name]) => name)).toEqual(['Table 1', 'Table 2']);
    const [first, second] = sheets.map(([, xml]) => xml);
    expect(first).toContain(
      '<cols><col min="1" max="1" width="19.05" customWidth="1"/><col min="2" max="2" width="19.05" customWidth="1"/>' +
        '<col min="3" max="3" width="19.05" customWidth="1"/></cols>',
    );
    expect(sheetData(first ?? '')).toBe(
      '<sheetData>' +
        `<row r="1">${textCell('A1', 'Toplam')}${textCell('C1', 'Fiyat')}</row>` +
        `<row r="2">${textCell('A2', 'Elma &lt;1&gt;')}${numberCell('B2', '3')}${numberCell('C2', '12.5')}</row>` +
        `<row r="3">${textCell('A3', 'Cay')}${textCell('B3', 'ilk\nikinci', ' s="1"')}</row>` +
        '</sheetData>',
    );
    expect(first).toContain(
      '<mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref="C2:C3"/></mergeCells>',
    );
    // `007` is an identifier and stays text; `1.234,5` is one thousand two hundred thirty-four and a half.
    expect(sheetData(second ?? '')).toBe(
      '<sheetData>' +
        `<row r="1">${textCell('A1', 'Kod')}${textCell('B1', 'Tutar')}</row>` +
        `<row r="2">${textCell('A2', '007')}${numberCell('B2', '1234.5')}</row>` +
        '</sheetData>',
    );
    expect(second).not.toContain('<mergeCells');
    expect(notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.exportOffice.done', { format: 'XLSX', pages: 1 }],
      ['op.note.exportOffice.sheets', { count: 2 }],
      ['op.note.exportOffice.numbers', { count: 3 }],
      ['op.note.exportOffice.tables', { count: 2 }],
      ['op.note.exportOffice.outsideText', undefined],
    ]);
    const zip = await JSZip.loadAsync(file.bytes);
    expect(await zip.file('docProps/core.xml')?.async('string')).toContain('<dc:title>Raporlar</dc:title>');
  });

  it('names sheets as Excel allows: 31 characters, none of []:*?/\\, each once, whatever the case', async () => {
    /** A 2 × 2 table of one cell each, its top left corner at `(x, top)`. */
    const small = (top: number, label: string): string =>
      [
        gridOperators([50, 110, 170], [top, top - 20, top - 40]),
        courier(58, top - 14, label),
        courier(118, top - 14, 'x'),
        courier(58, top - 34, 'y'),
        courier(118, top - 34, 'z'),
      ].join('\n');
    const bytes = await officeDocument([
      { content: [small(450, 'a'), small(350, 'b'), small(250, 'c')].join('\n') },
      { content: [small(450, 'd'), small(350, 'e'), small(250, 'f')].join('\n') },
    ]);
    const names = ['Same', 'same', '', '[:*?]', 'A'.repeat(40), 'A'.repeat(40)];
    const { file } = await exportOffice(
      bytes,
      {
        pages: [0, 1],
        baseName: 'a.pdf',
        format: 'xlsx',
        sheetName: { table: (n) => names[n - 1] ?? '', page: (n) => `Page ${n}` },
      },
      run,
    );
    expect((await sheetsOfXlsx(file.bytes)).map(([name]) => name)).toEqual([
      'Same',
      'same (2)',
      'Sheet3',
      'Sheet4',
      'A'.repeat(31),
      `${'A'.repeat(27)} (2)`,
    ]);
  });

  it('puts the text of a page without a table in rows, aligned on shared column starts, and reports it', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(50, 470, 'Name'),
          courier(200, 470, 'Qty'),
          courier(50, 450, 'Apple'),
          courier(200, 450, '3'),
          courier(50, 400, 'A line of prose across the page'),
        ].join('\n'),
      },
      { content: '' },
      { content: courier(50, 470, 'Third page') },
    ]);
    const { file, notes } = await exportOffice(
      bytes,
      {
        pages: [0, 1, 2],
        baseName: 'a.pdf',
        format: 'xlsx',
        sheetName: { table: (n) => `Tablo ${n}`, page: (n) => `Sayfa ${n}` },
      },
      run,
    );
    const sheets = await sheetsOfXlsx(file.bytes);
    expect(sheets.map(([name]) => name)).toEqual(['Sayfa 1', 'Sayfa 3']);
    expect(sheetData(sheets[0]?.[1] ?? '')).toBe(
      '<sheetData>' +
        `<row r="1">${textCell('A1', 'Name')}${textCell('B1', 'Qty')}</row>` +
        `<row r="2">${textCell('A2', 'Apple')}${numberCell('B2', '3')}</row>` +
        `<row r="3">${textCell('A3', 'A line of prose across the page')}</row>` +
        '</sheetData>',
    );
    // Without rules there are no widths to take: they follow the longest text, plus two.
    expect(sheets[0]?.[1]).toContain(
      '<cols><col min="1" max="1" width="33.00" customWidth="1"/><col min="2" max="2" width="6.00" customWidth="1"/></cols>',
    );
    expect(sheetData(sheets[1]?.[1] ?? '')).toBe(
      `<sheetData><row r="1">${textCell('A1', 'Third page')}</row></sheetData>`,
    );
    expect(notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.exportOffice.done', { format: 'XLSX', pages: 3 }],
      ['op.note.exportOffice.sheets', { count: 2 }],
      ['op.note.exportOffice.numbers', { count: 1 }],
      ['op.note.exportOffice.unruled', { pages: '1, 3' }],
      ['op.note.exportOffice.noText', { pages: '2' }],
    ]);
  });

  it('orders the sheets of a page top to bottom, left to right when they share a top, tables from spacing among them', async () => {
    const small = (left: number, label: string): string =>
      [
        gridOperators([left, left + 60, left + 120], [450, 430, 410]),
        courier(left + 8, 436, label),
        courier(left + 68, 436, 'x'),
        courier(left + 8, 416, 'y'),
        courier(left + 68, 416, 'z'),
      ].join('\n');
    const bytes = await officeDocument([
      {
        content: [
          // Written right first: the order on the page decides, not the order in the file.
          small(230, 'right'),
          small(50, 'left'),
          courier(50, 300, 'Kalem'),
          courier(200, 300, 'Adet'),
          courier(50, 285, 'Silgi'),
          courier(200, 285, 'Cok'),
        ].join('\n'),
      },
    ]);
    const { file, notes } = await exportOffice(bytes, { pages: [0], baseName: 'a.pdf', format: 'xlsx' }, run);
    const sheets = await sheetsOfXlsx(file.bytes);
    expect(sheets.map(([name]) => name)).toEqual(['Table 1', 'Table 2', 'Table 3']);
    expect(
      sheets.map(([, xml]) =>
        [...xml.matchAll(/<t xml:space="preserve">([^<]*)<\/t>/g)].map((match) => match[1]),
      ),
    ).toEqual([
      ['left', 'x', 'y', 'z'],
      ['right', 'x', 'y', 'z'],
      ['Kalem', 'Adet', 'Silgi', 'Cok'],
    ]);
    expect(notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.exportOffice.done', { format: 'XLSX', pages: 1 }],
      ['op.note.exportOffice.sheets', { count: 3 }],
      ['op.note.exportOffice.tables', { count: 2 }],
      ['op.note.exportOffice.streamTables', { count: 1 }],
    ]);
  });
});

describe('exportOffice → CSV', () => {
  it('writes each table as rows, an empty line between tables, the comma as default, quoting what needs it', async () => {
    const { file, notes, steps } = await exportOffice(
      await twoTablesPage(),
      { pages: [0], baseName: 'a.pdf', format: 'csv' },
      run,
    );
    expect(steps).toEqual(['office.read', 'office.tables', 'office.write', 'verify']);
    expect(file.mime).toBe('text/csv;charset=utf-8');
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.bytes);
    expect(text).toBe(
      '\uFEFFToplam,,Fiyat\r\nElma <1>,3,"12,5"\r\nCay,"ilk\nikinci",\r\n\r\nKod,Tutar\r\n007,"1.234,5"\r\n',
    );
    // What an RFC 4180 reader makes of it: the tables' cells, a one-cell row for the empty line.
    expect(parseCsv(text.slice(1), ',')).toEqual([
      ['Toplam', '', 'Fiyat'],
      ['Elma <1>', '3', '12,5'],
      ['Cay', 'ilk\nikinci', ''],
      [''],
      ['Kod', 'Tutar'],
      ['007', '1.234,5'],
    ]);
    expect(notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.exportOffice.done', { format: 'CSV', pages: 1 }],
      ['op.note.exportOffice.csvRows', { rows: 6, tables: 2 }],
      ['op.note.exportOffice.tables', { count: 2 }],
      ['op.note.exportOffice.outsideText', undefined],
    ]);
  });

  it('writes the text rows of a page without a table, and says which pages had no rules', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(50, 470, 'Name'),
          courier(200, 470, 'Note'),
          courier(50, 450, 'A'),
          courier(200, 450, '=1+1'),
        ].join('\n'),
      },
    ]);
    const { file, notes } = await exportOffice(
      bytes,
      { pages: [0], baseName: 'a.pdf', format: 'csv', csvDelimiter: ';' },
      run,
    );
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.bytes)).toBe(
      "\uFEFFName;Note\r\nA;'=1+1\r\n",
    );
    expect(notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.exportOffice.done', { format: 'CSV', pages: 1 }],
      ['op.note.exportOffice.csvRows', { rows: 2, tables: 1 }],
      ['op.note.exportOffice.csvFormulas', { count: 1 }],
      ['op.note.exportOffice.unruled', { pages: '1' }],
    ]);
  });
});

describe('exportOffice → errors, aborts and small facts', () => {
  const text = () => officeDocument([{ content: courier(50, 470, 'hello world') }]);

  it('maps a page that is not in the document to a tool error, and a damaged file too', async () => {
    await expect(exportOffice(await text(), { ...docxOptions, pages: [7] }, run)).rejects.toMatchObject({
      name: 'ToolError',
    });
    await expect(exportOffice(new Uint8Array([1, 2, 3]), docxOptions, run)).rejects.toMatchObject({
      name: 'ToolError',
    });
  });

  it('stops when the signal is aborted: before the start, while loading, and from the progress callbacks', async () => {
    const bytes = await text();
    const aborted = new AbortController();
    aborted.abort();
    await expect(exportOffice(bytes, docxOptions, { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    // While the engine loads.
    const loading = new AbortController();
    const pending = exportOffice(bytes, docxOptions, { signal: loading.signal });
    loading.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // In the read of the second page: the loop's own check, inside the try.
    const reading = new AbortController();
    await expect(
      exportOffice(
        bytes.slice(),
        { ...docxOptions, pages: [0, 0] },
        {
          signal: reading.signal,
          onProgress: (progress) => {
            if (progress.phase === 'read') reading.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // In the read of the only page: after the loop.
    const after = new AbortController();
    await expect(
      exportOffice(bytes, docxOptions, {
        signal: after.signal,
        onProgress: (progress) => {
          if (progress.phase === 'read') after.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // While writing the DOCX.
    const writing = new AbortController();
    await expect(
      exportOffice(bytes, docxOptions, {
        signal: writing.signal,
        onProgress: (progress) => {
          if (progress.phase === 'write') writing.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('joins lines across trailing and leading spaces without doubling them, and trims the paragraph', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(50, 470, `  ${'a'.repeat(27)} `),
          courier(50, 458, 'b'.repeat(30)),
          courier(50, 446, ` ${'c'.repeat(27)}  `),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    expect((await paragraphProps(file.bytes)).map(([, value]) => value)).toEqual([
      `${'a'.repeat(27)} ${'b'.repeat(30)} ${'c'.repeat(27)}`,
    ]);
  });

  it('reports a page of only spaces as having no text, and the characters it could not read', async () => {
    const blank = await officeDocument([{ content: courier(50, 470, '     ') }]);
    const docx = await exportOffice(blank, docxOptions, run);
    // The page stays a page: one empty paragraph.
    expect(await paragraphProps(docx.file.bytes)).toEqual([['', '']]);
    expect(docx.notes.find((entry) => entry.key === 'op.note.exportOffice.noText')?.params).toEqual({
      pages: '1',
    });
    const mapped = await officeDocument([{ content: line('courierMapped', 10, 50, 470, 'x\u0001y \u0001') }]);
    const { notes } = await exportOffice(mapped, docxOptions, run);
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.unreadable')?.params).toEqual({
      count: 2,
    });
  });

  it('exports a lone character XML cannot carry without failing the read-back', async () => {
    const bytes = await officeDocument([{ content: line('courierMapped', 10, 50, 470, 'a \u0004 b') }]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    expect((await paragraphProps(file.bytes)).map(([, value]) => value)).toEqual(['a  b']);
  });

  it('names the file after the PDF, or "document", and takes the title from the PDF or the name', async () => {
    const bytes = await text();
    const named = await exportOffice(bytes, { ...docxOptions, baseName: 'Rapor.PDF' }, run);
    expect(named.file.name).toBe('Rapor.docx');
    expect(
      await (await JSZip.loadAsync(named.file.bytes)).file('docProps/core.xml')?.async('string'),
    ).toContain('<dc:title>Rapor</dc:title>');
    expect((await exportOffice(bytes, { ...docxOptions, baseName: '.pdf' }, run)).file.name).toBe(
      'document.docx',
    );
  });

  it('writes a Word table of a stream and numbers none in a sheet without numbers', async () => {
    const { notes } = await exportOffice(
      await officeDocument([{ content: courier(50, 470, 'only words') }]),
      { ...docxOptions, format: 'xlsx' },
      run,
    );
    expect(notes.map((entry) => entry.key)).not.toContain('op.note.exportOffice.numbers');
  });

  it('measures a paragraph in the column on its right when nothing stands left of it', async () => {
    const bytes = await officeDocument([
      {
        size: [450, 500],
        content: [
          // Spans the page, so nothing ends left of the second column.
          courier(50, 470, 'W'.repeat(50)),
          courier(250, 435, 'd'.repeat(24)),
          courier(250, 423, 'e'.repeat(24)),
          courier(250, 411, 'f'.repeat(10)),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    expect(
      (await paragraphProps(file.bytes)).map(([props, value]) => [props.includes('w:jc'), value.slice(0, 3)]),
    ).toEqual([
      [false, 'WWW'],
      [true, 'ddd'],
    ]);
  });

  it('keeps every letter of text set at size 0, however the lines fall', async () => {
    const bytes = await officeDocument([
      { content: [line('courier', 0, 50, 470, 'gho'), line('courier', 0, 50, 458, 'st')].join('\n') },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    expect((await paragraphProps(file.bytes)).map(([, value]) => value).join('')).toBe('ghost');
  });
});
