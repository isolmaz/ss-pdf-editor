/**
 * Drawn redaction marks. The list needs a stable identity for its rows, and the operation needs
 * the engine rectangle, so each mark is kept as an id and its rectangle. Like every mark they are
 * the active tab's pending overlay, and every change is one undoable journal step.
 */

import type { SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { useCallback, useSyncExternalStore } from 'react';
import type { MarkedRedaction } from '../../annotation-interaction';
import { pendingOverlays } from '../../operations';
import { showNotice } from '../core/core-store';
import { type OverlayChange, writeOverlay } from '../core/overlays';

/** Replace the active tab's redaction marks (a new list, or a function of the current one). */
export function writeRedactions(
  session: SessionStore,
  change: OverlayChange<readonly MarkedRedaction[]>,
): void {
  writeOverlay(session, 'redactions', change, 'panel.redaction');
}

/** The active tab's redaction marks, re-read whenever the session changes, and the way to change them. */
export function useRedactionMarks(session: SessionStore) {
  useSyncExternalStore(session.subscribe, session.getSnapshot);
  const setRedactionMarks = useCallback(
    (change: OverlayChange<readonly MarkedRedaction[]>) => writeRedactions(session, change),
    [session],
  );
  return { redactionMarks: pendingOverlays(session.active).redactions, setRedactionMarks };
}

/**
 * Print and Snapshot render the engine document, which carries none of the session's staged
 * redaction marks: the browser's "Save as PDF" or a saved image would deliver the content the
 * marks were meant to remove, and the print dialog's imposed file opens as a new tab. They are
 * refused with the same notice as Save while a mark is unapplied.
 *
 * `true` means the action was refused.
 */
export function refuseUnappliedRedactions(session: SessionStore, t: Translator): boolean {
  if (pendingOverlays(session.active).redactions.length === 0) return false;
  showNotice(`${t('error.pending-redactions.message')} ${t('error.pending-redactions.hint')}`);
  return true;
}
