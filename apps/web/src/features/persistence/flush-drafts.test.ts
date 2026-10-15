import type { SessionStore } from 'pdf-model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultChannel } from '../../vault-channel';
import { flushDrafts } from './flush-drafts';
import { resetPersistence, vaultChannelOpened } from './persistence-store';

const persisted = vi.hoisted(() => ({ calls: [] as string[], fail: false }));
vi.mock('./draft-persist', () => ({
  persistDraft: async (_session: unknown, tabId: string) => {
    persisted.calls.push(tabId);
    if (persisted.fail && tabId === 'b') throw new Error('storage full');
    return 'written';
  },
}));

/** Only `getSnapshot().tabs[].id` is read; the real store is the model's and has its own tests. */
const session = {
  getSnapshot: () => ({ tabs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
} as unknown as SessionStore;

beforeEach(() => {
  resetPersistence();
  persisted.calls = [];
  persisted.fail = false;
});

describe('flushDrafts', () => {
  it('writes the draft of every open tab, in order, before it resolves', async () => {
    await flushDrafts(session, 'desktop');
    expect(persisted.calls).toEqual(['a', 'b', 'c']);
  });

  it('resolves when the storage refuses a draft: the earlier draft stands and the screen still offers the reload', async () => {
    persisted.fail = true;
    await expect(flushDrafts(session, 'desktop')).resolves.toBeUndefined();
    expect(persisted.calls).toEqual(['a', 'b']);
  });

  it('writes inside the vault lock, as the autosave does, so a sweep in another window cannot interleave', async () => {
    const events: string[] = [];
    const channel = {
      runExclusive: async <T>(work: () => Promise<T>): Promise<T> => {
        events.push('lock');
        try {
          return await work();
        } finally {
          events.push('unlock');
        }
      },
    } as unknown as VaultChannel;
    vaultChannelOpened(channel);
    await flushDrafts(session, 'desktop');
    expect(events).toEqual(['lock', 'unlock']);
    expect(persisted.calls).toEqual(['a', 'b', 'c']);
  });
});
