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

  it('separates tables that stand side by side with a hairline paragraph, which Word would otherwise fuse into one table', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(58, 425, 'a'),
          courier(108, 425, 'b'),
          courier(58, 405, 'c'),
          courier(108, 405, 'd'),
          courier(258, 425, 'e'),
          courier(308, 425, 'f'),
          courier(258, 405, 'g'),
          courier(308, 405, 'h'),
          gridOperators([50, 100, 150], [440, 420, 400]),
          gridOperators([250, 300, 350], [440, 420, 400]),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const kinds = bodyBlocks(await documentXml(file.bytes)).map((block) => /^<w:(\w+)/.exec(block)?.[1]);
    expect(kinds).toEqual(['tbl', 'p', 'tbl', 'sectPr']);
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

describe('exportOffice → DOCX text on drawings and pictures', () => {
  const red = { width: 4, height: 4, rgb: [255, 0, 0] } as const;
  /** A 10 pt Courier line as MuPDF boxes it: 12.5 pt high, its top 9.3 pt above the baseline. */
  const LINE = 12.5;
  const ASCENT = 9.3;
  /** Equal to within the point a holder takes and the half point two lines may overlap. */
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1.1);
  /**
   * Where the flow puts each paragraph of a one-page DOCX body, in points from the page's top,
   * the way a word processor stacks them: the top margin, then each paragraph's space before and
   * its height (a picture's holder is one point). A picture behind the text hangs `offset`
   * points from its holder's top, so its top is the holder's plus that. A paragraph of an exact height is a spacer.
   */
  const flowOf = (document: string) => {
    let y = Number(/<w:pgMar w:top="(\d+)"/.exec(document)?.[1]) / 20;
    const pictures: { x: number; top: number; width: number; height: number; relative: string }[] = [];
    const texts = new Map<string, number>();
    for (const block of bodyBlocks(document).filter((candidate) => candidate.startsWith('<w:p>'))) {
      y += Number(/w:before="(\d+)"/.exec(block)?.[1] ?? 0) / 20;
      const anchor =
        /<wp:positionH[^>]*><wp:posOffset>(-?\d+)<\/wp:posOffset>.*?<wp:positionV relativeFrom="(\w+)"><wp:posOffset>(-?\d+)<\/wp:posOffset>.*?<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(
          block,
        );
      const inline = /<wp:inline[^>]*><wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(block);
      if (inline !== null) {
        const left = Number(/<w:pgMar [^>]*w:left="(\d+)"/.exec(document)?.[1]) / 20;
        pictures.push({
          x: left + Number(/<w:ind w:left="(\d+)"/.exec(block)?.[1] ?? 0) / 20,
          relative: 'inline',
          top: y,
          width: Number(inline[1]) / 12700,
          height: Number(inline[2]) / 12700,
        });
        y += Number(inline[2]) / 12700;
        continue;
      }
      if (anchor === null) {
        const exact = /w:line="(\d+)" w:lineRule="exact"/.exec(block)?.[1];
        // A spacer paragraph has an exact height and no text.
        if (exact !== undefined) y += Number(exact) / 20;
        else {
          texts.set(block.replace(/<[^>]+>/g, ''), y);
          y += LINE;
        }
        continue;
      }
      pictures.push({
        x: Number(anchor[1]) / 12700,
        relative: anchor[2] as string,
        top: y + Number(anchor[3]) / 12700,
        width: Number(anchor[4]) / 12700,
        height: Number(anchor[5]) / 12700,
      });
      y += 1;
    }
    return { pictures, texts, end: y };
  };

  it('keeps the text inside a drawing as text and puts the drawing behind it, taking no room of its own', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(50, 470, 'W'.repeat(50)),
          // Two cards, each a drawing with a title and a figure written inside it.
          circle(100, 350, 40),
          courier(80, 352, 'Aktif'),
          courier(80, 340, '12.480'),
          circle(300, 350, 40),
          courier(280, 352, 'Gelir'),
          courier(280, 340, '1,92 M'),
          courier(50, 250, 'after'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const document = await documentXml(file.bytes);
    expect((await paragraphs(file.bytes)).join(' ')).toBe(
      `${'W'.repeat(50)} Aktif 12.480 Gelir 1,92 M after`,
    );
    // Each drawing is one picture, 80 pt square, 60 and 260 pt from the left of the page.
    const { pictures: found, texts } = flowOf(document);
    const pictures = [...found].sort((a, b) => a.x - b.x);
    expect(pictures.map((entry) => [entry.x, entry.width, entry.height])).toEqual([
      [60, 80, 80],
      [260, 80, 80],
    ]);
    expect(document).not.toContain('<wp:inline');
    // It hangs from its holder in the flow, so it goes where the text on it goes: its
    // title is 38 pt (the cards' 110 pt, the title's 148 pt baseline) minus the ascent below its top...
    expect(pictures.map((entry) => entry.relative)).toEqual(['paragraph', 'paragraph']);
    const [card] = pictures;
    near((texts.get('Aktif') ?? 0) - (card?.top ?? 0), 148 - ASCENT - 110);
    near((texts.get('12.480') ?? 0) - (card?.top ?? 0), 160 - ASCENT - 110);
    // ...and the text after the cards starts under them, not over them.
    expect(texts.get('after') ?? 0).toBeGreaterThanOrEqual((card?.top ?? 0) + 80);
    // The gap above the cards is clamped like any: the title's own space before is the rest of 48 pt.
    const [title] = (await paragraphProps(file.bytes)).find(([, text]) => text === 'Aktif') ?? [];
    expect(Number(/w:before="(\d+)"/.exec(title ?? '')?.[1]) / 20).toBeLessThanOrEqual(48);
    // The picture is a paragraph of a point's height, not a block of 80 pt in the flow.
    const holders = bodyBlocks(document).filter((block) => block.includes('<wp:anchor'));
    expect(holders).toHaveLength(2);
    for (const holder of holders) expect(holder).toContain('w:line="20" w:lineRule="exact"');
  });

  it('keeps a tall drawing with only a title near its top under the text that follows it', async () => {
    const bytes = await officeDocument([
      {
        content: [
          // A 200 pt drawing, 100..300 pt from the top, with a title on its top edge and body text below it.
          circle(200, 300, 100),
          courier(150, 380, 'Title'),
          courier(50, 150, 'after body text'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const { pictures, texts } = flowOf(await documentXml(file.bytes));
    const [drawing] = pictures;
    expect(drawing).toMatchObject({ x: 100, width: 200, height: 200, relative: 'paragraph' });
    const top = drawing?.top ?? 0;
    // The title is 20 pt under the drawing's top less its ascent, to the point its holder takes.
    near((texts.get('Title') ?? 0) - top, 120 - ASCENT - 100);
    // The body text is 350 pt from the page's top: under the drawing's foot (300 pt), as far as the PDF has it.
    expect(texts.get('after body text') ?? 0).toBeGreaterThanOrEqual(top + 200);
    near((texts.get('after body text') ?? 0) - (top + 200), 350 - ASCENT - 300);
  });

  it('keeps a drawing with no text as a picture in the flow, as before', async () => {
    const bytes = await officeDocument([
      {
        content: [courier(50, 470, 'W'.repeat(50)), circle(200, 300, 40), courier(50, 100, 'after')].join(
          '\n',
        ),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const document = await documentXml(file.bytes);
    expect(document).toContain('<wp:inline');
    expect(document).not.toContain('<wp:anchor');
  });

  it('puts a picture behind the text that stands on it, so the text is not pushed to another page', async () => {
    const bytes = await officeDocument([
      {
        images: { Im1: red },
        content: [
          // A picture over the whole page with a title and a line written on it.
          picture('Im1', 0, 0, 400, 500),
          courier(100, 400, 'Baslik'),
          courier(100, 300, 'Alt yazi'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const document = await documentXml(file.bytes);
    expect(await paragraphs(file.bytes)).toEqual(['Baslik', 'Alt yazi']);
    const { pictures, texts } = flowOf(document);
    expect(pictures).toMatchObject([{ x: 0, width: 400, height: 500, relative: 'paragraph' }]);
    // The title is 100 pt down the page, less its ascent: the picture starts at the page's top.
    near((texts.get('Baslik') ?? 0) - (pictures[0]?.top ?? 0), 100 - ASCENT);
    expect(document).not.toContain('<wp:inline');
    // The text keeps its distance from the top of the page: the picture is not above it in the flow.
    const [title] = await paragraphProps(file.bytes);
    expect(title?.[0]).toContain('w:before="0"');
  });

  it('carries a page break and a section on the paragraph that holds a picture behind the text', async () => {
    const bytes = await officeDocument([
      { content: courier(50, 470, 'first') },
      {
        size: [300, 300],
        images: { Im1: red },
        content: [picture('Im1', 0, 0, 300, 300), courier(100, 150, 'on it')].join('\n'),
      },
      { content: courier(50, 470, 'last') },
    ]);
    const { file } = await exportOffice(bytes, { ...docxOptions, pages: [0, 1, 2] }, run);
    const holder = bodyBlocks(await documentXml(file.bytes)).find((block) => block.includes('<wp:anchor'));
    expect(holder).toMatch(/^<w:p><w:pPr><w:pageBreakBefore\/>/);
    expect(await paragraphs(file.bytes)).toEqual(['first', 'on it', 'last']);
  });

  it('stands the holder before the text that is on its picture, and closes the section on the last item, whatever order MuPDF read them in', async () => {
    const bytes = await officeDocument([
      {
        size: [300, 300],
        images: { Im1: red },
        // The picture is drawn last, so MuPDF reads it after the text.
        content: [courier(100, 150, 'on it'), picture('Im1', 90, 140, 100, 14)].join('\n'),
      },
      { content: courier(50, 470, 'next') },
    ]);
    const { file } = await exportOffice(bytes, { ...docxOptions, pages: [0, 1] }, run);
    const blocks = bodyBlocks(await documentXml(file.bytes));
    const holder = blocks.find((block) => block.includes('<wp:anchor'));
    expect(holder).not.toContain('<w:sectPr>');
    const text = blocks.findIndex((block) => block.includes('on it'));
    expect(blocks.indexOf(holder ?? '')).toBe(text - 1);
    expect(blocks[text]).toContain('<w:sectPr><w:pgSz w:w="6000" w:h="6000"/>');
  });

  /** A coloured band with rounded corners (curves, so it is a drawing), 130 pt wide and 70 pt high. */
  const band = (x: number, y: number) =>
    [
      '0.1 0.3 0.7 rg',
      `${x + 8} ${y} m ${x + 122} ${y} l ${x + 130} ${y} ${x + 130} ${y} ${x + 130} ${y + 8} c`,
      `${x + 130} ${y + 62} l ${x + 130} ${y + 70} ${x + 130} ${y + 70} ${x + 122} ${y + 70} c`,
      `${x + 8} ${y + 70} l ${x} ${y + 70} ${x} ${y + 70} ${x} ${y + 62} c`,
      `${x} ${y + 8} l ${x} ${y} ${x} ${y} ${x + 8} ${y} c f`,
    ].join('\n');

  /** A card: a band with a white title and a value on it. */
  const card = (x: number, y: number, title: string, value: string) => [
    band(x, y),
    line('courier', 10, x + 8, y + 52, title, '1 1 1'),
    line('courier', 10, x + 8, y + 28, value, '1 1 1'),
  ];

  it('puts the text of cards that stand side by side on their own cards, in a flow that lays the right card after the left one', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(50, 470, 'Panel'),
          ...card(40, 360, 'Aylik Gelir', '12.480'),
          ...card(220, 360, 'Destek', '37'),
          ...card(40, 260, 'Sunucu', '99.9'),
          ...card(220, 260, 'Hata', '0.2'),
          courier(50, 120, 'after the cards'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const { pictures, texts } = flowOf(await documentXml(file.bytes));
    expect(pictures).toHaveLength(4);
    // The title and the value of a card are where the PDF has them on it: 18 and 42 pt under its top,
    // less the ascent, to the point its holder takes.
    const onCard = (x: number, title: string, value: string) => {
      const [first, second] = [title, value].map((name) => texts.get(name) ?? Number.NaN);
      const at = (text: number | undefined, top: number, down: number) =>
        Math.abs((text ?? Number.NaN) - top - (down - ASCENT)) <= 1.1;
      expect(
        pictures.some((entry) => entry.x === x && at(first, entry.top, 18) && at(second, entry.top, 42)),
      ).toBe(true);
    };
    onCard(40, 'Aylik Gelir', '12.480');
    onCard(220, 'Destek', '37');
    onCard(40, 'Sunucu', '99.9');
    onCard(220, 'Hata', '0.2');
    // The last text is under every card.
    const foot = Math.max(...pictures.map((entry) => entry.top + entry.height));
    expect(texts.get('after the cards') ?? 0).toBeGreaterThanOrEqual(foot - 0.1);
  });

  it('keeps the text after two drawings side by side under the taller one, whichever is first', async () => {
    const drawings = (left: boolean) => {
      const tall = [circle(105, 290, 95), courier(80, 365, 'LA1'), courier(80, 345, 'LA2')];
      const short = [circle(285, 340, 35), courier(270, 355, 'RB1'), courier(270, 335, 'RB2')];
      // The taller drawing is 115..305 pt from the top; the text is 5 pt under its foot.
      return [...(left ? [...tall, ...short] : [...short, ...tall]), courier(40, 181, 'after the cards')];
    };
    for (const left of [true, false]) {
      const bytes = await officeDocument([{ content: drawings(left).join('\n') }]);
      const { file } = await exportOffice(bytes, docxOptions, run);
      const { pictures, texts } = flowOf(await documentXml(file.bytes));
      expect(pictures).toHaveLength(2);
      const tallest = pictures.find((entry) => entry.height === 190);
      expect(tallest).toBeDefined();
      const foot = (tallest?.top ?? 0) + 190;
      // At or under the tallest drawing's foot, a clamped gap away from it.
      expect(texts.get('after the cards') ?? 0).toBeGreaterThanOrEqual(foot);
      expect(texts.get('after the cards') ?? 0).toBeLessThanOrEqual(foot + 48 + 1.1);
      // Each drawing keeps its labels on it, 10 and 30 pt under its top.
      for (const [card, names] of [
        [tallest, ['LA1', 'LA2']],
        [pictures.find((entry) => entry.height === 70), ['RB1', 'RB2']],
      ] as const) {
        names.forEach((name, row) => {
          near((texts.get(name) ?? 0) - (card?.top ?? 0), 10 + row * 20 + 0.7);
        });
      }
    }
  });

  it('keeps the text after three drawings in a row under the tallest, and each label on its own drawing', async () => {
    // Three cards 100 pt apart: 90, 190 and 120 pt tall, the tallest in the middle, two labels each.
    const card = (x: number, height: number, name: string) => [
      circle(x + height / 2, 500 - 120 - height / 2, height / 2),
      courier(x + height / 2 - 12, 500 - 140, `${name}1`),
      courier(x + height / 2 - 12, 500 - 160, `${name}2`),
    ];
    const bytes = await officeDocument([
      {
        size: [700, 500],
        content: [
          ...card(10, 90, 'A'),
          ...card(120, 190, 'B'),
          ...card(330, 120, 'C'),
          courier(40, 500 - 320, 'after the cards'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const { pictures, texts } = flowOf(await documentXml(file.bytes));
    expect(pictures.map((entry) => entry.height)).toEqual([90, 190, 120]);
    const [first, second, third] = pictures;
    // The labels sit where the PDF has them, 20 and 40 pt under the top of a card (less the ascent).
    for (const [name, card] of [
      ['A', first],
      ['B', second],
      ['C', third],
    ] as const) {
      near((texts.get(`${name}1`) ?? 0) - (card?.top ?? 0), 140 - 120 - ASCENT);
      near((texts.get(`${name}2`) ?? 0) - (card?.top ?? 0), 160 - 120 - ASCENT);
    }
    const foot = (second?.top ?? 0) + 190;
    expect(texts.get('after the cards') ?? 0).toBeGreaterThanOrEqual(foot);
    expect(texts.get('after the cards') ?? 0).toBeLessThanOrEqual(foot + 48 + 1.1);
  });

  it("puts the text of the next column under a drawing, not over it, when it comes after the drawing's own text", async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(40, 470, 'Intro'),
          circle(100, 120, 60),
          courier(80, 160, 'Chart'),
          ...Array.from({ length: 3 }, (_, index) =>
            courier(230, 470 - index * 14, `Right line ${index + 1}`),
          ),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const { pictures, texts } = flowOf(await documentXml(file.bytes));
    expect(pictures).toHaveLength(1);
    expect(texts.get('Chart') ?? 0).toBeGreaterThan(pictures[0]?.top ?? 0);
    expect(texts.get('Right line 1 Right line 2 Right line 3') ?? 0).toBeGreaterThanOrEqual(
      (pictures[0]?.top ?? 0) + 120,
    );
  });

  it('keeps a photograph on a full-page background, and the text under it, on one page', async () => {
    const bytes = await officeDocument([
      {
        images: { Im1: red },
        content: [
          picture('Im1', 0, 0, 400, 500),
          courier(40, 470, 'Title'),
          // 200 x 100 pt, 70..170 pt from the top, with a caption on it.
          picture('Im1', 100, 330, 200, 100),
          courier(110, 410, 'Caption'),
          courier(40, 150, 'Body one'),
          courier(40, 100, 'Body two'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const document = await documentXml(file.bytes);
    const { pictures, texts, end } = flowOf(document);
    const photo = pictures.find((entry) => entry.width === 200);
    expect(pictures).toHaveLength(2);
    expect(document).not.toContain('<w:pageBreakBefore/>');
    expect(end).toBeLessThanOrEqual(500 - 18);
    expect(texts.get('Body one') ?? 0).toBeGreaterThanOrEqual((photo?.top ?? 0) + 100);
    expect(texts.get('Body two') ?? 0).toBeGreaterThan(texts.get('Body one') ?? 0);
  });

  /** A drawing (a picture) with labels on it, or a line of text, laid out on a 400 x 500 pt page. */
  type Part =
    | {
        drawing: { x: number; top: number; w: number; h: number };
        labels?: [string, number, number][];
        /** What is drawn, when it is not the drawing itself: pictures that touch are one drawing. */
        drawn?: [number, number, number, number][];
      }
    | { text: string; x: number; top: number };
  const cardsPage = (parts: readonly Part[]) =>
    parts.flatMap((part) =>
      'drawing' in part
        ? [
            ...(part.drawn ?? [[part.drawing.x, part.drawing.top, part.drawing.w, part.drawing.h]]).map(
              ([x, top, w, h]) => picture('Im1', x, 500 - top - h, w, h),
            ),
            ...(part.labels ?? []).map(([text, dx, dy]) =>
              courier(part.drawing.x + dx, 490.7 - part.drawing.top - dy, text),
            ),
          ]
        : [courier(part.x, 490.7 - part.top, part.text)],
    );
  const drawing = (
    x: number,
    top: number,
    w: number,
    h: number,
    ...labels: [string, number, number][]
  ): Part => ({
    drawing: { x, top, w, h },
    labels,
  });
  const say = (text: string, x: number, top: number): Part => ({ text, x, top });

  /** Arrangements of drawings and text, and what the flow must keep of each. */
  const ARRANGEMENTS: Record<string, Part[]> = {
    single: [
      say('Heading', 40, 30),
      drawing(100, 100, 200, 100, ['Label A1', 10, 10], ['Label A2', 10, 40]),
      say('After single', 40, 240),
      say('Far after', 40, 320),
    ],
    'two side by side, the left one taller': [
      drawing(10, 100, 100, 160, ['Left 1', 10, 10], ['Left 2', 10, 30]),
      drawing(200, 110, 100, 60, ['Right 1', 10, 10], ['Right 2', 10, 30]),
      say('After the pair', 40, 280),
    ],
    'two side by side, the right one taller': [
      drawing(10, 100, 100, 60, ['Left 1', 10, 10], ['Left 2', 10, 30]),
      drawing(200, 110, 100, 160, ['Right 1', 10, 10], ['Right 2', 10, 30]),
      say('After the pair', 40, 290),
    ],
    'three in a row': [
      drawing(10, 100, 90, 90, ['One 1', 10, 10], ['One 2', 10, 30]),
      drawing(110, 100, 90, 190, ['Two 1', 10, 10], ['Two 2', 10, 30]),
      drawing(210, 100, 90, 120, ['Three 1', 10, 10], ['Three 2', 10, 30]),
      say('After the three', 40, 310),
    ],
    'two rows of two cards': [
      drawing(10, 100, 150, 80, ['Card A1', 10, 10], ['Card A2', 10, 40]),
      drawing(200, 110, 150, 70, ['Card B1', 10, 10], ['Card B2', 10, 40]),
      drawing(10, 200, 150, 80, ['Card C1', 10, 10], ['Card C2', 10, 40]),
      drawing(200, 210, 150, 70, ['Card D1', 10, 10], ['Card D2', 10, 40]),
      say('After the grid', 40, 320),
    ],
    'two stacked': [
      drawing(100, 80, 200, 70, ['Upper 1', 10, 10], ['Upper 2', 10, 40]),
      drawing(100, 170, 200, 70, ['Lower 1', 10, 10], ['Lower 2', 10, 40]),
      say('After the stack', 40, 260),
    ],
    'a photograph with a caption on a full-page background': [
      drawing(0, 0, 400, 500, ['Title', 40, 20]),
      drawing(100, 70, 200, 100, ['Caption', 10, 10]),
      say('Body one', 40, 341),
      say('Body two', 40, 391),
    ],
    'a photograph with no text on a full-page background': [
      drawing(0, 0, 400, 500, ['Title', 40, 20]),
      drawing(100, 70, 200, 100),
      say('Body one', 40, 341),
      say('Body two', 40, 391),
    ],
    'two cards on a full-page background': [
      drawing(0, 0, 400, 500, ['Title', 40, 20]),
      drawing(30, 100, 150, 120, ['Card A1', 10, 10], ['Card A2', 10, 40]),
      drawing(220, 110, 150, 80, ['Card B1', 10, 10], ['Card B2', 10, 40]),
      say('Body text', 40, 300),
    ],
    'a drawing with no text on it': [
      say('Before', 40, 30),
      drawing(100, 100, 200, 80),
      say('After', 40, 220),
    ],
    // Pictures that overlap are one drawing, the union of both, whose labels belong to it.
    'two pictures that overlap': [
      {
        drawing: { x: 40, top: 100, w: 240, h: 200 },
        labels: [
          ['Back 1', 10, 10],
          ['Back 2', 10, 40],
          ['Front 1', 200, 70],
          ['Front 2', 200, 100],
        ],
        drawn: [
          [40, 100, 160, 150],
          [120, 150, 160, 150],
        ],
      },
      say('After the overlap', 40, 320),
    ],
  };

  for (const [name, parts] of Object.entries(ARRANGEMENTS)) {
    it(`keeps the labels on their drawings, the text out of foreign ones and the page one page long: ${name}`, async () => {
      const bytes = await officeDocument([{ images: { Im1: red }, content: cardsPage(parts).join('\n') }]);
      const { file } = await exportOffice(bytes, docxOptions, run);
      const { pictures, texts, end } = flowOf(await documentXml(file.bytes));
      const failures: string[] = [];
      const drawings = parts.flatMap((part) => ('drawing' in part ? [part] : []));
      const lines = [
        ...parts.flatMap((part) =>
          'drawing' in part
            ? (part.labels ?? []).map(([text, dx, dy]) => ({
                text,
                x: part.drawing.x + dx,
                top: part.drawing.top + dy,
              }))
            : [part],
        ),
      ];
      // The drawings of one size and place are told apart by their order down the page.
      const flowOfDrawing = (entry: (typeof drawings)[number]) => {
        const same = (a: { x: number; w: number; h: number }, b: { x: number; w: number; h: number }) =>
          a.w === b.w && a.h === b.h && Math.abs(a.x - b.x) <= 1;
        const rank = drawings.filter(
          (other) => same(other.drawing, entry.drawing) && other.drawing.top < entry.drawing.top,
        ).length;
        return pictures
          .filter((candidate) =>
            same({ ...candidate, w: candidate.width, h: candidate.height }, entry.drawing),
          )
          .sort((a, b) => a.top - b.top)[rank];
      };
      // Every drawing is there, and every line of text.
      for (const entry of drawings) {
        if (flowOfDrawing(entry) === undefined)
          failures.push(`no picture at ${entry.drawing.x},${entry.drawing.top}`);
      }
      for (const line of lines) if (!texts.has(line.text)) failures.push(`no text ${line.text}`);
      const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
      for (const entry of drawings) {
        const at = flowOfDrawing(entry);
        if (at === undefined) continue;
        const { x, top, w, h } = entry.drawing;
        for (const [text, , dy] of entry.labels ?? []) {
          const label = (texts.get(text) ?? Number.NaN) - at.top;
          if (Math.abs(label - dy) > 1.1)
            failures.push(`${text} is ${label.toFixed(1)} under its drawing, not ${dy}`);
        }
        for (const line of lines) {
          const flowTop = texts.get(line.text);
          if (flowTop === undefined) continue;
          const width = line.text.length * 6;
          const onIt =
            line.x + width / 2 >= x &&
            line.x + width / 2 <= x + w &&
            line.top + LINE / 2 >= top &&
            line.top + LINE / 2 <= top + h;
          if (onIt) continue;
          const across = overlap(line.x, line.x + width, x, x + w) > 1;
          // Not on the drawing: it keeps off it in the flow...
          if (across && overlap(flowTop, flowTop + LINE, at.top, at.top + h) > 1.1) {
            failures.push(`${line.text} is inside the drawing at ${x},${top}`);
          }
          // ...and under it when it is under it on the page, above it when it is above.
          if (across && line.top >= top + h - 1 && flowTop < at.top + h - 1.1)
            failures.push(`${line.text} is not under the drawing at ${x},${top}`);
          if (across && line.top + LINE <= top + 1 && flowTop + LINE > at.top + 1.1)
            failures.push(`${line.text} is not above the drawing at ${x},${top}`);
        }
        for (const other of drawings) {
          const beside = flowOfDrawing(other);
          const apart =
            overlap(x, x + w, other.drawing.x, other.drawing.x + other.drawing.w) <= 0 ||
            overlap(top, top + h, other.drawing.top, other.drawing.top + other.drawing.h) <= 0;
          if (
            other !== entry &&
            apart &&
            beside !== undefined &&
            overlap(at.x, at.x + w, beside.x, beside.x + other.drawing.w) > 0 &&
            overlap(at.top, at.top + h, beside.top, beside.top + other.drawing.h) > 1.1
          ) {
            failures.push(
              `the drawings at ${x},${top} and ${other.drawing.x},${other.drawing.top} overlap in the flow`,
            );
          }
        }
      }
      // Gaps stay clamped: between two lines, 48 pt, or what the PDF has, or a foot under the first.
      const ordered = lines
        .map((line) => ({ ...line, flowTop: texts.get(line.text) ?? Number.NaN }))
        .sort((a, b) => a.flowTop - b.flowTop);
      ordered.slice(1).forEach((next, index) => {
        const previous = ordered[index] as (typeof ordered)[number];
        const gap = next.flowTop - (previous.flowTop + LINE);
        const foot = Math.max(
          0,
          ...pictures.map((entry) => entry.top + entry.height - (previous.flowTop + LINE)),
        );
        const pdfGap = Math.abs(next.top - (previous.top + LINE));
        if (gap > Math.max(48, pdfGap) + foot + 1.1)
          failures.push(`a gap of ${gap.toFixed(1)} between ${previous.text} and ${next.text}`);
      });
      if (end > 500 - 18) failures.push(`the flow ends at ${end.toFixed(1)}, off the page`);
      expect(failures).toEqual([]);
    });
  }

  it('keeps a stamp over a corner of two lines of a paragraph where it is read, inline, not behind the last item of the page', async () => {
    const bytes = await officeDocument([
      {
        images: { Im1: red },
        content: [
          ...[470, 458, 446, 434].map((y, index) =>
            courier(50, y, `Line ${index + 1} of a paragraph that runs on across the page`),
          ),
          // 40 x 30 pt over the start of the second and third lines: a tenth of the paragraph.
          picture('Im1', 50, 440, 40, 30),
          courier(50, 100, 'Last line of the page'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const document = await documentXml(file.bytes);
    expect(document).not.toContain('<wp:anchor');
    const blocks = bodyBlocks(document).filter((block) => block.startsWith('<w:p>'));
    const at = blocks.findIndex((block) => block.includes('<wp:inline'));
    expect(blocks[at - 1]).toContain('Line 4');
    expect(blocks[at + 1]).toContain('Last line of the page');
  });

  it('keeps the gaps of a two-column page whose left column holds a labelled drawing, so the page is one page long', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(40, 470, 'Intro'),
          // A 120 pt drawing, 320..440 pt from the top, with its label.
          circle(100, 120, 60),
          courier(80, 120, 'Chart'),
          // The right column: eleven lines at the top of the page.
          ...Array.from({ length: 11 }, (_, index) =>
            courier(230, 470 - index * 14, `Right line ${index + 1}`),
          ),
          courier(40, 30, 'Footer'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const { pictures, texts, end } = flowOf(await documentXml(file.bytes));
    expect(pictures).toHaveLength(1);
    // The whole flow ends inside the page, above its bottom margin: one page.
    expect(end).toBeLessThanOrEqual(500 - 18);
    expect(texts.get('Footer') ?? 0).toBeGreaterThanOrEqual((pictures[0]?.top ?? 0) + 120 - 1.1);
  });

  it('draws a picture inline, before its text, when the text on it is not one run in the flow, so that no text lands on white paper', async () => {
    const bytes = await officeDocument([
      {
        content: [
          // The reading order is: left top, right top, left bottom, right bottom.
          band(40, 360),
          band(220, 360),
          line('courier', 10, 48, 412, 'LT', '1 1 1'),
          line('courier', 10, 228, 412, 'RT', '1 1 1'),
          line('courier', 10, 48, 372, 'LB', '1 1 1'),
          line('courier', 10, 228, 372, 'RB', '1 1 1'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const document = await documentXml(file.bytes);
    expect(await paragraphs(file.bytes)).toEqual(['LT', 'RT', 'LB', 'RB']);
    expect(document).toContain('<wp:inline');
    expect(document).not.toContain('<wp:anchor');
  });

  it('shrinks a picture that fills the page so that it fits it with its line, instead of sending it to a page of its own', async () => {
    const bytes = await officeDocument([
      { size: [300, 400], images: { Im1: red }, content: picture('Im1', 20, 18, 260, 364) },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const document = await documentXml(file.bytes);
    const [[width = 0, height = 0] = []] = [...document.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map(
      (match) => [Number(match[1]) / 12700, Number(match[2]) / 12700],
    );
    const margins = /w:top="(\d+)" w:right="\d+" w:bottom="(\d+)"/.exec(document);
    const room = 400 - (Number(margins?.[1]) + Number(margins?.[2])) / 20;
    // Room for the picture and the line it stands in, and the proportions kept.
    expect(height).toBeLessThan(room - 4);
    expect(width / height).toBeCloseTo(260 / 364, 2);
  });
});

describe('exportOffice → DOCX text in rows and tables', () => {
  it('writes the text of a table drawn inside another table once, in the inner one', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(58, 420, 'Dis1'),
          courier(158, 420, 'Dis2'),
          courier(58, 370, 'Dis3'),
          courier(158, 370, 'Dis4'),
          courier(258, 370, 'Dis5'),
          // A small grid inside the first cell of the large one.
          courier(60, 396, 'Ic1'),
          courier(100, 396, 'Ic2'),
          courier(60, 384, 'Ic3'),
          courier(100, 384, 'Ic4'),
          gridOperators([50, 150, 250, 350], [440, 410, 350]),
          gridOperators([55, 95, 135], [400, 390, 380]),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const words = (await paragraphs(file.bytes)).flatMap((text) => text.split(' '));
    for (const word of ['Dis1', 'Dis2', 'Dis3', 'Dis4', 'Dis5', 'Ic1', 'Ic2', 'Ic3', 'Ic4']) {
      expect(
        words.filter((found) => found === word),
        word,
      ).toHaveLength(1);
    }
  });

  it('writes the text of a ruled table once when a table read from spacing runs across it', async () => {
    const bytes = await officeDocument([
      {
        content: [
          // Rows of two pieces far apart, read as a table from their spacing...
          courier(50, 470, 'Ad'),
          courier(350, 470, 'Soyad'),
          courier(50, 458, 'Ali'),
          courier(350, 458, 'Veli'),
          courier(50, 446, 'Ayse'),
          courier(350, 446, 'Fatma'),
          // ...with a ruled table standing between them, inside the rows' span.
          courier(158, 455, 'Sag1'),
          courier(208, 455, 'Sag2'),
          courier(158, 441, 'Sag3'),
          courier(208, 441, 'Sag4'),
          gridOperators([150, 200, 250], [466, 452, 438]),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const words = (await paragraphs(file.bytes)).flatMap((text) => text.split(' '));
    for (const word of ['Ad', 'Soyad', 'Ali', 'Veli', 'Ayse', 'Fatma', 'Sag1', 'Sag2', 'Sag3', 'Sag4']) {
      expect(
        words.filter((found) => found === word),
        word,
      ).toHaveLength(1);
    }
  });

  it('keeps a line and the leader dots set after it, each dot a text of its own, as one line of one paragraph', async () => {
    const dots = Array.from({ length: 6 }, (_unused, index) => courier(135 + index * 12, 400, '.'));
    const bytes = await officeDocument([
      {
        content: [
          courier(50, 430, 'Toplam tutar'),
          courier(50, 400, 'Vergi dairesi'),
          ...dots,
          courier(50, 370, 'Son satir'),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    expect(await paragraphs(file.bytes)).toEqual(['Toplam tutar', 'Vergi dairesi . . . . . .', 'Son satir']);
  });

  it('joins the pieces that stand on one row into one line, in a paragraph and in a table cell, whatever order they come in', async () => {
    // Each piece is a text of its own, a gap apart: MuPDF takes each for a line.
    const bytes = await officeDocument([
      {
        content: [
          courier(50, 430, 'Vergi'),
          courier(95, 430, 'dairesi '),
          courier(150, 430, '. '),
          courier(180, 430, '.'),
          // The pieces of one cell, the second given first.
          courier(85, 405, 'Soyad'),
          courier(58, 405, 'Ad'),
          courier(58, 375, 'Alt'),
          courier(258, 405, 'Sag'),
          gridOperators([50, 250, 350], [420, 390, 360]),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const found = await paragraphs(file.bytes);
    expect(found).toContain('Vergi dairesi . .');
    expect(found).toContain('Ad Soyad');
  });

  it('puts a character whose centre lies a hair outside a table into the cell it is next to', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(58, 405, 'Ad'),
          courier(158, 405, 'Soyad'),
          // Six points wide, its centre 0.5 pt left of the table's frame.
          courier(46.5, 405, 'x'),
          gridOperators([50, 150, 250], [420, 390, 360]),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const words = (await paragraphs(file.bytes)).flatMap((text) => text.split(' '));
    expect(words.filter((word) => word === 'x')).toHaveLength(1);
    expect(words).toEqual(expect.arrayContaining(['Ad', 'Soyad']));
  });

  it('splits the text of two neighbouring cells that one line reads across the rule between them, never through a word', async () => {
    const bytes = await officeDocument([
      {
        content: [
          // One text with one space (94..100 pt) across the rule at 100 pt: no gap wide enough to cut it.
          courier(70, 405, 'Ad12 Soyad'),
          courier(58, 375, 'x1'),
          courier(108, 375, 'y1'),
          gridOperators([50, 100, 150], [420, 390, 360]),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const table = bodyBlocks(await documentXml(file.bytes)).find((block) => block.startsWith('<w:tbl>'));
    const texts = tableRows(table ?? '')
      .flat()
      .map((cell) => cell.paragraphs.map(([, text]) => text).join(' '));
    expect(texts).toEqual(['Ad12', 'Soyad', 'x1', 'y1']);
  });

  it('keeps a word whole when a rule lies inside it', async () => {
    const bytes = await officeDocument([
      {
        content: [
          // 'Soyadi' (100..136 pt) has the rule at 118 pt inside it, not in a gap.
          courier(70, 405, 'Ad12 Soyadi'),
          courier(58, 375, 'x1'),
          courier(108, 375, 'y1'),
          gridOperators([50, 118, 150], [420, 390, 360]),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const found = await paragraphs(file.bytes);
    expect(found.join(' ')).toContain('Ad12 Soyadi');
  });

  it('never cuts a line of text through a word at the edge of a table: it goes whole to the table or whole outside', async () => {
    const bytes = await officeDocument([
      {
        content: [
          courier(58, 445, 'Ad'),
          courier(158, 445, 'Soyad'),
          // Mostly outside the table, its first words inside it...
          courier(200, 420, 'Sosyal guvenlik numarasi'),
          // ...and mostly inside, its last words outside.
          courier(130, 405, 'Kimlik numaraniz burada'),
          gridOperators([50, 150, 250], [460, 430, 400]),
        ].join('\n'),
      },
    ]);
    const { file } = await exportOffice(bytes, docxOptions, run);
    const found = await paragraphs(file.bytes);
    expect(found).toContain('Sosyal guvenlik numarasi');
    expect(found).toContain('Kimlik numaraniz burada');
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
