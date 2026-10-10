/**
 * Writing drafts: the manifest describes the version whose bytes were written, a sensitive
 * document never reaches the vault, a manual save queues behind the automatic one, and turning
 * the opt-out on removes what was stored.
 */

import { SessionStore } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { persistDraft, retainedSnapshotsFor, saveDraft, toggleSensitiveSession } from './draft-persist';
import { failureNotice } from './draft-vault';
import {
  draftWrites,
  persistedKeysFor,
  persistedKeysRecorded,
  persistenceStore,
  resetPersistence,
} from './persistence-store';
import { fakeChannel, type MemoryStorage, manifest, memoryStorage, openTab } from './vault.fixtures';

const outside = vi.hoisted(() => ({
  handles: new Map<string, unknown>(),
  deleteRecentHandle: vi.fn(),
}));
vi.mock('../core/handles', () => ({ handleFor: (id: string) => outside.handles.get(id) }));
vi.mock('../../recent-handles', () => ({ deleteRecentHandle: outside.deleteRecentHandle }));

const t = createTranslator('en');
let storage: MemoryStorage;

function apply(session: SessionStore, tabId: string, byte: number): void {
  session.applyOperation({
    tabId,
    bytes: new Uint8Array([byte]),
    pageCount: 3,
    labelKey: 'ann.engineEdit',
    engine: 'mupdf',
    steps: ['step'],
    overlays: null,
  });
}

/** A tab with an engine handle whose annotation storage holds nothing. */
function openRendered(session: SessionStore, sha256 = 'one') {
  const tab = openTab(session, sha256);
  outside.handles.set(tab.id, { raw: { annotationStorage: { serializable: { map: new Map() } } } });
  return tab;
}

function notice(): string | null {
  return coreStore.get().notice;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  resetPersistence();
  outside.handles.clear();
  outside.deleteRecentHandle.mockReset();
  outside.deleteRecentHandle.mockResolvedValue(undefined);
  storage = memoryStorage();
  persistenceStore.set({ draftStorage: storage, channel: fakeChannel() });
});

describe('retainedSnapshotsFor', () => {
  it('keeps the journal history on desktop and one produced version on the smaller tier', () => {
    const session = new SessionStore();
    const tab = openTab(session);
    expect(retainedSnapshotsFor(session, tab, 'desktop')).toEqual([]);
    expect(retainedSnapshotsFor(session, tab, 'mobile')).toEqual([]);
    apply(session, tab.id, 1);
    apply(session, tab.id, 2);
    const edited = session.active;
    if (edited === null) throw new Error('no tab');
    expect(retainedSnapshotsFor(session, edited, 'desktop')).toHaveLength(2);
    expect(retainedSnapshotsFor(session, edited, 'mobile')).toEqual([edited.working.produced]);
  });
});

describe('persistDraft', () => {
  it('has nothing to write for a document that is gone', async () => {
    expect(await persistDraft(new SessionStore(), 'missing', 'desktop')).toBe('gone');
    expect(storage.drafts.size).toBe(0);
  });

  it('writes nothing for a document the engine has not opened yet', async () => {
    const session = new SessionStore();
    const tab = openTab(session);
    expect(await persistDraft(session, tab.id, 'desktop')).toBe('skipped');
    expect(storage.drafts.size).toBe(0);
    expect(storage.sources.size).toBe(0);
  });

  it('stores the source, every retained snapshot and a manifest that references exactly them', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    apply(session, tab.id, 1);
    const edited = session.active;
    if (edited === null) throw new Error('no tab');

    expect(await persistDraft(session, tab.id, 'desktop')).toBe('written');

    const draft = storage.drafts.get(tab.id);
    expect(draft?.sourceKey).toBe('src-one');
    expect(draft?.dirty).toBe(true);
    expect(draft?.journal).toHaveLength(edited.journal.entries.length);
    expect(draft?.journalCursor).toBe(edited.journal.cursor);
    expect(draft?.workingId).toBe(edited.working.produced?.id);
    expect(draft?.snapshots?.map((snapshot) => snapshot.key)).toEqual(
      session.snapshotsFor(tab.id).map((snapshot) => `snapshot-${snapshot.id}`),
    );
    expect([...storage.sources.keys()].sort()).toEqual(
      ['src-one', ...(draft?.snapshots ?? []).map((snapshot) => snapshot.key)].sort(),
    );
    expect(persistedKeysFor(tab.id)).toEqual((draft?.snapshots ?? []).map((snapshot) => snapshot.key));
  });

  it('keeps no journal on the smaller tier and one produced version', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    apply(session, tab.id, 1);
    apply(session, tab.id, 2);
    expect(await persistDraft(session, tab.id, 'mobile')).toBe('written');
    const draft = storage.drafts.get(tab.id);
    expect(draft?.journal).toEqual([]);
    expect(draft?.journalCursor).toBe(0);
    expect(draft?.snapshots).toHaveLength(1);
  });

  it('writes a manifest with no overlays, no working version and no engine values for a fresh document', async () => {
    const session = new SessionStore();
    const tab = openTab(session);
    outside.handles.set(tab.id, { raw: {} });
    expect(await persistDraft(session, tab.id, 'desktop')).toBe('written');
    const draft = storage.drafts.get(tab.id);
    expect(draft?.workingId).toBeUndefined();
    expect(draft?.overlays).toBeUndefined();
    expect(draft?.engineValues.entries).toEqual([]);
  });

  it('records the pending overlays in the manifest', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    session.setOverlays(tab.id, { annotations: ['pending'] }, 'ann.engineEdit');
    await persistDraft(session, tab.id, 'desktop');
    expect(storage.drafts.get(tab.id)?.overlays).toEqual({ annotations: ['pending'] });
  });

  it('keeps the snapshot blobs the new manifest still references', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    apply(session, tab.id, 1);
    await persistDraft(session, tab.id, 'desktop');
    const kept = persistedKeysFor(tab.id);
    expect(kept).toHaveLength(1);
    const deleteSource = vi.spyOn(storage, 'deleteSource');
    expect(await persistDraft(session, tab.id, 'desktop')).toBe('written');
    expect(deleteSource).not.toHaveBeenCalled();
    expect(persistedKeysFor(tab.id)).toEqual(kept);
  });

  it('drops the snapshot blobs the new manifest no longer references', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    storage.sources.set('snapshot-old', new Uint8Array([9]));
    persistedKeysRecorded(tab.id, ['snapshot-old']);
    expect(await persistDraft(session, tab.id, 'desktop')).toBe('written');
    expect(storage.sources.has('snapshot-old')).toBe(false);
    expect(persistedKeysFor(tab.id)).toEqual([]);
  });

  it('never writes a manifest for a sensitive document and removes what an earlier session stored', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    session.setSensitive(tab.id, true);
    storage.drafts.set(tab.id, manifest(tab.id, { sourceKey: 'src-one' }));
    storage.sources.set('src-one', new Uint8Array([1]));
    const writeDraft = vi.spyOn(storage, 'writeDraft');
    const putSource = vi.spyOn(storage, 'putSource');

    expect(await persistDraft(session, tab.id, 'desktop')).toBe('sensitive');
    expect(writeDraft).not.toHaveBeenCalled();
    expect(putSource).not.toHaveBeenCalled();
    expect(storage.drafts.size).toBe(0);
    expect(storage.sources.size).toBe(0);
  });

  it('removes the manifest of a document marked sensitive while its bytes were written', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    const putSource = storage.putSource;
    storage.putSource = async (key, bytes) => {
      await putSource(key, bytes);
      session.setSensitive(tab.id, true);
    };
    expect(await persistDraft(session, tab.id, 'desktop')).toBe('sensitive');
    expect(storage.drafts.size).toBe(0);
  });

  it('reports a document closed while its bytes were written as gone, with nothing left behind', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    const writeDraft = storage.writeDraft;
    storage.writeDraft = async (draft) => {
      await writeDraft(draft);
      session.closeTab(tab.id);
    };
    expect(await persistDraft(session, tab.id, 'desktop')).toBe('gone');
    expect(storage.drafts.size).toBe(0);
  });
});

describe('saveDraft', () => {
  it('does nothing with no document open', async () => {
    const persist = vi.fn();
    await saveDraft(new SessionStore(), persist, t);
    expect(persist).not.toHaveBeenCalled();
    expect(notice()).toBeNull();
  });

  it('refuses a sensitive document and says why', async () => {
    const session = new SessionStore();
    const tab = openTab(session);
    session.setSensitive(tab.id, true);
    const persist = vi.fn();
    await saveDraft(session, persist, t);
    expect(persist).not.toHaveBeenCalled();
    expect(notice()).toBe(t('redact.sensitive.on'));
  });

  it('persists the active document and says it was saved', async () => {
    const session = new SessionStore();
    const tab = openTab(session);
    const persist = vi.fn(async () => 'written' as const);
    await saveDraft(session, persist, t);
    expect(persist).toHaveBeenCalledWith(tab.id);
    expect(notice()).toBe(t('setting.opfsSaved'));
  });

  it('says the document is sensitive when it turned so while the save waited', async () => {
    const session = new SessionStore();
    openTab(session);
    await saveDraft(session, async () => 'sensitive', t);
    expect(notice()).toBe(t('redact.sensitive.on'));
  });

  it.each(['skipped', 'gone'] as const)('says nothing when the outcome is %s', async (outcome) => {
    const session = new SessionStore();
    openTab(session);
    await saveDraft(session, async () => outcome, t);
    expect(notice()).toBeNull();
  });

  it('waits for the writes queued before it, and reports a failure without stopping the queue', async () => {
    const session = new SessionStore();
    openTab(session);
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    draftWrites.current = gate;
    const persist = vi.fn(async () => {
      throw new Error('quota');
    });
    const saving = saveDraft(session, persist, t);
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();
    release();
    await saving;
    expect(persist).toHaveBeenCalledTimes(1);
    expect(notice()).toBe(failureNotice(new Error('quota'), t));
    await expect(draftWrites.current).resolves.toBeUndefined();
  });
});

describe('toggleSensitiveSession', () => {
  it('does nothing with no document open', () => {
    toggleSensitiveSession(new SessionStore(), t);
    expect(notice()).toBeNull();
  });

  it('turns the opt-out on, then removes the stored copies and the reopening handle', async () => {
    const session = new SessionStore();
    const tab = openTab(session);
    storage.drafts.set(tab.id, manifest(tab.id, { sourceKey: 'src-a' }));
    storage.sources.set('src-a', new Uint8Array([1]));

    toggleSensitiveSession(session, t);
    expect(session.active?.sensitive).toBe(true);
    expect(notice()).toBe(t('redact.sensitive.on'));
    await draftWrites.current;
    await vi.waitFor(() => expect(storage.drafts.size).toBe(0));
    expect(storage.sources.size).toBe(0);
    expect(outside.deleteRecentHandle).toHaveBeenCalledWith(tab.id);
    expect(notice()).toBe(t('redact.sensitive.on'));
  });

  it('turns the opt-out off without touching the vault', async () => {
    const session = new SessionStore();
    const tab = openTab(session);
    session.setSensitive(tab.id, true);
    toggleSensitiveSession(session, t);
    expect(session.active?.sensitive).toBe(false);
    expect(notice()).toBe(t('redact.sensitive.off'));
    await draftWrites.current;
    expect(outside.deleteRecentHandle).not.toHaveBeenCalled();
  });

  it('says the cleanup was incomplete when the vault could not be read', async () => {
    storage.failInventory = true;
    const session = new SessionStore();
    openTab(session);
    toggleSensitiveSession(session, t);
    await vi.waitFor(() => expect(notice()).toBe(t('vault.incomplete')));
  });

  it('says the write failed when the cleanup throws', async () => {
    outside.deleteRecentHandle.mockRejectedValue(new Error('locked'));
    const session = new SessionStore();
    openTab(session);
    toggleSensitiveSession(session, t);
    await vi.waitFor(() => expect(notice()).toBe(t('error.write-failed.message')));
  });
});
