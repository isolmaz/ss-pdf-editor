import { type DraftInventory, isRestorable, lacksHistory, sortDrafts } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { useEffect } from 'react';
import { loadRecentDocuments } from '../../recent';
import { pruneRecentHandles } from '../../recent-handles';
import { showNotice } from '../core/core-store';
import { claimWithPatience, type RestoreHost, restoreDraft } from './draft-restore';
import { draftStorage } from './persistence-store';

export interface RecoveryHost extends RestoreHost {
  /**
   * The translator, read when a notice is worded and deliberately not a dependency of the
   * recovery effect: a dependency on it would replay recovery over tabs that are already open
   * when the interface language changes, restoring every draft a second time.
   */
  readonly translator: { readonly current: Translator };
}

/**
 * Drafts: the model data of every open tab — never the source bytes of a document the user
 * opened through a handle. On startup the restorable drafts come back as tabs so closing the
 * browser is not losing work.
 */
export function useDraftRecovery({ store, translator, openAndFingerprint }: RecoveryHost): void {
  useEffect(() => {
    let disposed = false;
    void (async () => {
      const storage = draftStorage();
      const inventory: DraftInventory =
        storage.readDraftInventory !== undefined
          ? await storage.readDraftInventory()
          : { drafts: await storage.readDrafts(), unreadable: [] };
      if (inventory.enumerationFailed === true) {
        if (!disposed) showNotice(translator.current('error.write-failed.message'));
        return;
      }
      if (inventory.unreadable.length > 0 && !disposed) {
        showNotice(translator.current('draft.corrupt', { count: inventory.unreadable.length }));
      }
      const drafts = sortDrafts(inventory.drafts);
      const isOpen = (id: string): boolean => store.getSnapshot().tabs.some((tab) => tab.id === id);
      // Another window that has a draft's document open owns it, and restoring it here would
      // put the same id in two windows. The claims are asked for together, so waiting for
      // windows that are closing costs one pause rather than one per draft.
      await Promise.all(
        drafts
          .filter((draft) => isRestorable(draft) && !isOpen(draft.id))
          .map((draft) => claimWithPatience(draft.id)),
      );
      let restored = 0;
      let withoutHistory = 0;
      let failure: ToolError | null = null;
      for (const draft of drafts) {
        if (!isRestorable(draft)) continue;
        // Each draft is read inside its own guard: the source of one that cannot be read is
        // reported and skipped, and the others still come back.
        try {
          const outcome = await restoreDraft({ store, openAndFingerprint }, draft, {
            activate: false,
            cancelled: () => disposed,
          });
          if (outcome.kind === 'cancelled') return;
          if (outcome.kind === 'restored') {
            restored += 1;
            if (lacksHistory(draft)) withoutHistory += 1;
          }
        } catch (error) {
          failure =
            error instanceof ToolError ? error : new ToolError('corrupt-document', { engine: 'model' });
        }
      }
      if (!disposed && failure !== null) {
        showNotice(`${translator.current(failure.messageKey)} ${translator.current(failure.hintKey)}`);
      } else if (!disposed && restored > 0 && inventory.unreadable.length === 0) {
        showNotice(
          withoutHistory === 0
            ? translator.current('draft.restored', { count: restored })
            : translator.current('draft.restoredNoHistory', { count: restored, withoutHistory }),
        );
      }
      // Handles whose recent entry is gone are forgotten — after the restore, which reads them.
      if (!disposed) await pruneRecentHandles(new Set(loadRecentDocuments().map((item) => item.id)));
    })().catch(() => {
      // The vault could not be read at all (not one draft: those are guarded above): the
      // failure is the user's to know, and never an unhandled rejection with no notice.
      if (!disposed) showNotice(translator.current('error.write-failed.message'));
    });
    return () => {
      disposed = true;
    };
  }, [store, translator, openAndFingerprint]);
}
