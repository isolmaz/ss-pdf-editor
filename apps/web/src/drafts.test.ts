/**
 * The OPFS vault, against the failures that make it lose or misreport data.
 *
 * `navigator.storage.getDirectory()` is faked here — there is no OPFS in Node — but only at
 * that one boundary: everything above it (the key derivation, the manifest write order, the
 * inventory's error handling, the writable's lifecycle) is the real implementation. The
 * fake is deliberately able to *fail* on demand, because the behaviours worth testing are
 * the failure paths: an abort that never happens leaks a swap file and an exclusive lock,
 * and an inventory that throws on one bad file makes every other draft look absent.
 */

import type { Draft } from 'pdf-model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpfsDraftStorage, readAppFile, writeAppFile } from './drafts';

/** A minimal in-memory OPFS: enough of the API for this module, and able to fail. */
class FakeFileHandle {
  constructor(
    private readonly files: Map<string, Uint8Array>,
    private readonly name: string,
    private readonly failures: FailurePlan,
  ) {}

  async getFile(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }> {
    if (this.failures.read.has(this.name)) throw new DOMException('unreadable', 'NotReadableError');
    const bytes = this.files.get(this.name);
    if (bytes === undefined) throw new DOMException('missing', 'NotFoundError');
    return {
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    };
  }

  async createWritable(): Promise<{
    write(data: unknown): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    const name = this.name;
    const files = this.files;
    const failures = this.failures;
    let staged: Uint8Array | null = null;
    return {
      async write(data: unknown): Promise<void> {
        if (failures.write.has(name)) throw new DOMException('quota', 'QuotaExceededError');
        staged = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
      },
      async close(): Promise<void> {
        if (failures.close.has(name)) throw new DOMException('interrupted', 'InvalidStateError');
        if (staged !== null) files.set(name, staged);
      },
      async abort(): Promise<void> {
        failures.aborted.push(name);
        staged = null;
      },
    };
  }
}

class FakeDirectoryHandle {
  constructor(
    private readonly files: Map<string, Uint8Array>,
    private readonly failures: FailurePlan,
    private readonly listing: ListingPlan,
  ) {}

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
    if (!this.files.has(name) && options?.create !== true) throw new DOMException('missing', 'NotFoundError');
    return new FakeFileHandle(this.files, name, this.failures);
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.has(name)) throw new DOMException('missing', 'NotFoundError');
    this.files.delete(name);
  }

  async *entries(): AsyncGenerator<[string, unknown]> {
    if (this.listing.fail) throw new DOMException('cannot list', 'NotReadableError');
    for (const name of [...this.files.keys(), ...this.listing.ghosts]) yield [name, null];
  }
}

interface FailurePlan {
  readonly write: Set<string>;
  readonly close: Set<string>;
  readonly read: Set<string>;
  readonly aborted: string[];
}

interface ListingPlan {
  fail: boolean;
  /** Names the listing reports although the file is gone by the time it is opened. */
  ghosts: string[];
}

function installFakeOpfs(): { files: Map<string, Uint8Array>; failures: FailurePlan; listing: ListingPlan } {
  const files = new Map<string, Uint8Array>();
  const failures: FailurePlan = { write: new Set(), close: new Set(), read: new Set(), aborted: [] };
  const listing: ListingPlan = { fail: false, ghosts: [] };
  const directories = new Map<string, FakeDirectoryHandle>();
  /**
   * Two levels, as the real API has them: the origin root hands out the application
   * directory, and *that* hands out `drafts/` and `sources/`. Collapsing them would let a
   * bug in the second lookup pass unnoticed.
   */
  const leafFor = (name: string): FakeDirectoryHandle => {
    let handle = directories.get(name);
    if (handle === undefined) {
      handle = new FakeDirectoryHandle(files, failures, listing);
      directories.set(name, handle);
    }
    return handle;
  };
  // The origin root hands out the application directory, and that one hands out
  // `drafts/` and `sources/` — the same two levels the module walks.
  const appDirectory = { getDirectoryHandle: async (name: string) => leafFor(name) };
  const storage = {
    async getDirectory(): Promise<{ getDirectoryHandle(name: string): Promise<typeof appDirectory> }> {
      return { getDirectoryHandle: async () => appDirectory };
    },
  };
  vi.stubGlobal('navigator', { storage });
  return { files, failures, listing };
}

const MANIFEST = (id: string): Draft => ({
  id,
  name: `${id}.pdf`,
  pageCount: 1,
  size: 10,
  dirty: true,
  updatedAt: 1,
  sourceKey: `src-${id}`,
  journal: [],
  engineValues: { entries: [], dropped: 0 },
});

describe('createOpfsDraftStorage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes and reads a draft back through the real key layout', async () => {
    installFakeOpfs();
    const storage = createOpfsDraftStorage();
    await storage.writeDraft(MANIFEST('a'));
    const inventory = await storage.readDraftInventory?.();
    expect(inventory?.drafts.map((draft) => draft.id)).toEqual(['a']);
    expect(inventory?.unreadable).toEqual([]);
  });

  it('aborts a writable that failed, and still reports the failure', async () => {
    const { failures } = installFakeOpfs();
    const storage = createOpfsDraftStorage();
    failures.write.add('a.json');
    await expect(storage.writeDraft(MANIFEST('a'))).rejects.toThrow();
    // Without the abort the swap file and its exclusive lock survive the failure, and the
    // next write for the same key blocks on a lock nobody will release.
    expect(failures.aborted).toContain('a.json');
    // A failed write must never read as a successful persistence.
    expect((await storage.readDraftInventory?.())?.drafts).toEqual([]);
  });

  it('aborts when close fails, not only when write fails', async () => {
    const { failures } = installFakeOpfs();
    const storage = createOpfsDraftStorage();
    failures.close.add('b.json');
    await expect(storage.writeDraft(MANIFEST('b'))).rejects.toThrow();
    expect(failures.aborted).toContain('b.json');
  });

  it('reports one unreadable manifest without losing the readable ones', async () => {
    const { failures } = installFakeOpfs();
    const storage = createOpfsDraftStorage();
    await storage.writeDraft(MANIFEST('good'));
    await storage.writeDraft(MANIFEST('bad'));
    failures.read.add('bad.json');
    const inventory = await storage.readDraftInventory?.();
    // The read failure used to escape the per-file boundary and abort the whole listing,
    // which made every *other* draft look absent — the exact input a cleanup pass must not
    // mistake for “nothing is referenced”.
    expect(inventory?.drafts.map((draft) => draft.id)).toEqual(['good']);
    expect(inventory?.unreadable).toEqual(['bad.json']);
  });

  it('flags an enumeration failure instead of reporting an empty vault', async () => {
    const { listing } = installFakeOpfs();
    const storage = createOpfsDraftStorage();
    listing.fail = true;
    const inventory = await storage.readDraftInventory?.();
    expect(inventory?.enumerationFailed).toBe(true);
    expect(inventory?.drafts).toEqual([]);
  });

  it('treats a manifest that is not valid JSON as unreadable rather than as absent', async () => {
    const { files } = installFakeOpfs();
    const storage = createOpfsDraftStorage();
    files.set('broken.json', new TextEncoder().encode('{ not json'));
    const inventory = await storage.readDraftInventory?.();
    expect(inventory?.unreadable).toEqual(['broken.json']);
    expect(inventory?.enumerationFailed).toBeUndefined();
  });

  it('treats a manifest that parses but is not a draft as unreadable rather than as absent', async () => {
    const { files } = installFakeOpfs();
    const storage = createOpfsDraftStorage();
    await storage.writeDraft(MANIFEST('good'));
    files.set('future.json', new TextEncoder().encode(JSON.stringify({ id: 'future', unknown: true })));
    const inventory = await storage.readDraftInventory?.();
    expect(inventory?.drafts.map((draft) => draft.id)).toEqual(['good']);
    expect(inventory?.unreadable).toEqual(['future.json']);
  });

  it('reports a manifest that vanished between listing and reading, and skips what is not a manifest', async () => {
    const { files, listing } = installFakeOpfs();
    const storage = createOpfsDraftStorage();
    await storage.writeDraft(MANIFEST('good'));
    files.set('notes.txt', new TextEncoder().encode('not a manifest'));
    listing.ghosts.push('gone.json');
    const inventory = await storage.readDraftInventory?.();
    expect(inventory?.drafts.map((draft) => draft.id)).toEqual(['good']);
    expect(inventory?.unreadable).toEqual(['gone.json']);
  });

  it('writes a source once per key and does not complain when asked to delete one that is absent', async () => {
    installFakeOpfs();
    const storage = createOpfsDraftStorage();
    await storage.putSource('src-once', new Uint8Array([1, 2, 3]));
    // Same key, same length: the document is the same, so the stored copy is kept.
    await storage.putSource('src-once', new Uint8Array([9, 9, 9]));
    expect(await storage.getSource('src-once')).toEqual(new Uint8Array([1, 2, 3]));
    // A different length cannot be the same document and replaces it.
    await storage.putSource('src-once', new Uint8Array([7, 7]));
    expect(await storage.getSource('src-once')).toEqual(new Uint8Array([7, 7]));
    await expect(storage.deleteSource('never-stored')).resolves.toBeUndefined();
    await expect(storage.deleteDraft('never-stored')).resolves.toBeUndefined();
  });

  it('stores a source blob once and reports it by key', async () => {
    installFakeOpfs();
    const storage = createOpfsDraftStorage();
    await storage.putSource('src-abc', new Uint8Array([1, 2, 3]));
    expect(await storage.hasSource('src-abc')).toBe(true);
    expect(await storage.getSource('src-abc')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await storage.listSources?.()).toEqual(['src-abc']);
    await storage.deleteSource('src-abc');
    expect(await storage.hasSource('src-abc')).toBe(false);
    expect(await storage.getSource('src-abc')).toBeNull();
  });
});

describe('app files', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips a settings file and reports an absent one as null', async () => {
    installFakeOpfs();
    expect(await readAppFile('trust-roots.json')).toBeNull();
    await writeAppFile('trust-roots.json', { roots: [] });
    expect(await readAppFile('trust-roots.json')).toEqual({ roots: [] });
  });

  it('returns null for a corrupt settings file instead of throwing into the shell', async () => {
    const { files } = installFakeOpfs();
    files.set('trust-roots.json', new TextEncoder().encode('not json at all'));
    expect(await readAppFile('trust-roots.json')).toBeNull();
  });
});
