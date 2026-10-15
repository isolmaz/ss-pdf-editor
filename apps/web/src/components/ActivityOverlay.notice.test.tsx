// @vitest-environment happy-dom
/**
 * The notice line of the activity overlay: the button a notice offers, and that pressing it
 * closes the notice and runs the action once.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityOverlay } from './ActivityOverlay';

const t = createTranslator('en');

afterEach(cleanup);

function show(noticeAction?: { label: string; run: () => void } | null) {
  const onDismiss = vi.fn();
  render(
    <ActivityOverlay
      t={t}
      notice="Applied to document: Stamp"
      {...(noticeAction === undefined ? {} : { noticeAction })}
      onDismiss={onDismiss}
      progress={null}
      onCancel={() => undefined}
    />,
  );
  return { onDismiss };
}

describe('ActivityOverlay notice', () => {
  it('offers no button with a notice that carries none', () => {
    show();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    cleanup();
    show(null);
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('closes the notice and runs the action when its button is pressed', async () => {
    const run = vi.fn();
    const { onDismiss } = show({ label: 'Details', run });
    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
