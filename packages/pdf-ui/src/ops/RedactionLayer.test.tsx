// @vitest-environment happy-dom
/**
 * The redaction layer: a drag over the page becomes one rectangle in unrotated page points,
 * both corners converted by the viewer's own mapping; a click, a stray drag, a drag the
 * viewer cannot place, a drag another pointer interrupts or one the browser cancels produces none.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { RedactionLayer } from './RedactionLayer';

afterEach(cleanup);

/** Pages sit side by side: client x < 500 is page 0, x ≥ 500 page 1, and y > 900 is off every page. */
const viewer = {
  pointToPage: (clientX: number, clientY: number) =>
    clientY > 900 ? null : { pageIndex: clientX >= 500 ? 1 : 0, x: clientX - 100, y: clientY - 50 },
} as unknown as ViewerApi;

function show(onDone?: () => void) {
  const onMark = vi.fn();
  const { container } = render(
    <RedactionLayer t={createTranslator('en')} viewer={viewer} onMark={onMark} onDone={onDone} />,
  );
  const layer = container.querySelector<HTMLElement>('[data-redaction-layer]') as HTMLElement;
  // The layer starts 30 px right of and 20 px below the client origin.
  layer.getBoundingClientRect = () => new DOMRect(30, 20, 800, 600);
  return { layer, onMark };
}

const drag = async (
  layer: HTMLElement,
  from: { clientX: number; clientY: number },
  to: { clientX: number; clientY: number },
) => {
  const user = userEvent.setup();
  await user.pointer([
    { keys: '[MouseLeft>]', target: layer, coords: from },
    { target: layer, coords: to },
    { keys: '[/MouseLeft]', target: layer, coords: to },
  ]);
};

const previewOf = (layer: HTMLElement) => layer.querySelector<HTMLElement>('span[aria-hidden="true"]');

describe('RedactionLayer', () => {
  it('marks the rectangle between the two corners the viewer maps, in page points', async () => {
    const { layer, onMark } = show();
    await drag(layer, { clientX: 300, clientY: 250 }, { clientX: 200, clientY: 100 });
    expect(onMark).toHaveBeenCalledExactlyOnceWith({
      pageIndex: 0,
      space: 'app-v1',
      rect: [100, 50, 200, 200],
    });
  });

  it('leaves the tool after a mark when the app asks for one-shot marking', async () => {
    const onDone = vi.fn();
    const { layer, onMark } = show(onDone);
    await drag(layer, { clientX: 100, clientY: 100 }, { clientX: 150, clientY: 160 });
    expect(onMark).toHaveBeenCalledOnce();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('shows the box being drawn relative to the layer, and removes it when the drag ends', async () => {
    const { layer } = show();
    const user = userEvent.setup();
    await user.pointer([
      { keys: '[MouseLeft>]', target: layer, coords: { clientX: 300, clientY: 250 } },
      { target: layer, coords: { clientX: 200, clientY: 100 } },
    ]);
    const box = previewOf(layer);
    expect(box?.style.cssText).toBe('left: 170px; top: 80px; width: 100px; height: 150px;');
    await user.pointer({ keys: '[/MouseLeft]', target: layer, coords: { clientX: 200, clientY: 100 } });
    expect(previewOf(layer)).toBeNull();
  });

  it('draws nothing while the pointer moves without a press', async () => {
    const { layer, onMark } = show();
    await userEvent.setup().pointer({ target: layer, coords: { clientX: 200, clientY: 100 } });
    expect(previewOf(layer)).toBeNull();
    expect(onMark).not.toHaveBeenCalled();
  });

  it('ignores the buttons other than the primary one', async () => {
    const { layer, onMark } = show();
    await userEvent.setup().pointer([
      { keys: '[MouseRight>]', target: layer, coords: { clientX: 100, clientY: 100 } },
      { target: layer, coords: { clientX: 300, clientY: 300 } },
      { keys: '[/MouseRight]', target: layer, coords: { clientX: 300, clientY: 300 } },
    ]);
    expect(previewOf(layer)).toBeNull();
    expect(onMark).not.toHaveBeenCalled();
  });

  it.each([
    ['a click', { clientX: 100, clientY: 100 }, { clientX: 100, clientY: 100 }],
    ['a drag narrower than 6 px', { clientX: 100, clientY: 100 }, { clientX: 105, clientY: 200 }],
    ['a drag shorter than 6 px', { clientX: 100, clientY: 100 }, { clientX: 300, clientY: 105 }],
  ])('discards %s', async (_title, from, to) => {
    const onDone = vi.fn();
    const { layer, onMark } = show(onDone);
    await drag(layer, from, to);
    expect(onMark).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('marks a drag of exactly 6 px each way', async () => {
    const { layer, onMark } = show();
    await drag(layer, { clientX: 100, clientY: 100 }, { clientX: 106, clientY: 106 });
    expect(onMark).toHaveBeenCalledExactlyOnceWith({ pageIndex: 0, space: 'app-v1', rect: [0, 50, 6, 56] });
  });

  it('holds the pointer through the drag and gives it back at the end, and still marks when the browser already took it', async () => {
    const { layer, onMark } = show();
    const user = userEvent.setup();
    const release = vi.spyOn(layer, 'releasePointerCapture');
    await user.pointer({ keys: '[MouseLeft>]', target: layer, coords: { clientX: 100, clientY: 100 } });
    expect(layer.hasPointerCapture(1)).toBe(true);
    await user.pointer([
      { target: layer, coords: { clientX: 200, clientY: 200 } },
      { keys: '[/MouseLeft]', target: layer, coords: { clientX: 200, clientY: 200 } },
    ]);
    expect(release).toHaveBeenCalledExactlyOnceWith(1);
    expect(onMark).toHaveBeenCalledOnce();

    release.mockClear();
    await user.pointer({ keys: '[MouseLeft>]', target: layer, coords: { clientX: 100, clientY: 100 } });
    layer.releasePointerCapture(1);
    release.mockClear();
    await user.pointer([
      { target: layer, coords: { clientX: 200, clientY: 200 } },
      { keys: '[/MouseLeft]', target: layer, coords: { clientX: 200, clientY: 200 } },
    ]);
    expect(release).not.toHaveBeenCalled();
    expect(onMark).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['starts off the pages', { clientX: 100, clientY: 950 }, { clientX: 300, clientY: 300 }],
    ['ends off the pages', { clientX: 100, clientY: 100 }, { clientX: 300, clientY: 950 }],
    ['crosses from one page to another', { clientX: 300, clientY: 100 }, { clientX: 600, clientY: 300 }],
  ])('discards a drag that %s', async (_title, from, to) => {
    const { layer, onMark } = show();
    await drag(layer, from, to);
    expect(onMark).not.toHaveBeenCalled();
  });

  it('adds no rectangle when the browser cancels the gesture, and lets go of the preview and the pointer', async () => {
    const onDone = vi.fn();
    const { layer, onMark } = show(onDone);
    const user = userEvent.setup();
    await user.pointer([
      { keys: '[MouseLeft>]', target: layer, coords: { clientX: 100, clientY: 100 } },
      { target: layer, coords: { clientX: 300, clientY: 300 } },
    ]);
    expect(previewOf(layer)).not.toBeNull();
    expect(layer.hasPointerCapture(1)).toBe(true);
    // A finger that starts to scroll the page: the browser cancels the pointer.
    fireEvent.pointerCancel(layer, { pointerId: 1, clientX: 300, clientY: 300 });
    expect(previewOf(layer)).toBeNull();
    expect(layer.hasPointerCapture(1)).toBe(false);
    // What the cancelled drag had drawn is not a mark, whatever arrives after it.
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: 300, clientY: 300 });
    expect(onMark).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("keeps the drag of one pointer when another pointer moves, lifts or is cancelled, and ends with the drag's own", async () => {
    const { layer, onMark } = show();
    const user = userEvent.setup();
    await user.pointer({ keys: '[MouseLeft>]', target: layer, coords: { clientX: 100, clientY: 100 } });
    const started = 'left: 70px; top: 80px; width: 0px; height: 0px;';
    expect(previewOf(layer)?.style.cssText).toBe(started);

    // A second finger, far away, does everything a pointer can do.
    fireEvent.pointerMove(layer, { pointerId: 7, clientX: 700, clientY: 500 });
    expect(previewOf(layer)?.style.cssText).toBe(started);
    fireEvent.pointerUp(layer, { pointerId: 7, clientX: 700, clientY: 500 });
    fireEvent.pointerCancel(layer, { pointerId: 7 });
    expect(previewOf(layer)?.style.cssText).toBe(started);
    expect(onMark).not.toHaveBeenCalled();

    await user.pointer([
      { target: layer, coords: { clientX: 200, clientY: 200 } },
      { keys: '[/MouseLeft]', target: layer, coords: { clientX: 200, clientY: 200 } },
    ]);
    expect(onMark).toHaveBeenCalledExactlyOnceWith({
      pageIndex: 0,
      space: 'app-v1',
      rect: [0, 50, 100, 150],
    });
  });

  it('ends nothing for a pointer that began no drag', () => {
    const { layer, onMark } = show();
    fireEvent.pointerUp(layer, { pointerId: 1, clientX: 200, clientY: 200 });
    fireEvent.pointerCancel(layer, { pointerId: 1 });
    expect(onMark).not.toHaveBeenCalled();
  });

  it('is a drawing surface for a pointer, named by a status and not by a widget role it cannot honour', () => {
    const { layer } = show();
    expect(screen.queryByRole('application')).toBeNull();
    expect(layer.hasAttribute('role')).toBe(false);
    const name = within(layer).getByText('Draw rectangle');
    expect(name.getAttribute('aria-live')).toBe('polite');
    expect(name.className).toContain('sr-only');
  });

  it('keeps a finger that draws from scrolling the page', () => {
    const { layer } = show();
    expect(layer.classList.contains('touch-none')).toBe(true);
  });
});
