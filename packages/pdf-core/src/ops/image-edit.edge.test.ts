/**
 * Image listing, reading and replacement on the shapes real producers write: images that are
 * not images, masks, indexed and 16-bit samples, filter chains, ICC colour spaces, short or
 * undecodable streams, and the refusals of a replacement (empty, wrong format, wrong page).
 * Every file is built here with MuPDF's object model, and read back through it.
 */

import { ColorSpace, PDFDocument, type PDFObject, Pixmap } from 'mupdf';
import { describe, expect, it, vi } from 'vitest';
import { handPdf } from './forms.fixtures';
import { applyImageEdit, listPdfImages, readImageData } from './image-edit';

const run = { signal: new AbortController().signal };

interface Spec {
  readonly name: string;
  /** Entries of the image dictionary, over the defaults of an 8-bit RGB 2 x 1 image. */
  readonly dict?: Record<string, unknown>;
  readonly data?: Uint8Array;
  /** Written as a raw stream (the bytes stay as given, whatever `/Filter` says). */
  readonly raw?: boolean;
}

/** A one-page file whose resources name each spec as an image object, plus a direct entry and a non-stream. */
function build(specs: readonly Spec[], options: { readonly rotate?: boolean } = {}): Uint8Array {
  const doc = new PDFDocument();
  const objects: Record<string, PDFObject> = {};
  for (const spec of specs) {
    const dict = {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 1,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      ...spec.dict,
    };
    const data = spec.data ?? new Uint8Array([1, 2, 3, 4, 5, 6]);
    objects[spec.name] = spec.raw === true ? doc.addRawStream(data, dict) : doc.addStream(data, dict);
  }
  const form = doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] });
  const notStream = doc.addObject({ Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1 });
  doc.insertPage(
    0,
    doc.addPage(
      [0, 0, 100, 100],
      options.rotate === true ? 90 : 0,
      { XObject: { ...objects, Form: form, Dict: notStream } },
      '',
    ),
  );
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('listPdfImages on unusual images', () => {
  const list = async (specs: readonly Spec[]) => (await listPdfImages(build(specs), run)).images;
  const byName = (images: Awaited<ReturnType<typeof list>>) =>
    new Map(images.map((image) => [image.name, image]));

  it('says why an image cannot be edited or transformed, and what a filter chain looks like', async () => {
    const images = byName(
      await list([
        { name: 'Mask', dict: { ImageMask: true, ColorSpace: undefined, BitsPerComponent: 1 } },
        { name: 'Zero', dict: { Width: 0 } },
        { name: 'NoWidth', dict: { Width: undefined } },
        { name: 'NoHeight', dict: { Height: undefined } },
        { name: 'Bits1', dict: { BitsPerComponent: 1 } },
        {
          name: 'Indexed',
          dict: { ColorSpace: ['Indexed', 'DeviceRGB', 1, new Uint8Array([0, 0, 0, 1, 1, 1])] },
        },
        { name: 'Cmyk', dict: { ColorSpace: 'DeviceCMYK' } },
        { name: 'Chain', dict: { Filter: ['ASCIIHexDecode', 'FlateDecode'] }, raw: true },
        { name: 'Jpx', dict: { Filter: 'JPXDecode' }, raw: true },
        { name: 'Soft', dict: { SMask: 5 } },
        { name: 'NoSpace', dict: { ColorSpace: undefined } },
        { name: 'Number', dict: { ColorSpace: 5 } },
        { name: 'Plain', dict: {} },
      ]),
    );
    const note = (name: string) => {
      const image = images.get(name);
      return {
        editable: image?.editable,
        key: image?.notEditableKey,
        transformable: image?.transformable,
        why: image?.notTransformableKey,
      };
    };
    expect(note('Mask')).toMatchObject({ editable: false, key: 'op.note.image.mask', transformable: false });
    expect(note('Zero')).toMatchObject({ editable: false, key: 'op.note.image.degenerate' });
    expect(note('NoWidth')).toMatchObject({ editable: false, key: 'op.note.image.degenerate' });
    expect(note('NoHeight')).toMatchObject({ editable: false, key: 'op.note.image.degenerate' });
    expect(note('Bits1')).toMatchObject({
      editable: true,
      transformable: false,
      why: 'op.note.image.bitsUnsupported',
    });
    expect(note('Indexed')).toMatchObject({
      transformable: false,
      why: 'op.note.image.colorSpaceUnsupported',
    });
    expect(note('Cmyk')).toMatchObject({ transformable: false, why: 'op.note.image.colorSpaceUnsupported' });
    // A filter chain is no single codec the caller can name, but MuPDF decodes it: the samples are readable.
    expect(note('Chain')).toMatchObject({ transformable: true, why: undefined });
    expect(note('Jpx')).toMatchObject({ why: 'op.note.image.filterUnsupported' });
    expect(note('NoSpace')).toMatchObject({ why: 'op.note.image.colorSpaceUnsupported' });
    expect(note('Plain')).toMatchObject({ editable: true, transformable: true, why: undefined });
    expect(images.get('Chain')?.filter).toBeNull();
    expect(images.get('Indexed')?.colorSpace).toBe('Indexed');
    expect(images.get('Number')?.colorSpace).toBeNull();
    expect(images.get('NoSpace')?.colorSpace).toBeNull();
    expect(images.get('Bits1')?.bitsPerComponent).toBe(1);
    expect(images.get('NoWidth')).toMatchObject({ width: 0, height: 1 });
    // A form XObject is listed as not an image; a direct dictionary entry is not listed at all.
    expect(images.get('Form')).toMatchObject({ editable: false, notEditableKey: 'op.note.image.notImage' });
    expect(images.has('Dict')).toBe(true);
  });

  it('reads an ICC-based space of one or three components as grey or RGB, and none for another', async () => {
    const doc = new PDFDocument();
    const profile = (components: number | undefined) =>
      doc.addStream(new Uint8Array(4), components === undefined ? {} : { N: components });
    const icc = (components: number | undefined) => ['ICCBased', profile(components)];
    const image = (colorSpace: unknown) =>
      doc.addStream(new Uint8Array(6), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: colorSpace,
      });
    doc.insertPage(
      0,
      doc.addPage(
        [0, 0, 10, 10],
        0,
        {
          XObject: {
            Rgb: image(icc(3)),
            Grey: image(icc(1)),
            Cmyk: image(icc(4)),
            NoN: image(icc(undefined)),
            Bare: image(['ICCBased']),
          },
        },
        '',
      ),
    );
    const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    doc.destroy();
    const images = byName((await listPdfImages(bytes, run)).images);
    expect(images.get('Rgb')).toMatchObject({ transformable: true, colorSpace: 'ICCBased' });
    expect(images.get('Grey')?.transformable).toBe(true);
    for (const name of ['Cmyk', 'NoN', 'Bare']) {
      expect(images.get(name)?.notTransformableKey).toBe('op.note.image.colorSpaceUnsupported');
    }
  });

  it('lists a page with no resources, reports progress per page and stops on an abort', async () => {
    const empty = (() => {
      const doc = new PDFDocument();
      doc.insertPage(0, doc.addPage([0, 0, 10, 10], 0, {}, ''));
      const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
      doc.destroy();
      return bytes;
    })();
    const onProgress = vi.fn();
    expect(await listPdfImages(empty, { signal: run.signal, onProgress })).toEqual({
      images: [],
      pageCount: 1,
    });
    expect(onProgress.mock.calls).toEqual([
      [{ phase: 'images', labelKey: 'op.progress.image.read', done: 1, total: 1 }],
    ]);
    await expect(listPdfImages(empty, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('readImageData on unusual images', () => {
  const read = async (spec: Spec) => readImageData(build([spec]), { pageIndex: 0, name: spec.name }, run);

  it('refuses what it cannot hand out, with the reason', async () => {
    expect(await read({ name: 'Jpx', dict: { Filter: 'JPXDecode' }, raw: true })).toEqual({
      kind: 'unsupported',
      reasonKey: 'op.note.image.filterUnsupported',
    });
    expect(await read({ name: 'Bits', dict: { BitsPerComponent: 16 } })).toEqual({
      kind: 'unsupported',
      reasonKey: 'op.note.image.bitsUnsupported',
    });
    expect(await read({ name: 'Cmyk', dict: { ColorSpace: 'DeviceCMYK' } })).toEqual({
      kind: 'unsupported',
      reasonKey: 'op.note.image.colorSpaceUnsupported',
    });
    // Fewer samples than width x height x colours: the picture would be invented.
    expect(await read({ name: 'Short', data: new Uint8Array([1, 2, 3]) })).toEqual({
      kind: 'unsupported',
      reasonKey: 'op.note.image.decodeFailed',
    });
    // A Flate stream that is not Flate data cannot be decoded.
    expect(
      await read({
        name: 'Broken',
        dict: { Filter: 'FlateDecode' },
        raw: true,
        data: new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
      }),
    ).toEqual({
      kind: 'unsupported',
      reasonKey: 'op.note.image.decodeFailed',
    });
  });

  it('names the object as not an image when the page, the name or the stream is missing', async () => {
    const bytes = build([{ name: 'A' }]);
    const notImage = { kind: 'unsupported', reasonKey: 'op.note.image.notImage' };
    expect(await readImageData(bytes, { pageIndex: 5, name: 'A' }, run)).toEqual(notImage);
    expect(await readImageData(bytes, { pageIndex: 0, name: 'Dict' }, run)).toEqual(notImage);
    await expect(
      readImageData(bytes, { pageIndex: 0, name: 'A' }, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('reads a JPEG with no declared size as 0 x 0 and unfiltered samples with no declared depth as 8-bit', async () => {
    const jpeg = await read({
      name: 'J',
      dict: { Filter: 'DCTDecode', Width: undefined, Height: undefined },
      raw: true,
      data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    });
    expect(jpeg).toMatchObject({ kind: 'jpeg', width: 0, height: 0 });
    const samples = await read({ name: 'S', dict: { BitsPerComponent: undefined } });
    expect(samples).toMatchObject({ kind: 'raw', width: 2, height: 1 });
  });
});

describe('applyImageEdit refusals and reports', () => {
  const png = (() => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0,
      0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63,
      0xf8, 0xcf, 0xc0, 0xf0, 0x1f, 0, 0x05, 0, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0, 0, 0, 0, 0x49, 0x45,
      0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    return bytes;
  })();
  const replace = (over: Partial<Parameters<typeof applyImageEdit>[1]['replacements'][number]> = {}) => ({
    pageIndex: 0,
    name: 'A',
    data: png,
    format: 'png' as const,
    ...over,
  });
  const input = () => build([{ name: 'A' }]);

  it('returns the input untouched, and says so, for no replacements', async () => {
    const bytes = input();
    const out = await applyImageEdit(bytes, { replacements: [] }, run);
    expect(out.bytes).toBe(bytes);
    expect(out.report.notes.map((entry) => entry.key)).toEqual([
      'op.note.image.nothing',
      'op.note.metadata.producerKept',
    ]);
  });

  it('refuses a page that is not in the document, empty data and a signature that is not the format', async () => {
    await expect(
      applyImageEdit(input(), { replacements: [replace({ pageIndex: 4 })] }, run),
    ).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { path: 'request.replacements.pageIndex', engineMessage: 'page 4 is outside 0…0' },
    });
    await expect(
      applyImageEdit(input(), { replacements: [replace({ pageIndex: -1 })] }, run),
    ).rejects.toMatchObject({
      code: 'value-out-of-range',
    });
    await expect(
      applyImageEdit(input(), { replacements: [replace({ data: new Uint8Array(0) })] }, run),
    ).rejects.toMatchObject({
      code: 'selection-empty',
      details: { engineMessage: 'replacement for "A" carries no bytes' },
    });
    await expect(
      applyImageEdit(input(), { replacements: [replace({ format: 'jpeg' })] }, run),
    ).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { engineMessage: 'the replacement for "A" is not a readable JPEG' },
    });
    await expect(
      applyImageEdit(input(), { replacements: [replace({ data: png.slice(0, 20) })] }, run),
    ).rejects.toMatchObject({ code: 'unsupported-format' });
  });

  it('counts a name the document lacks next to the one it replaced, and reports progress', async () => {
    const onProgress = vi.fn();
    const out = await applyImageEdit(
      input(),
      { replacements: [replace(), replace({ name: 'Nope' })] },
      { signal: run.signal, onProgress },
    );
    expect(out.report.notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.image.replaced', { name: 'A', page: 1 }],
      ['op.note.image.notFound', { count: 1 }],
    ]);
    expect(out.report.steps).toEqual(['load', 'producer', 'save', 'verify']);
    const event = (done: number) => [
      { phase: 'images', labelKey: 'op.progress.image.write', done, total: 2 },
    ];
    expect(onProgress.mock.calls).toEqual([event(0), event(1), event(2)]);
  });

  it('stops on an aborted signal before touching the file', async () => {
    await expect(
      applyImageEdit(input(), { replacements: [replace()] }, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps an old mask and says so when asked not to drop it, unless the new picture brings its own', async () => {
    const withMask = (() => {
      const doc = new PDFDocument();
      const mask = doc.addStream(new Uint8Array([255, 255]), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceGray',
      });
      const image = doc.addStream(new Uint8Array(6), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: 'DeviceRGB',
        SMask: mask,
      });
      doc.insertPage(0, doc.addPage([0, 0, 10, 10], 0, { XObject: { A: image } }, ''));
      const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
      doc.destroy();
      return bytes;
    })();
    const opaque = new Uint8Array(new Pixmap(ColorSpace.DeviceRGB, [0, 0, 2, 1], false).asPNG());
    const kept = await applyImageEdit(
      withMask,
      { replacements: [replace({ data: opaque })], dropMask: false },
      run,
    );
    expect(kept.report.notes.map((entry) => entry.key)).toEqual([
      'op.note.image.maskKept',
      'op.note.image.replaced',
    ]);
    // The replacement carries alpha of its own, which is its mask: nothing old is being kept.
    const own = await applyImageEdit(withMask, { replacements: [replace()], dropMask: false }, run);
    expect(own.report.notes.map((entry) => entry.key)).toEqual(['op.note.image.replaced']);
    const dropped = await applyImageEdit(withMask, { replacements: [replace()] }, run);
    expect(dropped.report.notes.map((entry) => entry.key)).toEqual([
      'op.note.image.replaced',
      'op.note.image.maskDropped',
    ]);
  });
});

describe('image resources a page can carry besides indirect image streams', () => {
  const pageWith = (resources: string, extra: Record<number, string> = {}): Uint8Array =>
    handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      3: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]${resources}>>`,
      ...extra,
    });

  it('lists nothing for a page with no resources, a direct entry or an entry that is not a dictionary', async () => {
    for (const bytes of [
      pageWith(''),
      pageWith('/Resources<</XObject<</D<</Subtype/Image/Width 1/Height 1>>>>>>'),
      pageWith('/Resources<</XObject<</N 7 0 R>>>>', { 7: '5' }),
      pageWith('/Resources<<>>'),
      pageWith('/Resources<</XObject 5>>'),
    ]) {
      expect((await listPdfImages(bytes, run)).images).toEqual([]);
    }
  });

  it('inherits the resources of the page tree', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R]/Count 1/Resources<</XObject<</A 4 0 R>>>>>>',
      3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>',
      4: '<</Type/XObject/Subtype/Image/Width 1/Height 1/BitsPerComponent 8/ColorSpace/DeviceGray/Length 1>>\nstream\nx\nendstream',
    });
    expect((await listPdfImages(bytes, run)).images.map((image) => image.name)).toEqual(['A']);
  });

  it('reports a flate stream whose predictor cannot be undone as undecodable, not as pixels', async () => {
    const doc = new PDFDocument();
    const image = doc.addRawStream(new Uint8Array([0x78, 0x9c, 3, 0, 0, 0, 0, 1]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 1,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      Filter: 'FlateDecode',
      DecodeParms: { Predictor: 12, Columns: 2147483647, Colors: 32, BitsPerComponent: 16 },
    });
    doc.insertPage(0, doc.addPage([0, 0, 10, 10], 0, { XObject: { A: image } }, ''));
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    expect(await readImageData(bytes, { pageIndex: 0, name: 'A' }, run)).toEqual({
      kind: 'unsupported',
      reasonKey: 'op.note.image.decodeFailed',
    });
  });
});
