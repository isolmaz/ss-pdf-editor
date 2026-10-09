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

const shapesOf = (notes: readonly { readonly key: string; readonly params?: unknown }[]) =>
  (
    notes.find((entry) => entry.key === 'op.note.exportOffice.layout')?.params as
      | { shapes: number }
      | undefined
  )?.shapes;

/** Whether `text` holds a control character or any of `extra` (a raw glyph code that was not mapped). */
const hasRaw = (text: string, extra: string): boolean =>
  [...text].some((char) => (char.codePointAt(0) as number) < 0x20 || extra.includes(char));

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
    // The checked box is drawn: its mark is one more shape than the same box unchecked has.
    const unchecked = (await fillFormFields(bytes, [{ name: 'agree', value: false }], run)).bytes;
    expect(shapesOf(exact.notes)).toBeGreaterThan(shapesOf((await documentXml(unchecked, 'layout')).notes));
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

/** A form XObject of `content`: Helvetica as /F1, ZapfDingbats as /Z, an opacity-0 state as /G0. */
function appearance(content: string, width = 200, height = 20): string {
  return `<</Type/XObject/Subtype/Form/BBox[0 0 ${width} ${height}]/Resources<</Font<</F1 30 0 R/Z 31 0 R>>/ExtGState<</G0<</ca 0>>>>>>/Length ${content.length}>>\nstream\n${content}\nendstream`;
}

const FONTS = {
  30: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  31: '<</Type/Font/Subtype/Type1/BaseFont/ZapfDingbats>>',
  // The square a checked box draws when it draws a path.
  40: appearance('0 0 10 10 re f', 10, 10),
};

/** A widget of `kind` on page 1 at `rect`, its normal appearance object `ap`. */
const widget = (rect: string, ap: number, more: string): string =>
  widgetBody(rect, `/AP<</N ${ap} 0 R>>${more}`);

describe('exact layout: what the reader sees of a field or an annotation', () => {
  it('leaves out text an appearance draws without showing it, and keeps what it shows', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R 11 0 R]',
      extra: {
        ...FONTS,
        20: appearance(
          [
            'BT /F1 12 Tf 2 5 Td (ShownText) Tj ET',
            'BT /F1 12 Tf 3 Tr 80 5 Td (SecretTr) Tj ET',
            'q /G0 gs BT /F1 12 Tf 160 5 Td (SecretAlpha) Tj ET Q',
          ].join('\n'),
          300,
        ),
        10: widget('50 500 350 520', 20, '/FT/Tx/T(a)/V(ShownText)/DA(/Helv 12 Tf 0 g)'),
        // A FreeText annotation is text the page shows too, hidden text in its appearance as well.
        21: appearance('BT /F1 12 Tf 2 5 Td (NoteShown) Tj ET BT /F1 12 Tf 3 Tr 90 5 Td (NoteSecret) Tj ET'),
        11: `<</Type/Annot/Subtype/FreeText/Rect[50 400 250 420]/P 3 0 R/F 4/Contents(NoteShown)/DA(/Helv 12 Tf 0 g)/AP<</N 21 0 R>>>>`,
      },
    });
    const exact = await documentXml(bytes, 'layout');
    expect(exact.text).toContain('ShownText');
    expect(exact.text).toContain('NoteShown');
    expect(exact.text).not.toContain('Secret');
    expect(lost(exact.notes)).toBeUndefined();
  });

  it('writes a ZapfDingbats mark as the symbol it draws, and names a mark it cannot place', async () => {
    const bytes = formPdf({
      fields: '[10 0 R 11 0 R 12 0 R]',
      annots: '[10 0 R 11 0 R 12 0 R]',
      extra: {
        ...FONTS,
        // Check mark, star and an unknown glyph (code a), each the only drawing of a checked box.
        20: appearance('BT /Z 12 Tf 2 4 Td (4) Tj ET', 14, 14),
        21: appearance('BT /Z 12 Tf 2 4 Td (H) Tj ET', 14, 14),
        22: appearance('BT /Z 12 Tf 2 4 Td (a) Tj ET', 14, 14),
        10: widget('50 500 64 514', 20, '/FT/Btn/T(a)/V/Yes/AS/Yes'),
        11: widget('50 450 64 464', 21, '/FT/Btn/T(b)/V/Yes/AS/Yes'),
        12: widget('50 400 64 414', 22, '/FT/Btn/T(c)/V/Yes/AS/Yes'),
      },
    });
    const exact = await documentXml(bytes, 'layout');
    expect(exact.text).toContain('\u2714');
    expect(exact.text).toContain('\u2605');
    expect(hasRaw(exact.text, '4Ha')).toBe(false);
    expect(lost(exact.notes)?.params).toEqual({ count: 1 });
  });

  it('draws the check mark of a box that has no appearance stream', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      extra: {
        10: widgetBody(
          '50 500 64 514',
          '/FT/Btn/T(a)/V/Yes/AS/Yes/MK<</CA(4)/BC[0 0 0]>>/DA(/ZaDb 0 Tf 0 g)',
        ),
      },
    });
    const exact = await documentXml(bytes, 'layout');
    expect(hasRaw(exact.text, '3')).toBe(false);
    expect(lost(exact.notes)).toBeUndefined();
  });

  it('judges a radio button by its own state, not its group’s value', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[11 0 R 12 0 R]',
      extra: {
        ...FONTS,
        41: appearance('', 14, 14),
        10: '<</FT/Btn/Ff 32768/T(g)/V/B/Kids[11 0 R 12 0 R]>>',
        // The first button is off and draws nothing there; the second is on and draws a square.
        11: '<</Type/Annot/Subtype/Widget/Rect[50 500 64 514]/P 3 0 R/F 4/Parent 10 0 R/AS/Off/AP<</N<</B 40 0 R/Off 41 0 R>>>>>>',
        12: '<</Type/Annot/Subtype/Widget/Rect[50 450 64 464]/P 3 0 R/F 4/Parent 10 0 R/AS/B/AP<</N<</B 40 0 R/Off 41 0 R>>>>>>',
      },
    });
    expect(lost((await documentXml(bytes, 'layout')).notes)).toBeUndefined();
  });

  it('counts a checked box with no state of its own by its value', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      extra: { ...FONTS, 10: widget('50 500 64 514', 40, '/FT/Btn/T(a)/V/Yes') },
    });
    expect(lost((await documentXml(bytes, 'layout')).notes)).toBeUndefined();
  });

  it('leaves out a field the viewer does not show — no-view, or in an optional-content group that is off — and does not report it', async () => {
    const bytes = formPdf({
      fields: '[10 0 R 11 0 R]',
      annots: '[10 0 R 11 0 R]',
      extra: {
        ...FONTS,
        1: '<</Type/Catalog/Pages 2 0 R/AcroForm 5 0 R/OCProperties<</OCGs[50 0 R]/D<</OFF[50 0 R]>>>>>>',
        50: '<</Type/OCG/Name(Off layer)>>',
        20: appearance('BT /F1 12 Tf 2 5 Td (Secret) Tj ET'),
        10: widget('50 500 250 520', 20, '/FT/Tx/T(a)/V(Secret)/DA(/Helv 12 Tf 0 g)').replace(
          '/F 4',
          '/F 32',
        ),
        11: widget('50 400 250 420', 20, '/FT/Tx/T(b)/V(Secret)/DA(/Helv 12 Tf 0 g)/OC 50 0 R'),
      },
    });
    const exact = await documentXml(bytes, 'layout');
    expect(exact.text).not.toContain('Secret');
    expect(lost(exact.notes)).toBeUndefined();
  });

  it('exports the page when a field’s parents loop, and says nothing of that field', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      extra: {
        ...FONTS,
        20: appearance('BT /F1 12 Tf 2 5 Td (Looped) Tj ET'),
        10: widget('50 500 250 520', 20, '/FT/Tx/T(a)/V(Looped)/Parent 11 0 R'),
        11: '<</Parent 12 0 R>>',
        12: '<</Parent 11 0 R>>',
      },
    });
    const exact = await documentXml(bytes, 'layout');
    expect(exact.text).toContain('Looped');
    expect(lost(exact.notes)).toBeUndefined();
  });

  it('counts the characters an appearance cannot read among the unreadable ones', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      extra: {
        32: '<</Type/Font/Subtype/Type1/BaseFont/Courier/ToUnicode 33 0 R>>',
        33: '<</Length 168>>\nstream\n/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <01> <0001> endbfchar endcmap end end\nendstream',
        20: `<</Type/XObject/Subtype/Form/BBox[0 0 200 20]/Resources<</Font<</F1 32 0 R>>>>/Length 37>>\nstream\nBT /F1 12 Tf 2 5 Td (a\x01b\x01) Tj ET\nendstream`,
        10: widget('50 500 250 520', 20, '/FT/Tx/T(a)/V(ab)/DA(/Helv 12 Tf 0 g)'),
      },
    });
    const out = await exportOffice(
      bytes,
      { pages: [0], format: 'docx', docxLayout: 'layout', baseName: 'x.pdf' },
      run,
    );
    expect(out.notes.find((entry) => entry.key === 'op.note.exportOffice.unreadable')?.params).toEqual({
      count: 2,
    });
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
    // What was left out is said, in characters.
    expect(flow.notes.find((entry) => entry.key === 'op.note.exportOffice.hiddenText')?.params).toEqual({
      count: 'HIDDENLINE'.length + 'HIDDENTAIL'.length,
    });
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

  /** A 400 × 500 page: a picture of `height` points from its bottom edge, then `content`. */
  async function pictured(height: number, content: string): Promise<Uint8Array> {
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
        `q 400 0 0 ${height} 0 0 cm /Im0 Do Q\n${content}`,
      ),
    );
    const saved = doc.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    doc.destroy();
    return bytes;
  }

  it('keeps a scan’s invisible layer when the page also carries visible text, such as a Bates number', async () => {
    const bytes = await pictured(
      500,
      'BT /F1 14 Tf 3 Tr 60 400 Td (Recognized words of the scan) Tj ET\nBT /F1 10 Tf 0 Tr 20 20 Td (BATES-000123) Tj ET\n',
    );
    const flow = await documentXml(bytes, 'flow');
    expect(flow.text).toContain('Recognized words of the scan');
    expect(flow.text).toContain('BATES-000123');
    expect(flow.notes.some((entry) => entry.key === 'op.note.exportOffice.hiddenText')).toBe(false);
  });

  it('keeps hidden text over the picture and drops it over blank paper, on a page mostly picture', async () => {
    // The picture covers the lower 52 % of the page; y 100 is over it, y 450 is over paper.
    const bytes = await pictured(
      260,
      'BT /F1 14 Tf 3 Tr 60 100 Td (LayerWords) Tj ET\nBT /F1 14 Tf 3 Tr 60 450 Td (SmuggledSecret) Tj ET\n',
    );
    const flow = await documentXml(bytes, 'flow');
    expect(flow.text).toContain('LayerWords');
    expect(flow.text).not.toContain('Smuggled');
    expect(flow.notes.find((entry) => entry.key === 'op.note.exportOffice.hiddenText')?.params).toEqual({
      count: 'SmuggledSecret'.length,
    });
  });

  it('drops hidden text on a page that has visible text and a picture, over paper, as the exact layout does', async () => {
    const bytes = await pictured(
      200,
      'BT /F1 14 Tf 0 Tr 60 400 Td (Stamped) Tj ET\nBT /F1 14 Tf 3 Tr 60 300 Td (SECRETLAYER) Tj ET\n',
    );
    const flow = await documentXml(bytes, 'flow');
    expect(flow.text).toContain('Stamped');
    expect(flow.text).not.toContain('SECRETLAYER');
  });
});
