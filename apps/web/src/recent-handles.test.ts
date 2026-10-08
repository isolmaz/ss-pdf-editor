/**
 * `recent-handles.ts`: file handles behind the recent list, kept in IndexedDB.
 *
 * Node has no IndexedDB, so a minimal in-memory fake (just the calls the module makes) is
 * stubbed onto the global. These tests protect what the module promises: a stored handle
 * comes back, a value that is not a file handle never does, pruning forgets exactly the
 * entries that left the recent list, every call tolerates a missing or failing IndexedDB, and
 * reopening a handle maps the permission states to `file`, `denied` and `missing`.
 * What the fake cannot show: real structured cloning of a handle and real browser prompts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteRecentHandle,
  ensureWriteAccess,
  getRecentHandle,
  pruneRecentHandles,
  putRecentHandle,
  reopenFromHandle,
} from './recent-handles';

class FakeHandle {
  permission: PermissionState = 'granted';
  asked: PermissionState = 'granted';
  requests = 0;
  failWith: Error | null = null;
  constructor(readonly name = 'a.pdf') {}
  async queryPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requests += 1;
    return this.asked;
  }
  async getFile(): Promise<File> {
    if (this.failWith !== null) throw this.failWith;
    return new File(['x'], this.name);
  }
}

/** Requests answer on a later microtask, after the caller has attached its handlers. */
function answer<T>(result: () => T): IDBRequest<T> {
  const request = { onsuccess: null, onerror: null, result: undefined } as unknown as IDBRequest<T> & {
    onsuccess: (() => void) | null;
  };
  queueMicrotask(() => {
    (request as { result: T }).result = result();
    request.onsuccess?.();
  });
  return request;
}

function fakeIndexedDb(rows: Map<string, unknown>) {
  const store = {
    put: (value: unknown, key: string) => answer(() => rows.set(key, value) && key),
    get: (key: string) => answer(() => rows.get(key)),
    getAllKeys: () => answer(() => [...rows.keys()]),
    delete: (key: string) => answer(() => rows.delete(key)),
  };
  return {
    open: () => {
      const request = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null } as {
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        result?: unknown;
      };
      request.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => store,
        transaction: () => ({ objectStore: () => store }),
        close: () => undefined,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

let rows: Map<string, unknown>;

beforeEach(() => {
  rows = new Map();
  vi.stubGlobal('FileSystemFileHandle', FakeHandle);
  vi.stubGlobal('indexedDB', fakeIndexedDb(rows));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stored handles', () => {
  it('returns the handle stored for an entry, and null for an unknown id or a value that is no handle', async () => {
    const handle = new FakeHandle('report.pdf');
    await putRecentHandle('r1', handle as unknown as FileSystemFileHandle);
    expect(await getRecentHandle('r1')).toBe(handle);
    expect(await getRecentHandle('missing')).toBeNull();

    rows.set('r2', { name: 'plain object' });
    expect(await getRecentHandle('r2')).toBeNull();
  });

  it('prunes every handle whose entry left the recent list, and only those', async () => {
    for (const id of ['keep', 'old-1', 'old-2']) {
      await putRecentHandle(id, new FakeHandle(id) as unknown as FileSystemFileHandle);
    }
    await pruneRecentHandles(new Set(['keep', 'not-stored']));
    expect([...rows.keys()]).toEqual(['keep']);
    await pruneRecentHandles(new Set());
    expect(rows.size).toBe(0);
  });

  it('forgets one entry’s handle and leaves the others', async () => {
    for (const id of ['sensitive', 'other']) {
      await putRecentHandle(id, new FakeHandle(id) as unknown as FileSystemFileHandle);
    }
    await deleteRecentHandle('sensitive');
    expect([...rows.keys()]).toEqual(['other']);
    await expect(deleteRecentHandle('never-stored')).resolves.toBeUndefined();
    expect([...rows.keys()]).toEqual(['other']);
  });

  it('does nothing and throws nothing without IndexedDB, or when it cannot be opened', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(
      putRecentHandle('x', new FakeHandle() as unknown as FileSystemFileHandle),
    ).resolves.toBeUndefined();
    expect(await getRecentHandle('x')).toBeNull();
    await expect(pruneRecentHandles(new Set())).resolves.toBeUndefined();
    await expect(deleteRecentHandle('x')).resolves.toBeUndefined();

    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(await getRecentHandle('x')).toBeNull();
  });
});

/** An IndexedDB whose `open` ends with `outcome` and whose database is `db`. */
function openEndingWith(outcome: 'error' | 'blocked', db: unknown = undefined) {
  return {
    open: () => {
      const request = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null } as {
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
        result?: unknown;
      };
      request.result = db;
      queueMicrotask(() => (outcome === 'error' ? request.onerror : request.onblocked)?.());
      return request;
    },
  };
}

describe('a failing database', () => {
  it('answers null when opening errors or is blocked by another connection', async () => {
    vi.stubGlobal('indexedDB', openEndingWith('error'));
    expect(await getRecentHandle('x')).toBeNull();
    vi.stubGlobal('indexedDB', openEndingWith('blocked'));
    expect(await getRecentHandle('x')).toBeNull();
  });

  it('answers null when a request fails, and when the transaction aborts', async () => {
    let closed = 0;
    const failingRequest = () => {
      const request = { onsuccess: null, onerror: null } as { onerror: (() => void) | null };
      queueMicrotask(() => request.onerror?.());
      return request;
    };
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request = { onsuccess: null as (() => void) | null, result: undefined as unknown };
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => ({
            objectStore: () => ({ get: failingRequest }),
            onabort: null,
          }),
          close: () => {
            closed += 1;
          },
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    });
    expect(await getRecentHandle('x')).toBeNull();
    expect(closed).toBe(1);

    vi.stubGlobal('indexedDB', {
      open: () => {
        const request = { onsuccess: null as (() => void) | null, result: undefined as unknown };
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const transaction: { onabort: (() => void) | null; objectStore: () => unknown } = {
              onabort: null,
              objectStore: () => ({ get: () => ({ onsuccess: null, onerror: null }) }),
            };
            queueMicrotask(() => transaction.onabort?.());
            return transaction;
          },
          close: () => {
            closed += 1;
          },
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    });
    expect(await getRecentHandle('x')).toBeNull();
    expect(closed).toBe(2);
  });
});

describe('a database that cannot serve the call', () => {
  it('answers null and still closes the connection when the transaction cannot start', async () => {
    let closed = 0;
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request = { onsuccess: null as (() => void) | null, result: undefined as unknown };
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            throw new DOMException('closing', 'InvalidStateError');
          },
          close: () => {
            closed += 1;
          },
        };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    });
    expect(await getRecentHandle('x')).toBeNull();
    expect(closed).toBe(1);
  });

  it('creates the store on the first open of the database', async () => {
    const created: string[] = [];
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request = {
          onupgradeneeded: null as (() => void) | null,
          onsuccess: null as (() => void) | null,
          result: undefined as unknown,
        };
        request.result = {
          objectStoreNames: { contains: () => false },
          createObjectStore: (name: string) => created.push(name),
          transaction: () => {
            throw new DOMException('stop here', 'InvalidStateError');
          },
          close: () => undefined,
        };
        queueMicrotask(() => {
          request.onupgradeneeded?.();
          request.onsuccess?.();
        });
        return request;
      },
    });
    await getRecentHandle('x');
    expect(created).toHaveLength(1);
  });
});

describe('ensureWriteAccess', () => {
  const asHandle = (handle: object) => handle as unknown as FileSystemFileHandle;

  it('is true without asking when write permission is already held', async () => {
    const handle = new FakeHandle();
    expect(await ensureWriteAccess(asHandle(handle))).toBe(true);
    expect(handle.requests).toBe(0);
  });

  it('asks once when the browser says prompt, and follows the answer', async () => {
    const accepted = new FakeHandle();
    accepted.permission = 'prompt';
    expect(await ensureWriteAccess(asHandle(accepted))).toBe(true);
    expect(accepted.requests).toBe(1);

    const refused = new FakeHandle();
    refused.permission = 'prompt';
    refused.asked = 'denied';
    expect(await ensureWriteAccess(asHandle(refused))).toBe(false);
  });

  it('is false when permission was revoked, without asking', async () => {
    const revoked = new FakeHandle();
    revoked.permission = 'denied';
    expect(await ensureWriteAccess(asHandle(revoked))).toBe(false);
    expect(revoked.requests).toBe(0);
  });

  it('treats a browser without the permission calls as already granted, and a prompt it cannot answer as denied', async () => {
    expect(await ensureWriteAccess(asHandle({}))).toBe(true);
    expect(await ensureWriteAccess(asHandle({ queryPermission: async () => 'prompt' }))).toBe(false);
  });
});

describe('reopenFromHandle', () => {
  it('reads the file of a browser that has no permission calls, and refuses a prompt it cannot answer', async () => {
    const plain = { getFile: async () => new File(['x'], 'plain.pdf') };
    const opened = await reopenFromHandle(plain as unknown as FileSystemFileHandle);
    expect(opened.kind).toBe('file');
    const stuck = { queryPermission: async () => 'prompt', getFile: plain.getFile };
    expect(await reopenFromHandle(stuck as unknown as FileSystemFileHandle)).toEqual({ kind: 'denied' });
  });

  it('reads the file when permission is held, and asks once when the browser says prompt', async () => {
    const held = new FakeHandle('held.pdf');
    const opened = await reopenFromHandle(held as unknown as FileSystemFileHandle);
    expect(opened.kind).toBe('file');
    if (opened.kind === 'file') expect(opened.file.name).toBe('held.pdf');
    expect(held.requests).toBe(0);

    const prompted = new FakeHandle('asked.pdf');
    prompted.permission = 'prompt';
    expect((await reopenFromHandle(prompted as unknown as FileSystemFileHandle)).kind).toBe('file');
    expect(prompted.requests).toBe(1);
  });

  it('answers denied when the user refuses or permission is gone, and missing when the file is', async () => {
    const refused = new FakeHandle();
    refused.permission = 'prompt';
    refused.asked = 'denied';
    expect(await reopenFromHandle(refused as unknown as FileSystemFileHandle)).toEqual({ kind: 'denied' });

    const revoked = new FakeHandle();
    revoked.permission = 'denied';
    expect(await reopenFromHandle(revoked as unknown as FileSystemFileHandle)).toEqual({ kind: 'denied' });
    expect(revoked.requests).toBe(0);

    const blocked = new FakeHandle();
    blocked.failWith = new DOMException('no', 'NotAllowedError');
    expect(await reopenFromHandle(blocked as unknown as FileSystemFileHandle)).toEqual({ kind: 'denied' });

    const gone = new FakeHandle();
    gone.failWith = new DOMException('moved', 'NotFoundError');
    expect(await reopenFromHandle(gone as unknown as FileSystemFileHandle)).toEqual({ kind: 'missing' });
  });
});
