/**
 * The batch runner against real bytes. The wrong answers that matter: `'all'` resolved
 * against the wrong document, a password-locked item that stops the whole run instead of
 * failing on its own, a step order that does not follow the dependency rule, a template
 * that gets past the validator, and a cancellation that loses the files already finished.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LIMITS, ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_STEP_KINDS,
  BATCH_TEMPLATE_VERSION,
  type BatchProgress,
  type BatchRuleSet,
  type BatchStep,
  MAX_BATCH_ITEMS,
  parseRuleSet,
  planBatch,
  runBatch,
  serializeRuleSet,
  validateRuleSet,
} from './batch';
import { ALL_PERMISSIONS } from './security';

function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

async function pages(count: number, options = ''): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (let index = 0; index < count; index += 1)
    doc.insertPage(index, doc.addPage([0, 0, 300, 400], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer(options).asUint8Array());
  doc.destroy();
  return bytes;
}

/** Pages that each carry one word of text. */
async function words(...list: readonly string[]): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
  for (const [index, word] of list.entries()) {
    doc.insertPage(
      index,
      doc.addPage([0, 0, 300, 400], 0, { Font: { F: font } }, `BT /F 18 Tf 40 300 Td (${word}) Tj ET`),
    );
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** One page drawing a red image `/Flat` (4x2 RGB, written by hand) and a black one, `/Dark`. */
async function imagePage(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const image = { Type: 'XObject', Subtype: 'Image', BitsPerComponent: 8, ColorSpace: 'DeviceRGB' };
  const red = new Uint8Array(4 * 2 * 3).map((_value, index) => (index % 3 === 0 ? 255 : 0));
  const flat = doc.addStream(red, { ...image, Width: 4, Height: 2 });
  const dark = doc.addStream(new Uint8Array(4 * 2 * 3), { ...image, Width: 4, Height: 2 });
  doc.insertPage(
    0,
    doc.addPage(
      [0, 0, 200, 100],
      0,
      { XObject: { Flat: flat, Dark: dark } },
      'q 80 0 0 80 10 10 cm /Flat Do Q q 80 0 0 80 110 10 cm /Dark Do Q',
    ),
  );
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

/** RGB at a point of page 1, rendered at 72 dpi. */
async function rgbAt(bytes: Uint8Array, x: number, y: number): Promise<number[]> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false);
    const at = (y * pixmap.getWidth() + x) * 3;
    return Array.from(pixmap.getPixels().slice(at, at + 3));
  } finally {
    doc.destroy();
  }
}

/** Every page's extracted text. */
async function texts(bytes: Uint8Array): Promise<string[]> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return Array.from({ length: doc.countPages() }, (_unused, index) =>
      doc.loadPage(index).toStructuredText('').asText().trim(),
    );
  } finally {
    doc.destroy();
  }
}

/** Page count and `/Rotate` of every page. */
async function shape(bytes: Uint8Array): Promise<{ count: number; rotations: number[] }> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return {
      count: doc.countPages(),
      rotations: Array.from({ length: doc.countPages() }, (_unused, index) =>
        doc.findPage(index).getInheritable('Rotate').asNumber(),
      ),
    };
  } finally {
    doc.destroy();
  }
}

const run = { signal: new AbortController().signal };

const bates = (pagesOf: 'all' | readonly number[]): BatchStep => ({
  kind: 'stamp',
  params: {
    kind: 'bates',
    pages: pagesOf,
    anchor: 'bottom-right',
    prefix: 'NO-',
    startAt: 1,
    digits: 3,
    fontSize: 10,
    marginMm: 10,
  },
});

const numbering: BatchRuleSet = { version: 1, name: 'numara', steps: [bates('all')] };

const ruleSetOf = (...steps: BatchStep[]): BatchRuleSet => ({ version: 1, name: 'test', steps });

/** Runs one item and returns its only result. */
async function runOne(bytes: Uint8Array, ...steps: BatchStep[]) {
  const report = await runBatch([{ name: 'a.pdf', bytes }], ruleSetOf(...steps), run);
  const [result] = report.results;
  if (result === undefined) throw new Error('no result');
  return { report, result };
}

function done(result: Awaited<ReturnType<typeof runOne>>['result']) {
  if (result.status !== 'done') throw new Error(`item did not finish: ${JSON.stringify(result)}`);
  return result;
}

describe('validateRuleSet', () => {
  const step = { kind: 'compress', params: { mode: 'structure', stripMetadata: false, keepProducer: true } };
  const invalid = (ruleSet: unknown) => () => validateRuleSet(ruleSet as BatchRuleSet);

  it('returns the schema version, the name and every parsed step', () => {
    const result = validateRuleSet({ version: 1, name: 'rapor', steps: [step] } as BatchRuleSet);
    expect(result).toEqual({ version: BATCH_TEMPLATE_VERSION, name: 'rapor', steps: [step] });
    expect(validateRuleSet({ version: 1, name: 5, steps: [step] } as unknown as BatchRuleSet).name).toBe('');
  });

  it.each([
    ['a string version', '1'],
    ['a fractional version', 1.5],
    ['a missing version', undefined],
  ])('refuses %s as unsupported-format at "version"', (_name, version) => {
    expect(invalid({ version, name: 'x', steps: [step] })).toThrow(
      expect.objectContaining({
        code: 'unsupported-format',
        details: expect.objectContaining({ path: 'version' }),
      }),
    );
  });

  it('refuses another schema version as unsupported and names both versions', () => {
    expect(invalid({ version: 2, name: 'x', steps: [step] })).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        details: expect.objectContaining({
          path: 'version',
          engineMessage: expect.stringContaining('version 2 is not the 1'),
        }),
      }),
    );
  });

  it('refuses steps that are not an array, and an empty array', () => {
    expect(invalid({ version: 1, name: 'x', steps: 'compress' })).toThrow(
      expect.objectContaining({
        code: 'unsupported-format',
        details: expect.objectContaining({ path: 'steps' }),
      }),
    );
    expect(invalid({ version: 1, name: 'x', steps: [] })).toThrow(
      expect.objectContaining({
        code: 'selection-empty',
        details: expect.objectContaining({ path: 'steps' }),
      }),
    );
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'compress'],
  ])('refuses a step that is %s, naming its position', (_name, entry) => {
    expect(invalid({ version: 1, name: 'x', steps: [step, entry] })).toThrow(
      expect.objectContaining({
        code: 'unsupported-format',
        details: expect.objectContaining({ path: 'steps[1]' }),
      }),
    );
  });

  it('refuses a step without a kind and a step with an unknown kind, naming the kind', () => {
    expect(invalid({ version: 1, name: 'x', steps: [{ params: {} }] })).toThrow(
      expect.objectContaining({
        code: 'unsupported-format',
        details: expect.objectContaining({ path: 'steps[0].kind' }),
      }),
    );
    expect(invalid({ version: 1, name: 'x', steps: [{ kind: 'shred', params: {} }] })).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        details: expect.objectContaining({
          path: 'steps[0].kind',
          engineMessage: `unknown step kind "shred" (this build knows ${BATCH_STEP_KINDS.join(', ')})`,
        }),
      }),
    );
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('refuses params that are %s', (_name, params) => {
    expect(invalid({ version: 1, name: 'x', steps: [{ kind: 'compress', params }] })).toThrow(
      expect.objectContaining({
        code: 'unsupported-format',
        details: expect.objectContaining({
          path: 'steps[0].params',
          engineMessage: 'the "compress" step has no params object',
        }),
      }),
    );
  });
});

describe('serializeRuleSet and parseRuleSet', () => {
  const metadata: BatchStep = {
    kind: 'metadata',
    params: {
      patch: { title: 'Özet', keywords: ['a', 'b'], writeXmp: false },
      clean: false,
      cleanXmp: false,
    },
  };

  it('writes a template that parses back to the same rule set', () => {
    const json = serializeRuleSet({ version: 1, name: 'rapor', steps: [metadata, bates([0, 2])] });
    expect(json.endsWith('}\n')).toBe(true);
    expect(JSON.parse(json)).toMatchObject({ version: 1, name: 'rapor' });
    expect(parseRuleSet(json)).toEqual({ version: 1, name: 'rapor', steps: [metadata, bates([0, 2])] });
  });

  it('refuses to write a step that carries raw pixels, naming the offending path', () => {
    const replace: BatchStep = {
      kind: 'image',
      params: {
        action: 'replace',
        replacements: [{ pageIndex: 0, name: 'Im1', data: new Uint8Array([1, 2, 3]), format: 'jpeg' }],
      },
    };
    expect(() => serializeRuleSet(ruleSetOf(metadata, replace))).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        details: expect.objectContaining({
          path: 'steps[1].params.replacements[0].data',
          engineMessage: expect.stringContaining('holds raw image bytes'),
        }),
      }),
    );
  });

  it('refuses to write a rule set the validator refuses', () => {
    expect(() => serializeRuleSet({ version: 1, name: 'x', steps: [] })).toThrow(
      expect.objectContaining({ code: 'selection-empty' }),
    );
  });

  it.each([
    ['text that is not JSON', '{nope', 'unsupported-format', 'template'],
    ['an array', '[]', 'unsupported-format', 'template'],
    ['null', 'null', 'unsupported-format', 'template'],
    ['a number', '3', 'unsupported-format', 'template'],
    ['another version', '{"version":2,"steps":[]}', 'unsupported', 'version'],
    ['a missing version', '{"steps":[]}', 'unsupported', 'version'],
    ['no steps array', '{"version":1,"steps":{}}', 'unsupported-format', 'steps'],
    ['an empty steps array', '{"version":1,"steps":[]}', 'selection-empty', 'steps'],
    [
      'a step of an unknown kind',
      '{"version":1,"steps":[{"kind":"zap","params":{}}]}',
      'unsupported',
      'steps[0].kind',
    ],
  ])('refuses a template that is %s', (_name, json, code, path) => {
    expect(() => parseRuleSet(json)).toThrow(
      expect.objectContaining({ code, details: expect.objectContaining({ path }) }),
    );
  });

  it('names the JSON parser error, and reads a template without a name as unnamed', () => {
    expect(() => parseRuleSet('{nope')).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          engineMessage: expect.stringContaining('the template is not valid JSON: '),
        }),
      }),
    );
    const step =
      '{"kind":"compress","params":{"mode":"structure","stripMetadata":false,"keepProducer":true}}';
    expect(parseRuleSet(`{"version":1,"steps":[${step}]}`).name).toBe('');
    expect(parseRuleSet(`{"version":1,"name":7,"steps":[${step}]}`).name).toBe('');
  });
});

describe('planBatch', () => {
  const kinds = (steps: readonly BatchStep[]) => planBatch(steps).steps.map((entry) => entry.kind);
  const generic = (kind: BatchStep['kind']) => ({ kind, params: {} }) as unknown as BatchStep;

  it('keeps an author-ordered rule set exactly as written', () => {
    const plan = planBatch([generic('pages'), generic('compress'), generic('stamp'), generic('protect')]);
    expect(plan.reordered).toBe(false);
    expect(plan.steps.map((entry) => entry.kind)).toEqual(['pages', 'compress', 'stamp', 'protect']);
  });

  it('orders every kind by the dependency rule and reports the reshuffle', () => {
    const declared = [...BATCH_STEP_KINDS].reverse().map(generic);
    const plan = planBatch(declared);
    expect(plan.reordered).toBe(true);
    expect(plan.steps.map((entry) => entry.kind)).toEqual([
      'pages',
      'compress',
      'ocr',
      'page-labels',
      'image',
      'stamp',
      'metadata',
      'text-export',
      'protect',
    ]);
  });

  it('keeps the author order inside one phase', () => {
    expect(kinds([generic('stamp'), generic('image'), generic('pages')])).toEqual([
      'pages',
      'stamp',
      'image',
    ]);
    expect(kinds([generic('image'), generic('stamp')])).toEqual(['image', 'stamp']);
  });
});

describe('runBatch', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves "all" per item and fails a password-locked item on its own', async () => {
    const report = await runBatch(
      [
        { name: 'iki.pdf', bytes: await pages(2) },
        { name: 'kilitli.pdf', bytes: await pages(1, 'encrypt=aes-256,user-password=x,owner-password=y') },
        { name: 'bir.pdf', bytes: await pages(1) },
      ],
      numbering,
      { signal: new AbortController().signal },
    );
    expect(report.completed).toEqual(['iki.pdf', 'bir.pdf']);
    expect(report.failed).toEqual(['kilitli.pdf']);
    const [first, locked, last] = report.results;
    expect(locked).toMatchObject({ status: 'failed', code: 'encrypted-unsupported' });
    if (first?.status !== 'done' || last?.status !== 'done') throw new Error('items did not finish');
    expect(await texts(first.bytes)).toEqual(['NO-001', 'NO-002']);
    expect(await texts(last.bytes)).toEqual(['NO-001']);
  });

  it('reports the run: rule set, order, per-step results and the byte counts of the item', async () => {
    const input = await pages(2);
    const { report, result } = await runOne(input, bates('all'), {
      kind: 'pages',
      params: { pages: [1, 0] },
    });
    expect(report).toMatchObject({
      ruleSet: { name: 'test', version: 1 },
      cancelled: false,
      totalItems: 1,
      completed: ['a.pdf'],
      failed: [],
      skipped: [],
      order: ['pages', 'stamp'],
      reordered: true,
    });
    const item = done(result);
    expect(item).toMatchObject({
      name: 'a.pdf',
      pageCount: 2,
      inputBytes: input.length,
      outputBytes: item.bytes.length,
      extras: [],
    });
    expect(item.steps.map((entry) => entry.kind)).toEqual(['pages', 'stamp']);
    expect(item.steps[0]?.files).toEqual([]);
    expect(item.steps[1]?.notes).toEqual(item.steps[1]?.report?.notes);
    expect(await texts(item.bytes)).toEqual(['NO-001', 'NO-002']);
  });

  it('refuses an empty queue, an oversized queue and a rule set the validator refuses, before any work', async () => {
    await expect(runBatch([], numbering, run)).rejects.toMatchObject({ code: 'input-missing' });
    const bytes = await pages(1);
    const crowd = Array.from({ length: MAX_BATCH_ITEMS + 1 }, (_unused, index) => ({
      name: `${index}.pdf`,
      bytes,
    }));
    await expect(runBatch(crowd, numbering, run)).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: `257 files in one run; the bound is ${MAX_BATCH_ITEMS}` },
    });
    await expect(
      runBatch([{ name: 'a.pdf', bytes }], { version: 1, name: 'x', steps: [] }, run),
    ).rejects.toMatchObject({ code: 'selection-empty' });
  });

  it('fails an item over the document ceiling as file-too-large without running a step', async () => {
    const huge = new Uint8Array(LIMITS.desktop.maxBytes + 1);
    const report = await runBatch(
      [
        { name: 'huge.pdf', bytes: huge },
        { name: 'ok.pdf', bytes: await pages(1) },
      ],
      numbering,
      run,
    );
    expect(report.results[0]).toEqual({
      status: 'failed',
      name: 'huge.pdf',
      inputBytes: huge.length,
      code: 'file-too-large',
      messageKey: 'error.file-too-large.message',
      hintKey: 'error.file-too-large.hint',
      detail: `item is ${huge.length} bytes, the ceiling is ${LIMITS.desktop.maxBytes}`,
      step: null,
      stepIndex: null,
    });
    expect(report.completed).toEqual(['ok.pdf']);
  });

  it('captures a failing step with its kind, position and the engine message, and goes on', async () => {
    const report = await runBatch(
      [
        { name: 'short.pdf', bytes: await pages(1) },
        { name: 'long.pdf', bytes: await pages(3) },
      ],
      ruleSetOf(bates([2])),
      run,
    );
    expect(report.results[0]).toMatchObject({
      status: 'failed',
      name: 'short.pdf',
      code: 'range-invalid',
      step: 'stamp',
      stepIndex: 0,
      messageKey: 'error.range-invalid.message',
      hintKey: 'error.range-invalid.hint',
      detail: 'stamp.pages names page 2 of a 1-page document',
    });
    expect(report.completed).toEqual(['long.pdf']);
  });

  it('reports a step failure that carries no engine message as a null detail', async () => {
    const report = await runBatch([{ name: 'a.pdf', bytes: await pages(1) }], numbering, {
      signal: run.signal,
      onProgress: (event) => {
        if (event.operation !== null) throw new ToolError('internal', { engine: 'ui' });
      },
    });
    expect(report.results[0]).toMatchObject({
      status: 'failed',
      code: 'internal',
      step: 'stamp',
      stepIndex: 0,
      detail: null,
    });
  });

  it('measures the page count once and then trusts each step report for the next "all"', async () => {
    const input = await pages(2);
    const { result } = await runOne(
      input,
      { kind: 'pages', params: { pages: [0, 0, 1] } },
      { kind: 'compress', params: { mode: 'structure', stripMetadata: false, keepProducer: true } },
      bates('all'),
    );
    const item = done(result);
    expect(item.pageCount).toBe(3);
    expect(await texts(item.bytes)).toEqual(['NO-001', 'NO-002', 'NO-003']);
  });

  it('applies a pages step with rotations and repeated pages through the composition path', async () => {
    const input = await words('one', 'two', 'three');
    const { result } = await runOne(input, {
      kind: 'pages',
      params: { pages: [2, 0, 0], rotations: { 0: 90, 2: 180 } },
    });
    const item = done(result);
    expect(await texts(item.bytes)).toEqual(['three', 'one', 'one']);
    expect(await shape(item.bytes)).toEqual({ count: 3, rotations: [90, 0, 180] });
    expect(item.pageCount).toBe(3);

    const kept = done((await runOne(input, { kind: 'pages', params: { pages: 'all' } })).result);
    expect(await texts(kept.bytes)).toEqual(['one', 'two', 'three']);
  });

  it('refuses a pages step that names a page the item lacks, as that item only', async () => {
    const { result } = await runOne(await pages(2), { kind: 'pages', params: { pages: [0, 5] } });
    expect(result).toMatchObject({
      status: 'failed',
      code: 'range-invalid',
      step: 'pages',
      detail: 'pages names page 5 of a 2-page document',
    });
  });

  it.each([
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative index', -1],
    ['a fraction', 0.5],
  ])('refuses %s as a page index', async (_name, page) => {
    const { result } = await runOne(await pages(2), bates([page]));
    expect(result).toMatchObject({ status: 'failed', code: 'range-invalid', step: 'stamp' });
  });

  it('runs a structure compression and reports its own notes', async () => {
    const { result } = await runOne(await words('a', 'b'), {
      kind: 'compress',
      params: { mode: 'structure', stripMetadata: true, keepProducer: true },
    });
    const item = done(result);
    expect(item.steps[0]?.report?.notes.map((entry) => entry.key)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^optimize\./)]),
    );
    expect(await texts(item.bytes)).toEqual(['a', 'b']);
  });

  it('resolves the page scope of a raster compression before the engine renders', async () => {
    // Rendering needs a canvas, which Node lacks, so both runs stop before it: one at the
    // batch's own page check, one at the operation's option check after "all" was resolved.
    const raster = (pagesOf: 'all' | readonly number[]): BatchStep => ({
      kind: 'compress',
      params: { mode: 'raster', pages: pagesOf, dpi: 10, quality: 0.5, greyscale: false },
    });
    const outside = await runOne(await pages(2), raster([7]));
    expect(outside.result).toMatchObject({
      status: 'failed',
      step: 'compress',
      code: 'range-invalid',
      detail: 'compress.pages names page 7 of a 2-page document',
    });
    const all = await runOne(await pages(2), raster('all'));
    expect(all.result).toMatchObject({
      status: 'failed',
      step: 'compress',
      code: 'range-invalid',
      detail: 'dpi must be between 72 and 300',
    });
  });

  it('resolves the page scope of an OCR step before the operation validates its options', async () => {
    const { result } = await runOne(await pages(2), {
      kind: 'ocr',
      params: { pages: 'all', languages: [], quality: 'fast', dpi: 200, existingText: 'skip' },
    });
    expect(result).toMatchObject({ status: 'failed', step: 'ocr', code: 'unsupported' });
    const wrongPage = await runOne(await pages(2), {
      kind: 'ocr',
      params: { pages: [4], languages: ['eng'], quality: 'fast', dpi: 200, existingText: 'skip' },
    });
    expect(wrongPage.result).toMatchObject({ status: 'failed', step: 'ocr', code: 'range-invalid' });
  });

  it('writes page labels, metadata and protection as ordered steps on the same bytes', async () => {
    const { result } = await runOne(
      await pages(2),
      {
        kind: 'protect',
        params: { userPassword: 'gizli', ownerPassword: 'sahip', permissions: ALL_PERMISSIONS },
      },
      {
        kind: 'metadata',
        params: { patch: { title: 'Rapor', writeXmp: false }, clean: false, cleanXmp: false },
      },
      {
        kind: 'page-labels',
        params: { ranges: [{ startPage: 0, style: 'roman-upper', prefix: '', start: 1 }] },
      },
    );
    const item = done(result);
    expect(item.steps.map((entry) => entry.kind)).toEqual(['page-labels', 'metadata', 'protect']);
    const mupdf = await import('mupdf');
    const locked = mupdf.PDFDocument.openDocument(item.bytes.slice(), 'application/pdf');
    expect(locked.needsPassword()).toBe(true);
    expect(locked.authenticatePassword('gizli')).toBeGreaterThan(0);
    expect(locked.getMetaData('info:Title')).toBe('Rapor');
    const labels = locked.asPDF()?.getTrailer().get('Root').get('PageLabels').get('Nums');
    expect(labels?.length).toBe(2);
    expect(labels?.get(1).get('S').asName()).toBe('R');
    locked.destroy();
  });

  it('fades the named images one write each and folds them into one report', async () => {
    const input = await imagePage();
    expect(await rgbAt(input, 50, 50)).toEqual([255, 0, 0]);
    const { result } = await runOne(input, {
      kind: 'image',
      params: {
        action: 'opacity',
        targets: [
          { pageIndex: 0, name: 'Flat', opacity: 0.5 },
          { pageIndex: 0, name: 'Dark', opacity: 0.5 },
        ],
      },
    });
    const item = done(result);
    const report = item.steps[0]?.report;
    expect(report?.engine).toBe('mupdf');
    expect(report?.incremental).toBe(false);
    expect(report?.steps.some((entry) => entry.startsWith('image[0].'))).toBe(true);
    expect(report?.steps.some((entry) => entry.startsWith('image[1].'))).toBe(true);
    expect(report?.inputBytes).toBe(input.length);
    expect(report?.outputBytes).toBe(item.bytes.length);
    expect(report?.pageCount).toBe(1);
    const [red, green, blue] = await rgbAt(item.bytes, 50, 50);
    expect([red, Math.abs((green ?? 0) - 128) <= 2, Math.abs((blue ?? 0) - 128) <= 2]).toEqual([
      255,
      true,
      true,
    ]);
    expect(Math.abs(((await rgbAt(item.bytes, 150, 50))[0] ?? 0) - 128)).toBeLessThanOrEqual(2);
  });

  it('refuses an opacity step that names no image', async () => {
    const { result } = await runOne(await imagePage(), {
      kind: 'image',
      params: { action: 'opacity', targets: [] },
    });
    expect(result).toMatchObject({
      status: 'failed',
      step: 'image',
      code: 'selection-empty',
      detail: 'the opacity step names no image',
    });
  });

  it('replaces an image with encoded pixels, honouring dropMask when given', async () => {
    const mupdf = await import('mupdf');
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
    const pixels = pixmap.getPixels();
    for (let at = 0; at < pixels.length; at += 3) pixels.set([0, 0, 255], at);
    const data = new Uint8Array(pixmap.asJPEG(90));
    const input = await imagePage();
    const replacements = [{ pageIndex: 0, name: 'Flat', data, format: 'jpeg' as const }];
    for (const dropMask of [undefined, false]) {
      const { result } = await runOne(input, {
        kind: 'image',
        params: { action: 'replace', replacements, ...(dropMask === undefined ? {} : { dropMask }) },
      });
      const [red, , blue] = await rgbAt(done(result).bytes, 50, 50);
      expect([(red ?? 255) < 60, (blue ?? 0) > 200]).toEqual([true, true]);
    }
  });

  it('exports text as a file named after the item, leaving the document untouched', async () => {
    const input = await words('Alpha', 'Bravo');
    const report = await runBatch(
      [
        { name: 'rapor.v2.pdf', bytes: input },
        { name: 'ikinci.pdf', bytes: input },
      ],
      ruleSetOf({ kind: 'text-export', params: { pages: 'all', format: 'text', baseName: 'cikti' } }),
      run,
    );
    const [first, second] = report.results.map(done);
    expect(first?.extras.map((file) => file.name)).toEqual(['rapor.v2-cikti.txt']);
    expect(second?.extras.map((file) => file.name)).toEqual(['ikinci-cikti.txt']);
    expect(new TextDecoder().decode(first?.extras[0]?.bytes)).toBe('Alpha\n\n----- 2 -----\n\nBravo\n');
    expect(first?.bytes).toBe(input);
    expect(first?.steps[0]).toMatchObject({
      kind: 'text-export',
      files: [{ name: 'cikti.txt' }],
      report: {
        engine: 'pdfjs',
        steps: ['extract-text'],
        pageCount: 2,
        incremental: true,
        inputBytes: input.length,
        outputBytes: input.length,
      },
    });
    expect(first?.steps[0]?.notes.map((entry) => entry.key)).toEqual([
      'export.text.covered',
      'export.text.done',
    ]);
  });

  it('keeps the page count of the document when a text export covers only some pages', async () => {
    const input = await words('one', 'two', 'three');
    const { result } = await runOne(input, {
      kind: 'text-export',
      params: { pages: [0], format: 'text', baseName: 'ilk' },
    });
    const item = done(result);
    expect(item.pageCount).toBe(3);
    expect(item.steps[0]?.report.pageCount).toBe(3);
  });

  it('says a text export found nothing when the pages carry no text', async () => {
    const { result } = await runOne(await pages(1), {
      kind: 'text-export',
      params: { pages: [0], format: 'markdown', baseName: 'bos' },
    });
    const item = done(result);
    expect(item.steps[0]?.notes.map((entry) => entry.key)).toEqual(['export.text.empty']);
    expect(item.extras.map((file) => file.name)).toEqual(['a-bos.md']);
  });

  it('refuses a text export that selects no page', async () => {
    const empty = await runOne(await pages(1), {
      kind: 'text-export',
      params: { pages: [], format: 'text', baseName: 'x' },
    });
    expect(empty.result).toMatchObject({
      status: 'failed',
      step: 'text-export',
      code: 'selection-empty',
      detail: 'the text export names no page',
    });
    const noPages = await runOne(await pages(0), {
      kind: 'text-export',
      params: { pages: 'all', format: 'text', baseName: 'x' },
    });
    expect(noPages.result).toMatchObject({ status: 'failed', code: 'selection-empty' });
  });

  it('reports the item start and every operation step through onProgress', async () => {
    const events: BatchProgress[] = [];
    await runBatch(
      [
        { name: 'a.pdf', bytes: await pages(1) },
        { name: 'b.pdf', bytes: await pages(1) },
      ],
      numbering,
      { signal: run.signal, onProgress: (event) => events.push(event) },
    );
    const starts = events.filter((event) => event.operation === null);
    expect(starts).toMatchObject([
      { itemIndex: 0, itemName: 'a.pdf', doneItems: 0, totalItems: 2, stepIndex: 0, step: 'stamp' },
      { itemIndex: 1, itemName: 'b.pdf', doneItems: 1, totalItems: 2, stepIndex: 0, step: 'stamp' },
    ]);
    const operation = events.filter((event) => event.operation !== null && event.itemIndex === 1);
    expect(operation.length).toBeGreaterThan(0);
    expect(operation[0]).toMatchObject({
      itemName: 'b.pdf',
      doneItems: 1,
      totalItems: 2,
      stepIndex: 0,
      step: 'stamp',
    });
  });

  it('skips every item as not-started when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const report = await runBatch(
      [
        { name: 'a.pdf', bytes: await pages(1) },
        { name: 'b.pdf', bytes: await pages(1) },
      ],
      numbering,
      { signal: controller.signal },
    );
    expect(report).toMatchObject({
      cancelled: true,
      completed: [],
      failed: [],
      skipped: ['a.pdf', 'b.pdf'],
      results: [
        { status: 'skipped', name: 'a.pdf', reason: 'not-started' },
        { status: 'skipped', name: 'b.pdf', reason: 'not-started' },
      ],
    });
  });

  it('drops the item whose start event aborted, and marks the rest not-started', async () => {
    const controller = new AbortController();
    const report = await runBatch(
      [
        { name: 'a.pdf', bytes: await pages(1) },
        { name: 'b.pdf', bytes: await pages(1) },
      ],
      numbering,
      {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.itemIndex === 1 && event.operation === null) controller.abort();
        },
      },
    );
    expect(report.cancelled).toBe(true);
    expect(report.completed).toEqual(['a.pdf']);
    expect(report.results[1]).toEqual({ status: 'skipped', name: 'b.pdf', reason: 'cancelled' });
  });

  it('keeps the finished files when the user cancels in the middle of a step, even if the engine threw another error', async () => {
    const controller = new AbortController();
    const report = await runBatch(
      [
        { name: 'a.pdf', bytes: await pages(1) },
        { name: 'b.pdf', bytes: await pages(1) },
        { name: 'c.pdf', bytes: await pages(1) },
      ],
      numbering,
      {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.itemIndex === 1 && event.operation !== null) controller.abort();
        },
      },
    );
    expect(report.cancelled).toBe(true);
    expect(report.completed).toEqual(['a.pdf']);
    expect(report.failed).toEqual([]);
    expect(report.results.map((entry) => (entry.status === 'skipped' ? entry.reason : entry.status))).toEqual(
      ['done', 'cancelled', 'not-started'],
    );
  });

  it('fails a locked item on a page-scoped step with the engine code, not a guess', async () => {
    const locked = await pages(1, 'encrypt=aes-256,user-password=x,owner-password=y');
    const { result } = await runOne(locked, {
      kind: 'text-export',
      params: { pages: 'all', format: 'text', baseName: 'x' },
    });
    expect(result).toMatchObject({ status: 'failed', step: 'text-export', code: 'encrypted-unsupported' });
  });
});
