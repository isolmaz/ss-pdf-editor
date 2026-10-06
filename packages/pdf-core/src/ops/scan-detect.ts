/**
 * Find the page in a photograph (the camera scanner, `ops/scan.ts`).
 *
 * A lightweight, local detector, with no OpenCV: the usual document-scanner recipe
 * (grayscale, blur, edges, the largest four-sided contour) rebuilt from small parts, so
 * nothing but this file ships for it.
 *
 *  1. The picture is reduced to about {@link WORKING_SIZE} px on its long side, grayscale,
 *     and blurred with a 5×5 Gaussian.
 *  2. Sobel gradients, non-maximum suppression across the edge and hysteresis give thin,
 *     connected edge pixels, each with the direction of its gradient.
 *  3. Every edge pixel votes for the straight lines through it whose normal is within a
 *     few degrees of its gradient (a Hough transform restricted by direction), and the
 *     strongest well-separated lines are kept. A line, unlike a contour, survives a page
 *     edge that is broken by glare, a finger or a fold.
 *  4. Every way of choosing four of those lines (plus the four edges of the picture, for
 *     a page that runs past the frame) as two pairs of opposite sides is a candidate
 *     quadrilateral. It is kept only if it is convex, its corners are plausible angles
 *     for a page seen in perspective, and it covers enough of the picture. It is scored
 *     by how much of its outline lies on real edges of the right direction, times the
 *     square root of its area, so the page's outer border beats the text block inside it
 *     and a picture-sized frame that nothing supports.
 *  5. Each side of the winner is refitted by least squares through the edge pixels that
 *     support it, which is what brings the corners to a fraction of a pixel.
 *
 * What it cannot do: a page that is the same brightness as what it lies on, or a
 * background full of strong straight lines (a keyboard, floor tiles), will not give a
 * confident answer. {@link detectPage} then returns `null` and the user drags the
 * corners; it never invents an outline.
 */

import {
  isConvexQuad,
  orderCorners,
  type Point,
  polygonArea,
  type Quad,
  type RasterImage,
  scaleQuad,
} from './scan-geometry';

/** The long side, in pixels, of the picture the detector actually looks at. */
export const WORKING_SIZE = 400;

export interface DetectedPage {
  readonly quad: Quad;
  /** 0…1: the winning candidate's score; below about 0.3 the outline is a guess to be checked. */
  readonly confidence: number;
}

interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/** Reduce to a grayscale picture whose long side is at most `limit`, by averaging whole source pixels. */
function grayDownscale(image: RasterImage, limit: number): GrayImage {
  const factor = Math.max(1, Math.max(image.width, image.height) / limit);
  const width = Math.max(1, Math.round(image.width / factor));
  const height = Math.max(1, Math.round(image.height / factor));
  const data = new Float32Array(width * height);
  const stepX = image.width / width;
  const stepY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * stepY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * stepY)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * stepX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * stepX)));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let index = (sy * image.width + x0) * 4;
        for (let sx = x0; sx < x1; sx += 1) {
          // Rec. 601 luma.
          sum +=
            0.299 * (image.data[index] as number) +
            0.587 * (image.data[index + 1] as number) +
            0.114 * (image.data[index + 2] as number);
          index += 4;
          count += 1;
        }
      }
      data[y * width + x] = sum / count;
    }
  }
  return { width, height, data };
}

/** A 5×5 Gaussian (binomial 1 4 6 4 1), separable, edges clamped. */
function blur(image: GrayImage): Float32Array {
  const { width, height, data } = image;
  const kernel = [1, 4, 6, 4, 1];
  const temporary = new Float32Array(width * height);
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -2; k <= 2; k += 1) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        sum += (kernel[k + 2] as number) * (data[y * width + sx] as number);
      }
      temporary[y * width + x] = sum / 16;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -2; k <= 2; k += 1) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        sum += (kernel[k + 2] as number) * (temporary[sy * width + x] as number);
      }
      output[y * width + x] = sum / 16;
    }
  }
  return output;
}

interface EdgeMap {
  readonly width: number;
  readonly height: number;
  /** 1 where there is an edge pixel. */
  readonly edge: Uint8Array;
  /** The gradient direction of an edge pixel, in radians, folded into [0, π). */
  readonly angle: Float32Array;
}

/** Sobel + non-maximum suppression + hysteresis. */
function detectEdges(gray: GrayImage): EdgeMap {
  const { width, height } = gray;
  const smooth = blur(gray);
  const magnitude = new Float32Array(width * height);
  const gradientX = new Float32Array(width * height);
  const gradientY = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const a = smooth[i - width - 1] as number;
      const b = smooth[i - width] as number;
      const c = smooth[i - width + 1] as number;
      const d = smooth[i - 1] as number;
      const f = smooth[i + 1] as number;
      const g = smooth[i + width - 1] as number;
      const h = smooth[i + width] as number;
      const k = smooth[i + width + 1] as number;
      const gx = c + 2 * f + k - (a + 2 * d + g);
      const gy = g + 2 * h + k - (a + 2 * b + c);
      gradientX[i] = gx;
      gradientY[i] = gy;
      magnitude[i] = Math.hypot(gx, gy);
    }
  }

  // Thresholds from the picture's own gradient distribution: the strongest ~8 % of the
  // pixels are "strong", with a floor so a flat picture does not promote its noise.
  const bins = 1024;
  const histogram = new Uint32Array(bins);
  let top = 0;
  for (const value of magnitude) if (value > top) top = value;
  const scale = top > 0 ? (bins - 1) / top : 0;
  for (const value of magnitude)
    histogram[Math.floor(value * scale)] = (histogram[Math.floor(value * scale)] as number) + 1;
  const target = width * height * 0.92;
  let seen = 0;
  let percentile = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    seen += histogram[bin] as number;
    if (seen >= target) {
      percentile = bin / scale;
      break;
    }
  }
  const high = Math.max(percentile, 70);
  const low = high * 0.4;

  // Non-maximum suppression across the edge, direction quantised to 4 sectors.
  const thin = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const m = magnitude[i] as number;
      if (m < low) continue;
      const gx = gradientX[i] as number;
      const gy = gradientY[i] as number;
      const ax = Math.abs(gx);
      const ay = Math.abs(gy);
      let first: number;
      let second: number;
      if (ay <= ax * 0.41421356) {
        first = magnitude[i - 1] as number;
        second = magnitude[i + 1] as number;
      } else if (ay >= ax * 2.41421356) {
        first = magnitude[i - width] as number;
        second = magnitude[i + width] as number;
      } else if (gx * gy > 0) {
        first = magnitude[i - width - 1] as number;
        second = magnitude[i + width + 1] as number;
      } else {
        first = magnitude[i - width + 1] as number;
        second = magnitude[i + width - 1] as number;
      }
      if (m >= first && m >= second) thin[i] = m;
    }
  }

  // Hysteresis: weak pixels survive only when connected to a strong one.
  const edge = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let i = 0; i < thin.length; i += 1) {
    if ((thin[i] as number) >= high) {
      edge[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (edge[j] === 0 && (thin[j] as number) >= low) {
          edge[j] = 1;
          stack.push(j);
        }
      }
    }
  }

  const angle = new Float32Array(width * height);
  for (let i = 0; i < edge.length; i += 1) {
    if (edge[i] === 0) continue;
    let theta = Math.atan2(gradientY[i] as number, gradientX[i] as number);
    if (theta < 0) theta += Math.PI;
    if (theta >= Math.PI) theta -= Math.PI;
    angle[i] = theta;
  }
  return { width, height, edge, angle };
}

/** A straight line `x cos θ + y sin θ = ρ`, `θ` being the direction of its normal. */
interface Line {
  readonly theta: number;
  readonly rho: number;
  readonly votes: number;
  /** One of the picture's own four edges, offered for a page that runs out of the frame. */
  readonly frame: boolean;
}

const THETA_BINS = 180;
/** Edge pixels vote for normals within this many bins either side of their gradient. */
const VOTE_SPREAD = 6;
const MAX_LINES = 12;

/** Hough accumulator with the gradient-direction restriction, and its strongest separated peaks. */
function houghLines(map: EdgeMap): Line[] {
  const { width, height, edge, angle } = map;
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhoBins = diagonal * 2 + 1;
  const accumulator = new Uint16Array(THETA_BINS * rhoBins);
  const cosines = new Float32Array(THETA_BINS);
  const sines = new Float32Array(THETA_BINS);
  for (let bin = 0; bin < THETA_BINS; bin += 1) {
    cosines[bin] = Math.cos((bin * Math.PI) / THETA_BINS);
    sines[bin] = Math.sin((bin * Math.PI) / THETA_BINS);
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (edge[i] === 0) continue;
      const centre = Math.round(((angle[i] as number) * THETA_BINS) / Math.PI);
      for (let d = -VOTE_SPREAD; d <= VOTE_SPREAD; d += 1) {
        // Past either end of [0, π) the same family of lines is reached from the other side.
        const bin = (centre + d + THETA_BINS) % THETA_BINS;
        const rho = x * (cosines[bin] as number) + y * (sines[bin] as number);
        const index = bin * rhoBins + Math.round(rho) + diagonal;
        accumulator[index] = (accumulator[index] as number) + 1;
      }
    }
  }

  const minimum = Math.max(18, Math.round(Math.min(width, height) * 0.22));
  const lines: Line[] = [];
  for (let found = 0; found < MAX_LINES; found += 1) {
    // A peak is read over three neighbouring distance bins: an edge whose distance falls
    // between two bins (a side at most angles, a staircase edge, one at 45°) splits its
    // votes between them, and a single-bin maximum then fell under the floor and the side
    // was never offered.
    let best = 0;
    let bestIndex = -1;
    for (let row = 0; row < THETA_BINS; row += 1) {
      const start = row * rhoBins;
      for (let column = 1; column < rhoBins - 1; column += 1) {
        const index = start + column;
        const value =
          (accumulator[index - 1] as number) +
          (accumulator[index] as number) +
          (accumulator[index + 1] as number);
        if (value > best) {
          best = value;
          bestIndex = index;
        }
      }
    }
    if (best < minimum || bestIndex < 0) break;
    const bin = Math.floor(bestIndex / rhoBins);
    const before = accumulator[bestIndex - 1] as number;
    const after = accumulator[bestIndex + 1] as number;
    // The vote-weighted centre of the window, so a split peak lands between its bins.
    const rho = (bestIndex % rhoBins) - diagonal + (after - before) / best;
    lines.push({ theta: (bin * Math.PI) / THETA_BINS, rho, votes: best, frame: false });
    // Suppress the neighbourhood, across the 0 / 180° seam as well.
    const reach = Math.max(6, Math.round(Math.min(width, height) * 0.03));
    for (let d = -9; d <= 9; d += 1) {
      let neighbour = bin + d;
      let sign = 1;
      if (neighbour < 0) {
        neighbour += THETA_BINS;
        sign = -1;
      } else if (neighbour >= THETA_BINS) {
        neighbour -= THETA_BINS;
        sign = -1;
      }
      const centre = sign * rho;
      for (let r = centre - reach; r <= centre + reach; r += 1) {
        const column = Math.round(r) + diagonal;
        if (column < 0 || column >= rhoBins) continue;
        accumulator[neighbour * rhoBins + column] = 0;
      }
    }
  }
  return lines;
}

function frameLines(width: number, height: number): Line[] {
  // Normals: left edge x = 0 (θ 0), right edge x = w, top edge y = 0 (θ 90°), bottom edge y = h.
  return [
    { theta: 0, rho: 0, votes: 0, frame: true },
    { theta: 0, rho: width - 1, votes: 0, frame: true },
    { theta: Math.PI / 2, rho: 0, votes: 0, frame: true },
    { theta: Math.PI / 2, rho: height - 1, votes: 0, frame: true },
  ];
}

/** Smallest difference between two line directions, in radians, 0…π/2. */
function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

function intersect(a: Line, b: Line): Point | null {
  const ca = Math.cos(a.theta);
  const sa = Math.sin(a.theta);
  const cb = Math.cos(b.theta);
  const sb = Math.sin(b.theta);
  const determinant = ca * sb - sa * cb;
  if (Math.abs(determinant) < 1e-3) return null;
  return {
    x: (a.rho * sb - sa * b.rho) / determinant,
    y: (ca * b.rho - a.rho * cb) / determinant,
  };
}

/** The pixels an edge map accepts as lying on a line of a given direction: edges, grown by 2 px. */
interface Support {
  readonly width: number;
  readonly height: number;
  /** Direction of the nearest edge pixel, in 1/64 π steps + 1; 0 where there is none. */
  readonly near: Uint8Array;
}

function buildSupport(map: EdgeMap): Support {
  const { width, height, edge, angle } = map;
  const near = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (edge[i] === 0) continue;
      const code = 1 + Math.min(63, Math.floor(((angle[i] as number) / Math.PI) * 64));
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          near[ny * width + nx] = code;
        }
      }
    }
  }
  return { width, height, near };
}

/** Fraction of a side's in-picture length that lies on an edge running the side's way; `-1` if mostly outside. */
function sideSupport(support: Support, from: Point, to: Point): number {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length < 1) return 0;
  // The side's normal direction, folded into [0, π).
  let normal = Math.atan2(to.x - from.x, -(to.y - from.y));
  if (normal < 0) normal += Math.PI;
  if (normal >= Math.PI) normal -= Math.PI;
  const steps = Math.ceil(length);
  let inside = 0;
  let hits = 0;
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * step) / steps);
    if (x < 0 || y < 0 || x >= support.width || y >= support.height) continue;
    inside += 1;
    const code = support.near[y * support.width + x] as number;
    if (code === 0) continue;
    const direction = ((code - 0.5) / 64) * Math.PI;
    if (angleBetween(direction, normal) <= Math.PI / 8) hits += 1;
  }
  if (inside < length * 0.25) return -1;
  return hits / inside;
}

interface Candidate {
  readonly lines: readonly [Line, Line, Line, Line];
  readonly corners: readonly [Point, Point, Point, Point];
  readonly score: number;
}

/** Interior angle at `b`, in degrees, of the corner `a b c`. */
function cornerAngle(a: Point, b: Point, c: Point): number {
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const cosine = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
}

/** The best quadrilateral that four of `lines` make, scored against `support`. */
function bestQuad(lines: readonly Line[], width: number, height: number, support: Support): Candidate | null {
  const imageArea = width * height;
  const minSide = Math.min(width, height) * 0.15;
  let best: Candidate | null = null;
  const count = lines.length;
  for (let a = 0; a < count - 3; a += 1) {
    for (let b = a + 1; b < count - 2; b += 1) {
      for (let c = b + 1; c < count - 1; c += 1) {
        for (let d = c + 1; d < count; d += 1) {
          const four = [lines[a], lines[b], lines[c], lines[d]] as [Line, Line, Line, Line];
          if (four.filter((line) => line.frame).length > 2) continue;
          // The three ways to split four lines into two pairs of opposite sides.
          for (const [i, j, k, l] of [
            [0, 1, 2, 3],
            [0, 2, 1, 3],
            [0, 3, 1, 2],
          ] as const) {
            const first = four[i] as Line;
            const second = four[j] as Line;
            const third = four[k] as Line;
            const fourth = four[l] as Line;
            // Opposite sides are roughly parallel; adjacent ones are not.
            if (angleBetween(first.theta, second.theta) > 0.7) continue;
            if (angleBetween(third.theta, fourth.theta) > 0.7) continue;
            if (angleBetween(first.theta, third.theta) < 0.6) continue;
            const p00 = intersect(first, third);
            const p01 = intersect(first, fourth);
            const p11 = intersect(second, fourth);
            const p10 = intersect(second, third);
            if (p00 === null || p01 === null || p11 === null || p10 === null) continue;
            const corners = [p00, p01, p11, p10] as const;
            if (!isConvexQuad(corners)) continue;
            if (
              corners.some(
                (point) =>
                  point.x < -width * 0.15 ||
                  point.x > width * 1.15 ||
                  point.y < -height * 0.15 ||
                  point.y > height * 1.15,
              )
            )
              continue;
            let plausible = true;
            for (let corner = 0; corner < 4; corner += 1) {
              const angle = cornerAngle(
                corners[(corner + 3) % 4] as Point,
                corners[corner] as Point,
                corners[(corner + 1) % 4] as Point,
              );
              if (angle < 45 || angle > 135) {
                plausible = false;
                break;
              }
            }
            if (!plausible) continue;
            const area = polygonArea(corners);
            const ratio = area / imageArea;
            if (ratio < 0.12 || ratio > 1.3) continue;
            let short = false;
            for (let side = 0; side < 4; side += 1) {
              const from = corners[side] as Point;
              const to = corners[(side + 1) % 4] as Point;
              if (Math.hypot(to.x - from.x, to.y - from.y) < minSide) short = true;
            }
            if (short) continue;

            // Score: the geometric mean of the sides' support, squared, times √area.
            const sides: [Line, Line, Line, Line] = [first, fourth, second, third];
            // Sides in outline order p00→p01 (first), p01→p11 (fourth), p11→p10 (second), p10→p00 (third).
            let product = 1;
            for (let side = 0; side < 4; side += 1) {
              const line = sides[side] as Line;
              const from = corners[side] as Point;
              const to = corners[(side + 1) % 4] as Point;
              const measured = line.frame ? 0.5 : sideSupport(support, from, to);
              // A side mostly outside the picture says nothing either way.
              product *= measured < 0 ? 0.35 : Math.max(measured, 0.02);
            }
            const mean = product ** 0.25;
            const score = mean * mean * Math.sqrt(Math.min(ratio, 1));
            if (best === null || score > best.score) {
              best = { lines: [first, fourth, second, third], corners: [p00, p01, p11, p10], score };
            }
          }
        }
      }
    }
  }
  return best;
}

/**
 * Refit a side by least squares through the edge pixels that support it: those within
 * 2.5 px of the line, running its way, and lying between its two corners. A hundred
 * pixels averaged place the line better than the integer Hough bin can.
 */
function refine(map: EdgeMap, line: Line, from: Point, to: Point): Line {
  if (line.frame) return line;
  const { width, height, edge, angle } = map;
  const cos = Math.cos(line.theta);
  const sin = Math.sin(line.theta);
  // Along-the-line coordinate, to keep to the segment between the corners.
  const tx = -sin;
  const ty = cos;
  const t0 = from.x * tx + from.y * ty;
  const t1 = to.x * tx + to.y * ty;
  const low = Math.min(t0, t1);
  const high = Math.max(t0, t1);
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (edge[i] === 0) continue;
      if (Math.abs(x * cos + y * sin - line.rho) > 2.5) continue;
      const t = x * tx + y * ty;
      if (t < low || t > high) continue;
      if (angleBetween(angle[i] as number, line.theta) > Math.PI / 10) continue;
      n += 1;
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
    }
  }
  if (n < 8) return line;
  const meanX = sx / n;
  const meanY = sy / n;
  const covXX = sxx / n - meanX * meanX;
  const covXY = sxy / n - meanX * meanY;
  const covYY = syy / n - meanY * meanY;
  // The line's direction is the dominant eigenvector; its normal is the other one.
  const direction = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
  let theta = direction + Math.PI / 2;
  // Keep the normal on the side of the original so the line keeps its sign convention.
  if (Math.cos(theta - line.theta) < 0) theta += Math.PI;
  const rho = meanX * Math.cos(theta) + meanY * Math.sin(theta);
  // Refuse a refit that wandered: the least-squares line must stay close to the Hough one.
  if (angleBetween(theta, line.theta) > Math.PI / 24 || Math.abs(rho - line.rho) > 4) return line;
  // Fold to θ ∈ [0, π) with the matching ρ sign, as the rest of the file expects.
  let foldedTheta = theta;
  let foldedRho = rho;
  while (foldedTheta < 0) {
    foldedTheta += Math.PI;
    foldedRho = -foldedRho;
  }
  while (foldedTheta >= Math.PI) {
    foldedTheta -= Math.PI;
    foldedRho = -foldedRho;
  }
  return { theta: foldedTheta, rho: foldedRho, votes: line.votes, frame: false };
}

/**
 * Find the page's four corners in `image`, in the picture's own pixel coordinates, or
 * `null` when no outline is convincing enough to offer (the caller falls back to an inset
 * rectangle the user adjusts).
 */
export function detectPage(image: RasterImage): DetectedPage | null {
  if (image.width < 16 || image.height < 16) return null;
  const gray = grayDownscale(image, WORKING_SIZE);
  const map = detectEdges(gray);
  const peaks = houghLines(map);
  if (peaks.length < 2) return null;
  const support = buildSupport(map);
  const candidates = [...peaks, ...frameLines(gray.width, gray.height)];
  const winner = bestQuad(candidates, gray.width, gray.height, support);
  if (winner === null || winner.score < 0.2) return null;

  // Refit the four sides, then take the corners from the refitted lines.
  const [first, fourth, second, third] = winner.lines;
  const corners = winner.corners;
  const refitted: [Line, Line, Line, Line] = [
    refine(map, first, corners[0], corners[1]),
    refine(map, fourth, corners[1], corners[2]),
    refine(map, second, corners[2], corners[3]),
    refine(map, third, corners[3], corners[0]),
  ];
  const p00 = intersect(refitted[0], refitted[3]);
  const p01 = intersect(refitted[0], refitted[1]);
  const p11 = intersect(refitted[2], refitted[1]);
  const p10 = intersect(refitted[2], refitted[3]);
  const final =
    p00 !== null && p01 !== null && p11 !== null && p10 !== null && isConvexQuad([p00, p01, p11, p10])
      ? [p00, p01, p11, p10]
      : [...corners];

  // Pixel centres: the working raster's pixel `i` covers `[i, i + 1)` of the source, so a
  // corner found at integer coordinates sits half a pixel to the lower right.
  const factorX = image.width / gray.width;
  const factorY = image.height / gray.height;
  const clamped = final.map((point) => ({
    x: Math.min(gray.width, Math.max(0, point.x + 0.5)),
    y: Math.min(gray.height, Math.max(0, point.y + 0.5)),
  }));
  const ordered = orderCorners(clamped);
  return { quad: scaleQuad(ordered, factorX, factorY), confidence: Math.min(1, winner.score) };
}
