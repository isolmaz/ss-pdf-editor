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
 * One environment note, not product behaviour: MuPDF writes the fixtures, loaded from the
 * installed package through pdf-core's own dependency link, because the adapter imports it
 * by the served URL. (pdf.js's worker is pointed at the installed package by
 * `vitest.setup.ts`, for every suite.)
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { PdfDocumentHandle } from 'pdf-core';
import { readAnnotations } from 'pdf-core';
import type { Mupdf } from 'pdf-core/engines/mupdf';
import { openWithPdfjs } from 'pdf-core/engines/pdfjs-handle';
import { readFormFields } from 'pdf-core/ops/forms';
import { scaleForRatio } from 'pdf-core/ops/measure';
import { readPageText } from 'pdf-core/text-source';
import { encodeEngineValues, type JsonValue, SessionStore, workingPageCount } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import {
  applyHistoryStep,
  applyPageAction,
  applyProducedBytes,
  DOCUMENT_FACTS,
  hasEngineEdits,
  materializeBase,
  pageActionLabel,
  pendingOverlays,
  planPageAction,
  pruneOverlays,
  redactionNeedles,
  removeMarkTargets,
  verifyForWrite,
  type WriteVerification,
  writeSessionAnnotations,
} from './operations';
import type { SaveStepDescription } from './save-plan';

const coreRequire = createRequire(import.meta.url);
const mupdf = (await import(
  pathToFileURL(createRequire(coreRequire.resolve('pdf-core')).resolve('mupdf')).href
)) as Mupdf;
/** MuPDF's document class, as pdf-core's adapter types it (this workspace does not declare mupdf). */
type PDFDocument = InstanceType<Mupdf['PDFDocument']>;
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
    expectedPageCount: workingPageCount(tab),
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

describe('applyHistoryStep over a mark-only step', () => {
  it('keeps the live viewer when it is refused, and leaves the history where it was', async () => {
    const source = await threePageDocument(1);
    const store = new SessionStore();
    const opened = store.openDocument({
      name: 'marks.pdf',
      bytes: source.bytes,
      sha256: 'marks',
      pageCount: 1,
    });
    const handle = await openWithPdfjs(source.bytes);
    try {
      const empty = { annotations: [], measures: [], redactions: [] };
      store.setOverlays(opened.id, empty as unknown as JsonValue, 'ann.engineEdit');
      const cursor = store.active?.journal.cursor;
      const aborted = new AbortController();
      aborted.abort();
      const tab = store.active;
      if (tab === null) throw new Error('the document closed');
      await expect(
        applyHistoryStep({ store, tab, handle, t: createTranslator('en') }, 'undo', {
          signal: aborted.signal,
        }),
      ).rejects.toMatchObject({ code: 'aborted' });
      expect(store.active?.journal.cursor).toBe(cursor);
      // The viewer was not the step's to release: it still answers.
      expect((await handle.raw.getPage(1)).pageNumber).toBe(1);
    } finally {
      await handle.destroy();
    }
  });
});

/** A session over `bytes`, the live handle the app would hold, and the tab as a page action sees it. */
async function openSession(bytes: Uint8Array, pageCount: number) {
  const store = new SessionStore();
  store.openDocument({ name: 'doc.pdf', bytes, sha256: 'doc', pageCount });
  const handle = await openWithPdfjs(bytes);
  const context = () => {
    const tab = store.active;
    if (tab === null) throw new Error('the session has no active tab');
    return { store, tab, handle, t: createTranslator('en') };
  };
  return { store, handle, context };
}

const SIGNAL = { signal: new AbortController().signal };

const HIGHLIGHT = {
  id: 'session-highlight',
  kind: 'highlight' as const,
  pageIndex: 0,
  quads: [[40, 65, 180, 85]] as [number, number, number, number][],
  color: '#ffff00',
  opacity: 1,
  author: '',
  contents: '',
  createdAt: '2026-09-22T00:00:00.000Z',
};

const RULER = {
  id: 'session-ruler',
  pageIndex: 0,
  mode: 'distance' as const,
  points: [
    { x: 40, y: 100 },
    { x: 240, y: 100 },
  ],
  scale: scaleForRatio(100),
  color: '#ff0000',
  opacity: 1,
  author: '',
  contents: '',
  createdAt: '2026-09-22T00:00:00.000Z',
};

/** The annotation subtypes of every page, read back from the bytes by MuPDF. */
function annotationSubtypes(bytes: Uint8Array): string[][] {
  const document = reopen(bytes);
  try {
    return Array.from({ length: document.countPages() }, (_unused, index) => {
      const annots = document.findPage(index).get('Annots');
      return annots.isNull()
        ? []
        : Array.from({ length: annots.length }, (_item, at) => annots.get(at).get('Subtype').asName());
    });
  } finally {
    document.destroy();
  }
}

function rotationsOf(bytes: Uint8Array): number[] {
  const document = reopen(bytes);
  try {
    return Array.from({ length: document.countPages() }, (_unused, index) => {
      const rotate = document.findPage(index).get('Rotate');
      return rotate.isNull() ? 0 : rotate.asNumber();
    });
  } finally {
    document.destroy();
  }
}

function textsOf(bytes: Uint8Array): string[] {
  const document = reopen(bytes);
  try {
    return Array.from({ length: document.countPages() }, (_unused, index) =>
      document.loadPage(index).toStructuredText('').asText().trim(),
    );
  } finally {
    document.destroy();
  }
}

describe('planPageAction', () => {
  const pages = ['a', 'b', 'c', 'd'].map((id, index) => ({
    id,
    sourceId: 'src',
    srcIndex: index,
    rotation: 0 as const,
  }));
  const ids = (list: readonly { readonly id: string }[]) => list.map((page) => page.id);

  it('removes the selected pages and leaves every other page alone', () => {
    expect(ids(planPageAction(pages, [1, 3], { kind: 'delete' }).pages)).toEqual(['a', 'c']);
  });

  it('copies each selected page right after itself under a fresh id', () => {
    const plan = planPageAction(pages, [2], { kind: 'duplicate' });
    expect(ids(plan.pages)).toEqual(['a', 'b', 'c', 'c~copy2', 'd']);
    expect(plan.pages[3]).toMatchObject({ srcIndex: 2, sourceId: 'src' });
    expect(plan.rotations).toEqual({});
  });

  it('moves the selection, in page order, to the target index counted over the remaining pages', () => {
    expect(ids(planPageAction(pages, [3, 0], { kind: 'move', toIndex: 1 }).pages)).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
    // A target past the end lands after the last remaining page, one before the start at the front.
    expect(ids(planPageAction(pages, [0], { kind: 'move', toIndex: 99 }).pages)).toEqual([
      'b',
      'c',
      'd',
      'a',
    ]);
    expect(ids(planPageAction(pages, [3], { kind: 'move', toIndex: -5 }).pages)).toEqual([
      'd',
      'a',
      'b',
      'c',
    ]);
    // Nothing selected, nothing moves.
    expect(planPageAction(pages, [], { kind: 'move', toIndex: 2 }).pages).toBe(pages);
  });

  it('turns only the selected pages by a quarter turn in the direction asked', () => {
    const turned = pages.map((page, index) => (index === 2 ? { ...page, rotation: 270 as const } : page));
    expect(planPageAction(turned, [0, 2], { kind: 'rotate', direction: 'right' }).rotations).toEqual({
      0: 90,
      2: 0,
    });
    expect(planPageAction(turned, [0, 2], { kind: 'rotate', direction: 'left' }).rotations).toEqual({
      0: 270,
      2: 180,
    });
  });

  it('leaves the page list of this document alone for an insert, which is a merge', () => {
    const plan = planPageAction(pages, [0], {
      kind: 'insert',
      bytes: new Uint8Array(),
      pageCount: 2,
      insertAfter: 1,
    });
    expect(plan.pages).toBe(pages);
    expect(plan.rotations).toEqual({});
  });
});

describe('pageActionLabel', () => {
  it('names each action with the count its notice interpolates', () => {
    expect(pageActionLabel({ kind: 'rotate', direction: 'left' }, 2)).toEqual({
      key: 'pages.rotate.done',
      params: { count: 2 },
    });
    expect(pageActionLabel({ kind: 'delete' }, 3)).toEqual({
      key: 'pages.delete.done',
      params: { count: 3 },
    });
    expect(pageActionLabel({ kind: 'duplicate' }, 1)).toEqual({
      key: 'pages.duplicate.done',
      params: { count: 1 },
    });
    expect(pageActionLabel({ kind: 'move', toIndex: 0 }, 4)).toEqual({
      key: 'pages.moved',
      params: { count: 4 },
    });
    // An insert counts the pages it brings, not the selection.
    expect(
      pageActionLabel({ kind: 'insert', bytes: new Uint8Array(), pageCount: 7, insertAfter: 0 }, 1),
    ).toEqual({ key: 'file.add.done', params: { count: 7 } });
  });
});

describe('pruneOverlays', () => {
  it('drops exactly the named marks and keeps the identity of a list nothing left', () => {
    const redaction = {
      id: 'r1',
      mark: { pageIndex: 0, space: 'app-v1' as const, rect: [0, 0, 1, 1] as const },
    };
    const overlays = { annotations: [HIGHLIGHT], measures: [RULER], redactions: [redaction] };
    const none = { annotations: [], measures: [], redactions: [], existing: [] };

    expect(pruneOverlays(overlays, none).annotations).toBe(overlays.annotations);
    const pruned = pruneOverlays(overlays, {
      ...none,
      measures: [RULER.id],
      redactions: ['r1', 'unknown'],
    });
    expect(pruned.measures).toEqual([]);
    expect(pruned.redactions).toEqual([]);
    expect(pruned.annotations).toBe(overlays.annotations);
    // Asking for an id that is not in the list changes nothing, identity included.
    expect(pruneOverlays(overlays, { ...none, annotations: ['missing'] }).annotations).toBe(
      overlays.annotations,
    );
  });
});

describe('hasEngineEdits', () => {
  it('is false for a storage pdf.js has no entries in and for a handle without a storage, true after an edit', async () => {
    const source = await threePageDocument(1);
    const handle = await openWithPdfjs(source.bytes);
    try {
      expect(hasEngineEdits(handle)).toBe(false);
      expect(
        hasEngineEdits({ ...handle, raw: { annotationStorage: null } } as unknown as PdfDocumentHandle),
      ).toBe(false);
      expect(
        hasEngineEdits({ ...handle, raw: { annotationStorage: 4 } } as unknown as PdfDocumentHandle),
      ).toBe(false);
      expect(
        hasEngineEdits({ ...handle, raw: { annotationStorage: {} } } as unknown as PdfDocumentHandle),
      ).toBe(false);
      handle.raw.annotationStorage.setValue('typed', { value: 'x' });
      expect(hasEngineEdits(handle)).toBe(true);
    } finally {
      await handle.destroy();
    }
  });
});

describe('applyPageAction', () => {
  it('rotates a page, journals it and hands back a handle over the rotated bytes', async () => {
    const source = await threePageDocument();
    const { store, handle, context } = await openSession(source.bytes, 3);
    try {
      const next = await applyPageAction(context(), [1], { kind: 'rotate', direction: 'right' }, SIGNAL);
      expect(next?.pageCount).toBe(3);
      const produced = store.active?.working.produced;
      expect(rotationsOf(produced?.bytes ?? new Uint8Array())).toEqual([0, 90, 0]);
      expect(textsOf(produced?.bytes ?? new Uint8Array())).toEqual(LINES);
      await next?.destroy();
    } finally {
      await handle.destroy();
    }
  });

  it('answers null for an action that changes nothing or would empty the document', async () => {
    const source = await threePageDocument(2);
    const { store, handle, context } = await openSession(source.bytes, 2);
    try {
      expect(await applyPageAction(context(), [0, 1], { kind: 'delete' }, SIGNAL)).toBeNull();
      expect(await applyPageAction(context(), [], { kind: 'move', toIndex: 1 }, SIGNAL)).toBeNull();
      // Moving a page onto the place it already holds is the same page list: no new version.
      expect(await applyPageAction(context(), [0], { kind: 'move', toIndex: 0 }, SIGNAL)).toBeNull();
      expect(await applyPageAction(context(), [], { kind: 'rotate', direction: 'left' }, SIGNAL)).toBeNull();
      expect(store.active?.working.produced ?? null).toBeNull();
    } finally {
      await handle.destroy();
    }
  });

  it('bakes pending annotations and measurements into the bytes before it composes, and renumbers the pending redactions', async () => {
    const source = await threePageDocument();
    const { store, handle, context } = await openSession(source.bytes, 3);
    try {
      const redaction = (id: string, pageIndex: number) => ({
        id,
        mark: { pageIndex, space: 'app-v1' as const, rect: [10, 10, 60, 40] as const },
      });
      const tabId = context().tab.id;
      store.setOverlays(
        tabId,
        {
          annotations: [HIGHLIGHT],
          measures: [RULER],
          redactions: [redaction('on-deleted', 1), redaction('on-last', 2)],
        } as unknown as JsonValue,
        'ann.engineEdit',
      );
      const next = await applyPageAction(context(), [1], { kind: 'delete' }, SIGNAL);
      expect(next?.pageCount).toBe(2);
      const produced = store.active?.working.produced;
      const bytes = produced?.bytes ?? new Uint8Array();
      expect(textsOf(bytes)).toEqual([LINES[0], LINES[2]]);
      expect(annotationSubtypes(bytes)[0]).toEqual(['Highlight', 'Popup', 'Line']);
      // The baked marks are no longer pending; the redaction on the removed page left with it
      // and the one on the last page now points at page index 1.
      expect(pendingOverlays(store.active)).toMatchObject({ annotations: [], measures: [] });
      expect(pendingOverlays(store.active).redactions).toEqual([
        { id: 'on-last:1', mark: { pageIndex: 1, space: 'app-v1', rect: [10, 10, 60, 40] } },
      ]);
      await next?.destroy();
    } finally {
      await handle.destroy();
    }
  });
});

describe('materializeBase with pending measurements', () => {
  it('writes the measurement into the bytes and journals the steps that did it', async () => {
    const source = await threePageDocument(1);
    const { store, handle, context } = await openSession(source.bytes, 1);
    try {
      store.setOverlays(
        context().tab.id,
        { annotations: [], measures: [RULER], redactions: [] } as unknown as JsonValue,
        'ann.engineEdit',
      );
      const steps: SaveStepDescription[] = [];
      const bytes = await materializeBase(context(), SIGNAL, steps);
      expect(annotationSubtypes(bytes)).toEqual([['Line']]);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.every((step) => step.note === 'pending measurements' && step.engine === 'mupdf')).toBe(
        true,
      );
    } finally {
      await handle.destroy();
    }
  });
});

describe('applyProducedBytes', () => {
  it('refuses a result above the page ceiling and one above the byte ceiling, naming which', async () => {
    const source = await threePageDocument(1);
    const { store, handle, context } = await openSession(source.bytes, 1);
    try {
      const label = { key: 'pages.moved' as const };
      await expect(
        applyProducedBytes(context(), source.bytes, 2001, label, 'mupdf', []),
      ).rejects.toMatchObject({
        code: 'page-limit',
        details: { engine: 'model', path: 'doc.pdf' },
      });
      await expect(
        applyProducedBytes(context(), new Uint8Array(300 * 1024 * 1024 + 1), 1, label, 'mupdf', []),
      ).rejects.toMatchObject({ code: 'file-too-large', details: { engine: 'model' } });
      expect(store.active?.working.produced ?? null).toBeNull();
    } finally {
      await handle.destroy();
    }
  });

  it('refuses to mount a result whose operation was aborted, or whose tab is no longer current', async () => {
    const source = await threePageDocument(1);
    const { store, handle, context } = await openSession(source.bytes, 1);
    try {
      const label = { key: 'pages.moved' as const };
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        applyProducedBytes(context(), source.bytes, 1, label, 'mupdf', [], { signal: aborted.signal }),
      ).rejects.toMatchObject({ code: 'aborted' });
      await expect(
        applyProducedBytes({ ...context(), isCurrent: () => false }, source.bytes, 1, label, 'mupdf', []),
      ).rejects.toMatchObject({ code: 'aborted' });
      expect(store.active?.working.produced ?? null).toBeNull();
      // With nothing in the way the same bytes mount, and the label's parameters reach the journal.
      const mounted = await applyProducedBytes(
        context(),
        source.bytes,
        1,
        { key: 'pages.moved', params: { count: 5 } },
        'mupdf',
        ['save'],
      );
      expect(store.active?.working.produced?.bytes).toBe(source.bytes);
      await mounted.destroy();
    } finally {
      await handle.destroy();
    }
  });
});

describe('removeMarkTargets', () => {
  it('deletes the named file annotation from the bytes and keeps the other pending marks pending', async () => {
    const source = await threePageDocument(1);
    const written = await writeSessionAnnotations(source.bytes, [HIGHLIGHT], SIGNAL);
    const { store, handle, context } = await openSession(written, 1);
    try {
      const target = (await readAnnotations(handle, SIGNAL)).find((item) => item.subtype === 'Highlight');
      if (target === undefined) throw new Error('the highlight was not written');
      store.setOverlays(
        context().tab.id,
        {
          annotations: [{ ...HIGHLIGHT, id: 'other' }],
          measures: [RULER],
          redactions: [],
        } as unknown as JsonValue,
        'ann.engineEdit',
      );
      const steps: SaveStepDescription[] = [];
      const outcome = await removeMarkTargets(
        context(),
        {
          annotations: [],
          measures: [RULER.id],
          redactions: [],
          existing: [{ pageIndex: target.pageIndex, id: target.id }],
        },
        SIGNAL,
        steps,
      );
      expect(annotationSubtypes(outcome.bytes)).toEqual([[]]);
      expect(outcome.pageCount).toBe(1);
      expect(outcome.overlays.measures).toEqual([]);
      expect(outcome.overlays.annotations.map((mark) => mark.id)).toEqual(['other']);
      expect(outcome.steps).toEqual(steps.map((step) => step.id));
      expect(steps.some((step) => step.note === 'file annotations removed')).toBe(true);
    } finally {
      await handle.destroy();
    }
  });
});

describe('applyHistoryStep over byte history', () => {
  it('undoes a page action by mounting the previous bytes and redoes it again, and refuses when the operation was cancelled', async () => {
    const source = await threePageDocument();
    const { store, handle, context } = await openSession(source.bytes, 3);
    const opened: PdfDocumentHandle[] = [];
    try {
      const rotated = await applyPageAction(context(), [0], { kind: 'rotate', direction: 'right' }, SIGNAL);
      if (rotated === null) throw new Error('the rotation was not applied');
      opened.push(rotated);
      const rotatedBytes = store.active?.working.produced?.bytes ?? new Uint8Array();
      expect(rotationsOf(rotatedBytes)).toEqual([90, 0, 0]);

      const aborted = new AbortController();
      aborted.abort();
      await expect(
        applyHistoryStep({ ...context(), handle: rotated }, 'undo', { signal: aborted.signal }),
      ).rejects.toMatchObject({ code: 'aborted' });
      expect(store.active?.working.produced?.bytes).toBe(rotatedBytes);

      const undone = await applyHistoryStep({ ...context(), handle: rotated }, 'undo', SIGNAL);
      if (undone === null) throw new Error('nothing was undone');
      opened.push(undone.handle);
      expect(undone.handle).not.toBe(rotated);
      expect(undone.handle.pageCount).toBe(3);
      expect(rotationsOf(store.active?.working.produced?.bytes ?? source.bytes)).toEqual([0, 0, 0]);

      const redone = await applyHistoryStep({ ...context(), handle: undone.handle }, 'redo', SIGNAL);
      if (redone === null) throw new Error('nothing was redone');
      opened.push(redone.handle);
      expect(rotationsOf(store.active?.working.produced?.bytes ?? source.bytes)).toEqual([90, 0, 0]);
      // Nothing left to redo.
      expect(await applyHistoryStep({ ...context(), handle: redone.handle }, 'redo', SIGNAL)).toBeNull();
    } finally {
      await handle.destroy();
      for (const item of opened) await item.destroy();
    }
  });
});

describe('redactionNeedles', () => {
  it('returns the words a mark covers, drops single letters and answers nothing for no marks', async () => {
    const source = await threePageDocument(2);
    expect(await redactionNeedles(source.bytes, [], SIGNAL)).toEqual([]);

    const page = await readPageText(source.bytes, 0, SIGNAL);
    const chars = page.blocks.flatMap((block) => block.lines.flatMap((line) => line.chars));
    const text = chars.map((glyph) => glyph.ch).join('');
    expect(text).toBe('Alpha page text');
    // Cover the glyphs of "page": the box of characters 6..9 and nothing else.
    const covered = chars.slice(6, 10);
    const x0 = Math.min(...covered.map((glyph) => glyph.quad[0])) - 0.5;
    const x1 = Math.max(...covered.map((glyph) => glyph.quad[2])) + 0.5;
    const y0 = Math.min(...covered.map((glyph) => glyph.quad[1])) - 0.5;
    const y1 = Math.max(...covered.map((glyph) => glyph.quad[3])) + 0.5;
    const mark = { pageIndex: 0, space: 'app-v1' as const, rect: [x0, y0, x1, y1] as const };
    expect(await redactionNeedles(source.bytes, [mark, mark], SIGNAL)).toEqual(['page']);

    // A box that covers only the "A" of "Alpha" is a one-letter run: not a needle.
    const first = chars[0];
    if (first === undefined) throw new Error('the page has no text');
    const letter = {
      pageIndex: 0,
      space: 'app-v1' as const,
      rect: [first.quad[0] - 0.2, first.quad[1] - 0.2, first.quad[2] + 0.2, first.quad[3] + 0.2] as const,
    };
    expect(await redactionNeedles(source.bytes, [letter], SIGNAL)).toEqual([]);
  });

  it('stops with an aborted error when the signal fired before a page was read', async () => {
    const source = await threePageDocument(1);
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      redactionNeedles(source.bytes, [{ pageIndex: 0, space: 'app-v1', rect: [0, 0, 10, 10] }], {
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

/** The same document with a flat outline of `titles`, each pointing at page one. */
function withOutline(bytes: Uint8Array, titles: readonly string[]): Uint8Array {
  const document = reopen(bytes);
  const outlines = document.addObject({ Type: 'Outlines' });
  const items = titles.map((title) =>
    document.addObject({
      Title: document.newString(title),
      Parent: outlines,
      Dest: [document.findPage(0), 'Fit'],
    }),
  );
  items.forEach((item, index) => {
    const previous = items[index - 1];
    const next = items[index + 1];
    if (previous !== undefined) item.put('Prev', previous);
    if (next !== undefined) item.put('Next', next);
  });
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) throw new Error('an outline needs a title');
  outlines.put('First', first);
  outlines.put('Last', last);
  outlines.put('Count', items.length);
  document.getTrailer().get('Root').put('Outlines', outlines);
  return saved(document);
}

/** The same document with page labels in `style` (`r` = lower-case roman numerals). */
function withPageLabels(bytes: Uint8Array, style: string): Uint8Array {
  const document = reopen(bytes);
  document
    .getTrailer()
    .get('Root')
    .put('PageLabels', { Nums: [0, { S: style }] });
  return saved(document);
}

describe('verifyForWrite: what a change is measured as', () => {
  it('reports a change as unverified, not as a promise broken, when the run declared no steps at all', async () => {
    const source = await threePageDocument();
    const document = reopen(source.bytes);
    document.findPage(0).put('CropBox', [10, 10, 390, 490]);
    document.findPage(2).put('Rotate', 180);
    const changed = saved(document);
    const result = await verify(changed, source.bytes, { expectedPageCount: 3 });
    expect(result.operation).toEqual({ kind: 'unverified', steps: [] });
    expect(checkFor(result, 'cropBox')).toEqual({
      fact: 'cropBox',
      verdict: 'degraded',
      reason: 'unverified',
      params: { steps: '', page: 1 },
    });
    expect(checkFor(result, 'rotation')).toEqual({
      fact: 'rotation',
      verdict: 'degraded',
      reason: 'unverified',
      params: { steps: '', page: 3 },
    });
  });

  it('refuses a rotation that an operation which must not turn pages produced', async () => {
    const source = await threePageDocument();
    const document = reopen(source.bytes);
    document.findPage(1).put('Rotate', 90);
    await expect(verify(saved(document), source.bytes, { expectedPageCount: 3, steps: [] })).rejects.toThrow(
      /^\[verification-failed\] pdfjs: rotation: page 2 rotation changed$/,
    );
  });

  it('checks nothing positional without a reference and says so for every positional fact', async () => {
    const source = await threePageDocument();
    const result = await verifyForWrite(source.bytes, { expectedPageCount: 3, steps: [] });
    for (const fact of [
      'rotation',
      'cropBox',
      'pageOrder',
      'pageContent',
      'textContent',
      'outlines',
      'pageLabels',
    ]) {
      expect(checkFor(result, fact), fact).toEqual({ fact, verdict: 'unsupported', reason: 'no-reference' });
    }
    expect(checkFor(result, 'pageCount')?.verdict).toBe('verified');
    expect(result.state).toBe('verified');
  });

  it('refuses with an aborted error, from the model, when the signal fires while the pages are being compared', async () => {
    const source = await threePageDocument();
    const aborted = new AbortController();
    const reference = await openWithPdfjs(source.bytes);
    // The reference answers its first page text and the user cancels at that moment.
    const cancelling: PdfDocumentHandle = {
      ...reference,
      getPageText: async (index) => {
        aborted.abort();
        return await reference.getPageText(index);
      },
    };
    try {
      const failure = await verifyForWrite(source.bytes, {
        expectedPageCount: 3,
        steps: [],
        sourceHandle: cancelling,
        signal: aborted.signal,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ToolError);
      expect(failure).toMatchObject({ code: 'aborted', details: { engine: 'model' } });
    } finally {
      await reference.destroy();
    }
  });

  it('refuses a signal that fired before the file was opened, from the reader', async () => {
    const source = await threePageDocument();
    const aborted = new AbortController();
    aborted.abort();
    const failure = await verifyForWrite(source.bytes, {
      expectedPageCount: 3,
      steps: [],
      signal: aborted.signal,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'aborted', details: { engine: 'pdfjs' } });
  });

  it('treats form fields by what the operation declared: count, values, and an operation it cannot characterise', async () => {
    const source = await threePageDocument();
    const expected = [
      { name: 'fullName', value: 'Ada Lovelace' },
      { name: 'city', value: 'Izmir' },
    ];
    const fields = await withFields(source.bytes, [
      ['fullName', 'Ada Lovelace'],
      ['city', 'Izmir'],
    ]);
    const fewer = await withFields(source.bytes, [['fullName', 'Ada Lovelace']]);
    const retyped = await withChangedValue(fields, 'city', 'Ankara');

    // Creating fields is declared to change the count: reported, not thrown.
    const created = await verify(fewer, fields, {
      expectedPageCount: 3,
      steps: ['form.createField'],
      expectedFormFields: expected,
    });
    expect(checkFor(created, 'formFieldCount')).toEqual({
      fact: 'formFieldCount',
      verdict: 'degraded',
      reason: 'changed',
      params: { count: 1 },
    });
    // A value the operation did not declare is refused, by name and count.
    await expect(
      verify(retyped, fields, { expectedPageCount: 3, steps: [], expectedFormFields: expected }),
    ).rejects.toThrow(/^\[verification-failed\] pdfjs: formFieldValues: 1 field value\(s\) changed$/);
    // The same two facts under an operation nobody characterised degrade to unverified.
    const unknown = await verify(fewer, fields, { expectedPageCount: 3, expectedFormFields: expected });
    expect(checkFor(unknown, 'formFieldCount')).toEqual({
      fact: 'formFieldCount',
      verdict: 'degraded',
      reason: 'unverified',
      params: { steps: '', count: 1 },
    });
    expect(checkFor(unknown, 'formFieldValues')?.verdict).toBe('verified');
    // No inventory to compare with: nothing is claimed.
    const without = await verify(fields, fields, { expectedPageCount: 3, steps: [] });
    expect(checkFor(without, 'formFieldCount')).toEqual({
      fact: 'formFieldCount',
      verdict: 'unsupported',
      reason: 'no-reference',
    });
  });

  it('pairs fields that share a name in order, so two documents merged with the same field name still verify', async () => {
    const source = await threePageDocument();
    // What a merge of two forms that both name a field `name` produces: two fields, one name.
    const merged = await withFields(source.bytes, [
      ['name', 'First value'],
      ['name', 'Second value'],
    ]);
    const expected = [
      { name: 'name', value: 'First value' },
      { name: 'name', value: 'Second value' },
    ];
    const unchanged = await verify(merged, merged, {
      expectedPageCount: 3,
      steps: [],
      expectedFormFields: expected,
    });
    expect(checkFor(unchanged, 'formFieldValues')?.verdict).toBe('verified');
    // A real change to one of the two is still caught.
    const swapped = [
      { name: 'name', value: 'First value' },
      { name: 'name', value: 'Third value' },
    ];
    await expect(
      verify(merged, merged, { expectedPageCount: 3, steps: [], expectedFormFields: swapped }),
    ).rejects.toThrow(/^\[verification-failed\] pdfjs: formFieldValues: 1 field value\(s\) changed$/);
  });

  it('compares outline titles in order: same is verified, a different outline is refused unless declared', async () => {
    const source = await threePageDocument();
    const titled = withOutline(source.bytes, ['Intro', 'Body']);
    const same = await verify(titled, titled, { expectedPageCount: 3, steps: [] });
    expect(checkFor(same, 'outlines')?.verdict).toBe('verified');

    const renamed = withOutline(source.bytes, ['Intro', 'Appendix']);
    await expect(verify(renamed, titled, { expectedPageCount: 3, steps: [] })).rejects.toThrow(
      /^\[verification-failed\] pdfjs: outlines: reference had 2 outline entr\(ies\), output has 2$/,
    );
    const dropped = await verify(source.bytes, titled, { expectedPageCount: 3, steps: ['outline.remove'] });
    expect(checkFor(dropped, 'outlines')).toEqual({
      fact: 'outlines',
      verdict: 'degraded',
      reason: 'changed',
      params: { count: 0 },
    });
    const unknown = await verify(source.bytes, titled, { expectedPageCount: 3 });
    expect(checkFor(unknown, 'outlines')).toEqual({
      fact: 'outlines',
      verdict: 'degraded',
      reason: 'unverified',
      params: { steps: '', count: 0 },
    });
  });

  it('compares page labels: same is verified, a restyled numbering is refused unless declared', async () => {
    const source = await threePageDocument();
    const roman = withPageLabels(source.bytes, 'r');
    const same = await verify(roman, roman, { expectedPageCount: 3, steps: [] });
    expect(checkFor(same, 'pageLabels')?.verdict).toBe('verified');

    const letters = withPageLabels(source.bytes, 'a');
    await expect(verify(letters, roman, { expectedPageCount: 3, steps: [] })).rejects.toThrow(
      /^\[verification-failed\] pdfjs: pageLabels: reference had 3 label\(s\), output has 3$/,
    );
    const declared = await verify(letters, roman, { expectedPageCount: 3, steps: ['labels'] });
    expect(checkFor(declared, 'pageLabels')).toEqual({
      fact: 'pageLabels',
      verdict: 'degraded',
      reason: 'changed',
      params: { count: 3 },
    });
    const none = await verify(source.bytes, roman, { expectedPageCount: 3, steps: ['labels'] });
    expect(checkFor(none, 'pageLabels')).toMatchObject({
      verdict: 'degraded',
      reason: 'changed',
      params: { count: 0 },
    });
  });
});

describe('verifyForWrite: what the reader cannot answer', () => {
  it('says it cannot check geometry or text for a page tree the reader cannot walk, instead of passing it', async () => {
    const source = await threePageDocument();
    const document = reopen(source.bytes);
    const pages = document.getTrailer().get('Root').get('Pages');
    // The tree claims three pages and its third entry is not a page: the third `getPage` throws.
    pages.get('Kids').put(2, 7);
    const damaged = saved(document);
    const result = await verify(damaged, source.bytes, { expectedPageCount: 3, steps: [] });
    for (const fact of ['rotation', 'cropBox', 'pageOrder', 'pageContent', 'textContent']) {
      expect(checkFor(result, fact), fact).toEqual({ fact, verdict: 'unsupported', reason: 'engine-cannot' });
    }
    expect(result.sampledPages).toEqual([]);
  });

  it('sees what the reader sees: a rotation off the quarter turns reads as none, an empty box as a changed box', async () => {
    const source = await threePageDocument(1);
    const odd = reopen(source.bytes);
    odd.findPage(0).put('Rotate', 45);
    const flat = reopen(source.bytes);
    flat.findPage(0).put('MediaBox', [0, 0, 0, 0]);
    flat.findPage(0).put('CropBox', [0, 0, 0, 0]);
    const turned = await verify(saved(odd), source.bytes, { expectedPageCount: 1, steps: [] });
    expect(checkFor(turned, 'rotation')?.verdict).toBe('verified');
    await expect(verify(saved(flat), source.bytes, { expectedPageCount: 1, steps: [] })).rejects.toThrow(
      /^\[verification-failed\] pdfjs: cropBox: page 1 box changed$/,
    );
  });
});

/**
 * A reference handle whose reader fails on one question: the one engine-boundary fault these
 * tests inject. Everything else it answers is the real pdf.js handle's.
 */
function failingReference(
  real: PdfDocumentHandle,
  failure: 'outline' | 'pageLabels' | 'pageText',
): PdfDocumentHandle {
  const raw =
    failure === 'pageLabels'
      ? new Proxy(real.raw, {
          get(target, property) {
            if (property === 'getPageLabels') {
              return async () => {
                throw new Error('the page label tree cannot be read');
              };
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        })
      : real.raw;
  return {
    ...real,
    raw,
    getOutline:
      failure === 'outline'
        ? async () => {
            throw new Error('the outline cannot be read');
          }
        : real.getOutline,
    getPageText:
      failure === 'pageText'
        ? async () => {
            throw new Error('the page text cannot be read');
          }
        : real.getPageText,
  };
}

describe('verifyForWrite: a reference the reader cannot question', () => {
  it.each([
    ['outline', ['outlines']],
    ['pageLabels', ['pageLabels']],
    ['pageText', ['pageOrder', 'pageContent', 'textContent']],
  ] as const)(
    'reports %s as unsupported by the engine and still checks what it can read',
    async (failure, facts) => {
      const source = await threePageDocument();
      const real = await openWithPdfjs(source.bytes);
      try {
        const result = await verifyForWrite(source.bytes, {
          expectedPageCount: 3,
          sourceHandle: failingReference(real, failure),
          steps: [],
        });
        for (const fact of facts) {
          expect(checkFor(result, fact), fact).toEqual({
            fact,
            verdict: 'unsupported',
            reason: 'engine-cannot',
          });
        }
        // Geometry does not depend on the failed question: it is still compared and verified.
        expect(checkFor(result, 'rotation')?.verdict).toBe('verified');
        expect(checkFor(result, 'cropBox')?.verdict).toBe('verified');
      } finally {
        await real.destroy();
      }
    },
  );
});

/** A reference whose reader describes every page with a view box of only three numbers. */
function shortViewReference(real: PdfDocumentHandle): PdfDocumentHandle {
  const bound = (target: object, property: string | symbol): unknown => {
    const value: unknown = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  };
  const raw = new Proxy(real.raw, {
    get(target, property) {
      if (property !== 'getPage') return bound(target, property);
      return async (number: number) => {
        const page = await target.getPage(number);
        return new Proxy(page, {
          get: (pageTarget, pageProperty) =>
            pageProperty === 'view' ? [0, 0, 595] : bound(pageTarget, pageProperty),
        });
      };
    },
  });
  return { ...real, raw };
}

describe('verifyForWrite: a reference whose page boxes are unreadable', () => {
  it('reports rotation and box as unsupported by the engine when a view box is not four numbers', async () => {
    const source = await threePageDocument();
    const real = await openWithPdfjs(source.bytes);
    try {
      const result = await verifyForWrite(source.bytes, {
        expectedPageCount: 3,
        sourceHandle: shortViewReference(real),
        steps: [],
      });
      for (const fact of ['rotation', 'cropBox']) {
        expect(checkFor(result, fact), fact).toEqual({
          fact,
          verdict: 'unsupported',
          reason: 'engine-cannot',
        });
      }
    } finally {
      await real.destroy();
    }
  });
});

describe('verifyForWrite: every fact is answered', () => {
  it.each([
    ['without a reference', { expectedPageCount: 3, steps: [] }],
    ['over the byte budget', { expectedPageCount: 3, steps: [], budgetBytes: 1 }],
    ['against a reference', { expectedPageCount: 3, steps: [], reference: true }],
    ['with expected form fields', { expectedPageCount: 3, steps: [], reference: true, fields: [] }],
  ] as const)('lists every document fact, in report order, %s', async (_label, run) => {
    const source = await threePageDocument();
    const reference = 'reference' in run ? await openWithPdfjs(source.bytes) : undefined;
    try {
      const result = await verifyForWrite(source.bytes, {
        expectedPageCount: run.expectedPageCount,
        steps: run.steps,
        ...('budgetBytes' in run ? { budgetBytes: run.budgetBytes } : {}),
        ...(reference === undefined ? {} : { sourceHandle: reference }),
        ...('fields' in run ? { expectedFormFields: run.fields } : {}),
      });
      expect(result.checks.map((check) => check.fact)).toEqual([...DOCUMENT_FACTS]);
    } finally {
      await reference?.destroy();
    }
  });
});

describe('base bytes and shortcuts', () => {
  it('starts from the bytes of the newest applied operation once there is one', async () => {
    const source = await threePageDocument();
    const { store, handle, context } = await openSession(source.bytes, 3);
    try {
      const next = await applyPageAction(context(), [2], { kind: 'delete' }, SIGNAL);
      const produced = store.active?.working.produced?.bytes;
      expect(produced).toBeDefined();
      // The live handle holds no edits, so the base is what the operation produced, not the master.
      expect(await materializeBase(context())).toBe(produced);
      await next?.destroy();
    } finally {
      await handle.destroy();
    }
  });

  it('mounts a result whose label carries no parameters', async () => {
    const source = await threePageDocument(1);
    const { store, handle, context } = await openSession(source.bytes, 1);
    try {
      const mounted = await applyProducedBytes(
        context(),
        source.bytes,
        1,
        { key: 'pages.moved' },
        'mupdf',
        [],
      );
      expect(store.active?.working.produced?.bytes).toBe(source.bytes);
      await mounted.destroy();
    } finally {
      await handle.destroy();
    }
  });

  it('reports a page that lost its text as unverified, naming the page, for an operation nobody characterised', async () => {
    const wordy = await threePageDocument(3, { 1: 'Bravo page text with plenty more words' });
    const blank = await threePageDocument(3, { 1: '' });
    const result = await verify(blank.bytes, wordy.bytes, { expectedPageCount: 3 });
    expect(checkFor(result, 'textContent')).toEqual({
      fact: 'textContent',
      verdict: 'degraded',
      reason: 'unverified',
      params: { steps: '', page: 2 },
    });
  });

  it('degrades the form checks to the budget when the file is above it', async () => {
    const source = await threePageDocument();
    const fields = await withFields(source.bytes, [['city', 'Izmir']]);
    const result = await verify(fields, fields, {
      expectedPageCount: 3,
      steps: [],
      expectedFormFields: [{ name: 'city', value: 'Izmir' }],
      budgetBytes: 128,
    });
    expect(checkFor(result, 'formFieldCount')).toEqual({
      fact: 'formFieldCount',
      verdict: 'degraded',
      reason: 'budget',
    });
    expect(checkFor(result, 'formFieldValues')).toEqual({
      fact: 'formFieldValues',
      verdict: 'degraded',
      reason: 'budget',
    });
    expect(checkFor(result, 'outlines')).toEqual({ fact: 'outlines', verdict: 'degraded', reason: 'budget' });
    expect(checkFor(result, 'pageLabels')).toEqual({
      fact: 'pageLabels',
      verdict: 'degraded',
      reason: 'budget',
    });
  });
});

describe('materializeBase over a static XFA form', () => {
  const TEMPLATE =
    '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"><subform><field name="Name"><ui><textEdit/></ui></field></subform></subform></template>';
  const DATASETS =
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Old</Name></form1></xfa:data></xfa:datasets>';

  /** A one-field static XFA form: the widget is what a reader edits, the datasets are what XFA reads. */
  function staticXfaForm(widgetValue: string | null): Uint8Array {
    const document = new mupdf.PDFDocument();
    document.insertPage(0, document.addPage([0, 0, 400, 300], 0, {}, ''));
    const page = document.findPage(0);
    const root = document.addObject({ T: document.newString('form1[0]'), Kids: [] });
    const inner = document.addObject({ T: document.newString('#subform[0]'), Parent: root, Kids: [] });
    root.get('Kids').push(inner);
    const name = document.addObject({
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [20, 250, 180, 270],
      P: page,
      F: 4,
      FT: 'Tx',
      T: document.newString('Name[0]'),
      Parent: inner,
      AP: { N: document.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 160, 20] }) },
      ...(widgetValue === null ? {} : { V: document.newString(widgetValue) }),
    });
    inner.get('Kids').push(name);
    page.put('Annots', [name]);
    const form = document.addObject({ Fields: [root] });
    const packets = document.newArray();
    for (const [packet, body] of [
      ['template', TEMPLATE],
      ['datasets', DATASETS],
    ] as const) {
      packets.push(document.newString(packet));
      packets.push(document.addStream(body, document.newDictionary()));
    }
    form.put('XFA', packets);
    document.getTrailer().get('Root').put('AcroForm', form);
    return saved(document);
  }

  function datasetsOf(bytes: Uint8Array): string {
    const document = reopen(bytes);
    try {
      const xfa = document.getTrailer().get('Root').get('AcroForm').resolve().get('XFA').resolve();
      for (let at = 0; at + 1 < xfa.length; at += 2) {
        if (xfa.get(at).asString() === 'datasets') {
          return new TextDecoder().decode(
            xfa
              .get(at + 1)
              .readStream()
              .asUint8Array(),
          );
        }
      }
      throw new Error('the form has no datasets packet');
    } finally {
      document.destroy();
    }
  }

  it('brings the XFA datasets in step with the value the engine save wrote, and journals that step', async () => {
    const master = staticXfaForm(null);
    const engineSaved = staticXfaForm('Ada Lovelace');
    expect(datasetsOf(engineSaved)).toContain('<Name>Old</Name>');
    const live = await engineSaveHandle(master, engineSaved);
    try {
      const store = new SessionStore();
      const tab = store.openDocument({ name: 'xfa.pdf', bytes: master, sha256: 'xfa', pageCount: 1 });
      const steps: SaveStepDescription[] = [];
      const bytes = await materializeBase({ store, t: createTranslator(), tab, handle: live }, SIGNAL, steps);
      expect(datasetsOf(bytes)).toContain('<Name>Ada Lovelace</Name>');
      expect(steps.map((step) => step.id)).toEqual(['pdfjs.saveDocument', 'xfa.datasets']);
      expect(steps[1]).toMatchObject({ engine: 'mupdf', note: 'static XFA data kept in step' });
    } finally {
      await live.destroy();
    }
  });
});
