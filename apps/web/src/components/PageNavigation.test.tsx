// @vitest-environment happy-dom
/**
 * The page bar's two view toggles show their state from the stores they flip: the page dock
 * (core store) and reading mode (reading store).
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  // First in the file on purpose: the zoom menu is a lazy chunk, and only the first render of the
  // file can see it not yet loaded.
  it('draws the zoom as plain text until the zoom menu has loaded, then as its button', async () => {
    render(bar());
    expect(screen.queryByRole('button', { name: /^Zoom level/ })).toBeNull();
    expect(screen.getByText('100%')).toBeTruthy();

    expect(await screen.findByRole('button', { name: 'Zoom level (100%)' })).toBeTruthy();
  });

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

  it('zooms to the next standard stop inside the range, from a zoom that is on none too', async () => {
    const user = userEvent.setup();
    const onZoomChange = vi.fn();
    const { rerender } = render(bar({ onZoomChange, zoom: 1 }));

    await user.click(toggle('nav.zoomOut'));
    await user.click(toggle('nav.zoomIn'));
    expect(onZoomChange.mock.calls).toEqual([[0.9], [1.1]]);

    onZoomChange.mockClear();
    rerender(bar({ onZoomChange, zoom: 0.6347 }));
    await user.click(toggle('nav.zoomOut'));
    await user.click(toggle('nav.zoomIn'));
    expect(onZoomChange.mock.calls).toEqual([[0.5], [0.67]]);

    rerender(bar({ onZoomChange, zoom: 0.25 }));
    expect(toggle('nav.zoomOut').hasAttribute('disabled')).toBe(true);
    rerender(bar({ onZoomChange, zoom: 4 }));
    expect(toggle('nav.zoomIn').hasAttribute('disabled')).toBe(true);
  });

  it('shows the zoom on the button that opens the zoom menu, written the way the language does', async () => {
    render(bar({ zoom: 1.4 }));
    expect((await screen.findByRole('button', { name: 'Zoom level (140%)' })).textContent).toBe('140%');
    cleanup();
    const tr = createTranslator('tr');
    render(bar({ t: tr, zoom: 1.4 }));
    const trButton = await screen.findByRole('button', { name: `${tr('nav.zoomMenu')} (%140)` });
    expect(trButton.textContent).toBe('%140');
  });

  it('opens the zoom menu from the bar and hands the choice to the viewer', async () => {
    const user = userEvent.setup();
    const onZoomChange = vi.fn();
    render(bar({ onZoomChange }));
    await user.click(await screen.findByRole('button', { name: 'Zoom level (100%)' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Zoom level' })).getByRole('button', {
        name: 'Fit page',
      }),
    );
    expect(onZoomChange).toHaveBeenCalledExactlyOnceWith('page-fit');
  });

  it('offers rotate only while the document can be edited, and always offers fullscreen', async () => {
    const user = userEvent.setup();
    const onRotate = vi.fn();
    const onToggleFullscreen = vi.fn();
    const { rerender } = render(bar({ onToggleFullscreen }));
    expect(screen.queryByRole('button', { name: t('nav.rotate') })).toBeNull();

    rerender(bar({ onToggleFullscreen, onRotate }));
    // The tooltip and the description say what a press does to the document, and that it can be undone.
    expect(toggle('nav.rotate').getAttribute('aria-description')).toBe(t('nav.rotate.hint'));
    await user.click(toggle('nav.rotate'));
    await user.click(toggle('nav.fullscreen'));
    expect(onRotate).toHaveBeenCalledTimes(1);
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });
});
