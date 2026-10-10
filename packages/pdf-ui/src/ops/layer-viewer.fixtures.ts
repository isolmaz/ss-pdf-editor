/**
 * A stand-in for the viewer's geometry, for the overlay layers' DOM tests: happy-dom has no
 * layout, so the page rectangles the real viewer measures are given here, and `pointToPage`
 * is the exact inverse of the projection every layer draws with (an unrotated page).
 */

import type { ViewerApi } from '../viewer/PdfViewerPane';

export interface FakePage {
  /** The page element's rectangle, in client pixels. */
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** The page box in user space (`pageGeometry`). */
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly rotation?: 0 | 90 | 180 | 270;
  /** The page is laid out but the viewer has not put it on screen: no `pageRect`, no hits. */
  readonly hidden?: boolean;
}

/** Two 600 × 800 pt pages drawn at 50 %, one under the other, 100 px in from the container. */
export const TWO_PAGES: readonly FakePage[] = [
  { rect: { x: 100, y: 50, width: 300, height: 400 }, box: { x: 0, y: 0, width: 600, height: 800 } },
  { rect: { x: 100, y: 500, width: 300, height: 400 }, box: { x: 0, y: 0, width: 600, height: 800 } },
];

export interface FakeViewerOptions {
  readonly pages?: readonly FakePage[];
  readonly container?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** Page point → client pixel for page `pageIndex` of {@link TWO_PAGES}-shaped (unrotated) pages. */
export function clientOf(
  point: { readonly x: number; readonly y: number },
  pageIndex = 0,
  pages: readonly FakePage[] = TWO_PAGES,
): { readonly clientX: number; readonly clientY: number } {
  const page = pages[pageIndex] as FakePage;
  const scale = page.rect.width / page.box.width;
  return { clientX: page.rect.x + (point.x - page.box.x) * scale, clientY: page.rect.y + point.y * scale };
}

export function fakeViewer(options: FakeViewerOptions = {}): ViewerApi {
  const pages = options.pages ?? TWO_PAGES;
  const container = options.container ?? { x: 0, y: 0, width: 1000, height: 1000 };
  return {
    pointToPage: (clientX: number, clientY: number) => {
      const index = pages.findIndex(
        (page) =>
          page.hidden !== true &&
          clientX >= page.rect.x &&
          clientX <= page.rect.x + page.rect.width &&
          clientY >= page.rect.y &&
          clientY <= page.rect.y + page.rect.height,
      );
      const page = pages[index];
      if (page === undefined) return null;
      const scale = page.rect.width / page.box.width;
      return {
        pageIndex: index,
        x: page.box.x + (clientX - page.rect.x) / scale,
        y: (clientY - page.rect.y) / scale,
      };
    },
    pageGeometry: (pageIndex: number) => {
      const page = pages[pageIndex];
      return page === undefined ? null : { ...page.box, rotation: page.rotation ?? 0 };
    },
    pageRect: (pageIndex: number) => {
      const page = pages[pageIndex];
      return page === undefined || page.hidden === true ? null : page.rect;
    },
    containerRect: () => container,
  } as unknown as ViewerApi;
}
