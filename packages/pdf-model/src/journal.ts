/**
 * The single chronological operation journal (`PLAN.md §9/K12`, §3.2).
 *
 * One log per document. Every entry is **data** (engine, op kind, JSON payload,
 * schema version) — never functions, because the persisted draft goes through
 * structured cloning and functions do not survive it. `apply`/`revert`
 * behaviour lives in program code keyed by `op.kind`.
 *
 * What the journal guarantees:
 *  - strictly chronological undo/redo (`highlight → rotate → comment` undoes
 *    comment → rotate → highlight);
 *  - appending truncates the redo tail and reports which entries were dropped,
 *    so the owning engines can discard their own stale redo branches;
 *  - persistence and restore are lossless for entries plus the cursor.
 */

export type JournalEngine = 'model' | 'pdfjs-editor' | 'mupdf';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface JournalOperation {
  readonly kind: string;
  readonly payload: JsonValue;
}

export interface JournalEntry {
  readonly id: string;
  readonly seq: number;
  /** i18n key rendered in the user's language ("Rotated page 3"). */
  readonly labelKey: string;
  /** Params for `labelKey` (`{count}`, `{page}`); data only. */
  readonly labelParams?: JsonValue;
  readonly engine: JournalEngine;
  readonly op: JournalOperation;
  readonly schema: number;
  readonly timestamp: number;
}

export interface JournalSnapshot {
  readonly schema: number;
  readonly entries: readonly JournalEntry[];
  /** Number of entries currently applied (the rest form the redo tail). */
  readonly cursor: number;
}

/**
 * Entry schema. 2 added `labelParams` (the History panel shows "3 sayfa silindi",
 * which a bare key cannot express); a draft written by schema 1 is skipped by
 * `parseDraft` rather than misread (`PLAN.md §3.5`).
 */
export const JOURNAL_SCHEMA = 2;

export interface AppendResult {
  readonly entry: JournalEntry;
  /** Redo entries invalidated by this append — discard matching engine redo. */
  readonly discarded: readonly JournalEntry[];
}

export type JournalListener = (journal: OperationJournal) => void;

export class OperationJournal {
  #entries: JournalEntry[] = [];
  #cursor = 0;
  #listeners = new Set<JournalListener>();

  get entries(): readonly JournalEntry[] {
    return this.#entries;
  }

  /** Entries still ahead of the cursor (the redo tail). */
  get redoTail(): readonly JournalEntry[] {
    return this.#entries.slice(this.#cursor);
  }

  get length(): number {
    return this.#entries.length;
  }

  get cursor(): number {
    return this.#cursor;
  }

  get canUndo(): boolean {
    return this.#cursor > 0;
  }

  get canRedo(): boolean {
    return this.#cursor < this.#entries.length;
  }

  subscribe(listener: JournalListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  append(input: Omit<JournalEntry, 'id' | 'seq' | 'schema' | 'timestamp'>): AppendResult {
    const discarded = this.redoTail;
    /**
     * A **new array**, never `length =` on the old one.
     *
     * `entries` hands the array out by reference — the draft writer reads it, a React
     * subscription may compare it, and `undo`/`redo` read it across an `await`. Truncating
     * and pushing in place therefore rewrote history that callers already held: a snapshot
     * taken before an append silently became a different array, and the branch's abandoned
     * redo entries stayed visible in it (`F11`).
     */
    const kept = discarded.length > 0 ? this.#entries.slice(0, this.#cursor) : this.#entries;
    const entry: JournalEntry = {
      ...input,
      id: crypto.randomUUID(),
      seq: kept.length,
      schema: JOURNAL_SCHEMA,
      timestamp: Date.now(),
    };
    this.#entries = [...kept, entry];
    this.#cursor = this.#entries.length;
    this.#notify();
    return { entry, discarded };
  }

  /**
   * Replace the newest entry's operation in place of appending a new one, so a burst of
   * one kind of edit (the keystrokes of a form value) stays a single undo step. Allowed
   * only at the head of the history (no redo tail); the amended entry gets a fresh id,
   * because the id is what tells an edited state from a saved one. `undefined` when
   * there is nothing to amend.
   */
  amendLast(op: JournalOperation): JournalEntry | undefined {
    const last = this.#entries[this.#cursor - 1];
    if (last === undefined || this.#cursor !== this.#entries.length) return undefined;
    const entry: JournalEntry = { ...last, op, id: crypto.randomUUID(), timestamp: Date.now() };
    this.#entries = [...this.#entries.slice(0, -1), entry];
    this.#notify();
    return entry;
  }

  undo(): JournalEntry | undefined {
    if (!this.canUndo) return undefined;
    this.#cursor -= 1;
    this.#notify();
    const entry = this.#entries[this.#cursor];
    return entry;
  }

  redo(): JournalEntry | undefined {
    if (!this.canRedo) return undefined;
    const entry = this.#entries[this.#cursor];
    this.#cursor += 1;
    this.#notify();
    return entry;
  }

  /** Drop everything (document closed / new session) — not an undoable action. */
  clear(): void {
    this.#entries = [];
    this.#cursor = 0;
    this.#notify();
  }

  toJSON(): JournalSnapshot {
    return { schema: JOURNAL_SCHEMA, entries: this.#entries, cursor: this.#cursor };
  }

  static fromJSON(snapshot: JournalSnapshot): OperationJournal {
    if (snapshot.schema !== JOURNAL_SCHEMA) {
      throw new Error(`journal schema ${snapshot.schema} is not readable by this build`);
    }
    // A cursor outside the array is corruption, not something to clamp: clamping it would
    // silently move the restored document to a different state than the one the user left
    // (`F09`). `parseDraft` rejects such a draft before it gets here; this is the second
    // line of defence for a caller that builds a snapshot itself.
    if (
      !Number.isSafeInteger(snapshot.cursor) ||
      snapshot.cursor < 0 ||
      snapshot.cursor > snapshot.entries.length
    ) {
      throw new Error(`journal cursor ${snapshot.cursor} is outside 0…${snapshot.entries.length}`);
    }
    const journal = new OperationJournal();
    journal.#entries = [...snapshot.entries];
    journal.#cursor = snapshot.cursor;
    return journal;
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this);
  }
}
