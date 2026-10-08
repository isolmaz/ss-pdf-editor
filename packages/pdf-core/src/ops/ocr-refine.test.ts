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
      [word('+905550102030', 82)],
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

  it('keeps the readings that lost as alternatives: the first read, a reread of another shape, the capitals of the first read', async () => {
    const ink = page([[10, 150]]);
    // a surer reread that corrects letters is taken, and the first read stays as the other reading
    const taken = await refineWords(
      [word('gergeklestirdim', 80)],
      ink,
      encode,
      reader(() => ({ text: 'gerçekleştirdim', confidence: 91 })).read,
      signal,
    );
    expect(taken[0]).toMatchObject({ text: 'gerçekleştirdim', alternatives: ['gergeklestirdim'] });
    // a reread of another shape is not taken (it could drop a dot), but the ink may still prefer it
    const refused = await refineWords(
      [word('%20', 80)],
      ink,
      encode,
      reader(() => ({ text: '9020', confidence: 99 })).read,
      signal,
    );
    expect(refused[0]).toMatchObject({ text: '%20', confidence: 80, alternatives: ['9020'] });
    // a less sure reread of the same shape is another reading as well
    const unsure = await refineWords(
      [word('modern', 80)],
      ink,
      encode,
      reader(() => ({ text: 'rnodern', confidence: 60 })).read,
      signal,
    );
    expect(unsure[0]).toMatchObject({ text: 'modern', alternatives: ['rnodern'] });
    // English's capitals replace the first read's, which stays beside them
    const english = await refineWords(
      [word('SOL', 99)],
      ink,
      encode,
      reader(() => ({ text: 'SQL', confidence: 90 })).read,
      signal,
    );
    expect(english[0]).toMatchObject({ text: 'SQL', alternatives: ['SOL'] });
    // nothing differs (the same reading twice, or one with a space): no alternatives at all
    for (const answer of [
      { text: 'modern', confidence: 99 },
      { text: 'mod ern', confidence: 99 },
    ]) {
      const same = await refineWords([word('modern', 80)], ink, encode, reader(() => answer).read, signal);
      expect(same[0]).not.toHaveProperty('alternatives');
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

  it('reads the least sure words first and no more than 150 crops of a page', async () => {
    // 200 unsure words of the same box, the sure-est ones last in the page
    const input = Array.from({ length: 200 }, (_, at) => word('abc', 30 + (at % 60), 10, 150, 20, 40));
    const { read, calls } = reader(() => ({ text: 'abd', confidence: 99 }));
    const out = await refineWords(input, page([[10, 150]]), encode, read, signal);
    expect(calls).toHaveLength(150);
    const changed = input.filter((_, at) => out[at]?.text === 'abd').map((entry) => entry.confidence);
    expect(changed).toHaveLength(150);
    // everything read again was below what was left alone
    expect(Math.max(...changed)).toBeLessThanOrEqual(
      Math.min(...input.filter((_, at) => out[at]?.text === 'abc').map((entry) => entry.confidence)),
    );
  });

  it('reads words with a gap in their ink before the unsure ones, whatever their confidence', async () => {
    const { read, calls } = reader((width) => (width === 32 ? { text: 'ab', confidence: 95 } : null));
    const ink = page([
      [10, 30],
      [60, 80],
    ]);
    await refineWords([word('abc', 30, 100, 190), word('abc', 99)], ink, encode, read, signal);
    // the split word (confident, two pieces) is read first, the unsure word whole after it
    expect(calls.map((call) => call.width)).toEqual([32, 32, 102]);
  });

  it('does not read what would be dropped as a graphic, or the capitals again when English alone reads like all', async () => {
    const { read, calls } = reader(() => ({ text: 'SQL', confidence: 99 }));
    const ink = page([[10, 150]]);
    // garbage letters at 10 % are what tesseract makes of an icon
    await refineWords([word('qxz', 10)], ink, encode, read, signal);
    expect(calls).toEqual([]);
    const sure = [word('SOL', 99)];
    expect((await refineWords(sure, ink, encode, read, signal, { englishAlone: false }))[0]?.text).toBe(
      'SOL',
    );
    expect(calls).toEqual([]);
    expect((await refineWords(sure, ink, encode, read, signal))[0]?.text).toBe('SQL');
    expect(calls.map((call) => call.models)).toEqual(['english']);
  });

  it('draws a crop only as large as the word needs: 100 pixels high at most, not at all past a million pixels', async () => {
    const sizes: number[][] = [];
    const grab = (crop: RgbaImage): Uint8Array => {
      sizes.push([crop.width, crop.height]);
      return new Uint8Array(1);
    };
    const { read, calls } = reader(() => null);
    const big = (width: number, height: number): RgbaImage => ({
      width,
      height,
      data: new Uint8Array(width * height * 4).fill(255),
      scale: 1,
    });
    // 20 px high: ×3; 45 px: ×2; 120 px: ×1
    await refineWords([word('abc', 40, 10, 100, 20, 40)], big(300, 300), grab, read, signal);
    await refineWords([word('abc', 40, 10, 100, 20, 65)], big(300, 300), grab, read, signal);
    await refineWords([word('abc', 40, 10, 100, 20, 140)], big(300, 300), grab, read, signal);
    expect(sizes).toEqual([
      [(90 + 12) * 3, (20 + 12) * 3],
      [(90 + 12) * 2, (45 + 12) * 2],
      [90 + 12, 120 + 12],
    ]);
    // a box of 1500 × 1000 pixels is not cropped, nor read
    sizes.length = 0;
    calls.length = 0;
    await refineWords([word('abc', 40, 100, 1600, 100, 1100)], big(2000, 1500), grab, read, signal);
    expect(sizes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('stops when the export is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { read } = reader(() => null);
    await expect(refineWords([word('abc', 40)], page([]), encode, read, controller.signal)).rejects.toThrow();
  });
});
