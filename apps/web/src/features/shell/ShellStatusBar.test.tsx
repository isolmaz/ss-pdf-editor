// @vitest-environment happy-dom
/**
 * The status bar reads the document, the viewer's zoom and page and the memory sample, and hands
 * the page controls their handlers. The bar and the page controls are pdf-ui's own; here they are
 * stand-ins that expose the props the shell wires.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import type { ViewerApi } from 'pdf-ui/viewer';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle } from '../core/handles';
import {
  diagnosticsStore,
  initialDiagnosticsState,
  MEMORY_SAMPLE_INTERVAL_MS,
} from '../diagnostics/memory-store';
import { factsRead, factsStore } from '../facts/facts-store';
import { formsStore, initialFormsState } from '../forms/forms-store';
import { hideStartScreen, initialOpenState, openStore } from '../open/open-store';
import { initialSaveState, saveStore, viewerChanged } from '../save/save-store';
import { ShellStatusBar } from './ShellStatusBar';

const presentation = vi.hoisted(() => ({ toggle: vi.fn(), viewers: [] as unknown[] }));
vi.mock('pdf-ui/tools', async (original) => ({
  ...(await original<typeof import('pdf-ui/tools')>()),
  usePresentation: (viewer: unknown) => {
    presentation.viewers.push(viewer);
    return { toggle: presentation.toggle };
  },
}));
vi.mock('pdf-ui/ui', async (original) => {
  const { createElement } = await import('react');
  return {
    ...(await original<typeof import('pdf-ui/ui')>()),
    StatusBar: (props: {
      pageIndex: number | null;
      pageCount: number | null;
      zoom: number;
      tier: string;
      signatures: readonly unknown[];
      memoryUsage: { usedBytes: number } | undefined;
      sensitive: boolean;
      navigation: ReactNode;
    }) =>
      createElement(
        'footer',
        {
          'aria-label': 'status bar',
          'data-page-index': String(props.pageIndex),
          'data-page-count': String(props.pageCount),
          'data-zoom': String(props.zoom),
          'data-tier': props.tier,
          'data-signatures': String(props.signatures.length),
          'data-memory': String(props.memoryUsage?.usedBytes),
          'data-sensitive': String(props.sensitive),
        },
        props.navigation,
      ),
  };
});
vi.mock('../../components/PageNavigation', async () => {
  const { createElement } = await import('react');
  return {
    PageNavigation: (props: {
      currentPage: number;
      pageCount: number;
      zoom: number;
      onGoToPage: (pageIndex: number) => void;
      onZoomChange: (zoom: number | 'page-width') => void;
      onRotate?: () => void;
      onToggleFullscreen: () => void;
    }) =>
      createElement(
        'nav',
        {
          'aria-label': 'page navigation',
          'data-page': String(props.currentPage),
          'data-count': String(props.pageCount),
        },
        createElement('button', { type: 'button', onClick: () => props.onGoToPage(2) }, 'go to page 3'),
        createElement('button', { type: 'button', onClick: () => props.onZoomChange(2) }, 'zoom 2'),
        props.onRotate === undefined
          ? null
          : createElement('button', { type: 'button', onClick: props.onRotate }, 'rotate'),
        createElement('button', { type: 'button', onClick: props.onToggleFullscreen }, 'fullscreen'),
      ),
  };
});

const t = createTranslator('en');
const handle = { id: 'h' } as unknown as PdfDocumentHandle;
let session: SessionStore;
let viewer: { document: PdfDocumentHandle; goToPage: Mock; setZoom: Mock };
let runPageAction: Mock;

function openTab() {
  const tab = session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 5 });
  adoptHandle(tab.id, handle);
  hideStartScreen();
  return tab;
}

function mount() {
  return render(<ShellStatusBar session={session} tier="mobile" t={t} actions={{ runPageAction }} />);
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  presentation.viewers.length = 0;
  coreStore.set(initialCoreState());
  saveStore.set(initialSaveState());
  openStore.set(initialOpenState());
  formsStore.set(initialFormsState());
  factsStore.set({ facts: null, failure: null });
  diagnosticsStore.set(initialDiagnosticsState());
  session = new SessionStore();
  viewer = { document: handle, goToPage: vi.fn(), setZoom: vi.fn() };
  runPageAction = vi.fn();
});

describe('ShellStatusBar', () => {
  it('reports no page and no page controls with no document', () => {
    mount();
    const bar = screen.getByLabelText('status bar');
    expect(bar.getAttribute('data-page-index')).toBe('null');
    expect(bar.getAttribute('data-page-count')).toBe('null');
    expect(bar.getAttribute('data-tier')).toBe('mobile');
    expect(bar.getAttribute('data-signatures')).toBe('0');
    expect(bar.getAttribute('data-sensitive')).toBe('false');
    expect(screen.queryByLabelText('page navigation')).toBeNull();
  });

  it('samples the memory the open documents hold, again on every interval, and stops with the bar', () => {
    vi.useFakeTimers();
    try {
      openTab();
      const { unmount } = mount();
      const first = Number(screen.getByLabelText('status bar').getAttribute('data-memory'));
      expect(first).toBeGreaterThanOrEqual(24 * 1024 * 1024);
      session.openDocument({ name: 'b.pdf', bytes: new Uint8Array(1024), sha256: 'b', pageCount: 1 });
      act(() => {
        vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS);
      });
      const second = Number(screen.getByLabelText('status bar').getAttribute('data-memory'));
      expect(second).toBeGreaterThan(first);
      unmount();
      const sampled = diagnosticsStore.get().memoryUsage;
      session.openDocument({ name: 'c.pdf', bytes: new Uint8Array(4096), sha256: 'c', pageCount: 1 });
      vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS * 2);
      expect(diagnosticsStore.get().memoryUsage).toBe(sampled);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the document's page, zoom, signatures and sensitive flag", () => {
    const tab = openTab();
    session.setSensitive(tab.id, true);
    factsRead({
      tabId: tab.id,
      version: tab.working.id,
      fonts: [],
      attachments: [],
      signatures: [{ name: 'Sig1' }, { name: 'Sig2' }],
      security: { encrypted: false, permissions: [] },
    } as never);
    saveStore.set({ zoom: 1.5, currentPage: 3 });
    mount();
    const bar = screen.getByLabelText('status bar');
    expect(bar.getAttribute('data-page-index')).toBe('3');
    expect(bar.getAttribute('data-page-count')).toBe('5');
    expect(bar.getAttribute('data-zoom')).toBe('1.5');
    expect(bar.getAttribute('data-signatures')).toBe('2');
    expect(bar.getAttribute('data-sensitive')).toBe('true');
    const navigation = screen.getByLabelText('page navigation');
    expect(navigation.getAttribute('data-page')).toBe('3');
    expect(navigation.getAttribute('data-count')).toBe('5');
  });

  it('shows the page count but no page while the engine has not opened the document', () => {
    session.openDocument({ name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 5 });
    mount();
    const bar = screen.getByLabelText('status bar');
    expect(bar.getAttribute('data-page-index')).toBe('null');
    expect(bar.getAttribute('data-page-count')).toBe('5');
    expect(screen.queryByLabelText('page navigation')).toBeNull();
  });

  it('hides the page controls behind the start screen', () => {
    openTab();
    openStore.set({ showHomeScreen: true });
    mount();
    expect(screen.queryByLabelText('page navigation')).toBeNull();
  });

  it('sends the page controls to the viewer and the presentation', async () => {
    const user = userEvent.setup();
    openTab();
    viewerChanged(viewer as unknown as ViewerApi);
    mount();
    await user.click(screen.getByRole('button', { name: 'go to page 3' }));
    expect(viewer.goToPage).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole('button', { name: 'zoom 2' }));
    expect(viewer.setZoom).toHaveBeenCalledWith(2);
    await user.click(screen.getByRole('button', { name: 'fullscreen' }));
    expect(presentation.toggle).toHaveBeenCalledTimes(1);
    expect(presentation.viewers.at(-1)).toBe(viewer);
  });

  it('does nothing for a page control while no viewer is ready', async () => {
    const user = userEvent.setup();
    openTab();
    mount();
    await user.click(screen.getByRole('button', { name: 'go to page 3' }));
    await user.click(screen.getByRole('button', { name: 'zoom 2' }));
    expect(viewer.goToPage).not.toHaveBeenCalled();
    expect(viewer.setZoom).not.toHaveBeenCalled();
  });

  it('rotates the current page only while the document can be edited', async () => {
    const user = userEvent.setup();
    openTab();
    viewerChanged(viewer as unknown as ViewerApi);
    mount();
    await user.click(screen.getByRole('button', { name: 'rotate' }));
    expect(runPageAction).toHaveBeenCalledWith({ kind: 'rotate', direction: 'right' });
    act(() => coreStore.set({ busy: true }));
    expect(screen.queryByRole('button', { name: 'rotate' })).toBeNull();
  });
});
