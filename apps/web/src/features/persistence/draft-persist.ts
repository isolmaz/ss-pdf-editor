/**
 * Writing a document's draft: the model data every open tab keeps in the vault so that closing
 * the browser is not losing work, the manual "save to browser" command, and the sensitive
 * session opt-out that removes what was stored.
 */

import {
  type DraftSnapshot,
  draftFor,
  encodeEngineValues,
  type ProducedDocument,
  type SessionStore,
  type SessionTab,
  sourceKeyFor,
  workingPageCount,
} from 'pdf-model';
import type { DeviceTier, Translator } from 'pdf-shared';
import { deleteRecentHandle } from '../../recent-handles';
import { showNotice } from '../core/core-store';
import { handleFor } from '../core/handles';
import { failureNotice, forgetDraft } from './draft-vault';
import { draftStorage, persistedKeysFor, persistedKeysRecorded, queueDraftWrite } from './persistence-store';

/** What one persistence attempt did, so the caller can word the notice honestly. */
export type PersistOutcome = 'written' | 'sensitive' | 'skipped' | 'gone';

/**
 * The snapshots a document retains, per device tier. Desktop keeps the journal's own history;
 * the smaller tiers keep one produced version, because a phone's storage budget is the
 * constraint that matters there.
 */
export function retainedSnapshotsFor(
  session: SessionStore,
  tab: SessionTab,
  tier: DeviceTier,
): readonly ProducedDocument[] {
  if (tier === 'desktop') return session.snapshotsFor(tab.id);
  return tab.working.produced === undefined ? [] : [tab.working.produced];
}

/**
 * The **one** implementation of draft persistence, used by the manual save command and
 * the debounced automatic save alike.
 *
 * The model state is captured synchronously before the first `await`, so the manifest
 * always describes the version whose bytes were written — reading it again after the
 * encoding work would let a fast edit publish a manifest for a state no blob matches.
 */
export async function persistDraft(
  session: SessionStore,
  tabId: string,
  tier: DeviceTier,
): Promise<PersistOutcome> {
  const before = session.getSnapshot().tabs.find((item) => item.id === tabId);
  if (before === undefined) return 'gone';
  if (before.sensitive) {
    // A sensitive document never enters persistence, and whatever an earlier session
    // stored for it leaves now.
    await forgetDraft(session, tabId);
    return 'sensitive';
  }
  const handle = handleFor(tabId);
  if (handle === undefined) return 'skipped';
  const storage = draftStorage();
  const map = handle.raw.annotationStorage?.serializable?.map;
  const journal = tier === 'desktop' ? before.journal.entries : [];
  const journalCursor = tier === 'desktop' ? before.journal.cursor : 0;
  const engineValues = await encodeEngineValues(map instanceof Map ? map.entries() : []);
  const sourceKey = sourceKeyFor(before.id, before.source.sha256);
  await storage.putSource(sourceKey, before.source.master);
  const snapshots: DraftSnapshot[] = [];
  for (const snapshot of retainedSnapshotsFor(session, before, tier)) {
    const key = `snapshot-${snapshot.id}`;
    await storage.putSource(key, snapshot.bytes);
    const { bytes: _bytes, ...description } = snapshot;
    snapshots.push({ ...description, key });
  }
  await storage.writeDraft(
    draftFor({
      id: before.id,
      name: before.name,
      pageCount: workingPageCount(before),
      size: before.source.size,
      sourcePageCount: before.source.pageCount,
      dirty: before.dirty,
      sourceKey,
      journal,
      journalCursor,
      stateId: before.working.stateId,
      savedState: before.savedState,
      ...(before.working.overlays === undefined ? {} : { overlays: before.working.overlays }),
      ...(before.working.produced === undefined ? {} : { workingId: before.working.produced.id }),
      snapshots,
      engineValues,
      now: Date.now(),
    }),
  );
  // The tab may have been closed or marked sensitive while the bytes were written; a
  // manifest for a sensitive document must not survive that race.
  const after = session.getSnapshot().tabs.find((item) => item.id === tabId);
  if (after === undefined || after.sensitive) {
    await forgetDraft(session, tabId);
    return after === undefined ? 'gone' : 'sensitive';
  }
  const keys = snapshots.map((item) => item.key);
  for (const key of persistedKeysFor(tabId)) {
    if (!keys.includes(key)) await storage.deleteSource(key);
  }
  persistedKeysRecorded(tabId, keys);
  return 'written';
}

/**
 * The manual "save to browser" command. `persist` is the shell's persistence callback; it runs
 * on the same write queue as the automatic save: a manual save that took its own path wrote a
 * manifest against a source key nothing ever stored, and could race the debounced one.
 */
export async function saveDraft(
  session: SessionStore,
  persist: (tabId: string) => Promise<PersistOutcome>,
  t: Translator,
): Promise<void> {
  const tab = session.active;
  if (tab === null) return;
  if (tab.sensitive) {
    showNotice(t('redact.sensitive.on'));
    return;
  }
  try {
    const outcome = await queueDraftWrite(() => persist(tab.id));
    if (outcome === 'written') showNotice(t('setting.opfsSaved'));
    else if (outcome === 'sensitive') showNotice(t('redact.sensitive.on'));
  } catch (error) {
    showNotice(failureNotice(error, t));
  }
}

/**
 * Flip the active document's sensitive-session opt-out. Turning it **on** is also the moment
 * the stored copies go, and the handle that would reopen the file: leaving them behind would
 * make the toggle a label rather than a decision.
 */
export function toggleSensitiveSession(session: SessionStore, t: Translator): void {
  const tab = session.active;
  if (tab === null) return;
  const next = !tab.sensitive;
  session.setSensitive(tab.id, next);
  if (!next) {
    showNotice(t('redact.sensitive.off'));
    return;
  }
  showNotice(t('redact.sensitive.on'));
  queueDraftWrite(async () => {
    await deleteRecentHandle(tab.id);
    return forgetDraft(session, tab.id);
  })
    .then((removed) => {
      if (removed === null) showNotice(t('vault.incomplete'));
    })
    .catch(() => showNotice(t('error.write-failed.message')));
}
