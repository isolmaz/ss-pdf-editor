/**
 * Flattening, the calculator's number reading and `/MaxLen`, against real bytes read back
 * through MuPDF (an independent reader): a form another tool filled in is drawn from its values
 * and not from the stale picture it left, a hidden widget is not drawn, a parent whose last child
 * was flattened leaves the form, `1.234,56` is a number, and a limit of three counts three emoji
 * the same way whichever path checks it. The document wrapper below only counts `findPage` calls,
 * so "the pages are walked once per operation" is measured; everything else is real.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument, type PDFPage } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as MupdfEngine from '../engines/mupdf';
import {
  applyCalculations,
  createFormFields,
  fillFormFields,
  flattenForm,
  parseFormNumber,
  readFormFields,
  type SeparatorStyle,
  validateField,
} from './forms';
import { blankForm, formPdf, widgetBody } from './forms.fixtures';

const counts = vi.hoisted(() => ({ findPage: 0 }));

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof MupdfEngine>();
  return {
    ...actual,
    loadMupdf: async () => {
      // `loadMupdf` is the seam every document is opened through (see forms.faults.test.ts); it
      // hands back the whole module, so the module is loaded here as the engine loads it.
      const real = await import('mupdf');
      const wrapDocument = (document: PDFDocument): PDFDocument => {
        const proxy: PDFDocument = new Proxy(document, {
          get(target, property) {
            if (property === 'asPDF') return () => proxy;
            if (property === 'findPage') {
              return (index: number) => {
                counts.findPage += 1;
                return target.findPage(index);
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return proxy;
      };
      const documents = new Proxy(real.PDFDocument, {
        get(target, property) {
          if (property === 'openDocument') {
            return (...args: Parameters<typeof real.PDFDocument.openDocument>) =>
              wrapDocument(real.PDFDocument.openDocument(...args) as PDFDocument);
          }
          return Reflect.get(target, property, target);
        },
      });
      return new Proxy(real, {
        get(target, property) {
          return property === 'PDFDocument' ? documents : Reflect.get(target, property, target);
        },
      });
    },
  };
});

const run = { signal: new AbortController().signal };

function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

beforeEach(() => {
  const font = notoRegular();
  vi.stubGlobal('fetch', async () => new Response(font));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const rect = (y: number) => `10 ${y} 110 ${y + 20}`;

/** A 100 x 20 form XObject drawing `value` in Helvetica: the picture a producer leaves in `/AP`. */
function drawing(value: string, operator = 'Tj'): string {
  const content = `BT /F1 12 Tf 2 5 Td (${value}) ${operator} ET`;
  return `<</Type/XObject/Subtype/Form/BBox[0 0 100 20]/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>/Length ${content.length}>>\nstream\n${content}\nendstream`;
}

/** The text a reader draws on page 1, widgets included. */
async function pageTextOf(bytes: Uint8Array): Promise<string> {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const page = doc.loadPage(0) as PDFPage;
    return page.toDisplayList(true).toStructuredText('preserve-whitespace').asText();
  } finally {
    doc.destroy();
  }
}

/** Open `bytes` and hand the document to `read`. */
function inspect<T>(bytes: Uint8Array, read: (doc: PDFDocument) => T): T {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return read(doc);
  } finally {
    doc.destroy();
  }
}

/** The object number of each entry of `/AcroForm /Fields`. */
const fieldEntries = (bytes: Uint8Array): number[] =>
  inspect(bytes, (doc) => {
    const fields = doc.getTrailer().get('Root').get('AcroForm').get('Fields').resolve();
    return Array.from({ length: fields.length }, (_, index) => fields.get(index).asIndirect());
  });

const fieldNames = async (bytes: Uint8Array): Promise<string[]> =>
  (await readFormFields(bytes)).map((field) => field.name);

describe('flattenForm draws the value a field holds', () => {
  const textField = (name: string, y: number, more: string, flags = 4) =>
    `<</Type/Annot/Subtype/Widget/Rect[${rect(y)}]/P 3 0 R/F ${flags}/FT/Tx/T(${name})/DA(/Helv 12 Tf 0 g)${more}>>`;

  it('draws the value, not the old picture, when the form says /NeedAppearances true', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      acroForm: '/NeedAppearances true',
      extra: { 10: textField('ad', 500, '/V(Merhaba)/AP<</N 61 0 R>>'), 61: drawing('Eski') },
    });
    const out = await flattenForm(bytes, null, run);
    const text = await pageTextOf(out.bytes);
    expect(text).toContain('Merhaba');
    expect(text).not.toContain('Eski');
    expect(out.report.notes).toContainEqual({ kind: 'preserved', key: 'form.note.appearanceNoto' });
  });

  it('draws the value of a field whose /AP is empty, with the flag on', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      acroForm: '/NeedAppearances true',
      extra: { 10: textField('ad', 500, '/V(Merhaba)/AP<</N 60 0 R>>'), 60: blankForm(100, 20) },
    });
    expect(await pageTextOf((await flattenForm(bytes, null, run)).bytes)).toContain('Merhaba');
  });

  it('draws the value of a field with no /AP at all', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      acroForm: '/NeedAppearances true',
      extra: { 10: textField('ad', 500, '/V(Merhaba)') },
    });
    expect(await pageTextOf((await flattenForm(bytes, null, run)).bytes)).toContain('Merhaba');
  });

  it('draws a value that sits under an empty appearance even without the flag', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      extra: { 10: textField('ad', 500, '/V(Merhaba)/AP<</N 60 0 R>>'), 60: blankForm(100, 20) },
    });
    expect(await pageTextOf((await flattenForm(bytes, null, run)).bytes)).toContain('Merhaba');
  });

  it('draws a choice field from its value under /NeedAppearances', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      acroForm: '/NeedAppearances true',
      extra: {
        10: `<</Type/Annot/Subtype/Widget/Rect[${rect(500)}]/P 3 0 R/F 4/FT/Ch/Ff 131072/T(il)/Opt[(Bir)(Iki)]/V(Iki)/AP<</N 60 0 R>>>>`,
        60: blankForm(100, 20),
      },
    });
    expect(await pageTextOf((await flattenForm(bytes, null, run)).bytes)).toContain('Iki');
  });

  it('draws a choice field whose value sits under an empty appearance even without the flag', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      extra: {
        10: `<</Type/Annot/Subtype/Widget/Rect[${rect(500)}]/P 3 0 R/F 4/FT/Ch/Ff 131072/T(il)/Opt[(Bir)(Iki)]/V(Iki)/AP<</N 60 0 R>>>>`,
        60: blankForm(100, 20),
      },
    });
    expect(await pageTextOf((await flattenForm(bytes, null, run)).bytes)).toContain('Iki');
  });

  it('keeps an appearance that shows its text with the quote operator', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      extra: { 10: textField('ad', 500, '/V(Yeni)/AP<</N 61 0 R>>'), 61: drawing('Eski', "'") },
    });
    const out = await flattenForm(bytes, null, run);
    const text = await pageTextOf(out.bytes);
    expect(text).toContain('Eski');
    expect(text).not.toContain('Yeni');
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('form.note.appearanceNoto');
  });

  it('keeps an appearance that already draws the value, and does not touch it', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      extra: { 10: textField('ad', 500, '/V(Merhaba)/AP<</N 61 0 R>>'), 61: drawing('Merhaba') },
    });
    const out = await flattenForm(bytes, null, run);
    expect(await pageTextOf(out.bytes)).toContain('Merhaba');
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('form.note.appearanceNoto');
  });
});

describe('flattenForm leaves hidden widgets out', () => {
  const hiddenForm = () =>
    formPdf({
      fields: '[10 0 R 11 0 R 12 0 R]',
      annots: '[10 0 R 11 0 R 12 0 R]',
      extra: {
        // Hidden (and printable), NoView, and a plain visible one.
        10: `<</Type/Annot/Subtype/Widget/Rect[${rect(500)}]/P 3 0 R/F 6/FT/Tx/T(ad)/V(Gizli)/AP<</N 61 0 R>>>>`,
        11: `<</Type/Annot/Subtype/Widget/Rect[${rect(470)}]/P 3 0 R/F 32/FT/Tx/T(nv)/V(Yok)/AP<</N 62 0 R>>>>`,
        12: `<</Type/Annot/Subtype/Widget/Rect[${rect(440)}]/P 3 0 R/F 4/FT/Tx/T(vis)/V(Gorunur)/AP<</N 63 0 R>>>>`,
        61: drawing('Gizli'),
        62: drawing('Yok'),
        63: drawing('Gorunur'),
      },
    });

  it('paints the visible widget only and removes all three from the page and the form', async () => {
    const out = await flattenForm(hiddenForm(), null, run);
    const text = await pageTextOf(out.bytes);
    expect(text).toContain('Gorunur');
    expect(text).not.toContain('Gizli');
    expect(text).not.toContain('Yok');
    expect(out.report.notes).toContainEqual({
      kind: 'changed',
      key: 'form.note.flattenHidden',
      params: { count: 2 },
    });
    expect(inspect(out.bytes, (doc) => doc.findPage(0).get('Annots').resolve().length)).toBe(0);
    expect(await readFormFields(out.bytes)).toEqual([]);
  });

  it('flattens a field whose every widget is hidden without painting anything', async () => {
    const out = await flattenForm(hiddenForm(), ['ad'], run);
    const text = await pageTextOf(out.bytes);
    expect(text).not.toContain('Gizli');
    expect(await fieldNames(out.bytes)).toEqual(['nv', 'vis']);
  });

  it('draws nothing again for a hidden field when the form says /NeedAppearances true', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      acroForm: '/NeedAppearances true',
      extra: {
        10: `<</Type/Annot/Subtype/Widget/Rect[${rect(500)}]/P 3 0 R/F 2/FT/Tx/T(ad)/V(Gizli)/DA(/Helv 12 Tf 0 g)>>`,
      },
    });
    const out = await flattenForm(bytes, null, run);
    expect(await pageTextOf(out.bytes)).not.toContain('Gizli');
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('form.note.appearanceNoto');
    expect(await readFormFields(out.bytes)).toEqual([]);
  });

  it('flattens a hidden widget that no page holds, which has nothing to come off', async () => {
    const bytes = formPdf({
      fields: '[10 0 R]',
      annots: '[]',
      extra: { 10: `<</Type/Annot/Subtype/Widget/Rect[${rect(500)}]/F 2/FT/Tx/T(ad)/V(Gizli)>>` },
    });
    const out = await flattenForm(bytes, null, run);
    expect(out.report.notes).toContainEqual({
      kind: 'changed',
      key: 'form.note.flattenHidden',
      params: { count: 1 },
    });
    expect(await readFormFields(out.bytes)).toEqual([]);
  });
});

describe('flattenForm selects a field by its name', () => {
  it('flattens the first of two fields that share a name, and leaves the second', async () => {
    const bytes = formPdf({
      fields: '[10 0 R 11 0 R]',
      annots: '[10 0 R 11 0 R]',
      extra: {
        10: widgetBody(rect(500), '/FT/Tx/T(dup)/V(first)/AP<</N 61 0 R>>'),
        11: widgetBody(rect(470), '/FT/Tx/T(dup)/V(second)/AP<</N 62 0 R>>'),
        61: drawing('first'),
        62: drawing('second'),
      },
    });
    const out = await flattenForm(bytes, ['dup'], run);
    expect(fieldEntries(out.bytes)).toEqual([11]);
    expect(await pageTextOf(out.bytes)).toContain('first');
  });
});

describe('flattenForm takes a parent out once its last child is flattened', () => {
  const group = (): Uint8Array =>
    formPdf({
      fields: '[10 0 R 13 0 R]',
      annots: '[11 0 R 12 0 R 13 0 R]',
      extra: {
        10: '<</T(grp)/FT/Tx/Kids[11 0 R 12 0 R]>>',
        11: widgetBody(rect(500), '/T(a)/Parent 10 0 R/V(x)/AP<</N 60 0 R>>'),
        12: widgetBody(rect(470), '/T(b)/Parent 10 0 R/V(y)/AP<</N 60 0 R>>'),
        13: widgetBody(rect(440), '/FT/Tx/T(c)/V(z)/AP<</N 60 0 R>>'),
        60: blankForm(100, 20),
      },
    });

  it('removes the emptied parent from /Fields, so a second flatten-all succeeds', async () => {
    const first = await flattenForm(group(), ['grp.a', 'grp.b'], run);
    expect(fieldEntries(first.bytes)).toEqual([13]);
    expect(await fieldNames(first.bytes)).toEqual(['c']);

    const second = await flattenForm(first.bytes, null, run);
    expect(second.report.notes).toContainEqual({
      kind: 'changed',
      key: 'form.note.flattened',
      params: { count: 1 },
    });
    expect(await readFormFields(second.bytes)).toEqual([]);
  });

  it('keeps a parent that still has a child field', async () => {
    const out = await flattenForm(group(), ['grp.a'], run);
    expect(fieldEntries(out.bytes)).toEqual([10, 13]);
    expect(await fieldNames(out.bytes)).toEqual(['grp.b', 'c']);
  });

  it('removes a parent whose remaining kids are not dictionaries', async () => {
    const bytes = formPdf({
      fields: '[10 0 R 13 0 R]',
      annots: '[11 0 R 13 0 R]',
      extra: {
        // A number in `/Kids` is junk, not a field: only the child is a field of this parent.
        10: '<</T(grp)/FT/Tx/Kids[11 0 R 42]>>',
        11: widgetBody(rect(500), '/T(a)/Parent 10 0 R/V(x)/AP<</N 60 0 R>>'),
        13: widgetBody(rect(470), '/FT/Tx/T(c)/V(z)/AP<</N 60 0 R>>'),
        60: blankForm(100, 20),
      },
    });
    const out = await flattenForm(bytes, ['grp.a'], run);
    expect(fieldEntries(out.bytes)).toEqual([13]);
    expect(await fieldNames(out.bytes)).toEqual(['c']);
  });

  it('removes every emptied ancestor, however deep, and keeps the unrelated field', async () => {
    const bytes = formPdf({
      fields: '[10 0 R 13 0 R]',
      annots: '[12 0 R 13 0 R]',
      extra: {
        10: '<</T(top)/Kids[11 0 R]>>',
        11: '<</T(mid)/Parent 10 0 R/FT/Tx/Kids[12 0 R]>>',
        12: widgetBody(rect(500), '/T(leaf)/Parent 11 0 R/V(x)/AP<</N 60 0 R>>'),
        13: widgetBody(rect(470), '/FT/Tx/T(c)/V(z)/AP<</N 60 0 R>>'),
        60: blankForm(100, 20),
      },
    });
    const out = await flattenForm(bytes, ['top.mid.leaf'], run);
    expect(fieldEntries(out.bytes)).toEqual([13]);
    expect(await fieldNames(out.bytes)).toEqual(['c']);
  });
});

describe('flattenForm writes each page once', () => {
  it('appends one content stream per page however many widgets it flattens', async () => {
    const bytes = formPdf({
      fields: '[10 0 R 11 0 R 12 0 R]',
      annots: '[10 0 R 11 0 R 12 0 R]',
      pageExtra: '/Contents 70 0 R',
      extra: {
        10: widgetBody(rect(500), '/FT/Tx/T(a)/V(x)/AP<</N 61 0 R>>'),
        11: widgetBody(rect(470), '/FT/Tx/T(b)/V(y)/AP<</N 61 0 R>>'),
        12: widgetBody(rect(440), '/FT/Tx/T(c)/V(z)/AP<</N 61 0 R>>'),
        61: drawing('x'),
        70: '<</Length 0>>\nstream\n\nendstream',
      },
    });
    const out = await flattenForm(bytes, null, run);
    // The page's own stream, the `q` before it and one stream of all three widgets after it.
    expect(inspect(out.bytes, (doc) => doc.findPage(0).get('Contents').resolve().length)).toBe(3);
    const painted = inspect(out.bytes, (doc) => {
      const keys: string[] = [];
      doc
        .findPage(0)
        .get('Resources')
        .get('XObject')
        .forEach((_value, key) => {
          keys.push(String(key));
        });
      return keys.filter((key) => key.startsWith('FlatWidget'));
    });
    expect(painted).toHaveLength(3);
  });
});

describe('the pages are walked once per operation', () => {
  /** `count` widgets that carry no `/P` and are listed only by the second page. */
  const unplaced = (count: number): Uint8Array => {
    const numbers = Array.from({ length: count }, (_, index) => 100 + index);
    const refs = `[${numbers.map((number) => `${number} 0 R`).join(' ')}]`;
    const extra: Record<number, string> = { 60: blankForm(100, 20) };
    for (const number of numbers) {
      extra[number] =
        `<</Type/Annot/Subtype/Widget/Rect[10 10 110 30]/F 4/FT/Tx/T(w${number})/V(x)/AP<</N 60 0 R>>>>`;
    }
    return formPdf({ fields: refs, annots: '[]', secondAnnots: refs, extra });
  };

  const findPageCalls = async (body: () => Promise<unknown>): Promise<number> => {
    counts.findPage = 0;
    await body();
    return counts.findPage;
  };

  it('reads a widget page without walking every page for each widget', async () => {
    const few = await findPageCalls(() => readFormFields(unplaced(4)));
    const many = await findPageCalls(() => readFormFields(unplaced(40)));
    expect(few).toBeGreaterThan(0);
    expect(many).toBe(few);
    expect((await readFormFields(unplaced(40))).every((field) => field.pageIndex === 1)).toBe(true);
  });

  it('flattens without walking every page for each widget', async () => {
    const few = await findPageCalls(() => flattenForm(unplaced(4), null, run));
    const many = await findPageCalls(() => flattenForm(unplaced(40), null, run));
    expect(many).toBe(few);
    const out = await flattenForm(unplaced(40), null, run);
    expect(out.report.notes).toContainEqual({
      kind: 'changed',
      key: 'form.note.flattened',
      params: { count: 40 },
    });
    expect(await readFormFields(out.bytes)).toEqual([]);
  });

  it('puts a widget the first page lists on the first page', async () => {
    const bytes = formPdf({
      fields: '[100 0 R]',
      annots: '[100 0 R]',
      secondAnnots: '[100 0 R]',
      extra: { 100: '<</Type/Annot/Subtype/Widget/Rect[10 10 110 30]/F 4/FT/Tx/T(both)>>' },
    });
    expect((await readFormFields(bytes))[0]?.pageIndex).toBe(0);
  });

  it('refuses a duplicate name inside one creation call and lists every created field', async () => {
    const base = formPdf({ fields: '[]', annots: '[]', extra: {} });
    const spec = (name: string, index: number) => ({
      kind: 'text' as const,
      name,
      pageIndex: 0,
      rect: [10, 10 + index * 12, 100, 10] as const,
    });
    await expect(createFormFields(base, [spec('dup', 0), spec('dup', 1)], run)).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { engine: 'mupdf', engineMessage: 'a field named dup already exists' },
    });
    const names = Array.from({ length: 30 }, (_, index) => `f${index}`);
    const out = await createFormFields(
      base,
      names.map((name, index) => spec(name, index)),
      run,
    );
    expect(await fieldNames(out.bytes)).toEqual(names);
  });
});

describe('reading a number out of a field', () => {
  const sheet = (value: string, extra = '', objects: Readonly<Record<number, string>> = {}): Uint8Array =>
    formPdf({
      fields: '[10 0 R 11 0 R]',
      annots: '[10 0 R 11 0 R]',
      extra: {
        10: widgetBody(rect(500), `/FT/Tx/T(a)/V(${value})${extra}`),
        11: widgetBody(rect(470), '/FT/Tx/T(total)'),
        ...objects,
      },
    });
  const script = (body: string, dict = '') => `<</Length ${body.length}${dict}>>\nstream\n${body}\nendstream`;
  const formatAction = '/AA<</F<</S/JavaScript/JS 70 0 R>>>>';
  const FORMAT_STYLE_2 = 'AFNumber_Format(2, 2, 0, 0, "", true);';
  const total = async (bytes: Uint8Array): Promise<string | undefined> =>
    (await applyCalculations(bytes, [{ target: 'total', expression: 'a + 1' }], run)).results.total;

  it.each([
    ['1.234,56', '1235.56'],
    ['1,234.56', '1235.56'],
    ['12,5', '13.5'],
    ['1.234.567,5', '1234568.5'],
    ['1,234,567', '1234568'],
    ['-1.234,5', '-1233.5'],
  ])('reads %s as a number and adds 1 to it: %s', async (value, expected) => {
    expect(await total(sheet(value))).toBe(expected);
  });

  it("reads the field's own AFNumber_Format separator style when it has one", async () => {
    const format = (style: number) =>
      `/AA<</F<</S/JavaScript/JS(AFNumber_Format(2, ${style}, 0, 0, "", true);)>>>>`;
    // `1.234` is one thousand two hundred thirty-four in style 2 and one and a bit otherwise.
    expect(await total(sheet('1.234', format(2)))).toBe('1235');
    expect(await total(sheet('1.234'))).toBe('2.23');
    expect(await total(sheet('1,234', format(0)))).toBe('1235');
    expect(await total(sheet('1,234'))).toBe('2.23');
  });

  it('reads the separator style out of a format script that is a stream', async () => {
    expect(await total(sheet('1.234', formatAction, { 70: script(FORMAT_STYLE_2) }))).toBe('1235');
    // A stream with no AFNumber_Format call names no style.
    expect(await total(sheet('1.234', formatAction, { 70: script('AFPercent_Format(2, 0);') }))).toBe('2.23');
  });

  it('goes by the separators the text shows when the format script cannot be read or is no script', async () => {
    // Predictor rows too wide to decode: the stream cannot be opened, so it names no style.
    const unreadable = script(
      FORMAT_STYLE_2,
      '/Filter/FlateDecode/DecodeParms<</Predictor 12/Columns 2147483647>>',
    );
    expect(await total(sheet('1.234', formatAction, { 70: unreadable }))).toBe('2.23');
    // `/JS 5` is neither a string nor a stream.
    expect(await total(sheet('1.234', '/AA<</F<</S/JavaScript/JS 5>>>>'))).toBe('2.23');
  });

  const cases: readonly [string, SeparatorStyle | null, number][] = [
    ['1.234,56', null, 1234.56],
    ['1,234.56', null, 1234.56],
    ['12,5', null, 12.5],
    ['12.5', null, 12.5],
    ['1.234.567', null, 1234567],
    ['1,234,567.89', null, 1234567.89],
    ["1'234.56", null, 1234.56],
    ['.5', null, 0.5],
    ['-3,5', null, -3.5],
    ['7 EUR', null, 7],
    ['1,234.56', 0, 1234.56],
    ['1234.56', 1, 1234.56],
    ['1.234,56', 2, 1234.56],
    ['1.234', 2, 1234],
    ['10.125', 2, 10125],
    // A grouped number never starts with a zero: this is a fraction, whatever the style says.
    ['0.125', 2, 0.125],
    ['0,125', 0, 0.125],
    ['1234,56', 3, 1234.56],
    ["1'234.56", 4, 1234.56],
    // Not written in the style: the text's own separators decide.
    ['1235.56', 2, 1235.56],
    ['1235.56', 3, 1235.56],
    ['1,5', 1, 1.5],
  ];
  it.each(cases)('parseFormNumber(%j, style %j) is %d', (text, style, expected) => {
    expect(parseFormNumber(text, style)).toBe(expected);
  });

  it('has no number in a text that does not start with one', () => {
    expect(parseFormNumber('abc')).toBeNaN();
    expect(parseFormNumber('')).toBeNaN();
    expect(parseFormNumber('$5')).toBeNaN();
  });
});

describe('/MaxLen counts characters the same way on every path', () => {
  const limited = (): Uint8Array =>
    formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      extra: { 10: widgetBody(rect(500), '/FT/Tx/T(kod)/MaxLen 3') },
    });
  const three = '😀😀😀';
  const four = '😀😀😀😀';

  it('accepts three emoji and refuses four when a value is written', async () => {
    const out = await fillFormFields(limited(), [{ name: 'kod', value: three }], run);
    expect((await readFormFields(out.bytes)).find((field) => field.name === 'kod')?.value).toBe(three);
    await expect(fillFormFields(limited(), [{ name: 'kod', value: four }], run)).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { engine: 'mupdf', engineMessage: 'form.fill(kod): 4 characters exceed /MaxLen 3' },
    });
  });

  it('accepts three emoji and refuses four when the value is validated first', async () => {
    const field = (await readFormFields(limited())).find((entry) => entry.name === 'kod');
    if (field === undefined) throw new Error('no field kod');
    expect(field.maxLength).toBe(3);
    expect(validateField(field, three)).toEqual({ ok: true });
    expect(validateField(field, four)).toEqual({ ok: false, reasonKey: 'form.reason.maxLength' });
    expect(validateField(field, 'abc')).toEqual({ ok: true });
    expect(validateField(field, 'abcd')).toEqual({ ok: false, reasonKey: 'form.reason.maxLength' });
  });
});
