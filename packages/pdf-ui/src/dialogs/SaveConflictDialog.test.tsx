// @vitest-environment happy-dom
/**
 * The file-changed question: what it says, which button answers which way, that the destructive
 * answer is never the default, and that dismissing it (Escape) is the "leave the file alone"
 * answer rather than a close of its own.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SaveConflictDialog } from './SaveConflictDialog';

const t = createTranslator('en');

afterEach(cleanup);

function show(busy = false) {
  const onCancel = vi.fn();
  const onOverwrite = vi.fn();
  const onSaveAs = vi.fn();
  render(
    <SaveConflictDialog
      t={t}
      name="contract.pdf"
      busy={busy}
      onCancel={onCancel}
      onOverwrite={onOverwrite}
      onSaveAs={onSaveAs}
    />,
  );
  return { onCancel, onOverwrite, onSaveAs };
}

describe('SaveConflictDialog', () => {
  it('says the file changed, what each answer does and which document it is about', () => {
    show();
    const text = screen.getByRole('dialog').textContent ?? '';
    expect(text).toContain(t('error.conflict.message'));
    expect(text).toContain(t('conflict.body'));
    expect(text).toContain('contract.pdf');
  });

  it('answers Overwrite, Save as and Cancel with exactly one call each', async () => {
    const { onCancel, onOverwrite, onSaveAs } = show();
    await userEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    expect([onOverwrite.mock.calls.length, onSaveAs.mock.calls.length, onCancel.mock.calls.length]).toEqual([
      1, 0, 0,
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    expect([onOverwrite.mock.calls.length, onSaveAs.mock.calls.length, onCancel.mock.calls.length]).toEqual([
      1, 1, 0,
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect([onOverwrite.mock.calls.length, onSaveAs.mock.calls.length, onCancel.mock.calls.length]).toEqual([
      1, 1, 1,
    ]);
  });

  it('treats Escape as Cancel and keeps the question on screen until the shell answers it', async () => {
    const { onCancel, onOverwrite, onSaveAs } = show();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOverwrite).not.toHaveBeenCalled();
    expect(onSaveAs).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('refuses both writing answers while an operation holds the document, but never Cancel', async () => {
    const { onCancel, onOverwrite, onSaveAs } = show(true);
    expect((screen.getByRole('button', { name: 'Overwrite' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save as…' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save as…' }));
    expect(onOverwrite).not.toHaveBeenCalled();
    expect(onSaveAs).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
