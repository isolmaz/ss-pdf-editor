/**
 * Images → PDF against real bytes. The wrong answers that matter: an EXIF-rotated photo
 * placed sideways (or rotated twice, once by the decoder and once here), a `fit` page that
 * is not the image's pixel size, a `contain` image that is not centred in the margins, and
 * one unreadable file failing the whole batch.
 */

import { describe, expect, it } from 'vitest';
import { imagesToPdf } from './images';

const run = { signal: new AbortController().signal };

/** A `width`×`height` RGB image: left half red, right half blue. */
async function halves(width: number, height: number) {
  const mupdf = await import('mupdf');
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  const pixels = pixmap.getPixels();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1)
      pixels.set(x < width / 2 ? [255, 0, 0] : [0, 0, 255], (y * width + x) * 3);
  }
  return pixmap;
}

/** A JPEG with an EXIF APP1 segment carrying orientation `value` (big-endian TIFF). */
function withOrientation(jpeg: Uint8Array, value: number): Uint8Array {
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    value,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...payload, ...jpeg.slice(2)]);
}

/** The rendered page: its size and the RGB at a point. */
async function render(bytes: Uint8Array, pageIndex = 0) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pixmap = doc.loadPage(pageIndex).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const width = pixmap.getWidth();
    const pixels = pixmap.getPixels();
    return {
      width,
      height: pixmap.getHeight(),
      pages: doc.countPages(),
      at: (x: number, y: number) => Array.from(pixels.slice((y * width + x) * 3, (y * width + x) * 3 + 3)),
    };
  } finally {
    doc.destroy();
  }
}

/** Which of red and blue a pixel is (JPEG colours are near, not exact). */
const hue = (rgb: number[]): 'red' | 'blue' | 'other' =>
  (rgb[0] ?? 0) > 180 && (rgb[2] ?? 0) < 90
    ? 'red'
    : (rgb[2] ?? 0) > 180 && (rgb[0] ?? 0) < 90
      ? 'blue'
      : 'other';

describe('imagesToPdf', () => {
  it('makes a page the pixel size of a PNG and fills it', async () => {
    const png = (await halves(40, 20)).asPNG();
    const out = await imagesToPdf(
      {
        images: [{ name: 'a.png', bytes: png }],
        pageSize: 'fit',
        fit: 'contain',
        marginMm: 0,
        applyExif: true,
      },
      run,
    );
    expect(out.report.pageCount).toBe(1);
    const page = await render(out.bytes);
    expect([page.width, page.height]).toEqual([40, 20]);
    expect(page.at(5, 10)).toEqual([255, 0, 0]);
    expect(page.at(35, 10)).toEqual([0, 0, 255]);
  });

  it('turns an EXIF orientation 6 photo upright, exactly once', async () => {
    const jpeg = withOrientation((await halves(40, 20)).asJPEG(95), 6);
    const out = await imagesToPdf(
      {
        images: [{ name: 'photo.jpg', bytes: jpeg }],
        pageSize: 'fit',
        fit: 'contain',
        marginMm: 0,
        applyExif: true,
      },
      run,
    );
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.images.exif');
    const page = await render(out.bytes);
    // Orientation 6 is "turn 90° clockwise to view": the stored left (red) half is on top.
    expect([page.width, page.height]).toEqual([20, 40]);
    expect(hue(page.at(10, 5))).toBe('red');
    expect(hue(page.at(10, 35))).toBe('blue');

    const ignored = await imagesToPdf(
      {
        images: [{ name: 'photo.jpg', bytes: jpeg }],
        pageSize: 'fit',
        fit: 'contain',
        marginMm: 0,
        applyExif: false,
      },
      run,
    );
    const stored = await render(ignored.bytes);
    expect([stored.width, stored.height]).toEqual([40, 20]);
    expect(hue(stored.at(5, 10))).toBe('red');
  });

  it.each([
    // Stored left (red) half → displayed: 3 right, 5 top, 7 and 8 bottom.
    { orientation: 3, size: [40, 20], red: [35, 10], blue: [5, 10] },
    { orientation: 5, size: [20, 40], red: [10, 5], blue: [10, 35] },
    { orientation: 7, size: [20, 40], red: [10, 35], blue: [10, 5] },
    { orientation: 8, size: [20, 40], red: [10, 35], blue: [10, 5] },
  ])(
    'places an EXIF orientation $orientation photo by the tag’s definition',
    async ({ orientation, size, red, blue }) => {
      const jpeg = withOrientation((await halves(40, 20)).asJPEG(95), orientation);
      const out = await imagesToPdf(
        {
          images: [{ name: 'o.jpg', bytes: jpeg }],
          pageSize: 'fit',
          fit: 'contain',
          marginMm: 0,
          applyExif: true,
        },
        run,
      );
      const page = await render(out.bytes);
      expect([page.width, page.height]).toEqual(size);
      expect(hue(page.at(red[0] ?? 0, red[1] ?? 0))).toBe('red');
      expect(hue(page.at(blue[0] ?? 0, blue[1] ?? 0))).toBe('blue');
    },
  );

  it('mirrors an EXIF orientation 2 photo', async () => {
    const jpeg = withOrientation((await halves(40, 20)).asJPEG(95), 2);
    const out = await imagesToPdf(
      {
        images: [{ name: 'm.jpg', bytes: jpeg }],
        pageSize: 'fit',
        fit: 'contain',
        marginMm: 0,
        applyExif: true,
      },
      run,
    );
    const page = await render(out.bytes);
    expect(hue(page.at(5, 10))).toBe('blue');
    expect(hue(page.at(35, 10))).toBe('red');
  });

  it('mirrors an EXIF orientation 4 photo top to bottom (the halves are stacked here, not side by side)', async () => {
    const mupdf = await import('mupdf');
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 20, 40], false);
    const pixels = pixmap.getPixels();
    for (let y = 0; y < 40; y += 1)
      for (let x = 0; x < 20; x += 1) pixels.set(y < 20 ? [255, 0, 0] : [0, 0, 255], (y * 20 + x) * 3);
    const run4 = async (orientation: number) =>
      await render(
        (
          await imagesToPdf(
            {
              images: [{ name: 't.jpg', bytes: withOrientation(pixmap.asJPEG(95), orientation) }],
              pageSize: 'fit',
              fit: 'contain',
              marginMm: 0,
              applyExif: true,
            },
            run,
          )
        ).bytes,
      );
    // Stored: red on top. Orientation 1 shows it as stored; 4 flips it, so red is at the bottom.
    const upright = await run4(1);
    expect(hue(upright.at(10, 5))).toBe('red');
    expect(hue(upright.at(10, 35))).toBe('blue');
    const flipped = await run4(4);
    expect([flipped.width, flipped.height]).toEqual([20, 40]);
    expect(hue(flipped.at(10, 5))).toBe('blue');
    expect(hue(flipped.at(10, 35))).toBe('red');
  });

  it('fills the whole drawing area when asked to cover, cropping the overflow', async () => {
    const png = (await halves(40, 20)).asPNG();
    const out = await imagesToPdf(
      { images: [{ name: 'a.png', bytes: png }], pageSize: 'a4', fit: 'cover', marginMm: 0, applyExif: true },
      run,
    );
    const page = await render(out.bytes);
    expect([page.width, page.height]).toEqual([596, 842]);
    // A 2:1 picture scaled to the page height is 1684 pt wide: the visible 596 pt are its
    // middle, so the colour change is at the page's horizontal centre and nothing is blank.
    expect(page.at(100, 20)).toEqual([255, 0, 0]);
    expect(page.at(100, 820)).toEqual([255, 0, 0]);
    expect(page.at(500, 20)).toEqual([0, 0, 255]);
    expect(page.at(500, 820)).toEqual([0, 0, 255]);
  });

  it('centres a contained image inside the margins of an A4 page and skips an unreadable file', async () => {
    const png = (await halves(40, 20)).asPNG();
    const out = await imagesToPdf(
      {
        images: [
          {
            name: 'broken.png',
            bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
          },
          { name: 'a.png', bytes: png },
          { name: 'notes.txt', bytes: new TextEncoder().encode('hello') },
        ],
        pageSize: 'a4',
        fit: 'contain',
        marginMm: 10,
        applyExif: true,
      },
      run,
    );
    expect(out.report.notes.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['op.note.images.failed', 'op.note.images.unsupported']),
    );
    const page = await render(out.bytes);
    expect(page.pages).toBe(1);
    expect([page.width, page.height]).toEqual([596, 842]);
    // Width-bound: 2:1 across the 538-point drawing area, centred vertically.
    expect(page.at(40, 421)).toEqual([255, 0, 0]);
    expect(page.at(555, 421)).toEqual([0, 0, 255]);
    expect(page.at(297, 100)).toEqual([255, 255, 255]);
  });

  it('refuses a batch in which nothing can be embedded', async () => {
    await expect(
      imagesToPdf(
        {
          images: [{ name: 'x.txt', bytes: new TextEncoder().encode('x') }],
          pageSize: 'fit',
          fit: 'contain',
          marginMm: 0,
          applyExif: true,
        },
        run,
      ),
    ).rejects.toMatchObject({ code: 'unsupported-format' });
  });
});
