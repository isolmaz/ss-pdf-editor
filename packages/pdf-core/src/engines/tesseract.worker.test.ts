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
  /** While set, `terminate` has not finished: the worker's heap is not yet released. */
  terminateGate: undefined as undefined | Promise<void>,
  logger: undefined as undefined | ((message: unknown) => void),
}));

// Not hoisted: the module's URL carries the engine's pinned version, so it is the asset's own.
vi.doMock(TESSERACT_ASSETS.module, () => ({
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
        await state.terminateGate;
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
  state.terminateGate = undefined;
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

  it('does not keep a worker whose start failed, and lets a second caller waiting on it start its own', async () => {
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
    expect((await second).words).toEqual([]);
    expect(state.created).toHaveLength(2);
    // The next call has the worker the second started.
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

  it('reads one page at a time on a worker, the progress of each going to its page alone', async () => {
    const releases: Array<() => void> = [];
    state.recognize = () =>
      new Promise((resolve) => {
        releases.push(() => resolve(pageOf([])));
      });
    const seen: string[] = [];
    const progress = { status: 'recognizing text', progress: 0.5, jobId: '', userJobId: '', workerId: '' };
    const older = engine.recognizePage(input({ onProgress: () => seen.push('older') }));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const newer = engine.recognizePage(input({ onProgress: () => seen.push('newer') }));
    // The newer page waits for the worker: it has not started to read.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(releases).toHaveLength(1);
    (state.logger as (message: LoggerMessage) => void)(progress);
    releases[0]?.();
    await older;
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    (state.logger as (message: LoggerMessage) => void)(progress);
    releases[1]?.();
    await newer;
    expect(seen).toEqual(['older', 'newer']);
    expect(state.created).toHaveLength(1);
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

describe('recognizePage with automatic layout', () => {
  it('segments the page automatically for that read only and puts the default mode back', async () => {
    state.recognize = async () => pageOf([]);
    await engine.recognizePage(input({ languages: ['tur'], automaticLayout: true }));
    expect(state.workers[0]?.parameters).toEqual([
      { tessedit_pageseg_mode: '3' },
      { tessedit_pageseg_mode: '6' },
    ]);
    // a read without it leaves the mode alone, and the mode is back when the engine fails
    await engine.recognizePage(input({ languages: ['tur'] }));
    expect(state.workers[0]?.parameters).toHaveLength(2);
    state.recognize = async () => {
      throw new Error('out of memory');
    };
    await expect(
      engine.recognizePage(input({ languages: ['tur'], automaticLayout: true })),
    ).rejects.toMatchObject({ code: 'out-of-memory' });
    expect(state.workers[0]?.parameters.at(-1)).toEqual({ tessedit_pageseg_mode: '6' });
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
      { tessedit_pageseg_mode: '6' },
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
    expect(state.workers[0]?.parameters.at(-1)).toEqual({ tessedit_pageseg_mode: '6' });
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

describe('a pool of workers', () => {
  const reads = (count: number) => {
    const releases: Array<() => void> = [];
    state.recognize = () =>
      new Promise((resolve) => {
        releases.push(() => resolve(pageOf([])));
      });
    return { releases, count };
  };

  it('starts as many workers as it is allowed for pages read side by side, and a page beyond them waits for one', async () => {
    engine.claimOcrWorkers([{ languages: ['tur'], quality: 'fast', workers: 2 }]);
    const { releases } = reads(3);
    const pages = [
      engine.recognizePage(input()),
      engine.recognizePage(input()),
      engine.recognizePage(input()),
    ];
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.created).toHaveLength(2);
    expect(releases).toHaveLength(2);
    releases[1]?.();
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[0]?.();
    releases[2]?.();
    await Promise.all(pages);
    // The third took the worker the second gave back; none was started for it.
    expect(state.created).toHaveLength(2);
    expect(state.workers.map((worker) => worker.recognize.length)).toEqual([1, 2]);
  });

  it('keeps a pool for each language set and quality, and allows more than one worker only to the set it was asked for', async () => {
    engine.claimOcrWorkers([{ languages: ['tur'], quality: 'fast', workers: 2 }]);
    const { releases } = reads(1);
    const pages = [
      engine.recognizePage(input({ languages: ['tur'] })),
      engine.recognizePage(input({ languages: ['tur'] })),
      engine.recognizePage(input({ languages: ['eng'] })),
      engine.recognizePage(input({ languages: ['eng'] })),
      engine.recognizePage(input({ languages: ['tur'], quality: 'best' })),
    ];
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Two for Turkish, one for English (its second page waits), one for Turkish at the other quality.
    expect(state.created.map((entry) => entry.languages)).toEqual([['tur'], ['tur'], ['eng'], ['tur']]);
    for (const release of releases) release();
    await vi.waitFor(() => expect(releases).toHaveLength(5));
    releases[4]?.();
    await Promise.all(pages);
    expect(state.created).toHaveLength(4);
  });

  it('keeps every worker a cancelled waiter would have taken for the waiter behind it', async () => {
    engine.claimOcrWorkers([{ languages: ['tur'], quality: 'fast', workers: 1 }]);
    const { releases } = reads(1);
    const busy = engine.recognizePage(input());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const first = new AbortController();
    const second = new AbortController();
    const cancelled = engine.recognizePage(input({ signal: first.signal }));
    const behind = engine.recognizePage(input({ signal: second.signal }));
    first.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    releases[0]?.();
    await busy;
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]?.();
    await behind;
    expect(state.created).toHaveLength(1);
  });

  it('allows no more than three workers to a set', async () => {
    engine.claimOcrWorkers([{ languages: ['tur'], quality: 'fast', workers: 50 }]);
    const { releases } = reads(1);
    const pages = Array.from({ length: 5 }, () => engine.recognizePage(input()));
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(state.created).toHaveLength(3);
    for (let at = 0; at < 5; at += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(at));
      releases[at]?.();
    }
    await Promise.all(pages);
  });

  it('puts a cancelled read’s worker out of the pool and lets the next page start one in its place', async () => {
    engine.claimOcrWorkers([{ languages: ['tur'], quality: 'fast', workers: 1 }]);
    const { releases } = reads(2);
    const controller = new AbortController();
    const cancelled = engine.recognizePage(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const waiting = engine.recognizePage(input());
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]?.();
    await waiting;
    expect(state.created).toHaveLength(2);
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1, 0]);
  });

  it('sends a waiter away that is cancelled after it was woken but before it could take the freed place, which a newcomer took', async () => {
    engine.claimOcrWorkers([{ languages: ['tur'], quality: 'fast', workers: 1 }]);
    const { releases } = reads(2);
    const owner = new AbortController();
    const reading = engine.recognizePage(input({ signal: owner.signal }));
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const waiterSignal = new AbortController();
    const waiter = engine.recognizePage(input({ signal: waiterSignal.signal }));
    // The owner's cancel frees its place and wakes the waiter; before the waiter runs on, it is
    // cancelled itself and a newcomer starts a worker in the freed place.
    owner.abort();
    waiterSignal.abort();
    const newcomer = engine.recognizePage(input());
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]?.();
    await newcomer;
    expect(state.created).toHaveLength(2);
  });

  it('terminates the worker of a read cancelled after the pools were dropped, without a pool to leave', async () => {
    const controller = new AbortController();
    state.recognize = () => new Promise(() => undefined);
    const running = engine.recognizePage(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(state.workers[0]?.recognize).toHaveLength(1));
    await engine.terminateOcrWorkers();
    expect(state.workers[0]?.terminated).toBe(1);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(state.workers[0]?.terminated).toBe(2));
  });

  it('stops a page waiting for a worker when it is cancelled, without touching the workers', async () => {
    engine.claimOcrWorkers([{ languages: ['tur'], quality: 'fast', workers: 1 }]);
    const { releases } = reads(1);
    const busy = engine.recognizePage(input());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const controller = new AbortController();
    const waiting = engine.recognizePage(input({ signal: controller.signal }));
    const waitingWord = engine.recognizeWord({
      image,
      languages: ['tur'],
      quality: 'fast',
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(waitingWord).rejects.toMatchObject({ name: 'AbortError' });
    releases[0]?.();
    await busy;
    expect(state.workers.map((worker) => worker.terminated)).toEqual([0]);
  });

  it('gives the worker back when the read is cancelled while the worker was starting', async () => {
    const wordOf = (signal: AbortSignal) =>
      engine.recognizeWord({ image, languages: ['tur'], quality: 'fast', signal });
    for (const wordFirst of [false, true]) {
      await engine.terminateOcrWorkers();
      state.created = [];
      let finish: () => void = () => undefined;
      state.nextCreate = [
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ];
      const controller = new AbortController();
      const starts = wordFirst
        ? wordOf(controller.signal)
        : engine.recognizePage(input({ signal: controller.signal }));
      await vi.waitFor(() => expect(state.created).toHaveLength(1));
      const waits = wordFirst
        ? engine.recognizePage(input({ signal: controller.signal }))
        : wordOf(controller.signal);
      controller.abort();
      finish();
      await expect(starts).rejects.toMatchObject({ name: 'AbortError' });
      await expect(waits).rejects.toMatchObject({ name: 'AbortError' });
      // The worker that started is in the pool, free: the next read does not start another.
      state.recognize = async () => pageOf([]);
      await engine.recognizePage(input());
      expect(state.created).toHaveLength(1);
    }
  });

  it('terminates what is running, what is free and what is still starting, and sends the waiting pages away', async () => {
    engine.claimOcrWorkers([{ languages: ['tur'], quality: 'fast', workers: 3 }]);
    const { releases } = reads(1);
    const first = engine.recognizePage(input());
    const second = engine.recognizePage(input());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    let finish: () => void = () => undefined;
    state.nextCreate = [
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ];
    const third = engine.recognizePage(input());
    await vi.waitFor(() => expect(state.created).toHaveLength(3));
    const waiting = engine.recognizePage(input());
    const ending = engine.terminateOcrWorkers();
    finish();
    await ending;
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1, 1, 1]);
    // Reads that were running when the pool went give nothing back to it.
    for (const release of releases) release();
    await Promise.all([first, second]);
    releases.length = 0;
    state.recognize = async () => pageOf([]);
    await third;
    // The pool is back to one worker: two pages read one after the other, on one new worker.
    await Promise.all([engine.recognizePage(input()), engine.recognizePage(input())]);
    expect(state.created).toHaveLength(4);
  });

  it('suggests one worker less than the cores, from one to three, and one on a machine with little memory or one that does not say', () => {
    const suggested = (hardwareConcurrency?: number, deviceMemory?: number) => {
      vi.stubGlobal('navigator', {
        ...(hardwareConcurrency === undefined ? {} : { hardwareConcurrency }),
        ...(deviceMemory === undefined ? {} : { deviceMemory }),
      });
      return engine.suggestedOcrWorkers();
    };
    expect([undefined, 1, 2, 3, 4, 8, 64].map((cores) => suggested(cores, 8))).toEqual([1, 1, 1, 2, 3, 3, 3]);
    expect([0.5, 2, 3.5].map((memory) => suggested(8, memory))).toEqual([1, 1, 1]);
    expect([4, 8].map((memory) => suggested(8, memory))).toEqual([3, 3]);
    // Firefox, Safari and iOS browsers do not implement `deviceMemory`: unknown memory is taken for little,
    // whatever the cores say, instead of for enough for three wasm heaps.
    expect([2, 4, 8, 64].map((cores) => suggested(cores))).toEqual([1, 1, 1, 1]);
    vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: Number.NaN });
    expect(engine.suggestedOcrWorkers()).toBe(1);
    vi.unstubAllGlobals();
    vi.stubGlobal('navigator', undefined);
    expect(engine.suggestedOcrWorkers()).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('a worker that failed', () => {
  it('is terminated and left out of the pool, and the next page is read on a new worker', async () => {
    let reads = 0;
    state.recognize = async () => {
      reads += 1;
      if (reads === 1) throw new Error('RuntimeError: memory access out of bounds');
      return pageOf([{ text: 'Sonra', bbox: [20, 40, 120, 80] }]);
    };
    await expect(engine.recognizePage(input())).rejects.toMatchObject({ code: 'out-of-memory' });
    // The crashed worker is gone the moment the failure reaches the caller.
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1]);
    const next = await engine.recognizePage(input());
    expect(next.words.map((entry) => entry.text)).toEqual(['Sonra']);
    // The second page did not run on the crashed worker: a second one was started for it.
    expect(state.created).toHaveLength(2);
    expect(state.workers.map((worker) => worker.recognize.length)).toEqual([1, 1]);
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1, 0]);
  });

  it('is not given back when a word read fails either', async () => {
    state.recognize = async () => {
      throw new Error('worker exploded');
    };
    const readWord = () =>
      engine.recognizeWord({
        image,
        languages: ['eng'],
        quality: 'best',
        signal: new AbortController().signal,
      });
    await expect(readWord()).rejects.toMatchObject({ code: 'internal' });
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1]);
    state.recognize = async () => ({ data: { text: 'ok', confidence: 80 } });
    expect(await readWord()).toEqual({ text: 'ok', confidence: 80 });
    expect(state.created).toHaveLength(2);
  });

  it('hands its place to a page that was waiting for it', async () => {
    engine.claimOcrWorkers([{ languages: ['tur'], quality: 'fast', workers: 1 }]);
    let reads = 0;
    const crash = Promise.withResolvers<unknown>();
    const answer = pageOf([{ text: 'Bekleyen', bbox: [0, 0, 2, 2] }]);
    state.recognize = () => {
      reads += 1;
      return reads === 1 ? crash.promise : Promise.resolve(answer);
    };
    const failing = engine.recognizePage(input()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(reads).toBe(1));
    const waiting = engine.recognizePage(input());
    crash.reject(new Error('worker crashed'));
    expect(await failing).toBeInstanceOf(ToolError);
    expect((await waiting).words.map((entry) => entry.text)).toEqual(['Bekleyen']);
    expect(state.created).toHaveLength(2);
  });

  it('answers a read that never comes back with a timeout, and the next page does not wait on the dead worker', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let reads = 0;
      const asked = Promise.withResolvers<void>();
      state.recognize = () => {
        reads += 1;
        if (reads > 1) return Promise.resolve(pageOf([]));
        asked.resolve();
        return new Promise(() => undefined);
      };
      const dead = engine.recognizePage(input()).catch((error: unknown) => error);
      // Awaited through the read itself, not polled: `vi.waitFor` moves a fake clock on at every check.
      await asked.promise;
      await vi.advanceTimersByTimeAsync(engine.OCR_READ_TIMEOUT_MS);
      const failure = await dead;
      expect(failure).toBeInstanceOf(ToolError);
      expect(failure).toMatchObject({ code: 'timeout' });
      expect(state.workers[0]?.terminated).toBe(1);
      expect((await engine.recognizePage(input())).words).toEqual([]);
      expect(state.created).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a read that answers in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const answer = Promise.withResolvers<unknown>();
      const asked = Promise.withResolvers<void>();
      state.recognize = () => {
        asked.resolve();
        return answer.promise;
      };
      const reading = engine.recognizePage(input());
      // The read is under way and its timer is set (both in the same turn): the clock is moved by this test alone.
      // `vi.waitFor` is not used here: it advances a fake clock by its interval at every check, which would
      // push this read past the timeout it is meant to beat.
      await asked.promise;
      await vi.advanceTimersByTimeAsync(engine.OCR_READ_TIMEOUT_MS - 1);
      answer.resolve(pageOf([]));
      expect((await reading).words).toEqual([]);
      // The finished read left no timer behind, and the worker went back to the pool.
      expect(vi.getTimerCount()).toBe(0);
      await engine.recognizePage(input());
      expect(state.created).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('claims on the worker pools', () => {
  const tur = [{ languages: ['tur' as const], quality: 'fast' as const }];
  const held = () => {
    const releases: Array<() => void> = [];
    state.recognize = () =>
      new Promise((resolve) => {
        releases.push(() => resolve(pageOf([])));
      });
    return releases;
  };

  it('keeps the workers another operation is reading with when one operation lets go', async () => {
    const first = engine.claimOcrWorkers(tur);
    const second = engine.claimOcrWorkers(tur);
    const releases = held();
    const reading = engine.recognizePage(input());
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    await first.release();
    // The second operation's read still has its worker.
    expect(state.workers.map((worker) => worker.terminated)).toEqual([0]);
    releases[0]?.();
    expect((await reading).words).toEqual([]);
    // ...and its next page reuses it: nothing was started again.
    state.recognize = async () => pageOf([]);
    await engine.recognizePage(input());
    expect(state.created).toHaveLength(1);
    expect(state.workers.map((worker) => worker.terminated)).toEqual([0]);
    // The pool closes when the last operation holding it lets go.
    await second.release();
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1]);
  });

  it('lets an operation take back only the pools nobody else holds', async () => {
    const mine = engine.claimOcrWorkers([
      { languages: ['tur'], quality: 'fast' },
      { languages: ['eng'], quality: 'best' },
    ]);
    const theirs = engine.claimOcrWorkers([{ languages: ['tur'], quality: 'fast' }]);
    await engine.recognizePage(input({ languages: ['tur'] }));
    await engine.recognizePage(input({ languages: ['eng'], quality: 'best' }));
    await mine.release();
    // Turkish is still held by the other operation; English was mine alone.
    expect(state.created.map((entry) => entry.languages)).toEqual([['tur'], ['eng']]);
    expect(state.workers.map((worker) => worker.terminated)).toEqual([0, 1]);
    await engine.recognizePage(input({ languages: ['tur'] }));
    expect(state.created).toHaveLength(2);
    await theirs.release();
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1, 1]);
  });

  it('resolves only once the workers it took back are terminated, and does nothing the second time', async () => {
    const claim = engine.claimOcrWorkers(tur);
    await engine.recognizePage(input());
    const gate = Promise.withResolvers<void>();
    state.terminateGate = gate.promise;
    let done = false;
    const releasing = claim.release().then(() => {
      done = true;
    });
    // `terminate` has been asked for, and has not finished: the claim has not let go yet.
    await vi.waitFor(() => expect(state.workers[0]?.terminated).toBe(1));
    expect(done).toBe(false);
    gate.resolve();
    await releasing;
    expect(done).toBe(true);
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1]);
    await claim.release();
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1]);
  });

  it('gives a pool as many workers as the largest request of the operations holding it', async () => {
    const turkish = { languages: ['tur' as const], quality: 'fast' as const };
    const small = engine.claimOcrWorkers([{ ...turkish, workers: 1 }]);
    const large = engine.claimOcrWorkers([{ ...turkish, workers: 2 }]);
    const releases = held();
    const pages = [engine.recognizePage(input()), engine.recognizePage(input())];
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(state.created).toHaveLength(2);
    for (const release of releases) release();
    await Promise.all(pages);
    // The operation that asked for two lets go: the pool is back to what the other asked.
    await large.release();
    expect(state.workers.map((worker) => worker.terminated)).toEqual([0, 0]);
    await small.release();
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1, 1]);
  });

  it('starts a pool afresh for an operation that claims one the last holder has let go of', async () => {
    const first = engine.claimOcrWorkers(tur);
    await engine.recognizePage(input());
    await first.release();
    const second = engine.claimOcrWorkers(tur);
    await engine.recognizePage(input());
    expect(state.created).toHaveLength(2);
    // A late second release by the first operation does not touch the pool the second one holds.
    await first.release();
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1, 0]);
    await second.release();
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1, 1]);
  });

  it('is cleared by terminateOcrWorkers, whoever still holds the pool', async () => {
    const claim = engine.claimOcrWorkers(tur);
    await engine.recognizePage(input());
    await engine.terminateOcrWorkers();
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1]);
    await claim.release();
    expect(state.workers.map((worker) => worker.terminated)).toEqual([1]);
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
  it('asks with a GET request to the pinned path, cancels the body unread, and answers what the origin can reach', async () => {
    const asked: Array<[string, string | undefined]> = [];
    let cancelled = 0;
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      asked.push([url, init?.method]);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled += 1;
        },
      });
      return new Response(body, { status: url.includes('tur') ? 200 : 404 });
    });
    expect(await engine.isOcrLanguageAvailable('tur', 'fast')).toBe(true);
    expect(await engine.isOcrLanguageAvailable('deu', 'best')).toBe(false);
    expect(asked).toEqual([
      [engine.tesseractLanguageUrl('tur', 'fast'), 'GET'],
      [engine.tesseractLanguageUrl('deu', 'best'), 'GET'],
    ]);
    // Neither multi-megabyte model was downloaded for a yes or no.
    expect(cancelled).toBe(2);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    expect(await engine.isOcrLanguageAvailable('tur', 'fast')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('finds a pack that only the service worker can answer, which answers GET requests and not HEAD', async () => {
    // The worker's cache holds the pack; the network is off. A HEAD never reaches the worker.
    vi.stubGlobal('fetch', async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'GET') return new Response(new Uint8Array([31, 139]), { status: 200 });
      throw new TypeError('NetworkError when attempting to fetch resource.');
    });
    expect(await engine.isOcrLanguageAvailable('tur', 'fast')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('still answers that the pack is there when cancelling its body fails', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(16));
            },
            cancel() {
              throw new Error('the stream could not be cancelled');
            },
          }),
          { status: 200 },
        ),
    );
    expect(await engine.isOcrLanguageAvailable('tur', 'fast')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('answers a pack with no body, and a refusal the worker gave while offline, as they are', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('tur') ? new Response(null, { status: 200 }) : new Response('offline', { status: 503 }),
    );
    expect(await engine.isOcrLanguageAvailable('tur', 'fast')).toBe(true);
    expect(await engine.isOcrLanguageAvailable('eng', 'fast')).toBe(false);
    vi.unstubAllGlobals();
  });
});
