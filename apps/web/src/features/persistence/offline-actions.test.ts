/**
 * The offline commands say what the service worker's cache holds and what a preparation did,
 * and never round an interrupted or incomplete preparation up to success.
 */

import { createTranslator } from 'pdf-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as offline from '../../offline';
import type { PreparationResult, WorkerReadiness } from '../../offline';
import { coreStore, initialCoreState } from '../core/core-store';
import { checkOffline, prepareOfflinePackages } from './offline-actions';

const worker = vi.hoisted(() => ({ requestOfflineReadiness: vi.fn(), prepareOffline: vi.fn() }));
vi.mock('../../offline', async (importOriginal) => ({
  ...(await importOriginal<typeof offline>()),
  ...worker,
}));

const t = createTranslator('en');

/** A readiness in which the named capabilities are not ready. */
function readiness(...missing: string[]): WorkerReadiness {
  const capabilities = Object.fromEntries(
    ['core', 'app', 'pdfjs', 'mupdf', 'fonts'].map((name) => [
      name,
      { ready: !missing.includes(name), missing: missing.includes(name) ? ['/x'] : [] },
    ]),
  );
  return { version: 'v1', matchesBuild: true, capabilities };
}

function prepared(over: Partial<PreparationResult> = {}): PreparationResult {
  return { version: 'v1', prepared: 5, failed: [], ...over };
}

function notice(): string | null {
  return coreStore.get().notice;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  worker.requestOfflineReadiness.mockReset();
  worker.prepareOffline.mockReset();
});

describe('checkOffline', () => {
  it('says there is no service worker to ask', async () => {
    worker.requestOfflineReadiness.mockResolvedValue(null);
    await checkOffline(t);
    expect(notice()).toBe(t('offline.unavailable'));
  });

  it('says the editor works offline when the cache is complete', async () => {
    worker.requestOfflineReadiness.mockResolvedValue(readiness());
    await checkOffline(t);
    expect(notice()).toBe(t('offline.ready'));
  });

  it('names the capabilities the cache is missing', async () => {
    worker.requestOfflineReadiness.mockResolvedValue(readiness('mupdf', 'fonts'));
    await checkOffline(t);
    expect(notice()).toBe(t('offline.incomplete', { count: 2, facts: 'mupdf, fonts' }));
  });
});

describe('prepareOfflinePackages', () => {
  it('asks for the capabilities core editing needs, without OCR', async () => {
    worker.prepareOffline.mockResolvedValue(null);
    await prepareOfflinePackages(t);
    expect(worker.prepareOffline).toHaveBeenCalledWith(['core', 'app', 'pdfjs', 'mupdf', 'fonts']);
  });

  it('says there is no service worker to prepare the cache', async () => {
    worker.prepareOffline.mockResolvedValue(null);
    await prepareOfflinePackages(t);
    expect(notice()).toBe(t('offline.unavailable'));
    expect(worker.requestOfflineReadiness).not.toHaveBeenCalled();
  });

  it('reports an interrupted preparation with the count that did arrive', async () => {
    worker.prepareOffline.mockResolvedValue(prepared({ prepared: 3, failed: ['/a', '/b'] }));
    await prepareOfflinePackages(t);
    expect(notice()).toBe(t('offline.prepareFailed', { count: 3, failed: 2 }));
    expect(worker.requestOfflineReadiness).not.toHaveBeenCalled();
  });

  it('says the cache is prepared when the re-read agrees', async () => {
    worker.prepareOffline.mockResolvedValue(prepared());
    worker.requestOfflineReadiness.mockResolvedValue(readiness());
    await prepareOfflinePackages(t);
    expect(notice()).toBe(t('offline.prepared', { count: 5 }));
  });

  it('trusts the preparation when the worker cannot be asked again', async () => {
    worker.prepareOffline.mockResolvedValue(prepared());
    worker.requestOfflineReadiness.mockResolvedValue(null);
    await prepareOfflinePackages(t);
    expect(notice()).toBe(t('offline.prepared', { count: 5 }));
  });

  it('adds what the cache still lacks after the work, as it now is', async () => {
    worker.prepareOffline.mockResolvedValue(prepared());
    worker.requestOfflineReadiness.mockResolvedValue(readiness('pdfjs'));
    await prepareOfflinePackages(t);
    const lines = [
      t('offline.prepared', { count: 5 }),
      t('offline.incomplete', { count: 1, facts: 'pdfjs' }),
    ];
    expect(lines.every((line) => notice()?.includes(line))).toBe(true);
  });
});
