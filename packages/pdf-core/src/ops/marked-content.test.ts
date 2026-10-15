/**
 * The marked-content reader on content-stream text. The wrong answers that matter: a text entry of
 * a `BDC` dictionary that stays because a string inside the dictionary confused the reader (Word
 * writes `/ActualText<FEFF…>` right against the closing `>>`), an entry removed from a string, a
 * comment or an inline image that only looks like one, and bytes outside the removed entries that
 * change.
 */

import { describe, expect, it } from 'vitest';
import { scanMarkedContent } from './marked-content';

const STRIP: ReadonlySet<string> = new Set(['Alt', 'ActualText', 'E']);

/** Run the scanner on text; bytes are read and written as Latin-1 so the comparison is exact. */
function scan(stream: string) {
  const bytes = Uint8Array.from(stream, (character) => character.charCodeAt(0));
  const result = scanMarkedContent(bytes, STRIP);
  return {
    text: String.fromCharCode(...result.bytes),
    removed: result.removed,
    same: result.bytes === bytes,
  };
}

describe('scanMarkedContent', () => {
  it('removes a hex-string /ActualText written against the closing >> of the dictionary', () => {
    const result = scan('/Span <</ActualText<FEFF0041>>> BDC (x) Tj EMC');
    expect(result.text).toBe('/Span <<>> BDC (x) Tj EMC');
    expect(result.removed).toBe(1);
  });

  it('steps over strings that hold >>, ), and nested parentheses', () => {
    const result = scan('/Span <</MCID 0 /ActualText (a>>b\\) c (nest)) /Lang (en)>> BDC BT (Hi) Tj ET EMC');
    expect(result.text).toBe('/Span <</MCID 0  /Lang (en)>> BDC BT (Hi) Tj ET EMC');
    expect(result.removed).toBe(1);
  });

  it('removes /Alt, /ActualText and /E and keeps /MCID, /Lang and nested dictionaries', () => {
    const result = scan(
      '/Figure <</MCID 1/Alt(SECRET)/Lang(tr)/E (Expand)/Nested <</Alt (kept)>>/ActualText (x)>> BDC q Q EMC',
    );
    expect(result.text).toBe('/Figure <</MCID 1/Lang(tr)/Nested <</Alt (kept)>>>> BDC q Q EMC');
    expect(result.removed).toBe(3);
  });

  it('reads a DP point the same way', () => {
    const result = scan('/Span <</E (Expand) /MCID 2>> DP');
    expect(result.text).toBe('/Span << /MCID 2>> DP');
    expect(result.removed).toBe(1);
  });

  it('leaves a comment, a string and an inline image that look like marked content alone', () => {
    const stream = [
      '% /Span <</Alt (comment)>> BDC',
      '(a string with <</Alt (x)>> BDC) Tj',
      'BI /W 4 /H 4 /CS /G /BPC 8 ID \u0000\u0001 /Alt (x) <</Alt (y)>> BDC EI',
      '/Span <</Alt (real)>> BDC',
    ].join('\n');
    const result = scan(stream);
    expect(result.text).toBe(stream.replace('/Alt (real)', ''));
    expect(result.removed).toBe(1);
  });

  it('returns the very same bytes when there is nothing to remove', () => {
    const result = scan('q 1 0 0 1 0 0 cm /Span <</MCID 0>> BDC BT /F1 12 Tf (x) Tj ET EMC Q');
    expect(result.removed).toBe(0);
    expect(result.same).toBe(true);
  });

  it('cuts only what it finished reading when a string never closes', () => {
    const result = scan('/Span <</MCID 0 /Alt (gone)>> BDC /Span <</ActualText (unterminated');
    expect(result.text).toBe('/Span <</MCID 0 >> BDC /Span <</ActualText (unterminated');
    expect(result.removed).toBe(1);
  });

  it('reads a key written with #xx escapes as the name it spells', () => {
    const result = scan('/Span <</Al#74 (x) /Actual#54ext <FEFF0041>>> BDC');
    expect(result.text).toBe('/Span << >> BDC');
    expect(result.removed).toBe(2);
  });

  it('reads arrays whole, so a dictionary inside one is not mistaken for the property dictionary', () => {
    const result = scan('/Span <</Tags [1 (a]) <</Alt (kept)>> [2]] /Alt (gone)>> BDC');
    expect(result.text).toBe('/Span <</Tags [1 (a]) <</Alt (kept)>> [2]] >> BDC');
    expect(result.removed).toBe(1);
  });

  it('skips a key that is not a name and keeps pairing the entries behind it', () => {
    const result = scan('/Span <<(junk) 1 /Alt (gone)>> BDC');
    expect(result.text).toBe('/Span <<(junk) 1 >> BDC');
    expect(result.removed).toBe(1);
  });

  it('steps over stray delimiters, alone or as >>, outside any dictionary', () => {
    const result = scan(') > >> ] } { /Span <</Alt (x)>> BDC');
    expect(result.text).toBe(') > >> ] } { /Span <<>> BDC');
    expect(result.removed).toBe(1);
  });

  it('ends an inline image at the first EI that stands alone, and at the end of the stream without one', () => {
    // `EIx` is image data; `EI/` ends it because a delimiter follows.
    const closed = scan('BI /W 1 ID \u0000 EIx /Alt (y) EI/Span <</Alt (z)>> BDC');
    expect(closed.text).toBe('BI /W 1 ID \u0000 EIx /Alt (y) EI/Span <<>> BDC');
    expect(closed.removed).toBe(1);
    const open = scan('BI /W 1 ID \u0000 /Span <</Alt (z)>> BDC');
    expect(open.removed).toBe(0);
    expect(open.same).toBe(true);
  });

  it('reads a dictionary or array that stops short without removing what it did not finish', () => {
    for (const stream of ['/Span <</Alt', '/Span <</Alt (x)', '/Span <</Tags [1 2']) {
      const result = scan(stream);
      expect(result.removed, stream).toBe(0);
      expect(result.same, stream).toBe(true);
    }
  });

  it('gives up on nesting deeper than any real stream and leaves what follows as it was', () => {
    for (const opening of ['['.repeat(70), '<<'.repeat(70)]) {
      const result = scan(`${opening} /Span <</Alt (x)>> BDC`);
      expect(result.removed).toBe(0);
      expect(result.same).toBe(true);
    }
  });
});
