/**
 * The surface that belongs to saving: the question a document with unsaved work asks before it
 * closes — wired to the save store and the session.
 */

import type { SessionStore } from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { lazy, Suspense, useSyncExternalStore } from 'react';
import { useCore } from '../core/core-store';
import { useSignaturePending } from '../facts/signature-prompt';
import { discardAndClose, keepOpen, saveAndClose } from './close-actions';
import { useSave } from './save-store';

/**
 * The close question rides the same boundary as the capability dialogs: it is needed once per
 * close of a document with unsaved work, and the first paint must not carry it.
 */
const CloseDocumentDialog = lazy(async () => {
  const module = await import('pdf-ui/dialog');
  return { default: module.CloseDocumentDialog };
});

export interface CloseDocumentHostProps {
  readonly t: Translator;
  readonly session: SessionStore;
  /** Drop a tab and everything kept for it (`discardTab`). */
  readonly discardTab: (id: string) => void;
  /** Save a tab (`saveActive`); whether it was written. */
  readonly saveActive: (tabId: string) => Promise<boolean>;
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
  const busy = useCore((state) => state.busy);
  const notice = useCore((state) => state.notice);
  const signaturePending = useSignaturePending();
  const { tabs } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  if (closeRequest === null || signaturePending) return null;
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
