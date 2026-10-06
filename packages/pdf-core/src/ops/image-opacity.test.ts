/**
 * Image opacity against real bytes. The wrong answers that matter: a state wrapped around
 * the wrong image (`/Im1` matched inside `/Im10`), a content array whose parts are lost when
 * it is joined, and a state that is written but never selected — the image then paints as
 * before and the file claims otherwise.
 */

import { describe, expect, it } from 'vitest';
import { applyImageOpacity } from './image-opacity';

const run = { signal: new AbortController().signal };

/**
 * One page drawing a black image as `/Im1` and the same image as `/Im10`, with the content
 * split over two streams.
 */
async function imagePage(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
  pixmap.clear(0);
  const image = doc.addImage(new mupdf.Image(pixmap));
  const page = doc.addPage([0, 0, 200, 100], 0, { XObject: { Im1: image, Im10: image } }, '');
  page.put('Contents', [
    doc.addStream('q 80 0 0 80 10 10 cm /Im1 Do Q\n', {}),
    doc.addStream('q 80 0 0 80 110 10 cm /Im10 Do Q\n', {}),
  ]);
  doc.insertPage(0, page);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Grey level at a point of page 1, rendered at 72 dpi (0 black, 255 white). */
async function greyAt(bytes: Uint8Array, x: number, y: number): Promise<number> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false);
    return pixmap.getPixels()[y * pixmap.getWidth() + x] ?? -1;
  } finally {
    doc.destroy();
  }
}

describe('applyImageOpacity', () => {
  it('paints the named image fainter and leaves an image with a longer name alone', async () => {
    const input = await imagePage();
    expect(await greyAt(input, 50, 50)).toBe(0);

    const out = await applyImageOpacity(input, { pageIndex: 0, name: 'Im1', opacity: 0.4 }, run);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.image.opacityWrapped');
    // 40 % black over white.
    expect(Math.abs((await greyAt(out.bytes, 50, 50)) - 153)).toBeLessThanOrEqual(2);
    expect(await greyAt(out.bytes, 150, 50)).toBe(0);
  });

  it('restores full opacity when asked for 1', async () => {
    const faint = await applyImageOpacity(
      await imagePage(),
      { pageIndex: 0, name: 'Im1', opacity: 0.4 },
      run,
    );
    const back = await applyImageOpacity(faint.bytes, { pageIndex: 0, name: 'Im1', opacity: 1 }, run);
    expect(await greyAt(back.bytes, 50, 50)).toBe(0);
  });

  it('refuses a name the page does not draw and an opacity outside 0…1', async () => {
    const input = await imagePage();
    await expect(
      applyImageOpacity(input, { pageIndex: 0, name: 'Im2', opacity: 0.5 }, run),
    ).rejects.toMatchObject({
      code: 'selection-empty',
    });
    await expect(
      applyImageOpacity(input, { pageIndex: 0, name: 'Im1', opacity: 2 }, run),
    ).rejects.toMatchObject({
      code: 'value-out-of-range',
    });
    await expect(
      applyImageOpacity(input, { pageIndex: 4, name: 'Im1', opacity: 0.5 }, run),
    ).rejects.toMatchObject({
      code: 'value-out-of-range',
    });
  });
});
