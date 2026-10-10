/**
 * File-level capabilities.
 *
 * Four capabilities that take or produce whole documents. None of them
 * implements anything: each `run` composes the parameters the dialog collected,
 * calls one `pdf-core` operation and hands the produced files back together with
 * the operation's own report. Progress and cancellation travel straight into
 * that operation's `OperationContext` — the dialog host owns the
 * `AbortController` (`useOperationRun`), so a second one here would only be able
 * to cancel work the dialog does not own.
 *
 * Two of the four return their files **without** a report: `exportImages`
 * (`{ files, pageCount }`) and `exportText` (`TextExportResult`) predate the
 * dialog contract, while `OpRunResult.report` is required. Their reports are
 * therefore assembled here from what the dialog itself knows — the page set it
 * asked for, the produced byte sizes and the one fact the user must not have to
 * discover afterwards (an image export carries no text layer). The sentence they
 * need lives in this capability's dictionary part.
 */

import {
  exportImages,
  exportText,
  type ImageExportFormat,
  type ImageFit,
  imagesToPdf,
  mergeDocuments,
  note,
  type OutputFile,
  openWithPdfjs,
  type TextExportFormat,
} from 'pdf-core';
import { ToolError } from 'pdf-shared';
import type { OperationDialogSpec, OpRunResult } from '../dialogs/types';
import { resolveScope } from './scope';

/** The megapixel ceiling one exported page may hold (the 16 MP budget). */
const MAX_MEGAPIXELS = 16;

/** An export produces files, not a document: the report describes the files it wrote. */
function exportReport(
  steps: readonly string[],
  files: readonly OutputFile[],
  inputBytes: number,
  pageCount: number,
  notes: OpRunResult['report']['notes'],
): OpRunResult['report'] {
  return {
    engine: 'pdfjs',
    steps,
    notes,
    inputBytes,
    outputBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    pageCount,
    // A rendered image or an extracted text file is never an incremental update
    // of the document.
    incremental: false,
  };
}

/**
 * Add/import another PDF into the current one.
 *
 * The inserted document is merged as **bytes** (`mergeDocuments`), which is the
 * byte-based sibling of `composeDocument`: the base is the document the caller
 * materialised, so its annotations and form values are already baked in and the
 * added file is never opened as an editable document.
 */
export const addDocumentDialog: OperationDialogSpec = {
  id: 'add-document',
  titleKey: 'file.add.title',
  introKey: 'file.add.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  changesPageGeometry: true,
  fields: [
    {
      id: 'source',
      kind: 'files',
      labelKey: 'file.add.choose',
      hintKey: 'file.add.sourceHint',
      accept: 'application/pdf,.pdf',
      multiple: false,
    },
    {
      id: 'insertAt',
      kind: 'radio',
      labelKey: 'file.add.insertAt',
      defaultValue: 'end',
      columns: 3,
      options: [
        { value: 'start', labelKey: 'file.add.atStart' },
        { value: 'end', labelKey: 'file.add.atEnd' },
        { value: 'after-current', labelKey: 'file.add.afterCurrent' },
      ],
    },
  ],
  run: async (params, context) => {
    // A `files` field holds `File[]` (`dialogs/fields.tsx`); the declared value type
    // is the wider `FieldValue`, so the narrowing is an assertion.
    const picked = Array.isArray(params.source) ? (params.source as readonly File[]) : [];
    const source = picked[0];
    // Nothing was picked.
    if (source === undefined) {
      throw new ToolError('input-missing', {
        engine: 'ui',
        engineMessage: 'add-document: no file was picked',
      });
    }
    const bytes = new Uint8Array(await source.arrayBuffer());

    // The added document's page count has to come from the engine that will
    // compose it: a byte-level scan for `/Type /Page` misreads every document
    // whose page objects live in an object stream.
    const handle = await openWithPdfjs(bytes, { signal: context.signal });
    let addedPages: number;
    try {
      addedPages = handle.pageCount;
    } finally {
      await handle.destroy();
    }

    // `insertAfter` is a 0-based index of the base sequence; `-1` is in front of
    // everything (`mergeDocuments`).
    const insertAfter =
      params.insertAt === 'start'
        ? -1
        : params.insertAt === 'after-current'
          ? context.currentPage
          : context.pageCount - 1;

    const outcome = await mergeDocuments(
      { bytes: context.bytes, pageCount: context.pageCount },
      [{ name: source.name, bytes, pageCount: addedPages }],
      insertAfter,
      { signal: context.signal, onProgress: context.onProgress },
    );

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'file.add.done',
      noticeParams: { count: addedPages },
    };
  },
};

/**
 * Build a document from images, one page per image.
 *
 * Result kind `new-tab`: the images are not a revision of the open document, so
 * replacing it would lose it. `imagesToPdf` reports unsupported and unreadable
 * images as warnings and skips them, which is why the dialog does not try to
 * filter the picked files itself.
 */
export const imagesToPdfDialog: OperationDialogSpec = {
  id: 'images-to-pdf',
  titleKey: 'file.createImages.title',
  introKey: 'file.createImages.intro',
  confirmKey: 'op.result.newTab',
  resultKind: 'new-tab',
  standalone: true,
  fields: [
    {
      id: 'images',
      kind: 'files',
      labelKey: 'file.createImages.files',
      accept: 'image/png,image/jpeg,image/webp,image/*',
      multiple: true,
    },
    {
      id: 'pageSize',
      kind: 'select',
      labelKey: 'file.createImages.pageSize',
      defaultValue: 'a4',
      options: [
        { value: 'a4', labelKey: 'file.createImages.pageSize.a4' },
        { value: 'letter', labelKey: 'file.createImages.pageSize.letter' },
        { value: 'fit', labelKey: 'file.createImages.pageSize.fit' },
      ],
    },
    {
      id: 'fit',
      kind: 'radio',
      labelKey: 'file.createImages.fit',
      defaultValue: 'contain',
      // Only a fixed page size has anything to fit into: with `fit` the page is
      // the image's own size, so the choice would silently do nothing.
      visibleWhen: { field: 'pageSize', equals: ['a4', 'letter'] },
      options: [
        { value: 'contain', labelKey: 'file.createImages.fit.contain' },
        { value: 'cover', labelKey: 'file.createImages.fit.cover' },
        { value: 'stretch', labelKey: 'file.createImages.fit.stretch' },
      ],
    },
    {
      id: 'marginMm',
      advanced: true,
      kind: 'number',
      labelKey: 'file.createImages.margin',
      defaultValue: 0,
      min: 0,
      max: 50,
      step: 1,
    },
    {
      id: 'exif',
      advanced: true,
      kind: 'radio',
      labelKey: 'file.createImages.orientation',
      defaultValue: 'apply',
      options: [
        { value: 'apply', labelKey: 'file.createImages.orientation.auto' },
        { value: 'ignore', labelKey: 'file.createImages.orientation.ignore' },
      ],
    },
  ],
  run: async (params, context) => {
    const picked = Array.isArray(params.images) ? (params.images as readonly File[]) : [];
    if (picked.length === 0) {
      throw new ToolError('input-missing', {
        engine: 'ui',
        engineMessage: 'images-to-pdf: no images were picked',
      });
    }
    const images = await Promise.all(
      picked.map(async (file) => ({
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );

    const outcome = await imagesToPdf(
      {
        images,
        pageSize: params.pageSize as 'fit' | 'a4' | 'letter',
        fit: params.fit as ImageFit,
        marginMm: Number(params.marginMm),
        applyExif: params.exif !== 'ignore',
      },
      { signal: context.signal, onProgress: context.onProgress },
    );

    return {
      files: [
        { name: `${context.t('file.createImages.name')}.pdf`, bytes: outcome.bytes, mime: 'application/pdf' },
      ],
      report: outcome.report,
    };
  },
};

/**
 * Export pages as image files.
 *
 * The page set, the DPI and the name stem reach `exportImages` unchanged; the
 * megapixel ceiling is a product budget, not a user choice, so
 * a page that would exceed it fails with the operation's own message naming the
 * largest DPI that fits.
 */
export const exportImagesDialog: OperationDialogSpec = {
  id: 'export-images',
  titleKey: 'export.images.title',
  introKey: 'export.images.intro',
  confirmKey: 'op.result.download',
  resultKind: 'download',
  fields: [
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' },
    {
      id: 'format',
      kind: 'select',
      labelKey: 'export.images.format',
      defaultValue: 'png',
      options: [
        { value: 'png', labelKey: 'export.images.format.png' },
        { value: 'jpeg', labelKey: 'export.images.format.jpeg' },
        { value: 'webp', labelKey: 'export.images.format.webp' },
      ],
    },
    {
      id: 'dpi',
      kind: 'number',
      labelKey: 'export.images.dpi',
      hintKey: 'export.images.dpiHint',
      defaultValue: 150,
      min: 72,
      max: 600,
      step: 1,
    },
    {
      id: 'name',
      advanced: true,
      kind: 'text',
      labelKey: 'export.images.namePattern',
      hintKey: 'export.images.namePatternHint',
      defaultValue: '',
      maxLength: 120,
    },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.scope, context);
    const typed = String(params.name ?? '').trim();
    const result = await exportImages(
      context.bytes,
      {
        pages,
        format: params.format as ImageExportFormat,
        dpi: Number(params.dpi),
        // Empty means "name them after the document being exported"; the
        // operation appends the page number and the extension itself.
        baseName: typed === '' ? context.name : typed,
        maxMegapixels: MAX_MEGAPIXELS,
      },
      { signal: context.signal, onProgress: context.onProgress },
    );

    return {
      files: result.files,
      report: exportReport(['pdfjs.render'], result.files, context.bytes.length, result.pageCount, [
        note('lost', 'export.images.loss.text'),
      ]),
      noticeKey: 'export.images.done',
      noticeParams: { count: result.files.length },
    };
  },
};

/**
 * Export the text layer.
 *
 * Text export asks for a transparent engine choice, and the honest half of
 * that is what this dialog does **not** offer: the source selection "text layer /
 * OCR" is absent because `exportText` has no OCR path (it takes pages, format and
 * a name), and a choice that cannot reach an operation is a dead option. Scanned
 * pages are not hidden either — the operation returns them, and the dialog turns
 * that into the "this looks scanned, OCR first" notice.
 */
export const exportTextDialog: OperationDialogSpec = {
  id: 'export-text',
  titleKey: 'export.text.title',
  introKey: 'export.text.intro',
  confirmKey: 'op.result.download',
  resultKind: 'download',
  fields: [
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'all' },
    {
      id: 'format',
      kind: 'radio',
      labelKey: 'export.text.format',
      defaultValue: 'text',
      options: [
        { value: 'text', labelKey: 'export.text.format.text' },
        { value: 'markdown', labelKey: 'export.text.format.markdown' },
      ],
    },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.scope, context);
    const result = await exportText(
      context.bytes,
      {
        pages,
        format: params.format as TextExportFormat,
        baseName: context.name,
      },
      { signal: context.signal, onProgress: context.onProgress },
    );

    const scanned = result.emptyPages.length > 0;
    return {
      files: [result.file],
      report: exportReport(
        ['pdfjs.getTextContent'],
        [result.file],
        context.bytes.length,
        pages.length,
        scanned
          ? [note('warning', 'export.text.detected', { count: result.emptyPages.length })]
          : [note('preserved', 'export.text.covered', { count: pages.length })],
      ),
      noticeKey: scanned ? 'export.text.detected' : 'export.text.done',
      ...(scanned ? {} : { noticeParams: { name: result.file.name } }),
    };
  },
};
