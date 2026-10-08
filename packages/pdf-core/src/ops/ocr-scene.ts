/**
 * The "exact layout" page of a scan: what OCR read becomes positioned text boxes, and
 * everything OCR did not read becomes pictures behind them.
 *
 * Both halves work on the rendered page (`RgbaImage`) next to tesseract's word boxes
 * (`OcrWord`, page points, y down):
 *
 *  - `ocrTextBoxes`: lines are tesseract's, cut where a column gutter or the edge of a picture
 *    region runs through them; paragraphs are regrouped from the lines' geometry (alignment,
 *    spacing, size, region) and ordered column by column. The font size comes from the heights
 *    of the line's words by what they hold (capitals and ascenders, x-height, descenders;
 *    calibrated on Noto Sans and Arial) and is the median of them, the colour from the ink of the
 *    word against its local background, bold from the stroke width against the page's. A word
 *    with a letter or digit the engine was unsure of is a run of its own carrying a `note`.
 *  - `ocrBackground`: the words are erased from the image (filled with the background around
 *    them); what still differs from the page colour afterwards (a card, a photo, a logo) is cut
 *    out as one picture per connected region, and everything else is the page colour.
 *    `isMisread` / `dropMisreads` name the symbol-only guesses of tesseract that lie over a
 *    picture (an icon, a chart): they are not text, and stay in the picture.
 *
 * `OcrWord.confidence` is tesseract's 0–100 (the adapter passes it through); `lowConfidence`
 * is a fraction, 0.90 for "flag below 90 %", the threshold measured in `docs/ocr-evaluation.md`.
 */

import type { OcrWord } from '../engines/tesseract';
import type { TextBox, TextLine, TextParagraph, TextRun } from './layout-scene';
import type { Box } from './page-layout';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width × height × 4` bytes, row-major, straight (non-premultiplied) alpha. */
  readonly data: Uint8Array;
  /** Pixels per page point. */
  readonly scale: number;
}

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/**
 * How much of the font size the ink of a word spans above and below its baseline: capitals,
 * digits and ascenders reach `ASCENDER`, a word of x-height letters only `X_HEIGHT`, a capital
 * with a mark (İ Ğ Ö Ü) `MARKED`, and descenders go `DESCENDER` below. Measured on 10, 14 and
 * 24 pt renders: Noto Sans ascender 0.76 + descender 0.24, Arial's metric twin (Helvetica)
 * 0.73 + 0.22; the middles put both within 3 % (before the half-point rounding).
 */
const ASCENDER = 0.745;
const X_HEIGHT = 0.53;
const MARKED = 0.92;
const DESCENDER = 0.235;
/** Fallback for a line of nothing but symbols: the ink extent ÷ size, and the baseline above the bottom (× size). */
const INK_EXTENT = 0.98;
const DESCENT = 0.22;

/** A tesseract line is cut where two words are further apart than this × the line's size. */
const GUTTER = 1.5;
/** Lines of one paragraph: baselines this × the size apart (at most, at least), sizes within the ratios. */
const MAX_LEADING = 2;
const MIN_LEADING = 0.7;
const SAME_SIZE_LOW = 0.75;
const SAME_SIZE_HIGH = 1.33;
/** …and left edges or centres at most this × the size apart. */
const ALIGN = 0.8;

/** A symbol-only word is a misread graphic when tesseract is less sure than this (0–100). */
const MISREAD_CONFIDENCE = 60;

/** Word's natural line is about this × size; where the first baseline sits inside the line. */
const SINGLE_LINE = 1.2;
const BASELINE_IN_LINE = 0.8;

/** Width slack, as in `docx-layout-text`: a substitute font a little wider must not wrap. */
const WIDTH_FACTOR = 1.03;
const WIDTH_PAD = 2;

/** Lines whose centres all lie this close to the paragraph's centre (points) are centred. */
const CENTRE_TOLERANCE = 2;

/** A line's size is its paragraph's (the upper quartile) unless it is clearly different. */
const SIZE_SNAP_LOW = 0.72;
const SIZE_SNAP_HIGH = 1.1;

/** Channel difference (0–255) below which a word has no ink worth reading. */
const MIN_CONTRAST = 40;
/** Ink pixels: at least this fraction of the word's strongest contrast (colour / stroke). */
const COLOUR_INK = 0.6;
const STROKE_INK = 0.5;
/** Two runs whose colours differ by less than this (any channel) are one run. */
const SAME_COLOUR = 40;

/** A line is bold when its median stroke (in em) is this × the page's median. */
const BOLD_RATIO = 1.3;
const MAX_RUN = 64;

/** Ring thickness (pixels) the background is read from. */
const RING = 3;
/** How far a word's erased box reaches beyond the ink box, × its height. */
const ERASE_PAD = 0.15;

/** Channel difference from the page colour that makes a pixel part of a picture. */
const DIFFERENCE = 12;
/** Pictures closer than this (points) are one picture. */
const MERGE_GAP = 3;
/** A region smaller than this on both sides (points) is noise. */
const MIN_REGION = 8;

/* ------------------------------------------------------------------ *
 * pixels
 * ------------------------------------------------------------------ */

/** A pixel rectangle, ends exclusive. */
type PixelBox = readonly [number, number, number, number];

type Rgb = readonly [number, number, number];

/** A page-point rectangle as the pixels it covers, clamped to the image, at least one pixel. */
function pixelBox(image: RgbaImage, x0: number, y0: number, x1: number, y1: number): PixelBox {
  const { width, height, scale } = image;
  const px0 = Math.min(width - 1, Math.max(0, Math.floor(x0 * scale)));
  const py0 = Math.min(height - 1, Math.max(0, Math.floor(y0 * scale)));
  const px1 = Math.min(width, Math.max(px0 + 1, Math.ceil(x1 * scale)));
  const py1 = Math.min(height, Math.max(py0 + 1, Math.ceil(y1 * scale)));
  return [px0, py0, px1, py1];
}

/** Count one more sample in a histogram bin. */
function bump(histogram: Int32Array, bin: number): void {
  histogram[bin] = (histogram[bin] ?? 0) + 1;
}

/** Count the pixel at byte offset `at` in the three per-channel histograms of `histogram`. */
function countColour(histogram: Int32Array, data: Uint8Array, at: number): void {
  bump(histogram, data[at] ?? 0);
  bump(histogram, 256 + (data[at + 1] ?? 0));
  bump(histogram, 512 + (data[at + 2] ?? 0));
}

/** The median of a 256-bin histogram holding `total` samples. */
function histogramMedian(histogram: Int32Array, offset: number, total: number): number {
  let seen = 0;
  let value = 0;
  for (; value < 255; value += 1) {
    seen += histogram[offset + value] as number;
    if (seen * 2 >= total) break;
  }
  return value;
}

/** The per-channel median of the pixels in a ring of `thickness` around `box`; white if there is none. */
function ringMedian(data: Uint8Array, width: number, height: number, box: PixelBox, thickness: number): Rgb {
  const [x0, y0, x1, y1] = box;
  const ex0 = Math.max(0, x0 - thickness);
  const ey0 = Math.max(0, y0 - thickness);
  const ex1 = Math.min(width, x1 + thickness);
  const ey1 = Math.min(height, y1 + thickness);
  const histogram = new Int32Array(768);
  let total = 0;
  const take = (x: number, y: number): void => {
    const at = (y * width + x) * 4;
    countColour(histogram, data, at);
    total += 1;
  };
  for (let y = ey0; y < ey1; y += 1) {
    if (y >= y0 && y < y1) {
      for (let x = ex0; x < x0; x += 1) take(x, y);
      for (let x = x1; x < ex1; x += 1) take(x, y);
    } else {
      for (let x = ex0; x < ex1; x += 1) take(x, y);
    }
  }
  if (total === 0) return [255, 255, 255];
  return [
    histogramMedian(histogram, 0, total),
    histogramMedian(histogram, 256, total),
    histogramMedian(histogram, 512, total),
  ];
}

/** The largest channel difference between a pixel and a colour. */
function distance(data: Uint8Array, at: number, color: Rgb): number {
  return Math.max(
    Math.abs((data[at] as number) - color[0]),
    Math.abs((data[at + 1] as number) - color[1]),
    Math.abs((data[at + 2] as number) - color[2]),
  );
}

const rgbNumber = (color: Rgb): number => (color[0] << 16) | (color[1] << 8) | color[2];

/* ------------------------------------------------------------------ *
 * text
 * ------------------------------------------------------------------ */

interface WordInk {
  /** The colour of the word's ink; black where the word has no contrast against its background. */
  readonly color: Rgb;
  /** Lengths of the horizontal ink runs (1…MAX_RUN px), counted over the word's rows. */
  readonly runs: Int32Array;
}

/** The ink of one word: its colour and the lengths of its strokes. */
function measureWord(image: RgbaImage, word: OcrWord): WordInk {
  const { data, width, height } = image;
  const box = pixelBox(image, word.x0, word.y0, word.x1, word.y1);
  const [x0, y0, x1, y1] = box;
  const background = ringMedian(data, width, height, box, RING);
  let strongest = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      strongest = Math.max(strongest, distance(data, (y * width + x) * 4, background));
    }
  }
  const runs = new Int32Array(MAX_RUN + 1);
  if (strongest < MIN_CONTRAST) return { color: [0, 0, 0], runs };
  const histogram = new Int32Array(768);
  let inked = 0;
  for (let y = y0; y < y1; y += 1) {
    let run = 0;
    for (let x = x0; x <= x1; x += 1) {
      const at = (y * width + x) * 4;
      const away = x < x1 ? distance(data, at, background) : 0;
      if (away >= STROKE_INK * strongest) {
        run += 1;
      } else if (run > 0) {
        bump(runs, Math.min(run, MAX_RUN));
        run = 0;
      }
      if (away >= COLOUR_INK * strongest) {
        countColour(histogram, data, at);
        inked += 1;
      }
    }
  }
  return {
    color: [
      histogramMedian(histogram, 0, inked),
      histogramMedian(histogram, 256, inked),
      histogramMedian(histogram, 512, inked),
    ],
    runs,
  };
}

/** The median of a run-length histogram, in pixels; 0 when it is empty. */
function medianRun(runs: Int32Array): number {
  let total = 0;
  for (const count of runs) total += count;
  let seen = 0;
  let length = 1;
  for (; length < MAX_RUN; length += 1) {
    seen += runs[length] as number;
    if (seen * 2 >= total) break;
  }
  return total === 0 ? 0 : length;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/** The value at fraction `q` (0…1) of the sorted values, rounding up. */
const quantile = (values: readonly number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
};

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** A symbol, or one letter or digit alone in punctuation — "(O)", "[x]": what tesseract makes of a bullet or an icon. */
const SYMBOLIC = /^[^\p{L}\p{N}]*(?:[\p{L}\p{N}][^\p{L}\p{N}]+)?$/u;
/** Words made of x-height letters and low punctuation only; İ Ğ Ö Ü… reach higher than the capitals; descenders. */
const X_ONLY = /^[acemnopqrsuvwxyzgıçş.,:;\-_+=<>~]+$/;
const MARKED_CAPITAL = /[İĞÖÜÂÊÎÔÛ]/;
const HAS_DESCENDER = /[gjpqyçşÇŞQ,;()[\]{}|/@]/;

/** Whether a word is a symbol-only guess of tesseract it is not sure of: a misread icon or chart mark. */
export const isMisread = (word: OcrWord): boolean =>
  word.confidence < MISREAD_CONFIDENCE && SYMBOLIC.test(word.text);

/** The font size one word's height gives, by what its text holds; none for a word of symbols. */
function wordSize(word: OcrWord): number | undefined {
  if (word.size !== undefined) return word.size;
  if (!LETTER_OR_DIGIT.test(word.text)) return undefined;
  let top = ASCENDER;
  if (MARKED_CAPITAL.test(word.text)) top = MARKED;
  else if (X_ONLY.test(word.text)) top = X_HEIGHT;
  const bottom = HAS_DESCENDER.test(word.text) ? DESCENDER : 0;
  return (word.y1 - word.y0) / (top + bottom);
}

/** The size of a line of words: the median of the words' own, else what the ink extent gives. */
function lineSize(words: readonly OcrWord[]): number {
  const sizes = words.flatMap((word) => wordSize(word) ?? []);
  if (sizes.length > 0) return median(sizes);
  const top = Math.min(...words.map((word) => word.y0));
  const bottom = Math.max(...words.map((word) => word.y1));
  return (bottom - top) / INK_EXTENT;
}

/** The baseline (page y) of a line: tesseract's where it found one, else the median of the words' bottoms less their descenders. */
function baselineOf(words: readonly OcrWord[], size: number): number {
  const found = words.find((word) => word.baseline !== undefined)?.baseline;
  if (found !== undefined) return (found.y0 + found.y1) / 2;
  const bottoms = words
    .filter((word) => wordSize(word) !== undefined)
    .map((word) => word.y1 - (HAS_DESCENDER.test(word.text) ? DESCENDER * size : 0));
  return bottoms.length > 0 ? median(bottoms) : Math.max(...words.map((word) => word.y1)) - DESCENT * size;
}

interface Line {
  readonly words: readonly OcrWord[];
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  /** The font size the words' heights give, before it is rounded or snapped to the paragraph's. */
  readonly size: number;
  readonly baseline: number;
  /** The picture region the words lie in (−1: on the page itself). */
  readonly region: number;
}

function toLine(words: readonly OcrWord[], region: number): Line {
  const sorted = [...words].sort((a, b) => a.x0 - b.x0);
  const size = lineSize(sorted);
  return {
    words: sorted,
    x0: Math.min(...sorted.map((word) => word.x0)),
    x1: Math.max(...sorted.map((word) => word.x1)),
    y0: Math.min(...sorted.map((word) => word.y0)),
    y1: Math.max(...sorted.map((word) => word.y1)),
    size,
    baseline: baselineOf(sorted, size),
    region,
  };
}

/** The index of the smallest region containing the centre of a word, −1 where there is none. */
function regionIndex(regions: readonly Box[]): (word: OcrWord) => number {
  const bySize = regions
    .map((box, index) => ({ box, index, area: (box[2] - box[0]) * (box[3] - box[1]) }))
    .sort((a, b) => a.area - b.area);
  return (word) => {
    const x = (word.x0 + word.x1) / 2;
    const y = (word.y0 + word.y1) / 2;
    const hit = bySize.find(({ box }) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]);
    return hit === undefined ? -1 : hit.index;
  };
}

/** The words without those that are symbol-only guesses over a picture region (an icon, a chart). */
export function dropMisreads(words: readonly OcrWord[], regions: readonly Box[]): OcrWord[] {
  const within = regionIndex(regions);
  return words.filter((word) => !(isMisread(word) && within(word) >= 0));
}

/** One word's run attributes, before neighbouring words are merged. */
interface Token {
  readonly text: string;
  readonly bold: boolean;
  readonly color: Rgb;
  readonly note: string | undefined;
}

const sameColour = (a: Rgb, b: Rgb): boolean =>
  Math.abs(a[0] - b[0]) <= SAME_COLOUR &&
  Math.abs(a[1] - b[1]) <= SAME_COLOUR &&
  Math.abs(a[2] - b[2]) <= SAME_COLOUR;

/** The runs of a line: neighbours with the same look are one run; a noted word stands alone. */
function runsOf(tokens: readonly Token[], size: number, font: string): TextRun[] {
  const runs: { run: TextRun; color: Rgb }[] = [];
  for (const [index, token] of tokens.entries()) {
    const last = runs[runs.length - 1];
    let text = token.text;
    if (index > 0 && last !== undefined) {
      // The space belongs to the run before, unless that run is a noted word.
      if (last.run.note === undefined) last.run = { ...last.run, text: `${last.run.text} ` };
      else text = ` ${text}`;
    }
    if (
      last !== undefined &&
      token.note === undefined &&
      last.run.note === undefined &&
      last.run.bold === token.bold &&
      sameColour(last.color, token.color)
    ) {
      last.run = { ...last.run, text: last.run.text + text };
      continue;
    }
    runs.push({
      run: {
        text,
        font,
        size,
        bold: token.bold,
        italic: false,
        color: rgbNumber(token.color),
        link: null,
        ...(token.note === undefined ? {} : { note: token.note }),
      },
      color: token.color,
    });
  }
  return runs.map((entry) => entry.run);
}

/**
 * Tesseract's lines, cut where the gap between two words is wider than a column gutter
 * (`GUTTER` × the size) or where one word lies in another region than the one before. A word
 * without a line index stands alone.
 */
function groupLines(words: readonly OcrWord[], regionOf: (word: OcrWord) => number): Line[] {
  const found = new Map<string, OcrWord[]>();
  for (const [index, word] of words.entries()) {
    const key = word.line === undefined ? `alone${index}` : `${word.line}`;
    const line = found.get(key);
    if (line === undefined) found.set(key, [word]);
    else line.push(word);
  }
  const lines: Line[] = [];
  for (const members of found.values()) {
    const sorted = [...members].sort((a, b) => a.x0 - b.x0);
    const reach = GUTTER * lineSize(sorted);
    let piece: OcrWord[] = [];
    let right = -Infinity;
    for (const word of sorted) {
      if (piece.length > 0 && (word.x0 - right > reach || regionOf(word) !== regionOf(piece[0] as OcrWord))) {
        lines.push(toLine(piece, regionOf(piece[0] as OcrWord)));
        piece = [];
      }
      piece.push(word);
      right = piece.length === 1 ? word.x1 : Math.max(right, word.x1);
    }
    lines.push(toLine(piece, regionOf(piece[0] as OcrWord)));
  }
  return lines;
}

/** Whether `line` carries on the paragraph whose last line is `last`: same region, aligned, a line below at a similar size. */
function continues(last: Line, line: Line): boolean {
  if (last.region !== line.region) return false;
  const high = Math.max(last.size, line.size);
  const leading = line.baseline - last.baseline;
  const ratio = line.size / last.size;
  if (leading < MIN_LEADING * high || leading > MAX_LEADING * high) return false;
  if (ratio < SAME_SIZE_LOW || ratio > SAME_SIZE_HIGH) return false;
  const reach = ALIGN * high;
  return (
    Math.abs(line.x0 - last.x0) <= reach ||
    Math.abs((line.x0 + line.x1) / 2 - (last.x0 + last.x1) / 2) <= reach
  );
}

/** Lines, top to bottom, into paragraphs: each line joins the nearest paragraph above it that it continues. */
function groupParagraphs(lines: readonly Line[]): Line[][] {
  const paragraphs: Line[][] = [];
  for (const line of [...lines].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
    let best: Line[] | undefined;
    let nearest = Infinity;
    for (const paragraph of paragraphs) {
      const last = paragraph[paragraph.length - 1] as Line;
      const leading = line.baseline - last.baseline;
      if (leading < nearest && continues(last, line)) {
        best = paragraph;
        nearest = leading;
      }
    }
    if (best === undefined) paragraphs.push([line]);
    else best.push(line);
  }
  return paragraphs;
}

const boundsOf = (lines: readonly Line[]): Box => [
  Math.min(...lines.map((line) => line.x0)),
  Math.min(...lines.map((line) => line.y0)),
  Math.max(...lines.map((line) => line.x1)),
  Math.max(...lines.map((line) => line.y1)),
];

/**
 * Reading order by recursive cuts: items are split at a horizontal gap that no box crosses
 * (top part first), else at a vertical one (left part first), and what no gap divides is read
 * top to bottom.
 */
function readingOrder<T>(items: readonly T[], boxOf: (item: T) => Box): T[] {
  if (items.length < 2) return [...items];
  for (const axis of [1, 0] as const) {
    const sorted = [...items].sort((a, b) => boxOf(a)[axis] - boxOf(b)[axis]);
    let end = boxOf(sorted[0] as T)[axis + 2] as number;
    for (let at = 1; at < sorted.length; at += 1) {
      const box = boxOf(sorted[at] as T);
      if (box[axis] > end) {
        return [...readingOrder(sorted.slice(0, at), boxOf), ...readingOrder(sorted.slice(at), boxOf)];
      }
      end = Math.max(end, box[axis + 2] as number);
    }
  }
  return [...items].sort((a, b) => boxOf(a)[1] - boxOf(b)[1] || boxOf(a)[0] - boxOf(b)[0]);
}

/**
 * The text boxes of a recognised page: one per paragraph, in reading order. `regions` are the
 * boxes of the pictures `ocrBackground` found: lines and paragraphs never cross their edge.
 * `flagged` lists the words with a letter or digit whose confidence is below `lowConfidence`;
 * each is a run of its own with a `note`.
 */
export function ocrTextBoxes(
  words: readonly OcrWord[],
  image: RgbaImage,
  lowConfidence: number,
  regions: readonly Box[] = [],
  font = 'Arial',
): { boxes: TextBox[]; flagged: { text: string; confidence: number }[] } {
  const flagged: { text: string; confidence: number }[] = [];
  const inks = new Map<OcrWord, WordInk>();
  const paragraphs = readingOrder(groupParagraphs(groupLines(words, regionIndex(regions))), boundsOf);
  const lineStroke = new Map<Line, number>();
  const sizes = new Map<Line, number>();

  for (const lines of paragraphs) {
    const upper = quantile(
      lines.map((line) => line.size),
      0.75,
    );
    for (const line of lines) {
      const own = line.size;
      const size = own >= SIZE_SNAP_LOW * upper && own <= SIZE_SNAP_HIGH * upper ? upper : own;
      const rounded = Math.max(1, Math.round(size * 2) / 2);
      sizes.set(line, rounded);
      const runs = new Int32Array(MAX_RUN + 1);
      for (const word of line.words) {
        const ink = measureWord(image, word);
        inks.set(word, ink);
        for (let length = 1; length <= MAX_RUN; length += 1)
          runs[length] = (runs[length] ?? 0) + (ink.runs[length] ?? 0);
      }
      lineStroke.set(line, medianRun(runs) / (rounded * image.scale));
    }
  }
  const pageStroke = median([...lineStroke.values()]);

  const boxes: TextBox[] = [];
  for (const lines of paragraphs) {
    const textLines: TextLine[] = [];
    const baselines: number[] = [];
    for (const line of lines) {
      const size = sizes.get(line) as number;
      const bold = pageStroke > 0 && (lineStroke.get(line) as number) >= BOLD_RATIO * pageStroke;
      const tokens = line.words.map((word): Token => {
        const low = word.confidence / 100 < lowConfidence && !SYMBOLIC.test(word.text);
        if (low) flagged.push({ text: word.text, confidence: word.confidence / 100 });
        return {
          text: word.text,
          bold,
          color: (inks.get(word) as WordInk).color,
          note: low ? `Low OCR confidence (${Math.round(word.confidence)} %)` : undefined,
        };
      });
      baselines.push(line.baseline);
      textLines.push({ runs: runsOf(tokens, size, font) });
    }
    const firstSize = sizes.get(lines[0] as Line) as number;
    const gaps = baselines.slice(1).map((baseline, index) => baseline - (baselines[index] as number));
    const lineHeight = gaps.length === 0 ? SINGLE_LINE * firstSize : Math.max(firstSize, median(gaps));
    const left = Math.min(...lines.map((line) => line.x0));
    const right = Math.max(...lines.map((line) => line.x1));
    const centre = (left + right) / 2;
    const centred =
      lines.length > 1 &&
      lines.every((line) => Math.abs((line.x0 + line.x1) / 2 - centre) <= CENTRE_TOLERANCE) &&
      !lines.every((line) => Math.abs(line.x0 - left) <= CENTRE_TOLERANCE);
    const width = (right - left) * WIDTH_FACTOR + WIDTH_PAD;
    const x0 = centred ? centre - width / 2 : left;
    const top = (baselines[0] as number) - BASELINE_IN_LINE * lineHeight;
    const bottom = Math.max(top + lineHeight * lines.length, ...lines.map((line) => line.y1));
    const paragraph: TextParagraph = {
      align: centred ? 'center' : 'left',
      lineHeight,
      lines: textLines,
    };
    boxes.push({ box: [x0, top, x0 + width, bottom], rotation: 0, paragraphs: [paragraph] });
  }
  return { boxes, flagged };
}

/* ------------------------------------------------------------------ *
 * background
 * ------------------------------------------------------------------ */

/** Grow a mask by `radius` pixels in both directions (a square window). */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const across = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let count = 0;
    for (let x = 0; x < Math.min(width, radius); x += 1) count += mask[row + x] as number;
    for (let x = 0; x < width; x += 1) {
      if (x + radius < width) count += mask[row + x + radius] as number;
      if (x - radius - 1 >= 0) count -= mask[row + x - radius - 1] as number;
      across[row + x] = count > 0 ? 1 : 0;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x += 1) {
    let count = 0;
    for (let y = 0; y < Math.min(height, radius); y += 1) count += across[y * width + x] as number;
    for (let y = 0; y < height; y += 1) {
      if (y + radius < height) count += across[(y + radius) * width + x] as number;
      if (y - radius - 1 >= 0) count -= across[(y - radius - 1) * width + x] as number;
      out[y * width + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/** The most common colour of the image, with 16 levels per channel, as the mean of that bin. */
function commonColor(data: Uint8Array): Rgb {
  const counts = new Int32Array(4096);
  const sums = new Float64Array(4096 * 3);
  for (let at = 0; at < data.length; at += 4) {
    const r = data[at] as number;
    const g = data[at + 1] as number;
    const b = data[at + 2] as number;
    const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    counts[bin] = (counts[bin] ?? 0) + 1;
    sums[bin * 3] = (sums[bin * 3] ?? 0) + r;
    sums[bin * 3 + 1] = (sums[bin * 3 + 1] ?? 0) + g;
    sums[bin * 3 + 2] = (sums[bin * 3 + 2] ?? 0) + b;
  }
  let best = 0;
  for (let bin = 1; bin < 4096; bin += 1) if ((counts[bin] as number) > (counts[best] as number)) best = bin;
  const n = counts[best] as number;
  return [
    Math.round((sums[best * 3] as number) / n),
    Math.round((sums[best * 3 + 1] as number) / n),
    Math.round((sums[best * 3 + 2] as number) / n),
  ];
}

/**
 * The page without its words: every word box is filled with the background around it, the
 * page colour is the commonest colour left, and each connected region that differs from it is
 * cropped out of the erased image.
 */
export function ocrBackground(
  image: RgbaImage,
  words: readonly OcrWord[],
): { pageColor: number; regions: { box: Box; rgba: RgbaImage }[] } {
  const { width, height, scale } = image;
  const data = new Uint8Array(image.data);

  for (const word of words) {
    const pad = ERASE_PAD * (word.y1 - word.y0);
    const box = pixelBox(image, word.x0 - pad, word.y0 - pad, word.x1 + pad, word.y1 + pad);
    const [x0, y0, x1, y1] = box;
    const [r, g, b] = ringMedian(data, width, height, box, RING);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * width + x) * 4;
        data[at] = r;
        data[at + 1] = g;
        data[at + 2] = b;
        data[at + 3] = 255;
      }
    }
  }

  const page = commonColor(data);
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = distance(data, index * 4, page) > DIFFERENCE ? 1 : 0;
  }
  const grown = dilate(mask, width, height, Math.max(1, Math.round(MERGE_GAP * scale)));

  const regions: { box: Box; rgba: RgbaImage }[] = [];
  const stack = new Int32Array(width * height);
  for (let start = 0; start < grown.length; start += 1) {
    if (grown[start] === 0) continue;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let top = 0;
    stack[top++] = start;
    grown[start] = 0;
    while (top > 0) {
      const at = stack[--top] as number;
      const x = at % width;
      const y = (at - x) / width;
      if (mask[at] === 1) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      if (x > 0 && grown[at - 1] === 1) {
        grown[at - 1] = 0;
        stack[top++] = at - 1;
      }
      if (x + 1 < width && grown[at + 1] === 1) {
        grown[at + 1] = 0;
        stack[top++] = at + 1;
      }
      if (y > 0 && grown[at - width] === 1) {
        grown[at - width] = 0;
        stack[top++] = at - width;
      }
      if (y + 1 < height && grown[at + width] === 1) {
        grown[at + width] = 0;
        stack[top++] = at + width;
      }
    }
    if ((maxX - minX + 1) / scale < MIN_REGION && (maxY - minY + 1) / scale < MIN_REGION) continue;
    const x0 = Math.max(0, minX - 1);
    const y0 = Math.max(0, minY - 1);
    const x1 = Math.min(width, maxX + 2);
    const y1 = Math.min(height, maxY + 2);
    const cropWidth = x1 - x0;
    const crop = new Uint8Array(cropWidth * (y1 - y0) * 4);
    for (let y = y0; y < y1; y += 1) {
      const from = (y * width + x0) * 4;
      crop.set(data.subarray(from, from + cropWidth * 4), (y - y0) * cropWidth * 4);
    }
    regions.push({
      box: [x0 / scale, y0 / scale, x1 / scale, y1 / scale],
      rgba: { width: cropWidth, height: y1 - y0, data: crop, scale },
    });
  }
  return { pageColor: rgbNumber(page), regions };
}
