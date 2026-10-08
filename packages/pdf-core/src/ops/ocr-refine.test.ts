/**
 * The second read of unsure words: a page of drawn rectangles (ink on white, 1 px per point), a
 * fake reader that answers by the width of the crop it gets, and the words that come back.
 */

import { describe, expect, it } from 'vitest';
import type { OcrWord } from '../engines/tesseract';
import { inkRuns, type Reading, type ReadWith, refineWords } from './ocr-refine';
import type { RgbaImage } from './ocr-scene';

const WIDTH = 200;
const HEIGHT = 60;

/** White page with black blocks `[x0, x1]` over the rows 20..39 (a 20-pixel-high word). */
function page(blocks: readonly (readonly [number, number])[], ink = 0): RgbaImage {
  const data = new Uint8Array(WIDTH * HEIGHT * 4).fill(255 - ink);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (const [from, to] of blocks) {
    for (let y = 20; y < 40; y += 1) {
      for (let x = from; x < to; x += 1) data.fill(ink, (y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 3);
    }
  }
  return { width: WIDTH, height: HEIGHT, data, scale: 1 };
}

const word = (text: string, confidence: number, x0 = 10, x1 = 150, y0 = 20, y1 = 40): OcrWord => ({
  text,
  x0,
  y0,
  x1,
  y1,
  confidence,
  line: 3,
});

/** A crop's PNG stand-in: its width, so the fake reader can tell the crops apart. */
const encode = (crop: RgbaImage): Uint8Array => new Uint8Array([crop.width / 3, crop.height / 3]);
const signal = new AbortController().signal;

function reader(answers: (width: number, models: ReadWith) => Reading | null) {
  const calls: { width: number; models: ReadWith }[] = [];
  return {
    calls,
    read: async (png: Uint8Array, models: ReadWith) => {
      calls.push({ width: png[0] as number, models });
      return answers(png[0] as number, models);
    },
  };
}

describe('inkRuns', () => {
  it('is one run for a word whose letters are close', () => {
    expect(
      inkRuns(
        page([
          [10, 30],
          [34, 60],
        ]),
        word('ab', 99),
      ),
    ).toEqual([[10, 60]]);
  });

  it('splits where the ink has a gap wider than a space', () => {
    expect(
      inkRuns(
        page([
          [10, 30],
          [60, 80],
          [120, 150],
        ]),
        word('a b c', 99),
      ),
    ).toEqual([
      [10, 30],
      [60, 80],
      [120, 150],
    ]);
  });

  it('finds light ink on a dark ground as well', () => {
    expect(
      inkRuns(
        page(
          [
            [10, 30],
            [60, 80],
          ],
          255,
        ),
        word('a b', 99),
      ),
    ).toEqual([
      [10, 30],
      [60, 80],
    ]);
  });

  it('finds no gap in a box without contrast, or one that is a speck', () => {
    expect(inkRuns(page([]), word('a b', 99))).toEqual([[10, 150]]);
    expect(
      inkRuns(
        page([
          [10, 30],
          [60, 80],
        ]),
        word('a b', 99, 10, 150, 20, 25),
      ),
    ).toEqual([[10, 150]]);
    expect(inkRuns(page([[10, 30]]), word('a', 99, 300, 320))).toEqual([]);
  });
});

describe('refineWords', () => {
  it('splits a word at a gap and reads each piece on its own', async () => {
    const { read, calls } = reader((width) => ({ text: `p${width}`, confidence: 95 }));
    const out = await refineWords(
      [word('+905437454438', 82)],
      page([
        [10, 30],
        [60, 80],
      ]),
      encode,
      read,
      signal,
    );
    expect(out.map((w) => [w.text, w.x0, w.x1, w.line, w.confidence])).toEqual([
      ['p32', 10, 30, 3, 95],
      ['p32', 60, 80, 3, 95],
    ]);
    expect(calls.every((call) => call.models === 'all')).toBe(true);
  });

  it('keeps the word whole when a piece is unreadable, unsure or has a space', async () => {
    const ink = page([
      [10, 30],
      [60, 80],
    ]);
    for (const answer of [null, { text: 'x', confidence: 20 }, { text: 'a b', confidence: 90 }]) {
      const { read } = reader(() => answer);
      const out = await refineWords([word('ab', 99)], ink, encode, read, signal);
      expect(out.map((w) => w.text)).toEqual(['ab']);
    }
  });

  it('takes a surer reading that only corrects letters', async () => {
    const { read } = reader(() => ({ text: 'gerçekleştirdim', confidence: 91 }));
    const out = await refineWords([word('gergeklestirdim', 80)], page([[10, 150]]), encode, read, signal);
    expect(out[0]).toMatchObject({ text: 'gerçekleştirdim', confidence: 91, line: 3 });
  });

  it('keeps the first reading when the new one is less sure, drops a mark, a digit or a space', async () => {
    const ink = page([[10, 150]]);
    for (const [first, answer] of [
      ['entegrasyonlarin', { text: 'entegrasyonların', confidence: 70 }],
      ['.NET', { text: 'NET', confidence: 99 }],
      ['HTML5,', { text: 'HTMLS,', confidence: 99 }],
      ['React’e', { text: "React'e", confidence: 99 }],
      ['two', { text: 't w', confidence: 99 }],
    ] as const) {
      const { read } = reader(() => answer);
      const out = await refineWords([word(first, 80)], ink, encode, read, signal);
      expect(out[0]?.text).toBe(first);
    }
  });

  it('reads nothing again that is sure, or has no two letters or digits', async () => {
    const { read, calls } = reader(() => ({ text: 'zz', confidence: 100 }));
    const input = [word('Merhaba', 96), word('—', 50), word('a', 50)];
    const out = await refineWords(input, page([[10, 150]]), encode, read, signal);
    expect(out).toEqual(input);
    expect(calls).toEqual([]);
  });

  it('reads a run of capitals with English alone and takes its capitals', async () => {
    const { read, calls } = reader((_width, models) =>
      models === 'english'
        ? { text: 'gerceklestirdim.MSSQL', confidence: 40 }
        : { text: 'gerçekleştirdim.MSSOL', confidence: 91 },
    );
    const out = await refineWords(
      [word('gergeklestirdim.MSSQL', 90)],
      page([[10, 150]]),
      encode,
      read,
      signal,
    );
    expect(out[0]?.text).toBe('gerçekleştirdim.MSSQL');
    expect(calls.map((call) => call.models)).toEqual(['all', 'english']);
    // One crop, drawn once.
    expect(calls[0]?.width).toBe(calls[1]?.width);
  });

  it('keeps the capitals when English reads another length, other letters or nothing', async () => {
    const ink = page([[10, 150]]);
    for (const answer of [{ text: 'SQLL', confidence: 90 }, { text: 'sql', confidence: 90 }, null]) {
      const { read } = reader(() => answer);
      const out = await refineWords([word('SOL', 99)], ink, encode, read, signal);
      expect(out[0]?.text).toBe('SOL');
    }
  });

  it('stops when the export is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { read } = reader(() => null);
    await expect(refineWords([word('abc', 10)], page([]), encode, read, controller.signal)).rejects.toThrow();
  });
});
