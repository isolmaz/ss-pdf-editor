/**
 * The edit planner against a block whose face is replaced by a wider one — the case that
 * rewrapped every line the reader did not touch. Faces here are fixed-pitch tables, so a
 * line's width is its character count times the advance: the arithmetic is visible.
 */

import { describe, expect, it } from 'vitest';
import { planTextEdit } from './plan';
import type { FontMetrics, Rect, TextBlock, TextPage } from './types';

const SIZE = 12;
const LEADING = 22;

/** A fixed-pitch face: every glyph `advance` thousandths of an em wide. */
function face(advance: number): FontMetrics {
  return {
    unitsPerEm: 1000,
    glyphAdvance: () => advance,
    ascender: 800,
    descender: -200,
    lineGap: 0,
    hasGlyph: () => true,
    missing: [],
  };
}

/** The original face: 500/1000 em, so a 12 pt glyph is 6 pt wide. */
const ORIGINAL = face(500);
/** The substitute: 6 % wider, as Noto Sans sets Latin text against Helvetica. */
const WIDER = face(530);

/** A block of full lines, each measured in the original face, starting at (72, 100). */
function block(id: string, texts: readonly string[], x = 72, top = 100): TextBlock {
  const lines = texts.map((text, index) => {
    const baseline = top + SIZE * 0.8 + index * LEADING;
    const width = text.length * SIZE * 0.5;
    const rect: Rect = [x, baseline - SIZE * 0.8, x + width, baseline + SIZE * 0.2];
    return { text, rect, words: [], baseline };
  });
  const right = Math.max(...lines.map((line) => line.rect[2]));
  const bottom = lines.at(-1)?.rect[3] ?? top;
  return {
    id,
    rect: [x, top, right, bottom],
    lines,
    text: texts.join('\n'),
    style: {
      fontName: 'Helvetica',
      fontFamily: 'sans',
      bold: false,
      italic: false,
      fontSize: SIZE,
      leading: LEADING,
      color: '#000000',
    },
    align: 'left',
  };
}

function pageOf(...blocks: TextBlock[]): TextPage {
  return { pageIndex: 0, width: 595, height: 842, rotation: 0, blocks };
}

const LIST = Array.from(
  { length: 6 },
  (_unused, index) => `Line ${index + 1} of the page - the quick brown fox jumps`,
);

describe('planTextEdit with a wider substitute face', () => {
  it('deletes a block that has no lines with an empty erase list and no insert', () => {
    const hollow = { ...block('b0', ['x']), lines: [] };
    expect(planTextEdit({ page: pageOf(hollow), blockId: 'b0', replacement: '  ' }, WIDER)).toEqual({
      erase: [],
      insert: [],
      fonts: {},
    });
  });

  it('refuses an edit of a block the page does not have, naming the block and the page', () => {
    const attempt = () =>
      planTextEdit({ page: pageOf(block('b0', LIST)), blockId: 'b9', replacement: 'x' }, WIDER);
    expect(attempt).toThrow(
      expect.objectContaining({
        code: 'range-invalid',
        details: expect.objectContaining({ pageIndex: 0, engineMessage: 'block b9' }),
      }),
    );
  });

  it('keeps every line the reader kept on one line on one line, the edited one included', () => {
    const list = block('b0', LIST);
    const edited = LIST.map((text, index) => (index === 2 ? 'EDITED line' : text)).join('\n');
    const request = planTextEdit({ page: pageOf(list), blockId: 'b0', replacement: edited }, WIDER);
    const lines = request.insert[0]?.lines ?? [];
    expect(lines.map((line) => line.text)).toEqual(edited.split('\n'));
    // Same rhythm as the block: one baseline per original line, nothing pushed below it.
    expect(lines.map((line) => line.y)).toEqual(list.lines.map((line) => line.baseline));
  });

  it('wraps as before when a block beside it leaves no room to widen', () => {
    const list = block('b0', LIST);
    const neighbour = block('b1', ['Margin note'], list.rect[2] + 4, 100);
    const request = planTextEdit(
      { page: pageOf(list, neighbour), blockId: 'b0', replacement: LIST.join('\n') },
      WIDER,
    );
    // The box keeps its width, so the wider face breaks each full line once.
    expect(request.insert[0]?.lines.length).toBe(12);
    for (const line of request.insert[0]?.lines ?? [])
      expect(line.x + (line.width ?? 0)).toBeLessThan(neighbour.rect[0]);
  });

  it('wraps text that is really longer than the line, instead of widening the block across the page', () => {
    const list = block('b0', LIST);
    const longer = `${LIST[0]} and keeps running well past where the line used to end`;
    const request = planTextEdit({ page: pageOf(list), blockId: 'b0', replacement: longer }, WIDER);
    expect(request.insert[0]?.lines.length).toBeGreaterThan(1);
    for (const line of request.insert[0]?.lines ?? []) {
      expect(line.x + (line.width ?? 0)).toBeLessThanOrEqual(list.rect[2] + 0.01);
    }
  });

  it('still keeps the untouched lines whole when one edited line runs well past the block', () => {
    const list = block('b0', LIST);
    const lengthened = 'Line 3 was rewritten, and it keeps running well past where the line used to end';
    const edited = LIST.map((text, index) => (index === 2 ? lengthened : text));
    const request = planTextEdit(
      { page: pageOf(list), blockId: 'b0', replacement: edited.join('\n') },
      WIDER,
    );
    const texts = request.insert[0]?.lines.map((line) => line.text) ?? [];
    // The five lines the reader did not touch come back whole, in order; only the long one wraps.
    expect(texts.filter((text) => LIST.includes(text))).toEqual(LIST.filter((_text, index) => index !== 2));
    expect(texts.length).toBeGreaterThan(LIST.length);
    expect(texts.length).toBeLessThan(LIST.length + 3);
  });

  it('leaves a block in its own face exactly as wide as it was', () => {
    const list = block('b0', LIST);
    const request = planTextEdit(
      { page: pageOf(list), blockId: 'b0', replacement: LIST.join('\n') },
      ORIGINAL,
    );
    expect(request.insert[0]?.lines.map((line) => line.text)).toEqual(LIST);
  });
});

/** A block whose lines have exactly the given ink boxes (one line each). */
function blockOfRects(id: string, lineRects: readonly Rect[]): TextBlock {
  const base = block(id, ['x']);
  const lines = lineRects.map((rect) => ({ text: 'x', rect, words: [], baseline: rect[3] }));
  const rect: Rect = [
    Math.min(...lineRects.map((r) => r[0])),
    Math.min(...lineRects.map((r) => r[1])),
    Math.max(...lineRects.map((r) => r[2])),
    Math.max(...lineRects.map((r) => r[3])),
  ];
  return { ...base, rect, lines, text: lines.map((line) => line.text).join('\n') };
}

function eraseOf(target: TextBlock, ...others: TextBlock[]): readonly Rect[] {
  const request = planTextEdit(
    { page: pageOf(target, ...others), blockId: target.id, replacement: '' },
    ORIGINAL,
  );
  return request.erase[0]?.rects ?? [];
}

function expectRects(actual: readonly Rect[], expected: readonly Rect[]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((rect, index) => {
    rect.forEach((value, axis) => {
      expect(actual[index]?.[axis]).toBeCloseTo(value, 6);
    });
  });
}

describe('planTextEdit erase rects', () => {
  const LINE: Rect = [100, 100, 200, 112];
  const own = () => blockOfRects('b0', [LINE]);

  it('pads a lone line by 3 pt on every side', () => {
    expectRects(eraseOf(own()), [[97, 97, 203, 115]]);
  });

  it.each<[string, Rect, Rect]>([
    ['a neighbour touching the band edge below', [202, 112, 300, 124], [97, 97, 201, 115]],
    ['a neighbour touching the band edge above', [202, 88, 300, 100], [97, 97, 201, 115]],
    ['a neighbour touching the line on the right', [200, 100, 260, 112], [97, 97, 200, 115]],
    ['a neighbour touching the line on the left', [40, 100, 100, 112], [100, 97, 203, 115]],
    ['a neighbour touching the line from below', [100, 112, 200, 124], [97, 97, 203, 112]],
    ['a neighbour close below', [100, 114, 200, 124], [97, 97, 203, 113]],
    ['a neighbour touching the line from above', [200, 40, 260, 100], [97, 100, 200, 115]],
    ['a neighbour above that only touches in x', [200, 0, 260, 98], [97, 99, 203, 115]],
  ])('caps the pad against %s', (_name, neighbour, expected) => {
    expectRects(eraseOf(own(), blockOfRects('b1', [neighbour])), [expected]);
  });

  it('ignores a neighbour that is out of the line band, however near in x', () => {
    expectRects(eraseOf(own(), blockOfRects('b1', [[202, 0, 300, 50]])), [[97, 97, 203, 115]]);
  });

  it('ignores a neighbour that is out of the line column, however near in y', () => {
    expectRects(eraseOf(own(), blockOfRects('b1', [[300, 0, 400, 98]])), [[97, 97, 203, 115]]);
  });

  it('grows a zero-width line to 0.1 pt when neighbours cap its pad to nothing', () => {
    const thin = blockOfRects('b0', [[100, 100, 100, 112]]);
    const left = blockOfRects('b1', [[40, 100, 100, 112]]);
    const right = blockOfRects('b2', [[100, 100, 160, 112]]);
    expectRects(eraseOf(thin, left, right), [[99.95, 97, 100.05, 115]]);
  });

  it('grows a zero-height line to 0.1 pt when neighbours cap its pad to nothing', () => {
    const flat = blockOfRects('b0', [[100, 100, 200, 100]]);
    const above = blockOfRects('b1', [[100, 50, 200, 100]]);
    const below = blockOfRects('b2', [[100, 100, 200, 150]]);
    expectRects(eraseOf(flat, above, below), [[97, 99.95, 203, 100.05]]);
  });

  it('merges lines whose padded boxes overlap, and only those', () => {
    expectRects(
      eraseOf(
        blockOfRects('b0', [
          [100, 100, 200, 112],
          [100, 114, 200, 126],
        ]),
      ),
      [[97, 97, 203, 129]],
    );
  });

  it('merges padded boxes that merely touch', () => {
    expectRects(
      eraseOf(
        blockOfRects('b0', [
          [100, 100, 200, 112],
          [0, 100, 94, 112],
        ]),
      ),
      [[-3, 97, 203, 115]],
    );
  });

  it('keeps lines side by side on one row as separate rects', () => {
    expectRects(
      eraseOf(
        blockOfRects('b0', [
          [100, 100, 150, 112],
          [300, 100, 350, 112],
        ]),
      ),
      [
        [97, 97, 153, 115],
        [297, 97, 353, 115],
      ],
    );
  });
});

describe('planTextEdit box fitting and justification', () => {
  const TEXT = 'abcdefghi '.repeat(4).trim();
  const WIDE_PAGE = { ...pageOf(), width: 2000 };
  const run = (
    blocks: TextBlock[],
    options: { align?: 'left' | 'right' | 'center' | 'justify' },
    replacement = TEXT,
    page: TextPage = pageOf(...blocks),
  ) => planTextEdit({ page, blockId: 'b0', replacement, options }, WIDER).insert[0]?.lines ?? [];
  // 40 chars: 234 pt in the original face, 248.04 pt in the wider one.
  const own = () => block('b0', [TEXT]);

  it('widens right for left text, left for right text and both ways for centred text', () => {
    expect(run([own()], { align: 'left' })[0]?.x).toBeCloseTo(72, 6);
    expect(run([own()], { align: 'center' })[0]?.x).toBeCloseTo(64.98, 6);
    expect(run([own()], { align: 'right' })[0]?.x).toBeCloseTo(57.96, 6);
  });

  it('does not widen across a block that touches the right edge', () => {
    const list = own();
    const touching = block('b1', ['N'], list.rect[2], 100);
    expect(run([list, touching], { align: 'left' }).length).toBe(2);
  });

  it('does not widen right-aligned text into a block close on its left', () => {
    const list = own();
    const beside = blockOfRects('b1', [[10, 100, 68, 112]]);
    expect(run([list, beside], { align: 'right' }).length).toBe(2);
  });

  it('ignores a block above that merely sits beside the box horizontally', () => {
    const list = own();
    const above = blockOfRects('b1', [[list.rect[2] + 4, 40, list.rect[2] + 50, 90]]);
    expect(run([list, above], { align: 'left' }).length).toBe(1);
  });

  it('wraps text longer than 1.25 times the line even when the page has the room', () => {
    const list = own();
    const longer = `${TEXT} and keeps running well past where the line used to end`;
    const lines = run([list], { align: 'left' }, longer, { ...WIDE_PAGE, blocks: [list] });
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.x + (line.width ?? 0)).toBeLessThanOrEqual(list.rect[2] + 0.01);
  });

  it('carries stretched word placements on every full line of a justified paragraph, and natural ones on its last', () => {
    const list = own();
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll';
    const lines = run([list], { align: 'justify' }, text);
    // The box keeps its width (234 pt; the paragraph is longer than 1.25 lines): seven 4-letter words are 34 glyphs of 6.36 pt, an eighth word would not fit.
    expect(lines.map((line) => line.text)).toEqual([
      'aaaa bbbb cccc dddd eeee ffff gggg',
      'hhhh iiii jjjj kkkk llll',
    ]);
    const glyph = SIZE * 0.53;
    const placed = lines.map((line) => line.words ?? []);
    expect(placed.map((row) => row.map((word) => word.text))).toEqual(
      lines.map((line) => line.text.split(' ')),
    );
    const edge = list.rect[2];
    // First line: starts at the box's left edge, the last word ends on the right edge, and the gaps are equal.
    const first = placed[0] ?? [];
    expect(first[0]?.x).toBeCloseTo(list.rect[0], 6);
    const lastWord = first.at(-1);
    expect((lastWord?.x ?? 0) + (lastWord?.text.length ?? 0) * glyph).toBeCloseTo(edge, 2);
    const gaps = first.slice(1).map((word, index) => {
      const before = first[index];
      return word.x - ((before?.x ?? 0) + (before?.text.length ?? 0) * glyph);
    });
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0] ?? 0, 2);
    // Stretched: wider than the natural single space.
    expect(gaps[0]).toBeGreaterThan(glyph);
    // Last line: natural positions, one space glyph between words, ending short of the edge.
    const last = placed[1] ?? [];
    expect(last[0]?.x).toBeCloseTo(list.rect[0], 6);
    expect(last[1]?.x).toBeCloseTo(list.rect[0] + 4 * glyph + glyph, 6);
    expect(last[2]?.x).toBeCloseTo(list.rect[0] + 2 * (4 * glyph + glyph), 6);
    // Any other alignment is drawn whole.
    for (const align of ['left', 'right', 'center'] as const) {
      for (const line of run([list], { align }, text)) expect(line.words).toBeUndefined();
    }
  });
});
