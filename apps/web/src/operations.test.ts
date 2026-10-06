/**
 * Operation-aware output verification.
 *
 * Every case here builds a real PDF with MuPDF and reads it back through the same
 * pdf.js adapter the application uses, because the defect this suite guards against was
 * invisible to any test that stubbed the reader: the previous implementation decided
 * which checks to skip by matching the operation's step ids against
 * `/delete|clear|blank|flatten/i` — a pattern no id this app produces matches — and
 * reported "verified" for the checks it happened to run, without recording the ones it
 * never ran. So the assertions are about the *returned table*: which facts are verified,
 * which are degraded with which reason, which this build cannot check, and which change
 * throws.
 *
 * One boundary is faked, and only one: the case that walks `materializeBase` end to end
 * answers the live handle's `saveDocument()` with bytes this suite wrote, because a real
 * engine cannot be made to lose a form field. The bytes, the reader, the reference handle
 * and the verifier are real in every case.
 *
 * Two environment notes, neither of them product behaviour:
 *
 *  - pdf.js points `GlobalWorkerOptions.workerSrc` at a browser-relative path
 *    (`/engines/pdfjs/pdf.worker.mjs`) that a Node process cannot resolve, and without a
 *    worker it refuses to parse anything. The file inside the installed package is used
 *    instead, resolved through pdf-core's own dependency link so no dependency is added
 *    to the workspace.
 *  - MuPDF writes the fixtures, loaded from the installed package through pdf-core's own
 *    dependency link for the same reason: the adapter imports it by the served URL.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { PdfDocumentHandle } from 'pdf-core';
import type { Mupdf } from 'pdf-core/engines/mupdf';
import { loadPdfjs, openWithPdfjs } from 'pdf-core/engines/pdfjs-handle';
import { readFormFields } from 'pdf-core/ops/forms';
import { encodeEngineValues, type JsonValue, SessionStore } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import {
  applyHistoryStep,
  materializeBase,
  pendingOverlays,
  tabPageCount,
  verifyForWrite,
  type WriteVerification,
} from './operations';
import type { SaveStepDescription } from './save-plan';

const coreRequire = createRequire(import.meta.url);
const mupdf = (await import(
  pathToFileURL(createRequire(coreRequire.resolve('pdf-core')).resolve('mupdf')).href
)) as Mupdf;
/** MuPDF's document class, as pdf-core's adapter types it (this workspace does not declare mupdf). */
type PDFDocument = InstanceType<Mupdf['PDFDocument']>;
const pdfjs = await loadPdfjs();
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(coreRequire.resolve('pdf-core')).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

/** The step ids a rotate, delete or insert actually journals (`save-plan.ts`). */
const COMPOSE_STEPS = ['pdfjs.extractPages', 'metadata', 'save'];

const PAGE_SIZE: [number, number] = [400, 500];
const LINES = ['Alpha page text', 'Bravo page text', 'Charlie page text'];

interface Fixture {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
}

/** A three-page document whose pages carry distinct, extractable text. */
async function threePageDocument(
  pageCount = 3,
  textOf: Readonly<Record<number, string>> = {},
): Promise<Fixture> {
  const document = new mupdf.PDFDocument();
  const font = document.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  for (let index = 0; index < pageCount; index += 1) {
    const line = textOf[index] ?? LINES[index] ?? `Page ${index + 1}`;
    const content = `BT /F 18 Tf 40 ${PAGE_SIZE[1] - 80} Td (${line}) Tj ET`;
    document.insertPage(index, document.addPage([0, 0, ...PAGE_SIZE], 0, { Font: { F: font } }, content));
  }
  return { bytes: saved(document), pageCount };
}

/** Serialise and release a fixture document. */
function saved(document: PDFDocument): Uint8Array {
  const bytes = new Uint8Array(document.saveToBuffer('').asUint8Array());
  document.destroy();
  return bytes;
}

function reopen(bytes: Uint8Array): PDFDocument {
  const document = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (document === null) throw new Error('not a PDF');
  return document;
}

/** Text fields on page 1, each a field dictionary that is also its widget, with a value. */
async function withFields(
  bytes: Uint8Array,
  values: readonly (readonly [string, string])[],
): Promise<Uint8Array> {
  const document = reopen(bytes);
  const page = document.findPage(0);
  const root = document.getTrailer().get('Root');
  if (root.get('AcroForm').isNull()) root.put('AcroForm', { Fields: [] });
  if (page.get('Annots').isNull()) page.put('Annots', []);
  for (const [name, value] of values) {
    // A field without a widget is not a field a reader can lose: the partial-loss case
    // below takes the widget off the page with the field.
    const field = document.addObject({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Tx',
      T: document.newString(name),
      V: document.newString(value),
      Rect: [40, 40, 220, 60],
      P: page,
      F: 4,
    });
    root.get('AcroForm', 'Fields').push(field);
    page.get('Annots').push(field);
  }
  return saved(document);
}

/** The same fields with one value rewritten: what a save of engine-side values writes. */
async function withChangedValue(bytes: Uint8Array, name: string, value: string): Promise<Uint8Array> {
  const document = reopen(bytes);
  const fields = document.getTrailer().get('Root', 'AcroForm', 'Fields');
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields.get(index);
    if (field.get('T').asString() === name) field.put('V', document.newString(value));
  }
  return saved(document);
}

/** The same fields minus one: the loss the field-count check has to catch. */
async function withoutField(bytes: Uint8Array, name: string): Promise<Uint8Array> {
  const document = reopen(bytes);
  const fields = document.getTrailer().get('Root', 'AcroForm', 'Fields');
  const annots = document.findPage(0).get('Annots');
  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const field = fields.get(index);
    if (field.get('T').asString() !== name) continue;
    const number = field.asIndirect();
    fields.delete(index);
    for (let position = annots.length - 1; position >= 0; position -= 1) {
      if (annots.get(position).asIndirect() === number) annots.delete(position);
    }
  }
  return saved(document);
}

/**
 * A tab's live handle with engine-side edits: its storage holds a pending value — the
 * state `hasEngineEdits` reads, seeded through pdf.js's own storage API — and
 * `saveDocument()` answers with the bytes this suite wrote.
 *
 * This boundary is the one fake in the file, and it is the only way to hand the verifier
 * an engine save that lost a field: a real engine writes what its storage holds, and
 * nothing else. Every byte the checks read stays real — MuPDF wrote them, pdf.js reads
 * them, and the reference is a real handle.
 */
async function engineSaveHandle(master: Uint8Array, saved: Uint8Array): Promise<PdfDocumentHandle> {
  const handle = await openWithPdfjs(master);
  handle.raw.annotationStorage.setValue('pendingFieldValue', { value: 'pending' });
  return { ...handle, saveDocument: async () => new Uint8Array(saved) };
}

/**
 * One save run in the app's own order: `materializeBase` over the tab's live handle, then
 * `verifyForWrite` against that handle with **the steps the run journaled**. The step ids
 * are never written by hand here: recognising them is exactly what the verifier has to do,
 * and a run whose ids it does not know is the case this pipeline guards against.
 */
async function materializedVerification(
  handle: PdfDocumentHandle,
  master: Uint8Array,
  reference: PdfDocumentHandle,
  expectedFormFields: readonly { readonly name: string; readonly value: string }[],
): Promise<WriteVerification> {
  const store = new SessionStore();
  const tab = store.openDocument({ name: 'form.pdf', bytes: master, sha256: 'fixture', pageCount: 3 });
  const executedSteps: SaveStepDescription[] = [];
  const bytes = await materializeBase(
    { store, t: createTranslator(), tab, handle },
    { signal: new AbortController().signal },
    executedSteps,
  );
  return await verifyForWrite(bytes, {
    expectedPageCount: tabPageCount(tab),
    sourceHandle: reference,
    steps: executedSteps.map((step) => step.id),
    expectedFormFields,
  });
}

/** Verify `produced` against `reference`, the way the save path does. */
async function verify(
  produced: Uint8Array,
  referenceBytes: Uint8Array,
  options: {
    readonly expectedPageCount: number;
    readonly steps?: readonly string[];
    readonly expectedFormFields?: readonly { readonly name: string; readonly value: string }[];
    readonly budgetBytes?: number;
  },
): Promise<WriteVerification> {
  const reference = await openWithPdfjs(referenceBytes);
  try {
    return await verifyForWrite(produced, {
      expectedPageCount: options.expectedPageCount,
      sourceHandle: reference,
      ...(options.steps === undefined ? {} : { steps: options.steps }),
      ...(options.expectedFormFields === undefined ? {} : { expectedFormFields: options.expectedFormFields }),
      ...(options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes }),
    });
  } finally {
    await reference.destroy();
  }
}

function checkFor(verification: WriteVerification, fact: string) {
  return verification.checks.find((check) => check.fact === fact);
}

describe('verifyForWrite', () => {
  it('refuses a page whose content differs when the operation did not declare content', async () => {
    const source = await threePageDocument();
    const altered = await threePageDocument(3, { 1: 'Zulu page text' });
    await expect(
      verify(altered.bytes, source.bytes, { expectedPageCount: 3, steps: ['pdfjs.saveDocument'] }),
    ).rejects.toThrow(/pageOrder: page 2 differs from the reference/);
    // Unchanged pages are not what it objects to.
    const same = await verify(source.bytes, source.bytes, {
      expectedPageCount: 3,
      steps: ['pdfjs.saveDocument'],
    });
    expect(checkFor(same, 'pageContent')?.verdict).toBe('verified');
  });

  it('measures a content change an operation declared, and names the page that lost its text', async () => {
    const source = await threePageDocument();
    const altered = await threePageDocument(3, { 1: 'Zulu page text' });
    const changed = await verify(altered.bytes, source.bytes, {
      expectedPageCount: 3,
      steps: COMPOSE_STEPS,
    });
    expect(checkFor(changed, 'pageContent')).toEqual({
      fact: 'pageContent',
      verdict: 'degraded',
      reason: 'changed',
      params: { page: 2 },
    });
    expect(checkFor(changed, 'textContent')?.verdict).toBe('verified');

    const wordy = await threePageDocument(3, { 1: 'Bravo page text with plenty more words' });
    const blank = await threePageDocument(3, { 1: '' });
    const lost = await verify(blank.bytes, wordy.bytes, { expectedPageCount: 3, steps: COMPOSE_STEPS });
    expect(checkFor(lost, 'textContent')).toEqual({
      fact: 'textContent',
      verdict: 'degraded',
      reason: 'changed',
      params: { page: 2 },
    });
    await expect(
      verify(blank.bytes, wordy.bytes, { expectedPageCount: 3, steps: ['boxes'] }),
    ).rejects.toThrow(/page 2/);
  });

  it('refuses a changed page box unless the operation declared boxes', async () => {
    const source = await threePageDocument();
    const document = reopen(source.bytes);
    document.findPage(0).put('CropBox', [10, 10, 390, 490]);
    const cropped = saved(document);
    await expect(verify(cropped, source.bytes, { expectedPageCount: 3, steps: [] })).rejects.toThrow(
      /page 1/,
    );
    const declared = await verify(cropped, source.bytes, { expectedPageCount: 3, steps: ['boxes'] });
    expect(checkFor(declared, 'cropBox')).toEqual({
      fact: 'cropBox',
      verdict: 'degraded',
      reason: 'changed',
      params: { page: 1 },
    });
  });

  it('says it only sampled pages of a long document instead of claiming it checked them all', async () => {
    const long = await threePageDocument(70);
    const result = await verify(long.bytes, long.bytes, { expectedPageCount: 70, steps: [] });
    expect(checkFor(result, 'pageOrder')).toMatchObject({ verdict: 'degraded', reason: 'sampled' });
    expect(result.sampledPages.length).toBeLessThan(70);
    expect(result.sampledPages.length).toBeGreaterThan(0);
  });

  it('verifies an unchanged document and never claims what it cannot check', async () => {
    const source = await threePageDocument();
    const unchanged = await threePageDocument();
    const result = await verify(unchanged.bytes, source.bytes, {
      expectedPageCount: 3,
      steps: [],
    });

    expect(result.state).toBe('verified');
    expect(result.operation).toEqual({ kind: 'declared', steps: [] });
    expect(result.declared).toEqual([]);
    expect(result.sampledPages).toEqual([0, 1, 2]);
    for (const fact of [
      'pageCount',
      'pageOrder',
      'pageContent',
      'textContent',
      'rotation',
      'cropBox',
    ] as const) {
      expect(checkFor(result, fact)?.verdict, fact).toBe('verified');
    }
    // The two facts this build cannot check are reported as such, in every run: an
    // `unsupported` row is the difference between a claim and silence.
    expect(checkFor(result, 'annotations')).toEqual({
      fact: 'annotations',
      verdict: 'unsupported',
      reason: 'pending-storage',
    });
    expect(checkFor(result, 'signatures')?.verdict).toBe('unsupported');
  });

  it('measures a declared rotation instead of failing it, and still verifies order and content', async () => {
    const source = await threePageDocument();
    const document = reopen((await threePageDocument()).bytes);
    document.findPage(1).put('Rotate', 90);
    const rotated = saved(document);

    const result = await verify(rotated, source.bytes, {
      expectedPageCount: 3,
      steps: COMPOSE_STEPS,
    });

    // The composed page list is declared able to change rotation; the change is
    // reported, not thrown, and the facts the step did not touch are still checked.
    expect(checkFor(result, 'rotation')).toEqual({
      fact: 'rotation',
      verdict: 'degraded',
      reason: 'changed',
      params: { page: 2 },
    });
    expect(checkFor(result, 'pageOrder')?.verdict).toBe('verified');
    expect(checkFor(result, 'pageContent')?.verdict).toBe('verified');
    expect(checkFor(result, 'pageCount')?.verdict).toBe('verified');
    expect(result.state).toBe('degraded');
    expect(result.declared).toContain('rotation');
  });

  it('accepts a page count its operation declared, and refuses one it did not', async () => {
    const source = await threePageDocument();
    const loaded = reopen(source.bytes);
    loaded.deletePage(1);
    const deleted = saved(loaded);

    const declared = await verify(deleted, source.bytes, {
      expectedPageCount: 2,
      steps: COMPOSE_STEPS,
    });
    expect(checkFor(declared, 'pageCount')).toEqual({
      fact: 'pageCount',
      verdict: 'degraded',
      reason: 'changed',
      params: { count: 2 },
    });
    // A page list that changed makes a positional comparison meaningless, and the
    // table says exactly that rather than passing the facts silently.
    expect(checkFor(declared, 'pageOrder')).toEqual({
      fact: 'pageOrder',
      verdict: 'unsupported',
      reason: 'changed',
    });

    // The same bytes under steps that promise the page list is untouched: the model
    // says three pages, the reference had three, the output has two.
    await expect(verify(deleted, source.bytes, { expectedPageCount: 3, steps: [] })).rejects.toThrow(
      ToolError,
    );
  });

  it('fails when a form field disappears under an operation that must not touch the fields', async () => {
    const source = await threePageDocument();
    const expectedFields = [
      { name: 'fullName', value: 'Ada Lovelace' },
      { name: 'city', value: 'Izmir' },
      { name: 'postcode', value: '35000' },
    ];
    const fields = await withFields(source.bytes, [
      ['fullName', 'Ada Lovelace'],
      ['city', 'Izmir'],
      ['postcode', '35000'],
    ]);
    // A real partial loss: a document written from the same source with one field
    // missing, verified against the three-field inventory the session holds.
    const partial = await withFields(source.bytes, [
      ['fullName', 'Ada Lovelace'],
      ['city', 'Izmir'],
    ]);

    // The engine save writes field *values*, so it is declared for `formFieldValues`
    // only: a field that vanishes is a failure.
    const intact = await verify(fields, fields, {
      expectedPageCount: 3,
      steps: ['pdfjs.saveDocument'],
      expectedFormFields: expectedFields,
    });
    expect(checkFor(intact, 'formFieldCount')?.verdict).toBe('verified');

    await expect(
      verify(partial, fields, {
        expectedPageCount: 3,
        steps: ['pdfjs.saveDocument'],
        expectedFormFields: expectedFields,
      }),
    ).rejects.toThrow(/formFieldCount/);
  });

  it('reports a budget shortcut as degraded, naming the facts it skipped', async () => {
    const source = await threePageDocument();
    const result = await verify(source.bytes, source.bytes, {
      expectedPageCount: 3,
      steps: [],
      budgetBytes: 128,
    });

    expect(result.state).toBe('degraded');
    for (const fact of ['pageOrder', 'pageContent', 'textContent'] as const) {
      expect(checkFor(result, fact), fact).toEqual({
        fact,
        verdict: 'degraded',
        reason: 'budget',
      });
    }
    // The cheap checks still ran: a shortcut is not a blanket excuse.
    expect(checkFor(result, 'pageCount')?.verdict).toBe('verified');
    expect(checkFor(result, 'rotation')?.verdict).toBe('verified');
    expect(result.sampledPages).toEqual([]);
  });

  it('treats an operation it cannot characterise as unverified rather than as unchanged', async () => {
    const source = await threePageDocument();
    const loaded = reopen(source.bytes);
    loaded.deletePage(1);
    const deleted = saved(loaded);

    const result = await verify(deleted, source.bytes, {
      expectedPageCount: 2,
      steps: ['future-op.nothing-known'],
    });

    expect(result.operation).toEqual({ kind: 'unverified', steps: ['future-op.nothing-known'] });
    expect(checkFor(result, 'pageCount')).toEqual({
      fact: 'pageCount',
      verdict: 'degraded',
      reason: 'unverified',
      params: { steps: 'future-op.nothing-known', count: 2 },
    });
  });
});

/**
 * The engine's own save, end to end (`materializeBase` → `verifyForWrite`).
 *
 * A form value the user typed lives in the engine's storage, not in the bytes, so the
 * value in the output is a change **this run** made — and the only thing that tells the
 * verifier so is the step id the run journals. A run whose id the table does not know
 * degrades to "unverified": the value it wrote is then reported as an unexplained change
 * (`policyFor`), the operation stops being declared, and a save the user asked for comes
 * back short of what it actually did. The cases below go through the real
 * `materializeBase`, so the ids under test are the ones the app journals.
 */
describe('materializeBase → verifyForWrite', () => {
  it('measures the value the engine save wrote and still refuses a field it lost', async () => {
    const source = await threePageDocument();
    const expectedFields = [
      { name: 'fullName', value: 'Ada Lovelace' },
      { name: 'city', value: 'Izmir' },
      { name: 'postcode', value: '35000' },
    ];
    // The file the session opened, and two real documents a save of its pending values
    // can produce: one where a value reached the page, one where a field is gone.
    const filled = await withFields(
      source.bytes,
      expectedFields.map((field) => [field.name, field.value] as const),
    );
    const saved = await withChangedValue(filled, 'city', 'Ankara');
    const lossy = await withoutField(filled, 'postcode');

    // The reference is the live handle: the bytes the session holds, where the pending
    // value is not yet written (`save-plan.ts`).
    const reference = await openWithPdfjs(filled);
    const changed = await engineSaveHandle(filled, saved);
    const lossyHandle = await engineSaveHandle(filled, lossy);
    try {
      const accepted = await materializedVerification(changed, filled, reference, expectedFields);

      // The engine save is declared for the values it writes, so the value it wrote is
      // measured and reported once — not thrown, and not reported as a change nobody
      // declared. The field *count* is not part of that declaration, so it stays a
      // promise: `verified` here, and a failure below.
      expect(accepted.operation).toEqual({ kind: 'declared', steps: [] });
      expect(accepted.declared).toContain('formFieldValues');
      expect(accepted.declared).not.toContain('formFieldCount');
      expect(checkFor(accepted, 'formFieldValues')).toEqual({
        fact: 'formFieldValues',
        verdict: 'degraded',
        reason: 'changed',
        params: { count: 1 },
      });
      expect(checkFor(accepted, 'formFieldCount')?.verdict).toBe('verified');
      expect(accepted.state).toBe('degraded');

      // The same declared save, one field short of the inventory the session holds.
      await expect(materializedVerification(lossyHandle, filled, reference, expectedFields)).rejects.toThrow(
        /^\[verification-failed\] pdfjs: formFieldCount: expected 3 field\(s\), found 2$/,
      );
    } finally {
      await reference.destroy();
      await changed.destroy();
      await lossyHandle.destroy();
    }
  });
});

describe('mark-only history', () => {
  it('keeps the live viewer and typed form values while moving between mark snapshots', async () => {
    const source = await threePageDocument(1);
    const bytes = await withFields(source.bytes, [['city', 'Izmir']]);
    const store = new SessionStore();
    const opened = store.openDocument({ name: 'history.pdf', bytes, sha256: 'history', pageCount: 1 });
    const handle = await openWithPdfjs(bytes);
    try {
      const page = await handle.raw.getPage(1);
      const fields = await page.getAnnotations();
      const field = fields.find(
        (item: unknown): item is { id: string; fieldName: string } =>
          item !== null &&
          typeof item === 'object' &&
          'id' in item &&
          typeof item.id === 'string' &&
          'fieldName' in item &&
          item.fieldName === 'city',
      );
      if (field === undefined) throw new Error('the real form widget was not produced');
      handle.raw.annotationStorage?.setValue(field.id, { value: 'Ankara' });
      const engineValues = await encodeEngineValues([[field.id, { value: 'Ankara' }]]);
      const before = { annotations: [], measures: [], redactions: [], engineValues };
      store.setOverlays(opened.id, before as unknown as JsonValue, 'ann.engineEdit');
      // A restored draft has equal values but not shared object references.
      const mark = {
        id: 'owned-highlight',
        kind: 'highlight',
        pageIndex: 0,
        quads: [[40, 65, 180, 85]],
        color: '#ffff00',
        opacity: 1,
        author: '',
        contents: '',
        createdAt: '2026-09-22T00:00:00.000Z',
      };
      store.setOverlays(
        opened.id,
        { ...before, engineValues: JSON.parse(JSON.stringify(engineValues)), annotations: [mark] },
        'ann.engineEdit',
      );
      const current = () => {
        const tab = store.active;
        if (tab === null) throw new Error('the history operation closed the document');
        return { store, tab, handle, t: createTranslator('en') };
      };
      const undo = await applyHistoryStep(current(), 'undo', { signal: new AbortController().signal });
      expect(undo?.handle).toBe(handle);
      expect(pendingOverlays(store.active).annotations).toEqual([]);
      const saved = await materializeBase(current());
      expect((await readFormFields(saved)).map(({ name, value }) => ({ name, value }))).toEqual([
        { name: 'city', value: 'Ankara' },
      ]);
      const redo = await applyHistoryStep(current(), 'redo', { signal: new AbortController().signal });
      expect(redo?.handle).toBe(handle);
      expect(pendingOverlays(store.active).annotations).toEqual([mark]);
    } finally {
      await handle.destroy();
    }
  });
});
