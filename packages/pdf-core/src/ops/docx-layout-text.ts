/**
 * The text of a page for the "exact layout" Word export: MuPDF's lines grouped into
 * paragraphs and text boxes (`textBoxes`), and a text box written as a floating Word text box
 * (`textBoxXml`) that keeps the text where the PDF has it.
 *
 * ## Grouping
 *
 * 1. A line is MuPDF's (the characters on one baseline); lines of nothing but whitespace are
 *    dropped. A line MuPDF reports as running vertically (its direction, which holds for a
 *    single character too) is rotated text and is a box of its own (rotation 90 or 270),
 *    written as a vertical text box (`vert="vert"` / `"vert270"`: LibreOffice ignores `rot`).
 * 2. Consecutive lines (across MuPDF's blocks, see `textBoxes`) are one paragraph while their font size agrees
 *    (±1 pt), their baseline pitch is regular (0.5…1.6 × size, ±15 % of the paragraph's pitch)
 *    and the alignment stays consistent: left edges, centres or right edges all agree (2 pt)
 *    with the paragraph's first line. A bullet (•, ▪, "- ", "1. " …) starts a new paragraph.
 * 3. A paragraph is centred, right, justified (≥ 2 full-width lines, the last one shorter) or
 *    left from those same edges.
 * 4. Paragraphs that stack with the baseline gap Word's exact line spacing would
 *    produce, and share an edge (left, centre or right), form one box; anything else is a box
 *    of its own, so spacing between paragraphs is never invented.
 */

import { EMU, TWIPS, xml, xmlSafe } from './docx-drawing';
import { wordFontName } from './export-office';
import type { DocxRegistry, SceneLink, TextBox, TextLine, TextParagraph, TextRun } from './layout-scene';
import type { LayoutChar, LayoutLine, PageLayout } from './page-layout';

/* ------------------------------------------------------------------ *
 * calibration
 * ------------------------------------------------------------------ */

/**
 * How far below a line's top its baseline sits when the paragraph has `w:lineRule="exact"`:
 * Word and LibreOffice put the glyphs of an exact line with the baseline at about four
 * fifths of the line's height (Noto and Arial-like fonts). The one number to tune if the
 * text renders too high or too low.
 */
const BASELINE_IN_LINE = 0.8;

/**
 * Where a text box's top edge goes so that a first line of height `lineHeight` has its
 * baseline on the PDF's `baseline` (page space, y down).
 */
function boxTop(baseline: number, lineHeight: number): number {
  return baseline - BASELINE_IN_LINE * lineHeight;
}

/**
 * MuPDF's character boxes reach from the font's ascent to its descent; for rotated text, whose
 * origin is not read, the baseline is this fraction of the size inside the box's far side
 * (0.27…0.32 for the fonts looked at). Upright text has its origin (`LayoutChar.baseline`).
 */
const DESCENT = 0.3;

/** A single line's height is at least this × size (Word's natural line is about that). */
const MIN_LINE = 1.15;

/**
 * Width slack: a substitute font with wider metrics must not overflow. `wrap="none"` is
 * also set, but LibreOffice wraps a line that is wider than its frame all the same, and the
 * second line is cut off by the frame's height (measured: a page lost 11 % of its words).
 */
const WIDTH_FACTOR = 1.03;
const WIDTH_PAD = 2;
/**
 * A justified line fills its box, so the box is the PDF's own width, plus what the line's
 * squeezed spaces need: typesetters set a tight line with its spaces below the natural
 * `SPACE` × size, and a line whose natural width passes the frame wraps (see above).
 */
const SPACE = 0.278;

/** What a squeezed line's frame needs beyond that, for a substitute font a little wider than the PDF's. */
const SQUEEZE_MARGIN = 1.015;

/** The box width ÷ the lines' extent for a justified box: 1 unless a line is squeezed. */
function justifiedFactor(rows: readonly Row[]): number {
  const worst = Math.max(...rows.map((row) => row.natural));
  return worst > 1 ? worst * SQUEEZE_MARGIN : 1;
}

/* ------------------------------------------------------------------ *
 * lines
 * ------------------------------------------------------------------ */

type Direction = 'right' | 'down' | 'up';

interface Row {
  readonly runs: readonly TextRun[];
  readonly text: string;
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly size: number;
  readonly baseline: number;
  readonly bullet: boolean;
  readonly direction: Direction;
  /** The line's width with its spaces at their natural width ÷ its width: above 1 for a squeezed line. */
  readonly natural: number;
}

const BULLET = /^(?:[•▪◦‣●○■□·*]|[-–—]\s|\d{1,3}[.)](?:\s|$))/;

const isSpace = (char: LayoutChar): boolean => char.c.trim() === '';

/** The link whose box holds the character's centre. */
function linkOf(char: LayoutChar, links: readonly SceneLink[]): string | null {
  const cx = (char.box[0] + char.box[2]) / 2;
  const cy = (char.box[1] + char.box[3]) / 2;
  for (const link of links) {
    if (cx >= link.box[0] && cx <= link.box[2] && cy >= link.box[1] && cy <= link.box[3]) return link.uri;
  }
  return null;
}

/** The size most of the characters have (to 0.5 pt); the larger on a tie. */
function dominantSize(chars: readonly LayoutChar[]): number {
  const counts = new Map<number, number>();
  for (const char of chars) {
    const key = Math.round(char.size * 2) / 2;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = chars[0]?.size ?? 0;
  let bestCount = 0;
  for (const [size, count] of counts) {
    if (count > bestCount || (count === bestCount && size > best)) {
      best = size;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Whether the line runs down or up the page rather than across it, by MuPDF's direction of
 * the line (which is right for a single character too, where no two positions compare).
 * Text turned less than about 25° from the vertical counts as running down or up.
 */
function directionOf(line: LayoutLine): Direction {
  const [, y] = line.dir;
  if (Math.abs(y) < 0.9) return 'right';
  return y > 0 ? 'down' : 'up';
}

/** The gap between two consecutive characters along the line's direction. */
function gapBetween(previous: LayoutChar, char: LayoutChar, direction: Direction): number {
  if (direction === 'down') return char.box[1] - previous.box[3];
  if (direction === 'up') return previous.box[1] - char.box[3];
  return char.box[0] - previous.box[2];
}

/**
 * The families a page mostly sets in serif faces, by the characters' flags: the flag is read
 * from each style's own font descriptor and a family's bold may disagree with its regular, so
 * the family is judged as a whole.
 */
function serifFamilies(layout: PageLayout): ReadonlySet<string> {
  const votes = new Map<string, number>();
  for (const block of layout.blocks) {
    if (block.kind !== 'text') continue;
    for (const line of block.lines) {
      for (const char of line.chars)
        votes.set(char.font, (votes.get(char.font) ?? 0) + (char.serif ? 1 : -1));
    }
  }
  return new Set([...votes].filter(([, vote]) => vote > 0).map(([family]) => family));
}

/** Runs of a line: split on font, size (0.5 pt), weight, slant, colour and link. */
function runsOf(
  chars: readonly LayoutChar[],
  links: readonly SceneLink[],
  direction: Direction,
  serifs: ReadonlySet<string>,
): TextRun[] {
  // Characters with a space between words where the PDF has none but a gap.
  const items: { c: string; source: LayoutChar; link: string | null; space: boolean }[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index] as LayoutChar;
    const link = linkOf(char, links);
    const previous = items[items.length - 1];
    if (isSpace(char)) {
      if (previous !== undefined && !previous.space) {
        items.push({ c: ' ', source: previous.source, link: previous.link, space: true });
      }
      continue;
    }
    if (previous !== undefined && !previous.space) {
      const before = chars[index - 1];
      if (before !== undefined && gapBetween(before, char, direction) > 0.25 * before.size) {
        items.push({ c: ' ', source: previous.source, link: previous.link, space: true });
      }
    }
    items.push({ c: char.c, source: char, link, space: false });
  }
  // A space belongs to a link only when both its neighbours do.
  for (let at = 0; at < items.length; at += 1) {
    const item = items[at] as (typeof items)[number];
    if (!item.space) continue;
    const next = items[at + 1];
    if (next === undefined || next.link !== item.link) item.link = null;
  }
  while (items.length > 0 && (items[items.length - 1] as (typeof items)[number]).space) items.pop();

  const runs: TextRun[] = [];
  for (const item of items) {
    const font = wordFontName(item.source.font, {
      serif: serifs.has(item.source.font),
      mono: item.source.mono,
    });
    const last = runs[runs.length - 1];
    if (
      last !== undefined &&
      last.font === font &&
      Math.abs(last.size - item.source.size) < 0.5 &&
      last.bold === item.source.bold &&
      last.italic === item.source.italic &&
      last.color === item.source.color &&
      last.link === item.link
    ) {
      runs[runs.length - 1] = { ...last, text: last.text + item.c };
    } else {
      runs.push({
        text: item.c,
        font,
        size: item.source.size,
        bold: item.source.bold,
        italic: item.source.italic,
        color: item.source.color,
        link: item.link,
      });
    }
  }
  return runs;
}

/** A line as a row, or `null` when it holds nothing but whitespace. */
function rowOf(line: LayoutLine, links: readonly SceneLink[], serifs: ReadonlySet<string>): Row | null {
  const solid = line.chars.filter((char) => !isSpace(char));
  if (solid.length === 0) return null;
  const first = line.chars.indexOf(solid[0] as LayoutChar);
  const last = line.chars.lastIndexOf(solid[solid.length - 1] as LayoutChar);
  const chars = line.chars.slice(first, last + 1);
  const direction = directionOf(line);
  const runs = runsOf(chars, links, direction, serifs);
  const text = runs.map((run) => run.text).join('');
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const char of solid) {
    x0 = Math.min(x0, char.box[0]);
    y0 = Math.min(y0, char.box[1]);
    x1 = Math.max(x1, char.box[2]);
    y1 = Math.max(y1, char.box[3]);
  }
  const size = dominantSize(solid);
  const sample = solid.find((char) => Math.round(char.size * 2) / 2 === Math.round(size * 2) / 2) ?? solid[0];
  // The origin is the baseline of upright text; a rotated line's is across, set by `rotated`.
  const baseline = (sample as LayoutChar).baseline;
  const glyphs = solid.reduce((sum, char) => sum + char.box[2] - char.box[0], 0);
  const spaces = text.split(' ').length - 1;
  const natural = direction === 'right' ? (glyphs + spaces * SPACE * size) / (x1 - x0) : 1;
  return { runs, text, x0, x1, y0, y1, size, baseline, bullet: BULLET.test(text), direction, natural };
}

/**
 * MuPDF cuts a justified line whose words are stretched far apart into one "line" per piece
 * (the pieces of a block read left to right on one baseline). They are one line again when the
 * gaps between the pieces are all the same (justification stretches every gap alike) and the
 * last piece reaches the right edge of the block's other lines, or, for a single gap, when the
 * pieces span those lines from edge to edge. Pieces that are columns of a row (unequal gaps),
 * or a block with no other line to measure against (a footer's two ends), stay apart.
 */
function joinPieces(lines: readonly LayoutLine[]): LayoutLine[] {
  const extent = (item: LayoutLine) => {
    const solid = item.chars.filter((char) => !isSpace(char));
    return {
      x0: Math.min(...solid.map((char) => char.box[0])),
      x1: Math.max(...solid.map((char) => char.box[2])),
    };
  };
  const filled = lines.filter((item) => item.chars.some((char) => !isSpace(char)));
  const out: LayoutLine[] = [];
  let at = 0;
  while (at < lines.length) {
    const first = lines[at] as LayoutLine;
    const pieces = [first];
    if (filled.includes(first) && directionOf(first) === 'right') {
      let end = at + 1;
      while (end < lines.length) {
        const next = lines[end] as LayoutLine;
        const last = pieces[pieces.length - 1] as LayoutLine;
        const sameBaseline =
          filled.includes(next) &&
          directionOf(next) === 'right' &&
          Math.abs(next.box[1] - first.box[1]) <= 1 &&
          Math.abs(next.box[3] - first.box[3]) <= 1 &&
          extent(next).x0 > extent(last).x1;
        if (!sameBaseline) break;
        pieces.push(next);
        end += 1;
      }
    }
    const others = filled.filter((item) => !pieces.includes(item));
    const left = Math.min(...others.map((item) => extent(item).x0));
    const right = Math.max(...others.map((item) => extent(item).x1));
    const gaps = pieces
      .slice(1)
      .map((piece, index) => extent(piece).x0 - extent(pieces[index] as LayoutLine).x1);
    const even = gaps.every((gap) => Math.abs(gap - (gaps[0] as number)) <= 1.5);
    const reachesRight = extent(pieces[pieces.length - 1] as LayoutLine).x1 >= right - 2.5;
    const spans = reachesRight && extent(first).x0 <= left + 2;
    if (pieces.length > 1 && others.length > 0 && even && (gaps.length > 1 ? reachesRight : spans)) {
      out.push({
        box: [
          Math.min(...pieces.map((piece) => piece.box[0])),
          Math.min(...pieces.map((piece) => piece.box[1])),
          Math.max(...pieces.map((piece) => piece.box[2])),
          Math.max(...pieces.map((piece) => piece.box[3])),
        ],
        dir: first.dir,
        chars: pieces.flatMap((piece) => piece.chars),
      });
      at += pieces.length;
    } else {
      out.push(first);
      at += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * paragraphs
 * ------------------------------------------------------------------ */

type Align = TextParagraph['align'];

interface Para {
  readonly rows: readonly Row[];
  align: Align;
  lineHeight: number;
  /** The line height is the measured pitch (or was solved to fit a neighbour), not a guess. */
  fixed: boolean;
}

/** Lines of one paragraph so far, and which alignments they still agree with. */
interface Pending {
  readonly rows: Row[];
  left: boolean;
  center: boolean;
  right: boolean;
}

const EDGE = 2;

/** Whether `row` carries on the paragraph; updates the alignments it still agrees with. */
function continues(pending: Pending, row: Row): boolean {
  const first = pending.rows[0] as Row;
  const last = pending.rows[pending.rows.length - 1] as Row;
  if (row.bullet || Math.abs(row.size - last.size) > 1) return false;
  const pitch = row.baseline - last.baseline;
  if (pitch < 0.5 * last.size || pitch > 1.6 * last.size) return false;
  if (pending.rows.length >= 2) {
    const mean = (last.baseline - first.baseline) / (pending.rows.length - 1);
    if (Math.abs(pitch - mean) > 0.15 * mean) return false;
  }
  const left = pending.left && Math.abs(row.x0 - first.x0) <= EDGE;
  const center = pending.center && Math.abs((row.x0 + row.x1) / 2 - (first.x0 + first.x1) / 2) <= EDGE;
  const right = pending.right && Math.abs(row.x1 - first.x1) <= EDGE;
  if (!left && !center && !right) return false;
  pending.left = left;
  pending.center = center;
  pending.right = right;
  return true;
}

/** Centre, right, justified or left, from the edges of the lines. */
function alignmentOf(rows: readonly Row[], pageWidth: number): Align {
  if (rows.length === 1) {
    const row = rows[0] as Row;
    const centred = Math.abs((row.x0 + row.x1) / 2 - pageWidth / 2) <= 1.5;
    return centred && row.x0 > pageWidth * 0.1 && row.x1 - row.x0 < pageWidth * 0.8 ? 'center' : 'left';
  }
  const left = Math.min(...rows.map((row) => row.x0));
  const right = Math.max(...rows.map((row) => row.x1));
  const last = rows[rows.length - 1] as Row;
  const full = rows.filter((row) => Math.abs(row.x0 - left) <= 1.5 && Math.abs(row.x1 - right) <= 1.5);
  // Every line the full width, the last too, is a justified paragraph that goes on (a column's
  // end, a page's); two lines are not enough to tell it from a ragged pair.
  const lastFull = last.x1 >= right - 1.5;
  if (full.length >= (lastFull ? 3 : 2)) return 'both';
  const leftSpread = Math.max(...rows.map((row) => row.x0)) - left;
  const middle = ((rows[0] as Row).x0 + (rows[0] as Row).x1) / 2;
  if (leftSpread > 1.5 && rows.every((row) => Math.abs((row.x0 + row.x1) / 2 - middle) <= EDGE))
    return 'center';
  if (leftSpread > 1.5 && rows.every((row) => Math.abs(row.x1 - right) <= 1.5)) return 'right';
  return 'left';
}

function paragraphOf(rows: readonly Row[], pageWidth: number): Para {
  const first = rows[0] as Row;
  if (rows.length === 1) {
    return {
      rows,
      align: alignmentOf(rows, pageWidth),
      lineHeight: Math.max(MIN_LINE * first.size, first.y1 - first.y0),
      fixed: false,
    };
  }
  const pitch = ((rows[rows.length - 1] as Row).baseline - first.baseline) / (rows.length - 1);
  return { rows, align: alignmentOf(rows, pageWidth), lineHeight: pitch, fixed: true };
}

const paragraphLeft = (para: Para) => Math.min(...para.rows.map((row) => row.x0));
const paragraphRight = (para: Para) => Math.max(...para.rows.map((row) => row.x1));
const classOf = (align: Align) => (align === 'both' ? 'left' : align);

/**
 * Adds `next` under the box's last paragraph when Word's exact spacing puts it where the PDF
 * has it: the baseline of a line follows the previous one by
 * `(1 − F) × previous line height + F × its own` with F = `BASELINE_IN_LINE`. A paragraph of
 * one line has no measured pitch of its own; its line height is solved from the gap.
 */
function stack(group: Para[], next: Para): boolean {
  const first = group[0] as Para;
  const previous = group[group.length - 1] as Para;
  const nextFirst = next.rows[0] as Row;
  const gap = nextFirst.baseline - (previous.rows[previous.rows.length - 1] as Row).baseline;
  if (gap <= 0) return false;

  // The same edge: left edges, centres or right edges, whichever the box is aligned by.
  const kind = classOf(first.align);
  const near = (a: number, b: number) => Math.abs(a - b) <= EDGE;
  const nextClass = next.rows.length === 1 ? kind : classOf(next.align);
  if (nextClass !== kind) return false;
  const edgeOk =
    kind === 'left'
      ? near(paragraphLeft(next), paragraphLeft(first))
      : kind === 'center'
        ? near(
            (paragraphLeft(next) + paragraphRight(next)) / 2,
            (paragraphLeft(first) + paragraphRight(first)) / 2,
          )
        : near(paragraphRight(next), paragraphRight(first));
  if (!edgeOk) return false;

  const within = (lineHeight: number, size: number) => lineHeight >= size && lineHeight <= 1.6 * size;
  const F = BASELINE_IN_LINE;
  let previousHeight = previous.lineHeight;
  let nextHeight = next.lineHeight;
  if (!previous.fixed) {
    if (next.fixed) {
      // A paragraph that goes on at its own pitch: the single line before it shares that pitch.
      previousHeight = next.lineHeight;
      if (!within(previousHeight, previous.rows[0]?.size ?? 0)) return false;
    } else {
      previousHeight = gap;
      nextHeight = gap;
      if (!within(gap, previous.rows[0]?.size ?? 0) || !within(gap, nextFirst.size)) return false;
    }
  } else if (!next.fixed) {
    nextHeight = (gap - (1 - F) * previousHeight) / F;
    if (!within(nextHeight, nextFirst.size)) return false;
  }
  if (Math.abs(gap - ((1 - F) * previousHeight + F * nextHeight)) > 1) return false;

  previous.lineHeight = previousHeight;
  previous.fixed = true;
  next.lineHeight = nextHeight;
  next.fixed = true;
  if (next.rows.length === 1) next.align = kind;
  group.push(next);
  return true;
}

/**
 * Whether a left-aligned paragraph of several lines is justified like the paragraphs around
 * it: it starts where one of theirs does and every line but the last reaches the right edge
 * theirs reach (a paragraph of two lines is too short to show it on its own).
 */
function justifiedLikeColumn(para: Para, justified: readonly Para[]): boolean {
  const left = paragraphLeft(para);
  const last = para.rows[para.rows.length - 1] as Row;
  return justified.some((ref) => {
    const right = paragraphRight(ref);
    return (
      Math.abs(paragraphLeft(ref) - left) <= EDGE &&
      last.x1 <= right + 1.5 &&
      para.rows.slice(0, -1).every((row) => Math.abs(row.x1 - right) <= 1.5)
    );
  });
}

/* ------------------------------------------------------------------ *
 * boxes
 * ------------------------------------------------------------------ */

function upright(group: readonly Para[]): TextBox {
  const rows = group.flatMap((para) => para.rows);
  const first = group[0] as Para;
  const left = Math.min(...rows.map((row) => row.x0));
  const right = Math.max(...rows.map((row) => row.x1));
  const justified = group.some((para) => para.align === 'both');
  // A justified line is stretched to the box, so the box is the lines' width and any slack moves
  // the right edge; only a squeezed line (spaces below their natural width) whose natural width
  // would not fit the frame gets the room it needs (`justifiedFactor`).
  const width = justified
    ? (right - left) * justifiedFactor(rows)
    : (right - left) * WIDTH_FACTOR + WIDTH_PAD;
  const kind = classOf(first.align);
  const x0 = kind === 'center' ? (left + right) / 2 - width / 2 : kind === 'right' ? right - width : left;
  const top = boxTop((first.rows[0] as Row).baseline, first.lineHeight);
  const height = group.reduce((sum, para) => sum + para.lineHeight * para.rows.length, 0);
  const bottom = Math.max(top + height, ...rows.map((row) => row.y1));
  return {
    box: [x0, top, x0 + width, bottom],
    rotation: 0,
    paragraphs: group.map((para) => ({
      align: para.align,
      lineHeight: para.lineHeight,
      lines: para.rows.map((row): TextLine => ({ runs: row.runs })),
    })),
  };
}

/**
 * Rotated text: one line, its visual box in page space (the text's length along the box's
 * height, the line across its width). `textBoxXml` writes it as a vertical text box.
 */
function rotated(row: Row): TextBox {
  const lineHeight = Math.max(MIN_LINE * row.size, row.x1 - row.x0);
  const length = (row.y1 - row.y0) * WIDTH_FACTOR + WIDTH_PAD;
  const down = row.direction === 'down';
  // The glyphs' tops face right when the text runs down, left when it runs up.
  const baseline = down ? row.x0 + DESCENT * row.size : row.x1 - DESCENT * row.size;
  const x0 = down ? baseline - (1 - BASELINE_IN_LINE) * lineHeight : baseline - BASELINE_IN_LINE * lineHeight;
  const y0 = down ? row.y0 : row.y1 - length;
  return {
    box: [x0, y0, x0 + lineHeight, y0 + length],
    rotation: down ? 90 : 270,
    paragraphs: [{ align: 'left', lineHeight, lines: [{ runs: row.runs }] }],
  };
}

/**
 * The text of a page as boxes, in the order MuPDF reads it. MuPDF's blocks are only a hint
 * here: it cuts centred and right-aligned paragraphs into blocks wherever the line starts
 * differ, so lines carry on a paragraph (and paragraphs stack into a box) across consecutive
 * blocks as long as the size, pitch and edge rules hold; a picture block ends both.
 */
export function textBoxes(layout: PageLayout, links: readonly SceneLink[]): TextBox[] {
  // Stacked paragraphs per box, or a rotated box; built once the page's alignments are known.
  const parts: (Para[] | TextBox)[] = [];
  const serifs = serifFamilies(layout);
  let pending: Pending | null = null;
  let group: Para[] = [];
  const flush = () => {
    if (pending !== null) {
      const para = paragraphOf(pending.rows, layout.width);
      pending = null;
      if (group.length === 0 || !stack(group, para)) {
        if (group.length > 0) parts.push(group);
        group = [para];
      }
    }
  };
  const end = () => {
    flush();
    if (group.length > 0) parts.push(group);
    group = [];
  };
  for (const block of layout.blocks) {
    if (block.kind !== 'text') {
      end();
      continue;
    }
    for (const line of joinPieces(block.lines)) {
      const row = rowOf(line, links, serifs);
      if (row === null) continue;
      if (row.direction !== 'right') {
        end();
        parts.push(rotated(row));
      } else if (pending !== null && continues(pending, row)) {
        pending.rows.push(row);
      } else {
        flush();
        pending = { rows: [row], left: true, center: true, right: true };
      }
    }
  }
  end();
  const paragraphs = parts.filter((part): part is Para[] => Array.isArray(part)).flat();
  const justified = paragraphs.filter((para) => para.align === 'both');
  for (const para of paragraphs) {
    if (para.align === 'left' && para.rows.length >= 2 && justifiedLikeColumn(para, justified)) {
      para.align = 'both';
    }
  }
  return parts.map((part) => (Array.isArray(part) ? upright(part) : part));
}

/* ------------------------------------------------------------------ *
 * words
 * ------------------------------------------------------------------ */

/** The text a paragraph writes: its lines joined by the space that precedes each break. */
function paragraphText(paragraph: TextParagraph): string {
  return paragraph.lines.map((line) => line.runs.map((run) => xmlSafe(run.text)).join('')).join(' ');
}

/** The whitespace-separated words the boxes write (what mammoth reads back). */
export function wordsInBoxes(boxes: readonly TextBox[]): number {
  let count = 0;
  for (const box of boxes) {
    for (const paragraph of box.paragraphs) {
      const text = paragraphText(paragraph).trim();
      if (text !== '') count += text.split(/\s+/).length;
    }
  }
  return count;
}

/* ------------------------------------------------------------------ *
 * XML
 * ------------------------------------------------------------------ */

/** Points with at most two decimals, for VML. */
const pt = (value: number) => String(Math.round(value * 100) / 100);

function runXml(run: TextRun, scale: number, registry: DocxRegistry): string {
  const half = Math.max(2, Math.round(run.size * scale * 2));
  const font = xml(run.font);
  const properties =
    `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>` +
    (run.bold ? '<w:b/><w:bCs/>' : '') +
    (run.italic ? '<w:i/><w:iCs/>' : '') +
    `<w:color w:val="${(run.color & 0xffffff).toString(16).toUpperCase().padStart(6, '0')}"/><w:sz w:val="${half}"/><w:szCs w:val="${half}"/>`;
  const body = `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${xml(run.text)}</w:t></w:r>`;
  return run.link === null ? body : `<w:hyperlink r:id="${registry.addLink(run.link)}">${body}</w:hyperlink>`;
}

/** The line's runs; a line that is followed by a break ends in a space (mammoth would glue the words). */
function lineRunsXml(
  runs: readonly TextRun[],
  scale: number,
  registry: DocxRegistry,
  broken: boolean,
): string {
  const all = [...runs];
  const last = all[all.length - 1];
  if (broken && last !== undefined && !/\s$/.test(xmlSafe(last.text))) {
    all.push({ ...last, text: ' ', link: null });
  }
  return all.map((run) => runXml(run, scale, registry)).join('');
}

function paragraphXml(paragraph: TextParagraph, scale: number, registry: DocxRegistry): string {
  const line = Math.max(1, Math.round(paragraph.lineHeight * scale * TWIPS));
  const lines = paragraph.lines
    .map((item, index) => lineRunsXml(item.runs, scale, registry, index < paragraph.lines.length - 1))
    .join('<w:r><w:br/></w:r>');
  return (
    `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="exact"/>` +
    `<w:jc w:val="${paragraph.align}"/></w:pPr>${lines}</w:p>`
  );
}

/**
 * A text box as one `w:r` holding a floating, borderless, fill-less text box with the exact
 * line spacing and no insets; `mc:AlternateContent` carries the DrawingML shape (read by Word
 * and LibreOffice) and a VML fallback with the same content (read by mammoth and older
 * readers). Offsets and sizes are the page's points × `scale` (`wordPageScale`).
 */
export function textBoxXml(box: TextBox, scale: number, registry: DocxRegistry): string {
  const [x0, y0, x1, y1] = box.box;
  const width = (x1 - x0) * scale;
  const height = (y1 - y0) * scale;
  const left = x0 * scale;
  const top = y0 * scale;
  const content = `<w:txbxContent>${box.paragraphs.map((paragraph) => paragraphXml(paragraph, scale, registry)).join('')}</w:txbxContent>`;
  const z = registry.nextZ();
  const id = registry.nextDrawingId();
  const cx = Math.max(1, Math.round(width * EMU));
  const cy = Math.max(1, Math.round(height * EMU));
  const vert = box.rotation === 90 ? 'vert' : box.rotation === 270 ? 'vert270' : 'horz';
  const flow =
    box.rotation === 90
      ? ' style="layout-flow:vertical"'
      : box.rotation === 270
        ? ' style="layout-flow:vertical;mso-layout-flow-alt:bottom-to-top"'
        : '';
  return (
    '<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>' +
    `<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${z}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(left * EMU)}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${Math.round(top * EMU)}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:wrapNone/>' +
    `<wp:docPr id="${id}" name="Text ${id}"/>` +
    '<wp:cNvGraphicFramePr/>' +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    '<wps:wsp><wps:cNvSpPr txBox="1"/>' +
    `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>' +
    `<wps:txbx>${content}</wps:txbx>` +
    `<wps:bodyPr rot="0" vert="${vert}" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0"><a:noAutofit/></wps:bodyPr>` +
    '</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice>' +
    '<mc:Fallback><w:pict>' +
    `<v:shape style="position:absolute;margin-left:${pt(left)}pt;margin-top:${pt(top)}pt;width:${pt(width)}pt;height:${pt(height)}pt;mso-position-horizontal-relative:page;mso-position-vertical-relative:page;z-index:${z}" stroked="f" filled="f">` +
    `<v:textbox${flow} inset="0,0,0,0">${content}</v:textbox></v:shape></w:pict></mc:Fallback>` +
    '</mc:AlternateContent></w:r>'
  );
}
