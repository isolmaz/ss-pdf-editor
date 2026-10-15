// @vitest-environment happy-dom
/**
 * The narrow boundaries: a dock panel that cannot load is a sentence in its place (the app
 * around it keeps running), and a layer over the pages that cannot load draws nothing and says
 * why on the notice line.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator, loadLocale } from 'pdf-shared';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { LayerBoundary, PanelBoundary } from './SurfaceBoundaries';

const t = createTranslator('en');

beforeAll(async () => {
  await loadLocale('en');
});
beforeEach(() => {
  coreStore.set(initialCoreState());
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'onLine');
});

function ChunkFails(): ReactNode {
  throw new TypeError('Failed to fetch dynamically imported module: /editor/assets/DockPanels-1.js');
}

const OFFLINE = `${t('error.asset-offline.message')} ${t('error.asset-offline.hint')}`;

describe('PanelBoundary', () => {
  it('passes a panel that renders through', () => {
    render(
      <PanelBoundary t={t}>
        <p>the panel</p>
      </PanelBoundary>,
    );
    expect(screen.getByText('the panel')).toBeTruthy();
  });

  it('puts the failure in the panel’s place and leaves its siblings alone', () => {
    render(
      <div>
        <p>the tabs</p>
        <PanelBoundary t={t}>
          <ChunkFails />
        </PanelBoundary>
      </div>,
    );
    expect(screen.getByRole('alert').textContent).toBe(OFFLINE);
    expect(screen.getByText('the tabs')).toBeTruthy();
  });
});

describe('LayerBoundary', () => {
  it('passes a layer that renders through, with no notice', () => {
    render(
      <LayerBoundary t={t}>
        <p>the layer</p>
      </LayerBoundary>,
    );
    expect(screen.getByText('the layer')).toBeTruthy();
    expect(coreStore.get().notice).toBeNull();
  });

  it('draws nothing for a layer that cannot load, and says why on the notice line', () => {
    render(
      <div>
        <p>the pages</p>
        <LayerBoundary t={t}>
          <ChunkFails />
        </LayerBoundary>
      </div>,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('the pages')).toBeTruthy();
    expect(coreStore.get().notice).toBe(OFFLINE);
  });
});
