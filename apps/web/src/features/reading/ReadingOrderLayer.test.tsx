// @vitest-environment happy-dom
/**
 * The reading-order layer arrives with the tags view's chunk: the shell shows its fallback
 * first, then the layer, which draws the boxes the tags panel published to its store.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createTranslator } from 'pdf-shared';
import { readingOrderStore } from 'pdf-ui/panels';
import type { ViewerApi } from 'pdf-ui/viewer';
import { Suspense } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ReadingOrderLayer } from './ReadingOrderLayer';

const viewer = {
  containerRect: () => ({ x: 0, y: 0, width: 600, height: 800 }),
  pageRect: (pageIndex: number) => (pageIndex === 0 ? { x: 0, y: 0, width: 600, height: 800 } : null),
} as unknown as ViewerApi;

const heading = { key: 'o1', number: 1, role: 'H1', rect: [10, 10, 100, 40] } as const;

// The layer is a dynamic chunk: load it once up front so no test races the first import.
beforeAll(async () => {
  await import('pdf-ui/panels');
}, 120_000);
afterEach(() => {
  cleanup();
  readingOrderStore.clear();
});

describe('ReadingOrderLayer', () => {
  it('shows the fallback while its chunk loads, then the numbered boxes the tags view published', async () => {
    readingOrderStore.setPages([{ pageIndex: 0, width: 600, height: 800, rotation: 0, items: [heading] }]);
    const { container } = render(
      <Suspense fallback={<p>loading</p>}>
        <ReadingOrderLayer t={createTranslator('en')} viewer={viewer} layout={0} />
      </Suspense>,
    );
    expect(screen.getByText('loading')).toBeTruthy();

    await waitFor(() => expect(container.querySelector('[data-order-box="o1"]')).not.toBeNull());
    expect(screen.queryByText('loading')).toBeNull();
    expect(container.querySelector('[data-order-box="o1"]')?.getAttribute('data-order-number')).toBe('1');
  });

  it('draws no box for a page the viewer has not laid out', async () => {
    readingOrderStore.setPages([
      { pageIndex: 0, width: 600, height: 800, rotation: 0, items: [heading] },
      { pageIndex: 1, width: 600, height: 800, rotation: 0, items: [{ ...heading, key: 'o2', number: 2 }] },
    ]);
    const { container } = render(
      <Suspense fallback={null}>
        <ReadingOrderLayer t={createTranslator('en')} viewer={viewer} layout={0} />
      </Suspense>,
    );
    await waitFor(() => expect(container.querySelector('[data-order-box="o1"]')).not.toBeNull());
    expect(container.querySelector('[data-order-box="o2"]')).toBeNull();
  });

  it('places the boxes again at a new layout, on the same mounted layer, where the viewer now puts the page', async () => {
    // A viewer is one object whose answers change: the page is where it says it is now.
    let page = { x: 0, y: 0, width: 600, height: 800 };
    const moving = {
      containerRect: () => ({ x: 0, y: 0, width: 600, height: 800 }),
      pageRect: () => page,
    } as unknown as ViewerApi;
    readingOrderStore.setPages([{ pageIndex: 0, width: 600, height: 800, rotation: 0, items: [heading] }]);
    const t = createTranslator('en');
    const layer = (layout: number) => (
      <Suspense fallback={null}>
        <ReadingOrderLayer t={t} viewer={moving} layout={layout} />
      </Suspense>
    );
    const { container, rerender } = render(layer(0));
    const box = async () => {
      await waitFor(() => expect(container.querySelector('[data-order-box="o1"]')).not.toBeNull());
      return container.querySelector<HTMLElement>('[data-order-box="o1"]');
    };
    const first = await box();
    expect(first?.style.left).toBe('10px');
    expect(first?.style.width).toBe('90px');

    // The page is laid out at twice the size, beside the scrolled content's origin.
    page = { x: 50, y: 0, width: 1200, height: 1600 };
    rerender(layer(1));
    const second = await box();
    expect(second).toBe(first);
    expect(second?.style.left).toBe('70px');
    expect(second?.style.width).toBe('180px');
  });
});
