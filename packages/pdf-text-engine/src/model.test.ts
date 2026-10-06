/**
 * The text model's word segmentation — the step whose failure wrote an edited paragraph
 * back without a single space. Glyphs here are laid out on one baseline at 10 pt, each
 * box `advance` wide, the way MuPDF reports a line: the boxes of consecutive glyphs abut,
 * and a space is either a reported whitespace character or only a gap in the geometry.
 *
 * The failing page was **italic**: MuPDF's glyph quad is slanted, so the bounding box of
 * one glyph reaches past the start of the next — across a space as well — and the ink
 * gap the model measured between two words came out negative (measured on `test1.pdf`:
 * "s" 384.1–391.0, " " 391.0–393.1, "i" 390.9–395.9).
 */

import { describe, expect, it } from 'vitest';
import { buildTextPage } from './model';
import type { CharInput, PageTextInput } from './types';

const SIZE = 10;
const BASELINE = 100;

/**
 * One line of glyphs from a pattern: a letter is a 5 pt glyph, `' '` is a reported
 * space character 2.5 pt wide, and `'_'` is a 2.5 pt gap with **no** character at all.
 */
function line(pattern: string, slant = 0): readonly CharInput[] {
  const chars: CharInput[] = [];
  let x = 72;
  for (const ch of pattern) {
    const advance = ch === ' ' || ch === '_' ? 2.5 : 5;
    if (ch !== '_') {
      chars.push({
        ch,
        // An italic glyph's slanted quad, reduced to its bounding box, reaches `slant`
        // points past its own advance.
        quad: [x, BASELINE - 8, x + advance + slant, BASELINE + 2],
        origin: [x, BASELINE],
        size: SIZE,
        fontName: 'ABCDEF+NotoSans-Regular',
      });
    }
    x += advance;
  }
  return chars;
}

function page(pattern: string, slant = 0): PageTextInput {
  const chars = line(pattern, slant);
  return {
    pageIndex: 0,
    width: 595,
    height: 842,
    rotation: 0,
    blocks: [{ quad: [72, 90, 400, 104], lines: [{ chars, quad: [72, 90, 400, 104], baseline: BASELINE }] }],
  };
}

describe('buildTextPage word segmentation', () => {
  it('splits italic words at a reported space even though their slanted boxes overlap across it', () => {
    // 3 pt of slant: wider than the 2.5 pt space, so the geometry alone sees no gap.
    const built = buildTextPage(page('This is a test', 3));
    expect(built.blocks[0]?.text).toBe('This is a test');
    expect(built.blocks[0]?.lines[0]?.words.map((word) => word.text)).toEqual(['This', 'is', 'a', 'test']);
  });

  it('splits words at a gap wider than a fraction of an em when no space character exists', () => {
    expect(buildTextPage(page('Word_gap')).blocks[0]?.text).toBe('Word gap');
  });

  it('keeps a word whole across glyphs that touch', () => {
    expect(buildTextPage(page('Kerning')).blocks[0]?.text).toBe('Kerning');
  });

  it('does not start a line with an empty word for leading whitespace', () => {
    const built = buildTextPage(page('  indented'));
    expect(built.blocks[0]?.lines[0]?.words.map((word) => word.text)).toEqual(['indented']);
  });

  it('splits at a reported tab or no-break space just like a space', () => {
    for (const gapChar of ['	', ' ']) {
      const built = buildTextPage(page(`ab${gapChar}cd`));
      expect(
        built.blocks[0]?.lines[0]?.words.map((word) => word.text),
        JSON.stringify(gapChar),
      ).toEqual(['ab', 'cd']);
    }
  });

  it('collapses runs of whitespace and ignores trailing whitespace instead of emitting empty words', () => {
    const built = buildTextPage(page('ab   cd  '));
    expect(built.blocks[0]?.lines[0]?.words.map((word) => word.text)).toEqual(['ab', 'cd']);
    expect(built.blocks[0]?.text).toBe('ab cd');
  });

  it('puts the word-gap threshold at 0.15 em of the larger glyph (1.5 pt at 10 pt), not above or below', () => {
    // Two 5 pt glyphs with an unreported ink gap between them, no space character.
    const withGap = (gap: number): PageTextInput => {
      const glyph = (ch: string, x: number): CharInput => ({
        ch,
        quad: [x, BASELINE - 8, x + 5, BASELINE + 2],
        origin: [x, BASELINE],
        size: SIZE,
        fontName: 'ABCDEF+NotoSans-Regular',
      });
      const chars = [glyph('a', 72), glyph('b', 77 + gap)];
      return {
        pageIndex: 0,
        width: 595,
        height: 842,
        rotation: 0,
        blocks: [
          { quad: [72, 90, 400, 104], lines: [{ chars, quad: [72, 90, 400, 104], baseline: BASELINE }] },
        ],
      };
    };
    const words = (gap: number) =>
      buildTextPage(withGap(gap)).blocks[0]?.lines[0]?.words.map((word) => word.text);
    expect(words(1.2)).toEqual(['ab']);
    expect(words(1.4)).toEqual(['ab']);
    expect(words(1.6)).toEqual(['a', 'b']);
    expect(words(1.9)).toEqual(['a', 'b']);
  });

  it('reports the word boxes, the line text, the baseline and the glyph advances', () => {
    const line = buildTextPage(page('ab cd')).blocks[0]?.lines[0];
    expect(line?.text).toBe('ab cd');
    expect(line?.baseline).toBe(BASELINE);
    expect(line?.words.map((word) => word.rect)).toEqual([
      [72, 92, 82, 102],
      [84.5, 92, 94.5, 102],
    ]);
    // Advance = distance to the next glyph's origin; the last glyph of a word still
    // measures to the next glyph that was positioned (the space is not a glyph).
    expect(line?.words[0]?.glyphs.map((glyph) => glyph.advance)).toEqual([5, 7.5]);
    expect(line?.words[1]?.glyphs.map((glyph) => glyph.advance)).toEqual([5, 5]);
  });

  it('scales the gap threshold by the larger of the two neighbouring glyphs', () => {
    const chars: CharInput[] = [
      { ch: 'a', quad: [72, 92, 77, 102], origin: [72, 100], size: 10, fontName: 'F' },
      // 2.5 pt of ink gap: over 0.15 x 10 pt, under 0.15 x 20 pt.
      { ch: 'b', quad: [79.5, 92, 89.5, 102], origin: [79.5, 100], size: 20, fontName: 'F' },
    ];
    const built = buildTextPage({
      pageIndex: 0,
      width: 595,
      height: 842,
      rotation: 0,
      blocks: [{ quad: [72, 90, 400, 104], lines: [{ chars, quad: [72, 90, 400, 104], baseline: 100 }] }],
    });
    expect(built.blocks[0]?.lines[0]?.words.map((word) => word.text)).toEqual(['ab']);
  });

  it('normalises a glyph quad given with its corners swapped', () => {
    const chars: CharInput[] = [
      { ch: 'a', quad: [77, 102, 72, 92], origin: [72, 100], size: 10, fontName: 'F' },
    ];
    const built = buildTextPage({
      pageIndex: 0,
      width: 595,
      height: 842,
      rotation: 0,
      blocks: [{ quad: [72, 90, 400, 104], lines: [{ chars, quad: [72, 90, 400, 104], baseline: 100 }] }],
    });
    expect(built.blocks[0]?.lines[0]?.words[0]?.rect).toEqual([72, 92, 77, 102]);
  });
});
