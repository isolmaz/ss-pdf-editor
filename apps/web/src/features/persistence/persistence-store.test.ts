/**
 * The vault's shared state: the channel is owned by whoever opened it, the keys written per tab
 * are remembered and forgotten, the tab states a draft protects are told from the ones it does not,
 * and queued writes run one at a time, each failing alone.
 */

import { SessionStore } from 'pdf-model';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  draftStorage,
  draftWrites,
  draftWritten,
  holdsUnprotectedWork,
  persistedKeysFor,
  persistedKeysForgotten,
  persistedKeysRecorded,
  persistenceStore,
  queueDraftWrite,
  resetPersistence,
  vaultChannelClosed,
  vaultChannelOpened,
} from './persistence-store';
import { fakeChannel, memoryStorage, openTab } from './vault.fixtures';

beforeEach(resetPersistence);

describe('the storage', () => {
  it('is the one the store holds', () => {
    const storage = memoryStorage();
    persistenceStore.set({ draftStorage: storage });
    expect(draftStorage()).toBe(storage);
  });
});

describe('the channel', () => {
  it('starts closed, is available once opened and goes away when its owner closes it', () => {
    expect(persistenceStore.get().channel).toBeNull();
    const channel = fakeChannel();
    vaultChannelOpened(channel);
    expect(persistenceStore.get().channel).toBe(channel);
    vaultChannelClosed(channel);
    expect(persistenceStore.get().channel).toBeNull();
  });

  it('is left alone when a newer channel replaced the one being closed', () => {
    const first = fakeChannel();
    const second = fakeChannel();
    vaultChannelOpened(first);
    vaultChannelOpened(second);
    vaultChannelClosed(first);
    expect(persistenceStore.get().channel).toBe(second);
  });
});

describe('the keys written per tab', () => {
  it('are empty before a first write, remembered after it and gone when the tab is forgotten', () => {
    expect(persistedKeysFor('tab')).toEqual([]);
    persistedKeysRecorded('tab', ['snapshot-1']);
    expect(persistedKeysFor('tab')).toEqual(['snapshot-1']);
    persistedKeysForgotten('tab');
    expect(persistedKeysFor('tab')).toEqual([]);
  });
});

describe('the work a draft protects', () => {
  /** The tab object `session` holds for `id` now: a tab changes by being replaced. */
  function current(session: SessionStore, id: string) {
    const tab = session.getSnapshot().tabs.find((item) => item.id === id);
    if (tab === undefined) throw new Error('no such tab');
    return tab;
  }

  it('is nothing while no document has unsaved changes', () => {
    expect(holdsUnprotectedWork(new SessionStore().getSnapshot())).toBe(false);
    const session = new SessionStore();
    openTab(session);
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(false);
  });

  it('is the changes no draft holds: none written yet, or a write that never came', () => {
    const session = new SessionStore();
    const tab = openTab(session);
    session.setDirty(tab.id, true);
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(true);
  });

  it('is nothing once a draft of exactly that state is written, and is back as soon as the tab changes', () => {
    const session = new SessionStore();
    const first = openTab(session, 'one');
    const second = openTab(session, 'two');
    session.setDirty(first.id, true);
    draftWritten(current(session, first.id));
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(false);

    // Looking at another tab leaves the written state as it was: still protected.
    session.setActive(first.id);
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(false);

    // Another edit is a state the draft does not have.
    session.setOverlays(first.id, { marks: 1 }, 'ann.engineEdit');
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(true);
    draftWritten(current(session, first.id));
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(false);

    // A draft covers the document it was written for and no other.
    session.setDirty(second.id, true);
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(true);
  });

  it('is the changes of a sensitive session, whatever was written for the tab', () => {
    const session = new SessionStore();
    const tab = openTab(session);
    session.setDirty(tab.id, true);
    session.setSensitive(tab.id, true);
    draftWritten(current(session, tab.id));
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(true);
    session.setSensitive(tab.id, false);
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(true);
    draftWritten(current(session, tab.id));
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(false);
  });

  it('forgets what was written on a reset', () => {
    const session = new SessionStore();
    const tab = openTab(session);
    session.setDirty(tab.id, true);
    draftWritten(current(session, tab.id));
    resetPersistence();
    expect(holdsUnprotectedWork(session.getSnapshot())).toBe(true);
  });
});

describe('the write queue', () => {
  it('runs writes one after another and hands each caller its own result', async () => {
    const order: string[] = [];
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const first = queueDraftWrite(async () => {
      order.push('first starts');
      await gate;
      order.push('first ends');
      return 1;
    });
    const second = queueDraftWrite(async () => {
      order.push('second');
      return 2;
    });
    await Promise.resolve();
    expect(order).toEqual(['first starts']);
    release();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(order).toEqual(['first starts', 'first ends', 'second']);
  });

  it('reports a failure to its caller only, and the next write still runs', async () => {
    const failed = queueDraftWrite(async () => {
      throw new Error('quota');
    });
    await expect(failed).rejects.toThrow('quota');
    await expect(draftWrites.current).resolves.toBeUndefined();
    await expect(queueDraftWrite(async () => 'next')).resolves.toBe('next');
  });

  it('is empty again after a reset', async () => {
    draftWrites.current = new Promise(() => undefined);
    resetPersistence();
    await expect(queueDraftWrite(async () => 'ran')).resolves.toBe('ran');
  });
});
