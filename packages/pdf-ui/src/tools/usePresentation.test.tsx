// @vitest-environment happy-dom
/**
 * Presentation mode: the document alone, page by page. The viewer is the pdf.js markup the tools
 * read (`viewer-dom.ts`) with a fake `ViewerApi` in front of it; layout is faked as pages 500 px
 * tall stacked in an 800 × 600 container, so the page "on screen" is the one whose top has passed
 * the container's middle (y = 300). Full screen is the browser's state, faked on the container
 * and the document.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { type Presentation, type PresentationOptions, usePresentation } from './usePresentation';

const PAGE_HEIGHT = 500;

interface Rig {
  readonly viewer: ViewerApi;
  readonly container: HTMLElement;
  readonly setZoom: Mock;
  readonly setSpreadMode: Mock;
  readonly goToPage: Mock;
  readonly state: { zoom: number; scrollTop: number; pageWidth: number };
  readonly fullscreen: { element: Element | null };
}

/** `.overflow-auto > .pdfViewer[data-active-viewer] > .page[data-page-number] > canvas`, laid out by `state`. */
function mountRig(pageCount = 3, state = { zoom: 1.5, scrollTop: 0, pageWidth: 500 }): Rig {
  document.body.innerHTML = '';
  const container = document.createElement('div');
  container.className = 'overflow-auto';
  container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
  Object.defineProperty(container, 'clientWidth', { configurable: true, value: 800 });
  const root = document.createElement('div');
  root.className = 'pdfViewer';
  root.setAttribute('data-active-viewer', '');
  for (let index = 0; index < pageCount; index += 1) {
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.pageNumber = String(index + 1);
    page.getBoundingClientRect = () =>
      new DOMRect(0, index * PAGE_HEIGHT - state.scrollTop, 500, PAGE_HEIGHT);
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, state.pageWidth, PAGE_HEIGHT);
    page.append(canvas);
    root.append(page);
  }
  container.append(root);
  document.body.append(container);

  const fullscreen: { element: Element | null } = { element: null };
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen.element });
  const setZoom = vi.fn((value: number | string) => {
    state.zoom = typeof value === 'number' ? value : 1.2;
  });
  const setSpreadMode = vi.fn();
  const goToPage = vi.fn((index: number) => {
    state.scrollTop = index * PAGE_HEIGHT;
  });
  const viewer = { getZoom: () => state.zoom, setZoom, setSpreadMode, goToPage } as unknown as ViewerApi;
  return { viewer, container, setZoom, setSpreadMode, goToPage, state, fullscreen };
}

/** The browser grants full screen on `rig.container` and leaves it again on `exitFullscreen`. */
function grantFullscreen(rig: Rig) {
  const request = vi.fn(async () => {
    rig.fullscreen.element = rig.container;
  });
  rig.container.requestFullscreen = request;
  const exitFullscreen = vi.fn(async () => {
    rig.fullscreen.element = null;
  });
  document.exitFullscreen = exitFullscreen;
  return { request, exitFullscreen };
}

/** Records the observers pdf.js-sized containers would have, so a test can resize them. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.observed.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
  static resize() {
    for (const instance of FakeResizeObserver.instances) if (!instance.disconnected) instance.callback();
  }
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // @ts-expect-error — the fakes are installed per test; happy-dom has none to restore.
  document.exitFullscreen = undefined;
  document.body.innerHTML = '';
});

/** What the parent that owns the viewer, the way the shell does, gets back. */
interface PresentationHost extends Presentation {
  setViewer(viewer: ViewerApi | null): void;
}

/** The hook under a parent that owns the viewer, the way the shell does. */
function mountHook(rig: Rig | null, options?: PresentationOptions) {
  return renderHook(
    ({ opts }: { opts?: PresentationOptions }) => {
      const [viewer, setViewer] = useState<ViewerApi | null>(rig?.viewer ?? null);
      return { ...usePresentation(viewer, opts), setViewer };
    },
    { initialProps: { opts: options } },
  );
}

const flushPromises = () => act(async () => {});

describe('entering presentation', () => {
  it('lays the document out one page at a time, fitted to the width, on the page the reader is on', () => {
    const rig = mountRig();
    rig.state.scrollTop = 600;
    grantFullscreen(rig);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    expect(result.current.active).toBe(true);
    expect(result.current.page).toBe(1);
    expect(rig.setSpreadMode).toHaveBeenCalledExactlyOnceWith('single');
    expect(rig.setZoom).toHaveBeenCalledExactlyOnceWith('page-width');
    expect(rig.container.classList.contains('pdfPresentationMode')).toBe(true);
  });

  it('asks the browser for full screen on the scroll container and reports the start', () => {
    const rig = mountRig();
    const { request } = grantFullscreen(rig);
    const onEnter = vi.fn(() => {
      // The layout is on before full screen is requested.
      expect(request).not.toHaveBeenCalled();
      expect(rig.container.classList.contains('pdfPresentationMode')).toBe(true);
    });
    const { result } = mountHook(rig, { onEnter });
    act(() => result.current.enter());
    expect(onEnter).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(rig.fullscreen.element).toBe(rig.container);
  });

  it('still works in the page when the browser has no full screen', () => {
    const rig = mountRig();
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    expect(result.current.active).toBe(true);
    act(() => result.current.exit());
    expect(result.current.active).toBe(false);
  });

  it('keeps the layout in the page when the browser refuses full screen, and does not release what it never took', async () => {
    const rig = mountRig();
    const { exitFullscreen } = grantFullscreen(rig);
    rig.container.requestFullscreen = vi.fn(() => Promise.reject(new Error('not allowed')));
    rig.fullscreen.element = document.body;
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    await flushPromises();
    expect(result.current.active).toBe(true);
    act(() => result.current.exit());
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it('does nothing without a viewer', () => {
    const rig = mountRig();
    const { result } = mountHook(null);
    act(() => result.current.enter());
    expect(result.current.active).toBe(false);
    expect(rig.setSpreadMode).not.toHaveBeenCalled();
  });

  it('does nothing when the viewer has no markup on screen', () => {
    const rig = mountRig();
    document.body.innerHTML = '';
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    expect(result.current.active).toBe(false);
    expect(rig.setSpreadMode).not.toHaveBeenCalled();
  });

  it('does nothing when it is already presenting', () => {
    const rig = mountRig();
    const onEnter = vi.fn();
    const { result } = mountHook(rig, { onEnter });
    act(() => result.current.enter());
    act(() => result.current.enter());
    expect(rig.setSpreadMode).toHaveBeenCalledOnce();
    expect(onEnter).toHaveBeenCalledOnce();
  });

  it('toggles between entering and leaving', () => {
    const rig = mountRig();
    const { result } = mountHook(rig);
    act(() => result.current.toggle());
    expect(result.current.active).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.active).toBe(false);
  });
});

describe('leaving presentation', () => {
  it('gives the pane the scale the reader had, and releases the full screen it took', () => {
    const rig = mountRig();
    const { exitFullscreen } = grantFullscreen(rig);
    const onExit = vi.fn();
    const { result } = mountHook(rig, { onExit });
    act(() => result.current.enter());
    rig.setZoom.mockClear();
    act(() => result.current.exit());
    expect(rig.setZoom).toHaveBeenCalledExactlyOnceWith(1.5);
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(rig.container.classList.contains('pdfPresentationMode')).toBe(false);
    expect(onExit).toHaveBeenCalledOnce();
    expect(result.current.active).toBe(false);
  });

  it('asks for the width fit again when the pane was showing one', () => {
    const rig = mountRig(3, { zoom: 1.5, scrollTop: 0, pageWidth: 799 });
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    rig.setZoom.mockClear();
    act(() => result.current.exit());
    expect(rig.setZoom).toHaveBeenCalledExactlyOnceWith('page-width');
  });

  it.each([
    ['a page not yet rendered', 0],
    ['a page narrower than the container', 600],
  ])('does not take %s for a width fit', (_name, pageWidth) => {
    const rig = mountRig(3, { zoom: 1.5, scrollTop: 0, pageWidth });
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    rig.setZoom.mockClear();
    act(() => result.current.exit());
    expect(rig.setZoom).toHaveBeenCalledExactlyOnceWith(1.5);
  });

  it('does not take a viewer without pages for a width fit', () => {
    const rig = mountRig(0);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    rig.setZoom.mockClear();
    act(() => result.current.exit());
    expect(rig.setZoom).toHaveBeenCalledExactlyOnceWith(1.5);
  });

  it('does not take a page without a bitmap for a width fit', () => {
    const rig = mountRig();
    rig.container.querySelector('canvas')?.remove();
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    rig.setZoom.mockClear();
    act(() => result.current.exit());
    expect(rig.setZoom).toHaveBeenCalledExactlyOnceWith(1.5);
  });

  it('is a no-op while not presenting', () => {
    const rig = mountRig();
    const onExit = vi.fn();
    const { result } = mountHook(rig, { onExit });
    act(() => result.current.exit());
    expect(onExit).not.toHaveBeenCalled();
    expect(rig.setZoom).not.toHaveBeenCalled();
  });

  it('ends when the browser leaves full screen by any route, without asking it to leave again', () => {
    const rig = mountRig();
    const { exitFullscreen } = grantFullscreen(rig);
    const onExit = vi.fn();
    const { result } = mountHook(rig, { onExit });
    act(() => result.current.enter());
    // A change that leaves our element in full screen is not the end.
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(result.current.active).toBe(true);
    rig.fullscreen.element = null;
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(result.current.active).toBe(false);
    expect(exitFullscreen).not.toHaveBeenCalled();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('ends anyway when the browser refuses to leave full screen', async () => {
    const rig = mountRig();
    const { exitFullscreen } = grantFullscreen(rig);
    exitFullscreen.mockRejectedValue(new Error('already gone'));
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    act(() => result.current.exit());
    await flushPromises();
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(result.current.active).toBe(false);
  });

  it('ends when the viewer goes away', () => {
    const rig = mountRig();
    const { exitFullscreen } = grantFullscreen(rig);
    const onExit = vi.fn();
    const { result } = mountHook(rig, { onExit });
    act(() => result.current.enter());
    act(() => result.current.setViewer(null));
    expect(result.current.active).toBe(false);
    expect(onExit).toHaveBeenCalledOnce();
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });

  it('releases the full screen it took when the host unmounts, without reporting an exit', () => {
    const rig = mountRig();
    const { exitFullscreen } = grantFullscreen(rig);
    const onExit = vi.fn();
    const { result, unmount } = mountHook(rig, { onExit });
    act(() => result.current.enter());
    unmount();
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(rig.container.classList.contains('pdfPresentationMode')).toBe(false);
    expect(onExit).not.toHaveBeenCalled();
  });

  it('leaves the browser alone when the host unmounts while not presenting', () => {
    const rig = mountRig();
    const { exitFullscreen } = grantFullscreen(rig);
    const { unmount } = mountHook(rig);
    unmount();
    expect(exitFullscreen).not.toHaveBeenCalled();
  });
});

describe('page keys', () => {
  const press = (keys: string) => userEvent.setup().keyboard(keys);

  it.each(['{ArrowRight}', ' ', '{PageDown}'])('%j moves to the next page', async (keys) => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    await press(keys);
    expect(rig.goToPage).toHaveBeenCalledExactlyOnceWith(1);
    expect(result.current.page).toBe(1);
  });

  it.each(['{ArrowLeft}', '{PageUp}'])('%s moves to the previous page', async (keys) => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    await press('{End}');
    expect(result.current.page).toBe(2);
    rig.goToPage.mockClear();
    await press(keys);
    expect(rig.goToPage).toHaveBeenCalledExactlyOnceWith(1);
    expect(result.current.page).toBe(1);
  });

  it('jumps to the first and the last page', async () => {
    const rig = mountRig(4);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    await press('{End}');
    expect(rig.goToPage).toHaveBeenLastCalledWith(3);
    expect(result.current.page).toBe(3);
    await press('{Home}');
    expect(rig.goToPage).toHaveBeenLastCalledWith(0);
    expect(result.current.page).toBe(0);
  });

  it('stays on the first and last page instead of running off either end', async () => {
    const rig = mountRig(2);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    await press('{ArrowLeft}');
    expect(rig.goToPage).toHaveBeenLastCalledWith(0);
    await press('{ArrowRight}{ArrowRight}');
    expect(rig.goToPage).toHaveBeenLastCalledWith(1);
    expect(result.current.page).toBe(1);
  });

  it('takes the key for itself: nothing bubbling behind it sees it, and other keys pass through', async () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    const behind = vi.fn();
    document.body.addEventListener('keydown', behind);
    await press('{ArrowRight}');
    expect(behind).not.toHaveBeenCalled();
    await press('a');
    expect(behind).toHaveBeenCalledOnce();
    expect(rig.goToPage).toHaveBeenCalledOnce();
  });

  it('leaves Escape to end the presentation, before anything else sees it', async () => {
    const rig = mountRig(3);
    const onExit = vi.fn();
    const { result } = mountHook(rig, { onExit });
    act(() => result.current.enter());
    const behind = vi.fn();
    document.body.addEventListener('keydown', behind);
    await press('{Escape}');
    expect(result.current.active).toBe(false);
    expect(onExit).toHaveBeenCalledOnce();
    expect(behind).not.toHaveBeenCalled();
  });

  it.each([
    ['a text field', () => document.createElement('input')],
    ['a text area', () => document.createElement('textarea')],
    ['a select', () => document.createElement('select')],
    [
      'editable content',
      () => {
        const div = document.createElement('div');
        div.contentEditable = 'true';
        div.tabIndex = 0;
        return div;
      },
    ],
  ])('keeps the arrow keys for %s', async (_name, make) => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    const field = make();
    document.body.append(field);
    field.focus();
    await press('{ArrowRight}');
    expect(rig.goToPage).not.toHaveBeenCalled();
  });

  it('pages from an element that is not an editing context', async () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    await press('{ArrowRight}');
    expect(rig.goToPage).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('pages for a key that comes from outside any element', () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
    });
    expect(rig.goToPage).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('does nothing for a viewer with no pages', async () => {
    const rig = mountRig(0);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    await press('{End}');
    expect(rig.goToPage).not.toHaveBeenCalled();
  });

  it('does nothing once the viewer markup has left the screen', async () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    rig.container.remove();
    await press('{ArrowRight}');
    expect(rig.goToPage).not.toHaveBeenCalled();
  });

  it('stops listening once presentation ends', async () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    act(() => result.current.exit());
    await press('{ArrowRight}');
    expect(rig.goToPage).not.toHaveBeenCalled();
  });
});

describe('following the page on screen', () => {
  it('follows the container as it scrolls', () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    rig.state.scrollTop = 1000;
    act(() => {
      rig.container.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.page).toBe(2);
  });

  it('keeps the page when the viewer markup is gone at the next scroll', () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    const scroll = new Event('scroll');
    document.body.innerHTML = '';
    act(() => {
      rig.container.dispatchEvent(scroll);
    });
    expect(result.current.page).toBe(0);
  });

  it('stops following the container once presentation ends', () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    act(() => result.current.exit());
    rig.state.scrollTop = 1000;
    act(() => {
      rig.container.dispatchEvent(new Event('scroll'));
    });
    expect(result.current.page).toBe(0);
  });
});

describe('resizing the container', () => {
  it('watches the container, and stops when presentation ends', () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    const [observer] = FakeResizeObserver.instances;
    expect(observer?.observed).toEqual([rig.container]);
    act(() => result.current.exit());
    expect(observer?.disconnected).toBe(true);
  });

  it('re-applies the width fit on the page on screen when entering full screen resized the container', () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    rig.state.scrollTop = 600;
    rig.setZoom.mockClear();
    act(() => FakeResizeObserver.resize());
    expect(rig.setZoom).toHaveBeenCalledExactlyOnceWith('page-width');
    expect(rig.goToPage).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('leaves the scale to a reader who zoomed away from the fit', () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    rig.state.zoom = 2;
    rig.setZoom.mockClear();
    act(() => FakeResizeObserver.resize());
    expect(rig.setZoom).not.toHaveBeenCalled();
    expect(rig.goToPage).not.toHaveBeenCalled();
  });

  it('refits to the first page when the viewer markup is gone', () => {
    const rig = mountRig(3);
    const { result } = mountHook(rig);
    act(() => result.current.enter());
    document.body.innerHTML = '';
    act(() => FakeResizeObserver.resize());
    expect(rig.goToPage).toHaveBeenCalledExactlyOnceWith(0);
  });
});

describe('a viewer that vanishes around the start', () => {
  it('ends a presentation whose viewer went away in the same moment, without a container to watch', () => {
    const rig = mountRig();
    const onExit = vi.fn();
    let parent: { readonly current: PresentationHost } | null = null;
    const { result } = mountHook(rig, {
      onEnter: () => parent?.current.setViewer(null),
      onExit,
    });
    parent = result;
    act(() => result.current.enter());
    expect(result.current.active).toBe(false);
    expect(onExit).toHaveBeenCalledOnce();
    expect(FakeResizeObserver.instances.flatMap((o) => o.observed)).toEqual([]);
  });

  it('keeps listening for keys when the viewer markup was removed at the start', async () => {
    const rig = mountRig();
    const { result } = mountHook(rig, { onEnter: () => document.body.replaceChildren() });
    act(() => result.current.enter());
    expect(result.current.active).toBe(true);
    expect(FakeResizeObserver.instances.flatMap((o) => o.observed)).toEqual([]);
    await userEvent.setup().keyboard('{Escape}');
    expect(result.current.active).toBe(false);
  });

  it('ignores page keys, scrolls and resizes that land while the viewer is being torn down', () => {
    const rig = mountRig(3);
    const onExit = vi.fn(() => {
      // Still subscribed here: the listeners go with the next render, after this callback.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', cancelable: true }));
      rig.container.dispatchEvent(new Event('scroll'));
      FakeResizeObserver.resize();
    });
    const { result } = mountHook(rig, { onExit });
    act(() => result.current.enter());
    rig.goToPage.mockClear();
    rig.setZoom.mockClear();
    act(() => result.current.setViewer(null));
    expect(onExit).toHaveBeenCalledOnce();
    expect(rig.goToPage).not.toHaveBeenCalled();
    expect(rig.setZoom).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
  });
});
