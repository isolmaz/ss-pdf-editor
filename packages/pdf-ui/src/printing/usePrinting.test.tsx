// @vitest-environment happy-dom
/**
 * The print controller: the sheets it rasterises into the page (one canvas for the whole job, one
 * `<img>` per page, sized by the chosen scale), the phases it reports, the ways a job ends (the
 * browser's `afterprint`, `cancel`, the caller's signal, unmounting, a failed page) and the produced
 * imposed file. The engine document is a fake source; `buildPrintDocument` is pdf-core's own, tested
 * there, and is replaced here by a recorder.
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { type PrintController, type PrintRequest, usePrinting } from './usePrinting';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected value is missing');
  return value;
}

const impose = vi.hoisted(() => ({
  calls: [] as Array<{ bytes: Uint8Array; options: Record<string, unknown>; signal: AbortSignal }>,
  gate: null as Promise<void> | null,
  failure: null as Error | null,
  /** The operation returns its result although the signal fired after its last check. */
  finishesDespiteAbort: false,
  progress: [] as Array<{ done?: number; total?: number }>,
}));

const opened = vi.hoisted(() => ({ handle: null as unknown, open: null as unknown }));

vi.mock('pdf-core/engines/pdfjs-handle', () => ({
  openWithPdfjs: (...args: unknown[]) => (opened.open as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('pdf-core/ops/impose', () => ({
  buildPrintDocument: async (
    bytes: Uint8Array,
    options: Record<string, unknown>,
    context: { signal: AbortSignal; onProgress: (progress: { done?: number; total?: number }) => void },
  ) => {
    impose.calls.push({ bytes, options, signal: context.signal });
    for (const step of impose.progress) context.onProgress(step);
    await impose.gate;
    if (context.signal.aborted && !impose.finishesDespiteAbort) {
      // What pdf-core's `throwIfAborted` raises when the signal fires while the operation works.
      throw Object.assign(new Error('operation aborted'), { name: 'AbortError' });
    }
    if (impose.failure !== null) throw impose.failure;
    return { bytes: new Uint8Array([1, 2, 3]) };
  },
}));

interface FakeSource {
  readonly pageCount: number;
  readonly getPageSize: Mock;
  readonly renderPage: Mock;
  readonly destroy: Mock;
}

const LETTER_ISH = { width: 300, height: 400 };
/** What the shell's reader hands over: the working bytes with the unsaved marks written in. */
const WORKING = new Uint8Array([9, 9]);

let source: FakeSource;
let read: Mock;
let openArgs: unknown[][];
let canvases: HTMLCanvasElement[];
let blobGate: Promise<void> | null;
let blobFailsAt: number | null;
let decodeGate: Promise<void> | null;
let decodeFails: boolean;
let created: string[];
let revoked: string[];
let printCalls: number;

function viewerOf(document: FakeSource | null = source): ViewerApi {
  return { document } as unknown as ViewerApi;
}

function request(overrides: Partial<PrintRequest> = {}): PrintRequest {
  return {
    pages: [1, 3],
    scale: 'fit',
    perSheet: 1,
    booklet: false,
    duplex: 'simplex',
    marginMm: 0,
    ...overrides,
  };
}

beforeEach(() => {
  source = {
    pageCount: 3,
    getPageSize: vi.fn(async () => LETTER_ISH),
    renderPage: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
  read = vi.fn(async () => WORKING);
  openArgs = [];
  // The copy of the working bytes opens as `source` itself, so the rendering assertions below
  // read the calls the job made on the opened document.
  opened.open = async (...args: unknown[]) => {
    openArgs.push(args);
    return source;
  };
  canvases = [];
  blobGate = null;
  blobFailsAt = null;
  decodeGate = null;
  decodeFails = false;
  created = [];
  revoked = [];
  printCalls = 0;
  impose.calls.length = 0;
  impose.gate = null;
  impose.failure = null;
  impose.finishesDespiteAbort = false;
  impose.progress = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    done: BlobCallback,
    type?: string,
  ) {
    canvases.push(this);
    expect(type).toBe('image/png');
    void (async () => {
      await blobGate;
      done(blobFailsAt === canvases.length ? null : new Blob(['png'], { type: 'image/png' }));
    })();
  });
  URL.createObjectURL = () => {
    const url = `blob:sheet-${created.length + 1}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  HTMLImageElement.prototype.decode = async () => {
    await decodeGate;
    if (decodeFails) throw new Error('undecodable');
  };
  window.print = () => {
    printCalls += 1;
  };
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
});

const roots = () => document.querySelectorAll('.pdf-print-root');
const sheets = () => [
  ...document.querySelectorAll<HTMLImageElement>('.pdf-print-root .pdf-print-page > img'),
];

function mount(
  viewer: ViewerApi | null = viewerOf(),
  options: Partial<Parameters<typeof usePrinting>[1]> = {},
) {
  return renderHook(() => usePrinting(viewer, { read, ...options }));
}

async function startAndPrint(controller: { current: PrintController }, req: PrintRequest = request()) {
  act(() => controller.current.start(req));
  await waitFor(() => expect(controller.current.phase).toBe('printing'));
}

describe('usePrinting start', () => {
  it('renders each page through the source into one canvas, shows a sheet per page, then prints', async () => {
    const { result } = mount();
    expect(result.current.phase).toBe('idle');
    await startAndPrint(result);
    expect(source.getPageSize.mock.calls).toEqual([
      [0, 1],
      [2, 1],
    ]);
    expect(source.renderPage).toHaveBeenCalledTimes(2);
    const first = source.renderPage.mock.calls[0] as [number, HTMLCanvasElement, Record<string, unknown>];
    const second = source.renderPage.mock.calls[1] as [number, HTMLCanvasElement, Record<string, unknown>];
    expect([first[0], second[0]]).toEqual([0, 2]);
    // One canvas for the whole job, twice the linear resolution.
    expect(first[1]).toBe(second[1]);
    expect(first[2]).toMatchObject({ devicePixelRatio: 2 });
    expect(first[2].signal).toBeInstanceOf(AbortSignal);
    expect(roots()).toHaveLength(1);
    expect(sheets().map((image) => image.getAttribute('src'))).toEqual(['blob:sheet-1', 'blob:sheet-2']);
    expect(result.current).toMatchObject({ phase: 'printing', done: 2, total: 2, failure: null });
    expect(printCalls).toBe(1);
  });

  it('fits a page to A4 and leaves its size to the stylesheet', async () => {
    const { result } = mount();
    await startAndPrint(result, request({ scale: 'fit', pages: [1] }));
    // A4 portrait is 793.7 × 1122.5 px: a 300 × 400 pt page is limited by the width.
    const options = must(source.renderPage.mock.calls[0])[2] as { scale: number };
    expect(options.scale).toBeCloseTo(((210 / 25.4) * 96) / 300, 9);
    expect(sheets()[0]?.style.width).toBe('');
    expect(sheets()[0]?.style.height).toBe('');
  });

  it('prints a small page at its own size when told to shrink to fit, a large one shrunk', async () => {
    const { result } = mount();
    await startAndPrint(result, request({ scale: 'shrink-to-fit', pages: [1] }));
    // 300 × 400 pt would be enlarged to fit A4: it stays at 100 % (4/3 px per point).
    const small = source.renderPage.mock.calls[0]?.[2] as { scale: number };
    expect(small.scale).toBeCloseTo(96 / 72, 9);
    expect(sheets()[0]?.style.width).toBe('400px');
    expect(sheets()[0]?.style.height).toBe('533px');
    act(() => result.current.cancel());
    source.getPageSize.mockResolvedValue({ width: 1200, height: 1600 });
    await startAndPrint(result, request({ scale: 'shrink-to-fit', pages: [1] }));
    const large = source.renderPage.mock.calls[1]?.[2] as { scale: number };
    expect(large.scale).toBeCloseTo(((210 / 25.4) * 96) / 1200, 9);
    expect(sheets()[0]?.style.width).toBe('794px');
  });

  it('prints at 100 % for actual size, however large the page is', async () => {
    source.getPageSize.mockResolvedValue({ width: 1200, height: 1600 });
    const { result } = mount();
    await startAndPrint(result, request({ scale: 'actual', pages: [2] }));
    const options = source.renderPage.mock.calls[0]?.[2] as { scale: number };
    expect(options.scale).toBeCloseTo(96 / 72, 9);
    expect(sheets()[0]?.style.width).toBe('1600px');
    expect(sheets()[0]?.style.height).toBe('2133px');
  });

  it('reports the pages rendered so far while it works', async () => {
    const gate = Promise.withResolvers<void>();
    blobGate = gate.promise;
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(result.current.phase).toBe('preparing'));
    expect(result.current).toMatchObject({ done: 0, total: 2 });
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(result.current.phase).toBe('printing'));
  });

  it('removes the sheets and the object URLs, and calls back, when the browser has printed', async () => {
    const onFinished = vi.fn();
    const { result } = mount(viewerOf(), { onFinished });
    await startAndPrint(result);
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(roots()).toHaveLength(0);
    expect(revoked).toEqual(['blob:sheet-1', 'blob:sheet-2']);
    expect(result.current).toMatchObject({ phase: 'idle', done: 0, total: 0 });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it('finishes quietly after printing when nobody asked to be told', async () => {
    const { result } = mount();
    await startAndPrint(result);
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
    expect(result.current.phase).toBe('idle');
  });

  it('does nothing without a page source or without pages', () => {
    const noSource = mount(viewerOf(null));
    act(() => noSource.result.current.start(request()));
    expect(noSource.result.current.phase).toBe('idle');
    const noViewer = mount(null);
    act(() => noViewer.result.current.start(request()));
    expect(noViewer.result.current.phase).toBe('idle');
    const noPages = mount();
    act(() => noPages.result.current.start(request({ pages: [] })));
    expect(noPages.result.current.phase).toBe('idle');
    expect(roots()).toHaveLength(0);
    expect(source.getPageSize).not.toHaveBeenCalled();
  });

  it('replaces a job in flight rather than stacking sheets beside it', async () => {
    const { result } = mount();
    await startAndPrint(result);
    await startAndPrint(result, request({ pages: [2] }));
    expect(roots()).toHaveLength(1);
    expect(sheets()).toHaveLength(1);
    // The first job's sheets and URLs went with it.
    expect(revoked).toEqual(['blob:sheet-1', 'blob:sheet-2']);
  });
});

describe('usePrinting working bytes', () => {
  it('renders from a copy of the working bytes, not from the viewer’s engine document, and frees the copy', async () => {
    const live = {
      ...source,
      renderPage: vi.fn(async () => undefined),
      getPageSize: vi.fn(async () => LETTER_ISH),
    };
    const { result } = mount(viewerOf(live));
    await startAndPrint(result);
    expect(read).toHaveBeenCalledExactlyOnceWith({ signal: expect.any(AbortSignal) });
    expect(openArgs[0]?.[0]).toBe(WORKING);
    expect(source.renderPage).toHaveBeenCalledTimes(2);
    expect(live.renderPage).not.toHaveBeenCalled();
    expect(source.destroy).toHaveBeenCalledOnce();
  });

  it('renders a protected document from the engine document, which then is the working version', async () => {
    const live = {
      ...source,
      renderPage: vi.fn(async () => undefined),
      getPageSize: vi.fn(async () => LETTER_ISH),
    };
    opened.open = async () => {
      throw new ToolError('password-required', { engine: 'pdfjs' });
    };
    const { result } = mount(viewerOf(live));
    await startAndPrint(result);
    expect(live.renderPage).toHaveBeenCalledTimes(2);
    expect(source.renderPage).not.toHaveBeenCalled();
  });

  it('reports the engine’s own error when the working bytes cannot be read, and prints nothing', async () => {
    const failure = new ToolError('internal', { engine: 'model' });
    read.mockRejectedValueOnce(failure);
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(result.current.failure).toEqual({ kind: 'document', error: failure }));
    expect(result.current).toMatchObject({ phase: 'idle', done: 0, total: 2 });
    expect(roots()).toHaveLength(0);
    expect(source.renderPage).not.toHaveBeenCalled();
    expect(printCalls).toBe(0);
  });

  it('words an unexpected failure of the copy as an internal error', async () => {
    opened.open = async () => {
      throw new Error('boom');
    };
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(result.current.failure?.kind).toBe('document'));
    expect((result.current.failure as { error: ToolError }).error.code).toBe('internal');
  });

  it('draws nothing, reports nothing and frees the copy when cancelled while the bytes are read', async () => {
    const gate = Promise.withResolvers<Uint8Array>();
    read.mockImplementationOnce(() => gate.promise);
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    act(() => result.current.cancel());
    await act(async () => {
      gate.resolve(WORKING);
    });
    await waitFor(() => expect(source.destroy).toHaveBeenCalledOnce());
    expect(source.renderPage).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ phase: 'idle', failure: null });
  });

  it('stays quiet when the read fails because the job was cancelled', async () => {
    const gate = Promise.withResolvers<Uint8Array>();
    read.mockImplementationOnce(() => gate.promise);
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    act(() => result.current.cancel());
    await act(async () => {
      gate.reject(new Error('aborted'));
    });
    expect(result.current).toMatchObject({ phase: 'idle', failure: null });
  });

  it('frees the copy after a failed page too', async () => {
    source.renderPage.mockRejectedValueOnce(new Error('engine failed'));
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(result.current.failure).not.toBeNull());
    await waitFor(() => expect(source.destroy).toHaveBeenCalledOnce());
  });
});

describe('usePrinting ending a job early', () => {
  it('cancels a job: the sheets go, nothing is printed, the state is idle again', async () => {
    const gate = Promise.withResolvers<void>();
    source.renderPage.mockImplementationOnce(() => gate.promise);
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(source.renderPage).toHaveBeenCalledTimes(1));
    const signal = (must(source.renderPage.mock.calls[0])[2] as { signal: AbortSignal }).signal;
    act(() => result.current.cancel());
    expect(signal.aborted).toBe(true);
    expect(roots()).toHaveLength(0);
    expect(result.current.phase).toBe('idle');
    await act(async () => {
      gate.resolve();
    });
    // The render that was running finishes into a job that is gone.
    expect(source.renderPage).toHaveBeenCalledTimes(1);
    expect(printCalls).toBe(0);
    expect(canvases).toHaveLength(0);
  });

  it('does not report a failure when the renderer rejects because the job was cancelled', async () => {
    const gate = Promise.withResolvers<void>();
    source.renderPage.mockImplementationOnce(() => gate.promise);
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(source.renderPage).toHaveBeenCalledTimes(1));
    act(() => result.current.cancel());
    await act(async () => {
      gate.reject(new Error('rendering cancelled'));
    });
    expect(result.current).toMatchObject({ phase: 'idle', failure: null });
    expect(printCalls).toBe(0);
  });

  it('stops before the next page when cancelled while a page is being turned into an image', async () => {
    const gate = Promise.withResolvers<void>();
    blobGate = gate.promise;
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(canvases).toHaveLength(1));
    act(() => result.current.cancel());
    await act(async () => {
      gate.resolve();
    });
    expect(source.renderPage).toHaveBeenCalledTimes(1);
    expect(printCalls).toBe(0);
    expect(result.current.phase).toBe('idle');
    // The image that was being made is not kept.
    expect(revoked).toEqual(['blob:sheet-1']);
    expect(roots()).toHaveLength(0);
  });

  it('does not print when cancelled while the images decode', async () => {
    const gate = Promise.withResolvers<void>();
    decodeGate = gate.promise;
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(sheets()).toHaveLength(2));
    act(() => result.current.cancel());
    await act(async () => {
      gate.resolve();
    });
    expect(printCalls).toBe(0);
    expect(result.current).toMatchObject({ phase: 'idle', failure: null });
  });

  it('has nothing to cancel when nothing runs', () => {
    const { result } = mount();
    act(() => result.current.cancel());
    expect(result.current.phase).toBe('idle');
  });

  it('ends the job when the caller’s signal aborts', async () => {
    const outside = new AbortController();
    const { result } = mount(viewerOf(), { signal: outside.signal });
    await startAndPrint(result);
    act(() => outside.abort());
    expect(roots()).toHaveLength(0);
    expect(revoked).toEqual(['blob:sheet-1', 'blob:sheet-2']);
    expect(result.current.phase).toBe('idle');
    expect(printCalls).toBe(1);
  });

  it('removes the sheets and revokes the URLs when the component unmounts', async () => {
    const { result, unmount } = mount();
    await startAndPrint(result);
    unmount();
    expect(roots()).toHaveLength(0);
    expect(revoked).toEqual(['blob:sheet-1', 'blob:sheet-2']);
  });

  it('unmounts cleanly when nothing ran', () => {
    const { unmount } = mount();
    unmount();
    expect(roots()).toHaveLength(0);
  });
});

describe('usePrinting failures', () => {
  it('names the page that could not be rendered and takes the sheets away', async () => {
    source.renderPage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('engine failed'));
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(result.current.failure).toEqual({ kind: 'page', page: 3 }));
    expect(result.current).toMatchObject({ phase: 'idle', done: 1, total: 2 });
    expect(roots()).toHaveLength(0);
    expect(revoked).toEqual(['blob:sheet-1']);
    expect(printCalls).toBe(0);
  });

  it('names the page whose image could not be made', async () => {
    blobFailsAt = 1;
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(result.current.failure).toEqual({ kind: 'page', page: 1 }));
    expect(result.current.done).toBe(0);
  });

  it('names the last page when the finished sheets cannot be decoded', async () => {
    decodeFails = true;
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(result.current.failure).toEqual({ kind: 'page', page: 3 }));
    expect(result.current.done).toBe(2);
    expect(roots()).toHaveLength(0);
    expect(printCalls).toBe(0);
  });

  it('starts a new job with the failure cleared', async () => {
    source.renderPage.mockRejectedValueOnce(new Error('engine failed'));
    const { result } = mount();
    act(() => result.current.start(request()));
    await waitFor(() => expect(result.current.failure).not.toBeNull());
    await startAndPrint(result);
    expect(result.current.failure).toBeNull();
  });
});

describe('usePrinting produce', () => {
  it('imposes the working bytes the shell reads and returns the file, with 0-based pages and A4 paper', async () => {
    const { result } = mount();
    let bytes: Uint8Array | null = null;
    await act(async () => {
      bytes = await result.current.produce(
        request({
          pages: [2, 4],
          perSheet: 2,
          booklet: false,
          duplex: 'long-edge',
          marginMm: 5,
          scale: 'shrink-to-fit',
        }),
      );
    });
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(impose.calls).toHaveLength(1);
    expect(read).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(impose.calls[0]?.bytes).toBe(WORKING);
    expect(impose.calls[0]?.options).toEqual({
      pages: [1, 3],
      perSheet: 2,
      booklet: false,
      duplex: 'long-edge',
      marginMm: 5,
      paper: 'a4',
      landscape: false,
      cropMarks: false,
      scale: 'shrink-to-fit',
    });
    expect(result.current.phase).toBe('idle');
  });

  it('passes the orientation and the crop marks when they are chosen', async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.produce(request({ landscape: true, cropMarks: true, booklet: true, perSheet: 4 }));
    });
    expect(impose.calls[0]?.options).toMatchObject({
      landscape: true,
      cropMarks: true,
      booklet: true,
      perSheet: 4,
    });
  });

  it('shows the progress the operation reports', async () => {
    const gate = Promise.withResolvers<void>();
    impose.gate = gate.promise;
    impose.progress = [{ done: 1, total: 5 }];
    const { result } = mount();
    let produced: Promise<Uint8Array | null> = Promise.resolve(null);
    act(() => {
      produced = result.current.produce(request());
    });
    await waitFor(() => expect(result.current).toMatchObject({ phase: 'producing', done: 1, total: 5 }));
    await act(async () => {
      gate.resolve();
      await produced;
    });
    expect(result.current.phase).toBe('idle');
  });

  it('counts from zero, out of the pages asked for, when the operation reports no numbers', async () => {
    const gate = Promise.withResolvers<void>();
    impose.gate = gate.promise;
    impose.progress = [{}];
    const { result } = mount();
    let produced: Promise<Uint8Array | null> = Promise.resolve(null);
    act(() => {
      produced = result.current.produce(request({ pages: [1, 2, 3] }));
    });
    await waitFor(() => expect(result.current).toMatchObject({ phase: 'producing', done: 0, total: 3 }));
    await act(async () => {
      gate.resolve();
      await produced;
    });
  });

  it('has nothing to produce without a source or without pages', async () => {
    const noSource = mount(viewerOf(null));
    expect(await noSource.result.current.produce(request())).toBeNull();
    const noViewer = mount(null);
    expect(await noViewer.result.current.produce(request())).toBeNull();
    const noPages = mount();
    expect(await noPages.result.current.produce(request({ pages: [] }))).toBeNull();
    expect(impose.calls).toEqual([]);
  });

  it('returns nothing when cancelled while the document is being saved', async () => {
    const gate = Promise.withResolvers<Uint8Array>();
    read.mockImplementationOnce(() => gate.promise);
    const { result } = mount();
    let produced: Promise<Uint8Array | null> = Promise.resolve(null);
    act(() => {
      produced = result.current.produce(request());
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    act(() => result.current.cancel());
    await act(async () => {
      gate.resolve(new Uint8Array([1]));
    });
    expect(await produced).toBeNull();
    expect(impose.calls).toEqual([]);
    expect(result.current.phase).toBe('idle');
  });

  it('returns nothing when cancelled as the operation finishes the sheets', async () => {
    const gate = Promise.withResolvers<void>();
    impose.gate = gate.promise;
    impose.finishesDespiteAbort = true;
    const { result } = mount();
    let produced: Promise<Uint8Array | null> = Promise.resolve(null);
    act(() => {
      produced = result.current.produce(request());
    });
    await waitFor(() => expect(impose.calls).toHaveLength(1));
    act(() => result.current.cancel());
    expect(impose.calls[0]?.signal.aborted).toBe(true);
    await act(async () => {
      gate.resolve();
    });
    expect(await produced).toBeNull();
  });

  it('returns nothing, instead of the abort error, when cancelled while the operation works', async () => {
    const gate = Promise.withResolvers<void>();
    impose.gate = gate.promise;
    const { result } = mount();
    let produced: Promise<Uint8Array | null> = Promise.resolve(null);
    act(() => {
      produced = result.current.produce(request());
    });
    await waitFor(() => expect(impose.calls).toHaveLength(1));
    act(() => result.current.cancel());
    expect(result.current.phase).toBe('idle');
    await act(async () => {
      gate.resolve();
    });
    expect(await produced).toBeNull();
    expect(result.current.phase).toBe('idle');
  });

  it('still rejects with a failure that is not a cancellation', async () => {
    const gate = Promise.withResolvers<void>();
    impose.gate = gate.promise;
    impose.failure = new Error('disk full');
    const { result } = mount();
    let produced: Promise<Uint8Array | null> = Promise.resolve(null);
    act(() => {
      produced = result.current.produce(request());
    });
    await waitFor(() => expect(impose.calls).toHaveLength(1));
    const rejection = expect(produced).rejects.toBe(impose.failure);
    await act(async () => {
      gate.resolve();
    });
    await rejection;
  });

  it('leaves the phase of a print job that replaced the production when the production ends', async () => {
    const gate = Promise.withResolvers<void>();
    impose.gate = gate.promise;
    const sheets = Promise.withResolvers<void>();
    blobGate = sheets.promise;
    const { result } = mount();
    let produced: Promise<Uint8Array | null> = Promise.resolve(null);
    act(() => {
      produced = result.current.produce(request());
    });
    await waitFor(() => expect(impose.calls).toHaveLength(1));
    act(() => result.current.start(request()));
    await waitFor(() => expect(canvases).toHaveLength(1));
    expect(result.current.phase).toBe('preparing');
    await act(async () => {
      gate.resolve();
    });
    expect(await produced).toBeNull();
    expect(result.current.phase).toBe('preparing');
    await act(async () => {
      sheets.resolve();
    });
  });

  it('lets a second production take over from the first, which then returns nothing', async () => {
    const gate = Promise.withResolvers<void>();
    impose.gate = gate.promise;
    const { result } = mount();
    let first: Promise<Uint8Array | null> = Promise.resolve(null);
    let second: Promise<Uint8Array | null> = Promise.resolve(null);
    act(() => {
      first = result.current.produce(request());
    });
    await waitFor(() => expect(impose.calls).toHaveLength(1));
    act(() => {
      second = result.current.produce(request({ pages: [1] }));
    });
    await waitFor(() => expect(impose.calls).toHaveLength(2));
    await act(async () => {
      gate.resolve();
    });
    expect(await first).toBeNull();
    expect(await second).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.current.phase).toBe('idle');
  });

  it('stops a production still running when the component unmounts', async () => {
    const gate = Promise.withResolvers<void>();
    impose.gate = gate.promise;
    const { result, unmount } = mount();
    let produced: Promise<Uint8Array | null> = Promise.resolve(null);
    act(() => {
      produced = result.current.produce(request());
    });
    await waitFor(() => expect(impose.calls).toHaveLength(1));
    unmount();
    expect(impose.calls[0]?.signal.aborted).toBe(true);
    gate.resolve();
    expect(await produced).toBeNull();
  });

  it('rejects with the operation’s own error and returns to idle', async () => {
    impose.failure = new ToolError('internal', { engine: 'ui', engineMessage: 'impossible layout' });
    const { result } = mount();
    await act(async () => {
      await expect(result.current.produce(request())).rejects.toBe(impose.failure);
    });
    expect(result.current.phase).toBe('idle');
  });

  it('replaces sheets in flight when production starts', async () => {
    const { result } = mount();
    await startAndPrint(result);
    await act(async () => {
      await result.current.produce(request());
    });
    expect(roots()).toHaveLength(0);
  });
});
