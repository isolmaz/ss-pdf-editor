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

import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { buildTextPage, lineOrientation } from './model';
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

describe('buildTextPage — refusals, style facts and the cases with nothing to measure', () => {
  /** A glyph of `size` in `fontName` whose box starts at x on the baseline at y. */
  const glyph = (ch: string, x: number, y = BASELINE, size = SIZE, fontName = 'Helvetica'): CharInput => ({
    ch,
    quad: [x, y - 8, x + 5, y + 2],
    origin: [x, y],
    size,
    fontName,
  });
  const input = (blocks: PageTextInput['blocks'], extra: Partial<PageTextInput> = {}): PageTextInput => ({
    pageIndex: 0,
    width: 595,
    height: 842,
    rotation: 0,
    blocks,
    ...extra,
  });
  const lineOf = (chars: readonly CharInput[], baseline = BASELINE) => ({
    chars,
    quad: [72, baseline - 8, 400, baseline + 2] as const,
    baseline,
  });
  const blockOf = (...lines: ReturnType<typeof lineOf>[]) => ({ quad: [72, 0, 400, 800] as const, lines });

  it('refuses a page index or a page size it cannot place text on', () => {
    const fail = (extra: Partial<PageTextInput>): string => {
      try {
        buildTextPage(input([], extra));
        return 'built';
      } catch (error) {
        return error instanceof ToolError ? `${error.code}: ${error.details.engineMessage}` : 'other';
      }
    };
    expect(fail({ pageIndex: -1 })).toBe('range-invalid: pageIndex -1');
    expect(fail({ pageIndex: 1.5 })).toBe('range-invalid: pageIndex 1.5');
    expect(fail({ width: 0 })).toBe('range-invalid: page size 0 x 842');
    expect(fail({ height: Number.NaN })).toBe('range-invalid: page size 595 x NaN');
  });

  it('drops a block with no inked glyph or no usable size, and numbers the rest from b0', () => {
    const built = buildTextPage(
      input([
        blockOf(lineOf([glyph(' ', 72)])),
        blockOf(lineOf([glyph('a', 72, BASELINE, 0)])),
        blockOf(lineOf([glyph('b', 72)]), lineOf([glyph('c', 72, BASELINE + 30)])),
      ]),
    );
    expect(built.blocks.map((block) => [block.id, block.text])).toEqual([['b0', 'b\nc']]);
  });

  it('takes the most used named font, ignores unnamed and zero-size glyphs, and has no name when none is given', () => {
    const named = buildTextPage(
      input([
        blockOf(
          lineOf([
            glyph('a', 72, BASELINE, 0, 'Times-Bold'),
            glyph('b', 77, BASELINE, 12, ''),
            glyph('c', 82, BASELINE, 12, 'Helvetica-Oblique'),
            glyph('d', 87, BASELINE, 12, 'Helvetica-Oblique'),
          ]),
        ),
      ]),
    ).blocks[0];
    expect(named?.style).toMatchObject({
      fontName: 'Helvetica-Oblique',
      fontFamily: 'sans',
      italic: true,
      fontSize: 12,
    });
    const unnamed = buildTextPage(input([blockOf(lineOf([glyph('a', 72, BASELINE, 10, '')]))])).blocks[0];
    expect([unnamed?.style.fontName, unnamed?.style.fontFamily]).toEqual([null, 'unknown']);
  });

  it('falls back to 1.2 em leading when the lines share a baseline, and checks the colour it is given', () => {
    const stacked = buildTextPage(input([blockOf(lineOf([glyph('a', 72)]), lineOf([glyph('b', 200)]))]))
      .blocks[0];
    expect(stacked?.style.leading).toBe(12);
    const coloured = buildTextPage(input([blockOf(lineOf([glyph('a', 72)]))], { colors: { 0: '#a1b2c3' } }));
    expect(coloured.blocks[0]?.style.color).toBe('#a1b2c3');
    expect(() =>
      buildTextPage(input([blockOf(lineOf([glyph('a', 72)]))], { colors: { 0: '#A1B2C3' } })),
    ).toThrow(/colour #A1B2C3/);
    expect(() => buildTextPage(input([blockOf(lineOf([glyph('a', 72)]))], { colors: { 0: 'red' } }))).toThrow(
      /colour red \(expected #rrggbb\)/,
    );
  });

  it('reads a line whose glyphs share one origin as horizontal, and two glyphs on one spot as horizontal', () => {
    const same = [glyph('a', 72), glyph('b', 72)];
    const built = buildTextPage(input([blockOf(lineOf(same))])).blocks[0];
    expect(built?.text).toBe('ab');
    const line = built?.lines[0];
    if (line === undefined) throw new Error('no line');
    expect(lineOrientation(line)).toBe('horizontal');
  });
});

describe('buildTextPage — paragraph blocks', () => {
  const glyphAt = (ch: string, x: number, y: number, fontName = 'Helvetica', size = SIZE): CharInput => ({
    ch,
    quad: [x, y - 8, x + 5, y + 2],
    origin: [x, y],
    size,
    fontName,
  });
  /** A block with one horizontal line of `text` starting at (x, baseline). */
  const block = (text: string, x: number, baseline: number, fontName = 'Helvetica', size = SIZE) => {
    const chars = [...text].map((ch, index) => glyphAt(ch, x + index * 5, baseline, fontName, size));
    const quad = [x, baseline - 8, x + text.length * 5, baseline + 2] as const;
    return { quad, lines: [{ chars, quad, baseline }] };
  };
  /** A block of one vertical line: each glyph below the last. */
  const vertical = (x: number, top: number) => {
    const chars = [...'abc'].map((ch, index) => glyphAt(ch, x, top + index * 12));
    const quad = [x, top - 8, x + 5, top + 26] as const;
    return { quad, lines: [{ chars, quad, baseline: top }] };
  };
  const texts = (blocks: PageTextInput['blocks']) =>
    buildTextPage({ pageIndex: 0, width: 595, height: 842, rotation: 0, blocks }).blocks.map(
      (built) => built.text,
    );

  it('joins the next line of the same paragraph into one block, with its own leading', () => {
    const built = buildTextPage({
      pageIndex: 0,
      width: 595,
      height: 842,
      rotation: 0,
      blocks: [block('aaaa', 72, 100), block('bbbb', 72, 114), block('cc', 72, 128)],
    }).blocks;
    expect(built.map((item) => [item.id, item.text, item.style.leading])).toEqual([
      ['b0', 'aaaa\nbbbb\ncc', 14],
    ]);
  });

  it('keeps blocks apart that differ in font, size, rhythm, column or direction', () => {
    expect(texts([block('aaaa', 72, 100), block('bbbb', 72, 114, 'Times-Roman')])).toEqual(['aaaa', 'bbbb']);
    expect(texts([block('aaaa', 72, 100), block('bbbb', 72, 114, 'Helvetica', 11)])).toEqual([
      'aaaa',
      'bbbb',
    ]);
    // A paragraph break: more than 1.6 × the 12 pt leading.
    expect(texts([block('aaaa', 72, 100), block('bbbb', 72, 120)])).toEqual(['aaaa', 'bbbb']);
    // Above the previous block, not below it.
    expect(texts([block('aaaa', 72, 100), block('bbbb', 72, 90)])).toEqual(['aaaa', 'bbbb']);
    // A column beside the paragraph.
    expect(texts([block('aaaa', 72, 100), block('bbbb', 300, 114)])).toEqual(['aaaa', 'bbbb']);
    // A vertical line: each glyph is its own word along the line's direction, and it never joins.
    expect(texts([vertical(72, 100), block('bbbb', 72, 140)])).toEqual(['a b c', 'bbbb']);
  });

  it('calls a single line centred on the page centred, and one off centre left', () => {
    const align = (x: number) =>
      buildTextPage({
        pageIndex: 0,
        width: 595,
        height: 842,
        rotation: 0,
        blocks: [block('abcdefghij', x, 100)],
      }).blocks[0]?.align;
    // 50 pt wide: centred on 297.5 when it starts at 272.5.
    expect(align(272.5)).toBe('center');
    expect(align(72)).toBe('left');
    // Two lines of different length sharing one centre, flush on neither side.
    const centred = buildTextPage({
      pageIndex: 0,
      width: 595,
      height: 842,
      rotation: 0,
      blocks: [block('abcdefghij', 72, 100), block('abcd', 87, 114)],
    }).blocks;
    expect(centred.map((item) => [item.text, item.align])).toEqual([['abcdefghij\nabcd', 'center']]);
  });
});

describe('buildTextPage — glyph colour and a right-aligned paragraph', () => {
  const glyphAt = (ch: string, x: number, y: number, color?: string): CharInput => ({
    ch,
    quad: [x, y - 8, x + 5, y + 2],
    origin: [x, y],
    size: SIZE,
    fontName: 'Helvetica',
    ...(color === undefined ? {} : { color }),
  });
  const lineAt = (text: string, x: number, baseline: number, color?: string) => {
    const chars = [...text].map((ch, index) => glyphAt(ch, x + index * 5, baseline, color));
    return { chars, quad: [x, baseline - 8, x + text.length * 5, baseline + 2] as const, baseline };
  };

  it('keeps a glyph colour the extractor reported and leaves it off when none was', () => {
    const built = buildTextPage({
      pageIndex: 0,
      width: 595,
      height: 842,
      rotation: 0,
      blocks: [
        { quad: [72, 90, 200, 104], lines: [lineAt('ab', 72, 100, '#ff0000'), lineAt('cd', 72, 114)] },
      ],
    }).blocks[0];
    const glyphs = built?.lines.flatMap((line) => line.words.flatMap((word) => word.glyphs)) ?? [];
    expect(glyphs.map((glyph) => [glyph.ch, glyph.color])).toEqual([
      ['a', '#ff0000'],
      ['b', '#ff0000'],
      ['c', undefined],
      ['d', undefined],
    ]);
  });

  it('calls lines flush right and ragged left right-aligned', () => {
    const built = buildTextPage({
      pageIndex: 0,
      width: 595,
      height: 842,
      rotation: 0,
      blocks: [{ quad: [72, 90, 200, 120], lines: [lineAt('abcdefgh', 72, 100), lineAt('abcd', 92, 114)] }],
    }).blocks[0];
    expect(built?.align).toBe('right');
  });
});
