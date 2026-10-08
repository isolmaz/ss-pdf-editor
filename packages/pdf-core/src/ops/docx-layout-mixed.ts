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
import type { PageScene } from './layout-scene';
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
/** The ring the fill colour is sampled from lies this far (pixels) outside the padded box. */
const RING = 2;
/** Pictures hold ink of their own when this share of their pixels differs from their background … */
const MIN_INK = 0.003;
/** … and are a photograph, not a scan, when more than this share does. */
const MAX_INK: number = 0.3;
/** A pixel is ink when its luminance is this far from the picture's background. */
const INK_CONTRAST = 64;
/** A masked box drops the OCR words overlapping it by more than this share of the word. */
const MASKED_SHARE = 0.5;
/** An unsure word this close to a masked box (pixels) is a sliver of a glyph the mask cut. */
const EDGE_PIXELS = 3;
const SLIVER_CONFIDENCE = 30;

export const isVisible = (char: { readonly c: string; readonly invisible?: true }): boolean =>
  char.invisible !== true && char.c.trim() !== '';

/** The text lines of the scene (it reads the page's text without pictures, so its blocks are text). */
const linesOf = (scene: PageScene) =>
  scene.text.blocks.flatMap((block) => (block.kind === 'text' ? block.lines : []));

const hasVisibleText = (scene: PageScene): boolean =>
  linesOf(scene).some((line) => line.chars.some(isVisible));

/** The boxes of the page's pictures (`SceneImage`, `SceneRaster`). */
const pictureBoxes = (scene: PageScene): Box[] =>
  scene.items.flatMap((item) => (item.kind === 'shape' ? [] : [item.box]));

/** Whether the pictures cover at least half the page. */
function picturesCover(scene: PageScene): boolean {
  let covered = 0;
  for (const box of pictureBoxes(scene))
    covered += Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
  return covered >= SCAN_COVER * scene.width * scene.height;
}

/** Whether the page shows no text and is mostly pictures: a scan, with or without an invisible text layer. */
export const isScanPage = (scene: PageScene): boolean => !hasVisibleText(scene) && picturesCover(scene);

/** Whether the page shows text and is mostly pictures: a scan with real text on it, or a picture the text lies over. */
export const isMixedPage = (scene: PageScene): boolean => hasVisibleText(scene) && picturesCover(scene);

/** The boxes of the visible text, one per run of characters of a line (page points, y down). */
export function visibleBoxes(scene: PageScene): Box[] {
  const boxes: Box[] = [];
  for (const line of linesOf(scene)) {
    const shown = line.chars.filter(isVisible).sort((a, b) => a.box[0] - b.box[0]);
    let current: Box | null = null;
    let last: LayoutChar | null = null;
    for (const char of shown) {
      if (
        current !== null &&
        last !== null &&
        char.box[0] - last.box[2] <= BOX_GAP * Math.max(last.size, char.size)
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
 * Whether the pictures of the page hold ink of their own in `image` (the page with the visible
 * text masked): some of their pixels, but not most, differ from the picture's background.
 * Nothing left is a picture the text lies over; most of it is a photograph.
 */
export function hasScanInk(image: RgbaImage, scene: PageScene): boolean {
  let ink = 0;
  let total = 0;
  for (const box of pictureBoxes(scene)) {
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
        bins[Math.min(15, value >> 4)] = (bins[Math.min(15, value >> 4)] as number) + 1;
      }
    }
    if (luminance.length === 0) continue;
    const background = (bins.indexOf(Math.max(...bins)) + 0.5) * 16;
    total += luminance.length;
    ink += luminance.filter((value) => Math.abs(value - background) > INK_CONTRAST).length;
  }
  return total > 0 && ink / total >= MIN_INK && ink / total <= MAX_INK;
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
