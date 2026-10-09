// @vitest-environment happy-dom
/**
 * The pdf.js viewer host. pdf.js's viewer stack is faked at the module seam the pane loads it
 * through (`pdfjs-dist/web/pdf_viewer.mjs`): an event bus that really dispatches, a viewer that
 * records what the pane assigns and answers the page views a test lays out, and a document
 * handle whose `raw` carries a fake annotation storage. What the tests assert is what the shell
 * consumes: the api handed to `onReady`, the callbacks, the find bar and the overlay host.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PDFJS_ASSETS } from 'pdf-core/assets';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { PdfViewerPane, type PdfViewerPaneProps, type ViewerApi } from './PdfViewerPane';

interface PageViewFake {
  readonly div: HTMLDivElement;
  readonly viewport: {
    readonly viewBox: number[];
    readonly rotation: number;
    convertToPdfPoint(x: number, y: number): number[];
  };
}

interface ViewerFake {
  readonly options: { container: HTMLDivElement; viewer: HTMLDivElement } & Record<string, unknown>;
  currentScale: number;
  currentScaleValue: string | null;
  currentPageNumber: number;
  spreadMode: number;
  pagesCount: number;
  optionalContentConfigPromise: Promise<unknown> | null;
  pageViews: (PageViewFake | undefined)[];
  readonly documents: unknown[];
  readonly scaleValues: (string | null)[];
  readonly pageNumbers: number[];
  cleanups: number;
  updates: number;
}

interface BusFake {
  readonly dispatched: { readonly name: string; readonly payload: unknown }[];
  dispatch(name: string, payload?: unknown): void;
  listenerCount(name: string): number;
}

interface LinkServiceFake {
  readonly options: Record<string, unknown>;
  viewer: unknown;
  readonly documents: unknown[];
}

const stage = vi.hoisted(() => {
  type Listener = (payload: unknown) => void;

  class EventBus {
    readonly handlers = new Map<string, Set<Listener>>();
    readonly dispatched: { name: string; payload: unknown }[] = [];
    constructor() {
      stage.buses.push(this);
    }
    on(name: string, listener: Listener) {
      const set = this.handlers.get(name) ?? new Set<Listener>();
      set.add(listener);
      this.handlers.set(name, set);
    }
    off(name: string, listener: Listener) {
      this.handlers.get(name)?.delete(listener);
    }
    dispatch(name: string, payload?: unknown) {
      this.dispatched.push({ name, payload });
      for (const listener of [...(this.handlers.get(name) ?? [])]) listener(payload);
    }
    listenerCount(name: string) {
      return this.handlers.get(name)?.size ?? 0;
    }
  }

  class PDFLinkService {
    viewer: unknown = null;
    readonly documents: unknown[] = [];
    constructor(readonly options: Record<string, unknown>) {
      stage.links.push(this);
    }
    setViewer(viewer: unknown) {
      this.viewer = viewer;
    }
    setDocument(document: unknown) {
      this.documents.push(document);
    }
  }

  class PDFFindController {
    constructor(readonly options: Record<string, unknown>) {}
  }

  class PDFViewer {
    currentScale = 1;
    currentPageNumber = 1;
    spreadMode = 0;
    pagesCount = 0;
    optionalContentConfigPromise: Promise<unknown> | null = null;
    pageViews: (unknown | undefined)[] = [];
    readonly documents: unknown[] = [];
    readonly scaleValues: (string | null)[] = [];
    readonly pageNumbers: number[] = [];
    cleanups = 0;
    updates = 0;
    #scaleValue: string | null = null;
    constructor(readonly options: Record<string, unknown>) {
      stage.viewers.push(this);
    }
    get currentScaleValue() {
      return this.#scaleValue;
    }
    set currentScaleValue(value: string | null) {
      this.#scaleValue = value;
      this.scaleValues.push(value);
    }
    setDocument(document: { numPages?: number } | null) {
      this.documents.push(document);
      this.pagesCount = document?.numPages ?? 0;
    }
    getPageView(index: number) {
      return this.pageViews[index];
    }
    cleanup() {
      this.cleanups += 1;
    }
    update() {
      this.updates += 1;
    }
  }

  return {
    EventBus,
    PDFLinkService,
    PDFFindController,
    PDFViewer,
    viewers: [] as unknown[],
    buses: [] as unknown[],
    links: [] as unknown[],
  };
});

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => ({
  EventBus: stage.EventBus,
  PDFLinkService: stage.PDFLinkService,
  PDFFindController: stage.PDFFindController,
  PDFViewer: stage.PDFViewer,
}));

// The stylesheet ships with the engine chunk; the pane only needs the import to settle.
vi.mock('pdfjs-dist/web/pdf_viewer.css', () => ({}));

const viewers = () => stage.viewers as ViewerFake[];
const buses = () => stage.buses as BusFake[];
const links = () => stage.links as LinkServiceFake[];
const t = createTranslator('en');

interface StorageFake {
  onSetModified: (() => void) | null;
  onAnnotationEditor: ((type: string | null) => void) | null;
  serializable: { map: unknown };
  setValue: Mock;
  remove: Mock;
}

interface DocumentFake {
  readonly handle: PdfDocumentHandle;
  readonly storage: StorageFake;
}

let documentCount = 0;
function makeDocument(options: { pageCount?: number; fingerprint?: string | null } = {}): DocumentFake {
  documentCount += 1;
  const pageCount = options.pageCount ?? 3;
  const storage: StorageFake = {
    onSetModified: null,
    onAnnotationEditor: null,
    serializable: { map: null },
    setValue: vi.fn(),
    remove: vi.fn(),
  };
  const config = { name: `config-${documentCount}` };
  const handle = {
    pageCount,
    fingerprint: options.fingerprint === undefined ? `fp-${documentCount}` : options.fingerprint,
    raw: { numPages: pageCount, annotationStorage: storage, getOptionalContentConfig: async () => config },
  } as unknown as PdfDocumentHandle;
  return { handle, storage };
}

/** Animation frames run by hand. */
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const runFrames = () =>
  act(() => {
    const pending = [...frames];
    frames.clear();
    for (const [, callback] of pending) callback(0);
  });

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
}

beforeEach(() => {
  stage.viewers.length = 0;
  stage.buses.length = 0;
  stage.links.length = 0;
  frames.clear();
  nextFrame = 1;
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Callbacks {
  readonly onReady: Mock;
  readonly onDocumentReleased: Mock;
  readonly onCurrentPageChange: Mock;
  readonly onScaleChange: Mock;
  readonly onModifiedChange: Mock;
  readonly onLayoutChange: Mock;
}

function callbacks(): Callbacks {
  return {
    onReady: vi.fn(),
    onDocumentReleased: vi.fn(),
    onCurrentPageChange: vi.fn(),
    onScaleChange: vi.fn(),
    onModifiedChange: vi.fn(),
    onLayoutChange: vi.fn(),
  };
}

/** Lets the pane's dynamic import of the viewer stack finish, with its state updates inside `act`. */
const settle = (until: () => void) => act(async () => void (await vi.waitFor(until)));

interface Pane extends Callbacks {
  readonly rerender: (props: Partial<PdfViewerPaneProps>) => void;
  readonly unmount: () => void;
  readonly container: HTMLElement;
  /** The `.pdfViewer` slots: the first and the spare. */
  readonly slots: readonly [HTMLElement, HTMLElement];
  readonly host: HTMLElement;
}

function paneProps(
  handle: PdfDocumentHandle,
  cb: Callbacks,
  props: Partial<PdfViewerPaneProps>,
): PdfViewerPaneProps {
  return { document: handle, documentKey: 'tab-1', t, ...cb, ...props };
}

/** Mounts the pane without waiting for the viewer stack. */
function mountNow(doc: DocumentFake, props: Partial<PdfViewerPaneProps> = {}): Pane {
  const cb = callbacks();
  const view = render(<PdfViewerPane {...paneProps(doc.handle, cb, props)} />);
  const host = document.querySelector('[data-viewer-overlay]') as HTMLElement;
  const container = host.parentElement as HTMLElement;
  return {
    ...cb,
    container,
    host,
    slots: [...container.querySelectorAll<HTMLElement>('.pdfViewer')] as unknown as readonly [
      HTMLElement,
      HTMLElement,
    ],
    rerender: (next) =>
      view.rerender(<PdfViewerPane {...paneProps(doc.handle, cb, { ...props, ...next })} />),
    unmount: view.unmount,
  };
}

/** Mounts the pane and waits until its first stack has been published. */
async function mount(
  doc: DocumentFake = makeDocument(),
  props: Partial<PdfViewerPaneProps> = {},
): Promise<Pane> {
  const pane = mountNow(doc, props);
  await settle(() => expect(pane.onReady).toHaveBeenCalledTimes(1));
  return pane;
}

/** The api published by the latest `onReady` call. */
const apiOf = (pane: Pane) => pane.onReady.mock.calls.at(-1)?.[0] as ViewerApi;
const lastViewer = () => viewers().at(-1) as ViewerFake;
const lastBus = () => buses().at(-1) as BusFake;
const emit = (bus: BusFake, name: string, payload?: unknown) => act(() => bus.dispatch(name, payload));

/** A page view whose element sits at `rect`, with a transparent border of `border` px. */
function pageView(
  rect: DOMRect,
  options: {
    border?: number;
    viewBox?: number[];
    rotation?: number;
    content?: { width: number; height: number };
  } = {},
): PageViewFake {
  const div = document.createElement('div') as HTMLDivElement;
  const border = options.border ?? 0;
  div.getBoundingClientRect = () => rect;
  Object.defineProperties(div, {
    clientLeft: { value: border },
    clientTop: { value: border },
    clientWidth: { value: options.content?.width ?? rect.width - 2 * border },
    clientHeight: { value: options.content?.height ?? rect.height - 2 * border },
  });
  return {
    div,
    viewport: {
      viewBox: options.viewBox ?? [0, 0, 600, 800],
      rotation: options.rotation ?? 0,
      // A 2 pt-per-pixel viewport on a 800 pt tall page, y up.
      convertToPdfPoint: (x, y) => [x * 2, 800 - y * 2],
    },
  };
}

/** Gives the container a rectangle and scroll geometry, as layout would. */
function layOut(
  element: HTMLElement,
  values: Partial<
    Record<
      | 'clientWidth'
      | 'clientHeight'
      | 'scrollWidth'
      | 'scrollHeight'
      | 'clientLeft'
      | 'clientTop'
      | 'scrollLeft'
      | 'scrollTop'
      | 'offsetTop'
      | 'offsetHeight',
      number
    >
  >,
  rect?: DOMRect,
) {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(element, name, { configurable: true, writable: true, value });
  }
  if (rect !== undefined) element.getBoundingClientRect = () => rect;
}

describe('the viewer stack', () => {
  it('builds pdf.js with the editors off and one page at the first slot, and publishes the api', async () => {
    const doc = makeDocument();
    const pane = await mount(doc);
    const viewer = lastViewer();
    expect(viewer.options).toMatchObject({
      annotationMode: 2,
      annotationEditorMode: -1,
      imageResourcesPath: PDFJS_ASSETS.images,
      maxCanvasPixels: 4 * 1024 * 1024,
    });
    // Identity, not `toMatchObject`: its subset walk would recurse into the happy-dom elements.
    expect(viewer.options.container).toBe(pane.container);
    expect(viewer.options.viewer).toBe(pane.slots[0]);
    expect(links()[0]?.options).toMatchObject({ externalLinkTarget: 2 });
    expect(links()[0]?.viewer).toBe(viewer);
    expect(viewer.documents).toEqual([doc.handle.raw]);
    expect(links()[0]?.documents).toEqual([doc.handle.raw]);
    expect(pane.slots[0].hasAttribute('data-active-viewer')).toBe(true);
    expect(pane.slots[1].hasAttribute('data-active-viewer')).toBe(false);
    expect(apiOf(pane).document).toBe(doc.handle);
  });

  it('says it is preparing the pages, and keeps the overlay hidden, until a page is painted', async () => {
    const pane = await mount(makeDocument(), { overlay: <span>mark</span> });
    expect(screen.getByRole('status').textContent).toBe('Preparing pages…');
    expect(pane.host.style.visibility).toBe('hidden');
    expect(screen.getByText('mark').parentElement).toBe(pane.host);
    emit(lastBus(), 'pagerendered', { pageNumber: 1 });
    expect(screen.queryByRole('status')).toBeNull();
    expect(pane.host.style.visibility).toBe('');
  });

  it('does not wait for a paint that will never come on a document without pages', async () => {
    await mount(makeDocument({ pageCount: 0 }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('starts every new document at fit-width and tells the viewer to update', async () => {
    await mount();
    emit(lastBus(), 'pagesinit');
    expect(lastViewer().scaleValues).toEqual(['page-width']);
    expect(lastViewer().updates).toBe(1);
  });

  it('reports the page and the scale pdf.js changes to', async () => {
    const pane = await mount();
    emit(lastBus(), 'pagechanging', { pageNumber: 4 });
    emit(lastBus(), 'scalechanging', { scale: 1.75 });
    expect(pane.onCurrentPageChange).toHaveBeenCalledExactlyOnceWith(3);
    expect(pane.onScaleChange).toHaveBeenCalledExactlyOnceWith(1.75);
  });

  it('tells the shell the viewer is gone on unmount, and gives the engine its document back', async () => {
    const doc = makeDocument();
    const pane = await mount(doc);
    const viewer = lastViewer();
    pane.unmount();
    expect(pane.onReady).toHaveBeenLastCalledWith(null);
    expect(pane.onDocumentReleased).toHaveBeenCalledExactlyOnceWith(doc.handle);
    expect(viewer.documents).toEqual([doc.handle.raw, null]);
    expect(viewer.cleanups).toBe(1);
    expect(lastBus().listenerCount('pagesinit')).toBe(0);
  });

  // Not a rerender: vitest's mocker treats two overlapping imports of one mocked module as a
  // circular import and hands the second the real pdf.js, so the superseded run is ended by an unmount.
  it('builds nothing for a pane that is gone before the engine finished loading', async () => {
    const pane = mountNow(makeDocument());
    pane.unmount();
    const elapsed = Promise.withResolvers<void>();
    setTimeout(elapsed.resolve, 20);
    await act(() => elapsed.promise);
    expect(viewers()).toHaveLength(0);
    expect(buses()).toHaveLength(0);
    expect(pane.onReady.mock.calls).toEqual([[null]]);
  });

  it('drops the previous stack and starts again when the document changes for good', async () => {
    const first = makeDocument();
    const pane = await mount(first);
    emit(lastBus(), 'pagerendered', { pageNumber: 1 });
    const firstViewer = lastViewer();
    const second = makeDocument();
    pane.rerender({ document: second.handle, documentKey: 'tab-2' });
    expect(pane.onReady).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('status').textContent).toBe('Preparing pages…');
    expect(firstViewer.documents.at(-1)).toBeNull();
    expect(pane.onDocumentReleased).toHaveBeenCalledExactlyOnceWith(first.handle);
    await settle(() => expect(pane.onReady).toHaveBeenCalledTimes(3));
    expect(viewers()).toHaveLength(2);
    expect(pane.slots[0].hasAttribute('data-active-viewer')).toBe(true);
  });

  it('drops a stack that never painted instead of keeping empty pixels on screen', async () => {
    const first = makeDocument({ fingerprint: 'same' });
    const pane = await mount(first, { documentKey: undefined });
    const second = makeDocument({ fingerprint: 'same' });
    pane.rerender({ document: second.handle });
    expect(pane.onReady).toHaveBeenLastCalledWith(null);
    expect(pane.onDocumentReleased).toHaveBeenCalledExactlyOnceWith(first.handle);
  });

  it('cannot recognise a document without a key or a fingerprint, so a rewrite starts fresh', async () => {
    const first = makeDocument({ fingerprint: null });
    const pane = await mount(first, { documentKey: undefined });
    emit(lastBus(), 'pagerendered', { pageNumber: 1 });
    pane.rerender({ document: makeDocument({ fingerprint: null }).handle });
    expect(pane.onReady).toHaveBeenLastCalledWith(null);
    expect(pane.slots[0].style.position).toBe('');
  });
});

describe('a rewritten document', () => {
  async function rewritten() {
    const first = makeDocument();
    const pane = await mount(first);
    const firstViewer = lastViewer();
    const firstBus = lastBus();
    layOut(pane.container, { scrollLeft: 15 }, new DOMRect(0, 20, 800, 600));
    layOut(pane.slots[0], {}, new DOMRect(0, 0, 640, 2000));
    firstViewer.currentScaleValue = '1.5';
    firstViewer.currentPageNumber = 2;
    firstViewer.spreadMode = 1;
    firstViewer.pageViews = [undefined, pageView(new DOMRect(0, 120, 500, 700))];
    emit(firstBus, 'pagerendered', { pageNumber: 2 });
    const second = makeDocument();
    pane.rerender({ document: second.handle });
    await settle(() => expect(viewers()).toHaveLength(2));
    return { pane, first, second, firstViewer, firstBus, secondViewer: lastViewer(), secondBus: lastBus() };
  }

  it('freezes the painted stack in place and builds the replacement in the other slot', async () => {
    const { pane, firstBus } = await rewritten();
    const frozen = pane.slots[0].style;
    expect([
      frozen.position,
      frozen.top,
      frozen.left,
      frozen.width,
      frozen.zIndex,
      frozen.pointerEvents,
    ]).toEqual(['absolute', '0px', '0px', '640px', '0', 'none']);
    expect(lastViewer().options.viewer).toBe(pane.slots[1]);
    expect(pane.slots[0].hasAttribute('data-active-viewer')).toBe(false);
    expect(pane.slots[1].hasAttribute('data-active-viewer')).toBe(true);
    // The shell is not told the viewer went away across a write.
    expect(pane.onReady).not.toHaveBeenCalledWith(null);
    expect(firstBus.listenerCount('pagerendered')).toBeGreaterThan(0);
  });

  it('puts the reader back on the page, the zoom and the scroll offset they left', async () => {
    const { pane, secondViewer, secondBus } = await rewritten();
    // The remembered page sits 100 px below the container's top edge; the new page 2 is 40 px below.
    secondViewer.pageViews = [undefined, pageView(new DOMRect(0, 60, 500, 700))];
    const scrollTop = vi.fn();
    let top = 500;
    Object.defineProperty(pane.container, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
        scrollTop(value);
      },
    });
    emit(secondBus, 'pagesinit');
    expect(secondViewer.spreadMode).toBe(1);
    expect(secondViewer.scaleValues).toEqual(['1.5']);
    expect(secondViewer.pageNumbers).toEqual([]);
    expect(secondViewer.currentPageNumber).toBe(2);
    expect(scrollTop).toHaveBeenLastCalledWith(500 + (60 - 20) - 100);
    expect(pane.container.scrollLeft).toBe(15);
    expect(secondViewer.updates).toBe(1);
    // A frame later the geometry has settled and the offset is applied again.
    secondViewer.pageViews = [undefined, pageView(new DOMRect(0, 80, 500, 700))];
    runFrames();
    expect(scrollTop).toHaveBeenLastCalledWith(top);
    expect(top).toBe(500 + (60 - 20) - 100 + (80 - 20) - 100);
  });

  it.each([
    ['null', null, 'page-width'],
    ['empty', '', 'page-width'],
  ])('asks for fit-width when the remembered scale was %s', async (_name, scale, expected) => {
    const first = makeDocument();
    const pane = await mount(first);
    lastViewer().currentScaleValue = scale;
    emit(lastBus(), 'pagerendered', { pageNumber: 1 });
    pane.rerender({ document: makeDocument().handle });
    await settle(() => expect(viewers()).toHaveLength(2));
    emit(lastBus(), 'pagesinit');
    expect(lastViewer().scaleValues).toEqual([expected]);
  });

  it.each([
    ['past the end', 9, 3, 3],
    ['before the start', 0, 3, 1],
    ['into a document that lost all its pages', 2, 0, 1],
  ])('clamps a remembered page %s', async (_name, remembered, pagesCount, expected) => {
    const first = makeDocument();
    const pane = await mount(first);
    lastViewer().currentPageNumber = remembered;
    emit(lastBus(), 'pagerendered', { pageNumber: 1 });
    pane.rerender({ document: makeDocument({ pageCount: pagesCount }).handle });
    await settle(() => expect(viewers()).toHaveLength(2));
    emit(lastBus(), 'pagesinit');
    expect(lastViewer().currentPageNumber).toBe(expected);
  });

  it('keeps the offset alone when the remembered page has no view yet, or the pane is gone', async () => {
    const { pane, secondBus } = await rewritten();
    const scrollTop = vi.fn();
    Object.defineProperty(pane.container, 'scrollTop', { configurable: true, get: () => 0, set: scrollTop });
    emit(secondBus, 'pagesinit');
    expect(scrollTop).not.toHaveBeenCalled();
    pane.rerender({ document: makeDocument().handle, documentKey: 'tab-other' });
    runFrames();
    expect(scrollTop).not.toHaveBeenCalled();
  });

  it('forgets the remembered view when another document opens before it was used', async () => {
    const { pane } = await rewritten();
    pane.rerender({ document: makeDocument().handle, documentKey: 'tab-other' });
    await settle(() => expect(viewers()).toHaveLength(3));
    emit(lastBus(), 'pagesinit');
    expect(lastViewer().scaleValues).toEqual(['page-width']);
    expect(lastViewer().spreadMode).toBe(0);
  });

  it('forgets the remembered view when the new document cannot be recognised', async () => {
    const { pane } = await rewritten();
    pane.rerender({ document: makeDocument({ fingerprint: null }).handle, documentKey: undefined });
    await settle(() => expect(viewers()).toHaveLength(3));
    emit(lastBus(), 'pagesinit');
    expect(lastViewer().scaleValues).toEqual(['page-width']);
  });

  it('releases the frozen stack once the replacement has painted every page in view', async () => {
    const { pane, first, firstViewer, secondViewer, secondBus } = await rewritten();
    layOut(pane.container, {}, new DOMRect(0, 0, 800, 600));
    secondViewer.pagesCount = 4;
    secondViewer.pageViews = [
      pageView(new DOMRect(0, 0, 500, 400)),
      undefined,
      pageView(new DOMRect(0, 300, 500, 400)),
      pageView(new DOMRect(0, 900, 500, 400)),
    ];
    emit(secondBus, 'pagerendered', { pageNumber: 1, error: new Error('failed') });
    expect(pane.onDocumentReleased).not.toHaveBeenCalled();
    emit(secondBus, 'pagerendered', { pageNumber: 1 });
    // Page 3 is also in view and has not painted yet.
    expect(pane.onDocumentReleased).not.toHaveBeenCalled();
    expect(firstViewer.cleanups).toBe(0);
    emit(secondBus, 'pagerendered', { pageNumber: 3 });
    expect(pane.onDocumentReleased).toHaveBeenCalledExactlyOnceWith(first.handle);
    expect(firstViewer.documents.at(-1)).toBeNull();
    expect(firstViewer.cleanups).toBe(1);
    expect(pane.slots[0].style.cssText).toBe('');
    expect(secondBus.listenerCount('pagerendered')).toBe(1);
  });

  it('builds the next rewrite back in the first slot once the replacement in the second has painted', async () => {
    const { pane, first, firstViewer, secondViewer, secondBus } = await rewritten();
    layOut(pane.container, {}, new DOMRect(0, 0, 800, 600));
    secondViewer.pagesCount = 1;
    secondViewer.pageViews = [pageView(new DOMRect(0, 0, 500, 400))];
    emit(secondBus, 'pagerendered', { pageNumber: 1 });
    expect(pane.onDocumentReleased).toHaveBeenCalledExactlyOnceWith(first.handle);
    expect(firstViewer.documents.at(-1)).toBeNull();

    pane.rerender({ document: makeDocument().handle });
    await settle(() => expect(viewers()).toHaveLength(3));
    expect(lastViewer().options.viewer).toBe(pane.slots[0]);
    expect(pane.slots[0].hasAttribute('data-active-viewer')).toBe(true);
    expect(pane.slots[1].hasAttribute('data-active-viewer')).toBe(false);
    // The painted stack of the second slot is the one now held on screen.
    expect(pane.slots[1].style.position).toBe('absolute');
  });

  it('waits when no page in view has been laid out against the container', async () => {
    const { pane, secondViewer, secondBus } = await rewritten();
    layOut(pane.container, {}, new DOMRect(100, 100, 500, 500));
    secondViewer.pagesCount = 3;
    secondViewer.pageViews = [
      pageView(new DOMRect(100, -400, 500, 400)),
      pageView(new DOMRect(100, 700, 500, 400)),
      pageView(new DOMRect(700, 150, 500, 400)),
    ];
    emit(secondBus, 'pagerendered', { pageNumber: 1 });
    emit(secondBus, 'pagerendered', { pageNumber: 2 });
    emit(secondBus, 'pagerendered', { pageNumber: 3 });
    expect(pane.onDocumentReleased).not.toHaveBeenCalled();
  });

  it('takes a page left of the container for off screen too', async () => {
    const { pane, secondViewer, secondBus } = await rewritten();
    layOut(pane.container, {}, new DOMRect(500, 0, 500, 600));
    secondViewer.pagesCount = 1;
    secondViewer.pageViews = [pageView(new DOMRect(0, 0, 400, 400))];
    emit(secondBus, 'pagerendered', { pageNumber: 1 });
    expect(pane.onDocumentReleased).not.toHaveBeenCalled();
  });

  it('releases the frozen stack at once when the new document has no pages', async () => {
    const first = makeDocument();
    const pane = await mount(first);
    emit(lastBus(), 'pagerendered', { pageNumber: 1 });
    pane.rerender({ document: makeDocument({ pageCount: 0 }).handle });
    await settle(() => expect(viewers()).toHaveLength(2));
    expect(pane.onDocumentReleased).toHaveBeenCalledExactlyOnceWith(first.handle);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the first frozen stack on screen through a second rewrite that comes before the first replacement paints', async () => {
    const first = makeDocument();
    const pane = await mount(first);
    emit(lastBus(), 'pagerendered', { pageNumber: 1 });
    const firstViewer = lastViewer();
    pane.rerender({ document: makeDocument().handle });
    await settle(() => expect(viewers()).toHaveLength(2));
    const secondViewer = lastViewer();
    const third = makeDocument();
    pane.rerender({ document: third.handle });
    await settle(() => expect(viewers()).toHaveLength(3));
    // The unpainted second stack is dropped without releasing the one still frozen on screen.
    expect(secondViewer.documents.at(-1)).toBeNull();
    expect(firstViewer.documents.at(-1)).not.toBeNull();
    expect(pane.onDocumentReleased).toHaveBeenCalledOnce();
    expect(pane.slots[0].style.position).toBe('absolute');
    expect(lastViewer().options.viewer).toBe(pane.slots[1]);
  });

  it('lets a different document take the screen from a frozen stack', async () => {
    const { pane, first, firstViewer } = await rewritten();
    pane.rerender({ document: makeDocument().handle, documentKey: 'tab-other' });
    expect(firstViewer.documents.at(-1)).toBeNull();
    expect(pane.onDocumentReleased).toHaveBeenCalledWith(first.handle);
    expect(pane.onReady).toHaveBeenLastCalledWith(null);
  });

  it('disposes the frozen stack too when the pane unmounts', async () => {
    const { pane, first, firstViewer } = await rewritten();
    pane.unmount();
    expect(firstViewer.documents.at(-1)).toBeNull();
    expect(pane.onDocumentReleased).toHaveBeenCalledWith(first.handle);
    expect(pane.onReady).toHaveBeenLastCalledWith(null);
  });

  it('stops the frozen stack from speaking for the pane', async () => {
    const { pane, first, firstBus, secondBus } = await rewritten();
    emit(firstBus, 'pagechanging', { pageNumber: 5 });
    emit(firstBus, 'scalechanging', { scale: 3 });
    expect(pane.onCurrentPageChange).not.toHaveBeenCalled();
    expect(pane.onScaleChange).not.toHaveBeenCalled();
    first.storage.onSetModified?.();
    await act(async () => {});
    expect(pane.onModifiedChange).not.toHaveBeenCalled();
    emit(secondBus, 'pagechanging', { pageNumber: 2 });
    expect(pane.onCurrentPageChange).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('measures the overlay host from the slot the new stack draws in', async () => {
    const { pane } = await rewritten();
    layOut(pane.container, { clientWidth: 800, clientHeight: 600 });
    layOut(pane.slots[0], { scrollWidth: 1200, offsetTop: 0, offsetHeight: 5000 });
    layOut(pane.slots[1], { scrollWidth: 900, offsetTop: 10, offsetHeight: 1500 });
    runFrames();
    expect([pane.host.style.width, pane.host.style.height]).toEqual(['900px', '1510px']);
  });

  it('freezes a stack only once when it is replaced twice before the replacement paints', async () => {
    const first = makeDocument();
    const pane = await mount(first);
    emit(lastBus(), 'pagerendered', { pageNumber: 1 });
    pane.rerender({ document: makeDocument().handle });
    await settle(() => expect(viewers()).toHaveLength(2));
    pane.slots[0].style.width = '123px';
    pane.rerender({ document: makeDocument().handle });
    await settle(() => expect(viewers()).toHaveLength(3));
    expect(pane.slots[0].style.width).toBe('123px');
  });
});

describe('what the engine edits', () => {
  it('tells the shell once per burst of form input, and ignores events after the stack is gone', async () => {
    const pane = await mount();
    fireEvent.input(pane.container);
    fireEvent.change(pane.container);
    await act(async () => {});
    expect(pane.onModifiedChange).toHaveBeenCalledOnce();
    fireEvent.input(pane.container);
    await act(async () => {});
    expect(pane.onModifiedChange).toHaveBeenCalledTimes(2);
  });

  it('tells the shell about edits the annotation storage reports, keeping the hooks that were there', async () => {
    const doc = makeDocument();
    const previousModified = vi.fn();
    const previousEditor = vi.fn();
    doc.storage.onSetModified = previousModified;
    doc.storage.onAnnotationEditor = previousEditor;
    const pane = await mount(doc);
    doc.storage.onSetModified?.();
    doc.storage.onAnnotationEditor?.('highlight');
    await act(async () => {});
    expect(previousModified).toHaveBeenCalledOnce();
    expect(previousEditor).toHaveBeenCalledExactlyOnceWith('highlight');
    expect(pane.onModifiedChange).toHaveBeenCalledOnce();
    pane.unmount();
    expect(doc.storage.onSetModified).toBe(previousModified);
    expect(doc.storage.onAnnotationEditor).toBe(previousEditor);
  });

  it('works without hooks on the storage, and puts the storage back as it was', async () => {
    const doc = makeDocument();
    const pane = await mount(doc);
    doc.storage.onAnnotationEditor?.(null);
    await act(async () => {});
    expect(pane.onModifiedChange).toHaveBeenCalledOnce();
    pane.unmount();
    expect([doc.storage.onSetModified, doc.storage.onAnnotationEditor]).toEqual([null, null]);
  });

  it('does not report an edit when the stack went away before the report was delivered', async () => {
    const doc = makeDocument();
    const pane = await mount(doc);
    fireEvent.input(pane.container);
    pane.rerender({ document: makeDocument().handle, documentKey: 'tab-other' });
    await act(async () => {});
    expect(pane.onModifiedChange).not.toHaveBeenCalled();
  });
});

describe('the api', () => {
  it('sets the zoom as pdf.js takes it and reads the current one', async () => {
    const pane = await mount();
    const api = apiOf(pane);
    api.setZoom(1.5);
    api.setZoom('page-fit');
    expect(lastViewer().scaleValues).toEqual(['1.5', 'page-fit']);
    lastViewer().currentScale = 2.25;
    expect(api.getZoom()).toBe(2.25);
  });

  it.each([
    ['single', 0],
    ['book', 1],
    ['book-even', 2],
  ] as const)('maps the %s reading layout to pdf.js spread mode %i', async (mode, expected) => {
    const pane = await mount();
    apiOf(pane).setSpreadMode(mode);
    expect(lastViewer().spreadMode).toBe(expected);
  });

  it.each([
    [-5, 1],
    [0, 1],
    [1, 2],
    [99, 3],
  ])('goes to 0-based page %i as pdf.js page %i, within the document', async (index, expected) => {
    const pane = await mount();
    apiOf(pane).goToPage(index);
    expect(lastViewer().currentPageNumber).toBe(expected);
  });

  it('reads the engine delta of the annotation storage', async () => {
    const doc = makeDocument();
    doc.storage.serializable = { map: new Map([['field-1', { value: 'Ada' }]]) };
    const pane = await mount(doc);
    expect(await apiOf(pane).captureEngineValues()).toEqual({
      entries: [{ key: 'field-1', value: { value: 'Ada' } }],
      dropped: 0,
    });
    doc.storage.serializable = { map: null };
    expect(await apiOf(pane).captureEngineValues()).toEqual({ entries: [], dropped: 0 });
  });

  it('puts a restored delta back and says how many entries it applied', async () => {
    const doc = makeDocument();
    const pane = await mount(doc);
    const applied = await apiOf(pane).applyEngineValues({
      entries: [
        { key: 'a', value: { value: 1 } },
        { key: 'b', value: { value: 'two' } },
      ],
      dropped: 0,
    });
    expect(applied).toBe(2);
    expect(doc.storage.setValue.mock.calls).toEqual([
      ['a', { value: 1 }],
      ['b', { value: 'two' }],
    ]);
  });

  it('repaints optional content with the cached configuration instance', async () => {
    const doc = makeDocument();
    const pane = await mount(doc);
    await apiOf(pane).refreshOptionalContent();
    expect(await lastViewer().optionalContentConfigPromise).toBe(
      await doc.handle.raw.getOptionalContentConfig(),
    );
  });

  it('captures only annotation entries the engine holds, not form values', async () => {
    const doc = makeDocument();
    const highlight = { annotationType: 9, color: [1, 1, 0] };
    const removed = { deleted: true };
    doc.storage.serializable = {
      map: new Map<unknown, unknown>([
        ['pdfjs_internal_editor_0', highlight],
        ['pdfjs_internal_editor_1', removed],
        ['field-1', { value: 'form value' }],
        ['null-value', null],
        ['number-value', 5],
        [7, { annotationType: 1 }],
      ]),
    };
    const pane = await mount(doc);
    expect(apiOf(pane).captureAnnotationEntries()).toEqual([
      { id: 'pdfjs_internal_editor_0', value: highlight },
      { id: 'pdfjs_internal_editor_1', value: removed },
    ]);
    doc.storage.serializable = { map: null };
    expect(apiOf(pane).captureAnnotationEntries()).toEqual([]);
  });

  it('drops a taken-over annotation from the engine storage', async () => {
    const doc = makeDocument();
    const pane = await mount(doc);
    apiOf(pane).dropAnnotationEntry('pdfjs_internal_editor_0');
    expect(doc.storage.remove).toHaveBeenCalledExactlyOnceWith('pdfjs_internal_editor_0');
  });
});

describe('page geometry', () => {
  it('answers the origin of the scrolled content in client coordinates, with its full extent', async () => {
    const pane = await mount();
    layOut(
      pane.container,
      { clientLeft: 1, clientTop: 2, scrollLeft: 30, scrollTop: 40, scrollWidth: 1000, scrollHeight: 2000 },
      new DOMRect(10, 20, 800, 600),
    );
    expect(apiOf(pane).containerRect()).toEqual({ x: -19, y: -18, width: 1000, height: 2000 });
  });

  it('answers a page by its content box, inside the transparent border', async () => {
    const pane = await mount();
    lastViewer().pageViews = [pageView(new DOMRect(100, 50, 318, 418), { border: 9 })];
    expect(apiOf(pane).pageRect(0)).toEqual({ x: 109, y: 59, width: 300, height: 400 });
    expect(apiOf(pane).pageRect(1)).toBeNull();
  });

  it('answers the page box and the page rotation in user space', async () => {
    const pane = await mount();
    lastViewer().pageViews = [
      pageView(new DOMRect(0, 0, 300, 400), { viewBox: [10, 820, 610, 20], rotation: 90 }),
      pageView(new DOMRect(0, 0, 300, 400), { rotation: 270 }),
      pageView(new DOMRect(0, 0, 300, 400), { rotation: 180 }),
      pageView(new DOMRect(0, 0, 300, 400), { rotation: 45 }),
    ];
    const geometry = (index: number) => apiOf(pane).pageGeometry(index);
    expect(geometry(0)).toEqual({ x: 10, y: 20, width: 600, height: 800, rotation: 90 });
    expect(geometry(1)?.rotation).toBe(270);
    expect(geometry(2)?.rotation).toBe(180);
    expect(geometry(3)?.rotation).toBe(0);
    expect(geometry(9)).toBeNull();
  });

  it('maps a client point to the page under it, y measured from the page top', async () => {
    const pane = await mount();
    lastViewer().pagesCount = 3;
    lastViewer().pageViews = [
      pageView(new DOMRect(100, 50, 318, 418), { border: 9 }),
      undefined,
      pageView(new DOMRect(100, 500, 318, 418), { border: 9 }),
    ];
    const api = apiOf(pane);
    // 50 px right of and below the content box's corner at (109, 59).
    expect(api.pointToPage(159, 109)).toEqual({ pageIndex: 0, x: 100, y: 100 });
    expect(api.pointToPage(159, 559)).toEqual({ pageIndex: 2, x: 100, y: 100 });
  });

  it.each([
    ['left of', 108, 100],
    ['right of', 410, 100],
    ['above', 150, 58],
    ['below', 150, 460],
  ])('maps a point %s the page content to nothing', async (_where, x, y) => {
    const pane = await mount();
    lastViewer().pagesCount = 1;
    lastViewer().pageViews = [pageView(new DOMRect(100, 50, 318, 418), { border: 9 })];
    expect(apiOf(pane).pointToPage(x, y)).toBeNull();
  });
});

describe('the find bar', () => {
  const FIND = {
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    matchDiacritics: true,
    phraseSearch: true,
  };
  // happy-dom's accessibility tree has no `search` landmark, so the bar is found through its field.
  const findBar = () =>
    screen.getByRole('textbox', { name: 'Find in document' }).closest('search') as HTMLElement;
  const found = (bus: BusFake) =>
    bus.dispatched.filter((event) => event.name === 'find').map((event) => event.payload);

  it('is closed until asked for', async () => {
    await mount();
    expect(screen.queryByRole('textbox', { name: 'Find in document' })).toBeNull();
  });

  it('opens with a query from the api and starts the search', async () => {
    const pane = await mount();
    act(() => apiOf(pane).find('invoice'));
    expect((screen.getByRole('textbox', { name: 'Find in document' }) as HTMLInputElement).value).toBe(
      'invoice',
    );
    expect(found(lastBus())).toEqual([{ ...FIND, type: '', query: 'invoice', findPrevious: false }]);
  });

  it('opens an empty bar without searching for an empty query', async () => {
    const pane = await mount();
    act(() => apiOf(pane).find(''));
    expect(screen.getByRole('textbox', { name: 'Find in document' })).toBeTruthy();
    expect(found(lastBus())).toEqual([]);
  });

  it('opens on the api request and selects the text for the next search', async () => {
    const pane = await mount();
    act(() => apiOf(pane).find('abc'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    act(() => apiOf(pane).openFind());
    runFrames();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
  });

  it.each([
    ['Ctrl+F', { ctrlKey: true, key: 'f' }],
    ['Cmd+F', { metaKey: true, key: 'f' }],
    ['Ctrl+Shift+F', { ctrlKey: true, key: 'F' }],
  ])('%s opens the bar and takes the key from the browser', async (_name, init) => {
    await mount();
    const event = new KeyboardEvent('keydown', { ...init, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Find in document' })).toBeTruthy();
    runFrames();
  });

  it('closes on Escape and says nothing when it was not open', async () => {
    await mount();
    const user = userEvent.setup();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Find in document' })).toBeNull();
    await user.keyboard('{Control>}f{/Control}');
    expect(screen.getByRole('textbox', { name: 'Find in document' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Find in document' })).toBeNull();
  });

  it('starts a search on Enter, and walks the matches with Enter and Shift+Enter after that', async () => {
    await mount();
    const user = userEvent.setup();
    await user.keyboard('{Control>}f{/Control}');
    const input = screen.getByRole('textbox');
    await user.click(input);
    await user.keyboard('{Enter}');
    expect(found(lastBus())).toEqual([]);
    await user.type(input, 'tax{Enter}');
    expect(found(lastBus())).toEqual([{ ...FIND, type: '', query: 'tax', findPrevious: false }]);
    emit(lastBus(), 'updatefindmatchescount', { matchesCount: { total: 4, current: 1 } });
    await user.keyboard('{Enter}');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(found(lastBus()).slice(1)).toEqual([
      { ...FIND, type: 'again', query: 'tax', findPrevious: false },
      { ...FIND, type: 'again', query: 'tax', findPrevious: true },
    ]);
  });

  it('sends the edited text with Enter after a search, and pdf.js restarts because the query changed', async () => {
    await mount();
    const user = userEvent.setup();
    await user.keyboard('{Control>}f{/Control}');
    const input = screen.getByRole('textbox');
    await user.type(input, 'tax{Enter}');
    emit(lastBus(), 'updatefindmatchescount', { matchesCount: { total: 4, current: 1 } });
    await user.type(input, 's{Enter}');
    // The channel type stays 'again': pdf.js's `#shouldDirtyMatch` treats a changed query as a new search.
    expect(found(lastBus()).at(-1)).toEqual({ ...FIND, type: 'again', query: 'taxs', findPrevious: false });
  });

  it('reports the match count, "no matches" and "scanning"', async () => {
    const pane = await mount();
    const counter = () => findBar().querySelector('span.min-w-16')?.textContent;
    act(() => apiOf(pane).find('tax'));
    expect(counter()).toBe('Scanning…');
    emit(lastBus(), 'updatefindcontrolstate', { state: 3 });
    expect(counter()).toBe('Scanning…');
    emit(lastBus(), 'updatefindcontrolstate', { state: 1 });
    expect(counter()).toBe('No matches');
    emit(lastBus(), 'updatefindcontrolstate', { state: 0, matchesCount: { total: 7, current: 2 } });
    expect(counter()).toBe('2 of 7 matches');
    emit(lastBus(), 'updatefindmatchescount', { matchesCount: { total: 7, current: 3 } });
    expect(counter()).toBe('3 of 7 matches');
  });

  it('shows no count for an empty query', async () => {
    const pane = await mount();
    act(() => apiOf(pane).find(''));
    expect(findBar().querySelector('span.min-w-16')?.textContent).toBe('');
  });

  it('clears the count when a new document opens', async () => {
    const pane = await mount();
    act(() => apiOf(pane).find('tax'));
    emit(lastBus(), 'updatefindmatchescount', { matchesCount: { total: 7, current: 3 } });
    emit(lastBus(), 'pagesinit');
    expect(findBar().querySelector('span.min-w-16')?.textContent).toBe('Scanning…');
    // Nothing to reset the second time.
    emit(lastBus(), 'pagesinit');
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('steps through the matches with the buttons, which are off while nothing matched', async () => {
    const pane = await mount();
    act(() => apiOf(pane).find('tax'));
    const previous = screen.getByRole('button', { name: 'Previous match' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next match' }) as HTMLButtonElement;
    expect([previous.disabled, next.disabled]).toEqual([true, true]);
    emit(lastBus(), 'updatefindmatchescount', { matchesCount: { total: 2, current: 1 } });
    const user = userEvent.setup();
    await user.click(next);
    await user.click(previous);
    expect(found(lastBus()).slice(1)).toEqual([
      { ...FIND, type: 'again', query: 'tax', findPrevious: false },
      { ...FIND, type: 'again', query: 'tax', findPrevious: true },
    ]);
  });

  it('steps with F3 and Shift+F3 while the bar is open, and leaves F3 alone when it is closed', async () => {
    const pane = await mount();
    const user = userEvent.setup();
    await user.keyboard('{F3}');
    expect(found(lastBus())).toEqual([]);
    act(() => apiOf(pane).find('tax'));
    const plain = new KeyboardEvent('keydown', { key: 'F3', cancelable: true });
    act(() => {
      window.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(true);
    await user.keyboard('{Shift>}{F3}{/Shift}');
    expect(found(lastBus()).slice(1)).toEqual([
      { ...FIND, type: 'again', query: 'tax', findPrevious: false },
      { ...FIND, type: 'again', query: 'tax', findPrevious: true },
    ]);
  });

  it('has nothing to step through for an empty query', async () => {
    const pane = await mount();
    act(() => apiOf(pane).find(''));
    await userEvent.setup().keyboard('{F3}');
    expect(found(lastBus())).toEqual([]);
  });

  it('offers find and replace only where the document can be edited, with the query', async () => {
    const onReplace = vi.fn();
    const pane = await mount(makeDocument(), { onReplace });
    act(() => apiOf(pane).find('tax'));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Replace…' }));
    expect(onReplace).toHaveBeenCalledExactlyOnceWith('tax');
    cleanup();
    const readOnly = await mount();
    act(() => apiOf(readOnly).find('tax'));
    expect(screen.queryByRole('button', { name: 'Replace…' })).toBeNull();
  });

  it('closes with its button, telling pdf.js to drop the highlights', async () => {
    const pane = await mount();
    act(() => apiOf(pane).find('tax'));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close find' }));
    expect(screen.queryByRole('textbox', { name: 'Find in document' })).toBeNull();
    expect(lastBus().dispatched.at(-1)).toEqual({ name: 'findbarclose', payload: { query: '' } });
  });

  it('works before the viewer is loaded, searching nothing', async () => {
    const pane = mountNow(makeDocument());
    // Synchronous events: the faked module settles within a few microtasks, which an awaited
    // user-event keystroke would let through, so the viewer would no longer be "not loaded".
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    const input = screen.getByRole('textbox', { name: 'Find in document' });
    fireEvent.change(input, { target: { value: 'tax' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'F3' });
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }));
    await settle(() => expect(pane.onReady).toHaveBeenCalledOnce());
    expect(found(lastBus())).toEqual([]);
    expect(lastBus().dispatched).toEqual([]);
  });
});

describe('the overlay host', () => {
  it('is sized to the pages of the slot on screen, and tells the shell when the layout changed', async () => {
    const pane = await mount();
    layOut(pane.container, { clientWidth: 800, clientHeight: 600 });
    layOut(pane.slots[0], { scrollWidth: 500, offsetTop: 0, offsetHeight: 1500 });
    const page = document.createElement('div');
    page.getBoundingClientRect = () => new DOMRect(0, 0, 300, 400);
    pane.slots[0].append(page);
    runFrames();
    expect([pane.host.style.width, pane.host.style.height]).toEqual(['800px', '1500px']);
    expect(pane.onLayoutChange).toHaveBeenCalledOnce();
    // The same layout again is not a change.
    const observer = FakeResizeObserver.instances[0] as FakeResizeObserver;
    act(() => observer.callback());
    act(() => observer.callback());
    runFrames();
    expect(pane.onLayoutChange).toHaveBeenCalledOnce();
    layOut(pane.slots[0], { scrollWidth: 1100 });
    act(() => observer.callback());
    runFrames();
    expect(pane.host.style.width).toBe('1100px');
    expect(pane.onLayoutChange).toHaveBeenCalledTimes(2);
  });

  it('is as big as the container when the slot is empty', async () => {
    const pane = await mount();
    layOut(pane.container, { clientWidth: 800, clientHeight: 600 });
    layOut(pane.slots[0], { scrollWidth: 0, offsetTop: 0, offsetHeight: 0 });
    runFrames();
    expect([pane.host.style.width, pane.host.style.height]).toEqual(['800px', '600px']);
  });

  it('watches the container and both slots, and stops on unmount', async () => {
    const pane = await mount();
    const observer = FakeResizeObserver.instances[0] as FakeResizeObserver;
    expect(observer.observed).toEqual([pane.container, pane.slots[0], pane.slots[1]]);
    pane.unmount();
    expect(observer.disconnected).toBe(true);
  });

  it('drops a measurement that was still waiting when the pane unmounted', async () => {
    const pane = await mount();
    expect(frames.size).toBe(1);
    pane.unmount();
    expect(frames.size).toBe(0);
  });

  it('does not cancel a measurement that already ran when the pane unmounts', async () => {
    const pane = await mount();
    runFrames();
    expect(frames.size).toBe(0);
    pane.unmount();
    expect(frames.size).toBe(0);
  });

  describe('a preset zoom after the container is resized', () => {
    async function resized(preset: string | null, pagesCount = 3) {
      const pane = await mount(makeDocument({ pageCount: pagesCount }));
      const viewer = lastViewer();
      viewer.currentScaleValue = preset;
      viewer.scaleValues.length = 0;
      layOut(pane.container, { clientWidth: 640, clientHeight: 600 });
      runFrames();
      return viewer;
    }

    it.each(['page-width', 'page-fit', 'auto'])(
      'applies %s again, because it is a promise about the container',
      async (preset) => {
        expect((await resized(preset)).scaleValues).toEqual([preset]);
      },
    );

    it('leaves a numeric zoom alone', async () => {
      expect((await resized('1.5')).scaleValues).toEqual([]);
    });

    it('leaves a document without pages alone', async () => {
      expect((await resized('page-width', 0)).scaleValues).toEqual([]);
    });

    it('has nothing to re-apply before the viewer exists', async () => {
      const pane = mountNow(makeDocument());
      layOut(pane.container, { clientWidth: 640, clientHeight: 600 });
      runFrames();
      await settle(() => expect(pane.onReady).toHaveBeenCalledOnce());
      expect(lastViewer().scaleValues).toEqual([]);
    });
  });
});

describe('the hand tool', () => {
  const container = () =>
    (document.querySelector('[data-viewer-overlay]') as HTMLElement).parentElement as HTMLElement;

  it('does nothing without the tool', async () => {
    await mount();
    const scroll = container();
    await userEvent.setup().pointer([
      { keys: '[MouseLeft>]', target: scroll, coords: { clientX: 100, clientY: 100 } },
      { target: scroll, coords: { clientX: 50, clientY: 50 } },
    ]);
    expect(scroll.className).not.toContain('cursor-grab');
    expect(scroll.scrollLeft).toBe(0);
  });

  it('drags the page: the document follows the pointer until the button is released', async () => {
    await mount(makeDocument(), { handTool: true });
    const scroll = container();
    expect(scroll.className).toContain('cursor-grab');
    scroll.scrollLeft = 200;
    scroll.scrollTop = 300;
    const user = userEvent.setup();
    await user.pointer([
      { keys: '[MouseLeft>]', target: scroll, coords: { clientX: 100, clientY: 100 } },
      { target: scroll, coords: { clientX: 60, clientY: 130 } },
    ]);
    expect(scroll.className).toContain('cursor-grabbing');
    expect([scroll.scrollLeft, scroll.scrollTop]).toEqual([240, 270]);
    await user.pointer({ keys: '[/MouseLeft]', target: scroll, coords: { clientX: 60, clientY: 130 } });
    expect(scroll.className).toContain('cursor-grab ');
    await user.pointer({ target: scroll, coords: { clientX: 0, clientY: 0 } });
    expect([scroll.scrollLeft, scroll.scrollTop]).toEqual([240, 270]);
  });

  it('ignores the other buttons', async () => {
    await mount(makeDocument(), { handTool: true });
    const scroll = container();
    await userEvent
      .setup()
      .pointer({ keys: '[MouseRight>]', target: scroll, coords: { clientX: 1, clientY: 1 } });
    expect(scroll.className).not.toContain('cursor-grabbing');
  });
});

describe('the markers pdf.js shows', () => {
  it('keeps the app’s identity marker out of what pdf.js draws into the pane', async () => {
    const pane = await mount();
    const popup = document.createElement('p');
    popup.textContent = 'pdf-editor-ann:abc123 the words';
    pane.container.append(popup);
    await act(async () => {});
    expect(popup.textContent).toBe('the words');
  });
});
