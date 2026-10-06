/**
 * The four draggable corners over a photograph.
 *
 * The outline and the handles sit in a box that is exactly the picture's rectangle
 * (`FittedStage`), so a corner is a fraction of the picture and the same numbers work on
 * the reduced decode here and on the full-size one the PDF is made from.
 *
 *  - Handles are 44 px touch targets (the visible dot is smaller) and take pointer
 *    capture, so a finger that slides off a handle keeps dragging it.
 *  - While one is dragged a magnifier shows the picture at 4× around it, in the corner of
 *    the stage farthest from it: a fingertip hides exactly the pixels that matter.
 *  - Each handle is a keyboard control: arrow keys move it by 0.25 %, Shift by 2 %.
 *  - An outline that folds over itself (a corner dragged across its neighbour) is drawn
 *    in the danger colour; the host refuses to add such a page.
 */

import { isConvexQuad, type Point, type Quad } from 'pdf-core/ops/scan-geometry';
import type { Translator } from 'pdf-shared';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { FittedStage } from './FittedStage';
import { moveCorner } from './scan-pages';

export interface CornerEditorProps {
  readonly t: Translator;
  /** An object URL of the photograph. */
  readonly imageUrl: string;
  /** Width over height of the photograph. */
  readonly aspect: number;
  readonly quad: Quad;
  readonly onChange: (quad: Quad) => void;
}

const LABELS = [
  'scan.crop.corner.tl',
  'scan.crop.corner.tr',
  'scan.crop.corner.br',
  'scan.crop.corner.bl',
] as const;

const LOUPE = 112;
const ZOOM = 4;

export function CornerEditor({ t, imageUrl, aspect, quad, onChange }: CornerEditorProps) {
  const stage = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  /** The stage's size in px when a drag began: the loupe's scale is relative to it. */
  const [size, setSize] = useState({ width: 1, height: 1 });
  const valid = isConvexQuad(quad);

  const pointOf = (event: PointerEvent): Point | null => {
    const element = stage.current;
    if (element === null) return null;
    const rectangle = element.getBoundingClientRect();
    if (rectangle.width === 0 || rectangle.height === 0) return null;
    return {
      x: (event.clientX - rectangle.left) / rectangle.width,
      y: (event.clientY - rectangle.top) / rectangle.height,
    };
  };

  const onKey = (index: number, event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.02 : 0.0025;
    const point = quad[index] as Point;
    const move = (dx: number, dy: number) => {
      event.preventDefault();
      onChange(moveCorner(quad, index, { x: point.x + dx, y: point.y + dy }));
    };
    if (event.key === 'ArrowLeft') move(-step, 0);
    else if (event.key === 'ArrowRight') move(step, 0);
    else if (event.key === 'ArrowUp') move(0, -step);
    else if (event.key === 'ArrowDown') move(0, step);
  };

  const active = dragging === null ? null : (quad[dragging] as Point);
  const stroke = valid ? 'var(--color-pdf-accent, #2f6fed)' : 'var(--color-kumo-danger, #d92d20)';

  return (
    <FittedStage aspect={aspect} className="h-full w-full">
      <div ref={stage} className="absolute inset-0 touch-none select-none">
        <img src={imageUrl} alt="" draggable={false} className="size-full" />
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 size-full"
          aria-hidden="true"
        >
          <polygon
            points={quad.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')}
            fill={valid ? 'rgba(47,111,237,0.14)' : 'rgba(217,45,32,0.14)'}
            stroke={stroke}
            strokeWidth={2.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {quad.map((point, index) => (
          <button
            // The four corners are fixed roles, in a fixed order.
            // biome-ignore lint/suspicious/noArrayIndexKey: a corner is identified by its position
            key={index}
            type="button"
            aria-label={t(LABELS[index] as (typeof LABELS)[number])}
            className="absolute flex size-11 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus active:cursor-grabbing"
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              const bounds = stage.current?.getBoundingClientRect();
              if (bounds !== undefined) setSize({ width: bounds.width, height: bounds.height });
              setDragging(index);
            }}
            onPointerMove={(event) => {
              if (dragging !== index) return;
              const at = pointOf(event);
              if (at !== null) onChange(moveCorner(quad, index, at));
            }}
            onPointerUp={() => setDragging(null)}
            onPointerCancel={() => setDragging(null)}
            onKeyDown={(event) => onKey(index, event)}
          >
            <span
              className="size-5 rounded-full border-2 border-white shadow-md"
              style={{ background: stroke }}
            />
          </button>
        ))}
        {active === null ? null : (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute overflow-hidden rounded-full border-2 border-white shadow-lg"
            style={{
              width: LOUPE,
              height: LOUPE,
              // The corner of the stage farthest from the finger.
              ...(active.x < 0.5 ? { right: 8 } : { left: 8 }),
              ...(active.y < 0.5 ? { bottom: 8 } : { top: 8 }),
              backgroundImage: `url(${imageUrl})`,
              backgroundRepeat: 'no-repeat',
              // The picture at ZOOM times its size on the stage, moved so the handle's
              // point sits in the middle of the loupe.
              backgroundSize: `${ZOOM * size.width}px ${ZOOM * size.height}px`,
              backgroundPosition: `${LOUPE / 2 - active.x * ZOOM * size.width}px ${LOUPE / 2 - active.y * ZOOM * size.height}px`,
            }}
          >
            <span className="absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-transparent ring-1 ring-black/60" />
          </div>
        )}
      </div>
    </FittedStage>
  );
}
