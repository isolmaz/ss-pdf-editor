// @vitest-environment happy-dom
/**
 * The entry point: the app mounts into `#root` once the interface language's catalogue is in
 * (or has failed, which must not leave a blank page), a page without `#root` says so, and the
 * idle warm-up of the lazy chunks carries on when one of them cannot be fetched.
 */

import type * as PdfShared from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const outside = vi.hoisted(() => ({
  loadLocale: vi.fn(),
  warmPdfjs: vi.fn(),
  loadEditor: vi.fn(),
  initServiceWorkerUpdates: vi.fn(),
}));
vi.mock('pdf-core', () => ({ warmPdfjs: outside.warmPdfjs }));
vi.mock('pdf-shared', async (importOriginal) => ({
  ...(await importOriginal<typeof PdfShared>()),
  loadLocale: outside.loadLocale,
}));
vi.mock('pdf-ui/ui', () => ({ getStoredLocale: () => 'en' }));
vi.mock('./App', async () => {
  const { createElement } = await import('react');
  return { App: () => createElement('main', null, 'the editor shell') };
});
vi.mock('./features/shell/editor-store', () => ({ loadEditor: outside.loadEditor }));
vi.mock('./serviceWorkerUpdate', () => ({ initServiceWorkerUpdates: outside.initServiceWorkerUpdates }));
// Chunks the cache does not hold: their dynamic import rejects.
vi.mock('pdf-ui/printing', () => {
  throw new Error('the printing chunk is not available');
});
vi.mock('pdf-ui/palette', () => {
  throw new Error('the palette chunk is not available');
});

/**
 * Runs the entry point. It has no exports: its effect is its module body, so each case loads it
 * afresh (`vi.resetModules` in `beforeEach`) through a dynamic import, which is the boundary under test.
 */
async function runMain(): Promise<unknown> {
  return import('./main');
}

/** The page's `#root`, present or not. */
function mountPoint(present: boolean): void {
  document.body.innerHTML = present ? '<div id="root"></div>' : '';
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(outside)) mock.mockReset();
  outside.loadLocale.mockResolvedValue(undefined);
  outside.loadEditor.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  // The idle callback runs the warm-up at once, so the entry point's whole effect is in the import.
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
    callback();
    return 1;
  });
  mountPoint(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'onLine');
  document.body.innerHTML = '';
});

describe('the entry point', () => {
  it('mounts the app into #root only after the interface language is loaded', async () => {
    const catalogue = Promise.withResolvers<void>();
    outside.loadLocale.mockReturnValue(catalogue.promise);
    await runMain();

    expect(outside.loadLocale).toHaveBeenCalledWith('en');
    expect(document.getElementById('root')?.textContent).toBe('');
    catalogue.resolve();
    await vi.waitFor(() => expect(document.getElementById('root')?.textContent).toBe('the editor shell'));
  });

  it('mounts the app anyway when the language catalogue cannot be loaded', async () => {
    outside.loadLocale.mockRejectedValue(new Error('offline'));
    await runMain();

    await vi.waitFor(() => expect(document.getElementById('root')?.textContent).toBe('the editor shell'));
  });

  it('refuses to start on a page that has no #root', async () => {
    mountPoint(false);

    await expect(runMain()).rejects.toThrow('#root is missing from index.html');
    expect(outside.loadLocale).not.toHaveBeenCalled();
  });

  it('keeps warming and checking for updates when a lazy chunk cannot be fetched', async () => {
    outside.loadEditor.mockRejectedValue(new Error('the editor chunk is not cached'));
    await runMain();
    // Let the three rejected imports settle: an unhandled one would fail the run.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(outside.warmPdfjs).toHaveBeenCalledTimes(1);
    expect(outside.loadEditor).toHaveBeenCalledTimes(1);
    expect(outside.initServiceWorkerUpdates).toHaveBeenCalledTimes(1);
  });
});
