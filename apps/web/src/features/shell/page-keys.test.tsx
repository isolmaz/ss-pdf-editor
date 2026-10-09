// @vitest-environment happy-dom
/**
 * One page key, one page: the real key table, the real shell bindings and the real presentation
 * hook, all listening on the same `window`. Each is a capture-phase listener there, and
 * `stopPropagation` does not keep a listener on the same target from running — the first to
 * register runs first — so with both answering, which of them turns the page depends on the
 * order they register in and a key turns two pages; only the presentation answers while it is
 * open.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { SessionStore } from 'pdf-model';
import { usePresentation } from 'pdf-ui/tools';
import type { ViewerApi } from 'pdf-ui/viewer';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import type { ShellActions } from './shell-actions';
import { useShellBindings } from './use-shell-bindings';

const PAGES = 4;
const PAGE_HEIGHT = 100;

/** A viewer with one page to a screen: `shown` is the page at the top of the scroll container. */
function laidOutViewer() {
  let shown = 0;
  const container = document.createElement('div');
  const strip = document.createElement('div');
  strip.className = 'pdfViewer';
  strip.setAttribute('data-active-viewer', '');
  container.append(strip);
  const box = (top: number) => ({ top, bottom: top + PAGE_HEIGHT, height: PAGE_HEIGHT }) as DOMRect;
  container.getBoundingClientRect = () => box(0);
  for (let index = 0; index < PAGES; index += 1) {
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset.pageNumber = String(index + 1);
    page.getBoundingClientRect = () => box((index - shown) * PAGE_HEIGHT);
    strip.append(page);
  }
  document.body.append(container);
  const goToPage = vi.fn((index: number) => {
    shown = Math.min(Math.max(index, 0), PAGES - 1);
    // pdf.js reports the page it landed on as it lands, which is what the shell's store follows.
    saveStore.set({ currentPage: shown });
  });
  const viewer = {
    getZoom: () => 1,
    setZoom: vi.fn(),
    setSpreadMode: vi.fn(),
    goToPage,
  } as unknown as ViewerApi;
  return { viewer, goToPage };
}

function shellActions(): ShellActions {
  return {
    openViaPicker: vi.fn(async () => undefined),
    saveActive: vi.fn(async () => true),
    deleteMarkSelection: vi.fn(() => true),
    openPrint: vi.fn(),
    stepHistoryNow: vi.fn(() => true),
    openDialog: vi.fn(),
    selectAllMarks: vi.fn(() => true),
  } as unknown as ShellActions;
}

/** A page key reaching the shell the way the browser delivers it: from an element, down through `window`. */
function press(key: string): void {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

let session: SessionStore;
let viewer: ViewerApi;
let goToPage: Mock<(index: number) => void>;

/** The shell's bindings and a presentation of the viewer, hooked up in the order the shell hooks them. */
function mountShell() {
  return renderHook(
    (props: { actions: ShellActions }) => {
      useShellBindings({ session, actions: props.actions });
      return usePresentation(viewer);
    },
    { initialProps: { actions: shellActions() } },
  );
}

beforeEach(() => {
  saveStore.set(initialSaveState());
  session = new SessionStore();
  session.openDocument({ name: 'slides.pdf', bytes: new Uint8Array([1]), sha256: 's', pageCount: PAGES });
  ({ viewer, goToPage } = laidOutViewer());
  viewerChanged(viewer);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('one page key, one page', () => {
  it('is the shell that turns the page when nothing is presented', () => {
    mountShell();
    press('PageDown');
    press('End');
    press('PageUp');
    press('Home');
    expect(goToPage.mock.calls).toEqual([[1], [3], [2], [0]]);
  });

  it('is the presentation alone that turns the page while one is on', () => {
    const { result } = mountShell();
    act(() => result.current.enter());
    for (const key of ['PageDown', 'PageDown', 'PageUp', 'End', 'Home']) press(key);
    expect(goToPage.mock.calls).toEqual([[1], [2], [1], [3], [0]]);
  });

  it('is still the presentation alone when the shell registered its keys after it did', () => {
    const { result, rerender } = mountShell();
    act(() => result.current.enter());
    // New actions re-bind the shell's listener behind the presentation's.
    rerender({ actions: shellActions() });
    press('PageDown');
    press('PageDown');
    press('PageUp');
    expect(goToPage.mock.calls).toEqual([[1], [2], [1]]);
  });

  it('is the shell again once the presentation has ended', () => {
    const { result } = mountShell();
    act(() => result.current.enter());
    press('PageDown');
    act(() => result.current.exit());
    press('PageDown');
    expect(goToPage.mock.calls).toEqual([[1], [2]]);
  });
});
