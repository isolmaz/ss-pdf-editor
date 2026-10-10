/**
 * The scanner's geometry: the corner order a rotated page must get, the homography that
 * straightens a page, and the page proportions recovered from a perspective view. The wrong
 * answers that matter: a page turned about 45 degrees that gets two corners the same role,
 * a homography that is right at the corners and wrong inside, and an A4 sheet photographed
 * at an angle that comes out as a different paper because its near edge is longer.
 */

import { describe, expect, it } from 'vitest';
import {
  applyHomography,
  clampPoint,
  estimatePageAspect,
  insetQuad,
  isConvexQuad,
  orderCorners,
  type Point,
  type Quad,
  quadSize,
  rotateQuad,
  solveHomography,
} from './scan-geometry';

/** A 200 x 100 page turned by `degrees` about (300, 300): the corners in reading order. */
function turnedPage(degrees: number): Quad {
  const angle = (degrees * Math.PI) / 180;
  const turn = (x: number, y: number): Point => ({
    x: 300 + x * Math.cos(angle) - y * Math.sin(angle),
    y: 300 + x * Math.sin(angle) + y * Math.cos(angle),
  });
  return [turn(-100, -50), turn(100, -50), turn(100, 50), turn(-100, 50)];
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('scan geometry: corners', () => {
  it('orders the corners clockwise from the top-left whatever order they come in', () => {
    // At 30 degrees the page's top-left corner is the one nearest the bounding box's
    // top-left (derived by hand: it is 50 px from the left edge of the box, 0 from the top).
    const page = turnedPage(30);
    for (const shuffled of permutations(page)) {
      expect(orderCorners(shuffled)).toEqual(page);
    }
    // An axis-aligned page too.
    const flat: Quad = [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 220 },
      { x: 10, y: 220 },
    ];
    expect(orderCorners([flat[2], flat[0], flat[3], flat[1]])).toEqual(flat);
    expect(() => orderCorners(flat.slice(0, 3))).toThrow(RangeError);
  });

  it('rotates a quad by quarter turns and measures its page', () => {
    const [a, b, c, d] = turnedPage(0);
    const quad: Quad = [a, b, c, d];
    // A quarter turn clockwise brings the bottom-left corner to the top-left.
    expect(rotateQuad(quad, 1)).toEqual([d, a, b, c]);
    expect(rotateQuad(quad, 2)).toEqual([c, d, a, b]);
    expect(rotateQuad(quad, 0)).toEqual(quad);
    expect(quadSize(quad)).toEqual({ width: 200, height: 100 });
    // The longer of each pair of opposite edges: a trapezoid keeps its near edge.
    const trapezoid: Quad = [
      { x: 20, y: 0 },
      { x: 80, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ];
    expect(quadSize(trapezoid).width).toBe(100);
    expect(quadSize(trapezoid).height).toBeCloseTo(Math.hypot(20, 50), 9);
  });

  it('tells a page outline from a folded one and keeps handles inside the picture', () => {
    expect(isConvexQuad(turnedPage(30))).toBe(true);
    // Corners 1 and 2 swapped: a bow tie.
    const [p0, p1, p2, p3] = turnedPage(0);
    expect(isConvexQuad([p0, p2, p1, p3])).toBe(false);
    expect(isConvexQuad([p0, p1, p2])).toBe(false);
    // Three corners on one line: no turn at the first, so not a page outline.
    expect(
      isConvexQuad([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toBe(false);
    expect(clampPoint({ x: -5, y: 900 }, 640, 480)).toEqual({ x: 0, y: 480 });
    const inset = insetQuad(1000, 500, 0.1);
    expect(inset[0]).toEqual({ x: 100, y: 50 });
    expect(inset[2]).toEqual({ x: 900, y: 450 });
  });
});

describe('scan geometry: homography', () => {
  const unit: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const skewed: Point[] = [
    { x: 40, y: 30 },
    { x: 310, y: 10 },
    { x: 380, y: 260 },
    { x: 5, y: 300 },
  ];

  it('maps the four corners exactly and the centre to where the diagonals cross', () => {
    const h = solveHomography(unit, skewed);
    expect(h).not.toBeNull();
    if (h === null) return;
    for (const [index, corner] of unit.entries()) {
      const mapped = applyHomography(h, corner);
      expect(mapped.x).toBeCloseTo((skewed[index] as Point).x, 6);
      expect(mapped.y).toBeCloseTo((skewed[index] as Point).y, 6);
    }
    // A projective map sends the diagonals to the diagonals, so the centre of the square
    // lands on the crossing of the quad's diagonals: solved here from the line equations.
    const [a, b, c, d] = skewed as [Point, Point, Point, Point];
    const denominator = (a.x - c.x) * (b.y - d.y) - (a.y - c.y) * (b.x - d.x);
    const t1 = a.x * c.y - a.y * c.x;
    const t2 = b.x * d.y - b.y * d.x;
    const crossing = {
      x: (t1 * (b.x - d.x) - (a.x - c.x) * t2) / denominator,
      y: (t1 * (b.y - d.y) - (a.y - c.y) * t2) / denominator,
    };
    const centre = applyHomography(h, { x: 0.5, y: 0.5 });
    expect(centre.x).toBeCloseTo(crossing.x, 6);
    expect(centre.y).toBeCloseTo(crossing.y, 6);
    // And it is a perspective map, not an affine one: the centre is not the corners' mean.
    expect(Math.abs(centre.x - (a.x + b.x + c.x + d.x) / 4)).toBeGreaterThan(1);
  });

  it('inverts by solving the other way, and refuses degenerate input', () => {
    const forward = solveHomography(unit, skewed);
    const backward = solveHomography(skewed, unit);
    if (forward === null || backward === null) throw new Error('solvable');
    const point = { x: 0.3, y: 0.8 };
    const there = applyHomography(forward, point);
    const back = applyHomography(backward, there);
    expect(back.x).toBeCloseTo(0.3, 9);
    expect(back.y).toBeCloseTo(0.8, 9);
    // Three collinear corners: no homography.
    const line = [unit[0] as Point, { x: 0.5, y: 0 }, unit[1] as Point, unit[3] as Point];
    expect(solveHomography(line, skewed)).toBeNull();
    expect(solveHomography(unit.slice(0, 3), skewed)).toBeNull();
  });
});

describe('scan geometry: page proportions', () => {
  /** An A4 sheet (210 x 297, portrait) seen by a pinhole camera: yaw, pitch, distance, focal length. */
  function photographA4(yaw: number, pitch: number, distance: number, focal: number, size: [number, number]) {
    const [width, height] = size;
    const ry = (yaw * Math.PI) / 180;
    const rx = (pitch * Math.PI) / 180;
    const project = (x: number, y: number): Point => {
      // Rotate about the vertical axis, then the horizontal one, then move away from the lens.
      const x1 = x * Math.cos(ry);
      const z1 = -x * Math.sin(ry);
      const y2 = y * Math.cos(rx) - z1 * Math.sin(rx);
      const z2 = y * Math.sin(rx) + z1 * Math.cos(rx) + distance;
      return { x: width / 2 + (focal * x1) / z2, y: height / 2 + (focal * y2) / z2 };
    };
    const quad: Quad = [
      project(-105, -148.5),
      project(105, -148.5),
      project(105, 148.5),
      project(-105, 148.5),
    ];
    return quad;
  }

  it('recovers the A4 ratio from a perspective view, where the edges are off by percent', () => {
    const size: [number, number] = [1600, 1200];
    const a4 = 210 / 297;
    const rounded = (quad: Quad): Quad =>
      quad.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })) as unknown as Quad;
    for (const [yaw, pitch] of [
      [28, 22],
      [-20, 30],
      [35, -15],
    ] as const) {
      const quad = photographA4(yaw, pitch, 600, 1200, size);
      // A pinhole view with the principal point at the centre is exactly the model the
      // estimate assumes: with exact corners only floating-point error remains (1e-6 is far
      // above it), while the longer near edge makes the edges' own ratio wrong by percent.
      const exact = estimatePageAspect(quad, size[0], size[1]) as number;
      expect(Math.abs(exact / a4 - 1)).toBeLessThan(1e-6);
      const edges = quadSize(quad);
      expect(Math.abs(edges.width / edges.height / a4 - 1)).toBeGreaterThan(0.01);
      // Corners found to the pixel (all a detector can offer) move it by about a percent.
      const snapped = estimatePageAspect(rounded(quad), size[0], size[1]) as number;
      expect(Math.abs(snapped / a4 - 1)).toBeLessThan(0.02);
    }
  });

  it('reads a photograph with the typical lens when its rounded corners imply no real focal length', () => {
    // An A4 sheet photographed with a 1200 px lens on a 1600 x 1200 picture, its corners rounded to
    // the pixel and a pixel off here and there. The first quad's corners imply a negative squared
    // focal length; the second and the third imply a lens of 0.28 and 0.17 times the long side,
    // wider than any real one. 1200 px is three quarters of the long side, the lens assumed then,
    // so the ratio still comes out as A4's. Taking the implied focal length at face value would
    // give 0.7147 for the second quad and 0.7230 for the third: 1 to 2 % off.
    const a4 = 210 / 297;
    const quads: readonly Quad[] = [
      [
        { x: 405, y: 46 },
        { x: 1200, y: 41 },
        { x: 1153, y: 1096 },
        { x: 449, y: 1091 },
      ],
      [
        { x: 537, y: 233 },
        { x: 1060, y: 236 },
        { x: 1038, y: 931 },
        { x: 561, y: 935 },
      ],
      [
        { x: 470, y: 144 },
        { x: 1128, y: 147 },
        { x: 1082, y: 990 },
        { x: 516, y: 992 },
      ],
    ];
    for (const quad of quads) {
      const aspect = estimatePageAspect(quad, 1600, 1200) as number;
      expect(Math.abs(aspect / a4 - 1)).toBeLessThan(0.002);
    }
  });

  it('answers nothing for a quad with a corner that is not a number', () => {
    const quad: Quad = [
      { x: Number.NaN, y: 10 },
      { x: 300, y: 12 },
      { x: 310, y: 400 },
      { x: 20, y: 390 },
    ];
    expect(estimatePageAspect(quad, 400, 500)).toBeNull();
  });

  it('answers a straight-on page and a degenerate one', () => {
    const flat: Quad = [
      { x: 400, y: 200 },
      { x: 610, y: 200 },
      { x: 610, y: 497 },
      { x: 400, y: 497 },
    ];
    const aspect = estimatePageAspect(flat, 1000, 800);
    expect(aspect).toBeCloseTo(210 / 297, 3);
    const collapsed: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ];
    expect(estimatePageAspect(collapsed, 100, 100)).toBeNull();
  });
});
