/**
 * The page detector on pictures drawn in the test: a light sheet on a dark desk, turned and
 * seen in perspective. The wrong answers that matter: corners that are several pixels off
 * (the warp then shows desk or cuts paper), an outline invented for a picture with no page
 * in it, and corners returned in an order the rest of the scanner cannot use.
 */

import { describe, expect, it, vi } from 'vitest';
import { detectPage, WORKING_SIZE } from './scan-detect';
import { distance, type Point, type Quad, type RasterImage } from './scan-geometry';

// Each case finds a sheet in a full-size photograph: about a second alone, several under the
// coverage run on a loaded core.
vi.setConfig({ testTimeout: 30_000 });

/** Whether `point` lies inside the convex polygon (any winding). */
function inside(polygon: readonly Point[], x: number, y: number): boolean {
  let sign = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index] as Point;
    const b = polygon[(index + 1) % polygon.length] as Point;
    const turn = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (turn === 0) continue;
    const current = turn > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (sign !== current) return false;
  }
  return true;
}

/**
 * `paper` inside the quad, `desk` outside, edges antialiased (4 x 4 coverage) as a camera's
 * are, plus a deterministic grain so it is not a flat fill. A hard-edged staircase is not
 * what a photograph looks like: its edge pixels split between two Hough distance bins and a
 * tilted side can fall below the detector's vote floor; `grid = 1` draws one on purpose.
 */
function drawPage(width: number, height: number, quad: Quad, paper = 225, desk = 35, grid = 4): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < grid; sy += 1) {
        for (let sx = 0; sx < grid; sx += 1) {
          if (inside(quad, x + (sx + 0.5) / grid, y + (sy + 0.5) / grid)) covered += 1;
        }
      }
      const grain = ((x * 7 + y * 13) % 5) - 2;
      const value = desk + ((paper - desk) * covered) / (grid * grid) + grain;
      const at = (y * width + x) * 4;
      data[at] = value;
      data[at + 1] = value;
      data[at + 2] = value;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Each true corner has a detected one within `tolerance` px, in the same role. */
function expectCorners(found: Quad, wanted: Quad, tolerance: number): void {
  for (const [index, corner] of wanted.entries()) {
    expect(distance(found[index] as Point, corner)).toBeLessThan(tolerance);
  }
}

describe('detectPage', () => {
  it('finds a turned sheet within a few pixels, corners in reading order', () => {
    const wanted: Quad = [
      { x: 150, y: 60 },
      { x: 390, y: 105 },
      { x: 340, y: 330 },
      { x: 100, y: 285 },
    ];
    const found = detectPage(drawPage(480, 360, wanted));
    expect(found).not.toBeNull();
    if (found === null) return;
    // The picture is 480 px wide, so the detector works at 400/480 of it; the corners come
    // out within about a pixel, and 3 leaves room for the quantisation without hiding a miss.
    expectCorners(found.quad, wanted, 3);
    expect(found.confidence).toBeGreaterThan(0.3);
  });

  it('finds a sheet seen in perspective, in a picture larger than the working size', {
    timeout: 60_000,
  }, () => {
    const width = 1200;
    const height = 900;
    expect(width).toBeGreaterThan(WORKING_SIZE);
    // Wider at the bottom than at the top, as a page tilted away from the lens is.
    const wanted: Quad = [
      { x: 330, y: 150 },
      { x: 860, y: 130 },
      { x: 990, y: 790 },
      { x: 180, y: 760 },
    ];
    const found = detectPage(drawPage(width, height, wanted));
    expect(found).not.toBeNull();
    if (found === null) return;
    // Working scale is one third: a corner is good to a pixel there, so to about 3 here.
    expectCorners(found.quad, wanted, 6);
  });

  it('finds a sheet at any turn, antialiased or hard-edged (votes split between bins)', {
    timeout: 60_000,
  }, () => {
    /** A 240 x 220 sheet turned `degrees` about the picture's centre. */
    const turned = (degrees: number): Quad => {
      const r = (degrees * Math.PI) / 180;
      return [
        [-120, -110],
        [120, -110],
        [120, 110],
        [-120, 110],
      ].map(([x, y]) => ({
        x: 240 + (x as number) * Math.cos(r) - (y as number) * Math.sin(r),
        y: 180 + (x as number) * Math.sin(r) + (y as number) * Math.cos(r),
      })) as unknown as Quad;
    };
    // 45° failed in both drawings, and 5°, 40° and 80° hard-edged, before the peak was
    // read over three distance bins and the vote spread widened to 6°.
    for (const degrees of [5, 40, 45, 80]) {
      for (const grid of [4, 1]) {
        const wanted = turned(degrees);
        const found = detectPage(drawPage(480, 360, wanted, 225, 35, grid));
        expect(found, `${degrees}° grid ${grid}`).not.toBeNull();
        if (found === null) continue;
        for (const corner of wanted) {
          const nearest = Math.min(...found.quad.map((point) => distance(point, corner)));
          expect(nearest, `${degrees}° grid ${grid}`).toBeLessThan(3);
        }
      }
    }
  });

  it('offers nothing for a picture with no page in it', () => {
    const grain = drawPage(480, 360, [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
    expect(detectPage(grain)).toBeNull();
    // A smooth lighting gradient has no edge to find either.
    const gradient: RasterImage = { width: 480, height: 360, data: new Uint8ClampedArray(480 * 360 * 4) };
    for (let y = 0; y < 360; y += 1) {
      for (let x = 0; x < 480; x += 1) {
        const at = (y * 480 + x) * 4;
        const value = 60 + x / 4;
        gradient.data[at] = value;
        gradient.data[at + 1] = value;
        gradient.data[at + 2] = value;
        gradient.data[at + 3] = 255;
      }
    }
    expect(detectPage(gradient)).toBeNull();
    // Too small to say anything.
    expect(detectPage({ width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) })).toBeNull();
  });
});
