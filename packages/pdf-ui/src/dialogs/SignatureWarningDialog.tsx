/**
 * The pre-save signature warning (`PLAN.md §9/K17`: “editing after signing invalidates
 * the signature → pre-save warning and a status badge”).
 *
 * One question with two answers, because the save router knows which one applies and the
 * user does not (`packages/pdf-model/src/save-router.ts`, `plan.incremental`):
 *
 *  - **incremental** — the file grows by a revision and the signature stays intact; a
 *    reader will show changes *after* the signing, which is a different statement from
 *    “broken” and must read as one.
 *  - **rewrite** — everything after the signature's `/ByteRange` is regenerated, so the
 *    signed bytes are gone and the signature will not verify. That is the case this dialog
 *    exists for, and the confirm button says so.
 *
 * It is deliberately not a `window.confirm`: the dialog is keyboard-reachable, it names
 * the signature it is talking about, and it is the same surface the rest of the app uses
 * (`K24`).
 */

import { Dialog } from '@cloudflare/kumo/components/dialog';
import type { MessageKey, Translator } from 'pdf-shared';
import { Button } from '../components/Button';

export interface SignatureWarningDialogProps {
  readonly t: Translator;
  /** True when the plan rewrites the file, which breaks the signature outright. */
  readonly breaks: boolean;
  /** The signer the certificate named, when it named one. */
  readonly signer: string | null;
  readonly fieldName: string;
  readonly onContinue: () => void;
  readonly onCancel: () => void;
}

export function SignatureWarningDialog({
  t,
  breaks,
  signer,
  fieldName,
  onContinue,
  onCancel,
}: SignatureWarningDialogProps) {
  const titleKey: MessageKey = breaks ? 'sig.warn.breaks.title' : 'sig.warn.revision.title';
  const bodyKey: MessageKey = breaks ? 'sig.warn.breaks.body' : 'sig.warn.revision.body';
  return (
    <Dialog.Root
      open
      onOpenChange={(next, details) => {
        if (next) return;
        details.cancel();
        onCancel();
      }}
    >
      <Dialog size="sm" className="flex flex-col gap-3 p-4">
        <Dialog.Title className="text-sm font-semibold text-kumo-strong">{t(titleKey)}</Dialog.Title>
        <p className="whitespace-pre-line text-xs text-kumo-subtle">
          {t(bodyKey, { signer: signer ?? t('props.sig.signerUnknown'), field: fieldName })}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t('op.cancel')}
          </Button>
          <Button variant={breaks ? 'destructive' : 'primary'} onClick={onContinue}>
            {t(breaks ? 'sig.warn.saveAnyway' : 'sig.warn.continue')}
          </Button>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
