/**
 * `convertWithGhostscript`: what it does in a browser (a module worker per conversion, the
 * document handed over by transfer, the worker's messages mapped onto progress, a result or an
 * error, the worker always terminated) and in Node (the same runner in this thread). The
 * browser's `Worker` is the one thing stood in for; the in-thread runs import a real loader
 * file, written to a temporary directory, through the module's own import.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const assets = vi.hoisted(() => ({ js: '/engines/ghostscript/gs.js', wasm: '/engines/ghostscript/gs.wasm' }));

vi.mock('../assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../assets')>();
  return { ...actual, GHOSTSCRIPT_ASSETS: assets };
});

const { convertWithGhostscript, ghostscriptFailure } = await import('./ghostscript');

const request = () => ({
  input: new Uint8Array([1, 2, 3]),
  part: 2 as const,
  info: {
    title: null,
    author: null,
    subject: null,
    keywords: null,
    creator: null,
    creationDate: null,
    language: null,
  },
});

/** The module a loader file answers: pages print, the second `callMain` converts. */
function loaderSource(convert: string): string {
  return `
    export default async (options) => {
      const files = new Map();
      let calls = 0;
      return {
        callMain: () => {
          calls += 1;
          if (calls === 1) return 0;
          ${convert}
          return 0;
        },
        FS: {
          writeFile: (path, data) => files.set(path, data),
          readFile: (path) => {
            if (!files.has(path)) throw new Error('missing');
            return files.get(path);
          },
          unlink: (path) => files.delete(path),
        },
        options,
      };
    };`;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  terminated = 0;
  posted: Array<{ message: unknown; transfer: unknown }> = [];
  constructor(
    readonly url: URL,
    readonly options: { type: string },
  ) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown, transfer: unknown): void {
    this.posted.push({ message, transfer });
  }
  terminate(): void {
    this.terminated += 1;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }
}

describe('ghostscriptFailure', () => {
  it('names the stage: an engine that did not load is offline, a conversion is a PDF/A failure, memory is its own', () => {
    expect(ghostscriptFailure('load', 'x').code).toBe('asset-offline');
    expect(ghostscriptFailure('run', 'Cannot enlarge memory arrays').code).toBe('out-of-memory');
    expect(ghostscriptFailure('run', 'syntax error').code).toBe('pdfa-failed');
  });
});

describe('in a browser (a worker per conversion)', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('self', { location: { href: 'https://editor.test/app/index.html' } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts a module worker, hands the document over by transfer, and relays pages and the result', async () => {
    const input = request();
    const pages: Array<[number, number]> = [];
    const running = convertWithGhostscript(input, {
      signal: new AbortController().signal,
      onPage: (page, total) => pages.push([page, total]),
    });
    const worker = FakeWorker.instances[0];
    expect(worker?.options).toEqual({ type: 'module' });
    expect(worker?.url.pathname.endsWith('ghostscript-worker.ts')).toBe(true);
    expect(worker?.posted).toEqual([
      {
        message: {
          js: 'https://editor.test/engines/ghostscript/gs.js',
          wasm: 'https://editor.test/engines/ghostscript/gs.wasm',
          request: input,
        },
        transfer: [input.input.buffer],
      },
    ]);
    worker?.emit({ type: 'page', page: 1, total: 2 });
    worker?.emit({ type: 'page', page: 2, total: 2 });
    const result = { output: new Uint8Array([4]), exitCode: 0, warnings: [], pageCount: 2 };
    worker?.emit({ type: 'done', result });
    expect(await running).toBe(result);
    expect(pages).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(worker?.terminated).toBe(1);
  });

  it('relays pages when nobody listens', async () => {
    const running = convertWithGhostscript(request(), { signal: new AbortController().signal });
    const worker = FakeWorker.instances[0];
    worker?.emit({ type: 'page', page: 1, total: 1 });
    worker?.emit({
      type: 'done',
      result: { output: new Uint8Array(), exitCode: 0, warnings: [], pageCount: 1 },
    });
    expect((await running).pageCount).toBe(1);
  });

  it('maps an error message by its stage, and terminates the worker', async () => {
    for (const [stage, code] of [
      ['load', 'asset-offline'],
      ['run', 'pdfa-failed'],
    ] as const) {
      const running = convertWithGhostscript(request(), { signal: new AbortController().signal });
      const worker = FakeWorker.instances.at(-1);
      worker?.emit({ type: 'error', stage, message: 'it broke' });
      await expect(running).rejects.toMatchObject({ code, details: { engineMessage: 'it broke' } });
      expect(worker?.terminated).toBe(1);
    }
  });

  it('reports a worker that cannot start as an engine that is offline', async () => {
    const first = convertWithGhostscript(request(), { signal: new AbortController().signal });
    FakeWorker.instances[0]?.onerror?.({ message: 'Failed to load module script' });
    await expect(first).rejects.toMatchObject({
      code: 'asset-offline',
      details: { engineMessage: 'Failed to load module script' },
    });
    const second = convertWithGhostscript(request(), { signal: new AbortController().signal });
    FakeWorker.instances[1]?.onerror?.({ message: '' });
    await expect(second).rejects.toMatchObject({
      code: 'asset-offline',
      details: { engineMessage: 'the worker failed to start' },
    });
  });

  it('stops with an abort error and terminates the worker when cancelled; a later message changes nothing', async () => {
    const controller = new AbortController();
    const running = convertWithGhostscript(request(), { signal: controller.signal });
    const worker = FakeWorker.instances[0];
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker?.terminated).toBe(1);
  });

  it('does not start a worker for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(convertWithGhostscript(request(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(FakeWorker.instances).toEqual([]);
  });
});

describe('in this thread (no Worker)', () => {
  let directory = '';
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'gs-engine-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
    assets.js = '/engines/ghostscript/gs.js';
  });

  function loader(name: string, source: string): string {
    const file = join(directory, name);
    writeFileSync(file, source);
    return pathToFileURL(file).href;
  }

  it('runs the conversion in-thread with the pinned loader and reports its pages', async () => {
    assets.js = loader(
      'ok.mjs',
      loaderSource(
        `options.print('Processing pages 1 through 1.'); options.print('Page 1'); files.set('/tmp/output.pdf', new Uint8Array([8]));`,
      ),
    );
    const pages: Array<[number, number]> = [];
    const result = await convertWithGhostscript(request(), {
      signal: new AbortController().signal,
      onPage: (page, total) => pages.push([page, total]),
    });
    expect(result.output).toEqual(new Uint8Array([8]));
    expect(pages).toEqual([[1, 1]]);
  });

  it('reports a loader that cannot be imported as an engine that is offline', async () => {
    assets.js = pathToFileURL(join(directory, 'missing.mjs')).href;
    await expect(
      convertWithGhostscript(request(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: 'asset-offline',
    });
  });

  it('reports a loader that fails with something that is not an Error by its text', async () => {
    assets.js = loader('text.mjs', `export default async () => { throw 'plain text failure'; };`);
    await expect(
      convertWithGhostscript(request(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: 'asset-offline',
      details: { engineMessage: 'plain text failure' },
    });
  });

  it('reports a conversion that fails after the engine loaded as a PDF/A failure, or as memory', async () => {
    assets.js = loader('run.mjs', loaderSource(`throw new Error('syntax error in stream');`));
    await expect(
      convertWithGhostscript(request(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: 'pdfa-failed',
    });
    assets.js = loader('oom.mjs', loaderSource(`throw new Error('Cannot enlarge memory arrays');`));
    await expect(
      convertWithGhostscript(request(), { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      code: 'out-of-memory',
    });
  });

  it('does not start for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(convertWithGhostscript(request(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
