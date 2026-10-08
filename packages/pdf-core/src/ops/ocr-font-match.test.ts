/**
 * The font matcher on synthetic scans: pages set in a real font with MuPDF (Helvetica, Times,
 * Courier, and the Noto Sans the app ships), at 150 and 200 dpi, with and without noise and with
 * the OCR's size estimate off by 3 %. The candidates are the faces Word would choose between:
 * Arial, Times New Roman and Courier New (the base-14 faces) and Noto Sans (its file).
 */

import { readFileSync } from 'node:fs';
import type { Font } from 'mupdf';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMupdf, type Mupdf } from '../engines/mupdf';
import { chooseReadings, type FaceCandidate, type MatchWord, matchFamily } from './ocr-font-match';
import { renderScan, renderWord } from './ocr-font-match.fixtures';

const NOTO = new Uint8Array(
  readFileSync(new URL('../../../../public/fonts/noto/NotoSans-Regular.ttf', import.meta.url)),
);

const CANDIDATES: readonly FaceCandidate[] = [
  { family: 'Arial', kind: 'sans', bytes: null },
  { family: 'Times New Roman', kind: 'serif', bytes: null },
  { family: 'Courier New', kind: 'mono', bytes: null },
  { family: 'Noto Sans', kind: 'sans', bytes: NOTO },
];

let mupdf: Mupdf;
const faces = new Map<string, Font>();
beforeAll(async () => {
  mupdf = await loadMupdf();
  faces.set('Arial', new mupdf.Font('Helvetica'));
  faces.set('Times New Roman', new mupdf.Font('Times-Roman'));
  faces.set('Courier New', new mupdf.Font('Courier'));
  faces.set('Noto Sans', new mupdf.Font('NotoSans-Regular', NOTO));
});

describe('matchFamily', () => {
  const cases = CANDIDATES.flatMap(({ family }) =>
    [150, 200].flatMap((dpi) => [0, 40].map((amplitude) => ({ family, dpi, amplitude }))),
  );

  it.each(cases)(
    '$family scan at $dpi dpi, noise $amplitude: that family, clearly ahead',
    ({ family, dpi, amplitude }) => {
      const { image, words } = renderScan(mupdf, faces.get(family) as Font, {
        dpi,
        size: 11,
        amplitude,
        sizeError: 1.03,
      });
      const match = matchFamily(mupdf, image, words, CANDIDATES);
      expect(match.family).toBe(family);
      expect(match.score).toBeGreaterThan(0.5);
      expect(match.score - (match.runnerUp?.score ?? 0)).toBeGreaterThan(0.1);
    },
  );

  it('is deterministic and independent of the candidates order', () => {
    const { image, words } = renderScan(mupdf, faces.get('Noto Sans') as Font, {
      dpi: 150,
      size: 11,
      amplitude: 20,
    });
    const first = matchFamily(mupdf, image, words, CANDIDATES);
    const reversed = matchFamily(mupdf, image, words, [...CANDIDATES].reverse());
    expect(reversed).toEqual(first);
  });

  it('compares at most 40 words and only regular ones of four letters or more', () => {
    const { image, words } = renderScan(mupdf, faces.get('Times New Roman') as Font, {
      dpi: 150,
      size: 11,
      amplitude: 0,
    });
    // Marking every word bold or italic leaves nothing to compare: all families score 0.
    const marked = words.map((word, at) => ({ ...word, bold: at % 2 === 0, italic: at % 2 === 1 }));
    const none = matchFamily(mupdf, image, marked, CANDIDATES);
    expect(none).toEqual({ family: 'Arial', score: 0, runnerUp: { family: 'Times New Roman', score: 0 } });
    // Words of three letters do not count either.
    const short = words.map((word) => ({ ...word, text: word.text.slice(0, 3) }));
    expect(matchFamily(mupdf, image, short, CANDIDATES).score).toBe(0);
    // A few good words among bold ones are enough.
    const some = marked.map((word, at) => (at < 12 ? { ...word, bold: false, italic: false } : word));
    expect(matchFamily(mupdf, image, some, CANDIDATES).family).toBe('Times New Roman');
  });

  it('leaves out words a candidate has no glyph for, words off the page and words on blank paper', () => {
    const { image, words } = renderScan(mupdf, faces.get('Courier New') as Font, {
      dpi: 150,
      size: 11,
      amplitude: 10,
    });
    const box = words[0]?.box as MatchWord['box'];
    const odd: MatchWord[] = [
      { text: '漢字漢字', box, size: 11, bold: false, italic: false },
      { text: 'abcd', box: [-50, -50, -49, -49], size: 11, bold: false, italic: false },
      { text: 'abcd', box: [500, 750, 530, 760], size: 11, bold: false, italic: false },
      { text: 'abcd', box: [100, 820, 140, 832], size: 11, bold: false, italic: false },
    ];
    const blank = { ...image, data: new Uint8Array(image.data.length).fill(255) };
    expect(matchFamily(mupdf, blank, [...words, ...odd], CANDIDATES).score).toBe(0);
    // Few enough words that all of them are compared; the odd ones are skipped, the others decide.
    const match = matchFamily(mupdf, image, [...odd, ...words.slice(0, 12)], CANDIDATES);
    expect(match.family).toBe('Courier New');
  });

  it('reads light text on a dark ground', () => {
    const { image, words } = renderScan(mupdf, faces.get('Times New Roman') as Font, {
      dpi: 150,
      size: 11,
      amplitude: 0,
    });
    const data = image.data.map((value, at) => (at % 4 === 3 ? value : 255 - value));
    expect(matchFamily(mupdf, { ...image, data }, words, CANDIDATES).family).toBe('Times New Roman');
  });

  it('returns a lone candidate without a runner-up and refuses none', () => {
    const { image, words } = renderScan(mupdf, faces.get('Arial') as Font, {
      dpi: 150,
      size: 11,
      amplitude: 0,
    });
    const lone = matchFamily(mupdf, image, words, [CANDIDATES[0] as FaceCandidate]);
    expect(lone.family).toBe('Arial');
    expect(lone.runnerUp).toBeNull();
    expect(() => matchFamily(mupdf, image, words, [])).toThrow(RangeError);
  });
});

describe('chooseReadings', () => {
  const choose = (
    scanned: string,
    text: string,
    alternatives: readonly string[],
    dpi = 200,
    name = 'Arial',
    size = 11,
  ) => {
    const font = faces.get(name) as Font;
    const { image, box } = renderWord(mupdf, font, scanned, { dpi, size });
    return chooseReadings(mupdf, image, [{ text, alternatives, box, size }], font)[0];
  };

  it('takes the reading whose drawing lies on the ink: 9020 for a scan that says so, %20 for one that does', () => {
    for (const dpi of [150, 200]) {
      expect(choose('9020', '%20', ['9020'], dpi)).toBe('9020');
      expect(choose('%20', '9020', ['%20'], dpi)).toBe('%20');
    }
  });

  it("chooses among several readings, in the page's own face", () => {
    expect(choose('world', 'wor1d', ['worid', 'world', 'wor1d.'])).toBe('world');
    expect(choose('HTML5', 'HTMLS', ['HTML5'], 200, 'Arial')).toBe('HTML5');
    expect(choose('Hamburg', 'Hamburg', ['Hamburq', 'Harnburg'], 150, 'Times New Roman')).toBe('Hamburg');
    expect(choose('Hello', 'He11o', ['Hello'], 200, 'Noto Sans')).toBe('Hello');
  });

  it('keeps the settled reading when no other beats it by the margin', () => {
    // m drawn for rn: at 150 dpi the two are too alike for the margin
    expect(choose('modern', 'rnodern', ['modern'], 150)).toBe('rnodern');
    // the same word twice, or the settled one is right
    expect(choose('modern', 'modern', ['modern'])).toBe('modern');
    expect(choose('modern', 'modern', ['rnodern', 'madern'])).toBe('modern');
  });

  it('keeps a settled reading that is right when another differs by a letter and the ink boxes differ by a pixel', () => {
    // a 1-px difference between the trimmed boxes of the drawing and of the scan (an anti-aliased
    // tail, a side bearing) once cost the right text 0.15–0.25 against a wrong one of the same box
    expect(choose('SQL', 'SQL', ['SOL'], 200, 'Arial', 11)).toBe('SQL');
    expect(choose('Hamburg', 'Hamburg', ['Hamburq'], 200, 'Times New Roman', 9)).toBe('Hamburg');
  });

  it('keeps the right reading over the look-alikes of a face at the sizes and resolutions of a scan', () => {
    const pairs = [
      ['SQL', 'SOL'],
      ['Hamburg', 'Hamburq'],
      ['Hamburg', 'Harnburg'],
      ['modern', 'rnodern'],
      ['world', 'wor1d'],
      ['Hello', 'He11o'],
      ['Total', 'Tota1'],
      ['clear', 'dear'],
    ] as const;
    const wrong: string[] = [];
    for (const name of ['Arial', 'Times New Roman', 'Courier New', 'Noto Sans']) {
      for (const dpi of [150, 200]) {
        for (const size of [8, 9, 10, 11]) {
          for (const [right, other] of pairs) {
            if (choose(right, right, [other], dpi, name, size) !== right) {
              wrong.push(`${name} ${dpi} dpi ${size} pt: ${right} -> ${other}`);
            }
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  }, 60000);

  it('leaves the ink out of it when the glyphs are too small for a pixel of tolerance: under 16 px to the em', () => {
    // 7 pt at 150 dpi is an em of 14.6 px: a pixel is a tenth of the glyph, and the proportions
    // that keep a reading of another length out no longer count
    expect(choose('modern', 'modern', ['rnodern'], 150, 'Times New Roman', 7)).toBe('modern');
    // even where the ink is clear (wor1d for world: 0.28 against 1.0), the settled text stays
    expect(choose('world', 'wor1d', ['world'], 150, 'Arial', 7)).toBe('wor1d');
    // from 16 px on it chooses (8 pt at 150 dpi is 16.7 px)
    expect(choose('world', 'wor1d', ['world'], 150, 'Arial', 8)).toBe('world');
  });

  it('keeps the settled reading when no drawing lies on the ink at all, whatever it beats the others by', () => {
    // Courier ink read in Helvetica: neither reading overlaps it by half, and one of them by 0.2 more than the other
    const courier = faces.get('Courier New') as Font;
    const { image, box } = renderWord(mupdf, courier, 'world', { dpi: 200, size: 11 });
    const font = faces.get('Arial') as Font;
    const read = (alternatives: readonly string[]) =>
      chooseReadings(mupdf, image, [{ text: 'world', alternatives, box, size: 11 }], font)[0];
    expect(read(['xxxxx'])).toBe('world');
    // a clear winner that does lie on the ink still wins
    const sans = renderWord(mupdf, font, 'world', { dpi: 200, size: 11 });
    expect(
      chooseReadings(
        mupdf,
        sans.image,
        [{ text: 'xxxxx', alternatives: ['world'], box: sans.box, size: 11 }],
        font,
      ),
    ).toEqual(['world']);
  });

  it('keeps the settled reading when the face lacks a glyph of it, or of the others, and when the paper is blank', () => {
    const font = faces.get('Arial') as Font;
    const { image, box } = renderWord(mupdf, font, 'world', { dpi: 200, size: 11 });
    const read = (text: string, alternatives: readonly string[], on = image) =>
      chooseReadings(mupdf, on, [{ text, alternatives, box, size: 11 }], font)[0];
    // the settled reading cannot be drawn: it stays, whatever the others
    expect(read('漢字', ['world'])).toBe('漢字');
    // an alternative that cannot be drawn is not a candidate
    expect(read('wor1d', ['漢字'])).toBe('wor1d');
    expect(read('wor1d', ['漢字', 'world'])).toBe('world');
    // no ink to judge by
    const blank = { ...image, data: new Uint8Array(image.data.length).fill(255) };
    expect(read('wor1d', ['world'], blank)).toBe('wor1d');
  });

  it('answers for each word in turn', () => {
    const font = faces.get('Arial') as Font;
    const first = renderWord(mupdf, font, '9020', { dpi: 200, size: 11 });
    const out = chooseReadings(
      mupdf,
      first.image,
      [
        { text: '%20', alternatives: ['9020'], box: first.box, size: 11 },
        { text: '9020', alternatives: [], box: first.box, size: 11 },
      ],
      font,
    );
    expect(out).toEqual(['9020', '9020']);
  });
});
