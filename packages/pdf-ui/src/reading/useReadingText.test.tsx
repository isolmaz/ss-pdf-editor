// @vitest-environment happy-dom
/**
 * The reading text hook: what the pane receives while a page is read (waiting, a failure keyed to
 * the dictionary, blocks) and how a page the user has left, or a cancelled session, is kept out of
 * the result. The engine document is a fake with the one member the hook reads, `raw.getPage`.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ReadingViewer, useReadingText } from './useReadingText';

interface FakeItem {
  readonly str?: string;
  readonly type?: string;
  readonly transform?: readonly number[];
  readonly width?: number;
  readonly height?: number;
}

const textRun = (str: string, y = 700): FakeItem => ({
  str,
  transform: [12, 0, 0, 12, 72, y],
  width: 60,
  height: 12,
});

/** A viewer whose document serves `items` for every page, recording the page numbers asked for. */
function viewerOf(items: readonly FakeItem[], getPage = vi.fn()) {
  getPage.mockImplementation(async () => ({ getTextContent: async () => ({ items }) }));
  return { getPage, viewer: { document: { raw: { getPage } } } as unknown as ReadingViewer };
}

afterEach(cleanup);

describe('useReadingText', () => {
  it('waits, without failing, until the viewer exists', () => {
    const { result } = renderHook(() => useReadingText(null, 0));
    expect(result.current).toEqual({ blocks: [], loading: true, error: null });
  });

  it('reports the missing text source as an internal error instead of an empty page', () => {
    const viewer = {} as unknown as ReadingViewer;
    const { result } = renderHook(() => useReadingText(viewer, 0));
    expect(result.current).toEqual({ blocks: [], loading: false, error: 'error.internal.message' });
  });

  it('reads the requested page (0-based) into reading blocks, skipping markers and blank runs', async () => {
    const { viewer, getPage } = viewerOf([
      { type: 'beginMarkedContent' },
      textRun('First line', 700),
      textRun('   ', 686),
      textRun('second line', 686),
      { str: 'Broken', transform: [Number.NaN, 0, 0, 12, 72, 600], width: 10, height: 12 },
    ]);
    const { result } = renderHook(() => useReadingText(viewer, 4));
    expect(result.current).toEqual({ blocks: [], loading: true, error: null });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getPage).toHaveBeenCalledExactlyOnceWith(5);
    expect(result.current).toEqual({
      blocks: [{ kind: 'paragraph', text: 'First line second line' }],
      loading: false,
      error: null,
    });
  });

  it('reads a page without any text as no blocks', async () => {
    const { viewer } = viewerOf([]);
    const { result } = renderHook(() => useReadingText(viewer, 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ blocks: [], loading: false, error: null });
  });

  it('reports a ToolError by its dictionary key and any other failure as internal', async () => {
    const damaged = {
      document: {
        raw: { getPage: async () => Promise.reject(new ToolError('corrupt-document', { engine: 'pdfjs' })) },
      },
    };
    const { result } = renderHook(() => useReadingText(damaged as unknown as ReadingViewer, 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ blocks: [], loading: false, error: 'error.corrupt-document.message' });

    const broken = { document: { raw: { getPage: async () => Promise.reject(new Error('worker died')) } } };
    const other = renderHook(() => useReadingText(broken as unknown as ReadingViewer, 0));
    await waitFor(() => expect(other.result.current.loading).toBe(false));
    expect(other.result.current).toEqual({ blocks: [], loading: false, error: 'error.internal.message' });
  });

  it('never applies a page the user has left, even when it settles after the next one', async () => {
    const slow = Promise.withResolvers<{ getTextContent: () => Promise<{ items: FakeItem[] }> }>();
    const getPage = vi.fn(async (page: number) =>
      page === 1 ? slow.promise : { getTextContent: async () => ({ items: [textRun('Second page')] }) },
    );
    const viewer = { document: { raw: { getPage } } } as unknown as ReadingViewer;
    const { result, rerender } = renderHook(({ page }) => useReadingText(viewer, page), {
      initialProps: { page: 0 },
    });
    await waitFor(() => expect(getPage).toHaveBeenCalledWith(1));
    rerender({ page: 1 });
    await waitFor(() => expect(result.current.blocks).toEqual([{ kind: 'paragraph', text: 'Second page' }]));
    await act(async () => {
      slow.resolve({ getTextContent: async () => ({ items: [textRun('First page')] }) });
    });
    expect(result.current.blocks).toEqual([{ kind: 'paragraph', text: 'Second page' }]);
  });

  it('does not report the failure of a page the user has left', async () => {
    const slow = Promise.withResolvers<never>();
    const getPage = vi.fn(async (page: number) =>
      page === 1 ? slow.promise : { getTextContent: async () => ({ items: [textRun('Second page')] }) },
    );
    const viewer = { document: { raw: { getPage } } } as unknown as ReadingViewer;
    const { result, rerender } = renderHook(({ page }) => useReadingText(viewer, page), {
      initialProps: { page: 0 },
    });
    await waitFor(() => expect(getPage).toHaveBeenCalledWith(1));
    rerender({ page: 1 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      slow.reject(new Error('late failure'));
    });
    expect(result.current).toEqual({
      blocks: [{ kind: 'paragraph', text: 'Second page' }],
      loading: false,
      error: null,
    });
  });

  it('stops before reading the text when the session is cancelled while the page is being fetched', async () => {
    const gate = Promise.withResolvers<{ getTextContent: () => Promise<{ items: FakeItem[] }> }>();
    const getTextContent = vi.fn(async () => ({ items: [textRun('Never shown')] }));
    const getPage = vi.fn(() => gate.promise);
    const viewer = { document: { raw: { getPage } } } as unknown as ReadingViewer;
    const session = new AbortController();
    const { result } = renderHook(() => useReadingText(viewer, 0, session.signal));
    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(1));
    session.abort();
    await act(async () => {
      gate.resolve({ getTextContent });
    });
    expect(getTextContent).not.toHaveBeenCalled();
    expect(result.current).toEqual({ blocks: [], loading: true, error: null });
  });

  it('drops the text when the session is cancelled while the engine extracts it', async () => {
    const gate = Promise.withResolvers<{ items: FakeItem[] }>();
    const getPage = vi.fn(async () => ({ getTextContent: () => gate.promise }));
    const viewer = { document: { raw: { getPage } } } as unknown as ReadingViewer;
    const session = new AbortController();
    const { result } = renderHook(() => useReadingText(viewer, 0, session.signal));
    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    session.abort();
    await act(async () => {
      gate.resolve({ items: [textRun('Never shown')] });
    });
    expect(result.current).toEqual({ blocks: [], loading: true, error: null });
  });

  it('drops blocks that were built just as the session was cancelled', async () => {
    const session = new AbortController();
    // The cancellation lands while the runs are being shaped, after the engine's last checkpoint.
    const cancelling: FakeItem = {
      str: 'Never shown',
      get transform() {
        session.abort();
        return [12, 0, 0, 12, 72, 700];
      },
      width: 60,
      height: 12,
    };
    const { viewer, getPage } = viewerOf([cancelling]);
    const { result } = renderHook(() => useReadingText(viewer, 0, session.signal));
    await waitFor(() => expect(getPage).toHaveBeenCalledTimes(1));
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 0);
    await act(async () => {
      await tick.promise;
    });
    expect(session.signal.aborted).toBe(true);
    expect(result.current).toEqual({ blocks: [], loading: true, error: null });
  });

  it('does not touch the engine when the session is already cancelled', async () => {
    const { viewer, getPage } = viewerOf([textRun('Never shown')]);
    const session = new AbortController();
    session.abort();
    const { result } = renderHook(() => useReadingText(viewer, 0, session.signal));
    await act(async () => {
      await Promise.resolve();
    });
    expect(getPage).not.toHaveBeenCalled();
    expect(result.current).toEqual({ blocks: [], loading: true, error: null });
  });
});
