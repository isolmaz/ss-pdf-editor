/**
 * Cross-window vault coordination.
 *
 * The vault lives in the origin's private file system, which every tab of this origin
 * shares. The in-window write queue (`features/persistence`) serialises one tab's writes; it says
 * nothing about the second window the user has open on the same document. Three questions
 * therefore need an answer that spans windows:
 *
 * 1. **Which blobs are still live?** A sweep may only delete a key that no window holds.
 *    This window knows its own documents; it has to *ask* the others.
 * 2. **Who writes and deletes, and when?** A draft write (its blobs, then its manifest) and a
 *    sweep must not interleave: a sweep that lists the stored blobs between the two sees a
 *    snapshot no manifest references yet and deletes it. Writers therefore take the vault lock
 *    (`runExclusive`) *outermost* and run the window's own queue inside it
 *    (`queueVaultWrite`, `sweepVault`, `purgeActiveDocument`) — never the other way round, so a
 *    window waiting for the lock cannot hold up the queue its lock holder is waiting on.
 * 3. **Whose is this draft?** A draft's manifest is `drafts/<id>.json` and its id is the tab's
 *    id, so two windows that both restore (or both write) the same id overwrite each other's
 *    manifest, and one window's snapshot cleanup deletes blobs the other's manifest names.
 *
 * ## Mechanisms, and the fallback
 *
 * `BroadcastChannel` answers the first question and `navigator.locks` the second and third.
 * Both are broadly available, and neither is assumed. When `navigator.locks` is missing the
 * work runs unserialised (the vault operations are idempotent, so the worst case is a repeated
 * `removeEntry`), a draft cannot be claimed (ownership is then best-effort: every claim is
 * granted), and a probe cannot tell whom to wait for, so it reports `false` and the sweep
 * deletes nothing. When `BroadcastChannel` is missing the same exchange moves to
 * `localStorage` + `storage` events, which ships everywhere. Only if *both* channels are
 * unavailable does `canReachPeers()` return `false`, and then the sweep refuses to run:
 * without peer knowledge a “delete everything unreferenced” pass would delete another
 * window's only copy of a document.
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
 * the probe report `false`, and the sweep refuses to run rather than guess. So does a lock
 * manager that is missing or cannot be asked: the probe still collects what peers answer
 * within `PROBE_WINDOW_MS`, but it cannot prove that every window did, so its verdict is
 * `false` — a timer never decides that a peer is absent.
 *
 * ## Who owns a draft
 *
 * An open tab's window holds a lock named after the draft (`DRAFT_LOCK_PREFIX + id`) for as
 * long as the tab lives. `claimDraft` asks for it without waiting and says whether this window
 * now owns the draft; a window restores a stored draft, and writes one, only when it does.
 * The lock manager releases a closed window's locks by itself, so a draft whose window crashed
 * is claimable again at the next start. A window that is closing or reloading has not always
 * dropped its locks by the time the next page runs, so the startup restore asks again for a
 * moment before it decides a draft belongs to someone else (`draft-restore.ts`).
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

/** The window that has a tab open holds `DRAFT_LOCK_PREFIX + <draft id>`: that is what owning a draft is. */
const DRAFT_LOCK_PREFIX = 'pdf-editor.vault.draft.';

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
   * lists has answered, and `false` when the peer knowledge may be incomplete: a listed window
   * stayed silent, or there is no lock manager to say which windows to wait for (the fixed
   * window still collects what peers answer, but a timer cannot prove that none is missing).
   */
  probe(): Promise<boolean>;
  /** The union of every key any window has claimed, including this one's last announcement. */
  peerReferences(): readonly string[];
  /** Runs `work` with the cross-window lock when the platform provides one. */
  runExclusive<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Takes the draft `draftId` for this window, for as long as the window (or `releaseDraft`)
   * keeps it. Resolves `true` when this window owns it — now or already — and `false` when
   * another window does. Without a lock manager nobody can be asked, so every claim is granted:
   * ownership is best-effort there, and the refusal path never runs.
   */
  claimDraft(draftId: string): Promise<boolean>;
  /** Gives up this window's claim on `draftId`; a draft this window never claimed is left alone. */
  releaseDraft(draftId: string): void;
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
  /** The drafts this window owns or is asking for; a granted claim holds its lock until it is released. */
  const claims = new Map<string, { readonly granted: Promise<boolean>; readonly release: () => void }>();

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
   * timer or a storage event). Resolves `true` when the wait completed; when the limit elapsed
   * first it resolves `timerCompletes` — `false` for live windows still silent and for a wait
   * that has no way to know whom it is waiting for, `true` only for the shared `localStorage`
   * record, which every window rewrites whenever its keys change.
   */
  const waitFor = (
    awaiting: Set<string> | null,
    limitMs: number,
    probeId: string,
    timerCompletes: boolean,
  ): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      pending = { probeId, awaiting, finish: resolve };
      probeTimer = setTimeout(() => endProbe(timerCompletes), limitMs);
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
        return await waitFor(null, PROBE_WINDOW_MS, 'fallback', true);
      }
      const live = await liveWindows();
      probeCount += 1;
      const probeId = `${id}:${probeCount}`;
      // No answer from the lock manager means no list of whom to wait for: the window below still
      // collects what peers say, but only a list can prove that nobody is missing, so it is `false`.
      const answered =
        live === null || live.size > 0
          ? waitFor(live, live === null ? PROBE_WINDOW_MS : LIVE_PEER_LIMIT_MS, probeId, false)
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

    claimDraft(draftId) {
      const existing = claims.get(draftId);
      if (existing !== undefined) return existing.granted;
      if (closed) return Promise.resolve(false);
      const locks = lockManager();
      if (locks === undefined) return Promise.resolve(true);
      let dropped = false;
      let freeLock: (() => void) | null = null;
      const granted = new Promise<boolean>((resolve) => {
        locks
          .request(DRAFT_LOCK_PREFIX + draftId, { mode: 'exclusive', ifAvailable: true }, (lock) => {
            if (lock === null || dropped) {
              resolve(false);
              return undefined;
            }
            resolve(true);
            return new Promise<void>((free) => {
              freeLock = free;
            });
          })
          // A lock manager that throws cannot say who owns the draft: keep working rather than
          // refuse to save the user's document (the window lock above does the same).
          .catch(() => resolve(true));
      });
      const claim = {
        granted,
        release: () => {
          dropped = true;
          freeLock?.();
        },
      };
      claims.set(draftId, claim);
      // A refusal is not remembered: the other window may close, and the next ask must reach the lock manager.
      void granted.then((owned) => {
        if (!owned && claims.get(draftId) === claim) claims.delete(draftId);
      });
      return granted;
    },

    releaseDraft(draftId) {
      claims.get(draftId)?.release();
      claims.delete(draftId);
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
      for (const claim of claims.values()) claim.release();
      claims.clear();
      channel?.close();
    },
  };
}

export { createVaultChannel };
