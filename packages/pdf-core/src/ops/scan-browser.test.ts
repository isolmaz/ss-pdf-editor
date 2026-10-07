/**
 * The scanner's canvas end, with the browser's canvas objects (`document`, `createImageBitmap`,
 * `ImageData`, a 2D context) replaced by recorders: a Node run has none. What is asserted is this
 * module's own work — the decode size, the orientation option, the pixels it hands on, releasing
 * what it allocated, and the errors it names — not that a canvas draws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePhoto, frameToRaster, MAX_PHOTO_SIDE, paintRaster, rasterToJpeg } from './scan-browser';

interface Recorded {
  canvases: FakeCanvas[];
  decodes: Array<{ options: unknown }>;
  closed: number;
  noContext: boolean;
  noBlob: boolean;
  decodeFails: boolean;
  drawn: Array<{ width: number; height: number }>;
  put: Array<{ width: number; height: number; length: number }>;
}

interface FakeCanvas {
  width: number;
  height: number;
  getContext: (kind: string, options: unknown) => unknown;
  toBlob: (done: (blob: Blob | null) => void, type: string, quality: number) => void;
}

const seen: Recorded = {
  canvases: [],
  decodes: [],
  closed: 0,
  noContext: false,
  noBlob: false,
  decodeFails: false,
  drawn: [],
  put: [],
};

beforeEach(() => {
  Object.assign(seen, {
    canvases: [],
    decodes: [],
    closed: 0,
    noContext: false,
    noBlob: false,
    decodeFails: false,
    drawn: [],
    put: [],
  });
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      expect(tag).toBe('canvas');
      const canvas: FakeCanvas = {
        width: 0,
        height: 0,
        getContext: (kind, options) => {
          expect(kind).toBe('2d');
          expect(options).toEqual({ willReadFrequently: true });
          if (seen.noContext) return null;
          return {
            imageSmoothingQuality: 'low',
            drawImage: (_source: unknown, _x: number, _y: number, width: number, height: number) => {
              seen.drawn.push({ width, height });
            },
            getImageData: (_x: number, _y: number, width: number, height: number) => ({
              data: new Uint8ClampedArray(width * height * 4).fill(7),
            }),
            putImageData: (image: { width: number; height: number; data: Uint8ClampedArray }) => {
              seen.put.push({ width: image.width, height: image.height, length: image.data.length });
            },
          };
        },
        toBlob: (done, type, quality) => {
          done(seen.noBlob ? null : new Blob([`${type}@${quality}`], { type }));
        },
      };
      seen.canvases.push(canvas);
      return canvas;
    },
  });
  vi.stubGlobal('createImageBitmap', async (_blob: Blob, options: unknown) => {
    seen.decodes.push({ options });
    if (seen.decodeFails) throw new Error('cannot decode');
    return {
      width: 8000,
      height: 4000,
      close: () => {
        seen.closed += 1;
      },
    };
  });
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodePhoto', () => {
  it('decodes upright (EXIF applied), shrinks the long side to the limit, and hands on the pixels and the true size', async () => {
    const decoded = await decodePhoto(new Blob(['x']));
    expect(seen.decodes).toEqual([{ options: { imageOrientation: 'from-image' } }]);
    expect(MAX_PHOTO_SIDE).toBe(4096);
    expect(seen.drawn).toEqual([{ width: 4096, height: 2048 }]);
    expect(decoded.raster.width).toBe(4096);
    expect(decoded.raster.height).toBe(2048);
    expect(decoded.raster.data.length).toBe(4096 * 2048 * 4);
    expect([decoded.originalWidth, decoded.originalHeight]).toEqual([8000, 4000]);
    // The bitmap is released, and the canvas backing store with it.
    expect(seen.closed).toBe(1);
    expect([seen.canvases[0]?.width, seen.canvases[0]?.height]).toEqual([0, 0]);
  });

  it('does not enlarge a photograph already below the limit', async () => {
    await decodePhoto(new Blob(['x']), 10_000);
    expect(seen.drawn).toEqual([{ width: 8000, height: 4000 }]);
  });

  it('reports a photograph the browser cannot decode, keeping the cause', async () => {
    seen.decodeFails = true;
    const failure = await decodePhoto(new Blob(['x'])).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'unsupported-format' });
    expect((failure as Error).cause).toMatchObject({ message: 'cannot decode' });
    expect(seen.closed).toBe(0);
  });

  it('reports a canvas without a 2D context as out of memory, and still releases the bitmap', async () => {
    seen.noContext = true;
    await expect(decodePhoto(new Blob(['x']))).rejects.toMatchObject({ code: 'out-of-memory' });
    expect(seen.closed).toBe(1);
  });
});

describe('frameToRaster', () => {
  const video = (width: number, height: number) =>
    ({ videoWidth: width, videoHeight: height }) as HTMLVideoElement;

  it('answers nothing for a video that has no frame yet', () => {
    expect(frameToRaster(video(0, 480), 640)).toBeNull();
    expect(frameToRaster(video(640, 0), 640)).toBeNull();
    expect(seen.canvases).toEqual([]);
  });

  it('reads the frame at most maxSide on its long side, and releases the canvas', () => {
    const raster = frameToRaster(video(1280, 720), 640);
    expect([raster?.width, raster?.height]).toEqual([640, 360]);
    expect(seen.drawn).toEqual([{ width: 640, height: 360 }]);
    expect([seen.canvases[0]?.width, seen.canvases[0]?.height]).toEqual([0, 0]);
    expect(frameToRaster(video(100, 50), 640)?.width).toBe(100);
  });

  it('refuses a canvas without a 2D context', () => {
    seen.noContext = true;
    expect(() => frameToRaster(video(100, 50), 640)).toThrow(
      expect.objectContaining({ code: 'out-of-memory' }),
    );
  });
});

describe('paintRaster and rasterToJpeg', () => {
  const raster = { width: 3, height: 2, data: new Uint8ClampedArray(3 * 2 * 4) };

  it('sizes the canvas to the pixels and puts them on it', () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ putImageData: () => undefined }) };
    paintRaster(canvas as unknown as HTMLCanvasElement, raster);
    expect([canvas.width, canvas.height]).toEqual([3, 2]);
  });

  it('encodes a JPEG at the quality asked for and releases the canvas', async () => {
    const blob = await rasterToJpeg(raster, 0.8);
    expect(blob.type).toBe('image/jpeg');
    expect(await blob.text()).toBe('image/jpeg@0.8');
    expect(seen.put).toEqual([{ width: 3, height: 2, length: 24 }]);
    expect([seen.canvases[0]?.width, seen.canvases[0]?.height]).toEqual([0, 0]);
  });

  it('reports a canvas that produced no picture as out of memory, and still releases it', async () => {
    seen.noBlob = true;
    await expect(rasterToJpeg(raster, 0.8)).rejects.toMatchObject({ code: 'out-of-memory' });
    expect([seen.canvases[0]?.width, seen.canvases[0]?.height]).toEqual([0, 0]);
  });
});
