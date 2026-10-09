/**
 * What the Word export carries of what the reader sees. Form fields in the exact layout: a
 * field's value is drawn by its appearance stream, which the page's own text does not include,
 * so a filled field must come out as text (a text box where the field is), and a field whose
 * value nothing draws is named under Losses instead of vanishing. The flowing layout leaves out
 * the text the document itself hides (render mode 3), but keeps the invisible layer of an OCR'd
 * scan, the only text such a page has.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { exportOffice } from './export-office';
import { line, officeDocument } from './export-office-fixtures';
import { createFormFields, fillFormFields } from './forms';
import { blankForm, formPdf, widgetBody } from './forms.fixtures';
import type { OperationContext } from './types';

const run: OperationContext = { signal: new AbortController().signal };

async function documentXml(bytes: Uint8Array, docxLayout: 'layout' | 'flow') {
  const out = await exportOffice(bytes, { pages: [0], format: 'docx', docxLayout, baseName: 'x.pdf' }, run);
  const zip = await JSZip.loadAsync(out.file.bytes);
  const xml = await (zip.file('word/document.xml') as JSZip.JSZipObject).async('string');
  // The words, as Word shows them: the text runs joined.
  const text = [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => match[1]).join('');
  return { xml, text, notes: out.notes };
}

const lost = (notes: readonly { readonly key: string; readonly params?: unknown }[]) =>
  notes.find((entry) => entry.key === 'op.note.exportOffice.layoutFieldsLost');

describe('exact layout: form fields', () => {
  beforeEach(() => {
    const require = createRequire(import.meta.url);
    const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
      paths: [process.cwd()],
    });
    const font = new Uint8Array(readFileSync(file));
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes a filled text field and a checked box where the field is, with no loss', async () => {
    let bytes = await officeDocument([{ content: line('helvetica', 12, 60, 400, 'Applicant name:') }]);
    bytes = (
      await createFormFields(
        bytes,
        [
          { kind: 'text', name: 'name', pageIndex: 0, rect: [60, 300, 200, 20] },
          { kind: 'checkbox', name: 'agree', pageIndex: 0, rect: [60, 250, 14, 14] },
        ],
        run,
      )
    ).bytes;
    bytes = (
      await fillFormFields(
        bytes,
        [
          { name: 'name', value: 'Zeynep Örnek' },
          { name: 'agree', value: true },
        ],
        run,
      )
    ).bytes;
    const exact = await documentXml(bytes, 'layout');
    expect(exact.text).toContain('Applicant name:');
    expect(exact.text).toContain('Zeynep Örnek');
    expect(lost(exact.notes)).toBeUndefined();
    // The flowing layout does not carry fields, and says so.
    const flow = await documentXml(bytes, 'flow');
    expect(flow.text).not.toContain('Zeynep');
    expect(flow.notes.map((entry) => entry.key)).toContain('op.note.exportOffice.docxApproximate');
  });

  it('names the fields whose value nothing draws, and only those', async () => {
    const field = (more: string) => widgetBody('50 500 250 520', more);
    const bytes = formPdf({
      fields: '[10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 15 0 R]',
      annots: '[10 0 R 11 0 R 12 0 R 13 0 R 14 0 R 15 0 R]',
      extra: {
        // A value whose appearance draws nothing, and a checked box whose appearance draws nothing: both lost.
        10: field('/FT/Tx/T(a)/V(Typed value)/DA(/Helv 12 Tf 0 g)/AP<</N 20 0 R>>'),
        11: widgetBody('50 450 64 464', '/FT/Btn/T(b)/V/Yes/AS/Yes/AP<</N<</Yes 20 0 R/Off 20 0 R>>>>'),
        20: blankForm(200, 20),
        // Nothing to carry: an empty field, an unchecked box, a hidden field, a signature.
        12: field('/FT/Tx/T(c)/V()/DA(/Helv 12 Tf 0 g)'),
        13: widgetBody('50 400 64 414', '/FT/Btn/T(d)/V/Off/AS/Off'),
        14: widgetBody('50 350 250 370', '/FT/Tx/T(e)/V(Hidden value)/DA(/Helv 12 Tf 0 g)').replace(
          '/F 4',
          '/F 2',
        ),
        15: widgetBody('50 300 250 320', '/FT/Sig/T(f)/V(x)'),
      },
    });
    const exact = await documentXml(bytes, 'layout');
    expect(exact.text).not.toContain('Typed value');
    expect(exact.text).not.toContain('Hidden value');
    expect(lost(exact.notes)?.params).toEqual({ count: 2 });
  });

  it('counts a checked box drawn with a picture, a mask and a gradient as seen', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const tile = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 4, 4], false);
    tile.clear(0);
    const picture = doc.addImage(new mupdf.Image(tile));
    tile.destroy();
    const mask = doc.addStream(new Uint8Array([0xf0]), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 4,
      Height: 1,
      ImageMask: true,
      BitsPerComponent: 1,
    });
    const shade = doc.addObject({
      ShadingType: 2,
      ColorSpace: 'DeviceRGB',
      Coords: [0, 0, 20, 0],
      Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [0, 0, 1], N: 1 },
    });
    const drawn = doc.addStream('q 10 0 0 10 0 0 cm /Im Do Q q 10 0 0 10 10 0 cm /Mk Do Q /Sh0 sh', {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 20, 20],
      Resources: { XObject: { Im: picture, Mk: mask }, Shading: { Sh0: shade } },
    });
    doc.insertPage(-1, doc.addPage([0, 0, 400, 500], 0, {}, ''));
    const page = doc.findPage(0);
    const widget = doc.addObject({
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [50, 400, 70, 420],
      P: page,
      F: 4,
      FT: 'Btn',
      T: doc.newString('box'),
      V: 'Yes',
      AS: 'Yes',
      AP: { N: { Yes: drawn, Off: drawn } },
    });
    page.put('Annots', [widget]);
    doc
      .getTrailer()
      .get('Root')
      .put('AcroForm', { Fields: [widget] });
    const saved = doc.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    doc.destroy();
    const exact = await documentXml(bytes, 'layout');
    expect(lost(exact.notes)).toBeUndefined();
  });

  it('still reads a scanned page with a filled field as a scan', async () => {
    const mupdf = await loadMupdf();
    const scan = new mupdf.PDFDocument();
    const tile = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
    tile.clear(255);
    const image = scan.addImage(new mupdf.Image(tile));
    tile.destroy();
    scan.insertPage(
      -1,
      scan.addPage([0, 0, 400, 500], 0, { XObject: { Im0: image } }, 'q 400 0 0 500 0 0 cm /Im0 Do Q\n'),
    );
    const saved = scan.saveToBuffer('compress');
    let bytes: Uint8Array = saved.asUint8Array().slice();
    saved.destroy();
    scan.destroy();
    bytes = (
      await createFormFields(
        bytes,
        [{ kind: 'text', name: 'name', pageIndex: 0, rect: [60, 300, 200, 20] }],
        run,
      )
    ).bytes;
    bytes = (await fillFormFields(bytes, [{ name: 'name', value: 'Filled in' }], run)).bytes;
    const out = await exportOffice(
      bytes,
      { pages: [0], format: 'docx', docxLayout: 'layout', baseName: 's.pdf' },
      run,
    );
    // No recogniser was given: a scan is reported as one, and the field's value is carried all the same.
    expect(out.notes.map((entry) => entry.key)).toContain('op.note.exportOffice.ocrUnavailable');
    const zip = await JSZip.loadAsync(out.file.bytes);
    expect(await (zip.file('word/document.xml') as JSZip.JSZipObject).async('string')).toContain('Filled');
  });
});

describe('flowing layout: hidden text', () => {
  it('leaves out the document’s own invisible text, whole lines and the tail of a line', async () => {
    const bytes = await officeDocument([
      {
        content: [
          line('helvetica', 12, 60, 400, 'VISIBLEWORD'),
          'BT /F3 12 Tf 3 Tr 60 386 Td (HIDDENLINE) Tj ET',
          'BT /F3 12 Tf 0 Tr 60 300 Td (Shown ) Tj ET',
          'BT /F3 12 Tf 3 Tr 93 300 Td (HIDDENTAIL) Tj ET',
        ].join('\n'),
      },
    ]);
    const flow = await documentXml(bytes, 'flow');
    expect(flow.text).toContain('VISIBLEWORD');
    expect(flow.text).toContain('Shown');
    expect(flow.text).not.toContain('HIDDEN');
  });

  it('keeps the invisible layer of a scanned page, the only text it has', async () => {
    const mupdf = await loadMupdf();
    const scan = new mupdf.PDFDocument();
    const tile = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
    tile.clear(255);
    const image = scan.addImage(new mupdf.Image(tile));
    tile.destroy();
    const font = scan.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    scan.insertPage(
      -1,
      scan.addPage(
        [0, 0, 400, 500],
        0,
        { XObject: { Im0: image }, Font: { F1: font } },
        'q 400 0 0 500 0 0 cm /Im0 Do Q\nBT /F1 14 Tf 3 Tr 60 400 Td (Recognized words here) Tj ET\n',
      ),
    );
    const saved = scan.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    scan.destroy();
    const flow = await documentXml(bytes, 'flow');
    expect(flow.text).toContain('Recognized words here');
  });

  it('drops hidden text on a page that has visible text over a picture, as the exact layout does', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const tile = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
    tile.clear(255);
    const image = doc.addImage(new mupdf.Image(tile));
    tile.destroy();
    const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, 400, 500],
        0,
        { XObject: { Im0: image }, Font: { F1: font } },
        'q 400 0 0 500 0 0 cm /Im0 Do Q\nBT /F1 14 Tf 0 Tr 60 400 Td (Stamped) Tj ET\nBT /F1 14 Tf 3 Tr 60 300 Td (SECRETLAYER) Tj ET\n',
      ),
    );
    const saved = doc.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    doc.destroy();
    const flow = await documentXml(bytes, 'flow');
    expect(flow.text).toContain('Stamped');
    expect(flow.text).not.toContain('SECRETLAYER');
  });
});
