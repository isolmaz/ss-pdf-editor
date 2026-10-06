/**
 * Session store (`PLAN.md §9/K23`, §3.2).
 *
 * Document/session state lives here — plain TypeScript, DOM-free, observable —
 * **not** in a store library. React subscribes through `useSyncExternalStore`.
 * The store owns model data only (source, working version, journal, dirty flag);
 * engine handles stay with the caller, because `pdf-model` never talks to an
 * engine and stays Node-testable.
 *
 * Snapshots are immutable and cached: a subscriber compares references, so the
 * store only allocates when something actually changed.
 */

import type { MessageKey } from 'pdf-shared';
import { ToolError } from 'pdf-shared';
import type { Draft } from './drafts';
import type { JournalEntry, JsonValue } from './journal';
import { JOURNAL_SCHEMA, OperationJournal } from './journal';
import {
  DOCUMENT_CHANGE_KIND,
  type DocumentChangePayload,
  type HistoryResult,
  type HistoryStep,
  type ProducedDocument,
  SNAPSHOT_BUDGET,
  snapshotBudgetFor,
} from './operations';
import {
  createSourceDocument,
  createWorkingVersion,
  type OutputVersion,
  type PageRef,
  type Rotation,
  type SourceDocument,
  type WorkingVersion,
} from './source';

export interface SessionTab {
  readonly id: string;
  readonly name: string;
  readonly source: SourceDocument;
  readonly working: WorkingVersion;
  readonly outputs: readonly OutputVersion[];
  readonly journal: OperationJournal;
  readonly dirty: boolean;
  /** Journal state last successfully written; null means an unknown legacy baseline. */
  readonly savedState: string | null;
  /** Sensitive session: persistent drafts off (`K16`). */
  readonly sensitive: boolean;
}

export interface SessionSnapshot {
  readonly tabs: readonly SessionTab[];
  readonly activeId: string | null;
}

export interface OpenDocumentInput {
  readonly id?: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly pageCount: number;
  readonly handle?: FileSystemFileHandle;
}

export interface ApplyOperationInput {
  readonly tabId: string;
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly labelKey: MessageKey;
  readonly labelParams?: Readonly<Record<string, string | number>>;
  /** Engine that produced the bytes, for the save report and the History panel. */
  readonly engine: string;
  readonly steps: readonly string[];
  /** Complete pending state left by this operation, never inferred by the model. */
  readonly overlays: JsonValue;
}

export class SessionStore {
  #tabs: SessionTab[] = [];
  #activeId: string | null = null;
  #snapshot: SessionSnapshot = { tabs: [], activeId: null };
  #listeners = new Set<() => void>();
  /** Produced-bytes snapshots per tab, oldest first (bounded, `operations.ts`). */
  #productions = new Map<string, ProducedDocument[]>();

  readonly getSnapshot = (): SessionSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  get active(): SessionTab | null {
    return this.#tabs.find((tab) => tab.id === this.#activeId) ?? null;
  }

  openDocument(input: OpenDocumentInput): SessionTab {
    const source = createSourceDocument({
      name: input.name,
      master: input.bytes,
      sha256: input.sha256,
      pageCount: input.pageCount,
      ...(input.handle === undefined ? {} : { handle: input.handle }),
    });
    const tab: SessionTab = {
      id: input.id ?? source.id,
      name: input.name,
      source,
      working: createWorkingVersion(source),
      outputs: [],
      journal: new OperationJournal(),
      dirty: false,
      savedState: 'source',
      sensitive: false,
    };
    this.#tabs = [...this.#tabs, tab];
    this.#activeId = tab.id;
    this.#publish();
    return tab;
  }

  closeTab(id: string): void {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    this.#tabs = this.#tabs.filter((tab) => tab.id !== id);
    this.#productions.delete(id);
    if (this.#activeId === id) {
      const fallback = this.#tabs[index] ?? this.#tabs[index - 1] ?? null;
      this.#activeId = fallback?.id ?? null;
    }
    this.#publish();
  }

  setActive(id: string): void {
    if (this.#activeId === id) return;
    if (!this.#tabs.some((tab) => tab.id === id)) return;
    this.#activeId = id;
    this.#publish();
  }

  /** `dirty` flips back only when a write for that exact version succeeded (§3.3/6). */
  setDirty(id: string, dirty: boolean): void {
    if (!this.#tabs.some((tab) => tab.id === id && tab.dirty !== dirty)) return;
    this.#tabs = this.#tabs.map((tab) => {
      if (tab.id !== id) return tab;
      return dirty
        ? { ...tab, dirty, working: { ...tab.working, stateId: crypto.randomUUID() } }
        : { ...tab, dirty, savedState: tab.working.stateId };
    });
    this.#publish();
  }

  /** Tab title. Not a document change: renaming is not journaled (`§3.5`). */
  renameTab(id: string, name: string): void {
    this.#tabs = this.#tabs.map((tab) => (tab.id === id ? { ...tab, name } : tab));
    this.#publish();
  }

  /** Sensitive session: persistent drafts off (`K16`). */
  setSensitive(id: string, sensitive: boolean): void {
    this.#tabs = this.#tabs.map((tab) => (tab.id === id ? { ...tab, sensitive } : tab));
    this.#publish();
  }

  /** Associate or update a FileSystemFileHandle for in-place save. */
  setHandle(id: string, handle: FileSystemFileHandle): void {
    this.#tabs = this.#tabs.map((tab) =>
      tab.id === id ? { ...tab, source: { ...tab.source, handle } } : tab,
    );
    this.#publish();
  }

  /** Output history — what was written where (`§3.5`, closes `REPORT.md §4.19`). */
  addOutput(id: string, output: OutputVersion): void {
    this.#tabs = this.#tabs.map((tab) =>
      tab.id === id
        ? {
            ...tab,
            outputs: [...tab.outputs, output],
            savedState: output.fromState,
            dirty: tab.working.stateId !== output.fromState,
          }
        : tab,
    );
    this.#publish();
  }

  /**
   * Record an applied operation (`operations.ts`): keep its bytes for undo/redo,
   * append the data-only journal entry, and make the produced document the
   * working version the viewer and the save path both read.
   */
  applyOperation(input: ApplyOperationInput): ProducedDocument {
    const tab = this.#tabs.find((candidate) => candidate.id === input.tabId);
    if (tab === undefined) throw new ToolError('internal', { engine: 'model', engineMessage: 'unknown tab' });
    const previous = tab.working.produced;
    const produced: ProducedDocument = {
      id: crypto.randomUUID(),
      bytes: input.bytes,
      pageCount: input.pageCount,
      inputBytes: previous?.bytes.byteLength ?? tab.source.size,
      labelKey: input.labelKey,
      ...(input.labelParams === undefined ? {} : { labelParams: input.labelParams }),
    };
    /**
     * Bytes first, budget second — and the *abandoned* branch is released before the
     * budget is applied. Applying a byte budget over a list that still holds the redo
     * snapshots this append is about to invalidate counted unreachable bytes as if they
     * were live, and evicted reachable history to pay for them (`F11`).
     */
    const appended = tab.journal.append({
      labelKey: input.labelKey,
      ...(input.labelParams === undefined ? {} : { labelParams: input.labelParams as JsonValue }),
      // The model owns snapshot undo; payload.engine names the actual byte writer.
      engine: 'model',
      op: {
        kind: DOCUMENT_CHANGE_KIND,
        payload: {
          before: previous?.id ?? null,
          beforeOverlays: tab.working.overlays ?? null,
          afterOverlays: input.overlays,
          after: produced.id,
          engine: input.engine,
          steps: [...input.steps],
        } satisfies DocumentChangePayload,
      },
    });
    if (appended.discarded.length > 0) this.#releaseDiscarded(tab.id, appended.discarded);
    this.#remember(tab.id, produced);
    this.#setWorking(tab.id, produced, input.pageCount, input.overlays);
    // The subscribers must hear about it: `#setWorking` replaces `#tabs`, and the
    // cached snapshot is what `useSyncExternalStore` compares — without this the
    // status bar keeps the previous page count while the panel (fed by the engine
    // handle) already shows the new one.
    this.#publish();
    return produced;
  }

  snapshotsFor(tabId: string): readonly ProducedDocument[] {
    return this.#productions.get(tabId) ?? [];
  }

  restoreHistory(tabId: string, draft: Draft, snapshots: readonly ProducedDocument[]): void {
    const tab = this.#tabs.find((item) => item.id === tabId);
    if (tab === undefined) return;
    this.#productions.set(tabId, [...snapshots]);
    const produced = snapshots.find((item) => item.id === draft.workingId) ?? null;
    this.#tabs = this.#tabs.map((item) =>
      item.id !== tabId
        ? item
        : {
            ...item,
            savedState:
              draft.savedState === undefined
                ? draft.dirty
                  ? null
                  : (draft.stateId ??
                    draft.journal[(draft.journalCursor ?? draft.journal.length) - 1]?.id ??
                    'source')
                : draft.savedState,
            journal: OperationJournal.fromJSON({
              schema: JOURNAL_SCHEMA,
              entries: draft.journal,
              cursor: draft.journalCursor ?? draft.journal.length,
            }),
          },
    );
    this.#setWorking(tabId, produced, produced?.pageCount ?? tab.source.pageCount, draft.overlays);
    if (draft.stateId !== undefined) {
      this.#tabs = this.#tabs.map((item) =>
        item.id !== tabId
          ? item
          : {
              ...item,
              working: { ...item.working, stateId: draft.stateId as string },
              dirty: draft.stateId !== item.savedState,
            },
      );
    }
    this.#publish();
  }

  /**
   * Canvas edits share the same chronological journal as byte-producing operations.
   *
   * With `coalesceWithinMs`, an edit that follows an edit of the same label within that
   * window amends that step instead of adding one: typing "Acme" into a form field is one
   * undo step, not four. A step that is the saved state, or that has a redo tail after
   * it, is never amended, so undo can still return to exactly what was saved.
   */
  setOverlays(
    tabId: string,
    overlays: JsonValue,
    labelKey: MessageKey,
    options: { readonly coalesceWithinMs?: number } = {},
  ): void {
    const tab = this.#tabs.find((item) => item.id === tabId);
    if (tab === undefined || tab.working.overlays === overlays) return;
    const last = tab.journal.entries[tab.journal.cursor - 1];
    if (
      options.coalesceWithinMs !== undefined &&
      last !== undefined &&
      !tab.journal.canRedo &&
      last.labelKey === labelKey &&
      last.op.kind === 'document.overlays' &&
      last.id !== tab.savedState &&
      Date.now() - last.timestamp <= options.coalesceWithinMs
    ) {
      const before = (last.op.payload as { readonly before: JsonValue }).before;
      tab.journal.amendLast({ kind: 'document.overlays', payload: { before, after: overlays } });
      this.#setOverlays(tabId, overlays);
      this.#publish();
      return;
    }
    /**
     * An overlay edit is a journal entry like any other, so it invalidates the redo tail
     * the same way an operation does — including the produced documents that tail pointed
     * at. Releasing them only in `applyOperation` left an overlay-only branch holding
     * snapshots nothing could reach, and the byte budget was then applied over them
     * (`F11`).
     */
    const appended = tab.journal.append({
      labelKey,
      engine: 'model',
      op: { kind: 'document.overlays', payload: { before: tab.working.overlays ?? null, after: overlays } },
    });
    if (appended.discarded.length > 0) this.#releaseDiscarded(tabId, appended.discarded);
    this.#setOverlays(tabId, overlays);
    this.#publish();
  }

  #setOverlays(tabId: string, overlays: JsonValue): void {
    this.#tabs = this.#tabs.map((tab) =>
      tab.id !== tabId
        ? tab
        : {
            ...tab,
            dirty: this.#stateId(tab) !== tab.savedState,
            working: { ...tab.working, id: crypto.randomUUID(), stateId: this.#stateId(tab), overlays },
          },
    );
  }

  /** Newest produced bytes for a tab, or `null` when the working version is the source. */
  producedFor(tabId: string): ProducedDocument | null {
    return this.#tabs.find((tab) => tab.id === tabId)?.working.produced ?? null;
  }

  /**
   * Chronological undo (`K12`). The store moves its own state and reports what
   * the viewer must show; the app re-materializes the engine handle from
   * `step.produced` (or the source master when it is `null`).
   */
  undo(tabId: string): HistoryResult {
    return this.#move(tabId, 'undo');
  }

  redo(tabId: string): HistoryResult {
    return this.#move(tabId, 'redo');
  }

  /** Resolve the next history target without moving the cursor or publishing state. */
  previewHistory(tabId: string, direction: 'undo' | 'redo'): HistoryResult {
    const tab = this.#tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return { kind: 'empty' };
    const index = direction === 'undo' ? tab.journal.cursor - 1 : tab.journal.cursor;
    const entry = tab.journal.entries[index];
    if (entry === undefined) return { kind: 'empty' };
    return { kind: 'done', step: this.#stepFor(tab, entry, direction, false), direction };
  }

  #move(tabId: string, direction: 'undo' | 'redo'): HistoryResult {
    const tab = this.#tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return { kind: 'empty' };
    const preview = this.previewHistory(tabId, direction);
    if (preview.kind === 'empty' || preview.step.kind === 'unavailable') return preview;
    const entry = direction === 'undo' ? tab.journal.undo() : tab.journal.redo();
    if (entry === undefined) return { kind: 'empty' };
    const step = this.#stepFor(tab, entry, direction);
    this.#publish();
    return { kind: 'done', step, direction };
  }

  #stepFor(tab: SessionTab, entry: JournalEntry, direction: 'undo' | 'redo', apply = true): HistoryStep {
    if (entry.op.kind === 'document.overlays') {
      const state = entry.op.payload as { before: JsonValue; after: JsonValue };
      if (apply) this.#setOverlays(tab.id, direction === 'undo' ? state.before : state.after);
      return { kind: 'overlays', entry };
    }
    if (entry.op.kind !== DOCUMENT_CHANGE_KIND) return { kind: 'unavailable', entry };
    const payload = entry.op.payload as DocumentChangePayload | null;
    if (payload === null || typeof payload !== 'object' || !('after' in payload)) {
      return { kind: 'unavailable', entry };
    }
    const id = direction === 'undo' ? payload.before : payload.after;
    if (id === null) {
      if (apply) this.#setWorking(tab.id, null, tab.source.pageCount, payload.beforeOverlays);
      return { kind: 'document', produced: null, pageCount: tab.source.pageCount, entry };
    }
    const produced = this.#find(tab.id, id);
    if (produced === null) return { kind: 'unavailable', entry };
    if (apply) {
      this.#setWorking(
        tab.id,
        produced,
        produced.pageCount,
        direction === 'undo' ? payload.beforeOverlays : payload.afterOverlays,
      );
    }
    return { kind: 'document', produced, pageCount: produced.pageCount, entry };
  }

  #setWorking(
    tabId: string,
    produced: ProducedDocument | null,
    pageCount: number,
    overlays?: JsonValue,
  ): void {
    this.#tabs = this.#tabs.map((tab) => {
      if (tab.id !== tabId) return tab;
      const working: WorkingVersion = {
        id: crypto.randomUUID(),
        stateId: this.#stateId(tab),
        fromSources: [produced === null ? tab.source.id : produced.id],
        pageOrder: identityPages(produced === null ? tab.source.id : produced.id, pageCount),
        ...(produced === null ? {} : { produced }),
        ...(overlays == null ? {} : { overlays }),
      };
      return { ...tab, working, dirty: working.stateId !== tab.savedState };
    });
  }

  #stateId(tab: SessionTab): string {
    return tab.journal.entries[tab.journal.cursor - 1]?.id ?? 'source';
  }

  /**
   * Drops the produced documents a new branch made unreachable.
   *
   * Only the snapshots the discarded entries actually pointed at are released: an entry
   * may name a document that an earlier, still-reachable entry also names, and releasing
   * that one would break `undo` to a state the user can still walk back to.
   */
  #releaseDiscarded(tabId: string, discarded: readonly JournalEntry[]): void {
    const unreachable = new Set<string>();
    for (const entry of discarded) {
      const payload = entry.op.payload as Partial<DocumentChangePayload> | undefined;
      if (entry.op.kind !== DOCUMENT_CHANGE_KIND || typeof payload?.after !== 'string') continue;
      unreachable.add(payload.after);
    }
    if (unreachable.size === 0) return;

    /**
     * What is still reachable: every version named by an entry **before the cursor**, plus
     * the working version. Entries at or after the cursor are the redo tail, and the caller
     * has just discarded it — counting them here would keep the very bytes this is meant to
     * release. An entry naming the same document on both sides keeps it reachable, which is
     * the case a branch that re-lands on an earlier state depends on.
     */
    const tab = this.#tabs.find((candidate) => candidate.id === tabId);
    const reachable = new Set<string>();
    const entries = tab?.journal.entries ?? [];
    const cursor = tab?.journal.cursor ?? 0;
    for (let index = 0; index < cursor; index += 1) {
      const entry = entries[index];
      if (entry === undefined || entry.op.kind !== DOCUMENT_CHANGE_KIND) continue;
      const payload = entry.op.payload as Partial<DocumentChangePayload> | undefined;
      if (typeof payload?.before === 'string') reachable.add(payload.before);
      if (typeof payload?.after === 'string') reachable.add(payload.after);
    }
    const working = tab?.working.produced?.id;
    if (working !== undefined) reachable.add(working);

    const kept = (this.#productions.get(tabId) ?? []).filter(
      (item) => reachable.has(item.id) || !unreachable.has(item.id),
    );
    this.#productions.set(tabId, kept);
  }

  #remember(tabId: string, produced: ProducedDocument): void {
    const kept = [...(this.#productions.get(tabId) ?? []), produced];
    const budget = snapshotBudgetFor(produced.bytes.byteLength);
    let total = kept.reduce((sum, item) => sum + item.bytes.byteLength, 0);
    while (kept.length > SNAPSHOT_BUDGET.keepNewest && total > budget) {
      const dropped = kept.shift();
      if (dropped === undefined) break;
      total -= dropped.bytes.byteLength;
    }
    this.#productions.set(tabId, kept);
  }

  #find(tabId: string, id: string): ProducedDocument | null {
    return (this.#productions.get(tabId) ?? []).find((item) => item.id === id) ?? null;
  }

  #publish(): void {
    this.#snapshot = { tabs: this.#tabs, activeId: this.#activeId };
    for (const listener of this.#listeners) listener();
  }
}

function identityPages(sourceId: string, pageCount: number): PageRef[] {
  return Array.from(
    { length: pageCount },
    (_unused, index): PageRef => ({
      id: `${sourceId}:${index}`,
      sourceId,
      srcIndex: index,
      rotation: 0 as Rotation,
    }),
  );
}
