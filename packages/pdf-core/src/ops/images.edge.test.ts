/**
 * Images → PDF at its edges: arguments that cannot be honoured, every shape of EXIF block the
 * reader must either apply or ignore (never fail on), and the page sizes and fit modes the
 * options name. The export to images validates its arguments before it renders; the render and
 * the encode need a browser canvas and are not exercised here.
 */

import { ColorSpace, PDFDocument, Pixmap } from 'mupdf';
import { describe, expect, it, vi } from 'vitest';
import { exportImages, type ImagesToPdfOptions, imagesToPdf } from './images';

const run = { signal: new AbortController().signal };

/** A 8 x 4 JPEG: wider than tall, so an orientation of 5 … 8 turns it to 4 x 8. */
const jpeg = new Uint8Array(new Pixmap(ColorSpace.DeviceRGB, [0, 0, 8, 4], false).asJPEG(90));
const png = new Uint8Array(new Pixmap(ColorSpace.DeviceRGB, [0, 0, 8, 4], false).asPNG());

const options = (over: Partial<ImagesToPdfOptions> = {}): ImagesToPdfOptions => ({
  images: [{ name: 'a.jpg', bytes: jpeg }],
  pageSize: 'fit',
  fit: 'contain',
  marginMm: 0,
  applyExif: true,
  ...over,
});

/** The size of every page of a produced file. */
function pageSizes(bytes: Uint8Array): number[][] {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return Array.from({ length: doc.countPages() }, (_value, index) => {
      const [x0, y0, x1, y1] = doc.loadPage(index).getBounds();
      return [Math.round((x1 ?? 0) - (x0 ?? 0)), Math.round((y1 ?? 0) - (y0 ?? 0))];
    });
  } finally {
    doc.destroy();
  }
}

interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  readonly value: number;
}

/** A TIFF block: header, one directory of `entries`, in the given byte order. */
function tiff(
  littleEndian: boolean,
  entries: readonly Entry[],
  over: {
    readonly magic?: number;
    readonly offset?: number;
    readonly order?: readonly number[];
    readonly count?: number;
  } = {},
): number[] {
  const u16 = (value: number) => (littleEndian ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff]);
  const u32 = (value: number) =>
    littleEndian
      ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24]
      : [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  return [
    ...(over.order ?? (littleEndian ? [0x49, 0x49] : [0x4d, 0x4d])),
    ...u16(over.magic ?? 0x2a),
    ...u32(over.offset ?? 8),
    ...u16(over.count ?? entries.length),
    ...entries.flatMap((entry) => [
      ...u16(entry.tag),
      ...u16(entry.type),
      ...u32(entry.count),
      ...u16(entry.value),
      0,
      0,
    ]),
    0,
    0,
    0,
    0,
  ];
}

const orientation = (value: number, over: Partial<Entry> = {}): Entry => ({
  tag: 0x112,
  type: 3,
  count: 1,
  value,
  ...over,
});
const make: Entry = { tag: 0x010f, type: 2, count: 1, value: 0 };

/** An APP1 segment: the marker, its length and `payload`. */
function app1(payload: readonly number[]): number[] {
  const length = payload.length + 2;
  return [0xff, 0xe1, length >> 8, length & 0xff, ...payload];
}
const exif = (block: readonly number[]) => app1([0x45, 0x78, 0x69, 0x66, 0, 0, ...block]);

/** The JPEG with `segments` inserted straight after its start-of-image marker. */
function withSegments(...segments: readonly (readonly number[])[]): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...segments.flat(), ...jpeg.slice(2)]);
}

async function pageOf(image: Uint8Array, over: Partial<ImagesToPdfOptions> = {}) {
  const out = await imagesToPdf(options({ images: [{ name: 'a.jpg', bytes: image }], ...over }), run);
  return { sizes: pageSizes(out.bytes), keys: out.report.notes.map((entry) => entry.key) };
}

describe('EXIF orientation: what is applied', () => {
  it.each([
    ['little-endian', tiff(true, [orientation(6)])],
    ['big-endian', tiff(false, [orientation(6)])],
    ['after another tag', tiff(true, [make, orientation(6)])],
  ])('turns the page for a %s block', async (_name, block) => {
    const { sizes, keys } = await pageOf(withSegments(exif(block)));
    expect(sizes).toEqual([[4, 8]]);
    expect(keys).toEqual(['op.note.images.exif']);
  });

  it('does not turn the page when asked to leave the orientation alone', async () => {
    const { sizes, keys } = await pageOf(withSegments(exif(tiff(true, [orientation(6)]))), {
      applyExif: false,
    });
    expect(sizes).toEqual([[8, 4]]);
    expect(keys).toEqual([]);
  });

  it('finds the block after a segment that is not EXIF', async () => {
    const xmp = app1([...new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x/>')]);
    const { sizes } = await pageOf(withSegments(xmp, exif(tiff(true, [orientation(8)]))));
    expect(sizes).toEqual([[4, 8]]);
  });

  it('finds the block after fill bytes: any marker may be preceded by 0xFF padding', async () => {
    const { sizes } = await pageOf(withSegments([0xff, 0xff], exif(tiff(true, [orientation(8)]))));
    expect(sizes).toEqual([[4, 8]]);
  });
});

describe('EXIF orientation: what is ignored without failing', () => {
  it.each([
    ['an unknown byte order', tiff(true, [orientation(6)], { order: [0x58, 0x58] })],
    ['a wrong TIFF magic', tiff(true, [orientation(6)], { magic: 0x2b })],
    ['a directory beyond the segment', tiff(true, [orientation(6)], { offset: 4000 })],
    ['a block too short for a header', [0x49, 0x49, 0x2a, 0, 8, 0]],
    ['no orientation tag', tiff(true, [make])],
    ['an orientation that is not a SHORT', tiff(true, [orientation(6, { type: 4 })])],
    ['an orientation with two values', tiff(true, [orientation(6, { count: 2 })])],
    ['an orientation of zero', tiff(true, [orientation(0)])],
    ['an orientation of nine', tiff(true, [orientation(9)])],
    ['a directory announcing more entries than the segment holds', tiff(true, [make], { count: 40 })],
  ])('keeps the page upright for %s', async (_name, block) => {
    const { sizes, keys } = await pageOf(withSegments(exif(block)));
    expect(sizes).toEqual([[8, 4]]);
    expect(keys).toEqual([]);
  });

  it('keeps the page upright when the JPEG has no EXIF at all, or only a JFIF header', async () => {
    expect((await pageOf(jpeg)).sizes).toEqual([[8, 4]]);
    const jfif = [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
    expect((await pageOf(withSegments([0xff, 0xe0, 0, jfif.length + 2, ...jfif]))).sizes).toEqual([[8, 4]]);
  });

  it.each([0x01, 0xd0, 0xd7])('finds the block after the length-less marker FF %i', async (marker) => {
    const { sizes } = await pageOf(withSegments([0xff, marker], exif(tiff(true, [orientation(8)]))));
    expect(sizes).toEqual([[4, 8]]);
  });

  it('reads past a second start-of-image marker, which the decoder then refuses as a damaged file', async () => {
    const twice = withSegments([0xff, 0xd8], exif(tiff(true, [orientation(8)])));
    await expect(
      imagesToPdf(options({ images: [{ name: 'twice.jpg', bytes: twice }] }), run),
    ).rejects.toMatchObject({
      code: 'unsupported-format',
    });
  });

  it('reports a JPEG whose segment ends where no marker begins, instead of guessing at the rest', async () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0x41, 0x42, 0, 0, 0, 0, 0, 0]);
    await expect(
      imagesToPdf(options({ images: [{ name: 'broken.jpg', bytes: broken }] }), run),
    ).rejects.toMatchObject({
      code: 'unsupported-format',
    });
  });

  it('reports a JPEG whose first segment claims more bytes than the file has, instead of reading past the end', async () => {
    const cut = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xf0, 0x45, 0x78, 0x69, 0x66, 0, 0]);
    await expect(
      imagesToPdf(options({ images: [{ name: 'cut.jpg', bytes: cut }] }), run),
    ).rejects.toMatchObject({
      code: 'unsupported-format',
    });
  });
});

describe('imagesToPdf arguments', () => {
  it('refuses no images and an aborted signal before anything is read', async () => {
    await expect(imagesToPdf(options({ images: [] }), run)).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'no images were handed in' },
    });
    await expect(imagesToPdf(options(), { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('stops between images when the signal aborts, and keeps no partial file', async () => {
    const controller = new AbortController();
    await expect(
      imagesToPdf(
        options({
          images: [
            { name: 'a.png', bytes: png },
            { name: 'b.png', bytes: png },
          ],
        }),
        {
          signal: controller.signal,
          onProgress: ({ done }) => {
            if (done === 0) controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refuses a margin that is negative, not a number, or leaves no drawing area', async () => {
    for (const marginMm of [-1, Number.NaN]) {
      await expect(imagesToPdf(options({ marginMm }), run)).rejects.toMatchObject({
        code: 'range-invalid',
        details: { engineMessage: `margin ${marginMm} mm is not a positive length` },
      });
    }
    await expect(imagesToPdf(options({ pageSize: 'a4', marginMm: 150 }), run)).rejects.toMatchObject({
      code: 'range-invalid',
      details: {
        engineMessage: expect.stringMatching(/leaves no drawing area on a 595\.28x841\.89 pt page$/),
      },
    });
  });

  it('sizes a page to the paper or to a long side, and reports progress per image', async () => {
    const onProgress = vi.fn();
    const out = await imagesToPdf(
      options({
        images: [
          { name: 'a.png', bytes: png },
          { name: 'b.jpg', bytes: jpeg },
        ],
        pageSize: 'letter',
        fit: 'stretch',
      }),
      { signal: run.signal, onProgress },
    );
    expect(pageSizes(out.bytes)).toEqual([
      [612, 792],
      [612, 792],
    ]);
    expect(onProgress.mock.calls.map(([event]) => event.done)).toEqual([0, 1]);
    const scaled = await imagesToPdf(options({ fitLongSidePt: 80 }), run);
    expect(pageSizes(scaled.bytes)).toEqual([[80, 40]]);
    const turned = await imagesToPdf(
      options({
        images: [{ name: 'a.jpg', bytes: withSegments(exif(tiff(true, [orientation(6)]))) }],
        fitLongSidePt: 80,
      }),
      run,
    );
    expect(pageSizes(turned.bytes)).toEqual([[40, 80]]);
  });

  it('reports a file that has the signature but cannot be decoded, and one with no signature', async () => {
    const out = await imagesToPdf(
      options({
        images: [
          { name: 'bad.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
          { name: 'note.txt', bytes: new TextEncoder().encode('x') },
          { name: 'ok.png', bytes: png },
        ],
      }),
      run,
    );
    expect(out.report.notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.images.failed', { name: 'bad.jpg' }],
      ['op.note.images.unsupported', { name: 'note.txt' }],
    ]);
    expect(out.report.pageCount).toBe(1);
  });
});

describe('exportImages arguments', () => {
  const settings = { pages: [0], format: 'png' as const, dpi: 72, baseName: 'x', maxMegapixels: 16 };
  const doc = (() => {
    const document = new PDFDocument();
    document.insertPage(0, document.addPage([0, 0, 200, 100], 0, {}, ''));
    const bytes = new Uint8Array(document.saveToBuffer('').asUint8Array());
    document.destroy();
    return bytes;
  })();

  it('refuses nothing selected, a bad budget, a bad resolution and an aborted signal', async () => {
    await expect(exportImages(doc, { ...settings, pages: [] }, run)).rejects.toMatchObject({
      code: 'selection-empty',
    });
    await expect(exportImages(doc, { ...settings, maxMegapixels: 0 }, run)).rejects.toMatchObject({
      code: 'range-invalid',
      details: { engineMessage: 'megapixel budget 0 is not a positive number' },
    });
    await expect(exportImages(doc, { ...settings, maxMegapixels: Number.NaN }, run)).rejects.toMatchObject({
      code: 'range-invalid',
    });
    await expect(exportImages(doc, { ...settings, dpi: -1 }, run)).rejects.toMatchObject({
      code: 'range-invalid',
      details: { engineMessage: 'resolution -1 DPI is not a positive number' },
    });
    await expect(
      exportImages(doc, { ...settings, dpi: Number.POSITIVE_INFINITY }, run),
    ).rejects.toMatchObject({
      code: 'range-invalid',
    });
    await expect(exportImages(doc, settings, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it.each([1, -1, 0.5])(
    'refuses the page %s as outside the document, naming the page count',
    async (page) => {
      await expect(exportImages(doc, { ...settings, pages: [page] }, run)).rejects.toMatchObject({
        code: 'range-invalid',
        details: { engineMessage: `page ${page + 1} is outside the 1-page document` },
      });
    },
  );

  it('refuses a page over the megapixel budget, with the DPI that fits', async () => {
    await expect(exportImages(doc, { ...settings, dpi: 7200, maxMegapixels: 1 }, run)).rejects.toMatchObject({
      code: 'file-too-large',
      details: {
        engine: 'pdfjs',
        pageIndex: 0,
        engineMessage: expect.stringMatching(/the largest DPI that fits is 509$/),
      },
    });
  });
});
