/**
 * Save as PDF/A (`pdf-core/ops/pdfa.ts`).
 *
 * The converted file opens in a new tab, beside the original, which stays as it is: the
 * conversion rewrites the whole file and cannot be undone inside it. The report says what the
 * conversion kept, changed and lost, and what the checker found on the output. The engine
 * (15.5 MB of WebAssembly) loads only when this dialog runs.
 */

import { convertToPdfA, pdfaLevel } from 'pdf-core/ops/pdfa';
import type { PdfAPart } from 'pdf-core/ops/pdfa-check';
import type { OperationDialogSpec, OpRunResult } from '../dialogs/types';

const PARTS: Readonly<Record<string, PdfAPart>> = { '1b': 1, '2b': 2, '3b': 3 };

export const pdfaDialog: OperationDialogSpec = {
  id: 'pdfa',
  titleKey: 'pdfa.title',
  introKey: 'pdfa.intro',
  confirmKey: 'op.result.newTab',
  resultKind: 'new-tab',
  fields: [
    {
      id: 'level',
      kind: 'radio',
      labelKey: 'pdfa.level',
      defaultValue: '2b',
      options: [
        { value: '2b', labelKey: 'pdfa.level.2b', hintKey: 'pdfa.level.2bHint' },
        { value: '3b', labelKey: 'pdfa.level.3b', hintKey: 'pdfa.level.3bHint' },
        { value: '1b', labelKey: 'pdfa.level.1b', hintKey: 'pdfa.level.1bHint' },
      ],
    },
  ],
  run: async (params, context) => {
    const part = PARTS[String(params.level)] ?? 2;
    const result = await convertToPdfA(
      context.bytes,
      { part },
      { signal: context.signal, onProgress: context.onProgress },
    );
    const stem = context.name.replace(/\.pdf$/i, '') || 'document';
    const name = `${stem}-pdfa-${part}b.pdf`;
    const files = [{ name, bytes: result.bytes, mime: 'application/pdf' }];
    const outcome: OpRunResult = result.converted
      ? { files, report: result.report, noticeKey: 'pdfa.done', noticeParams: { name } }
      : {
          files,
          report: result.report,
          noticeKey: 'pdfa.doneAlready',
          noticeParams: { level: pdfaLevel(part) },
        };
    return outcome;
  },
};
