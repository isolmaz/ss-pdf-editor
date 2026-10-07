import { describe, expect, it } from 'vitest';
import { lensRegion } from './lens';

describe('lensRegion', () => {
  it('centres a source window of cssSize / zoom page pixels on the pointer', () => {
    // A 1200-pixel bitmap shown 600 CSS pixels wide at (100, 50): 2 source pixels per CSS pixel.
    const region = lensRegion(
      { bitmap: { width: 1200 }, rect: { left: 100, top: 50, width: 600 } },
      { x: 400, y: 250 },
      { cssSize: 160, deviceSize: 320, zoom: 4 },
    );
    // The window is 160 / 4 = 40 CSS px = 80 source px wide; the pointer is (300, 200) CSS px into the page.
    expect(region).toEqual([600 - 40, 400 - 40, 80, 80, 0, 0, 320, 320]);
  });

  it('follows the bitmap resolution: a bitmap of the same width as its box maps one to one', () => {
    const region = lensRegion(
      { bitmap: { width: 500 }, rect: { left: 0, top: 0, width: 500 } },
      { x: 10, y: 20 },
      { cssSize: 100, deviceSize: 100, zoom: 2 },
    );
    expect(region).toEqual([10 - 25, 20 - 25, 50, 50, 0, 0, 100, 100]);
  });
});
