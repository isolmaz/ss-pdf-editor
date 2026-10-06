/**
 * Marked content in a content stream: which painting operators sit in which `BDC … EMC`
 * sequence and how each one counts for PDF/UA (tagged, artifact, both, neither). The wrong
 * answers that matter: a clip or an invisible path counted as content, a `/MCID` read out of
 * an `/ActualText` string, and an unbalanced stream reported as balanced.
 */

import { describe, expect, it } from 'vitest';
import { readInstructions } from './accessibility';
import { type ContentMarks, coverageOf, mcidOf, scanContent } from './content-scan';

function marks(stream: string, hooks: Parameters<typeof scanContent>[2] = {}): ContentMarks {
  const bytes = new TextEncoder().encode(stream);
  const instructions = readInstructions(bytes);
  if (instructions === null) throw new Error('the fixture stream does not tokenise');
  return scanContent(bytes, instructions, hooks);
}

const coverage = (found: ContentMarks): string[] => found.paints.map((paint) => coverageOf(found, paint));

describe('scanContent', () => {
  it('classifies each paint as tagged, artifact, both, or unmarked', () => {
    const found = marks(
      [
        '/P <</MCID 4>> BDC BT /F 12 Tf 10 100 Td (tagged) Tj ET EMC',
        '/Artifact BMC 0 0 10 10 re f EMC',
        '/P <</MCID 5>> BDC /Artifact BMC 0 0 5 5 re f EMC EMC',
        '20 20 5 5 re S',
      ].join('\n'),
    );
    expect(found.unbalanced).toBe(false);
    expect(found.paints.map((paint) => paint.kind)).toEqual(['text', 'path', 'path', 'path']);
    expect(coverage(found)).toEqual(['tagged', 'artifact', 'conflict', 'unmarked']);
    expect(mcidOf(found, found.paints[0] as (typeof found.paints)[number])).toBe(4);
    expect(mcidOf(found, found.paints[1] as (typeof found.paints)[number])).toBeNull();
    expect([...found.fonts]).toEqual(['F']);
  });

  it('counts invisible text, but not a clip, a path left unpainted or clip-only text', () => {
    const found = marks(
      [
        'BT /F 12 Tf 3 Tr (ocr layer) Tj ET',
        'BT 7 Tr (clip text) Tj ET',
        '0 0 10 10 re W n',
        '0 0 10 10 re n',
        '0 0 10 10 re f',
      ].join('\n'),
    );
    expect(found.paints.map((paint) => paint.kind)).toEqual(['text', 'path']);
    expect(found.paints[1]?.bbox).toEqual([0, 0, 10, 10]);
  });

  it('places an image under the transform in force and a path by its points', () => {
    const found = marks('q 100 0 0 50 10 20 cm /Im1 Do Q 0 0 m 30 40 l S', {
      xobject: (name) => (name === 'Im1' ? { kind: 'image' } : null),
    });
    expect(found.paints.map((paint) => paint.kind)).toEqual(['image', 'path']);
    expect(found.paints[0]?.name).toBe('Im1');
    expect(found.paints[0]?.bbox).toEqual([10, 20, 110, 70]);
    expect(found.paints[1]?.bbox).toEqual([0, 0, 30, 40]);
  });

  it('reads an MCID from a named property list through the hook and ignores one inside a string', () => {
    const found = marks(
      '/P /MC0 BDC (x) Tj EMC /Span <</ActualText (fake /MCID 9 here) /MCID 2>> BDC (y) Tj EMC',
      { properties: (name) => (name === 'MC0' ? 7 : null) },
    );
    expect(found.spans.map((span) => [span.tag, span.mcid])).toEqual([
      ['P', 7],
      ['Span', 2],
    ]);
  });

  it('reports an unclosed sequence and a stray EMC as unbalanced', () => {
    expect(marks('/P <</MCID 0>> BDC (a) Tj').unbalanced).toBe(true);
    expect(marks('(a) Tj EMC').unbalanced).toBe(true);
    expect(marks('/P <</MCID 0>> BDC (a) Tj EMC').unbalanced).toBe(false);
  });

  it('treats a wrapper sequence without an MCID or Artifact tag as transparent', () => {
    const found = marks('/OC /Layer BDC 0 0 5 5 re f EMC');
    expect(coverage(found)).toEqual(['unmarked']);
  });
});
