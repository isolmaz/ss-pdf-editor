/**
 * Form data interchange at its edges: string escapes as other producers write them (octal
 * escapes of one or two digits, a backslash before a character that needs none, text outside
 * Latin-1 in an unescaped literal), FDF whose fields are not the shape this writer produces, and
 * JSON whose entries are not either of the two shapes it accepts.
 */

import { describe, expect, it } from 'vitest';
import { parseFdf, parseFormJson, serializeFdf, serializeFormJson, tokenizePdfSource } from './form-data';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const fdf = (fields: string) =>
  encode(
    `%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ ${fields} ] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );
const field = (name: string, value: string) => `<< /T (${name}) /V ${value} >>`;

describe('FDF strings from other producers', () => {
  it('reads octal escapes of one, two and three digits', () => {
    // \53 is "+", \7 is the bell, \101 is "A"; a digit that follows three digits is text.
    const [record] = parseFdf(fdf(field('a', '(x\\53y\\7z\\1012)')));
    expect(record?.value).toBe('x+y\u0007zA2');
  });

  it('reads the escapes that stand for control characters and for delimiters', () => {
    const [record] = parseFdf(fdf(field('a', '(\\n\\r\\t\\b\\f\\(\\)\\\\)')));
    expect(record?.value).toBe('\n\r\t\b\f()\\');
  });

  it('drops a backslash before a character that needs no escape, as the PDF specification says', () => {
    expect(parseFdf(fdf(field('a', '(a\\qb)')))[0]?.value).toBe('aqb');
  });

  it('keeps a character outside Latin-1 that is written unescaped, instead of splitting it into two bytes', () => {
    const [token] = tokenizePdfSource('(Şişli ığ €)');
    expect(token).toEqual({ kind: 'string', text: 'Şişli ığ €' });
  });

  it('writes a carriage return in ASCII text as an escape, and reads it back', () => {
    const bytes = serializeFdf([{ name: 'a', value: 'one\r\ntwo' }]);
    expect(new TextDecoder().decode(bytes)).toContain('/V (one\\r\\ntwo)');
    expect(parseFdf(bytes)).toEqual([{ name: 'a', value: 'one\r\ntwo' }]);
  });

  it('reads a UTF-16 string that carries characters outside Latin-1 spelled out unescaped', () => {
    const [token] = tokenizePdfSource('(\\376\\377\\000a😀)');
    expect(token).toEqual({ kind: 'string', text: 'a😀' });
    expect(tokenizePdfSource('(\\376\\377\\000a€)')[0]).toEqual({ kind: 'string', text: 'a€' });
  });
});

describe('FDF fields that are not the shape this writer produces', () => {
  it('skips a /T that no string follows, a name with no /V after it, and a /V at the end of the file', () => {
    const records = parseFdf(
      encode(
        '%FDF-1.2\n1 0 obj << /FDF << /Fields [ << /T /Oops /V (a) >> << /T (b) /X (c) >> << /T (d) /V (e) >> << /T (f) /V',
      ),
    );
    expect(records).toEqual([{ name: 'd', value: 'e' }]);
  });

  it('keeps a value that is a name other than Yes and Off as that name, and reads checkboxes', () => {
    expect(parseFdf(fdf([field('a', '/Choice'), field('b', '/Yes'), field('c', '/Off')].join(' ')))).toEqual([
      { name: 'a', value: 'Choice' },
      { name: 'b', value: true },
      { name: 'c', value: false },
    ]);
  });

  it('skips a value that is a dictionary or a number, and arrays keep only strings and names', () => {
    const records = parseFdf(
      fdf(
        [
          field('a', '<< /K 1 >>'),
          field('b', '[ (x) /y << >> (z) ]'),
          field('c', '[ ]'),
          field('d', '(kept)'),
        ].join(' '),
      ),
    );
    expect(records).toEqual([
      { name: 'b', value: ['x', 'y', 'z'] },
      { name: 'c', value: [] },
      { name: 'd', value: 'kept' },
    ]);
  });

  it('refuses a file with the header and no /Fields, and accepts an empty /Fields array', () => {
    expect(() => parseFdf(encode('%FDF-1.2\n1 0 obj << >> endobj'))).toThrowError(
      expect.objectContaining({ code: 'corrupt-document' }),
    );
    expect(parseFdf(fdf(''))).toEqual([]);
  });

  it('refuses a string literal that never ends, and a file without the header', () => {
    expect(() => parseFdf(fdf('<< /T (open /V (x) >>'))).toThrowError(
      expect.objectContaining({ code: 'corrupt-document' }),
    );
    expect(() => parseFdf(encode('<< /Fields [] >>'))).toThrowError(
      expect.objectContaining({ code: 'unsupported-format' }),
    );
  });

  it('skips comments and reads names and numbers that nothing delimits', () => {
    const tokens = tokenizePdfSource('% a comment ( not a string\n/Name 12 [ ] << >> true');
    expect(tokens.map((token) => `${token.kind}:${token.text}`)).toEqual([
      'name:Name',
      'name:12',
      'array-open:[',
      'array-close:]',
      'dict-open:<<',
      'dict-close:>>',
      'name:true',
    ]);
  });
});

describe('form JSON', () => {
  it('skips entries that are not objects, have no text name, or have a value of no form field type', () => {
    expect(
      parseFormJson(
        JSON.stringify({
          fields: [
            null,
            'text',
            { name: 1, value: 'x' },
            { name: 'null', value: null },
            { name: 'object', value: { a: 1 } },
            { name: 'ok', value: 'v' },
            { name: 'n', value: 3 },
            { name: 'list', value: ['a', 1, 'b'] },
            { name: 'box', value: false },
          ],
        }),
      ),
    ).toEqual([
      { name: 'ok', value: 'v' },
      { name: 'n', value: '3' },
      { name: 'list', value: ['a', 'b'] },
      { name: 'box', value: false },
    ]);
  });

  it('reads a bare map and skips the values that are not form values', () => {
    expect(parseFormJson('{"a":"x","b":null,"c":true,"d":{"e":1},"f":7}')).toEqual([
      { name: 'a', value: 'x' },
      { name: 'c', value: true },
      { name: 'f', value: '7' },
    ]);
  });

  it('refuses text that is not JSON and JSON that is not an object', () => {
    expect(() => parseFormJson('{nope')).toThrowError(
      expect.objectContaining({ code: 'unsupported-format' }),
    );
    for (const text of ['null', '[1]', '"s"']) {
      expect(() => parseFormJson(text)).toThrowError(
        expect.objectContaining({
          details: expect.objectContaining({ engineMessage: 'form JSON must be an object' }),
        }),
      );
    }
  });

  it('writes compact or indented JSON that reads back', () => {
    const records = [
      { name: 'a', value: 'x' },
      { name: 'b', value: ['y', 'z'] },
      { name: 'c', value: true },
    ];
    const compact = new TextDecoder().decode(serializeFormJson(records));
    const pretty = new TextDecoder().decode(serializeFormJson(records, true));
    expect(compact).not.toContain('\n');
    expect(pretty).toContain('\n  ');
    expect(parseFormJson(compact)).toEqual(records);
    expect(parseFormJson(pretty)).toEqual(records);
  });
});
