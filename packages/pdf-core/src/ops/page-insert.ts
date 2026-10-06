/**
 * Page insertion and replacement — page management v2 ("add page (from file/document/blank/image), replace").
 *
 * Both operations are **compositions**, not rebuilds: the output is produced by
 * pdf.js's own `extractPages` running on the *live* document that owns the
 * annotation storage (`composeDocument` with `document: null`) — the rule
 * `ops/compose.ts` documents and measured: a byte source carries 0 storage-backed
 * annotations where the live handle carries 1 `Highlight`. Form values and
 * annotations therefore travel into the result instead of being rebuilt away.
 *
 * What the engine does **not** carry is the base document's Info: `#makeInfo`
 * copies Info only for a single-document composition, and both operations have a
 * second source, so the Info dictionary is written back afterwards with MuPDF
 * (`copyDocumentInfo`) — exactly the step `mergeDocuments` performs, for the same reason.
 * The rest of the source catalog (viewer preferences, `Lang`, output intents,
 * OCG/`OCProperties`, `OpenAction`) is rebuilt by the engine; the report says so.
 *
 * ### Page order (the part a reviewer wants to see without running an engine)
 *
 * `planInsert(pageCount, at, count)`:
 *
 * | output position | where the page comes from |
 * |---|---|
 * | `0 … at-1` | current document, pages `0 … at-1` |
 * | `at … at+count-1` | inserted source, pages `0 … count-1` (in the order given) |
 * | `at+count … pageCount+count-1` | current document, pages `at … pageCount-1` |
 *
 * `planReplace(pageCount, pages, replacements)`: the page count never changes;
 * every position keeps its page except the ones in `pages`, which take the
 * replacement whose index matches its slot (`replacements[i]` replaces
 * `pages[i]`, reading the page `replacements[i].index` of that replacement's own
 * document — the field exists so one document can supply several replacement
 * pages without being split first).
 *
 * The composition gets those positions explicitly (`ComposeSource.positions`),
 * so the engine is told the layout rather than trusted to derive it.
 *
 * ### Sources
 *
 * - `blank` — pages of a chosen paper size, or of the size of a page of the
 *   current document (`size: 'match'`); the matched size is the one a reader
 *   sees (`pageGeometry().display`), so a blank page matches a rotated page as
 *   it looks and not as it is stored.
 * - `image` — the picked images go through `imagesToPdf`, which owns PNG/JPEG
 *   sniffing, EXIF orientation and the fit modes. With `size: 'match'` the
 *   composed image pages are then scaled as whole pages onto pages of the
 *   matched size: `ImagesToPdfOptions` has no explicit page size, and a second
 *   image placement implementation is exactly what this file must not grow.
 * - `document` — another PDF, passed as **bytes**: the added document is never
 *   opened as an editable document. Its page indices are checked against its
 *   real page count, read through `openWithPdfjs` (a byte scan for
 *   `/Type /Page` misreads every document whose pages live in an object stream).
 */

import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError, openPdf } from '../engines/mupdf';
import {
  copyDocumentInfo,
  pdfNumber as num,
  openForWrite,
  pageAsForm,
  pageObjects,
  saveRewrite,
} from '../engines/mupdf-write';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { composeDocument } from './compose';
import { imagesToPdf } from './images';
import { pageGeometry } from './stamp';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

/** A page size in points (1 pt = 1/72"), the unit every engine here works in. */
export interface PageSizePt {
  readonly width: number;
  readonly height: number;
}

/** The two paper sizes a blank page can be asked for without a match page. */
export const PAPER_POINTS: Readonly<Record<'a4' | 'letter', PageSizePt>> = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
};

/**
 * Ceiling on the pages one insert may produce. The desktop tier's hard page
 * limit is 2000 (`pdf-shared/limits.ts`); a blank-page count is
 * a number a user types, so it is checked before anything is allocated.
 */
const MAX_PAGE_BUDGET = 2000;

export type PageInsertSource =
  | { readonly kind: 'blank'; readonly size: 'a4' | 'letter' | 'match'; readonly count: number }
  | {
      readonly kind: 'image';
      readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[];
      readonly size: 'a4' | 'letter' | 'match';
      readonly fit: 'fit' | 'fill' | 'stretch';
      readonly marginMm: number;
    }
  | {
      readonly kind: 'document';
      readonly bytes: Uint8Array;
      /** 0-based pages of the inserted document, in the order they are inserted. */
      readonly pages: readonly number[];
    };

export interface InsertPagesOptions {
  readonly source: PageInsertSource;
  /** 0-based position in the **current** document where the first inserted page lands. */
  readonly at: number;
  /** The current document the pages are inserted into. */
  readonly bytes: Uint8Array;
  /** Page count of `bytes`. */
  readonly pageCount: number;
  /** Match the inserted blank/image page size to this page of the current document. */
  readonly matchPage?: number;
}

export interface ReplacePagesOptions {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** 0-based pages of the current document that are replaced, ascending. */
  readonly pages: readonly number[];
  /** Exactly `pages.length` replacement pages; each is inserted in place. */
  readonly replacements: readonly {
    readonly name: string;
    readonly bytes: Uint8Array;
    /** 0-based page of this replacement's own document. */
    readonly index: number;
  }[];
}

/** One output page of an insert, and where it comes from. */
export interface PlannedInsertPage {
  /** 0-based position in the composed document. */
  readonly position: number;
  /** `document` = the current document, `inserted` = the source being inserted. */
  readonly source: 'document' | 'inserted';
  /** 0-based page inside that source. */
  readonly page: number;
}

/** One output page of a replacement, and where it comes from. */
export interface PlannedReplacePage {
  readonly position: number;
  /** `document` = the current document, `replacement` = one of the replacements. */
  readonly source: 'document' | 'replacement';
  /** 0-based page inside that source. */
  readonly page: number;
  /** Index into `ReplacePagesOptions.replacements`; absent for kept pages. */
  readonly replacement?: number;
}

/** What a built source contributes to the composition. */
export interface BuiltInsertedPages {
  readonly bytes: Uint8Array;
  /** Pages the built document holds; may be fewer than the images handed in. */
  readonly pageCount: number;
}

function requireIndex(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `${field} must be between ${min} and ${max}`,
      path: String(value),
    });
  }
  return value;
}

/**
 * The page order an insert produces. Pure: no engine, no bytes — the layout is
 * reviewable (and testable) before anything runs.
 */
export function planInsert(pageCount: number, at: number, count: number): readonly PlannedInsertPage[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: 'invalid page count',
      path: String(pageCount),
    });
  }
  requireIndex(at, 0, pageCount, 'at');
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: 'no pages to insert',
      path: String(count),
    });
  }
  if (pageCount + count > MAX_PAGE_BUDGET) {
    throw new ToolError('page-limit', {
      engine: 'model',
      engineMessage: `inserting ${count} pages into ${pageCount} exceeds the ${MAX_PAGE_BUDGET}-page budget`,
    });
  }

  const planned: PlannedInsertPage[] = [];
  for (let page = 0; page < pageCount; page += 1) {
    planned.push({
      // Every page of the current document keeps its order, shifted by the pages
      // that land in front of it.
      position: page < at ? page : page + count,
      source: 'document',
      page,
    });
  }
  for (let page = 0; page < count; page += 1) {
    planned.push({ position: at + page, source: 'inserted', page });
  }
  return planned.sort((left, right) => left.position - right.position);
}

/**
 * The page order a replacement produces: same count, same positions, except at
 * the replaced slots — which is what makes the operation impossible to get wrong
 * in a report, the numbering cannot shift.
 */
export function planReplace(
  pageCount: number,
  pages: readonly number[],
  replacements: readonly { readonly index: number }[],
): readonly PlannedReplacePage[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: 'invalid page count',
      path: String(pageCount),
    });
  }
  if (pages.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: 'no pages to replace',
    });
  }
  if (replacements.length !== pages.length) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: `${pages.length} page(s) selected but ${replacements.length} replacement page(s) built`,
    });
  }

  const slots = new Map<number, number>();
  let previous = -1;
  for (const [slot, page] of pages.entries()) {
    if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) {
      throw new ToolError('range-invalid', {
        engine: 'model',
        engineMessage: `page ${page + 1} is outside the ${pageCount}-page document`,
        pageIndex: page,
      });
    }
    if (page <= previous) {
      throw new ToolError('range-invalid', {
        engine: 'model',
        engineMessage: 'the replaced pages must be ascending and unique',
        pageIndex: page,
      });
    }
    previous = page;
    slots.set(page, slot);
  }

  const planned: PlannedReplacePage[] = [];
  for (let page = 0; page < pageCount; page += 1) {
    const slot = slots.get(page);
    if (slot === undefined) {
      planned.push({ position: page, source: 'document', page });
      continue;
    }
    const replacement = replacements[slot];
    if (replacement === undefined) {
      throw new ToolError('selection-empty', {
        engine: 'model',
        engineMessage: `replacement ${slot} is missing`,
      });
    }
    requireIndex(replacement.index, 0, Number.MAX_SAFE_INTEGER, 'replacement index');
    planned.push({ position: page, source: 'replacement', page: replacement.index, replacement: slot });
  }
  return planned;
}

/**
 * The size a reader sees for the given pages, one entry per index
 * (`pageGeometry().display`). The dialog uses it to resolve `size: 'match'`
 * before an operation runs, and `insertPages` uses it for the matched page.
 */
export async function pageSizesOf(
  bytes: Uint8Array,
  pageIndices: readonly number[],
): Promise<readonly PageSizePt[]> {
  const mupdf = await loadMupdf();
  // Read-only: nothing is written back, so the page tree is read without the
  // password check `openForWrite` makes.
  const document = openPdf(mupdf, bytes);
  try {
    const pages = pageObjects(document);
    return pageIndices.map((index) => {
      requireIndex(index, 0, pages.length - 1, 'page');
      const page = pages[index];
      if (page === undefined) throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex: index });
      const display = pageGeometry(page).display;
      return { width: display.width, height: display.height };
    });
  } catch (error) {
    throw mapMupdfError(error, 'pageSizesOf');
  } finally {
    document.destroy();
  }
}

/** The size for the `index`-th produced page; the last entry repeats. */
function matchSizeAt(sizes: readonly PageSizePt[] | null, index: number): PageSizePt {
  const size = sizes === null || sizes.length === 0 ? undefined : sizes[Math.min(index, sizes.length - 1)];
  if (size === undefined) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: 'size "match" without a matched page size',
    });
  }
  return size;
}

/** Pages of a fixed paper size, or one size per page when `sizes` is given. */
async function blankPages(count: number, sizes: readonly PageSizePt[]): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const document = new mupdf.PDFDocument();
  try {
    for (let index = 0; index < count; index += 1) {
      const size = matchSizeAt(sizes, index);
      document.insertPage(index, document.addPage([0, 0, size.width, size.height], 0, {}, ''));
    }
    return saveRewrite(document, 'blankPages');
  } finally {
    document.destroy();
  }
}

/**
 * Scale whole pages of `bytes` onto pages of the given sizes — the `match` step
 * for image sources. `fit` keeps the aspect ratio inside the page, `fill` covers
 * it (the page box is what clips the overflow) and `stretch` uses both axes
 * independently.
 *
 * Each source page becomes a form XObject of its visible box (`pageAsForm`) drawn once
 * on the new page.
 */
async function fitPagesOnto(
  bytes: Uint8Array,
  sizes: readonly PageSizePt[],
  fit: 'fit' | 'fill' | 'stretch',
  context: OperationContext,
): Promise<Uint8Array> {
  const { mupdf, doc: source } = await openForWrite(bytes);
  const out = new mupdf.PDFDocument();
  try {
    const pages = pageObjects(source);
    const graft = out.newGraftMap();
    for (const [index, sourcePage] of pages.entries()) {
      throwIfAborted(context.signal);
      const target = matchSizeAt(sizes, index);
      const { box } = pageGeometry(sourcePage);
      const form = pageAsForm(out, graft, sourcePage, box);
      const scaleX =
        fit === 'stretch'
          ? target.width / box.width
          : fit === 'fill'
            ? Math.max(target.width / box.width, target.height / box.height)
            : Math.min(target.width / box.width, target.height / box.height);
      const scaleY = fit === 'stretch' ? target.height / box.height : scaleX;
      const x = fit === 'stretch' ? 0 : (target.width - box.width * scaleX) / 2;
      const y = fit === 'stretch' ? 0 : (target.height - box.height * scaleY) / 2;
      const operators = `q ${num(scaleX)} 0 0 ${num(scaleY)} ${num(x)} ${num(y)} cm /P0 Do Q`;
      const page = out.addPage([0, 0, target.width, target.height], 0, { XObject: { P0: form } }, operators);
      out.insertPage(index, page);
    }
    return saveRewrite(out, 'fitPagesOnto');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'fitPagesOnto');
  } finally {
    out.destroy();
    source.destroy();
  }
}

/** Page count of a document the composition is about to take pages from. */
async function measuredPageCount(bytes: Uint8Array, context: OperationContext): Promise<number> {
  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  try {
    return handle.pageCount;
  } finally {
    await handle.destroy();
  }
}

/**
 * Turn a source into the document that is inserted — the one place a blank page
 * or an image page is made. `matchSizes` supplies the target sizes for
 * `size: 'match'`, one per produced page (the last entry repeats), which is what
 * lets a replacement give every slot its own size.
 */
export async function buildInsertedPages(
  source: PageInsertSource,
  matchSizes: readonly PageSizePt[] | null,
  context: OperationContext,
): Promise<BuiltInsertedPages> {
  throwIfAborted(context.signal);
  switch (source.kind) {
    case 'blank': {
      const count = requireIndex(source.count, 1, MAX_PAGE_BUDGET, 'blank page count');
      // A matched blank page takes the size of the page it lands on, one per
      // slot when the caller supplies them; a named paper size is the same for
      // every page.
      const sizes = source.size === 'match' ? (matchSizes ?? []) : [PAPER_POINTS[source.size]];
      context.onProgress?.({
        phase: 'prepare',
        labelKey: 'insert.progress.prepare',
        done: 0,
        total: count,
      });
      const bytes = await blankPages(count, sizes);
      return { bytes, pageCount: count };
    }

    case 'image': {
      if (source.files.length === 0) {
        throw new ToolError('selection-empty', {
          engine: 'model',
          engineMessage: 'no images were handed in',
        });
      }
      requireIndex(source.files.length, 1, MAX_PAGE_BUDGET, 'image count');
      const outcome = await imagesToPdf(
        {
          images: source.files,
          // The matched size is applied afterwards; an image's own pixel size at
          // 72 dpi is the neutral source the re-fit scales from.
          pageSize: source.size === 'match' ? 'fit' : source.size,
          fit: source.fit === 'fill' ? 'cover' : source.fit === 'stretch' ? 'stretch' : 'contain',
          marginMm: source.marginMm,
          applyExif: true,
        },
        { signal: context.signal, onProgress: context.onProgress },
      );
      if (source.size !== 'match') {
        return { bytes: outcome.bytes, pageCount: outcome.report.pageCount };
      }
      const fitted = await fitPagesOnto(outcome.bytes, matchSizes ?? [], source.fit, context);
      return { bytes: fitted, pageCount: outcome.report.pageCount };
    }

    default: {
      if (source.pages.length === 0) {
        throw new ToolError('selection-empty', {
          engine: 'model',
          engineMessage: 'no pages of the inserted document were chosen',
        });
      }
      requireIndex(source.pages.length, 1, MAX_PAGE_BUDGET, 'inserted page count');
      const pageCount = await measuredPageCount(source.bytes, context);
      for (const page of source.pages) {
        if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) {
          throw new ToolError('range-invalid', {
            engine: 'model',
            engineMessage: `page ${page + 1} is outside the inserted document's ${pageCount} pages`,
            pageIndex: page,
          });
        }
      }
      return { bytes: source.bytes, pageCount: source.pages.length };
    }
  }
}

/**
 * Write the base document's Info into a composition result and stamp the product
 * producer line. `copyDocumentInfo` is the same helper `impose`/`compress` use; the
 * Info dictionary only reaches the output through this step because the engine copies
 * it for single-document compositions only.
 */
async function carryBaseInfo(
  produced: Uint8Array,
  base: Uint8Array,
  context: OperationContext,
  operation: string,
): Promise<Uint8Array> {
  throwIfAborted(context.signal);
  const mupdf = await loadMupdf();
  // Read-only open: the base's Info is read, nothing is written back to it.
  const source = openPdf(mupdf, base);
  try {
    const { doc: document } = await openForWrite(produced);
    try {
      copyDocumentInfo(source, document);
      return saveRewrite(document, operation);
    } finally {
      document.destroy();
    }
  } catch (error) {
    throw mapMupdfError(error, operation);
  } finally {
    source.destroy();
  }
}

/** The matched page of the current document for `size: 'match'`. */
function resolveMatchPage(options: InsertPagesOptions): number | undefined {
  if (options.source.kind === 'document' || options.source.size !== 'match') return undefined;
  const { pageCount, matchPage } = options;
  if (pageCount === 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: 'size "match" needs a page of the current document, and it has none',
    });
  }
  // Without a request, the page *at* the insertion point is the one a blank page
  // should look like; the end of the document falls back to its last page.
  const index = matchPage ?? (options.at < pageCount ? options.at : pageCount - 1);
  requireIndex(index, 0, pageCount - 1, 'matchPage');
  return index;
}

export async function insertPages(
  options: InsertPagesOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const { at, pageCount } = options;
  const matchPage = resolveMatchPage(options);
  const matchSizes =
    matchPage === undefined
      ? null
      : await pageSizesOf(options.bytes, [matchPage]).then((sizes) => [...sizes]);

  const built = await buildInsertedPages(options.source, matchSizes, context);
  const plan = planInsert(pageCount, at, built.pageCount);
  const inserted = plan.filter((page) => page.source === 'inserted');
  const kept = plan.filter((page) => page.source === 'document');
  const outputCount = pageCount + built.pageCount;

  const handle = await openWithPdfjs(options.bytes, { signal: context.signal });
  let composed: Uint8Array;
  try {
    const outcome = await composeDocument(
      {
        pageCount: outputCount,
        sources: [
          {
            pages: kept.map((page) => page.page),
            positions: kept.map((page) => page.position),
          },
          {
            bytes: built.bytes,
            // A document source hands over the whole file: the plan's 0-based slot is
            // the chosen page list's index, not the page itself.
            pages: inserted.map((page) =>
              options.source.kind === 'document' ? (options.source.pages[page.page] ?? page.page) : page.page,
            ),
            positions: inserted.map((page) => page.position),
          },
        ],
      },
      handle.raw,
      {
        signal: context.signal,
        onProgress: (progress) =>
          context.onProgress?.({
            phase: 'place',
            labelKey: 'insert.progress.place',
            ...(progress.done === undefined ? {} : { done: progress.done }),
            ...(progress.total === undefined ? {} : { total: progress.total }),
          }),
      },
    );
    composed = outcome.bytes;
  } finally {
    await handle.destroy();
  }

  const bytes = await carryBaseInfo(composed, options.bytes, context, 'insertPages.metadata');
  const notes: OperationNote[] = [
    note('preserved', 'insert.note.storage'),
    note('lost', 'insert.note.catalog'),
    note('preserved', 'insert.note.info'),
    note('changed', 'insert.note.inserted', {
      count: built.pageCount,
      position: Math.min(at + 1, outputCount),
    }),
  ];
  if (options.source.kind === 'image' && built.pageCount < options.source.files.length) {
    notes.push(
      note('warning', 'insert.note.skipped', { count: options.source.files.length - built.pageCount }),
    );
  }

  return {
    bytes,
    report: {
      engine: 'pdfjs',
      steps: ['pdfjs.extractPages', 'metadata', 'save'],
      notes,
      inputBytes: options.bytes.length + built.bytes.length,
      outputBytes: bytes.length,
      pageCount: outputCount,
      // A composition writes a fresh file, never an incremental update.
      incremental: false,
    },
  };
}

export async function replacePages(
  options: ReplacePagesOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const plan = planReplace(options.pageCount, options.pages, options.replacements);

  // One source per distinct replacement document (by identity): the same file
  // used for several slots is parsed once by the engine, and its entry can carry
  // all of its pages ascending as the engine requires.
  const groups = new Map<Uint8Array, { name: string; pages: number[]; positions: number[] }>();
  for (const page of plan) {
    if (page.source !== 'replacement' || page.replacement === undefined) continue;
    const replacement = options.replacements[page.replacement];
    if (replacement === undefined) continue;
    const group = groups.get(replacement.bytes) ?? { name: replacement.name, pages: [], positions: [] };
    group.pages.push(page.page);
    group.positions.push(page.position);
    groups.set(replacement.bytes, group);
  }

  // Every index is checked against the real page count of its own document
  // before the engine sees it: `extractPages` would otherwise decide on its own
  // what an out-of-range page means.
  for (const [bytes, group] of groups) {
    const pageCount = await measuredPageCount(bytes, context);
    for (const page of group.pages) {
      if (page >= pageCount) {
        throw new ToolError('range-invalid', {
          engine: 'model',
          engineMessage: `${group.name} has ${pageCount} pages; page ${page + 1} was asked for`,
          path: group.name,
          pageIndex: page,
        });
      }
    }
  }

  const kept = plan.filter((page) => page.source === 'document');
  const handle = await openWithPdfjs(options.bytes, { signal: context.signal });
  let composed: Uint8Array;
  try {
    const outcome = await composeDocument(
      {
        pageCount: options.pageCount,
        sources: [
          { pages: kept.map((page) => page.page), positions: kept.map((page) => page.position) },
          ...[...groups].map(([bytes, group]) => ({
            bytes,
            pages: group.pages,
            positions: group.positions,
          })),
        ],
      },
      handle.raw,
      {
        signal: context.signal,
        onProgress: (progress) =>
          context.onProgress?.({
            phase: 'replace',
            labelKey: 'replace.progress.replace',
            ...(progress.done === undefined ? {} : { done: progress.done }),
            ...(progress.total === undefined ? {} : { total: progress.total }),
          }),
      },
    );
    composed = outcome.bytes;
  } finally {
    await handle.destroy();
  }

  const bytes = await carryBaseInfo(composed, options.bytes, context, 'replacePages.metadata');
  const notes: OperationNote[] = [
    note('preserved', 'insert.note.storage'),
    note('lost', 'insert.note.catalog'),
    note('preserved', 'insert.note.info'),
    note('changed', 'replace.note.replaced', { count: options.pages.length }),
  ];

  return {
    bytes,
    report: {
      engine: 'pdfjs',
      steps: ['pdfjs.extractPages', 'metadata', 'save'],
      notes,
      inputBytes: options.bytes.length + [...groups.keys()].reduce((total, bytes) => total + bytes.length, 0),
      outputBytes: bytes.length,
      pageCount: options.pageCount,
      incremental: false,
    },
  };
}
