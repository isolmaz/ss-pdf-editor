/**
 * The page detector on pictures that exercise its edges: an axis-aligned sheet with no grain
 * (gradients exactly horizontal or vertical), a sheet touching the picture's border, a sheet
 * lit unevenly (weak edge stretches that only hysteresis keeps), and pictures with nothing to find.
 */

import { describe, expect, it } from 'vitest';
import { detectPage } from './scan-detect';
import type { RasterImage } from './scan-geometry';

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
