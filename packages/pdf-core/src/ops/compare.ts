/**
 * Document comparison (`PLAN.md §5/Phase 4` — "document comparison, text and
 * rendered pixels"): what a second document changed, stated per page.
 *
 * Two independent answers, and the method is never implied:
 *
 *  - `compareText` extracts both documents with the **existing** text operation
 *    (`ops/text-export.ts`) and diffs the extracted lines. There is deliberately no
 *    second extractor here: a comparison whose left side disagrees with the text the
 *    user can export is worse than no comparison. The export is asked for every page
 *    of each side, so the page counts come from the same engine that produced the
 *    text, and every requested page index is validated against that document inside
 *    the export — a wrong count cannot silently drop pages.
 *  - `compareVisual` renders both documents through the **existing** viewer adapter
 *    (`engines/pdfjs-handle.ts`) at one fixed low DPI, 4x box-downscales them to
 *    greyscale and reports the differing-pixel percentage plus the number of differing
 *    tiles, so a block that merely moved is visible as such (`PLAN.md §7` pixel policy:
 *    4x downscaled greyscale, <= 0.5 % pixel difference).
 *
 * Both are bounded, both take the shared `AbortSignal`/progress contract, and both
 * fail through the mapped `ToolError` vocabulary only. The bounds are named in
 * {@link COMPARE_LIMITS} and every one of them is reported: a bound that was hit sets
 * `truncated` and names the reason, so a partial answer can never be read as a
 * complete one. A page count mismatch is reported (`pageCountDelta`, plus `added` /
 * `removed` page entries), never silently truncated to the shorter document.
 *
 * **The raster surface is injected.** `compress.ts` may call `document.createElement`
 * because it is a main-thread writer, but this module is also the engine half of the
 * comparison probe (`tools/spikes/compare-probe.mts`) and must run in Node, where no
 * canvas exists. The caller therefore supplies `createCanvas`, and the page's pixels
 * are read back through `getImageData` — the same call `compress.ts` already makes.
 */

import { ToolError, toToolError } from 'pdf-shared';
import { openWithPdfjs, type PdfDocumentHandle } from '../engines/pdfjs-handle';
import { exportText } from './text-export';
import { type OperationContext, throwIfAborted } from './types';

/* ------------------------------------------------------------------ shared ----- */

/** One 0-based page position in the left document's order. */
export type ComparePageStatus = 'identical' | 'changed' | 'added' | 'removed' | 'unavailable';

/** Why a page's answer is not complete. Stable ids, not user text. */
export type CompareTruncationReason =
  /** The line-level LCS matrix did not fit; the page is reported as one replaced block. */
  | 'line-matrix'
  /** A changed line pair exceeded the word-level matrix; it is named line-level only. */
  | 'word-matrix'
  /** The per-page change list was cut off at `maxReportedLines`. */
  | 'line-list'
  /** The page raster would have exceeded `maxRasterPixels`; the page was not compared. */
  | 'raster-cap';

/**
 * Every bound the two comparisons obey. Named and overridable so a caller (or a
 * probe) can tighten them; the defaults are what the product runs with.
 */
export const COMPARE_LIMITS = {
  /**
   * Cells in the line-level LCS matrix of **one page** (one cell = one line pair).
   * 250 000 cells is a 4 MB `Uint32Array` at worst, and a page pair that exceeds it
   * is not comparable line by line — it degrades to one replaced block, reported.
   */
  maxLineMatrixCells: 250_000,
  /** Cells in one word-level LCS matrix (one cell = one word pair). */
  maxWordMatrixCells: 4_096,
  /** Changed lines named per page; the counters stay exact when the list is cut. */
  maxReportedLines: 200,
  /** Pixels in one page raster; above it the page is reported `unavailable`. */
  maxRasterPixels: 4_000_000,
} as const;

export type CompareLimits = { -readonly [K in keyof typeof COMPARE_LIMITS]: number };

/** Percent of differing pixels at or below which two pages are called identical. */
export const IDENTICAL_PERCENT = 0.5;

/** The one DPI both sides are rendered at; low on purpose (comparison, not print). */
export const COMPARE_DPI = 40;

/**
 * Greyscale distance (0-255) above which a downscaled pixel counts as different.
 * 16/255 is 6 % of the range: it survives antialiasing and the 4x box filter,
 * which is what makes "identical" mean identical rather than "nearly".
 */
const PIXEL_THRESHOLD = 16;

/** Tile edge, in 4x-downscaled pixels — the granularity "a block moved" is seen at. */
const TILE_SIZE = 16;

/** Why a compared page could not be answered at all. */
type UnavailableReason = 'page-too-large' | 'page-size-mismatch';

function requireRange(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `compare: ${field} is ${String(value)}, expected ${min}..${max}`,
    });
  }
  return value;
}

/**
 * An abort that reached this module as a plain `AbortError` is the one failure that
 * must not become `internal`: the user asked for it. `toToolError` only recognises a
 * `DOMException`, which `throwIfAborted` does not create.
 */
function mapCompareError(error: unknown): ToolError {
  if (error instanceof Error && error.name === 'AbortError') {
    return new ToolError('aborted', { engine: 'model', engineMessage: error.message }, { cause: error });
  }
  return toToolError(error, 'pdfjs');
}

/** 0-based positions to compare: every position either document has, or the caller's list. */
function positionsOf(leftCount: number, rightCount: number, pages: readonly number[] | undefined): number[] {
  const reach = Math.max(leftCount, rightCount);
  if (pages === undefined) return [...Array(reach).keys()];
  const unique = new Set<number>();
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 0 || page >= reach) {
      throw new ToolError('range-invalid', {
        engine: 'model',
        engineMessage: `compare: page index out of bounds (${String(page)} of ${reach})`,
        pageIndex: page,
      });
    }
    unique.add(page);
  }
  return [...unique].sort((a, b) => a - b);
}

/* -------------------------------------------------------------------- text ----- */

export interface CompareWordChange {
  readonly kind: 'added' | 'removed';
  readonly text: string;
}

/** One line of the answer: a whole line added, removed, or a changed pair. */
export interface CompareLineChange {
  readonly kind: 'added' | 'removed' | 'changed';
  /** 1-based line number on the left; `null` when the line has no left side. */
  readonly leftLine: number | null;
  /** 1-based line number on the right; `null` when the line has no right side. */
  readonly rightLine: number | null;
  /** The right document's line (`added`/`changed`), or the left document's (`removed`). */
  readonly text: string;
  /** The left document's line — present only for a `changed` pair. */
  readonly previous?: string;
  /**
   * The word-level detail of a `changed` pair; `null` means the words did not fit
   * `maxWordMatrixCells` and the pair is named at line level only.
   */
  readonly words: readonly CompareWordChange[] | null;
}

export interface TextPageComparison {
  readonly pageIndex: number;
  readonly status: ComparePageStatus;
  /** Lines the extractor produced per side; a missing side is 0. */
  readonly leftLines: number;
  readonly rightLines: number;
  /** Exact counts, even when `lines` is cut off. */
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  /** The changes themselves, in document order, capped by `maxReportedLines`. */
  readonly lines: readonly CompareLineChange[];
  readonly truncated: boolean;
  readonly reasons: readonly CompareTruncationReason[];
}

export interface TextComparison {
  readonly method: 'text';
  readonly leftPageCount: number;
  readonly rightPageCount: number;
  /** right count - left count; non-zero means pages exist on one side only. */
  readonly pageCountDelta: number;
  readonly pages: readonly TextPageComparison[];
  readonly summary: {
    readonly pagesCompared: number;
    readonly identicalPages: number;
    readonly changedPages: number;
    readonly addedPages: number;
    readonly removedPages: number;
    readonly addedLines: number;
    readonly removedLines: number;
    readonly changedLines: number;
  };
  /** At least one bound was hit; the detail below is partial. */
  readonly truncated: boolean;
  readonly truncationReasons: readonly CompareTruncationReason[];
}

export interface CompareTextOptions {
  /** Page positions to compare; default is every position either document has. */
  readonly pages?: readonly number[];
  readonly limits?: Partial<CompareLimits>;
}

/**
 * One document's per-page text, from the export operation and nothing else.
 *
 * The export writes one separator per page (`----- N -----`), which is how the page
 * boundaries are recovered; the separators are matched **in order** from a moving
 * cursor, so a page whose own text happens to contain a separator line cannot shift
 * the split earlier without the sequence check failing.
 */
async function pageTexts(
  bytes: Uint8Array,
  context: OperationContext,
): Promise<{ readonly pageCount: number; readonly texts: readonly string[] }> {
  throwIfAborted(context.signal);
  const handle: PdfDocumentHandle = await openWithPdfjs(bytes, { signal: context.signal });
  let pageCount: number;
  try {
    pageCount = handle.pageCount;
  } finally {
    await handle.destroy();
  }
  if (pageCount === 0) return { pageCount, texts: [] };

  const exportPages = [...Array(pageCount).keys()];
  const exported = await exportText(
    bytes,
    { pages: exportPages, format: 'text', baseName: 'compare' },
    context,
  );
  // The plain-text export starts with a BOM (Windows Notepad) and ends with a newline.
  const body = new TextDecoder()
    .decode(exported.file.bytes)
    .replace(/^\uFEFF/, '')
    .replace(/\n$/, '');
  const texts: string[] = [];
  let cursor = 0;
  for (let index = 1; index < pageCount; index += 1) {
    const marker = `\n\n----- ${index + 1} -----\n\n`;
    const at = body.indexOf(marker, cursor);
    if (at < 0) {
      throw new ToolError('internal', {
        engine: 'model',
        engineMessage: `compare: page separator ${String(index + 1)} not found in the text export`,
      });
    }
    texts.push(body.slice(cursor, at));
    cursor = at + marker.length;
  }
  texts.push(body.slice(cursor));
  return { pageCount, texts };
}

/** Lines of one exported page; blank lines carry paragraph breaks, not content. */
function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
}

type LineOp = 'equal' | 'added' | 'removed';

/**
 * LCS over two line arrays, walked backwards from a `Uint32Array` table.
 * The caller has already checked that the table fits `maxLineMatrixCells`: this
 * function allocates exactly `(left+1) * (right+1)` words and nothing else.
 */
function lcsOps(left: readonly string[], right: readonly string[]): LineOp[] {
  const leftCount = left.length;
  const rightCount = right.length;
  const stride = rightCount + 1;
  const table = new Uint32Array((leftCount + 1) * stride);
  for (let i = leftCount - 1; i >= 0; i -= 1) {
    for (let j = rightCount - 1; j >= 0; j -= 1) {
      const here = i * stride + j;
      table[here] =
        left[i] === right[j]
          ? (table[(i + 1) * stride + j + 1] as number) + 1
          : Math.max(table[(i + 1) * stride + j] as number, table[i * stride + j + 1] as number);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < leftCount && j < rightCount) {
    if (left[i] === right[j]) {
      ops.push('equal');
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * stride + j] as number) >= (table[i * stride + j + 1] as number)) {
      ops.push('removed');
      i += 1;
    } else {
      ops.push('added');
      j += 1;
    }
  }
  while (i < leftCount) {
    ops.push('removed');
    i += 1;
  }
  while (j < rightCount) {
    ops.push('added');
    j += 1;
  }
  return ops;
}

/**
 * Word-level detail of a changed pair: the words that differ, with their kind.
 * `null` when the pair exceeds `maxWordMatrixCells` — the caller reports the pair at
 * line level and marks the page truncated rather than allocating a huge table.
 */
function diffWords(left: string, right: string, maxCells: number): readonly CompareWordChange[] | null {
  const leftWords = left.split(/\s+/).filter((word) => word !== '');
  const rightWords = right.split(/\s+/).filter((word) => word !== '');
  if ((leftWords.length + 1) * (rightWords.length + 1) > maxCells) return null;
  const ops = lcsOps(leftWords, rightWords);
  const changes: CompareWordChange[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  for (const op of ops) {
    if (op === 'equal') {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    if (op === 'removed') {
      changes.push({ kind: 'removed', text: leftWords[leftIndex] as string });
      leftIndex += 1;
      continue;
    }
    changes.push({ kind: 'added', text: rightWords[rightIndex] as string });
    rightIndex += 1;
  }
  return changes;
}

interface PageDiff {
  readonly changes: readonly CompareLineChange[];
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly truncated: boolean;
  readonly reasons: readonly CompareTruncationReason[];
}

/**
 * One page's line diff.
 *
 * The common prefix and suffix are trimmed first, so the matrix only covers the part
 * that actually differs — the normal case for a document with one edited line. The
 * remaining middle decides the level:
 *
 *  - it fits `maxLineMatrixCells` -> an exact LCS over lines, and every changed pair
 *    is refined to words when the pair fits `maxWordMatrixCells`;
 *  - it does not -> the middle is reported as one replaced block (all left lines
 *    removed, all right lines added) with `line-matrix` in the reasons. Never an
 *    unbounded allocation, and never a silent "identical".
 */
function diffPage(left: readonly string[], right: readonly string[], limits: CompareLimits): PageDiff {
  const reasons = new Set<CompareTruncationReason>();
  const changes: CompareLineChange[] = [];
  let added = 0;
  let removed = 0;
  let changed = 0;

  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;
  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1;
  }
  const middleLeft = left.slice(head, left.length - tail);
  const middleRight = right.slice(head, right.length - tail);

  const fits = (middleLeft.length + 1) * (middleRight.length + 1) <= limits.maxLineMatrixCells;
  const ops: LineOp[] = fits
    ? lcsOps(middleLeft, middleRight)
    : [...middleLeft.map((): LineOp => 'removed'), ...middleRight.map((): LineOp => 'added')];
  if (!fits) reasons.add('line-matrix');

  // Walk the ops, collecting hunks of consecutive removals and additions. A hunk's
  // i-th removal pairs with its i-th addition: that is what makes "one line changed"
  // read as one changed line instead of one removal plus one addition.
  const pendingRemoved: number[] = [];
  const pendingAdded: number[] = [];
  const flush = () => {
    const pairs = Math.min(pendingRemoved.length, pendingAdded.length);
    for (let index = 0; index < pairs; index += 1) {
      const leftIndex = pendingRemoved[index] as number;
      const rightIndex = pendingAdded[index] as number;
      const previous = middleLeft[leftIndex] as string;
      const text = middleRight[rightIndex] as string;
      const words = diffWords(previous, text, limits.maxWordMatrixCells);
      if (words === null) reasons.add('word-matrix');
      changed += 1;
      changes.push({
        kind: 'changed',
        leftLine: head + leftIndex + 1,
        rightLine: head + rightIndex + 1,
        text,
        previous,
        words,
      });
    }
    for (let index = pairs; index < pendingRemoved.length; index += 1) {
      const leftIndex = pendingRemoved[index] as number;
      removed += 1;
      changes.push({
        kind: 'removed',
        leftLine: head + leftIndex + 1,
        rightLine: null,
        text: middleLeft[leftIndex] as string,
        words: null,
      });
    }
    for (let index = pairs; index < pendingAdded.length; index += 1) {
      const rightIndex = pendingAdded[index] as number;
      added += 1;
      changes.push({
        kind: 'added',
        leftLine: null,
        rightLine: head + rightIndex + 1,
        text: middleRight[rightIndex] as string,
        words: null,
      });
    }
    pendingRemoved.length = 0;
    pendingAdded.length = 0;
  };

  let leftIndex = 0;
  let rightIndex = 0;
  for (const op of ops) {
    if (op === 'equal') {
      flush();
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    if (op === 'removed') {
      pendingRemoved.push(leftIndex);
      leftIndex += 1;
      continue;
    }
    pendingAdded.push(rightIndex);
    rightIndex += 1;
  }
  flush();

  changes.sort((a, b) => {
    const left = a.leftLine ?? Number.MAX_SAFE_INTEGER;
    const other = b.leftLine ?? Number.MAX_SAFE_INTEGER;
    if (left !== other) return left - other;
    return (a.rightLine ?? 0) - (b.rightLine ?? 0);
  });

  const truncated = changes.length > limits.maxReportedLines;
  if (truncated) reasons.add('line-list');
  return {
    changes: truncated ? changes.slice(0, limits.maxReportedLines) : changes,
    added,
    removed,
    changed,
    truncated: truncated || reasons.size > 0,
    reasons: [...reasons],
  };
}

export async function compareText(
  leftBytes: Uint8Array,
  rightBytes: Uint8Array,
  context: OperationContext,
  options: CompareTextOptions = {},
): Promise<TextComparison> {
  const limits: CompareLimits = { ...COMPARE_LIMITS, ...options.limits };
  try {
    context.onProgress?.({ phase: 'text', labelKey: 'op.progress.textExport', done: 0, total: 2 });
    const left = await pageTexts(leftBytes, context);
    throwIfAborted(context.signal);
    context.onProgress?.({ phase: 'text', labelKey: 'op.progress.textExport', done: 1, total: 2 });
    const right = await pageTexts(rightBytes, context);
    throwIfAborted(context.signal);

    const positions = positionsOf(left.pageCount, right.pageCount, options.pages);
    const pages: TextPageComparison[] = [];
    const reasons = new Set<CompareTruncationReason>();
    let addedLines = 0;
    let removedLines = 0;
    let changedLines = 0;
    let identicalPages = 0;
    let changedPages = 0;
    let addedPages = 0;
    let removedPages = 0;

    for (const [index, pageIndex] of positions.entries()) {
      throwIfAborted(context.signal);
      const onlyLeft = pageIndex >= right.pageCount;
      const onlyRight = pageIndex >= left.pageCount;
      const leftLines = onlyRight ? [] : splitLines(left.texts[pageIndex] as string);
      const rightLines = onlyLeft ? [] : splitLines(right.texts[pageIndex] as string);
      const diff = diffPage(leftLines, rightLines, limits);
      addedLines += diff.added;
      removedLines += diff.removed;
      changedLines += diff.changed;
      const status: ComparePageStatus = onlyLeft
        ? 'removed'
        : onlyRight
          ? 'added'
          : diff.changes.length === 0
            ? 'identical'
            : 'changed';
      if (status === 'identical') identicalPages += 1;
      else if (status === 'changed') changedPages += 1;
      else if (status === 'added') addedPages += 1;
      else removedPages += 1;
      for (const reason of diff.reasons) reasons.add(reason);
      pages.push({
        pageIndex,
        status,
        leftLines: leftLines.length,
        rightLines: rightLines.length,
        added: diff.added,
        removed: diff.removed,
        changed: diff.changed,
        lines: diff.changes,
        truncated: diff.truncated,
        reasons: diff.reasons,
      });
      context.onProgress?.({
        phase: 'text',
        labelKey: 'op.progress.textExport',
        done: index + 1,
        total: positions.length,
      });
    }

    return {
      method: 'text',
      leftPageCount: left.pageCount,
      rightPageCount: right.pageCount,
      pageCountDelta: right.pageCount - left.pageCount,
      pages,
      summary: {
        pagesCompared: positions.length,
        identicalPages,
        changedPages,
        addedPages,
        removedPages,
        addedLines,
        removedLines,
        changedLines,
      },
      truncated: reasons.size > 0,
      truncationReasons: [...reasons],
    };
  } catch (error) {
    throw mapCompareError(error);
  }
}

/* ------------------------------------------------------------------ visual ----- */

/**
 * The 2D surface this module needs: exactly what `renderPage` writes into and what
 * `getImageData` reads back. A DOM canvas satisfies it structurally; a Node caller
 * supplies its own (`tools/spikes/compare-probe.mts`).
 */
export interface CompareCanvasPixels {
  getImageData(
    x: number,
    y: number,
    width: number,
    height: number,
  ): {
    readonly data: Uint8ClampedArray | Uint8Array;
  };
}

export interface CompareCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): CompareCanvasPixels | null;
}

export interface VisualPageComparison {
  readonly pageIndex: number;
  readonly status: ComparePageStatus;
  /** Differing downscaled pixels as a percentage of the compared area. */
  readonly differencePercent: number;
  readonly differingPixels: number;
  readonly totalPixels: number;
  /** Mean absolute greyscale distance over the compared area (0-255). */
  readonly meanDifference: number;
  /** Tiles holding at least one differing pixel — where the change is. */
  readonly differingTiles: number;
  readonly tileCount: number;
  readonly tiles: { readonly columns: number; readonly rows: number };
  /** Raster size at this DPI; `null` for a page only the other document has. */
  readonly leftSize: { readonly width: number; readonly height: number } | null;
  readonly rightSize: { readonly width: number; readonly height: number } | null;
  /** Present when the page is `unavailable` or the two rasters are not the same size. */
  readonly reason?: UnavailableReason;
}

export interface VisualComparison {
  readonly method: 'pixels';
  readonly dpi: number;
  /** Percent at or below which a page counts as identical (`PLAN.md §7`). */
  readonly thresholdPercent: number;
  readonly leftPageCount: number;
  readonly rightPageCount: number;
  readonly pageCountDelta: number;
  readonly pages: readonly VisualPageComparison[];
  readonly summary: {
    readonly pagesCompared: number;
    readonly identicalPages: number;
    readonly changedPages: number;
    readonly addedPages: number;
    readonly removedPages: number;
    readonly unavailablePages: number;
    readonly meanDifferencePercent: number;
  };
  readonly truncated: boolean;
  readonly truncationReasons: readonly CompareTruncationReason[];
}

export interface CompareVisualOptions {
  /** One fresh rasterisation surface per page. Required: this module is DOM-free. */
  readonly createCanvas: () => CompareCanvas;
  /** Low fixed DPI for both sides; default {@link COMPARE_DPI}. */
  readonly dpi?: number;
  /** Page positions to compare; default is every position either document has. */
  readonly pages?: readonly number[];
  readonly limits?: Partial<CompareLimits>;
}

interface GreyImage {
  readonly width: number;
  readonly height: number;
  readonly grey: Uint8Array;
}

/** Rec. 601 luma with integer weights (77+150+29 = 256), matching `compress.ts`. */
function luma(red: number, green: number, blue: number): number {
  return (77 * red + 150 * green + 29 * blue) >> 8;
}

/**
 * 4x box-downscale to greyscale in one pass over the RGBA buffer, so the raster is
 * never copied: the policy's 4x/greyscale step is also what keeps the comparison's
 * own memory to a quarter of the pixels.
 */
function downscaleGreyscale(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  factor: number,
): GreyImage {
  const columns = Math.max(1, Math.floor(width / factor));
  const rows = Math.max(1, Math.floor(height / factor));
  const grey = new Uint8Array(columns * rows);
  for (let row = 0; row < rows; row += 1) {
    const y0 = row * factor;
    const y1 = Math.min(y0 + factor, height);
    for (let column = 0; column < columns; column += 1) {
      const x0 = column * factor;
      const x1 = Math.min(x0 + factor, width);
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y += 1) {
        let at = (y * width + x0) * 4;
        for (let x = x0; x < x1; x += 1) {
          sum += luma(rgba[at] as number, rgba[at + 1] as number, rgba[at + 2] as number);
          at += 4;
          count += 1;
        }
      }
      grey[row * columns + column] = Math.round(sum / Math.max(1, count));
    }
  }
  return { width: columns, height: rows, grey };
}

interface GreyDiff {
  readonly totalPixels: number;
  readonly differingPixels: number;
  readonly differencePercent: number;
  readonly meanDifference: number;
  readonly differingTiles: number;
  readonly tileCount: number;
  readonly columns: number;
  readonly rows: number;
}

/** Mean absolute difference per pixel, plus the tiles that hold at least one of them. */
function diffGrey(left: GreyImage, right: GreyImage, tileSize: number): GreyDiff {
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  const columns = Math.max(1, Math.ceil(width / tileSize));
  const rows = Math.max(1, Math.ceil(height / tileSize));
  const tiles = new Uint8Array(columns * rows);
  let differingPixels = 0;
  let sum = 0;
  for (let y = 0; y < height; y += 1) {
    const tileRow = Math.floor(y / tileSize) * columns;
    const leftRow = y * left.width;
    const rightRow = y * right.width;
    for (let x = 0; x < width; x += 1) {
      const a = left.grey[leftRow + x] as number;
      const b = right.grey[rightRow + x] as number;
      const delta = a > b ? a - b : b - a;
      sum += delta;
      if (delta > PIXEL_THRESHOLD) {
        differingPixels += 1;
        tiles[tileRow + Math.floor(x / tileSize)] = 1;
      }
    }
  }
  let differingTiles = 0;
  for (const tile of tiles) differingTiles += tile;
  const totalPixels = width * height;
  return {
    totalPixels,
    differingPixels,
    differencePercent: totalPixels === 0 ? 0 : (differingPixels / totalPixels) * 100,
    meanDifference: totalPixels === 0 ? 0 : sum / totalPixels,
    differingTiles,
    tileCount: columns * rows,
    columns,
    rows,
  };
}

interface RasterResult {
  readonly grey: GreyImage | null;
  readonly size: { readonly width: number; readonly height: number } | null;
}

/** One page's downscaled greyscale raster, or `null` if it would breach the cap. */
async function rasterPage(
  handle: PdfDocumentHandle,
  pageIndex: number,
  scale: number,
  limits: CompareLimits,
  context: OperationContext,
  createCanvas: () => CompareCanvas,
): Promise<RasterResult> {
  const view = await handle.getPageSize(pageIndex, scale);
  const size = { width: Math.max(1, Math.round(view.width)), height: Math.max(1, Math.round(view.height)) };
  // The cap is checked before a surface is created: a page over it is reported, not rendered.
  if (size.width * size.height > limits.maxRasterPixels) return { grey: null, size };
  const canvas = createCanvas();
  // The adapter's own render call, at the comparison's fixed scale. `devicePixelRatio: 1`
  // keeps a HiDPI screen from inflating the raster, and the white background makes the
  // greyscale of an untouched area exactly white instead of transparent.
  await handle.renderPage(pageIndex, canvas as unknown as HTMLCanvasElement, {
    scale,
    devicePixelRatio: 1,
    background: '#ffffff',
    signal: context.signal,
  });
  const context2d = canvas.getContext('2d');
  if (context2d === null) {
    throw new ToolError('unsupported', {
      engine: 'model',
      engineMessage: 'compare: the supplied canvas has no 2d context',
    });
  }
  const image = context2d.getImageData(0, 0, canvas.width, canvas.height);
  const grey = downscaleGreyscale(image.data, canvas.width, canvas.height, 4);
  return { grey, size: { width: canvas.width, height: canvas.height } };
}

export async function compareVisual(
  leftBytes: Uint8Array,
  rightBytes: Uint8Array,
  context: OperationContext,
  options: CompareVisualOptions,
): Promise<VisualComparison> {
  const limits: CompareLimits = { ...COMPARE_LIMITS, ...options.limits };
  const dpi = requireRange(options.dpi ?? COMPARE_DPI, 12, 96, 'dpi');
  const scale = dpi / 72;
  const reasons = new Set<CompareTruncationReason>();
  let left: PdfDocumentHandle | null = null;
  let right: PdfDocumentHandle | null = null;

  try {
    throwIfAborted(context.signal);
    left = await openWithPdfjs(leftBytes, { signal: context.signal });
    right = await openWithPdfjs(rightBytes, { signal: context.signal });
    const positions = positionsOf(left.pageCount, right.pageCount, options.pages);
    const pages: VisualPageComparison[] = [];
    let identicalPages = 0;
    let changedPages = 0;
    let addedPages = 0;
    let removedPages = 0;
    let unavailablePages = 0;
    let compared = 0;
    let differenceSum = 0;

    for (const [index, pageIndex] of positions.entries()) {
      throwIfAborted(context.signal);
      const onlyLeft = pageIndex >= right.pageCount;
      const onlyRight = pageIndex >= left.pageCount;
      const leftRaster = onlyRight
        ? { grey: null, size: null }
        : await rasterPage(left, pageIndex, scale, limits, context, options.createCanvas);
      throwIfAborted(context.signal);
      const rightRaster = onlyLeft
        ? { grey: null, size: null }
        : await rasterPage(right, pageIndex, scale, limits, context, options.createCanvas);

      let entry: VisualPageComparison;
      if (onlyLeft || onlyRight) {
        // Nothing to compare, but the page's size at this DPI is still a fact about the
        // document — and it is what a reader needs to see the page counts differ.
        const view = await (onlyLeft ? left : right).getPageSize(pageIndex, scale);
        const size = {
          width: Math.max(1, Math.round(view.width)),
          height: Math.max(1, Math.round(view.height)),
        };
        entry = {
          pageIndex,
          status: onlyLeft ? 'removed' : 'added',
          differencePercent: 0,
          differingPixels: 0,
          totalPixels: 0,
          meanDifference: 0,
          differingTiles: 0,
          tileCount: 0,
          tiles: { columns: 0, rows: 0 },
          leftSize: onlyLeft ? size : null,
          rightSize: onlyRight ? size : null,
        };
        if (onlyLeft) removedPages += 1;
        else addedPages += 1;
      } else if (leftRaster.grey === null || rightRaster.grey === null) {
        reasons.add('raster-cap');
        unavailablePages += 1;
        entry = {
          pageIndex,
          status: 'unavailable',
          differencePercent: 0,
          differingPixels: 0,
          totalPixels: 0,
          meanDifference: 0,
          differingTiles: 0,
          tileCount: 0,
          tiles: { columns: 0, rows: 0 },
          leftSize: leftRaster.size,
          rightSize: rightRaster.size,
          reason: 'page-too-large',
        };
      } else {
        const mismatch =
          leftRaster.grey.width !== rightRaster.grey.width ||
          leftRaster.grey.height !== rightRaster.grey.height;
        const diff = diffGrey(leftRaster.grey, rightRaster.grey, TILE_SIZE);
        const status: ComparePageStatus =
          diff.differencePercent <= IDENTICAL_PERCENT ? 'identical' : 'changed';
        if (status === 'identical') identicalPages += 1;
        else changedPages += 1;
        compared += 1;
        differenceSum += diff.differencePercent;
        entry = {
          pageIndex,
          status,
          differencePercent: diff.differencePercent,
          differingPixels: diff.differingPixels,
          totalPixels: diff.totalPixels,
          meanDifference: diff.meanDifference,
          differingTiles: diff.differingTiles,
          tileCount: diff.tileCount,
          tiles: { columns: diff.columns, rows: diff.rows },
          leftSize: leftRaster.size,
          rightSize: rightRaster.size,
          ...(mismatch ? { reason: 'page-size-mismatch' as const } : {}),
        };
      }
      pages.push(entry);
      context.onProgress?.({
        phase: 'render',
        labelKey: 'op.progress.compress.render',
        done: index + 1,
        total: positions.length,
      });
    }

    return {
      method: 'pixels',
      dpi,
      thresholdPercent: IDENTICAL_PERCENT,
      leftPageCount: left.pageCount,
      rightPageCount: right.pageCount,
      pageCountDelta: right.pageCount - left.pageCount,
      pages,
      summary: {
        pagesCompared: compared,
        identicalPages,
        changedPages,
        addedPages,
        removedPages,
        unavailablePages,
        meanDifferencePercent: compared === 0 ? 0 : differenceSum / compared,
      },
      truncated: reasons.size > 0,
      truncationReasons: [...reasons],
    };
  } catch (error) {
    throw mapCompareError(error);
  } finally {
    // Two pdf.js workers are two document copies; both must go, cancelled or not.
    await right?.destroy();
    await left?.destroy();
  }
}
