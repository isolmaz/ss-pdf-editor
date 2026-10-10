/**
 * The certificates and revocation lists the user imported to judge signatures with.
 *
 * They live in the app's own OPFS directory — a device setting, never a document fact — and the
 * signature verdicts re-run when either list changes, because a trust decision is exactly what a
 * re-check is for (an imported CRL is what turns "indeterminate" into an answer). The DER bytes
 * the verifier takes are derived with the list, so a consumer's effect depends on them by
 * identity: they change exactly when the list does.
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
import { useEffect } from 'react';
import { readAppFile, writeAppFile } from '../../drafts';
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
 * unmounted is dropped.
 */
export function useStoredTrust(): void {
  useEffect(() => {
    let live = true;
    void readAppFile(ROOTS_FILE).then((raw) => {
      if (live) keepRoots(parseTrustRoots(raw).roots);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    void readAppFile(LISTS_FILE).then((raw) => {
      if (live) keepLists(parseRevocationLists(raw).lists);
    });
    return () => {
      live = false;
    };
  }, []);
}

/**
 * Store the roots the panel parsed. The parsing lives in the panel's chunk — it needs pkijs, and
 * the shell must not carry it (see `pdf-ui/panels/trust-roots.ts`).
 */
export function importTrustRoots(imported: readonly TrustRoot[], t: Translator): void {
  let next: TrustRootsFile = { version: 1, roots: trustStore.get().roots };
  for (const root of imported) next = addTrustRoot(next, root);
  keepRoots(next.roots);
  void writeAppFile(ROOTS_FILE, next);
  showNotice(t('props.sig.roots.added', { count: imported.length }));
}

export function removeTrustRootById(id: string): void {
  const next = removeTrustRoot({ version: 1, roots: trustStore.get().roots }, id);
  keepRoots(next.roots);
  void writeAppFile(ROOTS_FILE, next);
}

/** The CRLs the panel parsed; they are stored as imported and judged when a signature is checked. */
export function importRevocationLists(imported: readonly RevocationList[], t: Translator): void {
  let next: RevocationListsFile = { version: 1, lists: trustStore.get().lists };
  for (const list of imported) next = addRevocationList(next, list);
  keepLists(next.lists);
  void writeAppFile(LISTS_FILE, next);
  showNotice(t('props.sig.crls.added', { count: imported.length }));
}

export function removeRevocationListById(id: string): void {
  const next = removeRevocationList({ version: 1, lists: trustStore.get().lists }, id);
  keepLists(next.lists);
  void writeAppFile(LISTS_FILE, next);
}
