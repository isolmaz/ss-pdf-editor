// @vitest-environment happy-dom
/**
 * The geometry the tools read off the pdf.js viewer stack: which pages exist, which one the
 * reader is on, which bitmaps are on screen and which one sits under the pointer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { findViewerDom, pageImageAt, pageIndexAtTop, pagesInView } from './viewer-dom';

const viewer = {} as ViewerApi;

interface PageSpec {
  /** The `data-page-number` attribute. */
  readonly number: string;
  readonly top?: number;
  readonly height?: number;
  readonly canvas?: { readonly width: number; readonly height: number; readonly rect?: DOMRect } | null;
}

/** `.overflow-auto > .pdfViewer[data-active-viewer] > .page[data-page-number]` — pdf.js's shape. */
function mountViewer(specs: readonly PageSpec[], container = new DOMRect(0, 0, 800, 600)) {
  document.body.innerHTML = '';
  const scroll = document.createElement('div');
  scroll.className = 'overflow-auto';
  scroll.getBoundingClientRect = () => container;
  const root = document.createElement('div');
  root.className = 'pdfViewer';
  root.setAttribute('data-active-viewer', '');
  for (const spec of specs) {
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.pageNumber = spec.number;
    page.getBoundingClientRect = () => new DOMRect(0, spec.top ?? 0, 500, spec.height ?? 0);
    if (spec.canvas !== null && spec.canvas !== undefined) {
      const canvas = document.createElement('canvas');
      canvas.width = spec.canvas.width;
      canvas.height = spec.canvas.height;
      canvas.getBoundingClientRect = () =>
        spec.canvas?.rect ?? new DOMRect(0, spec.top ?? 0, 500, spec.height ?? 0);
      page.append(canvas);
    }
    root.append(page);
  }
  scroll.append(root);
  document.body.append(scroll);
  return { scroll, root };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('findViewerDom', () => {
  it('finds nothing while there is no viewer api', () => {
    mountViewer([{ number: '1' }]);
    expect(findViewerDom(null)).toBeNull();
  });

  it('finds nothing when no active pdf.js viewer is on screen', () => {
    document.body.innerHTML = '<div class="overflow-auto"><div class="pdfViewer"></div></div>';
    expect(findViewerDom(viewer)).toBeNull();
  });

  it('lists the pages with their 0-based index and their canvas, when rendered', () => {
    const { scroll, root } = mountViewer([
      { number: '1', canvas: { width: 10, height: 10 } },
      { number: '2' },
      { number: '3', canvas: { width: 10, height: 10 } },
    ]);
    const dom = findViewerDom(viewer);
    expect(dom?.container).toBe(scroll);
    expect(dom?.viewer).toBe(root);
    expect(dom?.pages.map((page) => [page.index, page.canvas !== null])).toEqual([
      [0, true],
      [1, false],
      [2, true],
    ]);
  });

  it('falls back to the position in the list for a page number that is not a positive integer', () => {
    mountViewer([{ number: 'x' }, { number: '0' }, { number: '2.5' }, { number: '-3' }, { number: '7' }]);
    expect(findViewerDom(viewer)?.pages.map((page) => page.index)).toEqual([0, 1, 2, 3, 6]);
  });

  it('ignores page views inside a viewer that is not the active one', () => {
    document.body.innerHTML =
      '<div><div class="pdfViewer"><div class="page" data-page-number="1"></div></div></div>';
    expect(findViewerDom(viewer)).toBeNull();
  });
});

describe('pageIndexAtTop', () => {
  const dom = (specs: readonly PageSpec[], container?: DOMRect) => {
    mountViewer(specs, container);
    const found = findViewerDom(viewer);
    if (found === null) throw new Error('the fake viewer must be found');
    return found;
  };

  it('answers the page covering the middle of the scroll container', () => {
    const pages = [0, 1, 2, 3].map((n) => ({ number: String(n + 1), top: n * 500 - 700, height: 500 }));
    // The container's middle is y = 300; the page tops are -700, -200, 300 and 800.
    expect(pageIndexAtTop(dom(pages))).toBe(2);
  });

  it('stays on an earlier page while a later one starts below the middle', () => {
    const pages = [0, 1, 2].map((n) => ({ number: String(n + 1), top: n * 500 - 100, height: 500 }));
    expect(pageIndexAtTop(dom(pages))).toBe(0);
  });

  it('walks to the last page when the middle is past every page top', () => {
    const pages = [0, 1].map((n) => ({ number: String(n + 1), top: n * 100, height: 100 }));
    expect(pageIndexAtTop(dom(pages))).toBe(1);
  });

  it('answers the first page for a viewer without layout, where every page box is empty', () => {
    const pages = [0, 1, 2].map((n) => ({ number: String(n + 1), top: 0, height: 0 }));
    expect(pageIndexAtTop(dom(pages))).toBe(0);
  });

  it('answers the first page for a viewer that has no page views yet', () => {
    expect(pageIndexAtTop(dom([]))).toBe(0);
  });
});

describe('pagesInView', () => {
  const pagesOf = (specs: readonly PageSpec[]) => {
    mountViewer(specs, new DOMRect(0, 100, 800, 400));
    const found = findViewerDom(viewer);
    if (found === null) throw new Error('the fake viewer must be found');
    return pagesInView(found);
  };

  it('lists the rendered pages crossing the container with their bitmap and its rectangle', () => {
    const rect = new DOMRect(10, 120, 300, 200);
    const [first, ...rest] = pagesOf([
      { number: '1', canvas: { width: 600, height: 400, rect } },
      { number: '2', canvas: { width: 600, height: 400, rect: new DOMRect(10, 350, 300, 200) } },
    ]);
    expect(first?.index).toBe(0);
    expect(first?.rect).toBe(rect);
    expect(first?.canvas.width).toBe(600);
    expect(rest.map((image) => image.index)).toEqual([1]);
  });

  it('skips pages with no canvas, an unsized bitmap or a collapsed rectangle', () => {
    const inside = new DOMRect(0, 150, 300, 200);
    const images = pagesOf([
      { number: '1' },
      { number: '2', canvas: { width: 0, height: 400, rect: inside } },
      { number: '3', canvas: { width: 400, height: 0, rect: inside } },
      { number: '4', canvas: { width: 400, height: 400, rect: new DOMRect(0, 150, 0, 200) } },
      { number: '5', canvas: { width: 400, height: 400, rect: new DOMRect(0, 150, 300, 0) } },
      { number: '6', canvas: { width: 400, height: 400, rect: inside } },
    ]);
    expect(images.map((image) => image.index)).toEqual([5]);
  });

  it('skips pages scrolled wholly above or below the container', () => {
    const images = pagesOf([
      { number: '1', canvas: { width: 400, height: 400, rect: new DOMRect(0, -200, 300, 300) } },
      { number: '2', canvas: { width: 400, height: 400, rect: new DOMRect(0, 500, 300, 300) } },
      { number: '3', canvas: { width: 400, height: 400, rect: new DOMRect(0, 499, 300, 300) } },
    ]);
    expect(images.map((image) => image.index)).toEqual([2]);
  });
});

describe('pageImageAt', () => {
  /** happy-dom has no hit testing; `elementFromPoint` answers the element the test names. */
  const pointer = (element: Element | null) => {
    document.elementFromPoint = () => element;
  };

  it('answers the bitmap and its rectangle for a point on a rendered page', () => {
    const rect = new DOMRect(20, 30, 300, 400);
    const { root } = mountViewer([
      { number: '1' },
      { number: '3', canvas: { width: 600, height: 800, rect } },
    ]);
    const page = root.querySelectorAll('.page')[1] as HTMLElement;
    pointer(page.querySelector('canvas'));
    const hit = pageImageAt(50, 60);
    expect(hit?.index).toBe(2);
    expect(hit?.rect).toBe(rect);
    expect(hit?.canvas).toBe(page.querySelector('canvas'));
  });

  it('answers index 0 for a page whose number is not a positive integer', () => {
    const { root } = mountViewer([
      { number: 'x', canvas: { width: 600, height: 800, rect: new DOMRect(0, 0, 3, 4) } },
    ]);
    pointer(root.querySelector('canvas'));
    expect(pageImageAt(1, 1)?.index).toBe(0);
  });

  it('answers nothing for a point outside any element', () => {
    mountViewer([{ number: '1', canvas: { width: 600, height: 800 } }]);
    pointer(null);
    expect(pageImageAt(1, 1)).toBeNull();
  });

  it('answers nothing for a point outside any page', () => {
    mountViewer([{ number: '1', canvas: { width: 600, height: 800 } }]);
    pointer(document.body);
    expect(pageImageAt(1, 1)).toBeNull();
  });

  it('answers nothing for a page the viewer has not rendered, or whose bitmap is unsized', () => {
    const { root } = mountViewer([
      { number: '1' },
      { number: '2', canvas: { width: 0, height: 800, rect: new DOMRect(0, 0, 3, 4) } },
      { number: '3', canvas: { width: 800, height: 0, rect: new DOMRect(0, 0, 3, 4) } },
    ]);
    for (const page of root.querySelectorAll('.page')) {
      pointer(page);
      expect(pageImageAt(1, 1)).toBeNull();
    }
  });

  it('answers nothing for a bitmap with a collapsed rectangle', () => {
    const { root } = mountViewer([
      { number: '1', canvas: { width: 800, height: 800, rect: new DOMRect(0, 0, 0, 4) } },
      { number: '2', canvas: { width: 800, height: 800, rect: new DOMRect(0, 0, 3, 0) } },
    ]);
    for (const page of root.querySelectorAll('.page')) {
      pointer(page);
      expect(pageImageAt(1, 1)).toBeNull();
    }
  });
});
