import type { ViewerApi } from '../viewer/PdfViewerPane';

/**
 * Geometry of the pdf.js viewer stack, read from the DOM pdf.js itself builds.
 *
 * `ViewerApi` (`viewer/PdfViewerPane.tsx`) is deliberately navigation-only. The
 * tools in this folder need one more thing: *what is on screen right now* — which
 * pages the viewer has rendered, where their bitmaps sit, and at which device
 * resolution (`devicePixelRatio × scale`). The pane keeps its `PDFViewer`
 * instance private and is not ours to change, so the markup it renders is the
 * only surface left. That markup is pdf.js's public shape: it is what
 * `pdf_viewer.css` styles and what `PDFViewer#setDocument` fills in (one page
 * view per page, created upfront, ending at `data-page-number`):
 *
 *   <div class="overflow-auto">          ← the scroll container (`scrollTop` lives here)
 *     <div class="pdfViewer">
 *       <div class="spread?">            ← spreads exist in book mode only
 *         <div class="page" data-page-number="1">
 *           <div class="canvasWrapper"><canvas/></div> …
 *
 * Every function here is a read: nothing calls pdf.js, nothing writes, nothing
 * holds state — the tools stay consumers of the viewer, never a second source of
 * document state.
 *
 * **Known gap:** `ViewerApi` exposes no container reference and no document
 * handle, so a second viewport (a future split view) would resolve the first
 * `.pdfViewer` in the document; that needs a real accessor on the pane's API.
 */

export interface ViewerPage {
  /** 0-based page index — the same index `ViewerApi.goToPage` takes. */
  readonly index: number;
  readonly element: HTMLElement;
  /** `null` until the viewer has rendered that page. */
  readonly canvas: HTMLCanvasElement | null;
}

export interface ViewerDom {
  /** The scroll container the viewer element lives in. */
  readonly container: HTMLElement;
  /** The `.pdfViewer` element the page views are appended to. */
  readonly viewer: HTMLElement;
  readonly pages: readonly ViewerPage[];
}

export interface PageImage {
  /** 0-based page index. */
  readonly index: number;
  /** The bitmap the viewer's own render pipeline produced for that page. */
  readonly canvas: HTMLCanvasElement;
  /** Where that bitmap sits on screen, in client coordinates. */
  readonly rect: DOMRect;
}

/** The live viewer, or `null` when there is no document / no viewer on screen. */
export function findViewerDom(viewer: ViewerApi | null): ViewerDom | null {
  if (viewer === null) return null;
  const element = document.querySelector('.pdfViewer[data-active-viewer]');
  if (!(element instanceof HTMLElement)) return null;
  const container = element.parentElement;
  if (container === null) return null;
  const pages: ViewerPage[] = [];
  for (const page of element.querySelectorAll<HTMLElement>('.page[data-page-number]')) {
    const number = Number(page.dataset.pageNumber);
    pages.push({
      index: Number.isInteger(number) && number > 0 ? number - 1 : pages.length,
      element: page,
      canvas: page.querySelector('canvas'),
    });
  }
  return { container, viewer: element, pages };
}

/**
 * The page covering the middle of the scroll container — the view the reader is
 * on. Binary search over the page boxes (a 2000-page document must not be
 * measured page by page on every sample).
 */
export function pageIndexAtTop(dom: ViewerDom): number {
  const band = dom.container.getBoundingClientRect();
  const middle = band.top + band.height / 2;
  let low = 0;
  let high = dom.pages.length - 1;
  let found = 0;
  while (low <= high) {
    const index = (low + high) >> 1;
    const page = dom.pages[index];
    if (page === undefined) break;
    if (page.element.getBoundingClientRect().top <= middle) {
      found = index;
      low = index + 1;
    } else {
      high = index - 1;
    }
  }
  // A viewer without layout (hidden, or measured before it is sized) reports the
  // same empty box for every page; every such box "covers" the middle, so the
  // search would walk to the last page and every sample would claim the document
  // ended there. The first page is the honest answer for that case.
  const box = dom.pages[found]?.element.getBoundingClientRect();
  if (box === undefined || box.height === 0) return 0;
  return found;
}

/** The rendered pages crossing the scroll container — what a view snapshot contains. */
export function pagesInView(dom: ViewerDom): readonly PageImage[] {
  const bounds = dom.container.getBoundingClientRect();
  const images: PageImage[] = [];
  for (const page of dom.pages) {
    const canvas = page.canvas;
    if (canvas === null || canvas.width === 0 || canvas.height === 0) continue;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
    images.push({ index: page.index, canvas, rect });
  }
  return images;
}

/** The rendered page bitmap under a viewport point (the magnifier's source). */
export function pageImageAt(clientX: number, clientY: number): PageImage | null {
  const page = document.elementFromPoint(clientX, clientY)?.closest('.page[data-page-number]');
  if (!(page instanceof HTMLElement)) return null;
  const canvas = page.querySelector('canvas');
  if (canvas === null || canvas.width === 0 || canvas.height === 0) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const number = Number(page.dataset.pageNumber);
  return { index: Number.isInteger(number) && number > 0 ? number - 1 : 0, canvas, rect };
}
