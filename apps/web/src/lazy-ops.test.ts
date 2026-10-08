/**
 * The lazily loaded writers keep the signature of the function they stand for: a call
 * through `lazy-ops` must do exactly what the underlying operation does, on real bytes
 * read back through MuPDF.
 */

import { loadMupdf, openPdf } from 'pdf-core/engines/mupdf';
import { describe, expect, it } from 'vitest';
import { addImageStamp, convertToPdf, fillFormFields, imagesToPdf, resizeImageStamp } from './lazy-ops';

const run = { signal: new AbortController().signal };

async function blankPage(): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 200, 300], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

async function redPng(): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 4], false);
  const pixels = pixmap.getPixels();
  for (let at = 0; at < 8 * 4 * 3; at += 3) pixels.set([255, 0, 0], at);
  return new Uint8Array(pixmap.asPNG());
}

async function stampRects(bytes: Uint8Array): Promise<{ type: string; rect: number[] }[]> {
  const doc = openPdf(await loadMupdf(), bytes);
  try {
    return doc
      .loadPage(0)
      .getAnnotations()
      .map((annot) => ({ type: annot.getType(), rect: annot.getBounds() }));
  } finally {
    doc.destroy();
  }
}

describe('addImageStamp / resizeImageStamp through lazy-ops', () => {
  it('stamps a picture as a Stamp annotation and later resizes only its rectangle', async () => {
    const stamped = await addImageStamp(
      await blankPage(),
      {
        id: 'stamp-1',
        pageIndex: 0,
        center: { x: 100, y: 150 },
        width: 60,
        height: 40,
        image: await redPng(),
        role: 'signature',
        label: 'Signature',
        author: 'Tester',
      },
      run,
    );
    expect(await stampRects(stamped.bytes)).toEqual([{ type: 'Stamp', rect: [70, 130, 130, 170] }]);

    const resized = await resizeImageStamp(
      stamped.bytes,
      { pageIndex: 0, id: stamped.annotationId, rect: [20, 40, 100, 80] },
      run,
    );
    expect(await stampRects(resized.bytes)).toEqual([{ type: 'Stamp', rect: [20, 40, 100, 80] }]);
  });
});

describe('convertToPdf through lazy-ops', () => {
  it('turns a text file into a PDF page that holds its text', async () => {
    const out = await convertToPdf(
      {
        name: 'notlar.txt',
        bytes: new TextEncoder().encode('Çalışma notları'),
        pageSize: 'a4',
        orientation: 'portrait',
        marginMm: 15,
      },
      run,
    );
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      expect(doc.countPages()).toBe(1);
      expect(doc.loadPage(0).toStructuredText('preserve-whitespace').asText()).toContain('Çalışma notları');
    } finally {
      doc.destroy();
    }
  });
});

describe('imagesToPdf through lazy-ops', () => {
  it('makes one page of the image size from a PNG', async () => {
    const out = await imagesToPdf(
      {
        images: [{ name: 'a.png', bytes: await redPng() }],
        pageSize: 'fit',
        fit: 'contain',
        marginMm: 0,
        applyExif: true,
      },
      run,
    );
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      expect(doc.countPages()).toBe(1);
      expect(doc.loadPage(0).getBounds()).toEqual([0, 0, 8, 4]);
    } finally {
      doc.destroy();
    }
  });
});

describe('fillFormFields through lazy-ops', () => {
  it('writes the value of a text field into the file', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 400, 600], 0, {}, ''));
    const page = doc.findPage(0);
    const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    const widget = doc.addObject({
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [20, 540, 380, 570],
      P: page,
      F: 4,
      FT: 'Tx',
      T: doc.newString('ad'),
      DA: doc.newString('/Helv 12 Tf 0 g'),
      AP: { N: doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 360, 30] }) },
    });
    const annots = doc.newArray();
    annots.push(widget);
    page.put('Annots', annots);
    const acro = doc.addObject({ Fields: [widget], DR: { Font: { Helv: font } } });
    doc.getTrailer().get('Root').put('AcroForm', acro);
    const source = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();

    const out = await fillFormFields(source, [{ name: 'ad', value: 'Ayşe' }], run);
    const reread = openPdf(mupdf, out.bytes);
    try {
      const widgets = reread.loadPage(0).getWidgets();
      expect(widgets.map((entry) => [entry.getName(), entry.getValue()])).toEqual([['ad', 'Ayşe']]);
    } finally {
      reread.destroy();
    }
  });
});
