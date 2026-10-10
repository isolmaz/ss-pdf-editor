/**
 * The question a save asks when it would touch a signed document: continue, or keep the file as
 * it is. The prompt is state rather than a `window.confirm` so the answer is a real button in the
 * app's own surface. The answer resumes exactly the frozen output operation that asked; it never
 * authorizes a later call or another tab.
 */

import type { SignatureVerification } from 'pdf-core';
import type { Translator } from 'pdf-shared';
import { createStore, useStore } from '../store';

/** The signature a pending save would touch, and whether that save rewrites the file. */
export interface SignatureWarning {
  readonly breaks: boolean;
  readonly signer: string | null;
  readonly fieldName: string;
}

export const signaturePrompt = createStore<{ readonly warning: SignatureWarning | null }>({ warning: null });

/** Resumes the output operation that asked. */
let decision: ((accepted: boolean) => void) | null = null;

/**
 * Ask whether to go on. With no signature there is nothing to ask, and the answer is yes;
 * otherwise the prompt opens and the promise settles when the user answers it.
 */
export function confirmSignature(
  signatures: readonly SignatureVerification[],
  incremental: boolean,
  t: Translator,
): Promise<boolean> {
  const signature = signatures[0];
  if (signature === undefined) return Promise.resolve(true);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  decision = resolve;
  signaturePrompt.set({
    warning: {
      breaks: !incremental,
      signer: signature.signer,
      fieldName: signature.fieldName === '' ? t('props.sig.unnamed') : signature.fieldName,
    },
  });
  return promise;
}

/** The user answered: resume the operation that asked, and close the prompt. */
export function answerSignature(accepted: boolean): void {
  decision?.(accepted);
  decision = null;
  signaturePrompt.set({ warning: null });
}

/** Whether the prompt is open (other dialogs wait for it). */
export function useSignaturePending(): boolean {
  return useStore(signaturePrompt, (state) => state.warning !== null);
}
