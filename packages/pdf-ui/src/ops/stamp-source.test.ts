/**
 * The pictures a stamp is made of. The canvas work runs on the Skia canvas pdf.js itself uses in
 * Node (`skia-canvas.fixtures`), so pixels are really drawn, read, trimmed and encoded; only the
 * DOM objects around them (`document`, `createImageBitmap`, `FontFace`) are stand-ins.
 *
 * Also: whether an added JPEG is embedded as it is or re-encoded upright (the EXIF orientation
 * read in `stamp-source.ts`). A camera file whose EXIF offsets point past its bytes must not
 * stop the picture from being added; it is re-encoded from what the browser decoded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mupdfForTests } from '../pdf-fixtures';
import { skia, skiaElement, skiaImageBitmap } from '../skia-canvas.fixtures';
import {
  bytesOfDataUrl,
  HANDWRITING_FACES,
  imageFromFile,
  inkFromPhoto,
  jpegIsTurned,
  trimmedPng,
} from './stamp-source';

/** SOI, one APP1 "Exif" segment over a little-endian TIFF header, then SOS. */
function jpegWithExif(options: { orientation?: number; ifdOffset?: number; otherTag?: boolean }): Blob {
  const entries: [number, number][] = [];
  if (options.otherTag === true) entries.push([0x0100, 640]);
  if (options.orientation !== undefined) entries.push([0x0112, options.orientation]);
  const tiff = [0x49, 0x49, 0x2a, 0x00, ...le32(options.ifdOffset ?? 8), ...le16(entries.length)];
  for (const [tag, value] of entries) tiff.push(...le16(tag), ...le16(3), ...le32(1), ...le16(value), 0, 0);
  tiff.push(...le32(0));
  const app1 = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  return new Blob([
    new Uint8Array([0xff, 0xd8, 0xff, 0xe1, ...be16(app1.length + 2), ...app1, 0xff, 0xda, 0x00, 0x02]),
  ]);
}

const le16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const le32 = (value: number) => [...le16(value & 0xffff), ...le16((value >>> 16) & 0xffff)];
const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const blobOf = (bytes: number[]) => new Blob([new Uint8Array(bytes)]);

describe('jpegIsTurned', () => {
  it('reads the orientation tag: 1 is upright, anything else turns or mirrors', async () => {
    expect(await jpegIsTurned(jpegWithExif({ orientation: 1 }))).toBe(false);
    expect(await jpegIsTurned(jpegWithExif({ orientation: 6 }))).toBe(true);
    expect(await jpegIsTurned(jpegWithExif({}))).toBe(false);
  });

  it('finds the orientation behind another tag of the same block', async () => {
    expect(await jpegIsTurned(jpegWithExif({ otherTag: true, orientation: 8 }))).toBe(true);
    expect(await jpegIsTurned(jpegWithExif({ otherTag: true, orientation: 1 }))).toBe(false);
    expect(await jpegIsTurned(jpegWithExif({ otherTag: true }))).toBe(false);
  });

  it('re-encodes, rather than fails, when the EXIF offsets point past the bytes', async () => {
    await expect(jpegIsTurned(jpegWithExif({ orientation: 1, ifdOffset: 0x7fff_0000 }))).resolves.toBe(true);
    await expect(jpegIsTurned(jpegWithExif({ orientation: 1, ifdOffset: 30 }))).resolves.toBe(true);
  });

  it('is upright where there is nothing to read the orientation from', async () => {
    // Not a marker at the first segment.
    expect(await jpegIsTurned(blobOf([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]))).toBe(false);
    // The picture starts (SOS) before any EXIF block.
    expect(await jpegIsTurned(blobOf([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBe(false);
    // A non-EXIF APP1 (XMP) segment, then the picture.
    const xmp = [0x68, 0x74, 0x74, 0x70];
    expect(
      await jpegIsTurned(blobOf([0xff, 0xd8, 0xff, 0xe1, ...be16(xmp.length + 2), ...xmp, 0xff, 0xda, 0, 2])),
    ).toBe(false);
    // An APP1 so near the end that its identifier is cut off, and a file that ends in segments.
    expect(await jpegIsTurned(blobOf([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02]))).toBe(false);
    expect(await jpegIsTurned(blobOf([0xff, 0xd8]))).toBe(false);
  });
});

describe('bytesOfDataUrl', () => {
  it('decodes the base64 after the comma', () => {
    expect(Array.from(bytesOfDataUrl('data:image/png;base64,AAEC'))).toEqual([0, 1, 2]);
  });

  it('is empty for text that is not a data URL', () => {
    expect(Array.from(bytesOfDataUrl('not a data url'))).toEqual([]);
  });
});

describe('loadHandwritingFonts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does nothing where there are no web fonts, and is the same promise on a second ask', async () => {
    vi.resetModules();
    const { loadHandwritingFonts } = await import('./stamp-source');
    const first = loadHandwritingFonts();
    await expect(first).resolves.toBeUndefined();
    expect(loadHandwritingFonts()).toBe(first);
  });

  it('does nothing where there is a font API but no document', async () => {
    const loaded: string[] = [];
    vi.stubGlobal(
      'FontFace',
      class {
        constructor(family: string) {
          loaded.push(family);
        }
      },
    );
    vi.stubGlobal('document', undefined);
    vi.resetModules();
    const { loadHandwritingFonts } = await import('./stamp-source');
    await loadHandwritingFonts();
    expect(loaded).toEqual([]);
  });

  it('registers both faces in both subsets once, and leaves out a face that fails to load', async () => {
    const made: { family: string; source: string; descriptors: { unicodeRange: string; display: string } }[] =
      [];
    const added: string[] = [];
    vi.stubGlobal(
      'FontFace',
      class {
        readonly family: string;
        readonly source: string;
        constructor(family: string, source: string, descriptors: { unicodeRange: string; display: string }) {
          this.family = family;
          this.source = source;
          made.push({ family, source, descriptors });
        }
        async load() {
          if (this.source.includes('great-vibes-latin-ext')) throw new Error('404');
          return this;
        }
      },
    );
    vi.stubGlobal('document', { fonts: { add: (face: { family: string }) => added.push(face.family) } });
    vi.resetModules();
    const { loadHandwritingFonts } = await import('./stamp-source');
    await loadHandwritingFonts();
    await loadHandwritingFonts();
    expect(made.map((face) => [face.family, face.source])).toEqual([
      ['SsSignatureDancing', 'url(/fonts/handwriting/dancing-script-latin-400-normal.woff2)'],
      ['SsSignatureDancing', 'url(/fonts/handwriting/dancing-script-latin-ext-400-normal.woff2)'],
      ['SsSignatureVibes', 'url(/fonts/handwriting/great-vibes-latin-400-normal.woff2)'],
      ['SsSignatureVibes', 'url(/fonts/handwriting/great-vibes-latin-ext-400-normal.woff2)'],
    ]);
    expect(made.map((face) => face.descriptors.display)).toEqual(['block', 'block', 'block', 'block']);
    expect(made[0]?.descriptors.unicodeRange).toContain('U+0131');
    expect(made[1]?.descriptors.unicodeRange).toContain('U+0100-02BA');
    expect(added).toEqual(['SsSignatureDancing', 'SsSignatureDancing', 'SsSignatureVibes']);
    expect(HANDWRITING_FACES.map((face) => face.family)).toEqual(['SsSignatureDancing', 'SsSignatureVibes']);
  });
});

/** The size and pixels of an encoded picture, decoded by Skia. */
async function pixelsOf(bytes: Uint8Array) {
  const image = await skia.loadImage(bytes);
  const canvas = skia.createCanvas(image.width, image.height);
  const context = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  context.drawImage(image as unknown as CanvasImageSource, 0, 0);
  const data = context.getImageData(0, 0, image.width, image.height).data;
  return {
    width: image.width,
    height: image.height,
    at: (x: number, y: number) =>
      Array.from(data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)),
  };
}

/** A transparent canvas of the given size, with `paint` run on its context. */
function canvasOf(width: number, height: number, paint: (context: CanvasRenderingContext2D) => void) {
  const canvas = skia.createCanvas(width, height);
  paint(canvas.getContext('2d') as unknown as CanvasRenderingContext2D);
  return canvas as unknown as HTMLCanvasElement;
}

/** An encoded picture of white paper with `paint` drawn on it. */
function photoOf(width: number, height: number, paint: (context: CanvasRenderingContext2D) => void): Blob {
  const canvas = skia.createCanvas(width, height);
  const context = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  paint(context);
  return new Blob([new Uint8Array(canvas.toBuffer('image/png'))], { type: 'image/png' });
}

const near = (actual: number[], expected: number[], tolerance = 2) =>
  actual.every((value, at) => Math.abs(value - (expected[at] as number)) <= tolerance);

const closed = { count: 0 };
const makeElement = { nullContext: false, failEncode: false };

beforeEach(() => {
  closed.count = 0;
  makeElement.nullContext = false;
  makeElement.failEncode = false;
  vi.stubGlobal('document', {
    createElement: () => {
      const element = skiaElement();
      if (makeElement.nullContext) element.getContext = () => null;
      if (makeElement.failEncode) element.toBlob = (done) => done(null);
      return element;
    },
  });
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const bitmap = await skiaImageBitmap(blob);
    return Object.assign(bitmap, {
      close: () => {
        closed.count += 1;
      },
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('trimmedPng', () => {
  it('cuts a drawn signature to its ink plus a margin of one percent of the larger side', async () => {
    const source = canvasOf(300, 100, (context) => {
      context.fillStyle = '#000000';
      context.fillRect(100, 40, 60, 20);
    });
    const stamp = await trimmedPng(source, 'signature');
    // Ink 60 x 20 at (100, 40); margin round(300 * 0.01) = 3 on every side.
    expect(stamp).toMatchObject({ role: 'signature', pixelWidth: 66, pixelHeight: 26 });
    const bytes = stamp?.bytes ?? new Uint8Array();
    expect(Array.from(bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect(stamp?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const picture = await pixelsOf(bytes);
    expect([picture.width, picture.height]).toEqual([66, 26]);
    expect(picture.at(0, 0)[3]).toBe(0);
    expect(picture.at(33, 13)).toEqual([0, 0, 0, 255]);
    expect(Array.from(bytesOfDataUrl(stamp?.dataUrl ?? ''))).toEqual(Array.from(bytes));
  });

  it('keeps the margin inside the canvas when the ink touches its edges', async () => {
    const source = canvasOf(100, 50, (context) => {
      context.fillStyle = '#000000';
      context.fillRect(0, 0, 100, 50);
    });
    expect(await trimmedPng(source, 'initials')).toMatchObject({
      role: 'initials',
      pixelWidth: 100,
      pixelHeight: 50,
    });
  });

  it('has nothing to give for an empty canvas, or for ink too faint to see', async () => {
    expect(
      await trimmedPng(
        canvasOf(100, 50, () => undefined),
        'signature',
      ),
    ).toBeNull();
    const faint = canvasOf(100, 50, (context) => {
      context.fillStyle = 'rgba(0, 0, 0, 0.02)';
      context.fillRect(10, 10, 20, 20);
    });
    expect(await trimmedPng(faint, 'signature')).toBeNull();
  });

  it('has nothing to give when the canvas gives no context to read', async () => {
    const source = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(await trimmedPng(source, 'signature')).toBeNull();
  });

  it('fails with a sentence when the trimmed picture cannot be encoded', async () => {
    makeElement.failEncode = true;
    const source = canvasOf(30, 30, (context) => context.fillRect(5, 5, 10, 10));
    await expect(trimmedPng(source, 'signature')).rejects.toThrow('the canvas could not be encoded');
  });
});

describe('inkFromPhoto', () => {
  const stripe = (context: CanvasRenderingContext2D) => {
    context.fillStyle = '#141414';
    context.fillRect(100, 50, 200, 100);
  };

  it('makes the paper transparent and the ink the chosen colour, trimmed to the ink', async () => {
    const stamp = await inkFromPhoto(photoOf(400, 200, stripe), 50, '#1d4ed8', 'signature');
    // Ink 200 x 100 at (100, 50); margin round(400 * 0.01) = 4.
    expect(stamp).toMatchObject({ role: 'signature', pixelWidth: 208, pixelHeight: 108 });
    const picture = await pixelsOf(stamp?.bytes ?? new Uint8Array());
    expect(picture.at(0, 0)[3]).toBe(0);
    const inside = picture.at(100, 50);
    expect(near(inside.slice(0, 3), [29, 78, 216])).toBe(true);
    expect(inside[3]).toBeGreaterThan(200);
    expect(closed.count).toBe(1);
  });

  it('writes the ink near-black when the colour is not a #rrggbb value', async () => {
    const stamp = await inkFromPhoto(photoOf(400, 200, stripe), 50, 'blue', 'initials');
    const picture = await pixelsOf(stamp?.bytes ?? new Uint8Array());
    expect(near(picture.at(100, 50).slice(0, 3), [0x11, 0x11, 0x11])).toBe(true);
  });

  it('shrinks a photo wider than 1200 pixels before reading it', async () => {
    const wide = photoOf(2400, 40, (context) => {
      context.fillStyle = '#141414';
      context.fillRect(800, 10, 800, 20);
    });
    const stamp = await inkFromPhoto(wide, 50, '#111111', 'signature');
    expect(stamp?.pixelWidth).toBeGreaterThan(395);
    expect(stamp?.pixelWidth).toBeLessThan(430);
    expect(stamp?.pixelHeight).toBeLessThan(30);
  });

  it('treats a threshold outside 1-100 as the nearest end of the scale', async () => {
    const grey = photoOf(400, 200, (context) => {
      context.fillStyle = '#808080';
      context.fillRect(100, 50, 200, 100);
    });
    // Grey 128 is paper at threshold 1 (cut 2.55), ink at 100 (cut 255), and 0 and 150 clamp to those.
    expect(await inkFromPhoto(grey, 0, '#111111', 'signature')).toBeNull();
    expect(await inkFromPhoto(grey, 1, '#111111', 'signature')).toBeNull();
    expect(await inkFromPhoto(grey, 100, '#111111', 'signature')).toMatchObject({ pixelWidth: 208 });
    expect(await inkFromPhoto(grey, 150, '#111111', 'signature')).toMatchObject({ pixelWidth: 208 });
  });

  it('has nothing to give for a photo of blank paper', async () => {
    expect(
      await inkFromPhoto(
        photoOf(100, 100, () => undefined),
        50,
        '#111111',
        'signature',
      ),
    ).toBeNull();
  });

  it('has nothing to give when the canvas gives no context, and still releases the decoded photo', async () => {
    makeElement.nullContext = true;
    expect(await inkFromPhoto(photoOf(100, 100, stripe), 50, '#111111', 'signature')).toBeNull();
    expect(closed.count).toBe(1);
  });
});

describe('imageFromFile', () => {
  const rgbJpeg = async (width: number, height: number): Promise<Uint8Array> => {
    const mupdf = await mupdfForTests();
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
    pixmap.clear(150);
    const bytes = new Uint8Array(pixmap.asJPEG(90, false));
    pixmap.destroy();
    return bytes;
  };
  const jpegFile = (bytes: Uint8Array) => new File([bytes as BlobPart], 'photo.jpg', { type: 'image/jpeg' });
  const pngFile = (width: number, height: number, paint: (context: CanvasRenderingContext2D) => void) => {
    const canvas = skia.createCanvas(width, height);
    paint(canvas.getContext('2d') as unknown as CanvasRenderingContext2D);
    return new File([new Uint8Array(canvas.toBuffer('image/png'))], 'picture.png', { type: 'image/png' });
  };
  const isJpegBytes = (bytes: Uint8Array) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

  it('embeds an upright JPEG with its own bytes, so there is no second lossy pass', async () => {
    const original = await rgbJpeg(30, 20);
    const stamp = await imageFromFile(jpegFile(original));
    expect(stamp).toMatchObject({ role: 'image', pixelWidth: 30, pixelHeight: 20 });
    expect(Array.from(stamp?.bytes ?? [])).toEqual(Array.from(original));
    expect(stamp?.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(closed.count).toBe(1);
  });

  it('re-encodes a JPEG whose EXIF orientation turns it', async () => {
    const original = await rgbJpeg(30, 20);
    const orientation = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, ...le32(8), ...le16(1)];
    orientation.push(...le16(0x0112), ...le16(3), ...le32(1), ...le16(6), 0, 0, ...le32(0));
    const turned = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe1,
      ...be16(orientation.length + 2),
      ...orientation,
      ...original.slice(2),
    ]);
    const stamp = await imageFromFile(jpegFile(turned));
    // The decoder applies the orientation, so the upright picture is 20 wide and 30 tall.
    expect(stamp).toMatchObject({ role: 'image', pixelWidth: 20, pixelHeight: 30 });
    expect(isJpegBytes(stamp?.bytes ?? new Uint8Array())).toBe(true);
    expect(Array.from(stamp?.bytes ?? [])).not.toEqual(Array.from(turned));
    const picture = await pixelsOf(stamp?.bytes ?? new Uint8Array());
    expect([picture.width, picture.height]).toEqual([20, 30]);
  });

  it('shrinks a JPEG longer than 3000 pixels and re-encodes it', async () => {
    const original = await rgbJpeg(3200, 10);
    const stamp = await imageFromFile(jpegFile(original));
    expect(stamp).toMatchObject({ pixelWidth: 3000, pixelHeight: 9 });
    expect(isJpegBytes(stamp?.bytes ?? new Uint8Array())).toBe(true);
    expect(Array.from(stamp?.bytes ?? [])).not.toEqual(Array.from(original));
    const picture = await pixelsOf(stamp?.bytes ?? new Uint8Array());
    expect([picture.width, picture.height]).toEqual([3000, 9]);
  });

  it('writes an opaque PNG as a JPEG', async () => {
    const file = pngFile(30, 20, (context) => {
      context.fillStyle = '#336699';
      context.fillRect(0, 0, 30, 20);
    });
    const stamp = await imageFromFile(file);
    expect(stamp).toMatchObject({ role: 'image', pixelWidth: 30, pixelHeight: 20 });
    expect(isJpegBytes(stamp?.bytes ?? new Uint8Array())).toBe(true);
  });

  it('keeps a PNG that has transparency as a PNG', async () => {
    const file = pngFile(30, 20, (context) => {
      context.fillStyle = '#336699';
      context.fillRect(0, 0, 15, 20);
    });
    const stamp = await imageFromFile(file);
    expect(Array.from(stamp?.bytes.slice(1, 4) ?? [])).toEqual([0x50, 0x4e, 0x47]);
    const picture = await pixelsOf(stamp?.bytes ?? new Uint8Array());
    expect(picture.at(25, 10)[3]).toBe(0);
    expect(picture.at(5, 10)).toEqual([0x33, 0x66, 0x99, 255]);
  });

  it('is null for a file the browser cannot read', async () => {
    const file = new File(['this is not a picture'], 'notes.png', { type: 'image/png' });
    expect(await imageFromFile(file)).toBeNull();
    expect(closed.count).toBe(0);
  });

  it('is null when the canvas gives no context, and still releases the decoded picture', async () => {
    makeElement.nullContext = true;
    expect(await imageFromFile(jpegFile(await rgbJpeg(30, 20)))).toBeNull();
    expect(closed.count).toBe(1);
  });
});
