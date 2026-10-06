/**
 * Bulk text find for the redaction mark list (`PLAN.md §5/Phase 3`, `§6` A14).
 *
 * The erasure engine (`ops/redact.ts`) takes rectangles; this module is what turns a
 * user's pattern list into them. Nothing here erases anything, and nothing here
 * draws: the mark list belongs to the panel, the geometry to the engine.
 *
 * **Which MuPDF calls.** A page's text is built *once* —
 * `page.toStructuredText('preserve-whitespace')` (`mupdf.d.ts:453`) — and both the
 * page text (`StructuredText.asText()`, `mupdf.d.ts:267`) and the match locations
 * (`StructuredText.search(needle, {})`, `mupdf.d.ts:271`) come from that one object.
 * `Page.search` (`mupdf.d.ts:457`) is the same engine primitive but rebuilds the
 * page's structured text on every call (`mupdf.js:1771` → `runSearch`), so a search
 * per pattern per page is a text extraction per pattern per page. Measured on the
 * installed `mupdf@1.28.1` under Node against a pdf-lib fixture: the two entry points
 * return byte-identical `Quad[][]` (JSON-equal for two needles with two hits and one
 * hit respectively), which is why this module searches the text it already built.
 *
 * **The loop implemented.** Per page, with only the patterns that page's scope asks
 * for: build the structured text, take its plain text, prescan that text for every
 * pattern in scope, and search only for the substrings that are actually there (one
 * search per distinct substring). Cost, in the terms the prescan exists for: the
 * naive loop is `patterns × pages` engine searches, each rebuilding the page's text —
 * 2 000 pages with one rare pattern is 2 000 extractions for a handful of hits. This
 * loop is `pages` extractions plus one *in-memory* search per present pattern (plus
 * one per distinct matched substring for the regex form); when every pattern happens
 * to be present on every page it costs exactly one extra extraction per page over the
 * naive loop. That is the trade the feature is for: the bulk case — a list of specific
 * strings, most of them absent from most pages — pays a constant per page, and the
 * pathological all-present case pays one text build.
 *
 * **MuPDF's search is case-sensitive.** Measured: the needle `gizli-token-4711`
 * returns no hit against the text `GIZLI-TOKEN-4711`, the same needle in its own case
 * returns one, and `{}` is the only options object that does not throw (`Unused search
 * arguments found` for an unknown key; `runSearch` reads no option at all —
 * `mupdf.js:471`). `flags: 'i'` is therefore not an engine option: a case-insensitive
 * literal is compiled to an escaped, `i`-flagged regular expression and travels the
 * regex path, whose matched text is taken verbatim from the page text and searched
 * back. The `g` and `y` flags are dropped from a caller's `flags` (this module owns
 * its own `g`, and a sticky match is meaningless over a whole page) and the rest are
 * handed to `RegExp`, which rejects anything unknown.
 *
 * **A hit is a list of quads, never one quad** (`WORKLOG.md §4`, spike #4). `search`
 * returns `Quad[][]` — one inner array per hit, holding every quad the hit spans
 * (`mupdf.js:486-493` groups them from the mark array). Reading a hit as a single quad
 * gives `undefined` coordinates, `NaN` rectangles, and a redaction that then erases the
 * whole page; here every quad becomes its own rectangle, and a non-finite or empty one
 * is dropped rather than handed to the engine.
 *
 * The engine's own ceiling is 500 hits per call: `runSearch` allocates `max_hits = 500`
 * and no option raises it (`mupdf.js:472`; measured: a 600-occurrence page returns
 * exactly 500). `MAX_HITS_PER_PAGE` is the product's cap across a page's patterns, so a
 * page can only pass 500 through several patterns or several distinct substrings.
 *
 * The progress sentence (`op.progress.redact.find`) lives in
 * `packages/shared/src/i18n/parts/audit.ts`, which the integration owner folds into
 * `tr.ts`; the one `as MessageKey` below is that seam, not a second dictionary.
 */

import type { PDFDocument, PDFPage, Quad, StructuredText } from 'mupdf';
import { type MessageKey, ToolError } from 'pdf-shared';
import { loadMupdf, type Mupdf, mapMupdfError, openPdf, readPageBox } from '../engines/mupdf';
import type { RedactRect } from './redact';
import { type OperationContext, throwIfAborted } from './types';

export interface FindPattern {
  /** A JavaScript regular expression source; the engine matches it against page text. */
  readonly source: string;
  readonly flags?: string;
  readonly literal?: boolean;
  readonly pages?: readonly number[];
}

export interface PatternHit {
  readonly pageIndex: number;
  /** Unrotated page points, top-left origin — one rectangle per quad of the hit. */
  readonly rects: readonly (readonly [number, number, number, number])[];
  /** The matched text, trimmed to `MAX_HIT_TEXT` characters, for the mark list. */
  readonly text: string;
  /** Which pattern matched (index into the input list) — one search can carry several. */
  readonly patternIndex: number;
}

/** Rectangles one page may contribute; the engine caps a single search at 500 (`mupdf.js:472`). */
const MAX_HITS_PER_PAGE = 2000;
/** Rectangles one find run may produce, so a one-character pattern cannot fill the heap. */
const MAX_HITS = 20000;
/** Characters of matched text kept for the mark list — a label, not a copy of the page. */
const MAX_HIT_TEXT = 120;

/**
 * One pattern, compiled once per call. A case-sensitive literal is a needle the
 * engine can look for verbatim; everything else (a regular expression, or a literal
 * asked to ignore case) is matched against the page text, and its match text travels
 * back as the search needle.
 */
type CompiledPattern =
  | { readonly kind: 'needle'; readonly needle: string }
  | { readonly kind: 'regex'; readonly matcher: RegExp };

export async function findPatternMarks(
  bytes: Uint8Array,
  patterns: readonly FindPattern[],
  context: OperationContext,
): Promise<{ readonly hits: readonly PatternHit[]; readonly pagesSearched: number }> {
  throwIfAborted(context.signal);
  if (patterns.length === 0) return { hits: [], pagesSearched: 0 };

  const compiled = patterns.map((pattern, index) => compilePattern(pattern, index));
  const mupdf = await loadMupdf();
  throwIfAborted(context.signal);

  const doc = openPdf(mupdf, bytes);
  const hits: PatternHit[] = [];
  let pagesSearched = 0;
  try {
    const scope = pageScope(patterns, doc.countPages());
    const total = scope.size;
    for (const [pageIndex, indices] of scope) {
      throwIfAborted(context.signal);
      for (const hit of searchPage(mupdf, doc, pageIndex, compiled, indices)) {
        if (hits.length >= MAX_HITS) break;
        hits.push(hit);
      }
      pagesSearched += 1;
      context.onProgress?.({
        phase: 'find',
        // `parts/audit.ts` carries this sentence; the integration owner's merge into
        // `tr.ts` is what makes `MessageKey` name it — see the header.
        labelKey: 'op.progress.redact.find' as MessageKey,
        done: pagesSearched,
        total,
      });
      if (hits.length >= MAX_HITS) break;
    }
  } catch (error) {
    throw mapMupdfError(error, 'redact-find');
  } finally {
    doc.destroy();
  }
  throwIfAborted(context.signal);
  return { hits, pagesSearched };
}

/** One mark per hit rectangle; the pages are already ascending, so the marks are too. */
export function patternToMarks(hits: readonly PatternHit[], _color: string): readonly RedactRect[] {
  const marks: RedactRect[] = [];
  for (const hit of hits) {
    for (const rect of hit.rects) marks.push({ pageIndex: hit.pageIndex, space: 'app-v1', rect });
  }
  return marks;
}

/**
 * Stable identity for a mark (`p3:12.4,44.1,80.0,52.3`): the page, then the
 * rectangle rounded to a tenth of a point. The same find run and a re-run of it
 * produce the same key, so a mark list can be de-duplicated and re-applied without
 * comparing geometry with a tolerance.
 */
export function markKey(mark: RedactRect): string {
  const [x0, y0, x1, y1] = mark.rect;
  return `p${mark.pageIndex}:${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)},${y1.toFixed(1)}`;
}

/** First occurrence of each mark, in input order. */
export function uniqueMarks(marks: readonly RedactRect[]): readonly RedactRect[] {
  const seen = new Set<string>();
  const kept: RedactRect[] = [];
  for (const mark of marks) {
    const key = markKey(mark);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(mark);
  }
  return kept;
}

/**
 * Both lists as one, de-duplicated, ascending by page and then by rectangle. The
 * union is ordered *before* the de-duplication on purpose: keeping the first
 * occurrence then leaves one array, sorted, without a second pass.
 */
export function mergeMarks(a: readonly RedactRect[], b: readonly RedactRect[]): readonly RedactRect[] {
  const union = [...a, ...b];
  union.sort((left, right) => left.pageIndex - right.pageIndex || compareRects(left.rect, right.rect));
  return uniqueMarks(union);
}

function compareRects(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number],
): number {
  for (let index = 0; index < 4; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** `patterns` as the engine will run them; a broken pattern fails before any page loads. */
function compilePattern(pattern: FindPattern, index: number): CompiledPattern {
  if (pattern.source.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: `pattern ${index} has an empty source`,
    });
  }
  const flags = (pattern.flags ?? '').replace(/[gy]/g, '');
  if (pattern.literal === true && !flags.includes('i')) {
    return { kind: 'needle', needle: pattern.source };
  }
  // A literal is an escape hatch, not a pattern: every character of the source is
  // taken as itself (the standard escape set, which is also what a user typing a
  // full stop means).
  const source =
    pattern.literal === true ? pattern.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern.source;
  try {
    return { kind: 'regex', matcher: new RegExp(source, `${flags}g`) };
  } catch (error) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `pattern ${index} is not a valid regular expression: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

/**
 * `pageIndex -> patterns to run there`, ascending by page so the wasm pages load in
 * order (`ops/redact.ts` keeps the same rule). A pattern without `pages` puts every
 * page in scope; a pattern with an empty `pages` list is never searched. A page no
 * pattern asks for is never loaded, and a page index outside the document is a
 * caller bug, not a silent skip.
 */
function pageScope(patterns: readonly FindPattern[], pageCount: number): Map<number, readonly number[]> {
  const sets = patterns.map((pattern) => (pattern.pages === undefined ? null : new Set(pattern.pages)));
  const requested = new Set<number>();
  for (const [index, set] of sets.entries()) {
    if (set === null) continue;
    for (const pageIndex of set) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
        throw new ToolError('range-invalid', {
          engine: 'mupdf',
          pageIndex,
          engineMessage: `pattern ${index} asks for page ${pageIndex} of ${pageCount}`,
        });
      }
      requested.add(pageIndex);
    }
  }
  const everyPage = sets.some((set) => set === null);
  const pages = everyPage
    ? Array.from({ length: pageCount }, (_, pageIndex) => pageIndex)
    : [...requested].sort((left, right) => left - right);

  const scope = new Map<number, readonly number[]>();
  for (const pageIndex of pages) {
    scope.set(
      pageIndex,
      patterns.flatMap((_, index) => {
        const set = sets[index];
        return set === null || set === undefined || set.has(pageIndex) ? [index] : [];
      }),
    );
  }
  return scope;
}

/**
 * One page's hits. The structured text is built once and destroyed here; the page
 * text is asked for once and reused by every pattern's prescan.
 */
function searchPage(
  mupdf: Mupdf,
  doc: PDFDocument,
  pageIndex: number,
  patterns: readonly CompiledPattern[],
  indices: readonly number[],
): PatternHit[] {
  const hits: PatternHit[] = [];
  let page: PDFPage | null = null;
  let text: StructuredText | null = null;
  try {
    page = doc.loadPage(pageIndex);
    const inverse = mupdf.Matrix.invert(page.getTransform());
    const box = readPageBox(page);
    const top = box.y + box.height;
    text = page.toStructuredText('preserve-whitespace');
    const plain = text.asText();
    for (const patternIndex of indices) {
      if (hits.length >= MAX_HITS_PER_PAGE) break;
      const pattern = patterns[patternIndex];
      if (pattern === undefined) continue;
      for (const query of queriesOf(pattern, plain)) {
        for (const hit of text.search(query, {})) {
          if (hits.length >= MAX_HITS_PER_PAGE) break;
          // Search quads already include CropBox and /Rotate. Undo MuPDF's
          // transform, then use the same top-origin contract as manual marks.
          const rects = hitRects(hit).map((rect) => {
            const user = mupdf.Rect.transform([...rect], inverse);
            return [user[0], top - user[3], user[2], top - user[1]] as const;
          });
          if (rects.length === 0) continue;
          hits.push({ pageIndex, rects, text: query.slice(0, MAX_HIT_TEXT), patternIndex });
        }
        if (hits.length >= MAX_HITS_PER_PAGE) break;
      }
    }
    return hits;
  } finally {
    text?.destroy();
    page?.destroy();
  }
}

/**
 * The substrings to search on this page, and the prescan that keeps an absent pattern
 * from costing an engine search. A needle is searched verbatim; a matcher runs over
 * the page text and hands back its own match text — a substring of that text by
 * construction, which is what makes searching it back exact. Duplicates are dropped,
 * because several matches of one pattern are one query.
 */
function queriesOf(pattern: CompiledPattern, plain: string): readonly string[] {
  if (pattern.kind === 'needle') {
    return plain.includes(pattern.needle) ? [pattern.needle] : [];
  }
  const queries = new Set<string>();
  for (const match of plain.matchAll(pattern.matcher)) {
    if (match[0].length > 0) queries.add(match[0]);
  }
  return [...queries];
}

/** A hit's quads as mark rectangles: each quad's four points, in ascending order. */
function hitRects(quads: readonly Quad[]): Array<readonly [number, number, number, number]> {
  const rects: Array<readonly [number, number, number, number]> = [];
  for (const quad of quads) {
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
    // The measured failure mode is a hit read as one quad: its coordinates are
    // `undefined`, the rectangle is `NaN`, and MuPDF treats it as the whole page.
    // Nothing non-finite or empty reaches the engine from here.
    if (!Number.isFinite(rect[0] + rect[1] + rect[2] + rect[3])) continue;
    if (rect[2] <= rect[0] || rect[3] <= rect[1]) continue;
    rects.push(rect);
  }
  return rects;
}
