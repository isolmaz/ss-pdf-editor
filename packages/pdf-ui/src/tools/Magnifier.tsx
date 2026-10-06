import type { Translator } from 'pdf-shared';
import { useEffect, useRef } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { type LensBitmap, lensRegion } from './lens';
import { type PageImage, pageImageAt } from './viewer-dom';
import './tools.css';

/**
 * Magnifier (`PLAN.md §5/Phase 1`): a lens that follows the pointer over the
 * pages and shows the region under it at 2×–8×.
 *
 * The lens never re-renders a page. When it activates — or the page under the
 * pointer or the viewer's scale changes — the bitmap pdf.js painted is copied
 * **once** into an offscreen canvas (`adopt`); every frame after that is a single
 * `drawImage` of a source region scaled into the lens (`lensRegion`), driven by a
 * `requestAnimationFrame` loop that only runs while the pointer is over a page
 * and stops on pointer leave, `Escape` and `active → false`.
 *
 * Pointer movement writes to the DOM directly (transform + canvas pixels) instead
 * of going through React state: a mouse move must not re-render the viewer, and
 * the engine's own render pipeline must not be touched by a hover.
 *
 * `Escape` hides the lens until the pointer leaves the pages, so a jittery mouse
 * cannot undo the dismissal immediately. While the lens is up, the wheel adjusts
 * its magnification instead of scrolling — the same wheel is the reader's again
 * as soon as the pointer is off a page.
 */

/** Lens diameter in CSS pixels; small enough to leave the context visible, large enough to read. */
const LENS_SIZE = 180;
const MIN_ZOOM = 2;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.5;

export interface MagnifierProps {
  readonly viewer: ViewerApi | null;
  readonly active: boolean;
  /** The interface language's translator: the lens's label follows the shell's locale. */
  readonly t: Translator;
  /** Lens magnification; values outside 2×–8× are clamped here. */
  readonly zoom: number;
  readonly onZoomChange: (zoom: number) => void;
}

function clampZoom(value: number): number {
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) * 10) / 10;
}

export function Magnifier({ viewer, active, t, zoom, onZoomChange }: MagnifierProps) {
  const lensRef = useRef<HTMLCanvasElement | null>(null);
  /** The crop of the page canvas the lens blits from (origin canvas + its position). */
  const windowRef = useRef<{
    origin: HTMLCanvasElement;
    canvas: HTMLCanvasElement;
    x: number;
    y: number;
    size: number;
  } | null>(null);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef(0);
  /** `Escape` hides the lens until the pointer leaves the pages. */
  const hiddenRef = useRef(false);
  const zoomRef = useRef(zoom);
  const zoomHandler = useRef(onZoomChange);

  useEffect(() => {
    zoomRef.current = zoom;
    zoomHandler.current = onZoomChange;
  });

  useEffect(() => {
    if (!active || viewer === null) return undefined;
    const lens = lensRef.current;
    if (lens === null) return undefined;

    const stop = () => {
      if (frameRef.current === 0) return;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
    const hide = () => {
      stop();
      lens.style.visibility = 'hidden';
    };

    /**
     * Every frame blits from a **small window** of the page canvas, not from a copy of
     * the whole thing. The first version copied the entire canvas whenever pdf.js
     * replaced or rescaled it — on a 130-page image-heavy document that is a ~20 MB copy
     * per page change, i.e. exactly the hitch the owner reported as an unstable
     * magnifier. The window is re-copied only when the pointer (or the lens zoom) needs
     * pixels outside it, which keeps a frame's work proportional to the lens, not to the
     * document.
     */
    const WINDOW_MARGIN = 1.5;
    const ensureWindow = (
      image: PageImage,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
    ): HTMLCanvasElement | null => {
      const current = windowRef.current;
      const inside =
        current !== null &&
        current.origin === image.canvas &&
        current.origin.width === image.canvas.width &&
        current.origin.height === image.canvas.height &&
        sx >= current.x &&
        sy >= current.y &&
        sx + sw <= current.x + current.size &&
        sy + sh <= current.y + current.size;
      if (inside && current !== null) return current.canvas;

      const size = Math.max(64, Math.ceil(Math.max(sw, sh) * WINDOW_MARGIN));
      const x = Math.min(
        Math.max(0, Math.round(sx - (size - sw) / 2)),
        Math.max(0, image.canvas.width - size),
      );
      const y = Math.min(
        Math.max(0, Math.round(sy - (size - sh) / 2)),
        Math.max(0, image.canvas.height - size),
      );
      const copy = document.createElement('canvas');
      copy.width = Math.min(size, image.canvas.width);
      copy.height = Math.min(size, image.canvas.height);
      const context = copy.getContext('2d');
      if (context === null) return null;
      context.drawImage(image.canvas, x, y, copy.width, copy.height, 0, 0, copy.width, copy.height);
      windowRef.current = { origin: image.canvas, canvas: copy, x, y, size: copy.width };
      return copy;
    };

    const frame = () => {
      frameRef.current = 0;
      const pointer = pointerRef.current;
      if (hiddenRef.current || pointer === null) {
        lens.style.visibility = 'hidden';
        return;
      }
      const image = pageImageAt(pointer.x, pointer.y);
      const context = lens.getContext('2d');
      if (image === null || context === null) {
        lens.style.visibility = 'hidden';
        return;
      }
      const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
      const deviceSize = Math.round(LENS_SIZE * dpr);
      if (lens.width !== deviceSize || lens.height !== deviceSize) {
        lens.width = deviceSize;
        lens.height = deviceSize;
      }
      // Geometry first (which source pixels), then the window that must hold them.
      const bitmap: LensBitmap = { bitmap: image.canvas, rect: image.rect };
      const [sx, sy, sw, sh, dx, dy, dw, dh] = lensRegion(bitmap, pointer, {
        cssSize: LENS_SIZE,
        deviceSize,
        zoom: zoomRef.current,
      });
      const crop = ensureWindow(image, sx, sy, sw, sh);
      if (crop === null || windowRef.current === null) {
        lens.style.visibility = 'hidden';
        return;
      }
      lens.style.transform = `translate(${pointer.x - LENS_SIZE / 2}px, ${pointer.y - LENS_SIZE / 2}px)`;
      lens.style.visibility = 'visible';
      context.clearRect(0, 0, deviceSize, deviceSize);
      context.save();
      context.beginPath();
      context.arc(deviceSize / 2, deviceSize / 2, deviceSize / 2, 0, Math.PI * 2);
      context.clip();
      // The window is a crop of the page canvas at (x, y), so the source rectangle
      // moves with it; a magnified lens shows a small crop, where nearest-neighbour
      // stays legible.
      context.imageSmoothingEnabled = zoomRef.current <= 3;
      context.drawImage(crop, sx - windowRef.current.x, sy - windowRef.current.y, sw, sh, dx, dy, dw, dh);
      context.restore();
      frameRef.current = requestAnimationFrame(frame);
    };

    const onPointerMove = (event: PointerEvent) => {
      const image = pageImageAt(event.clientX, event.clientY);
      if (image === null) {
        // Off the pages — the surround, the dock, a page that has not rendered
        // yet: nothing to magnify. Leaving the pages also arms the lens again
        // after an `Escape`.
        const wasShowing = pointerRef.current !== null;
        pointerRef.current = null;
        hiddenRef.current = false;
        if (wasShowing) hide();
        return;
      }
      // `Escape` keeps the lens out of the way while the pointer stays on a page.
      if (hiddenRef.current) return;
      // A page whose canvas has not been painted yet has nothing to magnify.
      if (image.canvas.width === 0 || image.canvas.height === 0) {
        pointerRef.current = null;
        hide();
        return;
      }
      pointerRef.current = { x: event.clientX, y: event.clientY };
      if (frameRef.current === 0) frameRef.current = requestAnimationFrame(frame);
    };

    /** `relatedTarget === null` is the pointer leaving the document, not a child element. */
    const onPointerOut = (event: PointerEvent) => {
      if (event.relatedTarget !== null) return;
      pointerRef.current = null;
      hiddenRef.current = false;
      hide();
    };

    const onWheel = (event: WheelEvent) => {
      if (pointerRef.current === null) return;
      event.preventDefault();
      event.stopPropagation();
      const next = clampZoom(zoomRef.current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
      if (next === zoomRef.current) return;
      // Accumulate locally: several wheel events can arrive before the shell
      // re-renders with the new zoom.
      zoomRef.current = next;
      zoomHandler.current(next);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      pointerRef.current = null;
      hiddenRef.current = true;
      hide();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerout', onPointerOut, true);
    window.addEventListener('wheel', onWheel, { passive: false, capture: true });
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerout', onPointerOut, true);
      window.removeEventListener('wheel', onWheel, { capture: true });
      window.removeEventListener('keydown', onKeyDown);
      stop();
      windowRef.current = null;
      pointerRef.current = null;
    };
  }, [active, viewer]);

  if (!active || viewer === null) return null;

  return (
    <>
      <canvas
        ref={lensRef}
        className="pdf-tools-lens pdf-overlay-shadow border border-kumo-line bg-kumo-base"
        style={{ width: LENS_SIZE, height: LENS_SIZE, visibility: 'hidden' }}
      />
      <div className="pdf-tools-magnifier pdf-floating-shadow flex items-center gap-2 rounded-md border border-kumo-line bg-kumo-base px-2 py-1">
        <label className="flex items-center gap-2">
          <span className="text-xs text-kumo-subtle">{t('tools.magnifier')}</span>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            value={zoom}
            onChange={(event) => zoomHandler.current(clampZoom(Number(event.currentTarget.value)))}
            className="w-28"
          />
        </label>
        <span className="min-w-8 text-center text-xs text-kumo-default tabular-nums">{`${zoom}×`}</span>
      </div>
    </>
  );
}
