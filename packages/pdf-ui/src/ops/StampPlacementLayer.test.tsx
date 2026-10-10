// @vitest-environment happy-dom
/**
 * Placing a picture with one click: a translucent copy follows the pointer over a page at the
 * size it will have, a click puts it there (centre in app space, upright size in points), and
 * Escape or a click off the pages places nothing.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import {
  StampPlacementLayer,
  type StampPlacementLayerProps,
  type StampPlacementSource,
  stampSize,
} from './StampPlacementLayer';

const signature: StampPlacementSource = {
  role: 'signature',
  dataUrl: 'data:image/png;base64,AA',
  pixelWidth: 400,
  pixelHeight: 100,
};

describe('stampSize', () => {
  const roomy = [1000, 1000] as const;

  it('gives a signature 160 pt across and an initials 60 pt, in the picture’s own aspect', () => {
    expect(stampSize(signature, ...roomy)).toEqual({ width: 160, height: 40 });
    expect(
      stampSize({ ...signature, role: 'initials', pixelWidth: 200, pixelHeight: 100 }, ...roomy),
    ).toEqual({
      width: 60,
      height: 30,
    });
  });

  it('places an image at 96 dpi, three quarters of a point per pixel', () => {
    expect(stampSize({ ...signature, role: 'image', pixelWidth: 200, pixelHeight: 100 }, ...roomy)).toEqual({
      width: 150,
      height: 75,
    });
  });

  it('shrinks a picture that would pass 60 % of the page either way, keeping its aspect', () => {
    const image: StampPlacementSource = { ...signature, role: 'image', pixelWidth: 800, pixelHeight: 200 };
    // 600 pt wide on a 500 pt page: 300 pt allowed → half.
    expect(stampSize(image, 500, 1000)).toEqual({ width: 300, height: 75 });
    // Tall on a short page: 60 % of 60 pt is 36 pt of the 150 pt height → 0.24.
    const tall: StampPlacementSource = { ...signature, role: 'image', pixelWidth: 100, pixelHeight: 200 };
    expect(stampSize(tall, 1000, 60)).toEqual({ width: 75 * 0.24, height: 150 * 0.24 });
  });

  it('treats a picture with no width as one pixel wide, so the aspect stays finite', () => {
    // Aspect 10 / 1: 160 × 1600 pt, cut to the 600 pt that 60 % of a 1000 pt page allows.
    expect(stampSize({ ...signature, pixelWidth: 0, pixelHeight: 10 }, ...roomy)).toEqual({
      width: 60,
      height: 600,
    });
  });
});

/** A 600 × 800 pt page drawn at 50 % at (100, 50) of the container, turned by `rotation`. */
function viewerFor(rotation: 0 | 90 | 180 | 270, hole?: 'geometry' | 'rect' | 'point'): ViewerApi {
  const quarter = rotation === 90 || rotation === 270;
  return {
    pointToPage: () => (hole === 'point' ? null : { pageIndex: 0, x: pointer.x, y: pointer.y }),
    pageGeometry: () => (hole === 'geometry' ? null : { x: 0, y: 0, width: 600, height: 800, rotation }),
    pageRect: () =>
      hole === 'rect' ? null : { x: 100, y: 50, width: quarter ? 400 : 300, height: quarter ? 300 : 400 },
    containerRect: () => ({ x: 0, y: 0, width: 1000, height: 1000 }),
  } as unknown as ViewerApi;
}

/** The page point `pointToPage` answers — the layer maps the pointer through it. */
const pointer = { x: 300, y: 400 };

let page: HTMLElement;
let under: Element | null;

beforeEach(() => {
  pointer.x = 300;
  pointer.y = 400;
  page = document.createElement('div');
  page.className = 'page';
  document.body.append(page);
  under = page;
  document.elementFromPoint = () => under;
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function show(overrides: Partial<StampPlacementLayerProps> = {}) {
  const onPlace = vi.fn();
  const onCancel = vi.fn();
  const props: StampPlacementLayerProps = {
    viewer: viewerFor(0),
    source: signature,
    hint: 'Click the page to place your signature',
    onPlace,
    onCancel,
    ...overrides,
  };
  const view = render(<StampPlacementLayer {...props} />);
  return { onPlace, onCancel, view, props };
}

const ghost = () => document.querySelector<HTMLImageElement>('[data-stamp-ghost]');

describe('StampPlacementLayer', () => {
  it('says what the pointer does now and shows no copy before the pointer is over a page', () => {
    show();
    expect(screen.getByRole('status').textContent).toBe('Click the page to place your signature');
    expect(ghost()).toBeNull();
  });

  it('follows the pointer with a copy at the size the stamp will have, centred on the pointer', async () => {
    show();
    await userEvent.setup().pointer({ target: page, coords: { clientX: 250, clientY: 250 } });
    const copy = ghost();
    expect(copy?.getAttribute('src')).toBe(signature.dataUrl);
    // 160 × 40 pt at 50 % is 80 × 20 px, centred on the page point's screen position (250, 250).
    expect(copy?.style.cssText).toBe('left: 210px; top: 240px; width: 80px; height: 20px;');
  });

  it('keeps the copy inside the page when the pointer is at its edge', async () => {
    pointer.x = 10;
    pointer.y = 10;
    show();
    await userEvent.setup().pointer({ target: page, coords: { clientX: 105, clientY: 55 } });
    // The centre is held 80 pt / 20 pt from the left and top edges: screen (140, 60).
    expect(ghost()?.style.cssText).toBe('left: 100px; top: 50px; width: 80px; height: 20px;');
  });

  it('removes the copy when the pointer leaves the pages, or the viewer cannot place it', async () => {
    const user = userEvent.setup();
    const { view, props } = show();
    await user.pointer({ target: page, coords: { clientX: 250, clientY: 250 } });
    expect(ghost()).not.toBeNull();
    under = document.body;
    await user.pointer({ target: document.body, coords: { clientX: 5, clientY: 5 } });
    expect(ghost()).toBeNull();

    under = page;
    for (const hole of ['point', 'geometry', 'rect'] as const) {
      await user.pointer({ target: page, coords: { clientX: 250, clientY: 250 } });
      expect(ghost()).not.toBeNull();
      view.rerender(<StampPlacementLayer {...props} viewer={viewerFor(0, hole)} />);
      await user.pointer({ target: page, coords: { clientX: 251, clientY: 251 } });
      expect(ghost(), hole).toBeNull();
      view.rerender(<StampPlacementLayer {...props} viewer={viewerFor(0)} />);
    }
  });

  it('places the stamp where a left click lands, with the centre and size the copy showed', async () => {
    const { onPlace } = show();
    const user = userEvent.setup();
    await user.pointer({ keys: '[MouseLeft]', target: page, coords: { clientX: 250, clientY: 250 } });
    expect(onPlace).toHaveBeenCalledExactlyOnceWith({
      pageIndex: 0,
      center: { x: 300, y: 400 },
      width: 160,
      height: 40,
    });
  });

  it('swaps the stamp’s extents on a page turned a quarter when keeping its centre on the page', async () => {
    pointer.x = 10;
    pointer.y = 10;
    const { onPlace } = show({ viewer: viewerFor(90) });
    await userEvent
      .setup()
      .pointer({ keys: '[MouseLeft]', target: page, coords: { clientX: 105, clientY: 55 } });
    // Upright 160 × 40; the turned page holds it 20 pt across and 80 pt down from the origin.
    expect(onPlace).toHaveBeenCalledExactlyOnceWith({
      pageIndex: 0,
      center: { x: 20, y: 80 },
      width: 160,
      height: 40,
    });
  });

  it('holds the centre off the far edges too', async () => {
    pointer.x = 599;
    pointer.y = 799;
    const { onPlace } = show();
    await userEvent
      .setup()
      .pointer({ keys: '[MouseLeft]', target: page, coords: { clientX: 390, clientY: 440 } });
    expect(onPlace).toHaveBeenCalledExactlyOnceWith({
      pageIndex: 0,
      center: { x: 520, y: 780 },
      width: 160,
      height: 40,
    });
  });

  it('lets go of a text field that held the keyboard when it places', async () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    show();
    await userEvent
      .setup()
      .pointer({ keys: '[MouseLeft]', target: page, coords: { clientX: 250, clientY: 250 } });
    expect(document.activeElement).not.toBe(field);
  });

  it('takes the click away from the page it placed on', () => {
    show();
    const down = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 250,
      clientY: 250,
    });
    const reached = vi.fn();
    page.addEventListener('pointerdown', reached);
    act(() => {
      page.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
  });

  it('does not place with another button, off the pages, or where the viewer cannot place it', async () => {
    const user = userEvent.setup();
    const { onPlace, view, props } = show();
    await user.pointer({ keys: '[MouseRight]', target: page, coords: { clientX: 250, clientY: 250 } });
    under = document.body;
    await user.pointer({ keys: '[MouseLeft]', target: document.body, coords: { clientX: 5, clientY: 5 } });
    under = page;
    view.rerender(<StampPlacementLayer {...props} viewer={viewerFor(0, 'point')} />);
    await user.pointer({ keys: '[MouseLeft]', target: page, coords: { clientX: 250, clientY: 250 } });
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('cancels on Escape and on no other key', async () => {
    const { onCancel } = show();
    const user = userEvent.setup();
    await user.keyboard('a{Enter}');
    expect(onCancel).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('uses the picture and the callbacks of the latest render, not the first', async () => {
    const { view, props } = show();
    const onPlace = vi.fn();
    const initials: StampPlacementSource = {
      ...signature,
      role: 'initials',
      pixelWidth: 200,
      pixelHeight: 100,
    };
    view.rerender(<StampPlacementLayer {...props} source={initials} onPlace={onPlace} />);
    await userEvent
      .setup()
      .pointer({ keys: '[MouseLeft]', target: page, coords: { clientX: 250, clientY: 250 } });
    expect(onPlace).toHaveBeenCalledExactlyOnceWith({
      pageIndex: 0,
      center: { x: 300, y: 400 },
      width: 60,
      height: 30,
    });
  });

  it('stops listening once it is removed', async () => {
    const { onPlace, onCancel, view } = show();
    view.unmount();
    const user = userEvent.setup();
    await user.pointer({ keys: '[MouseLeft]', target: page, coords: { clientX: 250, clientY: 250 } });
    await user.keyboard('{Escape}');
    expect(onPlace).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
