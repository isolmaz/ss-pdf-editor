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
import { afterEach, describe, expect, it } from 'vitest';
import { ReadingOrderLayer } from './ReadingOrderLayer';

const viewer = {
  containerRect: () => ({ x: 0, y: 0, width: 600, height: 800 }),
  pageRect: (pageIndex: number) => (pageIndex === 0 ? { x: 0, y: 0, width: 600, height: 800 } : null),
} as unknown as ViewerApi;

afterEach(() => {
  cleanup();
  readingOrderStore.clear();
});

describe('ReadingOrderLayer', () => {
  it('shows the fallback while its chunk loads, then the numbered boxes the tags view published', async () => {
    readingOrderStore.setPages([
      {
        pageIndex: 0,
        width: 600,
        height: 800,
        rotation: 0,
        items: [{ key: 'o1', number: 1, role: 'H1', rect: [10, 10, 100, 40] }],
      },
    ]);
    const { container } = render(
      <Suspense fallback={<p>loading</p>}>
        <ReadingOrderLayer t={createTranslator('en')} viewer={viewer} />
      </Suspense>,
    );
    expect(screen.getByText('loading')).toBeTruthy();

    await waitFor(() => expect(container.querySelector('[data-order-box="o1"]')).not.toBeNull(), {
      timeout: 30_000,
    });
    expect(screen.queryByText('loading')).toBeNull();
    expect(container.querySelector('[data-order-box="o1"]')?.getAttribute('data-order-number')).toBe('1');
  }, 40_000);
});
