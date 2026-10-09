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
 *    out as one picture per connected region, and everything else is the page colour. A crooked
 *    scan is read on an upright copy of it (`ocr-preprocess.ts`): the words are the copy's, and
 *    the erasing and the pictures are the scan's own (`ocrBackground`'s `turn`, `eraseRulesTurned`).
 *    `misreadWords` / `dropMisreads` name what tesseract made of an icon or a chart (symbols,
 *    stems, low-confidence letters) lying over a picture: not text, it stays in the picture;
 *    `dropDuplicates` keeps the surer of two words read at the same place.
 *
 * `OcrWord.confidence` is tesseract's 0–100 (the adapter passes it through); `lowConfidence`
 * is a fraction, 0.90 for "flag below 90 %", the threshold measured in `docs/ocr-evaluation.md`.
 */

import type { OcrWord } from '../engines/tesseract';
import type { RunFit, TextBox, TextLine, TextParagraph, TextRun } from './layout-scene';
import { rotateAbout } from './ocr-preprocess';
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

/** Lines on baselines at most this × the size apart are cells of one row. */
const ROW_BAND = 0.5;
/** Two rows are rows of a table when this many of their cells stand under cells of the row above (a left edge, a right edge or a centre); rows need a column of figures too (`amountLike`: the left-most or the right-most cell of both rows for two cells, a figure under a figure for more)… */
const TABLE_CELLS = 3;
/** …and rows of three cells or more further apart than this × the size are not one table (rows are padded: twice the size is usual; two cells reach `MAX_LEADING` only: cards, paragraph breaks of two columns). */
const TABLE_MAX_LEADING = 4;
/** …and their cells hold this many words or fewer on average (a line of prose has more). */
const TABLE_CELL_WORDS = 4;

/** A symbol-only word is a misread graphic when tesseract is less sure than this (0–100). */
const MISREAD_CONFIDENCE = 60;
/** …a word of letters only, when less sure than this; a single stem, when taller than this × the page's median word. */
const MISREAD_LETTERS = 25;
const TALL_STEM = 1.5;
const STEM_ASPECT = 0.35;
/** Words of at most two characters this close to the left or right edge of the page (× its width) are scanner marks. */
const EDGE_BAND = 0.03;
const TALL_SYMBOL = 1.5;
/** A symbol between two sure words of its line, each at most this × the typical word height away, is text. */
const SEPARATOR_REACH = 2;
/** Two groups are columns when their vertical extents overlap by this share of the shorter. */
const COLUMN_OVERLAP = 0.33;
/** A horizontal gap at least this × the widest vertical one is cut first… */
const ROW_PREFERENCE = 0.6;
/** …when it is also at least this × the page's typical line size: the blank line between two paragraphs is not the gap between rows of cards (and cutting there would interleave two columns of text) — unless the vertical gap is no wider than a gutter (`GUTTER` × the size: the space between the cells of a table) or a side of it holds no paragraph of more than one line (a column of line numbers, of labels). */
const ROW_MIN_GAP = 2.5;
/** An opening bracket with at most one letter or digit after it: the corner of an external-link icon read as text — unless a closing bracket follows on its line ("(5 pages)"). */
const OPENING_BRACKET = /^[[({<][\p{L}\p{N}]?$/u;
const CLOSING_BRACKET = /[)\]}>]/;
/** A symbol of one or two characters (a pipe is a character of the text, whatever its height) taller than this × its line's words and narrower than this × its height: a rule of the design (a bar between items), not text. */
const TALL_BAR = 1.3;
const BAR_ASPECT = 0.5;
/** Two words overlapping by more than this share of the smaller one are one word read twice. */
const DUPLICATE_OVERLAP = 0.3;

/** Word's natural line is about this × size; where the first baseline sits inside the line. */
const SINGLE_LINE = 1.2;
const BASELINE_IN_LINE = 0.8;

/** Width slack, as in `docx-layout-text`: a substitute font a little wider must not wrap. */
const WIDTH_FACTOR = 1.03;
const WIDTH_PAD = 2;

/** Lines whose centres all lie this close to the paragraph's centre (points) are centred. */
const CENTRE_TOLERANCE = 2;

/** A line's size is its paragraph's (the upper quartile) unless it is clearly different. */
const SIZE_SNAP_LOW = 0.88;
const SIZE_SNAP_HIGH = 1.1;

/** Channel difference (0–255) below which a word has no ink worth reading. */
const MIN_CONTRAST = 40;
/** Ink pixels: at least this fraction of the word's strongest contrast (colour / stroke). */
const COLOUR_INK = 0.6;
const STROKE_INK = 0.5;
/** Two runs whose colours differ by less than this (any channel) are one run. */
const SAME_COLOUR = 40;

/**
 * A line is bold when its stroke (in em) is this × the page's median; a word of a line that is
 * not, when its own is at least `BOLD_WORD` × over at least `BOLD_EVIDENCE` ink rows (fewer: it
 * takes the weight of its neighbours when both are bold, else it is not).
 */
const BOLD_RATIO = 1.3;
const BOLD_WORD = 1.22;
const BOLD_EVIDENCE = 60;

/**
 * Italic: the ink of a line is sheared back by each of these tangents of the slant (rows above
 * the word's middle moving left, undoing a lean to the right); the shear that makes the
 * columns' ink sharpest (Σ column sums²) is the slant. A line leans when the sharpest shear is
 * at least `ITALIC_SLANT` and beats the upright reading by `ITALIC_GAIN`.
 */
const SHEARS = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35] as const;
const ITALIC_SLANT = 0.1;
const ITALIC_GAIN = 1.05;
const MAX_RUN = 64;
const STROKE_SHARE = 0.6;

/** Ring thickness (pixels) the background is read from. */
const RING = 3;
/** How far a word's erased box reaches beyond the ink box, × its height. */
const ERASE_PAD = 0.15;
/** …and for a word with a mark above or a cedilla below, that far (× its height) on that side. */
const MARK_PAD = 0.4;
const MARKED_ABOVE = /[İĞÖÜÂÊÎÔÛ]/;
const CEDILLA = /[ÇŞçşĢģ]/;

/**
 * A scan saved as JPEG has faint ripples around letters, up to a block (16 px) away from the
 * ink: the erased box of a word grows over them, side by side, while the next row or column
 * holds nothing but pixels within `RIPPLE_DIFFERENCE` of the fill (anything stronger — the ink
 * of the next word, a rule, a card edge — stops it).
 */
const RIPPLE_REACH = 16;
const RIPPLE_DIFFERENCE = 17;
/** A stretch of this many points (or this share of the box's side, if shorter) at one level that is 3 or more off the fill is a tint, not a ripple. */
const RIPPLE_FLAT_RUN = 8;
const RIPPLE_FLAT_SHARE = 0.8;
const RIPPLE_FLAT_OFFSET = 3;

/** Channel difference from the page colour that makes a pixel part of a picture. */
const DIFFERENCE = 12;
/** Pictures closer than this (points) are one picture. */
const MERGE_GAP = 3;
/** A region smaller than this on both sides (points) is noise. */
const MIN_REGION = 8;
/** A region is a solid fill (a card, a band, a photo) when this share of its box differs from the page colour; the rest is marks. */
const SOLID_FILL = 0.5;

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

/**
 * Whether the pixels at `at(from)` … `at(to - 1)` (indices into `data`) are ripples around the
 * fill: all within `RIPPLE_DIFFERENCE` of it, and without a flat stretch — one level, off the
 * fill by 3 or more, over `flatRun` pixels — which is a tint or a card of its own, not noise.
 */
function ripples(
  data: Uint8Array,
  fill: Rgb,
  from: number,
  to: number,
  at: (i: number) => number,
  flatRun: number,
): boolean {
  const level = (index: number): number =>
    ((data[index] as number) +
      (data[index + 1] as number) +
      (data[index + 2] as number) -
      fill[0] -
      fill[1] -
      fill[2]) /
    3;
  let run = 0;
  let previous = 0;
  for (let i = from; i < to; i += 1) {
    const index = at(i);
    if (distance(data, index, fill) > RIPPLE_DIFFERENCE) return false;
    const offset = level(index);
    const off = Math.abs(offset) >= RIPPLE_FLAT_OFFSET;
    run = off ? (run > 0 && Math.abs(offset - previous) <= 1 ? run + 1 : 1) : 0;
    previous = offset;
    if (run >= flatRun) return false;
  }
  return true;
}

/** `box` grown over the faint ripples around it (see `RIPPLE_REACH`), side by side. */
function growOverRipples(
  data: Uint8Array,
  width: number,
  height: number,
  scale: number,
  box: PixelBox,
  fill: Rgb,
): PixelBox {
  let [x0, y0, x1, y1] = box;
  const flatRun = (length: number): number =>
    Math.max(2, Math.min(Math.round(RIPPLE_FLAT_RUN * scale), Math.floor(RIPPLE_FLAT_SHARE * length)));
  const quiet = (y: number): boolean =>
    ripples(data, fill, x0, x1, (x) => (y * width + x) * 4, flatRun(x1 - x0));
  const stirred = (x: number): boolean =>
    ripples(data, fill, y0, y1, (y) => (y * width + x) * 4, flatRun(y1 - y0));
  for (let step = 0; step < RIPPLE_REACH && y0 > 0 && quiet(y0 - 1); step += 1) y0 -= 1;
  for (let step = 0; step < RIPPLE_REACH && y1 < height && quiet(y1); step += 1) y1 += 1;
  for (let step = 0; step < RIPPLE_REACH && x0 > 0 && stirred(x0 - 1); step += 1) x0 -= 1;
  for (let step = 0; step < RIPPLE_REACH && x1 < width && stirred(x1); step += 1) x1 += 1;
  return [x0, y0, x1, y1];
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

/** A rectangle of pixels filled with one colour. */
interface Fill {
  readonly box: PixelBox;
  readonly color: Rgb;
}

/** Fill the pixels of `fill` in `data` (opaque). */
function paint(data: Uint8Array, width: number, fill: Fill): void {
  const [x0, y0, x1, y1] = fill.box;
  const [r, g, b] = fill.color;
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

/** The pixel box of the scan that holds `box`, a box of its upright copy turned by `angle` about the canvas centre (`frame`'s), clamped to the canvas. */
function scanBox(frame: Pick<RgbaImage, 'width' | 'height'>, box: PixelBox, angle: number): PixelBox {
  const { width, height } = frame;
  const [x0, y0, x1, y1] = box;
  const corners = [
    rotateAbout(x0, y0, width / 2, height / 2, angle),
    rotateAbout(x1, y0, width / 2, height / 2, angle),
    rotateAbout(x1, y1, width / 2, height / 2, angle),
    rotateAbout(x0, y1, width / 2, height / 2, angle),
  ];
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const px0 = Math.min(width - 1, Math.max(0, Math.floor(Math.min(...xs))));
  const py0 = Math.min(height - 1, Math.max(0, Math.floor(Math.min(...ys))));
  return [
    px0,
    py0,
    Math.min(width, Math.max(px0 + 1, Math.ceil(Math.max(...xs)))),
    Math.min(height, Math.max(py0 + 1, Math.ceil(Math.max(...ys)))),
  ];
}

/**
 * The fills of an upright copy (`ocr-preprocess.ts`) painted on the scan it was turned from by
 * `angle`: a scan pixel takes a fill's colour when its centre, turned back, lies inside the
 * fill's box — the quad the box becomes, not the box around it, so the lines beside a skewed
 * word are not touched.
 */
function paintTurned(
  data: Uint8Array,
  frame: Pick<RgbaImage, 'width' | 'height'>,
  fills: readonly Fill[],
  angle: number,
): void {
  const { width, height } = frame;
  for (const fill of fills) {
    const [x0, y0, x1, y1] = fill.box;
    const [r, g, b] = fill.color;
    const [bx0, by0, bx1, by1] = scanBox(frame, fill.box, angle);
    for (let y = by0; y < by1; y += 1) {
      for (let x = bx0; x < bx1; x += 1) {
        const [u, v] = rotateAbout(x + 0.5, y + 0.5, width / 2, height / 2, -angle);
        if (u < x0 || u >= x1 || v < y0 || v >= y1) continue;
        const at = (y * width + x) * 4;
        data[at] = r;
        data[at + 1] = g;
        data[at + 2] = b;
        data[at + 3] = 255;
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * text
 * ------------------------------------------------------------------ */

interface WordInk {
  /** The colour of the word's ink; black where the word has no contrast against its background. */
  readonly color: Rgb;
  /** Lengths of the horizontal ink runs (1…MAX_RUN px), counted over the word's rows. */
  readonly runs: Int32Array;
  /** Σ column sums² of the ink after each of `SHEARS`; all zero where the word has no ink. */
  readonly sharpness: Float64Array;
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
  const sharpness = new Float64Array(SHEARS.length);
  if (strongest < MIN_CONTRAST) return { color: [0, 0, 0], runs, sharpness };
  const histogram = new Int32Array(768);
  const wide = x1 - x0;
  const mask = new Uint8Array(wide * (y1 - y0));
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
      if (x < x1 && away >= STROKE_INK * strongest) mask[(y - y0) * wide + (x - x0)] = 1;
    }
  }
  return {
    color: [
      histogramMedian(histogram, 0, inked),
      histogramMedian(histogram, 256, inked),
      histogramMedian(histogram, 512, inked),
    ],
    runs,
    sharpness: shearSharpness(mask, wide, y1 - y0),
  };
}

/** Σ column sums² of the ink `mask` (`wide` × `tall`) sheared back by each of `SHEARS`. */
function shearSharpness(mask: Uint8Array, wide: number, tall: number): Float64Array {
  const out = new Float64Array(SHEARS.length);
  const middle = (tall - 1) / 2;
  const pad = Math.ceil((SHEARS[SHEARS.length - 1] as number) * middle) + 1;
  for (const [index, shear] of SHEARS.entries()) {
    const columns = new Int32Array(wide + 2 * pad);
    for (let y = 0; y < tall; y += 1) {
      const shift = pad + Math.round(shear * (y - middle));
      for (let x = 0; x < wide; x += 1) {
        if (mask[y * wide + x] === 1) columns[x + shift] = (columns[x + shift] as number) + 1;
      }
    }
    let sum = 0;
    for (const column of columns) sum += column * column;
    out[index] = sum;
  }
  return out;
}

/** Whether the ink leans: the sharpest of `SHEARS` is a real slant and clearly sharper than upright. */
function leans(sharpness: Float64Array): boolean {
  let best = 0;
  for (let index = 1; index < sharpness.length; index += 1) {
    if ((sharpness[index] as number) > (sharpness[best] as number)) best = index;
  }
  return (
    (SHEARS[best] as number) >= ITALIC_SLANT &&
    (sharpness[best] as number) >= ITALIC_GAIN * (sharpness[0] as number)
  );
}

/** The stroke width of a run-length histogram, in pixels: the mean of its shortest `STROKE_SHARE` (the stems; long runs are bars and joins). 0 when it is empty. */
function strokeRun(runs: Int32Array): number {
  let total = 0;
  for (const count of runs) total += count;
  const keep = Math.ceil(total * STROKE_SHARE);
  let sum = 0;
  let taken = 0;
  for (let length = 1; length <= MAX_RUN && taken < keep; length += 1) {
    const used = Math.min(runs[length] as number, keep - taken);
    sum += used * length;
    taken += used;
  }
  return taken === 0 ? 0 : sum / taken;
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

/** What tesseract makes of a round icon: a ringed letter or a registered-mark sign. */
const ICON_GLYPH = /[()®©○●◯◎]/;

const medianHeight = (words: readonly OcrWord[]): number => median(words.map((word) => word.y1 - word.y0));

/**
 * The words that are not text but what tesseract made of a graphic: a symbol or a letter alone in
 * punctuation it is below 60 % sure of, or a ringed one like (O) or ® taller than 1.5 × the page's
 * typical word (an icon, a bullet); a word of one or two characters, taller than 1.5 × the typical word and
 * narrower than 0.35 × its height (a bar of a chart, a speck); a word of letters only it is below 25 % sure of (a level icon read as DUKE). A misread
 * word that lies over a picture region is dropped (`dropMisreads`), so the graphic stays in the
 * picture.
 */
export function misreadWords(words: readonly OcrWord[]): Set<OcrWord> {
  const typical = words.length === 0 ? Infinity : medianHeight(words);
  const reach = SEPARATOR_REACH * typical;
  // A symbol with a sure word of its own line close on both sides is a separator of the text (| — •), not a graphic.
  // Typical height of the words with letters or digits on the word's line (else of the page).
  const lineHeights = new Map<number | undefined, number>();
  const lineTypical = (word: OcrWord): number => {
    if (!lineHeights.has(word.line)) {
      const own = words.filter((other) => other.line === word.line && LETTER_OR_DIGIT.test(other.text));
      lineHeights.set(word.line, own.length === 0 ? typical : medianHeight(own));
    }
    return lineHeights.get(word.line) as number;
  };
  const separates = (word: OcrWord): boolean => {
    const sure = words.filter(
      (other) => other !== word && other.line === word.line && other.confidence >= MISREAD_CONFIDENCE,
    );
    return (
      sure.some((other) => other.x1 <= word.x0 + 1 && word.x0 - other.x1 <= reach) &&
      sure.some((other) => other.x0 >= word.x1 - 1 && other.x0 - word.x1 <= reach)
    );
  };
  const closed = (word: OcrWord): boolean =>
    words.some(
      (other) => other.line === word.line && other.x0 >= word.x1 - 1 && CLOSING_BRACKET.test(other.text),
    );
  return new Set(
    words.filter(
      (word) =>
        (SYMBOLIC.test(word.text) &&
          (word.confidence < MISREAD_CONFIDENCE ||
            (ICON_GLYPH.test(word.text) && word.y1 - word.y0 > TALL_SYMBOL * typical)) &&
          !separates(word)) ||
        (OPENING_BRACKET.test(word.text) && !closed(word)) ||
        (SYMBOLIC.test(word.text) &&
          word.text !== '|' &&
          word.text.length <= 2 &&
          word.y1 - word.y0 > TALL_BAR * lineTypical(word) &&
          word.x1 - word.x0 < BAR_ASPECT * (word.y1 - word.y0)) ||
        (word.text.length <= 2 &&
          word.y1 - word.y0 > TALL_STEM * typical &&
          word.x1 - word.x0 < STEM_ASPECT * (word.y1 - word.y0)) ||
        (word.confidence < MISREAD_LETTERS && /^\p{L}+$/u.test(word.text)),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * underlines
 * ------------------------------------------------------------------ */

/** A thin horizontal rule under text, page points (y down). */
export interface Rule {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** A rule row is inked over this share of the word's width. */
const UNDERLINE_COVER = 0.9;
/** The rule is at most this × the word's height thick (at least 2 px), and lies this far (× height) above / below the word's bottom edge. */
const UNDERLINE_THICK = 0.16;
const UNDERLINE_ABOVE = 0.35;
const UNDERLINE_BELOW = 0.45;
/** It reaches beyond the words it lies under by at most this × their height: a rule of the design is longer. */
const UNDERLINE_REACH = 0.8;
/** The words one rule runs under are at most this × their height apart (a space, not a cell's width), and no line of the design this × their height long meets its ends. */
const UNDERLINE_GROUP_GAP = 1.5;
const UNDERLINE_SIDE = 0.7;
/** A word under which the rule is looked for has at least this many letters or digits, and is at least this × its height wide. */
const UNDERLINE_MIN_CHARS = 2;
const UNDERLINE_MIN_WIDTH = 1.2;

/** Whether the rule runs under most of the word, at its bottom. */
function underlines(rule: Rule, word: OcrWord): boolean {
  const h = word.y1 - word.y0;
  const across = Math.min(rule.x1, word.x1) - Math.max(rule.x0, word.x0);
  return (
    across >= 0.6 * (word.x1 - word.x0) &&
    rule.y0 >= word.y1 - UNDERLINE_ABOVE * h - 1 &&
    rule.y1 <= word.y1 + UNDERLINE_BELOW * h + 1
  );
}

/**
 * The rules drawn under the words of a page: for each word, the rows just around its bottom
 * edge that are inked over nearly its whole width, thin, with plain background on both sides
 * of them; each is followed to where the ink ends, and kept when it lies under the words (not
 * far beyond them: a divider or the border of a card).
 */
export function findUnderlines(image: RgbaImage, words: readonly OcrWord[]): Rule[] {
  const { data, width, height, scale } = image;
  const found: Rule[] = [];
  for (const word of words) {
    if ((word.text.match(/[\p{L}\p{N}]/gu) ?? []).length < UNDERLINE_MIN_CHARS) continue;
    const h = word.y1 - word.y0;
    if (word.x1 - word.x0 < UNDERLINE_MIN_WIDTH * h) continue;
    const [x0, y0, x1, y1] = pixelBox(image, word.x0, word.y0, word.x1, word.y1);
    const background = ringMedian(data, width, height, [x0, y0, x1, y1], RING);
    let strongest = 0;
    for (let y = y0; y < y1; y += 1)
      for (let x = x0; x < x1; x += 1)
        strongest = Math.max(strongest, distance(data, (y * width + x) * 4, background));
    if (strongest < MIN_CONTRAST) continue;
    const inked = (x: number, y: number): boolean =>
      distance(data, (y * width + x) * 4, background) >= STROKE_INK * strongest;
    const cover = (y: number): number => {
      let count = 0;
      for (let x = x0; x < x1; x += 1) if (inked(x, y)) count += 1;
      return count / (x1 - x0);
    };
    const top = Math.max(0, Math.floor(y1 - UNDERLINE_ABOVE * h * scale));
    const bottom = Math.min(height - 1, Math.ceil(y1 + UNDERLINE_BELOW * h * scale));
    const thick = Math.max(2, Math.round(UNDERLINE_THICK * h * scale));
    let y = top;
    while (y <= bottom) {
      if (cover(y) < UNDERLINE_COVER) {
        y += 1;
        continue;
      }
      let end = y;
      while (end + 1 <= bottom && cover(end + 1) >= UNDERLINE_COVER) end += 1;
      const plain = (row: number): boolean => row < 0 || row >= height || cover(row) < 0.6;
      if (end - y + 1 <= thick && plain(y - 1) && plain(end + 1)) {
        // follow the rule's middle row left and right to where its ink ends
        const row = Math.floor((y + end) / 2);
        let left = x0;
        let gap = 0;
        for (let x = x0 - 1; x >= 0 && gap < 3; x -= 1) {
          if (inked(x, row)) {
            left = x;
            gap = 0;
          } else gap += 1;
        }
        let right = x1;
        gap = 0;
        for (let x = x1; x < width && gap < 3; x += 1) {
          if (inked(x, row)) {
            right = x + 1;
            gap = 0;
          } else gap += 1;
        }
        found.push({ x0: left / scale, y0: y / scale, x1: right / scale, y1: (end + 1) / scale });
      }
      y = end + 1;
    }
  }
  return found.filter((rule) => {
    const under = words.filter((word) => {
      const h = word.y1 - word.y0;
      return (
        word.x1 > rule.x0 &&
        word.x0 < rule.x1 &&
        rule.y0 >= word.y1 - UNDERLINE_ABOVE * h - 1 &&
        rule.y1 <= word.y1 + UNDERLINE_BELOW * h + 1
      );
    });
    if (under.length === 0) return false;
    const reach = UNDERLINE_REACH * medianHeight(under);
    const sorted = [...under].sort((a, b) => a.x0 - b.x0);
    // The words are one group (a link of several words), not the words of cells a border runs along.
    const joined = sorted.every(
      (word, at) =>
        at === 0 || word.x0 - (sorted[at - 1] as OcrWord).x1 <= UNDERLINE_GROUP_GAP * medianHeight(under),
    );
    return (
      joined &&
      rule.x0 >= (sorted[0] as OcrWord).x0 - reach &&
      rule.x1 <= Math.max(...under.map((word) => word.x1)) + reach &&
      !meetsVerticalRule(image, rule, medianHeight(under))
    );
  });
}

/**
 * Whether a line of the design runs up or down from an end of the rule (the side or the corner
 * of a table cell, a card): ink in a column at the rule's end, as long as most of a word's height,
 * right above or right below it. A link's underline ends in the air.
 */
function meetsVerticalRule(image: RgbaImage, rule: Rule, wordHeight: number): boolean {
  const { data, width, height, scale } = image;
  const y0 = Math.floor(rule.y0 * scale);
  const y1 = Math.min(height, Math.ceil(rule.y1 * scale));
  const middle = Math.min(height - 1, Math.floor((y0 + y1 - 1) / 2));
  const x0 = Math.max(0, Math.floor(rule.x0 * scale));
  const x1 = Math.min(width, Math.ceil(rule.x1 * scale));
  const background = ringMedian(data, width, height, [x0, y0, x1, y1], RING);
  const ink = distance(data, (middle * width + Math.floor((x0 + x1) / 2)) * 4, background);
  const inked = (x: number, y: number): boolean =>
    x >= 0 &&
    x < width &&
    y >= 0 &&
    y < height &&
    distance(data, (y * width + x) * 4, background) >= STROKE_INK * ink;
  const length = Math.ceil(UNDERLINE_SIDE * wordHeight * scale);
  const run = (x: number, from: number, step: 1 | -1): boolean => {
    for (let at = 0; at < length; at += 1) if (!inked(x, from + step * at)) return false;
    return true;
  };
  for (const end of [x0, x1 - 1]) {
    for (let x = end - 1; x <= end + 1; x += 1) {
      if (run(x, y0 - 1, -1) || run(x, y1, 1)) return true;
    }
  }
  return false;
}

/**
 * The image without the rules: each rule's rows (and one row beyond on each side, for the
 * anti-aliased edge) take the colour of the row below them, except where a letter's descender
 * crosses the rule (ink above and below it).
 */
export function eraseRules(image: RgbaImage, rules: readonly Rule[]): RgbaImage {
  const { width, height, scale } = image;
  return { width, height, data: ruleFills(image, rules).data, scale };
}

/** The pixels of `image` without the rules, and the fills that erased them (columns of the rule not crossed by a descender). */
function ruleFills(image: RgbaImage, rules: readonly Rule[]): { data: Uint8Array; fills: Fill[] } {
  const { width, height, scale } = image;
  const data = new Uint8Array(image.data);
  const fills: Fill[] = [];
  for (const rule of rules) {
    const x0 = Math.max(0, Math.floor(rule.x0 * scale));
    const x1 = Math.min(width, Math.ceil(rule.x1 * scale));
    const y0 = Math.max(0, Math.floor(rule.y0 * scale) - 1);
    const y1 = Math.min(height, Math.ceil(rule.y1 * scale) + 1);
    const above = Math.max(0, y0 - 1);
    const below = Math.min(height - 1, y1);
    const [r, g, b] = ringMedian(data, width, height, [x0, y0, x1, y1], RING);
    const background: Rgb = [r, g, b];
    // Runs of columns that are not crossed (the columns do not read each other's rows).
    let start = x0;
    const flush = (end: number): void => {
      if (end <= start) return;
      const fill: Fill = { box: [start, y0, end, y1], color: background };
      paint(data, width, fill);
      fills.push(fill);
    };
    for (let x = x0; x < x1; x += 1) {
      const crossed =
        distance(data, (above * width + x) * 4, background) >= MIN_CONTRAST &&
        distance(data, (below * width + x) * 4, background) >= MIN_CONTRAST;
      if (crossed) {
        flush(x);
        start = x + 1;
      }
    }
    flush(x1);
  }
  return { data, fills };
}

/**
 * `scan` without the rules found on its upright copy `image` (`ocr-preprocess.ts`, turned by
 * `angle`): the copy's fills are painted on the scan where they land, so the rule is erased
 * along the line it is drawn on.
 */
export function eraseRulesTurned(
  image: RgbaImage,
  rules: readonly Rule[],
  scan: RgbaImage,
  angle: number,
): RgbaImage {
  const data = new Uint8Array(scan.data);
  paintTurned(data, image, ruleFills(image, rules).fills, angle);
  return { width: scan.width, height: scan.height, data, scale: scan.scale };
}

/** A word of at most two characters smaller than this × the word it sits on is that word's mark, not a word. */
const MARK_SIZE = 0.5;
/** The mark lies within this × the word's height above it (or below it), and over its first this × width plus the same reach. */
const MARK_REACH = 0.6;

/** A mark is one character or nothing but punctuation: the word "is" under a heading is a word. */
const MARK_TEXT = /^(?:.|[^\p{L}\p{N}]{2})$/su;

/**
 * The words that are the mark of another: tesseract reads the dot of an İ, a cedilla or an
 * accent as a word of its own ("H", ".") just above or below the word it belongs to, on a text
 * line of its own. They are not text; the caller erases them with the word. A short word
 * among the words of its own line is a word, however close the line above or below it is.
 */
export function markWords(words: readonly OcrWord[]): Set<OcrWord> {
  const marks = new Set<OcrWord>();
  for (const mark of words) {
    if (!MARK_TEXT.test(mark.text)) continue;
    if (mark.line !== undefined && words.some((word) => word.line === mark.line && word.text.length > 2)) {
      continue;
    }
    const h = mark.y1 - mark.y0;
    const centre = (mark.x0 + mark.x1) / 2;
    const owner = words.some((word) => {
      const big = word.y1 - word.y0;
      return (
        word !== mark &&
        word.text.length > 2 &&
        h < MARK_SIZE * big &&
        centre >= word.x0 - MARK_REACH * big &&
        centre <= word.x1 &&
        ((word.y0 - mark.y1 <= MARK_REACH * big && word.y0 - mark.y1 >= -0.2 * big) ||
          (mark.y0 - word.y1 <= MARK_REACH * big && mark.y0 - word.y1 >= -0.2 * big))
      );
    });
    if (owner) marks.add(mark);
  }
  return marks;
}

/** Words without the one- and two-character ones in the outer 3 % of the page width: the dark scanner edge and its specks. */
export function dropEdgeMarks(words: readonly OcrWord[], pageWidth: number): OcrWord[] {
  const band = EDGE_BAND * pageWidth;
  return words.filter((word) => !(word.text.length <= 2 && (word.x0 < band || word.x1 > pageWidth - band)));
}

const boxArea = (word: OcrWord): number => (word.x1 - word.x0) * (word.y1 - word.y0);

/**
 * Words without any that overlap a bigger one by more than `DUPLICATE_OVERLAP` of the smaller box: one
 * word read twice, at two segmentations; the box that covers more ink (the surer when equal) is
 * the reading. The caller still erases the dropped ones.
 */
export function dropDuplicates(words: readonly OcrWord[]): OcrWord[] {
  const kept: OcrWord[] = [];
  for (const word of [...words].sort((a, b) => boxArea(b) - boxArea(a) || b.confidence - a.confidence)) {
    const area = boxArea(word);
    const twice = kept.some((other) => {
      const across = Math.min(word.x1, other.x1) - Math.max(word.x0, other.x0);
      const down = Math.min(word.y1, other.y1) - Math.max(word.y0, other.y0);
      return across > 0 && down > 0 && across * down > DUPLICATE_OVERLAP * Math.min(area, boxArea(other));
    });
    if (!twice) kept.push(word);
  }
  return words.filter((word) => kept.includes(word));
}

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

/** The words without the `misread` ones that lie over a picture region (an icon, a chart). */
export function dropMisreads(
  words: readonly OcrWord[],
  regions: readonly Box[],
  misread: ReadonlySet<OcrWord>,
): OcrWord[] {
  const within = regionIndex(regions);
  return words.filter((word) => !(misread.has(word) && within(word) >= 0));
}

/** One word's run attributes, before neighbouring words are merged. */
interface Token {
  readonly text: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly color: Rgb;
  readonly note: string | undefined;
  /** The word's box, page points from the left. */
  readonly x0: number;
  readonly x1: number;
}

const sameColour = (a: Rgb, b: Rgb): boolean =>
  Math.abs(a[0] - b[0]) <= SAME_COLOUR &&
  Math.abs(a[1] - b[1]) <= SAME_COLOUR &&
  Math.abs(a[2] - b[2]) <= SAME_COLOUR;

/** The advance (em) of a Unicode value in a stand-in family (Arial, Times New Roman, Courier New), `undefined` where unknown. */
export type Advance = (family: string, bold: boolean, italic: boolean, unicode: number) => number | undefined;

/** The stand-in families a scan's text is set in, sans first: it wins unless another is clearly closer. */
const FAMILIES = ['Arial', 'Times New Roman', 'Courier New'] as const;
/** A family replaces Arial when the spread of its word-width ratios is under this × Arial's. */
const SWITCH_SPREAD = 0.8;
/** Words (3 or more letters or digits) needed before the page's family is judged. */
const MIN_WORDS = 8;
/** Advance of a character the family has no glyph for, em. */
const FALLBACK_ADVANCE = 0.5;

const advanceOf = (advance: Advance, family: string, bold: boolean, italic: boolean, code: number): number =>
  advance(family, bold, italic, code) ?? FALLBACK_ADVANCE;

/**
 * The family the page's words are set in: for each stand-in, the ratio of every word's box width
 * to the width the family gives it at its line's size; the family whose ratios agree best (the
 * median distance from their median, in log) is the one — a typewriter's words are all
 * 0.6 em a letter, a serif's are not Arial's.
 */
function pickFamily(lines: readonly Line[], advance: Advance): string {
  let best: string = FAMILIES[0];
  let bestSpread = Infinity;
  for (const family of FAMILIES) {
    const logs: number[] = [];
    for (const line of lines) {
      for (const word of line.words) {
        if ((word.text.match(/[\p{L}\p{N}]/gu) ?? []).length < 3) continue;
        let em = 0;
        for (const char of word.text)
          em += advanceOf(advance, family, false, false, char.codePointAt(0) as number);
        logs.push(Math.log((word.x1 - word.x0) / (em * line.size)));
      }
    }
    if (logs.length < MIN_WORDS) return FAMILIES[0];
    const centre = median(logs);
    const spread = median(logs.map((value) => Math.abs(value - centre)));
    if (family === FAMILIES[0] || spread < SWITCH_SPREAD * bestSpread) {
      best = family;
      bestSpread = spread;
    }
  }
  return best;
}

/** What tesseract reads a bullet as, when it opens a line of more words: * + ° · */
const BULLET_LIKE = /^[*+°·]$/;

/** A line whose height-based size exceeds the one its word widths give by this factor has an inflated height (a speck joined the box). */
const INFLATED = 1.3;
/** …and is set at the width-based size × this. */
const INFLATED_KEEP = 1.1;

/**
 * The size of a line: its heights' (`line.size`), unless the words are much narrower than that
 * size lets `family` set them — a box that grew over a speck or an accent of the line below —
 * then a little over what the widths give.
 */
function sizeOf(line: Line, family: string, advance: Advance | undefined): number {
  if (advance === undefined) return line.size;
  const sizes: number[] = [];
  for (const word of line.words) {
    if ((word.text.match(/[\p{L}\p{N}]/gu) ?? []).length < 3) continue;
    let em = 0;
    for (const char of word.text)
      em += advanceOf(advance, family, false, false, char.codePointAt(0) as number);
    sizes.push((word.x1 - word.x0) / em);
  }
  if (sizes.length === 0) return line.size;
  const byWidth = median(sizes);
  return line.size > INFLATED * byWidth ? INFLATED_KEEP * byWidth : line.size;
}

/** A word box this much narrower or wider than the word's natural width is not trusted (a misread, a box grown over a mark): its letters are set at the natural pitch from the box's left edge. */
const FIT_LOW = 0.75;
const FIT_HIGH = 1.35;

/** What a line whose letters the writer squeezes needs of its frame beyond its own width: the natural width of the text in the stand-in font, a little over (a frame narrower than that makes LibreOffice wrap, and the wrapped words are cut off). */
const SQUEEZE_MARGIN = 1.015;

/** The widest line's natural width in the stand-in family: the advances of its letters at the size of their run. */
function naturalWidth(lines: readonly TextLine[]): number {
  return Math.max(
    0,
    ...lines.map((line) =>
      line.runs.reduce(
        (sum, run) => sum + (run.fit?.advances.reduce((total, em) => total + em, 0) ?? 0) * run.size,
        0,
      ),
    ),
  );
}

/** One piece of a run's text: a word with the page positions of its box ends, or a space (`NaN`). */
interface Part {
  readonly text: string;
  readonly x0: number;
  readonly x1: number;
}

/** Where the scan has each character of a run: a word's letters spread over its box by their advances, spaces unplaced. */
function fitOf(
  parts: readonly Part[],
  family: string,
  bold: boolean,
  italic: boolean,
  size: number,
  advance: Advance,
): RunFit {
  const advances: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const part of parts) {
    const ems = [...part.text].map((char) =>
      advanceOf(advance, family, bold, italic, char.codePointAt(0) as number),
    );
    const total = ems.reduce((sum, em) => sum + em, 0);
    const natural = total * size;
    const width = part.x1 - part.x0;
    const span = width < FIT_LOW * natural || width > FIT_HIGH * natural ? natural : width;
    let seen = 0;
    for (const em of ems) {
      advances.push(em);
      starts.push(part.x0 + (span * seen) / total);
      seen += em;
      ends.push(part.x0 + (span * seen) / total);
    }
  }
  return { advances, starts, ends, hscale: 1 };
}

/** The runs of a line: neighbours with the same look are one run; a noted word stands alone. With `advance`, each run carries where the scan has its letters. */
function runsOf(
  tokens: readonly Token[],
  size: number,
  family: string,
  advance: Advance | undefined,
): TextRun[] {
  const metrics =
    advance !== undefined && advance(family, false, false, 97) !== undefined ? advance : undefined;
  const space: Part = { text: ' ', x0: Number.NaN, x1: Number.NaN };
  const runs: { run: TextRun; color: Rgb; parts: Part[] }[] = [];
  for (const [index, token] of tokens.entries()) {
    const last = runs[runs.length - 1];
    const word: Part = { text: token.text, x0: token.x0, x1: token.x1 };
    let text = token.text;
    let lead = false;
    if (index > 0 && last !== undefined) {
      // The space belongs to the run before, unless that run is a noted word.
      if (last.run.note === undefined) {
        last.run = { ...last.run, text: `${last.run.text} ` };
        last.parts.push(space);
      } else {
        text = ` ${text}`;
        lead = true;
      }
    }
    if (
      last !== undefined &&
      token.note === undefined &&
      last.run.note === undefined &&
      last.run.bold === token.bold &&
      last.run.italic === token.italic &&
      (last.run.underline === true) === token.underline &&
      sameColour(last.color, token.color)
    ) {
      last.run = { ...last.run, text: last.run.text + text };
      last.parts.push(word);
      continue;
    }
    runs.push({
      run: {
        text,
        font: family,
        size,
        bold: token.bold,
        italic: token.italic,
        ...(token.underline ? { underline: true as const } : {}),
        color: rgbNumber(token.color),
        link: null,
        ...(token.note === undefined ? {} : { note: token.note }),
      },
      color: token.color,
      parts: lead ? [space, word] : [word],
    });
  }
  return runs.map(({ run, parts }) =>
    metrics === undefined ? run : { ...run, fit: fitOf(parts, family, run.bold, run.italic, size, metrics) },
  );
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

const rightmost = (row: readonly Line[]): Line =>
  row.reduce((best, line) => (line.x1 > best.x1 ? line : best));
const leftmost = (row: readonly Line[]): Line =>
  row.reduce((best, line) => (line.x0 < best.x0 ? line : best));

/** A cell of figures: more digits than letters (an amount, a quantity, a percentage, a date). */
function amountLike(cell: Line): boolean {
  const text = cell.words.map((word) => word.text).join('');
  return (text.match(/\p{N}/gu)?.length ?? 0) > (text.match(/\p{L}/gu)?.length ?? 0);
}

/**
 * Whether the cells of a row stand under the cells of the row above, as a table's do (see
 * `tableRows`); `leading` is the distance from the lowest line above, which a wrapped cell
 * brings closer than the row's own baseline.
 */
function gridPair(above: readonly Line[], below: readonly Line[], leading: number): boolean {
  const size = Math.max(...above.map((line) => line.size), ...below.map((line) => line.size));
  const cells = Math.min(above.length, below.length);
  const need = cells >= TABLE_CELLS ? TABLE_CELLS : 2;
  const reachDown = cells >= TABLE_CELLS ? TABLE_MAX_LEADING : MAX_LEADING;
  if (leading > reachDown * size || cells < need) return false;
  const reach = ALIGN * size;
  const sameColumn = (over: Line, cell: Line) =>
    over.region === cell.region &&
    (Math.abs(over.x0 - cell.x0) <= reach ||
      Math.abs(over.x1 - cell.x1) <= reach ||
      Math.abs((over.x0 + over.x1) / 2 - (cell.x0 + cell.x1) / 2) <= reach);
  // A table has a column of figures; side-by-side blocks of short lines (skill lists, label blocks) are columns. Two cells need it in the left-most or in the right-most cell of both rows; more cells, a figure under a figure.
  const edge = (pick: (row: readonly Line[]) => Line) => amountLike(pick(above)) && amountLike(pick(below));
  const figures =
    need === 2
      ? edge(rightmost) || edge(leftmost)
      : below.some(
          (cell) => amountLike(cell) && above.some((over) => amountLike(over) && sameColumn(over, cell)),
        );
  if (!figures) return false;
  const stands = (cell: Line) => above.some((over) => sameColumn(over, cell));
  const words = [...above, ...below].reduce((sum, cell) => sum + cell.words.length, 0);
  return below.filter(stands).length >= need && words <= TABLE_CELL_WORDS * (above.length + below.length);
}

/**
 * The tables of a page, as the lines that are their cells: rows are lines on one baseline (two
 * or more), and consecutive rows whose cells stand under each other (`gridPair`) are one table.
 * A line alone on its baseline keeps the table open only as the second line of a wrapped cell
 * (it continues a cell of the row above, or such a line, as `continues` has it); any other line — a
 * sub-heading — ends it.
 * A column of single-line cells (an invoice's descriptions) looks like a paragraph of short
 * lines to `groupParagraphs`; this is what tells it apart.
 */
function tableRows(lines: readonly Line[]): Line[][] {
  const rows: Line[][] = [];
  for (const line of [...lines].sort((a, b) => a.baseline - b.baseline)) {
    const row = rows.find(
      (cells) => Math.abs((cells[0] as Line).baseline - line.baseline) <= ROW_BAND * line.size,
    );
    if (row === undefined) rows.push([line]);
    else row.push(line);
  }
  const tables: Line[][] = [];
  let open = false;
  let above: Line[] | undefined;
  /** The cells of the last row and the lines that wrapped under them. */
  let refs: Line[] = [];
  let lowest = -Infinity;
  for (const row of rows) {
    const baseline = (row[0] as Line).baseline;
    if (row.length > 1) {
      if (above !== undefined && gridPair(above, row, baseline - lowest)) {
        if (!open) tables.push([...above]);
        (tables[tables.length - 1] as Line[]).push(...row);
        open = true;
      } else {
        open = false;
      }
      above = row;
      refs = [...row];
    } else {
      const line = row[0] as Line;
      const wraps =
        baseline - lowest <= MAX_LEADING * line.size && refs.some((cell) => continues(cell, line));
      if (wraps) refs.push(line);
      else {
        open = false;
        above = undefined;
        refs = [];
      }
    }
    lowest = baseline;
  }
  return tables;
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

/** Lines, top to bottom, into paragraphs: each line joins the nearest paragraph above it that it continues; a cell of a table starts its own. */
function groupParagraphs(lines: readonly Line[], cells: ReadonlySet<Line>): Line[][] {
  const paragraphs: Line[][] = [];
  for (const line of [...lines].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)) {
    let best: Line[] | undefined;
    let nearest = Infinity;
    for (const paragraph of paragraphs) {
      const last = paragraph[paragraph.length - 1] as Line;
      const leading = line.baseline - last.baseline;
      if (leading < nearest && !cells.has(line) && continues(last, line)) {
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

/** Whether the items before and after `at` stand side by side (their vertical extents overlap by a third of the shorter one): columns, not a heading beside a block below it. */
function sideBySide<T>(sorted: readonly T[], at: number, boxOf: (item: T) => Box): boolean {
  const extent = (items: readonly T[]): [number, number] => [
    Math.min(...items.map((item) => boxOf(item)[1])),
    Math.max(...items.map((item) => boxOf(item)[3])),
  ];
  const [top0, bottom0] = extent(sorted.slice(0, at));
  const [top1, bottom1] = extent(sorted.slice(at));
  const overlap = Math.min(bottom0, bottom1) - Math.max(top0, top1);
  return overlap >= COLUMN_OVERLAP * Math.min(bottom0 - top0, bottom1 - top1);
}

/** Whether paragraphs of more than one line stand on both sides of the vertical cut: columns of text, not a column of numbers or labels beside a text. */
function textColumns<T>(cut: { sorted: T[]; at: number }, linesOf: (item: T) => number): boolean {
  return (
    cut.sorted.slice(0, cut.at).some((item) => linesOf(item) > 1) &&
    cut.sorted.slice(cut.at).some((item) => linesOf(item) > 1)
  );
}

/**
 * Reading order by recursive cuts: items are split at the widest gap that no box crosses on
 * each axis; a vertical gap (columns, left part first) wins only when it is wider than the
 * horizontal one divided by `ROW_PREFERENCE` — a column gutter outweighs the space between a
 * heading and its list, so a sidebar is read before the main column, but a grid of cards is read
 * row by row — and what no gap divides is read in rows.
 */
function readingOrder<T>(
  items: readonly T[],
  boxOf: (item: T) => Box,
  size: number,
  linesOf: (item: T) => number,
): T[] {
  if (items.length < 2) return [...items];
  const cuts: ({ sorted: T[]; at: number; gap: number } | undefined)[] = [undefined, undefined];
  for (const axis of [1, 0] as const) {
    const sorted = [...items].sort((a, b) => boxOf(a)[axis] - boxOf(b)[axis]);
    let end = boxOf(sorted[0] as T)[axis + 2] as number;
    for (let at = 1; at < sorted.length; at += 1) {
      const box = boxOf(sorted[at] as T);
      const gap = (box[axis] as number) - end;
      const best = cuts[axis];
      if (
        gap > 0 &&
        (best === undefined || gap > best.gap) &&
        (axis === 1 || sideBySide(sorted, at, boxOf))
      ) {
        cuts[axis] = { sorted, at, gap };
      }
      end = Math.max(end, box[axis + 2] as number);
    }
  }
  const [columns, rows] = cuts;
  const cut =
    rows !== undefined &&
    (columns === undefined ||
      (rows.gap >= ROW_PREFERENCE * columns.gap &&
        (rows.gap >= ROW_MIN_GAP * size || columns.gap < GUTTER * size || !textColumns(columns, linesOf))))
      ? rows
      : columns;
  if (cut !== undefined) {
    return [
      ...readingOrder(cut.sorted.slice(0, cut.at), boxOf, size, linesOf),
      ...readingOrder(cut.sorted.slice(cut.at), boxOf, size, linesOf),
    ];
  }
  return inRows(items, boxOf);
}

/** Items no gap divides: top to bottom in rows (an item joins a row when it overlaps a member by half of the smaller height), each row left to right. */
function inRows<T>(items: readonly T[], boxOf: (item: T) => Box): T[] {
  const rows: T[][] = [];
  for (const item of [...items].sort((a, b) => boxOf(a)[1] - boxOf(b)[1] || boxOf(a)[0] - boxOf(b)[0])) {
    const box = boxOf(item);
    const row = rows.find((members) =>
      members.some((member) => {
        const other = boxOf(member);
        const overlap = Math.min(box[3], other[3]) - Math.max(box[1], other[1]);
        return overlap >= 0.5 * Math.min(box[3] - box[1], other[3] - other[1]);
      }),
    );
    if (row === undefined) rows.push([item]);
    else row.push(item);
  }
  return rows.flatMap((row) => row.sort((a, b) => boxOf(a)[0] - boxOf(b)[0]));
}

/** A word as the page sets it: its box (page points, y down), the size, weight and slant of its run, and how sure OCR was (0–100). */
export interface MeasuredWord {
  readonly text: string;
  readonly box: Box;
  readonly size: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly confidence: number;
}

/** A word that has other readings (`OcrWord.alternatives`), with the size it was set at. */
export interface UnsettledWord {
  readonly word: OcrWord;
  readonly size: number;
}

/**
 * The text boxes of a recognised page: one per paragraph, in reading order. `regions` are the
 * boxes of the solid regions `ocrBackground` found (cards, bands, photos; not loose marks): lines and paragraphs never cross their edge.
 * `flagged` lists the words with a letter or digit whose confidence is below `lowConfidence`;
 * each is a run of its own with a `note`. With `advance` the page is set in the stand-in family
 * whose letter widths fit the word boxes best (`font` names one instead) and every run carries
 * where the scan has its letters, so the writer places each word where the scan has it.
 * `measured` lists the words as they were set, for whoever judges the typeface; `family` is the
 * one they were set in and `unsettled` the words that have other readings, for whoever judges those.
 */
export function ocrTextBoxes(
  words: readonly OcrWord[],
  image: RgbaImage,
  lowConfidence: number,
  regions: readonly Box[] = [],
  advance?: Advance,
  font?: string,
  rules: readonly Rule[] = [],
): {
  boxes: TextBox[];
  flagged: { text: string; confidence: number }[];
  measured: MeasuredWord[];
  family: string;
  unsettled: UnsettledWord[];
} {
  const flagged: { text: string; confidence: number }[] = [];
  const measured: MeasuredWord[] = [];
  const unsettled: UnsettledWord[] = [];
  const inks = new Map<OcrWord, WordInk>();
  const lines = groupLines(words, regionIndex(regions));
  const typical = lines.length === 0 ? 0 : median(lines.map((line) => line.size));
  const tables = tableRows(lines);
  const cells = new Set(tables.flat());
  const grouped = groupParagraphs(lines, cells);
  // A table is one item of the reading order, read row by row inside; paragraphs are items of their own.
  const units: Line[][][] = grouped
    .filter((paragraph) => !cells.has(paragraph[0] as Line))
    .map((paragraph) => [paragraph]);
  for (const table of tables) {
    const own = grouped.filter((paragraph) => table.includes(paragraph[0] as Line));
    units.push(inRows(own, boundsOf));
  }
  const paragraphs = readingOrder(
    units,
    (unit) => boundsOf(unit.flat()),
    typical,
    (unit) => (unit.length === 1 ? (unit[0] as Line[]).length : 1),
  ).flat();
  const lineStroke = new Map<Line, number>();
  const sizes = new Map<Line, number>();
  const slants = new Map<Line, boolean>();
  const family = font ?? (advance === undefined ? FAMILIES[0] : pickFamily(paragraphs.flat(), advance));

  for (const lines of paragraphs) {
    const upper = quantile(
      lines.map((line) => sizeOf(line, family, advance)),
      0.75,
    );
    for (const line of lines) {
      const own = sizeOf(line, family, advance);
      const size = own >= SIZE_SNAP_LOW * upper && own <= SIZE_SNAP_HIGH * upper ? upper : own;
      const rounded = Math.max(1, Math.round(size * 2) / 2);
      sizes.set(line, rounded);
      const runs = new Int32Array(MAX_RUN + 1);
      const sharp = new Float64Array(SHEARS.length);
      for (const word of line.words) {
        const ink = measureWord(image, word);
        inks.set(word, ink);
        for (const [index, value] of ink.sharpness.entries()) sharp[index] = (sharp[index] ?? 0) + value;
        for (let length = 1; length <= MAX_RUN; length += 1)
          runs[length] = (runs[length] ?? 0) + (ink.runs[length] ?? 0);
      }
      lineStroke.set(line, strokeRun(runs) / (rounded * image.scale));
      slants.set(line, leans(sharp));
    }
  }
  const pageStroke = median([...lineStroke.values()]);

  const boxes: TextBox[] = [];
  for (const lines of paragraphs) {
    const textLines: TextLine[] = [];
    const baselines: number[] = [];
    for (const line of lines) {
      const size = sizes.get(line) as number;
      const lineBold = pageStroke > 0 && (lineStroke.get(line) as number) >= BOLD_RATIO * pageStroke;
      const own = line.words.map((word): boolean | undefined => {
        const { runs } = inks.get(word) as WordInk;
        let evidence = 0;
        for (const count of runs) evidence += count;
        return evidence < BOLD_EVIDENCE
          ? undefined
          : strokeRun(runs) / (size * image.scale) >= BOLD_WORD * pageStroke;
      });
      const italic = slants.get(line) as boolean;
      const tokens = line.words.map((word, at): Token => {
        const bold =
          own[at] === true ||
          (own[at] === undefined && (lineBold || (own[at - 1] === true && own[at + 1] === true)));
        const low = word.confidence / 100 < lowConfidence && !SYMBOLIC.test(word.text);
        if (low) flagged.push({ text: word.text, confidence: word.confidence / 100 });
        measured.push({
          text: word.text,
          box: [word.x0, word.y0, word.x1, word.y1],
          size,
          bold,
          italic,
          confidence: word.confidence,
        });
        if (word.alternatives !== undefined) unsettled.push({ word, size });
        return {
          text: at === 0 && line.words.length > 1 && BULLET_LIKE.test(word.text) ? '\u2022' : word.text,
          bold,
          italic,
          underline: rules.some((rule) => underlines(rule, word)),
          color: (inks.get(word) as WordInk).color,
          note: low ? `Low OCR confidence (${Math.round(word.confidence)} %)` : undefined,
          x0: word.x0,
          x1: word.x1,
        };
      });
      baselines.push(line.baseline);
      textLines.push({ runs: runsOf(tokens, size, family, advance) });
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
    const width = Math.max(
      (right - left) * WIDTH_FACTOR + WIDTH_PAD,
      SQUEEZE_MARGIN * naturalWidth(textLines),
    );
    const x0 = centred ? centre - width / 2 : left;
    // Every line says where the box would start for its own baseline at the pitch the lines are set
    // at (the line height, which is the scan's only when it is no tighter than the size); the middle
    // of them stands, so one line whose baseline is off (a heading, a speck) does not carry the box.
    const top =
      median(baselines.map((baseline, at) => baseline - at * lineHeight)) - BASELINE_IN_LINE * lineHeight;
    const bottom = Math.max(top + lineHeight * lines.length, ...lines.map((line) => line.y1));
    const paragraph: TextParagraph = {
      align: centred ? 'center' : 'left',
      lineHeight,
      lines: textLines,
    };
    boxes.push({ box: [x0, top, x0 + width, bottom], rotation: 0, paragraphs: [paragraph] });
  }
  return { boxes, flagged, measured, family, unsettled };
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
 *
 * With `turn`, `image` is the upright copy of a crooked scan and `words` are its: the page
 * colour, the regions and their `box` are found on the copy (the frame the words and the text
 * boxes are in), but the words are erased from `turn.scan` itself, each fill painted where the
 * scan has it (`paintTurned`), and the pictures are cut from it: `placed` is the box of the
 * scan that holds a region (the region's own box, when the page is not turned).
 */
export function ocrBackground(
  image: RgbaImage,
  words: readonly OcrWord[],
  turn?: { readonly scan: RgbaImage; readonly angle: number },
): { pageColor: number; regions: { box: Box; placed: Box; rgba: RgbaImage; solid: boolean }[] } {
  const { width, height, scale } = image;
  const data = new Uint8Array(image.data);
  const fills: Fill[] = [];

  for (const word of words) {
    const h = word.y1 - word.y0;
    const pad = ERASE_PAD * h;
    // A mark above (İ Ö Ü Ğ) or a cedilla below (Ç Ş) can lie outside the box tesseract gave the letters.
    const above = MARKED_ABOVE.test(word.text) ? MARK_PAD * h : pad;
    const below = CEDILLA.test(word.text) ? MARK_PAD * h : pad;
    const box = pixelBox(image, word.x0 - pad, word.y0 - above, word.x1 + pad, word.y1 + below);
    const [r, g, b] = ringMedian(data, width, height, box, RING);
    const fill: Fill = { box: growOverRipples(data, width, height, scale, box, [r, g, b]), color: [r, g, b] };
    paint(data, width, fill);
    fills.push(fill);
  }
  // The pixels the pictures are cut from: the page itself, or the scan with the same fills.
  let cut = data;
  if (turn !== undefined) {
    cut = new Uint8Array(turn.scan.data);
    paintTurned(cut, image, fills, turn.angle);
  }

  const page = commonColor(data);
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = distance(data, index * 4, page) > DIFFERENCE ? 1 : 0;
  }
  const grown = dilate(mask, width, height, Math.max(1, Math.round(MERGE_GAP * scale)));

  const regions: { box: Box; placed: Box; rgba: RgbaImage; solid: boolean }[] = [];
  const stack = new Int32Array(width * height);
  for (let start = 0; start < grown.length; start += 1) {
    if (grown[start] === 0) continue;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let top = 0;
    let inked = 0;
    stack[top++] = start;
    grown[start] = 0;
    while (top > 0) {
      const at = stack[--top] as number;
      const x = at % width;
      const y = (at - x) / width;
      if (mask[at] === 1) {
        inked += 1;
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
    const [px0, py0, px1, py1] =
      turn === undefined ? [x0, y0, x1, y1] : scanBox(image, [x0, y0, x1, y1], turn.angle);
    const cropWidth = px1 - px0;
    const crop = new Uint8Array(cropWidth * (py1 - py0) * 4);
    for (let y = py0; y < py1; y += 1) {
      const from = (y * width + px0) * 4;
      crop.set(cut.subarray(from, from + cropWidth * 4), (y - py0) * cropWidth * 4);
    }
    regions.push({
      box: [x0 / scale, y0 / scale, x1 / scale, y1 / scale],
      placed: [px0 / scale, py0 / scale, px1 / scale, py1 / scale],
      rgba: { width: cropWidth, height: py1 - py0, data: crop, scale },
      solid: inked >= SOLID_FILL * (maxX - minX + 1) * (maxY - minY + 1),
    });
  }
  return { pageColor: rgbNumber(page), regions };
}
