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

  it('survives a damaged stream: an unclosed dictionary and a runaway nest end the scan, not the process', () => {
    expect(() => scan(ascii('<</A 1 /B'))).not.toThrow();
    expect(() => scan(ascii(`${'['.repeat(500)} f`))).not.toThrow();
    expect(scan(ascii('')).length).toBe(0);
  });
});
