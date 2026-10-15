/**
 * Splitting.
 *
 * Five modes: ranges, every N pages, by approximate size, booklet
 * signatures, and the bookmarks of the outline. Range parsing and part naming come from `page-ranges.ts`, so the
 * Turkish error text and the file-name width rule are shared with every other
 * range consumer.
 *
 * Every part is produced through the composition path (`composeDocument`) on a
 * pdf.js document opened from the bytes being split — the document that owns the
 * annotation storage — so annotations and form values travel into the parts
 * instead of being rebuilt away.
 */

import { ToolError } from 'pdf-shared';
import { openWithPdfjs, type PdfOutlineEntry } from '../engines/pdfjs-handle';
import { composeDocument } from './compose';
import { chunkPages, parsePageRanges, partFileName, splitRangeSegments } from './page-ranges';
import { type OperationContext, type OutputFile, throwIfAborted } from './types';

export type SplitMode = 'ranges' | 'everyN' | 'size' | 'booklet' | 'bookmarks';

/** A bookmark that starts a part: its title and the 0-based page it points to. */
export interface SplitBookmark {
  readonly title: string;
  readonly pageIndex: number;
}

export interface SplitOptions {
  readonly mode: SplitMode;
  /** `ranges` mode: e.g. `1-3, 5`. */
  readonly ranges?: string;
  /** `everyN` and `booklet` modes: pages per part / pages per signature. */
  readonly chunkSize?: number;
  /** `size` mode: the largest part, in bytes. */
  readonly maxBytes?: number;
  /** Part name stem; the part number and `.pdf` are appended by `partFileName`. */
  readonly baseName: string;
  readonly pageCount: number;
  /**
   * Byte size of the document being split. Only `size` mode needs it: parts are
   * planned from the page-count proportion and then checked against the real
   * bytes while they are produced. A size plan without it would be a guess, so
   * `planSplit` fails instead of previewing a part count it cannot know.
   */
  readonly totalBytes?: number;
  /** `bookmarks` mode: the bookmarks that start the parts, as `readSplitBookmarks` returns them. */
  readonly bookmarks?: readonly SplitBookmark[];
  /** `bookmarks` mode: the name of the part holding the pages before the first bookmark. */
  readonly leadTitle?: string;
}

export interface SplitPlan {
  /** One entry per part, as 0-based page indices into the source. */
  readonly parts: readonly (readonly number[])[];
  readonly names: readonly string[];
}

/** A booklet signature is two folded sheets: four pages. */
const DEFAULT_SIGNATURE_PAGES = 4;

/**
 * Compute the parts without producing bytes — what the dialog previews before
 * the user commits, and what validation errors are reported against.
 */
export function planSplit(options: SplitOptions): SplitPlan {
  const { parts, suffixes } = planParts(options);
  return {
    parts,
    names: parts.map((_part, index) =>
      partFileName(options.baseName, index, parts.length, suffixes?.[index] ?? ''),
    ),
  };
}

export interface SplitResult {
  readonly files: readonly OutputFile[];
  readonly plan: SplitPlan;
  /**
   * `size` mode: 0-based pages that are bigger than the limit on their own. Each is
   * a single-page part that still exceeds `maxBytes` — a page cannot be cut — so the
   * limit does not hold for it. Empty in every other mode.
   */
  readonly oversizedPages: readonly number[];
}

/** Produce one PDF per part. Progress is per part; cancellation stops between parts. */
export async function splitDocument(
  bytes: Uint8Array,
  options: SplitOptions,
  context: OperationContext,
): Promise<SplitResult> {
  throwIfAborted(context.signal);
  assertPageCount(options);
  assertSelection(options);

  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  try {
    const parts: number[][] = [];
    let suffixes: readonly string[] | undefined;
    const blobs: Uint8Array[] = [];
    const oversizedPages: number[] = [];
    const composePart = async (partPages: readonly number[]): Promise<Uint8Array> => {
      const outcome = await composeDocument(
        {
          pageCount: partPages.length,
          sources: [
            {
              pages: partPages,
              positions: partPages.map((_page, position) => position),
            },
          ],
        },
        handle.raw,
        context,
      );
      return outcome.bytes;
    };

    if (options.mode === 'size') {
      // Estimated from the page-count proportion first, then verified against the
      // real bytes: a part that comes back over the limit is corrected from its
      // measured size (`fitPart`), and the measured average sizes the next part.
      // A page that is bigger than the limit on its own is produced alone — a page
      // cannot be cut in half — and is reported in `oversizedPages`.
      const maxBytes = requireMaxBytes(options);
      const totalBytes = requireTotalBytes(options);
      let perPage = totalBytes / options.pageCount;
      let start = 0;
      while (start < options.pageCount) {
        throwIfAborted(context.signal);
        const estimate = Math.max(1, Math.min(Math.floor(maxBytes / perPage), options.pageCount - start));
        const { take, bytes: partBytes } = await fitPart(start, estimate, maxBytes, composePart, context);
        if (take === 1 && partBytes.length > maxBytes) oversizedPages.push(start);
        perPage = partBytes.length / take;
        parts.push(pageBlock(start, take));
        blobs.push(partBytes);
        start += take;
        context.onProgress?.({
          phase: 'part',
          labelKey: 'op.progress.split.parts',
          done: parts.length,
        });
      }
    } else {
      const plan = planParts(options);
      suffixes = plan.suffixes;
      for (const [index, partPages] of plan.parts.entries()) {
        throwIfAborted(context.signal);
        context.onProgress?.({
          phase: 'part',
          labelKey: 'op.progress.split.parts',
          done: index,
          total: plan.parts.length,
        });
        parts.push([...partPages]);
        blobs.push(await composePart(partPages));
      }
    }

    // Names are built once the part count is known — in `size` mode that is only
    // after the last part was measured — and `partFileName` widens the number
    // instead of running into the extension past 999.
    const files: OutputFile[] = blobs.map((partBytes, index) => ({
      name: partFileName(options.baseName, index, blobs.length, suffixes?.[index] ?? ''),
      bytes: partBytes,
      mime: 'application/pdf',
    }));
    return { files, plan: { parts, names: files.map((file) => file.name) }, oversizedPages };
  } finally {
    await handle.destroy();
  }
}

/**
 * The largest block of pages from `start` — at most `estimate` — whose part stays
 * within `maxBytes`, found with `O(log estimate)` productions instead of one per
 * page of overshoot.
 *
 * The estimate is produced first. If it is over the limit, the *measured* size says
 * how many pages should fit (a part of `n` pages weighing `b` bytes holds about
 * `n * maxBytes / b`), and that is the second probe; every probe after it bisects
 * the bracket between the largest block known to fit and the smallest known to be
 * over, so the work is bounded even when the size is not proportional to the page
 * count (fonts and other shared resources are repeated in every part). A single
 * page that is over the limit is returned as it is: `take === 1` with
 * `bytes.length > maxBytes`.
 */
async function fitPart(
  start: number,
  estimate: number,
  maxBytes: number,
  composePart: (pages: readonly number[]) => Promise<Uint8Array>,
  context: OperationContext,
): Promise<{ readonly take: number; readonly bytes: Uint8Array }> {
  let over = { take: estimate, bytes: await composePart(pageBlock(start, estimate)) };
  if (over.bytes.length <= maxBytes || estimate === 1) return over;

  let fits: { take: number; bytes: Uint8Array } | null = null;
  let next = Math.floor((over.take * maxBytes) / over.bytes.length);
  while (over.take - (fits?.take ?? 0) > 1) {
    throwIfAborted(context.signal);
    const lowest = (fits?.take ?? 0) + 1;
    next = Math.min(Math.max(next, lowest), over.take - 1);
    const probe = { take: next, bytes: await composePart(pageBlock(start, next)) };
    if (probe.bytes.length <= maxBytes) fits = probe;
    else over = probe;
    next = Math.floor(((fits?.take ?? 0) + over.take) / 2);
  }
  // Nothing smaller fits: the bracket closed on one page that is over the limit by itself.
  return fits ?? over;
}

interface PlannedParts {
  readonly parts: number[][];
  /** The text each part adds to its file name after its number; `bookmarks` mode only. */
  readonly suffixes?: readonly string[];
}

function planParts(options: SplitOptions): PlannedParts {
  assertPageCount(options);
  assertSelection(options);
  const all = pageBlock(0, options.pageCount);
  switch (options.mode) {
    case 'ranges':
      return { parts: planRanges(options) };
    case 'everyN':
      return { parts: chunkPages(all, requireChunkSize(options, null)) };
    case 'booklet':
      return { parts: chunkPages(all, requireChunkSize(options, DEFAULT_SIGNATURE_PAGES)) };
    case 'size':
      return { parts: planBySize(options) };
    case 'bookmarks':
      return planByBookmarks(options);
  }
}

/** Longest bookmark title kept in a file name, in characters. */
const MAX_TITLE_NAME = 60;

/** A bookmark title as the end of a file name: no path or reserved characters, no edge dots or spaces. */
function titleSuffix(title: string): string {
  const clean = title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what a file name must not hold
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ');
  const cut = Array.from(clean.trim()).slice(0, MAX_TITLE_NAME).join('');
  const name = cut.replace(/^[. ]+|[. ]+$/g, '');
  return name === '' ? '' : `-${name}`;
}

/**
 * One part per bookmark, from its page to the page before the next bookmark's; the pages before
 * the first bookmark are a part of their own. Bookmarks on the same page start one part, named
 * after the first of them in outline order.
 */
function planByBookmarks(options: SplitOptions): PlannedParts {
  const marks = (options.bookmarks ?? []).map((mark, order) => ({ ...mark, order }));
  for (const mark of marks) {
    if (!Number.isSafeInteger(mark.pageIndex) || mark.pageIndex < 0 || mark.pageIndex >= options.pageCount) {
      throw new ToolError('range-invalid', {
        engine: 'model',
        engineMessage: `bookmark "${mark.title}" points to page index ${mark.pageIndex}, outside the document`,
      });
    }
  }
  if (marks.length === 0) {
    throw new ToolError('no-bookmarks', {
      engine: 'model',
      engineMessage: 'the document has no bookmark that points to a page',
    });
  }
  marks.sort((left, right) => left.pageIndex - right.pageIndex || left.order - right.order);
  const starts = marks.filter((mark, index) => index === 0 || mark.pageIndex !== marks[index - 1]?.pageIndex);
  const parts: number[][] = [];
  const titles: string[] = [];
  const first = starts[0] as (typeof starts)[number];
  if (first.pageIndex > 0) {
    parts.push(pageBlock(0, first.pageIndex));
    titles.push(options.leadTitle ?? '');
  }
  for (const [index, mark] of starts.entries()) {
    const end = starts[index + 1]?.pageIndex ?? options.pageCount;
    parts.push(pageBlock(mark.pageIndex, end - mark.pageIndex));
    titles.push(mark.title);
  }
  return { parts, suffixes: titles.map(titleSuffix) };
}

/**
 * The bookmarks of the outline down to `level` (1 = the top ones), in outline order, with the page
 * each points to. `skipped` counts those that point to no page of this document (a link to another
 * file, a destination that does not resolve): they cannot start a part.
 */
export function flattenOutline(
  outline: readonly PdfOutlineEntry[],
  level: number,
): { readonly bookmarks: readonly SplitBookmark[]; readonly skipped: number } {
  const bookmarks: SplitBookmark[] = [];
  let skipped = 0;
  const walk = (entries: readonly PdfOutlineEntry[], depth: number): void => {
    for (const entry of entries) {
      if (entry.pageIndex === null) skipped += 1;
      else bookmarks.push({ title: entry.title, pageIndex: entry.pageIndex });
      if (depth < level) walk(entry.children, depth + 1);
    }
  };
  walk(outline, 1);
  return { bookmarks, skipped };
}

/** Read the outline of a document and flatten it for `bookmarks` mode. */
export async function readSplitBookmarks(
  bytes: Uint8Array,
  level: number,
  context: OperationContext,
): Promise<{ readonly bookmarks: readonly SplitBookmark[]; readonly skipped: number }> {
  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  try {
    return flattenOutline(await handle.getOutline(), level);
  } finally {
    await handle.destroy();
  }
}

/** One part per entered range, in the order the user wrote them. */
function planRanges(options: SplitOptions): number[][] {
  const source = options.ranges?.trim() ?? '';
  if (source === '') {
    throw new ToolError('selection-empty', { engine: 'model', engineMessage: 'no range was entered' });
  }
  // The whole expression is parsed first: one parser decides what a duplicate, a
  // descending or an out-of-range page means.
  parsePageRanges(source, options.pageCount);
  return splitRangeSegments(source).map((segment) => [...parsePageRanges(segment, options.pageCount).pages]);
}

function planBySize(options: SplitOptions): number[][] {
  const maxBytes = requireMaxBytes(options);
  const totalBytes = requireTotalBytes(options);
  const perPage = totalBytes / options.pageCount;
  const parts: number[][] = [];
  let start = 0;
  while (start < options.pageCount) {
    const take = Math.max(1, Math.min(Math.floor(maxBytes / perPage), options.pageCount - start));
    parts.push(pageBlock(start, take));
    start += take;
  }
  return parts;
}

function assertPageCount(options: SplitOptions): void {
  if (!Number.isSafeInteger(options.pageCount) || options.pageCount < 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `page count ${options.pageCount} is not a whole number of pages`,
    });
  }
}

/** Nothing selected is its own outcome: a range may be valid and still cover nothing. */
function assertSelection(options: SplitOptions): void {
  if (options.pageCount === 0) {
    throw new ToolError('selection-empty', { engine: 'model', engineMessage: 'the document has no pages' });
  }
}

function requireChunkSize(options: SplitOptions, fallback: number | null): number {
  const size = options.chunkSize ?? fallback;
  if (size === null) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: 'splitting every N pages needs the page count per part',
    });
  }
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `pages per part ${size} is not a positive whole number`,
    });
  }
  return size;
}

function requireMaxBytes(options: SplitOptions): number {
  const maxBytes = options.maxBytes;
  if (maxBytes === undefined || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: 'splitting by size needs the largest part size in bytes',
    });
  }
  return maxBytes;
}

function requireTotalBytes(options: SplitOptions): number {
  const totalBytes = options.totalBytes;
  if (totalBytes === undefined || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    throw new ToolError('internal', {
      engine: 'model',
      engineMessage: 'size mode needs the document byte size to estimate the pages per part',
    });
  }
  return totalBytes;
}

/** `[start, start + count)` as a page list. */
function pageBlock(start: number, count: number): number[] {
  return Array.from({ length: count }, (_unused, offset) => start + offset);
}
