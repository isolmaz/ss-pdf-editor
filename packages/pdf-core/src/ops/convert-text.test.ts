/**
 * Text and CSV into HTML for the conversion: the decoding that must not turn `ş` into
 * mojibake (UTF-8 first, Windows-1254 when that fails, reported), and the CSV rules that
 * must not split a quoted field on its own delimiter or mistake a semicolon file for one
 * column.
 */

import { describe, expect, it } from 'vitest';
import {
  csvToHtml,
  decodeText,
  MAX_CSV_CELLS,
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
  parseCsv,
  sniffDelimiter,
  textToHtml,
} from './convert-text';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
/** An A4 line between 15 mm margins, in points. */
const LINE = 510;

/** `text` as UTF-16 behind a byte-order mark, the way Notepad and Excel's "Unicode Text" write it. */
function utf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let at = 0; at < text.length; at += 1) view.setUint16(2 + at * 2, text.charCodeAt(at), littleEndian);
  return out;
}

/** What `run` throws, or `null` when it returns. */
function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe('convert-text', () => {
  it('decodes UTF-8, and falls back to Windows-1254 with a note for legacy Turkish bytes', () => {
    expect(decodeText(bytes('Şişli çay ığ')).encoding).toBe('utf-8');
    // 0xDE = Ş, 0xFD = ı, 0xF0 = ğ in Windows-1254: invalid UTF-8.
    const legacy = Uint8Array.from([0xde, 0x69, 0xfd, 0xf0]);
    const decoded = decodeText(legacy);
    expect(decoded).toEqual({ text: 'Şiığ', encoding: 'windows-1254' });
    const html = textToHtml(legacy, LINE);
    expect(html.parts[0]?.html).toBe('<pre class="text">Şiığ</pre>');
    expect(html.notes.map((entry) => entry.key)).toEqual(['op.note.convert.encoding']);
  });

  it.each([
    [true, 'utf-16le', 'UTF-16 LE'],
    [false, 'utf-16be', 'UTF-16 BE'],
  ] as const)(
    'reads UTF-16 behind its byte-order mark (little endian: %s) and says so',
    (littleEndian, encoding, label) => {
      const text = 'Şişli çay ığ 😀';
      expect(decodeText(utf16(text, littleEndian))).toEqual({ text, encoding });
      const html = textToHtml(utf16(text, littleEndian), LINE);
      expect(html.parts[0]?.html).toBe(`<pre class="text">${text}</pre>`);
      expect(html.notes).toEqual([
        { kind: 'changed', key: 'op.note.convert.encoding', params: { encoding: label } },
      ]);
    },
  );

  it('reads a UTF-16 CSV, which is how Excel writes "Unicode Text", with its tab delimiter', () => {
    const { parts, notes } = csvToHtml(utf16('Ad\tTutar\nÇiğdem\t12,5', true), false, LINE);
    expect(parts[0]?.html).toBe(
      '<table class="sheet"><tr><th>Ad</th><th>Tutar</th></tr><tr><td>Çiğdem</td><td class="n">12,5</td></tr></table>',
    );
    expect(notes).toEqual([
      { kind: 'changed', key: 'op.note.convert.encoding', params: { encoding: 'UTF-16 LE' } },
    ]);
  });

  it('escapes markup in plain text', () => {
    const html = textToHtml(bytes('a < b & "c"'), LINE).parts[0]?.html;
    expect(html).toBe('<pre class="text">a &lt; b &amp; &quot;c&quot;</pre>');
  });

  it('parses RFC 4180 quoting: delimiter, doubled quote and line break inside a field', () => {
    expect(parseCsv('a,"b,1","say ""hi""","l1\nl2"\r\nx,y', ',')).toEqual([
      ['a', 'b,1', 'say "hi"', 'l1\nl2'],
      ['x', 'y'],
    ]);
  });

  it('sniffs the delimiter from the first lines', () => {
    expect(sniffDelimiter('ad;soyad;yaş\nAli;Veli;3', null)).toBe(';');
    expect(sniffDelimiter('a\tb\tc\n1\t2\t3', null)).toBe('\t');
    expect(sniffDelimiter('a,b,c\n1,2,3', null)).toBe(',');
    expect(sniffDelimiter('a;b', '\t')).toBe('\t');
  });

  it('builds one table: header cells, right-aligned numbers (comma decimals too), padded rows', () => {
    const { parts } = csvToHtml(bytes('﻿Ad;Tutar\nÇiğdem;12,5\nZeynep'), false, LINE);
    expect(parts[0]?.html).toBe(
      '<table class="sheet"><tr><th>Ad</th><th>Tutar</th></tr>' +
        '<tr><td>Çiğdem</td><td class="n">12,5</td></tr>' +
        '<tr><td>Zeynep</td><td></td></tr></table>',
    );
    const tsv = csvToHtml(bytes('a;b\tc\n1\t2'), true, LINE).parts[0]?.html;
    expect(tsv).toContain('<th>a;b</th><th>c</th>');
  });

  it('falls back to a comma when no line gives a field count to sniff from', () => {
    expect(sniffDelimiter('', null)).toBe(',');
    // A lone opening quote parses to no row at all, so no delimiter scores.
    expect(sniffDelimiter('"', null)).toBe(',');
  });

  it('notes a legacy-encoded CSV and decodes its Turkish letters', () => {
    // 0xDE = Ş in Windows-1254, which is not valid UTF-8.
    const { parts, notes } = csvToHtml(Uint8Array.from([0xde, 0x2c, 0x31]), false, LINE);
    expect(parts[0]?.html).toBe('<table class="sheet"><tr><th>Ş</th><th>1</th></tr></table>');
    expect(notes).toEqual([
      { kind: 'changed', key: 'op.note.convert.encoding', params: { encoding: 'Windows-1254' } },
    ]);
  });

  it('keeps at most one field past the column limit of a row, and none of the rest of it', () => {
    expect(parseCsv('a,b,c,d,e\n1,2', ',', 2)).toEqual([
      ['a', 'b', 'c'],
      ['1', '2'],
    ]);
    // No limit given: every field.
    expect(parseCsv('a,b,c,d,e', ',')).toEqual([['a', 'b', 'c', 'd', 'e']]);
  });

  it('refuses a CSV with a row wider than the column limit, however few its rows are', () => {
    // 100 001 fields: padded to every row of a long file, this was two billion cells.
    const hundredThousand = refusal(() => csvToHtml(bytes(`x,y\n${','.repeat(100_000)}`), false, LINE));
    expect(hundredThousand).toMatchObject({
      code: 'file-too-large',
      details: { engine: 'model', engineMessage: `a CSV row has more than ${MAX_CSV_COLUMNS} fields` },
    });
    expect(refusal(() => csvToHtml(bytes(','.repeat(MAX_CSV_COLUMNS)), false, LINE))).toMatchObject({
      code: 'file-too-large',
    });
    // Exactly the limit is a table.
    const html = csvToHtml(bytes(','.repeat(MAX_CSV_COLUMNS - 1)), false, LINE).parts[0]?.html ?? '';
    expect(html.split('<th>').length - 1).toBe(MAX_CSV_COLUMNS);
  });

  it('refuses a CSV whose table (rows × widest row) is past the cell limit, and takes one at it', () => {
    // 20 000 rows of 101 fields: 2 020 000 cells.
    const tooMany = bytes(`a${',a'.repeat(100)}\n`.repeat(MAX_CSV_ROWS));
    expect(refusal(() => csvToHtml(tooMany, false, LINE))).toMatchObject({
      code: 'file-too-large',
      details: {
        engineMessage: `${MAX_CSV_ROWS} rows of 101 fields make more than ${MAX_CSV_CELLS} cells`,
      },
    });
    // 20 000 rows of 100 fields: 2 000 000 cells, exactly the limit.
    const atTheLimit = bytes(`a${',a'.repeat(99)}\n`.repeat(MAX_CSV_ROWS));
    const html = csvToHtml(atTheLimit, false, LINE).parts[0]?.html ?? '';
    expect(html.split('<tr>').length - 1).toBe(MAX_CSV_ROWS);
    expect(html.split('<td>').length - 1 + (html.split('<th>').length - 1)).toBe(MAX_CSV_CELLS);
  }, 60_000);

  it('judges the table that is kept: a wide row among the rows that were cut does not count', () => {
    const wideAfterTheCut = `${'a,b\n'.repeat(MAX_CSV_ROWS)}${','.repeat(MAX_CSV_COLUMNS * 2)}`;
    const { parts, notes } = csvToHtml(bytes(wideAfterTheCut), false, LINE);
    expect((parts[0]?.html ?? '').split('<tr>').length - 1).toBe(MAX_CSV_ROWS);
    expect(notes.map((entry) => entry.key)).toEqual(['op.note.convert.csvTruncated']);
  });

  it('keeps the first rows of an oversized CSV and says how many there were', () => {
    const { parts, notes } = csvToHtml(bytes('a,b\n'.repeat(MAX_CSV_ROWS + 1)), false, LINE);
    expect((parts[0]?.html ?? '').split('<tr>').length - 1).toBe(MAX_CSV_ROWS);
    expect(notes).toEqual([
      {
        kind: 'lost',
        key: 'op.note.convert.csvTruncated',
        params: { rows: MAX_CSV_ROWS, total: MAX_CSV_ROWS + 1 },
      },
    ]);
  });

  describe('a run longer than the line', () => {
    // 57 pt is ten characters of the 9.5 pt monospace face, which advances 5.7 pt.
    const TEN = 57;
    const preOf = (text: string, lineWidth = TEN): string | undefined =>
      textToHtml(bytes(text), lineWidth).parts[0]?.html;

    it('is cut at what a line of text holds, leaving short words and the spaces between them', () => {
      expect(preOf('ab abcdefghijklmnopqrstuvwxyz  cd')).toBe(
        '<pre class="text">ab abcdefghij\nklmnopqrst\nuvwxyz  cd</pre>',
      );
    });

    it('is cut by characters, not by UTF-16 units, and each piece is escaped on its own', () => {
      expect(preOf('😀'.repeat(12))).toBe(`<pre class="text">${'😀'.repeat(10)}\n😀😀</pre>`);
      expect(preOf('&'.repeat(12))).toBe(`<pre class="text">${'&amp;'.repeat(10)}\n&amp;&amp;</pre>`);
    });

    it('is not cut inside ideographs, which MuPDF breaks between, only around them', () => {
      expect(preOf('一'.repeat(30))).toBe(`<pre class="text">${'一'.repeat(30)}</pre>`);
      expect(preOf(`${'x'.repeat(12)}一一一`)).toBe('<pre class="text">xxxxxxxxxx\nxx一一一</pre>');
    });

    it('takes the line from the page: a narrower line cuts sooner', () => {
      // 5.7 pt per character: 114 pt is 20 of them, 570 pt is 100.
      const lines = (lineWidth: number): number =>
        (preOf('a'.repeat(60), lineWidth) ?? '').split('\n').length;
      expect(lines(114)).toBe(3);
      expect(lines(570)).toBe(1);
    });

    it('is cut in a table cell with a line break, to the share of the line its column can have', () => {
      // 240 pt less the padding of two columns is 30 characters at 7.35 pt: the short column
      // needs 5, which leaves 25 for the long one.
      const { parts } = csvToHtml(bytes(`x;${'a'.repeat(100)}\nabcde;y`), false, 240);
      const quarters = Array.from({ length: 4 }, () => 'a'.repeat(25)).join('<br>');
      expect(parts[0]?.html).toBe(
        `<table class="sheet"><tr><th>x</th><th>${quarters}</th></tr><tr><td>abcde</td><td>y</td></tr></table>`,
      );
    });

    it('is left whole in a table that fits, and an ordinary word is left whole in one that does not', () => {
      const fits = csvToHtml(bytes(`x;${'a'.repeat(50)}`), false, LINE).parts[0]?.html;
      expect(fits).toBe(`<table class="sheet"><tr><th>x</th><th>${'a'.repeat(50)}</th></tr></table>`);
      // Sixty columns cannot fit 510 pt even with ten letters each, yet no word is chopped.
      const words = Array.from({ length: 60 }, () => 'abcdefghij').join(',');
      expect(csvToHtml(bytes(words), false, LINE).parts[0]?.html).not.toContain('<br>');
      // A run past the floor of 20 characters is still cut there.
      const runs = Array.from({ length: 60 }, () => 'a'.repeat(25)).join(',');
      expect(csvToHtml(bytes(runs), false, LINE).parts[0]?.html.split('<th>')[1]).toBe(
        `${'a'.repeat(20)}<br>aaaaa</th>`,
      );
    });

    it('allows a column its longest run even when a longer cell of short words comes after it', () => {
      // One column, 30 characters of line: the second cell is longer than the first's run of 30
      // but its longest run is 3, so the limit stays 30 and nothing is cut.
      const csv = `${'a'.repeat(30)}\n${'abc '.repeat(10)}`;
      expect(csvToHtml(bytes(csv), false, 240).parts[0]?.html).not.toContain('<br>');
    });
  });
});
