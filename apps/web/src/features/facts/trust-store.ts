/**
 * The certificates and revocation lists the user imported to judge signatures with.
 *
 * They live in the app's own OPFS directory — a device setting, never a document fact — and the
 * signature verdicts re-run when either list changes, because a trust decision is exactly what a
 * re-check is for (an imported CRL is what turns "indeterminate" into an answer). The DER bytes
 * the verifier takes are derived with the list, so a consumer's effect depends on them by
 * identity: they change exactly when the list does.
 *
 * What the store holds is what the file holds. A change is written first and applied only when
 * the write succeeded: a root that is shown as removed but returns after a reload, or a root
 * that judges this session's signatures but is gone after it, is a trust decision the user never
 * made. A write the browser refuses says so and changes nothing. The writes go one at a time
 * (`createWritable` takes an exclusive lock in some browsers), and each change is derived from
 * the state its turn finds, so two quick imports both land.
 */

import {
  addRevocationList,
  addTrustRoot,
  parseRevocationLists,
  parseTrustRoots,
  type RevocationList,
  type RevocationListsFile,
  removeRevocationList,
  removeTrustRoot,
  revocationListDer,
  type TrustRoot,
  type TrustRootsFile,
  toDer,
} from 'pdf-model';
import type { Translator } from 'pdf-shared';
import { useEffect, useRef } from 'react';
import { readAppFile, writeAppFile } from '../../drafts';
import { storageReasonKey } from '../../notices';
import { showNotice } from '../core/core-store';
import { createStore, type Equality, useStore } from '../store';

const ROOTS_FILE = 'trust-roots.json';
const LISTS_FILE = 'revocation-lists.json';

export interface TrustState {
  /** The trust roots the user imported. */
  readonly roots: readonly TrustRoot[];
  /** `roots` as bytes, for the verifier. */
  readonly rootBytes: readonly Uint8Array[];
  /** The CRLs the user imported. */
  readonly lists: readonly RevocationList[];
  /** `lists` as bytes, for the verifier. */
  readonly listBytes: readonly Uint8Array[];
}

export const trustStore = createStore<TrustState>({ roots: [], rootBytes: [], lists: [], listBytes: [] });

/** The part of the trust state a component reads (see `useStore` for the selector rules). */
export function useTrust<T>(selector: (state: TrustState) => T, equality?: Equality<T>): T {
  return useStore(trustStore, selector, equality);
}

function keepRoots(roots: readonly TrustRoot[]): void {
  trustStore.set({ roots, rootBytes: roots.map((root) => toDer(root)) });
}

function keepLists(lists: readonly RevocationList[]): void {
  trustStore.set({ lists, listBytes: lists.map((list) => revocationListDer(list)) });
}

/**
 * Read the stored roots and CRLs once, when the shell mounts. A read that lands after the shell
 * unmounted is dropped. A read the browser refuses leaves the list empty — certificate trust is
 * then "not checked" — and the user is told why it is empty rather than left to think nothing
 * was ever imported.
 */
function keepStoredRoots(raw: unknown): void {
  keepRoots(parseTrustRoots(raw).roots);
}

function keepStoredLists(raw: unknown): void {
  keepLists(parseRevocationLists(raw).lists);
}

/**
 * Read one settings file when the shell mounts, and say so when the browser refuses the read.
 * The translator is read through a ref, not an effect dependency: a language switch must not
 * read the file again — a read that began before a change was stored could land after it and put
 * the old roots back, and the store would stop being what the file holds.
 */
function useStoredFile(name: string, keep: (raw: unknown) => void, t: Translator): void {
  const translator = useRef(t);
  useEffect(() => {
    translator.current = t;
  }, [t]);
  useEffect(() => {
    let live = true;
    readAppFile(name)
      .then((raw) => {
        if (live) keep(raw);
      })
      .catch(() => {
        if (live) showNotice(translator.current('props.sig.storeUnreadable'));
      });
    return () => {
      live = false;
    };
  }, [name, keep]);
}

export function useStoredTrust(t: Translator): void {
  useStoredFile(ROOTS_FILE, keepStoredRoots, t);
  useStoredFile(LISTS_FILE, keepStoredLists, t);
}

/** The tail of the writes: the next change starts when the one before it has settled. */
let writes: Promise<unknown> = Promise.resolve();

/**
 * Store one change, then apply it. `derive` runs when the change's turn comes, against the state
 * the earlier changes left. A write that fails changes nothing and says why; the returned promise
 * never rejects, and resolves to whether the change landed.
 */
function change<File>(
  name: string,
  derive: () => File,
  keep: (file: File) => void,
  t: Translator,
): Promise<boolean> {
  const turn = writes.then(async () => {
    const file = derive();
    try {
      await writeAppFile(name, file);
    } catch (error) {
      showNotice(t('props.sig.storeFailed', { reason: t(storageReasonKey(error)) }));
      return false;
    }
    keep(file);
    return true;
  });
  writes = turn;
  return turn;
}

function rootsFile(derive: (file: TrustRootsFile) => TrustRootsFile): () => TrustRootsFile {
  return () => derive({ version: 1, roots: trustStore.get().roots });
}

function listsFile(derive: (file: RevocationListsFile) => RevocationListsFile): () => RevocationListsFile {
  return () => derive({ version: 1, lists: trustStore.get().lists });
}

/**
 * Store the roots the panel parsed. The parsing lives in the panel's chunk — it needs pkijs, and
 * the shell must not carry it (see `pdf-ui/panels/trust-roots.ts`). Resolves when the roots
 * are stored and in use, or the user was told they are not.
 */
export async function importTrustRoots(imported: readonly TrustRoot[], t: Translator): Promise<void> {
  const landed = await change(
    ROOTS_FILE,
    rootsFile((file) => imported.reduce(addTrustRoot, file)),
    (file) => keepRoots(file.roots),
    t,
  );
  if (landed) showNotice(t('props.sig.roots.added', { count: imported.length }));
}

export async function removeTrustRootById(id: string, t: Translator): Promise<void> {
  await change(
    ROOTS_FILE,
    rootsFile((file) => removeTrustRoot(file, id)),
    (file) => keepRoots(file.roots),
    t,
  );
}

/** The CRLs the panel parsed; they are stored as imported and judged when a signature is checked. */
export async function importRevocationLists(
  imported: readonly RevocationList[],
  t: Translator,
): Promise<void> {
  const landed = await change(
    LISTS_FILE,
    listsFile((file) => imported.reduce(addRevocationList, file)),
    (file) => keepLists(file.lists),
    t,
  );
  if (landed) showNotice(t('props.sig.crls.added', { count: imported.length }));
}

export async function removeRevocationListById(id: string, t: Translator): Promise<void> {
  await change(
    LISTS_FILE,
    listsFile((file) => removeRevocationList(file, id)),
    (file) => keepLists(file.lists),
    t,
  );
}
