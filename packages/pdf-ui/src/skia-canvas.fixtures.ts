/**
 * The 2D surface a browser gives pdf.js and the dialogs, for a Node unit run: the Skia canvas
 * pdf.js itself uses in Node (`@napi-rs/canvas`, an optional dependency of `pdfjs-dist`). The
 * pixels are really drawn and really encoded; only the DOM objects around them
 * (`OffscreenCanvas`, `document.createElement('canvas')`, `createImageBitmap`) are stand-ins.
 */

import { createRequire } from 'node:module';
// `URL` is Node's own: a DOM environment (happy-dom) replaces the global one with a page-relative class.
import { URL as NodeURL } from 'node:url';

type Mime = 'image/png' | 'image/jpeg' | 'image/webp';

interface SkiaCanvas {
  width: number;
  height: number;
  getContext(kind: '2d', options?: object): unknown;
  toBuffer(mime: Mime, quality?: number): Uint8Array;
  toDataURL(mime: string, quality?: number): string;
}

interface SkiaImage {
  readonly width: number;
  readonly height: number;
}

interface Skia {
  createCanvas(width: number, height: number): SkiaCanvas;
  loadImage(source: Uint8Array): Promise<SkiaImage>;
  ImageData: unknown;
  Path2D: unknown;
}

const coreRequire = createRequire(new NodeURL('../../pdf-core/package.json', import.meta.url));
export const skia = createRequire(coreRequire.resolve('pdfjs-dist/package.json'))('@napi-rs/canvas') as Skia;

const encode = (canvas: SkiaCanvas, type: string, quality: number): Blob => {
  const mime = type as Mime;
  return new Blob(
    [new Uint8Array(canvas.toBuffer(mime, mime === 'image/png' ? undefined : Math.round(quality * 100)))],
    {
      type,
    },
  );
};

/** A Skia canvas with what a DOM canvas element has on top: `style` and `toBlob`. */
export function skiaElement() {
  const canvas = skia.createCanvas(1, 1);
  return Object.assign(canvas, {
    style: {},
    toBlob(done: (blob: Blob | null) => void, type = 'image/png', quality = 0.92) {
      done(encode(canvas, type, quality));
    },
  });
}

/** A `document` whose only job is `createElement('canvas')`. */
export const skiaDocument = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error(`the stand-in document makes canvases only, not <${tag}>`);
    return skiaElement();
  },
};

/**
 * `OffscreenCanvas`: a Skia canvas that also encodes with `convertToBlob`. A constructor that
 * returns the canvas itself, so the object a dialog draws into another canvas is a real Skia
 * surface.
 */
export const SkiaOffscreen = function SkiaOffscreen(width: number, height: number) {
  const canvas = skia.createCanvas(width, height);
  return Object.assign(canvas, {
    convertToBlob: async (options: { type: string; quality?: number }) =>
      encode(canvas, options.type, options.quality ?? 0.92),
  });
} as unknown as new (
  width: number,
  height: number,
) => SkiaCanvas;

/** `createImageBitmap(blob)`: decodes with Skia, refusing what it cannot decode as a browser does. */
export async function skiaImageBitmap(blob: Blob): Promise<SkiaImage & { close(): void }> {
  const image = await skia.loadImage(new Uint8Array(await blob.arrayBuffer()));
  return Object.assign(image, { close: () => undefined });
}
