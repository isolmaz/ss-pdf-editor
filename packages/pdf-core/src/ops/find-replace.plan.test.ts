/**
 * The plan behind find and replace, run on hand-built page models so that every geometry
 * is known to the point: a glyph is 5 pt wide at 10 pt, words are 2.5 pt apart (a tab-like
 * gap is anything over 10 pt) and a face "measures" text as half an em per character
 * unless a test says otherwise. The wrong answers that matter: the rest of a line moved
 * onto a column it must not touch, a replacement drawn in a face or size the old text did
 * not have, text that cannot be drawn again exactly redrawn anyway, a re-laid paragraph
 * that loses its indent, hyphenation or a word's own font, and a block that cannot be
 * planned silently produced instead of refused.
 */

import type {
  FontCandidate,
  FontMetrics,
  GlyphBox,
  Rect,
  TextAlign,
  TextBlock,
  TextLine,
  TextPage,
  TextStyle,
  TextWord,
} from 'pdf-text-engine';
import { describe, expect, it } from 'vitest';
import type { TextFontSet } from '../text-source';
import { type FaceSource, type FindReplacePlan, planFindReplace } from './find-replace';

const SIZE = 10;
/** The width of one glyph at `SIZE`. */
const CHAR = 5;
/** The gap between two words of a line. */
const GAP = 2.5;

/** What a glyph carries beyond its character and box; `null` leaves the field off. */
interface Look {
  readonly fontName?: string | null;
  readonly color?: string | null;
  readonly size?: number | null;
  readonly origin?: boolean;
}

const BASE_LOOK = { fontName: 'Helvetica', color: '#112233', size: SIZE, origin: true } as const;

function glyphOf(ch: string, x: number, baseline: number, width: number, look: Look): GlyphBox {
  const { fontName, color, size, origin } = { ...BASE_LOOK, ...look };
  return {
    ch,
    rect: [x, baseline - 8, x + width, baseline + 2],
    advance: width,
    ...(origin ? { origin: [x, baseline] as const } : {}),
    ...(size === null ? {} : { size }),
    ...(fontName === null ? {} : { fontName }),
    ...(color === null ? {} : { color }),
  };
}

function unionOf(rects: readonly Rect[]): Rect {
  return [
    Math.min(...rects.map((rect) => rect[0])),
    Math.min(...rects.map((rect) => rect[1])),
    Math.max(...rects.map((rect) => rect[2])),
    Math.max(...rects.map((rect) => rect[3])),
  ];
}

interface LineSpec {
  readonly words: readonly string[];
  readonly baseline: number;
  /** The left edge of the first word. */
  readonly x?: number;
  /** The width of one glyph. */
  readonly width?: number;
  /** The gap after each word; `GAP` where absent. */
  readonly gaps?: readonly number[];
  /** Extra space between two glyphs of one word (letter-spacing). */
  readonly tracking?: number;
  readonly look?: Look | ((word: number, index: number) => Look);
}

function lineOf(spec: LineSpec): TextLine {
  const width = spec.width ?? CHAR;
  const start = spec.x ?? 40;
  let x = start;
  const words: TextWord[] = spec.words.map((text, wordIndex) => {
    const glyphs = [...text].map((ch, index) => {
      const look = typeof spec.look === 'function' ? spec.look(wordIndex, index) : (spec.look ?? {});
      const glyph = glyphOf(ch, x, spec.baseline, width, look);
      x += width + (index < text.length - 1 ? (spec.tracking ?? 0) : 0);
      return glyph;
    });
    x += spec.gaps?.[wordIndex] ?? GAP;
    return { text, rect: unionOf(glyphs.map((glyph) => glyph.rect)), glyphs };
  });
  return {
    text: spec.words.join(' '),
    rect:
      words.length === 0
        ? [start, spec.baseline - 8, start, spec.baseline + 2]
        : unionOf(words.map((word) => word.rect)),
    words,
    baseline: spec.baseline,
  };
}

function blockOf(
  id: string,
  lines: readonly TextLine[],
  patch: Partial<TextStyle> & { readonly align?: TextAlign } = {},
): TextBlock {
  const { align = 'left', ...style } = patch;
  return {
    id,
    rect: unionOf(lines.map((line) => line.rect)),
    lines,
    text: lines.map((line) => line.text).join('\n'),
    style: {
      fontName: 'Helvetica',
      fontFamily: 'sans',
      bold: false,
      italic: false,
      fontSize: SIZE,
      leading: 12,
      color: '#000000',
      ...style,
    },
    align,
  };
}

function pageOf(blocks: readonly TextBlock[], width = 300, height = 300): TextPage {
  return { pageIndex: 0, width, height, rotation: 0, blocks };
}

function metricsOf(covers: (point: number) => boolean = () => true): FontMetrics {
  return {
    unitsPerEm: 1000,
    glyphAdvance: () => 500,
    ascender: 800,
    descender: -200,
    lineGap: 0,
    hasGlyph: covers,
    missing: [],
  };
}

const NOTO: FontCandidate = {
  id: 'noto-sans',
  family: 'sans',
  bold: false,
  italic: false,
  filePath: '/fonts/noto-sans.ttf',
};

function fontsOf(
  candidates: readonly FontCandidate[] = [NOTO],
  metrics: Readonly<Record<string, FontMetrics>> = { 'noto-sans': metricsOf() },
  provider?: (candidate: FontCandidate) => FontMetrics | null,
): TextFontSet {
  return { catalog: { candidates, metrics: provider }, metrics };
}

/** Half an em per character: five points a glyph at ten. */
const HALF_EM: FaceSource['measure'] = (text, _face, size) => text.length * size * 0.5;

/** `ownFonts` are the font names the page's own font can draw any text with. */
function facesOf(ownFonts: readonly string[] = [], measure: FaceSource['measure'] = HALF_EM): FaceSource {
  return {
    own: (_page, fontName) => (ownFonts.includes(fontName) ? `doc:${fontName}` : null),
    ownMetrics: (_page, fontName) => (ownFonts.includes(fontName) ? metricsOf() : null),
    measure,
  };
}

interface Setup {
  readonly faces?: FaceSource;
  readonly fonts?: TextFontSet;
  readonly matchCase?: boolean;
  readonly wholeWord?: boolean;
}

function plan(page: TextPage, find: string, replace: string, setup: Setup = {}): FindReplacePlan {
  return planFindReplace(
    [page],
    { find, replace, matchCase: setup.matchCase ?? true, wholeWord: setup.wholeWord ?? false },
    setup.fonts ?? fontsOf(),
    setup.faces ?? facesOf(),
  );
}

/** The inserted lines, as the few fields a test reads. */
function drawn(result: FindReplacePlan) {
  return result.request.insert
    .flatMap((entry) => entry.lines)
    .map((line) => ({ text: line.text, x: line.x, y: line.y, fontSize: line.fontSize, fontId: line.fontId }));
}

function erased(result: FindReplacePlan): Rect[] {
  return result.request.erase.flatMap((entry) => entry.rects);
}

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** `alpha beta gamma` at x 40: alpha 40–65, beta 67.5–87.5, gamma 90–115. */
const threeWords = (look?: LineSpec['look']) =>
  lineOf({ words: ['alpha', 'beta', 'gamma'], baseline: 100, ...(look === undefined ? {} : { look }) });

describe('planFindReplace: one line', () => {
  it('moves the rest of the line by the difference and erases only the changed stretch', () => {
    const result = plan(pageOf([blockOf('b0', [threeWords()])]), 'beta', 'bet');
    expect(result).toMatchObject({ found: 1, replaced: 1, inPlace: 1, movedLines: 0, shrunk: 0 });
    expect(drawn(result)).toEqual([
      { text: 'bet', x: 67.5, y: 100, fontSize: 10, fontId: 'helvetica' },
      { text: 'gamma', x: 85, y: 100, fontSize: 10, fontId: 'helvetica' },
    ]);
    expect(erased(result)).toEqual([[67.55, 92, 114.95, 102]]);
    expect(result.standardFaces).toEqual(['Helvetica']);
    expect(result.ownFonts).toEqual([]);
  });

  it('plans nothing for a search text that is only white space', () => {
    const result = plan(pageOf([blockOf('b0', [threeWords()])]), '   ', 'x');
    expect(result).toMatchObject({ found: 0, replaced: 0, skipped: 0 });
    expect(result.request).toEqual({ erase: [], insert: [], fonts: {} });
  });

  it('redraws the tail of a word that a match ends inside, moved by the difference', () => {
    const result = plan(
      pageOf([blockOf('b0', [lineOf({ words: ['quickly'], baseline: 100 })])]),
      'quick',
      'slow',
    );
    expect(drawn(result)).toEqual([
      { text: 'slow', x: 40, y: 100, fontSize: 10, fontId: 'helvetica' },
      { text: 'ly', x: 60, y: 100, fontSize: 10, fontId: 'helvetica' },
    ]);
    // The new word stands inside the old one's room, so the line is not reported as moved.
    expect(result.movedLines).toBe(0);
  });

  it('draws again the tail of a word when the replacement is a hair wider and cannot shrink to fit', () => {
    // 1 pt glyphs; `W` is 0.4 pt wider than `x`: under the 0.5 pt move tolerance, yet over the
    // one point of room the next glyph leaves, even at 80 % of the size.
    const measure: FaceSource['measure'] = (text, _face, size) =>
      ([...text].reduce((sum, character) => sum + (character === 'W' ? 1.4 : 1), 0) * size) / 10;
    const result = plan(
      pageOf([blockOf('b0', [lineOf({ words: ['xyz'], baseline: 100, width: 1 })])]),
      'x',
      'W',
      { faces: facesOf([], measure) },
    );
    expect(result).toMatchObject({ replaced: 1, inPlace: 1, movedLines: 1, shrunk: 0 });
    expect(drawn(result)).toEqual([
      { text: 'W', x: 40, y: 100, fontSize: 10, fontId: 'helvetica' },
      { text: 'yz', x: 41.4, y: 100, fontSize: 10, fontId: 'helvetica' },
    ]);
    expect(erased(result)).toEqual([[40.05, 92, 42.95, 102]]);
  });

  it('lets a replacement use the letter-spacing that follows a match inside a word', () => {
    // 1 pt glyphs 1 pt apart: `x` ends at 41 and `y` starts at 42. `W` is 0.8 pt wider than
    // `x`, more than the move tolerance and less than the room up to `y`.
    const measure: FaceSource['measure'] = (text, _face, size) =>
      ([...text].reduce((sum, character) => sum + (character === 'W' ? 1.8 : 1), 0) * size) / 10;
    const line = lineOf({ words: ['xyz'], baseline: 100, width: 1, tracking: 1 });
    const result = plan(pageOf([blockOf('b0', [line])]), 'x', 'W', { faces: facesOf([], measure) });
    expect(result).toMatchObject({ replaced: 1, inPlace: 1, movedLines: 0, shrunk: 0 });
    expect(drawn(result)).toEqual([
      { text: 'W', x: 40, y: 100, fontSize: 10, fontId: 'helvetica' },
      { text: 'yz', x: 42.8, y: 100, fontSize: 10, fontId: 'helvetica' },
    ]);
  });

  it('ignores an empty line between two lines of a block', () => {
    const block = blockOf('b0', [
      lineOf({ words: ['alpha', 'beta'], baseline: 100 }),
      lineOf({ words: [], baseline: 112 }),
      lineOf({ words: ['gamma'], baseline: 124 }),
    ]);
    const result = plan(pageOf([block]), 'gamma', 'omega');
    expect(result).toMatchObject({ found: 1, replaced: 1, inPlace: 1 });
    expect(drawn(result)).toEqual([{ text: 'omega', x: 40, y: 124, fontSize: 10, fontId: 'helvetica' }]);
  });

  it('closes the gap of deleted words but leaves a column after a tab-like gap where it is', () => {
    // beta 40–60, xx 62.5–72.5, beta 75–95, then a 20 pt gap and gamma at 115.
    const line = lineOf({ words: ['beta', 'xx', 'beta', 'gamma'], baseline: 100, gaps: [GAP, GAP, 20] });
    const result = plan(pageOf([blockOf('b0', [line])]), 'beta', '');
    expect(result).toMatchObject({ found: 2, replaced: 2, movedLines: 0 });
    expect(drawn(result)).toEqual([{ text: 'xx', x: 40, y: 100, fontSize: 10, fontId: 'helvetica' }]);
    expect(erased(result)).toEqual([[40.05, 92, 94.95, 102]]);
  });

  describe('a tab-like gap after the match', () => {
    // alpha 40–65, beta 67.5–87.5, xx 90–100, then 20 pt, gamma 120–145.
    const line = () =>
      lineOf({ words: ['alpha', 'beta', 'xx', 'gamma'], baseline: 100, gaps: [GAP, GAP, 20] });

    it('does not move a column that starts right after the match', () => {
      const column = lineOf({ words: ['alpha', 'beta', 'gamma'], baseline: 100, gaps: [GAP, 20] });
      const result = plan(pageOf([blockOf('b0', [column])]), 'beta', 'be');
      expect(result).toMatchObject({ replaced: 1, inPlace: 1, movedLines: 0 });
      expect(drawn(result)).toEqual([{ text: 'be', x: 67.5, y: 100, fontSize: 10, fontId: 'helvetica' }]);
      expect(erased(result)).toEqual([[67.55, 92, 87.45, 102]]);
    });

    it('stops moving the line at the column when the moved text still ends before it', () => {
      const result = plan(pageOf([blockOf('b0', [line()])]), 'beta', 'bet');
      expect(drawn(result)).toEqual([
        { text: 'bet', x: 67.5, y: 100, fontSize: 10, fontId: 'helvetica' },
        { text: 'xx', x: 85, y: 100, fontSize: 10, fontId: 'helvetica' },
      ]);
      expect(erased(result)).toEqual([[67.55, 92, 99.95, 102]]);
    });

    it('moves the column along when the moved text would run into it', () => {
      const result = plan(pageOf([blockOf('b0', [line()])]), 'beta', 'b'.repeat(12));
      expect(result).toMatchObject({ replaced: 1, movedLines: 1 });
      expect(drawn(result)).toEqual([
        { text: 'b'.repeat(12), x: 67.5, y: 100, fontSize: 10, fontId: 'helvetica' },
        { text: 'xx', x: 130, y: 100, fontSize: 10, fontId: 'helvetica' },
        { text: 'gamma', x: 160, y: 100, fontSize: 10, fontId: 'helvetica' },
      ]);
      expect(erased(result)).toEqual([[67.55, 92, 144.95, 102]]);
    });
  });

  it('falls back to its own size, baseline and colour for a glyph that carries none', () => {
    const bare: Look = { origin: false, size: null, color: null };
    const line = lineOf({ words: ['alpha', 'beta'], baseline: 100, look: bare });
    const result = plan(pageOf([blockOf('b0', [line], { color: '#445566' })]), 'beta', 'bett');
    expect(result.request.insert[0]?.lines).toEqual([
      {
        text: 'bett',
        x: 67.5,
        y: 100,
        fontSize: 10,
        color: '#445566',
        fontId: 'helvetica',
        width: 20,
        lineSpan: [40, 87.5],
      },
    ]);
  });

  it('redraws the rest of a line from the same fallbacks when its glyphs carry no origin, size or colour', () => {
    const bare: Look = { origin: false, size: null, color: null };
    const result = plan(pageOf([blockOf('b0', [threeWords(bare)], { color: '#445566' })]), 'beta', 'bet');
    expect(result.request.insert[0]?.lines).toEqual([
      {
        text: 'bet',
        x: 67.5,
        y: 100,
        fontSize: 10,
        color: '#445566',
        fontId: 'helvetica',
        width: 15,
        lineSpan: [40, 115],
      },
      {
        text: 'gamma',
        x: 85,
        y: 100,
        fontSize: 10,
        color: '#445566',
        fontId: 'helvetica',
        width: 25,
        lineSpan: [40, 115],
      },
    ]);
  });

  it('measures the room of a line that ends against two blocks to its right by the nearer one', () => {
    const left = blockOf('b0', [lineOf({ words: ['alpha', 'beta'], baseline: 100 })]);
    const far = blockOf('b1', [lineOf({ words: ['ccc'], baseline: 100, x: 200 })]);
    const near = blockOf('b2', [lineOf({ words: ['bbb'], baseline: 100, x: 150 })]);
    // Room: from 67.5 to 150 less half the size = 77.5; 85 pt of text shrinks to 9.11 pt.
    const result = plan(pageOf([left, far, near], 400), 'beta', 'b'.repeat(17));
    expect(result).toMatchObject({ replaced: 1, shrunk: 1 });
    expect(drawn(result)).toEqual([
      { text: 'b'.repeat(17), x: 67.5, y: 100, fontSize: 9.11, fontId: 'helvetica' },
    ]);
  });
});

describe('planFindReplace: faces and sizes', () => {
  /** One line, the match at its end, so the replacement is drawn in place. */
  const endOfLine = (look: Look, style: Partial<TextStyle>) =>
    pageOf([blockOf('b0', [lineOf({ words: ['alpha', 'beta'], baseline: 100, look })], style)]);

  it('draws with the page’s own font when it can draw the text', () => {
    const result = plan(endOfLine({}, {}), 'beta', 'bett', { faces: facesOf(['Helvetica']) });
    expect(drawn(result).map((line) => line.fontId)).toEqual(['doc:Helvetica']);
    expect(result.ownFonts).toEqual(['Helvetica']);
    expect(result.standardFaces).toEqual([]);
  });

  it('takes the face from the block when the glyph has no font name', () => {
    const style = { fontName: 'Times-Italic', fontFamily: 'serif', italic: true } as const;
    const result = plan(endOfLine({ fontName: null }, style), 'beta', 'bett');
    expect(drawn(result).map((line) => line.fontId)).toEqual(['times-italic']);
    expect(result.standardFaces).toEqual(['Times-Italic']);
  });

  it('takes the family, weight and slant from the block when neither glyph nor block has a font name', () => {
    const style = { fontName: null, fontFamily: 'serif', bold: true, italic: true } as const;
    const result = plan(endOfLine({ fontName: null }, style), 'beta', 'bett');
    expect(drawn(result).map((line) => line.fontId)).toEqual(['times-bolditalic']);
  });

  it('draws text that WinAnsi cannot spell in the catalogue face that covers it', () => {
    const result = plan(endOfLine({}, {}), 'beta', 'ğeta');
    expect(drawn(result).map((line) => line.fontId)).toEqual(['noto-sans']);
    expect(result.standardFaces).toEqual([]);
  });

  it('skips a shipped face that lacks a glyph of the new text for one that has it', () => {
    const other: FontCandidate = { ...NOTO, id: 'other-sans', filePath: '/fonts/other-sans.ttf' };
    const metrics = {
      'noto-sans': metricsOf((point) => point < 0x100),
      'other-sans': metricsOf(),
    };
    const fonts = fontsOf(
      [NOTO, other],
      metrics,
      (candidate) => metrics[candidate.id as keyof typeof metrics],
    );
    // The page's font is Noto Sans, which the catalogue ships, but its table has no `ğ`.
    const page = endOfLine({ fontName: 'NotoSans' }, { fontName: 'NotoSans' });
    expect(drawn(plan(page, 'beta', 'bett', { fonts })).map((line) => line.fontId)).toEqual(['noto-sans']);
    expect(drawn(plan(page, 'beta', 'ğeta', { fonts })).map((line) => line.fontId)).toEqual(['other-sans']);
  });

  describe('a substitute face is sized to draw the old text as wide as the old font did', () => {
    // `beta` is four glyphs; the standard face measures it at 20 pt at size 10.
    it.each([
      [5.5, 11],
      [8, 11.5],
      [3, 8.5],
    ])('glyphs %s pt wide draw at %s pt', (glyphWidth, size) => {
      const line = lineOf({ words: ['beta'], baseline: 100, width: glyphWidth });
      const result = plan(pageOf([blockOf('b0', [line])]), 'beta', 'bett');
      expect(drawn(result).map((entry) => entry.fontSize)).toEqual([size]);
    });

    it('keeps the size when the old text is one the standard face cannot spell', () => {
      const line = lineOf({ words: ['ğeta'], baseline: 100, width: 5.5 });
      const result = plan(pageOf([blockOf('b0', [line])]), 'ğeta', 'beta');
      expect(drawn(result)).toEqual([{ text: 'beta', x: 40, y: 100, fontSize: 10, fontId: 'helvetica' }]);
    });

    it('keeps the size when the face measures the old text as nothing', () => {
      const line = lineOf({ words: ['beta'], baseline: 100, width: 5.5 });
      const measure: FaceSource['measure'] = (text, face, size) =>
        text === 'beta' ? 0 : HALF_EM(text, face, size, 0);
      const result = plan(pageOf([blockOf('b0', [line])]), 'beta', 'bett', { faces: facesOf([], measure) });
      expect(drawn(result).map((entry) => entry.fontSize)).toEqual([10]);
    });
  });

  describe('text that cannot be drawn again exactly stays where it is', () => {
    it.each([
      ['a font that is not a standard face', 'Arial', 'gamma'],
      ['a subset of a standard face', 'ABCDEF+Helvetica', 'gamma'],
      ['a standard face with no family', 'Symbol', 'gamma'],
      ['text WinAnsi cannot spell', 'Helvetica', 'ğamma'],
    ])('%s', (_label, fontName, tail) => {
      const line = lineOf({ words: ['alpha', 'beta', tail], baseline: 100, look: { fontName } });
      const result = plan(pageOf([blockOf('b0', [line], { fontName })]), 'beta', 'bet');
      // The line way would have to draw `tail` again, so only the match is replaced.
      expect(result).toMatchObject({ replaced: 1, inPlace: 1, movedLines: 0 });
      expect(drawn(result)).toEqual([{ text: 'bet', x: 67.5, y: 100, fontSize: 10, fontId: 'helvetica' }]);
      expect(erased(result)).toEqual([[67.55, 92, 87.45, 102]]);
    });

    it('does the same when the glyphs report no font at all', () => {
      const result = plan(pageOf([blockOf('b0', [threeWords({ fontName: null })])]), 'beta', 'bet');
      expect(drawn(result)).toEqual([{ text: 'bet', x: 67.5, y: 100, fontSize: 10, fontId: 'helvetica' }]);
    });
  });
});

describe('planFindReplace: titles', () => {
  it('keeps the right edge of a right-aligned line that grows to the left', () => {
    const line = lineOf({ words: ['alphabetical'], baseline: 100, x: 200 });
    const result = plan(pageOf([blockOf('b0', [line], { align: 'right' })]), 'alphabetical', 'a'.repeat(40));
    expect(result).toMatchObject({ replaced: 1, inPlace: 1, shrunk: 0 });
    expect(drawn(result)).toEqual([
      { text: 'a'.repeat(40), x: 60, y: 100, fontSize: 10, fontId: 'helvetica' },
    ]);
  });

  it('re-lays a right-aligned line whose new text would have to shrink below the limit', () => {
    const line = lineOf({ words: ['alphabetical'], baseline: 100, x: 200 });
    const result = plan(pageOf([blockOf('b0', [line], { align: 'right' })]), 'alphabetical', 'a'.repeat(60));
    expect(result).toMatchObject({ replaced: 1, inPlace: 0, reflowed: 1, shrunk: 0 });
    expect(drawn(result).map((entry) => entry.text)).toEqual(['a'.repeat(60)]);
  });
});

describe('planFindReplace: centred text', () => {
  it('lets a centred title grow to the page margins on both sides of its centre', () => {
    const line = lineOf({ words: ['alphabetical'], baseline: 100, x: 120 });
    const page = pageOf([blockOf('b0', [line], { align: 'center' })]);
    // The title is 60 pt wide, centred at 150; the margins leave 114 pt each side.
    expect(drawn(plan(page, 'alphabetical', 'a'.repeat(40)))).toEqual([
      { text: 'a'.repeat(40), x: 50, y: 100, fontSize: 10, fontId: 'helvetica' },
    ]);
    // 260 pt is 87.7 % of the 228 pt room: drawn smaller, still centred.
    const tight = plan(page, 'alphabetical', 'a'.repeat(52));
    expect(tight).toMatchObject({ inPlace: 1, shrunk: 1 });
    expect(drawn(tight)).toMatchObject([
      { text: 'a'.repeat(52), y: 100, fontSize: 8.76, fontId: 'helvetica' },
    ]);
    expect(drawn(tight)[0]?.x).toBeCloseTo(36.12, 6);
  });

  it('lets a line of a centred paragraph grow only to the width of the block', () => {
    const short = lineOf({ words: ['beta'], baseline: 100, x: 140 });
    const long = lineOf({ words: ['alphabet'], baseline: 112, x: 130 });
    const page = pageOf([blockOf('b0', [short, long], { align: 'center' })]);
    // The block is 40 pt wide; 45 pt of text draws at 88.8 % of its size and stays centred on 150.
    const result = plan(page, 'beta', 'a'.repeat(9));
    expect(result).toMatchObject({ replaced: 1, inPlace: 1, shrunk: 1 });
    expect(drawn(result)).toEqual([
      { text: 'a'.repeat(9), x: 130.02, y: 100, fontSize: 8.88, fontId: 'helvetica' },
    ]);
  });
});

describe('planFindReplace: table cells', () => {
  /** Two cells of one row: `alpha` at 40 and `beta` at 150, on one baseline. */
  const row = () =>
    blockOf('b0', [
      lineOf({ words: ['alpha'], baseline: 100 }),
      lineOf({ words: ['beta'], baseline: 100, x: 150 }),
    ]);

  it('draws a replacement that fits a cell only between 60 % and 80 % at the smaller size', () => {
    // Room 105 pt (up to the next cell less half the size); 140 pt of text is 75 %.
    const result = plan(pageOf([row()]), 'alpha', 'a'.repeat(28));
    expect(result).toMatchObject({ found: 1, replaced: 1, inPlace: 1, shrunk: 1, noRoom: 0, reflowed: 0 });
    expect(drawn(result)).toEqual([
      { text: 'a'.repeat(28), x: 40, y: 100, fontSize: 7.5, fontId: 'helvetica' },
    ]);
  });

  it('never lays a match that runs from one cell into the next out as a paragraph', () => {
    const result = plan(pageOf([row()]), 'alpha beta', 'x');
    expect(result).toMatchObject({ found: 1, replaced: 0, noRoom: 1, reflowed: 0 });
    expect(result.request).toEqual({ erase: [], insert: [], fonts: {} });
  });
});

describe('planFindReplace: hyphenation', () => {
  const hyphenated = (first: string, second: string) =>
    pageOf([
      blockOf('b0', [lineOf({ words: [first], baseline: 100 }), lineOf({ words: [second], baseline: 112 })]),
    ]);

  it('joins a word broken by a hyphen before a lower-case letter, without the hyphen', () => {
    const page = hyphenated('self-ref-', 'erential');
    expect(plan(page, 'referential', 'x').found).toBe(1);
    expect(plan(page, 'ref-erential', 'x').found).toBe(0);
    expect(drawn(plan(page, 'referential', 'x')).map((entry) => entry.text)).toEqual(['self-', 'x']);
  });

  it('keeps the hyphen before a capital letter, which is a compound and not hyphenation', () => {
    const page = hyphenated('foo-', 'Bar');
    expect(plan(page, 'foo-Bar', 'qux').found).toBe(1);
    expect(plan(page, 'fooBar', 'qux').found).toBe(0);
    expect(drawn(plan(page, 'foo-Bar', 'qux')).map((entry) => entry.text)).toEqual(['qux']);
  });

  it('drops hyphenation and soft hyphens from the words of a re-laid paragraph', () => {
    const block = blockOf('b0', [
      lineOf({ words: ['alpha', 'ref-'], baseline: 100 }),
      lineOf({ words: ['erential', 'co\u00adop', 'delta'], baseline: 112 }),
      lineOf({ words: ['epsilon'], baseline: 124 }),
    ]);
    const result = plan(pageOf([block]), 'delta epsilon', 'omega');
    expect(result).toMatchObject({ found: 1, reflowed: 1 });
    expect(drawn(result).map((entry) => entry.text)).toEqual(['alpha', 'referential', 'coop', 'omega']);
  });
});

describe('planFindReplace: a re-laid paragraph', () => {
  /**
   * Three lines of a wrapped paragraph, each too full to take the next line's first word:
   * `alpha beta gamma` / `delta epsilon zeta` / `eta theta`, 85 pt wide.
   */
  const paragraph = (
    patch: Partial<TextStyle> & { readonly align?: TextAlign } = {},
    look?: LineSpec['look'],
  ) =>
    blockOf(
      'b0',
      [
        lineOf({ words: ['alpha', 'beta', 'gamma'], baseline: 100, ...(look === undefined ? {} : { look }) }),
        lineOf({ words: ['delta', 'epsilon', 'zeta'], baseline: 112 }),
        lineOf({ words: ['eta', 'theta'], baseline: 124 }),
      ],
      patch,
    );

  it('breaks the whole paragraph again across the block width, one baseline per leading', () => {
    const result = plan(pageOf([paragraph()]), 'gamma delta', 'omega');
    expect(result).toMatchObject({ found: 1, replaced: 1, reflowed: 1, inPlace: 0, overflowed: 0 });
    expect(drawn(result)).toEqual([
      { text: 'alpha', x: 40, y: 100, fontSize: 10, fontId: 'helvetica' },
      { text: 'beta', x: 70, y: 100, fontSize: 10, fontId: 'helvetica' },
      { text: 'omega', x: 95, y: 100, fontSize: 10, fontId: 'helvetica' },
      { text: 'epsilon', x: 40, y: 112, fontSize: 10, fontId: 'helvetica' },
      { text: 'zeta', x: 80, y: 112, fontSize: 10, fontId: 'helvetica' },
      { text: 'eta', x: 105, y: 112, fontSize: 10, fontId: 'helvetica' },
      { text: 'theta', x: 40, y: 124, fontSize: 10, fontId: 'helvetica' },
    ]);
  });

  it('spaces the lines by 1.2 times the size when the block reports no leading', () => {
    const result = plan(pageOf([paragraph({ leading: 0 })]), 'gamma delta', 'omega');
    expect(drawn(result).map((entry) => entry.y)).toEqual([100, 100, 100, 112, 112, 112, 124]);
    const wide = plan(pageOf([paragraph({ leading: 20 })]), 'gamma delta', 'omega');
    expect(drawn(wide).map((entry) => entry.y)).toEqual([100, 100, 100, 120, 120, 120, 140]);
  });

  it('leaves out a deleted match and the word gap it leaves', () => {
    const result = plan(pageOf([paragraph()]), 'gamma delta', '');
    expect(result).toMatchObject({ replaced: 1, reflowed: 1 });
    expect(drawn(result).map((entry) => [entry.text, entry.x, entry.y])).toEqual([
      ['alpha', 40, 100],
      ['beta', 70, 100],
      ['epsilon', 40, 112],
      ['zeta', 80, 112],
      ['eta', 105, 112],
      ['theta', 40, 124],
    ]);
  });

  it('closes the gap of a deleted match in the middle of a line', () => {
    const block = blockOf('b0', [
      lineOf({ words: ['alpha', 'beta', 'gamma'], baseline: 100 }),
      lineOf({ words: ['delta', 'zeta', 'eta'], baseline: 112 }),
    ]);
    const result = plan(pageOf([block]), 'gamma delta', '');
    expect(drawn(result).map((entry) => [entry.text, entry.x, entry.y])).toEqual([
      ['alpha', 40, 100],
      ['beta', 70, 100],
      ['zeta', 95, 100],
      ['eta', 40, 112],
    ]);
  });

  it('justifies the lines of a paragraph that do not end it, and ends a paragraph at a line the author ended', () => {
    // Lines 0 and 2 reach the right edge; line 1 is short and the next line would have fitted
    // on it, so it ends a paragraph, and so does the last line.
    const block = blockOf('b0', [
      lineOf({ words: ['alpha', 'beta', 'gammaa'], baseline: 100 }),
      lineOf({ words: ['delta'], baseline: 112 }),
      lineOf({ words: ['epsilo', 'zeta', 'omega'], baseline: 124 }),
      lineOf({ words: ['eta'], baseline: 136 }),
    ]);
    const result = plan(pageOf([block]), 'gammaa delta', 'omega');
    expect(drawn(result).map((entry) => [entry.text, entry.x, entry.y])).toEqual([
      ['alpha', 40, 100],
      ['beta', 70, 100],
      ['omega', 95, 100],
      ['epsilo', 40, 112],
      ['zeta', 100, 112],
      ['omega', 40, 124],
      ['eta', 70, 124],
    ]);
  });

  it('keeps the indent of the first line', () => {
    const block = blockOf('b0', [
      lineOf({ words: ['alpha', 'beta', 'gamma'], baseline: 100, x: 50 }),
      lineOf({ words: ['delta', 'epsilon', 'zet'], baseline: 112 }),
      lineOf({ words: ['eta', 'theta'], baseline: 124 }),
    ]);
    const result = plan(pageOf([block]), 'gamma delta', 'omega');
    expect(drawn(result).map((entry) => [entry.text, entry.x, entry.y])).toEqual([
      ['alpha', 50, 100],
      ['beta', 80, 100],
      ['omega', 40, 112],
      ['epsilon', 70, 112],
      ['zet', 110, 112],
      ['eta', 40, 124],
      ['theta', 60, 124],
    ]);
  });

  it('keeps each run of a word in the font, size and colour it had', () => {
    const look = (word: number, index: number): Look => {
      if (word === 0 && index >= 2) return { fontName: 'Helvetica-Bold', size: index === 4 ? 8 : SIZE };
      if (word === 1 && index < 2) return { color: '#ff0000' };
      return {};
    };
    const result = plan(pageOf([paragraph({}, look)]), 'gamma delta', 'omega');
    expect(
      result.request.insert[0]?.lines
        .slice(0, 5)
        .map((line) => [line.text, line.fontId, line.fontSize, line.color]),
    ).toEqual([
      ['al', 'helvetica', 10, '#112233'],
      ['ph', 'helvetica-bold', 10, '#112233'],
      ['a', 'helvetica-bold', 8, '#112233'],
      ['be', 'helvetica', 10, '#ff0000'],
      ['ta', 'helvetica', 10, '#112233'],
    ]);
  });

  it('colours the replacement like the first glyph it replaces, or like the block when that has none', () => {
    const coloured = plan(pageOf([paragraph({}, { color: '#00ff00' })]), 'gamma delta', 'omega');
    expect(coloured.request.insert[0]?.lines.find((line) => line.text === 'omega')?.color).toBe('#00ff00');
    const bare = blockOf(
      'b0',
      [
        lineOf({ words: ['alpha', 'beta', 'gamma'], baseline: 100, look: { color: null } }),
        lineOf({ words: ['delta', 'epsilon', 'zeta'], baseline: 112 }),
        lineOf({ words: ['eta', 'theta'], baseline: 124 }),
      ],
      { color: '#445566' },
    );
    const result = plan(pageOf([bare]), 'gamma delta', 'omega');
    expect(result.request.insert[0]?.lines.find((line) => line.text === 'omega')?.color).toBe('#445566');
  });

  it('reads a glyph with no size from the block', () => {
    const block = blockOf(
      'b0',
      [
        lineOf({ words: ['alpha', 'beta', 'gamma'], baseline: 100, look: { size: null } }),
        lineOf({ words: ['delta', 'epsilon', 'zeta'], baseline: 112 }),
        lineOf({ words: ['eta', 'theta'], baseline: 124 }),
      ],
      { fontSize: 9 },
    );
    const result = plan(pageOf([block]), 'gamma delta', 'omega');
    expect(result.request.insert[0]?.lines.find((line) => line.text === 'alpha')?.fontSize).toBe(9);
  });

  it('grows into the free space below the block, beside and above neighbours that are not in the way', () => {
    const above = blockOf('b1', [lineOf({ words: ['top'], baseline: 60 })]);
    const beside = blockOf('b2', [lineOf({ words: ['side'], baseline: 140, x: 200 })]);
    const result = plan(
      pageOf([above, paragraph(), beside].map((block, at) => ({ ...block, id: `b${at}` }))),
      'gamma delta',
      'o'.repeat(60),
    );
    expect(result).toMatchObject({ reflowed: 1, overflowed: 0 });
    expect(Math.max(...drawn(result).map((entry) => entry.y))).toBe(136);
  });

  it('shrinks the paragraph before it would run into the block below', () => {
    // 4 lines at a leading of 15 pt end at 145; the block below starts at 142 - 3 = 139.
    const below = blockOf('b1', [lineOf({ words: ['below'], baseline: 150 })]);
    const result = plan(pageOf([paragraph({ leading: 15 }), below]), 'gamma delta', 'o'.repeat(60));
    expect(result).toMatchObject({ reflowed: 1, overflowed: 0 });
    const lines = drawn(result);
    expect(lines.every((entry) => entry.fontSize === 8.5)).toBe(true);
    expect(Math.max(...lines.map((entry) => entry.y))).toBe(138.25);
  });

  it('stops at a block below and reports what no longer fits', () => {
    const below = blockOf('b1', [lineOf({ words: ['below'], baseline: 134 })]);
    const result = plan(pageOf([paragraph(), below]), 'gamma delta', 'o'.repeat(60));
    expect(result).toMatchObject({ reflowed: 1, overflowed: 1 });
    // Shrunk to the 85 % limit and still four lines.
    expect(drawn(result).every((entry) => entry.fontSize === 8.5)).toBe(true);
  });

  describe('falls back to the text tool’s own reflow in one face when an original word cannot be drawn again', () => {
    const arial = { fontName: 'ABCDEF+Arial' } as const;
    // Each case: the second line of `alpha beta` / `gamma …`, with the stretch that has no face.
    it.each([
      [
        'at the end of the block',
        [
          lineOf({ words: ['alpha', 'beta'], baseline: 100 }),
          lineOf({ words: ['gamma', 'delta'], baseline: 112, look: (w) => (w === 1 ? arial : {}) }),
        ],
        'beta gamma',
        'alpha omega delta',
      ],
      [
        'before a word gap',
        [
          lineOf({ words: ['alpha', 'beta'], baseline: 100 }),
          lineOf({
            words: ['gamma', 'delta', 'epsilon'],
            baseline: 112,
            look: (w) => (w === 1 ? arial : {}),
          }),
        ],
        'beta gamma',
        'alpha omega delta epsilon',
      ],
      [
        'where the font changes inside a word',
        [
          lineOf({ words: ['alpha', 'beta'], baseline: 100 }),
          lineOf({
            words: ['gamma', 'delta'],
            baseline: 112,
            look: (w, i) => (w === 1 && i < 2 ? arial : {}),
          }),
        ],
        'beta gamma',
        'alpha omega delta',
      ],
      [
        'right before the match, inside its word',
        [
          lineOf({
            words: ['alpha', 'xbeta'],
            baseline: 100,
            look: (w, i) => (w === 1 && i === 0 ? arial : {}),
          }),
          lineOf({ words: ['gamma', 'delta'], baseline: 112 }),
        ],
        'beta gamma',
        'alpha xomega delta',
      ],
      [
        'because a glyph reports no font',
        [
          lineOf({ words: ['alpha', 'beta'], baseline: 100 }),
          lineOf({
            words: ['gamma', 'delta'],
            baseline: 112,
            look: (w) => (w === 1 ? { fontName: null } : {}),
          }),
        ],
        'beta gamma',
        'alpha omega delta',
      ],
    ])('%s', (_label, lines, find, text) => {
      const result = plan(pageOf([blockOf('b0', lines)]), find, 'omega');
      expect(result).toMatchObject({ found: 1, replaced: 1, reflowed: 1, inPlace: 0 });
      const inserted = result.request.insert.flatMap((entry) => entry.lines);
      expect(inserted.every((line) => line.fontId === 'noto-sans')).toBe(true);
      expect(inserted.map((line) => line.text).join(' ')).toBe(text);
      expect(erased(result).length).toBeGreaterThan(0);
    });

    const unfit = () =>
      blockOf('b0', [
        lineOf({ words: ['alpha', 'beta'], baseline: 100 }),
        lineOf({ words: ['gamma', 'delta'], baseline: 112, look: (w) => (w === 1 ? arial : {}) }),
      ]);

    it('draws in the block’s own font when that can spell the new text', () => {
      const own = { fontName: 'ABCDEF+Own' };
      const block = { ...unfit(), style: { ...unfit().style, ...own, fontFamily: 'serif' as const } };
      const result = plan(pageOf([block]), 'beta gamma', 'omega', { faces: facesOf(['ABCDEF+Own']) });
      expect(drawn(result).every((line) => line.fontId === 'doc:ABCDEF+Own')).toBe(true);
      expect(result.ownFonts).toEqual(['Own']);
      const unknown = { ...block, style: { ...block.style, fontFamily: 'unknown' as const } };
      const again = plan(pageOf([unknown]), 'beta gamma', 'omega', { faces: facesOf(['ABCDEF+Own']) });
      expect(drawn(again)).toEqual(drawn(result));
    });

    it('does the same for a block that reports no font name', () => {
      const block = { ...unfit(), style: { ...unfit().style, fontName: null } };
      const result = plan(pageOf([block]), 'beta gamma', 'omega');
      expect(result).toMatchObject({ replaced: 1, reflowed: 1 });
      expect(drawn(result).every((line) => line.fontId === 'noto-sans')).toBe(true);
    });

    it('leaves the block blank, with nothing to report as overflow, when all that is left is white space', () => {
      const block = blockOf('b0', [
        lineOf({ words: ['beta'], baseline: 100 }),
        lineOf({ words: ['gamma', '\u2003'], baseline: 112, look: (w) => (w === 1 ? arial : {}) }),
      ]);
      const result = plan(pageOf([block]), 'beta gamma', '');
      expect(result).toMatchObject({ replaced: 1, reflowed: 1, overflowed: 0 });
      expect(result.request.insert).toEqual([]);
      expect(erased(result).length).toBeGreaterThan(0);
    });

    it('refuses to plan without metrics for the catalogue face it would draw with', () => {
      const error = thrown(() =>
        plan(pageOf([unfit()]), 'beta gamma', 'omega', { fonts: fontsOf([NOTO], {}) }),
      );
      expect(error).toMatchObject({
        code: 'font-missing',
        details: { engineMessage: 'no metric table for face noto-sans' },
      });
    });
  });

  describe('refuses to re-lay a block when the catalogue cannot erase it', () => {
    it.each([
      ['an empty catalogue', fontsOf([], {})],
      ['a catalogue without metrics for its first face', fontsOf([NOTO], {})],
    ])('%s', (_label, fonts) => {
      const error = thrown(() => plan(pageOf([paragraph()]), 'gamma delta', 'omega', { fonts }));
      expect(error).toMatchObject({
        code: 'font-missing',
        details: { engineMessage: 'no catalogue metrics' },
      });
    });
  });
});
