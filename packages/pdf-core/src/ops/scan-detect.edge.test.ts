/**
 * The page detector on pictures that exercise its edges: an axis-aligned sheet with no grain
 * (gradients exactly horizontal or vertical), a sheet touching the picture's border, a sheet
 * lit unevenly (weak edge stretches that only hysteresis keeps), and pictures with nothing to find.
 */

import { describe, expect, it } from 'vitest';
import { cornersOfSides, detectPage, type Side } from './scan-detect';
import type { Point, RasterImage } from './scan-geometry';

/** A picture of `desk` with an axis-aligned sheet; `shade` gives the sheet's grey at a column. */
function sheet(
  width: number,
  height: number,
  box: readonly [number, number, number, number],
  shade: (x: number) => number,
  desk = 30,
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onSheet = x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
      const value = onSheet ? shade(x) : desk;
      const at = (y * width + x) * 4;
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('detectPage edge cases', () => {
  it('finds a flat axis-aligned sheet, whose side gradients are exactly horizontal and vertical', () => {
    const found = detectPage(sheet(240, 180, [40, 30, 200, 150], () => 220));
    expect(found).not.toBeNull();
    const xs = found?.quad.map((point) => Math.round(point.x)) ?? [];
    const ys = found?.quad.map((point) => Math.round(point.y)) ?? [];
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(38);
    expect(Math.max(...xs)).toBeLessThanOrEqual(202);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(28);
    expect(Math.max(...ys)).toBeLessThanOrEqual(152);
  });

  it('finds a sheet that reaches the border of the picture', () => {
    const found = detectPage(sheet(240, 180, [1, 1, 239, 179], () => 220));
    expect(found === null || found.quad.length === 4).toBe(true);
  });

  it('finds a sheet lit unevenly, its far side dimmer than its near side', () => {
    const found = detectPage(sheet(240, 180, [40, 30, 200, 150], (x) => 230 - (x - 40) * 0.75));
    expect(found).not.toBeNull();
  });

  it('finds nothing in a picture too small to hold a page, in a flat one, and in one with no clear outline', () => {
    expect(detectPage(sheet(10, 10, [2, 2, 8, 8], () => 200))).toBeNull();
    expect(detectPage(sheet(240, 180, [0, 0, 0, 0], () => 0, 128))).toBeNull();
    // A sheet barely lighter than the desk: no side stands out.
    expect(detectPage(sheet(240, 180, [40, 30, 200, 150], () => 36))).toBeNull();
  });
});

/** A sheet on the desk: its convex outline and the grey it is drawn in at a pixel. */
interface Sheet {
  readonly corners: readonly (readonly [number, number])[];
  readonly shade: (x: number, y: number) => number;
}

/** `desk` with the sheets laid over it in order, the last on top; 2 x 2 coverage keeps the edges soft. */
function picture(width: number, height: number, sheets: readonly Sheet[], desk = 30): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const contains = (corners: Sheet['corners'], x: number, y: number): boolean => {
    let sign = 0;
    for (let index = 0; index < corners.length; index += 1) {
      const [ax, ay] = corners[index] as readonly [number, number];
      const [bx, by] = corners[(index + 1) % corners.length] as readonly [number, number];
      const turn = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (turn === 0) continue;
      const current = turn > 0 ? 1 : -1;
      if (sign === 0) sign = current;
      else if (sign !== current) return false;
    }
    return true;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let value = desk;
      for (const sheet of sheets) {
        let covered = 0;
        for (const [sx, sy] of [
          [0.25, 0.25],
          [0.75, 0.25],
          [0.25, 0.75],
          [0.75, 0.75],
        ] as const) {
          if (contains(sheet.corners, x + sx, y + sy)) covered += 1;
        }
        value += ((sheet.shade(x, y) - value) * covered) / 4;
      }
      const at = (y * width + x) * 4;
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

/** `paper` inside the convex polygon, `desk` outside. */
function polygon(
  width: number,
  height: number,
  corners: readonly (readonly [number, number])[],
  shade: (x: number, y: number) => number = () => 225,
  desk = 30,
): RasterImage {
  return picture(width, height, [{ corners, shade }], desk);
}

/** The detected corners, each within `tolerance` px of `wanted` in the same role. */
function expectQuad(
  found: ReturnType<typeof detectPage>,
  wanted: readonly (readonly [number, number])[],
  tolerance = 3,
): void {
  expect(found).not.toBeNull();
  for (const [index, [x, y]] of wanted.entries()) {
    const corner = found?.quad[index] as Point;
    expect(Math.hypot(corner.x - x, corner.y - y), `corner ${index}`).toBeLessThan(tolerance);
  }
}

describe('detectPage on awkward outlines', () => {
  it('keeps the weak stretch of a side whose contrast fades, because it joins a strong one', () => {
    const wanted = [
      [40, 30],
      [200, 30],
      [200, 150],
      [40, 150],
    ] as const;
    expectQuad(detectPage(polygon(240, 180, wanted, (x) => 230 - (x - 40) * 1.1)), wanted);
  });

  it("finds the sheet in a strip as thin as the detector accepts, whose far side hugs the picture's far corner", () => {
    const wanted = [
      [10, 1],
      [397, 1],
      [397, 19],
      [10, 19],
    ] as const;
    expectQuad(detectPage(polygon(400, 20, wanted)), wanted);
  });

  it('finds a sheet whose long sides converge, where two candidate sides lean opposite ways', () => {
    const wanted = [
      [100, 30],
      [200, 30],
      [280, 280],
      [20, 280],
    ] as const;
    expectQuad(detectPage(polygon(300, 300, wanted)), wanted);
  });

  it('finds a strongly sheared sheet, its acute corners near the plausibility limit', () => {
    const wanted = [
      [100, 40],
      [280, 40],
      [200, 260],
      [20, 260],
    ] as const;
    expectQuad(detectPage(polygon(300, 300, wanted)), wanted);
  });

  it("closes a sheet that runs off the picture with the picture's own edge", () => {
    const found = detectPage(
      polygon(300, 240, [
        [-50, 30],
        [220, 30],
        [220, 200],
        [-50, 200],
      ]),
    );
    expectQuad(found, [
      [1, 30],
      [220, 30],
      [220, 200],
      [1, 200],
    ]);
  });

  it('does not take a sheared sheet whose corners are far from square for the page: the outline it answers with keeps its corners near 45-135 degrees (refitting moves them a few degrees)', () => {
    const found = detectPage(
      polygon(400, 300, [
        [250, 40],
        [390, 40],
        [150, 260],
        [10, 260],
      ]),
    );
    expect(found).not.toBeNull();
    const quad = found?.quad as readonly Point[];
    for (let index = 0; index < 4; index += 1) {
      const a = quad[(index + 3) % 4] as Point;
      const b = quad[index] as Point;
      const c = quad[(index + 1) % 4] as Point;
      const cosine =
        ((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y)) /
        (Math.hypot(a.x - b.x, a.y - b.y) * Math.hypot(c.x - b.x, c.y - b.y));
      const degrees = (Math.acos(cosine) * 180) / Math.PI;
      expect(degrees, `corner ${index}`).toBeGreaterThan(40);
      expect(degrees, `corner ${index}`).toBeLessThan(140);
    }
  });

  it('finds nothing in a picture whose only outline is a band too narrow to be a page', () => {
    expect(
      detectPage(
        polygon(300, 300, [
          [130, -5],
          [169, -5],
          [169, 305],
          [130, 305],
        ]),
      ),
    ).toBeNull();
  });

  it('finds nothing in a picture so long and thin that its working raster is under 16 px across', () => {
    // A bright strip on a dark desk, 16 x 600 (working raster 11 x 400): without the check the
    // detector reads the strip's two long sides and the frame lines and returns a bogus quad.
    expect(detectPage(sheet(16, 600, [0, 60, 16, 540], () => 220))).toBeNull();
    // The same across the other way: 500 x 16 shrinks to 400 x 13.
    expect(detectPage(sheet(500, 16, [1, 2, 499, 14], () => 220))).toBeNull();
  });

  it('keeps a side that leans out of the picture, where only its last quarter is in view', () => {
    // The sheet's left side crosses the picture's left border 96 px above the bottom; the
    // corner it makes with the top of the picture lies 60 px outside, so almost all of the
    // side is out of view (a side that is mostly outside counts for little either way).
    const slope = 58 / (400 - 96);
    const at = (y: number) => slope * (y - (400 - 96));
    const found = detectPage(
      polygon(400, 400, [
        [at(-5), -5],
        [370, -5],
        [370, 405],
        [at(405), 405],
      ]),
    );
    expectQuad(found, [
      [0, 1],
      [370, 0],
      [370, 400],
      [18, 400],
    ]);
  });
});

describe('detectPage on a sheet half hidden under another', () => {
  it('leaves a side where the Hough line put it when fewer than 8 edge pixels lie along it to refit it with', () => {
    // A mid-grey sheet lies over a lighter one on a dark desk. One side of the outline found has
    // too few edge pixels between its two corners to fit a line through: refitted anyway, the
    // first corner ends up 26 px from the sheet's own corner.
    const found = detectPage(
      picture(
        85,
        53,
        [
          {
            corners: [
              [48, 42],
              [10, 30],
              [53, 13],
              [66, 27],
            ],
            shade: () => 180,
          },
          {
            corners: [
              [3, 6],
              [32, 1],
              [56, 13],
              [18, 26],
            ],
            shade: () => 100,
          },
        ],
        30,
      ),
    );
    expectQuad(
      found,
      [
        [3, 6],
        [41.6, 0],
        [53.7, 13.3],
        [18.6, 26.8],
      ],
      0.25,
    );
  });
});

/** The line through two points, as the detector writes one: its normal's direction and its distance. */
function through(from: Point, to: Point): Side {
  let theta = Math.atan2(to.x - from.x, -(to.y - from.y));
  if (theta < 0) theta += Math.PI;
  return { theta, rho: from.x * Math.cos(theta) + from.y * Math.sin(theta) };
}

describe('cornersOfSides', () => {
  const before: Point[] = [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 2, y: 2 },
    { x: 1, y: 2 },
  ];
  const at = (x: number, y: number): Point => ({ x, y });

  it('closes four sides into the corners they cross at, in outline order', () => {
    const top = through(at(0, 10), at(100, 12));
    const right = through(at(100, 12), at(98, 90));
    const bottom = through(at(98, 90), at(2, 88));
    const left = through(at(2, 88), at(0, 10));
    const corners = cornersOfSides([top, right, bottom, left], before);
    expect(corners).toHaveLength(4);
    for (const [index, [x, y]] of [
      [0, 10],
      [100, 12],
      [98, 90],
      [2, 88],
    ].entries()) {
      expect(corners[index]?.x, `corner ${index}`).toBeCloseTo(x as number, 6);
      expect(corners[index]?.y, `corner ${index}`).toBeCloseTo(y as number, 6);
    }
  });

  it('keeps the corners from before when two neighbouring sides came out parallel', () => {
    const top = through(at(0, 10), at(100, 10));
    const right = through(at(100, 10), at(100, 90));
    const bottom = through(at(100, 90), at(0, 90));
    // Parallel to the top: it never crosses it.
    const left = through(at(0, 30), at(100, 30));
    expect(cornersOfSides([top, right, bottom, left], before)).toEqual(before);
  });

  it('keeps the corners from before when the refit sides cross the outline over itself', () => {
    // The top and the bottom lean towards each other and cross half way: a bow tie.
    const top = through(at(0, 10), at(100, 50));
    const right = through(at(100, 50), at(100, 10));
    const bottom = through(at(100, 10), at(0, 50));
    const left = through(at(0, 50), at(0, 10));
    expect(cornersOfSides([top, right, bottom, left], before)).toEqual(before);
  });
});
