/**
 * Image listing, sample reads and in-place replacement against real bytes. The wrong
 * answers that matter: a JPEG handed to the canvas decoded (it must travel as the file's
 * own JPEG), grey or RGB samples read with the wrong colours, a replacement that moves the
 * object (the page then draws nothing, or draws it somewhere else), a shared image edited
 * without saying so, and a file that is not the claimed format accepted.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { applyImageEdit, type ImagePlacement, listPdfImages, readImageData } from './image-edit';
import type { OperationOutcome } from './types';

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

/**
 * A 400 x 300 page drawing the 20 x 10 picture `Wide` (red left half, blue right half) the way
 * `content` says. `more` adds resources and objects to the page (a form, a second page).
 */
async function wideDocument(
  content: string,
  more: (doc: PDFDocument, image: PDFObject) => Record<string, PDFObject> = () => ({}),
): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const samples = new Uint8Array(20 * 10 * 3);
  for (let pixel = 0; pixel < 200; pixel += 1) {
    samples.set(pixel % 20 < 10 ? [255, 0, 0] : [0, 0, 255], pixel * 3);
  }
  const wide = doc.addStream(samples, {
    Type: 'XObject',
    Subtype: 'Image',
    BitsPerComponent: 8,
    ColorSpace: 'DeviceRGB',
    Width: 20,
    Height: 10,
  });
  const page = doc.addPage([0, 0, 400, 300], 0, { XObject: { Wide: wide, ...more(doc, wide) } }, content);
  doc.insertPage(0, page);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const WIDE_FRAME = 'q 200 0 0 100 50 100 cm /Wide Do Q';

/** A solid green PNG of the given size: the pixels a caller would hand over after an edit. */
async function greenPng(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array((await pixmapOf([0, 255, 0], width, height)).asPNG());
}

/** A PNG whose top half is red and whose bottom half is blue. */
async function redOverBluePng(width: number, height: number): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  const pixels = pixmap.getPixels();
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      pixels.set(row < height / 2 ? [255, 0, 0] : [0, 0, 255], (row * width + column) * 3);
    }
  }
  return new Uint8Array(pixmap.asPNG());
}

/** The decoded content stream of one page, without the newline the reader joins its parts with. */
async function contentOf(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF() as PDFDocument;
  try {
    return doc.findPage(pageIndex).get('Contents').readStream().asString().trim();
  } finally {
    doc.destroy();
  }
}

const WHITE = [255, 255, 255];
const GREEN = [0, 255, 0];

/** Edit `Wide` on page 1 with the given pixels and placement. */
function editWide(
  bytes: Uint8Array,
  data: Uint8Array,
  placement: ImagePlacement | undefined,
): Promise<OperationOutcome> {
  return applyImageEdit(
    bytes,
    { replacements: [{ pageIndex: 0, name: 'Wide', data, format: 'png', placement }] },
    run,
  );
}

const NO_CROP = { left: 0, top: 0, right: 0, bottom: 0 };

describe('a replacement that changes the shape of the picture', () => {
  it('frames quarter-turned pixels around the centre of the old frame, at the picture’s own aspect', async () => {
    const out = await editWide(await wideDocument(WIDE_FRAME), await greenPng(10, 20), {
      turned: true,
      crop: NO_CROP,
    });
    // 200 x 100 at (50, 100) becomes 100 x 200 around (150, 150): x 100…200, page y 50…250.
    expect(await contentOf(out.bytes)).toBe('q 200 0 0 100 50 100 cm q 0.5 0 0 2 0.25 -0.5 cm /Wide Do Q Q');
    for (const [x, y] of [
      [105, 55],
      [195, 55],
      [105, 245],
      [195, 245],
    ] as const) {
      expect(await rgbAt(out.bytes, 0, x, y)).toEqual(GREEN);
    }
    for (const [x, y] of [
      [95, 150],
      [205, 150],
      [150, 45],
      [150, 255],
      [60, 150],
    ] as const) {
      expect(await rgbAt(out.bytes, 0, x, y)).toEqual(WHITE);
    }
    expect(out.report.notes.find((entry) => entry.key === 'op.note.image.reframed')).toMatchObject({
      kind: 'changed',
      params: { name: 'Wide', count: 1 },
    });
  });

  it('keeps the cropped window where it was drawn, not stretched over the whole frame', async () => {
    const out = await editWide(await wideDocument(WIDE_FRAME), await greenPng(10, 4), {
      turned: false,
      crop: { left: 0.25, top: 0.2, right: 0.25, bottom: 0.4 },
    });
    // The window is x 100…200 and, from the bottom of the frame, 40 %…80 % of 100: page y 140…180.
    expect(await contentOf(out.bytes)).toBe('q 200 0 0 100 50 100 cm q 0.5 0 0 0.4 0.25 0.4 cm /Wide Do Q Q');
    expect(await rgbAt(out.bytes, 0, 105, 125)).toEqual(GREEN);
    expect(await rgbAt(out.bytes, 0, 195, 155)).toEqual(GREEN);
    for (const [x, y] of [
      [95, 140],
      [205, 140],
      [150, 115],
      [150, 165],
    ] as const) {
      expect(await rgbAt(out.bytes, 0, x, y)).toEqual(WHITE);
    }
  });

  it('turns the cropped window, not the whole frame, about its own centre', async () => {
    const out = await editWide(await wideDocument(WIDE_FRAME), await greenPng(5, 20), {
      turned: true,
      crop: { left: 0, top: 0.5, right: 0, bottom: 0 },
    });
    // The window is the lower half, 200 x 50 at (50, 100) with its centre at (150, 125): turned, it is
    // 50 x 200 over x 125…175 and page y 25…225, which is rows 75…275 of the render.
    expect(await rgbAt(out.bytes, 0, 150, 80)).toEqual(GREEN);
    expect(await rgbAt(out.bytes, 0, 150, 270)).toEqual(GREEN);
    for (const [x, y] of [
      [120, 150],
      [180, 150],
      [150, 70],
      [150, 280],
    ] as const) {
      expect(await rgbAt(out.bytes, 0, x, y)).toEqual(WHITE);
    }
  });

  it('follows a picture the page draws turned: red stays on the side the turned picture puts it', async () => {
    // The picture is drawn a quarter turn counter-clockwise: its right edge up, its top edge left.
    const out = await editWide(
      await wideDocument('q 0 100 -200 0 250 100 cm /Wide Do Q'),
      await redOverBluePng(10, 20),
      { turned: true, crop: NO_CROP },
    );
    // Turned a quarter clockwise on the page: the box is 100 x 200 around (150, 150), red on the
    // left and blue on the right.
    for (const y of [60, 140, 240]) {
      expect(await rgbAt(out.bytes, 0, 120, y)).toEqual([255, 0, 0]);
      expect(await rgbAt(out.bytes, 0, 180, y)).toEqual([0, 0, 255]);
    }
    expect(await rgbAt(out.bytes, 0, 90, 150)).toEqual(WHITE);
    expect(await rgbAt(out.bytes, 0, 210, 150)).toEqual(WHITE);
  });

  it('finds the drawing through nested state, a stray restore, a short cm and other pictures', async () => {
    const content =
      'Q q 2 0 0 2 0 0 cm 0.5 g q 5 0 0 5 0 0 cm Q 1 0 0 1 0 cm Do /Other Do 100 0 0 50 25 50 cm /Wide Do Q';
    const out = await editWide(await wideDocument(content), await greenPng(10, 20), {
      turned: true,
      crop: NO_CROP,
    });
    expect(await rgbAt(out.bytes, 0, 105, 55)).toEqual(GREEN);
    expect(await rgbAt(out.bytes, 0, 95, 150)).toEqual(WHITE);
    // Everything but the one drawing is kept byte for byte.
    expect(await contentOf(out.bytes)).toBe(
      'Q q 2 0 0 2 0 0 cm 0.5 g q 5 0 0 5 0 0 cm Q 1 0 0 1 0 cm Do /Other Do 100 0 0 50 25 50 cm q 0.5 0 0 2 0.25 -0.5 cm /Wide Do Q Q',
    );
  });

  it('frames every drawing of the picture and skips one that has no area', async () => {
    const content =
      'q 0 0 0 0 50 100 cm /Wide Do Q q 200 0 0 100 50 100 cm /Wide Do Q q 80 0 0 40 0 0 cm /Wide Do Q';
    const out = await editWide(await wideDocument(content), await greenPng(10, 20), {
      turned: true,
      crop: NO_CROP,
    });
    expect(out.report.notes.find((entry) => entry.key === 'op.note.image.reframed')?.params).toEqual({
      name: 'Wide',
      count: 2,
    });
    expect(await contentOf(out.bytes)).toBe(
      'q 0 0 0 0 50 100 cm /Wide Do Q q 200 0 0 100 50 100 cm q 0.5 0 0 2 0.25 -0.5 cm /Wide Do Q Q q 80 0 0 40 0 0 cm q 0.5 0 0 2 0.25 -0.5 cm /Wide Do Q Q',
    );
  });

  it('changes no page content when the pixels fill the old frame', async () => {
    const input = await wideDocument(WIDE_FRAME);
    const same = await editWide(input, await greenPng(20, 10), { turned: false, crop: NO_CROP });
    expect(await contentOf(same.bytes)).toBe(WIDE_FRAME);
    expect(same.report.notes.map((entry) => entry.key)).not.toContain('op.note.image.reframed');
    const withoutPlacement = await editWide(input, await greenPng(20, 10), undefined);
    expect(await contentOf(withoutPlacement.bytes)).toBe(WIDE_FRAME);
  });

  it('frames the other pages that draw the same object and leaves a page that only names it alone', async () => {
    const mupdf = await import('mupdf');
    const base = await wideDocument(WIDE_FRAME);
    const doc = mupdf.PDFDocument.openDocument(base.slice(), 'application/pdf').asPDF() as PDFDocument;
    const wide = doc.findPage(0).get('Resources').get('XObject').get('Wide');
    const drawn = doc.addPage(
      [0, 0, 400, 300],
      0,
      { XObject: { Wide: wide } },
      'q 100 0 0 50 0 0 cm /Wide Do Q',
    );
    const named = doc.addPage([0, 0, 400, 300], 0, { XObject: { Wide: wide } }, '');
    const other = doc.addPage([0, 0, 400, 300], 0, {}, '');
    doc.insertPage(1, drawn);
    doc.insertPage(2, named);
    doc.insertPage(3, other);
    const input = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();

    const out = await editWide(input, await greenPng(10, 20), { turned: true, crop: NO_CROP });
    expect(out.report.notes.find((entry) => entry.key === 'op.note.image.reframed')?.params).toEqual({
      name: 'Wide',
      count: 2,
    });
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.image.shared');
    // 100 x 50 at (0, 0) becomes 50 x 100 around (50, 25): x 25…75, page y -25…75.
    expect(await contentOf(out.bytes, 1)).toBe('q 100 0 0 50 0 0 cm q 0.5 0 0 2 0.25 -0.5 cm /Wide Do Q Q');
    expect(await rgbAt(out.bytes, 1, 50, 300 - 60)).toEqual(GREEN);
  });

  it('refuses a picture the page draws only from inside a form', async () => {
    const input = await wideDocument('/Fm Do', (doc, image) => {
      const form = doc.addStream('q 200 0 0 100 50 100 cm /Wide Do Q', {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 400, 300],
        Resources: { XObject: { Wide: image } },
      });
      return { Fm: form };
    });
    await expect(
      editWide(input, await greenPng(10, 20), { turned: true, crop: NO_CROP }),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: expect.stringContaining('does not draw "Wide" in its own content') },
    });
  });

  it('refuses when the only drawing has no area to follow', async () => {
    const input = await wideDocument('q 0 0 0 0 50 100 cm /Wide Do Q');
    await expect(
      editWide(input, await greenPng(10, 20), { turned: true, crop: NO_CROP }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('refuses a page whose content cannot be read, undecodable or not a content stream', async () => {
    const mupdf = await import('mupdf');
    const withContents = async (build: (doc: PDFDocument) => PDFObject) => {
      const base = await wideDocument(WIDE_FRAME);
      const doc = mupdf.PDFDocument.openDocument(base.slice(), 'application/pdf').asPDF() as PDFDocument;
      doc.findPage(0).put('Contents', build(doc));
      const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
      doc.destroy();
      return bytes;
    };
    const undecodable = await withContents((doc) =>
      doc.addRawStream(new Uint8Array([1, 2, 3]), {
        Filter: 'FlateDecode',
        DecodeParms: { Predictor: 15, Columns: -5, Colors: 1000, BitsPerComponent: 99 },
      } as never),
    );
    const malformed = await withContents((doc) => doc.addStream('1 2 3', {}));
    for (const input of [undecodable, malformed]) {
      await expect(
        editWide(input, await greenPng(10, 20), { turned: true, crop: NO_CROP }),
      ).rejects.toMatchObject({
        code: 'unsupported',
        details: { engineMessage: expect.stringContaining('content stream cannot be read') },
      });
    }
  });
});
