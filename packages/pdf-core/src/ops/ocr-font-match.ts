/**
 * Which font family a scan's text was set in. The words tesseract read are drawn again in each
 * candidate face (MuPDF, the word's size at the page's resolution) and laid over the ink of the
 * word in the scan:
 *
 *  - the shape: both inks are cut to their bounding boxes, the drawing is resampled onto the
 *    scan's box (so size, hinting and the OCR's size rounding do not matter) and the two soft ink
 *    maps are compared as intersection over union, at the best of a few pixels' shift;
 *  - the proportions: the drawing's ink box has the aspect (width ÷ height) of the scan's only
 *    when the face has the same widths; the ratio of the two aspects weighs the shape.
 *
 * A face's score is the median over the words, so one misread word or a speck on the paper
 * moves nothing. Words are chosen to cover as many different letters as possible, regular ones
 * only (a candidate carries one program, bold and italic are synthesised by Word). The result is
 * the best family with the next best beside it; a caller that wants to keep its default unless
 * the evidence is clear looks at the difference between the two.
 */

import type { Font } from 'mupdf';
import type { Mupdf } from '../engines/mupdf';
import type { RgbaImage } from './ocr-scene';
import type { Box } from './page-layout';

export interface FaceCandidate {
  readonly family: string;
  readonly kind: 'sans' | 'serif' | 'mono';
  /** The font program, or `null` for the base-14 face of the kind (Helvetica, Times, Courier: Arial, Times New Roman, Courier New). */
  readonly bytes: Uint8Array | null;
}

export interface MatchWord {
  readonly text: string;
  /** Page points, y down. */
  readonly box: Box;
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
}

export interface FamilyMatch {
  readonly family: string;
  /** 0–1, the median over the words of how well the best family's drawing lies on the ink. */
  readonly score: number;
  readonly runnerUp: { readonly family: string; readonly score: number } | null;
}

/** At most this many words are compared; the words have to be at least this many letters. */
const MAX_WORDS = 40;
const MIN_LETTERS = 4;
/** The base-14 faces behind the kinds. */
const STANDARD = { sans: 'Helvetica', serif: 'Times-Roman', mono: 'Courier' } as const;
/** The scan's crop reaches this × the word's size (px) beyond the box on every side. */
const CROP_MARGIN = 0.12;
/** Ink-map pixels above this are ink when the boxes are cut. */
const INK = 0.5;
/** A word whose ink does not differ from its paper by at least this (0–255) is not read. */
const MIN_CONTRAST = 48;
/** The drawing is shifted by up to this many pixels each way. */
const SHIFT = 2;
/** The spread (natural log of the aspect ratio) over which the proportions stop agreeing. */
const ASPECT_SPREAD = 0.1;
/** The glyphs sit this far (× size) above the pixmap's bottom, and the pixmap is this tall (× size). */
const BASELINE = 0.5;
const HEIGHT = 1.9;

/** A grid of 0–1 ink. */
interface Ink {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/** The part of `ink` inside the bounding box of its pixels above `INK` (all of it when there is none). */
function trimmed(ink: Ink): Ink {
  let x0 = ink.width;
  let y0 = ink.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < ink.height; y++) {
    for (let x = 0; x < ink.width; x++) {
      if ((ink.data[y * ink.width + x] as number) <= INK) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  const [left, top, right, bottom] = x1 < 0 ? [0, 0, ink.width - 1, ink.height - 1] : [x0, y0, x1, y1];
  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const from = (top + y) * ink.width + left;
    data.set(ink.data.subarray(from, from + width), y * width);
  }
  return { width, height, data };
}

/** The weights with which `count` source cells cover each of `out` equal parts of them. */
function spans(count: number, out: number): { first: number; weights: number[] }[] {
  const step = count / out;
  return Array.from({ length: out }, (_, index) => {
    const from = index * step;
    const to = from + step;
    const first = Math.floor(from);
    const weights: number[] = [];
    for (let cell = first; cell < Math.min(count, to - 1e-9); cell++) {
      weights.push((Math.min(to, cell + 1) - Math.max(from, cell)) / step);
    }
    return { first, weights };
  });
}

/** `ink` resampled onto `width × height` cells, each the area-weighted mean of the cells it covers. */
function resampled(ink: Ink, width: number, height: number): Ink {
  const across = spans(ink.width, width);
  const rows = new Float32Array(width * ink.height);
  for (let y = 0; y < ink.height; y++) {
    for (let x = 0; x < width; x++) {
      const { first, weights } = across[x] as (typeof across)[number];
      let sum = 0;
      for (let k = 0; k < weights.length; k++) {
        sum += (weights[k] as number) * (ink.data[y * ink.width + first + k] as number);
      }
      rows[y * width + x] = sum;
    }
  }
  const down = spans(ink.height, height);
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const { first, weights } = down[y] as (typeof down)[number];
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = 0; k < weights.length; k++) {
        sum += (weights[k] as number) * (rows[(first + k) * width + x] as number);
      }
      data[y * width + x] = sum;
    }
  }
  return { width, height, data };
}

/**
 * The ink of the word in the scan: the crop around its box, its paper the median of the crop
 * (text covers less than half of it), each pixel's ink its difference from the paper over the
 * strongest differences (the top 2 % of them are full ink); cut to its bounding box. `null`
 * when the crop is off the page or has no ink to speak of.
 */
function scanInk(image: RgbaImage, word: MatchWord): Ink | null {
  const margin = Math.ceil(word.size * image.scale * CROP_MARGIN);
  const x0 = Math.max(0, Math.floor(word.box[0] * image.scale) - margin);
  const y0 = Math.max(0, Math.floor(word.box[1] * image.scale) - margin);
  const x1 = Math.min(image.width, Math.ceil(word.box[2] * image.scale) + margin);
  const y1 = Math.min(image.height, Math.ceil(word.box[3] * image.scale) + margin);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 2 || height < 2) return null;
  const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = ((y0 + y) * image.width + x0 + x) * 4;
      const [r, g, b] = [
        image.data[at] as number,
        image.data[at + 1] as number,
        image.data[at + 2] as number,
      ];
      gray[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  const paper = gray.slice().sort()[gray.length >> 1] as number;
  const diff = gray.map((value) => Math.abs(value - paper));
  const strongest = diff.slice().sort()[Math.floor(diff.length * 0.98)] as number;
  if (strongest < MIN_CONTRAST) return null;
  return trimmed({ width, height, data: diff.map((value) => Math.min(1, value / strongest)) });
}

/** The glyph ids of `text` in `font`, or `null` when it has no glyph for a character. */
function glyphsOf(font: Font, text: string): number[] | null {
  const glyphs: number[] = [];
  for (const char of text) {
    const glyph = font.encodeCharacter(char.codePointAt(0) as number);
    if (glyph === 0) return null;
    glyphs.push(glyph);
  }
  return glyphs;
}

/** `text` drawn in `font` at `px` pixels, black on white, as ink cut to its bounding box. */
function drawnInk(mupdf: Mupdf, font: Font, glyphs: readonly number[], text: string, px: number): Ink {
  const advance = glyphs.reduce((sum, glyph) => sum + font.advanceGlyph(glyph, 0) * px, 0);
  const pad = Math.ceil(px * 0.25);
  const width = Math.ceil(advance) + 2 * pad;
  const height = Math.ceil(px * HEIGHT);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, width, height], false);
  const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
  const shown = new mupdf.Text();
  try {
    pixmap.clear(255);
    shown.showString(font, [px, 0, 0, -px, pad, height - px * BASELINE], text);
    device.fillText(shown, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, [0], 1);
    device.close();
    const pixels = pixmap.getPixels();
    const data = new Float32Array(width * height);
    for (let at = 0; at < data.length; at++) data[at] = 1 - (pixels[at] as number) / 255;
    return trimmed({ width, height, data });
  } finally {
    shown.destroy();
    device.destroy();
    pixmap.destroy();
  }
}

/** Intersection over union of two soft ink maps, `drawn` laid over `scan` shifted by `dx, dy` (the scan has ink, so the union is never empty). */
function overlap(scan: Ink, drawn: Ink, dx: number, dy: number): number {
  let both = 0;
  let either = 0;
  for (let y = 0; y < scan.height; y++) {
    const sy = y - dy;
    for (let x = 0; x < scan.width; x++) {
      const sx = x - dx;
      const a = scan.data[y * scan.width + x] as number;
      const b =
        sx >= 0 && sx < drawn.width && sy >= 0 && sy < drawn.height
          ? (drawn.data[sy * drawn.width + sx] as number)
          : 0;
      both += Math.min(a, b);
      either += Math.max(a, b);
    }
  }
  return both / either;
}

/** How well `drawn` lies on `scan`: the best overlap over the shifts, weighed by the agreement of their proportions. */
function wordScore(scan: Ink, drawn: Ink): number {
  const onto = resampled(drawn, scan.width, scan.height);
  let best = 0;
  for (let dy = -SHIFT; dy <= SHIFT; dy++) {
    for (let dx = -SHIFT; dx <= SHIFT; dx++) best = Math.max(best, overlap(scan, onto, dx, dy));
  }
  const ratio = Math.log(drawn.width / drawn.height / (scan.width / scan.height));
  return best * Math.exp(-(ratio * ratio) / (2 * ASPECT_SPREAD * ASPECT_SPREAD));
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/** Up to `MAX_WORDS` words, each next one the one with the most letters not yet seen (longer first among equals). */
function varied(words: readonly MatchWord[]): MatchWord[] {
  const pool = words.filter(
    (word) =>
      !word.bold &&
      !word.italic &&
      word.size > 0 &&
      [...word.text].filter((char) => /\p{L}/u.test(char)).length >= MIN_LETTERS,
  );
  const seen = new Set<string>();
  const chosen: MatchWord[] = [];
  while (chosen.length < MAX_WORDS && pool.length > 0) {
    let bestAt = 0;
    let bestNew = -1;
    pool.forEach((word, at) => {
      const fresh = new Set([...word.text].filter((char) => !seen.has(char))).size;
      if (
        fresh > bestNew ||
        (fresh === bestNew && word.text.length > (pool[bestAt] as MatchWord).text.length)
      ) {
        bestAt = at;
        bestNew = fresh;
      }
    });
    const [word] = pool.splice(bestAt, 1) as [MatchWord];
    for (const char of word.text) seen.add(char);
    chosen.push(word);
  }
  return chosen;
}

/**
 * The family of `candidates` the words of `image` are set in. Words every candidate has the
 * glyphs for are drawn in each and compared with the scan (see the module comment); the score of
 * a family is the median over the words. With no usable word every family scores 0 (the first
 * candidate is returned, with the second as runner-up); `runnerUp` is `null` for a single candidate.
 * @throws RangeError without candidates.
 */
export function matchFamily(
  mupdf: Mupdf,
  image: RgbaImage,
  words: readonly MatchWord[],
  candidates: readonly FaceCandidate[],
): FamilyMatch {
  if (candidates.length === 0) throw new RangeError('matchFamily needs at least one candidate face');
  const fonts = candidates.map((candidate) =>
    candidate.bytes === null
      ? new mupdf.Font(STANDARD[candidate.kind])
      : new mupdf.Font(candidate.family, candidate.bytes),
  );
  try {
    const compared = varied(words).flatMap((word) => {
      const glyphs = fonts.map((font) => glyphsOf(font, word.text));
      const scan = glyphs.every((each) => each !== null) ? scanInk(image, word) : null;
      return scan === null ? [] : [{ word, scan, glyphs: glyphs as number[][] }];
    });
    const scored = candidates.map((candidate, index) => {
      const scores = compared.map(({ word, scan, glyphs }) =>
        wordScore(
          scan,
          drawnInk(
            mupdf,
            fonts[index] as Font,
            glyphs[index] as number[],
            word.text,
            word.size * image.scale,
          ),
        ),
      );
      return { family: candidate.family, score: scores.length === 0 ? 0 : median(scores) };
    });
    scored.sort((a, b) => b.score - a.score);
    const [best, next] = scored as [(typeof scored)[number], ...typeof scored];
    return { family: best.family, score: best.score, runnerUp: next ?? null };
  } finally {
    for (const font of fonts) font.destroy();
  }
}
