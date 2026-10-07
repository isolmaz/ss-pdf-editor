/**
 * `ocrDocument` against real PDFs, with the two parts a Node unit run cannot have replaced at
 * their own boundary: the page raster (pdf.js renders onto a canvas, and there is no canvas
 * here, so `render` answers instead and the canvas is a stand-in) and the recognition engine
 * (`recognizePage`, scripted per page). Everything else is real: the PDF, the pdf.js
 * text detection and viewport, the option checks, the report, and the text layer MuPDF writes
 * and these tests read back.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Font, PDFDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrWord, RecognizeInput, RecognizeResult } from '../engines/tesseract';
import type { OperationProgress } from './types';

interface Script {
  /** What `recognizePage` answers per call, in order. */
  results: RecognizeResult[];
  inputs: RecognizeInput[];
  /** Runs inside `recognizePage`, before it answers. */
  during?: (input: RecognizeInput) => void;
  available: boolean | ((language: string, quality: string) => boolean);
  probes: Array<[string, string]>;
  /** How the fake page's `render` ends. */
  render: 'ok' | 'fail' | 'fail-text' | 'hang';
  /** `destroy` of the pdf.js handle rejects. */
  destroyFails: boolean;
  cancelled: number;
  renders: Array<{ width: number; height: number }>;
}
const script: Script = {
  results: [],
  inputs: [],
  available: true,
  probes: [],
  render: 'ok',
  destroyFails: false,
  cancelled: 0,
  renders: [],
};

vi.mock('../engines/tesseract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/tesseract')>();
  return {
    ...actual,
    isOcrLanguageAvailable: async (language: string, quality: string) => {
      script.probes.push([language, quality]);
      return typeof script.available === 'function' ? script.available(language, quality) : script.available;
    },
    recognizePage: async (input: RecognizeInput) => {
      script.inputs.push(input);
      input.onProgress?.(0.5);
      script.during?.(input);
      const next = script.results.shift();
      if (next === undefined) throw new Error('no scripted recognition left');
      return next;
    },
  };
});

vi.mock('../engines/pdfjs-handle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/pdfjs-handle')>();
  return {
    ...actual,
    openWithPdfjs: async (...args: Parameters<typeof actual.openWithPdfjs>) => {
      const handle = await actual.openWithPdfjs(...args);
      const raw = new Proxy(handle.raw, {
        get(target, property) {
          if (property !== 'getPage') {
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return async (number: number) => {
            const page = await target.getPage(number);
            return new Proxy(page, {
              get(pageTarget, pageProperty) {
                if (pageProperty === 'render') {
                  return (parameters: { viewport: { width: number; height: number } }) => {
                    script.renders.push({
                      width: parameters.viewport.width,
                      height: parameters.viewport.height,
                    });
                    let reject: (reason: unknown) => void = () => undefined;
                    const promise = new Promise<void>((resolve, fail) => {
                      reject = fail;
                      if (script.render === 'ok') resolve();
                      if (script.render === 'fail') fail(new Error('render exploded'));
                      if (script.render === 'fail-text') fail('render exploded as text');
                    });
                    return {
                      promise,
                      cancel: () => {
                        script.cancelled += 1;
                        reject(new Error('render cancelled'));
                      },
                    };
                  };
                }
                const value: unknown = Reflect.get(pageTarget, pageProperty, pageTarget);
                return typeof value === 'function' ? value.bind(pageTarget) : value;
              },
            });
          };
        },
      });
      const destroy = async () => {
        await handle.destroy();
        if (script.destroyFails) throw new Error('destroy failed');
      };
      return { ...handle, raw, destroy };
    },
  };
});

const { detectScannedPages, ocrDocument, visualOrder, writeOcrLayer } = await import('./ocr');

const run = { signal: new AbortController().signal };

/** Three pages: 0 carries the text "Merhaba", 1 and 2 are blank scans. */
function document(): Uint8Array {
  const doc = new PDFDocument();
  const font = doc.addSimpleFont(new Font('Helvetica'));
  doc.insertPage(
    0,
    doc.addPage([0, 0, 300, 400], 0, { Font: { F1: font } }, 'BT /F1 18 Tf 20 300 Td (Merhaba) Tj ET'),
  );
  doc.insertPage(1, doc.addPage([0, 0, 300, 400], 0, {}, ''));
  doc.insertPage(2, doc.addPage([0, 0, 300, 400], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function word(text: string, x0: number, y0: number, x1: number, y1: number): OcrWord {
  return { text, x0, y0, x1, y1, confidence: 90 };
}

function options(
  overrides: Partial<Parameters<typeof ocrDocument>[1]> = {},
): Parameters<typeof ocrDocument>[1] {
  return { pages: [1], languages: ['tur'], quality: 'fast', dpi: 216, existingText: 'skip', ...overrides };
}

async function failureOf(task: Promise<unknown>): Promise<ToolError> {
  try {
    await task;
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

/** The words MuPDF extracts from a page. */
function textOf(bytes: Uint8Array, pageIndex: number): string {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return doc.loadPage(pageIndex).toStructuredText('preserve-whitespace').asText().trim();
  } finally {
    doc.destroy();
  }
}

/** A canvas stand-in that only answers what `renderPageImage` asks of one. */
class FakeOffscreen {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  async convertToBlob(options: { type: string }): Promise<Blob> {
    return new Blob([`${this.width}x${this.height}`], { type: options.type });
  }
}

beforeEach(() => {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  const font = new Uint8Array(readFileSync(file));
  vi.stubGlobal('fetch', async () => new Response(font));
  vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
  script.results = [];
  script.inputs = [];
  script.during = undefined;
  script.available = true;
  script.probes = [];
  script.render = 'ok';
  script.destroyFails = false;
  script.cancelled = 0;
  script.renders = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ocrDocument options', () => {
  it('refuses a resolution outside 150-300 instead of clamping it', async () => {
    for (const dpi of [149, 301, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await failureOf(ocrDocument(document(), options({ dpi }), run))).code).toBe('range-invalid');
    }
  });

  it('refuses an empty language list and an empty page list before asking whether a pack exists', async () => {
    expect((await failureOf(ocrDocument(document(), options({ languages: [] }), run))).code).toBe(
      'unsupported',
    );
    expect((await failureOf(ocrDocument(document(), options({ pages: [] }), run))).code).toBe(
      'selection-empty',
    );
    expect(script.probes).toEqual([]);
  });

  it('names a missing language pack, probing the quality the run would really use', async () => {
    script.available = (language) => language !== 'deu';
    const failure = await failureOf(
      ocrDocument(document(), options({ languages: ['tur', 'deu'], quality: 'fast' }), run),
    );
    expect(failure.code).toBe('ocr-language-missing');
    // `deu` has no fast model, so the whole run is `best`.
    expect(script.probes).toEqual([
      ['tur', 'best'],
      ['deu', 'best'],
    ]);
    expect(failure.details.engineMessage).toBe('deu (best) is not available at its pinned path');
  });

  it('stops with an abort error when the signal is aborted before the run or during the language probe', async () => {
    const before = new AbortController();
    before.abort();
    await expect(ocrDocument(document(), options(), { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const during = new AbortController();
    script.available = () => {
      during.abort();
      return true;
    };
    await expect(ocrDocument(document(), options(), { signal: during.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('refuses a page outside the document, naming it', async () => {
    const failure = await failureOf(ocrDocument(document(), options({ pages: [1, 3] }), run));
    expect(failure.code).toBe('range-invalid');
    expect(failure.details.pageIndex).toBe(3);
  });
});

describe('ocrDocument run', () => {
  it('writes the recognized words of the chosen pages as a text layer and reports what it did', async () => {
    script.results = [
      { words: [word('Çarşı', 36, 72, 120, 100)], confidence: 88.4 },
      { words: [word('Dünya', 36, 72, 120, 100)], confidence: 55.2 },
    ];
    const progress: OperationProgress[] = [];
    const outcome = await ocrDocument(
      document(),
      options({ pages: [2, 1, 1], languages: ['tur', 'eng'], quality: 'fast' }),
      { signal: run.signal, onProgress: (entry) => progress.push(entry) },
    );
    // Pages are recognized once each, in page order; the page is rendered at dpi/72 (216 dpi: 3 pixels per point).
    expect(script.inputs.map((input) => input.scale)).toEqual([3, 3]);
    expect(script.renders).toEqual([
      { width: 900, height: 1200 },
      { width: 900, height: 1200 },
    ]);
    expect(script.inputs[0]?.languages).toEqual(['tur', 'eng']);
    expect(script.inputs[0]?.quality).toBe('fast');
    expect(textOf(outcome.bytes, 1)).toBe('Çarşı');
    expect(textOf(outcome.bytes, 2)).toBe('Dünya');
    expect(outcome.pages).toEqual([
      { pageIndex: 1, words: 1, confidence: 88.4, skipped: false },
      { pageIndex: 2, words: 1, confidence: 55.2, skipped: false },
    ]);
    expect(outcome.report.engine).toBe('tesseract');
    expect(outcome.report.pageCount).toBe(3);
    expect(outcome.report.incremental).toBe(false);
    expect(outcome.report.notes).toEqual([
      { kind: 'changed', key: 'op.note.ocr.layerAdded', params: { pages: 2, words: 2, dpi: 216 } },
      { kind: 'warning', key: 'op.note.ocr.lowConfidence', params: { page: 3, confidence: 55 } },
      { kind: 'preserved', key: 'op.note.ocr.hiddenLayer' },
    ]);
    // The engine's own progress is mapped onto the page's slot: page 1 at 0.5 is 0.5 of 2.
    expect(progress.some((entry) => entry.phase === 'ocr' && entry.done === 0.5 && entry.total === 2)).toBe(
      true,
    );
    expect(progress.some((entry) => entry.labelKey === 'op.progress.ocr.save' && entry.done === 1)).toBe(
      true,
    );
  });

  it('skips pages that already carry text, and says so', async () => {
    script.results = [{ words: [word('Yeni', 36, 72, 100, 100)], confidence: 90 }];
    const outcome = await ocrDocument(document(), options({ pages: [0, 1], existingText: 'skip' }), run);
    expect(outcome.pages).toEqual([
      { pageIndex: 0, words: 0, confidence: 0, skipped: true },
      { pageIndex: 1, words: 1, confidence: 90, skipped: false },
    ]);
    expect(outcome.report.notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.ocr.layerAdded', { pages: 1, words: 1, dpi: 216 }],
      ['op.note.ocr.skippedPages', { count: 1 }],
      ['op.note.ocr.hiddenLayer', undefined],
    ]);
  });

  it('still returns the result when releasing the pdf.js document fails', async () => {
    script.destroyFails = true;
    script.results = [{ words: [word('Hallo', 36, 72, 100, 100)], confidence: 90 }];
    const outcome = await ocrDocument(document(), options(), run);
    expect(textOf(outcome.bytes, 1)).toBe('Hallo');
    expect(await detectScannedPages(document(), run)).toEqual([1, 2]);
  });

  it('returns the document when every chosen page was skipped', async () => {
    const outcome = await ocrDocument(document(), options({ pages: [0], existingText: 'skip' }), run);
    expect(outcome.pages).toEqual([{ pageIndex: 0, words: 0, confidence: 0, skipped: true }]);
    expect(textOf(outcome.bytes, 0)).toBe('Merhaba');
    expect(script.inputs).toEqual([]);
  });

  it('adds a layer under existing text when asked to overwrite, with the additive warning', async () => {
    script.results = [{ words: [word('Ek', 36, 72, 80, 100)], confidence: 95 }];
    const outcome = await ocrDocument(document(), options({ pages: [0], existingText: 'overwrite' }), run);
    expect(textOf(outcome.bytes, 0)).toContain('Merhaba');
    expect(outcome.report.notes).toContainEqual({
      kind: 'warning',
      key: 'op.note.ocr.overwriteIsAdditive',
      params: { count: 1 },
    });
  });

  it('notes that the better model was used when the fast one could not serve the languages', async () => {
    script.results = [{ words: [word('Hallo', 36, 72, 100, 100)], confidence: 90 }];
    const outcome = await ocrDocument(document(), options({ languages: ['deu'], quality: 'fast' }), run);
    expect(script.inputs[0]?.quality).toBe('best');
    expect(outcome.report.notes).toContainEqual({ kind: 'changed', key: 'op.note.ocr.bestModel' });
  });

  it('does not warn about a page whose confidence is unknown (0)', async () => {
    script.results = [{ words: [word('Hallo', 36, 72, 100, 100)], confidence: 0 }];
    const outcome = await ocrDocument(document(), options(), run);
    expect(outcome.report.notes.map((entry) => entry.key)).toEqual([
      'op.note.ocr.layerAdded',
      'op.note.ocr.hiddenLayer',
    ]);
  });

  it('fails when nothing was recognized on pages that were not skipped', async () => {
    script.results = [{ words: [], confidence: 0 }];
    const failure = await failureOf(ocrDocument(document(), options(), run));
    expect(failure.code).toBe('unsupported');
    expect(failure.details.engineMessage).toBe('no words recognized on the selected pages');
  });

  it('stops with an abort error when the user cancels while a page is recognized', async () => {
    const controller = new AbortController();
    script.results = [{ words: [word('Hallo', 36, 72, 100, 100)], confidence: 90 }];
    script.during = () => controller.abort();
    await expect(ocrDocument(document(), options(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('stops between pages when the signal is aborted after a page was done', async () => {
    const controller = new AbortController();
    script.results = [
      { words: [word('Bir', 36, 72, 100, 100)], confidence: 90 },
      { words: [word('Iki', 36, 72, 100, 100)], confidence: 90 },
    ];
    const done: Array<number | undefined> = [];
    await expect(
      ocrDocument(document(), options({ pages: [1, 2] }), {
        signal: controller.signal,
        onProgress: (entry) => {
          done.push(entry.done);
          if (entry.done === 1 && entry.total === 2) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(script.inputs).toHaveLength(1);
  });
});

describe('page rendering', () => {
  it('paints onto a DOM canvas when there is no OffscreenCanvas, and hands the PNG on', async () => {
    vi.unstubAllGlobals();
    const font = new Uint8Array(
      readFileSync(
        createRequire(import.meta.url).resolve(
          '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
          {
            paths: [process.cwd()],
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', async () => new Response(font));
    const made: Array<{ width: number; height: number }> = [];
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        expect(tag).toBe('canvas');
        const canvas = {
          width: 0,
          height: 0,
          toBlob: (done: (blob: Blob | null) => void, type: string) => done(new Blob(['png'], { type })),
        };
        made.push(canvas);
        return canvas;
      },
    });
    script.results = [{ words: [word('Hallo', 36, 72, 100, 100)], confidence: 90 }];
    await ocrDocument(document(), options(), run);
    expect(made).toEqual([{ width: 900, height: 1200, toBlob: expect.any(Function) }]);
    expect(script.inputs[0]?.image.size).toBe(3);
    expect(script.inputs[0]?.image.type).toBe('image/png');
  });

  it('reports a canvas that produced no picture as an internal error', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('document', {
      createElement: () => ({
        width: 0,
        height: 0,
        toBlob: (done: (blob: Blob | null) => void) => done(null),
      }),
    });
    const failure = await failureOf(ocrDocument(document(), options(), run));
    expect(failure.code).toBe('internal');
    expect(failure.details.engineMessage).toBe('canvas.toBlob produced no blob');
  });

  it('reports a page that cannot be rendered, naming it', async () => {
    script.render = 'fail';
    const failure = await failureOf(ocrDocument(document(), options({ pages: [2] }), run));
    expect(failure.code).toBe('internal');
    expect(failure.details.pageIndex).toBe(2);
    expect(failure.details.engineMessage).toBe('render exploded');
  });

  it('reports a render failure that is not an Error by its text', async () => {
    script.render = 'fail-text';
    const failure = await failureOf(ocrDocument(document(), options(), run));
    expect(failure.details.engineMessage).toBe('render exploded as text');
  });

  it('cancels the render and stops with an abort error when the user cancels during it', async () => {
    script.render = 'hang';
    const controller = new AbortController();
    const running = ocrDocument(document(), options(), { signal: controller.signal });
    await vi.waitFor(() => expect(script.renders).toHaveLength(1));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(script.cancelled).toBe(1);
  });
});

describe('detectScannedPages', () => {
  it('lists the pages without a text layer, reporting progress', async () => {
    const progress: Array<number | undefined> = [];
    const pages = await detectScannedPages(document(), {
      signal: run.signal,
      onProgress: (entry) => progress.push(entry.done),
    });
    expect(pages).toEqual([1, 2]);
    expect(progress).toEqual([0, 1, 2, 3]);
  });

  it('stops with an abort error when the signal is aborted before or during the scan', async () => {
    const before = new AbortController();
    before.abort();
    await expect(detectScannedPages(document(), { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const during = new AbortController();
    await expect(
      detectScannedPages(document(), { signal: during.signal, onProgress: () => during.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('writeOcrLayer', () => {
  const layer = (pageIndex: number, words: OcrWord[]) => ({
    pageIndex,
    words,
    toPdfPoint: (x: number, y: number) => [x, 400 - y] as const,
  });

  it('names a page the document does not have', async () => {
    const failure = await failureOf(
      writeOcrLayer(document(), [layer(7, [word('Merhaba', 10, 10, 90, 30)])], run),
    );
    expect(failure.code).toBe('range-invalid');
    expect(failure.details.pageIndex).toBe(7);
  });

  it('writes a word Noto Sans cannot spell in the glyph-less face, in visual order for right-to-left', async () => {
    const out = await writeOcrLayer(
      document(),
      [layer(1, [word('שלום', 10, 10, 90, 30), word('日本語', 100, 10, 190, 30)])],
      run,
    );
    expect(textOf(out, 1)).toContain('שלום');
    expect(textOf(out, 1)).toContain('日本語');
  });

  it('writes a word of zero width at the font size of its box, and a Devanagari word with its gap', async () => {
    const out = await writeOcrLayer(
      document(),
      [layer(1, [word('Merhaba', 10, 10, 10, 30), word('नमस्ते', 100, 10, 190, 30)])],
      run,
    );
    expect(textOf(out, 1)).toContain('Merhaba');
    expect(textOf(out, 1)).toContain('नमस्ते');
  });

  it('leaves a page with no words untouched', async () => {
    const out = await writeOcrLayer(document(), [layer(1, [])], run);
    expect(textOf(out, 1)).toBe('');
  });

  it('stops with an abort error when the signal is aborted between pages', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeOcrLayer(document(), [layer(1, [word('Merhaba', 10, 10, 90, 30)])], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('maps an engine failure on damaged bytes to a tool error', async () => {
    const failure = await failureOf(writeOcrLayer(new Uint8Array([1, 2, 3]), [layer(0, [])], run));
    expect(failure.code).not.toBe('aborted');
  });
});

describe('visualOrder', () => {
  it('reverses the grapheme clusters of a right-to-left word and leaves other words alone', () => {
    expect(visualOrder('abc')).toBe('abc');
    expect(visualOrder('שלום')).toBe('םולש');
  });
});
