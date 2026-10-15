// @vitest-environment happy-dom
/**
 * The zoom button of the status bar: it shows the percentage and opens a panel with the standard
 * stops, fit width, fit page and a typed value. Each choice reaches the viewer as the zoom it names,
 * and the panel closes.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZoomMenu } from './ZoomMenu';

const t = createTranslator('en');

afterEach(cleanup);

async function open(zoom = 1) {
  const user = userEvent.setup();
  const onZoomChange = vi.fn();
  render(<ZoomMenu t={t} zoom={zoom} onZoomChange={onZoomChange} />);
  await user.click(screen.getByRole('button', { name: `Zoom level (${Math.round(zoom * 100)}%)` }));
  const panel = await screen.findByRole('dialog', { name: 'Zoom level' });
  return { user, onZoomChange, panel };
}

describe('ZoomMenu', () => {
  it('shows the percentage on the button and lists the standard stops with the current one marked', async () => {
    const { panel } = await open(1);
    const stops = within(panel)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(stops.slice(0, 15)).toEqual([
      '25%',
      '33%',
      '50%',
      '67%',
      '75%',
      '90%',
      '100%',
      '110%',
      '125%',
      '150%',
      '175%',
      '200%',
      '250%',
      '300%',
      '400%',
    ]);
    expect(within(panel).getByRole('button', { name: '100%' }).getAttribute('aria-current')).toBe('true');
    expect(within(panel).getByRole('button', { name: '110%' }).getAttribute('aria-current')).toBeNull();
  });

  it('marks no stop while the zoom is between two', async () => {
    const { panel } = await open(0.6347);
    expect(within(panel).queryAllByRole('button', { current: true })).toHaveLength(0);
  });

  it('zooms to the stop clicked and closes the panel', async () => {
    const { user, onZoomChange, panel } = await open(1);
    await user.click(within(panel).getByRole('button', { name: '150%' }));
    expect(onZoomChange).toHaveBeenCalledExactlyOnceWith(1.5);
    expect(screen.queryByRole('dialog', { name: 'Zoom level' })).toBeNull();
  });

  it('fits the width or the page', async () => {
    const first = await open();
    await first.user.click(within(first.panel).getByRole('button', { name: 'Fit width' }));
    expect(first.onZoomChange).toHaveBeenCalledExactlyOnceWith('page-width');
    cleanup();

    const second = await open();
    await second.user.click(within(second.panel).getByRole('button', { name: 'Fit page' }));
    expect(second.onZoomChange).toHaveBeenCalledExactlyOnceWith('page-fit');
  });

  it('takes a typed value, starting from the current percentage', async () => {
    const { user, onZoomChange, panel } = await open(1.25);
    const field = within(panel).getByRole('textbox', { name: 'Zoom (%)' }) as HTMLInputElement;
    expect(field.value).toBe('125');
    await user.clear(field);
    await user.type(field, '80%{Enter}');
    expect(onZoomChange).toHaveBeenCalledExactlyOnceWith(0.8);
    expect(screen.queryByRole('dialog', { name: 'Zoom level' })).toBeNull();
  });

  it('says so, and keeps the panel and the zoom, for a value that is not 25 to 400', async () => {
    const { user, onZoomChange, panel } = await open();
    const field = within(panel).getByRole('textbox', { name: 'Zoom (%)' });
    expect(field.getAttribute('aria-invalid')).toBe('false');
    for (const typed of ['500', 'abc', '10']) {
      await user.clear(field);
      await user.type(field, `${typed}{Enter}`);
      expect(field.getAttribute('aria-invalid'), typed).toBe('true');
      expect(within(panel).getByRole('alert').textContent, typed).toBe('Enter a value from 25 to 400.');
    }
    expect(onZoomChange).not.toHaveBeenCalled();
    // Typing again takes the message away.
    await user.type(field, '1');
    expect(field.getAttribute('aria-invalid')).toBe('false');
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('closes on Escape and returns the focus to the button', async () => {
    const { user } = await open();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Zoom level' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Zoom level (100%)' }));
  });

  it('writes the percentages the way Turkish does', async () => {
    const tr = createTranslator('tr');
    const user = userEvent.setup();
    render(<ZoomMenu t={tr} zoom={1.4} onZoomChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: `${tr('nav.zoomMenu')} (%140)` }));
    const panel = await screen.findByRole('dialog', { name: tr('nav.zoomMenu') });
    expect(within(panel).getByRole('button', { name: '%100' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: tr('viewer.fitWidth') })).toBeTruthy();
  });
});
