/**
 * Page labels ("Header/footer + Bates + page labels").
 *
 * One rule per run, because a PDF label plan is written as one range per page where
 * the numbering changes and this dialog is a static form: it collects the rule (which
 * page it starts on, style, prefix, first number) and the operation replaces the
 * document's whole plan with it. The intro says so, and the report repeats it.
 *
 * Two things this dialog deliberately does that a "write and trust" dialog would not:
 *  - it renders the rule's first label with `formatLabel`, the same pure function the
 *    operation's reader (pdf.js) agrees with, so the report can compare the intended
 *    label with the one actually read back;
 *  - it reads the written document back through `readPageLabels` and names the first
 *    and last label it found, which is the only evidence that the plan landed in the
 *    file and not just in the wasm heap.
 *
 * The range field goes through the shared page-range parser (`resolveScope`), so a
 * typo'd range fails with the parser's own Turkish sentence before any byte is
 * written — no second parser, no second opinion about `1,1`.
 */

import {
  formatLabel,
  note,
  type PageLabelRange,
  type PageLabelStyle,
  readPageLabels,
  writePageLabels,
} from 'pdf-core';
import type { OperationDialogSpec } from '../dialogs/types';
import { resolveScope } from './scope';

export const pageLabelsDialog: OperationDialogSpec = {
  id: 'page-labels',
  titleKey: 'labels.dialog.title',
  introKey: 'labels.dialog.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  fields: [
    {
      id: 'range',
      kind: 'text',
      labelKey: 'labels.dialog.range',
      placeholderKey: 'op.scope.placeholder',
      hintKey: 'labels.dialog.rangeHint',
      // One rule, so one page is the honest default: it starts where the user says and
      // runs to the end of the document, which the report states in page numbers.
      defaultValue: '1',
      maxLength: 200,
    },
    {
      id: 'style',
      kind: 'select',
      labelKey: 'labels.dialog.style',
      defaultValue: 'decimal',
      options: [
        { value: 'decimal', labelKey: 'labels.style.decimal' },
        { value: 'roman-upper', labelKey: 'labels.style.romanUpper' },
        { value: 'roman-lower', labelKey: 'labels.style.romanLower' },
        { value: 'alpha-upper', labelKey: 'labels.style.alphaUpper' },
        { value: 'alpha-lower', labelKey: 'labels.style.alphaLower' },
        { value: 'none', labelKey: 'labels.style.none' },
      ],
    },
    {
      id: 'prefix',
      kind: 'text',
      labelKey: 'labels.dialog.prefix',
      hintKey: 'labels.dialog.prefixHint',
      defaultValue: '',
      maxLength: 60,
    },
    {
      id: 'start',
      kind: 'number',
      labelKey: 'labels.dialog.start',
      hintKey: 'labels.dialog.startHint',
      defaultValue: 1,
      min: 1,
      max: 100000,
      step: 1,
    },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.range, context);
    // `resolveScope` refuses an empty scope (`selection-empty` / `range-invalid`), so there is a first page.
    const startPage = pages[0] as number;
    const style = params.style as PageLabelStyle;
    const prefix = String(params.prefix ?? '');
    const start = Number(params.start);
    const ranges: readonly PageLabelRange[] = [{ startPage, style, prefix, start }];

    const outcome = await writePageLabels(context.bytes, ranges, {
      signal: context.signal,
      onProgress: context.onProgress,
    });

    // Read back with the reader the app displays. A plan that never reached the file
    // would otherwise be reported as written.
    const labels = await readPageLabels(outcome.bytes, context.pageCount, context.signal);
    const expected = formatLabel(style, prefix, 0, start);
    // The write above puts a label on every page from `startPage` on, so the reader returns one
    // for each page of the document (`startPage` is inside it: the scope was resolved against it).
    const firstLabel = labels[startPage] as string;
    const lastLabel = labels[labels.length - 1] as string;
    const count = Math.max(0, context.pageCount - startPage);

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: {
        ...outcome.report,
        notes: [
          ...outcome.report.notes,
          note('changed', 'labels.note.count', { count, from: startPage + 1 }),
          note('preserved', 'labels.note.verified', { first: firstLabel, last: lastLabel }),
          ...(firstLabel === expected
            ? []
            : [note('warning', 'labels.note.mismatch', { expected, actual: firstLabel })]),
        ],
      },
      noticeKey: 'labels.dialog.done',
      noticeParams: { count },
    };
  },
};
