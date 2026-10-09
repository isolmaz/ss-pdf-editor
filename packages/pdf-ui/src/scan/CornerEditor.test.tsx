// @vitest-environment happy-dom
/**
 * The four corner handles over a photograph: where they sit, what a drag and a key press
 * ask the host to change them to, the magnifier that follows a drag, and the colour of an
 * outline that folds over itself. The stage is a 400 × 200 box at (100, 50) — happy-dom has
 * no layout — so a client pixel is a fraction of the picture by simple arithmetic.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Quad } from 'pdf-core/ops/scan-geometry';
import { createTranslator } from 'pdf-shared';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CornerEditor } from './CornerEditor';

const t = createTranslator('en');
const IMAGE = 'blob:photo-1';

const SQUARE: Quad = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
];
/** Top-right and bottom-right swapped: the outline crosses itself. */
const BOW_TIE: Quad = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.9, y: 0.1 },
  { x: 0.1, y: 0.9 },
];

let stage = { left: 100, top: 50, width: 400, height: 200 };
const captured: number[] = [];

beforeEach(() => {
  stage = { left: 100, top: 50, width: 400, height: 200 };
  captured.length = 0;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ ...stage, right: stage.left + stage.width, bottom: stage.top + stage.height }) as DOMRect,
  );
  HTMLElement.prototype.setPointerCapture = (pointerId: number) => {
    captured.push(pointerId);
  };
  // A real viewport has no ResizeObserver-driven size here: the editor's frame is not under test.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
});

/** The editor under a host that keeps the quad, as the scanner does, and records every change. */
function renderEditor(initial: Quad = SQUARE, aspect = 2) {
  const changes: Quad[] = [];
  function Host() {
    const [quad, setQuad] = useState<Quad>(initial);
    return (
      <CornerEditor
        t={t}
        imageUrl={IMAGE}
        aspect={aspect}
        quad={quad}
        onChange={(next) => {
          changes.push(next);
          setQuad(next);
        }}
      />
    );
  }
  const view = render(<Host />);
  return { ...view, changes };
}

const corner = (name: string) => screen.getByRole('button', { name });
const loupe = (container: HTMLElement) =>
  container.querySelector('div[aria-hidden="true"]') as HTMLElement | null;
const polygon = (container: HTMLElement) => container.querySelector('polygon') as SVGPolygonElement;

describe('CornerEditor layout', () => {
  it('puts a labelled handle on each corner, at its fraction of the picture', () => {
    renderEditor();
    const expected = [
      ['Top-left corner', '10%', '10%'],
      ['Top-right corner', '90%', '10%'],
      ['Bottom-right corner', '90%', '90%'],
      ['Bottom-left corner', '10%', '90%'],
    ];
    for (const [name, left, top] of expected) {
      expect(corner(name as string).style.left).toBe(left);
      expect(corner(name as string).style.top).toBe(top);
    }
  });

  it('shows the photograph and outlines the corners in the accent colour', () => {
    const { container } = renderEditor();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(IMAGE);
    expect(polygon(container).getAttribute('points')).toBe('10,10 90,10 90,90 10,90');
    expect(polygon(container).getAttribute('stroke')).toBe('var(--color-pdf-accent, #2f6fed)');
    expect(polygon(container).getAttribute('fill')).toBe('rgba(47,111,237,0.14)');
  });

  it('draws an outline that folds over itself in the danger colour', () => {
    const { container } = renderEditor(BOW_TIE);
    expect(polygon(container).getAttribute('stroke')).toBe('var(--color-kumo-danger, #d92d20)');
    expect(polygon(container).getAttribute('fill')).toBe('rgba(217,45,32,0.14)');
  });
});

describe('CornerEditor dragging', () => {
  it('moves the dragged corner to the pointer, as a fraction of the picture, and leaves the others', () => {
    const { changes } = renderEditor();
    const handle = corner('Top-left corner');
    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 140, clientY: 70 });
    expect(captured).toEqual([7]);
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 300, clientY: 100 });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.[0]).toEqual({ x: 0.5, y: 0.25 });
    expect(changes[0]?.[1]).toEqual(SQUARE[1]);
    expect(changes[0]?.[2]).toEqual(SQUARE[2]);
    expect(changes[0]?.[3]).toEqual(SQUARE[3]);
    expect(handle.style.left).toBe('50%');
    expect(handle.style.top).toBe('25%');
  });

  it('keeps a corner dragged past the picture inside it', () => {
    const { changes } = renderEditor();
    const handle = corner('Bottom-right corner');
    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900, clientY: -40 });
    expect(changes[0]?.[2]).toEqual({ x: 1, y: 0 });
  });

  it('ignores movement of a handle that is not being dragged', () => {
    const { changes } = renderEditor();
    fireEvent.pointerMove(corner('Top-left corner'), { pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerDown(corner('Top-right corner'), { pointerId: 1 });
    fireEvent.pointerMove(corner('Top-left corner'), { pointerId: 1, clientX: 300, clientY: 100 });
    expect(changes).toEqual([]);
  });

  it('asks for no change while the stage has no size', () => {
    const { changes } = renderEditor();
    const handle = corner('Top-left corner');
    fireEvent.pointerDown(handle, { pointerId: 1 });
    stage = { left: 0, top: 0, width: 0, height: 200 };
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 100 });
    stage = { left: 0, top: 0, width: 400, height: 0 };
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 100 });
    expect(changes).toEqual([]);
  });

  it('shows a magnifier at 4× around the dragged corner, in the corner of the stage farthest from it', () => {
    const { container } = renderEditor();
    expect(loupe(container)).toBeNull();
    fireEvent.pointerDown(corner('Top-left corner'), { pointerId: 1 });
    const top = loupe(container) as HTMLElement;
    expect(top.style.right).toBe('8px');
    expect(top.style.bottom).toBe('8px');
    expect(top.style.left).toBe('');
    expect(top.style.width).toBe('112px');
    expect(top.style.backgroundImage).toContain(IMAGE);
    // The picture at 4× the stage (400 × 200), the corner's point (0.1, 0.1) in the loupe's middle (56).
    expect(top.style.backgroundSize).toBe('1600px 800px');
    expect(top.style.backgroundPosition).toBe(`${56 - 0.1 * 1600}px ${56 - 0.1 * 800}px`);
  });

  it('puts the magnifier at the upper left for a corner in the lower right', () => {
    const { container } = renderEditor();
    fireEvent.pointerDown(corner('Bottom-right corner'), { pointerId: 1 });
    const bottom = loupe(container) as HTMLElement;
    expect(bottom.style.left).toBe('8px');
    expect(bottom.style.top).toBe('8px');
    expect(bottom.style.right).toBe('');
    expect(bottom.style.bottom).toBe('');
  });

  it('puts the magnifier at the lower left for a corner in the upper right, and the upper right for one in the lower left', () => {
    const { container } = renderEditor();
    fireEvent.pointerDown(corner('Top-right corner'), { pointerId: 1 });
    expect(loupe(container)?.style.left).toBe('8px');
    expect(loupe(container)?.style.bottom).toBe('8px');
    fireEvent.pointerUp(corner('Top-right corner'), { pointerId: 1 });
    fireEvent.pointerDown(corner('Bottom-left corner'), { pointerId: 1 });
    expect(loupe(container)?.style.right).toBe('8px');
    expect(loupe(container)?.style.top).toBe('8px');
  });

  it('measures the stage when a drag begins, so the magnifier scales with it', () => {
    stage = { left: 0, top: 0, width: 200, height: 100 };
    const { container } = renderEditor();
    fireEvent.pointerDown(corner('Top-left corner'), { pointerId: 1 });
    expect(loupe(container)?.style.backgroundSize).toBe('800px 400px');
  });

  it('ends the drag, and the magnifier, when the pointer is released', () => {
    const { container, changes } = renderEditor();
    const handle = corner('Top-left corner');
    fireEvent.pointerDown(handle, { pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(loupe(container)).toBeNull();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 100 });
    expect(changes).toEqual([]);
  });

  it('ends the drag when the browser cancels the pointer', () => {
    const { container } = renderEditor();
    const handle = corner('Top-left corner');
    fireEvent.pointerDown(handle, { pointerId: 1 });
    expect(loupe(container)).not.toBeNull();
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(loupe(container)).toBeNull();
  });
});

describe('CornerEditor keyboard', () => {
  it.each([
    ['ArrowLeft', { x: 0.1 - 0.0025, y: 0.1 }],
    ['ArrowRight', { x: 0.1 + 0.0025, y: 0.1 }],
    ['ArrowUp', { x: 0.1, y: 0.1 - 0.0025 }],
    ['ArrowDown', { x: 0.1, y: 0.1 + 0.0025 }],
  ])('%s moves the focused corner by a quarter of a percent', (key, to) => {
    const { changes } = renderEditor();
    const prevented = !fireEvent.keyDown(corner('Top-left corner'), { key });
    expect(prevented).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.[0].x).toBeCloseTo(to.x, 12);
    expect(changes[0]?.[0].y).toBeCloseTo(to.y, 12);
    expect(changes[0]?.[1]).toEqual(SQUARE[1]);
  });

  it('moves by two percent with Shift held', () => {
    const { changes } = renderEditor();
    fireEvent.keyDown(corner('Bottom-right corner'), { key: 'ArrowLeft', shiftKey: true });
    expect(changes[0]?.[2].x).toBeCloseTo(0.88, 12);
    expect(changes[0]?.[2].y).toBe(0.9);
  });

  it('keeps a corner pushed at the edge inside the picture', () => {
    const { changes } = renderEditor([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    fireEvent.keyDown(corner('Top-left corner'), { key: 'ArrowLeft' });
    expect(changes[0]?.[0]).toEqual({ x: 0, y: 0 });
  });

  it('leaves other keys alone, for the browser to handle', () => {
    const { changes } = renderEditor();
    const prevented = !fireEvent.keyDown(corner('Top-left corner'), { key: 'Tab' });
    expect(prevented).toBe(false);
    expect(changes).toEqual([]);
  });
});
