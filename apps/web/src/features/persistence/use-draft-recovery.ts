import { openWithPdfjs, type PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { type DraftInventory, isRestorable, type SessionStore, sha256Hex, sortDrafts } from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { useEffect } from 'react';
import { addRecentDocument, loadRecentDocuments } from '../../recent';
import { getRecentHandle, pruneRecentHandles } from '../../recent-handles';
import { holdEngineValues } from '../annotations/annotations-store';
import { showNotice } from '../core/core-store';
import { adoptHandle } from '../core/handles';
import { draftStorage, persistedKeysRecorded } from './persistence-store';

export interface RecoveryHost {
  readonly store: SessionStore;
  /**
   * The translator, read when a notice is worded and deliberately not a dependency of the
   * recovery effect: switching the interface language used to replay recovery over tabs that
   * were already open, restoring every draft a second time.
   */
  readonly translator: { readonly current: Translator };
  /** Open bytes with the engine and fingerprint them side by side (the shell's open path). */
  readonly openAndFingerprint: (
    opening: Promise<PdfDocumentHandle>,
    fingerprinting: Promise<string>,
  ) => Promise<readonly [PdfDocumentHandle, string]>;
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
      let restored = 0;
      let failure: ToolError | null = null;
      for (const draft of drafts) {
        if (!isRestorable(draft)) continue;
        // A draft whose document is already open stays where it is: reopening it would
        // replace a live tab's history with the stored one, and two windows doing that at
        // once would race. The id is the identity, so the check is exact.
        if (store.getSnapshot().tabs.some((tab) => tab.id === draft.id)) continue;
        const bytes = await storage.getSource(draft.sourceKey);
        if (bytes === null) {
          failure = new ToolError('corrupt-document', { engine: 'model' });
          continue;
        }
        try {
          const snapshots = [];
          for (const snapshot of draft.snapshots ?? []) {
            const data = await storage.getSource(snapshot.key);
            if (data !== null) snapshots.push({ ...snapshot, bytes: data });
          }
          const working = snapshots.find((item) => item.id === draft.workingId);
          if (draft.workingId !== undefined && working === undefined)
            throw new ToolError('corrupt-document', { engine: 'model' });
          const [handle, sha256] = await openAndFingerprint(
            openWithPdfjs(working?.bytes ?? bytes),
            sha256Hex(bytes),
          );
          // The handle the document was opened from, if one was kept (`recent-handles.ts`):
          // without it a restored tab could only Export, never Save over its file.
          const fileHandle = await getRecentHandle(draft.id);
          // Nothing awaits from here to the tab being in: the check, the document in front
          // and the opening all see one state. Read before the last await, "in front" was
          // whatever was open then, and a document the user opened while the handle store
          // answered lost the front to the restored one — whose export they then took for
          // their own.
          if (disposed) {
            await handle.destroy();
            return;
          }
          // Opened meanwhile (from the recent list, say): the live tab stays, and the other
          // drafts are still restored.
          if (store.getSnapshot().tabs.some((item) => item.id === draft.id)) {
            await handle.destroy();
            continue;
          }
          const activeBeforeRestore = store.getSnapshot().activeId;
          const tab = store.openDocument({
            id: draft.id,
            name: draft.name,
            bytes,
            sha256,
            pageCount: draft.sourcePageCount ?? draft.pageCount,
            ...(fileHandle === null ? {} : { handle: fileHandle }),
          });
          adoptHandle(tab.id, handle);
          store.restoreHistory(tab.id, draft, snapshots);
          if (activeBeforeRestore !== null) store.setActive(activeBeforeRestore);
          persistedKeysRecorded(
            tab.id,
            (draft.snapshots ?? []).map((item) => item.key),
          );
          if (draft.engineValues.entries.length > 0) {
            holdEngineValues(tab.id, draft.engineValues);
          }
          if (draft.dirty) store.setDirty(tab.id, true);
          addRecentDocument({
            id: tab.id,
            name: tab.name,
            sizeBytes: (working?.bytes ?? bytes).byteLength,
            openedAt: Date.now(),
          });
          restored += 1;
        } catch (error) {
          // Report the failed draft while continuing to recover the other documents.
          failure =
            error instanceof ToolError ? error : new ToolError('corrupt-document', { engine: 'model' });
        }
      }
      if (!disposed && failure !== null) {
        showNotice(`${translator.current(failure.messageKey)} ${translator.current(failure.hintKey)}`);
      } else if (!disposed && restored > 0 && inventory.unreadable.length === 0) {
        showNotice(translator.current('draft.restored', { count: restored }));
      }
      // Handles whose recent entry is gone are forgotten — after the restore, which reads them.
      if (!disposed) await pruneRecentHandles(new Set(loadRecentDocuments().map((item) => item.id)));
    })();
    return () => {
      disposed = true;
    };
  }, [store, translator, openAndFingerprint]);
}
