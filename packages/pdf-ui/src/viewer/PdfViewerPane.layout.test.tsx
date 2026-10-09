// @vitest-environment happy-dom
/**
 * The pane's layout notification for a new stack. The overlays place their marks against the
 * pages as they are laid out, and the shell counts each layout in a revision the pane raises
 * through `onLayoutChange`. The pane raises it when the size of its pages moves, and once more
 * when a stack's pages have been laid out: a half turn rebuilds the stack at the size the pane
 * measured last, so nothing on the size could tell the overlays the pages are new.
 *
 * pdf.js is a stand-in that only speaks the events the pane listens to, and the frame clock is
 * driven by hand; `ResizeObserver` never fires, which is the case under test: no size moved.
 */

import { act, cleanup, render } from '@testing-library/react';
import type { PdfDocumentHandle } from 'pdf-core';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfViewerPane } from './PdfViewerPane';

const engine = vi.hoisted(() => {
  type Listener = (payload: unknown) => void;
  const buses: FakeEventBus[] = [];
  class FakeEventBus {
    private readonly listeners = new Map<string, Set<Listener>>();
    constructor() {
      buses.push(this);
    }
    on(name: string, listener: Listener): void {
      const known = this.listeners.get(name) ?? new Set<Listener>();
      known.add(listener);
      this.listeners.set(name, known);
    }
    off(name: string, listener: Listener): void {
      this.listeners.get(name)?.delete(listener);
    }
    dispatch(name: string, payload: unknown = {}): void {
      for (const listener of [...(this.listeners.get(name) ?? [])]) listener(payload);
    }
  }
  class FakeLinkService {
    setViewer(): void {}
    setDocument(): void {}
  }
  class FakeFindController {}
  class FakePdfViewer {
    currentScaleValue = '';
    currentScale = 1;
    currentPageNumber = 1;
    spreadMode = 0;
    pagesCount = 0;
    getPageView(): undefined {
      return undefined;
    }
    setDocument(): void {}
    update(): void {}
    cleanup(): void {}
  }
  return { buses, FakeEventBus, FakeLinkService, FakeFindController, FakePdfViewer };
});

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  EventBus: engine.FakeEventBus,
  PDFLinkService: engine.FakeLinkService,
  PDFFindController: engine.FakeFindController,
  PDFViewer: engine.FakePdfViewer,
}));
vi.mock('pdfjs-dist/web/pdf_viewer.css', () => ({}));

const t = createTranslator('en');
const handleOf = (id: string) =>
  ({ id, raw: {}, fingerprint: 'fingerprint', pageCount: 1 }) as unknown as PdfDocumentHandle;

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

/** Runs every frame requested so far (and none requested by those), as one tick of the clock. */
const tick = () =>
  act(async () => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(0);
  });

/** The event bus of the nth stack the pane built, once the pane has built it. */
const busOf = async (index: number) => {
  await act(async () => {
    await vi.waitFor(() => expect(engine.buses.length).toBeGreaterThan(index));
  });
  const bus = engine.buses[index];
  if (bus === undefined) throw new Error(`the pane built no stack ${index}`);
  return bus;
};

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frameId += 1;
    frames.set(frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  engine.buses.length = 0;
  frames.clear();
});

describe('PdfViewerPane layout notification', () => {
  it('tells the overlays once after a new stack lays out its pages, whatever the size', async () => {
    const onLayoutChange = vi.fn();
    const pane = (document: PdfDocumentHandle) => (
      <PdfViewerPane document={document} documentKey="tab" t={t} onLayoutChange={onLayoutChange} />
    );
    const { rerender } = render(pane(handleOf('upright')));
    const first = await busOf(0);
    // The pane's own first measure of its empty slots; no later size ever moves.
    await tick();
    const opened = onLayoutChange.mock.calls.length;

    await act(async () => first.dispatch('pagesinit'));
    await tick();
    expect(onLayoutChange).toHaveBeenCalledTimes(opened + 1);

    // A page turned: the same document rewritten builds a stack in the other slot, and the
    // painted one stays until it has pixels. The pages are laid out at a size already measured.
    await act(async () => first.dispatch('pagerendered', { pageNumber: 1 }));
    rerender(pane(handleOf('turned')));
    const second = await busOf(1);
    await tick();
    const rewritten = onLayoutChange.mock.calls.length;

    await act(async () => second.dispatch('pagesinit'));
    expect(onLayoutChange).toHaveBeenCalledTimes(rewritten);
    await tick();
    expect(onLayoutChange).toHaveBeenCalledTimes(rewritten + 1);
    await tick();
    expect(onLayoutChange).toHaveBeenCalledTimes(rewritten + 1);
  });

  it('says nothing for a pane that unmounted between the layout and the frame', async () => {
    const onLayoutChange = vi.fn();
    const { unmount } = render(
      <PdfViewerPane
        document={handleOf('upright')}
        documentKey="tab"
        t={t}
        onLayoutChange={onLayoutChange}
      />,
    );
    const bus = await busOf(0);
    await tick();
    const opened = onLayoutChange.mock.calls.length;

    await act(async () => bus.dispatch('pagesinit'));
    unmount();
    await tick();
    expect(onLayoutChange).toHaveBeenCalledTimes(opened);
  });

  it('says nothing for a stack a rewrite froze between the layout and the frame, and still does for its replacement', async () => {
    const onLayoutChange = vi.fn();
    const pane = (document: PdfDocumentHandle) => (
      <PdfViewerPane document={document} documentKey="tab" t={t} onLayoutChange={onLayoutChange} />
    );
    const { rerender } = render(pane(handleOf('upright')));
    const first = await busOf(0);
    await tick();
    const opened = onLayoutChange.mock.calls.length;

    // The first stack has laid out and painted, and the document is rewritten before the frame.
    await act(async () => first.dispatch('pagesinit'));
    await act(async () => first.dispatch('pagerendered', { pageNumber: 1 }));
    rerender(pane(handleOf('turned')));
    const second = await busOf(1);
    await tick();
    expect(onLayoutChange).toHaveBeenCalledTimes(opened);

    await act(async () => second.dispatch('pagesinit'));
    await tick();
    expect(onLayoutChange).toHaveBeenCalledTimes(opened + 1);
  });

  it('keeps working without a layout callback', async () => {
    const onReady = vi.fn();
    render(<PdfViewerPane document={handleOf('upright')} documentKey="tab" t={t} onReady={onReady} />);
    const bus = await busOf(0);
    await tick();

    await act(async () => bus.dispatch('pagesinit'));
    await tick();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ getZoom: expect.any(Function) }));
  });
});
