/**
 * The scanner's page helpers that need no browser: corners kept as fractions of the picture,
 * a dragged handle held inside it, and the outline offered when the detector finds nothing.
 * (The page list's reorder, rotate and remove are state changes inside `ScanDialog.tsx`, not
 * functions of this module; decoding and JPEG export need a canvas and are not run here.)
 */

import type { Quad, RasterImage } from 'pdf-core/ops/scan-geometry';
import { describe, expect, it } from 'vitest';
import { moveCorner, normaliseQuad, QUALITY_PRESETS, redetect } from './scan-pages';

const quad: Quad = [
  { x: 100, y: 50 },
  { x: 500, y: 50 },
  { x: 500, y: 350 },
  { x: 100, y: 350 },
];

describe('scan page helpers', () => {
  it('stores corners as fractions of the picture and keeps a dragged corner inside it', () => {
    const fractions = normaliseQuad(quad, 1000, 500);
    expect(fractions[0].x).toBeCloseTo(0.1, 12);
    expect(fractions[0].y).toBeCloseTo(0.1, 12);
    expect(fractions[2].x).toBeCloseTo(0.5, 12);
    expect(fractions[2].y).toBeCloseTo(0.7, 12);
    // Dragged past the edge: clamped, and only that corner moves.
    const moved = moveCorner(fractions, 2, { x: 1.4, y: -0.2 });
    expect(moved[2]).toEqual({ x: 1, y: 0 });
    expect(moved[0]).toEqual(fractions[0]);
    expect(moved[1]).toEqual(fractions[1]);
    expect(moved[3]).toEqual(fractions[3]);
    // The original is not mutated.
    expect(fractions[2].y).toBeCloseTo(0.7, 12);
    expect(QUALITY_PRESETS).toEqual({ low: 0.6, medium: 0.8, high: 0.92 });
  });

  it('offers the inset outline, marked as not detected, for a picture with no page', () => {
    const blank: RasterImage = {
      width: 200,
      height: 100,
      data: new Uint8ClampedArray(200 * 100 * 4).fill(90),
    };
    const result = redetect(blank);
    expect(result.detected).toBe(false);
    // insetQuad's default margin is 6 % of each side.
    expect(result.quad[0].x).toBeCloseTo(0.06, 9);
    expect(result.quad[0].y).toBeCloseTo(0.06, 9);
    expect(result.quad[2].x).toBeCloseTo(0.94, 9);
    expect(result.quad[2].y).toBeCloseTo(0.94, 9);
  });

  it('finds a light page on a dark desk and reports its corners as fractions', () => {
    const width = 400;
    const height = 300;
    const picture: RasterImage = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const onPage = x >= 80 && x < 320 && y >= 40 && y < 260;
        picture.data.fill(onPage ? 230 : 30, (y * width + x) * 4, (y * width + x) * 4 + 3);
        picture.data[(y * width + x) * 4 + 3] = 255;
      }
    }
    const result = redetect(picture);
    expect(result.detected).toBe(true);
    const wanted = [
      [80 / width, 40 / height],
      [320 / width, 40 / height],
      [320 / width, 260 / height],
      [80 / width, 260 / height],
    ];
    for (const [index, [x, y]] of wanted.entries()) {
      expect(Math.abs((result.quad[index]?.x ?? 9) - (x as number))).toBeLessThan(0.01);
      expect(Math.abs((result.quad[index]?.y ?? 9) - (y as number))).toBeLessThan(0.01);
    }
  });
});
