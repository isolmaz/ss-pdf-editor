// @vitest-environment happy-dom
/**
 * Two windows on one vault: the window that has a tab open owns its draft, so the other neither
 * restores nor writes it; a draft write holds the vault lock for its blobs and its manifest; a
 * tab closed before its first save leaves no source blob behind; and one restore path serves
 * startup recovery and the recent list.
 */

import { type Draft, SessionStore } from 'pdf-model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreStore, initialCoreState } from '../core/core-store';
import { adoptHandle, dropHandle } from '../core/handles';
import { persistDraft } from './draft-persist';
import { claimWithPatience, type RestoreHost, restoreDraft } from './draft-restore';
import { forgetDraft, syncDraftClaims } from './draft-vault';
import {
  disownDraft,
  ownsDraft,
  persistenceStore,
  queueVaultWrite,
  resetPersistence,
  sourceStored,
  storedSourceKeyFor,
} from './persistence-store';
import { fakeChannel, type MemoryStorage, manifest, memoryStorage, openTab } from './vault.fixtures';

const outside = vi.hoisted(() => ({
  openWithPdfjs: vi.fn(),
  getRecentHandle: vi.fn(),
  addRecentDocument: vi.fn(),
}));
vi.mock('pdf-core/engines/pdfjs-handle', () => ({ openWithPdfjs: outside.openWithPdfjs }));
vi.mock('../../recent-handles', () => ({
  getRecentHandle: outside.getRecentHandle,
  deleteRecentHandle: vi.fn(async () => undefined),
}));
vi.mock('../../recent', () => ({ addRecentDocument: outside.addRecentDocument }));

let storage: MemoryStorage;

function openRendered(session: SessionStore, sha256 = 'one') {
  const tab = openTab(session, sha256);
  adoptHandle(tab.id, { raw: { annotationStorage: { serializable: { map: new Map() } } } } as never);
  return tab;
}

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

beforeEach(() => {
  coreStore.set(initialCoreState());
  resetPersistence();
  vi.clearAllMocks();
  outside.getRecentHandle.mockResolvedValue(null);
  outside.openWithPdfjs.mockImplementation(async () => ({ destroy: vi.fn(async () => undefined) }));
  storage = memoryStorage();
  persistenceStore.set({ draftStorage: storage, channel: fakeChannel() });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('what this window writes', () => {
  it('leaves a draft another window owns alone', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    persistenceStore.set({ channel: fakeChannel({ claimDraft: async () => false }) });
    expect(await persistDraft(session, tab.id, 'desktop')).toBe('skipped');
    expect(storage.drafts.size).toBe(0);
    expect(storage.sources.size).toBe(0);
    dropHandle(tab.id);
  });

  it('describes the snapshots it retained when it began, not the ones an edit added while it wrote', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    apply(session, tab.id, 1);
    const first = session.snapshotsFor(tab.id).map((snapshot) => snapshot.id);
    const putSource = storage.putSource;
    storage.putSource = async (key, bytes) => {
      await putSource(key, bytes);
      if (key === 'src-one') apply(session, tab.id, 2);
    };
    expect(await persistDraft(session, tab.id, 'desktop')).toBe('written');
    expect(storage.drafts.get(tab.id)?.snapshots?.map((snapshot) => snapshot.id)).toEqual(first);
    dropHandle(tab.id);
  });

  it('records the hash of the last in-place write in the manifest', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    const sha256 = 'c'.repeat(64);
    session.addOutput(tab.id, {
      id: 'out',
      fromWorkingVersion: tab.working.id,
      fromState: tab.working.stateId,
      encrypted: false,
      steps: [],
      appliedSteps: [],
      incremental: false,
      writtenTo: { fileName: 'a.pdf', savedAt: 1, sha256 },
    });
    await persistDraft(session, tab.id, 'desktop');
    expect(storage.drafts.get(tab.id)?.lastWrittenSha256).toBe(sha256);
    dropHandle(tab.id);
  });

  it('writes its blobs and its manifest inside the vault lock, and the queue inside that', async () => {
    const session = new SessionStore();
    const tab = openRendered(session);
    const events: string[] = [];
    persistenceStore.set({
      channel: fakeChannel({
        runExclusive: async (work) => {
          events.push('lock');
          const result = await work();
          events.push('unlock');
          return result;
        },
      }),
    });
    const writeDraft = storage.writeDraft;
    storage.writeDraft = async (draft) => {
      events.push('manifest');
      await writeDraft(draft);
    };
    await queueVaultWrite(() => persistDraft(session, tab.id, 'desktop'));
    expect(events).toEqual(['lock', 'manifest', 'unlock']);
    dropHandle(tab.id);
  });
});

describe('the write queue and the lock', () => {
  it('queueVaultWrite is the plain queue without a channel', async () => {
    persistenceStore.set({ channel: null });
    expect(await queueVaultWrite(async () => 'queued')).toBe('queued');
  });

  it('ownsDraft asks the channel, and a window with none owns what it writes', async () => {
    expect(await ownsDraft('a')).toBe(true);
    persistenceStore.set({ channel: fakeChannel({ claimDraft: async (id) => id === 'mine' }) });
    expect(await ownsDraft('mine')).toBe(true);
    expect(await ownsDraft('theirs')).toBe(false);
    persistenceStore.set({ channel: null });
    expect(await ownsDraft('theirs')).toBe(true);
    expect(() => disownDraft('theirs')).not.toThrow();
  });

  it('keeps every open tab claimed and releases a closed one after the writes queued for it', async () => {
    const session = new SessionStore();
    const claimed: string[] = [];
    const released: string[] = [];
    persistenceStore.set({
      channel: fakeChannel({
        claimDraft: async (id) => {
          claimed.push(id);
          return true;
        },
        releaseDraft: (id) => released.push(id),
      }),
    });
    const one = openTab(session, 'one');
    const two = openTab(session, 'two');
    const open = syncDraftClaims(session, new Set());
    expect([...open].sort()).toEqual([one.id, two.id].sort());
    expect(claimed.sort()).toEqual([one.id, two.id].sort());
    expect(released).toEqual([]);
    session.closeTab(one.id);
    const after = syncDraftClaims(session, open);
    expect([...after]).toEqual([two.id]);
    expect(released).toEqual([]);
    await persistenceStore.get().draftStorage.hasSource('x');
    await vi.waitFor(() => expect(released).toEqual([one.id]));
    persistenceStore.set({ channel: null });
    expect([...syncDraftClaims(session, after)]).toEqual([two.id]);
  });
});

describe('a tab closed before its first save', () => {
  it('takes the source blob it stored with it, unless something else still references it', async () => {
    const session = new SessionStore();
    const gone = openTab(session, 'one');
    storage.sources.set('src-one', new Uint8Array([1]));
    sourceStored(gone.id, 'src-one');
    expect(storedSourceKeyFor(gone.id)).toBe('src-one');
    const kept = openTab(session, 'one');
    expect(await forgetDraft(session, gone.id)).toEqual([]);
    expect(storage.sources.has('src-one')).toBe(true);
    session.closeTab(kept.id);
    sourceStored(gone.id, 'src-one');
    expect(await forgetDraft(session, gone.id)).toEqual(['src-one']);
    expect(storage.sources.size).toBe(0);
    expect(storedSourceKeyFor(gone.id)).toBeUndefined();
  });

  it('counts the source once when its manifest names it too', async () => {
    const session = new SessionStore();
    storage.drafts.set('t', manifest('t'));
    storage.sources.set('src-t', new Uint8Array([1]));
    sourceStored('t', 'src-t');
    expect(await forgetDraft(session, 't')).toEqual(['src-t']);
  });
});

describe('restoreDraft', () => {
  const host = (store: SessionStore): RestoreHost => ({
    store,
    openAndFingerprint: async (opening, fingerprinting) => [await opening, await fingerprinting],
  });
  const stored = (draft: Draft) => {
    storage.drafts.set(draft.id, draft);
    storage.sources.set(draft.sourceKey, new Uint8Array([1, 2, 3]));
  };

  it('restores with the source page count and the hash of the last write, and fronts it on request', async () => {
    const store = new SessionStore();
    const other = openTab(store, 'other');
    const sha256 = 'd'.repeat(64);
    const draft = manifest('doc', {
      pageCount: 2,
      sourcePageCount: 5,
      lastWrittenSha256: sha256,
      dirty: true,
    });
    stored(draft);
    const outcome = await restoreDraft(host(store), draft, { activate: false });
    expect(outcome.kind).toBe('restored');
    const tab = store.getSnapshot().tabs.find((item) => item.id === 'doc');
    expect(tab?.source.pageCount).toBe(5);
    expect(tab?.lastWrittenSha256).toBe(sha256);
    expect(tab?.dirty).toBe(true);
    expect(store.active?.id).toBe(other.id);
    expect(storedSourceKeyFor('doc')).toBe('src-doc');
    store.closeTab('doc');
    const again = await restoreDraft(host(store), manifest('doc'), { activate: true });
    expect(again.kind).toBe('restored');
    expect(store.active?.id).toBe('doc');
  });

  it('leaves a draft another window owns, and one already open here', async () => {
    const store = new SessionStore();
    stored(manifest('doc'));
    persistenceStore.set({ channel: fakeChannel({ claimDraft: async () => false }) });
    expect((await restoreDraft(host(store), manifest('doc'), { activate: true })).kind).toBe('elsewhere');
    expect(store.getSnapshot().tabs).toHaveLength(0);
    persistenceStore.set({ channel: fakeChannel() });
    store.openDocument({ id: 'doc', name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 1 });
    expect((await restoreDraft(host(store), manifest('doc'), { activate: true })).kind).toBe('open');
  });

  it('throws for a draft whose source cannot be read, and gives its claim back', async () => {
    const store = new SessionStore();
    const released: string[] = [];
    persistenceStore.set({ channel: fakeChannel({ releaseDraft: (id) => released.push(id) }) });
    await expect(restoreDraft(host(store), manifest('missing'), { activate: true })).rejects.toMatchObject({
      code: 'corrupt-document',
    });
    storage.getSource = async () => {
      throw new Error('NotReadableError');
    };
    await expect(restoreDraft(host(store), manifest('locked'), { activate: true })).rejects.toThrow(
      'NotReadableError',
    );
    expect(released).toEqual(['missing', 'locked']);
  });

  it('destroys the engine handle when no tab came of it, and when the caller went away', async () => {
    const store = new SessionStore();
    const destroy = vi.fn(async () => undefined);
    outside.openWithPdfjs.mockImplementation(async () => ({ destroy }));
    stored(manifest('doc'));
    outside.getRecentHandle.mockRejectedValueOnce(new Error('idb'));
    await expect(restoreDraft(host(store), manifest('doc'), { activate: true })).rejects.toThrow('idb');
    expect(destroy).toHaveBeenCalledTimes(1);
    const released: string[] = [];
    persistenceStore.set({ channel: fakeChannel({ releaseDraft: (id) => released.push(id) }) });
    const outcome = await restoreDraft(host(store), manifest('doc'), {
      activate: true,
      cancelled: () => true,
    });
    expect(outcome.kind).toBe('cancelled');
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(released).toEqual(['doc']);
    expect(store.getSnapshot().tabs).toHaveLength(0);
  });

  it('reports the failure that kept the tab out, not the engine handle that would not shut down', async () => {
    const store = new SessionStore();
    const destroy = vi.fn(async () => {
      throw new Error('worker stuck');
    });
    outside.openWithPdfjs.mockImplementation(async () => ({ destroy }));
    stored(manifest('doc'));
    outside.getRecentHandle.mockRejectedValueOnce(new Error('idb'));
    await expect(restoreDraft(host(store), manifest('doc'), { activate: true })).rejects.toThrow('idb');
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('keeps its claim on a tab that was opened meanwhile, even when the caller went away', async () => {
    const store = new SessionStore();
    const released: string[] = [];
    persistenceStore.set({ channel: fakeChannel({ releaseDraft: (id) => released.push(id) }) });
    stored(manifest('doc'));
    outside.getRecentHandle.mockImplementation(async () => {
      store.openDocument({ id: 'doc', name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 1 });
      return null;
    });
    const outcome = await restoreDraft(host(store), manifest('doc'), {
      activate: true,
      cancelled: () => true,
    });
    expect(outcome.kind).toBe('cancelled');
    expect(released).toEqual([]);
    expect(store.getSnapshot().tabs).toHaveLength(1);
  });

  it('keeps its claim when the failure comes after the tab went in', async () => {
    const store = new SessionStore();
    const released: string[] = [];
    persistenceStore.set({ channel: fakeChannel({ releaseDraft: (id) => released.push(id) }) });
    stored(manifest('doc'));
    outside.addRecentDocument.mockImplementation(() => {
      throw new Error('recent list');
    });
    await expect(restoreDraft(host(store), manifest('doc'), { activate: true })).rejects.toThrow(
      'recent list',
    );
    expect(store.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['doc']);
    expect(released).toEqual([]);
    dropHandle('doc');
  });

  it('keeps the tab that was opened while it read, and destroys its own handle', async () => {
    const store = new SessionStore();
    const destroy = vi.fn(async () => undefined);
    outside.openWithPdfjs.mockImplementation(async () => ({ destroy }));
    stored(manifest('doc'));
    outside.getRecentHandle.mockImplementation(async () => {
      store.openDocument({ id: 'doc', name: 'a.pdf', bytes: new Uint8Array([1]), sha256: 'a', pageCount: 1 });
      return null;
    });
    expect((await restoreDraft(host(store), manifest('doc'), { activate: true })).kind).toBe('open');
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('claimWithPatience', () => {
  it('asks again for a window that is still closing, and gives up on one that never lets go', async () => {
    vi.useFakeTimers();
    let answers = [false, false, true];
    persistenceStore.set({ channel: fakeChannel({ claimDraft: async () => answers.shift() ?? false }) });
    const closing = claimWithPatience('doc');
    await vi.advanceTimersByTimeAsync(500);
    expect(await closing).toBe(true);
    answers = [];
    const live = claimWithPatience('doc');
    await vi.advanceTimersByTimeAsync(1_250);
    expect(await live).toBe(false);
  });
});
