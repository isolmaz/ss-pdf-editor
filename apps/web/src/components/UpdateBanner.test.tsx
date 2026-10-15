// @vitest-environment happy-dom
/**
 * The update banner says which of three things is the case: no update (nothing is rendered), an
 * update that is offered, or a page that was left on its old code because it holds unsaved work
 * and must be saved and reloaded by hand. Its two buttons are the hook's reload and dismiss.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner } from './UpdateBanner';

const update = vi.hoisted(() => ({
  state: { updateAvailable: false, reloadHeld: false },
  reloadToUpdate: vi.fn(),
  dismissUpdate: vi.fn(),
}));
vi.mock('../serviceWorkerUpdate', () => ({
  useServiceWorkerUpdate: () => ({
    ...update.state,
    reloadToUpdate: update.reloadToUpdate,
    dismissUpdate: update.dismissUpdate,
  }),
}));

const t = createTranslator('en');

beforeEach(() => {
  update.state = { updateAvailable: false, reloadHeld: false };
  update.reloadToUpdate.mockReset();
  update.dismissUpdate.mockReset();
});
afterEach(cleanup);

describe('UpdateBanner', () => {
  it('renders nothing while there is no update', () => {
    const { container } = render(<UpdateBanner t={t} />);
    expect(container.textContent).toBe('');
  });

  it('offers the update, and its buttons refresh and close it', async () => {
    update.state = { updateAvailable: true, reloadHeld: false };
    render(<UpdateBanner t={t} />);
    expect(screen.getByRole('status').textContent).toContain(t('update.available'));
    expect(screen.queryByText(t('update.saveFirst'))).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: t('update.refresh') }));
    expect(update.reloadToUpdate).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: t('op.close') }));
    expect(update.dismissUpdate).toHaveBeenCalledOnce();
  });

  it('asks for a save and a reload when the page was left on its old code', async () => {
    update.state = { updateAvailable: true, reloadHeld: true };
    render(<UpdateBanner t={t} />);
    expect(screen.getByRole('status').textContent).toContain(t('update.saveFirst'));
    expect(screen.queryByText(t('update.available'))).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: t('update.refresh') }));
    expect(update.reloadToUpdate).toHaveBeenCalledOnce();
  });
});
