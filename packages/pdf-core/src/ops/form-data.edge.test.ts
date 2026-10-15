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

  it('keeps a value that is a name other than Yes and Off as text marked as a name, and reads checkboxes', () => {
    expect(
      parseFdf(
        fdf(
          [field('a', '/Choice'), field('b', '/Yes'), field('c', '/Off'), field('d', '(Choice)')].join(' '),
        ),
      ),
    ).toEqual([
      { name: 'a', value: 'Choice', stateName: 'Choice' },
      { name: 'b', value: true },
      { name: 'c', value: false },
      { name: 'd', value: 'Choice' },
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

/** A file's bytes from text in which every character is one byte: what a binary FDF is. */
const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

describe('an FDF as Acrobat writes it', () => {
  /** The shape of a real export: a binary comment line, direct field dictionaries, hex `/ID`. */
  const acrobat = (fields: string): Uint8Array =>
    latin1Bytes(
      `%FDF-1.2\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<</FDF<</F(form.pdf)/Fields[${fields}]/ID[<0123ABCD><4567EF01>]/UF(form.pdf)>>>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n`,
    );

  it('reads the values of a file whose /ID is a pair of hex strings, in bounded time', () => {
    const started = performance.now();
    const records = parseFdf(acrobat('<</T(name)/V(Ada)>><</T(agree)/V/On>><</T(tags)/V[(a)(b)]>>'));
    expect(records).toEqual([
      { name: 'name', value: 'Ada' },
      { name: 'agree', value: 'On', stateName: 'On' },
      { name: 'tags', value: ['a', 'b'] },
    ]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('reads thousands of UTF-16 values without slowing down', () => {
    const fields = Array.from({ length: 4000 }, (_, at) => `<</T(f${at})/V(\\376\\377\\000a\\001\\037)>>`);
    const started = performance.now();
    const records = parseFdf(acrobat(fields.join('')));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(records).toHaveLength(4000);
    expect(records[3999]).toEqual({ name: 'f3999', value: 'ağ' });
  });

  it('reads a field and its parents that the file writes as indirect objects', () => {
    const bytes = encode(
      '%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ 2 0 R ] >> >>\nendobj\n' +
        '2 0 obj\n<< /T (p) /Kids [ 3 0 R ] >>\nendobj\n3 0 obj\n<< /V (z) /T (c) >>\nendobj\n' +
        'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    );
    expect(parseFdf(bytes)).toEqual([{ name: 'p.c', value: 'z' }]);
  });
});

describe('stream bodies', () => {
  const words = (source: string) => tokenizePdfSource(source).map((token) => `${token.kind}:${token.text}`);

  it('are binary data: a ( or < in one starts no string, and the tokens go on after endstream', () => {
    expect(words('<</Length 9>>\nstream\nq (not closed << [ <4\nendstream\nendobj /After')).toEqual([
      'dict-open:<<',
      'name:Length',
      'name:9',
      'dict-close:>>',
      'name:stream',
      'name:endstream',
      'name:endobj',
      'name:After',
    ]);
  });

  it('end with the file when the stream is never closed', () => {
    expect(words('/A stream\n( << [ <4 unfinished')).toEqual(['name:A', 'name:stream']);
  });

  it('are only the bare word: /stream is a name and (stream) is a string', () => {
    expect(words('/stream (stream) <73747265616d> (x)')).toEqual([
      'name:stream',
      'string:stream',
      'string:stream',
      'string:x',
    ]);
  });
});

describe('FDF delimiters that start nothing, and hex strings', () => {
  it('moves past a lone >, a ) that closes nothing, and reads the fields around them', () => {
    expect(tokenizePdfSource('/A > /B ) /C').map((token) => `${token.kind}:${token.text}`)).toEqual([
      'name:A',
      'punct:>',
      'name:B',
      'punct:)',
      'name:C',
    ]);
    expect(parseFdf(fdf(`${field('a', '(x)')} > ) ${field('b', '(y)')}`))).toEqual([
      { name: 'a', value: 'x' },
      { name: 'b', value: 'y' },
    ]);
  });

  it('reads a hex string: white space ignored, a missing last digit taken as 0, UTF-16BE behind its BOM', () => {
    const text = (source: string) => tokenizePdfSource(source)[0];
    expect(text('<FEFF00C700FC>')).toEqual({ kind: 'string', text: 'Çü' });
    expect(text('<41 42\n43>')).toEqual({ kind: 'string', text: 'ABC' });
    expect(text('<414>')).toEqual({ kind: 'string', text: 'A@' });
    expect(text('<>')).toEqual({ kind: 'string', text: '' });
    expect(tokenizePdfSource('<</V<41>>>').map((token) => `${token.kind}:${token.text}`)).toEqual([
      'dict-open:<<',
      'name:V',
      'string:A',
      'dict-close:>>',
    ]);
  });

  it('reads /V <FEFF00C700FC> as the text "Çü" and a hex /T as a name', () => {
    expect(parseFdf(fdf('<< /T <61> /V <FEFF00C700FC> >>'))).toEqual([{ name: 'a', value: 'Çü' }]);
  });

  it('refuses a hex string that never ends, like a literal that never ends', () => {
    expect(() => tokenizePdfSource('/A <4142')).toThrowError(
      expect.objectContaining({
        code: 'corrupt-document',
        details: expect.objectContaining({ engineMessage: 'FDF hex string is not terminated' }),
      }),
    );
  });

  it('reads a string without a BOM as PDFDocEncoding: the byte 0x9A is "ı" and 0xA0 is the euro sign', () => {
    // The same four bytes written as raw bytes in a literal, as octal escapes and as hex.
    const fields = ['(\x9A\xA0\x80\xFC)', '(\\232\\240\\200\\374)', '<9AA080FC>'];
    const records = parseFdf(
      latin1Bytes(
        `%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ ${fields.map((value, at) => field(`f${at}`, value)).join(' ')} ] >> >>\nendobj\n`,
      ),
    );
    expect(records.map((record) => record.value)).toEqual(['ı€•ü', 'ı€•ü', 'ı€•ü']);
  });

  it('reads the PDFDocEncoding bytes below 0x20 that are accents: 0x18 is a breve, 0x1F a small tilde', () => {
    expect(tokenizePdfSource('<181F>')[0]).toEqual({ kind: 'string', text: '\u02d8\u02dc' });
  });

  it('decodes #xx in a name as UTF-8 and, where the bytes are not UTF-8, as Latin-1', () => {
    const records = parseFdf(
      latin1Bytes(
        `%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ ${[field('a', '/Caf#E9'), field('b', '/Caf#C3#A9')].join(' ')} ] >> >>\nendobj\n`,
      ),
    );
    expect(records.map((record) => record.value)).toEqual(['Café', 'Café']);
  });

  it('keeps a name written as text with characters outside Latin-1, and its #xx escapes', () => {
    expect(tokenizePdfSource('/A#20Ş😀')[0]).toEqual({ kind: 'name', text: 'A Ş😀' });
  });
});

describe('FDF fields as dictionaries', () => {
  it('reads /V before /T, as pdftk writes them', () => {
    expect(parseFdf(fdf('<< /V (b) /T (a) >>'))).toEqual([{ name: 'a', value: 'b' }]);
  });

  it('names a field under /Kids after its parent, at every level', () => {
    const records = parseFdf(
      fdf(
        [
          '<< /T (p) /Kids [ << /T (c) /V (z) >> ] >>',
          '<< /T (a) /Kids [ << /T (b) /Kids [ << /V (deep) /T (c) >> ] >> ] >>',
          '<< /T (own) /V (top) /Kids [ << /T (k) /V (kid) >> << /V (no name) >> ] >>',
          '<< /Kids [ << /T (orphan) /V (x) >> ] >>',
        ].join(' '),
      ),
    );
    expect(records).toEqual([
      { name: 'p.c', value: 'z' },
      { name: 'a.b.c', value: 'deep' },
      { name: 'own', value: 'top' },
      { name: 'own.k', value: 'kid' },
      { name: 'orphan', value: 'x' },
    ]);
  });

  it('reads the names a button value can be: /On, /1, /Evet, /Off, /Yes and an escaped name', () => {
    const records = parseFdf(
      fdf(
        ['/On', '/1', '/Evet', '/Off', '/Yes', '/Not#20Sure', '[ /a (b) ]']
          .map((value, at) => field(`f${at}`, value))
          .join(' '),
      ),
    );
    expect(records.map((record) => record.value)).toEqual([
      'On',
      '1',
      'Evet',
      false,
      true,
      'Not Sure',
      ['a', 'b'],
    ]);
  });

  it('skips what is not a key inside a field dictionary: a number, a string, a bare word', () => {
    expect(parseFdf(fdf('<< 7 /T (a) (junk) true /V (b) >>'))).toEqual([{ name: 'a', value: 'b' }]);
  });

  it('visits a field listed twice, or reached through its own /Kids, once, and skips a reference that leads nowhere', () => {
    const bytes = encode(
      '%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ 5 0 R 2 0 R 2 0 R << /T (ok) /V (v) >> 9 0 R ] >> >>\nendobj\n' +
        '2 0 obj\n<< /T (p) /V (x) /Kids [ 2 0 R ] >>\nendobj\n' +
        // A reference that refers to itself never resolves to an object.
        '5 0 obj 5 0 R endobj\n',
    );
    expect(parseFdf(bytes)).toEqual([
      { name: 'p', value: 'x' },
      { name: 'ok', value: 'v' },
    ]);
  });

  it('reads a file that ends right after "obj" as one with no /Fields', () => {
    expect(() => parseFdf(encode('%FDF-1.2\n1 0 obj'))).toThrowError(
      expect.objectContaining({
        code: 'corrupt-document',
        details: expect.objectContaining({ engineMessage: 'FDF file carries no /Fields array' }),
      }),
    );
  });

  it('reads no value from fields that have none, and says so with no records', () => {
    expect(parseFdf(fdf('<< /T (a) >> << /T (b) /V 5 >> << /T (c) /V << /K 1 >> >>'))).toEqual([]);
  });

  it('refuses a value nested deeper than any form is, instead of overflowing the stack', () => {
    const deep = `${'['.repeat(200)}${']'.repeat(200)}`;
    expect(() => parseFdf(fdf(`<< /T (a) /V ${deep} >>`))).toThrowError(
      expect.objectContaining({ code: 'corrupt-document' }),
    );
  });
});

describe('FDF button values written under the name of their own state', () => {
  it('writes a checkbox as its on-state, a radio as the selected widget state, and Off as /Off', () => {
    const bytes = serializeFdf([
      { name: 'on', value: true, stateName: 'On' },
      { name: 'off', value: false, stateName: 'On' },
      { name: 'one', value: true, stateName: '1' },
      { name: 'radio', value: 'Kırmızı', stateName: 'Not Sure' },
      { name: 'plain', value: true },
    ]);
    const source = new TextDecoder().decode(bytes);
    expect(source).toContain('/T (on) /V /On >>');
    expect(source).toContain('/T (off) /V /Off >>');
    expect(source).toContain('/T (one) /V /1 >>');
    expect(source).toContain('/T (radio) /V /Not#20Sure >>');
    expect(source).toContain('/T (plain) /V /Yes >>');
    expect(parseFdf(bytes)).toEqual([
      { name: 'on', value: 'On', stateName: 'On' },
      { name: 'off', value: false },
      { name: 'one', value: '1', stateName: '1' },
      { name: 'radio', value: 'Not Sure', stateName: 'Not Sure' },
      { name: 'plain', value: true },
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
