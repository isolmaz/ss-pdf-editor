/**
 * The scanner's pixels: the warp that straightens a page and the three filters. The wrong
 * answers that matter: a pattern that lands in the wrong place or the wrong quarter turn, desk
 * showing where the sheet ends, a page lit from one side that comes out half black in
 * black-and-white, an enhanced page whose ink turned grey or whose colour was lost.
 */

import { describe, expect, it } from 'vitest';
import type { Quad, RasterImage } from './scan-geometry';
import {
  applyBlackAndWhite,
  applyEnhanced,
  applyGrayscale,
  createRaster,
  renderScanPage,
  warpPage,
} from './scan-image';

function fill(
  image: RasterImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  [r, g, b]: readonly [number, number, number],
): void {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * image.width + x) * 4;
      image.data[at] = r;
      image.data[at + 1] = g;
      image.data[at + 2] = b;
      image.data[at + 3] = 255;
    }
  }
}

const pixel = (image: RasterImage, x: number, y: number): number[] => {
  const at = (y * image.width + x) * 4;
  return [image.data[at] as number, image.data[at + 1] as number, image.data[at + 2] as number];
};

/**
 * A 600 x 800 photograph: a dark desk, a 400 x 600 sheet at (100, 100), a red square in the
 * sheet's top-left corner (sheet pixels 10..70) and a blue one in its bottom-right.
 */
function photograph(): { readonly source: RasterImage; readonly quad: Quad } {
  const source = createRaster(600, 800);
  fill(source, 0, 0, 600, 800, [40, 40, 40]);
  fill(source, 100, 100, 500, 700, [240, 240, 240]);
  fill(source, 110, 110, 170, 170, [255, 0, 0]);
  fill(source, 430, 630, 490, 690, [0, 0, 255]);
  const quad: Quad = [
    { x: 100, y: 100 },
    { x: 500, y: 100 },
    { x: 500, y: 700 },
    { x: 100, y: 700 },
  ];
  return { source, quad };
}

const near = (actual: readonly number[], expected: readonly number[], tolerance: number): void => {
  for (const [index, value] of actual.entries()) {
    expect(Math.abs(value - (expected[index] as number))).toBeLessThanOrEqual(tolerance);
  }
};

describe('warpPage', () => {
  it('cuts the sheet out at its own size with the pattern where it was', () => {
    const { source, quad } = photograph();
    const warped = warpPage(source, quad, 0, 2600);
    expect(warped).not.toBeNull();
    if (warped === null) return;
    const { image } = warped;
    expect([image.width, image.height]).toEqual([400, 600]);
    expect(warped.reduction).toBe(1);
    near(pixel(image, 40, 40), [255, 0, 0], 2);
    near(pixel(image, 360, 560), [0, 0, 255], 2);
    near(pixel(image, 200, 300), [240, 240, 240], 2);
    // No desk at the borders: the warp samples just inside the outline.
    for (const [x, y] of [
      [0, 0],
      [399, 0],
      [399, 599],
      [0, 599],
      [200, 0],
      [0, 300],
    ] as const) {
      expect(pixel(image, x, y)[0]).toBeGreaterThan(200);
    }
  });

  it('applies quarter turns clockwise and turns a larger source down to the long side', () => {
    const { source, quad } = photograph();
    const turned = warpPage(source, quad, 1, 2600);
    if (turned === null) throw new Error('warp');
    expect([turned.image.width, turned.image.height]).toEqual([600, 400]);
    // Clockwise: the top-left red square goes to the top-right, the blue one to the bottom-left.
    near(pixel(turned.image, 560, 40), [255, 0, 0], 2);
    near(pixel(turned.image, 40, 360), [0, 0, 255], 2);
    const half = warpPage(source, quad, 2, 2600);
    near(pixel((half as NonNullable<typeof half>).image, 360, 560), [255, 0, 0], 2);

    const small = warpPage(source, quad, 0, 300);
    if (small === null) throw new Error('warp');
    expect([small.image.width, small.image.height]).toEqual([200, 300]);
    expect(small.reduction).toBe(2);
    // The red square covers sheet pixels 10..70 of 400: output pixels 5..35 of 200.
    near(pixel(small.image, 20, 20), [255, 0, 0], 2);
    near(pixel(small.image, 100, 150), [240, 240, 240], 2);
  });

  it('fills what lies outside the photograph with white and refuses an outline with no area', () => {
    const { source } = photograph();
    // The left edge of the outline is 100 px left of the picture.
    const overhang: Quad = [
      { x: -100, y: 100 },
      { x: 500, y: 100 },
      { x: 500, y: 700 },
      { x: -100, y: 700 },
    ];
    const warped = warpPage(source, overhang, 0, 2600);
    if (warped === null) throw new Error('warp');
    expect(warped.image.width).toBe(600);
    expect(pixel(warped.image, 50, 300)).toEqual([255, 255, 255]);
    // Source pixels (the paper) start where the picture does, 100 px in.
    near(pixel(warped.image, 300, 300), [240, 240, 240], 2);
    const flat: Quad = [
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 500, y: 100 },
      { x: 600, y: 100 },
    ];
    expect(warpPage(source, flat, 0, 2600)).toBeNull();
    expect(renderScanPage(source, flat, 0, 'bw', 2600)).toBeNull();
  });
});

describe('scan filters', () => {
  it('grayscale is the Rec. 601 luma in all three channels', () => {
    const image = createRaster(3, 1);
    fill(image, 0, 0, 1, 1, [255, 0, 0]);
    fill(image, 1, 0, 2, 1, [0, 255, 0]);
    fill(image, 2, 0, 3, 1, [0, 0, 255]);
    applyGrayscale(image);
    // 0.299 * 255 = 76.2, 0.587 * 255 = 149.7, 0.114 * 255 = 29.1, rounded by the clamped array.
    expect(pixel(image, 0, 0)).toEqual([76, 76, 76]);
    expect(pixel(image, 1, 0)).toEqual([150, 150, 150]);
    expect(pixel(image, 2, 0)).toEqual([29, 29, 29]);
  });

  /** A 200 x 120 page lit from the left (paper 120) to the right (paper 230) with a black bar of text. */
  function litPage(): RasterImage {
    const image = createRaster(200, 120);
    for (let x = 0; x < 200; x += 1) {
      const paper = Math.round(120 + (110 * x) / 199);
      fill(image, x, 0, x + 1, 120, [paper, paper, paper]);
    }
    // Strokes of ink: 3 px wide, one on the dark side, one on the bright side, at 60 % of the local paper.
    for (const x of [30, 160]) {
      const ink = Math.round((120 + (110 * x) / 199) * 0.4);
      fill(image, x, 20, x + 3, 100, [ink, ink, ink]);
    }
    return image;
  }

  it('black and white follows the lighting: paper white on both sides, ink black', () => {
    const image = litPage();
    applyBlackAndWhite(image);
    const values = new Set<number>();
    for (let index = 0; index < image.data.length; index += 4) values.add(image.data[index] as number);
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
    // The dark side's paper is darker than the bright side's ink would be under a global threshold.
    expect(pixel(image, 10, 60)).toEqual([255, 255, 255]);
    expect(pixel(image, 100, 60)).toEqual([255, 255, 255]);
    expect(pixel(image, 190, 60)).toEqual([255, 255, 255]);
    expect(pixel(image, 31, 60)).toEqual([0, 0, 0]);
    expect(pixel(image, 161, 60)).toEqual([0, 0, 0]);
  });

  it('enhanced evens the lighting, whitens the paper and keeps ink dark and colour coloured', () => {
    const image = litPage();
    // A red stamp on the bright side.
    fill(image, 120, 40, 140, 70, [200, 30, 30]);
    applyEnhanced(image);
    // Paper far from ink: the sheet runs from 120 to 230 across (a lit side). The brightness
    // is estimated over a window of a sixth of the page each side, so the darkest edge is
    // not made fully white (it measures 224), but the 110 levels of difference shrink to
    // under 35 and no paper is left darker than 215.
    const paper = [5, 60, 100, 150, 195].map((x) => pixel(image, x, 10));
    for (const channels of paper) {
      expect(channels[0]).toBe(channels[1]);
      expect(channels[0]).toBeGreaterThanOrEqual(215);
    }
    const levels = paper.map((channels) => channels[0] as number);
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThan(35);
    // Ink stays dark.
    for (const x of [31, 161]) expect(Math.max(...pixel(image, x, 60))).toBeLessThan(60);
    // The stamp is still red: not grey, not cyan.
    const [red, green, blue] = pixel(image, 130, 55) as [number, number, number];
    expect(red).toBeGreaterThan(green + 80);
    expect(red).toBeGreaterThan(blue + 80);
  });
});
