/**
 * What the vault's writers share: the origin's draft storage, the channel that coordinates the
 * other windows, the keys this window has written for each tab, and the queue every vault write
 * goes through.
 *
 * Nothing here is rendered, so nothing subscribes: the handlers read it with
 * `persistenceStore.get()` at the moment they run. The keys and the queue are plain module state
 * beside the store, like the engine handles (`core/handles.ts`): a queue tail is a promise with
 * an identity, and the keys change on every write without anything on screen depending on them.
 */

import type { DraftStorage } from 'pdf-model';
import { createOpfsDraftStorage } from '../../drafts';
import type { VaultChannel } from '../../vault-channel';
import { createStore } from '../store';

export interface PersistenceState {
  /** Where drafts and the source/snapshot blobs live. */
  readonly draftStorage: DraftStorage;
  /**
   * The cross-window channel, or `null` before it opens and after it closes. A vault operation
   * that needs the other windows refuses without one.
   */
  readonly channel: VaultChannel | null;
}

export function initialPersistenceState(): PersistenceState {
  return { draftStorage: createOpfsDraftStorage(), channel: null };
}

export const persistenceStore = createStore<PersistenceState>(initialPersistenceState());

/** The storage every writer and reader of the vault uses. */
export function draftStorage(): DraftStorage {
  return persistenceStore.get().draftStorage;
}

/** The effect that owns `channel` opened it: the vault operations may use it. */
export function vaultChannelOpened(channel: VaultChannel): void {
  persistenceStore.set({ channel });
}

/** The owner of `channel` is closing it. A newer channel already in place is left alone. */
export function vaultChannelClosed(channel: VaultChannel): void {
  if (persistenceStore.get().channel === channel) persistenceStore.set({ channel: null });
}

/** The snapshot keys written for each tab: what its manifest references besides the source. */
const persistedKeys = new Map<string, readonly string[]>();

/** The snapshot keys last written for `tabId` (none before its first write). */
export function persistedKeysFor(tabId: string): readonly string[] {
  return persistedKeys.get(tabId) ?? [];
}

/** `tabId`'s manifest now references exactly `keys`. */
export function persistedKeysRecorded(tabId: string, keys: readonly string[]): void {
  persistedKeys.set(tabId, keys);
}

/** `tabId`'s copies left the vault. */
export function persistedKeysForgotten(tabId: string): void {
  persistedKeys.delete(tabId);
}

/**
 * The tail of the vault's write queue. Each write chains onto it so they run one at a time, and
 * the tail swallows a failure so the next write still runs; the caller of `queueDraftWrite`
 * is the one who sees the error.
 */
export const draftWrites: { current: Promise<unknown> } = { current: Promise.resolve() };

/** Run `work` after every write queued before it settles. */
export function queueDraftWrite<T>(work: () => Promise<T>): Promise<T> {
  const queued = draftWrites.current.then(work);
  draftWrites.current = queued.catch(() => undefined);
  return queued;
}

/** Back to a clean slate, for tests. */
export function resetPersistence(): void {
  persistenceStore.set(initialPersistenceState());
  persistedKeys.clear();
  draftWrites.current = Promise.resolve();
}
