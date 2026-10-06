/**
 * Text and CSV into HTML for the conversion: the decoding that must not turn `ş` into
 * mojibake (UTF-8 first, Windows-1254 when that fails, reported), and the CSV rules that
 * must not split a quoted field on its own delimiter or mistake a semicolon file for one
 * column.
 */

import { describe, expect, it } from 'vitest';
import { csvToHtml, decodeText, parseCsv, sniffDelimiter, textToHtml } from './convert-text';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

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
});
