/**
 * Image stamps on inputs the main tests do not use: a JPEG picture, a page with no /Rotate,
 * a stamp without a label, a page without annotations, an annotation entry that is no object,
 * a page that is not there, and non-finite numbers.
 */

import { ColorSpace, PDFDocument, Pixmap } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { addImageStamp, type ImageStampRequest, resizeImageStamp } from './image-stamp';

const run = { signal: new AbortController().signal };

function page(build: (doc: PDFDocument) => void = () => {}): Uint8Array {
  const doc = new PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 200, 300], 0, {}, ''));
  doc.findPage(0).delete('Rotate');
  build(doc);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function jpeg(): Uint8Array {
  const pixmap = new Pixmap(ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
  pixmap.clear(120);
  const bytes = new Uint8Array(pixmap.asJPEG(80));
  pixmap.destroy();
  return bytes;
}

const request = (patch: Partial<ImageStampRequest> = {}): ImageStampRequest => ({
  id: 'stamp-1',
  pageIndex: 0,
  center: { x: 100, y: 150 },
  width: 60,
  height: 40,
  image: jpeg(),
  role: 'signature',
  label: 'Signature',
  author: 'Tester',
  ...patch,
});

function annotations(bytes: Uint8Array) {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const annots = doc.findPage(0).get('Annots');
    return Array.from({ length: annots.length }, (_unused, index) => {
      const dict = annots.get(index).resolve();
      return {
        subtype: dict.get('Subtype').asName(),
        contents: dict.get('Contents').isNull() ? null : dict.get('Contents').asString(),
        rect: [0, 1, 2, 3].map((i) => dict.get('Rect').get(i).asNumber()),
      };
    });
  } finally {
    doc.destroy();
  }
}

describe('addImageStamp edge cases', () => {
  it('stamps a JPEG on a page without /Rotate, and writes no /Contents for an empty label', async () => {
    const out = await addImageStamp(page(), request({ label: '   ' }), run);
    expect(annotations(out.bytes)).toEqual([{ subtype: 'Stamp', contents: null, rect: [70, 130, 130, 170] }]);
  });

  it('refuses a width or centre that is not a number, and a page that is not there', async () => {
    await expect(addImageStamp(page(), request({ width: Number.NaN }), run)).rejects.toMatchObject({
      code: 'range-invalid',
    });
    await expect(
      addImageStamp(page(), request({ center: { x: Number.POSITIVE_INFINITY, y: 0 } }), run),
    ).rejects.toMatchObject({ code: 'range-invalid' });
    await expect(addImageStamp(page(), request({ pageIndex: 3 }), run)).rejects.toMatchObject({
      code: 'range-invalid',
    });
  });

  it('refuses bytes that carry a picture signature but no picture', async () => {
    await expect(
      addImageStamp(page(), request({ image: new Uint8Array([0xff, 0xd8, 0xff, 0x00, 1, 2, 3]) }), run),
    ).rejects.toMatchObject({ name: 'ToolError' });
  });
});

describe('resizeImageStamp edge cases', () => {
  it('refuses a box with a non-numeric corner, and a page that is not there', async () => {
    const placed = await addImageStamp(page(), request(), run);
    await expect(
      resizeImageStamp(
        placed.bytes,
        { pageIndex: 0, id: placed.annotationId, rect: [0, 0, Number.NaN, 50] },
        run,
      ),
    ).rejects.toMatchObject({ code: 'range-invalid' });
    await expect(
      resizeImageStamp(placed.bytes, { pageIndex: 5, id: placed.annotationId, rect: [0, 0, 50, 50] }, run),
    ).rejects.toMatchObject({ code: 'range-invalid' });
  });

  it('answers that the stamp is not there on a page without annotations or with an id that is no stamp reference', async () => {
    const rect = [10, 10, 50, 50] as const;
    await expect(resizeImageStamp(page(), { pageIndex: 0, id: '5R', rect }, run)).rejects.toMatchObject({
      code: 'selection-empty',
    });
    const placed = await addImageStamp(page(), request(), run);
    await expect(
      resizeImageStamp(placed.bytes, { pageIndex: 0, id: 'abc', rect }, run),
    ).rejects.toMatchObject({
      code: 'selection-empty',
    });
  });

  it('answers that the stamp is not there when its entry resolves to something that is no dictionary', async () => {
    let number = 0;
    const bytes = page((doc) => {
      const odd = doc.addObject(doc.newInteger(7));
      number = odd.asIndirect();
      const annots = doc.newArray();
      annots.push(odd);
      doc.findPage(0).put('Annots', annots);
    });
    await expect(
      resizeImageStamp(bytes, { pageIndex: 0, id: `${number}R`, rect: [10, 10, 50, 50] }, run),
    ).rejects.toMatchObject({ code: 'selection-empty' });
  });
});
