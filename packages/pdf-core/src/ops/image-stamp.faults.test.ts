/**
 * A stamp is read back after it is written. The real writer writes what it is told to, so the
 * save is wrapped at the writer's module seam: just before the bytes are produced, the document
 * is damaged in one chosen way, and the read-back has to refuse the file.
 */

import { ColorSpace, PDFDocument as Doc, type PDFDocument, Pixmap } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ damage: undefined as undefined | 'rect' | 'appearance' }));

vi.mock('../engines/mupdf-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf-write')>();
  return {
    ...actual,
    saveRewrite: (doc: PDFDocument, context?: string, options?: string) => {
      if (state.damage !== undefined) {
        for (let index = 1; index < doc.countObjects(); index += 1) {
          const object = doc.newIndirect(index).resolve();
          if (!object.isDictionary() || object.get('Subtype').isNull()) continue;
          if (object.get('Subtype').asName() !== 'Stamp') continue;
          if (state.damage === 'rect') {
            object.put('Rect', [0, 0, 1, 1]);
          }
          if (state.damage === 'appearance') object.delete('AP');
        }
      }
      return actual.saveRewrite(doc, context, options);
    },
  };
});

const { addImageStamp, resizeImageStamp } = await import('./image-stamp');

const run = { signal: new AbortController().signal };

function blank(): Uint8Array {
  const doc = new Doc();
  doc.insertPage(0, doc.addPage([0, 0, 200, 300], 0, {}, ''));
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

const stamp = {
  id: 's',
  pageIndex: 0,
  center: { x: 100, y: 150 },
  width: 60,
  height: 40,
  image: jpeg(),
  role: 'signature' as const,
  label: 'x',
  author: 'a',
};

afterEach(() => {
  state.damage = undefined;
});

describe('stamp read-back', () => {
  it('refuses a stamp whose appearance no longer draws an image', async () => {
    state.damage = 'appearance';
    await expect(addImageStamp(blank(), stamp, run)).rejects.toMatchObject({
      code: 'verification-failed',
    });
  });

  it('refuses a resize whose written rectangle is not the one the file carries', async () => {
    const placed = await addImageStamp(blank(), stamp, run);
    state.damage = 'rect';
    await expect(
      resizeImageStamp(placed.bytes, { pageIndex: 0, id: placed.annotationId, rect: [20, 40, 100, 80] }, run),
    ).rejects.toMatchObject({ code: 'verification-failed' });
  });
});
