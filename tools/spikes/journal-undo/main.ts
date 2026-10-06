/**
 * Phase 0 spike #2 — single-journal undo with the pdf.js bridge (`PLAN.md §5/Phase 0`).
 *
 * Throwaway prototype (`§9/K21`): nothing in this folder ships. The page runs in
 * two phases so the reload is a **real** `page.reload()`, not a JS-level reset:
 *
 *   phase 1  build a 12-page PDF in code → open it with the real pdf.js adapter →
 *            append 150 interleaved operations to one `OperationJournal` → undo 60
 *            → redo 40 → chronological-order case → two-engine redo-branch case →
 *            pdf.js source evidence → persist `journal.toJSON()` into IndexedDB.
 *   phase 2  (after the browser reload) restore with `fromJSON()`, replay the
 *            journal onto a *fresh* engine, check the state digest against the one
 *            persisted in phase 1, then keep undoing and redoing.
 *
 * Every step is verified against a pure journal-replay oracle (`ModelTarget`), so
 * a mismatch means the journal (not the engine) is wrong.
 */

import type { JournalEngine, JournalEntry, JournalSnapshot, JsonValue } from 'pdf-model';
import { JOURNAL_SCHEMA, OperationJournal } from 'pdf-model';
import { AnnotationEditorType } from 'pdfjs-dist';
import { loadMupdf } from '../load-mupdf';
import { EngineTarget, openEngine } from './engine';
import { collectEngineEvidence } from './engine-evidence';
import { buildFixture, buildStampRaster, type Fixture, type StampRaster, sha256Hex } from './fixture';
import {
  ANNOTATION_KEY_PREFIX,
  applyEntry,
  basePages,
  digestView,
  firstDifference,
  ModelTarget,
  replayPrefix,
  revertEntry,
  stableStringify,
} from './ops';
import { deleteDraft, getDraft, probeFunctionClone, putDraft } from './persistence';
import { type AnnotationTypeMap, buildPlan, PLAN_TOTAL, type Plan, type PlannedOperation } from './plan';
import { check, publish, setPhase, wireReloadButton } from './report';
import type {
  CheckResult,
  EngineHistoryEvidence,
  MismatchRecord,
  Phase1Summary,
  Phase2Summary,
  SpikeResult,
} from './types';

const DRAFT_ID = 'main';
const UNDO_STEPS = 60;
const REDO_STEPS = 40;
const CONTINUE_UNDO_STEPS = 25;
const CONTINUE_REDO_STEPS = 15;
const PAGE_COUNT = 12;

const annotationTypes: AnnotationTypeMap = {
  HIGHLIGHT: AnnotationEditorType.HIGHLIGHT,
  FREETEXT: AnnotationEditorType.FREETEXT,
  INK: AnnotationEditorType.INK,
  STAMP: AnnotationEditorType.STAMP,
  COMMENT: AnnotationEditorType.COMMENT,
};

const timings: Record<string, number> = {};
const digestCache = new Map<number, string>();

function mark(name: string, start: number): void {
  timings[name] = performance.now() - start;
  // Breadcrumb for the driving automation: a real run can be watched step by step.
  window.__spikeStep = name;
}

function isolationSnapshot(): SpikeResult['isolation'] {
  return {
    crossOriginIsolated: window.crossOriginIsolated,
    origin: location.origin,
    url: location.href,
    secureContext: window.isSecureContext,
    userAgent: navigator.userAgent,
    workerSrcAvailable: true,
  };
}

/** Digest of the pure journal prefix — the oracle every engine step is held to. */
async function expectedDigestAt(cursor: number, entries: readonly JournalEntry[]): Promise<string> {
  const cached = digestCache.get(cursor);
  if (cached) return cached;
  const model = new ModelTarget(basePages(PAGE_COUNT));
  await replayPrefix(model, entries, cursor);
  const digest = await digestView(model.view());
  digestCache.set(cursor, digest);
  return digest;
}

interface StepReport {
  readonly matches: number;
  readonly total: number;
  readonly order: readonly string[];
  readonly mismatches: readonly MismatchRecord[];
}

/**
 * Undo or redo `steps` entries, digesting the engine state after every single
 * step and comparing it with the journal prefix (chronological order, not just the
 * end state).
 */
async function stepThrough(
  direction: 'undo' | 'redo',
  journal: OperationJournal,
  target: EngineTarget,
  steps: number,
): Promise<StepReport> {
  const entries = journal.entries;
  const order: string[] = [];
  const mismatches: MismatchRecord[] = [];
  let matches = 0;
  for (let step = 0; step < steps; step += 1) {
    const entry = direction === 'undo' ? journal.undo() : journal.redo();
    if (!entry) {
      throw new Error(
        `journal.${direction}() returned nothing at step ${step} (cursor ${journal.cursor}, entries ${journal.length})`,
      );
    }
    if (direction === 'undo') await revertEntry(target, entry);
    else await applyEntry(target, entry);
    order.push(entry.id);

    const expectedDigest = await expectedDigestAt(journal.cursor, entries);
    const actualDigest = await digestView(target.view());
    if (expectedDigest === actualDigest) {
      matches += 1;
      continue;
    }
    const model = new ModelTarget(basePages(PAGE_COUNT));
    await replayPrefix(model, entries, journal.cursor);
    mismatches.push({
      step,
      direction,
      entryId: entry.id,
      cursor: journal.cursor,
      expectedDigest,
      actualDigest,
      detail: firstDifference(model.view(), target.view()),
    });
  }
  return { matches, total: steps, order, mismatches };
}

function operationToInput(operation: PlannedOperation) {
  return {
    engine: operation.engine,
    labelKey: operation.labelKey,
    op: { kind: operation.kind, payload: operation.payload },
  };
}

/* ------------------------------------------------------------------ phase 1 */

interface Phase1 {
  readonly summary: Phase1Summary;
  readonly checks: readonly CheckResult[];
  readonly evidence: EngineHistoryEvidence;
  readonly journalSnapshot: JournalSnapshot;
  readonly mismatches: readonly MismatchRecord[];
}

async function runPhase1(): Promise<Phase1> {
  const checks: CheckResult[] = [];
  const mismatches: MismatchRecord[] = [];

  const fixtureStart = performance.now();
  const fixture: Fixture = await buildFixture(PAGE_COUNT);
  const stampRaster: StampRaster = await buildStampRaster();
  mark('p1.fixtureAndStamp', fixtureStart);
  checks.push(
    check(
      'fixture.pages',
      'fixture has 12 pages',
      fixture.pageCount === PAGE_COUNT,
      PAGE_COUNT,
      fixture.pageCount,
    ),
  );

  const engineStart = performance.now();
  const opened = await openEngine(fixture.bytes);
  mark('p1.engineOpen', engineStart);
  checks.push(
    check(
      'engine.storageClass',
      'annotationStorage is pdf.js AnnotationStorage',
      opened.storageConstructor === 'AnnotationStorage',
      'AnnotationStorage',
      opened.storageConstructor,
    ),
  );
  const annotationKeysBefore = opened.storage.size;

  const plan: Plan = buildPlan({ pageCount: fixture.pageCount, annotationTypes, stamp: stampRaster });
  checks.push(
    check(
      'plan.total',
      'plan has 150 operations',
      plan.stats.total === PLAN_TOTAL,
      PLAN_TOTAL,
      plan.stats.total,
    ),
    check(
      'plan.distinct',
      'every operation is distinct',
      plan.stats.distinct === PLAN_TOTAL,
      PLAN_TOTAL,
      plan.stats.distinct,
    ),
    check(
      'plan.interleaved',
      'page operations are interleaved with annotation operations',
      plan.stats.engineTransitions > 100 &&
        plan.stats.firstPageOpIndex > 0 &&
        plan.stats.lastPageOpIndex < PLAN_TOTAL - 1,
      'transitions > 100, first page op inside the sequence, not last',
      `transitions=${plan.stats.engineTransitions}, first=${plan.stats.firstPageOpIndex}, last=${plan.stats.lastPageOpIndex}`,
    ),
    check(
      'plan.stamp',
      'exactly one image stamp with a data-URL payload',
      plan.stats.stampIndex >= 0 &&
        stampRaster.dataUrl.startsWith('data:image/png;base64,') &&
        plan.counts.stamp === 1,
      '1 stamp, data:image/png;base64 payload',
      `index=${plan.stats.stampIndex}, dataUrlBytes=${stampRaster.dataUrlBytes}`,
    ),
  );

  const journal = new OperationJournal();
  const target = new EngineTarget(opened.storage, basePages(fixture.pageCount));
  const commitStart = performance.now();
  for (const operation of plan.operations) journal.append(operationToInput(operation));
  for (const entry of journal.entries) await applyEntry(target, entry);
  mark('p1.commit150', commitStart);

  checks.push(
    check(
      'journal.appended',
      'journal holds the 150 appended entries',
      journal.length === PLAN_TOTAL,
      PLAN_TOTAL,
      journal.length,
    ),
    check(
      'journal.cursor',
      'cursor sits at the end after appending',
      journal.cursor === PLAN_TOTAL,
      PLAN_TOTAL,
      journal.cursor,
    ),
    check(
      'engine.storageSize',
      'pdf.js storage holds the surviving annotation entries',
      opened.storage.size === 114,
      114,
      opened.storage.size,
    ),
    check(
      'engine.storageKeys',
      'every storage key uses the pdf.js editor prefix',
      [...opened.storage].every(([key]) => key.startsWith(ANNOTATION_KEY_PREFIX)),
      'all keys prefixed',
      `keys=${opened.storage.size}`,
    ),
  );

  const stampOperation = plan.operations[plan.stats.stampIndex];
  if (!stampOperation) throw new Error('plan has no stamp operation');
  const stampKey = String(stampOperation.payload.key);
  const stampValue = stampOperation.payload.value as Record<string, JsonValue>;
  const stampBitmapId = String(stampValue.bitmapId);
  const stampRasterFromPayload = stampValue.raster as Record<string, JsonValue>;
  checks.push(
    check(
      'stamp.storage',
      'the engine storage carries the stamp data URL',
      (opened.storage.getRawValue(stampKey) as Record<string, JsonValue> | undefined)?.raster !== undefined,
      true,
      (opened.storage.getRawValue(stampKey) as Record<string, JsonValue> | undefined)?.raster !== undefined,
    ),
    check(
      'stamp.engineCache',
      'the engine-side bitmap cache holds exactly the stamp bitmap',
      target.images.ids().join(',') === stampBitmapId,
      stampBitmapId,
      target.images.ids().join(','),
    ),
  );

  const emptyDigest = await expectedDigestAt(0, journal.entries);

  const undoStart = performance.now();
  const undo = await stepThrough('undo', journal, target, UNDO_STEPS);
  mark('p1.undo60', undoStart);
  mismatches.push(...undo.mismatches);

  const expectedUndoOrder = journal.entries
    .slice(journal.cursor, journal.cursor + UNDO_STEPS)
    .map((entry) => entry.id)
    .reverse();
  checks.push(
    check(
      'undo.count',
      'undo ran the requested number of steps',
      undo.order.length === UNDO_STEPS,
      UNDO_STEPS,
      undo.order.length,
    ),
    check(
      'undo.order',
      'undo reverted strictly last-in-first-out (chronological reverse)',
      undo.order.join(',') === expectedUndoOrder.join(','),
      `reverse of entries ${journal.cursor}..${journal.cursor + UNDO_STEPS - 1}`,
      undo.order.length === expectedUndoOrder.length ? 'match' : 'length differs',
    ),
    check(
      'undo.digest',
      'engine state equalled the journal prefix after every undo step',
      undo.matches === UNDO_STEPS,
      UNDO_STEPS,
      undo.matches,
    ),
    check(
      'undo.cursor',
      'cursor after 60 undos',
      journal.cursor === PLAN_TOTAL - UNDO_STEPS,
      PLAN_TOTAL - UNDO_STEPS,
      journal.cursor,
    ),
  );

  const redoStart = performance.now();
  const redo = await stepThrough('redo', journal, target, REDO_STEPS);
  mark('p1.redo40', redoStart);
  mismatches.push(...redo.mismatches);

  const expectedRedoOrder = journal.entries
    .slice(journal.cursor, journal.cursor + REDO_STEPS)
    .map((entry) => entry.id);
  checks.push(
    check(
      'redo.count',
      'redo ran the requested number of steps',
      redo.order.length === REDO_STEPS,
      REDO_STEPS,
      redo.order.length,
    ),
    check(
      'redo.order',
      'redo re-applied strictly in chronological order',
      redo.order.join(',') === expectedRedoOrder.join(','),
      `entries ${journal.cursor}..${journal.cursor + REDO_STEPS - 1} in order`,
      redo.order.length === expectedRedoOrder.length ? 'match' : 'length differs',
    ),
    check(
      'redo.digest',
      'engine state equalled the journal prefix after every redo step',
      redo.matches === REDO_STEPS,
      REDO_STEPS,
      redo.matches,
    ),
    check('redo.cursor', 'cursor after 40 redos', journal.cursor === 130, 130, journal.cursor),
    check(
      'journal.redoTail',
      'redo tail left after 40 redos',
      journal.redoTail.length === 20,
      20,
      journal.redoTail.length,
    ),
  );

  const cursorDigest = await digestView(target.view());
  const oracleDigest = await expectedDigestAt(journal.cursor, journal.entries);
  const annotationKeysAtCursor = opened.storage.size;
  const expectedKeysAtCursor = journal.entries
    .slice(0, journal.cursor)
    .reduce(
      (total, entry) =>
        total + (entry.op.kind === 'annotation.create' ? 1 : entry.op.kind === 'annotation.delete' ? -1 : 0),
      0,
    );
  checks.push(
    check(
      'state.cursor',
      'engine state at the cursor equals the journal prefix',
      cursorDigest === oracleDigest,
      oracleDigest.slice(0, 16),
      cursorDigest.slice(0, 16),
    ),
    check(
      'state.cursorKeys',
      'storage entry count at the cursor equals the prefix arithmetic',
      annotationKeysAtCursor === expectedKeysAtCursor,
      expectedKeysAtCursor,
      annotationKeysAtCursor,
    ),
  );

  /* --- the must-pass chronological case from PLAN.md §7 ------------------- */
  const chronologyStart = performance.now();
  const chronology = await runChronologyCase(fixture);
  mark('p1.chronology', chronologyStart);
  checks.push(
    check(
      'chronology.revertOrder',
      'highlight → rotate → comment, undo ×3 reverts comment → rotate → highlight',
      chronology.revertOrder.join(' -> ') === 'comment -> rotate -> highlight',
      'comment -> rotate -> highlight',
      chronology.revertOrder.join(' -> '),
    ),
    check(
      'chronology.redoOrder',
      'redo ×3 re-applies highlight → rotate → comment',
      chronology.redoOrder.join(' -> ') === 'highlight -> rotate -> comment',
      'highlight -> rotate -> comment',
      chronology.redoOrder.join(' -> '),
    ),
    check(
      'chronology.state',
      'state returned to the pre-op baseline after undo ×3',
      chronology.emptyDigest === chronology.baseDigest,
      chronology.baseDigest.slice(0, 16),
      chronology.emptyDigest.slice(0, 16),
    ),
  );

  /* --- redo-branch invalidation across two engines ------------------------ */
  const branchStart = performance.now();
  const branch = await runBranchCase(chronology, plan);
  mark('p1.branch', branchStart);
  checks.push(
    check(
      'branch.discarded',
      'appending after an undo truncates the whole redo tail and reports it',
      branch.discarded === 4,
      4,
      branch.discarded,
    ),
    check(
      'branch.engines',
      'the discarded tail belonged to two engines',
      new Set(branch.discardedEngines).size === 2,
      2,
      `${[...new Set(branch.discardedEngines)].join('+')} (${branch.discardedEngines.join(',')})`,
    ),
    check(
      'branch.engineStacks',
      "each engine's own redo branch was dropped",
      Object.values(branch.droppedByEngine).every((value) => value === 0) &&
        Object.keys(branch.droppedByEngine).length === 2,
      'both engine stacks empty',
      stableStringify(branch.droppedByEngine as unknown as JsonValue),
    ),
    check(
      'branch.canRedo',
      'no stale redo remains in the journal',
      branch.redoTailAfterAppend === 0 && !branch.canRedoAfterAppend,
      'tail 0 and canRedo false',
      `tail=${branch.redoTailAfterAppend}, canRedo=${branch.canRedoAfterAppend}`,
    ),
    check(
      'branch.undoNew',
      'the newly appended entry is itself undoable',
      branch.undoneNewEntry,
      true,
      branch.undoneNewEntry,
    ),
  );

  /* --- engine history evidence ------------------------------------------- */
  const cloneProbe = await probeFunctionClone();
  const evidence = await collectEngineEvidence(cloneProbe);
  checks.push(
    check(
      'engine.evidence',
      'pdf.js CommandManager is a 128-slot history of function objects',
      evidence.defaultMaxSize === 128 && evidence.storesFunctions && evidence.capStatement !== null,
      'maxSize 128 + splice(0,1) cap + {cmd,undo,post,type} objects',
      `maxSize=${evidence.defaultMaxSize}, cap=${evidence.capStatement !== null}, functions=${evidence.storesFunctions}`,
    ),
    check(
      'engine.clone',
      'structured clone (and therefore IndexedDB) refuses engine-style command functions',
      cloneProbe.structuredCloneRejectsFunction &&
        cloneProbe.indexedDbRejectsFunction &&
        cloneProbe.structuredCloneAcceptsData,
      'DataCloneError for functions, plain data accepted',
      `structuredClone=${cloneProbe.structuredCloneErrorName}, indexedDB=${cloneProbe.indexedDbErrorName}, data accepted=${cloneProbe.structuredCloneAcceptsData}`,
    ),
    check(
      'engine.savePath',
      'saveDocument() serializes annotationStorage, not the command history',
      evidence.saveDocumentSerializesAnnotationStorage,
      true,
      evidence.saveDocumentSerializesAnnotationStorage,
    ),
  );

  /* --- persist the draft (model data only) ------------------------------- */
  const cursorDigestFinal = await digestView(target.view());
  const persistStart = performance.now();
  const summary: Phase1Summary = {
    fixture: {
      pageCount: fixture.pageCount,
      bytes: fixture.bytesLength,
      sha256: fixture.sha256,
      sha256Identity: fixture.sha256Identity,
    },
    plan: {
      total: plan.stats.total,
      distinct: plan.stats.distinct,
      pdfjsEditorOps: plan.stats.pdfjsEditorOps,
      modelOps: plan.stats.modelOps,
      engineTransitions: plan.stats.engineTransitions,
      firstPageOpIndex: plan.stats.firstPageOpIndex,
      lastPageOpIndex: plan.stats.lastPageOpIndex,
      stampIndex: plan.stats.stampIndex,
      counts: plan.counts,
    },
    journal: {
      entries: journal.length,
      cursor: journal.cursor,
      undone: UNDO_STEPS,
      redone: REDO_STEPS,
      redoTailAfterRedo: journal.redoTail.length,
      emptyDigest,
      cursorDigest: cursorDigestFinal,
    },
    digestChecks: {
      undoMatches: undo.matches,
      undoTotal: undo.total,
      redoMatches: redo.matches,
      redoTotal: redo.total,
      mismatches,
    },
    stamp: {
      key: stampKey,
      bitmapId: stampBitmapId,
      pageIndex: Number(stampOperation.payload.pageIndex),
      dataUrlBytes: stampRaster.dataUrlBytes,
      dataUrlSha256: String(stampRasterFromPayload.sha256),
      engineCacheIdsAfterCommit: target.images.ids(),
      engineCacheDecodes: target.images.decoded,
    },
    chronology: {
      appliedOrder: chronology.appliedOrder,
      revertOrder: chronology.revertOrder,
      redoOrder: chronology.redoOrder,
      ok: chronology.revertOrder.join(' -> ') === 'comment -> rotate -> highlight',
    },
    branch: {
      discarded: branch.discarded,
      discardedEngines: branch.discardedEngines,
      droppedByEngine: branch.droppedByEngine,
      redoTailAfterAppend: branch.redoTailAfterAppend,
      canRedoAfterAppend: branch.canRedoAfterAppend,
      ok: branch.discarded === 4 && branch.redoTailAfterAppend === 0,
    },
    draft: {
      storedBytes: 0,
      fixtureBytes: fixture.bytesLength,
      containsSourceBytes: false,
      hasPdfMagicInStoredJson: false,
    },
    engine: {
      storageConstructor: opened.storageConstructor,
      annotationKeysBefore,
      annotationKeysAfter150: opened.storage.size,
      annotationKeysAtCursor,
      storageWrites: target.writes,
      evidence,
    },
    checks,
    timings: { ...timings },
  };

  const stored = await putDraft({
    id: DRAFT_ID,
    savedAt: Date.now(),
    journalSchema: JOURNAL_SCHEMA,
    journal: journal.toJSON(),
    summary,
  });
  mark('p1.persistWrite', persistStart);

  const storedJson = JSON.stringify(stored);
  const hasPdfMagicInStoredJson = storedJson.includes('%PDF-');
  const draft = {
    storedBytes: stored.storedBytes,
    fixtureBytes: fixture.bytesLength,
    containsSourceBytes: stored.containsSourceBytes,
    hasPdfMagicInStoredJson,
  };
  const draftChecks = [
    check(
      'draft.modelOnly',
      'the persisted record contains model data only (no source bytes)',
      !stored.containsSourceBytes && !hasPdfMagicInStoredJson,
      'containsSourceBytes=false, no %PDF- in the record',
      `containsSourceBytes=${stored.containsSourceBytes}, %PDF-=${hasPdfMagicInStoredJson}, bytes=${stored.storedBytes}`,
    ),
    check(
      'draft.journalSchema',
      'the record carries the journal schema version',
      stored.journalSchema === JOURNAL_SCHEMA,
      JOURNAL_SCHEMA,
      stored.journalSchema,
    ),
  ];
  checks.push(...draftChecks);

  const finalChecks = [...checks];
  const summaryFinal: Phase1Summary = {
    ...summary,
    draft,
    checks: finalChecks,
    timings: { ...timings },
  };
  await putDraft({
    id: DRAFT_ID,
    savedAt: Date.now(),
    journalSchema: JOURNAL_SCHEMA,
    journal: journal.toJSON(),
    summary: summaryFinal,
  });

  return {
    summary: summaryFinal,
    checks: finalChecks,
    evidence,
    journalSnapshot: journal.toJSON(),
    mismatches,
  };
}

/* ------------------------------------------------ targeted chronological case */

interface ChronologyCase {
  readonly appliedOrder: readonly string[];
  readonly revertOrder: readonly string[];
  readonly redoOrder: readonly string[];
  readonly baseDigest: string;
  readonly emptyDigest: string;
  readonly journal: OperationJournal;
  readonly target: EngineTarget;
}

/**
 * `PLAN.md §7` must-pass: highlight → rotate → comment, undo ×3, and the state
 * must come back in the reverse order. Runs on its own engine and its own journal
 * so the order cannot be masked by anything else.
 */
async function runChronologyCase(fixture: Fixture): Promise<ChronologyCase> {
  const opened = await openEngine(fixture.bytes);
  const target = new EngineTarget(opened.storage, basePages(fixture.pageCount));
  const journal = new OperationJournal();
  const baseDigest = await digestView(target.view());

  const ops: {
    engine: JournalEngine;
    label: string;
    kind: string;
    payload: Record<string, JsonValue>;
    name: string;
  }[] = [
    {
      engine: 'pdfjs-editor',
      label: 'highlight',
      name: 'highlight',
      kind: 'annotation.create',
      payload: {
        key: `${ANNOTATION_KEY_PREFIX}${crypto.randomUUID()}`,
        pageIndex: 2,
        editorType: 'highlight',
        value: {
          annotationType: annotationTypes.HIGHLIGHT,
          pageIndex: 2,
          rect: [72, 640, 480, 660],
          rotation: 0,
          structTreeParentId: null,
          popupRef: '',
          color: [255, 226, 102],
          opacity: 0.5,
          thickness: 2,
          quadPoints: [72, 660, 480, 660, 72, 640, 480, 640],
        },
      },
    },
    {
      engine: 'model',
      label: 'rotate',
      name: 'rotate',
      kind: 'page.rotate',
      payload: { pageId: 'p2', from: 0, to: 90 },
    },
    {
      engine: 'pdfjs-editor',
      label: 'comment',
      name: 'comment',
      kind: 'annotation.create',
      payload: {
        key: `${ANNOTATION_KEY_PREFIX}${crypto.randomUUID()}`,
        pageIndex: 2,
        editorType: 'comment',
        value: {
          annotationType: annotationTypes.COMMENT,
          pageIndex: 2,
          rect: [490, 620, 670, 720],
          rotation: 0,
          structTreeParentId: null,
          popupRef: '',
          popup: { contents: 'Kontrol edildi', deleted: false, rect: [490, 620, 670, 720] },
        },
      },
    },
  ];

  const appliedOrder: string[] = [];
  for (const op of ops) {
    const { entry } = journal.append({
      engine: op.engine,
      labelKey: `journal.op.${op.kind}.${op.label}`,
      op: { kind: op.kind, payload: op.payload },
    });
    await applyEntry(target, entry);
    appliedOrder.push(op.name);
  }

  const revertOrder: string[] = [];
  for (let step = 0; step < ops.length; step += 1) {
    const entry = journal.undo();
    if (!entry) throw new Error('chronology case ran out of entries while undoing');
    await revertEntry(target, entry);
    revertOrder.push(entry.labelKey.split('.').pop() ?? entry.labelKey);
  }
  const emptyDigest = await digestView(target.view());

  const redoOrder: string[] = [];
  for (let step = 0; step < ops.length; step += 1) {
    const entry = journal.redo();
    if (!entry) throw new Error('chronology case ran out of entries while redoing');
    await applyEntry(target, entry);
    redoOrder.push(entry.labelKey.split('.').pop() ?? entry.labelKey);
  }

  return { appliedOrder, revertOrder, redoOrder, baseDigest, emptyDigest, journal, target };
}

/* ------------------------------------------- two-engine redo-branch case */

interface BranchCase {
  readonly discarded: number;
  readonly discardedEngines: readonly string[];
  readonly droppedByEngine: Record<string, number>;
  readonly redoTailAfterAppend: number;
  readonly canRedoAfterAppend: boolean;
  readonly undoneNewEntry: boolean;
}

/**
 * `PLAN.md §3.2` rule 3: a new entry truncates the redo tail, and when the tail
 * belongs to another engine that engine's own redo branch must be discarded. The
 * engine stacks are simulated (the spike has no real `AnnotationEditorUIManager`),
 * but the *reporting* being tested — `AppendResult.discarded` — is the real one.
 */
async function runBranchCase(chronology: ChronologyCase, plan: Plan): Promise<BranchCase> {
  const { journal, target } = chronology;
  const annotationPush = plan.operations
    .filter((operation) => operation.engine === 'pdfjs-editor')
    .slice(0, 3);
  const modelPush = plan.operations.filter((operation) => operation.engine === 'model').slice(0, 2);

  for (const operation of [...annotationPush, ...modelPush]) {
    const { entry } = journal.append(operationToInput(operation));
    await applyEntry(target, entry);
  }

  const foreignRedo = new Map<JournalEngine, string[]>();
  for (let step = 0; step < 4; step += 1) {
    const entry = journal.undo();
    if (!entry) throw new Error('branch case ran out of entries while undoing');
    await revertEntry(target, entry);
    const stack = foreignRedo.get(entry.engine) ?? [];
    stack.push(entry.id);
    foreignRedo.set(entry.engine, stack);
  }

  const tailEngines = journal.redoTail.map((entry) => entry.engine);
  const appended = plan.operations.filter((operation) => operation.engine === 'model').slice(2, 3);
  const nextOperation = appended[0];
  if (!nextOperation) throw new Error('branch case has no operation to append');
  const { entry: newEntry, discarded } = journal.append(operationToInput(nextOperation));
  await applyEntry(target, newEntry);

  const droppedByEngine: Record<string, number> = {};
  for (const engine of foreignRedo.keys()) droppedByEngine[engine] = 0;
  for (const entry of discarded) {
    const stack = foreignRedo.get(entry.engine) ?? [];
    const index = stack.indexOf(entry.id);
    if (index >= 0) {
      stack.splice(index, 1);
      foreignRedo.set(entry.engine, stack);
    }
  }
  for (const [engine, stack] of foreignRedo) droppedByEngine[engine] = stack.length;

  const undone = journal.undo();
  const undoneNewEntry = undone?.id === newEntry.id;
  if (undone) await revertEntry(target, undone);

  return {
    discarded: discarded.length,
    discardedEngines: discarded.map((entry) => entry.engine),
    droppedByEngine,
    redoTailAfterAppend: journal.redoTail.length,
    canRedoAfterAppend: journal.canRedo,
    undoneNewEntry: undoneNewEntry && tailEngines.length === 4,
  };
}

/* ------------------------------------------------------------------ phase 2 */

async function runPhase2(): Promise<Phase2Summary> {
  const checks: CheckResult[] = [];
  const timings2: Record<string, number> = {};

  const draftStart = performance.now();
  const draft = await getDraft(DRAFT_ID);
  timings2['p2.draftRead'] = performance.now() - draftStart;
  if (!draft) throw new Error('phase 2 started without a persisted draft');
  const phase1 = draft.summary;
  const storedJson = JSON.stringify(draft);
  const hasPdfMagicInStoredJson = storedJson.includes('%PDF-');

  const journal = OperationJournal.fromJSON(draft.journal);
  checks.push(
    check(
      'restore.entries',
      'journal entries survived the reload',
      journal.length === 150,
      150,
      journal.length,
    ),
    check(
      'restore.cursor',
      'journal cursor survived the reload',
      journal.cursor === 130,
      130,
      journal.cursor,
    ),
    check(
      'restore.redoTail',
      'the redo tail survived the reload',
      journal.redoTail.length === 20,
      20,
      journal.redoTail.length,
    ),
    check(
      'restore.schema',
      'journal schema version round-trips',
      draft.journalSchema === JOURNAL_SCHEMA && draft.journal.schema === JOURNAL_SCHEMA,
      JOURNAL_SCHEMA,
      `${draft.journal.schema}/${draft.journalSchema}`,
    ),
    check(
      'restore.noSourceBytes',
      'the draft still carries no source bytes',
      !draft.containsSourceBytes && !hasPdfMagicInStoredJson,
      'containsSourceBytes=false, no %PDF-',
      `containsSourceBytes=${draft.containsSourceBytes}, %PDF-=${hasPdfMagicInStoredJson}`,
    ),
  );

  const fixtureStart = performance.now();
  const fixture = await buildFixture(phase1.fixture.pageCount);
  timings2['p2.fixtureRegen'] = performance.now() - fixtureStart;
  checks.push(
    check(
      'restore.baseIdentity',
      'the regenerated base document is the same document (date-normalized digest)',
      fixture.sha256Identity === phase1.fixture.sha256Identity,
      phase1.fixture.sha256Identity.slice(0, 16),
      fixture.sha256Identity.slice(0, 16),
    ),
    check(
      'restore.basePages',
      'page count matches',
      fixture.pageCount === phase1.fixture.pageCount,
      phase1.fixture.pageCount,
      fixture.pageCount,
    ),
  );

  const engineStart = performance.now();
  const opened = await openEngine(fixture.bytes);
  timings2['p2.engineOpen'] = performance.now() - engineStart;
  const annotationsBeforeReplay = opened.storage.size;
  const target = new EngineTarget(opened.storage, basePages(fixture.pageCount));
  const rasterBeforeReplay = target.images.size;
  checks.push(
    check(
      'restore.engineEmpty',
      'the fresh engine holds nothing before the journal is replayed',
      annotationsBeforeReplay === 0 && rasterBeforeReplay === 0,
      '0 annotations, 0 bitmaps',
      `${annotationsBeforeReplay} annotations, ${rasterBeforeReplay} bitmaps`,
    ),
  );

  const replayStart = performance.now();
  await replayPrefix(target, journal.entries, journal.cursor);
  timings2['p2.replay130'] = performance.now() - replayStart;

  const restoredDigest = await digestView(target.view());
  checks.push(
    check(
      'restore.digest',
      'replayed state digest equals the digest persisted in phase 1',
      restoredDigest === phase1.journal.cursorDigest,
      phase1.journal.cursorDigest.slice(0, 16),
      restoredDigest.slice(0, 16),
    ),
    check(
      'restore.annotations',
      'the engine holds the same annotation count as phase 1 had at this cursor',
      opened.storage.size === phase1.engine.annotationKeysAtCursor,
      phase1.engine.annotationKeysAtCursor,
      opened.storage.size,
    ),
  );

  const stampValue = opened.storage.getRawValue(phase1.stamp.key) as Record<string, JsonValue> | undefined;
  const restoredRaster = stampValue?.raster as Record<string, JsonValue> | undefined;
  const restoredDataUrl = typeof restoredRaster?.dataUrl === 'string' ? restoredRaster.dataUrl : '';
  const restoredDataUrlSha256 = restoredDataUrl ? await sha256Hex(restoredDataUrl) : '';
  checks.push(
    check(
      'stamp.fromJournal',
      'after the reload the stamp raster comes from the journal payload, not the engine',
      restoredDataUrlSha256 === phase1.stamp.dataUrlSha256 &&
        target.images.has(phase1.stamp.bitmapId) &&
        rasterBeforeReplay === 0,
      phase1.stamp.dataUrlSha256.slice(0, 16),
      restoredDataUrlSha256.slice(0, 16),
    ),
    check(
      'stamp.bitmap',
      'the bitmap was re-decoded from that data URL on the fresh engine',
      target.images.decoded === 1 && target.images.has(phase1.stamp.bitmapId),
      '1 decode, bitmap present',
      `${target.images.decoded} decodes, present=${target.images.has(phase1.stamp.bitmapId)}`,
    ),
  );

  const mismatches: MismatchRecord[] = [];
  const undoStart = performance.now();
  const undo = await stepThrough('undo', journal, target, CONTINUE_UNDO_STEPS);
  timings2['p2.continueUndo25'] = performance.now() - undoStart;
  mismatches.push(...undo.mismatches);
  const redoStart = performance.now();
  const redo = await stepThrough('redo', journal, target, CONTINUE_REDO_STEPS);
  timings2['p2.continueRedo15'] = performance.now() - redoStart;
  mismatches.push(...redo.mismatches);

  checks.push(
    check(
      'continue.undo',
      'undoing continued correctly after the reload',
      undo.matches === CONTINUE_UNDO_STEPS,
      CONTINUE_UNDO_STEPS,
      undo.matches,
    ),
    check(
      'continue.redo',
      'redoing continued correctly after the reload',
      redo.matches === CONTINUE_REDO_STEPS,
      CONTINUE_REDO_STEPS,
      redo.matches,
    ),
    check(
      'continue.cursor',
      'cursor after 25 undos and 15 redos',
      journal.cursor === 130 - CONTINUE_UNDO_STEPS + CONTINUE_REDO_STEPS,
      120,
      journal.cursor,
    ),
  );

  /* Informational: what the engine itself writes from this storage. */
  const saveStart = performance.now();
  let engineSave: Phase2Summary['engineSave'] = {
    attempted: true,
    ok: false,
    bytes: null,
    annotationObjectsInPages: null,
    pagesWithAnnotations: null,
    error: null,
  };
  try {
    const bytes = await opened.handle.saveDocument();
    const mupdf = await loadMupdf();
    const parsed = mupdf.PDFDocument.openDocument(
      bytes.slice(),
      'application/pdf',
    ) as import('mupdf').PDFDocument;
    let annotationObjects = 0;
    let pagesWithAnnotations = 0;
    for (let index = 0; index < parsed.countPages(); index += 1) {
      const annots = parsed.findPage(index).get('Annots');
      if (annots.isArray()) {
        annotationObjects += annots.length;
        pagesWithAnnotations += 1;
      }
    }
    parsed.destroy();
    engineSave = {
      attempted: true,
      ok: true,
      bytes: bytes.byteLength,
      annotationObjectsInPages: annotationObjects,
      pagesWithAnnotations,
      error: null,
    };
  } catch (error) {
    engineSave = {
      ...engineSave,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
  timings2['p2.engineSave'] = performance.now() - saveStart;

  return {
    draft: {
      storedBytes: draft.summary.draft.storedBytes,
      journalEntries: draft.journal.entries.length,
      journalCursor: draft.journal.cursor,
      containsSourceBytes: draft.containsSourceBytes,
      hasPdfMagicInStoredJson,
      summaryPresent: phase1 !== undefined,
    },
    restored: {
      entries: journal.length,
      cursor: 130,
      redoTail: journal.redoTail.length,
      fixturePageCount: fixture.pageCount,
      fixtureSha256: fixture.sha256,
      fixtureIdentityMatches: fixture.sha256Identity === phase1.fixture.sha256Identity,
      engineAnnotationsBeforeReplay: annotationsBeforeReplay,
      engineRasterBeforeReplay: rasterBeforeReplay,
      replayedEntries: journal.cursor,
      digestMatchesPersistedCursor: restoredDigest === phase1.journal.cursorDigest,
      rasterDecodedFromJournal: target.images.decoded,
      stampSource: 'journal entry op.payload.value.raster.dataUrl',
      stampDataUrlSha256: restoredDataUrlSha256,
      stampDataUrlSha256Matches: restoredDataUrlSha256 === phase1.stamp.dataUrlSha256,
    },
    continued: {
      undone: CONTINUE_UNDO_STEPS,
      redone: CONTINUE_REDO_STEPS,
      finalCursor: journal.cursor,
      undoMatches: undo.matches,
      redoMatches: redo.matches,
      mismatches,
    },
    engineSave,
    checks,
    timings: timings2,
  };
}

/* ------------------------------------------------------------------- driver */

const LIMITS: readonly string[] = [
  'No real AnnotationEditorLayer commit interception: annotation entries here are written into `document.annotationStorage` in the editor serialized shape (annotationType/pageIndex/rect/…) but they are synthesized, not the output of `AnnotationEditor.serialize()` from a live editor instance. Production needs a commit hook on `AnnotationEditor.commit()`/`addCommands()` (`build/pdf.mjs:3113`, `3498`, `5314`) so one user-visible commit becomes one entry.',
  "The foreign engine's redo branch is *simulated*: the spike drops its own `Map<engine, id[]>` stacks. A real bridge must truncate pdf.js's private `#commands` (`build/pdf.mjs:2382-2395`) — there is no public API for that today.",
  "pdf.js's real `ImageManager` is stood in by `EngineImageCache`: the real one needs an `AnnotationEditorUIManager` (viewer DOM + `AnnotationEditorLayer`), which this spike deliberately does not build.",
  'Page operations stay model-level: rotate/reorder are recorded and replayed as journal entries, but no writer step (`extractPages`, MuPDF page boxes) is exercised — that is spike #1 territory.',
  'Restart safety across an in-place save is untested: this spike replays the journal onto a base it regenerated, never onto a base that changed underneath (the `K30`/§3.5 one-base-copy rule and its quota path are out of scope here).',
  'Uncommitted editing sessions are out of scope: pdf.js keeps the in-progress text session in its own editor state; the spike starts from committed entries only.',
  'MuPDF (`engine: "mupdf"`) entries are not covered: their revert needs the working-version snapshot mechanism (§3.5), which this prototype does not implement.',
  'The engine-side `saveDocument()` probe is informational: the storage entries are not full `serialize()` output, so the engine may warn or skip entries it cannot turn into a PDF annotation.',
];

async function main(): Promise<void> {
  const isolation = isolationSnapshot();
  wireReloadButton('reload');

  const existing = await getDraft(DRAFT_ID).catch(() => undefined);
  if (existing && new URLSearchParams(location.search).get('fresh') !== '1') {
    // A draft exists → this page load is the post-reload phase 2.
    const reloadToRunStart = performance.now();
    try {
      setPhase('phase2-running', 'phase 2: restoring the journal after a real page reload');
      const phase2 = await runPhase2();
      const allChecks = [...existing.summary.checks, ...phase2.checks];
      const mismatches = [...existing.summary.digestChecks.mismatches, ...phase2.continued.mismatches];
      const failed = allChecks.filter((entry) => !entry.ok);
      const result: SpikeResult = {
        spike: 'phase0/spike-2/single-journal-undo',
        schema: 1,
        phase: 'done',
        verdict: failed.length === 0 && mismatches.length === 0 ? 'PASS' : 'FAIL',
        isolation,
        steps: {
          fixturePages: existing.summary.fixture.pageCount,
          fixtureBytes: existing.summary.fixture.bytes,
          operations: existing.summary.plan.total,
          operationsDistinct: existing.summary.plan.distinct,
          undo: existing.summary.journal.undone,
          redo: existing.summary.journal.redone,
          undoDigestChecks: existing.summary.digestChecks.undoMatches,
          redoDigestChecks: existing.summary.digestChecks.redoMatches,
          chronologyUndoSteps: existing.summary.chronology.revertOrder.length,
          chronologyRedoSteps: existing.summary.chronology.redoOrder.length,
          branchDiscarded: existing.summary.branch.discarded,
          replayedAfterReload: phase2.restored.replayedEntries,
          continuedUndo: phase2.continued.undone,
          continuedRedo: phase2.continued.redone,
        },
        mismatches,
        restored: phase2.restored,
        timings: { ...existing.summary.timings, 'p2.reloadToRunStart': reloadToRunStart, ...phase2.timings },
        checks: allChecks,
        engineEvidence: existing.summary.engine.evidence,
        limits: LIMITS,
        phase1: existing.summary,
        phase2,
      };
      publish(result);
      // Leave no draft behind: the next load of this page must start at phase 1.
      await deleteDraft(DRAFT_ID).catch(() => undefined);
      return;
    } catch (error) {
      publish(failedResult(isolation, error, existing.summary.checks, existing.summary.timings));
      return;
    }
  }

  try {
    const phase1 = await runPhase1();
    const result: SpikeResult = {
      spike: 'phase0/spike-2/single-journal-undo',
      schema: 1,
      phase: 'phase1-done',
      verdict: phase1.checks.every((entry) => entry.ok) && phase1.mismatches.length === 0 ? 'PASS' : 'FAIL',
      isolation,
      steps: {
        fixturePages: phase1.summary.fixture.pageCount,
        fixtureBytes: phase1.summary.fixture.bytes,
        operations: phase1.summary.plan.total,
        operationsDistinct: phase1.summary.plan.distinct,
        undo: UNDO_STEPS,
        redo: REDO_STEPS,
        undoDigestChecks: phase1.summary.digestChecks.undoMatches,
        redoDigestChecks: phase1.summary.digestChecks.redoMatches,
        chronologyUndoSteps: phase1.summary.chronology.revertOrder.length,
        chronologyRedoSteps: phase1.summary.chronology.redoOrder.length,
        branchDiscarded: phase1.summary.branch.discarded,
        replayedAfterReload: 0,
        continuedUndo: 0,
        continuedRedo: 0,
      },
      mismatches: phase1.mismatches,
      restored: null,
      timings: { ...phase1.summary.timings },
      checks: phase1.checks,
      engineEvidence: phase1.evidence,
      limits: LIMITS,
      phase1: phase1.summary,
      phase2: null,
    };
    publish(result);
    setPhase(
      'phase1-done',
      'phase 1 complete: 150 operations, undo 60, redo 40, draft persisted to IndexedDB. Reload the page (F5 or the button) — phase 2 restores the journal and continues undo/redo.',
    );
  } catch (error) {
    publish(failedResult(isolation, error, [], timings));
  }
}

function failedResult(
  isolation: SpikeResult['isolation'],
  error: unknown,
  checks: readonly CheckResult[],
  phaseTimings: Record<string, number>,
): SpikeResult {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    spike: 'phase0/spike-2/single-journal-undo',
    schema: 1,
    phase: 'failed',
    verdict: 'FAIL',
    isolation,
    steps: {
      fixturePages: 0,
      fixtureBytes: 0,
      operations: 0,
      operationsDistinct: 0,
      undo: 0,
      redo: 0,
      undoDigestChecks: 0,
      redoDigestChecks: 0,
      chronologyUndoSteps: 0,
      chronologyRedoSteps: 0,
      branchDiscarded: 0,
      replayedAfterReload: 0,
      continuedUndo: 0,
      continuedRedo: 0,
    },
    mismatches: [],
    restored: null,
    timings: { ...phaseTimings },
    checks: [...checks, check('spike.error', 'spike ran to completion', false, 'no error', message)],
    engineEvidence: null,
    limits: LIMITS,
    phase1: null,
    phase2: null,
    error: message,
  };
}

await main();
