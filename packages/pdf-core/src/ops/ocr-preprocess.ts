/**
 * What the OCR engine is shown of a scanned page: a copy of the render turned upright when its
 * text lines are measurably skewed. A skewed sheet (a crooked scan) makes the recogniser cut
 * lines badly, and the table reader (`ocr-scene.ts`) groups rows by baseline, which a skew
 * breaks. The copy is turned about the page's centre on the same canvas; the words, the lines,
 * the paragraphs and the text boxes are all made in its frame, and then put back into the scan's
 * own (`rotateAbout`, `turnBoxes`): each text box is a frame turned by the skew angle (the
 * machinery of a slanted line, `docx-layout-text.ts`), the words are erased from the scan itself
 * (`ocrBackground`), so the page picture is the scan as it was and the export looks like it.
 *
 * The gate is a measurement (projection profile of the ink), so a page that is level is not
 * touched: `uprightScan` returns `null` and the render is read as it is. Levelling the
 * background, a median filter against speckle and a Sauvola retry were measured (A/B, one step at
 * a time) and did not read better, so they are not part of the chain.
 */

import type { TextBox } from './layout-scene';
import type { RgbaImage } from './ocr-scene';

export interface Grey {
  readonly width: number;
  readonly height: number;
  /** `width × height` bytes, row-major, 0 black … 255 white. */
  readonly data: Uint8Array;
}

/** Skew search: degrees, coarse then fine step, the window searched. */
const SKEW_RANGE = 6;
const SKEW_COARSE = 0.5;
const SKEW_FINE = 0.05;
/** The turn applied: between these (degrees), if the peak stands this far above the mean score. */
const SKEW_MIN = 0.3;
const SKEW_MAX = 5.9;
const SKEW_CONFIDENCE = 2.5;
const SKEW_LONG_SIDE = 1100;
const SKEW_POINTS = 60000;
const SKEW_MARGIN = 0.03;
/** Ink points (of text, at the reduced size) needed to measure a skew: about two lines of text. A page number or a few specks measure noise. */
const SKEW_MIN_INK = 2000;
/** An ink pixel in a window this dense is part of a picture or a rule, not a line of text. */
const SOLID_DENSITY = 0.7;
const SOLID_WINDOW = 9;
/** Ink joined into one piece longer than this share of the page's long side is a rule, a frame or a card: text is not that long unbroken, and one straight stroke would out-vote the lines. */
const LONG_STROKE = 0.1;
/** A piece at most this many pixels high and at least this many wide is a sliver — a dash of a dashed rule, an underscore, a hairline fragment — not a letter, and a row of them would out-vote the lines as a long stroke does. */
const SLIVER_HEIGHT = 2;
const SLIVER_WIDTH = 4;

/** Luma of an RGBA picture. */
export function toGrey(image: RgbaImage): Grey {
  const count = image.width * image.height;
  const data = new Uint8Array(count);
  const rgba = image.data;
  for (let i = 0, p = 0; i < count; i += 1, p += 4) {
    data[i] =
      ((rgba[p] as number) * 299 + (rgba[p + 1] as number) * 587 + (rgba[p + 2] as number) * 114 + 500) /
      1000;
  }
  return { width: image.width, height: image.height, data };
}

/** Otsu's threshold: pixels at or below it are dark. */
export function otsu(data: Uint8Array): number {
  const histogram = new Float64Array(256);
  for (const value of data) histogram[value] = (histogram[value] as number) + 1;
  let total = 0;
  let sum = 0;
  for (let level = 0; level < 256; level += 1) {
    total += histogram[level] as number;
    sum += level * (histogram[level] as number);
  }
  let below = 0;
  let sumBelow = 0;
  let best = -1;
  let threshold = 127;
  for (let level = 0; level < 256; level += 1) {
    below += histogram[level] as number;
    sumBelow += level * (histogram[level] as number);
    const above = total - below;
    if (below === 0 || above === 0) continue;
    const gap = sumBelow / below - (sum - sumBelow) / above;
    const spread = below * above * gap * gap;
    if (spread > best) {
      best = spread;
      threshold = level;
    }
  }
  return threshold;
}

/** Mean of `factor × factor` blocks. */
function downscale(grey: Grey, factor: number): Grey {
  if (factor <= 1) return grey;
  const width = Math.max(1, Math.floor(grey.width / factor));
  const height = Math.max(1, Math.floor(grey.height / factor));
  const data = new Uint8Array(width * height);
  const area = factor * factor;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let v = 0; v < factor; v += 1) {
        const row = (y * factor + v) * grey.width + x * factor;
        for (let u = 0; u < factor; u += 1) sum += grey.data[row + u] as number;
      }
      data[y * width + x] = sum / area;
    }
  }
  return { width, height, data };
}

export interface Skew {
  /** Degrees; positive when the text lines descend to the right (y down). */
  readonly angle: number;
  /** The best score over the mean score of the coarse search. */
  readonly confidence: number;
}

/**
 * Clears the 8-connected pieces of the ink `mask` (`width` × `height`, 1 where inked) that are
 * not text: those whose bounding box is more than `limit` pixels long on a side (a rule, a frame, a
 * card) and the slivers (`SLIVER_HEIGHT`, `SLIVER_WIDTH`).
 */
function dropNonText(mask: Uint8Array, width: number, height: number, limit: number): void {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    while (head < tail) {
      const at = queue[head++] as number;
      const x = at % width;
      const y = (at - x) / width;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let v = Math.max(0, y - 1); v <= Math.min(height - 1, y + 1); v += 1) {
        for (let u = Math.max(0, x - 1); u <= Math.min(width - 1, x + 1); u += 1) {
          const next = v * width + u;
          if (mask[next] === 1 && seen[next] === 0) {
            seen[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    const wide = maxX - minX + 1;
    const high = maxY - minY + 1;
    if (Math.max(wide, high) > limit || (high <= SLIVER_HEIGHT && wide >= SLIVER_WIDTH)) {
      for (let i = 0; i < tail; i += 1) mask[queue[i] as number] = 0;
    }
  }
}

/** The ink points of a page for the skew search: centred, subsampled, without pictures, rules, long strokes, slivers and the margin. */
function inkPoints(grey: Grey): { xs: Float32Array; ys: Float32Array; diagonal: number } | null {
  const factor = Math.max(1, Math.round(Math.max(grey.width, grey.height) / SKEW_LONG_SIDE));
  const small = downscale(grey, factor);
  const { width, height } = small;
  const threshold = otsu(small.data);
  const ink = new Uint8Array(width * height);
  for (let i = 0; i < ink.length; i += 1) ink[i] = (small.data[i] as number) <= threshold ? 1 : 0;
  dropNonText(ink, width, height, Math.ceil(LONG_STROKE * Math.max(width, height)));
  const stride = width + 1;
  const sums = new Int32Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += ink[y * width + x] as number;
      sums[(y + 1) * stride + x + 1] = (sums[y * stride + x + 1] as number) + row;
    }
  }
  const half = SOLID_WINDOW >> 1;
  const marginX = Math.floor(width * SKEW_MARGIN);
  const marginY = Math.floor(height * SKEW_MARGIN);
  const found: number[] = [];
  for (let y = marginY; y < height - marginY; y += 1) {
    for (let x = marginX; x < width - marginX; x += 1) {
      if (ink[y * width + x] === 0) continue;
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width, x + half + 1);
      const y0 = Math.max(0, y - half);
      const y1 = Math.min(height, y + half + 1);
      const count =
        (sums[y1 * stride + x1] as number) -
        (sums[y0 * stride + x1] as number) -
        (sums[y1 * stride + x0] as number) +
        (sums[y0 * stride + x0] as number);
      if (count <= SOLID_DENSITY * (x1 - x0) * (y1 - y0)) found.push(x, y);
    }
  }
  const total = found.length / 2;
  if (total < SKEW_MIN_INK) return null;
  const step = Math.max(1, Math.ceil(total / SKEW_POINTS));
  const used = Math.ceil(total / step);
  const xs = new Float32Array(used);
  const ys = new Float32Array(used);
  for (let i = 0; i < used; i += 1) {
    xs[i] = (found[i * step * 2] as number) - width / 2;
    ys[i] = (found[i * step * 2 + 1] as number) - height / 2;
  }
  return { xs, ys, diagonal: Math.ceil(Math.hypot(width, height)) };
}

/**
 * The skew of the text lines by projection profile: the angle at which the ink points, projected
 * across the lines, make the sharpest histogram.
 */
export function detectSkew(grey: Grey): Skew {
  const points = inkPoints(grey);
  if (points === null) return { angle: 0, confidence: 1 };
  const { xs, ys, diagonal } = points;
  const offset = diagonal;
  const histogram = new Int32Array(2 * diagonal + 2);
  const score = (degrees: number): number => {
    const radians = (degrees * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    histogram.fill(0);
    for (let i = 0; i < xs.length; i += 1) {
      const bin = Math.round((ys[i] as number) * cos - (xs[i] as number) * sin) + offset;
      histogram[bin] = (histogram[bin] as number) + 1;
    }
    let sharp = 0;
    for (let b = 0; b + 1 < histogram.length; b += 1) {
      const gap = (histogram[b] as number) - (histogram[b + 1] as number);
      sharp += gap * gap;
    }
    return sharp;
  };
  let best = 0;
  let top = -1;
  let sum = 0;
  let count = 0;
  for (let degrees = -SKEW_RANGE; degrees <= SKEW_RANGE + 1e-9; degrees += SKEW_COARSE) {
    const value = score(degrees);
    sum += value;
    count += 1;
    if (value > top) {
      top = value;
      best = degrees;
    }
  }
  const mean = sum / count;
  const coarse = best;
  for (let degrees = coarse - SKEW_COARSE; degrees <= coarse + SKEW_COARSE + 1e-9; degrees += SKEW_FINE) {
    const value = score(degrees);
    if (value > top) {
      top = value;
      best = degrees;
    }
  }
  return { angle: Math.round(best * 100) / 100, confidence: top / mean };
}

/** Whether a measured skew is one to correct: reliable (a peak, inside the searched window) and visible. */
export function isSkewed(skew: Skew): boolean {
  const size = Math.abs(skew.angle);
  return size >= SKEW_MIN && size <= SKEW_MAX && skew.confidence >= SKEW_CONFIDENCE;
}

/**
 * The picture turned about its centre so that lines descending by `angle` degrees are level, on
 * the same canvas (the corners that leave it are cropped; the ones that come in repeat the
 * nearest edge pixel, so paper stays paper). Bilinear.
 */
export function turnImage(image: RgbaImage, angle: number): RgbaImage {
  const { width, height, data } = image;
  const out = new Uint8Array(data.length);
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  for (let y = 0; y < height; y += 1) {
    const uy = y + 0.5 - height / 2;
    for (let x = 0; x < width; x += 1) {
      const ux = x + 0.5 - width / 2;
      const sx = Math.min(width - 1, Math.max(0, ux * cos - uy * sin + width / 2 - 0.5));
      const sy = Math.min(height - 1, Math.max(0, ux * sin + uy * cos + height / 2 - 0.5));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const wx = sx - x0;
      const wy = sy - y0;
      const to = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const top =
          (data[(y0 * width + x0) * 4 + channel] as number) * (1 - wx) +
          (data[(y0 * width + x1) * 4 + channel] as number) * wx;
        const bottom =
          (data[(y1 * width + x0) * 4 + channel] as number) * (1 - wx) +
          (data[(y1 * width + x1) * 4 + channel] as number) * wx;
        out[to + channel] = top * (1 - wy) + bottom * wy + 0.5;
      }
      out[to + 3] = 255;
    }
  }
  return { width, height, data: out, scale: image.scale };
}

/** The render turned upright and the angle turned by, or `null` when its lines are level (or the skew cannot be trusted). */
export function uprightScan(image: RgbaImage): { image: RgbaImage; angle: number } | null {
  const skew = detectSkew(toGrey(image));
  return isSkewed(skew) ? { image: turnImage(image, skew.angle), angle: skew.angle } : null;
}

/**
 * A point turned by `degrees` (clockwise on the page, y down) about `(cx, cy)`: the upright
 * copy's point to where the scan has it, and with `−degrees` the other way. It is the map
 * `turnImage` samples by, so a mark at `(x, y)` in the copy is at `rotateAbout(x, y, cx, cy, angle)` in the scan.
 */
export function rotateAbout(x: number, y: number, cx: number, cy: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
}

/**
 * Text boxes made on the upright copy, put on the scan: each is the same box turned by `angle`
 * about the page centre `(cx, cy)` (page points): its own centre goes where the scan has it,
 * the frame is turned by `angle` (`TextBox.rotation`, clockwise, 0…360 as a slanted line's is),
 * and the letters' positions along the frame (`RunFit`, measured from the box's left edge) move with it.
 */
export function turnBoxes(boxes: readonly TextBox[], angle: number, cx: number, cy: number): TextBox[] {
  const rotation = ((angle % 360) + 360) % 360;
  return boxes.map((box) => {
    const [x0, y0, x1, y1] = box.box;
    const [mx, my] = rotateAbout((x0 + x1) / 2, (y0 + y1) / 2, cx, cy, angle);
    const left = mx - (x1 - x0) / 2;
    const top = my - (y1 - y0) / 2;
    const shift = left - x0;
    return {
      box: [left, top, left + (x1 - x0), top + (y1 - y0)],
      rotation,
      paragraphs: box.paragraphs.map((paragraph) => ({
        ...paragraph,
        lines: paragraph.lines.map((textLine) => ({
          runs: textLine.runs.map((textRun) => {
            const fit = textRun.fit;
            return fit === undefined
              ? textRun
              : {
                  ...textRun,
                  fit: {
                    ...fit,
                    starts: fit.starts.map((position) => position + shift),
                    ends: fit.ends.map((position) => position + shift),
                  },
                };
          }),
        })),
      })),
    };
  });
}
