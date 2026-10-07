/**
 * The check that reads the written file back. The real engine writes what it is told to, so this
 * test wraps it at the seam `layer-write.faults.test.ts` uses: the bytes `saveRewrite` produces
 * can be swapped for a file that differs from the prediction in exactly one way. The input, the
 * removal and the second reader are real.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const state: { damaged?: Uint8Array } = {};

vi.mock('../engines/mupdf-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf-write')>();
  return {
    ...actual,
    saveRewrite: (...args: Parameters<typeof actual.saveRewrite>) => {
      const produced = actual.saveRewrite(...args);
      return state.damaged ?? produced;
    },
  };
});

const { removePdfAnnotations } = await import('./annotation-remove');
const { annotatedPages, square } = await import('./annotation-remove.fixtures');

const run = { signal: new AbortController().signal };
const direct = square(5);
const input = () =>
  annotatedPages({
    annots: `[10 0 R 11 0 R ${direct}]`,
    extra: { 10: square(1), 11: square(2), 12: square(3) },
  });
const removeFirst = () => removePdfAnnotations(input(), { targets: [{ pageIndex: 0, id: '10R' }] }, run);
const failure = (message: string, pageIndex?: number) => ({
  code: 'verification-failed',
  details: { engine: 'mupdf', engineMessage: message, ...(pageIndex === undefined ? {} : { pageIndex }) },
});

afterEach(() => {
  state.damaged = undefined;
});

describe('the read-back of the written file', () => {
  it('refuses output that does not open', async () => {
    state.damaged = new Uint8Array([1, 2, 3]);
    await expect(removeFirst()).rejects.toMatchObject(
      failure(expect.stringMatching(/^produced file does not re-open: /) as never),
    );
  });

  it('refuses output with a different page count', async () => {
    state.damaged = annotatedPages({ annots: '[11 0 R]', second: null, extra: { 11: square(2) } });
    await expect(removeFirst()).rejects.toMatchObject(failure('produced file has 2 pages, expected 1'));
  });

  it('refuses a page whose annotation count is not what was predicted', async () => {
    state.damaged = input();
    await expect(removeFirst()).rejects.toMatchObject(failure('page 1 carries 3 annotations, expected 2', 0));
  });

  it('refuses a removed annotation that is still listed', async () => {
    state.damaged = annotatedPages({ annots: `[10 0 R ${direct}]`, extra: { 10: square(1) } });
    await expect(removeFirst()).rejects.toMatchObject(
      failure('annotation 10R is still on page 1 after removal', 0),
    );
  });

  it('refuses a survivor that is no longer listed', async () => {
    state.damaged = annotatedPages({ annots: `[12 0 R ${direct}]`, extra: { 12: square(3) } });
    await expect(removeFirst()).rejects.toMatchObject(failure('annotation 11R disappeared from page 1', 0));
  });

  it('refuses an annotation that was not there before', async () => {
    state.damaged = annotatedPages({ annots: '[11 0 R 12 0 R]', extra: { 11: square(2), 12: square(3) } });
    await expect(removeFirst()).rejects.toMatchObject(failure('page 1 gained annotation 12R', 0));
  });
});
