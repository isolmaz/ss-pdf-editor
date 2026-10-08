/**
 * PDF to Word, Excel and CSV (`pdf-core/ops/export-office.ts`).
 *
 * A download like the text export: the pages in scope are read as layout and written in
 * the chosen format, and the core's own report says what came across and what did not.
 * A Word file is the exact layout (editable text boxes, shapes and pictures in place, the
 * default), flowing text (editable) or one picture per page (exact look, not editable); the
 * choice shows only while Word is the format. Its own chunk, because the writer carries
 * JSZip and the read-back check mammoth.
 */

import {
  type CsvDelimiter,
  type DocxLayout,
  exportOffice,
  type OfficeFormat,
} from 'pdf-core/ops/export-office';
import type { OperationDialogSpec } from '../dialogs/types';
import { resolveScope } from './scope';

/**
 * Excel splits a CSV on the list separator of the computer's region, and that is `;`
 * wherever the decimal mark is a comma (Turkish, German, French…). The browser's locale
 * is the closest reading of that region a web page has.
 */
function regionalDelimiter(): 'comma' | 'semicolon' {
  try {
    const locale = typeof navigator === 'undefined' ? 'en-US' : navigator.language;
    return new Intl.NumberFormat(locale).format(1.5).includes(',') ? 'semicolon' : 'comma';
  } catch {
    return 'comma';
  }
}

export const exportOfficeDialog: OperationDialogSpec = {
  id: 'export-office',
  titleKey: 'export.office.title',
  introKey: 'export.office.intro',
  confirmKey: 'op.result.download',
  resultKind: 'download',
  fields: [
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' },
    {
      id: 'format',
      kind: 'radio',
      labelKey: 'export.office.format',
      defaultValue: 'docx',
      options: [
        { value: 'docx', labelKey: 'export.office.format.docx', hintKey: 'export.office.format.docxHint' },
        { value: 'xlsx', labelKey: 'export.office.format.xlsx', hintKey: 'export.office.format.xlsxHint' },
        { value: 'csv', labelKey: 'export.office.format.csv', hintKey: 'export.office.format.csvHint' },
      ],
    },
    {
      id: 'layout',
      kind: 'radio',
      labelKey: 'export.office.layout',
      defaultValue: 'layout',
      visibleWhen: { field: 'format', equals: ['docx'] },
      options: [
        {
          value: 'layout',
          labelKey: 'export.office.layout.exact',
          hintKey: 'export.office.layout.exactHint',
        },
        { value: 'flow', labelKey: 'export.office.layout.flow', hintKey: 'export.office.layout.flowHint' },
        {
          value: 'page-images',
          labelKey: 'export.office.layout.pageImages',
          hintKey: 'export.office.layout.pageImagesHint',
        },
      ],
    },
    {
      id: 'delimiter',
      kind: 'radio',
      labelKey: 'export.office.delimiter',
      defaultValue: regionalDelimiter(),
      visibleWhen: { field: 'format', equals: ['csv'] },
      options: [
        { value: 'comma', labelKey: 'export.office.delimiter.comma' },
        { value: 'semicolon', labelKey: 'export.office.delimiter.semicolon' },
      ],
    },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.scope, context);
    const format = (['docx', 'xlsx', 'csv'] as const).includes(params.format as OfficeFormat)
      ? (params.format as OfficeFormat)
      : 'docx';
    const delimiter: CsvDelimiter = params.delimiter === 'semicolon' ? ';' : ',';
    const docxLayout: DocxLayout = (['layout', 'page-images', 'flow'] as const).includes(
      params.layout as DocxLayout,
    )
      ? (params.layout as DocxLayout)
      : 'layout';
    const result = await exportOffice(
      context.bytes,
      {
        pages,
        format,
        docxLayout,
        baseName: context.name,
        csvDelimiter: delimiter,
        sheetName: {
          table: (n) => context.t('export.office.sheet.table', { n }),
          page: (n) => context.t('export.office.sheet.page', { n }),
        },
      },
      { signal: context.signal, onProgress: context.onProgress },
    );
    return {
      files: [result.file],
      report: {
        engine: 'mupdf',
        steps: result.steps,
        notes: result.notes,
        inputBytes: context.bytes.length,
        outputBytes: result.file.bytes.length,
        pageCount: pages.length,
        // A Word or Excel file is never an incremental update of the PDF.
        incremental: false,
      },
      noticeKey: 'export.office.done',
      noticeParams: { name: result.file.name },
    };
  },
};
