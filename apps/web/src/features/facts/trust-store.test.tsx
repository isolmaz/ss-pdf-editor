// @vitest-environment happy-dom
/**
 * The user's trust decisions: what is read back from the settings directory, what an import or a
 * removal stores (and writes back), and the bytes the verifier is handed with them.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { revocationListFrom, trustRootFrom } from 'pdf-model';
import { createTranslator } from 'pdf-shared';
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

function Loader() {
  useStoredTrust();
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
});

describe('trust roots', () => {
  it('imports roots, replaces one imported twice, stores the file and says how many arrived', () => {
    trustStore.set({ roots: [rootA], rootBytes: [der(64, 1)] });

    importTrustRoots([rootB, rootA], t);

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

  it('removes a root by id, stores the file, and says nothing', () => {
    importTrustRoots([rootA, rootB], t);
    clearNotice();
    files.write.mockClear();

    removeTrustRootById(rootA.id);

    expect(trustStore.get().roots).toEqual([rootB]);
    expect(trustStore.get().rootBytes).toEqual([der(64, 2)]);
    expect(files.write).toHaveBeenCalledWith('trust-roots.json', { version: 1, roots: [rootB] });
    expect(coreStore.get().notice).toBeNull();
  });
});

describe('revocation lists', () => {
  it('imports lists, stores the file and says how many arrived', () => {
    importRevocationLists([listA, listB], t);

    expect(trustStore.get().lists).toEqual([listA, listB]);
    expect(trustStore.get().listBytes).toEqual([der(32, 7), der(32, 9)]);
    expect(files.write).toHaveBeenCalledWith('revocation-lists.json', {
      version: 1,
      lists: [listA, listB],
    });
    expect(coreStore.get().notice).toBe(t('props.sig.crls.added', { count: 2 }));
  });

  it('removes a list by id, stores the file, and says nothing', () => {
    importRevocationLists([listA, listB], t);
    clearNotice();
    files.write.mockClear();

    removeRevocationListById(listB.id);

    expect(trustStore.get().lists).toEqual([listA]);
    expect(files.write).toHaveBeenCalledWith('revocation-lists.json', { version: 1, lists: [listA] });
    expect(coreStore.get().notice).toBeNull();
  });
});
