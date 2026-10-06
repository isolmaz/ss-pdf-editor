/**
 * The geometry of a scanned page (the camera scanner, `ops/scan.ts`).
 *
 * Everything here is pure arithmetic on pixels and corner points, with no DOM and no
 * engine, so the scanner's maths can be run and tested in Node: ordering four corners,
 * measuring the page they enclose, and solving the homography that straightens it.
 *
 * Coordinates are pixels with the origin at the top-left, `x` to the right and `y`
 * down. A {@link Quad} always lists its corners clockwise from the top-left one:
 * top-left, top-right, bottom-right, bottom-left.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Four corners, clockwise from the top-left one. */
export type Quad = readonly [Point, Point, Point, Point];

/**
 * An 8-bit RGBA picture in the shape of the browser's `ImageData`, which satisfies it:
 * the algorithms read and write plain typed arrays, so they run in Node as they do in a
 * page.
 */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

/** Quarter turns clockwise. */
export type QuarterTurns = 0 | 1 | 2 | 3;

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Twice the signed area of the triangle `a b c`: positive when the turn is clockwise on screen. */
export function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Area of a simple polygon (shoelace), always positive. */
export function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index] as Point;
    const next = points[(index + 1) % points.length] as Point;
    sum += current.x * next.y - next.x * current.y;
  }
  return Math.abs(sum) / 2;
}

/** Whether the four points, taken in order, make a convex quadrilateral that does not fold over. */
export function isConvexQuad(points: readonly Point[]): boolean {
  if (points.length !== 4) return false;
  let sign = 0;
  for (let index = 0; index < 4; index += 1) {
    const turn = cross(
      points[index] as Point,
      points[(index + 1) % 4] as Point,
      points[(index + 2) % 4] as Point,
    );
    if (turn === 0) return false;
    const current = turn > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

/**
 * Put four corners in the {@link Quad} order, whatever order they were given in.
 *
 * The corners are sorted around their centroid by angle, then rotated so the one
 * nearest the top-left of the bounding box comes first. Sorting by `x + y` and `x − y`
 * (the usual shortcut) assigns two roles to one corner as soon as the page is turned by
 * about 45°, which a hand-held photo can be.
 */
export function orderCorners(points: readonly Point[]): Quad {
  if (points.length !== 4) throw new RangeError(`orderCorners needs 4 points, got ${points.length}`);
  const centreX = points.reduce((sum, point) => sum + point.x, 0) / 4;
  const centreY = points.reduce((sum, point) => sum + point.y, 0) / 4;
  // Screen coordinates: increasing atan2 goes clockwise.
  const sorted = [...points].sort(
    (a, b) => Math.atan2(a.y - centreY, a.x - centreX) - Math.atan2(b.y - centreY, b.x - centreX),
  );
  let first = 0;
  let best = Number.POSITIVE_INFINITY;
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  for (const [index, point] of sorted.entries()) {
    const score = (point.x - minX) ** 2 + (point.y - minY) ** 2;
    if (score < best) {
      best = score;
      first = index;
    }
  }
  const at = (offset: number) => sorted[(first + offset) % 4] as Point;
  return [at(0), at(1), at(2), at(3)];
}

/** The quad as it reads after `turns` clockwise quarter turns of the page it encloses. */
export function rotateQuad(quad: Quad, turns: QuarterTurns): Quad {
  // Turning a page a quarter clockwise sends its bottom-left corner to the top-left.
  const shift = (4 - turns) % 4;
  const at = (index: number) => quad[(index + shift) % 4] as Point;
  return [at(0), at(1), at(2), at(3)];
}

/**
 * The size, in source pixels, of the page a quad encloses: the longer of each pair of
 * opposite edges, so the straightened page never has less resolution than the nearest
 * side of it had in the photo.
 */
export function quadSize(quad: Quad): { readonly width: number; readonly height: number } {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  return {
    width: Math.max(distance(topLeft, topRight), distance(bottomLeft, bottomRight)),
    height: Math.max(distance(topLeft, bottomLeft), distance(topRight, bottomRight)),
  };
}

export function scaleQuad(quad: Quad, factorX: number, factorY: number = factorX): Quad {
  const scale = (point: Point): Point => ({ x: point.x * factorX, y: point.y * factorY });
  return [scale(quad[0]), scale(quad[1]), scale(quad[2]), scale(quad[3])];
}

/** The default outline when no page edge was found: the picture inset by `margin` of its size. */
export function insetQuad(width: number, height: number, margin = 0.06): Quad {
  const left = width * margin;
  const top = height * margin;
  const right = width * (1 - margin);
  const bottom = height * (1 - margin);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

/** A corner pulled back inside the picture: a hand can drag a handle past the edge. */
export function clampPoint(point: Point, width: number, height: number): Point {
  return {
    x: Math.min(Math.max(point.x, 0), width),
    y: Math.min(Math.max(point.y, 0), height),
  };
}

/**
 * Solve `A x = b` for a square system by Gaussian elimination with partial pivoting.
 * Returns `null` when the matrix is singular (to within rounding).
 */
function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const size = rhs.length;
  const rows = matrix.map((row, index) => [...row, rhs[index] as number]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (
        Math.abs((rows[row] as number[])[column] as number) >
        Math.abs((rows[pivot] as number[])[column] as number)
      )
        pivot = row;
    }
    const pivotRow = rows[pivot] as number[];
    if (Math.abs(pivotRow[column] as number) < 1e-10) return null;
    rows[pivot] = rows[column] as number[];
    rows[column] = pivotRow;
    for (let row = column + 1; row < size; row += 1) {
      const target = rows[row] as number[];
      const factor = (target[column] as number) / (pivotRow[column] as number);
      for (let k = column; k <= size; k += 1)
        target[k] = (target[k] as number) - factor * (pivotRow[k] as number);
    }
  }
  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    const current = rows[row] as number[];
    let sum = current[size] as number;
    for (let k = row + 1; k < size; k += 1) sum -= (current[k] as number) * (solution[k] as number);
    solution[row] = sum / (current[row] as number);
  }
  return solution;
}

/** A 3×3 projective transform, row-major, with the last element fixed at 1. */
export type Homography = readonly [number, number, number, number, number, number, number, number, number];

/**
 * The homography that maps each `from[i]` to `to[i]` (four pairs, no three collinear),
 * or `null` for a degenerate set. The eight unknowns come from two equations per pair,
 * `X = (h0 x + h1 y + h2) / (h6 x + h7 y + 1)` and likewise for `Y`, cleared of the
 * denominator.
 */
export function solveHomography(from: readonly Point[], to: readonly Point[]): Homography | null {
  if (from.length !== 4 || to.length !== 4) return null;
  const matrix: number[][] = [];
  const rhs: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = from[index] as Point;
    const { x: u, y: v } = to[index] as Point;
    matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    rhs.push(u);
    matrix.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    rhs.push(v);
  }
  const h = solveLinear(matrix, rhs);
  if (h === null || h.some((value) => !Number.isFinite(value))) return null;
  return [
    h[0] as number,
    h[1] as number,
    h[2] as number,
    h[3] as number,
    h[4] as number,
    h[5] as number,
    h[6] as number,
    h[7] as number,
    1,
  ];
}

/** Apply a homography to a point. */
export function applyHomography(h: Homography, point: Point): Point {
  const w = h[6] * point.x + h[7] * point.y + h[8];
  return {
    x: (h[0] * point.x + h[1] * point.y + h[2]) / w,
    y: (h[3] * point.x + h[4] * point.y + h[5]) / w,
  };
}

type Vector3 = readonly [number, number, number];

function crossProduct(a: Vector3, b: Vector3): Vector3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dotProduct(a: Vector3, b: Vector3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * The true width-to-height ratio of the rectangle a quad shows in perspective, or `null`
 * when it cannot be told (the quad is degenerate).
 *
 * A page photographed at an angle is a trapezoid, and the longer of its parallel edges is
 * simply nearer to the lens, not wider: reading the ratio off the edges stretches the page
 * by several percent. The ratio *is* recoverable, because a rectangle's right angles
 * constrain the camera: assuming square pixels and a principal point at the centre of the
 * picture (true of any uncropped photograph), the focal length follows from the quad
 * alone, and with it the rectangle's shape (Zhang and He, "Whiteboard scanning and image
 * enhancement", 2007).
 *
 * `quad` is clockwise from the top-left corner, `width` × `height` the picture's size.
 */
export function estimatePageAspect(quad: Quad, width: number, height: number): number | null {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  // The paper's labelling: m1 top-left, m2 top-right, m3 bottom-left, m4 bottom-right.
  const m1: Vector3 = [topLeft.x, topLeft.y, 1];
  const m2: Vector3 = [topRight.x, topRight.y, 1];
  const m3: Vector3 = [bottomLeft.x, bottomLeft.y, 1];
  const m4: Vector3 = [bottomRight.x, bottomRight.y, 1];
  const u0 = width / 2;
  const v0 = height / 2;

  const denominator2 = dotProduct(crossProduct(m2, m4), m3);
  const denominator3 = dotProduct(crossProduct(m3, m4), m2);
  if (Math.abs(denominator2) < 1e-9 || Math.abs(denominator3) < 1e-9) return null;
  const k2 = dotProduct(crossProduct(m1, m4), m3) / denominator2;
  const k3 = dotProduct(crossProduct(m1, m4), m2) / denominator3;
  const n2: Vector3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3: Vector3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];

  // The focal length the quad implies. It needs perspective along both axes: a page
  // tilted about one axis only has one vanishing point and the constraint degenerates. Then
  // (and when the numbers do not describe a real lens) a typical phone lens is assumed, a
  // focal length of three quarters of the picture's long side, which is still far closer
  // than reading the edges as they are.
  const product = n2[2] * n3[2];
  const typical = 0.75 * Math.max(width, height);
  let focal = typical;
  if (Math.abs(product) > 1e-3) {
    const focalSquared =
      -(
        n2[0] * n3[0] -
        (n2[0] * n3[2] + n2[2] * n3[0]) * u0 +
        product * u0 * u0 +
        (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + product * v0 * v0)
      ) / product;
    // A real lens is between a wide angle and a long tele: 0.3 to 6 times the long side.
    if (Number.isFinite(focalSquared) && focalSquared > 0) {
      const implied = Math.sqrt(focalSquared);
      const long = Math.max(width, height);
      if (implied > 0.3 * long && implied < 6 * long) focal = implied;
    }
  }

  const back = (vector: Vector3): Vector3 => [
    (vector[0] - u0 * vector[2]) / focal,
    (vector[1] - v0 * vector[2]) / focal,
    vector[2],
  ];
  const a2 = back(n2);
  const a3 = back(n3);
  const ratioSquared = dotProduct(a2, a2) / dotProduct(a3, a3);
  if (!Number.isFinite(ratioSquared) || ratioSquared <= 0) return null;
  return Math.sqrt(ratioSquared);
}
