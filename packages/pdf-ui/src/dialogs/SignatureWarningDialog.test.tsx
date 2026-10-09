// @vitest-environment happy-dom
/**
 * The pre-save signature warning: what it says for a save that breaks the signature and for one
 * that only adds a revision, which signer it names, and which button answers which way.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignatureWarningDialog } from './SignatureWarningDialog';

const t = createTranslator('en');

afterEach(cleanup);

function show(breaks: boolean, signer: string | null) {
  const onContinue = vi.fn();
  const onCancel = vi.fn();
  render(
    <SignatureWarningDialog
      t={t}
      breaks={breaks}
      signer={signer}
      fieldName="Signature1"
      onContinue={onContinue}
      onCancel={onCancel}
    />,
  );
  return { onContinue, onCancel };
}

describe('SignatureWarningDialog', () => {
  it('warns that saving invalidates the signature and offers to save anyway', async () => {
    const { onContinue, onCancel } = show(true, 'Ada Lovelace');
    expect(screen.getByRole('dialog').textContent).toContain('Saving will invalidate existing signature');
    expect(screen.getByRole('dialog').textContent).toContain('Ada Lovelace');
    expect(screen.getByRole('dialog').textContent).toContain('Signature1');
    await userEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('says a new version follows the signing when the file stays incremental', async () => {
    const { onContinue, onCancel } = show(false, 'Ada Lovelace');
    expect(screen.getByRole('dialog').textContent).toContain('A new version will be written after signing');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('says the signer could not be read when the certificate named none', () => {
    show(true, null);
    expect(screen.getByRole('dialog').textContent).toContain('could not read from certificate');
  });

  it('asks to cancel, never to close by itself, when Escape is pressed', async () => {
    const { onCancel } = show(true, null);
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
