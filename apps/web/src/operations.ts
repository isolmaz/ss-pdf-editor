/**
 * Page-structure actions and the bridge between an operation's produced bytes and
 * the session model.
 *
 * Two things live here and nowhere else:
 *
 * 1. **Materializing the base.** A save (or any
 *    operation) starts from exactly one base PDF. In this app that base is:
 *    what the viewer holds if it has engine-side edits (a form value, an
 *    annotation) → the produced bytes of the newest applied operation → the
 *    untouched master copy. Getting this order wrong is how an operation
 *    silently discards a form value the user just typed.
 *
 * 2. **Applying a result.** Every applied operation produces a *whole new PDF*.
 *    The bytes become the working version, the journal records the change as
 *    data, and the viewer is handed a fresh engine handle — which is also what
 *    makes undo a matter of mounting the previous snapshot (`pdf-model`
 *    `operations.ts`).
 *
 * Structural page actions (rotate/delete/duplicate/move/insert) go through
 * `composeDocument`, i.e. through pdf.js `extractPages` on the live document, so
 * annotations and form values travel with the pages.
 */

import {
  type AnnotationMark,
  type ComposeSource,
  type OperationContext,
  type OperationOutcome,
  type OperationProgress,
  type OutputFile,
  openWithPdfjs,
  type PdfDocumentHandle,
  readAnnotations,
} from 'pdf-core';
import type { PdfOutlineEntry } from 'pdf-core/engines/pdfjs-handle';
import { fieldValueText } from 'pdf-core/ops/form-value';
import type { FormFieldInfo } from 'pdf-core/ops/forms';
import { type MeasureMark, writeMeasureAnnotations } from 'pdf-core/ops/measure';
import type { RedactRect } from 'pdf-core/ops/redact';
import { readPageText } from 'pdf-core/text-source';
import {
  copyForEngine,
  type EngineValuesDraft,
  type JsonValue,
  type PageRef,
  type SessionStore,
  type SessionTab,
} from 'pdf-model';
import { checkDocumentLimits, detectDeviceTier, ToolError, type Translator } from 'pdf-shared';
import type { PageMoveAction } from 'pdf-ui';
import { type MarkRemovalRequest, normalizePendingMarks } from './annotation-interaction';
// The annotation-removal writer loads on its first call (`lazy-ops.ts`): neither the
// barrel nor a static module import may put it in the shell's first paint.
import {
  composeDocument,
  readFormFields,
  removePdfAnnotations,
  syncXfaDatasets,
  writeAnnotationsToFile,
} from './lazy-ops';
import type { SaveStepDescription } from './save-plan';

export interface PendingOverlays {
  readonly engineValues?: EngineValuesDraft;
  readonly annotations: readonly AnnotationMark[];
  readonly measures: readonly MeasureMark[];
  readonly redactions: readonly { readonly id: string; readonly mark: RedactRect }[];
}
export const EMPTY_OVERLAYS: PendingOverlays = { annotations: [], measures: [], redactions: [] };

export function pendingOverlays(tab: SessionTab | null): PendingOverlays {
  return (tab?.working.overlays as unknown as PendingOverlays | null) ?? EMPTY_OVERLAYS;
}

/** Everything a page action needs to touch one tab. */
export interface DocumentContext {
  readonly store: SessionStore;
  readonly t: Translator;
  readonly tab: SessionTab;
  readonly handle: PdfDocumentHandle;
  readonly isCurrent?: () => boolean;
}

export interface OperationHost {
  /** Swap the tab's engine handle, destroying the previous one. */
  readonly setHandle: (tabId: string, handle: PdfDocumentHandle) => void;
  readonly setNotice: (message: string) => void;
  readonly setProgress: (progress: OperationProgress | null) => void;
}

/**
 * The base PDF for an operation or a save. Order matters (see the file header):
 * engine-side edits are materialised first because they live in the engine, not
 * in the bytes.
 *
 * `overlays` is the mark state the base must carry. Selection edits pass empty
 * annotation/measurement lists so surviving overlays stay pending, rather than
 * being painted both by the PDF and by their session copies.
 */
export async function materializeBase(
  context: DocumentContext,
  operation: OperationContext = { signal: new AbortController().signal },
  executedSteps?: SaveStepDescription[],
  overlays: PendingOverlays = pendingOverlays(context.tab),
): Promise<Uint8Array> {
  const produced = context.tab.working.produced ?? null;
  const engineDirty = hasEngineEdits(context.handle);
  let bytes = engineDirty
    ? await context.handle.saveDocument()
    : produced === null
      ? copyForEngine(context.tab.source.master)
      : produced.bytes;
  if (engineDirty)
    executedSteps?.push({ id: 'pdfjs.saveDocument', engine: 'pdfjs', note: 'pending engine values' });
  if (engineDirty) {
    // A static XFA form keeps its data apart from the widgets pdf.js just wrote: bring the
    // data in step (a document without XFA comes back as the same bytes, untouched).
    const synced = await syncXfaDatasets(bytes);
    if (synced.bytes !== bytes) {
      bytes = synced.bytes;
      executedSteps?.push({ id: 'xfa.datasets', engine: 'mupdf', note: 'static XFA data kept in step' });
    }
  }
  // Recovered snapshots may retain measurements already present in their bytes.
  // Normalize here, not only in the shell's current inventory: dialogs, page actions
  // and background materialization all use this same boundary.
  const pending =
    overlays.measures.length === 0
      ? overlays
      : normalizePendingMarks(overlays, await readAnnotations(context.handle, operation));
  if (pending.annotations.length > 0) {
    bytes = await writeSessionAnnotations(bytes, pending.annotations, operation, executedSteps);
  }
  if (pending.measures.length > 0) {
    const outcome = await writeMeasureAnnotations(bytes, pending.measures, operation);
    bytes = outcome.bytes;
    for (const id of outcome.report.steps) {
      executedSteps?.push({ id, engine: outcome.report.engine, note: 'pending measurements' });
    }
  }
  return bytes;
}

/**
 * pdf.js exposes no "is the storage dirty" getter, and its `serializable` getter
 * answers a sentinel when the storage is empty — so the test is whether the
 * storage yields any entry at all (`AnnotationStorage` is `[Symbol.iterator]`-able,
 * `build/pdf.mjs`). Exported because the save execution plan needs the same answer.
 */
export function hasEngineEdits(handle: PdfDocumentHandle): boolean {
  const storage: unknown = handle.raw.annotationStorage;
  if (storage === null || typeof storage !== 'object' || !(Symbol.iterator in storage)) return false;
  for (const _entry of storage as Iterable<unknown>) return true;
  return false;
}

/**
 * The annotation step of the save execution plan: the
 * session's own marks written into the bytes the engine just produced.
 *
 * Runs on a **second** handle over those bytes, because the live handle's storage
 * is the engine's own channel and this write goes through the MuPDF writers for the
 * kinds the engine cannot write. The handle is destroyed here, in a `finally`, so a failed
 * write cannot leak a worker.
 */
export async function writeSessionAnnotations(
  bytes: Uint8Array,
  marks: readonly AnnotationMark[],
  operation: OperationContext,
  executedSteps?: SaveStepDescription[],
): Promise<Uint8Array> {
  const handle = await openWithPdfjs(bytes);
  try {
    const outcome = await writeAnnotationsToFile(
      handle,
      marks,
      operation,
      await readAnnotations(handle, operation),
    );
    for (const id of outcome.report.steps) {
      executedSteps?.push({ id, engine: outcome.report.engine, note: 'pending annotations' });
    }
    return outcome.bytes;
  } finally {
    await handle.destroy();
  }
}

/**
 * The panel owns the *intent* type it emits (`PageMoveAction`), and the app adds
 * the one action only it can perform: inserting another document's bytes. Keeping
 * the union split this way means `pdf-ui` never has to import from `apps/**`.
 */
export type PageAction =
  | PageMoveAction
  | {
      readonly kind: 'insert';
      readonly bytes: Uint8Array;
      readonly pageCount: number;
      readonly insertAfter: number;
    };

/** Page count of the tab's current working version. */
export function tabPageCount(tab: SessionTab): number {
  return tab.working.produced?.pageCount ?? tab.source.pageCount;
}

/**
 * Build the composition a `PageAction` implies. Pure so the action's effect on
 * the page list is reviewable without rendering anything.
 */
export function planPageAction(
  pages: readonly PageRef[],
  selected: readonly number[],
  action: PageAction,
): { readonly pages: readonly PageRef[]; readonly rotations: Record<number, 0 | 90 | 180 | 270> } {
  const selection = [...selected].sort((a, b) => a - b);
  switch (action.kind) {
    case 'delete': {
      const remaining = pages.filter((_page, index) => !selected.includes(index));
      return { pages: remaining, rotations: {} };
    }
    case 'duplicate': {
      const next: PageRef[] = [];
      const rotations: Record<number, 0 | 90 | 180 | 270> = {};
      for (const [index, page] of pages.entries()) {
        next.push(page);
        if (selected.includes(index)) {
          next.push({ ...page, id: `${page.id}~copy${index}` });
        }
      }
      return { pages: next, rotations };
    }
    case 'move': {
      if (selection.length === 0) return { pages, rotations: {} };
      const moving = selection
        .map((index) => pages[index])
        .filter((page): page is PageRef => page !== undefined);
      const rest = pages.filter((_page, index) => !selected.includes(index));
      const target = Math.max(0, Math.min(action.toIndex, rest.length));
      return { pages: [...rest.slice(0, target), ...moving, ...rest.slice(target)], rotations: {} };
    }
    case 'rotate': {
      const delta = action.direction === 'right' ? 90 : 270;
      const rotations: Record<number, 0 | 90 | 180 | 270> = {};
      for (const [index, page] of pages.entries()) {
        if (!selected.includes(index)) continue;
        rotations[index] = ((page.rotation + delta) % 360) as 0 | 90 | 180 | 270;
      }
      return { pages, rotations };
    }
    case 'insert':
      // Insertion is `mergeDocuments`, not a re-composition of this document.
      return { pages, rotations: {} };
  }
}

/** Apply a page action to the active tab: compose, journal, and hand back the new handle. */
export async function applyPageAction(
  context: DocumentContext,
  selected: readonly number[],
  action: PageAction,
  operation: OperationContext,
): Promise<PdfDocumentHandle | null> {
  const { pages, rotations } = planPageAction(context.tab.working.pageOrder, selected, action);
  if (action.kind === 'delete' && pages.length === 0) return null;
  if (action.kind === 'move' && selected.length === 0) return null;
  const unchanged =
    pages.length === context.tab.working.pageOrder.length &&
    pages.every((page, index) => page === context.tab.working.pageOrder[index]) &&
    Object.keys(rotations).length === 0;
  if (unchanged) return null;

  const overlays = pendingOverlays(context.tab);
  const pending = overlays.annotations.length > 0 || overlays.measures.length > 0;
  const handle = pending ? await openWithPdfjs(await materializeBase(context, operation)) : context.handle;
  let outcome: OperationOutcome;
  try {
    outcome = await composeDocument(
      {
        pageCount: pages.length,
        sources: [
          {
            pages: pages.map((page) => page.srcIndex),
            positions: pages.map((_page, index) => index),
            rotations,
          } satisfies ComposeSource,
        ],
      },
      handle.raw,
      operation,
    );
  } finally {
    if (pending) await handle.destroy();
  }
  const label = pageActionLabel(action, selected.length);
  return applyProducedBytes(
    context,
    outcome.bytes,
    outcome.report.pageCount,
    label,
    outcome.report.engine,
    outcome.report.steps,
    operation,
    {
      ...EMPTY_OVERLAYS,
      redactions: pages.flatMap((page, pageIndex) =>
        overlays.redactions
          .filter((item) => item.mark.pageIndex === page.srcIndex)
          .map((item) => ({
            id: `${item.id}:${pageIndex}`,
            mark: { ...item.mark, pageIndex },
          })),
      ),
    },
  );
}

/** Mount produced bytes as the tab's new working version (dialog results). */
export async function applyProducedBytes(
  context: DocumentContext,
  bytes: Uint8Array,
  pageCount: number,
  label: { readonly key: Parameters<Translator>[0]; readonly params?: Record<string, string | number> },
  engine: string,
  steps: readonly string[],
  operation?: OperationContext,
  remaining: PendingOverlays = { ...EMPTY_OVERLAYS, redactions: pendingOverlays(context.tab).redactions },
): Promise<PdfDocumentHandle> {
  const limitVerdict = checkDocumentLimits(detectDeviceTier(), pageCount, bytes.byteLength);
  if (limitVerdict.kind === 'blocked') {
    throw new ToolError(limitVerdict.reason === 'pages' ? 'page-limit' : 'file-too-large', {
      engine: 'model',
      ...(limitVerdict.reason === 'pages' ? { path: context.tab.name } : {}),
    });
  }

  const next = await openWithPdfjs(bytes);
  try {
    const current = context.store.getSnapshot().tabs.find((tab) => tab.id === context.tab.id);
    if (
      operation?.signal.aborted ||
      context.isCurrent?.() === false ||
      current?.working.id !== context.tab.working.id ||
      context.store.active?.id !== context.tab.id
    ) {
      throw new ToolError('aborted', { engine: 'model' });
    }
    context.store.applyOperation({
      tabId: context.tab.id,
      bytes,
      pageCount,
      labelKey: label.key,
      ...(label.params === undefined ? {} : { labelParams: label.params }),
      engine,
      steps,
      overlays: remaining as unknown as JsonValue,
    });
    return next;
  } catch (error) {
    await next.destroy();
    throw error;
  }
}

/**
 * The pending mark state a removal leaves behind: the four lists minus the ids the
 * request names, with every other field — the engine-value delta above all — carried
 * through untouched.
 *
 * A list nothing was removed from keeps its **own array identity**, so a caller that
 * journals the result cannot turn "this family did not change" into a new value the
 * store would record as a change.
 */
export function pruneOverlays(overlays: PendingOverlays, request: MarkRemovalRequest): PendingOverlays {
  const drop = (ids: readonly string[]) => new Set(ids);
  const annotations = drop(request.annotations);
  const measures = drop(request.measures);
  const redactions = drop(request.redactions);
  const without = <T>(items: readonly T[], idOf: (item: T) => string, removed: ReadonlySet<string>) => {
    if (removed.size === 0) return items;
    const kept = items.filter((item) => !removed.has(idOf(item)));
    return kept.length === items.length ? items : kept;
  };
  return {
    ...overlays,
    annotations: without(overlays.annotations, (mark) => mark.id, annotations),
    measures: without(overlays.measures, (mark) => mark.id, measures),
    redactions: without(overlays.redactions, (item) => item.id, redactions),
  };
}

/**
 * The removal that reaches the file: take the frozen base, delete the exact
 * annotation objects the selection named, and hand back the bytes with the mark lists
 * the caller must keep.
 *
 * Three rules hold this together, and each of them was a defect in the alternative:
 *
 *  - **Pending marks stay pending.** Only native form/editor values are materialized.
 *    Baking surviving marks while retaining their overlay copies made the next
 *    render paint them twice and could resurrect a mark after a later deletion.
 *  - **The file's annotations are deleted by the core writer**, not by the engine's
 *    storage: `removePdfAnnotations` resolves each id on its page and removes that
 *    object, refusing a target it cannot resolve instead of reporting a deletion that
 *    never happened (`ops/annotation-remove.ts`).
 *  - **Nothing is applied here.** The bytes are returned; the caller mounts them with
 *    `applyProducedBytes`, which is the one place a working version changes, and which
 *    refuses a result whose tab or working version moved while the write ran.
 *
 * `request.existing` must be non-empty: a pending-only removal is a mark-list edit and
 * never touches bytes — the caller journals that one itself and never calls this.
 */
export async function removeMarkTargets(
  context: DocumentContext,
  request: MarkRemovalRequest,
  operation: OperationContext,
  executedSteps: SaveStepDescription[] = [],
  overlays: PendingOverlays = pendingOverlays(context.tab),
): Promise<{
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly engine: string;
  readonly steps: readonly string[];
  readonly overlays: PendingOverlays;
}> {
  const remaining = pruneOverlays(overlays, request);
  const base = await materializeBase(context, operation, executedSteps, {
    ...remaining,
    annotations: [],
    measures: [],
  });
  const outcome = await removePdfAnnotations(
    base,
    { targets: request.existing.map((target) => ({ pageIndex: target.pageIndex, id: target.id })) },
    operation,
  );
  for (const id of outcome.report.steps) {
    executedSteps.push({ id, engine: outcome.report.engine, note: 'file annotations removed' });
  }
  return {
    bytes: outcome.bytes,
    pageCount: outcome.report.pageCount,
    engine: outcome.report.engine,
    steps: executedSteps.map((step) => step.id),
    overlays: remaining,
  };
}

/** Only byte or engine-delta history replaces a viewer; mark history is model-only. */
export async function applyHistoryStep(
  context: DocumentContext,
  direction: 'undo' | 'redo',
  operation: OperationContext,
) {
  const result = context.store.previewHistory(context.tab.id, direction);
  if (result.kind === 'empty' || result.step.kind === 'unavailable') return null;
  const cursor = context.tab.journal.cursor;
  const produced = result.step.kind === 'overlays' ? context.tab.working.produced : result.step.produced;
  let keepViewer = false;
  if (result.step.kind === 'overlays') {
    const state = result.step.entry.op.payload as { before: JsonValue; after: JsonValue };
    const before = (state.before as unknown as PendingOverlays | null)?.engineValues;
    const after = (state.after as unknown as PendingOverlays | null)?.engineValues;
    // Live overlay edits preserve the delta's identity. Draft JSON does not share
    // object references, so equal restored values use the same fast path as well.
    keepViewer = before === after || JSON.stringify(before) === JSON.stringify(after);
  }
  const next = keepViewer
    ? context.handle
    : await openWithPdfjs(produced?.bytes ?? copyForEngine(context.tab.source.master));
  try {
    const current = context.store.active;
    if (
      operation.signal.aborted ||
      context.isCurrent?.() === false ||
      current?.id !== context.tab.id ||
      current.working.id !== context.tab.working.id ||
      current.journal.cursor !== cursor
    )
      throw new ToolError('aborted', { engine: 'model' });
    const committed =
      direction === 'undo' ? context.store.undo(context.tab.id) : context.store.redo(context.tab.id);
    if (committed.kind === 'empty' || committed.step.kind === 'unavailable') {
      throw new ToolError('aborted', { engine: 'model' });
    }
    return { handle: next, entry: committed.step.entry };
  } catch (error) {
    if (next !== context.handle) await next.destroy();
    throw error;
  }
}

/** Files that a `download` dialog result produces. */
export function downloadFiles(files: readonly OutputFile[]): void {
  for (const file of files) {
    const blob = new Blob([file.bytes as unknown as BlobPart], { type: file.mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    // Generated blob URLs are cleaned up after each operation.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/**
 * What an operation is allowed to change, and what verification therefore promises.
 *
 * The previous shape asked three questions — page count, "is the text still there" on
 * three sampled pages, and a set of form/outline/label presence checks — and decided
 * which of them to *suppress* by matching the operation's change kinds against
 * `/delete|clear|blank|flatten/i`. That regex never matched a single id this app
 * produces (`pdfjs.extractPages`, `form.flatten`, `applyRedactions`, …): the
 * suppression it was written for could only ever fire by accident, and "verified" then
 * meant "the checks I happened to run passed", with nothing recorded about what was
 * never run at all.
 *
 * `OPERATION_TABLE` below is that guess replaced by data. Every step id the app's
 * writers report has one entry saying which of the twelve document facts that step is
 * **allowed** to change and why; a step id the table does not know makes the whole
 * verification `unverified`, named, rather than silently treated as "nothing may
 * change". A fact the operation declared it may change is still *measured* — a declared
 * change that did not happen is worth reporting as `verified` — but a change in it is
 * not a failure. A fact the operation did **not** declare is a preservation promise,
 * and a broken promise throws `verification-failed`.
 *
 * Four outcomes exist. `WriteVerification.state` and `FactCheck.verdict` only ever use
 * the honest ones:
 *
 *  - `verified` — the check ran and the fact held;
 *  - `degraded` — the check was cut short (the memory budget was exceeded, only sampled
 *    pages were compared) or the fact changed under a declaration that allowed it;
 *    `reason` names which of the two, so "degraded" is never a shrug;
 *  - `unsupported` — this build cannot check that fact at all; `reason` names why (no
 *    reference document, the reader has no answer, the reference's own engine storage
 *    overlaps the fact, signature validity needs the trust policy the save path runs
 *    separately);
 *  - `failed` — a checked, promised fact did not hold. This one is never *returned*: it
 *    is thrown as `verification-failed`, because a save that cannot be verified must
 *    not mark the session saved, and the thrown error is where that
 *    verdict lives.
 */

/** The document facts a declaration speaks about. */
export type DocumentFact =
  | 'pageCount'
  | 'pageOrder'
  | 'pageContent'
  | 'formFieldCount'
  | 'formFieldValues'
  | 'annotations'
  | 'outlines'
  | 'pageLabels'
  | 'textContent'
  | 'rotation'
  | 'cropBox'
  | 'signatures';

/** Report order: the page list first, then what is on the pages, then the rest. */
export const DOCUMENT_FACTS: readonly DocumentFact[] = [
  'pageCount',
  'pageOrder',
  'pageContent',
  'textContent',
  'rotation',
  'cropBox',
  'formFieldCount',
  'formFieldValues',
  'annotations',
  'outlines',
  'pageLabels',
  'signatures',
];

/**
 * What verification did with one fact. `failed` never appears in a returned result —
 * the error thrown for it is where that verdict is reported — but it is part of the
 * vocabulary because the throw and the return describe the same table.
 */
export type FactVerdict = 'verified' | 'degraded' | 'unsupported' | 'failed';

/** Why a fact is not `verified`; rendered as `verify.reason.<reason>` in both locales. */
export type VerificationReason =
  | 'budget'
  | 'sampled'
  | 'changed'
  | 'unverified'
  | 'no-reference'
  | 'engine-cannot'
  | 'pending-storage'
  | 'trust-policy';

export interface FactCheck {
  readonly fact: DocumentFact;
  readonly verdict: FactVerdict;
  readonly reason?: VerificationReason;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** One writer step's declaration: what it may change, and why that is the list. */
interface OperationDeclaration {
  /** Step ids as the writers report them; a trailing `*` matches every id with that prefix. */
  readonly steps: readonly string[];
  readonly mayChange: readonly DocumentFact[];
  readonly why: string;
}

/**
 * The step vocabulary of every writer that can journal a `document.change`
 * (`packages/pdf-core/src/ops`, `pdf-ui/src/ops`), each with the facts it may change.
 *
 * Two rules keep this table honest. It is keyed by the id the **engine reports**, never
 * by the label the UI shows — the same id means the same write regardless of which
 * dialog asked for it. And an entry only lists a fact when the writer can really change
 * it: `stamp` draws onto the page and may change its content, `attachments.attach`
 * changes nothing on this list because an embedded file is none of the twelve facts.
 * A step that exists only to load, serialise, or read back the document declares
 * nothing, which is a statement, not an omission: those steps must leave every fact
 * exactly as they found it, and verification enforces that.
 */
const OPERATION_TABLE: readonly OperationDeclaration[] = [
  /* — the page list: composition, imposition, page-set writers — */
  {
    steps: ['pdfjs.extractPages'],
    mayChange: ['pageCount', 'pageOrder', 'pageContent', 'textContent', 'rotation'],
    why: 'composeDocument rebuilds the page list through pdf.js extractPages; delete, move, duplicate, rotate, insert and replace all land on this one step, so no positional fact can be promised for it',
  },
  {
    steps: ['compose.rotate'],
    mayChange: ['rotation'],
    why: 'composeDocument adds a requested quarter turn to the /Rotate of the composed pages',
  },
  {
    steps: ['create.blank'],
    mayChange: ['pageCount', 'pageOrder', 'pageContent', 'textContent', 'rotation', 'cropBox'],
    why: 'create.ts makes a brand-new document of empty pages; nothing of a source exists to keep',
  },
  {
    steps: ['convert.*'],
    mayChange: [
      'pageCount',
      'pageOrder',
      'pageContent',
      'textContent',
      'rotation',
      'cropBox',
      'annotations',
      'outlines',
    ],
    why: 'convert.ts lays another format out as a brand-new PDF and writes its headings as the outline and its links as link annotations; nothing of a PDF source exists to keep',
  },
  {
    steps: ['scan.compose'],
    mayChange: ['pageCount', 'pageOrder', 'pageContent', 'textContent', 'rotation', 'cropBox'],
    why: 'scan.ts composes the scanned pages through images.ts into a brand-new document; nothing of a source survives by construction',
  },
  {
    steps: ['pdfa.*'],
    mayChange: [
      'pageContent',
      'textContent',
      'cropBox',
      'formFieldCount',
      'formFieldValues',
      'annotations',
      'signatures',
    ],
    why: 'pdfa.ts has Ghostscript rewrite the whole file: it flattens form fields, drops hidden annotations and invalidates signatures, may flatten transparency to pictures in PDF/A-1, and writes the visible box as the page; the page count is checked equal and the page order never changes',
  },
  {
    steps: ['images.create'],
    mayChange: ['pageCount', 'pageOrder', 'pageContent', 'textContent', 'rotation', 'cropBox'],
    why: 'images.ts creates a brand-new document; nothing of the source survives by construction',
  },
  {
    steps: ['sheets', 'pages', 'tiles'],
    mayChange: ['pageCount', 'pageOrder', 'pageContent', 'textContent', 'rotation', 'cropBox'],
    why: 'impose builds new sheet pages from the source pages',
  },
  {
    steps: ['boxes'],
    mayChange: ['cropBox'],
    why: 'page-boxes sets the page boxes; the content stream is untouched, so text is not',
  },

  /* — the engine's own save, and the session's overlay writers — */
  {
    steps: ['pdfjs.saveDocument'],
    mayChange: ['formFieldValues', 'annotations'],
    why: 'the engine serialises its own storage: the form values and annotation edits it holds',
  },
  {
    steps: ['annotations.*'],
    mayChange: ['annotations'],
    why: 'the session annotation writers (new marks, retag, shapes) append to the page annotation arrays',
  },
  {
    steps: ['measure.write'],
    mayChange: ['annotations'],
    why: 'a measurement is written as a PDF annotation',
  },
  {
    steps: ['annotations.remove', 'annotations.transform'],
    mayChange: ['annotations'],
    why: 'selection changes only the exact annotation objects it names; page content, outlines and form field appearances stay unchanged',
  },

  /* — form writers — */
  {
    steps: ['form.setText'],
    mayChange: ['formFieldValues'],
    why: 'fillFormFields sets the field values',
  },
  {
    steps: ['form.createField'],
    mayChange: ['formFieldCount', 'formFieldValues'],
    why: 'createFormFields adds field objects',
  },
  {
    steps: ['form.setFlags'],
    mayChange: ['formFieldValues'],
    why: 'field flags belong to the field the value travels with',
  },
  {
    steps: ['form.flatten'],
    mayChange: ['formFieldCount', 'formFieldValues', 'annotations', 'pageContent', 'textContent'],
    why: 'flattening removes the fields and bakes their appearance into the page, which is a visible content change',
  },
  {
    steps: ['form.calculate'],
    mayChange: ['formFieldValues'],
    why: 'calculated values are written into the fields',
  },

  /* — XFA: the data packet, and the form that leaves it — */
  {
    steps: ['xfa.datasets', 'xfa.remove', 'xfa.export'],
    mayChange: [],
    why: 'the XFA packets are none of the twelve facts: writing the datasets, dropping the XFA entry or reading the data leaves the pages, the AcroForm fields and their values exactly as they were',
  },
  {
    steps: ['xfa.flatten'],
    mayChange: ['pageCount', 'pageOrder', 'pageContent', 'textContent', 'rotation', 'cropBox'],
    why: 'the XFA flatten draws the laid-out form as pictures into a brand-new document; nothing of the placeholder page survives by construction',
  },

  /* — content writers — */
  {
    steps: ['stamp', 'watermark'],
    mayChange: ['pageContent', 'textContent'],
    why: 'the stamp draws text or an image onto the page, so the page content and its extracted text change',
  },
  {
    steps: ['images.embed'],
    mayChange: ['pageContent'],
    why: 'an embedded image is drawn content',
  },
  {
    steps: ['mupdf:redact', 'applyRedactions'],
    mayChange: ['pageContent', 'textContent', 'annotations'],
    why: 'redaction removes glyphs from the content stream and can remove the annotations it covers',
  },
  {
    steps: ['text.draw'],
    mayChange: ['pageContent', 'textContent'],
    why: 'the text editor draws the replacement text into the page',
  },
  {
    steps: ['ocr.layer'],
    mayChange: ['pageContent', 'textContent'],
    why: 'the OCR layer adds an invisible text layer to the page',
  },
  {
    steps: ['assemble'],
    mayChange: ['pageContent', 'textContent', 'rotation', 'cropBox', 'annotations'],
    why: 'the rasterising compressor replaces each selected page by an upright picture of itself: its text is gone, its /Rotate becomes 0, its boxes become the picture size and its annotations go with the old content',
  },
  {
    steps: ['extgstate', 'contents'],
    mayChange: ['pageContent'],
    why: 'the opacity writer wraps the page contents and adds a graphics state',
  },
  {
    steps: ['image'],
    mayChange: ['pageContent'],
    why: 'the image editor replaces a drawn image',
  },

  /* — annotation and outline writers — */
  {
    steps: ['link.add', 'link.remove'],
    mayChange: ['annotations'],
    why: 'a link is a PDF annotation',
  },
  {
    steps: ['signature.*', 'cms'],
    mayChange: ['signatures'],
    why: 'signing writes a signature dictionary and a CMS blob, which is the document signature itself',
  },
  {
    steps: ['outline.*'],
    mayChange: ['outlines'],
    why: 'the outline editor edits the document outline tree',
  },
  {
    steps: ['labels'],
    mayChange: ['pageLabels'],
    why: 'the page-label writer sets the /PageLabels number tree',
  },
  {
    steps: ['alt'],
    mayChange: ['pageContent', 'textContent'],
    why: 'an alternative text is written onto the image object it describes',
  },
  {
    steps: ['tags', 'tags.*'],
    mayChange: [],
    why: 'the structure editor rewrites /StructTreeRoot, the ParentTree and the marked-content wrappers (BDC/EMC) of the content streams; nothing it writes is drawn, selectable text or a page-geometry fact, and its own read-back compares the tree and the marked-content operator counts',
  },
  {
    steps: ['ua'],
    mayChange: ['annotations'],
    why: 'the PDF/UA quick fixes write the catalogue (title, language, viewer preferences, mark info), page /Tabs, and the /Contents of a link or the /TU of a field; an annotation text is the only fact of the twelve they touch',
  },
  {
    steps: ['ua.*'],
    mayChange: [],
    why: 'artifact-wrapping of decoration paths and the PDF/UA identifier in the XMP packet add marked-content wrappers and a metadata property; neither is drawn content, text or geometry',
  },

  /* — the sanitiser: one step per category it was asked for — */
  {
    steps: [
      'sanitize.javascript',
      'sanitize.files',
      'sanitize.metadata',
      'sanitize.private',
      'sanitize.thumbnails',
      'sanitize.unused',
    ],
    mayChange: [],
    why: 'scripts, attached files, metadata, private application data, thumbnails and unused objects are not drawn: the pages, their text and the forms are untouched, and the operation proves it by rendering sampled pages before and after',
  },
  {
    steps: ['sanitize.links', 'sanitize.comments'],
    mayChange: ['annotations'],
    why: 'external links and comments are annotations, and removing them removes annotations',
  },
  {
    steps: ['sanitize.forms'],
    mayChange: ['formFieldCount', 'formFieldValues', 'annotations', 'pageContent', 'textContent'],
    why: 'flattening or removing form fields deletes the fields and the widgets and, when flattened, bakes their appearance into the page',
  },
  {
    steps: ['sanitize.layers'],
    mayChange: ['pageContent', 'textContent', 'annotations'],
    why: 'hidden layer content is cut out of the content streams; what the page shows is unchanged (the operation compares renders), but the streams are not',
  },

  /* — encryption — */
  {
    steps: ['encrypt=aes-256', 'save(encrypt=none)'],
    mayChange: ['signatures'],
    why: 'encrypting or decrypting reserialises the file, which breaks the byte range a signature was made over',
  },

  /* — steps that must leave every fact alone: load, serialise, read back, verify — */
  {
    steps: [
      'load',
      'open',
      'mupdf:open',
      'mupdf:save',
      'text.font',
      'save',
      'save(*)',
      'producer',
      'metadata',
      'xmp',
      'structure',
    ],
    mayChange: [],
    why: 'loading, serialising and adding the producer line change none of the twelve facts',
  },
  {
    steps: ['render', 'scan', 'text', 'text.find', 'inspect', 'measure', 'extract-text'],
    mayChange: [],
    why: 'a read-back pass (render, scan, text walk, the find-and-replace search, inspection, measure, text export) changes nothing',
  },
  {
    steps: ['verify', 'pdfjs:verify', 'authenticate'],
    mayChange: [],
    why: 'the operation verifies or authenticates the bytes it already has; it writes nothing',
  },
  {
    steps: ['attach', 'remove'],
    mayChange: [],
    why: 'an embedded file is not one of the twelve facts: the page list, the pages and the forms are untouched',
  },
  {
    steps: ['.skipped'],
    mayChange: [],
    why: 'a writer that reported itself skipped changed nothing at all',
  },
];

/** How the operation whose bytes are being verified identified itself. */
export interface OperationIdentity {
  readonly kind: 'declared' | 'unverified';
  /** Step ids the table does not know; empty when `kind` is `declared`. */
  readonly steps: readonly string[];
}

/** The form inventory of the reference version, as the app already holds it. */
export interface ExpectedFormField {
  /** Fully qualified field name (`readFormFields`). */
  readonly name: string;
  /** The value as one line of text (`fieldValueText`). */
  readonly value: string;
}

export interface WriteVerification {
  /**
   * What the checks establish overall. `verified` means every check that this build
   * can run did run and held; `degraded` means at least one was cut short or measured a
   * declared change; `unsupported` means no check could be made at all. The facts that
   * are `unsupported` **by construction** (`annotations`, `signatures`) are listed in
   * `checks` and do not by themselves lower the state — the state answers "how much of
   * the table did we establish", and `checks` answers "what happened to each fact".
   */
  readonly state: 'verified' | 'degraded' | 'unsupported';
  readonly pageCount: number;
  readonly operation: OperationIdentity;
  /** Facts the operation declared it may change: measured, but not promised. */
  readonly declared: readonly DocumentFact[];
  /** One entry per fact of `DOCUMENT_FACTS`, in that order. */
  readonly checks: readonly FactCheck[];
  /** Pages whose text was compared positionally, ascending. 0-based. */
  readonly sampledPages: readonly number[];
}

export interface VerifyForWriteOptions {
  /** The page count the session's own model declares for these bytes. */
  readonly expectedPageCount: number;
  /** Memory budget for the text-based checks (default 64 MiB). */
  readonly budgetBytes?: number;
  /** The version the output must preserve: the live handle the user is looking at. */
  readonly sourceHandle?: PdfDocumentHandle | null;
  /**
   * Step ids **this run** executed (`save-plan.ts` `executedSteps`). Omitted or empty
   * means "nothing ran in this run", which is the strongest declaration: every fact
   * must survive into the output. Historical steps are deliberately absent — their
   * effect is already inside the reference handle, so declaring them again would only
   * weaken the promise.
   */
  readonly steps?: readonly string[];
  /** The form inventory of the reference version, when the session holds one. */
  readonly expectedFormFields?: readonly ExpectedFormField[] | null;
  readonly signal?: AbortSignal;
}

/** Text compared per page; long enough to tell two pages apart, short enough to be cheap. */
const FINGERPRINT_CHARS = 48;

/** Above this page count the positional comparison is sampled rather than complete. */
const ALL_PAGE_FINGERPRINTS = 64;

/** Writers round boxes to two decimals; a difference below this is the same box. */
const BOX_TOLERANCE = 0.05;

/** Sample policy when the document is too long to fingerprint every page. */
function sampledPageIndices(pageCount: number): readonly number[] {
  return [...new Set([0, Math.floor(pageCount / 2), pageCount - 1])]
    .filter((page) => page >= 0 && page < pageCount)
    .sort((left, right) => left - right);
}

/** The declaration for a run's step ids, and the ids the table does not know. */
function declarationFor(steps: readonly string[] | undefined): {
  readonly facts: ReadonlySet<DocumentFact>;
  readonly identity: OperationIdentity;
} {
  if (steps === undefined) {
    // No declaration at all is not "nothing changes": it is an operation nobody has
    // characterised, and the run must say so.
    return { facts: new Set(), identity: { kind: 'unverified', steps: [] } };
  }
  const facts = new Set<DocumentFact>();
  const unknown: string[] = [];
  for (const step of steps) {
    const entry = OPERATION_TABLE.find((candidate) =>
      candidate.steps.some((known) =>
        known.endsWith('*') ? step.startsWith(known.slice(0, -1)) : known === step,
      ),
    );
    if (entry === undefined) {
      unknown.push(step);
      continue;
    }
    for (const fact of entry.mayChange) facts.add(fact);
  }
  return {
    facts,
    identity: unknown.length === 0 ? { kind: 'declared', steps: [] } : { kind: 'unverified', steps: unknown },
  };
}

function verificationFailure(fact: DocumentFact, engineMessage: string): ToolError {
  return new ToolError('verification-failed', {
    engine: 'pdfjs',
    engineMessage: `${fact}: ${engineMessage}`,
  });
}

interface PageGeometry {
  readonly rotation: number;
  readonly box: readonly [number, number, number, number];
}

/** One page's rotation and view box, or `null` when the reader cannot answer for it. */
async function pageGeometry(handle: PdfDocumentHandle, pageIndex: number): Promise<PageGeometry | null> {
  try {
    const page = await handle.raw.getPage(pageIndex + 1);
    const [x0, y0, x1, y1] = page.view;
    if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return null;
    return { rotation: page.rotate, box: [x0, y0, x1, y1] };
  } catch {
    return null;
  }
}

interface PageSignature {
  readonly text: string;
  readonly size: string;
}

async function pageSignature(handle: PdfDocumentHandle, pageIndex: number): Promise<PageSignature | null> {
  const geometry = await pageGeometry(handle, pageIndex);
  if (geometry === null) return null;
  try {
    const text = await handle.getPageText(pageIndex);
    const [x0, y0, x1, y1] = geometry.box;
    return { text, size: `${(x1 - x0).toFixed(1)}x${(y1 - y0).toFixed(1)}` };
  } catch {
    return null;
  }
}

/** Everything a check needs to record its verdict, so a check cannot forget to. */
type RecordFact = (
  fact: DocumentFact,
  verdict: FactVerdict,
  reason?: VerificationReason,
  params?: Readonly<Record<string, string | number>>,
) => void;

/**
 * The run's promise, as each check reads it: `throw` means the fact was declared to
 * survive and verification promises it; `degrade` is the honest alternative when the
 * operation was never characterised, and it names the step ids that made the
 * operation unknown.
 */
interface PreservePolicy {
  /** True when the fact is declared able to change: a change is measured, not a failure. */
  readonly declared: (fact: DocumentFact) => boolean;
  /** Called when a fact changed without a declaration; throws unless the operation is unverified. */
  readonly changed: (
    fact: DocumentFact,
    engineMessage: string,
    params: Readonly<Record<string, string | number>>,
  ) => void;
}

function policyFor(
  declaredFacts: ReadonlySet<DocumentFact>,
  identity: OperationIdentity,
  record: RecordFact,
): PreservePolicy {
  return {
    declared: (fact) => declaredFacts.has(fact),
    changed: (fact, engineMessage, params) => {
      if (identity.kind === 'declared') throw verificationFailure(fact, engineMessage);
      record(fact, 'degraded', 'unverified', { steps: identity.steps.join(', '), ...params });
    },
  };
}

async function checkGeometry(
  output: PdfDocumentHandle,
  reference: PdfDocumentHandle | null,
  positionalReason: VerificationReason,
  policy: PreservePolicy,
  record: RecordFact,
): Promise<void> {
  if (reference === null) {
    record('rotation', 'unsupported', positionalReason);
    record('cropBox', 'unsupported', positionalReason);
    return;
  }
  let rotationChanged = -1;
  let boxChanged = -1;
  for (let index = 0; index < output.pageCount; index += 1) {
    const produced = await pageGeometry(output, index);
    const source = await pageGeometry(reference, index);
    if (produced === null || source === null) {
      record('rotation', 'unsupported', 'engine-cannot');
      record('cropBox', 'unsupported', 'engine-cannot');
      return;
    }
    // Legality is checked where preservation is not promised, because a rotation that
    // is not a quarter turn and a box with no area are broken pages in any output.
    if (produced.rotation % 90 !== 0) {
      throw verificationFailure('rotation', `page ${index + 1} has rotation ${produced.rotation}`);
    }
    const [x0, y0, x1, y1] = produced.box;
    if (x1 - x0 <= 0 || y1 - y0 <= 0) {
      throw verificationFailure('cropBox', `page ${index + 1} has an empty box`);
    }
    if (produced.rotation !== source.rotation && rotationChanged < 0) rotationChanged = index;
    const sameBox = produced.box.every(
      (value, corner) => Math.abs(value - (source.box[corner] ?? Number.NaN)) <= BOX_TOLERANCE,
    );
    if (!sameBox && boxChanged < 0) boxChanged = index;
  }
  if (rotationChanged < 0) record('rotation', 'verified');
  else if (policy.declared('rotation')) {
    record('rotation', 'degraded', 'changed', { page: rotationChanged + 1 });
  } else {
    policy.changed('rotation', `page ${rotationChanged + 1} rotation changed`, { page: rotationChanged + 1 });
  }
  if (boxChanged < 0) record('cropBox', 'verified');
  else if (policy.declared('cropBox')) {
    record('cropBox', 'degraded', 'changed', { page: boxChanged + 1 });
  } else {
    policy.changed('cropBox', `page ${boxChanged + 1} box changed`, { page: boxChanged + 1 });
  }
}

/** Positional text comparison; returns the pages it compared. */
async function checkText(
  output: PdfDocumentHandle,
  reference: PdfDocumentHandle | null,
  referenceReason: VerificationReason,
  policy: PreservePolicy,
  record: RecordFact,
  budgetOk: boolean,
): Promise<readonly number[]> {
  if (!budgetOk) {
    record('pageOrder', 'degraded', 'budget');
    record('pageContent', 'degraded', 'budget');
    record('textContent', 'degraded', 'budget');
    return [];
  }
  if (reference === null) {
    record('pageOrder', 'unsupported', referenceReason);
    record('pageContent', 'unsupported', referenceReason);
    record('textContent', 'unsupported', referenceReason);
    return [];
  }
  const complete = output.pageCount <= ALL_PAGE_FINGERPRINTS;
  const pages = complete
    ? Array.from({ length: output.pageCount }, (_unused, index) => index)
    : sampledPageIndices(output.pageCount);
  const boxMayChange = policy.declared('cropBox');
  let contentChanged = -1;
  let textLost = -1;
  for (const page of pages) {
    const produced = await pageSignature(output, page);
    const source = await pageSignature(reference, page);
    if (produced === null || source === null) {
      record('pageOrder', 'unsupported', 'engine-cannot');
      record('pageContent', 'unsupported', 'engine-cannot');
      record('textContent', 'unsupported', 'engine-cannot');
      return [];
    }
    // The page size is the view box, which is the `cropBox` fact: an operation declared
    // able to change boxes must not have that same change reported as a different page.
    const fingerprint = (page: PageSignature): string =>
      `${boxMayChange ? '' : page.size}|${page.text.slice(0, FINGERPRINT_CHARS)}`;
    if (fingerprint(produced) !== fingerprint(source) && contentChanged < 0) {
      contentChanged = page;
    }
    // The same text read answers the cruder question too: a page that had text and has
    // none is a blank page whatever else changed.
    if (source.text.length > 20 && produced.text.length === 0 && textLost < 0) textLost = page;
  }
  const sampled = complete ? undefined : ({ count: pages.length } as const);
  for (const fact of ['pageOrder', 'pageContent'] as const) {
    if (contentChanged < 0) {
      if (sampled === undefined) record(fact, 'verified');
      else record(fact, 'degraded', 'sampled', sampled);
    } else if (policy.declared(fact)) {
      record(fact, 'degraded', 'changed', { page: contentChanged + 1 });
    } else {
      policy.changed(fact, `page ${contentChanged + 1} differs from the reference`, {
        page: contentChanged + 1,
      });
    }
  }
  if (textLost < 0) {
    if (sampled === undefined) record('textContent', 'verified');
    else record('textContent', 'degraded', 'sampled', sampled);
  } else if (policy.declared('textContent')) {
    record('textContent', 'degraded', 'changed', { page: textLost + 1 });
  } else {
    policy.changed('textContent', `page ${textLost + 1} lost its text`, { page: textLost + 1 });
  }
  return pages;
}

async function checkForms(
  bytes: Uint8Array,
  expected: readonly ExpectedFormField[] | null,
  policy: PreservePolicy,
  record: RecordFact,
  budgetOk: boolean,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (expected === null) {
    record('formFieldCount', 'unsupported', 'no-reference');
    record('formFieldValues', 'unsupported', 'no-reference');
    return;
  }
  if (!budgetOk) {
    record('formFieldCount', 'degraded', 'budget');
    record('formFieldValues', 'degraded', 'budget');
    return;
  }
  let produced: readonly FormFieldInfo[];
  try {
    produced = await readFormFields(bytes, signal);
  } catch {
    // A form read that failed is not evidence of "no fields" — the previous shape
    // caught the error into `[]` and then reported a drop that never happened.
    record('formFieldCount', 'unsupported', 'engine-cannot');
    record('formFieldValues', 'unsupported', 'engine-cannot');
    return;
  }
  if (produced.length === expected.length) record('formFieldCount', 'verified');
  else if (policy.declared('formFieldCount')) {
    record('formFieldCount', 'degraded', 'changed', { count: produced.length });
  } else {
    policy.changed('formFieldCount', `expected ${expected.length} field(s), found ${produced.length}`, {
      count: produced.length,
    });
  }
  const byName = new Map(produced.map((field) => [field.name, fieldValueText(field.value)]));
  let changedValues = 0;
  for (const field of expected) {
    const value = byName.get(field.name);
    if (value !== undefined && value !== field.value) changedValues += 1;
  }
  if (changedValues === 0) record('formFieldValues', 'verified');
  else if (policy.declared('formFieldValues')) {
    record('formFieldValues', 'degraded', 'changed', { count: changedValues });
  } else {
    policy.changed('formFieldValues', `${changedValues} field value(s) changed`, { count: changedValues });
  }
}

/** Outline entries flattened in document order: presence, count and order in one shape. */
function outlineTitles(entries: readonly PdfOutlineEntry[]): readonly string[] {
  return entries.flatMap((entry) => [entry.title, ...outlineTitles(entry.children)]);
}

async function checkOutlines(
  output: PdfDocumentHandle,
  reference: PdfDocumentHandle | null,
  referenceReason: VerificationReason,
  policy: PreservePolicy,
  record: RecordFact,
  budgetOk: boolean,
): Promise<void> {
  if (reference === null) {
    record('outlines', 'unsupported', referenceReason);
    return;
  }
  if (!budgetOk) {
    record('outlines', 'degraded', 'budget');
    return;
  }
  let producedEntries: readonly PdfOutlineEntry[];
  let sourceEntries: readonly PdfOutlineEntry[];
  try {
    producedEntries = await output.getOutline();
    sourceEntries = await reference.getOutline();
  } catch {
    record('outlines', 'unsupported', 'engine-cannot');
    return;
  }
  const produced = outlineTitles(producedEntries);
  const source = outlineTitles(sourceEntries);
  const same = produced.length === source.length && produced.every((title, index) => title === source[index]);
  if (same) record('outlines', 'verified');
  else if (policy.declared('outlines')) {
    record('outlines', 'degraded', 'changed', { count: produced.length });
  } else {
    policy.changed(
      'outlines',
      `reference had ${source.length} outline entr(ies), output has ${produced.length}`,
      { count: produced.length },
    );
  }
}

async function checkPageLabels(
  output: PdfDocumentHandle,
  reference: PdfDocumentHandle | null,
  referenceReason: VerificationReason,
  policy: PreservePolicy,
  record: RecordFact,
  budgetOk: boolean,
): Promise<void> {
  if (reference === null) {
    record('pageLabels', 'unsupported', referenceReason);
    return;
  }
  if (!budgetOk) {
    record('pageLabels', 'degraded', 'budget');
    return;
  }
  let producedLabels: readonly string[] | null;
  let sourceLabels: readonly string[] | null;
  try {
    producedLabels = await output.raw.getPageLabels();
    sourceLabels = await reference.raw.getPageLabels();
  } catch {
    record('pageLabels', 'unsupported', 'engine-cannot');
    return;
  }
  const produced = producedLabels ?? [];
  const source = sourceLabels ?? [];
  const same = produced.length === source.length && produced.every((label, index) => label === source[index]);
  if (same) record('pageLabels', 'verified');
  else if (policy.declared('pageLabels')) {
    record('pageLabels', 'degraded', 'changed', { count: produced.length });
  } else {
    policy.changed('pageLabels', `reference had ${source.length} label(s), output has ${produced.length}`, {
      count: produced.length,
    });
  }
}

/**
 * Verification before a write. A save that cannot be
 * verified must not mark the session saved, so a fact the operation promised to
 * preserve but did not throws `verification-failed` naming that fact rather than
 * returning a verdict the caller could ignore.
 *
 * What is checked, and with what reference: the produced bytes are read with pdf.js —
 * the same reader the app renders with — and compared against the **live handle** the
 * user is looking at, positionally, fact by fact. Page count is always strict: the
 * bytes must carry the count the session's own model declares for them. Rotation and
 * the view box are read from every page; the text identity of a page (its size plus
 * the head of its extracted text) is compared positionally for every page up to
 * `ALL_PAGE_FINGERPRINTS` and on the first/middle/last page above it; form field names
 * and values come from `readFormFields` against the inventory the session holds;
 * outline entries and page labels are read from both documents. Two facts are reported
 * `unsupported` by construction and never claimed: `annotations` (the reference's page
 * annotations do not include the engine's pending annotation storage, so a count here
 * could not tell a dropped annotation from one this run is writing) and `signatures`
 * (validity needs the trust policy the save path runs through `verifySignatures`).
 *
 * The memory budget is a declared shortcut, not a silent one: above it the text, form,
 * outline and label checks are reported `degraded` with reason `budget`.
 */
export async function verifyForWrite(
  bytes: Uint8Array,
  options: VerifyForWriteOptions,
): Promise<WriteVerification> {
  const budget = options.budgetBytes ?? 64 * 1024 * 1024;
  const signal = options.signal;
  const abort = (): void => {
    if (signal?.aborted === true) throw new ToolError('aborted', { engine: 'model' });
  };

  const handle = await openWithPdfjs(bytes, signal === undefined ? {} : { signal });
  try {
    abort();
    const { facts: declaredFacts, identity } = declarationFor(options.steps);
    const verdicts = new Map<DocumentFact, FactCheck>();
    const record: RecordFact = (fact, verdict, reason, params) => {
      verdicts.set(fact, {
        fact,
        verdict,
        ...(reason === undefined ? {} : { reason }),
        ...(params === undefined ? {} : { params }),
      });
    };
    const policy = policyFor(declaredFacts, identity, record);
    const source = options.sourceHandle ?? null;

    if (handle.pageCount !== options.expectedPageCount) {
      throw verificationFailure(
        'pageCount',
        `expected ${options.expectedPageCount} page(s), produced ${handle.pageCount}`,
      );
    }
    if (source !== null && source.pageCount !== handle.pageCount) {
      if (policy.declared('pageCount')) {
        record('pageCount', 'degraded', 'changed', { count: handle.pageCount });
      } else {
        policy.changed('pageCount', `reference had ${source.pageCount} page(s)`, {
          count: handle.pageCount,
        });
      }
    } else {
      record('pageCount', 'verified');
    }

    /**
     * A page list that changed cannot be compared positionally: the reference has a
     * different page at the position the output holds. That is not a check that failed,
     * it is a check that has no meaning here, and saying so is the difference between
     * this and a silent pass.
     */
    const comparable = source !== null && source.pageCount === handle.pageCount;
    const positionalReason: VerificationReason = source === null ? 'no-reference' : 'changed';
    const budgetOk = bytes.byteLength <= budget;

    await checkGeometry(handle, comparable ? source : null, positionalReason, policy, record);
    const sampledPages = await checkText(
      handle,
      comparable ? source : null,
      positionalReason,
      policy,
      record,
      budgetOk,
    );
    abort();
    await checkForms(bytes, options.expectedFormFields ?? null, policy, record, budgetOk, signal);
    await checkOutlines(handle, comparable ? source : null, positionalReason, policy, record, budgetOk);
    await checkPageLabels(handle, comparable ? source : null, positionalReason, policy, record, budgetOk);

    record('annotations', 'unsupported', 'pending-storage');
    record('signatures', 'unsupported', 'trust-policy');

    const checks = DOCUMENT_FACTS.map(
      (fact): FactCheck => verdicts.get(fact) ?? { fact, verdict: 'unsupported', reason: 'engine-cannot' },
    );
    const state = checks.some((check) => check.verdict === 'degraded')
      ? 'degraded'
      : checks.some((check) => check.verdict === 'verified')
        ? 'verified'
        : 'unsupported';
    return {
      state,
      pageCount: handle.pageCount,
      operation: identity,
      declared: DOCUMENT_FACTS.filter((fact) => declaredFacts.has(fact)),
      checks,
      sampledPages,
    };
  } finally {
    await handle.destroy();
  }
}

/**
 * The words a set of redaction marks covers: the needles the object
 * audit needs to answer "does the file still carry what the user erased".
 *
 * The marks themselves carry geometry only, and `verifyRedaction` deliberately knows
 * *where* content was, not what it said. This reads the page back **before** the
 * erasure — the caller passes the pre-redaction bytes — and takes the characters whose
 * own box lies inside a mark: MuPDF's structured text is already in the app's page
 * space (unrotated, top-left origin, points), which is the space `RedactRect` is stored
 * in, so the mapping is one containment test and no transform.
 *
 * Runs of two characters or more become needles; single characters are dropped because
 * a one-letter needle matches everywhere and would turn the audit into noise that
 * looks like a finding.
 */
export async function redactionNeedles(
  bytes: Uint8Array,
  marks: readonly RedactRect[],
  operation: OperationContext,
): Promise<readonly string[]> {
  if (marks.length === 0) return [];
  const byPage = new Map<number, readonly RedactRect[]>();
  for (const mark of marks) {
    byPage.set(mark.pageIndex, [...(byPage.get(mark.pageIndex) ?? []), mark]);
  }
  const needles: string[] = [];
  const keep = (run: string): void => {
    const trimmed = run.trim();
    if (trimmed.length > 1) needles.push(trimmed);
  };
  for (const [pageIndex, pageMarks] of byPage) {
    if (operation.signal.aborted) throw new ToolError('aborted', { engine: 'model' });
    const page = await readPageText(bytes, pageIndex, operation);
    for (const block of page.blocks) {
      for (const line of block.lines) {
        let run = '';
        for (const glyph of line.chars) {
          const [x0, y0, x1, y1] = glyph.quad;
          const centerX = (x0 + x1) / 2;
          const centerY = (y0 + y1) / 2;
          const covered = pageMarks.some((mark) => {
            const [mx0, my0, mx1, my1] = mark.rect;
            return centerX >= mx0 && centerX <= mx1 && centerY >= my0 && centerY <= my1;
          });
          if (covered) {
            run += glyph.ch;
            continue;
          }
          keep(run);
          run = '';
        }
        keep(run);
      }
    }
  }
  return [...new Set(needles)];
}

/**
 * The journal step and the result notice for a page action, with the count they
 * both need. Every one of these sentences interpolates `{count}`, so the params
 * travel with the key — the notice that showed a literal `{count}` and the
 * History rows that would have shown one are the same defect, and the fix is to
 * stop having two ways to name an action.
 */
export function pageActionLabel(
  action: PageAction,
  selectedCount: number,
): { readonly key: Parameters<Translator>[0]; readonly params: { readonly count: number } } {
  const count = action.kind === 'insert' ? action.pageCount : selectedCount;
  switch (action.kind) {
    case 'rotate':
      return { key: 'pages.rotate.done', params: { count } };
    case 'delete':
      return { key: 'pages.delete.done', params: { count } };
    case 'duplicate':
      return { key: 'pages.duplicate.done', params: { count } };
    case 'move':
      return { key: 'pages.moved', params: { count } };
    case 'insert':
      return { key: 'file.add.done', params: { count } };
  }
}
