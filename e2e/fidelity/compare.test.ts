import { describe, expect, it } from 'vitest';
import {
  compareWords,
  downsample2,
  fitToReference,
  type Gray,
  intendedPageScale,
  joinHyphenation,
  normalizeWords,
  resizeBilinear,
  ssim,
} from './compare';

/** A deterministic generator: the tests must not depend on `Math.random`. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** A page-like picture: white, with dark horizontal strokes of varying length ("text lines"). */
function page(width = 160, height = 120, seed = 7): Gray {
  const random = prng(seed);
  const data = new Uint8Array(width * height).fill(255);
  for (let y = 8; y + 4 < height; y += 10) {
    let x = 8;
    while (x < width - 12) {
      const run = 6 + Math.floor(random() * 14);
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < run && x + dx < width - 8; dx++) data[(y + dy) * width + x + dx] = 20;
      }
      x += run + 5;
    }
  }
  return { width, height, data };
}

function shifted(image: Gray, dx: number): Gray {
  const data = new Uint8Array(image.data.length).fill(255);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < image.width) data[y * image.width + x] = image.data[y * image.width + sx] as number;
    }
  }
  return { ...image, data };
}

function noised(image: Gray, amplitude: number, seed = 3): Gray {
  const random = prng(seed);
  const data = image.data.map((v) =>
    Math.max(0, Math.min(255, Math.round(v + (random() * 2 - 1) * amplitude))),
  );
  return { ...image, data };
}

describe('ssim', () => {
  it('is 1 for identical images', () => {
    const image = page();
    expect(ssim(image, image)).toBeCloseTo(1, 12);
    expect(ssim(image, { ...image, data: image.data.slice() })).toBeCloseTo(1, 12);
  });

  it('is 1 for two equal flat images and about 0 for black against white', () => {
    const grey: Gray = { width: 40, height: 40, data: new Uint8Array(1600).fill(128) };
    expect(ssim(grey, grey)).toBeCloseTo(1, 12);
    const black: Gray = { width: 40, height: 40, data: new Uint8Array(1600).fill(0) };
    const white: Gray = { width: 40, height: 40, data: new Uint8Array(1600).fill(255) };
    expect(ssim(black, white)).toBeLessThan(0.001);
  });

  it('drops for a shifted page, and more for a larger shift', () => {
    const image = page();
    const one = ssim(image, shifted(image, 1));
    const six = ssim(image, shifted(image, 6));
    expect(one).toBeLessThan(1);
    expect(six).toBeLessThan(one);
    expect(six).toBeGreaterThan(-1);
  });

  it('drops with noise, in order of the noise amplitude', () => {
    const image = page();
    const light = ssim(image, noised(image, 20));
    const heavy = ssim(image, noised(image, 120));
    expect(light).toBeLessThan(1);
    expect(heavy).toBeLessThan(light);
  });

  it('is symmetric', () => {
    const a = page();
    const b = shifted(a, 3);
    expect(ssim(a, b)).toBeCloseTo(ssim(b, a), 12);
  });

  it('refuses images of different sizes and images smaller than the window', () => {
    expect(() => ssim(page(160, 120), page(160, 121))).toThrow(/equal sizes/);
    const tiny: Gray = { width: 8, height: 8, data: new Uint8Array(64) };
    expect(() => ssim(tiny, tiny)).toThrow(/at least/);
  });
});

describe('resizeBilinear', () => {
  it('returns the same image for the same size and keeps a flat image flat', () => {
    const image = page(60, 40);
    expect(resizeBilinear(image, 60, 40)).toBe(image);
    const flat: Gray = { width: 30, height: 20, data: new Uint8Array(600).fill(77) };
    const grown = resizeBilinear(flat, 31, 21);
    expect(grown.width).toBe(31);
    expect(grown.height).toBe(21);
    expect(grown.data.every((v) => v === 77)).toBe(true);
  });

  it('interpolates a ramp and stays close to the original under SSIM after a 1 % change', () => {
    const ramp: Gray = { width: 4, height: 1, data: Uint8Array.from([0, 100, 200, 100]) };
    expect(Array.from(resizeBilinear(ramp, 8, 1).data)).toEqual([0, 25, 75, 125, 175, 175, 125, 100]);
    const image = page(200, 150);
    const back = resizeBilinear(resizeBilinear(image, 202, 151), 200, 150);
    expect(ssim(image, back)).toBeGreaterThan(0.6);
    expect(ssim(image, back)).toBeLessThan(1);
  });
});

describe('joinHyphenation', () => {
  it('joins a hyphenated line end to a lowercase continuation and drops the hyphen', () => {
    expect(joinHyphenation('the infor-\nmation is re\u00AD\nceptors here')).toBe(
      'the information is receptors here',
    );
    expect(normalizeWords(joinHyphenation('infor-\nmation'))).toEqual(['information']);
    expect(joinHyphenation('a-\nb-\nc')).toBe('abc');
  });

  it('is Turkish-aware: dotless ı and ş start a continuation, dotted İ does not', () => {
    expect(joinHyphenation('kitap-\nışık')).toBe('kitapışık');
    expect(joinHyphenation('okul-\nşeker')).toBe('okulşeker');
    expect(joinHyphenation('İstan-\nbul')).toBe('İstanbul');
    expect(joinHyphenation('Ankara-\nİstanbul')).toBe('Ankara-\nİstanbul');
  });

  it('leaves dashes that are not line-end hyphenation alone', () => {
    expect(joinHyphenation('well-known\nword')).toBe('well-known\nword');
    expect(joinHyphenation('a -\nbc')).toBe('a -\nbc');
    expect(joinHyphenation('end-\n\nnext')).toBe('end-\n\nnext');
    expect(joinHyphenation('end-\nNext')).toBe('end-\nNext');
  });
});

describe('normalizeWords', () => {
  it('splits on any whitespace and keeps punctuation attached', () => {
    expect(normalizeWords('Hello,  world.\n\tSecond\u00A0line!')).toEqual([
      'Hello,',
      'world.',
      'Second',
      'line!',
    ]);
  });

  it('folds ligatures, drops soft hyphens and zero-width characters', () => {
    expect(normalizeWords('\uFB01nal of\uFB01ce')).toEqual(['final', 'office']);
    expect(normalizeWords('co\u00ADoperate zero\u200Bwidth')).toEqual(['cooperate', 'zerowidth']);
  });

  it('unifies typographic quotes and dashes', () => {
    expect(normalizeWords('\u201Cit\u2019s\u201D \u2013 a\u2014b')).toEqual(['"it\'s"', '-', 'a-b']);
  });

  it('preserves Turkish dotted and dotless i and compares case-sensitively', () => {
    const words = normalizeWords('İstanbul ılık Işık IŞIK');
    expect(words).toEqual(['İstanbul', 'ılık', 'Işık', 'IŞIK']);
    expect(words[0]).not.toBe('Istanbul');
    expect(words[1]).not.toBe('ilik');
    expect(words[2]).not.toBe(words[3]);
  });

  it('returns nothing for blank text', () => {
    expect(normalizeWords(' \n\t ')).toEqual([]);
  });
});

describe('compareWords', () => {
  const sentence = normalizeWords('the quick brown fox jumps over the lazy dog');

  it('is perfect for equal text', () => {
    const result = compareWords(sentence, [...sentence]);
    expect(result).toMatchObject({ accuracy: 1, distance: 0, missing: [], extra: [], substituted: [] });
  });

  it('reports a missing word, an extra word and a substitution, with their positions resolved', () => {
    const missing = compareWords(sentence, normalizeWords('the quick fox jumps over the lazy dog'));
    expect(missing.missing).toEqual(['brown']);
    expect(missing.extra).toEqual([]);
    expect(missing.accuracy).toBeCloseTo(1 - 1 / 9, 12);

    const extra = compareWords(sentence, normalizeWords('the quick brown fox jumps right over the lazy dog'));
    expect(extra.extra).toEqual(['right']);
    expect(extra.missing).toEqual([]);

    const swapped = compareWords(sentence, normalizeWords('the quick brown fox jumps over the lazy cat'));
    expect(swapped.substituted).toEqual([['dog', 'cat']]);
    expect(swapped.missing).toEqual([]);
    expect(swapped.extra).toEqual([]);
  });

  it('lowers the accuracy when words are reordered', () => {
    const reordered = normalizeWords('lazy dog the over jumps fox brown quick the');
    const result = compareWords(sentence, reordered);
    expect(result.accuracy).toBeLessThan(0.5);
    expect(result.distance).toBeGreaterThan(0);
    // Same bag of words, wrong order: the alignment still sees it as damage.
    expect(result.missing.length + result.substituted.length).toBeGreaterThan(0);
  });

  it('floors the accuracy at 0 when the output is longer than the expectation', () => {
    const result = compareWords(['a'], ['x', 'y', 'z', 'w']);
    expect(result.accuracy).toBe(0);
    expect(result.distance).toBe(4);
  });

  it('handles empty sides', () => {
    expect(compareWords([], []).accuracy).toBe(1);
    expect(compareWords([], ['x']).accuracy).toBe(0);
    expect(compareWords(['a', 'b'], [])).toMatchObject({ accuracy: 0, missing: ['a', 'b'] });
  });

  it('does not equate Turkish İ with I or ı with i', () => {
    const result = compareWords(normalizeWords('İstanbul ılık'), normalizeWords('Istanbul ilik'));
    expect(result.accuracy).toBe(0);
    expect(result.substituted).toEqual([
      ['İstanbul', 'Istanbul'],
      ['ılık', 'ilik'],
    ]);
  });

  it('agrees with a brute-force edit distance on random inputs', () => {
    const random = prng(11);
    const vocabulary = ['a', 'b', 'c', 'd', 'e'];
    const pick = (n: number) =>
      Array.from({ length: n }, () => vocabulary[Math.floor(random() * 5)] as string);
    const reference = (x: string[], y: string[]): number => {
      const width = y.length + 1;
      const d = new Array<number>((x.length + 1) * width).fill(0);
      const at = (i: number, j: number) => d[i * width + j] ?? 0;
      for (let i = 0; i <= x.length; i++) d[i * width] = i;
      for (let j = 0; j <= y.length; j++) d[j] = j;
      for (let i = 1; i <= x.length; i++) {
        for (let j = 1; j <= y.length; j++) {
          d[i * width + j] = Math.min(
            at(i - 1, j) + 1,
            at(i, j - 1) + 1,
            at(i - 1, j - 1) + (x[i - 1] === y[j - 1] ? 0 : 1),
          );
        }
      }
      return at(x.length, y.length);
    };
    for (let round = 0; round < 60; round++) {
      const x = pick(Math.floor(random() * 14));
      const y = pick(Math.floor(random() * 14));
      const result = compareWords(x, y);
      expect(result.distance).toBe(reference(x, y));
      expect(result.distance).toBe(result.missing.length + result.extra.length + result.substituted.length);
    }
  });
});

describe('downsample2', () => {
  it('averages exact 2×2 blocks and rounds to the nearest integer', () => {
    // 4×2: blocks [10 20 / 30 40] → 25 and [0 0 / 0 1] → 0.25 → 0, [255 255 / 255 254] → 254.75 → 255
    const image: Gray = {
      width: 4,
      height: 2,
      data: Uint8Array.from([10, 20, 0, 0, 30, 40, 0, 1]),
    };
    const half = downsample2(image);
    expect(half.width).toBe(2);
    expect(half.height).toBe(1);
    expect(Array.from(half.data)).toEqual([25, 0]);
    const high: Gray = { width: 2, height: 2, data: Uint8Array.from([255, 255, 255, 254]) };
    expect(Array.from(downsample2(high).data)).toEqual([255]);
  });

  it('drops an odd last row and column the same way for any image of that size', () => {
    const image: Gray = { width: 5, height: 3, data: Uint8Array.from({ length: 15 }, (_, i) => i * 10) };
    const half = downsample2(image);
    expect([half.width, half.height]).toEqual([2, 1]);
    // blocks (0,10,50,60) → 30 and (20,30,70,80) → 50
    expect(Array.from(half.data)).toEqual([30, 50]);
  });

  it('makes a one-pixel shift at the finer resolution cost less than the same shift at 100 dpi', () => {
    const fine = page(400, 300);
    const coarse = downsample2(fine);
    const afterBox = ssim(coarse, downsample2(shifted(fine, 1)));
    const atCoarse = ssim(coarse, shifted(coarse, 1));
    expect(afterBox).toBeGreaterThan(atCoarse);
    expect(afterBox).toBeLessThan(1);
  });
});

describe('intendedPageScale', () => {
  const s = 1584 / 1684;

  it('returns the factor when the converted page is the original scaled by it (±1 %)', () => {
    expect(intendedPageScale([1190, 1684], [1190 * s, 1584])).toBeCloseTo(s, 12);
    expect(intendedPageScale([1190, 1684], [1190 * s * 1.009, 1584 * 0.991])).toBeCloseTo(s, 12);
    expect(intendedPageScale([3168, 400], [1584, 200])).toBe(0.5);
  });

  it('is null outside the tolerance, for unscaled originals and for other sizes', () => {
    expect(intendedPageScale([1190, 1684], [1190 * s * 1.02, 1584])).toBeNull();
    expect(intendedPageScale([1190, 1684], [1190, 1684])).toBeNull();
    expect(intendedPageScale([1190, 1684], [1190 * s, 1584 * 0.98])).toBeNull();
    expect(intendedPageScale([595, 842], [595 * 0.9, 842 * 0.9])).toBeNull();
    expect(intendedPageScale([1584, 1584], [1584, 1584])).toBeNull();
    expect(intendedPageScale([0, 0], [10, 10])).toBeNull();
  });
});

describe('fitToReference', () => {
  it('crops and pads a rounding-sized difference at the top-left origin instead of stretching', () => {
    const image: Gray = { width: 4, height: 2, data: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) };
    const cropped = fitToReference(image, 3, 2);
    expect([cropped.width, cropped.height]).toEqual([3, 2]);
    expect(Array.from(cropped.data)).toEqual([1, 2, 3, 5, 6, 7]);
    const padded = fitToReference(image, 5, 3);
    expect(Array.from(padded.data)).toEqual([1, 2, 3, 4, 255, 5, 6, 7, 8, 255, 255, 255, 255, 255, 255]);
    expect(fitToReference(image, 4, 2)).toBe(image);
  });

  it('resamples a larger difference', () => {
    const image = page(100, 80);
    expect(fitToReference(image, 110, 88)).toEqual(resizeBilinear(image, 110, 88));
  });
});
