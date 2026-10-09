/**
 * Page labels ("Header/footer + Bates + page labels").
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
 *
 * ### Labels across a multi-document composition
 *
 * pdf.js `extractPages` writes `/PageLabels` only when every page of the composition comes
 * from **one** document (`#collectPageLabels` returns when `!isSingleFile`,
 * `pdf.worker.mjs:63481`). An insert, a replacement or a merge has a second source, so the
 * engine drops the label tree and every base page would read as a plain `1, 2, 3…`.
 * `composedLabelRanges` plans the tree the engine did not write, and `replaceLabelRanges`
 * writes it, from three pieces:
 *
 *  - `readLabelRanges` reads a document's own ranges (`/Nums`, under `/Kids`) with the
 *    object model, because the planner needs the ranges themselves and not the rendered
 *    strings;
 *  - `composeLabelRanges` maps every output page back to its source page and the label
 *    **that source gave it**, then emits a range only where style, prefix or consecutive
 *    numbering breaks;
 *  - the rule for a page whose source has no `/PageLabels`: its decimal page number in that
 *    source (what a reader shows for such a file), so a blank page inserted into a labelled
 *    document reads `1` and an added document without labels counts from `1` itself. When no
 *    contributing source has labels, nothing is written.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import type { Mupdf } from '../engines/mupdf';
import { loadMupdf, MUPDF_FULL_SAVE_OPTIONS, mapMupdfError, openPdf, savePdf } from '../engines/mupdf';
import { readName, readText, resolved } from '../engines/mupdf-write';
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
    setLabelRanges(mupdf, doc, planned);

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
      // A MuPDF full save is never incremental.
      incremental: false,
    },
  };
}

/** `setPageLabels` once per range; the caller has cleared whatever plan was there before. */
function setLabelRanges(mupdf: Mupdf, doc: PDFDocument, ranges: readonly PageLabelRange[]): void {
  for (const range of ranges) {
    doc.setPageLabels(range.startPage, styleFlag(mupdf, range.style), range.prefix, range.start);
  }
}

/**
 * Make `ranges` the document's whole label plan: every old entry is cleared first
 * (`setPageLabels` adds or replaces the entry at one page index, so an entry the new plan
 * does not name would survive as an older rule), then the ranges are written.
 *
 * For the composition writers, which already hold the produced document open and call this
 * with the plan they computed (they skip the call when there is none). The first range
 * must start at page 0, as `composeLabelRanges` always has it: measured, clearing every entry
 * leaves a default decimal entry at page 0, which only a range starting there replaces.
 */
export function replaceLabelRanges(mupdf: Mupdf, doc: PDFDocument, ranges: readonly PageLabelRange[]): void {
  const pageCount = doc.countPages();
  for (let index = 0; index < pageCount; index += 1) doc.deletePageLabels(index);
  setLabelRanges(mupdf, doc, ranges);
}

/** The style a `/S` letter names; a missing or unknown letter is no numbering. */
function styleOfLetter(letter: string | null): PageLabelStyle {
  switch (letter) {
    case 'D':
      return 'decimal';
    case 'R':
      return 'roman-upper';
    case 'r':
      return 'roman-lower';
    case 'A':
      return 'alpha-upper';
    case 'a':
      return 'alpha-lower';
    default:
      return 'none';
  }
}

/**
 * A number tree is a few levels deep; a damaged or hostile one must end the walk instead of
 * overflowing the stack (the same bound `compose.ts` puts on an outline).
 */
const MAX_LABEL_TREE_DEPTH = 32;

/**
 * The label ranges of an open document, ascending by first page: the `/Nums` pairs of its
 * `/PageLabels` number tree, wherever they sit under `/Kids`. An empty list means the file
 * has no label plan.
 *
 * Read with the object model, not `readPageLabels`: composing labels needs the ranges
 * themselves (style, prefix, start), and a rendered string cannot be turned back into them.
 * The read is as forgiving as a reader has to be — a style letter it does not know is
 * `none`, a missing or non-positive `/St` is `1`, an entry that is not a (page index,
 * dictionary) pair is skipped, a node reachable twice is walked once (so a `/Kids` cycle
 * ends) — because the file being read may be damaged and the operation reading it is not
 * the place to refuse it.
 */
export function readLabelRanges(doc: PDFDocument): readonly PageLabelRange[] {
  const found = new Map<number, PageLabelRange>();
  const visited = new Set<number>();
  const walk = (entry: PDFObject, depth: number): void => {
    const node = resolved(entry);
    if (node?.isDictionary() !== true || depth > MAX_LABEL_TREE_DEPTH) return;
    if (entry.isIndirect()) {
      const id = entry.asIndirect();
      if (visited.has(id)) return;
      visited.add(id);
    }
    const nums = resolved(node.get('Nums'));
    if (nums?.isArray() === true) {
      for (let index = 0; index + 1 < nums.length; index += 2) {
        const page = resolved(nums.get(index));
        const label = resolved(nums.get(index + 1));
        if (page?.isNumber() !== true || label?.isDictionary() !== true || page.asNumber() < 0) continue;
        const start = resolved(label.get('St'));
        const startPage = Math.trunc(page.asNumber());
        found.set(startPage, {
          startPage,
          style: styleOfLetter(readName(label.get('S'))),
          prefix: readText(label.get('P')) ?? '',
          start: start?.isNumber() === true ? Math.max(1, Math.trunc(start.asNumber())) : 1,
        });
      }
    }
    const kids = resolved(node.get('Kids'));
    if (kids?.isArray() === true) {
      for (let index = 0; index < kids.length; index += 1) walk(kids.get(index), depth + 1);
    }
  };
  walk(doc.getTrailer().get('Root').get('PageLabels'), 0);
  return [...found.values()].sort((left, right) => left.startPage - right.startPage);
}

/** One page of a composition: the source it is copied from and where it lands. */
export interface LabelPlacement {
  /** Index into the `sources` list handed to the planner. */
  readonly source: number;
  /** 0-based page inside that source. */
  readonly page: number;
  /** 0-based page in the composed document. */
  readonly position: number;
}

/** What a reader shows on one page, in the terms a range is written in. */
interface PageLabelValue {
  readonly style: PageLabelStyle;
  readonly prefix: string;
  /** The number the style counts on this page. */
  readonly number: number;
}

/**
 * The label one source gives one of its pages, the way the reader renders it
 * (`#readPageLabels`, `pdf.worker.mjs:41067`): the last range that starts at or before the
 * page counts on from its `start`; a page in front of the first range has no style and no
 * prefix, so its label is empty; a source without a plan shows the page number.
 */
function labelOf(ranges: readonly PageLabelRange[], page: number): PageLabelValue {
  if (ranges.length === 0) return { style: 'decimal', prefix: '', number: page + 1 };
  const range = ranges.findLast((candidate) => candidate.startPage <= page);
  if (range === undefined) return { style: 'none', prefix: '', number: 1 };
  return { style: range.style, prefix: range.prefix, number: range.start + page - range.startPage };
}

/**
 * The label plan of a composition in which **every page keeps the label its own source
 * gave it**: each output page is mapped to its source page, labelled by that source's
 * ranges (`ranges[placement.source]`, ascending, as `readLabelRanges` returns them), and a
 * range starts only where the style or prefix changes or the numbering stops being
 * consecutive. A page continues the previous range when it is numbered one higher in the
 * same style and prefix — so a source's own range is not split, and a base range that
 * encloses an insertion is split exactly around it.
 *
 * Empty when no source that contributes a page has a plan: such a composition has no
 * labels to keep and none are invented. Pure; `placements` may come in any order.
 */
export function composeLabelRanges(
  ranges: readonly (readonly PageLabelRange[])[],
  placements: readonly LabelPlacement[],
): readonly PageLabelRange[] {
  // Callers index the sources they were handed, so every placement names a real entry.
  const planOf = (placement: LabelPlacement) => ranges[placement.source] as readonly PageLabelRange[];
  if (!placements.some((placement) => planOf(placement).length > 0)) return [];
  const composed: PageLabelRange[] = [];
  let previous: PageLabelValue | null = null;
  const ordered = [...placements].sort((left, right) => left.position - right.position);
  for (const [position, placement] of ordered.entries()) {
    const value = labelOf(planOf(placement), placement.page);
    const continues =
      previous !== null &&
      previous.style === value.style &&
      previous.prefix === value.prefix &&
      (value.style === 'none' || value.number === previous.number + 1);
    // An unnumbered range has nothing to count: `start` stays `1`.
    if (!continues) {
      composed.push({
        startPage: position,
        style: value.style,
        prefix: value.prefix,
        start: value.style === 'none' ? 1 : value.number,
      });
    }
    previous = value;
  }
  return composed;
}

/**
 * Plan the labels of a composition from the bytes of its sources: each source is opened
 * read-only and its ranges read, then `composeLabelRanges` maps them through `placements`
 * (`placements[i].source` indexes `sources`). `operation` names the step in an engine error.
 */
export async function composedLabelRanges(
  sources: readonly Uint8Array[],
  placements: readonly LabelPlacement[],
  context: OperationContext,
  operation: string,
): Promise<readonly PageLabelRange[]> {
  throwIfAborted(context.signal);
  const mupdf = await loadMupdf();
  const ranges: (readonly PageLabelRange[])[] = [];
  for (const bytes of sources) {
    throwIfAborted(context.signal);
    const doc = openPdf(mupdf, bytes);
    try {
      ranges.push(readLabelRanges(doc));
    } catch (error) {
      throw mapMupdfError(error, operation);
    } finally {
      doc.destroy();
    }
  }
  return composeLabelRanges(ranges, placements);
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
