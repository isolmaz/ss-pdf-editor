/**
 * Splitting.
 *
 * Four modes: ranges, every N pages, by approximate size, and booklet
 * signatures. Range parsing and part naming come from `page-ranges.ts`, so the
 * Turkish error text and the file-name width rule are shared with every other
 * range consumer.
 *
 * Every part is produced through the composition path (`composeDocument`) on a
 * pdf.js document opened from the bytes being split — the document that owns the
 * annotation storage — so annotations and form values travel into the parts
 * instead of being rebuilt away.
 */

import { ToolError } from 'pdf-shared';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { composeDocument } from './compose';
import { chunkPages, parsePageRanges, partFileName } from './page-ranges';
import { type OperationContext, type OutputFile, throwIfAborted } from './types';

export type SplitMode = 'ranges' | 'everyN' | 'size' | 'booklet';

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
  const parts = planParts(options);
  return {
    parts,
    names: parts.map((_part, index) => partFileName(options.baseName, index, parts.length)),
  };
}

/** Produce one PDF per part. Progress is per part; cancellation stops between parts. */
export async function splitDocument(
  bytes: Uint8Array,
  options: SplitOptions,
  context: OperationContext,
): Promise<{ readonly files: readonly OutputFile[]; readonly plan: SplitPlan }> {
  throwIfAborted(context.signal);
  assertPageCount(options);
  assertSelection(options);

  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  try {
    const parts: number[][] = [];
    const blobs: Uint8Array[] = [];
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
      // real bytes: a part that comes back over the limit is produced again with
      // one page less, and the measured average sizes the next part. A page that
      // is bigger than the limit on its own is produced alone — a page cannot be
      // cut in half.
      const maxBytes = requireMaxBytes(options);
      const totalBytes = requireTotalBytes(options);
      let perPage = totalBytes / options.pageCount;
      let start = 0;
      while (start < options.pageCount) {
        throwIfAborted(context.signal);
        let take = Math.max(1, Math.min(Math.floor(maxBytes / perPage), options.pageCount - start));
        let partBytes = await composePart(pageBlock(start, take));
        while (partBytes.length > maxBytes && take > 1) {
          take -= 1;
          partBytes = await composePart(pageBlock(start, take));
        }
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
      for (const [index, partPages] of plan.entries()) {
        throwIfAborted(context.signal);
        context.onProgress?.({
          phase: 'part',
          labelKey: 'op.progress.split.parts',
          done: index,
          total: plan.length,
        });
        parts.push([...partPages]);
        blobs.push(await composePart(partPages));
      }
    }

    // Names are built once the part count is known — in `size` mode that is only
    // after the last part was measured — and `partFileName` widens the number
    // instead of running into the extension past 999.
    const files: OutputFile[] = blobs.map((partBytes, index) => ({
      name: partFileName(options.baseName, index, blobs.length),
      bytes: partBytes,
      mime: 'application/pdf',
    }));
    return { files, plan: { parts, names: files.map((file) => file.name) } };
  } finally {
    await handle.destroy();
  }
}

function planParts(options: SplitOptions): number[][] {
  assertPageCount(options);
  assertSelection(options);
  switch (options.mode) {
    case 'ranges':
      return planRanges(options);
    case 'everyN':
      return chunkPages(pageBlock(0, options.pageCount), requireChunkSize(options, null));
    case 'booklet':
      return chunkPages(pageBlock(0, options.pageCount), requireChunkSize(options, DEFAULT_SIGNATURE_PAGES));
    case 'size':
      return planBySize(options);
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
  return source
    .split(/[,;\n]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
    .map((segment) => [...parsePageRanges(segment, options.pageCount).pages]);
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
