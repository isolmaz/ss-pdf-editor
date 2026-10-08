/**
 * The pdf.js chunk cache: the 1.5 MB parser is
 * imported once for the session and shared by every caller — and a **failed** import
 * must not be remembered, since `warmPdfjs()` already ran at idle on this page, so one
 * transient chunk failure would otherwise leave every later open failing until a hard
 * refresh.
 *
 * The chunk is mocked, but only where the adapter touches it: the setter below stands
 * for `module.GlobalWorkerOptions.workerSrc`, so every "attempt" counted here is one
 * pass of the adapter's own import-and-wire step. The promise under test is the
 * adapter's, not a stub.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFJS_ASSETS } from '../assets';

const state = vi.hoisted(() => ({
  /** Passes of the adapter's wire-the-worker step — one per import attempt it makes. */
  attempts: 0,
  /** How many of the next attempts fail; a retry finds this at zero again. */
  failures: 0,
  workerSrc: '',
  error: new Error('pdf.js chunk unavailable'),
  options: undefined as { workerSrc: string } | undefined,
}));

vi.mock('pdfjs-dist', () => {
  const GlobalWorkerOptions = {
    get workerSrc(): string {
      return state.workerSrc;
    },
    set workerSrc(value: string) {
      state.attempts += 1;
      if (state.failures > 0) {
        state.failures -= 1;
        throw state.error;
      }
      state.workerSrc = value;
    },
  };
  state.options = GlobalWorkerOptions;
  return { GlobalWorkerOptions };
});

/** The chunk cache lives in module scope, so every test needs its own module instance. */
async function freshLoader(): Promise<typeof import('./pdfjs-handle')> {
  vi.resetModules();
  return await import('./pdfjs-handle');
}

describe('loadPdfjs', () => {
  beforeEach(() => {
    state.attempts = 0;
    state.failures = 0;
    state.workerSrc = '';
  });

  it('wires the worker asset and gives simultaneous callers one shared attempt', async () => {
    const { loadPdfjs } = await freshLoader();
    const first = loadPdfjs();
    const second = loadPdfjs();
    expect(second).toBe(first);
    expect(state.attempts).toBe(0); // the attempt is still in flight: nothing was wired twice

    const [one, two] = await Promise.all([first, second]);
    expect(two).toBe(one);
    expect(one.GlobalWorkerOptions).toBe(state.options);
    expect(state.workerSrc).toBe(PDFJS_ASSETS.worker);
    expect(state.attempts).toBe(1);
  });

  it('forgets a failed import so the next call retries', async () => {
    const { loadPdfjs } = await freshLoader();
    state.failures = 1;
    await expect(loadPdfjs()).rejects.toBe(state.error);
    expect(state.attempts).toBe(1);

    const chunk = await loadPdfjs();
    expect(chunk.GlobalWorkerOptions).toBe(state.options);
    expect(state.workerSrc).toBe(PDFJS_ASSETS.worker);
    expect(state.attempts).toBe(2);
  });

  it('gives simultaneous retries exactly one fresh attempt', async () => {
    const { loadPdfjs } = await freshLoader();
    state.failures = 1;
    await expect(loadPdfjs()).rejects.toThrow(state.error.message);

    const first = loadPdfjs();
    const second = loadPdfjs();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(state.attempts).toBe(2); // one failed attempt, one retry — not two
  });

  it('keeps a resolved chunk for every later caller', async () => {
    const { loadPdfjs } = await freshLoader();
    const chunk = await loadPdfjs();
    expect(state.attempts).toBe(1);

    expect(loadPdfjs()).toBe(loadPdfjs());
    expect(await loadPdfjs()).toBe(chunk);
    expect(state.attempts).toBe(1);
  });
});

describe('openWithPdfjs', () => {
  it('reports a chunk the browser could not fetch as offline, not as a damaged file', async () => {
    const { openWithPdfjs } = await freshLoader();
    const original = state.error;
    state.error = new TypeError('Failed to fetch dynamically imported module: /editor/assets/pdf-1.js');
    state.failures = 1;
    try {
      await expect(openWithPdfjs(new Uint8Array([37, 80, 68, 70]))).rejects.toMatchObject({
        name: 'ToolError',
        code: 'asset-offline',
        details: { engine: 'pdfjs' },
      });
    } finally {
      state.error = original;
    }
  });

  it('maps each exception the engine names to the contract, and a thrown non-Error to an internal error', async () => {
    const cases: Array<[unknown, string]> = [
      [Object.assign(new Error('gone'), { name: 'MissingPDFException' }), 'unsupported-format'],
      [Object.assign(new Error('odd'), { name: 'UnexpectedResponseException' }), 'unsupported-format'],
      [Object.assign(new Error('stop'), { name: 'AbortException' }), 'aborted'],
      [Object.assign(new Error('stop'), { name: 'RenderingCancelledException' }), 'aborted'],
      ['plain text', 'internal'],
    ];
    for (const [error, code] of cases) {
      state.failures = 1;
      state.error = error as Error;
      const { openWithPdfjs } = await freshLoader();
      await expect(openWithPdfjs(new Uint8Array([1]))).rejects.toMatchObject({ code });
    }
    state.error = new Error('pdf.js chunk unavailable');
    // A warm-up that cannot load the chunk stays silent.
    state.failures = 1;
    const quiet = await freshLoader();
    const before = state.attempts;
    quiet.warmPdfjs();
    await vi.waitFor(() => expect(state.attempts).toBe(before + 1));
    // The failed attempt is forgotten: the slot is free for the next caller, which makes a
    // fresh attempt of its own (a remembered rejection would reject here without one).
    const chunk = await quiet.loadPdfjs();
    expect(chunk.GlobalWorkerOptions).toBe(state.options);
    expect(state.attempts).toBe(before + 2);
  });
});
