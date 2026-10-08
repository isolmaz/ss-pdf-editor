/**
 * Batch processing: many documents, one ordered rule set, one report.
 *
 * A batch is **not** a second engine and **not** a second save router. Every step
 * of a rule set names an operation this repository already ships (`ops/metadata`,
 * `ops/compress`, `ops/stamp`, `ops/page-labels`, `ops/ocr`, `ops/security`,
 * `ops/image-edit`, `ops/image-opacity`, `ops/text-export`, and the page
 * composition of `ops/compose`), and the runner calls those functions in the
 * order the dependency rules of `pdf-model/src/save-router.ts` require. Nothing
 * here re-implements a writer; the module exists to answer three questions the
 * operations cannot answer on their own:
 *
 *  1. **In what order?** `planSave` orders the steps of *one* save so that a
 *     rewrite cannot undo what a later step added: metadata after the final
 *     rewrite (`metadata-write`), encryption last (`qpdf-encrypt`), page
 *     composition before anything is drawn into the pages. A rule set is the
 *     same problem one level up — a list of saves — so it is ordered by the same
 *     rule (`STEP_PHASE`), and a run whose executed order differs from the
 *     declared order says so in its report instead of quietly reshuffling.
 *  2. **Which path?** The two save paths stay the two paths:
 *     operations that only touch metadata, overlays or image streams run on the
 *     bytes and hand bytes back (the MuPDF writer path), while a step
 *     that changes the *page set* goes through `openWithPdfjs` +
 *     `composeDocument` — the `pdfjs-extract-pages` path `ops/split.ts` and
 *     `apps/web/src/operations.ts` already use for a page composition. There is
 *     no third route and no batch-local composition.
 *  3. **What happens when one file fails?** A dropped or encrypted file in a
 *     hundred-file run must not end the run: the failure is captured per item as
 *     the mapped `ToolError` code, and the remaining items still run.
 *
 * Everything is bounded: an item larger than the desktop document ceiling is
 * refused with `file-too-large`, a rule set longer than `MAX_BATCH_ITEMS` files
 * is refused before any work starts, and the only thing that leaves this module
 * is the `ToolError` contract — an engine's raw English
 * message travels in `ToolError.details.engineMessage` for the report and never
 * becomes a user-facing sentence.
 */

import { LIMITS, type MessageKey, ToolError, type ToolErrorCode, toToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import { openForWrite } from '../engines/mupdf-write';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { type ComposeSource, composeDocument } from './compose';
import {
  type CompressOptions,
  compressDocument,
  type RasterCompressOptions,
  type StructureCompressOptions,
} from './compress';
import { applyImageEdit, type ImageEditRequest, type ImageReplacement } from './image-edit';
import { applyImageOpacity, type ImageOpacityRequest } from './image-opacity';
import { type MetadataWriteOptions, writeMetadata } from './metadata';
import { type OcrOptions, ocrDocument } from './ocr';
import { type PageLabelRange, writePageLabels } from './page-labels';
import { type ProtectOptions, protectDocument } from './security';
import { type StampOptions, stampDocument } from './stamp';
import { exportText, type TextExportOptions } from './text-export';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationProgress,
  type OperationReport,
  type OutputFile,
  throwIfAborted,
} from './types';

/* ------------------------------------------------------------------ *
 * The rule set
 * ------------------------------------------------------------------ */

/** Schema version of the serialised rule set. A template from another version is refused. */
export const BATCH_TEMPLATE_VERSION = 1;

/**
 * One file in a run. Bytes plus a name: a batch is what the user dropped on the
 * dialog, so the runner never opens a file itself (the caller owns the
 * master copy and hands disposable buffers over).
 */
export interface BatchItem {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Which pages a step applies to.
 *
 * `'all'` is resolved **per item**: a batch has no "the document" at the moment
 * the rule set is written, so "every page" has to mean "every page of the file
 * this is running on". An explicit list is 0-based and is validated against the
 * item's own page count — an item with fewer pages fails with `range-invalid`
 * instead of silently stamping the wrong ones.
 */
export type BatchPageSelection = 'all' | readonly number[];

export interface PagesStepParams {
  /** The pages to keep, in output order; `'all'` keeps the document as it is. */
  readonly pages: BatchPageSelection;
  /**
   * Rotation **added** to each page's own `/Rotate`, keyed by output position —
   * the convention `ComposeSource.rotations` documents.
   */
  readonly rotations?: Readonly<Record<number, 0 | 90 | 180 | 270>>;
}

export interface PageLabelsStepParams {
  readonly ranges: readonly PageLabelRange[];
}

export type TextExportStepParams = Omit<TextExportOptions, 'pages'> & {
  readonly pages: BatchPageSelection;
};

/**
 * `Omit` that distributes over a discriminated union — a plain `Omit` of a union
 * collapses to its shared keys, which would silently drop every option that only
 * one variant carries (`dpi`, `quality`, `greyscale`).
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Compression, with the page scope a queue can express. The structure mode takes
 * no page scope at all, so it is *not* widened — only the raster variant is.
 */
export type CompressStepParams =
  | StructureCompressOptions
  | (Omit<RasterCompressOptions, 'pages'> & { readonly pages: BatchPageSelection });

/** Stamps and Bates numbering, page-scoped per item. */
export type StampStepParams = DistributiveOmit<StampOptions, 'pages'> & {
  readonly pages: BatchPageSelection;
};

/** OCR, page-scoped per item. */
export type OcrStepParams = Omit<OcrOptions, 'pages'> & {
  readonly pages: BatchPageSelection;
};

/** A page selection after `'all'` has been resolved against the item's own page count. */
type ResolvedPagesStepParams = Omit<PagesStepParams, 'pages'> & {
  readonly pages: readonly number[];
};

/**
 * Image steps. `opacity` reuses `ops/image-opacity.ts` (a graphics-state write);
 * `replace` reuses `ops/image-edit.ts` and therefore carries **encoded pixels** —
 * the caller supplies them (a re-compressed JPEG is exactly such a replacement),
 * which is why a rule set containing one cannot be written to a template file
 * (`serializeRuleSet` refuses it by name rather than writing megabytes of base64).
 */
export type ImageStepParams =
  | { readonly action: 'opacity'; readonly targets: readonly ImageOpacityRequest[] }
  | {
      readonly action: 'replace';
      readonly replacements: readonly ImageReplacement[];
      readonly dropMask?: boolean;
    };

/** The params of each step kind. */
export interface BatchStepParams {
  readonly pages: PagesStepParams;
  readonly compress: CompressStepParams;
  readonly ocr: OcrStepParams;
  readonly 'page-labels': PageLabelsStepParams;
  readonly stamp: StampStepParams;
  readonly image: ImageStepParams;
  readonly metadata: MetadataWriteOptions;
  readonly 'text-export': TextExportStepParams;
  readonly protect: ProtectOptions;
}

export type BatchStepKind = keyof BatchStepParams;

/** The step kinds a template may name, in the order the dialog lists them. */
export const BATCH_STEP_KINDS: readonly BatchStepKind[] = [
  'pages',
  'compress',
  'ocr',
  'page-labels',
  'stamp',
  'image',
  'metadata',
  'text-export',
  'protect',
];

/**
 * `{ kind, params }` — the discipline `pdf-model/src/operations.ts` uses for the
 * journal: data only, never a function. The union is discriminated on
 * `kind`, so a step whose params do not match its kind is a compile error.
 */
export type BatchStep = {
  readonly [K in BatchStepKind]: { readonly kind: K; readonly params: BatchStepParams[K] };
}[BatchStepKind];

/** A rule set: what the dialog edits, and what a template file holds. */
export interface BatchRuleSet {
  readonly version: number;
  readonly name: string;
  readonly steps: readonly BatchStep[];
}

function isBatchStepKind(value: string): value is BatchStepKind {
  return (BATCH_STEP_KINDS as readonly string[]).includes(value);
}

/**
 * Validate a rule set that is already in memory — the same checks the parser
 * applies to a document, so a hand-built rule set cannot bypass the validator.
 *
 * **Params are not deep-validated here**, deliberately: each operation validates
 * its own arguments (page ranges, DPI, permissions, empty selections) and doing it
 * twice is how two rules for the same value drift apart. What this function owns
 * is the *shape*: the version, the name, and every step kind being one this build
 * knows.
 */
export function validateRuleSet(ruleSet: BatchRuleSet): BatchRuleSet {
  const version = ruleSet.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path: 'version',
      engineMessage: `the schema version is ${String(version)}, not an integer`,
    });
  }
  if (version !== BATCH_TEMPLATE_VERSION) {
    throw new ToolError('unsupported', {
      engine: 'model',
      path: 'version',
      engineMessage: `rule set schema version ${version} is not the ${BATCH_TEMPLATE_VERSION} this build writes`,
    });
  }
  const steps: unknown = ruleSet.steps;
  if (!Array.isArray(steps)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path: 'steps',
      engineMessage: 'steps must be an array',
    });
  }
  if (steps.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      path: 'steps',
      engineMessage: 'a rule set with no steps would write an unchanged copy of every file',
    });
  }
  return {
    version: BATCH_TEMPLATE_VERSION,
    name: typeof ruleSet.name === 'string' ? ruleSet.name : '',
    steps: steps.map((step, index) => parseStep(step, index)),
  };
}

/**
 * Parse one step. Only the three properties this module reads are checked, one
 * by one, rather than through an "is it an object" predicate: a step is valid
 * because its `kind` is a known string and its `params` are an object, and the
 * operation that consumes the params validates their *values*.
 */
function parseStep(entry: unknown, index: number): BatchStep {
  const path = `steps[${index}]`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path,
      engineMessage: 'a step must be an object with a kind and its params',
    });
  }
  const step = entry as Readonly<Record<string, unknown>>;
  const kind = step.kind;
  if (typeof kind !== 'string') {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path: `${path}.kind`,
      engineMessage: 'the step has no kind',
    });
  }
  if (!isBatchStepKind(kind)) {
    // Named on purpose: "unknown step kind" without the name is the sentence a user
    // cannot act on when a template came from a newer build (or a text editor).
    throw new ToolError('unsupported', {
      engine: 'model',
      path: `${path}.kind`,
      engineMessage: `unknown step kind "${kind}" (this build knows ${BATCH_STEP_KINDS.join(', ')})`,
    });
  }
  const params = step.params;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path: `${path}.params`,
      engineMessage: `the "${kind}" step has no params object`,
    });
  }
  // The one place a checked payload becomes a typed step: the kind is proven above,
  // the params object is proven above, and the values are the operation's own to check.
  return { kind, params } as unknown as BatchStep;
}

/**
 * Serialise a rule set to the JSON a template file holds.
 *
 * A step whose params carry raw pixels (a replaced image, a watermark image)
 * cannot be written: the payload would be megabytes of base64 inside a file the
 * user expects to be a small, editable rule sheet. The refusal names the step, so
 * the fix (keep the pixels in the session, save the rest of the rule set) is
 * obvious instead of a silently growing template.
 */
export function serializeRuleSet(ruleSet: BatchRuleSet): string {
  const validated = validateRuleSet(ruleSet);
  assertSerialisable(validated.steps);
  return `${JSON.stringify(
    { version: BATCH_TEMPLATE_VERSION, name: validated.name, steps: validated.steps },
    null,
    2,
  )}\n`;
}

/**
 * Parse a template back into a rule set. The version is checked first, an
 * unknown step kind is refused **by name**, and the result is validated again so
 * a template can never be the one path into the runner that skips the checks.
 */
export function parseRuleSet(json: string): BatchRuleSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    // `JSON.parse` only ever throws a `SyntaxError`.
    const syntax = error as SyntaxError;
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path: 'template',
      engineMessage: `the template is not valid JSON: ${syntax.message}`,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path: 'template',
      engineMessage: 'the template is not a JSON object',
    });
  }
  const template = parsed as Readonly<Record<string, unknown>>;
  const version = template.version;
  if (version !== BATCH_TEMPLATE_VERSION) {
    throw new ToolError('unsupported', {
      engine: 'model',
      path: 'version',
      engineMessage: `rule set schema version ${String(version)} is not the ${BATCH_TEMPLATE_VERSION} this build reads`,
    });
  }
  const steps = template.steps;
  if (!Array.isArray(steps)) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path: 'steps',
      engineMessage: 'the template has no steps array',
    });
  }
  return validateRuleSet({
    version: BATCH_TEMPLATE_VERSION,
    name: typeof template.name === 'string' ? template.name : '',
    steps: steps.map((step, index) => parseStep(step, index)),
  });
}

function assertSerialisable(steps: readonly BatchStep[]): void {
  for (const [index, step] of steps.entries()) walkParams(step.params, `steps[${index}].params`);
}

function walkParams(value: unknown, path: string): void {
  if (value instanceof Uint8Array) {
    throw new ToolError('unsupported', {
      engine: 'model',
      path,
      engineMessage: `${path} holds raw image bytes; a template carries the parameters a run needs, not the pixels`,
    });
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) walkParams(entry, `${path}[${index}]`);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      walkParams(entry, `${path}.${key}`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Dependency order — `planSave`'s rule, one level up
 * ------------------------------------------------------------------ */

/**
 * The phase each step kind belongs to. Phases run in ascending order and the
 * declared order is preserved inside a phase, so a rule set whose author already
 * wrote it in dependency order is executed exactly as written.
 *
 * The numbers are `save-router.ts`'s dependencies spelled out:
 *  - `1` page composition first: everything below draws into, labels or exports
 *    the pages the composition leaves (`pdfjs-extract-pages`);
 *  - `2` compression: a raster run re-renders the pages, so a text layer or an
 *    overlay added before it would be the thing it removes;
 *  - `3` OCR adds that text layer to the final page set;
 *  - `4` page labels: a MuPDF full save, which normalises the catalog and Info;
 *  - `5` the overlay writers (stamp, header/footer, Bates, images) — `writer-steps`;
 *  - `6` metadata after the final rewrite, so Info and XMP survive it
 *    (`metadata-write`);
 *  - `7` the read-only steps: the text export reads the finished bytes, and must
 *    read them before encryption makes them unreadable for every plain-bytes engine;
 *  - `8` encryption last (`qpdf-encrypt`), because pdf.js and MuPDF can only act
 *    on a decrypted document.
 */
const STEP_PHASE: Readonly<Record<BatchStepKind, number>> = {
  pages: 1,
  compress: 2,
  ocr: 3,
  'page-labels': 4,
  stamp: 5,
  image: 5,
  metadata: 6,
  'text-export': 7,
  protect: 8,
};

export interface BatchPlan {
  /** The steps in the order the run executes them. */
  readonly steps: readonly BatchStep[];
  /** The declared order was not the executed order — the report says so. */
  readonly reordered: boolean;
}

/** Order a rule set by the dependency rules above. Pure, so the dialog can preview it. */
export function planBatch(steps: readonly BatchStep[]): BatchPlan {
  const planned = steps
    .map((step, index) => ({ step, index, phase: STEP_PHASE[step.kind] }))
    // Stable by construction: the comparator is the phase only, so two steps of the
    // same phase keep the author's order (`Array.prototype.sort` is stable, ES2023).
    .sort((left, right) => left.phase - right.phase);
  return {
    steps: planned.map((entry) => entry.step),
    reordered: planned.some((entry, position) => entry.index !== position),
  };
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

/**
 * Bound on one run. The report holds the produced bytes of every item (that is
 * what the caller asked for), so the item count is bounded as well as the item
 * size — an unbounded queue is how a batch turns into an out-of-memory crash
 * instead of a message.
 */
export const MAX_BATCH_ITEMS = 256;

export interface BatchProgress {
  readonly itemIndex: number;
  readonly itemName: string;
  /** Items finished before this one. */
  readonly doneItems: number;
  readonly totalItems: number;
  /** Index into the executed order and the step it names. */
  readonly stepIndex: number;
  readonly step: BatchStepKind;
  /**
   * What the running operation itself reported (its phase, its label key, its
   * own done/total). `null` for the item-start event, which the runner emits
   * before the first step so a surface can name the file being processed and
   * abort before any work happens.
   */
  readonly operation: OperationProgress | null;
}

export interface BatchRunOptions {
  /** Checked between steps and between items. */
  readonly signal: AbortSignal;
  readonly onProgress?: (progress: BatchProgress) => void;
}

/** One step's outcome inside a successful item. */
export interface BatchStepResult {
  readonly kind: BatchStepKind;
  /** The operation's own report (`OperationReport`); the text export builds its own. */
  readonly report: OperationReport;
  readonly notes: readonly OperationNote[];
  /** Files the step produced instead of changing the document (the text export). */
  readonly files: readonly OutputFile[];
}

export interface BatchItemDone {
  readonly status: 'done';
  readonly name: string;
  /** The processed document. */
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly steps: readonly BatchStepResult[];
  /** Every file the rule set produced beside the document (text exports). */
  readonly extras: readonly OutputFile[];
}

/**
 * A failed item. The mapped code is the whole contract: the surface reads
 * `messageKey`/`hintKey` from the dictionary and shows `detail` only as a
 * diagnostic.
 */
export interface BatchItemFailure {
  readonly status: 'failed';
  readonly name: string;
  readonly code: ToolErrorCode;
  readonly messageKey: MessageKey;
  readonly hintKey: MessageKey;
  readonly detail: string | null;
  readonly inputBytes: number;
  /** The step that failed; `null` when the item failed before any step ran. */
  readonly step: BatchStepKind | null;
  readonly stepIndex: number | null;
}

export interface BatchItemSkipped {
  readonly status: 'skipped';
  readonly name: string;
  /**
   * `cancelled` = the abort arrived while this item was running (its partial work
   * is dropped, because a half-processed file is not a result).
   * `not-started` = the run stopped before this item was reached.
   */
  readonly reason: 'cancelled' | 'not-started';
}

export type BatchItemResult = BatchItemDone | BatchItemFailure | BatchItemSkipped;

export interface BatchReport {
  readonly ruleSet: { readonly name: string; readonly version: number };
  /** The run stopped early; `completed` names what it finished before that. */
  readonly cancelled: boolean;
  readonly totalItems: number;
  /** Names, in input order — what the surface lists as finished files. */
  readonly completed: readonly string[];
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
  readonly results: readonly BatchItemResult[];
  /** The kinds in execution order, after the dependency rule. */
  readonly order: readonly BatchStepKind[];
  readonly reordered: boolean;
}

/**
 * Apply a rule set to every item. One item's failure is captured and the run
 * continues; cancellation is a report, not an exception, so the surface can still
 * show which files were finished (the whole point of cancelling a long queue
 * instead of losing it).
 *
 * Throws only for a problem with the *run* itself — a rule set the validator
 * refuses, an empty queue, more items than `MAX_BATCH_ITEMS` — and always as the
 * mapped `ToolError` contract.
 */
export async function runBatch(
  items: readonly BatchItem[],
  ruleSet: BatchRuleSet,
  options: BatchRunOptions,
): Promise<BatchReport> {
  const validated = validateRuleSet(ruleSet);
  const plan = planBatch(validated.steps);
  const steps = plan.steps;
  // In bounds by construction: `validateRuleSet` refuses a rule set without steps.
  const firstStep = steps[0] as BatchStep;
  if (items.length === 0) {
    throw new ToolError('input-missing', {
      engine: 'model',
      engineMessage: 'no file was queued',
    });
  }
  if (items.length > MAX_BATCH_ITEMS) {
    throw new ToolError('unsupported', {
      engine: 'model',
      engineMessage: `${items.length} files in one run; the bound is ${MAX_BATCH_ITEMS}`,
    });
  }

  const results: BatchItemResult[] = [];
  let cancelled = false;

  for (const [itemIndex, item] of items.entries()) {
    if (options.signal.aborted) {
      cancelled = true;
      results.push({ status: 'skipped', name: item.name, reason: 'not-started' });
      continue;
    }
    // The item-start event is also the surface's last chance to abort before this
    // file is touched, so the signal is re-read straight after it.
    options.onProgress?.({
      itemIndex,
      itemName: item.name,
      doneItems: itemIndex,
      totalItems: items.length,
      stepIndex: 0,
      step: firstStep.kind,
      operation: null,
    });
    if (options.signal.aborted) {
      cancelled = true;
      results.push({ status: 'skipped', name: item.name, reason: 'cancelled' });
      continue;
    }

    const result = await runItem(item, steps, {
      itemIndex,
      itemName: item.name,
      totalItems: items.length,
      options,
    });
    if (result.kind === 'failed') {
      results.push(result.item);
      continue;
    }
    if (result.kind === 'cancelled') {
      cancelled = true;
      results.push({ status: 'skipped', name: item.name, reason: 'cancelled' });
      continue;
    }
    results.push(result.item);
  }

  return {
    ruleSet: { name: validated.name, version: validated.version },
    cancelled,
    totalItems: items.length,
    completed: names(results, 'done'),
    failed: names(results, 'failed'),
    skipped: names(results, 'skipped'),
    results,
    order: steps.map((step) => step.kind),
    reordered: plan.reordered,
  };
}

function names(results: readonly BatchItemResult[], status: BatchItemResult['status']): readonly string[] {
  return results.filter((result) => result.status === status).map((result) => result.name);
}

/** `fixture-a.pdf` → `fixture-a`: the stem a produced file is named after. */
function itemStem(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

interface ItemRunContext {
  readonly itemIndex: number;
  readonly itemName: string;
  readonly totalItems: number;
  readonly options: BatchRunOptions;
}

type ItemOutcome =
  | { readonly kind: 'done'; readonly item: BatchItemDone }
  | { readonly kind: 'failed'; readonly item: BatchItemFailure }
  | { readonly kind: 'cancelled' };

/** Apply every step to one item, in the plan's order. */
async function runItem(
  item: BatchItem,
  steps: readonly BatchStep[],
  context: ItemRunContext,
): Promise<ItemOutcome> {
  if (item.bytes.length > LIMITS.desktop.maxBytes) {
    return {
      kind: 'failed',
      item: {
        status: 'failed',
        name: item.name,
        inputBytes: item.bytes.length,
        code: 'file-too-large',
        messageKey: 'error.file-too-large.message',
        hintKey: 'error.file-too-large.hint',
        detail: `item is ${item.bytes.length} bytes, the ceiling is ${LIMITS.desktop.maxBytes}`,
        step: null,
        stepIndex: null,
      },
    };
  }

  let bytes = item.bytes;
  let pageCount = 0;
  let measured: number | null = null;
  const stepResults: BatchStepResult[] = [];
  const extras: OutputFile[] = [];

  for (const [stepIndex, step] of steps.entries()) {
    try {
      throwIfAborted(context.options.signal);
      const operation: OperationContext = {
        signal: context.options.signal,
        onProgress: (progress) =>
          context.options.onProgress?.({
            itemIndex: context.itemIndex,
            itemName: context.itemName,
            doneItems: context.itemIndex,
            totalItems: context.totalItems,
            stepIndex,
            step: step.kind,
            operation: progress,
          }),
      };
      /** The page count of the bytes in hand: the last report's, else a measurement. */
      const count = async (): Promise<number> => {
        if (measured !== null) return measured;
        measured = await measurePageCount(bytes);
        return measured;
      };
      const resolve: PageResolver = async (selection, path) => resolvePages(selection, await count(), path);
      const result = await applyStep(bytes, step, operation, resolve);
      stepResults.push(result);
      // A step that produces a file (the text export) names it after **this item**:
      // one rule set runs over many documents, and two exports sharing one name
      // would overwrite each other in the download.
      extras.push(...result.files.map((file) => ({ ...file, name: `${itemStem(item.name)}-${file.name}` })));
      bytes = result.bytes;
      // The report describes the bytes this step produced, so it is also the page
      // count the *next* step's `'all'` has to mean.
      pageCount = result.report.pageCount;
      measured = result.report.pageCount;
    } catch (error) {
      // An abort is the run's own cancellation, not a failure of the file: the
      // signal is authoritative, and a slow engine that threw for another reason
      // after an abort is still an abort.
      if (context.options.signal.aborted) return { kind: 'cancelled' };
      const failure = toToolError(error, 'model');
      return {
        kind: 'failed',
        item: {
          status: 'failed',
          name: item.name,
          inputBytes: item.bytes.length,
          code: failure.code,
          messageKey: failure.messageKey,
          hintKey: failure.hintKey,
          detail: failure.details.engineMessage ?? null,
          step: step.kind,
          stepIndex,
        },
      };
    }
  }

  return {
    kind: 'done',
    item: {
      status: 'done',
      name: item.name,
      bytes,
      pageCount,
      inputBytes: item.bytes.length,
      outputBytes: bytes.length,
      steps: stepResults,
      extras,
    },
  };
}

/* ------------------------------------------------------------------ *
 * One step, one existing operation
 * ------------------------------------------------------------------ */

interface StepResult {
  readonly kind: BatchStepKind;
  readonly bytes: Uint8Array;
  readonly report: OperationReport;
  readonly notes: readonly OperationNote[];
  readonly files: readonly OutputFile[];
}

/**
 * The item's page count, measured once per item and reused. A step's own report
 * already carries the page count of the bytes it produced, so the count is only
 * measured (through the MuPDF writer base, the same open every writer makes) when
 * the *first* page-scoped step of an item needs it — which is also why a batch
 * whose first page-scoped step runs on a password-locked item fails that item with
 * the engine's honest code (`encrypted-unsupported`) instead of guessing.
 */
async function measurePageCount(bytes: Uint8Array): Promise<number> {
  const { doc } = await openForWrite(bytes);
  try {
    return doc.countPages();
  } catch (error) {
    throw mapMupdfError(error, 'measure page count');
  } finally {
    doc.destroy();
  }
}

/** `'all'` and an explicit list resolve to the same thing: 0-based pages of *this* item. */
function resolvePages(selection: BatchPageSelection, pageCount: number, path: string): readonly number[] {
  if (selection === 'all') {
    return Array.from({ length: pageCount }, (_unused, index) => index);
  }
  for (const page of selection) {
    if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) {
      throw new ToolError('range-invalid', {
        engine: 'model',
        path,
        pageIndex: page,
        engineMessage: `${path} names page ${page} of a ${pageCount}-page document`,
      });
    }
  }
  return selection;
}

/** Resolve a step's page selection, measuring the item only when it has to. */
type PageResolver = (selection: BatchPageSelection, path: string) => Promise<readonly number[]>;

async function applyStep(
  bytes: Uint8Array,
  step: BatchStep,
  context: OperationContext,
  pages: PageResolver,
): Promise<StepResult> {
  switch (step.kind) {
    case 'pages': {
      const selection = await pages(step.params.pages, 'pages');
      return fromOutcome(step.kind, await composePages(bytes, { ...step.params, pages: selection }, context));
    }
    case 'compress': {
      const options: CompressOptions =
        step.params.mode === 'structure'
          ? step.params
          : { ...step.params, pages: await pages(step.params.pages, 'compress.pages') };
      return fromOutcome(step.kind, await compressDocument(bytes, options, context));
    }
    case 'ocr': {
      const options: OcrOptions = {
        ...step.params,
        pages: await pages(step.params.pages, 'ocr.pages'),
      };
      return fromOutcome(step.kind, await ocrDocument(bytes, options, context));
    }
    case 'page-labels':
      return fromOutcome(step.kind, await writePageLabels(bytes, step.params.ranges, context));
    case 'stamp': {
      const options: StampOptions = {
        ...step.params,
        pages: await pages(step.params.pages, 'stamp.pages'),
      };
      return fromOutcome(step.kind, await stampDocument(bytes, options, context));
    }
    case 'image':
      return fromOutcome(step.kind, await applyImage(bytes, step.params, context));
    case 'metadata':
      return fromOutcome(step.kind, await writeMetadata(bytes, step.params, context));
    case 'text-export': {
      const documentPages = (await pages('all', 'text-export.pages')).length;
      return await runTextExport(
        bytes,
        { ...step.params, pages: await pages(step.params.pages, 'text-export.pages') },
        documentPages,
        context,
      );
    }
    case 'protect':
      return fromOutcome(step.kind, await protectDocument(bytes, step.params, context));
  }
}

/**
 * The page-extraction path, for bytes (`extractPages`). It is the
 * path `ops/split.ts` takes and the reason a batch-local composition is not
 * written here: open the item with the pdf.js adapter, compose through
 * `composeDocument` on that live document, destroy it.
 */
async function composePages(
  bytes: Uint8Array,
  params: ResolvedPagesStepParams,
  context: OperationContext,
): Promise<OperationOutcome> {
  const sources: readonly ComposeSource[] = [
    params.rotations === undefined
      ? { pages: params.pages }
      : { pages: params.pages, rotations: params.rotations },
  ];
  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  try {
    // The pages are validated twice already: against the item's page count when the
    // selection was resolved, and against this live document inside `composeDocument`.
    return await composeDocument(
      {
        pageCount: params.pages.length,
        // Positions are stated explicitly: a repeated page must land where the
        // author put it, not where "fill the remaining slots" would put it.
        sources: sources.map((source) => ({
          ...source,
          positions: source.pages.map((_page, position) => position),
        })),
      },
      handle.raw,
      context,
    );
  } finally {
    await handle.destroy();
  }
}

/**
 * The image steps. `opacity` is one operation call per target folded into a
 * single report (each call re-serialises the file, so a rule set that fades three
 * images is three writes — reported as one step, with every note kept).
 */
async function applyImage(
  bytes: Uint8Array,
  params: ImageStepParams,
  context: OperationContext,
): Promise<OperationOutcome> {
  if (params.action === 'replace') {
    const request: ImageEditRequest = {
      replacements: params.replacements,
      ...(params.dropMask === undefined ? {} : { dropMask: params.dropMask }),
    };
    return await applyImageEdit(bytes, request, context);
  }
  const [firstTarget, ...otherTargets] = params.targets;
  if (firstTarget === undefined) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: 'the opacity step names no image',
    });
  }
  const head = await applyImageOpacity(bytes, firstTarget, context);
  const outcomes: OperationOutcome[] = [head];
  let tail = head;
  for (const target of otherTargets) {
    tail = await applyImageOpacity(tail.bytes, target, context);
    outcomes.push(tail);
  }
  return {
    bytes: tail.bytes,
    report: {
      engine: 'mupdf',
      steps: outcomes.flatMap((outcome, index) =>
        outcome.report.steps.map((entry) => `image[${index}].${entry}`),
      ),
      notes: outcomes.flatMap((outcome) => outcome.report.notes),
      inputBytes: head.report.inputBytes,
      outputBytes: tail.report.outputBytes,
      pageCount: tail.report.pageCount,
      // Every write re-serialises the file.
      incremental: false,
    },
  };
}

/**
 * The text export changes nothing: it produces a file. The step's report is
 * therefore built here — with the export's own numbers and the dictionary's own
 * sentences — rather than faking a writer report for a read.
 */
async function runTextExport(
  bytes: Uint8Array,
  params: TextExportOptions,
  documentPages: number,
  context: OperationContext,
): Promise<StepResult> {
  if (params.pages.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'pdfjs',
      engineMessage: 'the text export names no page',
    });
  }
  const result = await exportText(bytes, params, context);
  const notes: readonly OperationNote[] =
    result.characterCount === 0
      ? [note('warning', 'export.text.empty')]
      : [
          note('changed', 'export.text.covered', { count: params.pages.length }),
          note('changed', 'export.text.done', { name: result.file.name }),
        ];
  return {
    kind: 'text-export',
    bytes,
    report: {
      engine: 'pdfjs',
      steps: ['extract-text'],
      notes,
      inputBytes: bytes.length,
      outputBytes: bytes.length,
      // The document is untouched: its page count, not the number of pages exported.
      pageCount: documentPages,
      incremental: true,
    },
    notes,
    files: [result.file],
  };
}

function fromOutcome(kind: BatchStepKind, outcome: OperationOutcome): StepResult {
  return {
    kind,
    bytes: outcome.bytes,
    report: outcome.report,
    notes: outcome.report.notes,
    files: [],
  };
}
