/**
 * The retention policy for the browser vault.
 *
 * This module is **policy, not storage**: it decides which blob keys *may* be deleted,
 * and it is deliberately free of the DOM so the decision can be checked without a
 * browser. `apps/web/src/drafts.ts` performs the I/O it describes.
 *
 * ## What the vault holds
 *
 * - One manifest per persisted document: `drafts/<id>.json`.
 * - One content-addressed blob per distinct source document: `sources/src-<sha256>.pdf`.
 *   Two tabs, two windows or two sessions that open the same document share that one
 *   blob — which is why a key that looks unreferenced from one document's point of view
 *   is not necessarily garbage.
 * - One blob per retained working snapshot: `sources/snapshot-<id>.pdf`.
 *
 * ## The policy, and why each rule is the safe one
 *
 * 1. **Sensitive documents are never persisted.** `keysForDraft` is the only place that
 *    answers “what does this document own”, and a sensitive document owns nothing.
 * 2. **Uncertain references retain.** A key is deletable only when the whole inventory
 *    was read and it is referenced by nothing: no manifest, no other open document, and
 *    no other window that said so. A failed enumeration or one unreadable manifest makes
 *    the plan *refuse* rather than sweep — the alternative deletes a live document's only
 *    copy to reclaim space.
 * 3. **Deletion is logical, not physical.** Removing a row from the origin-private file
 *    system does not overwrite the bytes underneath, and it cannot reach a copy the user
 *    downloaded, opened from disk, or that the browser put in a backup. The UI must not
 *    describe it as secure erasure.
 */

import type { Draft, DraftInventory } from './drafts';

/** Every vault key one persisted document owns: its source blob plus its snapshots'. */
export function keysForDraft(draft: Draft): readonly string[] {
  return [draft.sourceKey, ...(draft.snapshots ?? []).map((snapshot) => snapshot.key)];
}

/**
 * The keys a single document owns *right now*, for the scoped cleanup the user asks for
 * by name. Answers the question for the document in front of them, not for the vault.
 */
export interface DocumentRetention {
  /** The manifest to remove. */
  readonly manifestId: string;
  /** The blobs that may be removed when nothing else references them. */
  readonly keys: readonly string[];
}

/** The blob keys one open document currently holds in memory. */
export interface OpenDocumentKeys {
  readonly source: string;
  readonly snapshots: readonly string[];
}

export interface VaultCleanupInput {
  /** What every document open in **this** window references. */
  readonly open: readonly OpenDocumentKeys[];
  /** What storage currently holds, verbatim — never a guess from a prior read. */
  readonly storedSources: readonly string[];
  /** The manifest inventory, including how complete it was. */
  readonly inventory: DraftInventory;
  /** Keys another window reported as live (`vault-channel.ts`), when the channel exists. */
  readonly peerReferences?: readonly string[];
}

export type VaultCleanupPlan =
  | { readonly ok: true; readonly deleteKeys: readonly string[]; readonly retained: number }
  | { readonly ok: false; readonly reason: 'incomplete-inventory' };

/**
 * Which stored blobs may be deleted, or a refusal.
 *
 * The refusal is the important half. `enumerationFailed` means the directory could not be
 * listed and `unreadable` means a manifest exists that this run could not understand —
 * either way the reference graph is unknown, so *nothing* is deleted and the caller says
 * so. Orphan bytes cost space; deleted live bytes cost the user a document.
 */
export function planVaultCleanup(input: VaultCleanupInput): VaultCleanupPlan {
  if (input.inventory.enumerationFailed === true || input.inventory.unreadable.length > 0) {
    return { ok: false, reason: 'incomplete-inventory' };
  }
  const referenced = new Set<string>();
  for (const document of input.open) {
    referenced.add(document.source);
    for (const key of document.snapshots) referenced.add(key);
  }
  for (const draft of input.inventory.drafts) {
    for (const key of keysForDraft(draft)) referenced.add(key);
  }
  for (const key of input.peerReferences ?? []) referenced.add(key);

  const stored = new Set(input.storedSources);
  const deleteKeys = [...stored].filter((key) => !referenced.has(key));
  return { ok: true, deleteKeys, retained: stored.size - deleteKeys.length };
}

/**
 * The keys that may go when one document is cleaned up on the user's request.
 *
 * The rule is the same as the sweep's, scoped: a key the document owns is removable only
 * when no *other* manifest, no open document and no other window still references it.
 * `null` means the inventory was incomplete and the caller must not delete anything.
 */
export function planDocumentCleanup(
  target: DocumentRetention,
  input: VaultCleanupInput,
): readonly string[] | null {
  if (input.inventory.enumerationFailed === true || input.inventory.unreadable.length > 0) return null;
  const referenced = new Set<string>();
  for (const document of input.open) {
    referenced.add(document.source);
    for (const key of document.snapshots) referenced.add(key);
  }
  for (const draft of input.inventory.drafts) {
    if (draft.id === target.manifestId) continue;
    for (const key of keysForDraft(draft)) referenced.add(key);
  }
  for (const key of input.peerReferences ?? []) referenced.add(key);
  return target.keys.filter((key) => !referenced.has(key));
}
