/**
 * The graphics-state walk of the content scan on streams a producer is free to write: operators
 * with too few or the wrong operands, text positioned by every text-line operator, curves in all
 * their forms, forms and images by what the document says they are, and a sequence walk with
 * indices that do not exist.
 */

import { describe, expect, it } from 'vitest';
import { readInstructions } from './accessibility';
import { type ContentMarks, coverageOf, enclosing, mcidOf, scanContent } from './content-scan';

function marks(stream: string, hooks: Parameters<typeof scanContent>[2] = {}): ContentMarks {
  const bytes = new TextEncoder().encode(stream);
  const instructions = readInstructions(bytes);
  if (instructions === null) throw new Error('the fixture stream does not tokenise');
  return scanContent(bytes, instructions, hooks);
}

describe('marked-content sequences', () => {
  it('reads a string with escapes and nested parentheses without taking an MCID from inside it', () => {
    const found = marks('/Span <</ActualText (a \\) b (c) /MCID 9) /MCID 4>> BDC EMC');
    expect(found.spans.map((span) => span.mcid)).toEqual([4]);
  });

  it('gives a sequence without a name operand an empty tag, and a property name the hook does not know no MCID', () => {
    const found = marks('1 BMC EMC /P /Unknown BDC EMC', { properties: () => null });
    expect(found.spans.map((span) => [span.tag, span.mcid])).toEqual([
      ['', null],
      ['P', null],
    ]);
    const without = marks('/P /MC0 BDC EMC');
    expect(without.spans[0]?.mcid).toBeNull();
  });

  it('gives an inline property list without an MCID none', () => {
    expect(marks('/Span <</Lang (tr)>> BDC EMC').spans[0]?.mcid).toBeNull();
  });

  it('nests sequences and answers the chain innermost first, and nothing for a span that does not exist', () => {
    const found = marks('/P <</MCID 1>> BDC /Artifact BMC 0 0 1 1 re f EMC EMC');
    const paint = found.paints[0];
    if (paint === undefined) throw new Error('no paint');
    expect(enclosing(found, paint.span).map((span) => span.tag)).toEqual(['Artifact', 'P']);
    expect(enclosing(found, 99)).toEqual([]);
    expect(coverageOf(found, paint)).toBe('conflict');
    expect(mcidOf(found, paint)).toBe(1);
  });
});

describe('graphics and text state', () => {
  it('ignores operators that lack their operands and keeps the state they would have changed', () => {
    const found = marks(
      [
        'Q',
        '1 0 0 cm',
        'BT Tf 12 Tf /F Tf /Name Tr TL 5 Td 1 2 Tm 0 0 m 5 l 1 2 3 c 1 2 y 1 2 3 v 1 re',
        '(still here) Tj ET',
      ].join('\n'),
    );
    expect(found.paints.map((paint) => paint.kind)).toEqual(['text']);
    expect(found.paints[0]?.origin).toEqual({ x: 0, y: 0 });
    expect(found.paints[0]?.fontSize).toBe(0);
    expect([...found.fonts]).toEqual(['F']);
  });

  it('places text by Td, TD, Tm, T*, quote and double quote, and only the showing operators paint', () => {
    const found = marks(
      [
        'BT /F 10 Tf 0 Tr',
        '10 20 Td (a) Tj',
        '5 -12 TD (b) Tj',
        'T* ',
        '(c) Tj',
        "(d) '",
        '1 2 (e) "',
        '1 0 0 1 100 200 Tm [(f)] TJ',
        'ET',
      ].join('\n'),
    );
    expect(found.paints.map((paint) => paint.kind)).toEqual(['text', 'text', 'text', 'text', 'text', 'text']);
    expect(found.paints.map((paint) => [paint.origin?.x, paint.origin?.y])).toEqual([
      [10, 20],
      [15, 8],
      [15, -4],
      [15, -16],
      [15, -28],
      [100, 200],
    ]);
  });

  it('follows TL for the next line and restores the matrix at Q', () => {
    const found = marks('q 2 0 0 2 0 0 cm BT 14 TL (a) Tj T* (b) Tj ET Q BT (c) Tj ET');
    expect(found.paints.map((paint) => paint.origin?.y)).toEqual([0, -28, 0]);
  });

  it('does not paint clip-only text', () => {
    expect(marks('BT 7 Tr (a) Tj ET').paints).toEqual([]);
  });
});

describe('paths', () => {
  it('bounds a path by every point of every construction operator, and drops it at n', () => {
    const found = marks(
      [
        '0 0 m 10 5 l 20 20 30 30 40 10 c 50 50 60 60 v 70 70 80 80 y 90 0 5 5 re S',
        '1 1 m n 2 2 3 3 re f',
      ].join('\n'),
    );
    expect(found.paints.map((paint) => paint.bbox)).toEqual([
      [0, 0, 95, 80],
      [2, 2, 5, 5],
    ]);
  });

  it('gives a path whose coordinates overflow no box', () => {
    expect(marks(`${'9'.repeat(400)} 0 m 1 1 l S`).paints[0]?.bbox).toBeNull();
  });

  it('gives a path with nothing constructed no box', () => {
    expect(marks('S').paints[0]?.bbox).toBeNull();
  });
});

describe('shadings, images and forms', () => {
  it('records shadings and inline images', () => {
    const found = marks('q 4 0 0 4 1 1 cm /Sh0 sh BI /W 1 /H 1 /CS /G /BPC 8 ID \u0000 EI Q');
    expect(found.paints.map((paint) => paint.kind)).toEqual(['shading', 'inline-image']);
    expect(found.paints[1]?.bbox).toEqual([1, 1, 5, 5]);
  });

  it('treats a Do without a name as nothing, an unknown XObject as an image, and an other XObject as not painting', () => {
    const found = marks('1 Do /Im Do /Other Do', {
      xobject: (name) => (name === 'Other' ? { kind: 'other' } : null),
    });
    expect(found.paints.map((paint) => [paint.kind, paint.name])).toEqual([['image', 'Im']]);
  });

  it('places a form by its box under its own matrix and the current one, or by nothing without a box', () => {
    const found = marks('q 2 0 0 2 10 10 cm /Fm0 Do /Fm1 Do /Fm2 Do Q', {
      xobject: (name) => {
        if (name === 'Fm0') return { kind: 'form', bbox: [0, 0, 10, 10], matrix: [1, 0, 0, 1, 5, 0] };
        if (name === 'Fm1') return { kind: 'form', bbox: [0, 0, 10, 10] };
        return { kind: 'form' };
      },
    });
    expect(found.paints.map((paint) => [paint.kind, paint.bbox])).toEqual([
      ['form', [20, 10, 40, 30]],
      ['form', [10, 10, 30, 30]],
      ['form', null],
    ]);
  });
});
