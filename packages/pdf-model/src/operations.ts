/**
 * Applied operations and the version snapshots that make them undoable
 * (`PLAN.md §3.2`, §3.5, §9/K12).
 *
 * **Why one op kind.** Every Phase 2 capability — page delete, rotate, stamp,
 * OCR, redaction, encryption — ends the same way: the working document becomes
 * a *new* PDF. `PLAN.md §3.3` calls that a writer step, and `K12` allows
 * engine-opaque operations to revert through the nearest **working-version
 * snapshot** rather than through a replayable payload. So the journal stores the
 * data-only fact "the working document's bytes were replaced (before → after)"
 * and keeps the bytes themselves in the tab's snapshot store, keyed by id.
 *
 * That gives one uniform, honest rule:
 *  - undo/redo move between snapshots (and back to the source master for
 *    `before: null`), so chronological order is preserved across engines;
 *  - a snapshot the session no longer holds makes the step **unavailable**, and
 *    the UI says so instead of replaying a payload onto the wrong base (§3.5);
 *  - structural page edits (reorder/delete/duplicate/insert) are materialized
 *    through `extractPages` *when they are applied*, so what the viewer shows is
 *    what the file holds — a page delete does not wait for a save to become real.
 */

import type { MessageKey } from 'pdf-shared';
import type { JournalEntry, JsonValue } from './journal';

/** The journal op kind Phase 2 writes. Data only — never functions (`K12`). */
export const DOCUMENT_CHANGE_KIND = 'document.change';

export interface DocumentChangePayload {
  /** Snapshot id of the bytes in effect before the operation; `null` = the source master. */
  readonly before: string | null;
  readonly beforeOverlays?: JsonValue;
  /** Pending values left after materialization; absent in legacy entries means none. */
  readonly afterOverlays?: JsonValue;
  /** Snapshot id of the bytes the operation produced. */
  readonly after: string;
  /** What the producing engine did, for the History panel and the save report. */
  readonly engine: string;
  readonly steps: readonly string[];
}

/** Bytes produced by an applied operation; held for undo/redo and for saving. */
export interface ProducedDocument {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** Size of the document this one replaced, so the report can show the delta. */
  readonly inputBytes: number;
  readonly labelKey: MessageKey;
  readonly labelParams?: Readonly<Record<string, string | number>>;
}

/**
 * What a journal step asks the caller to do. `pdf-model` never touches an
 * engine: it reports the state change and the app re-materializes the viewer.
 */
export type HistoryStep =
  | {
      readonly kind: 'document';
      /** Snapshot the viewer must now show; `null` = the untouched source master. */
      readonly produced: ProducedDocument | null;
      readonly pageCount: number;
      readonly entry: JournalEntry;
    }
  | { readonly kind: 'overlays'; readonly entry: JournalEntry }
  | { readonly kind: 'unavailable'; readonly entry: JournalEntry };

export type HistoryResult =
  | { readonly kind: 'done'; readonly step: HistoryStep; readonly direction: 'undo' | 'redo' }
  | { readonly kind: 'empty' };

/**
 * Snapshot retention budget. Undo history is worth memory, but never unbounded:
 * a 100 MB document keeps its most recent versions inside `max(3 × file, 64 MB)`
 * and older steps are reported as unavailable rather than silently dropped.
 */
export const SNAPSHOT_BUDGET = {
  minBytes: 64 * 1024 * 1024,
  factor: 3,
  /**
   * Always keep this many newest snapshots, whatever the budget says. The floor is what
   * makes a single undo always possible; it is also what lets a document whose versions
   * are each larger than the budget exceed it, which `tools/measure` reports as a number
   * rather than hiding. There is exactly **one** of these constants — a second copy in
   * `session.ts` had drifted to a different value (`R09`).
   */
  keepNewest: 2,
} as const;

export function snapshotBudgetFor(documentBytes: number): number {
  return Math.max(SNAPSHOT_BUDGET.minBytes, documentBytes * SNAPSHOT_BUDGET.factor);
}
