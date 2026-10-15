/**
 * The pages of the document as a Save would write it: the shell's reader is called with the job's
 * signal, its bytes are opened as a copy that is released afterwards, and a protected document —
 * whose copy cannot be opened without a password and which can hold no unsaved mark — is rendered
 * from the document on screen instead.
 */

import { ToolError } from 'pdf-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkingPages } from './workingPages';

const opener = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('pdf-core/engines/pdfjs-handle', () => ({ openWithPdfjs: opener.open }));

const BYTES = new Uint8Array([1, 2, 3]);
const live = { getPageSize: vi.fn(), renderPage: vi.fn() };

beforeEach(() => {
  opener.open.mockReset();
});

describe('openWorkingPages', () => {
  it('reads the working bytes with the job’s signal and opens a copy of them', async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => BYTES);
    const handle = { getPageSize: vi.fn(), renderPage: vi.fn(), destroy: vi.fn(async () => undefined) };
    opener.open.mockResolvedValue(handle);

    const pages = await openWorkingPages(read, live, controller.signal);

    expect(read).toHaveBeenCalledExactlyOnceWith({ signal: controller.signal });
    expect(opener.open).toHaveBeenCalledExactlyOnceWith(BYTES, { signal: controller.signal });
    expect(pages.source).toBe(handle);
    await pages.release();
    expect(handle.destroy).toHaveBeenCalledOnce();
  });

  it('never rejects from the release: the copy is already of no use', async () => {
    const handle = { destroy: vi.fn(async () => Promise.reject(new Error('worker gone'))) };
    opener.open.mockResolvedValue(handle);
    const pages = await openWorkingPages(async () => BYTES, live, new AbortController().signal);
    await expect(pages.release()).resolves.toBeUndefined();
  });

  it.each(['password-required', 'wrong-password'] as const)(
    'renders from the document on screen when the copy is protected (%s)',
    async (code) => {
      opener.open.mockRejectedValue(new ToolError(code, { engine: 'pdfjs' }));
      const pages = await openWorkingPages(async () => BYTES, live, new AbortController().signal);
      expect(pages.source).toBe(live);
      await expect(pages.release()).resolves.toBeUndefined();
    },
  );

  it('hands every other failure of the copy to the caller', async () => {
    const failure = new ToolError('corrupt-document', { engine: 'pdfjs' });
    opener.open.mockRejectedValue(failure);
    await expect(openWorkingPages(async () => BYTES, live, new AbortController().signal)).rejects.toBe(
      failure,
    );
    opener.open.mockRejectedValue(new Error('not a tool error'));
    await expect(openWorkingPages(async () => BYTES, live, new AbortController().signal)).rejects.toThrow(
      'not a tool error',
    );
  });

  it('hands the reader’s own failure to the caller and opens nothing', async () => {
    const failure = new ToolError('internal', { engine: 'model' });
    await expect(
      openWorkingPages(() => Promise.reject(failure), live, new AbortController().signal),
    ).rejects.toBe(failure);
    expect(opener.open).not.toHaveBeenCalled();
  });
});
