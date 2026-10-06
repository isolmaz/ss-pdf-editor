/**
 * Form data interchange (FDF and JSON). The wrong answer that matters most is text:
 * non-ASCII must be written whole as UTF-16BE behind a BOM, because a writer that put
 * only the non-ASCII characters into an otherwise single-byte string read "gö" back as
 * "g\0ö". The rest: escaping that survives parentheses and backslashes, the checkbox and
 * array shapes, and a file that is not form data refused instead of read as empty.
 */

import { describe, expect, it } from 'vitest';
import { parseFdf, parseFormJson, serializeFdf, serializeFormJson } from './form-data';

const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('FDF', () => {
  it('writes Turkish text whole as UTF-16BE behind a BOM and reads it back unchanged', () => {
    const bytes = serializeFdf([
      { name: 'şehir', value: 'Şişli ığüöç' },
      { name: 'mixed', value: 'gö' },
    ]);
    const source = latin1(bytes);
    // `gö` is `\376\377` then g (0x0067) and ö (0x00F6), every byte an octal escape.
    expect(source).toContain('/V (\\376\\377\\000\\147\\000\\366)');
    expect(source).not.toContain('\0');
    expect(parseFdf(bytes)).toEqual([
      { name: 'şehir', value: 'Şişli ığüöç' },
      { name: 'mixed', value: 'gö' },
    ]);
  });

  it('keeps parentheses, backslashes and line breaks in ASCII text, and characters above the BMP', () => {
    const records = [
      { name: 'a', value: 'f(x) = \\ (nested (deep)) \n\ttab' },
      { name: 'emoji', value: 'ok 😀 çok' },
    ];
    expect(parseFdf(serializeFdf(records))).toEqual(records);
  });

  it('round-trips checkboxes as /Yes and /Off and multi-selects as arrays', () => {
    const records = [
      { name: 'agree', value: true },
      { name: 'newsletter', value: false },
      { name: 'colours', value: ['kırmızı', 'mavi'] },
    ];
    const bytes = serializeFdf(records);
    expect(latin1(bytes)).toContain('/V /Yes');
    expect(latin1(bytes)).toContain('/V /Off');
    expect(parseFdf(bytes)).toEqual(records);
  });

  it('reads a UTF-16BE string written by another producer and a plain Latin-1 octal escape', () => {
    const source =
      '%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ << /T (a) /V (\\376\\377\\001\\037) >> << /T (b) /V (\\374) >> ] >> >>\nendobj\n%%EOF\n';
    expect(parseFdf(new TextEncoder().encode(source))).toEqual([
      { name: 'a', value: 'ğ' },
      { name: 'b', value: 'ü' },
    ]);
  });

  it('refuses a file without the FDF header and an unterminated string', () => {
    expect(() => parseFdf(new TextEncoder().encode('%PDF-1.7\n'))).toThrow(/not an FDF/);
    expect(() => parseFdf(new TextEncoder().encode('%FDF-1.2\n<< /T (open /V (x) >>'))).toThrow(
      /not terminated/,
    );
  });
});

describe('form JSON', () => {
  it('round-trips records, Turkish text included', () => {
    const records = [
      { name: 'ad', value: 'Şükrü' },
      { name: 'ok', value: true },
      { name: 'pick', value: ['a', 'b'] },
    ];
    expect(parseFormJson(new TextDecoder().decode(serializeFormJson(records, true)))).toEqual(records);
  });

  it('accepts a bare name-to-value map, turns numbers into text and drops what it cannot hold', () => {
    expect(
      parseFormJson('{"a": "x", "n": 3, "list": ["p", 4], "nested": {"z": 1}, "nothing": null}'),
    ).toEqual([
      { name: 'a', value: 'x' },
      { name: 'n', value: '3' },
      { name: 'list', value: ['p'] },
    ]);
  });

  it('refuses text that is not JSON, and JSON that is not an object', () => {
    expect(() => parseFormJson('not json')).toThrow(/not parseable/);
    expect(() => parseFormJson('[1, 2]')).toThrow(/must be an object/);
  });
});
