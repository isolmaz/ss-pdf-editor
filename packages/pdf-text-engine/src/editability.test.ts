/**
 * The editability verdict ladder on hand-built blocks: each rung, in the order the module
 * documents (first match wins), and the page-level answer for a page with no text layer or
 * with blocks that hold no glyphs.
 */

import { describe, expect, it } from 'vitest';
import { measureEditability } from './editability';
import type { GlyphBox, TextBlock, TextPage } from './types';

/** A glyph whose box centre sits at (x, y). */
const glyph = (ch: string, x: number, y: number): GlyphBox => ({
  ch,
  rect: [x - 2, y - 4, x + 2, y + 4],
  advance: 4,
});

/** One line whose glyphs run from (x0, y0) by (dx, dy) per glyph. */
function block(
  id: string,
  fields: {
    fontName?: string | null;
    family?: 'sans' | 'serif' | 'mono' | 'unknown';
    bold?: boolean;
    italic?: boolean;
    step?: readonly [number, number];
    glyphs?: number;
  } = {},
): TextBlock {
  const [dx, dy] = fields.step ?? [5, 0];
  const glyphs = Array.from({ length: fields.glyphs ?? 3 }, (_, index) =>
    glyph('a', 100 + index * dx, 200 + index * dy),
  );
  return {
    id,
    rect: [90, 190, 130, 230],
    lines: [
      {
        text: 'aaa',
        rect: [90, 190, 130, 230],
        baseline: 204,
        words: [{ text: 'aaa', rect: [90, 190, 130, 230], glyphs }],
      },
    ],
    text: 'aaa',
    style: {
      fontName: fields.fontName === undefined ? 'ABCDEF+NotoSans' : fields.fontName,
      fontFamily: fields.family ?? 'sans',
      bold: fields.bold ?? false,
      italic: fields.italic ?? false,
      fontSize: 10,
      leading: 12,
      color: '#000000',
    },
    align: 'left',
  };
}

const page = (blocks: readonly TextBlock[]): TextPage => ({
  pageIndex: 4,
  width: 595,
  height: 842,
  rotation: 0,
  blocks,
});

describe('measureEditability', () => {
  it('walks the ladder in order: no glyphs, rotated, skewed, Type3, base-14, embedded, shipped', () => {
    const report = measureEditability(
      page([
        block('empty', { glyphs: 0 }),
        block('vertical', { step: [0, 5] }),
        block('reversed', { step: [-5, 0] }),
        block('skewed', { step: [5, 2] }),
        block('type3', { fontName: 'Type3Font' }),
        block('helvetica', { fontName: 'Helvetica-Bold', bold: true }),
        block('arial', { fontName: 'ABCDEF+Arial' }),
        block('noto', { fontName: 'ABCDEF+NotoSans' }),
        block('noto-bold', { fontName: 'NotoSans-SemiBold', bold: true }),
        block('noto-wrong-axis', { fontName: 'NotoSans', italic: true }),
        block('no-name', { fontName: null }),
      ]),
    );
    expect(
      report.blocks.map((item) => [
        item.blockId,
        item.verdict,
        item.reason,
        item.fontEmbedded,
        item.substitutionRequired,
      ]),
    ).toEqual([
      ['empty', 'not-editable', 'no-glyphs', true, false],
      ['vertical', 'not-editable', 'rotated', true, false],
      ['reversed', 'not-editable', 'rotated', true, false],
      ['skewed', 'not-editable', 'skewed', true, false],
      ['type3', 'not-editable', 'type3', true, false],
      // A base-14 name is the proof that nothing is embedded.
      ['helvetica', 'substituted', 'standard-font', false, true],
      ['arial', 'substituted', 'embedded-font', true, true],
      ['noto', 'editable', 'ok', true, false],
      ['noto-bold', 'editable', 'ok', true, false],
      // The name matches a shipped face but the style does not: re-rendering would change it.
      ['noto-wrong-axis', 'substituted', 'embedded-font', true, true],
      ['no-name', 'substituted', 'embedded-font', true, true],
    ]);
    expect([report.pageIndex, report.editableCount, report.nonEditableCount, report.pageReason]).toEqual([
      4,
      6,
      5,
      'ok',
    ]);
  });

  it('names a page with no blocks scanned and one whose blocks hold no glyphs image-only', () => {
    expect(measureEditability(page([])).pageReason).toBe('scanned');
    const imageOnly = measureEditability(page([block('a', { glyphs: 0 }), block('b', { glyphs: 0 })]));
    expect([imageOnly.pageReason, imageOnly.editableCount, imageOnly.nonEditableCount]).toEqual([
      'image-only',
      0,
      2,
    ]);
  });
});
