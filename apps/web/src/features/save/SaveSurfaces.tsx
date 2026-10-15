/**
 * The surfaces that belong to saving — wired to the save store and the session: the question a
 * document with unsaved work asks before it closes, and the question a Save asks when the file on
 * disk is not the one the editor last saw.
 */

import type { SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { lazy, Suspense, useSyncExternalStore } from 'react';
import { useCore } from '../core/core-store';
import { useSignaturePending } from '../facts/signature-prompt';
import { discardAndClose, keepOpen, saveAndClose } from './close-actions';
import { keepFile, saveAfterConflict } from './conflict-actions';
import type { SaveOptions } from './save-actions';
import { useSave } from './save-store';

/**
 * The close question rides the same boundary as the capability dialogs: it is needed once per
 * close of a document with unsaved work, and the first paint must not carry it.
 */
const CloseDocumentDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.CloseDocumentDialog };
});

const SaveConflictDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.SaveConflictDialog };
});

export interface CloseDocumentHostProps {
  readonly t: Translator;
  readonly session: SessionStore;
  /** Drop a tab and everything kept for it (`discardTab`). */
  readonly discardTab: (id: string) => void;
  /** Save a tab (`saveActive`); whether it was written. */
  readonly saveActive: (tabId: string, options?: SaveOptions) => Promise<boolean>;
  /** Download a tab as a new file (`exportActive`). */
  readonly exportActive: (tabId: string) => Promise<void>;
}

/**
 * "Save changes to …?": shown while the save store holds a close request, and not over the
 * signature prompt that a Save in progress may be asking.
 */
export function CloseDocumentHost({
  t,
  session,
  discardTab,
  saveActive,
  exportActive,
}: CloseDocumentHostProps) {
  const closeRequest = useSave((state) => state.closeRequest);
  const conflict = useSave((state) => state.conflict);
  const busy = useCore((state) => state.busy);
  const notice = useCore((state) => state.notice);
  const signaturePending = useSignaturePending();
  const { tabs } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  // The file-changed question comes first: it is what stopped the save this one asked for.
  if (closeRequest === null || signaturePending || conflict !== null) return null;
  const tab = tabs.find((item) => item.id === closeRequest);
  return (
    <Suspense fallback={null}>
      <CloseDocumentDialog
        t={t}
        name={tab?.name ?? ''}
        canSave={tab?.source.handle !== undefined}
        busy={busy}
        notice={notice}
        onCancel={() => keepOpen()}
        onDiscard={() => discardAndClose({ discardTab }, closeRequest)}
        onExport={() => void exportActive(closeRequest)}
        onSave={() => void saveAndClose({ session, discardTab, saveActive }, closeRequest)}
      />
    </Suspense>
  );
}

export interface SaveConflictHostProps {
  readonly t: Translator;
  readonly session: SessionStore;
  /** Drop a tab and everything kept for it (`discardTab`). */
  readonly discardTab: (id: string) => void;
  /** Save a tab (`saveActive`) with the user's answer; whether it was written. */
  readonly saveActive: (tabId: string, options?: SaveOptions) => Promise<boolean>;
}

/**
 * "The file changed after you opened it": shown while the save store holds a conflict. Overwrite
 * writes over the file (this dialog is the confirmation), Save as chooses a new file, Cancel
 * leaves both alone.
 */
export function SaveConflictHost({ t, session, discardTab, saveActive }: SaveConflictHostProps) {
  const conflict = useSave((state) => state.conflict);
  const busy = useCore((state) => state.busy);
  const { tabs } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  if (conflict === null) return null;
  const tab = tabs.find((item) => item.id === conflict.tabId);
  const host = { session, discardTab, saveActive };
  return (
    <Suspense fallback={null}>
      <SaveConflictDialog
        t={t}
        name={tab?.name ?? ''}
        busy={busy}
        onCancel={() => keepFile()}
        onOverwrite={() => void saveAfterConflict(host, conflict.tabId, { overwrite: conflict.target })}
        onSaveAs={() => void saveAfterConflict(host, conflict.tabId, { saveAs: true })}
      />
    </Suspense>
  );
}
