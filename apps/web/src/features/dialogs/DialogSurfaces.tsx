/**
 * The modals the dialogs store opens: the standalone operation (`StartDialog`), the batch
 * dialog and the shortcut list. Each loads on demand — they are reached by a gesture, so none
 * belongs in the first paint — and is mounted only while the store says it is open: a static
 * import here is what put Kumo's dialog primitives on the first-paint graph, and a `lazy`
 * boundary that is mounted unconditionally still fetches immediately.
 */

import type { Translator } from 'pdf-shared';
import type { OperationRunContext, OpRunResult } from 'pdf-ui/ui';
import { lazy, Suspense, useMemo } from 'react';
import { downloadFiles } from '../../operations';
import { SHELL_SHORTCUT_GROUPS } from '../../useShortcuts';
import { showNotice } from '../core/core-store';
import { closeBatchDialog, closeStartDialog, useDialogs } from './dialogs-store';

/**
 * The batch dialog: a queue of files, not the open document. It carries Kumo's form and
 * dialog primitives, so it lives behind the same boundary as the other dialogs.
 */
const BatchDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.BatchDialog };
});
/**
 * The modal host of an operation that starts a document (blank, images, merge): it runs
 * with no document open, so it cannot live in a tab's tools panel.
 */
const StartDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.StartDialog };
});
/**
 * The keyboard shortcut list. Help is not a document operation — it opens with no tab
 * and in either mode — but it carries Kumo's dialog primitives, so it rides the dialog
 * boundary with the other modals rather than the first paint.
 */
const ShortcutsDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.ShortcutsDialog };
});

export interface StartDialogHostProps {
  readonly t: Translator;
  /** Carry the operation's result: download it or open it as a new tab. */
  readonly onResult: (result: OpRunResult) => Promise<void>;
}

/** Mounted only while a standalone operation is open. */
export function StartDialogHost({ t, onResult }: StartDialogHostProps) {
  const startSpec = useDialogs((state) => state.startSpec);
  /** What a standalone operation runs against: no bytes, no pages, nothing selected. */
  const context: OperationRunContext = useMemo(
    () => ({ bytes: new Uint8Array(0), pageCount: 0, name: '', currentPage: 0, selectedPages: [], t }),
    [t],
  );
  if (startSpec === null) return null;
  return (
    <Suspense fallback={null}>
      <StartDialog
        t={t}
        spec={startSpec}
        context={context}
        onClose={closeStartDialog}
        onResult={(result) => void onResult(result)}
      />
    </Suspense>
  );
}

/** Mounted only while the batch dialog is open. */
export function BatchDialogHost({ t }: { readonly t: Translator }) {
  const batchOpen = useDialogs((state) => state.batchOpen);
  if (!batchOpen) return null;
  return (
    <Suspense fallback={null}>
      <BatchDialog
        t={t}
        open={batchOpen}
        onClose={closeBatchDialog}
        onDownload={downloadFiles}
        onNotice={showNotice}
      />
    </Suspense>
  );
}

export interface ShortcutsDialogHostProps {
  readonly t: Translator;
  readonly onClose: () => void;
}

/** Mounted only while the shortcut list is open. */
export function ShortcutsDialogHost({ t, onClose }: ShortcutsDialogHostProps) {
  const shortcutsOpen = useDialogs((state) => state.shortcutsOpen);
  if (!shortcutsOpen) return null;
  return (
    <Suspense fallback={null}>
      <ShortcutsDialog t={t} open={shortcutsOpen} groups={SHELL_SHORTCUT_GROUPS} onClose={onClose} />
    </Suspense>
  );
}
