// @vitest-environment happy-dom
/**
 * The page bar's two view toggles show their state from the stores they flip: the page dock
 * (core store) and reading mode (reading store).
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, hideLeftDock } from '../features/core/core-store';
import { readingStore, toggleReading } from '../features/reading/reading-store';
import { PageNavigation } from './PageNavigation';

const t = createTranslator('en');
const initialCore = coreStore.get();
const initialReading = readingStore.get();
const toggle = (key: Parameters<typeof t>[0]) => screen.getByRole('button', { name: t(key) });

function bar(overrides: Partial<ComponentProps<typeof PageNavigation>> = {}) {
  return (
    <PageNavigation
      t={t}
      currentPage={1}
      pageCount={5}
      onGoToPage={vi.fn()}
      zoom={1}
      onZoomChange={vi.fn()}
      onToggleFullscreen={vi.fn()}
      {...overrides}
    />
  );
}

beforeEach(() => {
  coreStore.set(initialCore);
  readingStore.set(initialReading);
});
afterEach(cleanup);

describe('PageNavigation', () => {
  it('toggles the page dock, pressed while it is open', async () => {
    const user = userEvent.setup();
    render(bar());
    expect(toggle('nav.togglePages').getAttribute('aria-pressed')).toBe('true');

    await user.click(toggle('nav.togglePages'));
    expect(coreStore.get().leftDock).toBe(false);
    expect(toggle('nav.togglePages').getAttribute('aria-pressed')).toBe('false');

    act(() => hideLeftDock());
    await user.click(toggle('nav.togglePages'));
    expect(coreStore.get().leftDock).toBe(true);
  });

  it('toggles reading mode, pressed while it is on whichever route turned it on', async () => {
    const user = userEvent.setup();
    render(bar());
    expect(toggle('nav.readingMode').getAttribute('aria-pressed')).toBe('false');

    act(() => toggleReading());
    expect(toggle('nav.readingMode').getAttribute('aria-pressed')).toBe('true');

    await user.click(toggle('nav.readingMode'));
    expect(readingStore.get().reading).toBe(false);
  });
});

describe('PageNavigation page and zoom controls', () => {
  const pageField = () => screen.getByRole('textbox', { name: t('nav.pageNumber') }) as HTMLInputElement;

  it('steps between pages and stops at the ends', async () => {
    const user = userEvent.setup();
    const onGoToPage = vi.fn();
    const { rerender } = render(bar({ onGoToPage }));

    await user.click(toggle('nav.prevPage'));
    await user.click(toggle('nav.nextPage'));
    expect(onGoToPage.mock.calls).toEqual([[0], [2]]);

    rerender(bar({ onGoToPage, currentPage: 0 }));
    expect(toggle('nav.prevPage').hasAttribute('disabled')).toBe(true);
    rerender(bar({ onGoToPage, currentPage: 4 }));
    expect(toggle('nav.nextPage').hasAttribute('disabled')).toBe(true);
  });

  it('goes to the page typed, and ignores one out of range or not a number', async () => {
    const user = userEvent.setup();
    const onGoToPage = vi.fn();
    render(bar({ onGoToPage }));
    expect(pageField().value).toBe('2');

    await user.click(pageField());
    await user.clear(pageField());
    await user.type(pageField(), '4{Enter}');
    expect(onGoToPage).toHaveBeenLastCalledWith(3);
    expect(pageField().value).toBe('2');

    for (const typed of ['9', '0', 'x']) {
      await user.click(pageField());
      await user.clear(pageField());
      await user.type(pageField(), `${typed}{Enter}`);
    }
    expect(onGoToPage).toHaveBeenCalledTimes(1);
  });

  it('submits the shown page unchanged without typing, and drops a half-typed one on blur', async () => {
    const user = userEvent.setup();
    const onGoToPage = vi.fn();
    render(bar({ onGoToPage }));

    await user.click(pageField());
    await user.keyboard('{Enter}');
    expect(onGoToPage).toHaveBeenCalledWith(1);

    await user.click(pageField());
    await user.clear(pageField());
    await user.type(pageField(), '5');
    await user.tab();
    expect(pageField().value).toBe('2');
  });

  it('sends the form without a typed value as no page at all', () => {
    const onGoToPage = vi.fn();
    render(bar({ onGoToPage }));
    fireEvent.submit(pageField());
    expect(onGoToPage).not.toHaveBeenCalled();
  });

  it('zooms a quarter at a time inside the range, and fits the width', async () => {
    const user = userEvent.setup();
    const onZoomChange = vi.fn();
    const { rerender } = render(bar({ onZoomChange, zoom: 1 }));

    await user.click(toggle('nav.zoomOut'));
    await user.click(toggle('nav.zoomIn'));
    await user.click(screen.getByRole('button', { name: `${t('nav.fitWidth')} (100%)` }));
    expect(onZoomChange.mock.calls).toEqual([[0.75], [1.25], ['page-width']]);

    rerender(bar({ onZoomChange, zoom: 0.25 }));
    expect(toggle('nav.zoomOut').hasAttribute('disabled')).toBe(true);
    rerender(bar({ onZoomChange, zoom: 4 }));
    expect(toggle('nav.zoomIn').hasAttribute('disabled')).toBe(true);
  });

  it('offers rotate only while the document can be edited, and always offers fullscreen', async () => {
    const user = userEvent.setup();
    const onRotate = vi.fn();
    const onToggleFullscreen = vi.fn();
    const { rerender } = render(bar({ onToggleFullscreen }));
    expect(screen.queryByRole('button', { name: t('nav.rotate') })).toBeNull();

    rerender(bar({ onToggleFullscreen, onRotate }));
    await user.click(toggle('nav.rotate'));
    await user.click(toggle('nav.fullscreen'));
    expect(onRotate).toHaveBeenCalledTimes(1);
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });
});
