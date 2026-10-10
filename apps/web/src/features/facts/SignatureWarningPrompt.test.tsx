// @vitest-environment happy-dom
/**
 * The question a save asks before it touches a signed document: nothing is asked of an unsigned
 * one, the dialog names the signature and says whether the save breaks it, and the user's answer
 * resumes exactly the save that asked.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SignatureVerification } from 'pdf-core';
import { createTranslator } from 'pdf-shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignatureWarningPrompt } from './SignatureWarningPrompt';
import { answerSignature, confirmSignature, signaturePrompt, useSignaturePending } from './signature-prompt';

const t = createTranslator('en');

function signature(signer: string | null, fieldName: string): SignatureVerification {
  return { signer, fieldName } as SignatureVerification;
}

// The dialog is a dynamic chunk: load it once up front so no test waits on the first import.
beforeAll(async () => {
  await import('pdf-ui/dialog');
}, 60_000);
afterEach(() => {
  cleanup();
  answerSignature(false);
});

function Pending() {
  return <p>{useSignaturePending() ? 'waiting' : 'idle'}</p>;
}

describe('confirmSignature', () => {
  it('goes ahead without asking when nothing is signed', async () => {
    await expect(confirmSignature([], false, t)).resolves.toBe(true);
    expect(signaturePrompt.get().warning).toBeNull();
  });

  it('asks about the first signature, and settles with the answer', async () => {
    const view = render(<Pending />);
    expect(view.container.textContent).toBe('idle');

    let answer!: Promise<boolean>;
    act(() => {
      answer = confirmSignature([signature('Ada', 'Sig1'), signature('Bo', 'Sig2')], false, t);
    });
    expect(view.container.textContent).toBe('waiting');
    expect(signaturePrompt.get().warning).toEqual({ breaks: true, signer: 'Ada', fieldName: 'Sig1' });

    act(() => answerSignature(true));
    await expect(answer).resolves.toBe(true);
    expect(view.container.textContent).toBe('idle');
  });

  it('names an unnamed field and knows an incremental save does not break the signature', () => {
    void confirmSignature([signature(null, '')], true, t);
    expect(signaturePrompt.get().warning).toEqual({
      breaks: false,
      signer: null,
      fieldName: t('props.sig.unnamed'),
    });
  });

  it('closes the prompt even when nobody was waiting for an answer', () => {
    expect(() => answerSignature(true)).not.toThrow();
    expect(signaturePrompt.get().warning).toBeNull();
  });
});

describe('SignatureWarningPrompt', () => {
  it('renders nothing while no question is asked', () => {
    const view = render(<SignatureWarningPrompt t={t} />);
    expect(view.container.textContent).toBe('');
  });

  it('warns that the save breaks the signature, and a cancel keeps the file as it is', async () => {
    const user = userEvent.setup();
    render(<SignatureWarningPrompt t={t} />);
    let answer!: Promise<boolean>;
    act(() => {
      answer = confirmSignature([signature('Ada', 'Sig1')], false, t);
    });

    expect(await screen.findByText(t('sig.warn.breaks.title'))).toBeTruthy();
    expect(screen.getByText(/Ada/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('op.cancel') }));

    await expect(answer).resolves.toBe(false);
    expect(screen.queryByText(t('sig.warn.breaks.title'))).toBeNull();
  });

  it('lets the user continue a save that adds a revision', async () => {
    const user = userEvent.setup();
    render(<SignatureWarningPrompt t={t} />);
    let answer!: Promise<boolean>;
    act(() => {
      answer = confirmSignature([signature(null, 'Sig1')], true, t);
    });

    expect(await screen.findByText(t('sig.warn.revision.title'))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('sig.warn.continue') }));

    await expect(answer).resolves.toBe(true);
  });
});
