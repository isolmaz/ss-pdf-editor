/**
 * Shared result shapes for spike #2. Everything here is plain data so the whole
 * result is structured-cloneable: it lands on `window.__spikeResult`, goes through
 * IndexedDB unchanged, and is read back by the driving browser automation.
 */
import type { JournalSnapshot } from 'pdf-model';

export interface CheckResult {
  readonly id: string;
  readonly label: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface MismatchRecord {
  readonly step: number;
  readonly direction: 'undo' | 'redo' | 'restore' | 'replay';
  readonly entryId: string;
  readonly cursor: number;
  readonly expectedDigest: string;
  readonly actualDigest: string;
  readonly detail: string | null;
}

export interface FunctionCloneProbe {
  readonly structuredCloneRejectsFunction: boolean;
  readonly structuredCloneErrorName: string;
  readonly structuredCloneAcceptsData: boolean;
  readonly indexedDbRejectsFunction: boolean;
  readonly indexedDbErrorName: string | null;
}

export interface EngineHistoryEvidence {
  readonly sourceAvailable: boolean;
  readonly pdfjsVersion: string | null;
  readonly sourceBytes: number;
  readonly commandManagerLine: number;
  readonly defaultMaxSize: number | null;
  readonly capStatement: string | null;
  readonly addSignature: string | null;
  readonly storesFunctions: boolean;
  readonly saveDocumentSerializesAnnotationStorage: boolean;
  readonly quote: string;
  readonly cloneProbe: FunctionCloneProbe | null;
  readonly verdict: string;
}

export interface DraftRecord {
  readonly id: string;
  readonly savedAt: number;
  readonly containsSourceBytes: false;
  readonly journalSchema: number;
  readonly journal: JournalSnapshot;
  readonly summary: Phase1Summary;
}

export interface Phase1Summary {
  readonly fixture: {
    readonly pageCount: number;
    readonly bytes: number;
    readonly sha256: string;
    readonly sha256Identity: string;
  };
  readonly plan: {
    readonly total: number;
    readonly distinct: number;
    readonly pdfjsEditorOps: number;
    readonly modelOps: number;
    readonly engineTransitions: number;
    readonly firstPageOpIndex: number;
    readonly lastPageOpIndex: number;
    readonly stampIndex: number;
    readonly counts: Record<string, number>;
  };
  readonly journal: {
    readonly entries: number;
    readonly cursor: number;
    readonly undone: number;
    readonly redone: number;
    readonly redoTailAfterRedo: number;
    readonly emptyDigest: string;
    readonly cursorDigest: string;
  };
  readonly digestChecks: {
    readonly undoMatches: number;
    readonly undoTotal: number;
    readonly redoMatches: number;
    readonly redoTotal: number;
    readonly mismatches: readonly MismatchRecord[];
  };
  readonly stamp: {
    readonly key: string;
    readonly bitmapId: string;
    readonly pageIndex: number;
    readonly dataUrlBytes: number;
    readonly dataUrlSha256: string;
    readonly engineCacheIdsAfterCommit: readonly string[];
    readonly engineCacheDecodes: number;
  };
  readonly chronology: {
    readonly appliedOrder: readonly string[];
    readonly revertOrder: readonly string[];
    readonly redoOrder: readonly string[];
    readonly ok: boolean;
  };
  readonly branch: {
    readonly discarded: number;
    readonly discardedEngines: readonly string[];
    readonly droppedByEngine: Record<string, number>;
    readonly redoTailAfterAppend: number;
    readonly canRedoAfterAppend: boolean;
    readonly ok: boolean;
  };
  readonly draft: {
    readonly storedBytes: number;
    readonly fixtureBytes: number;
    readonly containsSourceBytes: boolean;
    readonly hasPdfMagicInStoredJson: boolean;
  };
  readonly engine: {
    readonly storageConstructor: string;
    readonly annotationKeysBefore: number;
    readonly annotationKeysAfter150: number;
    readonly annotationKeysAtCursor: number;
    readonly storageWrites: number;
    readonly evidence: EngineHistoryEvidence;
  };
  readonly checks: readonly CheckResult[];
  readonly timings: Record<string, number>;
}

export interface Phase2Summary {
  readonly draft: {
    readonly storedBytes: number;
    readonly journalEntries: number;
    readonly journalCursor: number;
    readonly containsSourceBytes: boolean;
    readonly hasPdfMagicInStoredJson: boolean;
    readonly summaryPresent: boolean;
  };
  readonly restored: {
    readonly entries: number;
    readonly cursor: number;
    readonly redoTail: number;
    readonly fixturePageCount: number;
    readonly fixtureSha256: string;
    readonly fixtureIdentityMatches: boolean;
    readonly engineAnnotationsBeforeReplay: number;
    readonly engineRasterBeforeReplay: number;
    readonly replayedEntries: number;
    readonly digestMatchesPersistedCursor: boolean;
    readonly rasterDecodedFromJournal: number;
    readonly stampSource: string;
    readonly stampDataUrlSha256: string;
    readonly stampDataUrlSha256Matches: boolean;
  };
  readonly continued: {
    readonly undone: number;
    readonly redone: number;
    readonly finalCursor: number;
    readonly undoMatches: number;
    readonly redoMatches: number;
    readonly mismatches: readonly MismatchRecord[];
  };
  readonly engineSave: {
    readonly attempted: boolean;
    readonly ok: boolean;
    readonly bytes: number | null;
    readonly annotationObjectsInPages: number | null;
    readonly pagesWithAnnotations: number | null;
    readonly error: string | null;
  };
  readonly checks: readonly CheckResult[];
  readonly timings: Record<string, number>;
}

export interface SpikeResult {
  readonly spike: 'phase0/spike-2/single-journal-undo';
  readonly schema: 1;
  readonly phase: 'phase1-done' | 'done' | 'failed';
  readonly verdict: 'PASS' | 'FAIL';
  readonly isolation: {
    readonly crossOriginIsolated: boolean;
    readonly origin: string;
    readonly url: string;
    readonly secureContext: boolean;
    readonly userAgent: string;
    readonly workerSrcAvailable: boolean;
  };
  readonly steps: {
    readonly fixturePages: number;
    readonly fixtureBytes: number;
    readonly operations: number;
    readonly operationsDistinct: number;
    readonly undo: number;
    readonly redo: number;
    readonly undoDigestChecks: number;
    readonly redoDigestChecks: number;
    readonly chronologyUndoSteps: number;
    readonly chronologyRedoSteps: number;
    readonly branchDiscarded: number;
    readonly replayedAfterReload: number;
    readonly continuedUndo: number;
    readonly continuedRedo: number;
  };
  readonly mismatches: readonly MismatchRecord[];
  readonly restored: Phase2Summary['restored'] | null;
  readonly timings: Record<string, number>;
  readonly checks: readonly CheckResult[];
  readonly engineEvidence: EngineHistoryEvidence | null;
  readonly limits: readonly string[];
  readonly phase1: Phase1Summary | null;
  readonly phase2: Phase2Summary | null;
  readonly error?: string;
}
