/**
 * The words a document's applied redactions removed.
 *
 * The audit's question is "does this file still carry what was erased", and the marks
 * themselves cannot answer it: a `RedactRect` is geometry, and the words under it are
 * gone from the working bytes the moment the redaction lands. So they are read once,
 * from the bytes the redaction ran on, and kept per tab until the tab is closed.
 */

import { createStore } from '../store';

export interface RedactionState {
  /** The erased words by tab id. Replaced, never mutated. */
  readonly erased: ReadonlyMap<string, readonly string[]>;
}

/** The state a fresh page starts in. */
export function initialRedactionState(): RedactionState {
  return { erased: new Map() };
}

export const redactionStore = createStore<RedactionState>(initialRedactionState());

/** A redaction on `tabId` removed `terms`: they join what was erased before; none changes nothing. */
export function redactedWordsRead(tabId: string, terms: readonly string[]): void {
  if (terms.length === 0) return;
  redactionStore.set((state) => ({
    erased: new Map(state.erased).set(tabId, [...new Set([...(state.erased.get(tabId) ?? []), ...terms])]),
  }));
}

/** The tab is closed: what its redactions erased is no longer asked about. */
export function redactedWordsForgotten(tabId: string): void {
  redactionStore.set((state) => {
    if (!state.erased.has(tabId)) return {};
    const next = new Map(state.erased);
    next.delete(tabId);
    return { erased: next };
  });
}

/** The words `tabId`'s applied redactions removed. */
export function erasedWordsOf(tabId: string): readonly string[] {
  return redactionStore.get().erased.get(tabId) ?? [];
}
