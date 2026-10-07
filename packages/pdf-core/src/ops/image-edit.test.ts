/**
 * Image listing, sample reads and in-place replacement against real bytes. The wrong
 * answers that matter: a JPEG handed to the canvas decoded (it must travel as the file's
 * own JPEG), grey or RGB samples read with the wrong colours, a replacement that moves the
 * object (the page then draws nothing, or draws it somewhere else), a shared image edited
 * without saying so, and a file that is not the claimed format accepted.
 */

import { describe, expect, it } from 'vitest';
import { applyImageEdit, listPdfImages, readImageData } from './image-edit';

const run = { signal: new AbortController().signal };

async function pixmapOf(rgb: readonly [number, number, number], width = 4, height = 2) {
  const mupdf = await import('mupdf');
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  const pixels = pixmap.getPixels();
  for (let at = 0; at < pixels.length; at += 3) pixels.set(rgb, at);
  return pixmap;
}

/**
 * Two pages. Page 1 draws a JPEG (`/Photo`) and a Flate RGB image (`/Flat`); page 2 draws
 * the same Flate image again (shared object).
 */
async function fixture(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  // Written by hand with `/DeviceRGB`, the way most producers write them (`addImage` would
  // attach an ICC profile).
  const jpeg = (await pixmapOf([0, 0, 255], 8, 8)).asJPEG(90);
  const image = { Type: 'XObject', Subtype: 'Image', BitsPerComponent: 8, ColorSpace: 'DeviceRGB' };
  const photo = doc.addRawStream(jpeg, { ...image, Width: 8, Height: 8, Filter: 'DCTDecode' });
  const red = new Uint8Array(4 * 2 * 3).map((_value, index) => (index % 3 === 0 ? 255 : 0));
  const flat = doc.addStream(red, { ...image, Width: 4, Height: 2 });
  const first = doc.addPage(
    [0, 0, 200, 100],
    0,
    { XObject: { Photo: photo, Flat: flat } },
    'q 80 0 0 80 10 10 cm /Photo Do Q q 80 0 0 80 110 10 cm /Flat Do Q',
  );
  const second = doc.addPage(
    [0, 0, 200, 100],
    0,
    { XObject: { Flat: flat } },
    'q 80 0 0 80 10 10 cm /Flat Do Q',
  );
  doc.insertPage(0, first);
  doc.insertPage(1, second);
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

/** RGB at a point of a page, rendered at 72 dpi. */
async function rgbAt(bytes: Uint8Array, pageIndex: number, x: number, y: number): Promise<number[]> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pixmap = doc.loadPage(pageIndex).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const at = (y * pixmap.getWidth() + x) * 3;
    return Array.from(pixmap.getPixels().slice(at, at + 3));
  } finally {
    doc.destroy();
  }
}

describe('image editing', () => {
  it('lists every image a page names, with its codec, size and what can be done to it', async () => {
    const listing = await listPdfImages(await fixture(), run);
    expect(listing.pageCount).toBe(2);
    const summary = listing.images.map((image) => ({
      page: image.pageIndex,
      name: image.name,
      filter: image.filter,
      size: `${image.width}x${image.height}`,
      space: image.colorSpace,
      editable: image.editable,
      transformable: image.transformable,
    }));
    expect(summary).toEqual(
      expect.arrayContaining([
        {
          page: 0,
          name: 'Photo',
          filter: 'DCTDecode',
          size: '8x8',
          space: 'DeviceRGB',
          editable: true,
          transformable: true,
        },
        {
          page: 0,
          name: 'Flat',
          filter: 'FlateDecode',
          size: '4x2',
          space: 'DeviceRGB',
          editable: true,
          transformable: true,
        },
        {
          page: 1,
          name: 'Flat',
          filter: 'FlateDecode',
          size: '4x2',
          space: 'DeviceRGB',
          editable: true,
          transformable: true,
        },
      ]),
    );
    expect(listing.images).toHaveLength(3);
    const flats = listing.images.filter((image) => image.name === 'Flat');
    expect(flats[0]?.ref).toBe(flats[1]?.ref);
    expect(listing.images.every((image) => image.bytes > 0)).toBe(true);
  });

  it('hands out a JPEG as the file’s own JPEG and Flate samples as RGBA', async () => {
    const bytes = await fixture();
    const photo = await readImageData(bytes, { pageIndex: 0, name: 'Photo' }, run);
    expect(photo.kind).toBe('jpeg');
    if (photo.kind === 'jpeg') expect(Array.from(photo.bytes.slice(0, 3))).toEqual([0xff, 0xd8, 0xff]);

    const flat = await readImageData(bytes, { pageIndex: 0, name: 'Flat' }, run);
    expect(flat.kind).toBe('raw');
    if (flat.kind === 'raw') {
      expect([flat.width, flat.height]).toEqual([4, 2]);
      expect(Array.from(flat.rgba.slice(0, 8))).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
    }
    expect(await readImageData(bytes, { pageIndex: 0, name: 'Nope' }, run)).toEqual({
      kind: 'unsupported',
      reasonKey: 'op.note.image.notImage',
    });
  });

  it('reads grey samples as grey, not as RGB triples', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    const grey = doc.addStream(new Uint8Array([10, 200]), {
      Type: 'XObject',
      Subtype: 'Image',
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
      Width: 2,
      Height: 1,
    });
    doc.insertPage(0, doc.addPage([0, 0, 50, 50], 0, { XObject: { G: grey } }, 'q 40 0 0 40 5 5 cm /G Do Q'));
    const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    doc.destroy();

    const data = await readImageData(bytes, { pageIndex: 0, name: 'G' }, run);
    expect(data.kind).toBe('raw');
    if (data.kind === 'raw') {
      expect([data.width, data.height]).toEqual([2, 1]);
      expect(Array.from(data.rgba)).toEqual([10, 10, 10, 255, 200, 200, 200, 255]);
    }
  });

  it('replaces an image in place, everywhere it is drawn, and says it was shared', async () => {
    const input = await fixture();
    const before = await listPdfImages(input, run);
    const green = (await pixmapOf([0, 255, 0])).asPNG();
    const out = await applyImageEdit(
      input,
      { replacements: [{ pageIndex: 0, name: 'Flat', data: new Uint8Array(green), format: 'png' }] },
      run,
    );
    expect(out.report.steps).toContain('verify');
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).toContain('op.note.image.replaced');
    expect(keys).toContain('op.note.image.shared');

    expect(await rgbAt(out.bytes, 0, 150, 50)).toEqual([0, 255, 0]);
    expect(await rgbAt(out.bytes, 1, 50, 50)).toEqual([0, 255, 0]);
    // The JPEG next to it is untouched.
    const photo = await rgbAt(out.bytes, 0, 50, 50);
    expect(photo[2]).toBeGreaterThan(200);

    const after = await listPdfImages(out.bytes, run);
    const ref = (listing: typeof before) => listing.images.find((image) => image.name === 'Flat')?.ref;
    expect(ref(after)).toBe(ref(before));
    // A replaced image can be edited again: its samples read back as the new pixels.
    const again = await readImageData(out.bytes, { pageIndex: 0, name: 'Flat' }, run);
    expect(again.kind).toBe('raw');
    if (again.kind === 'raw') expect(Array.from(again.rgba.slice(0, 4))).toEqual([0, 255, 0, 255]);
  });

  it('keeps the replacement picture’s alpha as an /SMask so transparent pixels stay transparent', async () => {
    const mupdf = await import('mupdf');
    const input = await fixture();
    // 4×2 black picture, left half fully transparent, right half opaque.
    const rgba = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 2], true);
    const pixels = rgba.getPixels();
    for (let at = 0; at < pixels.length; at += 4) {
      const column = (at / 4) % 4;
      pixels.set([0, 0, 0, column < 2 ? 0 : 255], at);
    }
    const out = await applyImageEdit(
      input,
      { replacements: [{ pageIndex: 0, name: 'Flat', data: new Uint8Array(rgba.asPNG()), format: 'png' }] },
      run,
    );
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const xobjects = doc.findPage(0).get('Resources').get('XObject');
      const image = xobjects.get('Flat');
      expect(image.get('SMask').isNull()).toBe(false);
      expect(image.get('SMask').get('ColorSpace').asName()).toBe('DeviceGray');
    } finally {
      doc.destroy();
    }
    // Image spans x 110…190: transparent left half shows the white page, right half is black.
    expect(await rgbAt(out.bytes, 0, 120, 50)).toEqual([255, 255, 255]);
    expect(await rgbAt(out.bytes, 0, 180, 50)).toEqual([0, 0, 0]);
  });

  it('says so when the old picture’s mask is dropped with it', async () => {
    const mupdf = await import('mupdf');
    // The fixture's Flate image with a soft mask that hides its left half.
    const source = mupdf.PDFDocument.openDocument((await fixture()).slice(), 'application/pdf').asPDF();
    if (source === null) throw new Error('not a PDF');
    const mask = source.addStream(new Uint8Array([0, 0, 255, 255, 0, 0, 255, 255]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 4,
      Height: 2,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
    });
    source.findPage(0).get('Resources').get('XObject').get('Flat').put('SMask', mask);
    const input = new Uint8Array(source.saveToBuffer('compress').asUint8Array());
    source.destroy();
    expect(await rgbAt(input, 0, 120, 50)).toEqual([255, 255, 255]);

    const green = (await pixmapOf([0, 255, 0])).asPNG();
    const out = await applyImageEdit(
      input,
      { replacements: [{ pageIndex: 0, name: 'Flat', data: new Uint8Array(green), format: 'png' }] },
      run,
    );
    // The old mask described the old pixels and is gone: the new picture is opaque…
    expect(await rgbAt(out.bytes, 0, 120, 50)).toEqual([0, 255, 0]);
    // …and the report says what was lost, as `dropMask` promises.
    expect(out.report.notes.find((entry) => entry.key === 'op.note.image.maskDropped')).toMatchObject({
      kind: 'lost',
      params: { count: 1 },
    });
  });

  it('refuses bytes that are not the claimed format and leaves a missing name untouched', async () => {
    const input = await fixture();
    await expect(
      applyImageEdit(
        input,
        {
          replacements: [{ pageIndex: 0, name: 'Flat', data: new Uint8Array([1, 2, 3, 4]), format: 'jpeg' }],
        },
        run,
      ),
    ).rejects.toMatchObject({ code: 'unsupported-format' });
    const green = (await pixmapOf([0, 255, 0])).asPNG();
    const untouched = await applyImageEdit(
      input,
      { replacements: [{ pageIndex: 0, name: 'Nope', data: new Uint8Array(green), format: 'png' }] },
      run,
    );
    expect(untouched.bytes).toBe(input);
    expect(untouched.report.notes.map((entry) => entry.key)).toContain('op.note.image.noneFound');
  });
});
