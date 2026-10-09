/**
 * Removing documents from the vault: a forget deletes only what nothing else references and
 * nothing at all when the inventory is incomplete; the purge and the sweep refuse without the
 * other windows and say what happened.
 */

import { type DraftSnapshot, SessionStore } from 'pdf-model';
import { createTranslator, ToolError } from 'pdf-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import {
  announceOpenKeys,
  failureNotice,
  forgetDraft,
  openVaultKeys,
  purgeActiveDocument,
  readInventory,
  sweepVault,
} from './draft-vault';
import { persistedKeysRecorded, persistenceStore, resetPersistence } from './persistence-store';
import { fakeChannel, type MemoryStorage, manifest, memoryStorage, openTab } from './vault.fixtures';

const handles = vi.hoisted(() => ({ deleteRecentHandle: vi.fn() }));
vi.mock('../../recent-handles', () => handles);

const t = createTranslator('en');
let storage: MemoryStorage;

function notice(): string | null {
  return coreStore.get().notice;
}

beforeEach(() => {
  coreStore.set(initialCoreState());
  resetPersistence();
  handles.deleteRecentHandle.mockReset();
  handles.deleteRecentHandle.mockResolvedValue(undefined);
  storage = memoryStorage();
  persistenceStore.set({ draftStorage: storage, channel: fakeChannel() });
});

describe('readInventory', () => {
  it('is what the storage lists', async () => {
    storage.drafts.set('a', manifest('a'));
    expect(await readInventory()).toEqual({ drafts: [manifest('a')], unreadable: [] });
  });

  it('falls back to the plain draft list for a storage that cannot say what it could not read', async () => {
    storage.drafts.set('a', manifest('a'));
    delete storage.readDraftInventory;
    expect(await readInventory()).toEqual({ drafts: [manifest('a')], unreadable: [] });
  });

  it('says the enumeration failed when the storage throws', async () => {
    storage.failInventory = true;
    expect(await readInventory()).toEqual({ drafts: [], unreadable: [], enumerationFailed: true });
  });
});

describe('openVaultKeys', () => {
  it('lists what each open document holds, without the excluded one', () => {
    const session = new SessionStore();
    const first = openTab(session, 'one');
    const second = openTab(session, 'two', 'b.pdf');
    persistedKeysRecorded(second.id, ['snapshot-1']);
    expect(openVaultKeys(session)).toEqual([
      { source: 'src-one', snapshots: [] },
      { source: 'src-two', snapshots: ['snapshot-1'] },
    ]);
    expect(openVaultKeys(session, first.id)).toEqual([{ source: 'src-two', snapshots: ['snapshot-1'] }]);
  });
});

describe('forgetDraft', () => {
  it('removes the manifest and the blobs nothing else references', async () => {
    const session = new SessionStore();
    const tab = openTab(session, 'one');
    storage.drafts.set(
      tab.id,
      manifest(tab.id, { sourceKey: 'src-one', snapshots: [snapshotKey('snapshot-1')] }),
    );
    storage.sources.set('src-one', new Uint8Array([1]));
    storage.sources.set('snapshot-1', new Uint8Array([2]));
    persistedKeysRecorded(tab.id, ['snapshot-1']);
    session.closeTab(tab.id);

    expect(await forgetDraft(session, tab.id)).toEqual(['src-one', 'snapshot-1']);
    expect(storage.drafts.size).toBe(0);
    expect(storage.sources.size).toBe(0);
  });

  it('removes what this window wrote when no manifest is stored for the document', async () => {
    const session = new SessionStore();
    storage.sources.set('snapshot-1', new Uint8Array([2]));
    persistedKeysRecorded('gone', ['snapshot-1']);
    expect(await forgetDraft(session, 'gone')).toEqual(['snapshot-1']);
    expect(storage.sources.size).toBe(0);
  });

  it('keeps a source another stored document, an open document or another window still references', async () => {
    const session = new SessionStore();
    const open = openTab(session, 'shared');
    storage.drafts.set('target', manifest('target', { sourceKey: 'src-shared' }));
    storage.drafts.set('other', manifest('other', { sourceKey: 'src-shared' }));
    storage.sources.set('src-shared', new Uint8Array([1]));
    expect(await forgetDraft(session, 'target')).toEqual([]);
    expect(storage.drafts.has('target')).toBe(false);
    expect(storage.sources.has('src-shared')).toBe(true);

    storage.drafts.delete('other');
    expect(await forgetDraft(session, 'target')).toEqual([]);
    session.closeTab(open.id);
    persistenceStore.set({ channel: fakeChannel({ peerReferences: () => ['src-shared'] }) });
    expect(await forgetDraft(session, 'target')).toEqual([]);
    expect(storage.sources.has('src-shared')).toBe(true);
  });

  it('deletes nothing without the channel', async () => {
    persistenceStore.set({ channel: null });
    storage.drafts.set('a', manifest('a'));
    expect(await forgetDraft(new SessionStore(), 'a')).toBeNull();
    expect(storage.drafts.has('a')).toBe(true);
  });

  it.each([
    ['an unreadable manifest', { drafts: [manifest('a')], unreadable: ['damaged.json'] }],
    ['an enumeration that failed', { drafts: [], unreadable: [], enumerationFailed: true }],
  ])('deletes nothing for %s', async (_name, inventory) => {
    storage.inventory = inventory;
    storage.drafts.set('a', manifest('a'));
    storage.sources.set('src-a', new Uint8Array([1]));
    expect(await forgetDraft(new SessionStore(), 'a')).toBeNull();
    expect(storage.drafts.has('a')).toBe(true);
    expect(storage.sources.has('src-a')).toBe(true);
  });
});

function snapshotKey(key: string): DraftSnapshot {
  return { key, id: key, pageCount: 1, inputBytes: 3, labelKey: 'shell.open' };
}

describe('failureNotice', () => {
  it('words a tool error as itself and anything else as a failed write', () => {
    const own = new ToolError('corrupt-document', { engine: 'model' });
    expect(failureNotice(own, t)).toBe(`${t(own.messageKey)} ${t(own.hintKey)}`);
    const failed = new ToolError('write-failed', { engine: 'model' });
    expect(failureNotice(new Error('quota'), t)).toBe(`${t(failed.messageKey)} ${t(failed.hintKey)}`);
  });
});

describe('purgeActiveDocument', () => {
  it('does nothing with no document open', async () => {
    await purgeActiveDocument(new SessionStore(), t);
    expect(notice()).toBeNull();
    expect(handles.deleteRecentHandle).not.toHaveBeenCalled();
  });

  it('says there is no channel when the other windows cannot be reached', async () => {
    persistenceStore.set({ channel: null });
    const session = new SessionStore();
    openTab(session);
    await purgeActiveDocument(session, t);
    expect(notice()).toBe(t('vault.sweepNoChannel'));
    expect(handles.deleteRecentHandle).not.toHaveBeenCalled();
  });

  it('forgets the file handle and the stored copies and reports how many blobs left', async () => {
    const session = new SessionStore();
    const tab = openTab(session, 'one');
    storage.drafts.set(tab.id, manifest(tab.id, { sourceKey: 'src-one' }));
    storage.sources.set('src-one', new Uint8Array([1]));
    session.setSensitive(tab.id, true);
    session.closeTab(tab.id);
    const other = openTab(session, 'two', 'b.pdf');
    storage.drafts.set(other.id, manifest(other.id, { sourceKey: 'src-two' }));
    storage.sources.set('src-two', new Uint8Array([2]));
    storage.sources.set('snapshot-1', new Uint8Array([3]));
    persistedKeysRecorded(other.id, ['snapshot-1']);

    await purgeActiveDocument(session, t);
    expect(handles.deleteRecentHandle).toHaveBeenCalledWith(other.id);
    expect(storage.drafts.has(other.id)).toBe(false);
    expect(storage.sources.has('src-one')).toBe(true);
    expect(notice()).toBe(t('vault.purged', { count: 1 }));
  });

  it('says the cleanup was incomplete when the inventory could not be read', async () => {
    storage.failInventory = true;
    const session = new SessionStore();
    openTab(session);
    await purgeActiveDocument(session, t);
    expect(notice()).toBe(t('vault.incomplete'));
  });

  it('words a failure on the notice line', async () => {
    handles.deleteRecentHandle.mockRejectedValue(new Error('locked'));
    const session = new SessionStore();
    openTab(session);
    await purgeActiveDocument(session, t);
    expect(notice()).toBe(failureNotice(new Error('locked'), t));
  });
});

describe('sweepVault', () => {
  it.each([
    ['no channel', null],
    ['peers that cannot be reached', fakeChannel({ canReachPeers: () => false })],
  ])('refuses with %s', async (_name, channel) => {
    persistenceStore.set({ channel });
    storage.sources.set('orphan', new Uint8Array([1]));
    await sweepVault(new SessionStore(), t);
    expect(notice()).toBe(t('vault.sweepNoChannel'));
    expect(storage.sources.has('orphan')).toBe(true);
  });

  it('refuses when a live window never answered', async () => {
    persistenceStore.set({ channel: fakeChannel({ probe: async () => false }) });
    storage.sources.set('orphan', new Uint8Array([1]));
    await sweepVault(new SessionStore(), t);
    expect(notice()).toBe(t('vault.peerSilent'));
    expect(storage.sources.has('orphan')).toBe(true);
  });

  it('deletes the blobs nothing references and says how many', async () => {
    const session = new SessionStore();
    openTab(session, 'open');
    storage.drafts.set('draft', manifest('draft', { sourceKey: 'src-draft' }));
    for (const key of ['src-open', 'src-draft', 'src-peer', 'orphan-1', 'orphan-2']) {
      storage.sources.set(key, new Uint8Array([1]));
    }
    persistenceStore.set({ channel: fakeChannel({ peerReferences: () => ['src-peer'] }) });
    await sweepVault(session, t);
    expect([...storage.sources.keys()].sort()).toEqual(['src-draft', 'src-open', 'src-peer']);
    expect(notice()).toBe(t('vault.swept', { count: 2 }));
  });

  it('says there was nothing to sweep', async () => {
    await sweepVault(new SessionStore(), t);
    expect(notice()).toBe(t('vault.sweepNothing'));
  });

  it('sweeps nothing when the storage cannot list its sources', async () => {
    delete storage.listSources;
    await sweepVault(new SessionStore(), t);
    expect(notice()).toBe(t('vault.sweepNothing'));
  });

  it('refuses an inventory that could not be read completely', async () => {
    storage.sources.set('orphan', new Uint8Array([1]));
    storage.failInventory = true;
    await sweepVault(new SessionStore(), t);
    expect(notice()).toBe(t('vault.incomplete'));
    expect(storage.sources.has('orphan')).toBe(true);
  });

  it('words a failure on the notice line', async () => {
    persistenceStore.set({
      channel: fakeChannel({
        runExclusive: async () => {
          throw new Error('lock refused');
        },
      }),
    });
    await sweepVault(new SessionStore(), t);
    expect(notice()).toBe(failureNotice(new Error('lock refused'), t));
  });
});

describe('announceOpenKeys', () => {
  it('tells the other windows the source and snapshot keys of every open document', () => {
    const announce = vi.fn();
    persistenceStore.set({ channel: fakeChannel({ announce }) });
    const session = new SessionStore();
    const tab = openTab(session, 'one');
    persistedKeysRecorded(tab.id, ['snapshot-1']);
    announceOpenKeys(session);
    expect(announce).toHaveBeenCalledWith(['src-one', 'snapshot-1']);
  });

  it('announces nothing without a channel', () => {
    persistenceStore.set({ channel: null });
    expect(() => announceOpenKeys(new SessionStore())).not.toThrow();
  });
});
