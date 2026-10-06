/**
 * Page management v2 dialogs: insert pages, replace pages.
 *
 * Both dialogs follow the shape `ops/pages.ts` established — declarative fields,
 * a `run` that resolves the page scope through `ops/scope.ts`, and an engine path
 * that never re-implements a composition. The difference from extract/split is
 * the direction: these pages *join* the current document, so the operation is an
 * insert into the document the composition runs on (`insertPages` /
 * `replacePages`, `document: null`), which is what keeps annotations and form
 * values alive across the change.
 *
 * Three rules are enforced here rather than left to the engine:
 *  - the insertion position is clamped to the document (`at` in `0…pageCount`,
 *    0 = in front of everything), because a number field cannot know the count;
 *  - a source document's page range is parsed by the shared parser
 *    (`parsePageRanges` + `validateRanges`, exactly as `ops/scope.ts` does) against
 *    the *source* document's page count, never against the current one;
 *  - a replacement must produce exactly as many pages as were selected; a
 *    mismatch is refused before any engine work, never silently padded.
 *
 * The error contract's sentences belong to the codes, not to a situation
 * (`pdf-shared/errors.ts`), so a count mismatch reads as `selection-empty` while
 * the exact counts travel in the engine message for diagnostics — the same
 * limitation `ops/pages.ts` records for the split-parts ceiling.
 */

import {
  type BuiltInsertedPages,
  buildInsertedPages,
  insertPages,
  openWithPdfjs,
  type PageInsertSource,
  type PageSizePt,
  pageSizesOf,
  parsePageRanges,
  replacePages,
  validateRanges,
} from 'pdf-core';
import { ToolError } from 'pdf-shared';
import type { FieldValue, OperationDialogSpec, OpRunContext } from '../dialogs/types';
import { resolveScope } from './scope';

/** The three sources the insert and replace dialogs offer. */
type SourceKind = 'blank' | 'image' | 'document';

/** A `pageScope`-free source size choice. */
type SizeChoice = 'a4' | 'letter' | 'match';

/** A `files` field holds `File[]`; the declared value type is the wider `FieldValue`. */
function pickedFiles(value: FieldValue | undefined): readonly File[] {
  return Array.isArray(value) ? (value as readonly File[]) : [];
}

/** The picked images as the byte-shaped records `imagesToPdf` consumes. */
async function pickedImages(
  value: FieldValue | undefined,
): Promise<readonly { name: string; bytes: Uint8Array }[]> {
  return Promise.all(
    pickedFiles(value).map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

/**
 * A `files` field's single PDF, with the pages its range text names. The page
 * count comes from the engine that will compose the document: a byte-level scan
 * for `/Type /Page` misreads every document whose page objects live in an object
 * stream.
 */
async function pickedDocument(
  value: FieldValue | undefined,
  range: FieldValue | undefined,
  context: OpRunContext,
): Promise<{ readonly name: string; readonly bytes: Uint8Array; readonly pages: readonly number[] }> {
  const picked = pickedFiles(value)[0];
  // Nothing was picked. `ToolError` carries no custom message key, so the closest
  // sentence the contract owns is "this file format is not supported" with the
  // hint "select a PDF file" — which is what the user has to do next
  // (`ops/file.ts` makes the same call).
  if (picked === undefined) {
    throw new ToolError('unsupported-format', {
      engine: 'ui',
      engineMessage: 'pageedit: no source PDF was picked',
    });
  }
  const bytes = new Uint8Array(await picked.arrayBuffer());

  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  let pageCount: number;
  try {
    pageCount = handle.pageCount;
  } finally {
    await handle.destroy();
  }

  const text = typeof range === 'string' ? range.trim() : '';
  const pages =
    text === ''
      ? Array.from({ length: pageCount }, (_unused, page) => page)
      : validateRanges(parsePageRanges(text, pageCount), pageCount).pages;
  return { name: picked.name, bytes, pages };
}

function readSource(params: Readonly<Record<string, FieldValue>>): SourceKind {
  // The renderer can only produce a declared option value, so this narrows the
  // wider `FieldValue` instead of guessing.
  const kind = params.source;
  return kind === 'image' || kind === 'document' ? kind : 'blank';
}

function readSize(params: Readonly<Record<string, FieldValue>>): SizeChoice {
  const size = params.size;
  return size === 'letter' || size === 'match' ? size : 'a4';
}

function readFit(params: Readonly<Record<string, FieldValue>>): 'fit' | 'fill' | 'stretch' {
  const fit = params.fit;
  return fit === 'fill' || fit === 'stretch' ? fit : 'fit';
}

/** The source document an insert or a replacement takes its pages from. */
async function readInsertSource(
  params: Readonly<Record<string, FieldValue>>,
  kind: SourceKind,
  context: OpRunContext,
): Promise<PageInsertSource> {
  if (kind === 'image') {
    const files = await pickedImages(params.images);
    if (files.length === 0) {
      throw new ToolError('selection-empty', {
        engine: 'ui',
        engineMessage: 'pageedit: no image was picked',
      });
    }
    return {
      kind: 'image',
      files,
      size: readSize(params),
      fit: readFit(params),
      marginMm: Number(params.marginMm),
    };
  }
  if (kind === 'document') {
    const picked = await pickedDocument(params.document, params.range, context);
    return { kind: 'document', bytes: picked.bytes, pages: picked.pages };
  }
  return { kind: 'blank', size: readSize(params), count: Math.round(Number(params.count)) };
}

/**
 * The pages a replacement contributes, as one document plus the source page each
 * replacement slot takes from it: blanks and images are built here (`blankPages`
 * / `imagesToPdf` inside `buildInsertedPages`), a picked document is used as it
 * is. `matchSizes` gives every slot the size of the page it replaces.
 */
async function buildReplacements(
  params: Readonly<Record<string, FieldValue>>,
  kind: SourceKind,
  matchSizes: readonly PageSizePt[] | null,
  pages: readonly number[],
  context: OpRunContext,
): Promise<{
  built: BuiltInsertedPages;
  name: string;
  indices: readonly number[];
  source: PageInsertSource;
}> {
  const source: PageInsertSource =
    kind === 'blank'
      ? { kind: 'blank', size: readSize(params), count: pages.length }
      : await readInsertSource(params, kind, context);

  const built = await buildInsertedPages(source, matchSizes, {
    signal: context.signal,
    // The builder labels its progress for an insert; a replacement says so.
    onProgress: (progress) => context.onProgress({ ...progress, labelKey: 'replace.progress.prepare' }),
  });
  const name =
    source.kind === 'document'
      ? (pickedFiles(params.document)[0]?.name ?? 'source document')
      : source.kind === 'blank'
        ? 'blank replacement pages'
        : (source.files[0]?.name ?? 'replacement images');
  const indices =
    source.kind === 'document'
      ? source.pages
      : Array.from({ length: built.pageCount }, (_unused, index) => index);
  return { built, name, indices, source };
}

/**
 * The position the first inserted page takes: the field counts 1-based pages as
 * "after page N" (0 = in front of everything) and is clamped to the document, so
 * a number typed for another document cannot fail the whole operation.
 */
function insertionPosition(value: FieldValue | undefined, pageCount: number): number {
  const requested = Math.round(Number(value ?? 0));
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  return Math.min(requested, pageCount);
}

/** Insert pages — blank, from images, or from another document's pages. */
export const insertPagesDialog: OperationDialogSpec = {
  id: 'insert-pages',
  titleKey: 'insert.title',
  introKey: 'insert.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  changesPageGeometry: true,
  fields: [
    {
      id: 'source',
      kind: 'radio',
      labelKey: 'insert.source',
      defaultValue: 'blank',
      columns: 3,
      options: [
        { value: 'blank', labelKey: 'insert.source.blank' },
        { value: 'image', labelKey: 'insert.source.image' },
        { value: 'document', labelKey: 'insert.source.document' },
      ],
    },
    {
      id: 'position',
      kind: 'number',
      labelKey: 'insert.position',
      hintKey: 'insert.positionHint',
      defaultValue: 1,
      min: 0,
      max: 5000,
      step: 1,
    },
    {
      id: 'count',
      kind: 'number',
      labelKey: 'insert.count',
      hintKey: 'insert.countHint',
      defaultValue: 1,
      min: 1,
      max: 2000,
      step: 1,
      visibleWhen: { field: 'source', equals: ['blank'] },
    },
    {
      id: 'size',
      kind: 'select',
      labelKey: 'insert.size',
      hintKey: 'insert.sizeMatchHint',
      defaultValue: 'a4',
      visibleWhen: { field: 'source', equals: ['blank', 'image'] },
      options: [
        { value: 'a4', labelKey: 'insert.size.a4' },
        { value: 'letter', labelKey: 'insert.size.letter' },
        { value: 'match', labelKey: 'insert.size.match' },
      ],
    },
    {
      id: 'fit',
      advanced: true,
      kind: 'select',
      labelKey: 'insert.fit',
      defaultValue: 'fit',
      visibleWhen: { field: 'source', equals: ['image'] },
      options: [
        { value: 'fit', labelKey: 'insert.fit.fit' },
        { value: 'fill', labelKey: 'insert.fit.fill' },
        { value: 'stretch', labelKey: 'insert.fit.stretch' },
      ],
    },
    {
      id: 'marginMm',
      advanced: true,
      kind: 'number',
      labelKey: 'insert.margin',
      hintKey: 'insert.marginHint',
      defaultValue: 0,
      min: 0,
      max: 50,
      step: 1,
      visibleWhen: { field: 'source', equals: ['image'] },
    },
    {
      id: 'images',
      kind: 'files',
      labelKey: 'insert.images',
      hintKey: 'insert.imagesHint',
      accept: 'image/*',
      multiple: true,
      visibleWhen: { field: 'source', equals: ['image'] },
    },
    {
      id: 'document',
      kind: 'files',
      labelKey: 'insert.document',
      hintKey: 'insert.documentHint',
      accept: 'application/pdf,.pdf',
      multiple: false,
      visibleWhen: { field: 'source', equals: ['document'] },
    },
    {
      id: 'range',
      kind: 'text',
      labelKey: 'insert.range',
      hintKey: 'insert.rangeHint',
      placeholderKey: 'op.scope.placeholder',
      defaultValue: '',
      maxLength: 200,
      visibleWhen: { field: 'source', equals: ['document'] },
    },
  ],
  run: async (params, context) => {
    const kind = readSource(params);
    const at = insertionPosition(params.position, context.pageCount);
    const source = await readInsertSource(params, kind, context);
    // `size: 'match'` takes the page the user is looking at; a viewer without a
    // current page leaves the operation to match the insertion point instead.
    const matchPage =
      context.currentPage >= 0 && context.currentPage < context.pageCount ? context.currentPage : undefined;

    const outcome = await insertPages(
      {
        source,
        at,
        bytes: context.bytes,
        pageCount: context.pageCount,
        ...(matchPage === undefined ? {} : { matchPage }),
      },
      { signal: context.signal, onProgress: context.onProgress },
    );

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'insert.note.inserted',
      noticeParams: {
        count: outcome.report.pageCount - context.pageCount,
        position: Math.min(at + 1, outcome.report.pageCount),
      },
    };
  },
};

/** Replace pages — the selection takes pages from a blank, image or document source. */
export const replacePagesDialog: OperationDialogSpec = {
  id: 'replace-pages',
  titleKey: 'replace.title',
  introKey: 'replace.intro',
  confirmKey: 'op.apply',
  resultKind: 'replace',
  changesPageGeometry: true,
  fields: [
    { id: 'scope', kind: 'pageScope', labelKey: 'op.scope', default: 'selection' },
    {
      id: 'source',
      kind: 'radio',
      labelKey: 'replace.source',
      hintKey: 'replace.countHint',
      defaultValue: 'blank',
      columns: 3,
      options: [
        { value: 'blank', labelKey: 'replace.source.blank' },
        { value: 'image', labelKey: 'replace.source.image' },
        { value: 'document', labelKey: 'replace.source.document' },
      ],
    },
    {
      id: 'size',
      kind: 'select',
      labelKey: 'insert.size',
      hintKey: 'replace.sizeHint',
      defaultValue: 'match',
      visibleWhen: { field: 'source', equals: ['blank', 'image'] },
      options: [
        { value: 'a4', labelKey: 'insert.size.a4' },
        { value: 'letter', labelKey: 'insert.size.letter' },
        { value: 'match', labelKey: 'insert.size.match' },
      ],
    },
    {
      id: 'fit',
      advanced: true,
      kind: 'select',
      labelKey: 'insert.fit',
      defaultValue: 'fit',
      visibleWhen: { field: 'source', equals: ['image'] },
      options: [
        { value: 'fit', labelKey: 'insert.fit.fit' },
        { value: 'fill', labelKey: 'insert.fit.fill' },
        { value: 'stretch', labelKey: 'insert.fit.stretch' },
      ],
    },
    {
      id: 'marginMm',
      advanced: true,
      kind: 'number',
      labelKey: 'insert.margin',
      hintKey: 'insert.marginHint',
      defaultValue: 0,
      min: 0,
      max: 50,
      step: 1,
      visibleWhen: { field: 'source', equals: ['image'] },
    },
    {
      id: 'images',
      kind: 'files',
      labelKey: 'insert.images',
      hintKey: 'insert.imagesHint',
      accept: 'image/*',
      multiple: true,
      visibleWhen: { field: 'source', equals: ['image'] },
    },
    {
      id: 'document',
      kind: 'files',
      labelKey: 'insert.document',
      hintKey: 'insert.documentHint',
      accept: 'application/pdf,.pdf',
      multiple: false,
      visibleWhen: { field: 'source', equals: ['document'] },
    },
    {
      id: 'range',
      kind: 'text',
      labelKey: 'insert.range',
      hintKey: 'insert.rangeHint',
      placeholderKey: 'op.scope.placeholder',
      defaultValue: '',
      maxLength: 200,
      visibleWhen: { field: 'source', equals: ['document'] },
    },
  ],
  run: async (params, context) => {
    const pages = resolveScope(params.scope, context);
    const kind = readSource(params);
    // Every replacement page can take the size of the page it replaces: the
    // sizes are read once, in one pass over the current document.
    const matchSizes =
      kind !== 'document' && readSize(params) === 'match' ? await pageSizesOf(context.bytes, pages) : null;

    const { built, name, indices, source } = await buildReplacements(
      params,
      kind,
      matchSizes,
      pages,
      context,
    );
    if (indices.length !== pages.length) {
      throw new ToolError('selection-empty', {
        engine: 'ui',
        engineMessage: `replace-pages: ${pages.length} page(s) selected, ${indices.length} replacement page(s) prepared${
          source.kind === 'image' ? ` from ${source.files.length} image(s)` : ''
        }`,
      });
    }

    const outcome = await replacePages(
      {
        bytes: context.bytes,
        pageCount: context.pageCount,
        pages,
        replacements: indices.map((index) => ({ name, bytes: built.bytes, index })),
      },
      { signal: context.signal, onProgress: context.onProgress },
    );

    return {
      files: [{ name: context.name, bytes: outcome.bytes, mime: 'application/pdf' }],
      report: outcome.report,
      noticeKey: 'replace.note.replaced',
      noticeParams: { count: pages.length },
    };
  },
};
