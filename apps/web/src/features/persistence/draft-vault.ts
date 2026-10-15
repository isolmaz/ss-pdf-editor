/**
 * Removing documents from the vault: one document's stored copies, the unreferenced blobs, and
 * the key set this window announces to the others.
 *
 * Every deletion is from this origin's application storage. It does not overwrite the bytes
 * underneath, and it cannot reach a download, an external original or a browser backup.
 */

import {
  type DraftInventory,
  keysForDraft,
  type OpenDocumentKeys,
  planDocumentCleanup,
  planVaultCleanup,
  type SessionStore,
  sourceKeyFor,
} from 'pdf-model';
import { ToolError, type Translator } from 'pdf-shared';
import { deleteRecentHandle } from '../../recent-handles';
import { showNotice } from '../core/core-store';
import {
  disownDraft,
  draftStorage,
  persistedKeysFor,
  persistedKeysForgotten,
  persistenceStore,
  queueDraftWrite,
  storedSourceKeyFor,
} from './persistence-store';

/** The manifest inventory; one that could not be read completely says so rather than throwing. */
export async function readInventory(): Promise<DraftInventory> {
  const storage = draftStorage();
  try {
    if (storage.readDraftInventory !== undefined) return await storage.readDraftInventory();
    return { drafts: await storage.readDrafts(), unreadable: [] };
  } catch {
    return { drafts: [], unreadable: [], enumerationFailed: true };
  }
}

/** What every document open in this window holds, in the vault-key vocabulary. */
export function openVaultKeys(session: SessionStore, excludedTabId?: string): readonly OpenDocumentKeys[] {
  return session
    .getSnapshot()
    .tabs.filter((tab) => tab.id !== excludedTabId)
    .map((tab) => ({
      source: sourceKeyFor(tab.id, tab.source.sha256),
      snapshots: persistedKeysFor(tab.id),
    }));
}

/**
 * Removes one document's stored copies: its manifest, then every blob it owns that no
 * other manifest, open document or window still references.
 *
 * `null` means the inventory was incomplete and **nothing was deleted** — an orphan blob
 * costs space, a deleted live blob costs the user a document.
 */
export async function forgetDraft(session: SessionStore, tabId: string): Promise<readonly string[] | null> {
  const { channel } = persistenceStore.get();
  if (channel === null) return null;
  const storage = draftStorage();
  const inventory = await readInventory();
  const known = inventory.drafts.find((draft) => draft.id === tabId);
  // The source blob is stored when the document opens, so a tab closed before its first
  // automatic save owns one with no manifest to name it: without this it stayed in the vault
  // for good. It goes only if nothing else references it — the plan below applies the same
  // test (other manifests, other open documents, other windows) to every key it is given.
  const stored = storedSourceKeyFor(tabId);
  const owned = [
    ...new Set([
      ...(stored === undefined ? [] : [stored]),
      ...(known === undefined ? persistedKeysFor(tabId) : keysForDraft(known)),
    ]),
  ];
  // The plan refuses an inventory it could not read completely, and it does so before anything
  // is deleted. It ignores the target's own manifest, so planning ahead of its removal is exact.
  const removable = planDocumentCleanup(
    { manifestId: tabId, keys: owned },
    {
      open: openVaultKeys(session, tabId),
      storedSources: [],
      inventory,
      peerReferences: channel.peerReferences(),
    },
  );
  if (removable === null) return null;
  await storage.deleteDraft(tabId);
  for (const key of removable) await storage.deleteSource(key);
  persistedKeysForgotten(tabId);
  return removable;
}

/** The failure, worded for the notice line: a `ToolError` as itself, anything else as a failed write. */
export function failureNotice(error: unknown, t: Translator): string {
  const failure = error instanceof ToolError ? error : new ToolError('write-failed', { engine: 'model' });
  return `${t(failure.messageKey)} ${t(failure.hintKey)}`;
}

/**
 * The user-requested, **scoped** cleanup: forget the active document, here and now.
 *
 * It is the same operation the sensitive toggle performs, offered by name so the user
 * can reach it without changing a session setting, and it reports what actually left the
 * vault. Any copy the user downloaded, the file they opened it from, and any browser profile
 * backup are outside this application's reach — the notice says so.
 */
export async function purgeActiveDocument(session: SessionStore, t: Translator): Promise<void> {
  const tab = session.active;
  if (tab === null) return;
  const { channel } = persistenceStore.get();
  if (channel === null) {
    showNotice(t('vault.sweepNoChannel'));
    return;
  }
  try {
    await channel.runExclusive(async () => {
      const removed = await queueDraftWrite(async () => {
        await deleteRecentHandle(tab.id);
        return forgetDraft(session, tab.id);
      });
      if (removed === null) showNotice(t('vault.incomplete'));
      else showNotice(t('vault.purged', { count: removed.length }));
    });
  } catch (error) {
    showNotice(failureNotice(error, t));
  }
}

/**
 * The orphan sweep: delete the vault blobs no document references any more.
 *
 * It refuses in two cases, both of them stated to the user rather than hidden. An
 * incomplete inventory means the reference graph is unknown. An unreachable peer channel
 * means another window's live documents are invisible, and sweeping then would delete
 * the only copy of something this window never heard about.
 */
export async function sweepVault(session: SessionStore, t: Translator): Promise<void> {
  try {
    const { channel } = persistenceStore.get();
    if (channel === null || !channel.canReachPeers()) {
      showNotice(t('vault.sweepNoChannel'));
      return;
    }
    await channel.runExclusive(async () => {
      // A live window that never answered is a window whose documents are unknown: the
      // reference graph is incomplete, so nothing is deleted.
      if (!(await channel.probe())) {
        showNotice(t('vault.peerSilent'));
        return;
      }
      await queueDraftWrite(async () => {
        const storage = draftStorage();
        const inventory = await readInventory();
        const storedSources = (await storage.listSources?.()) ?? [];
        const plan = planVaultCleanup({
          open: openVaultKeys(session),
          storedSources,
          inventory,
          peerReferences: channel.peerReferences(),
        });
        if (!plan.ok) {
          showNotice(t('vault.incomplete'));
          return;
        }
        for (const key of plan.deleteKeys) await storage.deleteSource(key);
        showNotice(
          plan.deleteKeys.length === 0
            ? t('vault.sweepNothing')
            : t('vault.swept', { count: plan.deleteKeys.length }),
        );
      });
    });
  } catch (error) {
    showNotice(failureNotice(error, t));
  }
}

/**
 * Keep this window's claims on the drafts of the documents it has open (`vault-channel.ts`).
 * Every open tab is claimed — the claim is idempotent, and one the lock manager refused is asked
 * for again — and a tab that has left `previous` is released **after** the writes queued
 * for it, so the manifest its discard deletes is gone before another window can claim, and
 * restore, the draft. Returns the ids that are open now: the `previous` of the next call.
 */
export function syncDraftClaims(session: SessionStore, previous: ReadonlySet<string>): ReadonlySet<string> {
  const open = new Set(session.getSnapshot().tabs.map((tab) => tab.id));
  const { channel } = persistenceStore.get();
  if (channel !== null) {
    for (const id of open) void channel.claimDraft(id);
    for (const id of previous) {
      if (!open.has(id)) void queueDraftWrite(async () => disownDraft(id));
    }
  }
  return open;
}

/**
 * Tell the other windows which vault keys this one is holding, so their sweeps treat them as
 * live.
 */
export function announceOpenKeys(session: SessionStore): void {
  persistenceStore
    .get()
    .channel?.announce(
      session
        .getSnapshot()
        .tabs.flatMap((tab) => [sourceKeyFor(tab.id, tab.source.sha256), ...persistedKeysFor(tab.id)]),
    );
}
