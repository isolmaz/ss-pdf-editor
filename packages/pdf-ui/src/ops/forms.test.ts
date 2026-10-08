/**
 * The three form dialogs, run against real bytes and read back with MuPDF's widget API: the
 * values a fill leaves, the flag a lock sets, the field a creation adds and the data an
 * export hands over or an import applies.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readFormFields } from 'pdf-core';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpRunContext, OpRunResult } from '../dialogs/types';
import { mupdfForTests } from '../pdf-fixtures';
import { createFieldDialog, formDataDialog, formFieldsDialog } from './forms';

/** A page with the text fields `ad` (max length 5), `a`, `b` (numbers) and `toplam`, and a checkbox. */
async function formFixture(pages = 1): Promise<Uint8Array> {
  const mupdf = await mupdfForTests();
  const doc = new mupdf.PDFDocument();
  for (let index = 0; index < pages; index += 1) doc.insertPage(-1, doc.addPage([0, 0, 400, 600], 0, {}, ''));
  const page = doc.findPage(0);
  const helv = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const da = doc.newString('/Helv 12 Tf 0 g');
  const box = (width: number, height: number) =>
    doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, width, height] });
  const widget = (extra: Record<string, unknown>, rect: number[]) =>
    doc.addObject({ Type: 'Annot', Subtype: 'Widget', Rect: rect, P: page, F: 4, ...extra });
  const text = (name: string, rect: number[], more: Record<string, unknown> = {}) =>
    widget({ FT: 'Tx', T: doc.newString(name), DA: da, AP: { N: box(80, 20) }, ...more }, rect);
  const ad = text('ad', [20, 540, 100, 560], { MaxLen: 5 });
  const a = text('a', [20, 500, 100, 520], { V: doc.newString('2,5') });
  const b = text('b', [120, 500, 200, 520], { V: doc.newString('4') });
  const toplam = text('toplam', [220, 500, 300, 520]);
  const onay = widget(
    {
      FT: 'Btn',
      T: doc.newString('onay'),
      V: 'Off',
      AS: 'Off',
      AP: { N: { Yes: box(20, 20), Off: box(20, 20) } },
    },
    [20, 460, 40, 480],
  );
  const liste = widget(
    {
      FT: 'Ch',
      Ff: 2097152,
      T: doc.newString('liste'),
      DA: da,
      Opt: [doc.newString('Bir'), doc.newString('Iki'), doc.newString('Uc')],
      AP: { N: box(80, 40) },
    },
    [20, 400, 100, 440],
  );
  page.put('Annots', [ad, a, b, toplam, onay, liste]);
  doc
    .getTrailer()
    .get('Root')
    .put('AcroForm', { Fields: [ad, a, b, toplam, onay, liste], DR: { Font: { Helv: helv } }, DA: da });
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

interface WidgetState {
  readonly value: string;
  readonly readOnly: boolean;
  readonly page: number;
}

/** Every widget of the file by name, as MuPDF reads it. */
async function widgetsOf(bytes: Uint8Array): Promise<Record<string, WidgetState>> {
  const mupdf = await mupdfForTests();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const states: Record<string, WidgetState> = {};
    for (let index = 0; index < doc.countPages(); index += 1) {
      const page = doc.loadPage(index) as InstanceType<Awaited<ReturnType<typeof mupdfForTests>>['PDFPage']>;
      for (const widget of page.getWidgets()) {
        states[widget.getName()] = {
          value: widget.getValue(),
          readOnly: widget.isReadOnly(),
          page: index,
        };
      }
    }
    return states;
  } finally {
    doc.destroy();
  }
}

function contextFor(bytes: Uint8Array, overrides: Partial<OpRunContext> = {}): OpRunContext {
  return {
    signal: new AbortController().signal,
    onProgress: () => undefined,
    bytes,
    pageCount: 1,
    name: 'form.pdf',
    currentPage: 0,
    selectedPages: [],
    t: createTranslator('en'),
    ...overrides,
  };
}

async function failureOf(run: Promise<OpRunResult>): Promise<ToolError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected the run to fail');
}

const fixedFile = (name: string, bytes: Uint8Array): File => new File([new Uint8Array(bytes)], name);

function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

// The appearance font is fetched from the app's own origin; the file is the same one.
beforeEach(() => {
  const font = notoRegular();
  vi.stubGlobal('fetch', async () => new Response(font));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('formFieldsDialog', () => {
  it('with nothing to fill, reports the inventory and changes nothing', async () => {
    const bytes = await formFixture();
    const result = await formFieldsDialog.run(
      { fills: '', calculations: '', lock: false, validateOnly: true },
      contextFor(bytes),
    );
    expect(result.files).toEqual([]);
    expect(result.noticeKey).toBe('form.note.inventory');
    expect(result.noticeParams).toEqual({ count: 6 });
    expect(result.report.notes.map((entry) => entry.key)).toEqual(['form.note.inventory', 'form.note.valid']);
    expect(result.report.incremental).toBe(true);
    expect(result.report.outputBytes).toBe(bytes.length);
  });

  it('treats missing fill and calculation texts as empty', async () => {
    const result = await formFieldsDialog.run({ validateOnly: true }, contextFor(await formFixture()));
    expect(result.files).toEqual([]);
    expect(result.noticeParams).toEqual({ count: 6 });
  });

  it('refuses a fill line that has no assignment, naming the line', async () => {
    const error = await failureOf(
      formFieldsDialog.run(
        { fills: 'ad=Ada\nno assignment here', calculations: '', lock: false, validateOnly: false },
        contextFor(await formFixture()),
      ),
    );
    expect(error.code).toBe('range-invalid');
    expect(error.details.engineMessage).toBe('form fill line 2 has no "name=value" assignment');
  });

  it('refuses a fill line that starts with the equals sign', async () => {
    const error = await failureOf(
      formFieldsDialog.run(
        { fills: '=value', calculations: '', lock: false, validateOnly: false },
        contextFor(await formFixture()),
      ),
    );
    expect(error.details.engineMessage).toBe('form fill line 1 has no "name=value" assignment');
  });

  it('refuses a calculation line without a target', async () => {
    const error = await failureOf(
      formFieldsDialog.run(
        { fills: '', calculations: 'toplam = a + b\njust text', lock: false, validateOnly: false },
        contextFor(await formFixture()),
      ),
    );
    expect(error.code).toBe('range-invalid');
    expect(error.details.engineMessage).toBe('calculation line 2 has no "target = expression" form');
  });

  it('refuses unknown fields and values the field cannot take before touching the document', async () => {
    const error = await failureOf(
      formFieldsDialog.run(
        { fills: 'ad=far too long\nmissing=1\na=3', calculations: '', lock: false, validateOnly: true },
        contextFor(await formFixture()),
      ),
    );
    expect(error.code).toBe('range-invalid');
    expect(error.details.engineMessage).toBe(
      'form validation refused: ad, missing (inventory: ad [text], a [text], b [text], toplam [text], onay [checkbox], liste [optionlist])',
    );
  });

  it('writes fills (text, checkbox), then calculations over them, then locks the filled fields', async () => {
    const bytes = await formFixture();
    const result = await formFieldsDialog.run(
      {
        fills: 'ad=Ada\nonay=true\na=10,5\nb=4',
        calculations: 'toplam = a * b',
        lock: true,
        validateOnly: true,
      },
      contextFor(bytes),
    );
    expect(result.noticeKey).toBe('form.note.filled');
    expect(result.noticeParams).toEqual({ count: 4 });
    expect(result.report.incremental).toBe(false);
    const file = result.files[0];
    expect(file?.name).toBe('form.pdf');
    expect(file?.mime).toBe('application/pdf');
    const states = await widgetsOf(file?.bytes ?? new Uint8Array());
    expect(states.ad).toMatchObject({ value: 'Ada', readOnly: true });
    expect(states.onay).toMatchObject({ value: 'Yes', readOnly: true });
    expect(states.a).toMatchObject({ value: '10,5', readOnly: true });
    expect(states.b).toMatchObject({ value: '4', readOnly: true });
    // 10.5 × 4: the calculation read the values the same run had just written.
    expect(states.toplam).toMatchObject({ value: '42', readOnly: false });
  });

  it('runs a calculation alone and leaves the fields unlocked', async () => {
    const result = await formFieldsDialog.run(
      { fills: '', calculations: 'toplam = a + b', lock: true, validateOnly: false },
      contextFor(await formFixture()),
    );
    const states = await widgetsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(states.toplam?.value).toBe('6.5');
    expect(states.a?.readOnly).toBe(false);
  });

  it('writes a comma-separated value to a text field as one string', async () => {
    const result = await formFieldsDialog.run(
      { fills: 'a=1, 2', calculations: '', lock: false, validateOnly: false },
      contextFor(await formFixture()),
    );
    expect((await widgetsOf(result.files[0]?.bytes ?? new Uint8Array())).a?.value).toBe('1, 2');
  });

  it('writes a comma-separated value to a list box as a multiple selection', async () => {
    const result = await formFieldsDialog.run(
      { fills: 'liste=Bir, Uc', calculations: '', lock: false, validateOnly: false },
      contextFor(await formFixture()),
    );
    const fields = await readFormFields(result.files[0]?.bytes ?? new Uint8Array());
    expect(fields.find((field) => field.name === 'liste')?.value).toEqual(['Bir', 'Uc']);
  });

  it('writes false to a checkbox', async () => {
    const checked = await formFieldsDialog.run(
      { fills: 'onay=true', calculations: '', lock: false, validateOnly: false },
      contextFor(await formFixture()),
    );
    const cleared = await formFieldsDialog.run(
      { fills: 'onay=false', calculations: '', lock: false, validateOnly: false },
      contextFor(checked.files[0]?.bytes ?? new Uint8Array()),
    );
    expect((await widgetsOf(cleared.files[0]?.bytes ?? new Uint8Array())).onay?.value).toBe('Off');
  });
});

describe('createFieldDialog', () => {
  it('creates one field on the chosen page at the typed rectangle', async () => {
    const result = await createFieldDialog.run(
      {
        kind: 'text',
        name: 'email',
        scope: 'current',
        x: 50,
        y: 300,
        width: 120,
        height: 20,
        defaultValue: 'a@b.c',
        options: '',
        fontSize: 10,
        required: true,
      },
      contextFor(await formFixture(2), { pageCount: 2, currentPage: 1 }),
    );
    expect(result.noticeKey).toBe('form.note.created');
    expect(result.noticeParams).toEqual({ count: 1 });
    const states = await widgetsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(states.email).toMatchObject({ value: 'a@b.c', page: 1 });
  });

  it('creates one numbered field per page of the scope', async () => {
    const result = await createFieldDialog.run(
      {
        kind: 'dropdown',
        name: 'city',
        scope: 'all',
        x: 50,
        y: 300,
        width: 120,
        height: 20,
        options: 'Bir, İki ,,Üç',
        fontSize: 12,
        required: false,
      },
      contextFor(await formFixture(2), { pageCount: 2 }),
    );
    expect(result.noticeParams).toEqual({ count: 2 });
    const states = await widgetsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(states.city1?.page).toBe(0);
    expect(states.city2?.page).toBe(1);
  });

  it('refuses a selection scope with no page selected', async () => {
    const error = await failureOf(
      createFieldDialog.run(
        { kind: 'text', name: 'x', scope: 'selection', x: 0, y: 0, width: 20, height: 20, fontSize: 12 },
        contextFor(await formFixture()),
      ),
    );
    expect(error.code).toBe('selection-empty');
  });

  it('refuses more pages than the field ceiling', async () => {
    const error = await failureOf(
      createFieldDialog.run(
        { kind: 'text', name: 'x', scope: 'all', x: 0, y: 0, width: 20, height: 20, fontSize: 12 },
        contextFor(new Uint8Array(), { pageCount: 201 }),
      ),
    );
    expect(error.code).toBe('range-invalid');
    expect(error.details.engineMessage).toBe('201 pages selected, over the 200 field ceiling');
  });

  it('refuses a field kind the engine does not know', async () => {
    const error = await failureOf(
      createFieldDialog.run(
        { kind: 'signature', name: 'x', scope: 'current', x: 0, y: 0, width: 20, height: 20, fontSize: 12 },
        contextFor(await formFixture()),
      ),
    );
    expect(error.code).toBe('value-out-of-range');
    expect(error.details.engineMessage).toBe('unknown field kind: signature');
  });

  it('defaults to a text field when the kind is missing', async () => {
    const result = await createFieldDialog.run(
      { name: 'plain', scope: 'current', x: 50, y: 300, width: 120, height: 20, fontSize: 12 },
      contextFor(await formFixture()),
    );
    expect((await widgetsOf(result.files[0]?.bytes ?? new Uint8Array())).plain?.value).toBe('');
  });
});

describe('formDataDialog', () => {
  it('exports the values as a JSON file the host downloads without touching the document', async () => {
    const bytes = await formFixture();
    const result = await formDataDialog.run({ mode: 'export', format: 'json' }, contextFor(bytes));
    expect(result.deliver).toBe('download');
    expect(result.noticeKey).toBe('form.note.exported');
    expect(result.noticeParams).toEqual({ count: 4 });
    const file = result.files[0];
    expect(file?.mime).toBe('application/json');
    expect(file?.name.endsWith('.json')).toBe(true);
    const data = JSON.parse(new TextDecoder().decode(file?.bytes));
    expect(data).toEqual({
      fields: [
        { name: 'a', value: '2,5' },
        { name: 'b', value: '4' },
        { name: 'onay', value: false },
        { name: 'liste', value: [] },
      ],
    });
    expect(result.report.notes.map((entry) => entry.key)).toEqual([
      'form.note.exported',
      'form.note.exportIsData',
    ]);
  });

  it('exports FDF when asked', async () => {
    const result = await formDataDialog.run(
      { mode: 'export', format: 'fdf' },
      contextFor(await formFixture()),
    );
    expect(result.files[0]?.name.endsWith('.fdf')).toBe(true);
    expect(new TextDecoder().decode(result.files[0]?.bytes).startsWith('%FDF')).toBe(true);
  });

  it('refuses an import without a chosen file', async () => {
    const error = await failureOf(
      formDataDialog.run({ mode: 'import', format: 'json' }, contextFor(await formFixture())),
    );
    expect(error.code).toBe('input-missing');
    expect(error.details.engineMessage).toBe('no form-data file chosen');
  });

  it('imports values from an exported JSON file and reports the fields the file did not know', async () => {
    const bytes = await formFixture();
    const exported = await formDataDialog.run({ mode: 'export', format: 'json' }, contextFor(bytes));
    const data = JSON.parse(new TextDecoder().decode(exported.files[0]?.bytes)) as {
      fields: { name: string; value: unknown }[];
    };
    data.fields[0] = { name: 'a', value: '7,5' };
    data.fields.push({ name: 'ghost', value: 'x' });
    const withUnknown = JSON.stringify(data);
    const result = await formDataDialog.run(
      {
        mode: 'import',
        format: 'json',
        file: [fixedFile('data.json', new TextEncoder().encode(withUnknown))],
      },
      contextFor(bytes),
    );
    expect(result.noticeKey).toBe('form.note.imported');
    expect((await widgetsOf(result.files[0]?.bytes ?? new Uint8Array())).a?.value).toBe('7,5');
    expect(result.report.notes.some((entry) => entry.key === 'form.note.missing')).toBe(true);
    expect(result.noticeParams).toEqual({ count: 4 });
  });

  it('flattens the form after an import when asked: the widgets become page content', async () => {
    const bytes = await formFixture();
    const exported = await formDataDialog.run({ mode: 'export', format: 'json' }, contextFor(bytes));
    const result = await formDataDialog.run(
      {
        mode: 'import',
        format: 'json',
        flatten: true,
        file: [fixedFile('data.json', exported.files[0]?.bytes ?? new Uint8Array())],
      },
      contextFor(bytes),
    );
    expect(Object.keys(await widgetsOf(result.files[0]?.bytes ?? new Uint8Array()))).toEqual([]);
    expect(result.report.steps.length).toBeGreaterThan(1);
  });
});
