/**
 * Cross-window vault coordination (`PLAN.md §3.5`, `K10`).
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
 * refreshes them with a bounded probe before each sweep.
 */

/** How long a probe waits for the other windows to answer. */
const PROBE_WINDOW_MS = 250;

/** The lock name: one vault, one writer at a time, across this origin's windows. */
const VAULT_LOCK = 'pdf-editor.vault.v1';

/** The `localStorage` fallback's single key. */
const FALLBACK_KEY = 'pdf_editor_vault_announce_v1';

interface Announcement {
  readonly windowId: string;
  readonly keys: readonly string[];
  readonly at: number;
}

export interface VaultChannel {
  /** Publishes the keys this window holds right now, so peers stop treating them as free. */
  announce(keys: readonly string[]): void;
  /** Refreshes every known peer's answer; resolves when the probe window has elapsed. */
  probe(): Promise<void>;
  /** The union of every key any window has claimed, including this one's last announcement. */
  peerReferences(): readonly string[];
  /** Runs `work` with the cross-window lock when the platform provides one. */
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
  /** Whether peers can be reached at all; a sweep must not run when they cannot. */
  canReachPeers(): boolean;
  close(): void;
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
  let resolveProbe: (() => void) | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;

  const remember = (announcement: Announcement): void => {
    if (announcement.windowId === id) return;
    if (!Array.isArray(announcement.keys)) return;
    const keys = announcement.keys.filter((key): key is string => typeof key === 'string');
    known.set(announcement.windowId, keys);
  };

  const writeFallback = (): void => {
    if (channel !== null) return;
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

  const endProbe = (): void => {
    clearTimeout(probeTimer ?? undefined);
    probeTimer = null;
    const resolve = resolveProbe;
    resolveProbe = null;
    resolve?.();
  };

  if (channel !== null) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (typeof data !== 'object' || data === null) return;
      const announcement = data as Partial<Announcement>;
      if (typeof announcement.windowId !== 'string') return;
      remember({ windowId: announcement.windowId, keys: announcement.keys ?? [], at: announcement.at ?? 0 });
      // A peer answering a probe ends our wait early; there is nothing else to learn.
      if ((data as { probe?: unknown }).probe === true) {
        channel.postMessage({ windowId: id, keys: lastAnnouncement, at: Date.now(), probe: false });
        endProbe();
      }
    };
  } else {
    globalThis.addEventListener?.('storage', (event) => {
      if (event.key === FALLBACK_KEY && readFallback()) endProbe();
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
      if (channel !== null) {
        channel.postMessage({ windowId: id, keys: lastAnnouncement, at: Date.now(), probe: true });
      } else {
        writeFallback();
        readFallback();
      }
      await new Promise<void>((resolve) => {
        resolveProbe = resolve;
        probeTimer = setTimeout(endProbe, PROBE_WINDOW_MS);
      });
    },

    peerReferences() {
      const keys = new Set<string>();
      for (const entry of known.values()) for (const key of entry) keys.add(key);
      return [...keys];
    },

    async runExclusive(work) {
      const locks = (globalThis.navigator as Navigator & { locks?: LockManager }).locks;
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
      endProbe();
      channel?.close();
    },
  };
}

export { createVaultChannel };
