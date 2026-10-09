import type { ViewerApi } from '../viewer/PdfViewerPane';

/**
 * What the printing slice takes from the viewer: the engine document it renders
 * through, and the pages it is showing right now.
 *
 * `ViewerApi` (`viewer/PdfViewerPane.tsx`) exposes navigation and zoom only, and
 * the printing slice must not widen that interface. A print job is the one shell
 * action that needs pages the viewer may never have painted — every page of a
 * 500-page document, not the handful its virtualised window holds — so the pane
 * hands out the `PdfDocumentHandle` (pdf-core) it already draws with. Printing
 * then renders through **that** document: the same pipeline, the same engine
 * adapter, no second parse of the file and nothing reaching into pdf.js.
 */

/** A page's size in PDF points (`scale 1`): 1 point = 1/72". */
export interface PrintPageSize {
  readonly width: number;
  readonly height: number;
}

export interface PrintRenderOptions {
  /** pdf.js viewport scale — CSS pixels per PDF point. */
  readonly scale: number;
  /** Backing-store multiplier applied on top of `scale`. */
  readonly devicePixelRatio?: number;
  readonly signal?: AbortSignal;
}

/**
 * The three members printing uses. `PdfDocumentHandle` already satisfies this
 * shape, so the handle *is* the page source — no parallel type is handed around.
 */
export interface PrintPageSource {
  readonly pageCount: number;
  getPageSize(pageIndex: number, scale: number): Promise<PrintPageSize>;
  renderPage(pageIndex: number, canvas: HTMLCanvasElement, options: PrintRenderOptions): Promise<void>;
}

/**
 * The engine document behind `viewer`, or `null` when the viewer was built
 * without one — the dialog then has nothing to render and says so by disabling
 * `print.start` instead of failing after the click.
 *
 * Either shape works: the handle exposed as a member (`viewer.document`) or its
 * members spread onto the viewport API object itself.
 */
export function resolvePrintSource(viewer: ViewerApi | null): PrintPageSource | null {
  if (viewer === null) return null;
  const candidate: unknown = viewer;
  if (isPrintPageSource(candidate)) return candidate;
  // A viewer without the handle yields `undefined` here, which is not a page source either.
  const nested: unknown = viewer.document;
  return isPrintPageSource(nested) ? nested : null;
}

/**
 * The pages the viewer is showing right now — the `print.rangeCurrent` choice.
 *
 * `ViewerApi` reports page changes to the *shell* (`onCurrentPageChange`) and
 * exposes no getter, so the visible set is read from the DOM the pdf.js viewer
 * paints: its page elements carry `data-page-number` (pdf.js's own attribute,
 * used for scrolling and links) and the ones intersecting the scroll container
 * are what the user is looking at. A viewer that is not laid out yet yields no
 * pages, which the dialog reports as an empty selection.
 */
export function currentViewPages(): readonly number[] {
  const viewerElement = document.querySelector<HTMLElement>('.pdfViewer[data-active-viewer]');
  if (viewerElement === null) return [];

  // A viewer found in the document is inside something: only `<html>` has no parent.
  const scroller = viewerElement.parentElement as HTMLElement;
  const box = scroller.getBoundingClientRect();
  const visible: number[] = [];
  for (const page of viewerElement.querySelectorAll<HTMLElement>('.page[data-page-number]')) {
    const rect = page.getBoundingClientRect();
    if (rect.bottom <= box.top || rect.top >= box.bottom) continue;
    const pageNumber = Number(page.dataset.pageNumber);
    if (Number.isInteger(pageNumber) && pageNumber > 0) visible.push(pageNumber);
  }
  return visible.sort((left, right) => left - right);
}

/** Structural check: the members printing calls, verified before it calls them. */
function isPrintPageSource(value: unknown): value is PrintPageSource {
  if (typeof value !== 'object' || value === null) return false;
  if (!('pageCount' in value) || !('getPageSize' in value) || !('renderPage' in value)) return false;
  return (
    typeof value.pageCount === 'number' &&
    typeof value.getPageSize === 'function' &&
    typeof value.renderPage === 'function'
  );
}
