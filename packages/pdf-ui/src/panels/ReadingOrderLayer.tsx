/**
 * The reading-order overlay: a numbered box over each block the tags panel lists, so the
 * order a screen reader will read the page in can be *seen* on the page.
 *
 * The layer draws what the panel put in `readingOrderStore` and nothing else — it reads no
 * file and knows nothing about structure. It is mounted inside the viewer's scroll
 * container (the pane's `overlay` slot), so the browser carries it with the pages, and it is
 * placed at render against the page as laid out now (zoom, spread, resize and a turned page
 * all move the shell's layout revision, which it takes as `layout`), the same contract
 * `TextLayer` follows.
 *
 * Rects arrive page-relative and unrotated; a turned page is mapped here, once, with the
 * four quarter-turn cases written out.
 */

import type { Translator } from 'pdf-shared';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import {
  type OverlayPage,
  type OverlayRect,
  readingOrderStore,
  useReadingOrder,
} from './reading-order-store';

export interface ReadingOrderLayerProps {
  readonly t: Translator;
  readonly viewer: ViewerApi;
  /**
   * The shell's layout revision: it moves each time the pages are laid out again. The viewer
   * answers where a page is through methods on one long-lived object, so nothing else in the
   * props says the boxes have to be placed again.
   */
  readonly layout: number;
}

/** A box in client pixels, as the viewer reports one. */
interface ClientBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The viewer's geometry as it was at one layout: what the boxes are placed on. */
interface Frame {
  readonly layout: number;
  readonly container: ClientBox;
  /** Each listed page that is on screen, with its painted box. */
  readonly placed: readonly { readonly page: OverlayPage; readonly box: ClientBox }[];
}

/**
 * Read the viewer's geometry for `pages` at `layout`. The revision is an argument, and part of
 * what comes back, because the React Compiler memoizes a call on its arguments: `viewer` is the
 * same object across layouts, so without it the first reading would be kept for good.
 */
function measure(viewer: ViewerApi, pages: readonly OverlayPage[], layout: number): Frame {
  return {
    layout,
    container: viewer.containerRect(),
    placed: pages.flatMap((page) => {
      const box = viewer.pageRect(page.pageIndex);
      return box === null ? [] : [{ page, box }];
    }),
  };
}

/** An unrotated page-relative rect → the displayed page's own space after `/Rotate`. */
function rotateRect(
  rect: OverlayRect,
  width: number,
  height: number,
  rotation: 0 | 90 | 180 | 270,
): { readonly rect: OverlayRect; readonly width: number; readonly height: number } {
  const [x0, y0, x1, y1] = rect;
  switch (rotation) {
    case 90:
      return { rect: [height - y1, x0, height - y0, x1], width: height, height: width };
    case 180:
      return { rect: [width - x1, height - y1, width - x0, height - y0], width, height };
    case 270:
      return { rect: [y0, width - x1, y1, width - x0], width: height, height: width };
    default:
      return { rect, width, height };
  }
}

export function ReadingOrderLayer({ t, viewer, layout }: ReadingOrderLayerProps) {
  const { pages, selectedKeys } = useReadingOrder();
  const { container, placed } = measure(viewer, pages, layout);
  return (
    <div data-reading-order-layer="true" className="pointer-events-none absolute inset-0 z-10">
      {placed.map(({ page, box }) => {
        return page.items.map((item) => {
          const turned = rotateRect(item.rect, page.width, page.height, page.rotation);
          const scaleX = box.width / Math.max(1, turned.width);
          const scaleY = box.height / Math.max(1, turned.height);
          const left = box.x - container.x + turned.rect[0] * scaleX;
          const top = box.y - container.y + turned.rect[1] * scaleY;
          const selected = selectedKeys.includes(item.key);
          return (
            <button
              key={`${String(page.pageIndex)}-${item.key}`}
              type="button"
              data-order-box={item.key}
              data-order-number={item.number}
              data-order-page={page.pageIndex}
              aria-label={t('tags.overlay.item' as Parameters<Translator>[0], {
                number: item.number,
                role: item.role,
              })}
              aria-pressed={selected}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) =>
                readingOrderStore.setSelected(
                  event.ctrlKey || event.metaKey
                    ? selected
                      ? selectedKeys.filter((key) => key !== item.key)
                      : [...selectedKeys, item.key]
                    : [item.key],
                )
              }
              className={`pointer-events-auto absolute border bg-transparent p-0 text-left ${
                selected
                  ? 'border-2 border-pdf-accent bg-pdf-accent/15'
                  : 'border-pdf-accent/60 hover:bg-pdf-accent/10'
              }`}
              style={{
                left: `${String(left)}px`,
                top: `${String(top)}px`,
                width: `${String(Math.max(6, (turned.rect[2] - turned.rect[0]) * scaleX))}px`,
                height: `${String(Math.max(6, (turned.rect[3] - turned.rect[1]) * scaleY))}px`,
              }}
            >
              <span className="absolute -top-2 -left-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-pdf-accent px-1 text-[10px] leading-none font-semibold text-pdf-on-accent tabular-nums">
                {item.number}
              </span>
            </button>
          );
        });
      })}
    </div>
  );
}
