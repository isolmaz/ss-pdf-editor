/**
 * Bringing one stored draft back as a tab: the source and snapshot bytes read from the vault,
 * the document opened with the engine, and the journal, snapshots, form values and dirty flag
 * put back. The startup recovery (`use-draft-recovery.ts`) and "open from the recent list"
 * (`features/open/open-actions.ts`) both restore through here, so a document reopened from its
 * recovery copy has the history and the page count the same draft gives at startup.
 *
 * Only a window that owns the draft restores it (`vault-channel.ts`): the id is the tab's
 * identity, and two windows holding one id write the same manifest.
 */

import { openWithPdfjs, type PdfDocumentHandle } from 'pdf-core/engines/pdfjs-handle';
import { type Draft, type ProducedDocument, type SessionStore, type SessionTab, sha256Hex } from 'pdf-model';
import { ToolError } from 'pdf-shared';
import { addRecentDocument } from '../../recent';
import { getRecentHandle } from '../../recent-handles';
import { holdEngineValues } from '../annotations/annotations-store';
import { adoptHandle } from '../core/handles';
import {
  disownDraft,
  draftStorage,
  ownsDraft,
  persistedKeysRecorded,
  sourceStored,
} from './persistence-store';

/** How often startup asks again for a draft another window seems to hold. */
const CLAIM_RETRY_MS = 250;

/** How many times it asks in all before it decides the draft is that window's. */
const CLAIM_ATTEMPTS = 6;

/** What a restore needs from the shell: the session, and the engine open that fingerprints beside it. */
export interface RestoreHost {
  readonly store: SessionStore;
  /** Open bytes with the engine and fingerprint them side by side (the shell's open path). */
  readonly openAndFingerprint: (
    opening: Promise<PdfDocumentHandle>,
    fingerprinting: Promise<string>,
  ) => Promise<readonly [PdfDocumentHandle, string]>;
}

export interface RestoreOptions {
  /**
   * Whether the restored tab comes to the front. Startup recovery says no: a document the user
   * opened while it ran is the one they chose, and stays in front.
   */
  readonly activate: boolean;
  /** Whether the caller went away while the restore was waiting; checked last, before the tab goes in. */
  readonly cancelled?: () => boolean;
}

export type RestoreOutcome =
  | { readonly kind: 'restored'; readonly tab: SessionTab }
  /** A tab with this id is already open in this window. */
  | { readonly kind: 'open' }
  /** Another window owns the draft: its document is open there. */
  | { readonly kind: 'elsewhere' }
  /** The caller went away first; nothing was opened. */
  | { readonly kind: 'cancelled' };

/**
 * Whether this window owns `draftId`, asking again for a moment when another window seems to:
 * a window that closed or reloaded a moment ago can still hold its locks while the next page
 * starts, and a draft skipped for that reason would wait for the next start to come back.
 * A live window never lets go, so this costs `CLAIM_RETRY_MS * (CLAIM_ATTEMPTS - 1)` at most.
 */
export async function claimWithPatience(draftId: string): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    if (await ownsDraft(draftId)) return true;
    if (attempt === CLAIM_ATTEMPTS) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, CLAIM_RETRY_MS));
  }
}

/**
 * Restore `draft` as a tab.
 *
 * Throws when the draft cannot be read back — its source, a snapshot its working version names,
 * or the document itself — and then owns nothing: a handle the engine opened is destroyed and a
 * claim this restore took is released, so one unreadable draft costs nothing beyond itself.
 * The caller reports it and carries on with the others.
 */
export async function restoreDraft(
  host: RestoreHost,
  draft: Draft,
  options: RestoreOptions,
): Promise<RestoreOutcome> {
  const { store, openAndFingerprint } = host;
  const isOpen = (): boolean => store.getSnapshot().tabs.some((tab) => tab.id === draft.id);
  // A draft whose document is already open stays where it is: reopening it would replace a live
  // tab's history with the stored one, and two windows doing that at once would race. The id is
  // the identity, so the check is exact.
  if (isOpen()) return { kind: 'open' };
  if (!(await ownsDraft(draft.id))) return { kind: 'elsewhere' };
  try {
    const storage = draftStorage();
    const bytes = await storage.getSource(draft.sourceKey);
    if (bytes === null) throw new ToolError('corrupt-document', { engine: 'model' });
    const snapshots: ProducedDocument[] = [];
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
    let tab: SessionTab;
    let activeBeforeRestore: string | null;
    try {
      // The handle the document was opened from, if one was kept (`recent-handles.ts`):
      // without it a restored tab could only Export, never Save over its file.
      const fileHandle = await getRecentHandle(draft.id);
      // Nothing awaits from here to the tab being in: the check, the document in front and the
      // opening all see one state. Read before the last await, "in front" was whatever was open
      // then, and a document the user opened while the handle store answered lost the front to
      // the restored one — whose export they then took for their own.
      if (options.cancelled?.() === true) {
        await handle.destroy();
        if (!isOpen()) disownDraft(draft.id);
        return { kind: 'cancelled' };
      }
      // Opened meanwhile (from the recent list, say): the live tab stays, and keeps its claim.
      if (isOpen()) {
        await handle.destroy();
        return { kind: 'open' };
      }
      activeBeforeRestore = store.getSnapshot().activeId;
      tab = store.openDocument({
        id: draft.id,
        name: draft.name,
        bytes,
        sha256,
        pageCount: draft.sourcePageCount ?? draft.pageCount,
        ...(fileHandle === null ? {} : { handle: fileHandle }),
      });
    } catch (error) {
      // The engine opened the document but no tab came of it: the handle would otherwise
      // outlive anything that can close it.
      await handle.destroy().catch(() => undefined);
      throw error;
    }
    adoptHandle(tab.id, handle);
    store.restoreHistory(tab.id, draft, snapshots);
    if (!options.activate && activeBeforeRestore !== null) store.setActive(activeBeforeRestore);
    persistedKeysRecorded(
      tab.id,
      (draft.snapshots ?? []).map((item) => item.key),
    );
    sourceStored(tab.id, draft.sourceKey);
    if (draft.engineValues.entries.length > 0) holdEngineValues(tab.id, draft.engineValues);
    if (draft.dirty) store.setDirty(tab.id, true);
    addRecentDocument({
      id: tab.id,
      name: tab.name,
      sizeBytes: (working?.bytes ?? bytes).byteLength,
      openedAt: Date.now(),
    });
    return { kind: 'restored', tab };
  } catch (error) {
    if (!isOpen()) disownDraft(draft.id);
    throw error;
  }
}
