/**
 * The content-stream lexer under the PDF/A colour rules: operators and operands in order, with
 * strings, comments and inline-image data never read as operators.
 */

import { describe, expect, it } from 'vitest';
import { nameOf, numberOf, type Operand, scanContent } from './pdfa-content';

const ascii = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'latin1'));

function scan(bytes: Uint8Array): { op: string; operands: readonly Operand[] }[] {
  const out: { op: string; operands: readonly Operand[] }[] = [];
  scanContent(bytes, (op, operands) => out.push({ op, operands }));
  return out;
}

describe('scanContent', () => {
  it('pairs each operator with its operands, in order', () => {
    const found = scan(ascii('/CS0 cs 0.5 -.25 +3 scn\nq 1 0 0 1 10 20 cm Q'));
    expect(found.map((entry) => entry.op)).toEqual(['cs', 'scn', 'q', 'cm', 'Q']);
    expect(nameOf(found[0]?.operands[0])).toBe('CS0');
    expect(found[1]?.operands.map(numberOf)).toEqual([0.5, -0.25, 3]);
    expect(found[3]?.operands.map(numberOf)).toEqual([1, 0, 0, 1, 10, 20]);
  });

  it('decodes #xx name escapes and keeps arrays and dictionaries as one operand', () => {
    const found = scan(ascii('/A#20B cs [1 [2] /N] 0 d <</K 1 /D <</X true>>>> gs'));
    expect(nameOf(found[0]?.operands[0])).toBe('A B');
    const array = found[1]?.operands[0];
    expect(array?.t).toBe('arr');
    if (array?.t === 'arr') {
      expect(array.items).toHaveLength(3);
      expect(array.items[1]?.t).toBe('arr');
    }
    const dictionary = found[2]?.operands[0];
    expect(dictionary?.t).toBe('dict');
    if (dictionary?.t === 'dict') expect([...dictionary.entries.keys()]).toEqual(['K', 'D']);
  });

  it('never reads an operator out of a string, a hex string or a comment', () => {
    const found = scan(ascii('BT (a (nested) Q f \\) still string) Tj <5120 66> Tj % 0 0 m S\nET'));
    expect(found.map((entry) => entry.op)).toEqual(['BT', 'Tj', 'Tj', 'ET']);
  });

  it('skips inline-image data, even when it looks like operators, and reports its dictionary', () => {
    const header = ascii('q BI /W 2 /H 1 /CS /RGB /BPC 8 ID ');
    const binary = Uint8Array.from([0x51, 0x20, 0x66, 0x20, 0xff, 0x00]); // "Q f " then raw bytes
    const tail = ascii('\nEI Q');
    const bytes = new Uint8Array(header.length + binary.length + tail.length);
    bytes.set(header);
    bytes.set(binary, header.length);
    bytes.set(tail, header.length + binary.length);

    const found = scan(bytes);
    expect(found.map((entry) => entry.op)).toEqual(['q', 'BI', 'Q']);
    const dictionary = found[1]?.operands[0];
    expect(dictionary?.t).toBe('dict');
    if (dictionary?.t === 'dict') {
      expect(nameOf(dictionary.entries.get('CS'))).toBe('RGB');
      expect(numberOf(dictionary.entries.get('W'))).toBe(2);
    }
  });

  it('ends the scan at an unclosed dictionary without producing an operator', () => {
    expect(scan(ascii('<</A 1 /B'))).toEqual([]);
    expect(scan(ascii(''))).toEqual([]);
  });

  it('caps nesting at 33 arrays: a 100000-deep nest neither overflows the stack nor loses the operators around it', () => {
    const depth = 100000;
    const found = scan(ascii(`q ${'['.repeat(depth)}${']'.repeat(33)} Q`));
    expect(found.map((entry) => entry.op)).toEqual(['q', 'Q']);
    // The 33 arrays the cap allows nest one inside the other; every deeper '[' is one null operand
    // inside the innermost, so the 33 closing brackets close exactly the arrays that were opened.
    let level: Operand | undefined = found[1]?.operands[0];
    let nested = 0;
    while (level?.t === 'arr' && level.items[0]?.t === 'arr') {
      nested += 1;
      level = level.items[0];
    }
    expect(nested).toBe(32);
    expect(found[1]?.operands).toHaveLength(1);
    if (level?.t !== 'arr') throw new Error('innermost level is not an array');
    expect(level.items).toHaveLength(depth - 33);
    expect(level.items.every((item) => item.t === 'null')).toBe(true);
  });

  it('skips a stray token inside a damaged dictionary and keeps the keys around it', () => {
    const found = scan(ascii('<</A 1 5 /B 2>> gs'));
    const dictionary = found[0]?.operands[0];
    expect(dictionary?.t).toBe('dict');
    if (dictionary?.t === 'dict') {
      expect([...dictionary.entries.keys()]).toEqual(['A', 'B']);
      expect(numberOf(dictionary.entries.get('B'))).toBe(2);
    }
  });

  it('ignores a keyword inside an array and ends an unterminated array at the end of the stream', () => {
    const closed = scan(ascii('[1 f 2] gs'));
    expect(closed[0]?.operands).toEqual([
      {
        t: 'arr',
        items: [
          { t: 'num', v: 1 },
          { t: 'num', v: 2 },
        ],
      },
    ]);
    const open = scan(ascii('[1 2 '));
    expect(open).toEqual([]);
  });

  it('reads a stray delimiter as a null operand, and true, false and null as their own operands', () => {
    const found = scan(ascii('1 ] 2 ) { } > m true false null d'));
    expect(found[0]?.op).toBe('m');
    expect(found[0]?.operands).toEqual([
      { t: 'num', v: 1 },
      { t: 'null' },
      { t: 'num', v: 2 },
      { t: 'null' },
      { t: 'null' },
      { t: 'null' },
      { t: 'null' },
    ]);
    expect(found[1]?.operands).toEqual([{ t: 'bool', v: true }, { t: 'bool', v: false }, { t: 'null' }]);
  });

  it('drops the oldest operands once a stream piles up more than 64 without an operator', () => {
    const numbers = Array.from({ length: 100 }, (_, index) => index + 1);
    const found = scan(ascii(`${numbers.join(' ')} m`));
    expect(found).toHaveLength(1);
    // 65th operand cuts to the last 32 (34..65); the 98th cuts again (67..98); two more arrive.
    expect(found[0]?.operands.map(numberOf)).toEqual(numbers.slice(66));
  });

  it('ends an inline image without whitespace after ID, and ignores EI that is glued to other bytes', () => {
    const found = scan(ascii('BI /W 1 ID(x) abEI EIx EI Q'));
    expect(found.map((entry) => entry.op)).toEqual(['BI', 'Q']);
  });

  it('survives an inline image that is cut off: at ID, inside its dictionary, or with a keyword where a value belongs', () => {
    expect(scan(ascii('BI /W 1 ID')).map((entry) => entry.op)).toEqual(['BI']);
    const unfinished = scan(ascii('BI /W 1 /H'));
    expect(unfinished.map((entry) => entry.op)).toEqual(['BI']);
    const noEnd = scan(ascii('BI /W 1 ID data without terminator'));
    expect(noEnd.map((entry) => entry.op)).toEqual(['BI']);
    // A stray delimiter between entries is stepped over; a keyword in place of a value leaves the key out.
    const stray = scan(ascii('BI /W 1 < /H 2 ID x EI Q'));
    expect(stray.map((entry) => entry.op)).toEqual(['BI', 'Q']);
    const strayDict = stray[0]?.operands[0];
    if (strayDict?.t !== 'dict') throw new Error('not a dictionary');
    expect([...strayDict.entries.keys()]).toEqual(['W', 'H']);
    const keyword = scan(ascii('BI /W ID abc EI'));
    const keywordDict = keyword[0]?.operands[0];
    expect(keyword.map((entry) => entry.op)).toEqual(['BI']);
    expect(keywordDict).toEqual({ t: 'dict', entries: new Map() });
  });

  it('returns null from numberOf and nameOf for an operand of the other kind or none at all', () => {
    expect(numberOf({ t: 'name', v: 'A' })).toBeNull();
    expect(numberOf(undefined)).toBeNull();
    expect(nameOf({ t: 'num', v: 1 })).toBeNull();
    expect(nameOf(undefined)).toBeNull();
  });
});
