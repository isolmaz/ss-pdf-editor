/**
 * The worker script, loaded under a stand-in worker scope: `self` is an object whose `onmessage`
 * the script claims and whose `postMessage` records what it answers. What is tested is what the
 * script does with the request it is sent: the conversion runs with the loader URL it was given,
 * pages are posted as they are written, the result is posted with its output buffer transferred,
 * and a failure is posted with the stage it happened in.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhostscriptWorkerMessage, GhostscriptWorkerRequest } from './ghostscript-worker';

interface Posted {
  readonly message: GhostscriptWorkerMessage;
  readonly transfer: unknown[];
}

interface Scope {
  onmessage: ((event: { data: GhostscriptWorkerRequest }) => void) | null;
  postMessage(message: GhostscriptWorkerMessage, transfer: unknown[]): void;
}

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
      };
    };`;
}

const info = {
  title: null,
  author: null,
  subject: null,
  keywords: null,
  creator: null,
  creationDate: null,
  language: null,
};

describe('ghostscript worker script', () => {
  let directory = '';
  let posted: Posted[] = [];
  let scope: Scope;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'gs-worker-'));
    posted = [];
    scope = {
      onmessage: null,
      postMessage: (message, transfer) => {
        posted.push({ message, transfer });
      },
    };
    vi.stubGlobal('self', scope);
    vi.resetModules();
    await import('./ghostscript-worker');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  });

  let sent = 0;
  function send(source: string): void {
    sent += 1;
    const file = join(directory, `gs${sent}.mjs`);
    writeFileSync(file, source);
    scope.onmessage?.({
      data: {
        js: pathToFileURL(file).href,
        wasm: 'https://example.test/gs.wasm',
        request: { input: new Uint8Array([1, 2]), part: 2, info },
      },
    });
  }

  it('claims the worker scope on load', () => {
    expect(scope.onmessage).toBeTypeOf('function');
  });

  it('posts each page as it is written, then the result with its output buffer transferred', async () => {
    send(
      loaderSource(
        `options.print('Processing pages 1 through 2.'); options.print('Page 1'); options.print('Page 2'); files.set('/tmp/output.pdf', new Uint8Array([5, 6]));`,
      ),
    );
    await vi.waitFor(() => expect(posted.at(-1)?.message.type).toBe('done'));
    expect(posted.map((entry) => entry.message.type)).toEqual(['page', 'page', 'done']);
    expect(posted[0]?.message).toEqual({ type: 'page', page: 1, total: 2 });
    const done = posted[2];
    expect(done?.message).toMatchObject({
      type: 'done',
      result: { output: new Uint8Array([5, 6]), pageCount: 2 },
    });
    const output = done?.message.type === 'done' ? done.message.result.output : null;
    expect(done?.transfer).toEqual([output?.buffer]);
  });

  it('posts a load error when the loader cannot be imported', async () => {
    scope.onmessage?.({
      data: {
        js: pathToFileURL(join(directory, 'missing.mjs')).href,
        wasm: 'x',
        request: { input: new Uint8Array([1]), part: 2, info },
      },
    });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.message).toMatchObject({ type: 'error', stage: 'load' });
    expect(posted[0]?.transfer).toEqual([]);
  });

  it('posts a run error, with the message of an Error or the text of anything else, once the engine loaded', async () => {
    send(loaderSource(`throw new Error('syntax error in stream');`));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]?.message).toEqual({ type: 'error', stage: 'run', message: 'syntax error in stream' });

    send(loaderSource(`throw 'plain text';`));
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]?.message).toEqual({ type: 'error', stage: 'run', message: 'plain text' });
  });
});
