/**
 * Redaction marking layer (`REPORT.md §3` A14).
 *
 * The user draws the areas to erase **on the page**, and what they see is what the
 * engine erases: every rectangle is converted at pointer-up through
 * `ViewerApi.pointToPage`, which uses pdf.js's own `PageViewport.convertToPdfPoint`
 * — so zoom, the spread layout and the page's `/Rotate` are accounted for by the
 * engine rather than by arithmetic here.
 *
 * The layer is an overlay, not a second viewer: it takes pointer events only while
 * the tool is active (`pointerEvents: 'auto'` on an otherwise inert, transparent
 * box), draws its preview in the same coordinate space as the pointer, and hands
 * the finished mark to the app. It never touches the document (`AGENTS.md`: state
 * changes go through the model).
 *
 * A drawn box smaller than `MIN_MARK_SIZE` points is discarded: a click is not a
 * redaction mark, and a 1-pixel mark would erase nothing while looking like it did.
 */

import type { RedactRect } from 'pdf-core';
import type { Translator } from 'pdf-shared';
import { useCallback, useRef, useState } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';

/** Below this (in CSS pixels) a drag is a click, not a rectangle. */
const MIN_MARK_SIZE = 6;

export interface RedactionLayerProps {
  readonly t: Translator;
  readonly viewer: ViewerApi;
  /** A finished rectangle, in unrotated page points with a top-left origin. */
  readonly onMark: (mark: RedactRect) => void;
  /** Called after a mark so the app can leave the tool (mirrors Acrobat's one-shot marking). */
  readonly onDone?: () => void;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  currentX: number;
  currentY: number;
}

export function RedactionLayer({ t, viewer, onMark, onDone }: RedactionLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<{
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } | null>(null);

  const boundsOf = useCallback((): DOMRect | null => layerRef.current?.getBoundingClientRect() ?? null, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const bounds = boundsOf();
      if (bounds === null) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
      };
      setPreview({
        left: event.clientX - bounds.left,
        top: event.clientY - bounds.top,
        width: 0,
        height: 0,
      });
    },
    [boundsOf],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const bounds = boundsOf();
      if (drag === null || bounds === null) return;
      drag.currentX = event.clientX;
      drag.currentY = event.clientY;
      setPreview({
        left: Math.min(drag.startX, drag.currentX) - bounds.left,
        top: Math.min(drag.startY, drag.currentY) - bounds.top,
        width: Math.abs(drag.currentX - drag.startX),
        height: Math.abs(drag.currentY - drag.startY),
      });
    },
    [boundsOf],
  );

  const finish = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setPreview(null);
      if (drag === null) return;
      if (event.currentTarget.hasPointerCapture(drag.pointerId)) {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      }
      const width = Math.abs(drag.currentX - drag.startX);
      const height = Math.abs(drag.currentY - drag.startY);
      if (width < MIN_MARK_SIZE || height < MIN_MARK_SIZE) return;

      // Both corners go through the viewer's own mapping, so the rectangle is
      // correct even when the page is rotated or the drag crosses a page boundary
      // (in which case the start corner's page wins and the far corner is clamped
      // by the engine's own bounds check later).
      const start = viewer.pointToPage(drag.startX, drag.startY);
      const end = viewer.pointToPage(drag.currentX, drag.currentY);
      if (start === null || end === null || start.pageIndex !== end.pageIndex) return;
      const mark: RedactRect = {
        pageIndex: start.pageIndex,
        space: 'app-v1',
        rect: [
          Math.min(start.x, end.x),
          Math.min(start.y, end.y),
          Math.max(start.x, end.x),
          Math.max(start.y, end.y),
        ],
      };
      onMark(mark);
      onDone?.();
    },
    [onDone, onMark, viewer],
  );

  return (
    <div
      ref={layerRef}
      // The layer covers the laid-out pages but only intercepts the pointer while the
      // tool is armed — the parent renders it conditionally, so reaching here always
      // means "drawing". The viewer's overlay host is inert (`pointer-events: none` is
      // inherited), so the layer takes the pointer back explicitly.
      className="pointer-events-auto absolute inset-0 z-20 cursor-crosshair"
      role="application"
      aria-label={t('redact.mode.box')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    >
      {preview === null ? null : (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute border border-kumo-danger bg-kumo-danger/25"
          style={{
            left: `${preview.left}px`,
            top: `${preview.top}px`,
            width: `${preview.width}px`,
            height: `${preview.height}px`,
          }}
        />
      )}
    </div>
  );
}
