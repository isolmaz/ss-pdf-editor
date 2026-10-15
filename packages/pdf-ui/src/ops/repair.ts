/**
 * Repair a damaged PDF (`pdf-core/ops/repair.ts`).
 *
 * `standalone`, like the other operations that start a document: the files that need it are the
 * ones that do not open, so the tool takes the file itself instead of the open document. The
 * repaired copy opens in a new tab beside whatever is open, and the file picked is not touched.
 */

import { repairDocument } from 'pdf-core/ops/repair';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec } from '../dialogs/types';

export const repairDialog: OperationDialogSpec = {
  id: 'repair',
  titleKey: 'repair.title',
  introKey: 'repair.intro',
  confirmKey: 'op.result.newTab',
  resultKind: 'new-tab',
  standalone: true,
  fields: [
    {
      id: 'file',
      kind: 'files',
      labelKey: 'repair.file',
      hintKey: 'repair.hint',
      accept: 'application/pdf,.pdf',
      multiple: false,
    },
  ],
  run: async (params, context) => {
    const [file] = Array.isArray(params.file) ? (params.file as readonly File[]) : [];
    if (file === undefined) {
      throw new ToolError('input-missing', { engine: 'ui', engineMessage: 'repair: no file was picked' });
    }
    const outcome = await repairDocument(new Uint8Array(await file.arrayBuffer()), {
      signal: context.signal,
      onProgress: context.onProgress,
    });
    const stem = file.name.replace(/\.pdf$/i, '') || 'document';
    const name = `${stem}-${context.t('repair.suffix')}.pdf`;
    return {
      files: [{ name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: outcome.repaired ? 'repair.done' : 'repair.doneClean',
      noticeParams: { name },
    };
  },
};
