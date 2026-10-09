import { listPdfImages, type PdfImageInfo } from 'pdf-core/ops/image-edit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationRunContext, OpRunContext } from '../dialogs/types';
import { mupdfForTests, pngBytes, runContext, textPdf } from '../pdf-fixtures';
import { SkiaOffscreen, skia, skiaImageBitmap } from '../skia-canvas.fixtures';
import { imageEditDialog } from './image-edit';

const run = { signal: new AbortController().signal };

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();

const rgbPixmap = async (rgb: readonly [number, number, number], width: number, height: number) => {
  const mupdf = await mupdfForTests();
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  const pixels = pixmap.getPixels();
  for (let at = 0; at < pixels.length; at += 3) pixels.set(rgb, at);
  return pixmap;
};

/**
 * One 200 x 100 page drawing, left to right: a blue JPEG (`Photo`, 8 x 8), a red uncompressed
 * RGB image (`Flat`, 20 x 10), a masked one (`Cut`, 4 x 4), a palette image (`Pal`, 4 x 2) that
 * the writer cannot read pixels of, and a JPEG stream that is not a JPEG (`Broken`).
 */
async function fixture(): Promise<Uint8Array> {
  const mupdf = await mupdfForTests();
  const doc = new mupdf.PDFDocument();
  const base = { Type: 'XObject', Subtype: 'Image', BitsPerComponent: 8, ColorSpace: 'DeviceRGB' };
  const jpeg = (await rgbPixmap([0, 0, 255], 8, 8)).asJPEG(90);
  const photo = doc.addRawStream(jpeg, { ...base, Width: 8, Height: 8, Filter: 'DCTDecode' });
  const red = new Uint8Array(20 * 10 * 3).map((_value, index) => (index % 3 === 0 ? 255 : 0));
  const flat = doc.addStream(red, { ...base, Width: 20, Height: 10 });
  const alpha = doc.addStream(new Uint8Array(16).fill(128), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: 4,
    Height: 4,
    BitsPerComponent: 8,
    ColorSpace: 'DeviceGray',
  });
  const cut = doc.addStream(new Uint8Array(4 * 4 * 3).fill(90), {
    ...base,
    Width: 4,
    Height: 4,
    SMask: alpha,
  });
  const palette = doc.addStream(new Uint8Array(4 * 2).fill(1), {
    ...base,
    ColorSpace: ['Indexed', 'DeviceRGB', 1, doc.newString('\u00ff\u0000\u0000\u0000\u00ff\u0000')],
    Width: 4,
    Height: 2,
  });
  const broken = doc.addRawStream(new Uint8Array([1, 2, 3, 4]), {
    ...base,
    Width: 8,
    Height: 8,
    Filter: 'DCTDecode',
  });
  const page = doc.addPage(
    [0, 0, 200, 100],
    0,
    { XObject: { Photo: photo, Flat: flat, Cut: cut, Pal: palette, Broken: broken } },
    'q 40 0 0 40 0 10 cm /Photo Do Q q 40 0 0 40 40 10 cm /Flat Do Q q 40 0 0 40 80 10 cm /Cut Do Q ' +
      'q 40 0 0 40 120 10 cm /Pal Do Q q 40 0 0 40 160 10 cm /Broken Do Q',
  );
  doc.insertPage(0, page);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

async function contextFor(
  bytes: Uint8Array,
  overrides: Partial<OpRunContext> = {},
): Promise<{ context: OpRunContext; image: (name: string) => PdfImageInfo }> {
  const { images } = await listPdfImages(bytes, run);
  const context = await runContext(bytes, { images, ...overrides });
  return {
    context,
    image: (name) => {
      const found = images.find((entry) => entry.name === name);
      if (found === undefined) throw new Error(`the fixture has no image ${name}`);
      return found;
    },
  };
}

/** The listing of the produced file, by image name. */
async function listed(bytes: Uint8Array) {
  const { images } = await listPdfImages(bytes, run);
  return Object.fromEntries(images.map((entry) => [entry.name, entry]));
}

/** The colour of the page at a point, rendered at 72 dpi. */
async function rgbAt(bytes: Uint8Array, x: number, y: number): Promise<number[]> {
  const mupdf = await mupdfForTests();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const at = (y * pixmap.getWidth() + x) * 3;
    return Array.from(pixmap.getPixels().slice(at, at + 3));
  } finally {
    doc.destroy();
  }
}

interface Conversion {
  readonly type: string;
  readonly quality?: number;
}
const conversions: Conversion[] = [];
const contextRequests = { count: 0, refuseFrom: Number.POSITIVE_INFINITY };

/** The browser's canvas: Skia, recording how it was asked to encode and refusing contexts on demand. */
function RecordingOffscreen(width: number, height: number) {
  const canvas = new SkiaOffscreen(width, height) as unknown as {
    getContext(kind: '2d'): unknown;
    convertToBlob(options: Conversion): Promise<Blob>;
  };
  const getContext = canvas.getContext.bind(canvas);
  const convertToBlob = canvas.convertToBlob.bind(canvas);
  canvas.getContext = (kind) => {
    contextRequests.count += 1;
    return contextRequests.count >= contextRequests.refuseFrom ? null : getContext(kind);
  };
  canvas.convertToBlob = (options) => {
    conversions.push(options);
    return convertToBlob(options);
  };
  return canvas;
}

beforeEach(() => {
  conversions.length = 0;
  contextRequests.count = 0;
  contextRequests.refuseFrom = Number.POSITIVE_INFINITY;
  vi.stubGlobal('OffscreenCanvas', RecordingOffscreen);
  vi.stubGlobal('ImageData', skia.ImageData);
  vi.stubGlobal('createImageBitmap', skiaImageBitmap);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the image list the dialog offers', () => {
  const choice = imageEditDialog.fields.find((field) => field.kind === 'choice');
  const optionsOf = (context: OperationRunContext) =>
    choice?.kind === 'choice' && typeof choice.options === 'function' ? choice.options(context) : [];

  it('lists the replaceable images in document order, each labelled with what the user needs to choose', async () => {
    const { context } = await contextFor(await fixture());
    expect(optionsOf(context)).toEqual([
      { value: '0:Photo', label: expect.stringMatching(/^Page 1 · Photo · 8×8 · DCTDecode · \d+ KB$/) },
      { value: '0:Flat', label: expect.stringMatching(/^Page 1 · Flat · 20×10 · uncompressed · 1 KB$/) },
      {
        value: '0:Cut',
        label: expect.stringMatching(/^Page 1 · Cut · 4×4 · uncompressed · 1 KB · transparency$/),
      },
      {
        value: '0:Pal',
        label: expect.stringMatching(/^Page 1 · Pal · 4×2 · uncompressed · 1 KB · replace only$/),
      },
      { value: '0:Broken', label: expect.stringMatching(/^Page 1 · Broken · 8×8 · DCTDecode · 1 KB$/) },
    ]);
  });

  it('leaves out an image that cannot be replaced, and lists nothing when the host gave no images', async () => {
    const { context, image } = await contextFor(await fixture());
    const unreplaceable = { ...image('Flat'), editable: false };
    expect(optionsOf({ ...context, images: [unreplaceable] })).toEqual([]);
    expect(optionsOf({ ...context, images: undefined })).toEqual([]);
  });
});

describe('imageEditDialog replace', () => {
  it('puts the picked PNG in the object the page already draws, under the same name', async () => {
    const { context } = await contextFor(await fixture());
    const file = new File([(await pngBytes(6, 3)) as BlobPart], 'new.png', { type: 'image/png' });
    const result = await imageEditDialog.run({ target: '0:Flat', action: 'replace', file: [file] }, context);
    expect(result.files[0]).toMatchObject({ name: 'doc.pdf', mime: 'application/pdf' });
    expect(result.noticeKey).toBe('image.done');
    const after = await listed(bytesOf(result));
    expect(after.Flat).toMatchObject({ width: 6, height: 3, filter: 'FlateDecode' });
    expect(after.Photo).toMatchObject({ width: 8, height: 8, filter: 'DCTDecode' });
  });

  it('embeds a picked JPEG as a JPEG', async () => {
    const { context } = await contextFor(await fixture());
    const jpeg = (await rgbPixmap([0, 128, 0], 10, 5)).asJPEG(90);
    const file = new File([new Uint8Array(jpeg) as BlobPart], 'new.jpg', { type: 'image/jpeg' });
    const result = await imageEditDialog.run({ target: '0:Flat', file: [file] }, context);
    expect(await listed(bytesOf(result))).toMatchObject({
      Flat: { width: 10, height: 5, filter: 'DCTDecode' },
    });
  });

  it('asks for a file when none was picked', async () => {
    const { context } = await contextFor(await fixture());
    const expected = {
      code: 'input-missing',
      details: { engine: 'ui', engineMessage: 'no image file was picked' },
    };
    await expect(
      imageEditDialog.run({ target: '0:Flat', action: 'replace', file: [] }, context),
    ).rejects.toMatchObject(expected);
    await expect(imageEditDialog.run({ target: '0:Flat' }, context)).rejects.toMatchObject(expected);
  });

  it('refuses a target that is no longer in the document, instead of editing another object', async () => {
    const { context } = await contextFor(await fixture());
    const expected = {
      code: 'selection-empty',
      details: { engineMessage: 'the chosen image is no longer in the document' },
    };
    await expect(imageEditDialog.run({ target: '0:Gone' }, context)).rejects.toMatchObject(expected);
    await expect(imageEditDialog.run({}, context)).rejects.toMatchObject(expected);
    await expect(
      imageEditDialog.run({ target: '0:Flat' }, { ...context, images: undefined }),
    ).rejects.toMatchObject(expected);
  });
});

describe('imageEditDialog opacity', () => {
  it('draws the picture at the chosen opacity, and at half when none is sent', async () => {
    const { context } = await contextFor(await fixture());
    expect(await rgbAt(bytesOf({ files: [{ bytes: context.bytes }] }), 50, 70)).toEqual([255, 0, 0]);
    const half = await imageEditDialog.run({ target: '0:Flat', action: 'opacity' }, context);
    expect(half.noticeKey).toBe('image.done');
    const [halfRed, halfGreen] = await rgbAt(bytesOf(half), 50, 70);
    expect(halfRed).toBe(255);
    expect(halfGreen).toBeGreaterThan(110);
    expect(halfGreen).toBeLessThan(145);
    const faint = await imageEditDialog.run({ target: '0:Flat', action: 'opacity', alpha: 0.1 }, context);
    expect((await rgbAt(bytesOf(faint), 50, 70))[1]).toBeGreaterThan(220);
  });
});

describe('imageEditDialog transforms', () => {
  it('re-compresses an uncompressed image as a JPEG at the chosen quality, kept between 0.05 and 1', async () => {
    const { context } = await contextFor(await fixture());
    const result = await imageEditDialog.run({ target: '0:Flat', action: 'compress', quality: 0.4 }, context);
    expect(await listed(bytesOf(result))).toMatchObject({
      Flat: { width: 20, height: 10, filter: 'DCTDecode' },
    });
    await imageEditDialog.run({ target: '0:Flat', action: 'compress', quality: 7 }, context);
    await imageEditDialog.run({ target: '0:Flat', action: 'compress', quality: -1 }, context);
    await imageEditDialog.run({ target: '0:Flat', action: 'compress' }, context);
    expect(conversions).toEqual([
      { type: 'image/jpeg', quality: 0.4 },
      { type: 'image/jpeg', quality: 1 },
      { type: 'image/jpeg', quality: 0.05 },
      { type: 'image/jpeg', quality: 0.7 },
    ]);
  });

  it('turns an image a quarter turn by default, swapping its sides, and keeps the colours', async () => {
    const { context } = await contextFor(await fixture());
    const result = await imageEditDialog.run({ target: '0:Flat', action: 'rotate' }, context);
    expect(await listed(bytesOf(result))).toMatchObject({
      Flat: { width: 10, height: 20, filter: 'FlateDecode' },
    });
    expect(conversions).toEqual([{ type: 'image/png' }]);
  });

  it.each([
    { degrees: '180', size: { width: 20, height: 10 } },
    { degrees: '270', size: { width: 10, height: 20 } },
  ])('turns an image $degrees degrees', async ({ degrees, size }) => {
    const { context } = await contextFor(await fixture());
    const result = await imageEditDialog.run({ target: '0:Flat', action: 'rotate', degrees }, context);
    expect(await listed(bytesOf(result))).toMatchObject({ Flat: size });
  });

  it('turns a JPEG through the browser decoder and writes the result as PNG', async () => {
    const { context } = await contextFor(await fixture());
    const result = await imageEditDialog.run({ target: '0:Photo', action: 'rotate', degrees: '90' }, context);
    expect(await listed(bytesOf(result))).toMatchObject({
      Photo: { width: 8, height: 8, filter: 'FlateDecode' },
    });
    const [red, green, blue] = await rgbAt(bytesOf(result), 20, 70);
    expect(blue).toBeGreaterThan(200);
    expect(red).toBeLessThan(40);
    expect(green).toBeLessThan(40);
  });

  it('cuts the chosen percentages off every side', async () => {
    const { context } = await contextFor(await fixture());
    const result = await imageEditDialog.run(
      { target: '0:Flat', action: 'crop', cropTop: 10, cropRight: 20, cropBottom: 30, cropLeft: 25 },
      context,
    );
    // 20 x 10: 5 off the left, 4 off the right, 1 off the top, 3 off the bottom.
    expect(await listed(bytesOf(result))).toMatchObject({ Flat: { width: 11, height: 6 } });
  });

  it('keeps every side whose crop is not sent', async () => {
    const { context } = await contextFor(await fixture());
    const result = await imageEditDialog.run({ target: '0:Flat', action: 'crop', cropLeft: 50 }, context);
    expect(await listed(bytesOf(result))).toMatchObject({ Flat: { width: 10, height: 10 } });
  });

  it('refuses a crop that removes the whole image', async () => {
    const { context } = await contextFor(await fixture());
    const run = imageEditDialog.run(
      { target: '0:Flat', action: 'crop', cropLeft: 50, cropRight: 50 },
      context,
    );
    await expect(run).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { engineMessage: 'the crop removes the whole image' },
    });
    const vertical = imageEditDialog.run(
      { target: '0:Flat', action: 'crop', cropTop: 50, cropBottom: 50 },
      context,
    );
    await expect(vertical).rejects.toMatchObject({ code: 'value-out-of-range' });
  });

  it('says which stream could not be decoded when the browser cannot read a JPEG', async () => {
    const { context } = await contextFor(await fixture());
    const run = imageEditDialog.run({ target: '0:Broken', action: 'rotate' }, context);
    await expect(run).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { engine: 'ui', engineMessage: 'the browser could not decode this image’s JPEG stream' },
      cause: expect.anything(),
    });
  });

  it('names the reason when the image samples cannot be read, before touching the file', async () => {
    const { context } = await contextFor(await fixture());
    const run = imageEditDialog.run({ target: '0:Pal', action: 'crop' }, context);
    await expect(run).rejects.toMatchObject({
      code: 'unsupported',
      details: {
        engineMessage: "this image's samples cannot be read: op.note.image.colorSpaceUnsupported",
      },
    });
  });

  it('says the reason is unknown when a listing marks an image unreadable without giving one', async () => {
    const { context, image } = await contextFor(await fixture());
    const { notTransformableKey: _dropped, ...bare } = image('Flat');
    const run = imageEditDialog.run(
      { target: '0:Flat', action: 'rotate' },
      { ...context, images: [{ ...bare, transformable: false }] },
    );
    await expect(run).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: "this image's samples cannot be read: unknown" },
    });
  });

  it('refuses an image whose samples turn out unreadable after the listing said otherwise', async () => {
    const { context, image } = await contextFor(await fixture());
    const run = imageEditDialog.run(
      { target: '0:Pal', action: 'rotate' },
      { ...context, images: [{ ...image('Pal'), transformable: true }] },
    );
    await expect(run).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: 'image samples: op.note.image.colorSpaceUnsupported' },
    });
  });

  it('fails as an internal error when the browser gives no drawing surface for the result', async () => {
    const { context } = await contextFor(await fixture());
    contextRequests.refuseFrom = 1;
    const run = imageEditDialog.run({ target: '0:Flat', action: 'rotate' }, context);
    await expect(run).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: 'the browser gave no 2D context for the image edit' },
    });
  });

  it('fails as an internal error when the browser gives no surface to unpack the samples on', async () => {
    const { context } = await contextFor(await fixture());
    contextRequests.refuseFrom = 2;
    const run = imageEditDialog.run({ target: '0:Flat', action: 'rotate' }, context);
    await expect(run).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: 'no 2D context for the image edit' },
    });
  });
});

describe('imageEditDialog on a document without images', () => {
  it('has nothing to choose from', async () => {
    const bytes = await textPdf([['no pictures here']]);
    const { context } = await contextFor(bytes);
    await expect(imageEditDialog.run({ target: '0:Flat' }, context)).rejects.toMatchObject({
      code: 'selection-empty',
    });
  });
});
