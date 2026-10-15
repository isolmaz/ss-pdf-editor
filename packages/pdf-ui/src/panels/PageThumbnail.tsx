import type { PdfDocumentHandle } from 'pdf-core';
import type { AnnotationMark } from 'pdf-core/ops/annotations';
import { useCallback, useEffect, useRef, useState } from 'react';
import { markVisual } from '../ops/AnnotationLayer';
import { type MarkPageFrame, markPageFrame } from '../ops/mark-interaction';

/**
 * A canvas given up: a canvas keeps its pixel buffer until the element is collected, and
 * a thumbnail list of a long document scrolled end to end holds hundreds of them (a
 * 2000-page file at a high pixel density is an estimated half a gigabyte). Zero size drops
 * the buffer now.
 */
function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

export interface PageThumbnailProps {
  readonly document: PdfDocumentHandle;
  readonly pageIndex: number;
  readonly marks: readonly AnnotationMark[];
  /** The width the page is drawn at; the page's own aspect ratio supplies the height. */
  readonly width: number;
  /**
   * A height the page must also fit in (the organize grid's fixed cells): the page is scaled
   * down to the smaller of the two, so a tall page does not push its row apart.
   */
  readonly maxHeight?: number;
  /** How far outside the window the page is still drawn. */
  readonly rootMargin?: string;
}

/**
 * One page's canvas, drawn when the item becomes visible and never eagerly: the whole
 * point of the observer is that a 2000-page document costs 2000 cheap placeholders, not
 * 2000 render tasks. It works the other way round too: an item that scrolls away stops
 * its render and gives its canvas up, keeping its height so the list does not move, and is
 * drawn again when it comes back — so what the list holds is what is near the window.
 *
 * The page list and the organize grid draw their pages with this one renderer.
 */
export function PageThumbnail({
  document,
  pageIndex,
  marks,
  width,
  maxHeight,
  rootMargin = '120px',
}: PageThumbnailProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const paintedRef = useRef(false);
  const [shownSize, setShownSize] = useState<{ width: number; height: number } | null>(null);
  /** The painted page's projection, for the marks drawn over it; null until it is painted. */
  const [frame, setFrame] = useState<MarkPageFrame | null>(null);

  /**
   * Each attempt owns a **fresh canvas**. Reusing the element across tab switches
   * let a superseded render task (aborted, or still finishing after the panel
   * remounted) write into the same node as its replacement: the result was a
   * page drawn upside down.
   */
  const draw = useCallback(
    async (holder: HTMLElement, signal: AbortSignal) => {
      const page = await document.getPageSize(pageIndex, 1);
      const scale = Math.min(width / page.width, (maxHeight ?? Number.POSITIVE_INFINITY) / page.height);
      const shown = {
        x: 0,
        y: 0,
        width: Math.round(page.width * scale),
        height: Math.round(page.height * scale),
      };
      setShownSize({ width: shown.width, height: shown.height });
      // `document` here is the PDF handle prop, not the global: reach for the DOM explicitly.
      const canvas = globalThis.document.createElement('canvas');
      canvas.className = 'max-w-full';
      canvas.width = shown.width;
      canvas.height = shown.height;
      try {
        await document.renderPage(pageIndex, canvas, { scale, signal });
      } catch (error) {
        releaseCanvas(canvas);
        throw error;
      }
      if (signal.aborted) {
        releaseCanvas(canvas);
        return;
      }
      // The picture of an earlier document or revision gives its buffer up as it is replaced.
      for (const previous of holder.querySelectorAll('canvas')) releaseCanvas(previous);
      holder.replaceChildren(canvas);
      const [x0, y0, x1, y1] = page.viewBox;
      setFrame(
        markPageFrame({
          rotation: (((page.rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270,
          originX: x0,
          top: y1,
          width: x1 - x0,
          height: y1 - y0,
          page: shown,
          container: shown,
        }),
      );
      paintedRef.current = true;
    },
    [document, pageIndex, width, maxHeight],
  );

  useEffect(() => {
    // The holder is rendered unconditionally, so the ref is set by the time an effect runs.
    const holder = holderRef.current as HTMLDivElement;
    // `draw` changes exactly when the handle, the page or the size does, so what is painted is
    // stale from here on. The item keeps its key across a document swap of the same
    // length (two freshly opened files are both state `source`) and across a write
    // whose new handle lands after its new state id — a flag that survived either kept
    // the previous document's picture on screen.
    paintedRef.current = false;
    setFrame(null);
    /** The render of the current visit; every visit has its own, so leaving stops exactly that one. */
    let attempt: AbortController | null = null;
    // Lazy, and **staying** lazy: the observer is not disconnected after the first
    // hit, so a thumbnail whose attempt was aborted is drawn when it next
    // becomes visible instead of staying blank forever.
    const observer = new IntersectionObserver(
      (entries) => {
        // One target: the last report is where the item is now.
        if ((entries.at(-1) as { isIntersecting: boolean }).isIntersecting) {
          if (paintedRef.current) return;
          attempt?.abort();
          attempt = new AbortController();
          void draw(holder, attempt.signal).catch(() => undefined);
          return;
        }
        // Out of reach: stop a render still running, and give a finished picture's buffer up.
        attempt?.abort();
        attempt = null;
        if (!paintedRef.current) return;
        for (const canvas of holder.querySelectorAll('canvas')) releaseCanvas(canvas);
        holder.replaceChildren();
        paintedRef.current = false;
        setFrame(null);
      },
      { rootMargin },
    );
    observer.observe(holder);
    return () => {
      observer.disconnect();
      attempt?.abort();
    };
  }, [draw, rootMargin]);

  // The canvas and the marks share one isolated box the size of the painted page: a
  // highlight's multiply then blends with the page under it and nothing outside.
  return (
    <div className="flex justify-center">
      <div
        className="relative isolate overflow-hidden bg-pdf-paper"
        data-thumbnail-page=""
        style={{
          width: shownSize?.width ?? width,
          height: shownSize?.height ?? (maxHeight === undefined ? 140 : Math.min(maxHeight, width * 1.3)),
        }}
      >
        <div ref={holderRef} />
        {frame === null || marks.length === 0 ? null : (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0" data-thumbnail-marks="">
            {marks.map((mark) => markVisual(mark, frame, false))}
          </div>
        )}
      </div>
    </div>
  );
}
