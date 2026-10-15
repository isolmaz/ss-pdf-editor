import type { SessionStore } from 'pdf-model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushDrafts } from './flush-drafts';

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
});
