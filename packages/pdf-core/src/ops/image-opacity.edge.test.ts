/**
 * Image opacity on pages a producer may write differently: every byte that can end a `Do`
 * token, a page with no contents or with contents that are no stream, an image that is named
 * in the resources but never drawn, a page without resources, and a cancelled run.
 */

import { ColorSpace, Image, PDFDocument, Pixmap } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { applyImageOpacity } from './image-opacity';

const run = { signal: new AbortController().signal };

/** One page with the image as `/Im1`; `build` may change the page before it is saved. */
function page(
  content: string,
  build: (doc: PDFDocument, page: ReturnType<PDFDocument['findPage']>) => void = () => {},
) {
  const doc = new PDFDocument();
  const pixmap = new Pixmap(ColorSpace.DeviceGray, [0, 0, 4, 4], false);
  pixmap.clear(0);
  const image = doc.addImage(new Image(pixmap));
  doc.insertPage(0, doc.addPage([0, 0, 200, 100], 0, { XObject: { Im1: image } }, content));
  build(doc, doc.findPage(0));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const request = { pageIndex: 0, name: 'Im1', opacity: 0.5 };

describe('applyImageOpacity edge cases', () => {
  it('wraps a Do that ends the stream or is followed by any PDF delimiter, and not one run into a longer word', async () => {
    for (const after of ['', ' ', '\n', '\r', '\t', '/', '[', ']', '<', '>', '(', ')', '{', '}', '%']) {
      const out = await applyImageOpacity(page(`q /Im1 Do${after}`), request, run);
      const wrapped = out.report.notes.find((entry) => entry.key === 'op.note.image.opacityWrapped');
      expect(wrapped?.params).toMatchObject({ count: 1 });
    }
    await expect(applyImageOpacity(page('q /Im1 Dox Q'), request, run)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('wraps every drawing of the image on the page', async () => {
    const out = await applyImageOpacity(page('q /Im1 Do Q q /Im1 Do Q'), request, run);
    expect(
      out.report.notes.find((entry) => entry.key === 'op.note.image.opacityWrapped')?.params,
    ).toMatchObject({
      count: 2,
    });
  });

  it('refuses a page without contents', async () => {
    const bytes = page('', (_doc, target) => target.delete('Contents'));
    await expect(applyImageOpacity(bytes, request, run)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('refuses contents that are not streams', async () => {
    const bytes = page('', (doc, target) => {
      const broken = doc.newArray();
      broken.push(doc.newInteger(3));
      target.put('Contents', broken);
    });
    await expect(applyImageOpacity(bytes, request, run)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('refuses an image that the resources name but the content never draws', async () => {
    await expect(applyImageOpacity(page('q 1 0 0 1 0 0 cm Q'), request, run)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('refuses a page without resources', async () => {
    const bytes = page('q /Im1 Do Q', (_doc, target) => target.delete('Resources'));
    await expect(applyImageOpacity(bytes, request, run)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('picks a state name the page does not already use', async () => {
    const bytes = page('q /Im1 Do Q', (doc, target) => {
      const states = doc.newDictionary();
      states.put('GS50', doc.newDictionary());
      states.put('GS50_1', doc.newDictionary());
      target.get('Resources').put('ExtGState', states);
    });
    const out = await applyImageOpacity(bytes, request, run);
    expect(
      out.report.notes.find((entry) => entry.key === 'op.note.image.opacityWrapped')?.params,
    ).toMatchObject({
      state: 'GS50_2',
    });
  });

  it('stops with an abort error when the signal is aborted before the save', async () => {
    const controller = new AbortController();
    await expect(
      applyImageOpacity(page('q /Im1 Do Q'), request, {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
