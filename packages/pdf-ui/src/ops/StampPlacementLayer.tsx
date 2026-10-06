/**
 * Placing a picture — a signature, initials or an image — with one click.
 *
 * While a picture is armed, a translucent copy of it follows the pointer over the pages at
 * the size it will have, and a click on a page puts it there: the layer answers the page,
 * the centre in app space and the upright size in points, and the shell writes the stamp
 * (`pdf-core/ops/image-stamp.ts`). Escape, or a click off the pages, does nothing to the
 * document.
 *
 * Like `MarkInteractionLayer`, the root takes no pointer: it listens on `window` and starts
 * only on a page surface, so the shell's chrome keeps its clicks.
 */

import { useEffect, useRef, useState } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { markPageFrameOf, pageGestureAt, releaseFocusHolder } from './mark-interaction';

/** The picture being placed: its preview and its pixel size, which fixes its aspect. */
export interface StampPlacementSource {
  readonly role: 'signature' | 'initials' | 'image';
  readonly dataUrl: string;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface StampPlacement {
  readonly pageIndex: number;
  /** Centre in app space: unrotated page points, origin top-left, y down. */
  readonly center: { readonly x: number; readonly y: number };
  /** Upright size as it shows on screen, in points. */
  readonly width: number;
  readonly height: number;
}

export interface StampPlacementLayerProps {
  readonly viewer: ViewerApi;
  readonly source: StampPlacementSource;
  /** Already translated: what the pointer does now. */
  readonly hint: string;
  readonly onPlace: (placement: StampPlacement) => void;
  readonly onCancel: () => void;
}

/** A signature's width on the page, and an initials' — what a pen would make, in points. */
const SIGNATURE_WIDTH = 160;
const INITIALS_WIDTH = 60;
/** An image is placed at 96 dpi (0.75 pt per pixel), never wider or taller than this share of the page. */
const IMAGE_PAGE_SHARE = 0.6;

/**
 * The upright size a picture gets on a page whose upright extents are `pageWidth` ×
 * `pageHeight` points. The aspect is always the picture's own.
 */
export function stampSize(
  source: StampPlacementSource,
  pageWidth: number,
  pageHeight: number,
): { readonly width: number; readonly height: number } {
  const aspect = source.pixelHeight / Math.max(source.pixelWidth, 1);
  let width =
    source.role === 'signature'
      ? SIGNATURE_WIDTH
      : source.role === 'initials'
        ? INITIALS_WIDTH
        : source.pixelWidth * 0.75;
  let height = width * aspect;
  const fit = Math.min(1, (pageWidth * IMAGE_PAGE_SHARE) / width, (pageHeight * IMAGE_PAGE_SHARE) / height);
  width *= fit;
  height *= fit;
  return { width, height };
}

interface Ghost {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function StampPlacementLayer({ viewer, source, hint, onPlace, onCancel }: StampPlacementLayerProps) {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const latest = useRef({ viewer, source, onPlace, onCancel });
  useEffect(() => {
    latest.current = { viewer, source, onPlace, onCancel };
  });

  useEffect(() => {
    /** Where the picture would land for a pointer at this client point, or `null` off the pages. */
    const placementAt = (clientX: number, clientY: number) => {
      const { viewer: current, source: picture } = latest.current;
      const point = current.pointToPage(clientX, clientY);
      if (point === null) return null;
      const frame = markPageFrameOf(current, point.pageIndex);
      const geometry = current.pageGeometry(point.pageIndex);
      if (frame === null || geometry === null) return null;
      const quarter = geometry.rotation === 90 || geometry.rotation === 270;
      const uprightWidth = quarter ? geometry.height : geometry.width;
      const uprightHeight = quarter ? geometry.width : geometry.height;
      const size = stampSize(picture, uprightWidth, uprightHeight);
      // The extents the stamp takes in app space: a quarter-turned page swaps them.
      const halfX = (quarter ? size.height : size.width) / 2;
      const halfY = (quarter ? size.width : size.height) / 2;
      const center = {
        x: Math.min(Math.max(point.x, geometry.x + halfX), geometry.x + geometry.width - halfX),
        y: Math.min(Math.max(point.y, halfY), geometry.height - halfY),
      };
      return { pageIndex: point.pageIndex, center, size, frame };
    };

    const onPointerMove = (event: PointerEvent): void => {
      const placement = pageGestureAt(event.clientX, event.clientY).available
        ? placementAt(event.clientX, event.clientY)
        : null;
      if (placement === null) {
        setGhost(null);
        return;
      }
      const middle = placement.frame.toScreen(placement.center);
      const width = placement.size.width * placement.frame.scale;
      const height = placement.size.height * placement.frame.scale;
      setGhost({ left: middle.x - width / 2, top: middle.y - height / 2, width, height });
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      if (!pageGestureAt(event.clientX, event.clientY).available) return;
      const placement = placementAt(event.clientX, event.clientY);
      if (placement === null) return;
      event.preventDefault();
      event.stopPropagation();
      releaseFocusHolder();
      latest.current.onPlace({
        pageIndex: placement.pageIndex,
        center: placement.center,
        width: placement.size.width,
        height: placement.size.height,
      });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      latest.current.onCancel();
    };

    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" data-stamp-placement="">
      <span className="sr-only" role="status">
        {hint}
      </span>
      {ghost === null ? null : (
        <img
          src={source.dataUrl}
          alt=""
          aria-hidden="true"
          data-stamp-ghost=""
          className="absolute opacity-70 outline outline-1 outline-dashed outline-pdf-accent/70"
          style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }}
        />
      )}
    </div>
  );
}
