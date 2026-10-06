/**
 * Other documents to PDF (`pdf-core/ops/convert.ts`): Word, Excel, PowerPoint, HTML,
 * text, CSV, EPUB and FB2, converted in this tab.
 *
 * A standalone operation like the blank document: it needs no open document and its
 * one result opens in a new tab. Several files are converted one by one and joined in
 * the order the list shows (`mergeDocuments`), so "these three files as one PDF" is one
 * step. Its own chunk: the converters carry JSZip, an XML parser and mammoth, which
 * nothing else needs.
 */

import { mergeDocuments } from 'pdf-core/ops/compose';
import { type ConvertPageSize, convertToPdf } from 'pdf-core/ops/convert';
import { CONVERT_ACCEPT, pdfNameFor } from 'pdf-core/ops/convert-formats';
import type { BlankOrientation } from 'pdf-core/ops/create';
import type { OperationNote, OperationReport } from 'pdf-core/ops/types';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec } from '../dialogs/types';

export const convertDialog: OperationDialogSpec = {
  id: 'convert-to-pdf',
  titleKey: 'convert.title',
  introKey: 'convert.intro',
  confirmKey: 'op.result.newTab',
  resultKind: 'new-tab',
  standalone: true,
  fields: [
    {
      id: 'files',
      kind: 'files',
      labelKey: 'convert.files',
      hintKey: 'convert.hint',
      accept: CONVERT_ACCEPT,
      multiple: true,
    },
    {
      id: 'pageSize',
      kind: 'select',
      labelKey: 'convert.pageSize',
      defaultValue: 'a4',
      options: [
        { value: 'a4', labelKey: 'start.blank.size.a4' },
        { value: 'letter', labelKey: 'start.blank.size.letter' },
        { value: 'a5', labelKey: 'start.blank.size.a5' },
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
      id: 'marginMm',
      advanced: true,
      kind: 'number',
      labelKey: 'convert.margin',
      defaultValue: 15,
      min: 0,
      max: 50,
      step: 1,
    },
  ],
  run: async (params, context) => {
    const picked = Array.isArray(params.files) ? (params.files as readonly File[]) : [];
    const first = picked[0];
    if (first === undefined) {
      throw new ToolError('selection-empty', {
        engine: 'ui',
        engineMessage: 'convert-to-pdf: no file picked',
      });
    }
    const options = {
      pageSize: params.pageSize as ConvertPageSize,
      orientation: params.orientation as BlankOrientation,
      marginMm: Number(params.marginMm),
    };
    const operation = { signal: context.signal, onProgress: context.onProgress };
    const converted = [];
    for (const file of picked) {
      const outcome = await convertToPdf(
        { ...options, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
        operation,
      );
      converted.push({
        name: file.name,
        bytes: outcome.bytes,
        pageCount: outcome.report.pageCount,
        report: outcome.report,
      });
    }
    const [base, ...others] = converted;
    if (base === undefined) throw new ToolError('selection-empty', { engine: 'ui' });
    let bytes = base.bytes;
    let report: OperationReport = base.report;
    if (others.length > 0) {
      const merged = await mergeDocuments(base, others, base.pageCount - 1, operation);
      bytes = merged.bytes;
      // Each file's notes follow its own first line, which names the file.
      const notes: OperationNote[] = converted.flatMap((item) => item.report.notes);
      report = {
        ...merged.report,
        steps: [...converted.flatMap((item) => item.report.steps), ...merged.report.steps],
        notes: [...notes, ...merged.report.notes],
        inputBytes: picked.reduce((sum, file) => sum + file.size, 0),
      };
    }
    return {
      files: [{ name: pdfNameFor(first.name), bytes, mime: 'application/pdf' }],
      report,
    };
  },
};
