/**
 * Cross-window vault coordination.
 *
 * The vault lives in the origin's private file system, which every tab of this origin
 * shares. The in-window write queue in `App.tsx` serialises one tab's writes; it says
 * nothing about the second window the user has open on the same document. Two questions
 * therefore need an answer that spans windows:
 *
 * 1. **Which blobs are still live?** A sweep may only delete a key that no window holds.
 *    This window knows its own documents; it has to *ask* the others.
 * 2. **Who deletes, and when?** Two windows deciding at the same moment must not
 *    interleave their `removeEntry` calls with a third window's manifest write.
 *
 * ## Mechanisms, and the fallback
 *
 * `BroadcastChannel` answers the first question and `navigator.locks` the second. Both are
 * broadly available, and neither is assumed: when `navigator.locks` is missing the work
 * runs unserialised (every vault operation is idempotent, so the worst case is a repeated
 * `removeEntry`, not a lost document), and when `BroadcastChannel` is missing the same
 * exchange moves to `localStorage` + `storage` events, which ships everywhere. Only if
 * *both* channels are unavailable does `canReachPeers()` return `false`, and then the
 * sweep refuses to run: without peer knowledge a “delete everything unreferenced” pass
 * would delete another window's only copy of a document.
 *
 * ## Liveness is never assumed
 *
 * References are only ever **added**. A window that answers once and then dies leaves its
 * keys pinned, which costs space; a window whose keys were forgotten because it went
 * quiet would cost a document. The channel therefore keeps every answer it has heard and
 * refreshes them with a probe before each sweep.
 *
 * ## What a probe waits for
 *
 * A fixed timer cannot tell a slow window from an absent one: a busy background tab that
 * answers after the timer would have its open document's blob swept. So while a window is
 * open it holds a `navigator.locks` lock named after its id; a probe asks the lock manager
 * which windows are alive (`locks.query()`) and completes only when each of them has
 * answered *that* probe, however long it takes — the outcome does not depend on timing.
 * A window that closes while the probe waits never answers, but the lock manager drops
 * its lock: the probe asks again every `RECHECK_MS` and stops waiting for a window whose
 * lock is gone (a tab closed a moment ago can still be listed by the first query).
 * A window that is listed but stays silent for `LIVE_PEER_LIMIT_MS` (a frozen tab) makes
 * the probe report `false`, and the sweep refuses to run rather than guess. Only where
 * there is no lock manager does the probe fall back to a fixed `PROBE_WINDOW_MS` wait.
 */

/** How long a probe without a lock manager waits for the other windows to answer. */
const PROBE_WINDOW_MS = 250;

/** How long a probe waits for a window the lock manager lists as alive before it gives up. */
const LIVE_PEER_LIMIT_MS = 10_000;

/** How often a waiting probe asks the lock manager again, so a window that closed meanwhile stops holding it open. */
const RECHECK_MS = 250;

/** Every open window holds `WINDOW_LOCK_PREFIX + id`; the set of such locks is the set of live windows. */
const WINDOW_LOCK_PREFIX = 'pdf-editor.vault.window.';

/** The lock name: one vault, one writer at a time, across this origin's windows. */
const VAULT_LOCK = 'pdf-editor.vault.v1';

/** The `localStorage` fallback's single key. */
const FALLBACK_KEY = 'pdf_editor_vault_announce_v1';

interface Announcement {
  readonly windowId: string;
  readonly keys: readonly string[];
  readonly at: number;
  /** Set on a probe: peers answer with `replyTo` carrying this id. */
  readonly probe?: boolean;
  readonly probeId?: string;
  readonly replyTo?: string;
}

export interface VaultChannel {
  /** Publishes the keys this window holds right now, so peers stop treating them as free. */
  announce(keys: readonly string[]): void;
  /**
   * Refreshes every live peer's answer. Resolves `true` when every window the lock manager
   * lists has answered (or, without a lock manager, when the fixed window has elapsed), and
   * `false` when a listed window stayed silent: the peer knowledge is then incomplete.
   */
  probe(): Promise<boolean>;
  /** The union of every key any window has claimed, including this one's last announcement. */
  peerReferences(): readonly string[];
  /** Runs `work` with the cross-window lock when the platform provides one. */
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
  /** Whether peers can be reached at all; a sweep must not run when they cannot. */
  canReachPeers(): boolean;
  close(): void;
}

/** The platform's lock manager, `undefined` where there is none. */
function lockManager(): LockManager | undefined {
  return globalThis.navigator?.locks;
}

/** A per-window identifier: two tabs must be distinguishable inside one announcement map. */
function windowId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `w-${Math.random().toString(36).slice(2)}`;
}

/**
 * The real channel. `send` is whatever the platform gives us and `known` is the peer
 * state, which starts empty: a window that has just opened knows nothing, and the probe
 * it performs before its first sweep is what makes that state trustworthy.
 */
function createVaultChannel(): VaultChannel {
  const id = windowId();
  const known = new Map<string, readonly string[]>();
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('pdf-editor.vault.v1') : null;
  let lastAnnouncement: readonly string[] = [];
  /** The probe in flight: whom it still waits for, and how it ends. */
  let pending: {
    readonly probeId: string;
    /** The live windows that have not answered yet; `null` when only a timer bounds the probe. */
    readonly awaiting: Set<string> | null;
    readonly finish: (complete: boolean) => void;
  } | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let probeCount = 0;
  let releaseWindowLock: (() => void) | null = null;

  // Holding this lock for as long as the window lives is what lets a probe know who is alive.
  lockManager()
    ?.request(WINDOW_LOCK_PREFIX + id, { mode: 'exclusive' }, () =>
      closed
        ? undefined
        : new Promise<void>((release) => {
            releaseWindowLock = release;
          }),
    )
    .catch(() => undefined);

  const remember = (announcement: Announcement): void => {
    if (announcement.windowId === id) return;
    if (!Array.isArray(announcement.keys)) return;
    const keys = announcement.keys.filter((key): key is string => typeof key === 'string');
    known.set(announcement.windowId, keys);
  };

  const writeFallback = (): void => {
    try {
      const raw = globalThis.localStorage.getItem(FALLBACK_KEY);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      const entries =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      entries[id] = { windowId: id, keys: lastAnnouncement, at: Date.now() } satisfies Announcement;
      globalThis.localStorage.setItem(FALLBACK_KEY, JSON.stringify(entries));
    } catch {
      // A storage quota or a disabled localStorage costs the *sweep*, never a document:
      // `canReachPeers()` reports the failure and the caller refuses to delete.
    }
  };

  const readFallback = (): boolean => {
    try {
      const raw = globalThis.localStorage.getItem(FALLBACK_KEY);
      if (raw === null) return false;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return false;
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (typeof value === 'object' && value !== null) remember(value as Announcement);
      }
      return true;
    } catch {
      return false;
    }
  };

  const endProbe = (complete: boolean): void => {
    clearTimeout(probeTimer ?? undefined);
    probeTimer = null;
    const ending = pending;
    pending = null;
    ending?.finish(complete);
  };

  /**
   * Holds the probe open until every window in `awaiting` has answered it (`null`: until the
   * timer or a storage event). Resolves `true` when the wait completed, `false` when the
   * limit elapsed first with live windows still silent.
   */
  const waitFor = (awaiting: Set<string> | null, limitMs: number, probeId: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      pending = { probeId, awaiting, finish: resolve };
      probeTimer = setTimeout(() => endProbe(awaiting === null), limitMs);
    });

  /** The ids of the other windows the lock manager lists as alive; `null` without one. */
  const liveWindows = async (): Promise<Set<string> | null> => {
    const locks = lockManager();
    if (locks === undefined) return null;
    try {
      const snapshot = await locks.query();
      const live = new Set<string>();
      for (const held of snapshot.held ?? []) {
        const name = held.name ?? '';
        if (!name.startsWith(WINDOW_LOCK_PREFIX)) continue;
        const peer = name.slice(WINDOW_LOCK_PREFIX.length);
        if (peer !== id) live.add(peer);
      }
      return live;
    } catch {
      return null;
    }
  };

  /**
   * While probe `probeId` waits, asks the lock manager again every `RECHECK_MS` and stops
   * waiting for any window whose lock is gone: it closed, so it will never answer. The loop
   * ends with the probe; a failed query changes nothing and the next one tries again.
   */
  const dropClosedWindows = (awaiting: Set<string>, probeId: string): void => {
    setTimeout(() => {
      if (pending?.probeId !== probeId) return;
      void liveWindows().then((live) => {
        if (pending?.probeId !== probeId) return;
        if (live !== null) for (const peer of [...awaiting]) if (!live.has(peer)) awaiting.delete(peer);
        if (awaiting.size === 0) endProbe(true);
        else dropClosedWindows(awaiting, probeId);
      });
    }, RECHECK_MS);
  };

  if (channel !== null) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (typeof data !== 'object' || data === null) return;
      const announcement = data as Partial<Announcement>;
      if (typeof announcement.windowId !== 'string') return;
      remember({ windowId: announcement.windowId, keys: announcement.keys ?? [], at: announcement.at ?? 0 });
      if (announcement.probe === true) {
        const probeId = typeof announcement.probeId === 'string' ? announcement.probeId : undefined;
        channel.postMessage({
          windowId: id,
          keys: lastAnnouncement,
          at: Date.now(),
          probe: false,
          replyTo: probeId,
        });
      }
      // An answer to *our* probe: the window it came from no longer holds the probe open.
      if (pending?.awaiting && announcement.replyTo === pending.probeId) {
        pending.awaiting.delete(announcement.windowId);
        if (pending.awaiting.size === 0) endProbe(true);
      }
    };
  } else {
    globalThis.addEventListener?.('storage', (event) => {
      if (event.key === FALLBACK_KEY && readFallback()) endProbe(true);
    });
  }

  return {
    announce(keys) {
      lastAnnouncement = [...keys];
      if (channel !== null) {
        channel.postMessage({ windowId: id, keys: lastAnnouncement, at: Date.now(), probe: false });
        return;
      }
      writeFallback();
    },

    async probe() {
      if (channel === null) {
        // Every window's entry sits in one storage record: reading it is the whole exchange,
        // and a `storage` event from a peer's write ends the wait early.
        writeFallback();
        readFallback();
        return await waitFor(null, PROBE_WINDOW_MS, 'fallback');
      }
      const live = await liveWindows();
      probeCount += 1;
      const probeId = `${id}:${probeCount}`;
      const answered =
        live === null || live.size > 0
          ? waitFor(live, live === null ? PROBE_WINDOW_MS : LIVE_PEER_LIMIT_MS, probeId)
          : Promise.resolve(true);
      if (live !== null && live.size > 0) dropClosedWindows(live, probeId);
      channel.postMessage({ windowId: id, keys: lastAnnouncement, at: Date.now(), probe: true, probeId });
      return await answered;
    },

    peerReferences() {
      const keys = new Set<string>();
      for (const entry of known.values()) for (const key of entry) keys.add(key);
      return [...keys];
    },

    async runExclusive(work) {
      const locks = lockManager();
      if (locks === undefined) return await work();
      // `steal: false`, no timeout: a vault mutation is short, and taking a lock away
      // from a window that is mid-write is exactly the interleaving this exists to stop.
      return await locks.request(VAULT_LOCK, async () => await work());
    },

    canReachPeers() {
      if (channel !== null) return true;
      try {
        globalThis.localStorage.setItem(FALLBACK_KEY, globalThis.localStorage.getItem(FALLBACK_KEY) ?? '{}');
        return true;
      } catch {
        return false;
      }
    },

    close() {
      closed = true;
      endProbe(false);
      releaseWindowLock?.();
      channel?.close();
    },
  };
}

export { createVaultChannel };
