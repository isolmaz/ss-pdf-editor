/**
 * The sentences the shell puts on its notice line, as data.
 *
 * Three failure paths in `App.tsx` used to end in either silence or a sentence that was
 * not about what happened: a restored draft whose engine values were all dropped said
 * nothing at all, a rejected `applyEngineValues` had no `catch` (an unhandled rejection,
 * invisible in the product and noisy in the console), and a cancelled picker's error
 * handler replaced the real open failure with `open.pickerFailed`. Each of them is a
 * *sentence* problem — which words, with which numbers — and sentences built inline in
 * a 3 600-line component cannot be tested without a DOM.
 *
 * So the choice of words is a pure function here, and the component only renders the
 * result. A descriptor carries the dictionary key plus the numbers that key
 * interpolates, never English text: `renderNotice` is the one place that reaches the
 * translator. Facts of the verification table travel as *keys* too and are
 * translated where they are rendered, because "verified" without its list is the
 * sentence this module exists to stop producing.
 */

import { isToolError, type MessageKey, type Translator } from 'pdf-shared';
import type { DocumentFact, FactCheck, WriteVerification } from './operations';

/**
 * One notice line, before it is words. `params` is what the key interpolates; `facts`
 * are the document facts the sentence names, each with the reason it carries in
 * parentheses. Facts travel as *keys* and are translated where they are rendered,
 * because "verified" without its list is the sentence this module exists to stop
 * producing.
 */
export interface NoticeDescriptor {
  readonly key: MessageKey;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly facts?: readonly NoticeFact[];
}

/** One named fact in a notice: its key, and why it did not come back clean. */
export interface NoticeFact {
  readonly key: MessageKey;
  readonly reason?: MessageKey;
  readonly reasonParams?: Readonly<Record<string, string | number>>;
}

/** The dictionary key naming one document fact (`verify.fact.*`). */
const FACT_KEYS: Readonly<Record<DocumentFact, MessageKey>> = {
  pageCount: 'verify.fact.pageCount',
  pageOrder: 'verify.fact.pageOrder',
  pageContent: 'verify.fact.pageContent',
  formFieldCount: 'verify.fact.formFieldCount',
  formFieldValues: 'verify.fact.formFieldValues',
  annotations: 'verify.fact.annotations',
  outlines: 'verify.fact.outlines',
  pageLabels: 'verify.fact.pageLabels',
  textContent: 'verify.fact.textContent',
  rotation: 'verify.fact.rotation',
  cropBox: 'verify.fact.cropBox',
  signatures: 'verify.fact.signatures',
};

/** The dictionary key naming why a fact is not `verified` (`verify.reason.*`). */
const REASON_KEYS: Readonly<Record<NonNullable<FactCheck['reason']>, MessageKey>> = {
  budget: 'verify.reason.budget',
  sampled: 'verify.reason.sampled',
  changed: 'verify.reason.changed',
  unverified: 'verify.reason.unverified',
  'no-reference': 'verify.reason.no-reference',
  'engine-cannot': 'verify.reason.engine-cannot',
  'pending-storage': 'verify.reason.pending-storage',
  'trust-policy': 'verify.reason.trust-policy',
};

/** One descriptor as the words the notice line shows. */
export function renderNotice(descriptor: NoticeDescriptor, t: Translator): string {
  const facts =
    descriptor.facts === undefined
      ? undefined
      : descriptor.facts
          .map((fact) =>
            fact.reason === undefined
              ? t(fact.key)
              : `${t(fact.key)} (${t(fact.reason, fact.reasonParams ?? {})})`,
          )
          .join(', ');
  return t(descriptor.key, {
    ...descriptor.params,
    ...(facts === undefined ? {} : { facts }),
  });
}

/**
 * The notice line as the shell shows it: one sentence after another, space separated —
 * the shape every existing call site already used by hand (`${t(a)} ${t(b)}`). One
 * function, because joining notices by hand is how a sentence gets dropped.
 */
export function noticeLine(descriptors: readonly NoticeDescriptor[], t: Translator): string {
  return descriptors.map((descriptor) => renderNotice(descriptor, t)).join(' ');
}

/**
 * What a finished engine-values restore did.
 *
 * The count of applied edits is the product's promise, so a restore that applied
 * **nothing** must say so instead of leaving the user with a document that silently
 * lost the draft's form values. `dropped` is only ever mentioned when it is non-zero —
 * "0 edits could not be carried" is a sentence that reads like a loss and is not one —
 * and it is the writer's own count, not a number this module derives.
 */
export function engineValuesNotices(input: {
  readonly applied: number;
  readonly carried: number;
  readonly dropped: number;
}): readonly NoticeDescriptor[] {
  if (input.applied === 0) return [{ key: 'draft.engineValuesLost', params: { count: input.carried } }];
  const restored: NoticeDescriptor = { key: 'draft.engineValues', params: { count: input.applied } };
  if (input.dropped <= 0) return [restored];
  return [restored, { key: 'draft.engineValuesDropped', params: { count: input.dropped } }];
}

/**
 * A failure as the two sentences the product uses everywhere: a `ToolError`'s own
 * message and hint when it is one, and `fallback` only when the cause is not a
 * `ToolError` at all (the dictionary is the text, the engine message is
 * diagnostics). The fallback is a parameter because the honest sentence depends on the
 * path — a failed open, a failed draft write and a failed engine release are different
 * promises.
 */
export function failureNotices(error: unknown, fallback: MessageKey): readonly NoticeDescriptor[] {
  if (!isToolError(error)) return [{ key: fallback }];
  return [{ key: error.messageKey }, { key: error.hintKey }];
}

/**
 * The sentence for a document that is open but whose recovery copy (the draft source in
 * the browser's storage, the recent-file reference) could not be written. The write is
 * not part of opening: the tab stays, and this is what the user is told — with the
 * storage error's own reason, not an open failure's. The browser reports a full quota as
 * a `QuotaExceededError` DOMException, which is not a `ToolError`, so it is mapped here:
 * a full store is `quota-exceeded`, any other storage failure is named as the browser's
 * storage refusing the write (`draft.storageRefused`), not as a file that could not be written.
 * The same sentence is used by the autosave when it fails, so it is one wording everywhere.
 */
export function storedCopyWarning(error: unknown, t: Translator): string {
  const reason: MessageKey = isToolError(error)
    ? error.messageKey
    : error instanceof Error && error.name === 'QuotaExceededError'
      ? 'error.quota-exceeded.message'
      : 'draft.storageRefused';
  return t('draft.sourceNotStored', { reason: t(reason) });
}

/**
 * A success line followed by the warning the same action raised, if any. The shell has one
 * notice line, so a later `setNotice(success)` would silently replace a warning set before
 * it; the callers of an open that can warn put both in the one line they set.
 */
export function appendWarning(line: string, warning: string | null): string {
  return warning === null ? line : `${line} ${warning}`;
}

/** The descriptor for one fact, with the reason it is not clean. */
function factNotice(check: FactCheck): NoticeFact {
  return {
    key: FACT_KEYS[check.fact],
    ...(check.reason === undefined
      ? {}
      : {
          reason: REASON_KEYS[check.reason],
          ...(check.params === undefined ? {} : { reasonParams: check.params }),
        }),
  };
}

/**
 * The verification table of a save or export, as notice lines.
 *
 * The verified group is always reported, because "the save was verified" is a claim
 * about specific checks and the user is entitled to see which. The declared group is
 * reported only when something is wrong with the rest, so an ordinary save is not
 * buried under the list of facts the operation was allowed to touch. A fact whose
 * verdict is `failed` cannot appear here: that verdict throws instead
 * (`operations.ts` `verifyForWrite`).
 */
export function verificationNotices(verification: WriteVerification): readonly NoticeDescriptor[] {
  const group = (verdict: FactCheck['verdict'], key: MessageKey): readonly NoticeDescriptor[] => {
    const checks = verification.checks.filter((check) => check.verdict === verdict);
    if (checks.length === 0) return [];
    return [{ key, facts: checks.map(factNotice) }];
  };
  return [
    ...group('verified', 'verify.verified'),
    ...group('degraded', 'verify.degraded'),
    ...group('unsupported', 'verify.unsupported'),
    ...(verification.state === 'verified'
      ? []
      : [
          {
            key: 'verify.declared' as const,
            facts: verification.declared.map((fact): NoticeFact => ({ key: FACT_KEYS[fact] })),
          },
        ]),
  ];
}

/**
 * What a redaction audit covered: how many terms the scan was given, and
 * whether it reported residual text. A clean report over zero terms says nothing about
 * the file, and the previous call site passed an empty needle list — the sentence has
 * to separate "we looked and found nothing" from "we had nothing to look for".
 */
export function auditNotice(input: {
  readonly terms: number;
  readonly contentFindings: number;
}): NoticeDescriptor {
  if (input.contentFindings > 0)
    return { key: 'audit.notice.residual', params: { count: input.contentFindings } };
  return { key: 'audit.notice.terms', params: { count: input.terms } };
}
