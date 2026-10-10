/**
 * Page-structure capabilities.
 *
 * Extraction and splitting are the same engine path seen from two sides: both
 * compose their output from the pages of the document that owns the annotation
 * storage (`composeDocument`, `document: null`), so annotations and form values
 * travel into the produced files instead of being rebuilt away.
 *
 * Two framework limits shape these dialogs, and both are stated to the user
 * rather than hidden:
 *  - `planSplit` is called in `run`, which is the only hook a spec has before the
 *    engine runs (`OperationDialogSpec` has no preview member, and
 *    `dialogs/fields.tsx` renders static values). The part count therefore
 *    arrives with the report instead of while typing, which the intro says.
 *  - date/range validation is the shared parser's job, so a typo'd range fails
 *    with the parser's own Turkish sentence before any page is touched.
 */

import {
  composeDocument,
  extractedFileName,
  note,
  type OperationOutcome,
  openWithPdfjs,
  planSplit,
  type SplitMode,
  type SplitOptions,
  splitDocument,
} from 'pdf-core';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec } from '../dialogs/types';
import { resolveScope, scopeRangeText } from './scope';

/**
 * Ceiling on the parts one split may produce. Every part is a full composition
 * and every part is held in memory until the last one is written, so a rule that
 * asks for thousands of files (one page per part on a 2000-page document) is a
 * failure the user should read, not a download storm to discover.
 */
const MAX_SPLIT_PARTS = 200;

/**
 * Extract the selected pages as a new document.
 *
 * `new-tab`, never `replace`: the pages are produced *beside* the document, which
 * is what makes the capability non-destructive.
 */
export const extractPagesDialog: OperationDialogSpec = {
  id: 'extract-pages',
  titleKey: 'pages.extract.title',
  introKey: 'pages.extract.intro',
  confirmKey: 'op.result.newTab',
  resultKind: 'new-tab',
  fields: [
    // The command is offered on a selection, so the selection is where the dialog
    // starts; "all pages" would only copy the document.
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'selection' },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.scope, context);
    const handle = await openWithPdfjs(context.bytes, { signal: context.signal });
    let outcome: OperationOutcome;
    try {
      outcome = await composeDocument(
        { pageCount: pages.length, sources: [{ pages }] },
        // The proxy, not the wrapper: `extractPages` is pdf.js's own writer and the
        // composition must run on the document that owns the annotation storage.
        handle.raw,
        { signal: context.signal, onProgress: context.onProgress },
      );
    } finally {
      await handle.destroy();
    }

    // The range names the file (`extractedFileName`): a part counter would read as
    // a page range of its own.
    const name = extractedFileName(context.name, pages);

    return {
      files: [{ name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
    };
  },
};

/**
 * Split the document.
 *
 * Four modes, one operation. Only the fields the chosen mode reads are visible,
 * and the ranges mode takes its text through the shared page-range parser, so a
 * duplicate (`'1,1'`) is refused here rather
 * than producing two identical parts.
 */
export const splitDialog: OperationDialogSpec = {
  id: 'split',
  titleKey: 'split.title',
  introKey: 'split.intro',
  confirmKey: 'op.result.download',
  resultKind: 'download',
  fields: [
    {
      id: 'mode',
      kind: 'radio',
      labelKey: 'split.mode',
      defaultValue: 'everyN',
      columns: 2,
      options: [
        { value: 'ranges', labelKey: 'split.mode.ranges' },
        { value: 'everyN', labelKey: 'split.mode.everyN' },
        { value: 'size', labelKey: 'split.mode.size' },
        { value: 'booklet', labelKey: 'split.mode.booklet' },
      ],
    },
    {
      id: 'ranges',
      kind: 'text',
      labelKey: 'split.ranges',
      placeholderKey: 'op.scope.placeholder',
      hintKey: 'split.rangesHint',
      defaultValue: '',
      maxLength: 200,
      visibleWhen: { field: 'mode', equals: ['ranges'] },
    },
    {
      id: 'chunkSize',
      kind: 'number',
      labelKey: 'split.everyN',
      hintKey: 'split.everyNHint',
      defaultValue: 1,
      min: 1,
      max: 5000,
      step: 1,
      visibleWhen: { field: 'mode', equals: ['everyN', 'booklet'] },
    },
    {
      id: 'maxSizeMb',
      kind: 'number',
      labelKey: 'split.maxSize',
      hintKey: 'split.maxSizeHint',
      defaultValue: 10,
      min: 0.1,
      max: 500,
      step: 0.1,
      visibleWhen: { field: 'mode', equals: ['size'] },
    },
    {
      id: 'baseName',
      advanced: true,
      kind: 'text',
      labelKey: 'split.partNames',
      hintKey: 'split.partNamesHint',
      defaultValue: '',
      maxLength: 120,
    },
  ],
  run: async (params, context) => {
    // The renderer can only produce a declared option value, so this narrows the
    // wider `FieldValue` instead of guessing.
    const mode = params.mode as SplitMode;
    const options: SplitOptions = {
      mode,
      // An empty stem means "name the parts after the document being split"; the
      // operations strip the `.pdf` themselves.
      baseName: String(params.baseName ?? '').trim() === '' ? context.name : String(params.baseName).trim(),
      pageCount: context.pageCount,
      // Only `size` mode reads this, and it cannot plan without it: an estimated
      // page count from a guessed byte size would be a preview of nothing.
      totalBytes: context.bytes.length,
      ...(mode === 'ranges' ? { ranges: scopeRangeText(params.ranges, context) } : {}),
      ...(mode === 'size' ? { maxBytes: Math.round(Number(params.maxSizeMb) * 1024 * 1024) } : {}),
      ...(mode === 'everyN' || mode === 'booklet' ? { chunkSize: Number(params.chunkSize) } : {}),
    };

    // Planned before anything is written: the count is the one number a split owes
    // the user up front, and the plan is also what refuses a rule that would
    // produce more files than a person can handle.
    const plan = planSplit(options);
    if (plan.parts.length > MAX_SPLIT_PARTS) {
      // The error contract's sentences are per code, not per situation
      // (`pdf-shared/errors.ts`): `range-invalid` is the one whose hint tells the
      // user what to do — enter a narrower range.
      throw new ToolError('range-invalid', {
        engine: 'ui',
        engineMessage: `split plan produces ${plan.parts.length} parts, over the ${MAX_SPLIT_PARTS} ceiling`,
      });
    }

    const { files } = await splitDocument(context.bytes, options, {
      signal: context.signal,
      onProgress: context.onProgress,
    });

    return {
      files,
      report: {
        engine: 'pdfjs',
        steps: ['pdfjs.extractPages'],
        notes: [
          // Every part is its own composition, so the catalog entry the engine
          // rebuilds is lost once per part (`op.note.compose.catalog`).
          note('lost', 'op.note.compose.catalog'),
          note('preserved', 'op.note.compose.storage'),
          note('changed', 'split.done', { count: files.length }),
        ],
        inputBytes: context.bytes.length,
        outputBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
        pageCount: context.pageCount,
        // A composition is a freshly written file.
        incremental: false,
      },
      noticeKey: 'split.done',
      noticeParams: { count: files.length },
    };
  },
};
