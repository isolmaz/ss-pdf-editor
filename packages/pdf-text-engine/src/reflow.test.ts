/**
 * Block-local reflow on a fixed-pitch face, so every position is arithmetic: at 10 pt a
 * glyph is 5 pt wide, a line is its character count times 5, and the first baseline sits
 * the ascent (8 pt) below the box top. Covers the refusals, the leading and ascent
 * fallbacks, the four alignments with justified word positions, indentation, paragraph
 * spacing, hyphenation (and its limits), auto-shrink to a floor, and empty text.
 */

import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEADING_RATIO, measureLineWidth, reflowBlock } from './reflow';
import type { FontMetrics, ReflowOptions, ReflowResult, TextAlign, TextBlock } from './types';

/** Every glyph half an em wide; ascender 0.8 em, descender 0.2 em. */
function face(overrides: Partial<FontMetrics> = {}): FontMetrics {
  return {
    unitsPerEm: 1000,
    glyphAdvance: () => 500,
    ascender: 800,
    descender: -200,
    lineGap: 0,
    hasGlyph: () => true,
    missing: [],
    ...overrides,
  };
}

/** A block 50 pt wide at (100, 200): ten 10 pt glyphs per line. */
function block(
  fields: { align?: TextAlign; fontSize?: number; leading?: number; width?: number } = {},
): TextBlock {
  const width = fields.width ?? 50;
  return {
    id: 'b0',
    rect: [100, 200, 100 + width, 230],
    lines: [],
    text: '',
    style: {
      fontName: 'Courier',
      fontFamily: 'mono',
      bold: false,
      italic: false,
      fontSize: fields.fontSize ?? 10,
      leading: fields.leading ?? 12,
      color: '#000000',
    },
    align: fields.align ?? 'left',
  };
}

const lay = (
  text: string,
  options?: ReflowOptions,
  target: TextBlock = block(),
  metrics = face(),
): ReflowResult =>
  reflowBlock({ block: target, text, ...(options === undefined ? {} : { options }) }, metrics);

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof ToolError) return `${error.code}: ${error.details.engineMessage}`;
    throw error;
  }
  throw new Error('no refusal');
};

describe('measureLineWidth', () => {
  it('sums the advances of every code point at the size, astral characters as one', () => {
    expect(measureLineWidth('abc', 10, face())).toBe(15);
    expect(measureLineWidth('a😀', 10, face())).toBe(10);
    expect(measureLineWidth('', 10, face())).toBe(0);
  });
});

describe('reflowBlock refusals', () => {
  it('names the value it cannot lay out with', () => {
    expect(refusal(() => lay('a', undefined, block(), face({ unitsPerEm: 0 })))).toBe(
      'unsupported: unitsPerEm 0',
    );
    expect(refusal(() => lay('a', { fontSize: 0 }))).toBe('range-invalid: fontSize 0');
    expect(refusal(() => lay('a', { indent: -1 }))).toBe('range-invalid: indent -1, paragraphSpacing 0');
    expect(refusal(() => lay('a', { paragraphSpacing: -2 }))).toBe(
      'range-invalid: indent 0, paragraphSpacing -2',
    );
    expect(refusal(() => lay('a', { box: [10, 10, 10, 50] }))).toBe('range-invalid: box width 0');
    expect(refusal(() => lay('a', { box: [10, 10, 60, 10] }))).toBe('range-invalid: box height 0');
  });
});

describe('reflowBlock layout', () => {
  it('places the first baseline one ascent below the box top and the next one leading lower', () => {
    const result = lay('aaaa bbbb cccc');
    expect(result.lines.map((line) => [line.text, line.baseline])).toEqual([
      ['aaaa bbbb', 208],
      ['cccc', 220],
    ]);
    expect(result.lines[0]?.rect).toEqual([100, 200, 145, 210]);
    expect(result.rect).toEqual([100, 200, 145, 222]);
    expect(result.overflow).toBe(false);
    expect(result.fontSize).toBe(10);
  });

  it('falls back to 1.2 em leading and 0.8 em ascent when the block or font give none', () => {
    const result = lay('aaaa bbbb cccc', undefined, block({ leading: 0 }), face({ ascender: 0 }));
    expect(result.lines.map((line) => line.baseline)).toEqual([208, 208 + 10 * DEFAULT_LEADING_RATIO]);
    // The options' leading wins over the block's.
    expect(lay('aaaa bbbb cccc', { leading: 30 }).lines.map((line) => line.baseline)).toEqual([208, 238]);
  });

  it('aligns right and centre inside the box, from the block or from the options', () => {
    expect(lay('ab', undefined, block({ align: 'right' })).lines[0]?.rect[0]).toBe(140);
    expect(lay('ab', { align: 'center' }).lines[0]?.rect[0]).toBe(120);
    expect(lay('ab', { align: 'left' }, block({ align: 'right' })).lines[0]?.rect[0]).toBe(100);
  });

  it('justifies every line but the last of a paragraph, spreading the slack over the word gaps', () => {
    const result = lay('aaa bb cccc dd', { align: 'justify' });
    const [first, last] = result.lines;
    expect(first?.text).toBe('aaa bb');
    expect(first?.justified).toBe(true);
    expect(first?.width).toBe(50);
    // aaa (15) + space (5) + 20 pt of slack puts bb at 140, its end on the right edge.
    expect(first?.words).toEqual([
      { text: 'aaa', x: 100 },
      { text: 'bb', x: 140 },
    ]);
    expect(last?.text).toBe('cccc dd');
    expect(last?.justified).toBe(false);
    expect(last?.words).toEqual([
      { text: 'cccc', x: 100 },
      { text: 'dd', x: 125 },
    ]);
    // A single word cannot be stretched and starts at the left edge.
    const single = lay('aaaaaaa bbbbbbb', { align: 'justify' }).lines[0];
    expect([single?.text, single?.justified, single?.rect[0]]).toEqual(['aaaaaaa', false, 100]);
  });

  it('indents the first line of each paragraph and spaces the paragraphs apart', () => {
    const result = lay('aaaa bbbb\n\n  \ncc', { indent: 10, paragraphSpacing: 6 });
    expect(result.lines.map((line) => [line.text, line.rect[0], line.baseline])).toEqual([
      ['aaaa', 110, 208],
      ['bbbb', 100, 220],
      // The blank lines are no paragraph: one spacing, not three.
      ['cc', 110, 238],
    ]);
  });

  it('hyphenates a word wider than the box only when asked, keeping two characters on each side', () => {
    const whole = lay('abcdefghijkl');
    expect(whole.lines.map((line) => line.text)).toEqual(['abcdefghijkl']);
    expect(whole.overflow).toBe(true);
    expect(whole.hyphenated).toEqual([]);

    const broken = lay('xx abcdefghijkl', { hyphenate: true });
    expect(broken.lines.map((line) => line.text)).toEqual(['xx', 'abcdefghi-', 'jkl']);
    expect(broken.hyphenated).toEqual(['abcdefghijkl']);
    expect(broken.overflow).toBe(false);

    // Too narrow for two characters and a hyphen: the word is placed whole and overflows.
    const narrow = lay('abcdef', { hyphenate: true }, block({ width: 12 }));
    expect(narrow.lines.map((line) => line.text)).toEqual(['abcdef']);
    expect(narrow.hyphenated).toEqual([]);
    expect(narrow.overflow).toBe(true);
  });

  it('shrinks in half-point steps until the text fits a fixed box, and stops at the floor', () => {
    // Three 10 pt lines need 34 pt; the box is 25 pt tall.
    const fitted = lay('aaaa bbbb cccc dddd eeee ffff', { box: [0, 0, 50, 25], minFontSize: 4 });
    expect(fitted.overflow).toBe(false);
    expect(fitted.fontSize).toBeLessThan(10);
    expect((fitted.fontSize * 2) % 1).toBe(0);
    expect(fitted.rect[3]).toBeLessThanOrEqual(25.25);
    // One more half point would not have fitted.
    expect(
      lay('aaaa bbbb cccc dddd eeee ffff', { box: [0, 0, 50, 25], fontSize: fitted.fontSize + 0.5 }).overflow,
    ).toBe(true);

    const floored = lay('aaaa bbbb cccc dddd eeee ffff', { box: [0, 0, 50, 25], minFontSize: 9 });
    expect([floored.fontSize, floored.overflow]).toEqual([9, true]);
    // Without a minimum the requested size is the floor: no shrinking at all.
    expect(lay('aaaa bbbb cccc dddd eeee ffff', { box: [0, 0, 50, 25] }).fontSize).toBe(10);
    // A minimum above the requested size never grows the text.
    expect(lay('aaaa', { box: [0, 0, 50, 25], minFontSize: 20 }).fontSize).toBe(10);
  });

  it('lays out empty text as no lines in a zero-area rect at the box corner', () => {
    expect(lay(' \n\t ')).toEqual({
      lines: [],
      rect: [100, 200, 100, 200],
      overflow: false,
      fontSize: 10,
      hyphenated: [],
    });
  });
});
