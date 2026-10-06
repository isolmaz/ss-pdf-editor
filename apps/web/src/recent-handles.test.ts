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
import { getRecentHandle, pruneRecentHandles, putRecentHandle, reopenFromHandle } from './recent-handles';

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

  it('does nothing and throws nothing without IndexedDB, or when it cannot be opened', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(
      putRecentHandle('x', new FakeHandle() as unknown as FileSystemFileHandle),
    ).resolves.toBeUndefined();
    expect(await getRecentHandle('x')).toBeNull();
    await expect(pruneRecentHandles(new Set())).resolves.toBeUndefined();

    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(await getRecentHandle('x')).toBeNull();
  });
});

describe('reopenFromHandle', () => {
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
