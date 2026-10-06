/**
 * The reading-order overlay: a numbered box over each block the tags panel lists, so the
 * order a screen reader will read the page in can be *seen* on the page.
 *
 * The layer draws what the panel put in `readingOrderStore` and nothing else — it reads no
 * file and knows nothing about structure. It is mounted inside the viewer's scroll
 * container (the pane's `overlay` slot), so the browser carries it with the pages, and it is
 * placed at render against the page as laid out now (zoom, spread and resize all re-render
 * it through the shell's layout signal), the same contract `TextLayer` follows.
 *
 * Rects arrive page-relative and unrotated; a turned page is mapped here, once, with the
 * four quarter-turn cases written out.
 */

import type { Translator } from 'pdf-shared';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { type OverlayRect, readingOrderStore, useReadingOrder } from './reading-order-store';

export interface ReadingOrderLayerProps {
  readonly t: Translator;
  readonly viewer: ViewerApi;
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

export function ReadingOrderLayer({ t, viewer }: ReadingOrderLayerProps) {
  const { pages, selectedKeys } = useReadingOrder();
  const container = viewer.containerRect();
  return (
    <div data-reading-order-layer="true" className="pointer-events-none absolute inset-0 z-10">
      {pages.map((page) => {
        const box = viewer.pageRect(page.pageIndex);
        if (box === null) return null;
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
