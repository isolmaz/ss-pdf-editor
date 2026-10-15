/**
 * Straighten scanned pages.
 *
 * One field, the page scope: the angle is measured on each page, never typed. The report the
 * operation returns names every page's outcome (the angle removed, already straight, no clear
 * text lines, or text that a turn would push off the page). A run that straightens nothing
 * hands back no file, so applying it cannot journal a step that changed nothing.
 *
 * `changesPageGeometry`: the content moves under the page, so redaction marks drawn on it
 * and not yet applied would no longer sit on what they were drawn over.
 */

import { deskewPages } from 'pdf-core/ops/deskew';
import type { OperationDialogSpec } from '../dialogs/types';
import { resolveScope } from './scope';

export const deskewDialog: OperationDialogSpec = {
  id: 'deskew',
  titleKey: 'deskew.title',
  introKey: 'deskew.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  changesPageGeometry: true,
  fields: [{ id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' }],
  run: async (params, context) => {
    const outcome = await deskewPages(
      context.bytes,
      { pages: resolveScope(params.scope, context) },
      { signal: context.signal, onProgress: context.onProgress },
    );
    const straightened = outcome.pages.filter((page) => page.verdict === 'straightened').length;
    if (straightened === 0) {
      return { files: [], report: outcome.report, noticeKey: 'deskew.note.unchanged' };
    }
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'deskew.done',
      noticeParams: { count: straightened },
    };
  },
};
