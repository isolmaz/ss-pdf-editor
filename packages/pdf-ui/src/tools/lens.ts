/**
 * The magnifier's one-frame geometry.
 *
 * The lens shows `cssSize / zoom` CSS pixels of the page around the pointer,
 * taken from the bitmap the viewer already rendered and blown up to the lens
 * size. This is the whole per-frame computation: the page bitmap is copied once
 * when the lens activates or the page/scale changes, and a frame is a single
 * scaled blit of a region — never a page render.
 *
 * Kept out of the component so the arithmetic, which mixes CSS pixels, the
 * viewer's device-pixel ratio and the lens's own backing store, can be checked
 * without a browser.
 */

export interface LensPointer {
  readonly x: number;
  readonly y: number;
}

/** The bitmap the lens blits from, and where it sits on screen (client coordinates). */
export interface LensBitmap {
  /** The page canvas; only its pixel width matters to the geometry. */
  readonly bitmap: { readonly width: number };
  readonly rect: Pick<DOMRect, 'left' | 'top' | 'width'>;
}

export interface LensFrame {
  /** Lens diameter on screen, in CSS pixels. */
  readonly cssSize: number;
  /** Lens backing store, in device pixels (`round(cssSize × devicePixelRatio)`). */
  readonly deviceSize: number;
  /** Magnification, 2×–8×. */
  readonly zoom: number;
}

/** `drawImage` arguments `[sx, sy, sw, sh, dx, dy, dw, dh]` for one lens frame. */
export type LensRegion = [number, number, number, number, number, number, number, number];

export function lensRegion(source: LensBitmap, pointer: LensPointer, frame: LensFrame): LensRegion {
  // Source pixels per CSS pixel of the page: the viewer paints at
  // `devicePixelRatio × scale`, which is the resolution the lens shows.
  const ratio = source.bitmap.width / source.rect.width;
  const field = (frame.cssSize / frame.zoom) * ratio;
  const sx = (pointer.x - source.rect.left) * ratio - field / 2;
  const sy = (pointer.y - source.rect.top) * ratio - field / 2;
  return [sx, sy, field, field, 0, 0, frame.deviceSize, frame.deviceSize];
}
