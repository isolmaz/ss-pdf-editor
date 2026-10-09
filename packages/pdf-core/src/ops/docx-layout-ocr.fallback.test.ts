/**
 * A scan with an annotation on it, whose shapes are read again without the annotation (the
 * render holds it): when that second read fails, the page keeps the shapes of the first.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { writeLayoutDocx } from './docx-layout';
import * as reader from './layout-scene-read';
import type { OperationContext } from './types';

vi.mock('./layout-scene-read', async (importOriginal) => {
  const original = await importOriginal<typeof import('./layout-scene-read')>();
  return { ...original, readPageScene: vi.fn(original.readPageScene) };
});

const run: OperationContext = { signal: new AbortController().signal };

describe('exact layout: the shapes of a scan page with an annotation', () => {
  it('keep the first read when the read without the annotation fails', async () => {
    const mupdf = await loadMupdf();
    const original = vi.mocked(reader.readPageScene).getMockImplementation();
    vi.mocked(reader.readPageScene).mockImplementation((m, page, contentsOnly) => {
      if (contentsOnly === true) throw new RangeError('a drawing nobody foresaw');
      return (original as typeof reader.readPageScene)(m, page, contentsOnly);
    });
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 50], false);
    pixmap.clear(230);
    const doc = new mupdf.PDFDocument();
    const image = doc.addImage(new mupdf.Image(pixmap));
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, 400, 500],
        0,
        { XObject: { Im0: image } },
        'q 400 0 0 500 0 0 cm /Im0 Do Q\n0.2 0.2 0.8 rg 40 40 100 20 re f\n',
      ),
    );
    const annotations = doc.newArray();
    annotations.push(
      doc.addObject({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [200, 200, 260, 240],
        F: 4,
        AP: {
          N: doc.addStream('1 0 0 rg 0 0 60 40 re f', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [0, 0, 60, 40],
          }),
        },
      }),
    );
    doc.loadPage(0).getObject().put('Annots', annotations);
    const opened = openPdf(mupdf, doc.saveToBuffer('compress').asUint8Array().slice());
    try {
      const result = await writeLayoutDocx(opened, [0], 'Scan', 'en-US', run, {
        lowConfidence: 0.9,
        recognize: async () => [],
      });
      expect(result.ocr.pages).toEqual([1]);
      // the page colour, the picture of the render's one mark, and the first read's shapes (the bar and the annotation)
      expect(result.shapes).toBeGreaterThanOrEqual(3);
    } finally {
      opened.destroy();
      vi.mocked(reader.readPageScene).mockImplementation(original as typeof reader.readPageScene);
      doc.destroy();
    }
  });
});
