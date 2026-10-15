/**
 * Page tidy-up dialogs: remove blank pages, split two-up scans.
 *
 * Both are `replace` dialogs that read the frozen bytes once and hand back a new version. The
 * run is the preview: what it found is in the report, and a result that removes pages is
 * always read before it is applied (a `lost` note, see `dialogs/review.ts`). When the run
 * finds nothing to do it returns no file, so the report is the whole answer and the document
 * is not touched.
 */

import {
  composeDocument,
  formatPageRanges,
  note,
  type OperationOutcome,
  type OperationReport,
  openWithPdfjs,
} from 'pdf-core';
import { findBlankPages, splitTwoUpPages } from 'pdf-core/ops/page-tidy';
import type { MessageKey } from 'pdf-shared';
import type { OperationDialogSpec, OpRunContext, OpRunResult } from '../dialogs/types';
import { resolveScope } from './scope';

/** A run that changed nothing: no file, and a report that says why. */
function unchanged(context: OpRunContext, kind: 'preserved' | 'warning', key: MessageKey): OpRunResult {
  const report: OperationReport = {
    engine: 'mupdf',
    steps: ['scan'],
    notes: [note(kind, key)],
    inputBytes: context.bytes.length,
    outputBytes: context.bytes.length,
    pageCount: context.pageCount,
    incremental: true,
  };
  return { files: [], report, noticeKey: key };
}

/**
 * Remove the pages that have nothing on them. The detection is `findBlankPages`; the removal
 * is a composition of the pages that stay, on the document that owns the annotation storage,
 * like an extraction.
 */
export const removeBlankPagesDialog: OperationDialogSpec = {
  id: 'remove-blank-pages',
  titleKey: 'tidy.blank.title',
  introKey: 'tidy.blank.intro',
  confirmKey: 'tidy.blank.confirm',
  resultKind: 'replace',
  changesPageGeometry: true,
  fields: [],
  run: async (_params, context) => {
    const progress = { signal: context.signal, onProgress: context.onProgress };
    const blank = await findBlankPages(context.bytes, progress);
    if (blank.length === 0) return unchanged(context, 'preserved', 'tidy.blank.none');
    if (blank.length === context.pageCount) {
      return unchanged(context, 'warning', 'tidy.blank.all');
    }

    const gone = new Set(blank);
    const kept = Array.from({ length: context.pageCount }, (_unused, page) => page).filter(
      (page) => !gone.has(page),
    );
    const handle = await openWithPdfjs(context.bytes, { signal: context.signal });
    let outcome: OperationOutcome;
    try {
      outcome = await composeDocument(
        { pageCount: kept.length, sources: [{ pages: kept }] },
        handle.raw,
        progress,
      );
    } finally {
      await handle.destroy();
    }
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: {
        ...outcome.report,
        notes: [
          note('lost', 'tidy.blank.removed', { count: blank.length, pages: formatPageRanges(blank) }),
          ...outcome.report.notes,
        ],
      },
      noticeKey: 'tidy.blank.done',
      noticeParams: { count: blank.length },
    };
  },
};

/** Split each landscape page of the scope into a left and a right page. */
export const splitTwoUpDialog: OperationDialogSpec = {
  id: 'split-two-up',
  titleKey: 'tidy.split.title',
  introKey: 'tidy.split.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  changesPageGeometry: true,
  fields: [{ id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' }],
  run: async (params, context) => {
    const outcome = await splitTwoUpPages(context.bytes, resolveScope(params.scope, context), {
      signal: context.signal,
      onProgress: context.onProgress,
    });
    if (outcome.split.length === 0) {
      return { files: [], report: outcome.report, noticeKey: 'tidy.split.none' };
    }
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'tidy.split.done',
      noticeParams: { count: outcome.split.length, pages: formatPageRanges(outcome.split) },
    };
  },
};
