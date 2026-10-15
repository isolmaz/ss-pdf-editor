/**
 * Which results the user must read before they reach the document.
 *
 * A result that lost nothing, warns of nothing and says nothing was approximated is applied the
 * moment the run ends (`OperationForm`): the document keeps an undo step for it, so a review
 * screen before it would only be a second button to press. Every other result keeps the review.
 *
 * The rule reads the report model (`OperationNoteKind`), not the operation:
 *
 *  - `lost` — the user must be told something is gone: always a review.
 *  - `warning` — an advisory, among them what could not be checked: always a review.
 *  - `changed` — what the operation did. Almost every run has some ("12 pages stamped"), so the
 *    kind cannot decide; only the notes in {@link REVIEW_CHANGES}, which say the output differs
 *    from what was asked or was not fully checked, do.
 *  - `preserved` — a guarantee: never a review.
 *
 * A result with no file has nothing to apply: its report is the whole answer (a form check that
 * wrote nothing), so it is read.
 */

import type { MessageKey } from 'pdf-shared';
import type { OpRunResult } from './types';

/**
 * The `changed` notes that mean the output is not what was asked for, or is not fully verified:
 * a replacement text that did not fit and was shrunk, moved or reflowed, a justified line the
 * check cannot measure, a conversion that is approximate, form fields that now share a value.
 */
const REVIEW_CHANGES: ReadonlySet<MessageKey> = new Set<MessageKey>([
  'op.note.findReplace.shrunk',
  'op.note.findReplace.moved',
  'op.note.findReplace.reflowed',
  'op.note.findReplace.standardFace',
  'op.note.textEdit.justified',
  'op.note.merge.sharedFields',
  'op.note.convert.docxApproximate',
  'op.note.convert.pptxApproximate',
  'op.note.convert.xlsxApproximate',
  'op.note.convert.encoding',
  'op.note.compose.outlineCopies',
  'op.note.security.ownerPasswordGenerated',
  'boxes.note.clamped',
  'boxes.note.minCrop',
  'form.note.flattenHidden',
]);

export function resultNeedsReview(result: OpRunResult): boolean {
  return (
    result.files.length === 0 ||
    result.report.notes.some(
      (note) =>
        note.kind === 'lost' ||
        note.kind === 'warning' ||
        (note.kind === 'changed' && REVIEW_CHANGES.has(note.key)),
    )
  );
}
