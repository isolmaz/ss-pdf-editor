/**
 * Page ranges — the one parser every capability shares (Turkish errors,
 * duplicates rejected, out-of-range reported).
 *
 * Input syntax: `1-3, 5, 8-10`, open ranges (`3-`, `-4`), single pages, Turkish
 * separators tolerated (`;` and whitespace — `1 3` and `1-3 5` read like `1, 3`
 * and `1-3, 5`; whitespace *around* a dash binds the dash: `1 - 3` is one range).
 * Output is 0-based page indices, sorted and unique — the shape `extractPages`,
 * printing, OCR, redaction and imposition all consume. A caller whose pages are
 * *taken in the order typed* (inserting from another document) asks for
 * `{ ordered: true }` and gets the same unique indices in the order written.
 *
 * Pure and DOM-free so the model, the UI and Node tests share exactly one rule.
 * Errors are `ToolError`s with the shared `range-invalid` code and **no English
 * text**.
 */

import { ToolError } from 'pdf-shared';

export interface ParsedRanges {
  /** 0-based page indices, unique; ascending unless parsed with `{ ordered: true }`. */
  readonly pages: readonly number[];
  readonly source: string;
}

export interface ParsePageRangesOptions {
  /**
   * Keep the pages in the order they were written (`5, 1` → `[4, 0]`) instead of
   * sorting them. For consumers where the order is the request — pages inserted from
   * another document. Duplicates are still refused.
   */
  readonly ordered?: boolean;
}

const SEGMENT = /^(\d*)\s*[-–—]\s*(\d*)$/;

/** Guard against a typo like `1-999999999` turning into an allocation. */
const MAX_PAGE_NUMBER = 20_000;

function fail(value: string, engineMessage: string): never {
  throw new ToolError('range-invalid', { engine: 'model', engineMessage, path: value });
}

function addPage(pages: number[], seen: Set<number>, pageNumber: number, segment: string, pageCount: number) {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_PAGE_NUMBER) {
    fail(segment, 'page number out of the supported range');
  }
  if (pageNumber > pageCount) {
    fail(segment, `page ${pageNumber} out of document bounds (${pageCount})`);
  }
  if (seen.has(pageNumber)) fail(segment, 'duplicate page');
  seen.add(pageNumber);
  pages.push(pageNumber - 1);
}

/**
 * The segments of a range expression, in the order written: `,` `;` newline and
 * whitespace separate them, except spaces and tabs next to a dash, which belong to
 * the range (`1 - 3` is one segment, `1 3` is two; a newline is always a separator,
 * so `5 -\n7` is `5-` and `7`). Shared with `split.ts`, where
 * every segment becomes one part, so the two never disagree about where one
 * range ends.
 */
export function splitRangeSegments(source: string): string[] {
  return source
    .replace(/[ \t]*([-–—])[ \t]*/g, '$1')
    .split(/[,;\s]+/)
    .filter((segment) => segment !== '');
}

/**
 * Parse a page-range expression against a document.
 *
 * Rules:
 *  - 1-based input, 0-based output;
 *  - out-of-range pages are an error, never silently clamped;
 *  - duplicates are an error, because a duplicated range in a split produces
 *    two identical parts;
 *  - `pageCount` of 0 rejects everything;
 *  - never throws anything but a `ToolError`.
 */
export function parsePageRanges(
  input: string,
  pageCount: number,
  options: ParsePageRangesOptions = {},
): ParsedRanges {
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) {
    fail(input, 'invalid or zero document pageCount');
  }
  const source = input.trim();
  if (source === '') fail(source, 'empty range');

  const pages: number[] = [];
  const seen = new Set<number>();

  for (const segment of splitRangeSegments(source)) {
    if (/^\d+$/.test(segment)) {
      addPage(pages, seen, Number(segment), segment, pageCount);
      continue;
    }
    const match = SEGMENT.exec(segment);
    if (match === null) fail(segment, 'unparsable segment');
    const [, rawFrom, rawTo] = match;
    if (rawFrom === '' && rawTo === '') fail(segment, 'empty segment');
    const from = rawFrom === '' ? 1 : Number(rawFrom);
    const to = rawTo === '' ? pageCount : Number(rawTo);
    if (from > to) fail(segment, 'descending range');
    if (to > pageCount) fail(segment, `page ${to} out of document bounds (${pageCount})`);
    for (let page = from; page <= to; page += 1) addPage(pages, seen, page, segment, pageCount);
  }

  if (pages.length === 0) fail(source, 'no pages selected');
  if (options.ordered !== true) pages.sort((a, b) => a - b);
  return { pages, source };
}

/**
 * Validate parsed pages against a real document and return them ascending.
 * Reported separately from parsing so a caller can parse first (to show a
 * preview) and validate once the document is known.
 */
export function validateRanges(parsed: ParsedRanges, pageCount: number): ParsedRanges {
  for (const page of parsed.pages) {
    if (page < 0 || page >= pageCount) fail(String(page + 1), 'page out of bounds');
  }
  return parsed;
}

/** `[0,1,2,5]` → `1-3, 6` — used by the split preview and the report. */
export function formatPageRanges(pages: readonly number[]): string {
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = -1;
  let previous = -2;
  for (const page of sorted) {
    if (page !== previous + 1 && previous !== -2) {
      parts.push(start === previous ? String(start + 1) : `${start + 1}-${previous + 1}`);
      start = page;
    } else if (previous === -2) {
      start = page;
    }
    previous = page;
  }
  if (previous !== -2) {
    parts.push(start === previous ? String(start + 1) : `${start + 1}-${previous + 1}`);
  }
  return parts.join(', ');
}

/** Split `[0..9]` every 3 → `[[0,1,2],[3,4,5],[6,7,8],[9]]`. */
export function chunkPages(pages: readonly number[], size: number): number[][] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new ToolError('range-invalid', { engine: 'model', engineMessage: 'chunk size < 1' });
  }
  const chunks: number[][] = [];
  for (let index = 0; index < pages.length; index += size) {
    chunks.push(pages.slice(index, index + size));
  }
  return chunks;
}

/**
 * Part file name for a split. The width grows with the part count, so past 999 parts
 * the number never pads into the extension.
 */
export function partFileName(baseName: string, index: number, total: number, suffix = ''): string {
  const stem = baseName.replace(/\.pdf$/i, '');
  const width = String(total).length;
  const number = String(index + 1).padStart(width, '0');
  return `${stem}-${number}${suffix}.pdf`;
}

/**
 * Name of the file an extraction writes: the pages it holds, spelled so they cannot be
 * mistaken for a part counter or break a file system. `partFileName` put the counter
 * first, so extracting page 2 of `rapor.pdf` gave `rapor-1-2.pdf` (which reads as pages
 * 1 to 2) and pages "1-3, 5" gave a name holding a comma and a space.
 */
export function extractedFileName(baseName: string, pages: readonly number[]): string {
  const stem = baseName.replace(/\.pdf$/i, '');
  return `${stem}-p${formatPageRanges(pages).replace(/,\s*/g, '_')}.pdf`;
}
