/**
 * Reports the applied working state and this output's actual materialization.
 * Byte operations already ran when journaled: never route their history through
 * a second writer chain. The redo tail is not part of the output.
 */
import type { AnnotationMark } from 'pdf-core';
import { type ChangeSummary, NO_CHANGES, type SessionTab } from 'pdf-model';

export interface SaveStepDescription {
  readonly id: string;
  readonly engine: string;
  readonly note: string;
}

export interface SaveExecutionInput {
  readonly tab: SessionTab;
  readonly engineDirty: boolean;
  readonly annotations: readonly AnnotationMark[];
  readonly baseBytes: Uint8Array;
  readonly encryptedOutput: boolean;
  readonly executedSteps: readonly SaveStepDescription[];
}

export interface SaveExecutionPlan {
  readonly changeSet: ChangeSummary;
  readonly plan: { readonly incremental: boolean; readonly encrypted: boolean };
  /** Historical operations already present in the bytes, excluding undone work. */
  readonly appliedSteps: readonly SaveStepDescription[];
  /** Only steps executed to materialize this output, not a replay recipe. */
  readonly steps: readonly SaveStepDescription[];
}

function appliedStepsFor(tab: SessionTab): SaveStepDescription[] {
  const result: SaveStepDescription[] = [];
  for (let index = 0; index < tab.journal.cursor; index += 1) {
    const entry = tab.journal.entries[index];
    if (entry?.op.kind !== 'document.change') continue;
    const payload = entry.op.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
    if (!Array.isArray(payload.steps) || typeof payload.engine !== 'string') continue;
    for (const step of payload.steps) {
      if (typeof step === 'string')
        result.push({ id: step, engine: payload.engine, note: 'already applied' });
    }
  }
  return result;
}

/**
 * The bytes of every version the applied history produced (entries before the cursor, so
 * an undone step's version is not counted), for `signatureWarning`'s `earlier`.
 */
export function appliedVersionBytes(
  tab: SessionTab,
  snapshots: readonly { readonly id: string; readonly bytes: Uint8Array }[],
): Uint8Array[] {
  const ids = new Set<string>();
  for (let index = 0; index < tab.journal.cursor; index += 1) {
    const payload = tab.journal.entries[index]?.op.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) continue;
    if (typeof payload.after === 'string') ids.add(payload.after);
  }
  return snapshots.filter((snapshot) => ids.has(snapshot.id)).map((snapshot) => snapshot.bytes);
}

export function changeSetFor(input: SaveExecutionInput): ChangeSummary {
  const steps = appliedStepsFor(input.tab)
    .map((step) => step.id)
    .join(' ');
  return {
    ...NO_CHANGES,
    annotations: input.engineDirty || input.annotations.length > 0,
    forms: input.engineDirty,
    pageOrder: /extractPages|compose|rotate/i.test(steps),
    overlays: /stamp|bates|watermark|impose|images|ocr/i.test(steps),
    boxes: /page-boxes|boxes/i.test(steps),
    layers: /layers|ocg/i.test(steps),
    widgets: /form|widget/i.test(steps),
    metadata: /metadata/i.test(steps),
    redaction: /applyRedactions/i.test(steps),
    encryption: /encrypt=|decrypt/i.test(steps),
    signature: /signature|pades|ByteRange|CMS/i.test(steps),
  };
}

/**
 * Does `output` start with every byte of `prefix`? That is what an incremental update is:
 * the earlier file, untouched, followed by what was appended (an identical file counts).
 */
export function extendsBytes(output: Uint8Array, prefix: Uint8Array): boolean {
  if (output.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== output[index]) return false;
  }
  return true;
}

/**
 * What saving `output` does to the signatures in `signed`:
 *
 *   - `unchanged` — the output **is** the signed file; there is nothing to warn about;
 *   - `appended`  — the signed bytes are kept and a revision follows: the signatures stay
 *                   valid, and readers report a change after signing;
 *   - `rewritten` — the signed bytes are not kept: the signatures no longer verify.
 *
 * `signed` is one file the signatures were read from; `signatureWarning` asks this for
 * every file that can carry one.
 */
export type SignedBytesFate = 'unchanged' | 'appended' | 'rewritten';

export function signedBytesFate(output: Uint8Array, signed: Uint8Array): SignedBytesFate {
  if (!extendsBytes(output, signed)) return 'rewritten';
  return output.length === signed.length ? 'unchanged' : 'appended';
}

/**
 * The signature warning a save owes the user, or `null` when it owes none.
 *
 * Two files can carry signatures, and each is judged against its own bytes:
 *   - the file the session **opened** (`source`) — an edit that rewrote it has already
 *     broken its signatures, and the save is where that is said, even when the output is
 *     exactly the edited version;
 *   - the version the session **produced** (`produced`), e.g. by signing — compared with
 *     the opened file instead, a document signed in the session never extends it, and the
 *     export of the very file the signing wrote was reported as breaking its signature.
 *
 *   - every **earlier** version the session passed through (`earlier`): a signature made
 *     in the session and rewritten by a later edit is no longer in the newest version at
 *     all, and judging only the newest one reported the broken file as untouched.
 *
 * A file whose bytes the output keeps unchanged is not asked about; a file without
 * signatures is not warned about. The worst fate wins (`rewritten` over `appended`).
 * `verify` is asked only for the files that need it, so an unsigned or untouched
 * document costs no verification.
 */
export async function signatureWarning<Signature>(
  output: Uint8Array,
  source: Uint8Array,
  produced: Uint8Array | null,
  verify: (bytes: Uint8Array) => Promise<readonly Signature[]>,
  earlier: readonly Uint8Array[] = [],
): Promise<{
  readonly fate: Exclude<SignedBytesFate, 'unchanged'>;
  readonly signatures: readonly Signature[];
} | null> {
  const files = [...new Set([source, ...(produced === null ? [] : [produced]), ...earlier])];
  let warning: { fate: Exclude<SignedBytesFate, 'unchanged'>; signatures: readonly Signature[] } | null =
    null;
  for (const bytes of files) {
    const fate = signedBytesFate(output, bytes);
    if (fate === 'unchanged') continue;
    if (warning?.fate === 'rewritten') break;
    const signatures = await verify(bytes);
    if (signatures.length === 0) continue;
    if (warning === null || fate === 'rewritten') warning = { fate, signatures };
  }
  return warning;
}

export function planSaveExecution(input: SaveExecutionInput): SaveExecutionPlan {
  // Incremental is a byte-format fact relative to the immutable input, not a
  // guess from engine names or a rebuilt identity page list.
  const incremental = extendsBytes(input.baseBytes, input.tab.source.master);
  return {
    changeSet: changeSetFor(input),
    plan: { incremental, encrypted: input.encryptedOutput },
    appliedSteps: appliedStepsFor(input.tab),
    steps: input.executedSteps,
  };
}

/** The parts of an operation dialog that decide whether unapplied redaction marks hold it. */
export interface HeldDialog {
  readonly resultKind: 'replace' | 'new-tab' | 'download';
  readonly standalone?: boolean;
  readonly changesPageGeometry?: boolean;
}

/**
 * Whether a dialog must be refused while redaction marks are staged but not applied. Save
 * and Export are held for the same reason (`error.pending-redactions`): a file that leaves
 * the tab — a download such as Word, text or a split, or a new tab such as PDF/A — would
 * still carry the content the marks were meant to remove. A dialog that applies to the tab
 * (`replace`) keeps the marks pending, unless it moves pages under them; one that starts a
 * new document (`standalone`) never reads this one.
 */
export function heldByPendingRedactions(spec: HeldDialog): boolean {
  if (spec.changesPageGeometry === true) return true;
  return spec.standalone !== true && spec.resultKind !== 'replace';
}
