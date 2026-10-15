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
    const html = textToHtml(legacy);
    expect(html.parts[0]?.html).toBe('<pre class="text">Şiığ</pre>');
    expect(html.notes.map((entry) => entry.key)).toEqual(['op.note.convert.encoding']);
  });

  it('escapes markup in plain text', () => {
    const html = textToHtml(bytes('a < b & "c"')).parts[0]?.html;
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
    const { parts } = csvToHtml(bytes('﻿Ad;Tutar\nÇiğdem;12,5\nZeynep'), false);
    expect(parts[0]?.html).toBe(
      '<table class="sheet"><tr><th>Ad</th><th>Tutar</th></tr>' +
        '<tr><td>Çiğdem</td><td class="n">12,5</td></tr>' +
        '<tr><td>Zeynep</td><td></td></tr></table>',
    );
    const tsv = csvToHtml(bytes('a;b\tc\n1\t2'), true).parts[0]?.html;
    expect(tsv).toContain('<th>a;b</th><th>c</th>');
  });

  it('falls back to a comma when no line gives a field count to sniff from', () => {
    expect(sniffDelimiter('', null)).toBe(',');
    // A lone opening quote parses to no row at all, so no delimiter scores.
    expect(sniffDelimiter('"', null)).toBe(',');
  });

  it('notes a legacy-encoded CSV and decodes its Turkish letters', () => {
    // 0xDE = Ş in Windows-1254, which is not valid UTF-8.
    const { parts, notes } = csvToHtml(Uint8Array.from([0xde, 0x2c, 0x31]), false);
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
    const hundredThousand = refusal(() => csvToHtml(bytes(`x,y\n${','.repeat(100_000)}`), false));
    expect(hundredThousand).toMatchObject({
      code: 'file-too-large',
      details: { engine: 'model', engineMessage: `a CSV row has more than ${MAX_CSV_COLUMNS} fields` },
    });
    expect(refusal(() => csvToHtml(bytes(','.repeat(MAX_CSV_COLUMNS)), false))).toMatchObject({
      code: 'file-too-large',
    });
    // Exactly the limit is a table.
    const html = csvToHtml(bytes(','.repeat(MAX_CSV_COLUMNS - 1)), false).parts[0]?.html ?? '';
    expect(html.split('<th>').length - 1).toBe(MAX_CSV_COLUMNS);
  });

  it('refuses a CSV whose table (rows × widest row) is past the cell limit, and takes one at it', () => {
    // 20 000 rows of 101 fields: 2 020 000 cells.
    const tooMany = bytes(`a${',a'.repeat(100)}\n`.repeat(MAX_CSV_ROWS));
    expect(refusal(() => csvToHtml(tooMany, false))).toMatchObject({
      code: 'file-too-large',
      details: {
        engineMessage: `${MAX_CSV_ROWS} rows of 101 fields make more than ${MAX_CSV_CELLS} cells`,
      },
    });
    // 20 000 rows of 100 fields: 2 000 000 cells, exactly the limit.
    const atTheLimit = bytes(`a${',a'.repeat(99)}\n`.repeat(MAX_CSV_ROWS));
    const html = csvToHtml(atTheLimit, false).parts[0]?.html ?? '';
    expect(html.split('<tr>').length - 1).toBe(MAX_CSV_ROWS);
    expect(html.split('<td>').length - 1 + (html.split('<th>').length - 1)).toBe(MAX_CSV_CELLS);
  }, 60_000);

  it('judges the table that is kept: a wide row among the rows that were cut does not count', () => {
    const wideAfterTheCut = `${'a,b\n'.repeat(MAX_CSV_ROWS)}${','.repeat(MAX_CSV_COLUMNS * 2)}`;
    const { parts, notes } = csvToHtml(bytes(wideAfterTheCut), false);
    expect((parts[0]?.html ?? '').split('<tr>').length - 1).toBe(MAX_CSV_ROWS);
    expect(notes.map((entry) => entry.key)).toEqual(['op.note.convert.csvTruncated']);
  });

  it('keeps the first rows of an oversized CSV and says how many there were', () => {
    const { parts, notes } = csvToHtml(bytes('a,b\n'.repeat(MAX_CSV_ROWS + 1)), false);
    expect((parts[0]?.html ?? '').split('<tr>').length - 1).toBe(MAX_CSV_ROWS);
    expect(notes).toEqual([
      {
        kind: 'lost',
        key: 'op.note.convert.csvTruncated',
        params: { rows: MAX_CSV_ROWS, total: MAX_CSV_ROWS + 1 },
      },
    ]);
  });
});
