/**
 * Forms against real bytes, read back through MuPDF's own widget API (an independent
 * reader) and through the rendered page. The wrong answers that matter: a Turkish value
 * written but drawn with a face that cannot show it, a radio group whose on-states do not
 * follow the value, a created field a reader does not list, a flattened field that
 * disappears instead of becoming page content, and a calculation over the wrong fields.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCalculations,
  createFormFields,
  exportFormData,
  fillFormFields,
  flattenForm,
  importFormData,
  readFormFields,
  setFieldFlags,
} from './forms';

const run = { signal: new AbortController().signal };

function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

/**
 * One page with: a text field `ad` (max 40, required), a checkbox `onay`, a radio group
 * `secim` with options A and B, a dropdown `il` and two number fields `a`, `b` plus a
 * `toplam` text field. The appearances are the minimal ones a producer might write.
 */
async function formFixture(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, 600], 0, {}, ''));
  const page = doc.findPage(0);
  const helv = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const da = doc.newString('/Helv 12 Tf 0 g');
  const box = ([x0 = 0, y0 = 0, x1 = 0, y1 = 0]: number[]) =>
    doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, x1 - x0, y1 - y0] });
  const widget = (extra: Record<string, unknown>, rect: number[]) =>
    doc.addObject({ Type: 'Annot', Subtype: 'Widget', Rect: rect, P: page, F: 4, ...extra });

  const text = (name: string, rect: number[], more: Record<string, unknown> = {}) =>
    widget({ FT: 'Tx', T: doc.newString(name), DA: da, AP: { N: box(rect) }, ...more }, rect);
  const ad = text('ad', [20, 540, 380, 570], { MaxLen: 40, Ff: 2 });
  const onay = widget(
    {
      FT: 'Btn',
      T: doc.newString('onay'),
      V: 'Off',
      AS: 'Off',
      AP: { N: { Yes: box([0, 0, 20, 20]), Off: box([0, 0, 20, 20]) } },
    },
    [20, 500, 40, 520],
  );
  const secim = doc.addObject({ FT: 'Btn', Ff: 49152, T: doc.newString('secim'), V: 'Off', Kids: [] });
  for (const [index, state] of ['A', 'B'].entries()) {
    const rect = [20 + index * 40, 460, 40 + index * 40, 480];
    const kid = widget({ Parent: secim, AS: 'Off', AP: { N: { [state]: box(rect), Off: box(rect) } } }, rect);
    secim.get('Kids').push(kid);
  }
  const il = widget(
    {
      FT: 'Ch',
      Ff: 131072,
      T: doc.newString('il'),
      DA: da,
      Opt: [doc.newString('Bir'), doc.newString('İki')],
      AP: { N: box([20, 420, 200, 440]) },
    },
    [20, 420, 200, 440],
  );
  const a = text('a', [20, 380, 100, 400], { V: doc.newString('2,5') });
  const b = text('b', [120, 380, 200, 400], { V: doc.newString('4') });
  const toplam = text('toplam', [220, 380, 300, 400]);
  const kids = secim.get('Kids');
  page.put('Annots', [ad, onay, kids.get(0), kids.get(1), il, a, b, toplam]);
  doc
    .getTrailer()
    .get('Root')
    .put('AcroForm', { Fields: [ad, onay, secim, il, a, b, toplam], DR: { Font: { Helv: helv } }, DA: da });
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Name → value as MuPDF's widget API reads them, plus the page's extracted text. */
async function widgets(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const page = doc.loadPage(0) as import('mupdf').PDFPage;
    const values: Record<string, string> = {};
    for (const widget of page.getWidgets()) {
      const name = widget.getName();
      const value = widget.getValue();
      if (values[name] === undefined || value !== 'Off') values[name] = value;
    }
    // The display list with annotations: `toStructuredText` on the page skips widgets.
    const pixmapText = page.toDisplayList(true).toStructuredText('preserve-whitespace').asText();
    return { values, text: pixmapText, annots: page.getAnnotations().length + page.getWidgets().length };
  } finally {
    doc.destroy();
  }
}

describe('forms', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists every field with its kind, value, flags, options and page', async () => {
    const fields = await readFormFields(await formFixture());
    const byName = Object.fromEntries(fields.map((field) => [field.name, field]));
    expect(Object.keys(byName)).toEqual(['ad', 'onay', 'secim', 'il', 'a', 'b', 'toplam']);
    expect(byName.ad).toMatchObject({
      kind: 'text',
      value: null,
      required: true,
      readOnly: false,
      maxLength: 40,
      pageIndex: 0,
    });
    expect(byName.onay).toMatchObject({ kind: 'checkbox', value: false });
    expect(byName.secim).toMatchObject({ kind: 'radio', options: ['A', 'B'], pageIndex: 0 });
    expect(byName.il).toMatchObject({ kind: 'dropdown', options: ['Bir', 'İki'] });
    expect(byName.a?.value).toBe('2,5');
  });

  it('fills text, checkbox, radio and dropdown values and draws Turkish text', async () => {
    const out = await fillFormFields(
      await formFixture(),
      [
        { name: 'ad', value: 'Şişli İğdır' },
        { name: 'onay', value: true },
        { name: 'secim', value: 'B' },
        { name: 'il', value: 'İki' },
        { name: 'yok', value: 'x' },
      ],
      run,
    );
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).toContain('form.note.missing');
    expect(keys).toContain('form.note.appearanceNoto');
    const result = await widgets(out.bytes);
    expect(result.values).toMatchObject({ ad: 'Şişli İğdır', onay: 'Yes', secim: 'B', il: 'İki' });
    expect(result.text).toContain('Şişli İğdır');
    const fields = await readFormFields(out.bytes);
    expect(fields.find((field) => field.name === 'onay')?.value).toBe(true);
    expect(fields.find((field) => field.name === 'secim')?.value).toBe('B');
  });

  it('shows exactly the chosen radio option and turns a checkbox back off', async () => {
    /** The `/AS` of each widget the page lists, in page order: onay, secim A, secim B. */
    const states = async (bytes: Uint8Array): Promise<string[]> => {
      const mupdf = await import('mupdf');
      const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
      if (doc === null) throw new Error('not a PDF');
      try {
        const annots = doc.findPage(0).get('Annots').resolve();
        return [1, 2, 3].map((index) => annots.get(index).resolve().get('AS').asName());
      } finally {
        doc.destroy();
      }
    };

    const chosen = await fillFormFields(
      await formFixture(),
      [
        { name: 'onay', value: true },
        { name: 'secim', value: 'B' },
      ],
      run,
    );
    expect(await states(chosen.bytes)).toEqual(['Yes', 'Off', 'B']);

    const switched = await fillFormFields(
      chosen.bytes,
      [
        { name: 'onay', value: false },
        { name: 'secim', value: 'A' },
      ],
      run,
    );
    expect(await states(switched.bytes)).toEqual(['Off', 'A', 'Off']);
    const fields = await readFormFields(switched.bytes);
    expect(fields.find((field) => field.name === 'onay')?.value).toBe(false);
    expect(fields.find((field) => field.name === 'secim')?.value).toBe('A');
  });

  it('creates fields a reader lists, with a legible Turkish default', async () => {
    const out = await createFormFields(
      await formFixture(),
      [
        {
          kind: 'text',
          name: 'yeni',
          pageIndex: 0,
          rect: [20, 300, 200, 24],
          defaultValue: 'Çağrı',
          required: true,
        },
        { kind: 'checkbox', name: 'kutu', pageIndex: 0, rect: [220, 300, 18, 18], defaultValue: 'true' },
        {
          kind: 'radio',
          name: 'grup',
          pageIndex: 0,
          rect: [20, 200, 100, 60],
          options: ['x', 'y'],
          defaultValue: 'y',
        },
        {
          kind: 'dropdown',
          name: 'liste',
          pageIndex: 0,
          rect: [220, 250, 150, 24],
          options: ['Ö', 'Ü'],
          defaultValue: 'Ü',
        },
      ],
      run,
    );
    const fields = await readFormFields(out.bytes);
    const byName = Object.fromEntries(fields.map((field) => [field.name, field]));
    expect(byName.yeni).toMatchObject({ kind: 'text', value: 'Çağrı', required: true, pageIndex: 0 });
    expect(byName.kutu).toMatchObject({ kind: 'checkbox', value: true });
    expect(byName.grup).toMatchObject({ kind: 'radio', value: 'y', options: ['x', 'y'] });
    expect(byName.liste).toMatchObject({ kind: 'dropdown', value: ['Ü'], options: ['Ö', 'Ü'] });
    expect((await widgets(out.bytes)).text).toContain('Çağrı');
    await expect(
      createFormFields(
        await formFixture(),
        [{ kind: 'text', name: 'z', pageIndex: 3, rect: [0, 0, 10, 10] }],
        run,
      ),
    ).rejects.toMatchObject({ code: 'range-invalid' });
  });

  it('writes the creation options a detected form uses: plain, comb, multiline, rects, rotation, signature', async () => {
    const out = await createFormFields(
      await formFixture(),
      [
        { kind: 'text', name: 'cerceveli', pageIndex: 0, rect: [20, 300, 100, 20] },
        { kind: 'text', name: 'sade', pageIndex: 0, rect: [20, 270, 100, 20], plain: true },
        { kind: 'text', name: 'tarama', pageIndex: 0, rect: [20, 240, 100, 20], plain: true, rotation: 90 },
        { kind: 'text', name: 'donuk', pageIndex: 0, rect: [20, 210, 100, 20], rotation: 270 },
        { kind: 'text', name: 'tc', pageIndex: 0, rect: [20, 180, 110, 14], plain: true, comb: 11 },
        { kind: 'text', name: 'not', pageIndex: 0, rect: [20, 120, 100, 50], plain: true, multiline: true },
        {
          kind: 'radio',
          name: 'secenek',
          pageIndex: 0,
          rect: [200, 300, 60, 12],
          options: ['a', 'b'],
          plain: true,
          optionRects: [
            [200, 300, 10, 10],
            [260, 302, 10, 10],
          ],
        },
        { kind: 'signature', name: 'imza', pageIndex: 0, rect: [200, 200, 120, 30], plain: true },
      ],
      run,
    );
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      // Every widget dictionary by field name (a radio group's kids by their parent's).
      const dicts = new Map<string, import('mupdf').PDFObject[]>();
      const annots = doc.findPage(0).get('Annots').resolve();
      for (let at = 0; at < annots.length; at += 1) {
        const dict = annots.get(at).resolve();
        const owner = dict.get('Parent').isNull() ? dict : dict.get('Parent').resolve();
        const name = owner.get('T').asString();
        dicts.set(name, [...(dicts.get(name) ?? []), dict]);
      }
      const only = (name: string) => dicts.get(name)?.[0] as import('mupdf').PDFObject;

      // A framed field carries its border and background; a plain one carries none.
      expect(only('cerceveli').get('MK').get('BC').length).toBe(3);
      expect(only('cerceveli').get('BS').get('W').asNumber()).toBe(1);
      expect(only('sade').get('MK').isNull()).toBe(true);
      expect(only('sade').get('BS').isNull()).toBe(true);
      // Rotation is `/MK /R` on a plain field and joins the frame on a framed one.
      expect(only('tarama').get('MK').get('R').asNumber()).toBe(90);
      expect(only('tarama').get('MK').get('BC').isNull()).toBe(true);
      expect(only('donuk').get('MK').get('R').asNumber()).toBe(270);
      expect(only('donuk').get('MK').get('BC').length).toBe(3);
      // Comb: the comb flag (bit 25) and the cell count as /MaxLen; multiline is bit 13.
      expect(only('tc').get('MaxLen').asNumber()).toBe(11);
      expect(only('tc').get('Ff').asNumber() & (1 << 24)).not.toBe(0);
      expect(only('not').get('Ff').asNumber() & (1 << 12)).not.toBe(0);
      expect(only('not').get('Ff').asNumber() & (1 << 24)).toBe(0);
      expect(only('sade').get('Ff').asNumber() & ((1 << 12) | (1 << 24))).toBe(0);
      // Option rectangles are used as given (x, y, x + w, y + h), one widget per option.
      expect(dicts.get('secenek')?.map((dict) => dict.get('Rect').asJS())).toEqual([
        [200, 300, 210, 310],
        [260, 302, 270, 312],
      ]);
      expect(only('imza').get('FT').asName()).toBe('Sig');
    } finally {
      doc.destroy();
    }
    const fields = await readFormFields(out.bytes);
    expect(fields.find((field) => field.name === 'imza')?.kind).toBe('signature');
    expect(fields.find((field) => field.name === 'tc')).toMatchObject({ kind: 'text', maxLength: 11 });
  });

  it('locks a field and flattens fields into page content', async () => {
    const locked = await setFieldFlags(await formFixture(), ['ad'], { readOnly: true, required: false }, run);
    expect((await readFormFields(locked.bytes)).find((field) => field.name === 'ad')).toMatchObject({
      readOnly: true,
      required: false,
    });

    const filled = await fillFormFields(await formFixture(), [{ name: 'ad', value: 'Düzlem' }], run);
    const flat = await flattenForm(filled.bytes, ['ad'], run);
    const names = (await readFormFields(flat.bytes)).map((field) => field.name);
    expect(names).not.toContain('ad');
    expect(names).toContain('onay');
    expect((await widgets(flat.bytes)).text).toContain('Düzlem');

    // The text is now page content *where the field was* (x 20..380, y 540..570 from the bottom
    // = 30..60 from the top), and no widget of that name is left on the page to draw it twice.
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(flat.bytes.slice(), 'application/pdf');
    try {
      const page = doc.loadPage(0) as import('mupdf').PDFPage;
      expect(page.getWidgets().map((widget) => widget.getName())).not.toContain('ad');
      const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, false);
      const pixels = pixmap.getPixels();
      let count = 0;
      let [x0, y0, x1, y1] = [Infinity, Infinity, -1, -1];
      for (let y = 0; y < pixmap.getHeight(); y += 1) {
        for (let x = 0; x < pixmap.getWidth(); x += 1) {
          const at = (y * pixmap.getWidth() + x) * pixmap.getNumberOfComponents();
          if ((pixels[at] ?? 255) > 200 && (pixels[at + 1] ?? 255) > 200 && (pixels[at + 2] ?? 255) > 200)
            continue;
          count += 1;
          [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
        }
      }
      expect(count).toBeGreaterThan(30);
      expect([x0 >= 20, y0 >= 30, x1 <= 380, y1 <= 60]).toEqual([true, true, true, true]);
    } finally {
      doc.destroy();
    }
  });

  it('calculates from the form’s own values and round-trips its data', async () => {
    const calculated = await applyCalculations(
      await formFixture(),
      [{ target: 'toplam', expression: 'a + b * 2' }],
      run,
    );
    expect(calculated.results).toEqual({ toplam: '10.5' });
    expect((await widgets(calculated.bytes)).values.toplam).toBe('10.5');

    const filled = await fillFormFields(await formFixture(), [{ name: 'ad', value: 'Işık' }], run);
    const exported = await exportFormData(filled.bytes, 'json');
    const imported = await importFormData(await formFixture(), exported.bytes, 'json', run);
    expect(imported.missing).toEqual([]);
    expect((await widgets(imported.bytes)).values.ad).toBe('Işık');
  });
});
