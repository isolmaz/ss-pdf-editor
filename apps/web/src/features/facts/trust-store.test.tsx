// @vitest-environment happy-dom
/**
 * The user's trust decisions: what is read back from the settings directory, what an import or a
 * removal stores (and writes back), the bytes the verifier is handed with them, and what the user
 * is told when the browser refuses a read or a write — a change that was not stored is not made.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { revocationListFrom, trustRootFrom } from 'pdf-model';
import { createTranslator, type Translator } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearNotice, coreStore } from '../core/core-store';
import {
  importRevocationLists,
  importTrustRoots,
  removeRevocationListById,
  removeTrustRootById,
  trustStore,
  useStoredTrust,
  useTrust,
} from './trust-store';

const files = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('../../drafts', () => ({ readAppFile: files.read, writeAppFile: files.write }));

const t = createTranslator('en');
// Stored entries shorter than a certificate / a CRL are dropped on read, so the fixtures have a real length.
const der = (length: number, fill: number) => new Uint8Array(length).fill(fill);
const rootA = trustRootFrom(der(64, 1), 'Root A', 1);
const rootB = trustRootFrom(der(64, 2), 'Root B', 2);
const summary = { thisUpdate: null, nextUpdate: null, revokedCount: 0, delta: false };
const listA = revocationListFrom(der(32, 7), 'CRL A', summary, 1);
const listB = revocationListFrom(der(32, 9), 'CRL B', summary, 2);
const empty = trustStore.get();

function Loader({ translator = t }: { translator?: Translator }) {
  useStoredTrust(translator);
  const labels = useTrust((state) => state.roots.map((root) => root.label).join(','));
  return <p>{labels}</p>;
}

/** A settings read the test settles by file name. */
function pendingReads() {
  const resolvers = new Map<string, (value: unknown) => void>();
  files.read.mockImplementation((name: string) => new Promise((resolve) => resolvers.set(name, resolve)));
  return resolvers;
}

beforeEach(() => {
  trustStore.set(empty);
  clearNotice();
  files.read.mockReset();
  files.write.mockReset();
  files.write.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('stored trust', () => {
  it('reads the stored roots and CRLs when the shell mounts', async () => {
    files.read.mockImplementation(async (name: string) =>
      name === 'trust-roots.json' ? { version: 1, roots: [rootA] } : { version: 1, lists: [listA] },
    );

    render(<Loader />);

    expect(await screen.findByText('Root A')).toBeTruthy();
    expect(trustStore.get().roots).toEqual([rootA]);
    expect(trustStore.get().rootBytes).toEqual([der(64, 1)]);
    expect(trustStore.get().lists).toEqual([listA]);
    expect(trustStore.get().listBytes).toEqual([der(32, 7)]);
  });

  it('starts empty when nothing is stored', async () => {
    files.read.mockResolvedValue(null);
    render(<Loader />);
    await vi.waitFor(() => expect(files.read).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(trustStore.get()).toMatchObject({ roots: [], rootBytes: [], lists: [], listBytes: [] });
  });

  it('drops a read that lands after the shell unmounted', async () => {
    const reads = pendingReads();
    const view = render(<Loader />);
    view.unmount();

    await act(async () => {
      reads.get('trust-roots.json')?.({ version: 1, roots: [rootA] });
      reads.get('revocation-lists.json')?.({ version: 1, lists: [listA] });
    });

    expect(trustStore.get()).toStrictEqual(empty);
  });

  it('tells the user when the browser refuses to read the stored trust, and leaves the lists empty', async () => {
    files.read.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));

    render(<Loader />);

    await vi.waitFor(() => expect(coreStore.get().notice).toBe(t('props.sig.storeUnreadable')));
    expect(trustStore.get()).toStrictEqual(empty);
  });

  it('does not read the files again when the language changes, so a stale read cannot undo a stored change', async () => {
    files.read.mockResolvedValue(null);
    const view = render(<Loader />);
    await vi.waitFor(() => expect(files.read).toHaveBeenCalledTimes(2));

    view.rerender(<Loader translator={createTranslator('tr')} />);
    await act(async () => undefined);

    expect(files.read).toHaveBeenCalledTimes(2);
  });

  it('words a refused read in the language in force when it fails', async () => {
    const refusal = Promise.withResolvers<unknown>();
    files.read.mockReturnValue(refusal.promise);
    const turkish = createTranslator('tr');
    const view = render(<Loader />);
    view.rerender(<Loader translator={turkish} />);

    await act(async () => refusal.reject(new DOMException('denied', 'NotAllowedError')));

    expect(coreStore.get().notice).toBe(turkish('props.sig.storeUnreadable'));
  });

  it('says nothing about a refused read that lands after the shell unmounted', async () => {
    const refusal = Promise.withResolvers<unknown>();
    files.read.mockReturnValue(refusal.promise);
    const view = render(<Loader />);
    view.unmount();

    await act(async () => refusal.reject(new DOMException('denied', 'NotAllowedError')));

    expect(coreStore.get().notice).toBeNull();
  });
});

describe('trust roots', () => {
  it('imports roots, replaces one imported twice, stores the file and says how many arrived', async () => {
    trustStore.set({ roots: [rootA], rootBytes: [der(64, 1)] });

    await importTrustRoots([rootB, rootA], t);

    expect(
      trustStore
        .get()
        .roots.map((root) => root.id)
        .sort(),
    ).toEqual([rootA.id, rootB.id].sort());
    expect(trustStore.get().rootBytes).toHaveLength(2);
    expect(files.write).toHaveBeenCalledWith('trust-roots.json', {
      version: 1,
      roots: trustStore.get().roots,
    });
    expect(coreStore.get().notice).toBe(t('props.sig.roots.added', { count: 2 }));
  });

  it('removes a root by id, stores the file, and says nothing', async () => {
    await importTrustRoots([rootA, rootB], t);
    clearNotice();
    files.write.mockClear();

    await removeTrustRootById(rootA.id, t);

    expect(trustStore.get().roots).toEqual([rootB]);
    expect(trustStore.get().rootBytes).toEqual([der(64, 2)]);
    expect(files.write).toHaveBeenCalledWith('trust-roots.json', { version: 1, roots: [rootB] });
    expect(coreStore.get().notice).toBeNull();
  });
});

describe('revocation lists', () => {
  it('imports lists, stores the file and says how many arrived', async () => {
    await importRevocationLists([listA, listB], t);

    expect(trustStore.get().lists).toEqual([listA, listB]);
    expect(trustStore.get().listBytes).toEqual([der(32, 7), der(32, 9)]);
    expect(files.write).toHaveBeenCalledWith('revocation-lists.json', {
      version: 1,
      lists: [listA, listB],
    });
    expect(coreStore.get().notice).toBe(t('props.sig.crls.added', { count: 2 }));
  });

  it('removes a list by id, stores the file, and says nothing', async () => {
    await importRevocationLists([listA, listB], t);
    clearNotice();
    files.write.mockClear();

    await removeRevocationListById(listB.id, t);

    expect(trustStore.get().lists).toEqual([listA]);
    expect(files.write).toHaveBeenCalledWith('revocation-lists.json', { version: 1, lists: [listA] });
    expect(coreStore.get().notice).toBeNull();
  });
});

describe('a store the browser refuses to write', () => {
  const quota = () => new DOMException('full', 'QuotaExceededError');
  const failed = (reason: string) => t('props.sig.storeFailed', { reason });

  it('adds no root, and says the browser could not store it instead of that it was added', async () => {
    files.write.mockRejectedValue(quota());

    await importTrustRoots([rootA], t);

    expect(trustStore.get()).toStrictEqual(empty);
    expect(coreStore.get().notice).toBe(failed(t('error.quota-exceeded.message')));
  });

  it('keeps a root the browser could not remove from the file, so a reload does not bring it back', async () => {
    await importTrustRoots([rootA, rootB], t);
    files.write.mockRejectedValue(new DOMException('locked', 'NoModificationAllowedError'));

    await removeTrustRootById(rootA.id, t);

    expect(trustStore.get().roots.map((root) => root.id)).toEqual([rootA.id, rootB.id]);
    expect(trustStore.get().rootBytes).toEqual([der(64, 1), der(64, 2)]);
    expect(coreStore.get().notice).toBe(failed(t('draft.storageRefused')));
  });

  it('adds no list and keeps a list it could not remove', async () => {
    files.write.mockRejectedValueOnce(quota());
    await importRevocationLists([listA], t);
    expect(trustStore.get()).toStrictEqual(empty);
    expect(coreStore.get().notice).toBe(failed(t('error.quota-exceeded.message')));

    await importRevocationLists([listA], t);
    files.write.mockRejectedValueOnce(new DOMException('locked', 'NoModificationAllowedError'));
    await removeRevocationListById(listA.id, t);

    expect(trustStore.get().lists).toEqual([listA]);
    expect(trustStore.get().listBytes).toEqual([der(32, 7)]);
    expect(coreStore.get().notice).toBe(failed(t('draft.storageRefused')));
  });

  it('applies a change only when its write has finished', async () => {
    const write = Promise.withResolvers<void>();
    files.write.mockReturnValue(write.promise);

    const landing = importTrustRoots([rootA], t);
    await vi.waitFor(() => expect(files.write).toHaveBeenCalledTimes(1));
    expect(trustStore.get()).toStrictEqual(empty);
    expect(coreStore.get().notice).toBeNull();

    write.resolve();
    await landing;

    expect(trustStore.get().roots).toEqual([rootA]);
    expect(coreStore.get().notice).toBe(t('props.sig.roots.added', { count: 1 }));
  });
});

describe('quick successive changes', () => {
  it('write one at a time, and each is derived from the state the one before it left', async () => {
    const first = Promise.withResolvers<void>();
    files.write.mockReturnValueOnce(first.promise);

    const importing = importTrustRoots([rootA], t);
    const importingMore = importTrustRoots([rootB], t);
    await vi.waitFor(() => expect(files.write).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    expect(files.write).toHaveBeenCalledTimes(1);

    first.resolve();
    await Promise.all([importing, importingMore]);

    expect(files.write).toHaveBeenCalledTimes(2);
    expect(files.write).toHaveBeenNthCalledWith(1, 'trust-roots.json', { version: 1, roots: [rootA] });
    expect(files.write).toHaveBeenNthCalledWith(2, 'trust-roots.json', { version: 1, roots: [rootA, rootB] });
    expect(trustStore.get().roots).toEqual([rootA, rootB]);
  });

  it('are not held up by an earlier one the browser refused', async () => {
    files.write.mockRejectedValueOnce(new DOMException('full', 'QuotaExceededError'));

    await Promise.all([importTrustRoots([rootA], t), importTrustRoots([rootB], t)]);

    expect(trustStore.get().roots).toEqual([rootB]);
    expect(files.write).toHaveBeenLastCalledWith('trust-roots.json', { version: 1, roots: [rootB] });
  });
});
