/**
 * The modal host of a `standalone` operation (`OperationDialogSpec.standalone`).
 *
 * The tools panel belongs to the open tab: a form there is frozen against that tab's bytes
 * and dismissed when the tab changes. An operation that *starts* a document has no tab to
 * belong to — it runs from the home screen just as well — so it gets this modal instead,
 * with the same `OperationForm` body every other operation renders, and the shell opens its
 * one result in a new tab.
 */

import { Dialog } from '@cloudflare/kumo/components/dialog';
import type { Translator } from 'pdf-shared';
import { useRef } from 'react';
import { OperationForm } from './OperationForm';
import type { OperationDialogSpec, OperationRunContext, OpRunResult } from './types';

export interface StartDialogProps {
  readonly t: Translator;
  readonly spec: OperationDialogSpec;
  readonly context: OperationRunContext;
  readonly onClose: () => void;
  readonly onResult: (result: OpRunResult) => void;
}

export function StartDialog({ t, spec, context, onClose, onResult }: StartDialogProps) {
  // A run in flight is cancelled by the form's own close path; the backdrop and Escape
  // must not tear the form down underneath it.
  const running = useRef(false);
  return (
    <Dialog.Root
      open
      onOpenChange={(open, details) => {
        if (open) return;
        details.cancel();
        if (!running.current) onClose();
      }}
    >
      <Dialog
        size="lg"
        className="pdf-floating-shadow flex max-h-[85vh] w-full flex-col gap-3 overflow-y-auto p-5"
      >
        <OperationForm
          key={spec.id}
          t={t}
          spec={spec}
          context={context}
          onClose={onClose}
          onResult={onResult}
          onRunningChange={(value) => {
            running.current = value;
          }}
          renderTitle={(title) => (
            <Dialog.Title className="text-sm font-semibold text-kumo-strong">{title}</Dialog.Title>
          )}
          renderIntro={(intro) => (
            <Dialog.Description className="text-xs text-kumo-subtle">{intro}</Dialog.Description>
          )}
        />
      </Dialog>
    </Dialog.Root>
  );
}
