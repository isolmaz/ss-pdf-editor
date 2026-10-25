/**
 * The operations that start a document rather than change one.
 *
 * Each of these is `standalone` (`dialogs/types.ts`): it runs with no document open, its
 * context carries no bytes, and its one result opens in a new tab. The home screen and the
 * File menu offer them whether or not a document is open, because none of them reads the
 * open one.
 */

import { openWithPdfjs } from 'pdf-core/engines/pdfjs-handle';
import { interleaveDocuments, mergeDocuments } from 'pdf-core/ops/compose';
import {
  type BlankOrientation,
  type BlankPageSize,
  createBlankDocument,
  MAX_BLANK_PAGES,
} from 'pdf-core/ops/create';
import type { OperationOutcome } from 'pdf-core/ops/types';
import { ToolError } from 'pdf-shared';
import type { FieldValue, OperationDialogSpec } from '../dialogs/types';

/** A blank document of empty pages (`pdf-core/ops/create.ts`). */
export const newDocumentDialog: OperationDialogSpec = {
  id: 'new-document',
  titleKey: 'start.blank.title',
  introKey: 'start.blank.intro',
  confirmKey: 'op.result.newTab',
  resultKind: 'new-tab',
  standalone: true,
  fields: [
    {
      id: 'size',
      kind: 'select',
      labelKey: 'start.blank.size',
      defaultValue: 'a4',
      options: [
        { value: 'a4', labelKey: 'start.blank.size.a4' },
        { value: 'a3', labelKey: 'start.blank.size.a3' },
        { value: 'a5', labelKey: 'start.blank.size.a5' },
        { value: 'letter', labelKey: 'start.blank.size.letter' },
        { value: 'legal', labelKey: 'start.blank.size.legal' },
      ],
    },
    {
      id: 'orientation',
      kind: 'radio',
      labelKey: 'start.blank.orientation',
      defaultValue: 'portrait',
      columns: 2,
      options: [
        { value: 'portrait', labelKey: 'start.blank.portrait' },
        { value: 'landscape', labelKey: 'start.blank.landscape' },
      ],
    },
    {
      id: 'pages',
      kind: 'number',
      integer: true,
      labelKey: 'start.blank.pages',
      defaultValue: 1,
      min: 1,
      max: MAX_BLANK_PAGES,
      step: 1,
    },
  ],
  run: async (params, context) => {
    const outcome = await createBlankDocument(
      {
        size: params.size as BlankPageSize,
        orientation: params.orientation as BlankOrientation,
        pageCount: Number(params.pages),
      },
      { signal: context.signal, onProgress: context.onProgress },
    );
    return {
      files: [
        { name: `${context.t('start.blank.name')}.pdf`, bytes: outcome.bytes, mime: 'application/pdf' },
      ],
      report: outcome.report,
    };
  },
};

/** A picked PDF with the page count the engine that composes the merge reads from it. */
async function measure(file: File, signal: AbortSignal) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  // The page count comes from the engine that composes the merge, never from a byte
  // scan (object streams hide `/Type /Page`).
  const handle = await openWithPdfjs(bytes, { signal });
  try {
    return { name: file.name, bytes, pageCount: handle.pageCount };
  } finally {
    await handle.destroy();
  }
}

const pickedFiles = (value: FieldValue | undefined): readonly File[] =>
  Array.isArray(value) ? (value as readonly File[]) : [];

/**
 * Several PDFs into one new document: in the order the list shows, or — for the two files a
 * double-sided scan makes — front and back sides alternating.
 *
 * The first file is the base of `mergeDocuments`, so its metadata is the result's and the
 * others are appended after its last page; the operation's own report says what was kept. The
 * alternating mode is a mode of this dialog rather than a tool of its own: it asks for the same
 * kind of files, makes the same kind of result and reports through the same merge.
 */
export const mergeFilesDialog: OperationDialogSpec = {
  id: 'merge-files',
  titleKey: 'start.merge.title',
  introKey: 'start.merge.intro',
  confirmKey: 'op.result.newTab',
  resultKind: 'new-tab',
  standalone: true,
  fields: [
    {
      id: 'mode',
      kind: 'radio',
      labelKey: 'start.merge.mode',
      defaultValue: 'append',
      options: [
        { value: 'append', labelKey: 'start.merge.mode.append' },
        { value: 'interleave', labelKey: 'start.merge.mode.interleave' },
      ],
    },
    {
      id: 'files',
      kind: 'files',
      labelKey: 'start.merge.files',
      hintKey: 'start.merge.hint',
      accept: 'application/pdf,.pdf',
      multiple: true,
      visibleWhen: { field: 'mode', equals: ['append'] },
    },
    {
      id: 'fronts',
      kind: 'files',
      labelKey: 'start.merge.fronts',
      accept: 'application/pdf,.pdf',
      multiple: false,
      visibleWhen: { field: 'mode', equals: ['interleave'] },
    },
    {
      id: 'backs',
      kind: 'files',
      labelKey: 'start.merge.backs',
      accept: 'application/pdf,.pdf',
      multiple: false,
      visibleWhen: { field: 'mode', equals: ['interleave'] },
    },
    {
      id: 'reverseBacks',
      kind: 'checkbox',
      labelKey: 'start.merge.reverse',
      hintKey: 'start.merge.reverseHint',
      defaultValue: true,
      visibleWhen: { field: 'mode', equals: ['interleave'] },
    },
  ],
  run: async (params, context) => {
    const run = { signal: context.signal, onProgress: context.onProgress };
    const interleave = params.mode === 'interleave';
    let outcome: OperationOutcome;
    if (interleave) {
      const [front] = pickedFiles(params.fronts);
      const [back] = pickedFiles(params.backs);
      if (front === undefined || back === undefined) {
        throw new ToolError('input-missing', {
          engine: 'ui',
          engineMessage: 'merge-files: a front-sides file and a back-sides file are needed',
        });
      }
      outcome = await interleaveDocuments(
        await measure(front, context.signal),
        await measure(back, context.signal),
        { reverseBacks: params.reverseBacks === true },
        run,
      );
    } else {
      const picked = pickedFiles(params.files);
      const [firstFile, ...otherFiles] = picked;
      if (firstFile === undefined || otherFiles.length === 0) {
        throw new ToolError('input-missing', {
          engine: 'ui',
          engineMessage: `merge-files: ${picked.length} file(s) picked, two are needed`,
        });
      }
      const base = await measure(firstFile, context.signal);
      const others = [];
      for (const file of otherFiles) others.push(await measure(file, context.signal));
      outcome = await mergeDocuments(base, others, base.pageCount - 1, run);
    }
    return {
      files: [
        { name: `${context.t('start.merge.name')}.pdf`, bytes: outcome.bytes, mime: 'application/pdf' },
      ],
      report: outcome.report,
    };
  },
};
