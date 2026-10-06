/**
 * Reading-mode text shaping (`PLAN.md §5/Phase 1`, reading mode + voice) — the pure
 * half of the reading pane: engine text runs become reading-order blocks, and page
 * text becomes the utterance chunks the speech queue speaks.
 *
 * Scope: **block-local** (`K13`, step 4d-1). Lines are grouped by baseline proximity
 * in PDF user space (`y` grows upwards, so the result does not depend on page
 * rotation) and blocks are separated by vertical gaps. There is no page-flow or
 * overflow handling and no column detection: a multi-column page therefore reads its
 * columns line by line, left to right — that is the out-of-scope research line
 * (`PLAN.md §9`, 4d-2), not a defect here.
 *
 * This module is DOM-free and engine-free (plain numbers in, blocks out), so it can
 * move to `packages/pdf-core` with its caller without a rewrite; it lives in
 * `packages/pdf-ui/src/reading/` only because this slice may not touch `pdf-core`.
 */

/** How the reading column presents a block. */
export type ReadingBlockKind = 'heading' | 'paragraph' | 'list-item' | 'caption';

export interface ReadingBlock {
  readonly kind: ReadingBlockKind;
  readonly text: string;
}

/**
 * One text run, already narrowed to numbers this module can trust.
 * Coordinates are PDF user space: `y` upwards, origin bottom-left.
 */
export interface ReadingTextItem {
  readonly text: string;
  /** Baseline origin. */
  readonly x: number;
  readonly y: number;
  /** Advance length along the baseline. */
  readonly width: number;
  /** Em size of the run. */
  readonly size: number;
  /** Baseline direction, unit vector. */
  readonly dx: number;
  readonly dy: number;
}

/**
 * The pdf.js `TextItem` fields read here. pdf.js declares `transform` as `any[]`, so
 * the values are re-checked in {@link toReadingTextItem} instead of being trusted by
 * the type: a non-finite coordinate would poison every sort and median below.
 */
export interface EngineTextRun {
  readonly str: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
}

/*
 * Reflow constants. They are named and justified rather than fitted to a sample: each
 * one is the boundary between two layout facts, so changing one should come with a
 * page that exercises that boundary.
 */

/**
 * Runs share a line while their baselines differ by less than this share of the local
 * em: a superscript sits around 0.33 em off its baseline and belongs to the line, the
 * next line of normal text is at least a full em away.
 */
const LINE_BAND = 0.6;

/**
 * A gap above this share of the local em is a word boundary. A real space advance is
 * 0.25–0.33 em, an intra-word split (pdf.js breaking a word at a kerning pair) is
 * below 0.05 em; 0.2 separates the two without inventing or losing a space.
 */
const WORD_GAP = 0.2;

/**
 * A line starts a new block when its baseline distance to the previous line is more
 * than this multiple of the page's median leading — paragraph leading is ≈1.2 em,
 * paragraph spacing ≈2 em, so 1.4 sits between the two. On a page with no leading to
 * speak of the page's median em is used instead, so evenly spaced floats still split.
 */
const BLOCK_GAP = 1.4;

/** A block keeps one typographic size: a line this much larger or smaller starts a new one. */
const SIZE_BREAK = 1.2;

/** A block is a heading when it is at least this much larger than the page's median em… */
const HEADING_SIZE_RATIO = 1.15;
/** …and short: at most two lines and this many characters. */
const HEADING_MAX_LINES = 2;
const HEADING_MAX_CHARS = 80;

/** A short block set this far below the page's median em is caption-sized (figure, table, footnote). */
const CAPTION_SIZE_RATIO = 0.9;
const CAPTION_MAX_CHARS = 160;

/** Bullets and enumerators that make a block a list item (`•`, `1.`, `a)`). */
const LIST_MARKER = /^(?:[•▪◦‣·*–—-]|\d{1,3}[.)]|[A-Za-zÇĞİÖŞÜçğıöşü][.)])\s/u;

/** A line ending in one of these is a word break, not punctuation. */
const TRAILING_HYPHEN = /[-‐]$/u;
const STARTS_LOWERCASE = /^\p{Ll}/u;

/** A run placed on its line: `perp` is across the baseline, `along` is along it. */
interface PlacedRun {
  readonly text: string;
  readonly perp: number;
  readonly along: number;
  /** End of the run, along the baseline. */
  readonly end: number;
  readonly size: number;
}

interface ReadingLine {
  /** Baseline position of the line's first run. */
  readonly perp: number;
  /** Largest em on the line — the band a run may deviate from the baseline. */
  maxSize: number;
  readonly runs: PlacedRun[];
}

/**
 * Engine run → placed run. `null` for a run without text (pdf.js emits bare space
 * runs) or with a matrix this module cannot use.
 */
export function toReadingTextItem(run: EngineTextRun): ReadingTextItem | null {
  const text = run.str.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;

  const matrix = run.transform;
  const a = matrix[0];
  const b = matrix[1];
  const c = matrix[2];
  const d = matrix[3];
  const x = matrix[4];
  const y = matrix[5];
  if (a === undefined || b === undefined || x === undefined || y === undefined) return null;
  if (![a, b, x, y].every(Number.isFinite)) return null;
  if (!Number.isFinite(run.width) || !Number.isFinite(run.height)) return null;

  const scale = Math.hypot(a, b);
  if (scale === 0) return null;
  // `height` is the text matrix's vertical scale, i.e. the em in user units; the
  // shorter matrix axis is the fallback for the rare run that reports no height.
  const size = run.height > 0 ? run.height : Math.hypot(c ?? 0, d ?? 0);
  if (size <= 0) return null;

  return {
    text,
    x,
    y,
    width: Math.abs(run.width),
    size,
    dx: a / scale,
    dy: b / scale,
  };
}

/** Groups runs into lines: top to bottom, left to right within a line. */
function buildLines(items: readonly ReadingTextItem[]): ReadingLine[] {
  // Projected onto the baseline axes described on `PlacedRun`: `dx/dy` is the run's
  // own baseline direction, so rotated runs land in the same coordinate system as
  // horizontal ones instead of breaking the grouping below.
  const placed = items
    .map((item: ReadingTextItem): PlacedRun => {
      const along = item.dx * item.x + item.dy * item.y;
      return {
        text: item.text,
        perp: item.dx * item.y - item.dy * item.x,
        along,
        end: along + item.width,
        size: item.size,
      };
    })
    .sort((left, right) => right.perp - left.perp || left.along - right.along);
  const lines: ReadingLine[] = [];
  for (const run of placed) {
    const line = lines[lines.length - 1];
    if (line !== undefined && line.perp - run.perp <= LINE_BAND * Math.max(line.maxSize, run.size)) {
      line.runs.push(run);
      line.maxSize = Math.max(line.maxSize, run.size);
      continue;
    }
    lines.push({ perp: run.perp, maxSize: run.size, runs: [run] });
  }
  return lines;
}

/** Joins the runs of one line; the gap test decides where a space belongs. */
function lineText(runs: readonly PlacedRun[]): string {
  const ordered = [...runs].sort((left, right) => left.along - right.along);
  let text = '';
  let end = 0;
  let size = 0;
  for (const run of ordered) {
    if (text.length > 0 && run.along - end > WORD_GAP * Math.max(size, run.size)) text += ' ';
    text += run.text;
    end = run.end;
    size = run.size;
  }
  return text;
}

/** Joins the lines of one block. */
function blockText(lines: readonly ReadingLine[]): string {
  let text = '';
  for (const line of lines) {
    const piece = lineText(line.runs);
    if (piece.length === 0) continue;
    if (text.length === 0) {
      text = piece;
      continue;
    }
    // A trailing hyphen is a word break, not punctuation — "keli-" + "me" reflows
    // back to "kelime". A capital after the hyphen keeps its space (compound name).
    if (TRAILING_HYPHEN.test(text) && STARTS_LOWERCASE.test(piece)) text = `${text.slice(0, -1)}${piece}`;
    else text = `${text} ${piece}`;
  }
  return text;
}

function classify(text: string, size: number, lineCount: number, pageSize: number): ReadingBlockKind {
  if (
    size >= pageSize * HEADING_SIZE_RATIO &&
    lineCount <= HEADING_MAX_LINES &&
    text.length <= HEADING_MAX_CHARS
  ) {
    return 'heading';
  }
  if (LIST_MARKER.test(text)) return 'list-item';
  if (size <= pageSize * CAPTION_SIZE_RATIO && text.length <= CAPTION_MAX_CHARS) return 'caption';
  return 'paragraph';
}

/** Median of a list; 0 for an empty one (a one-line page has no spread to measure). */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? upper) + upper) / 2;
}

/** Baseline distances between consecutive lines. */
function leadingDistances(lines: readonly ReadingLine[]): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (previous === undefined || current === undefined) continue;
    gaps.push(previous.perp - current.perp);
  }
  return gaps;
}

/**
 * Engine text runs → reading-order blocks, top of the page first.
 *
 * Deterministic: the same runs always produce the same blocks — runs are sorted by
 * geometry, blocks break on measured gaps, and no threshold is fitted at runtime.
 */
export function buildReadingBlocks(items: readonly ReadingTextItem[]): ReadingBlock[] {
  const lines = buildLines(items);
  if (lines.length === 0) return [];

  const sizes = lines.map((line) => median(line.runs.map((run) => run.size)));
  const pageSize = median(sizes);
  const leading = median(leadingDistances(lines));
  // Both yardsticks have to agree that a gap is large: the page's own leading (a
  // loosely set page breaks less often) and the page's em (a page with uniform
  // spacing, where the median leading is the gap itself, still separates blocks).
  const breakAt = BLOCK_GAP * Math.max(leading, pageSize);

  const blocks: ReadingBlock[] = [];
  let current: ReadingLine[] = [];
  let previous: ReadingLine | null = null;
  let previousSize = 0;
  for (const line of lines) {
    const size = median(line.runs.map((run) => run.size));
    const gap = previous === null ? 0 : previous.perp - line.perp;
    const sizeJump = Math.max(size, previousSize) / Math.max(Math.min(size, previousSize), Number.MIN_VALUE);
    const breaks = previous !== null && (gap > breakAt || sizeJump > SIZE_BREAK);
    if (breaks) {
      blocks.push(toBlock(current, pageSize));
      current = [];
    }
    current.push(line);
    previous = line;
    previousSize = size;
  }
  if (current.length > 0) blocks.push(toBlock(current, pageSize));
  return blocks;
}

function toBlock(lines: readonly ReadingLine[], pageSize: number): ReadingBlock {
  const text = blockText(lines);
  const size = median(lines.map((line) => median(line.runs.map((run) => run.size))));
  return { kind: classify(text, size, lines.length, pageSize), text };
}

/**
 * Sentences up to this length are queued as one utterance.
 *
 * Web Speech synthesises an utterance before it starts speaking it, so a page-long
 * utterance delays the first sound and runs into the platform's utterance-length
 * cut-off; splitting at sentence boundaries starts the reading immediately and keeps
 * every utterance inside the reliable range (180 characters is ≈12 s at rate 1).
 */
const MAX_UTTERANCE_CHARS = 180;

/** A sentence ends at terminal punctuation followed by whitespace. */
const SENTENCE_BREAK = /(?<=[.!?…:;])\s+/u;

/** Cut points preferred over a plain word break when a sentence is too long. */
const CLAUSE_CHARS = ',;:.)';

/** Finds a cut point at or before the utterance limit, preferring a clause end. */
function findCut(text: string): number {
  const limit = Math.min(text.length - 1, MAX_UTTERANCE_CHARS);
  for (let index = limit; index > 0; index -= 1) {
    if (CLAUSE_CHARS.includes(text.charAt(index)) && text.charAt(index + 1) === ' ') return index + 1;
  }
  const space = text.lastIndexOf(' ', Math.min(text.length, MAX_UTTERANCE_CHARS));
  return space > 0 ? space : Math.max(1, Math.min(text.length, MAX_UTTERANCE_CHARS));
}

function pushChunks(sentence: string, out: string[]): void {
  let remaining = sentence.trim();
  while (remaining.length > MAX_UTTERANCE_CHARS) {
    const cut = findCut(remaining);
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) out.push(remaining);
}

/**
 * Page text → utterance chunks, in reading order. Empty text produces no utterances,
 * which is what tells the caller that there is nothing to speak (`reading.empty`).
 */
export function splitUtterances(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return [];
  const utterances: string[] = [];
  for (const sentence of normalized.split(SENTENCE_BREAK)) {
    pushChunks(sentence, utterances);
  }
  return utterances;
}
