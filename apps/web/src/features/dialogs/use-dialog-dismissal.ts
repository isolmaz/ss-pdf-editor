import type { SessionSnapshot } from 'pdf-model';
import { useEffect } from 'react';
import { dismissOperationDialog, useDialogs } from './dialogs-store';

/**
 * A dialog belongs to the version it froze. When the active tab changes — the
 * user switched, closed it, or an operation landed behind the modal — the
 * frozen input is no longer that tab's document, so the dialog is dismissed
 * instead of being applied to bytes it was never opened for. `onDismissed` lets the shell
 * drop what else was frozen for that run (the text selection, the image list).
 */
export function useStaleDialogDismissal(session: SessionSnapshot, onDismissed: () => void): void {
  const dialogInput = useDialogs((state) => state.dialogInput);
  useEffect(() => {
    const input = dialogInput;
    if (input === null) return;
    const tab = session.tabs.find((item) => item.id === input.tabId);
    if (tab === undefined || tab.working.id !== input.workingId || session.activeId !== input.tabId) {
      dismissOperationDialog();
      onDismissed();
    }
  }, [dialogInput, onDismissed, session]);
}
