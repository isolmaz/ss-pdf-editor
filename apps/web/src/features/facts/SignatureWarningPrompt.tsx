import type { Translator } from 'pdf-shared';
import { lazy, Suspense } from 'react';
import { useStore } from '../store';
import { answerSignature, signaturePrompt } from './signature-prompt';

// A dynamic chunk: the shell's first paint must not carry the dialogs (the entry budget is locked).
const SignatureWarningDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.SignatureWarningDialog };
});

/** The dialog a save that would touch a signature asks its question in; nothing while none is asked. */
export function SignatureWarningPrompt({ t }: { readonly t: Translator }) {
  const warning = useStore(signaturePrompt, (state) => state.warning);
  if (warning === null) return null;
  return (
    <Suspense fallback={null}>
      <SignatureWarningDialog
        t={t}
        breaks={warning.breaks}
        signer={warning.signer}
        fieldName={warning.fieldName}
        onCancel={() => answerSignature(false)}
        onContinue={() => answerSignature(true)}
      />
    </Suspense>
  );
}
