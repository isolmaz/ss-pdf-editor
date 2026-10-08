/**
 * A second look at the words of a scan that the first read was unsure of, on a crop of the word
 * drawn three times as large and read as one word:
 *
 *  - A word whose ink has a gap wider than a space inside it is two or more words that tesseract
 *    ran together ("+90 543 745 44 38" as "+905437454438"): each piece is read on its own.
 *  - A word below `SURE` is read again with the run's languages; the new reading replaces the
 *    first one if it is more sure and only corrects letters (same length, no spaces) — never
 *    drops a dot or a letter the first read saw.
 *  - A run of capitals ("SQL") is read with English alone, which has no dictionary word "sol"
 *    to pull the Q to an O: the capitals of the first reading are replaced by the English ones
 *    when both readings are the same length.
 */

import type { OcrWord } from '../engines/tesseract';
import type { RgbaImage } from './ocr-scene';
import { throwIfAborted } from './types';

export interface Reading {
  readonly text: string;
  readonly confidence: number;
}

/** Which models read a crop: all the run's languages, or English alone. */
export type ReadWith = 'all' | 'english';

/** Reads the PNG of one cropped word; `null`: nothing readable. */
export type ReadWord = (png: Uint8Array, models: ReadWith, signal: AbortSignal) => Promise<Reading | null>;

/** A word at or above this confidence (0–100) is not read again. */
const SURE = 95;
/** A piece of a split word must be read at least this sure, or the word stays whole. */
const PIECE_SURE = 50;
/** The crop is drawn this many times as large, with this many pixels (× 1) of margin around the word's box. */
const UPSCALE = 3;
const MARGIN = 6;
/** An empty stretch of columns inside a word at least this × the word's box height splits it: wider than a space (a space and the side bearings of the letters, ≈ 0.3 em: the 1 of "140" leaves less). */
const SPLIT_GAP = 0.4;
/** Boxes shorter than this many pixels are specks, not words. */
const MIN_HEIGHT = 10;
/** A box whose darkest and lightest pixels differ by less than this has no ink to find gaps in. */
const MIN_CONTRAST = 60;

const luminance = (data: Uint8Array, at: number): number =>
  0.299 * (data[at] as number) + 0.587 * (data[at + 1] as number) + 0.114 * (data[at + 2] as number);

/** The pixel columns [from, to) of the box of `word`, clamped to the image. */
function pixelBox(image: RgbaImage, word: OcrWord): readonly [number, number, number, number] {
  const x0 = Math.max(0, Math.floor(word.x0 * image.scale));
  const y0 = Math.max(0, Math.floor(word.y0 * image.scale));
  const x1 = Math.min(image.width, Math.ceil(word.x1 * image.scale));
  const y1 = Math.min(image.height, Math.ceil(word.y1 * image.scale));
  return [x0, y0, x1, y1];
}

/**
 * The runs of ink columns of a word, as pixel [from, to) pairs, split where the columns are
 * empty for `SPLIT_GAP` × the word's height. One run: the word is one word.
 */
export function inkRuns(image: RgbaImage, word: OcrWord): [number, number][] {
  const [x0, y0, x1, y1] = pixelBox(image, word);
  if (x1 <= x0 || y1 <= y0) return [];
  if (y1 - y0 < MIN_HEIGHT) return [[x0, x1]];
  let lightest = 0;
  let darkest = 255;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const value = luminance(image.data, (y * image.width + x) * 4);
      lightest = Math.max(lightest, value);
      darkest = Math.min(darkest, value);
    }
  }
  if (lightest - darkest < MIN_CONTRAST) return [[x0, x1]];
  const cut = (lightest + darkest) / 2;
  // Ink is the lesser side of the cut: dark letters on a light ground, or light ones on a dark.
  let dark = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) if (luminance(image.data, (y * image.width + x) * 4) < cut) dark += 1;
  }
  const lightInk = dark * 2 > (x1 - x0) * (y1 - y0);
  const isInk = (x: number, y: number): boolean =>
    luminance(image.data, (y * image.width + x) * 4) < cut !== lightInk;
  const runs: [number, number][] = [];
  const gap = SPLIT_GAP * (y1 - y0);
  let start = -1;
  let last = -1;
  for (let x = x0; x < x1; x += 1) {
    let ink = false;
    for (let y = y0; y < y1 && !ink; y += 1) ink = isInk(x, y);
    if (!ink) continue;
    if (start >= 0 && x - last - 1 >= gap) {
      runs.push([start, last + 1]);
      start = x;
    } else if (start < 0) start = x;
    last = x;
  }
  if (start >= 0) runs.push([start, last + 1]);
  return runs;
}

const cubic = (t: number): number => {
  const x = Math.abs(t);
  if (x < 1) return 1.5 * x ** 3 - 2.5 * x * x + 1;
  return x < 2 ? -0.5 * x ** 3 + 2.5 * x * x - 4 * x + 2 : 0;
};

/** One axis of a Catmull-Rom upscale: for output index `i`, the source indices and their weights. */
function taps(i: number, size: number): { at: number; weight: number }[] {
  const source = (i + 0.5) / UPSCALE - 0.5;
  const base = Math.floor(source);
  const out: { at: number; weight: number }[] = [];
  for (let k = -1; k <= 2; k += 1) {
    out.push({ at: Math.min(size - 1, Math.max(0, base + k)), weight: cubic(source - (base + k)) });
  }
  return out;
}

/** The box of pixels [x0, x1) × the word's rows, with a margin, drawn `UPSCALE` times as large in grey. */
function upscaledCrop(image: RgbaImage, word: OcrWord, x0: number, x1: number): RgbaImage {
  const [, y0, , y1] = pixelBox(image, word);
  const left = Math.max(0, x0 - MARGIN);
  const top = Math.max(0, y0 - MARGIN);
  const width = Math.min(image.width, x1 + MARGIN) - left;
  const height = Math.min(image.height, y1 + MARGIN) - top;
  const grey = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      grey[y * width + x] = luminance(image.data, ((top + y) * image.width + left + x) * 4);
    }
  }
  const outWidth = width * UPSCALE;
  const outHeight = height * UPSCALE;
  const across = new Float32Array(outWidth * height);
  for (let x = 0; x < outWidth; x += 1) {
    const weights = taps(x, width);
    for (let y = 0; y < height; y += 1) {
      let sum = 0;
      for (const { at, weight } of weights) sum += (grey[y * width + at] as number) * weight;
      across[y * outWidth + x] = sum;
    }
  }
  const data = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y += 1) {
    const weights = taps(y, height);
    for (let x = 0; x < outWidth; x += 1) {
      let sum = 0;
      for (const { at, weight } of weights) sum += (across[at * outWidth + x] as number) * weight;
      const value = Math.max(0, Math.min(255, Math.round(sum)));
      const to = (y * outWidth + x) * 4;
      data[to] = value;
      data[to + 1] = value;
      data[to + 2] = value;
      data[to + 3] = 255;
    }
  }
  return { width: outWidth, height: outHeight, data, scale: image.scale * UPSCALE };
}

/** The capitals of `first` ("SOL") replaced by those `english` read at the same places ("SQL"), when both are as long. */
function withEnglishCapitals(first: string, english: string): string {
  if (english.length !== first.length) return first;
  return first.replace(/[A-Z]{2,}/g, (run, at: number) => {
    const other = english.slice(at, at + run.length);
    return /^[A-Z]+$/.test(other) ? other : run;
  });
}

/** Letters as `l`, digits as `d`, every other character as itself: a correction changes none of them ("HTML5" is not "HTMLS", "React’e" is not "React'e"). */
const shapeOf = (text: string): string => text.replace(/\p{L}/gu, 'l').replace(/\p{N}/gu, 'd');

/** Whether a word is worth a second look: it has at least two letters or digits. */
const hasSubstance = (text: string): boolean => (text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2;

/**
 * The words with their unsure and run-together readings read again. `read` gets the PNG of a
 * crop (`encode` makes it from pixels); every returned word keeps the box, line and baseline
 * of the one it came from (pieces of a split word: the box of their ink).
 */
export async function refineWords(
  words: readonly OcrWord[],
  image: RgbaImage,
  encode: (crop: RgbaImage) => Uint8Array,
  read: ReadWord,
  signal: AbortSignal,
): Promise<OcrWord[]> {
  const out: OcrWord[] = [];
  for (const word of words) {
    throwIfAborted(signal);
    if (!hasSubstance(word.text)) {
      out.push(word);
      continue;
    }
    const runs = inkRuns(image, word);
    if (runs.length > 1) {
      const pieces: OcrWord[] = [];
      for (const [from, to] of runs) {
        const reading = await read(encode(upscaledCrop(image, word, from, to)), 'all', signal);
        if (reading === null || reading.confidence < PIECE_SURE || /\s/.test(reading.text)) break;
        pieces.push({
          ...word,
          text: reading.text,
          x0: from / image.scale,
          x1: to / image.scale,
          confidence: reading.confidence,
        });
      }
      if (pieces.length === runs.length) {
        out.push(...pieces);
        continue;
      }
    }
    const [x0, , x1] = pixelBox(image, word);
    let crop: Uint8Array | undefined;
    const whole = () => (crop ??= encode(upscaledCrop(image, word, x0, x1)));
    let text = word.text;
    let confidence = word.confidence;
    if (confidence < SURE) {
      const again = await read(whole(), 'all', signal);
      if (
        again !== null &&
        again.confidence > confidence &&
        shapeOf(again.text) === shapeOf(text) &&
        !/\s/.test(again.text)
      ) {
        text = again.text;
        confidence = again.confidence;
      }
    }
    if (/[A-Z]{2,}/.test(text)) {
      const english = await read(whole(), 'english', signal);
      if (english !== null) text = withEnglishCapitals(text, english.text);
    }
    out.push(text === word.text && confidence === word.confidence ? word : { ...word, text, confidence });
  }
  return out;
}
