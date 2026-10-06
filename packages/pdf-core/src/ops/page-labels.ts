/**
 * Page labels (`PLAN.md §5/Phase 3`: "Header/footer + Bates + page labels").
 *
 * Read and write are deliberately split across the two engines, because neither
 * one covers both directions on the pinned versions:
 *
 *  - **Write with MuPDF**: `PDFDocument.setPageLabels(index, style, prefix, start)`
 *    and `PDFDocument.deletePageLabels(index)` (`mupdf.d.ts:526-527`), with the style
 *    constants `PDFDocument.PAGE_LABEL_{NONE,DECIMAL,ROMAN_UC,ROMAN_LC,ALPHA_UC,ALPHA_LC}`
 *    (`mupdf.d.ts:520-525`). The earlier brief's `PDFPageLabelStyle` enum does **not**
 *    exist in the installed 1.28.1 typings — the constants live on `PDFDocument`, and
 *    the wrapper maps the first character of the string to the C enum
 *    (`mupdf.js:2072`: `style.charCodeAt(0)`), which is why `PAGE_LABEL_NONE` is the
 *    string `"\0"`: char code 0 means "no `/S` entry".
 *  - **Read with pdf.js**: `PDFDocumentProxy.getPageLabels(): Promise<Array<string> | null>`
 *    (`pdfjs-dist/types/src/display/api.d.ts:945`) through this package's pdf.js
 *    adapter. MuPDF has a per-page `Page.getLabel()` (`mupdf.d.ts:447`) but no
 *    `getPageLabels` at all, and pdf.js is the reader the app displays — so the labels
 *    the user sees and the labels this operation verifies against come from one engine.
 *
 * Measured on the installed engines (mupdf 1.28.1, pdfjs-dist 6.3.289, 6-page fixture):
 *  - `setPageLabels(0, ROMAN_LC, 'on-', 3)` + `setPageLabels(2, DECIMAL, '', 1)` reads
 *    back as `["on-iii","on-iv","1","2","3","4"]`: a range runs until the next range and
 *    then to the end of the document, and `start` is the value of its **first** page.
 *  - `deletePageLabels(i)` for every page clears a previous plan (verified by replacing a
 *    two-range plan with a one-range plan and re-reading: `["Ek-A"…"Ek-F"]`).
 *  - pdf.js returns `null` only while `/PageLabels` is **absent**; once a plan was
 *    written, pages before its first range read back with pdf.js's default labels
 *    (`["1","2",…]`) rather than as empty strings. The report says so out loud.
 *  - `garbage=compact,compress,clean` keeps `/Producer`, `/ModDate` and the label tree
 *    (measured with and without labels), so the MuPDF write does not need a
 *    producer-line re-stamp the way the rewriting writers (`saveRewrite`) do.
 *  - `formatLabel` reproduces pdf.js's own rendering (`pdf.worker.mjs:1440` roman,
 *    `pdf.worker.mjs:41119-41125` alpha `character.repeat()`): measured 26 → `Z`,
 *    27 → `AA`, 52 → `ZZ`, roman 4 → `IV`, 3999 → `MMMCMXCIX`.
 */

import { ToolError } from 'pdf-shared';
import type { Mupdf } from '../engines/mupdf';
import { loadMupdf, MUPDF_FULL_SAVE_OPTIONS, mapMupdfError, openPdf, savePdf } from '../engines/mupdf';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

/** Numbering style of a label range — the six values PDF's `/S` can express. */
export type PageLabelStyle =
  | 'none'
  | 'decimal'
  | 'roman-upper'
  | 'roman-lower'
  | 'alpha-upper'
  | 'alpha-lower';

export interface PageLabelRange {
  /** 0-based first page of the range. */
  readonly startPage: number;
  readonly style: PageLabelStyle;
  readonly prefix: string;
  /**
   * The number the style counts from on the range's first page (PDF `/St`) — a
   * positive integer, `1` when the range starts at "1". Sent as a number; `''` is
   * never a value here (the prefix carries the empty string when unused).
   */
  readonly start: number;
}

/** The MuPDF constant name per style — `PDFDocument.PAGE_LABEL_NONE` is `"\0"`. */
function styleFlag(mupdf: Mupdf, style: PageLabelStyle): string {
  const { PDFDocument } = mupdf;
  switch (style) {
    case 'none':
      return PDFDocument.PAGE_LABEL_NONE;
    case 'decimal':
      return PDFDocument.PAGE_LABEL_DECIMAL;
    case 'roman-upper':
      return PDFDocument.PAGE_LABEL_ROMAN_UC;
    case 'roman-lower':
      return PDFDocument.PAGE_LABEL_ROMAN_LC;
    case 'alpha-upper':
      return PDFDocument.PAGE_LABEL_ALPHA_UC;
    case 'alpha-lower':
      return PDFDocument.PAGE_LABEL_ALPHA_LC;
  }
}

const ROMAN_PAIRS: readonly (readonly [number, string])[] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

/** Subtractive roman numerals, the same table pdf.js renders labels with. */
function toRoman(value: number, lower: boolean): string {
  let remaining = value;
  let out = '';
  for (const [amount, letters] of ROMAN_PAIRS) {
    while (remaining >= amount) {
      out += letters;
      remaining -= amount;
    }
  }
  return lower ? out.toLowerCase() : out;
}

/**
 * pdf.js renders `A`-style labels as a repeated letter block
 * (`pdf.worker.mjs:41119-41125`): 1 → `A` … 26 → `Z`, 27 → `AA`, 52 → `ZZ`,
 * 53 → `AAA`. Deliberately the engine's rule and not the spreadsheet-style
 * `AA…AZ, BA…` rule, so the dialog's preview cannot disagree with the reader.
 */
function toAlpha(value: number, base: number): string {
  const letterIndex = value - 1;
  const character = String.fromCharCode(base + (letterIndex % 26));
  return character.repeat(Math.floor(letterIndex / 26) + 1);
}

/**
 * Render one label exactly as the reader renders it: the range's `start` value on
 * its first page (`index` 0) and the same sequence onwards.
 *
 * Pure and exported for the label dialog, which previews a rule before writing it.
 * A value below 1 is clamped to 1 — PDF's `/St` and every style are defined for
 * positive integers only, and a label rendered from `0` would be a string no reader
 * reproduces.
 */
export function formatLabel(style: PageLabelStyle, prefix: string, index: number, start: number): string {
  const base = Number.isFinite(start) ? Math.trunc(start) : 1;
  const offset = Number.isFinite(index) ? Math.trunc(index) : 0;
  const value = Math.max(1, base + offset);
  switch (style) {
    case 'none':
      return prefix;
    case 'decimal':
      return prefix + String(value);
    case 'roman-upper':
      return prefix + toRoman(value, false);
    case 'roman-lower':
      return prefix + toRoman(value, true);
    case 'alpha-upper':
      return prefix + toAlpha(value, 65);
    case 'alpha-lower':
      return prefix + toAlpha(value, 97);
  }
}

/**
 * The rendered label of every page, read with pdf.js.
 *
 * `null` from pdf.js means the file carries no `/PageLabels` at all and is reported
 * as an empty array (the one shape a caller can branch on without a second error
 * case). `pageCount` bounds the result to the document being read: pdf.js returns one
 * entry per page, and a longer array can only mean the caller passed bytes from a
 * different document.
 */
export async function readPageLabels(
  bytes: Uint8Array,
  pageCount: number,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  if (signal?.aborted) {
    throw new ToolError('aborted', {
      engine: 'pdfjs',
      engineMessage: 'signal aborted before reading labels',
    });
  }
  const handle = await openWithPdfjs(bytes, signal === undefined ? {} : { signal });
  try {
    const labels = await handle.raw.getPageLabels();
    if (labels === null) return [];
    const limit = pageCount > 0 ? Math.min(labels.length, Math.trunc(pageCount)) : labels.length;
    return labels.slice(0, limit);
  } finally {
    await handle.destroy();
  }
}

/**
 * Replace the document's whole label plan.
 *
 * A PDF has exactly one `/PageLabels` number tree, so "set these ranges" and "remove
 * everything else" are the same write: the plan is cleared range by range and the
 * requested ranges are then written in page order. Ranges that are not listed keep
 * no label entry, which is why the report names the pages that go back to the
 * default numbering instead of hiding it.
 */
export async function writePageLabels(
  bytes: Uint8Array,
  ranges: readonly PageLabelRange[],
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const mupdf = await loadMupdf();
  throwIfAborted(context.signal);

  const doc = openPdf(mupdf, bytes);
  const steps: string[] = ['load', 'labels', 'save'];
  const notes: OperationNote[] = [];
  let pageCount: number;
  let produced: Uint8Array;
  try {
    pageCount = doc.countPages();
    const planned = normalizeRanges(ranges, pageCount);

    // Clear the previous plan first: MuPDF's `setPageLabels` adds or replaces the
    // entry at one page index, so a leftover entry that the new plan does not name
    // would otherwise survive as a second, older rule.
    for (let index = 0; index < pageCount; index += 1) {
      throwIfAborted(context.signal);
      doc.deletePageLabels(index);
      context.onProgress?.({
        phase: 'labels',
        labelKey: 'op.progress.labels',
        done: index + 1,
        total: pageCount,
      });
    }
    for (const range of planned) {
      doc.setPageLabels(range.startPage, styleFlag(mupdf, range.style), range.prefix, range.start);
    }

    notes.push(note('changed', 'labels.note.plan', { count: planned.length }));
    notes.push(note('lost', 'labels.note.previous'));
    // Measured: the full save keeps Info and the producer line verbatim.
    notes.push(note('preserved', 'labels.note.info'));

    produced = savePdf(doc, MUPDF_FULL_SAVE_OPTIONS);
  } catch (error) {
    throw mapMupdfError(error, 'page-labels');
  } finally {
    doc.destroy();
  }
  throwIfAborted(context.signal);

  return {
    bytes: produced,
    report: {
      engine: 'mupdf',
      steps,
      notes,
      inputBytes: bytes.byteLength,
      outputBytes: produced.byteLength,
      pageCount,
      // A MuPDF full save is never incremental (`PLAN.md §3.3` rule 3).
      incremental: false,
    },
  };
}

/**
 * Ranges in document order, validated against the document.
 *
 * Duplicate `startPage` values are refused rather than resolved last-one-wins: two
 * rules starting on the same page is a plan the format cannot express, and silently
 * dropping one would produce labels the user never asked for.
 */
function normalizeRanges(ranges: readonly PageLabelRange[], pageCount: number): readonly PageLabelRange[] {
  if (ranges.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: 'page labels need at least one range',
    });
  }
  const sorted = [...ranges].sort((left, right) => left.startPage - right.startPage);
  const seen = new Set<number>();
  for (const range of sorted) {
    if (!Number.isSafeInteger(range.startPage) || range.startPage < 0 || range.startPage >= pageCount) {
      throw new ToolError('range-invalid', {
        engine: 'model',
        pageIndex: range.startPage,
        engineMessage: `label range starts at page ${range.startPage}, outside 0..${pageCount - 1}`,
      });
    }
    if (seen.has(range.startPage)) {
      throw new ToolError('range-invalid', {
        engine: 'model',
        pageIndex: range.startPage,
        engineMessage: `two label ranges start at page ${range.startPage}`,
      });
    }
    seen.add(range.startPage);
    if (!Number.isSafeInteger(range.start) || range.start < 1) {
      throw new ToolError('value-out-of-range', {
        engine: 'model',
        pageIndex: range.startPage,
        engineMessage: `label range start ${range.start} is not a positive integer`,
      });
    }
  }
  return sorted;
}
