/**
 * Imposition.
 *
 * Three layouts over one operation: N-up, saddle-stitch booklet and poster
 * tiling. The sheet geometry — including paper, orientation, gutter, margins and
 * content rotation, which the source project never had — is computed by
 * `imposeDocument`; this dialog only decides which of the operation's parameters a
 * layout reads, and hides the rest (`visibleWhen`) so no control can look live
 * while the operation ignores it.
 *
 * The sheet count is planned with `planImposition` in `run` for the report and for
 * one guard: poster mode multiplies the page count by columns × rows, and a
 * document that would produce thousands of sheets is a mistake worth reading
 * rather than a job to start. A *live* count while typing is not expressible in
 * the frozen spec (`OperationDialogSpec` has no preview member and
 * `dialogs/fields.tsx` renders static values); `impose.preview` is therefore
 * unused until the framework grows a preview hook.
 */

import {
  type ImposeOptions,
  imposeDocument,
  type NUpOptions,
  type PaperSize,
  planImposition,
} from 'pdf-core';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec } from '../dialogs/types';
import { resolveScope } from './scope';

/**
 * Ceiling on the sheets one imposition may produce. Sheets are held in memory
 * until the whole document is written, and poster mode multiplies pages by tiles,
 * so this is the difference between a slow job and a failed browser tab.
 */
const MAX_SHEETS = 1000;

/** A16 — N-up, booklet and poster over one operation. */
export const imposeDialog: OperationDialogSpec = {
  id: 'impose',
  titleKey: 'impose.title',
  introKey: 'impose.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  changesPageGeometry: true,
  fields: [
    {
      id: 'mode',
      kind: 'radio',
      labelKey: 'impose.mode',
      defaultValue: 'nup',
      columns: 3,
      options: [
        { value: 'nup', labelKey: 'impose.mode.nup' },
        { value: 'booklet', labelKey: 'impose.mode.booklet' },
        { value: 'poster', labelKey: 'impose.mode.poster' },
      ],
    },
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' },
    {
      id: 'perSheet',
      kind: 'select',
      labelKey: 'impose.perSheet',
      defaultValue: '2',
      visibleWhen: { field: 'mode', equals: ['nup'] },
      options: [
        { value: '2', labelKey: 'impose.perSheet.2' },
        { value: '4', labelKey: 'impose.perSheet.4' },
        { value: '6', labelKey: 'impose.perSheet.6' },
        { value: '8', labelKey: 'impose.perSheet.8' },
        { value: '9', labelKey: 'impose.perSheet.9' },
        { value: '16', labelKey: 'impose.perSheet.16' },
      ],
    },
    {
      id: 'paper',
      kind: 'select',
      labelKey: 'impose.paper',
      defaultValue: 'a4',
      options: [
        { value: 'a4', labelKey: 'impose.paper.a4' },
        { value: 'a3', labelKey: 'impose.paper.a3' },
        { value: 'letter', labelKey: 'impose.paper.letter' },
      ],
    },
    {
      id: 'orientation',
      kind: 'radio',
      labelKey: 'impose.orientation',
      defaultValue: 'auto',
      visibleWhen: { field: 'mode', equals: ['nup'] },
      options: [
        { value: 'auto', labelKey: 'impose.orientation.auto' },
        { value: 'portrait', labelKey: 'impose.orientation.portrait' },
        { value: 'landscape', labelKey: 'impose.orientation.landscape' },
      ],
    },
    {
      id: 'gutterMm',
      advanced: true,
      kind: 'number',
      labelKey: 'impose.gutter',
      defaultValue: 0,
      min: 0,
      max: 50,
      step: 1,
      visibleWhen: { field: 'mode', equals: ['nup', 'booklet'] },
    },
    {
      id: 'marginMm',
      advanced: true,
      kind: 'number',
      labelKey: 'impose.margins',
      defaultValue: 10,
      min: 0,
      max: 50,
      step: 1,
      visibleWhen: { field: 'mode', equals: ['nup', 'booklet'] },
    },
    {
      id: 'rotateContent',
      advanced: true,
      kind: 'checkbox',
      labelKey: 'impose.rotateContent',
      hintKey: 'impose.rotateContentHint',
      defaultValue: true,
      visibleWhen: { field: 'mode', equals: ['nup'] },
    },
    {
      id: 'columns',
      kind: 'number',
      labelKey: 'impose.columns',
      defaultValue: 2,
      min: 1,
      max: 10,
      step: 1,
      visibleWhen: { field: 'mode', equals: ['poster'] },
    },
    {
      id: 'rows',
      kind: 'number',
      labelKey: 'impose.rows',
      defaultValue: 2,
      min: 1,
      max: 10,
      step: 1,
      visibleWhen: { field: 'mode', equals: ['poster'] },
    },
    {
      id: 'overlapMm',
      advanced: true,
      kind: 'number',
      labelKey: 'impose.overlap',
      hintKey: 'impose.overlapHint',
      defaultValue: 5,
      min: 0,
      max: 30,
      step: 1,
      visibleWhen: { field: 'mode', equals: ['poster'] },
    },
    {
      id: 'cropMarks',
      advanced: true,
      kind: 'checkbox',
      labelKey: 'impose.cropMarks',
      defaultValue: false,
      visibleWhen: { field: 'mode', equals: ['poster'] },
    },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.scope, context);
    // `mode` can only hold a declared option value; the value also picks which of
    // the operation's option shapes this run fills in.
    const mode = params.mode as ImposeOptions['mode'];
    const paper = params.paper as PaperSize;

    const options: ImposeOptions =
      mode === 'booklet'
        ? {
            mode: 'booklet',
            pages,
            paper,
            gutterMm: Number(params.gutterMm),
            marginMm: Number(params.marginMm),
          }
        : mode === 'poster'
          ? {
              mode: 'poster',
              pages,
              paper,
              columns: Number(params.columns),
              rows: Number(params.rows),
              overlapMm: Number(params.overlapMm),
              cropMarks: params.cropMarks === true,
            }
          : {
              mode: 'nup',
              pages,
              perSheet: Number(params.perSheet) as NUpOptions['perSheet'],
              paper,
              orientation: params.orientation as NUpOptions['orientation'],
              gutterMm: Number(params.gutterMm),
              marginMm: Number(params.marginMm),
              rotateContent: params.rotateContent === true,
            };

    const plan = planImposition(pages.length, options);
    if (plan.sheets > MAX_SHEETS) {
      // Same vocabulary limit as the split ceiling: the error contract's sentences
      // are per code, and `range-invalid`'s hint (enter a narrower range) is the
      // actionable one — fewer pages or fewer tiles.
      throw new ToolError('range-invalid', {
        engine: 'ui',
        engineMessage: `imposition plan produces ${plan.sheets} sheets, over the ${MAX_SHEETS} ceiling`,
      });
    }

    const outcome = await imposeDocument(context.bytes, options, {
      signal: context.signal,
      onProgress: context.onProgress,
    });

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      // Padding for a booklet signature is the operation's own note
      // (`op.note.impose.padded`); the dialog only adds the plan's sheet count, which
      // is what the notice needs before the report is read.
      report: outcome.report,
      noticeKey: 'impose.done',
      noticeParams: { sheets: plan.sheets },
    };
  },
};
