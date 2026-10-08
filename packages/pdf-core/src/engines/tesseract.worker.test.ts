/**
 * The tesseract worker cache and recognition, with the third-party engine replaced at its
 * loading boundary (the runtime-loaded ESM chunk): `createWorker` answers a scripted worker, so
 * what is tested is this adapter's own behaviour — the options the worker is created with, one
 * worker per language set, the progress it forwards, the boxes it returns, the abort that drops
 * the worker, and how engine failures are named.
 */

import { ToolError } from 'pdf-shared';
import type { LoggerMessage } from 'tesseract.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TESSERACT_ASSETS } from '../assets';

interface FakeWorker {
  recognize: (image: unknown, options: unknown, output: unknown) => Promise<unknown>;
  terminate: () => Promise<void>;
  setParameters: (parameters: unknown) => Promise<void>;
}

const state = vi.hoisted(() => ({
  created: [] as Array<{ languages: string[]; options: Record<string, unknown> }>,
  workers: [] as Array<{ recognize: unknown[]; terminated: number; parameters: unknown[] }>,
  /** Called for each created worker, in order; defaults to a worker that recognizes `page`. */
  nextCreate: [] as Array<() => Promise<unknown>>,
  recognize: undefined as undefined | ((call: number) => Promise<unknown>),
  terminateError: undefined as unknown,
  logger: undefined as undefined | ((message: unknown) => void),
}));

vi.mock('/engines/tesseract/tesseract.esm.min.js', () => ({
  default: undefined,
  createWorker: async (languages: string[], _engine: unknown, options: Record<string, unknown>) => {
    state.created.push({ languages, options });
    state.logger = options.logger as (message: unknown) => void;
    const next = state.nextCreate.shift();
    if (next !== undefined) await next();
    const record = { recognize: [] as unknown[], terminated: 0, parameters: [] as unknown[] };
    state.workers.push(record);
    const worker: FakeWorker = {
      recognize: (image, recognizeOptions, output) => {
        record.recognize.push({ image, recognizeOptions, output });
        if (state.recognize === undefined) return Promise.reject(new Error('no scripted recognition'));
        return state.recognize(record.recognize.length);
      },
      setParameters: async (parameters) => {
        record.parameters.push(parameters);
      },
      terminate: async () => {
        record.terminated += 1;
        if (state.terminateError !== undefined) throw state.terminateError;
      },
    };
    return worker;
  },
}));

const engine = await import('./tesseract');

const image = new Blob(['x'], { type: 'image/png' });

function pageOf(words: Array<{ text: string; bbox: [number, number, number, number]; confidence?: number }>) {
  return {
    data: {
      confidence: 81,
      blocks: [
        {
          paragraphs: [
            {
              lines: [
                {
                  words: words.map((entry) => ({
                    text: entry.text,
                    bbox: { x0: entry.bbox[0], y0: entry.bbox[1], x1: entry.bbox[2], y1: entry.bbox[3] },
                    confidence: entry.confidence ?? 90,
                  })),
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

function input(overrides: Partial<Parameters<typeof engine.recognizePage>[0]> = {}) {
  return {
    image,
    scale: 2,
    languages: ['tur' as const],
    quality: 'fast' as const,
    signal: new AbortController().signal,
    ...overrides,
  };
}

beforeEach(async () => {
  await engine.terminateOcrWorkers();
  state.created = [];
  state.workers = [];
  state.nextCreate = [];
  state.recognize = async () => pageOf([]);
  state.terminateError = undefined;
  state.logger = undefined;
});

describe('effectiveOcrQuality and language paths', () => {
  it('keeps fast only when every language has a fast model', () => {
    expect(engine.effectiveOcrQuality(['tur', 'eng'], 'fast')).toBe('fast');
    expect(engine.effectiveOcrQuality(['tur', 'deu'], 'fast')).toBe('best');
    expect(engine.effectiveOcrQuality(['tur'], 'best')).toBe('best');
  });

  it('points at the pinned directory of the quality', () => {
    expect(engine.tesseractLanguageUrl('tur', 'fast')).toBe(
      `${TESSERACT_ASSETS.fastLangPath}/tur.traineddata.gz`,
    );
    expect(engine.tesseractLanguageUrl('chi_sim', 'best')).toBe(
      `${TESSERACT_ASSETS.bestLangPath}/chi_sim.traineddata.gz`,
    );
  });
});

describe('recognizePage', () => {
  it('creates the worker from our own assets, and returns trimmed words in page points', async () => {
    state.recognize = async () =>
      pageOf([
        { text: ' Çarşı ', bbox: [20, 40, 120, 80], confidence: 77 },
        { text: '   ', bbox: [0, 0, 1, 1] },
        { text: 'Dünya', bbox: [140, 40, 200, 80] },
      ]);
    const result = await engine.recognizePage(input({ languages: ['tur', 'eng'] }));
    expect(result.confidence).toBe(81);
    expect(result.words).toEqual([
      { text: 'Çarşı', x0: 10, y0: 20, x1: 60, y1: 40, confidence: 77, block: 0, paragraph: 0, line: 0 },
      { text: 'Dünya', x0: 70, y0: 20, x1: 100, y1: 40, confidence: 90, block: 0, paragraph: 0, line: 0 },
    ]);
    expect(state.created).toHaveLength(1);
    expect(state.created[0]?.languages).toEqual(['tur', 'eng']);
    expect(state.created[0]?.options).toMatchObject({
      workerPath: TESSERACT_ASSETS.worker,
      corePath: TESSERACT_ASSETS.core,
      langPath: TESSERACT_ASSETS.fastLangPath,
      gzip: true,
    });
    expect(state.workers[0]?.recognize).toEqual([
      { image, recognizeOptions: {}, output: { blocks: true, text: false, hocr: false, tsv: false } },
    ]);
  });

  it('numbers blocks, paragraphs and lines over the page and scales the line baseline', async () => {
    const word = (text: string, x0: number) => ({
      text,
      bbox: { x0, y0: 20, x1: x0 + 20, y1: 40 },
      confidence: 95,
    });
    const baseline = { x0: 20, y0: 36, x1: 80, y1: 38, has_baseline: true };
    state.recognize = async () => ({
      data: {
        confidence: 90,
        blocks: [
          {
            paragraphs: [
              { lines: [{ baseline, words: [word('a', 20), word('b', 50)] }, { words: [word('c', 20)] }] },
              { lines: [{ baseline: { ...baseline, has_baseline: false }, words: [word('d', 20)] }] },
            ],
          },
          { paragraphs: [{ lines: [{ words: [word('e', 20)] }] }] },
        ],
      },
    });
    const { words } = await engine.recognizePage(input());
    expect(words.map(({ text, block, paragraph, line }) => [text, block, paragraph, line])).toEqual([
      ['a', 0, 0, 0],
      ['b', 0, 0, 0],
      ['c', 0, 0, 1],
      ['d', 0, 1, 2],
      ['e', 1, 2, 3],
    ]);
    expect(words[0]?.baseline).toEqual({ x0: 10, y0: 18, x1: 40, y1: 19 });
    expect(words[1]?.baseline).toEqual({ x0: 10, y0: 18, x1: 40, y1: 19 });
    // No baseline, or one tesseract flags as not found: the field is absent.
    expect(words[2]).not.toHaveProperty('baseline');
    expect(words[3]).not.toHaveProperty('baseline');
  });

  it('uses the best-model directory for the best quality', async () => {
    await engine.recognizePage(input({ quality: 'best' }));
    expect(state.created[0]?.options.langPath).toBe(TESSERACT_ASSETS.bestLangPath);
  });

  it('reads a page without blocks as no words', async () => {
    state.recognize = async () => ({ data: { confidence: 0 } });
    expect(await engine.recognizePage(input())).toEqual({ words: [], confidence: 0 });
  });

  it('keeps one worker per language set and quality, however the languages are ordered', async () => {
    await engine.recognizePage(input({ languages: ['tur', 'eng'] }));
    await engine.recognizePage(input({ languages: ['eng', 'tur'] }));
    expect(state.created).toHaveLength(1);
    await engine.recognizePage(input({ languages: ['tur', 'eng'], quality: 'best' }));
    await engine.recognizePage(input({ languages: ['tur'] }));
    expect(state.created).toHaveLength(3);
  });

  it('forwards only the recognizing progress of the page that currently owns the worker', async () => {
    const seen: number[] = [];
    state.recognize = async () => {
      const log = state.logger as (message: LoggerMessage) => void;
      log({ status: 'loading language traineddata', progress: 0.9, jobId: '', userJobId: '', workerId: '' });
      log({ status: 'recognizing text', progress: 0.25, jobId: '', userJobId: '', workerId: '' });
      log({ status: 'recognizing text', progress: 7, jobId: '', userJobId: '', workerId: '' });
      log({ status: 'recognizing text', progress: -1, jobId: '', userJobId: '', workerId: '' });
      log({ status: 'recognizing text', progress: Number.NaN, jobId: '', userJobId: '', workerId: '' });
      return pageOf([]);
    };
    await engine.recognizePage(input({ onProgress: (fraction) => seen.push(fraction) }));
    expect(seen).toEqual([0.25, 1, 0]);
    // Once the page is done the worker has no sink: a late message goes nowhere.
    (state.logger as (message: LoggerMessage) => void)({
      status: 'recognizing text',
      progress: 0.5,
      jobId: '',
      userJobId: '',
      workerId: '',
    });
    expect(seen).toEqual([0.25, 1, 0]);
    // A run without a sink ignores progress.
    await engine.recognizePage(input());
  });

  it('refuses an empty language list and an already aborted signal', async () => {
    await expect(engine.recognizePage(input({ languages: [] }))).rejects.toMatchObject({
      code: 'unsupported',
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(engine.recognizePage(input({ signal: aborted.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(state.created).toEqual([]);
  });

  it('does not keep a worker whose start failed, and gives a second caller waiting on it the failure', async () => {
    let fail: (error: unknown) => void = () => undefined;
    state.nextCreate = [
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    ];
    const first = engine.recognizePage(input());
    await vi.waitFor(() => expect(state.created).toHaveLength(1));
    const second = engine.recognizePage(input());
    fail(new Error('Failed to fetch worker.min.js'));
    expect(await first.catch((error: unknown) => error)).toMatchObject({ code: 'asset-missing' });
    expect(await second.catch((error: unknown) => error)).toMatchObject({ code: 'asset-missing' });
    // The next call starts again.
    expect((await engine.recognizePage(input())).words).toEqual([]);
    expect(state.created).toHaveLength(2);
  });

  it('stops with an abort error when cancelled during recognition, terminating and forgetting the worker', async () => {
    const controller = new AbortController();
    state.recognize = () => new Promise(() => undefined);
    const running = engine.recognizePage(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(state.workers[0]?.recognize).toHaveLength(1));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(state.workers[0]?.terminated).toBe(1));
    // The dropped worker is not reused.
    state.recognize = async () => pageOf([]);
    await engine.recognizePage(input());
    expect(state.created).toHaveLength(2);
  });

  it('survives a worker that is already dead when the abort terminates it', async () => {
    const controller = new AbortController();
    state.recognize = () => new Promise(() => undefined);
    state.terminateError = new Error('worker already gone');
    const running = engine.recognizePage(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(state.workers[0]?.recognize).toHaveLength(1));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(state.workers[0]?.terminated).toBe(1));
  });

  it('reports an abort that lands as the engine answers as an abort, not as a result', async () => {
    const controller = new AbortController();
    state.recognize = async () => {
      controller.abort();
      return pageOf([{ text: 'Geç', bbox: [0, 0, 2, 2] }]);
    };
    await expect(engine.recognizePage(input({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('leaves the progress sink of a newer page alone when an older page finishes after it started', async () => {
    const releases: Array<() => void> = [];
    state.recognize = () =>
      new Promise((resolve) => {
        releases.push(() => resolve(pageOf([])));
      });
    const seen: string[] = [];
    const older = engine.recognizePage(input({ onProgress: () => seen.push('older') }));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const newer = engine.recognizePage(input({ onProgress: () => seen.push('newer') }));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]?.();
    await older;
    (state.logger as (message: LoggerMessage) => void)({
      status: 'recognizing text',
      progress: 0.5,
      jobId: '',
      userJobId: '',
      workerId: '',
    });
    releases[1]?.();
    await newer;
    expect(seen).toEqual(['newer']);
  });

  it('names the failures of the engine', async () => {
    const cases: Array<[unknown, string]> = [
      [new Error('Failed to load language tur.traineddata'), 'ocr-language-missing'],
      [new Error('NetworkError when attempting to fetch resource'), 'asset-missing'],
      [new Error('Aborted(). Build with -sASSERTIONS; out of memory'), 'out-of-memory'],
      [new Error('something else broke'), 'internal'],
      ['plain text failure', 'internal'],
    ];
    for (const [error, code] of cases) {
      state.recognize = async () => {
        throw error;
      };
      const failure = await engine.recognizePage(input()).catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(ToolError);
      expect((failure as ToolError).code).toBe(code);
    }
  });

  it('passes a tool error of the engine through unchanged', async () => {
    const original = new ToolError('range-invalid', { engine: 'tesseract' });
    state.recognize = async () => {
      throw original;
    };
    expect(await engine.recognizePage(input()).catch((caught: unknown) => caught)).toBe(original);
  });
});

describe('recognizeWord', () => {
  const wordInput = (signal = new AbortController().signal) => ({
    image,
    languages: ['eng' as const],
    quality: 'best' as const,
    signal,
  });

  it('reads a crop as one word and puts the page mode back', async () => {
    state.recognize = async () => ({ data: { text: ' SQL \n', confidence: 47 } });
    expect(await engine.recognizeWord(wordInput())).toEqual({ text: 'SQL', confidence: 47 });
    expect(state.workers[0]?.parameters).toEqual([
      { tessedit_pageseg_mode: '8' },
      { tessedit_pageseg_mode: '3' },
    ]);
    expect(state.workers[0]?.recognize[0]).toMatchObject({ output: { text: true, blocks: false } });
  });

  it('answers null for a crop without text, and puts the mode back when the engine fails', async () => {
    state.recognize = async () => ({ data: { text: ' \n', confidence: 0 } });
    expect(await engine.recognizeWord(wordInput())).toBeNull();
    state.recognize = async () => {
      throw new Error('out of memory');
    };
    await expect(engine.recognizeWord(wordInput())).rejects.toMatchObject({ code: 'out-of-memory' });
    expect(state.workers[0]?.parameters.at(-1)).toEqual({ tessedit_pageseg_mode: '3' });
  });

  it('names a failed start, refuses an aborted signal and stops when cancelled mid-read', async () => {
    state.nextCreate = [async () => Promise.reject(new Error('Failed to fetch'))];
    await expect(engine.recognizeWord(wordInput())).rejects.toMatchObject({ code: 'asset-missing' });
    const aborted = new AbortController();
    aborted.abort();
    await expect(engine.recognizeWord(wordInput(aborted.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    const controller = new AbortController();
    state.recognize = () => new Promise(() => undefined);
    const pending = engine.recognizeWord(wordInput(controller.signal));
    await vi.waitFor(() => expect(state.workers[0]?.recognize).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.workers[0]?.terminated).toBe(1);
  });
});

describe('mapTesseractError', () => {
  it('prefixes the context and keeps the cause', () => {
    const cause = new Error('traineddata is damaged');
    const mapped = engine.mapTesseractError(cause, 'recognize');
    expect(mapped.code).toBe('ocr-language-missing');
    expect(mapped.details.engineMessage).toBe('recognize: traineddata is damaged');
    expect(mapped.cause).toBe(cause);
  });
});

describe('terminateOcrWorkers', () => {
  it('terminates every cached worker and waits for it, ignoring workers that never started or die on terminate', async () => {
    await engine.recognizePage(input({ languages: ['tur'] }));
    await engine.recognizePage(input({ languages: ['eng'] }));
    state.nextCreate = [async () => Promise.reject(new Error('start failed'))];
    const failing = engine.recognizePage(input({ languages: ['deu'], quality: 'best' }));
    state.terminateError = new Error('already dead');
    await engine.terminateOcrWorkers();
    await failing.catch(() => undefined);
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1, 1]);
    // Everything was dropped: the next page starts a worker again.
    state.terminateError = undefined;
    await engine.recognizePage(input({ languages: ['tur'] }));
    expect(state.created).toHaveLength(4);
  });
});

describe('isOcrLanguageAvailable', () => {
  it('asks with a HEAD request to the pinned path and answers what the origin can reach', async () => {
    const asked: Array<[string, string | undefined]> = [];
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      asked.push([url, init?.method]);
      return new Response(null, { status: url.includes('tur') ? 200 : 404 });
    });
    expect(await engine.isOcrLanguageAvailable('tur', 'fast')).toBe(true);
    expect(await engine.isOcrLanguageAvailable('deu', 'best')).toBe(false);
    expect(asked).toEqual([
      [engine.tesseractLanguageUrl('tur', 'fast'), 'HEAD'],
      [engine.tesseractLanguageUrl('deu', 'best'), 'HEAD'],
    ]);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    expect(await engine.isOcrLanguageAvailable('tur', 'fast')).toBe(false);
    vi.unstubAllGlobals();
  });
});
