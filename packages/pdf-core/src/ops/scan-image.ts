/**
 * Pixels of a scanned page (the camera scanner, `ops/scan.ts`): the perspective warp that
 * straightens a photographed page, and the four filters that give it the look of a scan.
 *
 * Pure typed-array code like `scan-geometry.ts`, so a page rendered in the browser and a
 * page rendered by a Node probe are the same page.
 */

import {
  estimatePageAspect,
  type Homography,
  type Point,
  type Quad,
  type QuarterTurns,
  quadSize,
  type RasterImage,
  rotateQuad,
  solveHomography,
} from './scan-geometry';

export type ScanFilter = 'original' | 'grayscale' | 'bw' | 'enhanced';

/** The longest side, in pixels, a straightened page is rendered at (about A4 at 220 dpi). */
export const PAGE_LONG_SIDE = 2600;
/** The same for the on-screen review, which only needs to be sharp on a phone or a laptop. */
export const PREVIEW_LONG_SIDE = 1100;

export function createRaster(width: number, height: number): RasterImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/**
 * Halve a picture by whole-pixel averaging until it is at most `factor` times the target;
 * a bilinear lookup that skips more than two source pixels per output pixel would alias
 * the text into moiré, so the source is brought close to the output size first.
 */
export function boxDownscale(image: RasterImage, factor: number): RasterImage {
  const step = Math.floor(factor);
  if (step < 2) return image;
  const width = Math.max(1, Math.floor(image.width / step));
  const height = Math.max(1, Math.floor(image.height / step));
  const output = createRaster(width, height);
  const area = step * step;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < step; sy += 1) {
        let index = ((y * step + sy) * image.width + x * step) * 4;
        for (let sx = 0; sx < step; sx += 1) {
          r += image.data[index] as number;
          g += image.data[index + 1] as number;
          b += image.data[index + 2] as number;
          index += 4;
        }
      }
      const out = (y * width + x) * 4;
      output.data[out] = r / area;
      output.data[out + 1] = g / area;
      output.data[out + 2] = b / area;
      output.data[out + 3] = 255;
    }
  }
  return output;
}

/**
 * The size, in source pixels, of the page `quad` encloses: its edges, corrected for
 * perspective. A page photographed at an angle has a nearer, longer edge that is not a wider
 * page, so the shape comes from `estimatePageAspect`, and the size is the smallest that
 * keeps the resolution of the longer edges in both directions. An estimate far from what
 * the edges say (a quad that is not a page, a lens the model does not fit) is not trusted.
 */
export function pageSize(
  quad: Quad,
  width: number,
  height: number,
): { readonly width: number; readonly height: number } {
  const edges = quadSize(quad);
  const aspect = estimatePageAspect(quad, width, height);
  if (aspect === null || edges.height <= 0) return edges;
  const drift = aspect / (edges.width / edges.height);
  if (drift < 0.65 || drift > 1.55) return edges;
  return edges.width / edges.height > aspect
    ? { width: edges.width, height: edges.width / aspect }
    : { width: edges.height * aspect, height: edges.height };
}

export interface WarpResult {
  readonly image: RasterImage;
  /** Source pixels per output pixel along the page's width: above 1 the output is a reduction. */
  readonly reduction: number;
}

/**
 * Straighten the page `quad` encloses (in `source` pixel coordinates) into an upright
 * rectangle: `turns` quarter turns clockwise are applied by re-ordering the corners, so a
 * rotation costs nothing, and the output is sized from the quad's own edges, never more
 * than `longSide` pixels on its long side and never enlarged past the source resolution.
 * Pixels outside the source (a corner dragged off the picture) come out white.
 */
export function warpPage(
  source: RasterImage,
  quad: Quad,
  turns: QuarterTurns,
  longSide: number,
): WarpResult | null {
  const oriented = rotateQuad(quad, turns);
  const measured = pageSize(oriented, source.width, source.height);
  if (measured.width < 2 || measured.height < 2) return null;
  const scale = Math.min(1, longSide / Math.max(measured.width, measured.height));
  const width = Math.max(1, Math.round(measured.width * scale));
  const height = Math.max(1, Math.round(measured.height * scale));

  // A source far larger than the output is reduced first (and the quad with it).
  const reduction = 1 / scale;
  const prefilter = Math.floor(reduction);
  const reduced = prefilter >= 2 ? boxDownscale(source, prefilter) : source;
  const shrink = reduced.width / source.width;
  const shrinkY = reduced.height / source.height;
  const corners = oriented.map((point) => ({ x: point.x * shrink, y: point.y * shrinkY })) as unknown as Quad;

  // Map output (pixel centres) -> source, directly, so no inverse is ever taken. The
  // outline is found to a pixel or so of the reduced picture the detector looks at, which is
  // several pixels of the photograph, and a page edge that landed a hair outside would leave
  // a dotted line of desk along the border. So the quad is mapped onto a rectangle 0.4 % of
  // the page larger all round, and the output samples just inside the outline: a margin of
  // paper nobody notices instead of an edge of desk everybody does.
  const pull = Math.max(1, 0.004 * Math.min(width, height));
  const destination: Point[] = [
    { x: -pull, y: -pull },
    { x: width + pull, y: -pull },
    { x: width + pull, y: height + pull },
    { x: -pull, y: height + pull },
  ];
  const h = solveHomography(destination, corners);
  if (h === null) return null;

  const output = createRaster(width, height);
  const { data: from, width: sourceWidth, height: sourceHeight } = reduced;
  const to = output.data;
  const [h0, h1, h2, h3, h4, h5, h6, h7] = h as Homography;
  for (let y = 0; y < height; y += 1) {
    const v = y + 0.5;
    for (let x = 0; x < width; x += 1) {
      const u = x + 0.5;
      const w = h6 * u + h7 * v + 1;
      const sx = (h0 * u + h1 * v + h2) / w - 0.5;
      const sy = (h3 * u + h4 * v + h5) / w - 0.5;
      const out = (y * width + x) * 4;
      if (sx < -0.5 || sy < -0.5 || sx > sourceWidth - 0.5 || sy > sourceHeight - 0.5) {
        to[out] = 255;
        to[out + 1] = 255;
        to[out + 2] = 255;
        to[out + 3] = 255;
        continue;
      }
      const x0 = Math.min(sourceWidth - 1, Math.max(0, Math.floor(sx)));
      const y0 = Math.min(sourceHeight - 1, Math.max(0, Math.floor(sy)));
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const y1 = Math.min(sourceHeight - 1, y0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const fy = Math.min(1, Math.max(0, sy - y0));
      const i00 = (y0 * sourceWidth + x0) * 4;
      const i10 = (y0 * sourceWidth + x1) * 4;
      const i01 = (y1 * sourceWidth + x0) * 4;
      const i11 = (y1 * sourceWidth + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      to[out] =
        (from[i00] as number) * w00 +
        (from[i10] as number) * w10 +
        (from[i01] as number) * w01 +
        (from[i11] as number) * w11;
      to[out + 1] =
        (from[i00 + 1] as number) * w00 +
        (from[i10 + 1] as number) * w10 +
        (from[i01 + 1] as number) * w01 +
        (from[i11 + 1] as number) * w11;
      to[out + 2] =
        (from[i00 + 2] as number) * w00 +
        (from[i10 + 2] as number) * w10 +
        (from[i01 + 2] as number) * w01 +
        (from[i11 + 2] as number) * w11;
      to[out + 3] = 255;
    }
  }
  return { image: output, reduction };
}

/** Rec. 601 luma of one RGBA pixel. */
function luma(data: Uint8ClampedArray, index: number): number {
  return (
    0.299 * (data[index] as number) +
    0.587 * (data[index + 1] as number) +
    0.114 * (data[index + 2] as number)
  );
}

/** Grayscale, in place. */
export function applyGrayscale(image: RasterImage): void {
  const { data } = image;
  for (let index = 0; index < data.length; index += 4) {
    const value = luma(data, index);
    data[index] = value;
    data[index + 1] = value;
    data[index + 2] = value;
  }
}

/**
 * Black and white by an adaptive threshold: a pixel is ink when it is darker than the
 * mean of the window around it by more than `bias` of that mean. A global threshold turns
 * a page lit from one side half black; a local one follows the lighting. The window is a
 * box (an integral image makes it a four-lookup average at any size), about a twentieth
 * of the page, wide enough to hold a letter's whole stroke and the paper around it.
 */
export function applyBlackAndWhite(image: RasterImage, bias = 0.13): void {
  const { width, height, data } = image;
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let row = 0;
    for (let x = 0; x < width; x += 1) {
      row += luma(data, (y * width + x) * 4);
      integral[(y + 1) * stride + x + 1] = (integral[y * stride + x + 1] as number) + row;
    }
  }
  const radius = Math.max(7, Math.round(Math.min(width, height) / 40));
  // The paper's brightness (95th percentile of luma): anything well below it is ink even
  // where the window around it is dark too, so a solid block stays black instead of
  // turning white inside its own outline.
  const histogram = new Uint32Array(256);
  for (let index = 0; index < data.length; index += 4) {
    const bin = Math.min(255, Math.round(luma(data, index)));
    histogram[bin] = (histogram[bin] as number) + 1;
  }
  let seen = 0;
  let paper = 255;
  for (let value = 0; value < 256; value += 1) {
    seen += histogram[value] as number;
    if (seen >= width * height * 0.95) {
      paper = value;
      break;
    }
  }
  const solid = paper * 0.4;
  for (let y = 0; y < height; y += 1) {
    const top = Math.max(0, y - radius);
    const bottom = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - radius);
      const right = Math.min(width, x + radius + 1);
      const sum =
        (integral[bottom * stride + right] as number) -
        (integral[top * stride + right] as number) -
        (integral[bottom * stride + left] as number) +
        (integral[top * stride + left] as number);
      const mean = sum / ((right - left) * (bottom - top));
      const index = (y * width + x) * 4;
      const brightness = luma(data, index);
      const value = brightness < mean * (1 - bias) || brightness < solid ? 0 : 255;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
    }
  }
}

/**
 * "Enhanced": even out the lighting and whiten the paper, keeping colour.
 *
 * How bright the paper is at every point is estimated in luminance, from a small copy of
 * the page: the brightest pixel of each cell (ink is darker than paper, so the maximum is
 * paper), a maximum filter over a wide window (a heading's ink is many cells wide), then a
 * box blur. Each pixel is divided by that brightness, which flattens a shadow or a lit
 * side, and by the paper's own colour (measured once, from the cells that are almost
 * certainly bare paper), which removes a yellow or blue cast. One gain for all three
 * channels at a point is what keeps coloured ink coloured: estimating each channel's
 * background separately turns a red stamp's surroundings cyan. A contrast curve then pulls
 * ink toward black.
 */
export function applyEnhanced(image: RasterImage): void {
  const { width, height, data } = image;
  const cell = Math.max(4, Math.round(Math.max(width, height) / 160));
  const gridWidth = Math.max(2, Math.ceil(width / cell));
  const gridHeight = Math.max(2, Math.ceil(height / cell));
  const brightest = new Float32Array(gridWidth * gridHeight);
  // The colour of each cell's brightest pixel, for the paper's own tint.
  const tint = new Float32Array(gridWidth * gridHeight * 3);
  for (let cy = 0; cy < gridHeight; cy += 1) {
    for (let cx = 0; cx < gridWidth; cx += 1) {
      let best = -1;
      let bestIndex = 0;
      const y1 = Math.min(height, (cy + 1) * cell);
      const x1 = Math.min(width, (cx + 1) * cell);
      for (let y = cy * cell; y < y1; y += 1) {
        for (let x = cx * cell; x < x1; x += 1) {
          const index = (y * width + x) * 4;
          const value = luma(data, index);
          if (value > best) {
            best = value;
            bestIndex = index;
          }
        }
      }
      const at = cy * gridWidth + cx;
      brightest[at] = best;
      tint[at * 3] = data[bestIndex] as number;
      tint[at * 3 + 1] = data[bestIndex + 1] as number;
      tint[at * 3 + 2] = data[bestIndex + 2] as number;
    }
  }

  // The paper's colour: the mean tint of the cells within 8 % of the brightest 5 % of cells.
  const sorted = Array.from(brightest).sort((a, b) => a - b);
  const reference = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number;
  let weightR = 0;
  let weightG = 0;
  let weightB = 0;
  let counted = 0;
  for (let at = 0; at < brightest.length; at += 1) {
    if ((brightest[at] as number) < reference * 0.92) continue;
    const value = Math.max(1, brightest[at] as number);
    weightR += (tint[at * 3] as number) / value;
    weightG += (tint[at * 3 + 1] as number) / value;
    weightB += (tint[at * 3 + 2] as number) / value;
    counted += 1;
  }
  // Per-channel gain that makes the paper neutral at unchanged luminance.
  const whiteR = counted === 0 ? 1 : weightR / counted;
  const whiteG = counted === 0 ? 1 : weightG / counted;
  const whiteB = counted === 0 ? 1 : weightB / counted;
  const white = [whiteR, whiteG, whiteB] as const;

  // Maximum filter (the ink of a heading is many cells wide), then a box blur.
  const dilated = dilate(brightest, gridWidth, gridHeight, 1, 14);
  const smooth = boxBlur(boxBlur(dilated, gridWidth, gridHeight, 1, 3), gridWidth, gridHeight, 1, 3);

  const lowPoint = 0.3;
  const highPoint = 0.92;
  for (let y = 0; y < height; y += 1) {
    // Cell-centre coordinates for the bilinear lookup of the paper brightness.
    const gy = Math.min(gridHeight - 1.001, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(gridWidth - 1.001, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      const a = smooth[y0 * gridWidth + x0] as number;
      const b = smooth[y0 * gridWidth + x0 + 1] as number;
      const c = smooth[(y0 + 1) * gridWidth + x0] as number;
      const d = smooth[(y0 + 1) * gridWidth + x0 + 1] as number;
      const background = Math.max(24, (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy);
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const ratio = (data[index + channel] as number) / (background * (white[channel] as number));
        const stretched = Math.min(1, Math.max(0, (ratio - lowPoint) / (highPoint - lowPoint)));
        // A gentle S-curve keeps mid-tones (photographs, stamps) from flattening.
        data[index + channel] = 255 * (stretched * stretched * (3 - 2 * stretched));
      }
    }
  }
}

/** Per-channel maximum over a square window of `radius` cells: it erases ink, keeps paper. */
function dilate(
  grid: Float32Array,
  width: number,
  height: number,
  channels: number,
  radius: number,
): Float32Array {
  const horizontal = new Float32Array(grid.length);
  const output = new Float32Array(grid.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        let value = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const sx = Math.min(width - 1, Math.max(0, x + k));
          value = Math.max(value, grid[(y * width + sx) * channels + channel] as number);
        }
        horizontal[(y * width + x) * channels + channel] = value;
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        let value = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const sy = Math.min(height - 1, Math.max(0, y + k));
          value = Math.max(value, horizontal[(sy * width + x) * channels + channel] as number);
        }
        output[(y * width + x) * channels + channel] = value;
      }
    }
  }
  return output;
}

function boxBlur(
  grid: Float32Array,
  width: number,
  height: number,
  channels: number,
  radius: number,
): Float32Array {
  const horizontal = new Float32Array(grid.length);
  const output = new Float32Array(grid.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        let sum = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const sx = Math.min(width - 1, Math.max(0, x + k));
          sum += grid[(y * width + sx) * channels + channel] as number;
        }
        horizontal[(y * width + x) * channels + channel] = sum / (radius * 2 + 1);
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        let sum = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const sy = Math.min(height - 1, Math.max(0, y + k));
          sum += horizontal[(sy * width + x) * channels + channel] as number;
        }
        output[(y * width + x) * channels + channel] = sum / (radius * 2 + 1);
      }
    }
  }
  return output;
}

/** Apply one filter to a straightened page, in place. */
export function applyFilter(image: RasterImage, filter: ScanFilter): void {
  if (filter === 'grayscale') applyGrayscale(image);
  else if (filter === 'bw') applyBlackAndWhite(image);
  else if (filter === 'enhanced') applyEnhanced(image);
}

/** Straighten a page and filter it: the one call both the review and the export make. */
export function renderScanPage(
  source: RasterImage,
  quad: Quad,
  turns: QuarterTurns,
  filter: ScanFilter,
  longSide: number,
): RasterImage | null {
  const warped = warpPage(source, quad, turns, longSide);
  if (warped === null) return null;
  applyFilter(warped.image, filter);
  return warped.image;
}
