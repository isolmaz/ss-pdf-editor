import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVaultChannel, type VaultChannel } from './vault-channel';

/** Waits for BroadcastChannel deliveries to land: they cross a real message port, so no fake clock can advance them. */
const settle = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const opened: VaultChannel[] = [];
const channel = () => {
  const created = createVaultChannel();
  opened.push(created);
  return created;
};

afterEach(() => {
  for (const created of opened.splice(0)) created.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const WINDOW_LOCK = 'pdf-editor.vault.window.';

/**
 * A lock manager that records what is held, like `navigator.locks` seen from every window of
 * one origin (Node has none). `delayGrant` makes a request wait a turn before it is
 * granted, as a real manager does when another holder is ahead. `options` is read on each
 * call, so a test can make the manager fail part-way through.
 */
function fakeLocks(options: { delayGrant?: boolean; failQuery?: boolean } = {}) {
  const held = new Map<symbol, string>();
  return {
    held,
    names: () => [...held.values()],
    request: async (name: string, first: unknown, second?: unknown) => {
      const work = (typeof first === 'function' ? first : second) as () => unknown;
      if (options.delayGrant) await Promise.resolve();
      const key = Symbol(name);
      held.set(key, name);
      try {
        return await work();
      } finally {
        held.delete(key);
      }
    },
    query: async () => {
      if (options.failQuery) throw new Error('locks unavailable');
      return { held: [...held.values()].map((name) => ({ name })), pending: [] };
    },
  };
}

/** Lets already-settled promises and queued port deliveries run, without any clock. */
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Wire {
  readonly windowId?: string;
  readonly probe?: boolean;
  readonly probeId?: string;
}

/** A bare second window on the channel: it hears probes and answers only when the test says so. */
function bareWindow(peerId: string) {
  const port = new BroadcastChannel('pdf-editor.vault.v1');
  const probes: Wire[] = [];
  let heard: (() => void) | null = null;
  port.onmessage = (event: MessageEvent<Wire>) => {
    if (event.data.probe === true) {
      probes.push(event.data);
      heard?.();
    }
  };
  return {
    nextProbe: async (): Promise<Wire> => {
      if (probes.length === 0) {
        await new Promise<void>((resolve) => {
          heard = resolve;
        });
      }
      return probes[probes.length - 1] as Wire;
    },
    answer: (keys: string[], replyTo: string | undefined) =>
      port.postMessage({ windowId: peerId, keys, at: 1, probe: false, replyTo }),
    close: () => port.close(),
  };
}

/** A Map-backed `localStorage`, the platform seam the fallback uses. */
function memoryStorage(failWrites = false) {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error('quota');
      store.set(key, value);
    },
  };
}

describe('vault channel over BroadcastChannel', () => {
  it('a window learns the keys another window announced, and not its own', async () => {
    const first = channel();
    const second = channel();
    first.announce(['src-a', 'snapshot-1']);
    second.announce(['src-b']);
    await settle();
    expect([...first.peerReferences()].sort()).toEqual(['src-b']);
    expect([...second.peerReferences()].sort()).toEqual(['snapshot-1', 'src-a']);
  });

  it('the latest announcement of a window replaces its earlier one', async () => {
    const first = channel();
    const second = channel();
    first.announce(['src-a']);
    await settle();
    first.announce(['src-c']);
    await settle();
    expect(second.peerReferences()).toEqual(['src-c']);
  });

  it('keeps announced keys after the announcing window closes (references are only added)', async () => {
    const first = channel();
    const second = channel();
    first.announce(['src-a']);
    await settle();
    first.close();
    expect(second.peerReferences()).toEqual(['src-a']);
  });

  it('without a lock manager a probe makes peers answer with what they hold, and waits the whole window so every peer can answer', async () => {
    vi.stubGlobal('navigator', {});
    const asker = channel();
    const holder = channel();
    holder.announce(['src-held']);
    await settle();
    // Drop nothing: a second asker that never heard the announcement must learn it from the probe.
    const fresh = channel();
    const started = Date.now();
    await fresh.probe();
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(fresh.peerReferences()).toEqual(['src-held']);
    expect(asker.peerReferences()).toEqual(['src-held']);
  });

  it('without a lock manager a probe with no peer waits out its window and learns nothing', async () => {
    vi.stubGlobal('navigator', {});
    const alone = channel();
    const started = Date.now();
    await alone.probe();
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(alone.peerReferences()).toEqual([]);
  });

  it('ignores non-string keys inside an announcement and malformed messages', async () => {
    const listener = new BroadcastChannel('pdf-editor.vault.v1');
    const receiver = channel();
    listener.postMessage(null);
    listener.postMessage({ keys: ['no-window-id'] });
    listener.postMessage({ windowId: 'w-x', keys: ['src-ok', 7, null], at: 1, probe: false });
    listener.postMessage({ windowId: 'w-y' });
    await settle();
    expect(receiver.peerReferences()).toEqual(['src-ok']);
    listener.close();
  });

  it('runs work directly when the platform has no lock manager, and under the vault lock when it has', async () => {
    vi.stubGlobal('navigator', {});
    const lone = channel();
    expect(await lone.runExclusive(async () => 'direct')).toBe('direct');

    const requested: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async (name: string, work: () => Promise<unknown>) => {
          requested.push(name);
          return await work();
        },
      },
    });
    expect(await lone.runExclusive(async () => 'locked')).toBe('locked');
    expect(requested).toEqual(['pdf-editor.vault.v1']);
  });
});

describe('a probe waits for every window the lock manager lists, not for a timer', () => {
  it('holds a window lock while open and gives it up on close', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    const open = channel();
    await vi.waitFor(() =>
      expect(locks.names()).toEqual([expect.stringMatching(/^pdf-editor\.vault\.window\./)]),
    );
    open.close();
    await vi.waitFor(() => expect(locks.names()).toEqual([]));
  });

  it('names its lock after a generated id when the platform has no crypto.randomUUID', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    vi.stubGlobal('crypto', undefined);
    channel();
    await vi.waitFor(() =>
      expect(locks.names()).toEqual([expect.stringMatching(/^pdf-editor\.vault\.window\.w-[a-z0-9]+$/)]),
    );
  });

  it('never keeps the lock of a window that was closed before the lock was granted', async () => {
    const locks = fakeLocks({ delayGrant: true });
    vi.stubGlobal('navigator', { locks });
    const short = channel();
    short.close();
    await turn();
    await turn();
    expect(locks.names()).toEqual([]);
  });

  it('keeps waiting for a live window that answers long after the old 250 ms window, then learns its keys', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    locks.held.set(Symbol('slow'), `${WINDOW_LOCK}slow`);
    const slow = bareWindow('slow');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asker = channel();
    let outcome: boolean | undefined;
    const probing = asker.probe().then((value) => {
      outcome = value;
    });
    const probe = await slow.nextProbe();
    vi.advanceTimersByTime(5_000);
    await turn();
    expect(outcome).toBeUndefined();
    slow.answer(['src-slow'], probe.probeId);
    await probing;
    expect(outcome).toBe(true);
    expect(asker.peerReferences()).toEqual(['src-slow']);
    slow.close();
  });

  it('does not count an answer to some other probe as the live window answering', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    locks.held.set(Symbol('slow'), `${WINDOW_LOCK}slow`);
    const slow = bareWindow('slow');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asker = channel();
    let outcome: boolean | undefined;
    const probing = asker.probe().then((value) => {
      outcome = value;
    });
    const probe = await slow.nextProbe();
    slow.answer(['src-stale'], 'someone-else:7');
    await turn();
    await turn();
    expect(outcome).toBeUndefined();
    slow.answer(['src-slow'], probe.probeId);
    await probing;
    expect(outcome).toBe(true);
    expect(asker.peerReferences()).toEqual(['src-slow']);
    slow.close();
  });

  it('reports false when a listed window stays silent for the whole limit', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    locks.held.set(Symbol('ghost'), `${WINDOW_LOCK}ghost`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asker = channel();
    let outcome: boolean | undefined;
    const probing = asker.probe().then((value) => {
      outcome = value;
    });
    await turn();
    vi.advanceTimersByTime(9_999);
    await turn();
    expect(outcome).toBeUndefined();
    vi.advanceTimersByTime(1);
    await probing;
    expect(outcome).toBe(false);
  });

  it('stops waiting for a listed window once its lock is gone, and a failed re-query changes nothing', async () => {
    const options = { failQuery: false };
    const locks = fakeLocks(options);
    vi.stubGlobal('navigator', { locks });
    const ghost = Symbol('closing');
    locks.held.set(ghost, `${WINDOW_LOCK}closing`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asker = channel();
    let outcome: boolean | undefined;
    const probing = asker.probe().then((value) => {
      outcome = value;
    });
    await turn();
    // The lock manager cannot be asked: the window it listed stays awaited.
    options.failQuery = true;
    locks.held.delete(ghost);
    vi.advanceTimersByTime(250);
    await turn();
    await turn();
    expect(outcome).toBeUndefined();
    // It can again, and the closed window no longer holds a lock: the probe is complete.
    options.failQuery = false;
    vi.advanceTimersByTime(250);
    await probing;
    expect(outcome).toBe(true);
  });

  it('keeps waiting for a listed window whose lock is still held, and stops asking once it answers', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    locks.held.set(Symbol('slow'), `${WINDOW_LOCK}slow`);
    const slow = bareWindow('slow');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asker = channel();
    let outcome: boolean | undefined;
    const probing = asker.probe().then((value) => {
      outcome = value;
    });
    const probe = await slow.nextProbe();
    for (let round = 0; round < 4; round += 1) {
      vi.advanceTimersByTime(250);
      await turn();
      await turn();
    }
    expect(outcome).toBeUndefined();
    const queries = vi.spyOn(locks, 'query');
    slow.answer(['src-slow'], probe.probeId);
    await probing;
    expect(outcome).toBe(true);
    vi.advanceTimersByTime(1_000);
    await turn();
    expect(queries).not.toHaveBeenCalled();
    slow.close();
  });

  it('reports false when the probing window closes while a re-query is in flight, even if that query finds no window', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    const ghost = Symbol('closing');
    locks.held.set(ghost, `${WINDOW_LOCK}closing`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asker = channel();
    const probing = asker.probe();
    await turn();
    locks.held.delete(ghost);
    vi.advanceTimersByTime(250);
    asker.close();
    expect(await probing).toBe(false);
    await turn();
  });

  it('reports false when the probing window is closed while it waits', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    locks.held.set(Symbol('ghost'), `${WINDOW_LOCK}ghost`);
    const asker = channel();
    const probing = asker.probe();
    await turn();
    asker.close();
    expect(await probing).toBe(false);
  });

  it('finishes at once, without any timer, when no other window is alive (other held locks, such as the vault lock, are not windows)', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    locks.held.set(Symbol('vault'), 'pdf-editor.vault.v1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const alone = channel();
    expect(await alone.probe()).toBe(true);
    expect(alone.peerReferences()).toEqual([]);
  });

  it('finishes as soon as each live window has answered, learning what a window announced before this one existed', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    const holder = channel();
    holder.announce(['src-held']);
    const busy = channel();
    busy.announce(['src-busy']);
    await turn();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await vi.waitFor(() => expect(locks.names()).toHaveLength(2), { timeout: 2_000 });
    const fresh = channel();
    expect(await fresh.probe()).toBe(true);
    expect([...fresh.peerReferences()].sort()).toEqual(['src-busy', 'src-held']);
  });

  it('forgets a window that closed: its lock is gone, so the probe no longer waits for it', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    const gone = channel();
    gone.announce(['src-gone']);
    await vi.waitFor(() => expect(locks.names()).toHaveLength(1));
    gone.close();
    await vi.waitFor(() => expect(locks.names()).toEqual([]));
    const survivor = channel();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(await survivor.probe()).toBe(true);
  });

  it('treats a lock listing without held locks, or with an unnamed one, as no live window', async () => {
    const locks = fakeLocks();
    locks.query = async () => ({ held: undefined, pending: [] }) as never;
    vi.stubGlobal('navigator', { locks });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const empty = channel();
    expect(await empty.probe()).toBe(true);

    locks.query = async () => ({ held: [{}], pending: [] }) as never;
    expect(await empty.probe()).toBe(true);
  });

  it('keeps working when the platform refuses the window lock', async () => {
    const locks = fakeLocks();
    locks.request = async () => {
      throw new Error('lock refused');
    };
    vi.stubGlobal('navigator', { locks });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const refused = channel();
    await turn();
    expect(await refused.probe()).toBe(true);
    expect(refused.canReachPeers()).toBe(true);
  });

  it('answers a probe from a window that sent no probe id, with its own keys and no reply id', async () => {
    vi.stubGlobal('navigator', {});
    const port = new BroadcastChannel('pdf-editor.vault.v1');
    // An announcement carries no `replyTo` property at all; only an answer to a probe has one.
    const answered = new Promise<{ keys: string[]; replyTo: unknown }>((resolve) => {
      port.onmessage = (event) => {
        if ('replyTo' in event.data) resolve(event.data);
      };
    });
    const responder = channel();
    responder.announce(['src-mine']);
    port.postMessage({ windowId: 'old-window', keys: [], at: 1, probe: true });
    const reply = await answered;
    expect(reply.keys).toEqual(['src-mine']);
    expect(reply.replyTo).toBeUndefined();
    port.close();
  });

  it('falls back to the fixed window when the lock manager cannot list its holders', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks({ failQuery: true }) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const asker = channel();
    let outcome: boolean | undefined;
    const probing = asker.probe().then((value) => {
      outcome = value;
    });
    await turn();
    vi.advanceTimersByTime(249);
    await turn();
    expect(outcome).toBeUndefined();
    vi.advanceTimersByTime(1);
    await probing;
    expect(outcome).toBe(true);
  });
});

describe('vault channel without BroadcastChannel', () => {
  it('reports peers reachable over BroadcastChannel without touching storage', () => {
    expect(channel().canReachPeers()).toBe(true);
  });

  it('a probe against storage that holds nothing and cannot be written waits its window and learns nothing', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', memoryStorage(true));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reader = channel();
    let outcome: boolean | undefined;
    const probing = reader.probe().then((value) => {
      outcome = value;
    });
    vi.advanceTimersByTime(249);
    await turn();
    expect(outcome).toBeUndefined();
    vi.advanceTimersByTime(1);
    await probing;
    expect(outcome).toBe(true);
    expect(reader.peerReferences()).toEqual([]);
  });

  it('ignores storage entries without a key list and a stored null', async () => {
    const storage = memoryStorage();
    storage.store.set(
      'pdf_editor_vault_announce_v1',
      JSON.stringify({
        'w-bad': { windowId: 'w-bad', keys: 5, at: 1 },
        'w-ok': { windowId: 'w-ok', keys: ['src-ok'], at: 1 },
      }),
    );
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', storage);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reader = channel();
    const probing = reader.probe();
    vi.advanceTimersByTime(250);
    await probing;
    expect(reader.peerReferences()).toEqual(['src-ok']);

    // A stored `null` that cannot be overwritten (writes fail) is read as no peers, keeping what was learnt.
    const failing = memoryStorage(true);
    failing.store.set('pdf_editor_vault_announce_v1', 'null');
    vi.stubGlobal('localStorage', failing);
    const again = reader.probe();
    vi.advanceTimersByTime(250);
    await again;
    expect(reader.peerReferences()).toEqual(['src-ok']);
  });

  it('announces through localStorage and reports peers reachable when storage works', () => {
    const storage = memoryStorage();
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', storage);
    const only = channel();
    expect(only.canReachPeers()).toBe(true);
    only.announce(['src-1']);
    const written = JSON.parse(storage.store.get('pdf_editor_vault_announce_v1') ?? '{}') as Record<
      string,
      { keys: string[] }
    >;
    expect(Object.values(written).map((entry) => entry.keys)).toEqual([['src-1']]);
  });

  it('a probe reads the other windows from storage and a storage event does too', async () => {
    const storage = memoryStorage();
    storage.store.set(
      'pdf_editor_vault_announce_v1',
      JSON.stringify({ 'w-peer': { windowId: 'w-peer', keys: ['src-peer'], at: 1 }, junk: 5 }),
    );
    const handlers: ((event: { key: string }) => void)[] = [];
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('addEventListener', (type: string, handler: (event: { key: string }) => void) => {
      if (type === 'storage') handlers.push(handler);
    });
    const reader = channel();
    await reader.probe();
    expect(reader.peerReferences()).toEqual(['src-peer']);

    storage.store.set(
      'pdf_editor_vault_announce_v1',
      JSON.stringify({ 'w-late': { windowId: 'w-late', keys: ['src-late'], at: 2 } }),
    );
    handlers[0]?.({ key: 'other-key' });
    expect(reader.peerReferences()).toEqual(['src-peer']);
    handlers[0]?.({ key: 'pdf_editor_vault_announce_v1' });
    expect([...reader.peerReferences()].sort()).toEqual(['src-late', 'src-peer']);
  });

  it('unreadable or non-object storage content yields no peers, and a failing storage means no reach', async () => {
    const storage = memoryStorage();
    storage.store.set('pdf_editor_vault_announce_v1', '"a string"');
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('localStorage', storage);
    const reader = channel();
    await reader.probe();
    expect(reader.peerReferences()).toEqual([]);
    storage.store.set('pdf_editor_vault_announce_v1', '{not json');
    await reader.probe();
    expect(reader.peerReferences()).toEqual([]);

    vi.stubGlobal('localStorage', memoryStorage(true));
    const blocked = channel();
    expect(blocked.canReachPeers()).toBe(false);
    expect(() => blocked.announce(['src-x'])).not.toThrow();
  });
});
