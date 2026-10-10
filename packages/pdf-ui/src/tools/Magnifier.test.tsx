// @vitest-environment happy-dom
/**
 * The magnifier: a lens that follows the pointer over a rendered page, drawing the region under
 * it from a small window of the page bitmap, and a zoom control that also answers the wheel.
 * Layout, canvas drawing and animation frames are faked (happy-dom has none of them): one page
 * whose 600 × 800 bitmap sits at (100, 50) as 300 × 400 CSS pixels (2 bitmap pixels per CSS
 * pixel), a recording 2D context per canvas, and frames the test runs by hand.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { Magnifier, type MagnifierProps } from './Magnifier';

const t = createTranslator('en');
const viewer = {} as ViewerApi;

/** Where the page bitmap sits on screen. */
const PAGE_RECT = new DOMRect(100, 50, 300, 400);

interface FakeContext {
  imageSmoothingEnabled: boolean;
  readonly clearRect: Mock;
  readonly save: Mock;
  readonly beginPath: Mock;
  readonly arc: Mock;
  readonly clip: Mock;
  readonly drawImage: Mock;
  readonly restore: Mock;
}

const contexts = new Map<HTMLCanvasElement, FakeContext>();
/** Canvases whose `getContext` the browser refuses. */
const refused = new Set<HTMLCanvasElement>();

function contextOf(canvas: HTMLCanvasElement): FakeContext {
  let context = contexts.get(canvas);
  if (context === undefined) {
    context = {
      imageSmoothingEnabled: true,
      clearRect: vi.fn(),
      save: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      clip: vi.fn(),
      drawImage: vi.fn(),
      restore: vi.fn(),
    };
    contexts.set(canvas, context);
  }
  return context;
}

/** Animation frames run by hand, one pending frame at a time. */
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;

/** Runs every frame that is pending now. */
const runFrames = () =>
  act(() => {
    const pending = [...frames];
    frames.clear();
    for (const [, callback] of pending) callback(0);
  });

interface Page {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
}

let page: Page;
/** What `elementFromPoint` answers inside `PAGE_RECT`. */
let under: Element | null;

function mountPage(size = { width: 600, height: 800 }, rect = PAGE_RECT): Page {
  document.body.innerHTML = '';
  const element = document.createElement('div');
  element.className = 'page';
  element.dataset.pageNumber = '1';
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.getBoundingClientRect = () => rect;
  element.append(canvas);
  document.body.append(element);
  return { element, canvas };
}

/** Pointer positions inside the page rectangle hit the page; anything else hits the body. */
function hitTest(x: number, y: number): Element | null {
  const inside = x >= PAGE_RECT.left && x <= PAGE_RECT.right && y >= PAGE_RECT.top && y <= PAGE_RECT.bottom;
  return inside ? under : document.body;
}

beforeEach(() => {
  contexts.clear();
  refused.clear();
  frames.clear();
  nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return refused.has(this) ? null : (contextOf(this) as unknown as CanvasRenderingContext2D);
  });
  page = mountPage();
  under = page.element;
  document.elementFromPoint = hitTest;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function show(overrides: Partial<MagnifierProps> = {}) {
  const onZoomChange = vi.fn();
  const props: MagnifierProps = { viewer, active: true, t, zoom: 4, onZoomChange, ...overrides };
  const view = render(<Magnifier {...props} />);
  return {
    onZoomChange,
    ...view,
    update: (next: Partial<MagnifierProps>) => view.rerender(<Magnifier {...props} {...next} />),
  };
}

/** The lens is the canvas the component renders; the page bitmap lives outside its container. */
/** The window copies the lens has drawn from, in order of first use. */
const windowsOf = (lens: HTMLCanvasElement) => [
  ...new Set(contextOf(lens).drawImage.mock.calls.map((call) => call[0] as HTMLCanvasElement)),
];

const lensIn = (container: HTMLElement) => container.querySelector('canvas') as HTMLCanvasElement;

const move = (x: number, y: number) =>
  userEvent.setup().pointer({ target: document.body, coords: { clientX: x, clientY: y } });

describe('what renders', () => {
  it.each([
    ['inactive', { active: false }],
    ['without a viewer', { viewer: null }],
  ])('renders nothing when %s', (_name, overrides) => {
    const { container } = show(overrides);
    expect(container.innerHTML).toBe('');
  });

  it('shows the lens, hidden until the pointer is over a page, and the zoom control at the set value', () => {
    const { container } = show({ zoom: 3.5 });
    const lens = lensIn(container);
    expect([lens.style.width, lens.style.height, lens.style.visibility]).toEqual([
      '180px',
      '180px',
      'hidden',
    ]);
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect([slider.min, slider.max, slider.step, slider.value]).toEqual(['2', '8', '0.5', '3.5']);
    expect(screen.getByText('Magnifier')).toBeTruthy();
    expect(screen.getByText('3.5×')).toBeTruthy();
  });

  it('reports the slider as a magnification within 2×–8×', () => {
    const { onZoomChange } = show();
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '6.5' } });
    expect(onZoomChange).toHaveBeenLastCalledWith(6.5);
    fireEvent.change(slider, { target: { value: '8' } });
    expect(onZoomChange).toHaveBeenLastCalledWith(8);
  });
});

describe('the lens over a page', () => {
  it('draws the region under the pointer, scaled into a circular lens centred on it', async () => {
    const { container } = show({ zoom: 4 });
    const lens = lensIn(container);
    await move(250, 250);
    expect(lens.style.visibility).toBe('hidden');
    runFrames();
    // 180 css px at 4× is 45 css px = 90 bitmap px, around bitmap point (300, 400).
    expect(lens.style.visibility).toBe('visible');
    expect(lens.style.transform).toBe('translate(160px, 160px)');
    expect([lens.width, lens.height]).toEqual([180, 180]);
    const context = contextOf(lens);
    expect(context.clearRect).toHaveBeenCalledExactlyOnceWith(0, 0, 180, 180);
    expect(context.arc).toHaveBeenCalledExactlyOnceWith(90, 90, 90, 0, Math.PI * 2);
    expect(context.clip).toHaveBeenCalledOnce();
    expect(context.restore).toHaveBeenCalledOnce();
    // The window copied from the page bitmap is 135 px around the region; the lens blits
    // the region out of it.
    const copy = context.drawImage.mock.calls[0]?.[0] as HTMLCanvasElement;
    expect([copy.width, copy.height]).toEqual([135, 135]);
    expect(contextOf(copy).drawImage).toHaveBeenCalledExactlyOnceWith(
      page.canvas,
      233,
      333,
      135,
      135,
      0,
      0,
      135,
      135,
    );
    expect(context.drawImage.mock.calls[0]?.slice(1)).toEqual([22, 22, 90, 90, 0, 0, 180, 180]);
  });

  it('keeps drawing frames while the pointer stays over the page', async () => {
    const { container } = show();
    await move(250, 250);
    runFrames();
    expect(frames.size).toBe(1);
    runFrames();
    expect(contextOf(lensIn(container)).drawImage).toHaveBeenCalledTimes(2);
  });

  it('smooths a low magnification and keeps pixels crisp when blown up', async () => {
    const { container, update } = show({ zoom: 3 });
    await move(250, 250);
    runFrames();
    expect(contextOf(lensIn(container)).imageSmoothingEnabled).toBe(true);
    update({ zoom: 3.5 });
    runFrames();
    expect(contextOf(lensIn(container)).imageSmoothingEnabled).toBe(false);
  });

  it('follows the pointer without copying the page again while the window still holds the region', async () => {
    const { container } = show();
    const lens = lensIn(container);
    await move(250, 250);
    runFrames();
    await move(255, 252);
    runFrames();
    expect(lens.style.transform).toBe('translate(165px, 162px)');
    const [only, ...others] = windowsOf(lens);
    expect(others).toEqual([]);
    expect(contextOf(only as HTMLCanvasElement).drawImage).toHaveBeenCalledOnce();
    expect(contextOf(lens).drawImage.mock.calls[1]?.slice(1)).toEqual([32, 26, 90, 90, 0, 0, 180, 180]);
  });

  it.each([
    ['left', 150, 250, 33, 333, 22, 22],
    ['above', 250, 100, 233, 33, 22, 22],
    ['right', 390, 250, 465, 333, 70, 22],
    ['below', 250, 440, 233, 665, 22, 70],
  ])(
    'copies a fresh window when the region leaves the old one on the %s',
    async (_side, x, y, windowX, windowY, cropX, cropY) => {
      const { container } = show();
      const lens = lensIn(container);
      await move(250, 250);
      runFrames();
      await move(x, y);
      runFrames();
      const [first, second, ...rest] = windowsOf(lens);
      expect(rest).toEqual([]);
      expect(contextOf(first as HTMLCanvasElement).drawImage).toHaveBeenCalledExactlyOnceWith(
        page.canvas,
        233,
        333,
        135,
        135,
        0,
        0,
        135,
        135,
      );
      expect(contextOf(second as HTMLCanvasElement).drawImage).toHaveBeenCalledExactlyOnceWith(
        page.canvas,
        windowX,
        windowY,
        135,
        135,
        0,
        0,
        135,
        135,
      );
      expect(contextOf(lens).drawImage.mock.calls[1]?.slice(1)).toEqual([
        cropX,
        cropY,
        90,
        90,
        0,
        0,
        180,
        180,
      ]);
    },
  );

  it('copies a fresh window when the page under the pointer is another bitmap', async () => {
    const { container } = show();
    const lens = lensIn(container);
    await move(250, 250);
    runFrames();
    const next = mountPage();
    under = next.element;
    await move(251, 250);
    runFrames();
    const [first, second] = windowsOf(lens);
    expect(contextOf(first as HTMLCanvasElement).drawImage.mock.calls[0]?.[0]).toBe(page.canvas);
    expect(contextOf(second as HTMLCanvasElement).drawImage.mock.calls[0]?.[0]).toBe(next.canvas);
  });

  it('keeps the window inside a small page bitmap', async () => {
    page = mountPage({ width: 40, height: 30 });
    under = page.element;
    const { container } = show({ zoom: 2 });
    await move(120, 60);
    runFrames();
    const copy = contextOf(lensIn(container)).drawImage.mock.calls[0]?.[0] as HTMLCanvasElement;
    expect([copy.width, copy.height]).toEqual([40, 30]);
    expect(contextOf(copy).drawImage).toHaveBeenCalledExactlyOnceWith(
      page.canvas,
      0,
      0,
      40,
      30,
      0,
      0,
      40,
      30,
    );
  });

  it('clamps the window to the page bitmap at its far corner', async () => {
    const { container } = show({ zoom: 8 });
    await move(399, 449);
    runFrames();
    // 180 css px at 8× is 22.5 css px = 45 bitmap px, so the window is the 64 px minimum.
    const copy = contextOf(lensIn(container)).drawImage.mock.calls[0]?.[0] as HTMLCanvasElement;
    expect([copy.width, copy.height]).toEqual([68, 68]);
    expect(contextOf(copy).drawImage).toHaveBeenCalledExactlyOnceWith(
      page.canvas,
      532,
      732,
      68,
      68,
      0,
      0,
      68,
      68,
    );
  });

  it('sizes the lens backing store by the device pixel ratio, with a fallback for a window that reports none', async () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { container } = show();
    await move(250, 250);
    runFrames();
    const lens = lensIn(container);
    expect([lens.width, lens.height]).toEqual([360, 360]);
    expect(contextOf(lens).arc).toHaveBeenCalledExactlyOnceWith(180, 180, 180, 0, Math.PI * 2);
    vi.stubGlobal('devicePixelRatio', 0);
    await move(251, 250);
    runFrames();
    expect([lens.width, lens.height]).toEqual([180, 180]);
  });

  it('hides the lens and stops its frames when the pointer leaves the pages', async () => {
    const { container } = show();
    const lens = lensIn(container);
    await move(250, 250);
    runFrames();
    expect(frames.size).toBe(1);
    await move(700, 700);
    expect(lens.style.visibility).toBe('hidden');
    expect(frames.size).toBe(0);
  });

  it('has nothing to hide when the pointer was never on a page', async () => {
    const { container } = show();
    await move(700, 700);
    expect(lensIn(container).style.visibility).toBe('hidden');
    expect(frames.size).toBe(0);
  });

  it('hides the lens over a page whose bitmap has not been painted yet', async () => {
    page.canvas.width = 0;
    const { container } = show();
    await move(250, 250);
    expect(lensIn(container).style.visibility).toBe('hidden');
    expect(frames.size).toBe(0);
    page.canvas.width = 600;
    page.canvas.height = 0;
    await move(251, 250);
    expect(frames.size).toBe(0);
  });

  it('hides the lens when the pointer leaves the document, and ignores moves between elements', async () => {
    const { container } = show();
    const lens = lensIn(container);
    await move(250, 250);
    runFrames();
    act(() => {
      document.body.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true, relatedTarget: page.element }),
      );
    });
    expect(lens.style.visibility).toBe('visible');
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
    });
    expect(lens.style.visibility).toBe('hidden');
    expect(frames.size).toBe(0);
  });

  it('arms the lens again after leaving the document, once the pointer is back on a page', async () => {
    const { container } = show();
    await move(250, 250);
    runFrames();
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
    });
    await move(260, 260);
    runFrames();
    expect(lensIn(container).style.visibility).toBe('visible');
  });

  it('shows nothing for a frame whose page left the screen after the pointer moved', async () => {
    const { container } = show();
    await move(250, 250);
    under = null;
    runFrames();
    expect(lensIn(container).style.visibility).toBe('hidden');
    expect(frames.size).toBe(0);
  });

  it('shows nothing when the browser gives the lens no 2D context', async () => {
    const { container } = show();
    refused.add(lensIn(container));
    await move(250, 250);
    runFrames();
    expect(lensIn(container).style.visibility).toBe('hidden');
    expect(frames.size).toBe(0);
  });

  it('shows nothing when the browser cannot give a window to copy into', async () => {
    const { container } = show();
    const lens = lensIn(container);
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const element = original(tag);
      if (tag === 'canvas') refused.add(element as HTMLCanvasElement);
      return element;
    });
    await move(250, 250);
    runFrames();
    expect(lens.style.visibility).toBe('hidden');
    expect(frames.size).toBe(0);
  });
});

describe('Escape', () => {
  it('hides the lens and keeps it hidden while the pointer stays on the pages', async () => {
    const { container } = show();
    const lens = lensIn(container);
    const user = userEvent.setup();
    await user.pointer({ target: document.body, coords: { clientX: 250, clientY: 250 } });
    runFrames();
    await user.keyboard('{Escape}');
    expect(lens.style.visibility).toBe('hidden');
    expect(frames.size).toBe(0);
    await user.pointer({ target: document.body, coords: { clientX: 255, clientY: 255 } });
    expect(frames.size).toBe(0);
    expect(lens.style.visibility).toBe('hidden');
  });

  it('lets the lens back once the pointer has left the pages and returned', async () => {
    const { container } = show();
    const user = userEvent.setup();
    await user.pointer({ target: document.body, coords: { clientX: 250, clientY: 250 } });
    await user.keyboard('{Escape}');
    await user.pointer({ target: document.body, coords: { clientX: 700, clientY: 700 } });
    await user.pointer({ target: document.body, coords: { clientX: 260, clientY: 260 } });
    runFrames();
    expect(lensIn(container).style.visibility).toBe('visible');
  });

  it('is the only key it answers to', async () => {
    const { container } = show();
    const user = userEvent.setup();
    await user.pointer({ target: document.body, coords: { clientX: 250, clientY: 250 } });
    runFrames();
    await user.keyboard('a');
    expect(lensIn(container).style.visibility).toBe('visible');
  });

  it('cancels the frame that was waiting when it is pressed', async () => {
    const { container } = show();
    await move(250, 250);
    expect(frames.size).toBe(1);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(frames.size).toBe(0);
    expect(lensIn(container).style.visibility).toBe('hidden');
  });
});

describe('the wheel', () => {
  const wheel = (deltaY: number) => {
    const event = new WheelEvent('wheel', { deltaY, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  };

  it('leaves the wheel to the reader while the pointer is off the pages', () => {
    const { onZoomChange } = show();
    const event = wheel(-100);
    expect(event.defaultPrevented).toBe(false);
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it('takes the wheel over a page: up magnifies by half a step, down reduces', async () => {
    const { onZoomChange } = show({ zoom: 4 });
    await move(250, 250);
    expect(wheel(-100).defaultPrevented).toBe(true);
    expect(onZoomChange).toHaveBeenLastCalledWith(4.5);
    expect(wheel(100).defaultPrevented).toBe(true);
    expect(onZoomChange).toHaveBeenLastCalledWith(4);
  });

  it('accumulates wheel events that arrive before the shell re-renders', async () => {
    const { onZoomChange } = show({ zoom: 4 });
    await move(250, 250);
    wheel(-1);
    wheel(-1);
    wheel(-1);
    expect(onZoomChange.mock.calls).toEqual([[4.5], [5], [5.5]]);
  });

  it('stays within 2× and 8×, still keeping the wheel from scrolling the page', async () => {
    const top = show({ zoom: 8 });
    await move(250, 250);
    expect(wheel(-100).defaultPrevented).toBe(true);
    expect(top.onZoomChange).not.toHaveBeenCalled();
    top.unmount();
    const bottom = show({ zoom: 2 });
    await move(251, 250);
    expect(wheel(100).defaultPrevented).toBe(true);
    expect(bottom.onZoomChange).not.toHaveBeenCalled();
  });

  it('takes the shell’s new zoom into the next frame', async () => {
    const { container, update } = show({ zoom: 4 });
    await move(250, 250);
    update({ zoom: 2 });
    runFrames();
    // 180 css px at 2× is 90 css px = 180 bitmap px.
    expect(contextOf(lensIn(container)).drawImage.mock.calls[0]?.slice(3, 5)).toEqual([180, 180]);
  });
});

describe('going inactive', () => {
  it('stops listening, cancels its frame and drops the window when deactivated', async () => {
    const { update, onZoomChange } = show();
    await move(250, 250);
    expect(frames.size).toBe(1);
    update({ active: false });
    expect(frames.size).toBe(0);
    await move(255, 255);
    expect(frames.size).toBe(0);
    expect(wheelEvent().defaultPrevented).toBe(false);
    expect(onZoomChange).not.toHaveBeenCalled();
  });

  it('starts from nothing when it is turned on again', async () => {
    const { container, update } = show();
    await move(250, 250);
    runFrames();
    update({ active: false });
    update({ active: true });
    runFrames();
    expect(lensIn(container).style.visibility).toBe('hidden');
    await move(255, 255);
    runFrames();
    expect(lensIn(container).style.visibility).toBe('visible');
  });

  it('stops listening when unmounted', async () => {
    const { unmount } = show();
    unmount();
    await move(250, 250);
    expect(frames.size).toBe(0);
  });
});

function wheelEvent() {
  const event = new WheelEvent('wheel', { deltaY: -100, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}
