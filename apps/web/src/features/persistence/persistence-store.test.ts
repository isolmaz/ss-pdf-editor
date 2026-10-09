/**
 * The vault's shared state: the channel is owned by whoever opened it, the keys written per tab
 * are remembered and forgotten, and queued writes run one at a time, each failing alone.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  draftStorage,
  draftWrites,
  persistedKeysFor,
  persistedKeysForgotten,
  persistedKeysRecorded,
  persistenceStore,
  queueDraftWrite,
  resetPersistence,
  vaultChannelClosed,
  vaultChannelOpened,
} from './persistence-store';
import { fakeChannel, memoryStorage } from './vault.fixtures';

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
