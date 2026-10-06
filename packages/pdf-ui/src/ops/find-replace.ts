/**
 * Find and replace across the document (`pdf-core/ops/find-replace.ts`).
 *
 * The dialog owns the fields and the dictionary text; the operation reads the pages,
 * replaces each match in place or re-lays its paragraph, erases the old glyphs for
 * real and verifies the result. The find bar opens it with its own query (`find`
 * preset), so a search the user already typed is not typed twice.
 */

import { findReplace } from 'pdf-core/ops/find-replace';
import type { OperationDialogSpec } from '../dialogs/types';
import { resolveScope } from './scope';

export const findReplaceDialog: OperationDialogSpec = {
  id: 'find-replace',
  titleKey: 'findReplace.title',
  introKey: 'findReplace.intro',
  confirmKey: 'findReplace.confirm',
  resultKind: 'replace',
  destructive: false,
  fields: [
    {
      id: 'find',
      kind: 'text',
      labelKey: 'findReplace.find',
      defaultValue: '',
      maxLength: 500,
    },
    {
      id: 'replace',
      kind: 'text',
      labelKey: 'findReplace.replace',
      hintKey: 'findReplace.replaceHint',
      defaultValue: '',
      maxLength: 500,
    },
    { id: 'matchCase', kind: 'checkbox', labelKey: 'findReplace.matchCase', defaultValue: false },
    { id: 'wholeWord', kind: 'checkbox', labelKey: 'findReplace.wholeWord', defaultValue: false },
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.scope, context);
    const outcome = await findReplace(
      context.bytes,
      {
        find: String(params.find ?? ''),
        replace: String(params.replace ?? ''),
        matchCase: params.matchCase === true,
        wholeWord: params.wholeWord === true,
        pages,
      },
      { signal: context.signal, onProgress: context.onProgress },
    );
    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'findReplace.done',
      noticeParams: { count: outcome.replaced },
    };
  },
};
