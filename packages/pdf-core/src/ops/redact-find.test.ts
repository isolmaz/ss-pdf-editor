/**
 * Pattern search for redaction marks, against real pages. The wrong answers that matter: a
 * hit rectangle in the wrong space (the redaction then erases something else), a regular
 * expression that silently matches literal text differently, a page outside the document
 * quietly skipped, and a search that runs unbounded on a one-character pattern.
 */

import { describe, expect, it } from 'vitest';
import { redactDocument, verifyRedaction } from './redact';
import { build, mark, pageTexts, TWO_LINES } from './redact.fixtures';
import {
  type FindPattern,
  findPatternMarks,
  markKey,
  mergeMarks,
  patternToMarks,
  uniqueMarks,
} from './redact-find';

const run = { signal: new AbortController().signal };

const abortsAtRead = (limit: number): AbortSignal => {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return reads >= limit;
    },
  } as AbortSignal;
};

describe('findPatternMarks', () => {
  it('finds a literal in the unrotated top-left space the redaction takes, and the redaction erases it', async () => {
    const source = await build([TWO_LINES]);
    const { hits, pagesSearched } = await findPatternMarks(source, [{ source: '4711', literal: true }], run);
    expect(pagesSearched).toBe(1);
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit).toMatchObject({ pageIndex: 0, text: '4711', patternIndex: 0 });
    expect(hit?.rects).toHaveLength(1);
    const [x0, y0, x1, y1] = hit?.rects[0] ?? [0, 0, 0, 0];
    // "Secret " is 7 glyphs before the number: the box starts right of x 50 and spans the
    // line's 12 pt height around the baseline 200 pt from the top.
    expect(x0).toBeGreaterThan(80);
    expect(x1 - x0).toBeGreaterThan(20);
    expect(y0).toBeGreaterThan(185);
    expect(y1).toBeLessThan(206);

    const marks = patternToMarks(hits, '#000000');
    expect(marks).toEqual([{ pageIndex: 0, space: 'app-v1', rect: [x0, y0, x1, y1] }]);
    const outcome = await redactDocument(
      source,
      { marks, imageMethod: 0, textMethod: 0, cleanMetadata: false, cleanAttachments: [] },
      run,
    );
    expect(await pageTexts(outcome.bytes)).toEqual(['Public line Secret']);
    expect(await verifyRedaction(source, marks)).toEqual({ marksCleared: false, remaining: [0] });
  });

  it('finds a hit on a rotated page in the same unrotated space, so the redaction still erases it', async () => {
    for (const rotate of [90, 180, 270] as const) {
      const source = await build([{ ...TWO_LINES, rotate }]);
      const { hits } = await findPatternMarks(source, [{ source: '4711', literal: true }], run);
      expect(hits, `rotation ${rotate}`).toHaveLength(1);
      const outcome = await redactDocument(
        source,
        {
          marks: patternToMarks(hits, ''),
          imageMethod: 0,
          textMethod: 0,
          cleanMetadata: false,
          cleanAttachments: [],
        },
        run,
      );
      expect(await pageTexts(outcome.bytes), `rotation ${rotate}`).toEqual(['Public line Secret']);
    }
  });

  it('matches a regular expression, with its flags, and searches each distinct match as one query', async () => {
    const source = await build([{ lines: [['Alfa 12 beta 345 alfa 12', 50, 400]] }]);
    const { hits } = await findPatternMarks(source, [{ source: '\\d+' }], run);
    expect(hits.map((hit) => hit.text)).toEqual(['12', '12', '345']);
    // `12` appears twice on the line: one query, two engine hits, one rectangle each.
    expect(hits.map((hit) => hit.rects.length)).toEqual([1, 1, 1]);
    expect(hits[0]?.rects[0]?.[0]).toBeLessThan(hits[1]?.rects[0]?.[0] ?? 0);

    const insensitive = await findPatternMarks(source, [{ source: 'alfa', flags: 'gi' }], run);
    expect(insensitive.hits.map((hit) => hit.text).sort()).toEqual(['Alfa', 'alfa']);
    const sensitive = await findPatternMarks(source, [{ source: 'alfa' }], run);
    expect(sensitive.hits.map((hit) => hit.text)).toEqual(['alfa']);
  });

  it('takes a literal as itself, including regular-expression characters, with or without case folding', async () => {
    const source = await build([{ lines: [['Price (a.b) and axb', 50, 400]] }]);
    const dotted = await findPatternMarks(source, [{ source: 'a.b', literal: true }], run);
    expect(dotted.hits.map((hit) => hit.text)).toEqual(['a.b']);
    const folded = await findPatternMarks(source, [{ source: 'A.B', literal: true, flags: 'i' }], run);
    expect(folded.hits.map((hit) => hit.text)).toEqual(['a.b']);
    const absent = await findPatternMarks(source, [{ source: 'a.c', literal: true }], run);
    expect(absent.hits).toEqual([]);
  });

  it('ignores a pattern that only matches the empty string', async () => {
    const source = await build([TWO_LINES]);
    const { hits } = await findPatternMarks(source, [{ source: 'x*' }], run);
    expect(hits).toEqual([]);
  });

  it('keeps the pattern index and runs each pattern only on its own pages', async () => {
    const source = await build([TWO_LINES, TWO_LINES, TWO_LINES]);
    const patterns: FindPattern[] = [
      { source: 'Secret', literal: true, pages: [2, 0] },
      { source: 'Public', literal: true, pages: [1] },
      { source: '4711' },
    ];
    const events: string[] = [];
    const { hits, pagesSearched } = await findPatternMarks(source, patterns, {
      signal: run.signal,
      onProgress: (entry) => events.push(`${entry.labelKey}:${entry.done}/${entry.total}`),
    });
    expect(pagesSearched).toBe(3);
    expect(events).toEqual([
      'op.progress.redact.find:1/3',
      'op.progress.redact.find:2/3',
      'op.progress.redact.find:3/3',
    ]);
    expect(hits.map((hit) => [hit.pageIndex, hit.patternIndex, hit.text])).toEqual([
      [0, 0, 'Secret'],
      [0, 2, '4711'],
      [1, 1, 'Public'],
      [1, 2, '4711'],
      [2, 0, 'Secret'],
      [2, 2, '4711'],
    ]);
  });

  it('searches only the pages the patterns ask for, in page order, when every pattern is scoped', async () => {
    const source = await build([TWO_LINES, TWO_LINES, TWO_LINES]);
    const { hits, pagesSearched } = await findPatternMarks(
      source,
      [
        { source: 'Secret', literal: true, pages: [2, 0] },
        { source: 'Public', literal: true, pages: [2, 2] },
      ],
      run,
    );
    expect(pagesSearched).toBe(2);
    expect(hits.map((hit) => [hit.pageIndex, hit.text])).toEqual([
      [0, 'Secret'],
      [2, 'Secret'],
      [2, 'Public'],
    ]);
  });

  it('drops a hit whose glyphs have no extent, instead of handing the engine an empty rectangle', async () => {
    const hidden = await build([TWO_LINES], (doc) => {
      doc.findPage(0).put('Contents', doc.addStream('BT /F1 12 Tf 0 Tz 50 300 Td (Hidden) Tj ET', {}));
    });
    // Zero horizontal scaling: the page text has an `H`, and its quad has no width.
    expect(await findPatternMarks(hidden, [{ source: 'H', literal: true }], run)).toEqual({
      hits: [],
      pagesSearched: 1,
    });
    const visible = await build([TWO_LINES]);
    expect((await findPatternMarks(visible, [{ source: 'P', literal: true }], run)).hits).toHaveLength(1);
  });

  it('searches no page for a pattern whose page list is empty', async () => {
    const source = await build([TWO_LINES]);
    expect(await findPatternMarks(source, [{ source: 'Secret', literal: true, pages: [] }], run)).toEqual({
      hits: [],
      pagesSearched: 0,
    });
  });

  it('answers an empty pattern list without opening the document', async () => {
    expect(await findPatternMarks(new Uint8Array(), [], run)).toEqual({ hits: [], pagesSearched: 0 });
  });

  it('refuses an empty source, an invalid expression and a page outside the document', async () => {
    const source = await build([TWO_LINES]);
    await expect(findPatternMarks(source, [{ source: 'ok' }, { source: '' }], run)).rejects.toMatchObject({
      code: 'selection-empty',
      details: { engineMessage: 'pattern 1 has an empty source' },
    });
    await expect(findPatternMarks(source, [{ source: '(' }], run)).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { engineMessage: expect.stringContaining('pattern 0 is not a valid regular expression') },
    });
    await expect(findPatternMarks(source, [{ source: '[' }], run)).rejects.toMatchObject({
      code: 'value-out-of-range',
    });
    for (const pages of [[1], [-1], [0.5]]) {
      await expect(findPatternMarks(source, [{ source: 'a', pages }], run)).rejects.toMatchObject({
        code: 'range-invalid',
      });
    }
  });

  it('maps an engine failure on bytes that are not a PDF', async () => {
    await expect(
      findPatternMarks(new TextEncoder().encode('nope'), [{ source: 'a' }], run),
    ).rejects.toMatchObject({
      code: 'corrupt-document',
    });
  });

  it('stops at every checkpoint when the signal is aborted', async () => {
    const source = await build([TWO_LINES]);
    // Reads: entry, after the engine loads, per page, after the search.
    const outcomes = { 1: 'AbortError', 2: 'AbortError', 3: 'ToolError', 4: 'AbortError' };
    for (const [limit, name] of Object.entries(outcomes)) {
      await expect(
        findPatternMarks(source, [{ source: 'Secret' }], { signal: abortsAtRead(Number(limit)) }),
      ).rejects.toMatchObject({ name });
    }
  });

  it('caps the rectangles of one page, however many patterns and matches ask for more', async () => {
    // 26 letters × up to 500 engine hits each; the page holds more than 2000 glyphs.
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    const lines: [string, number, number][] = [];
    for (let row = 0; row < 90; row += 1) lines.push([alphabet.repeat(3), 2, 498 - row * 5.4]);
    const source = await build([{ lines, size: 4 }]);
    const { hits } = await findPatternMarks(
      source,
      [{ source: '[a-z]' }, { source: 'a', literal: true }],
      run,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(2000);
    const rectangles = hits.reduce((sum, hit) => sum + hit.rects.length, 0);
    expect(rectangles).toBeGreaterThan(2000 - 26 * 2);
  });

  it('stops a run at the hit ceiling across pages', async () => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    const lines: [string, number, number][] = [];
    for (let row = 0; row < 90; row += 1) lines.push([alphabet.repeat(3), 2, 498 - row * 5.4]);
    // A short first page, so the ceiling falls in the middle of a later page.
    const pages = [TWO_LINES, ...Array.from({ length: 12 }, () => ({ lines, size: 4 }))];
    const source = await build(pages);
    const events: number[] = [];
    const { hits, pagesSearched } = await findPatternMarks(source, [{ source: '[a-z]' }], {
      signal: run.signal,
      onProgress: (entry) => events.push(entry.done ?? 0),
    });
    expect(hits.length).toBe(20000);
    expect(pagesSearched).toBeLessThan(13);
    expect(events.at(-1)).toBe(pagesSearched);
  }, 60_000);
});

describe('mark helpers', () => {
  it('keys a mark by its page and its rectangle rounded to a tenth of a point', () => {
    expect(markKey(mark([12.44, 44.06, 80, 52.349], 3))).toBe('p3:12.4,44.1,80.0,52.3');
  });

  it('keeps the first occurrence of each mark, in input order', () => {
    const first = mark([1, 2, 3, 4]);
    const same = mark([1.01, 2.01, 3.01, 4.01]);
    const other = mark([1, 2, 3, 4], 1);
    expect(uniqueMarks([first, other, same])).toEqual([first, other]);
    expect(uniqueMarks([first, other, same])[0]).toBe(first);
  });

  it('merges two lists ascending by page then by rectangle, without duplicates', () => {
    const a = [mark([5, 5, 9, 9], 1), mark([1, 1, 2, 2], 0)];
    const b = [
      mark([1, 1, 2, 2], 0),
      mark([1, 1, 3, 2], 0),
      mark([1, 1, 2, 3], 0),
      mark([0, 7, 8, 9], 0),
      mark([1, 2, 2, 3], 0),
    ];
    expect(mergeMarks(a, b).map((entry) => [entry.pageIndex, ...entry.rect])).toEqual([
      [0, 0, 7, 8, 9],
      [0, 1, 1, 2, 2],
      [0, 1, 1, 2, 3],
      [0, 1, 1, 3, 2],
      [0, 1, 2, 2, 3],
      [1, 5, 5, 9, 9],
    ]);
  });
});
