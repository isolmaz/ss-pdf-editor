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
