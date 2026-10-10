// @vitest-environment happy-dom
/**
 * What printing takes from the viewer: the page source (the engine document, as a member or spread
 * onto the viewer object) and the pages on screen. happy-dom has no layout, so the scroller's and
 * the pages' rectangles are given here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { currentViewPages, resolvePrintSource } from './printSource';

const source = {
  pageCount: 3,
  getPageSize: async () => ({ width: 100, height: 200 }),
  renderPage: async () => undefined,
};

/** A viewer object carrying `members`, as the shell hands it over. */
const viewerWith = (members: Record<string, unknown>) => members as unknown as ViewerApi;

describe('resolvePrintSource', () => {
  it('has no source without a viewer', () => {
    expect(resolvePrintSource(null)).toBeNull();
  });

  it('takes the engine document a viewer exposes as its member', () => {
    expect(resolvePrintSource(viewerWith({ document: source }))).toBe(source);
  });

  it('takes a viewer whose own members are the page source', () => {
    const spread = viewerWith({ ...source, document: undefined });
    expect(resolvePrintSource(spread)).toBe(spread);
  });

  it('has no source for a viewer built without the engine document', () => {
    expect(resolvePrintSource(viewerWith({}))).toBeNull();
    expect(resolvePrintSource(viewerWith({ document: null }))).toBeNull();
    expect(resolvePrintSource(viewerWith({ document: 'pdf' }))).toBeNull();
  });

  it.each([
    ['no page count', { getPageSize: source.getPageSize, renderPage: source.renderPage }],
    ['no page size', { pageCount: 3, renderPage: source.renderPage }],
    ['no renderer', { pageCount: 3, getPageSize: source.getPageSize }],
    ['a page count that is not a number', { ...source, pageCount: '3' }],
    ['a page size that is not a function', { ...source, getPageSize: 'size' }],
    ['a renderer that is not a function', { ...source, renderPage: 1 }],
  ])('has no source when the document has %s', (_name, document) => {
    expect(resolvePrintSource(viewerWith({ document }))).toBeNull();
  });
});

describe('currentViewPages', () => {
  /** The rectangle every element of the fake layout reports, by element. */
  const rects = new Map<Element, { top: number; bottom: number }>();

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const rect = rects.get(this) ?? { top: 0, bottom: 0 };
      return { ...rect, left: 0, right: 0, width: 0, height: rect.bottom - rect.top } as DOMRect;
    });
  });

  afterEach(() => {
    rects.clear();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  /** A scroller 0–500 tall holding a viewer with pages at the given `[number, top, bottom]`. */
  function layout(pages: ReadonlyArray<readonly [string | null, number, number]>, active = true) {
    const scroller = document.createElement('div');
    const viewer = document.createElement('div');
    viewer.className = 'pdfViewer';
    if (active) viewer.setAttribute('data-active-viewer', '');
    for (const [number, top, bottom] of pages) {
      const page = document.createElement('div');
      page.className = 'page';
      if (number !== null) page.setAttribute('data-page-number', number);
      rects.set(page, { top, bottom });
      viewer.append(page);
    }
    rects.set(scroller, { top: 0, bottom: 500 });
    scroller.append(viewer);
    document.body.append(scroller);
  }

  it('is empty when no viewer is laid out', () => {
    expect(currentViewPages()).toEqual([]);
  });

  it('is empty for a viewer that is not the active one', () => {
    layout([['1', 0, 400]], false);
    expect(currentViewPages()).toEqual([]);
  });

  it('lists the pages that meet the scroller, in ascending order', () => {
    layout([
      ['5', 900, 1300],
      ['3', 450, 850],
      ['1', -300, 100],
      ['2', 100, 450],
      ['9', -800, -400],
    ]);
    expect(currentViewPages()).toEqual([1, 2, 3]);
  });

  it('leaves out a page that only touches the scroller’s edge', () => {
    layout([
      ['1', -400, 0],
      ['2', 500, 900],
      ['3', 0, 500],
    ]);
    expect(currentViewPages()).toEqual([3]);
  });

  it('ignores pages whose number is not a positive whole number, or is missing', () => {
    layout([
      ['0', 0, 100],
      ['-2', 0, 100],
      ['1.5', 0, 100],
      ['two', 0, 100],
      [null, 0, 100],
      ['4', 0, 100],
    ]);
    expect(currentViewPages()).toEqual([4]);
  });
});
