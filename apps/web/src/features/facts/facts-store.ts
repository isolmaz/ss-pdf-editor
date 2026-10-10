/**
 * The facts the properties panel shows about the document on screen: fonts, embedded files,
 * security and the four-state signature verdict. They are read per working version — a font
 * list from a previous version is not a fact about this one — so every fact is tagged with the
 * tab and version it was read from, and a reader only sees the facts that match the tab it asks
 * about.
 */

import type { PdfFontInfo, SignatureVerification } from 'pdf-core';
import type { SessionTab } from 'pdf-model';
import type { ToolError } from 'pdf-shared';
import type { AttachmentRow } from 'pdf-ui';
import { createStore, useStore } from '../store';

export interface DocumentFacts {
  readonly tabId: string;
  readonly version: string;
  readonly fonts: readonly PdfFontInfo[];
  readonly attachments: readonly AttachmentRow[];
  readonly signatures: readonly SignatureVerification[];
  readonly security: { readonly encrypted: boolean; readonly permissions: readonly string[] };
}

export interface FactsFailure {
  readonly tabId: string;
  readonly version: string;
  readonly error: ToolError;
}

export interface FactsState {
  /** What the last read found; `null` while it is being read or when there is no document. */
  readonly facts: DocumentFacts | null;
  /** Why the last read failed. */
  readonly failure: FactsFailure | null;
}

export const factsStore = createStore<FactsState>({ facts: null, failure: null });

/** A read starts (or there is no document): nothing is known, and nothing has failed. */
export function factsReading(): void {
  factsStore.set({ facts: null, failure: null });
}

export function factsRead(facts: DocumentFacts): void {
  factsStore.set({ facts });
}

export function factsFailed(failure: FactsFailure): void {
  factsStore.set({ failure });
}

function factsOf(facts: DocumentFacts | null, tab: SessionTab | null): DocumentFacts | null {
  return facts !== null && tab !== null && facts.tabId === tab.id && facts.version === tab.working.id
    ? facts
    : null;
}

function failureOf(failure: FactsFailure | null, tab: SessionTab | null): ToolError | null {
  return failure !== null && tab !== null && failure.tabId === tab.id && failure.version === tab.working.id
    ? failure.error
    : null;
}

/** The facts of `tab`'s current working version, or `null` when they are not read yet. */
export function currentFacts(tab: SessionTab | null): DocumentFacts | null {
  return factsOf(factsStore.get().facts, tab);
}

/** Why reading `tab`'s current version failed, or `null`. */
export function currentFactsError(tab: SessionTab | null): ToolError | null {
  return failureOf(factsStore.get().failure, tab);
}

/** `currentFacts`, read by a component: it renders again when the facts or `tab` change. */
export function useCurrentFacts(tab: SessionTab | null): DocumentFacts | null {
  return factsOf(
    useStore(factsStore, (state) => state.facts),
    tab,
  );
}

/** `currentFactsError`, read by a component. */
export function useCurrentFactsError(tab: SessionTab | null): ToolError | null {
  return failureOf(
    useStore(factsStore, (state) => state.failure),
    tab,
  );
}
