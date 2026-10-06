/**
 * The operations that start a document rather than change one.
 *
 * Each of these is `standalone` (`dialogs/types.ts`): it runs with no document open, its
 * context carries no bytes, and its one result opens in a new tab. The home screen and the
 * File menu offer them whether or not a document is open, because none of them reads the
 * open one.
 */

import { openWithPdfjs } from 'pdf-core/engines/pdfjs-handle';
import { mergeDocuments } from 'pdf-core/ops/compose';
import {
  type BlankOrientation,
  type BlankPageSize,
  createBlankDocument,
  MAX_BLANK_PAGES,
} from 'pdf-core/ops/create';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec } from '../dialogs/types';

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

/**
 * Several PDFs into one new document, in the order the list shows.
 *
 * The first file is the base of `mergeDocuments`, so its metadata is the result's and the
 * others are appended after its last page; the operation's own report says what was kept.
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
      id: 'files',
      kind: 'files',
      labelKey: 'start.merge.files',
      hintKey: 'start.merge.hint',
      accept: 'application/pdf,.pdf',
      multiple: true,
    },
  ],
  run: async (params, context) => {
    const picked = Array.isArray(params.files) ? (params.files as readonly File[]) : [];
    if (picked.length < 2) {
      throw new ToolError('input-missing', {
        engine: 'ui',
        engineMessage: `merge-files: ${picked.length} file(s) picked, two are needed`,
      });
    }
    const sources = [];
    for (const file of picked) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The page count comes from the engine that composes the merge, never from a byte
      // scan (object streams hide `/Type /Page`).
      const handle = await openWithPdfjs(bytes, { signal: context.signal });
      try {
        sources.push({ name: file.name, bytes, pageCount: handle.pageCount });
      } finally {
        await handle.destroy();
      }
    }
    const [base, ...others] = sources;
    if (base === undefined) throw new ToolError('selection-empty', { engine: 'ui' });
    const outcome = await mergeDocuments(base, others, base.pageCount - 1, {
      signal: context.signal,
      onProgress: context.onProgress,
    });
    return {
      files: [
        { name: `${context.t('start.merge.name')}.pdf`, bytes: outcome.bytes, mime: 'application/pdf' },
      ],
      report: outcome.report,
    };
  },
};
