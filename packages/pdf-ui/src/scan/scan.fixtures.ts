/**
 * Stand-ins for the scanner's canvas end, for the tests that run in Node or happy-dom, which
 * have no canvas and no image decoder. A "photograph" is a `Blob` whose text says what it
 * shows (`page:400x300`: a light page on a dark desk, `plain:400x300`: one grey with no
 * page, `broken`: a file no decoder opens); the fake decode turns that into real pixels,
 * so the page detector, the warp and the filters the scanner runs on them are the real ones.
 */

import type { RasterImage } from 'pdf-core/ops/scan-geometry';

export type PhotoKind = 'page' | 'plain';

/** A photograph the fake decoder understands. */
export function photo(kind: PhotoKind, width = 400, height = 300): Blob {
  return new Blob([`${kind}:${width}x${height}`], { type: 'image/jpeg' });
}

/** A file the fake decoder refuses, as a browser refuses a text file renamed `.jpg`. */
export function brokenPhoto(): Blob {
  return new Blob(['broken'], { type: 'image/jpeg' });
}

export interface PageFractions {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Where the page is in a `page` photograph, as fractions of its width and height. */
export const PAGE_FRACTIONS: PageFractions = { left: 0.2, top: 40 / 300, right: 0.8, bottom: 260 / 300 };

/** A light page on a dark desk (`page`), or a uniform grey the detector finds nothing in (`plain`). */
export function rasterOf(
  kind: PhotoKind,
  width: number,
  height: number,
  at: PageFractions = PAGE_FRACTIONS,
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const left = Math.round(width * at.left);
  const right = Math.round(width * at.right);
  const top = Math.round(height * at.top);
  const bottom = Math.round(height * at.bottom);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onPage = kind === 'page' && x >= left && x < right && y >= top && y < bottom;
      const at = (y * width + x) * 4;
      data.fill(kind === 'plain' ? 90 : onPage ? 230 : 30, at, at + 3);
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

/** What `decodePhoto` answers for a fake photograph. Rejects the way the real one does for a broken file. */
export async function decodeFake(blob: Blob): Promise<{
  readonly raster: RasterImage;
  readonly originalWidth: number;
  readonly originalHeight: number;
}> {
  const text = await blob.text();
  const match = /^(page|plain):(\d+)x(\d+)$/.exec(text);
  if (match === null) throw new Error('the browser could not decode the photograph');
  const width = Number(match[2]);
  const height = Number(match[3]);
  return {
    raster: rasterOf(match[1] as PhotoKind, width, height),
    originalWidth: width,
    originalHeight: height,
  };
}
