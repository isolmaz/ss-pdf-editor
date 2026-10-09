/**
 * What the "exact layout" writer needs to read a page that is partly real text and partly a
 * scan, and to judge an invisible text layer before it is trusted (`docx-layout-ocr.ts`).
 *
 *  - A mixed page shows text a reader can select (a typed header, a stamp, page numbers) over
 *    pictures that cover most of the page and hold ink of their own: the scan's words. The
 *    visible text is kept as Word text; its boxes are painted over with the colour around them
 *    in the render OCR reads, so the recogniser sees only what is left, and the words it still
 *    finds on top of a masked box are dropped.
 *  - An invisible text layer is trusted only when few of its characters are low-fidelity: the
 *    replacement character (no Unicode behind the glyph) or a line turned away from the page's
 *    dominant direction. A layer that fails is read again with OCR.
 */

import type { OcrWord } from '../engines/tesseract';
import type { PageScene, SceneImage } from './layout-scene';
import type { RgbaImage } from './ocr-scene';
import type { Box, LayoutChar } from './page-layout';

/** The pictures cover at least this much of the page for it to be a scan. */
const SCAN_COVER = 0.5;
/** A layer is trusted when its low-fidelity characters are a smaller share than this. */
const TRUST_RATIO = 0.1;
/** A line this far (radians, ~3°) from the dominant direction is turned: scans' own layers skew a little per line. */
const TURNED = 0.05;
/** Visible characters further apart than this many font sizes are separate boxes. */
const BOX_GAP = 2;
/** A line whose direction has this much of its length along an axis is upright (turned text is boxed by character). */
const UPRIGHT = 0.99;
/** The ring the fill colour is sampled from lies this far (pixels) outside the padded box. */
const RING = 2;
/** Pictures hold ink of their own when this share of their pixels differs from their background … */
const MIN_INK = 0.003;
/** … and are a photograph, not a scan, when more than this share does. */
const MAX_INK: number = 0.3;
/** A pixel is ink when its luminance is this far from the picture's background. */
const INK_CONTRAST = 64;
/** A word's box is grown by this share of its height to take in the antialiased edges of its glyphs. */
const WORD_PAD = 0.2;
/** A box is flat when its pixels are within this much of their commonest tone (faint scanned text is 50 or more off paper) … */
const FLAT = 16;
/** … and a word is under a patch when less than this share of its box is not flat. */
const COVERED_SHARE = 0.005;
/** Rows (of the sampled grid) of blank space that end a band. */
const MIN_GAP = 3;
/** A picture of text has ink in at least this many bands of rows. */
const MIN_BANDS = 3;
/** A picture is searched for text when it covers at least this share of the page … */
const MIN_PICTURE = 0.02;
/**
 * … and its words stand when a picture of text is what it is, which these floors say, set from
 * what OCR made of pictures of each kind (words / lines / mean confidence / share of the ink
 * under the words): a scanned letter 77 / 12 / 96 / 1.0, a price table 14 / 5 / 93 / 0.25, a
 * rastered form 94 / 17 / 94 / 0.20, a diagram 84 / 23 / 76 / 0.18 and a chart 70 / 24 / 87 /
 * 0.14 with its axis labels, a logo 4 / 3 / 83 / 1.0.
 */
const MIN_PICTURE_WORDS = 8;
const MIN_PICTURE_LINES = 2;
const PICTURE_CONFIDENCE = 80;
const MIN_TEXT_INK = 0.15;
/** A masked box drops the OCR words overlapping it by more than this share of the word. */
const MASKED_SHARE = 0.5;
/** An unsure word this close to a masked box (pixels) is a sliver of a glyph the mask cut. */
const EDGE_PIXELS = 3;
const SLIVER_CONFIDENCE = 30;

export const isVisible = (char: { readonly c: string; readonly invisible?: true }): boolean =>
  char.invisible !== true && char.c.trim() !== '';

/** The text lines of the scene (it reads the page's text without pictures, so its blocks are text). */
const linesOf = (scene: PageScene) =>
  scene.text.blocks
    .filter((block): block is Extract<typeof block, { kind: 'text' }> => block.kind === 'text')
    .flatMap((block) => block.lines);

const hasVisibleText = (scene: PageScene): boolean =>
  linesOf(scene).some((line) => line.chars.some(isVisible));

/** The boxes of the page's pictures (`SceneImage`, `SceneRaster`). */
export const pictureBoxes = (scene: PageScene): Box[] =>
  scene.items.flatMap((item) => (item.kind === 'shape' ? [] : [item.box]));

/** Whether pictures covering `area` (square points) make a page of `width` × `height` a scan. */
export function coversPage(area: number, width: number, height: number): boolean {
  return area >= SCAN_COVER * width * height;
}

/** Whether the pictures cover at least half the page. */
function picturesCover(scene: PageScene): boolean {
  let covered = 0;
  for (const box of pictureBoxes(scene))
    covered += Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
  return coversPage(covered, scene.width, scene.height);
}

/** Whether the page shows no text and is mostly pictures: a scan, with or without an invisible text layer. */
export const isScanPage = (scene: PageScene): boolean => !hasVisibleText(scene) && picturesCover(scene);

/** Whether the page shows text and is mostly pictures: a scan with real text on it, or a picture the text lies over. */
export const isMixedPage = (scene: PageScene): boolean => hasVisibleText(scene) && picturesCover(scene);

/** The boxes of the visible text: a run of an upright line, a single character of anything turned (a diagonal watermark's box would cover the page). */
export function visibleBoxes(scene: PageScene): Box[] {
  const boxes: Box[] = [];
  for (const line of linesOf(scene)) {
    const shown = line.chars.filter(isVisible);
    const [dx, dy] = line.dir;
    const across = Math.abs(dx) > UPRIGHT && Math.abs(dy) < 1 - UPRIGHT;
    const along = Math.abs(dy) > UPRIGHT && Math.abs(dx) < 1 - UPRIGHT;
    if (!across && !along) {
      boxes.push(...shown.map((char): Box => [...char.box]));
      continue;
    }
    // Along the line: x for text across the page, y for text up or down it.
    const [low, high] = across ? ([0, 2] as const) : ([1, 3] as const);
    shown.sort((first, second) => first.box[low] - second.box[low]);
    let current: Box | null = null;
    let last: LayoutChar | null = null;
    for (const char of shown) {
      if (
        current !== null &&
        last !== null &&
        char.box[low] - last.box[high] <= BOX_GAP * Math.max(last.size, char.size)
      ) {
        current = [
          Math.min(current[0], char.box[0]),
          Math.min(current[1], char.box[1]),
          Math.max(current[2], char.box[2]),
          Math.max(current[3], char.box[3]),
        ];
      } else {
        if (current !== null) boxes.push(current);
        current = [...char.box];
      }
      last = char;
    }
    if (current !== null) boxes.push(current);
  }
  return boxes;
}

/** The pixels of `box` (page points) in `image`, padded by `pad` pixels and clamped to the image: `[x0, y0, x1, y1)`. */
function pixelsOf(image: RgbaImage, box: Box, pad: number): [number, number, number, number] {
  return [
    Math.max(0, Math.floor(box[0] * image.scale) - pad),
    Math.max(0, Math.floor(box[1] * image.scale) - pad),
    Math.min(image.width, Math.ceil(box[2] * image.scale) + pad),
    Math.min(image.height, Math.ceil(box[3] * image.scale) + pad),
  ];
}

/** The median of each colour channel over the ring of pixels around a padded rectangle; white when it lies off the image. */
function ringColour(image: RgbaImage, [x0, y0, x1, y1]: readonly [number, number, number, number]): number[] {
  const samples: number[][] = [[], [], []];
  const take = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const at = (y * image.width + x) * 4;
    for (let channel = 0; channel < 3; channel += 1)
      (samples[channel] as number[]).push(image.data[at + channel] as number);
  };
  for (let x = x0 - RING; x < x1 + RING; x += 1) {
    take(x, y0 - RING);
    take(x, y1 + RING - 1);
  }
  for (let y = y0 - RING; y < y1 + RING; y += 1) {
    take(x0 - RING, y);
    take(x1 + RING - 1, y);
  }
  return samples.map((values) =>
    values.length === 0 ? 255 : (values.sort((a, b) => a - b)[values.length >> 1] as number),
  );
}

/**
 * The page with each of `boxes` painted over with the colour around it (the median of a ring
 * just outside, so a box on a grey or a tinted scan does not leave a white hole the recogniser
 * reads edges into). With no boxes it is the same image, not a copy.
 */
export function maskBoxes(image: RgbaImage, boxes: readonly Box[]): RgbaImage {
  if (boxes.length === 0) return image;
  const data = image.data.slice();
  for (const box of boxes) {
    const rectangle = pixelsOf(image, box, 1);
    const [x0, y0, x1, y1] = rectangle;
    const colour = ringColour({ ...image, data }, rectangle);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * image.width + x) * 4;
        data[at] = colour[0] as number;
        data[at + 1] = colour[1] as number;
        data[at + 2] = colour[2] as number;
      }
    }
  }
  return { ...image, data };
}

/**
 * The boxes (page points) of `boxes` that hold ink of their own in `image` (the page with the
 * visible text masked): some of their pixels, but not most, differ from the box's background.
 * Nothing left is a picture the text lies over; most of it is a photograph.
 */
export function inkBoxes(image: RgbaImage, boxes: readonly Box[]): Box[] {
  return boxes.filter((box) => {
    const [x0, y0, x1, y1] = pixelsOf(image, box, 0);
    const luminance: number[] = [];
    const bins = new Array<number>(16).fill(0);
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        const at = (y * image.width + x) * 4;
        const value =
          0.299 * (image.data[at] as number) +
          0.587 * (image.data[at + 1] as number) +
          0.114 * (image.data[at + 2] as number);
        luminance.push(value);
        const bin = Math.min(15, value >> 4);
        bins[bin] = (bins[bin] as number) + 1;
      }
    }
    if (luminance.length === 0) return false;
    const background = (bins.indexOf(Math.max(...bins)) + 0.5) * 16;
    const ink = luminance.filter((value) => Math.abs(value - background) > INK_CONTRAST).length;
    return ink / luminance.length >= MIN_INK && ink / luminance.length <= MAX_INK;
  });
}

/** What tells a picture of text from a logo, a chart or a photograph that has a few words in it. */
export interface PictureStats {
  readonly words: number;
  /** Mean confidence of the words, 0–100. */
  readonly confidence: number;
  /** Distinct text lines the words are on. */
  readonly lines: number;
  /** The share of the picture's ink that lies under the words' boxes. */
  readonly inkInWords: number;
  /** The share of the picture that is its commonest tone: paper, or a flat panel. */
  readonly paper: number;
}

/** The statistics of `words` (those in `box`) over the picture's pixels in `image`. */
export function pictureStats(image: RgbaImage, box: Box, words: readonly OcrWord[]): PictureStats {
  const [x0, y0, x1, y1] = pixelsOf(image, box, 0);
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const luminance = new Float32Array(width * height);
  const bins = new Array<number>(16).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = ((y0 + y) * image.width + x0 + x) * 4;
      const value =
        0.299 * (image.data[at] as number) +
        0.587 * (image.data[at + 1] as number) +
        0.114 * (image.data[at + 2] as number);
      luminance[y * width + x] = value;
      const bin = Math.min(15, value >> 4);
      bins[bin] = (bins[bin] as number) + 1;
    }
  }
  const common = Math.max(...bins);
  const background = (bins.indexOf(common) + 0.5) * 16;
  const covered = new Uint8Array(width * height);
  for (const word of words) {
    const pad = WORD_PAD * (word.y1 - word.y0);
    const [wx0, wy0, wx1, wy1] = pixelsOf(
      image,
      [word.x0 - pad, word.y0 - pad, word.x1 + pad, word.y1 + pad],
      0,
    );
    for (let y = Math.max(y0, wy0); y < Math.min(y1, wy1); y += 1) {
      for (let x = Math.max(x0, wx0); x < Math.min(x1, wx1); x += 1) covered[(y - y0) * width + x - x0] = 1;
    }
  }
  let ink = 0;
  let under = 0;
  for (let at = 0; at < luminance.length; at += 1) {
    if (Math.abs((luminance[at] as number) - background) <= INK_CONTRAST) continue;
    ink += 1;
    under += covered[at] as number;
  }
  return {
    words: words.length,
    confidence: words.reduce((sum, word) => sum + word.confidence, 0) / Math.max(1, words.length),
    lines: new Set(words.map((word) => word.line)).size,
    inkInWords: ink === 0 ? 0 : under / ink,
    paper: luminance.length === 0 ? 0 : common / luminance.length,
  };
}

/** The pictures of a page big enough to hold text a reader would want: at least 2 % of the page. */
export function textPictures(scene: PageScene): SceneImage[] {
  return scene.items.filter(
    (item): item is SceneImage =>
      item.kind === 'image' &&
      (item.box[2] - item.box[0]) * (item.box[3] - item.box[1]) >= MIN_PICTURE * scene.width * scene.height,
  );
}

/** The words whose centre lies in `box`. */
export const wordsIn = (words: readonly OcrWord[], box: Box): OcrWord[] =>
  words.filter(
    (word) =>
      (word.x0 + word.x1) / 2 >= box[0] &&
      (word.x0 + word.x1) / 2 <= box[2] &&
      (word.y0 + word.y1) / 2 >= box[1] &&
      (word.y0 + word.y1) / 2 <= box[3],
  );

/**
 * The words in `box` when the picture is one of text (`pictureStats` says so): enough surely
 * read words that cover most of its ink. A few words are what OCR makes of a logo, a chart's
 * labels or a sign in a photograph, and those pictures stay pictures.
 */
export function wordsInPicture(image: RgbaImage, words: readonly OcrWord[], box: Box): OcrWord[] {
  const inside = wordsIn(words, box);
  const stats = pictureStats(image, box, inside);
  const text =
    stats.words >= MIN_PICTURE_WORDS &&
    stats.lines >= MIN_PICTURE_LINES &&
    stats.confidence >= PICTURE_CONFIDENCE &&
    stats.inkInWords >= MIN_TEXT_INK;
  return text ? inside : [];
}

/** The share of the pixels of `box` (page points) in `image` that differ from the box's own commonest tone by more than `FLAT`; `null` for a box off the image. */
function nonFlatShare(image: RgbaImage, box: Box): number | null {
  const [x0, y0, x1, y1] = pixelsOf(image, box, 0);
  const bins = new Array<number>(256).fill(0);
  const tones: number[] = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * image.width + x) * 4;
      const tone =
        0.299 * (image.data[at] as number) +
        0.587 * (image.data[at + 1] as number) +
        0.114 * (image.data[at + 2] as number);
      tones.push(tone);
      const bin = Math.round(tone);
      bins[bin] = (bins[bin] as number) + 1;
    }
  }
  if (tones.length === 0) return null;
  const background = bins.indexOf(Math.max(...bins));
  return tones.filter((tone) => Math.abs(tone - background) > FLAT).length / tones.length;
}

/**
 * The words of a text layer that show something in the render: a word whose box is flat (no mark
 * of any contrast, however faint the print) lies under a patch (an opaque annotation, a picture drawn over the scan) and is what
 * the reader cannot see, so it is not text of the page.
 */
export const dropCovered = (words: readonly OcrWord[], image: RgbaImage): OcrWord[] =>
  words.filter((word) => (nonFlatShare(image, [word.x0, word.y0, word.x1, word.y1]) ?? 1) >= COVERED_SHARE);

/**
 * Whether a picture, from its own pixels (composited over white; `image.scale` is not read), may
 * hold a page of text: a tenth of a percent to a third of it is ink, and the ink falls in at
 * least three bands of rows with at least a few blank rows between. A logo or a letterhead is one or two bands, a
 * photograph is ink everywhere; neither is worth rendering the page and reading it for.
 */
export function pictureLooksLikeText(image: RgbaImage): boolean {
  const step = Math.max(1, Math.floor(Math.max(image.width, image.height) / 400));
  const columns = Math.ceil(image.width / step);
  const rows = Math.ceil(image.height / step);
  const tones = new Float32Array(columns * rows);
  const bins = new Array<number>(16).fill(0);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const at = (row * step * image.width + column * step) * 4;
      const white = 255 - (image.data[at + 3] as number);
      const tone =
        0.299 * ((image.data[at] as number) + white) +
        0.587 * ((image.data[at + 1] as number) + white) +
        0.114 * ((image.data[at + 2] as number) + white);
      tones[row * columns + column] = tone;
      const bin = Math.min(15, tone >> 4);
      bins[bin] = (bins[bin] as number) + 1;
    }
  }
  const background = (bins.indexOf(Math.max(...bins)) + 0.5) * 16;
  let ink = 0;
  let bands = 0;
  let blank = MIN_GAP;
  for (let row = 0; row < rows; row += 1) {
    let inked = 0;
    for (let column = 0; column < columns; column += 1) {
      if (Math.abs((tones[row * columns + column] as number) - background) > INK_CONTRAST) inked += 1;
    }
    ink += inked;
    if (inked >= 2) {
      // a band starts after a blank stretch: the ascenders and the x-height of one line are one band
      if (blank >= MIN_GAP) bands += 1;
      blank = 0;
    } else {
      blank += 1;
    }
  }
  const share = ink / (columns * rows);
  return share >= MIN_INK && share <= MAX_INK && bands >= MIN_BANDS;
}

/**
 * The words that are not on a masked box: a word overlapping one by more than half its area is
 * the text the mask hid (or its edge), and an unsure word touching one is a sliver of a glyph.
 */
export function dropMasked(words: readonly OcrWord[], boxes: readonly Box[], scale: number): OcrWord[] {
  if (boxes.length === 0) return [...words];
  const reach = EDGE_PIXELS / scale;
  return words.filter((word) => {
    const area = Math.max(1e-6, (word.x1 - word.x0) * (word.y1 - word.y0));
    for (const box of boxes) {
      const across = Math.min(word.x1, box[2]) - Math.max(word.x0, box[0]);
      const down = Math.min(word.y1, box[3]) - Math.max(word.y0, box[1]);
      if (across > 0 && down > 0 && (across * down) / area > MASKED_SHARE) return false;
      if (word.confidence < SLIVER_CONFIDENCE && across > -reach && down > -reach) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Whether the page's invisible text layer can stand in for OCR: fewer than a tenth of its
 * characters are the replacement character or on a line turned away from the layer's dominant
 * direction. No layer at all passes (the caller sees there is nothing to read).
 */
export function layerTrusted(scene: PageScene): boolean {
  const lines = linesOf(scene)
    .map((line) => ({
      angle: Math.atan2(line.dir[1], line.dir[0]),
      chars: line.chars.filter((char) => char.invisible === true && char.c.trim() !== ''),
    }))
    .filter((line) => line.chars.length > 0);
  if (lines.length === 0) return true;
  const weight = new Map<number, { angle: number; chars: number }>();
  for (const line of lines) {
    const key = Math.round(line.angle / TURNED);
    const seen = weight.get(key);
    if (seen === undefined) weight.set(key, { angle: line.angle, chars: line.chars.length });
    else seen.chars += line.chars.length;
  }
  const dominant = [...weight.values()].sort((a, b) => b.chars - a.chars)[0] as { angle: number };
  let low = 0;
  let total = 0;
  for (const line of lines) {
    const gap = Math.abs(
      Math.atan2(Math.sin(line.angle - dominant.angle), Math.cos(line.angle - dominant.angle)),
    );
    for (const char of line.chars) {
      total += 1;
      if (gap > TURNED || char.c === '\uFFFD') low += 1;
    }
  }
  return low / total < TRUST_RATIO;
}
