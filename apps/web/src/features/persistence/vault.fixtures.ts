/** In-memory stand-ins for the vault's boundaries, shared by the persistence tests. */

import { type Draft, type DraftInventory, type DraftStorage, draftFor, type SessionStore } from 'pdf-model';
import { vi } from 'vitest';
import type { VaultChannel } from '../../vault-channel';

export interface MemoryStorage extends DraftStorage {
  readonly drafts: Map<string, Draft>;
  readonly sources: Map<string, Uint8Array>;
  /** The inventory `readDraftInventory` answers; `undefined` leaves it to the stored drafts. */
  inventory?: DraftInventory;
  /** Make the next reads of the inventory throw. */
  failInventory: boolean;
}

/** A map-backed storage that answers like the real one: the inventory is every stored draft. */
export function memoryStorage(): MemoryStorage {
  const drafts = new Map<string, Draft>();
  const sources = new Map<string, Uint8Array>();
  const storage: MemoryStorage = {
    drafts,
    sources,
    failInventory: false,
    writeDraft: async (draft) => {
      drafts.set(draft.id, draft);
    },
    readDrafts: async () => [...drafts.values()],
    readDraftInventory: async () => {
      if (storage.failInventory) throw new Error('unreadable');
      return storage.inventory ?? { drafts: [...drafts.values()], unreadable: [] };
    },
    deleteDraft: async (id) => {
      drafts.delete(id);
    },
    putSource: async (key, bytes) => {
      sources.set(key, bytes);
    },
    getSource: async (key) => sources.get(key) ?? null,
    hasSource: async (key) => sources.has(key),
    deleteSource: async (key) => {
      sources.delete(key);
    },
    listSources: async () => [...sources.keys()],
  };
  return storage;
}

/** A channel with no peers: reachable, answers every probe, runs work at once. */
export function fakeChannel(over: Partial<VaultChannel> = {}): VaultChannel {
  return {
    announce: vi.fn(),
    probe: async () => true,
    peerReferences: () => [],
    runExclusive: (work) => work(),
    canReachPeers: () => true,
    close: vi.fn(),
    ...over,
  };
}

/** A restorable manifest for the document `id`. */
export function manifest(id: string, over: Partial<Draft> = {}): Draft {
  return {
    ...draftFor({
      id,
      name: `${id}.pdf`,
      pageCount: 1,
      size: 3,
      dirty: true,
      sourceKey: `src-${id}`,
      journal: [],
      now: 1,
    }),
    ...over,
  };
}

/** Open a one-page document in `store`. */
export function openTab(store: SessionStore, sha256 = 'a', name = 'a.pdf') {
  return store.openDocument({ name, bytes: new Uint8Array([1, 2, 3]), sha256, pageCount: 1 });
}
