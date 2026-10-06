/**
 * The browser end of the scanner: photographs in, JPEG pages out.
 *
 * `scan-image.ts` works on plain pixel arrays; this file is the only place the scanner
 * touches a canvas, so everything else stays runnable in Node. Decoding goes through
 * `createImageBitmap` with `imageOrientation: 'from-image'`, so a phone photo whose
 * pixels are stored sideways (EXIF) is the right way up before the scanner sees it.
 */

import { ToolError } from 'pdf-shared';
import type { RasterImage } from './scan-geometry';

/** The longest side a photograph is decoded at; a 48-megapixel photo is 190 MB of pixels. */
export const MAX_PHOTO_SIDE = 4096;

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null)
    throw new ToolError('out-of-memory', { engine: 'ui', engineMessage: 'no 2D canvas context' });
  return context;
}

/** What a decode reports: the pixels, and the size the file really was. */
export interface DecodedPhoto {
  readonly raster: RasterImage;
  readonly originalWidth: number;
  readonly originalHeight: number;
}

/** Decode a photograph (JPEG, PNG, WebP…) to pixels, at most `maxSide` on its long side. */
export async function decodePhoto(blob: Blob, maxSide: number = MAX_PHOTO_SIDE): Promise<DecodedPhoto> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (cause) {
    throw new ToolError('unsupported-format', {
      engine: 'ui',
      engineMessage: 'the browser could not decode the photograph',
      cause,
    });
  }
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = canvasOf(width, height);
    const context = contextOf(canvas);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    canvas.width = 0;
    canvas.height = 0;
    return {
      raster: { width, height, data: pixels.data },
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}

/** A live video frame as pixels, at most `maxSide` on its long side (for the preview's outline). */
export function frameToRaster(video: HTMLVideoElement, maxSide: number): RasterImage | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth === 0 || sourceHeight === 0) return null;
  const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = canvasOf(width, height);
  const context = contextOf(canvas);
  context.drawImage(video, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  canvas.width = 0;
  canvas.height = 0;
  return { width, height, data: pixels.data };
}

/** Paint pixels onto a canvas, sizing it to them. */
export function paintRaster(canvas: HTMLCanvasElement, raster: RasterImage): void {
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = contextOf(canvas);
  context.putImageData(
    new ImageData(raster.data as Uint8ClampedArray<ArrayBuffer>, raster.width, raster.height),
    0,
    0,
  );
}

/** A JPEG of the pixels at `quality` (0…1). */
export async function rasterToJpeg(raster: RasterImage, quality: number): Promise<Blob> {
  const canvas = canvasOf(raster.width, raster.height);
  try {
    paintRaster(canvas, raster);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob === null)
      throw new ToolError('out-of-memory', { engine: 'ui', engineMessage: 'toBlob returned nothing' });
    return blob;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
