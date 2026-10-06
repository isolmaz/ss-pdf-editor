/**
 * The heuristics that find form fields on a flat page — pure geometry, no engine.
 *
 * "Prepare form" in Acrobat and the learned detectors in the literature (FFDNet and the
 * CommonForms data set train an object detector on rendered pages) both answer one question:
 * *where would a person write here?* A person writes where the page leaves room next to a
 * label, and the page marks that room in a handful of ways. This file reads those marks off a
 * page model (`DetectionPage`) that `form-detect.ts` builds from MuPDF's drawings and
 * structured text, and nothing in it needs a model download:
 *
 *  - a **rule** (a line, a dotted line, a run of underscores or dots in the text) with a
 *    label to its left, above or below it, and nothing written on it;
 *  - an **empty box** (an outlined or lightly shaded rectangle with no text or drawing in
 *    it) with a label beside or above it; a box divided into equal cells is a comb;
 *  - an **empty table cell** whose left neighbour is a label, or that sits under a header;
 *  - a **small empty square** (a checkbox) with a label beside it, drawn or typed (☐ □ ❑);
 *  - **small empty circles** (radio buttons), at least two in a row or a column;
 *  - a short **label ending in a colon** followed by room to the end of the line.
 *
 * Everything is in the page's displayed space: points, origin top-left, y down.
 *
 * Each rule answers with a confidence. `high` means a mark and a label both exist; `medium`
 * means one of them is inferred (a caption below a rule, a label that only ends in a colon, a
 * header over a column of cells). The review step shows the difference; the user decides.
 */

export type Box = readonly [number, number, number, number];

/** One character of a text line, as the structured-text walker reports it. */
export interface DetectChar {
  readonly c: string;
  readonly box: Box;
  readonly size: number;
}

export interface DetectLine {
  readonly chars: readonly DetectChar[];
}

/** A run of words on one line, split from its neighbours by a wide gap. */
export interface TextRun {
  readonly text: string;
  readonly box: Box;
  readonly size: number;
}

/** A row of underscores or dots typed as text: a blank to write on. */
export interface TextBlank {
  readonly box: Box;
  readonly size: number;
}

export interface HLine {
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
}

export interface VLine {
  readonly x: number;
  readonly y0: number;
  readonly y1: number;
}

/** A drawn rectangle or circle. `luminance` is the fill's brightness (0 black, 1 white), or `null` unfilled. */
export interface Shape {
  readonly box: Box;
  readonly stroked: boolean;
  readonly luminance: number | null;
}

export interface TableCellModel {
  readonly row: number;
  readonly column: number;
  readonly box: Box;
  readonly text: string;
}

export interface TableModel {
  readonly box: Box;
  readonly cells: readonly TableCellModel[];
}

/** What `form-detect.ts` reads off a page. */
export interface DetectionPage {
  readonly width: number;
  readonly height: number;
  readonly lines: readonly DetectLine[];
  readonly hlines: readonly HLine[];
  readonly vlines: readonly VLine[];
  readonly rects: readonly Shape[];
  readonly circles: readonly Shape[];
  /** The box of every other painted path: a mark inside a square means it is not empty. */
  readonly ink: readonly Box[];
  readonly tables: readonly TableModel[];
  /** The lines of a scan's picture are seen in pixels, not drawn: lower confidence. */
  readonly raster?: boolean;
}

export type CandidateKind = 'text' | 'checkbox' | 'radio' | 'signature';
export type CandidateSource =
  | 'line'
  | 'blank'
  | 'box'
  | 'comb'
  | 'cell'
  | 'glyph'
  | 'square'
  | 'circle'
  | 'colon';
export type Confidence = 'high' | 'medium';

/** A field the page suggests, in displayed page space. */
export interface RawCandidate {
  readonly kind: CandidateKind;
  readonly rect: Box;
  /** The text the name comes from (the radio group's own label for a radio). */
  readonly label: string;
  readonly confidence: Confidence;
  readonly source: CandidateSource;
  /** Label size in points, which the field's font follows. */
  readonly size: number;
  /** Radio buttons that belong together share this key. */
  readonly group?: string;
  /** A radio button's own text. */
  readonly option?: string;
  /** Equal cells of a comb field. */
  readonly cells?: number;
  readonly multiline?: boolean;
}

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

/** A rule shorter than this is not room to write. */
const MIN_FIELD_WIDTH = 28;
/** The height a text field gets over a rule, and its bounds. */
const MIN_FIELD_HEIGHT = 12;
const MAX_LINE_FIELD_HEIGHT = 22;
/** How far a label may sit left of its field, above it, and below it (a caption). */
const MAX_LABEL_GAP = 170;
const MAX_ABOVE_GAP = 26;
const MAX_CAPTION_GAP = 16;
/** A box below this is a checkbox, above it a text box. */
const CHECK_MAX = 20;
const CHECK_MIN = 5;
/** A frame this tall is a multi-line text box. */
const MULTILINE_HEIGHT = 38;
const MAX_BOX_HEIGHT = 160;
/** The characters a typed blank is made of. */
const BLANK_UNDERSCORE_MIN = 4;
const BLANK_DOT_MIN = 6;
const MAX_NAME_LENGTH = 48;
/** More text than this beside a field is a sentence, not its label. */
const MAX_LABEL_TEXT = 72;
const MAX_LABEL_WORDS = 6;
/** What stands beside a checkbox or a radio button may be a whole sentence of consent. */
const MAX_OPTION_TEXT = 120;
const MAX_OPTION_WORDS = 18;
/** A run this long, with another stacked on it, is a paragraph. */
const PROSE_LENGTH = 36;
/** A fill darker than this is a bar or a button, not a place to write. */
const DARK_FILL = 0.75;
const WHITE_FILL = 0.97;
/** A label set this much larger than the page's body text is a heading. */
const HEADING_RATIO = 1.25;
/** A rule longer than this share of the page is a divider. */
const LONG_RULE_SHARE = 0.75;
/** A caption set this much smaller than the page's body text is a label inside a figure. */
const CAPTION_RATIO = 0.7;
/** Labels set smaller than this share of the body text are part of a drawing. */
const TINY_RATIO = 0.55;

const CHECK_GLYPHS = new Set(['☐', '□', '❑', '❒', '❏', '❐', '◻', '▢', '⬜', '🔲']);
const RADIO_GLYPHS = new Set(['○', '◯', '⚪', '◌']);

// ---------------------------------------------------------------------------
// small geometry
// ---------------------------------------------------------------------------

const width = (box: Box): number => box[2] - box[0];
const height = (box: Box): number => box[3] - box[1];
const midY = (box: Box): number => (box[1] + box[3]) / 2;

function overlapX(a: Box, b: Box): number {
  return Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
}

function overlapY(a: Box, b: Box): number {
  return Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
}

function intersects(a: Box, b: Box): boolean {
  return overlapX(a, b) > 0 && overlapY(a, b) > 0;
}

function intersectionArea(a: Box, b: Box): number {
  return Math.max(0, overlapX(a, b)) * Math.max(0, overlapY(a, b));
}

function centerInside(inner: Box, outer: Box, slack = 0): boolean {
  const cx = (inner[0] + inner[2]) / 2;
  const cy = midY(inner);
  return cx > outer[0] + slack && cx < outer[2] - slack && cy > outer[1] + slack && cy < outer[3] - slack;
}

function unionOf(boxes: readonly Box[]): Box {
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

// ---------------------------------------------------------------------------
// text: runs and blanks
// ---------------------------------------------------------------------------

const DOT_LIKE = new Set(['.', '·', '…', '‥', '⋯', '‧', '∙']);

/** Dots and underscores a blank is typed with; a space between two of them stays inside it. */
function isBlankChar(c: string): boolean {
  return c === '_' || c === '＿' || DOT_LIKE.has(c);
}

/** The widest gap between two words of one run, in em. A tab or a column gap is wider. */
const RUN_GAP_EM = 0.9;

/**
 * A line as the runs of words and the blanks it holds.
 *
 * A blank is a run of underscores, or six dots, typed as text. Dots followed by nothing but
 * a number are a table of contents' leader, which leads to a page, not to a field.
 */
export function readLine(line: DetectLine): { runs: TextRun[]; blanks: TextBlank[] } {
  const chars = line.chars;
  const runs: TextRun[] = [];
  const blanks: TextBlank[] = [];
  let word: DetectChar[] = [];

  const flush = (): void => {
    const solid = word.filter((char) => char.c.trim() !== '');
    if (solid.length > 0) {
      const text = word
        .map((char) => char.c)
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      const sizes = solid.map((char) => char.size).sort((a, b) => a - b);
      if (text !== '') {
        runs.push({
          text,
          box: unionOf(solid.map((char) => char.box)),
          size: sizes[Math.floor(sizes.length / 2)] ?? 10,
        });
      }
    }
    word = [];
  };

  let index = 0;
  while (index < chars.length) {
    const char = chars[index] as DetectChar;
    if (isBlankChar(char.c)) {
      // The longest run of blank characters, with single spaces allowed between them.
      let end = index;
      let last = index;
      let weight = 0;
      let underscores = 0;
      for (let at = index; at < chars.length; at += 1) {
        const next = chars[at] as DetectChar;
        if (isBlankChar(next.c)) {
          weight += next.c === '…' ? 3 : 1;
          if (next.c === '_' || next.c === '＿') underscores += 1;
          last = at;
          end = at + 1;
        } else if (next.c === ' ' && at + 1 < chars.length && isBlankChar((chars[at + 1] as DetectChar).c)) {
          // a gap inside the run
        } else break;
      }
      const needed = underscores > 0 ? BLANK_UNDERSCORE_MIN : BLANK_DOT_MIN;
      const after = chars
        .slice(end)
        .map((next) => next.c)
        .join('')
        .trim();
      const leader = underscores === 0 && /^\(?[\divxlcIVXLC]{1,5}\)?$/.test(after);
      if (weight >= needed && !leader) {
        flush();
        const body = chars.slice(index, last + 1).filter((entry) => entry.c.trim() !== '');
        blanks.push({
          box: unionOf(body.map((entry) => entry.box)),
          size: body[0]?.size ?? 10,
        });
        index = end;
        continue;
      }
    }
    const previous = word[word.length - 1];
    if (previous !== undefined && char.c.trim() !== '') {
      const solid = [...word].reverse().find((entry) => entry.c.trim() !== '');
      if (solid !== undefined && char.box[0] - solid.box[2] > RUN_GAP_EM * Math.max(char.size, 4)) flush();
    }
    word.push(char);
    index += 1;
  }
  flush();
  return { runs, blanks };
}

/** The label text of a field: tidy, with no period (a field name cannot contain one). */
export function cleanLabel(text: string): string {
  const tidy = text
    // An abbreviation loses its periods (T.C. is TC); a run of dots or underscores is a gap.
    .replace(/(?<=\p{L})\.(?!\.)/gu, '')
    .replace(/[_.·…‥:：*•✱]+/g, ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (tidy.length <= MAX_NAME_LENGTH) return tidy;
  const cut = tidy.slice(0, MAX_NAME_LENGTH);
  const space = cut.lastIndexOf(' ');
  return (space > 12 ? cut.slice(0, space) : cut).trim();
}

/** Letters or digits in a label: a lone bullet or a number is not a name. */
function nameable(text: string, longest = MAX_LABEL_TEXT, words = MAX_LABEL_WORDS): boolean {
  // A label is a few words; a sentence is the page's own prose.
  return (
    /\p{L}/u.test(cleanLabel(text)) && text.length <= longest && text.trim().split(/\s+/).length <= words
  );
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

/** The nearest run to the left of `x` on a row: its vertical span must overlap the band. */
function labelLeft(runs: readonly TextRun[], x: number, band: Box, maxGap = MAX_LABEL_GAP): TextRun | null {
  let best: TextRun | null = null;
  for (const run of runs) {
    if (run.box[2] > x + 3 || x - run.box[2] > maxGap || !nameable(run.text)) continue;
    const need = Math.min(height(run.box), height(band), 8) * 0.5;
    if (overlapY(run.box, band) < need) continue;
    if (best === null || run.box[2] > best.box[2]) best = run;
  }
  return best;
}

/** The nearest run above a field that starts above its left edge or over it. */
function labelAbove(runs: readonly TextRun[], field: Box, maxGap = MAX_ABOVE_GAP): TextRun | null {
  let best: TextRun | null = null;
  for (const run of runs) {
    if (!nameable(run.text)) continue;
    const gap = field[1] - run.box[3];
    if (gap < -2 || gap > maxGap || BOILERPLATE.test(run.text.trim())) continue;
    const over = overlapX(run.box, field) > 0 || Math.abs(run.box[0] - field[0]) < 30;
    if (!over || run.box[0] > field[2] - 4) continue;
    if (best === null || run.box[3] > best.box[3]) best = run;
  }
  return best;
}

/** A caption under a rule: short, over the rule's span. */
function labelBelow(runs: readonly TextRun[], field: Box, y: number): TextRun | null {
  let best: TextRun | null = null;
  for (const run of runs) {
    if (!nameable(run.text) || run.text.length > 40 || BOILERPLATE.test(run.text.trim())) continue;
    const gap = run.box[1] - y;
    if (gap < 0.5 || gap > MAX_CAPTION_GAP) continue;
    if (overlapX(run.box, field) < Math.min(width(run.box), width(field)) * 0.4) continue;
    if (best === null || run.box[1] < best.box[1]) best = run;
  }
  return best;
}

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------

interface Context {
  readonly page: DetectionPage;
  readonly runs: readonly TextRun[];
  readonly blanks: readonly TextBlank[];
  readonly glyphs: readonly { readonly c: string; readonly box: Box; readonly size: number }[];
  /** Text boxes of every run, for "is anything written here". */
  readonly textBoxes: readonly Box[];
  /** The size most of the page's characters are set in. */
  readonly bodySize: number;
  /** The runs that can name a field: the page's text without its paragraphs. */
  readonly labels: readonly TextRun[];
}

/** The size that most characters of the page are set in. */
function bodySizeOf(runs: readonly TextRun[]): number {
  const weight = new Map<number, number>();
  for (const run of runs) {
    const key = Math.round(run.size * 2) / 2;
    weight.set(key, (weight.get(key) ?? 0) + run.text.length);
  }
  let best = 10;
  let most = 0;
  for (const [size, count] of weight) {
    if (count > most) {
      most = count;
      best = size;
    }
  }
  return best;
}

/**
 * The runs that are lines of a paragraph: stacked directly on a long run with the same left
 * edge. A sentence beside a rule is the page's own text, not what the rule is for.
 */
function proseRuns(runs: readonly TextRun[]): Set<TextRun> {
  const prose = new Set<TextRun>();
  const long = runs.filter((run) => run.text.length >= PROSE_LENGTH);
  for (const run of runs) {
    for (const other of long) {
      if (other === run || Math.abs(other.box[0] - run.box[0]) > 3) continue;
      const gap = Math.max(run.box[1] - other.box[3], other.box[1] - run.box[3]);
      if (gap >= -3 && gap <= run.size * 0.5) {
        prose.add(run);
        break;
      }
    }
  }
  return prose;
}

function contextOf(page: DetectionPage): Context {
  const runs: TextRun[] = [];
  const blanks: TextBlank[] = [];
  const glyphs: { c: string; box: Box; size: number }[] = [];
  for (const line of page.lines) {
    // Box glyphs are lifted out of the line first: a ☐ in the middle of a sentence would
    // otherwise be read as part of its words.
    const plain: DetectChar[] = [];
    const flushPlain = (): void => {
      if (plain.length === 0) return;
      const read = readLine({ chars: plain });
      runs.push(...read.runs);
      blanks.push(...read.blanks);
      plain.length = 0;
    };
    for (const char of line.chars) {
      if (CHECK_GLYPHS.has(char.c) || RADIO_GLYPHS.has(char.c)) {
        flushPlain();
        glyphs.push({ c: char.c, box: char.box, size: char.size });
      } else plain.push(char);
    }
    flushPlain();
  }
  const prose = proseRuns(runs);
  return {
    page,
    runs,
    blanks,
    glyphs,
    textBoxes: runs.map((run) => run.box),
    bodySize: bodySizeOf(runs),
    labels: runs.filter((run) => !prose.has(run)),
  };
}

/** Whether any text or glyph has its centre inside `box`, inset by `slack`. */
function holdsText(context: Context, box: Box, slack = 0.5): boolean {
  return (
    context.textBoxes.some((text) => centerInside(text, box, slack)) ||
    context.glyphs.some((glyph) => centerInside(glyph.box, box, slack))
  );
}

/** Whether something is drawn inside `box`, other than `box` itself. */
function holdsInk(page: DetectionPage, box: Box, slack = 1): boolean {
  const inner: Box = [box[0] + slack, box[1] + slack, box[2] - slack, box[3] - slack];
  if (inner[2] <= inner[0] || inner[3] <= inner[1]) return false;
  // A browser's dropdown arrow, a text area's resize grip, a date picker's icon: small, at the
  // right edge of a wide box, and not content.
  const chrome = (ink: Box): boolean =>
    width(box) >= 40 && width(ink) <= 14 && height(ink) <= 14 && ink[2] >= box[2] - 28;
  return page.ink.some(
    (ink) =>
      ink[0] >= inner[0] - 0.5 &&
      ink[2] <= inner[2] + 0.5 &&
      ink[1] >= inner[1] - 0.5 &&
      ink[3] <= inner[3] + 0.5 &&
      !chrome(ink),
  );
}

/** Text that sits near a rule without naming a field: page numbers, figure and table captions. */
const BOILERPLATE =
  /^\[[\w*†‡]{1,3}\]|^(?:sayfa|page|s\.)\s*\d+|^\d+\s*(?:\/|of)\s*\d+$|^(?:şekil|figure|fig\.?|tablo|table|kaynak|source)\s*\d/i;

const SIGNATURE = /imza|signature|sign here|signed by/;
const NOT_SIGNATURE = /tarih|date|adı|ad soyad|name|isim|unvan|title|kaşe|stamp/;

/** A label that asks for a signature, so the field is one. */
function isSignatureLabel(label: string): boolean {
  const lower = label.toLocaleLowerCase('tr').normalize('NFC');
  return lower.length <= 30 && SIGNATURE.test(lower) && !NOT_SIGNATURE.test(lower);
}

function textCandidate(
  rect: Box,
  label: string,
  confidence: Confidence,
  source: CandidateSource,
  size: number,
  extra: Partial<Pick<RawCandidate, 'cells' | 'multiline'>> = {},
): RawCandidate {
  return {
    kind: isSignatureLabel(label) && extra.cells === undefined ? 'signature' : 'text',
    rect,
    label,
    confidence,
    source,
    size,
    ...extra,
  };
}

// ---- rules ----------------------------------------------------------------

interface Rule {
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
}

/** The rules of the page without the ones that are the edges of a box or the grid of a table. */
function freeRules(context: Context, boxes: readonly Box[]): Rule[] {
  const { page } = context;
  const merged: Rule[] = [];
  const sorted = [...page.hlines].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  for (const line of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && Math.abs(last.y - line.y) <= 1 && line.x0 <= last.x1 + 2) {
      merged[merged.length - 1] = { x0: last.x0, x1: Math.max(last.x1, line.x1), y: last.y };
    } else merged.push({ x0: line.x0, x1: line.x1, y: line.y });
  }
  return merged.filter((rule) => {
    const long = rule.x1 - rule.x0;
    if (long < MIN_FIELD_WIDTH || long > page.width * 0.92) return false;
    if (
      page.tables.some(
        (table) =>
          rule.y >= table.box[1] - 2 &&
          rule.y <= table.box[3] + 2 &&
          rule.x0 >= table.box[0] - 2 &&
          rule.x1 <= table.box[2] + 2,
      )
    )
      return false;
    // The top or bottom edge of a rectangle is its border, not a line to write on.
    return !boxes.some(
      (box) =>
        (Math.abs(rule.y - box[1]) <= 1.5 || Math.abs(rule.y - box[3]) <= 1.5) &&
        rule.x0 >= box[0] - 3 &&
        rule.x1 <= box[2] + 3,
    );
  });
}

/** The parts of a rule that no text covers, at least `MIN_FIELD_WIDTH` wide. */
function freeSpans(context: Context, rule: Rule): [number, number][] {
  const covering = context.runs
    .filter(
      (run) =>
        run.box[3] > rule.y - 9 && run.box[1] < rule.y - 1 && run.box[2] > rule.x0 && run.box[0] < rule.x1,
    )
    .map((run) => [run.box[0] - 2, run.box[2] + 2] as const)
    .sort((a, b) => a[0] - b[0]);
  const spans: [number, number][] = [];
  let from = rule.x0;
  for (const [start, end] of covering) {
    if (start > from) spans.push([from, Math.min(start, rule.x1)]);
    from = Math.max(from, end);
  }
  if (from < rule.x1) spans.push([from, rule.x1]);
  return spans.filter(([a, b]) => b - a >= MIN_FIELD_WIDTH);
}

/** The text field a rule stands for, given the span of it that is free. */
function fieldOverRule(
  context: Context,
  rule: Rule,
  span: readonly [number, number],
  previous: readonly RawCandidate[],
): RawCandidate | null {
  const band: Box = [span[0], rule.y - 12, span[1], rule.y + 3];
  const left = labelLeft(context.labels, span[0], band);
  let label = left;
  let confidence: Confidence = 'high';
  let top = rule.y - MAX_LINE_FIELD_HEIGHT;
  let size = left?.size ?? 10;
  if (left !== null) {
    // A heading with a rule under it has the same shape as a label with its line: told apart
    // by size, because a heading is set larger than the text of the page.
    if (left.size > context.bodySize * HEADING_RATIO) return null;
    top = rule.y - Math.min(MAX_LINE_FIELD_HEIGHT, Math.max(MIN_FIELD_HEIGHT + 2, left.size * 1.7));
  } else {
    // No label on the row: a caption under the rule, or a label above it. A long rule
    // across the page is a divider, whatever sits next to it.
    if (rule.x1 - rule.x0 > context.page.width * LONG_RULE_SHARE) return null;
    const below = labelBelow(context.labels, [span[0], rule.y, span[1], rule.y + 14], rule.y);
    const above = labelAbove(context.labels, [span[0], rule.y - 11, span[1], rule.y], 18);
    const belowGap = below === null ? Number.POSITIVE_INFINITY : below.box[1] - rule.y;
    const aboveGap = above === null ? Number.POSITIVE_INFINITY : rule.y - above.box[3];
    if (below !== null && belowGap <= aboveGap) {
      label = below;
      size = below.size;
    } else if (above !== null) {
      label = above;
      top = Math.max(above.box[3] + 1, rule.y - 26);
      size = above.size;
    } else {
      // A second line of the same answer (an address on two lines): the same width as a field
      // just above it, which names it.
      const above = previous.find(
        (field) =>
          field.source === 'line' &&
          Math.abs(field.rect[0] - span[0]) <= 4 &&
          Math.abs(field.rect[2] - span[1]) <= 4 &&
          rule.y - field.rect[3] >= 8 &&
          rule.y - field.rect[3] <= 40,
      );
      if (above === undefined) return null;
      const continued: Box = [span[0], rule.y - MAX_LINE_FIELD_HEIGHT, span[1], rule.y - 0.5];
      return textCandidate(continued, above.label, 'medium', 'line', above.size);
    }
    // A caption much smaller than the page's text belongs to a figure, not to a form.
    if (size < context.bodySize * CAPTION_RATIO) return null;
    confidence = 'medium';
  }
  // Something standing on the rule (a bar, a column) makes it the base of a drawing, and a
  // rule among many drawn shapes is part of one.
  if (standsOn(context.page, rule, span) || inDrawing(context.page, rule)) return null;
  // A label that begins over the rule (the line runs under the label too) is a label only
  // when it asks for something: it ends in a colon.
  if (left !== null && left.box[0] >= rule.x0 - 1 && !/[:：]\s*$/.test(left.text)) return null;
  const x0 = left !== null && span[0] - left.box[2] < 4 ? span[0] + 1.5 : span[0];
  // Text written above the rule (another label, a hint) takes room from the field.
  for (const run of context.runs) {
    if (run === label || overlapX(run.box, [x0, 0, span[1], 0]) <= 3) continue;
    if (run.box[1] < rule.y - 1 && run.box[3] > top) top = Math.max(top, run.box[3] + 1);
  }
  if (rule.y - top < MIN_FIELD_HEIGHT - 3) return null;
  const rect: Box = [x0, top, span[1], rule.y - 0.5];
  if (label === null) return null;
  return textCandidate(rect, label.text, confidence, 'line', size);
}

/** Shapes the page draws in the neighbourhood of a rule: a diagram's parts, a keyboard's keys. */
function inDrawing(page: DetectionPage, rule: Rule): boolean {
  const around: Box = [rule.x0 - 15, rule.y - 45, rule.x1 + 15, rule.y + 10];
  const near = (box: Box): boolean => intersects(box, around);
  return page.ink.filter(near).length >= 6 || page.rects.filter((shape) => near(shape.box)).length >= 25;
}

/** Whether a drawn shape's bottom edge rests on the rule within `span`. */
function standsOn(page: DetectionPage, rule: Rule, span: readonly [number, number]): boolean {
  const rests = (box: Box): boolean =>
    Math.abs(box[3] - rule.y) <= 2 &&
    Math.min(box[2], span[1]) - Math.max(box[0], span[0]) > 6 &&
    height(box) > 3;
  return (
    page.rects.some((shape) => rests(shape.box)) ||
    page.circles.some((shape) => rests(shape.box)) ||
    page.ink.some(rests)
  );
}

function ruleCandidates(context: Context, boxes: readonly Box[]): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const rule of freeRules(context, boxes)) {
    for (const span of freeSpans(context, rule)) {
      const field = fieldOverRule(context, rule, span, out);
      if (field !== null) out.push(field);
    }
  }
  return out;
}

/** A blank typed as underscores or dots. */
function blankCandidates(context: Context): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const blank of context.blanks) {
    if (width(blank.box) < MIN_FIELD_WIDTH) continue;
    const rowBand: Box = [blank.box[0], blank.box[1], blank.box[2], blank.box[3]];
    const left = labelLeft(context.labels, blank.box[0], rowBand, 90);
    const size = left?.size ?? blank.size;
    // The glyph box is the whole em; the field is the line's body, never shorter than a
    // comfortable one.
    const y1 = blank.box[3];
    const heightOf = Math.max(MIN_FIELD_HEIGHT + 2, Math.min(MAX_LINE_FIELD_HEIGHT, size * 1.5));
    let rect: Box = [blank.box[0], y1 - heightOf, blank.box[2], y1];
    let label = left;
    let confidence: Confidence = 'high';
    if (left === null) {
      const above = labelAbove(context.labels, [rect[0], rect[1] - 14, rect[2], rect[3]]);
      if (above === null) continue;
      label = above;
      confidence = 'medium';
      rect = [rect[0], Math.max(above.box[3] + 1, rect[1]), rect[2], rect[3]];
    }
    if (label === null) continue;
    out.push(textCandidate(rect, label.text, confidence, 'blank', size));
  }
  return out;
}

// ---- boxes ----------------------------------------------------------------

function sameBox(a: Box, b: Box, tolerance = 1.2): boolean {
  return a.every((value, index) => Math.abs(value - (b[index] as number)) <= tolerance);
}

/** Boxes drawn as four separate lines, and rectangles from the device, without duplicates. */
function allRects(page: DetectionPage): Shape[] {
  const out: Shape[] = [];
  const push = (shape: Shape): void => {
    const twin = out.findIndex((entry) => sameBox(entry.box, shape.box));
    if (twin >= 0) {
      const old = out[twin] as Shape;
      out[twin] = {
        box: old.box,
        stroked: old.stroked || shape.stroked,
        luminance: old.luminance ?? shape.luminance,
      };
    } else out.push(shape);
  };
  for (const rect of page.rects) push(rect);
  // Four lines make a box when two horizontals and two verticals meet at its corners.
  const horizontals = [...page.hlines].filter((line) => line.x1 - line.x0 >= 6);
  for (const top of horizontals) {
    for (const bottom of horizontals) {
      const tall = bottom.y - top.y;
      if (tall < 6 || tall > MAX_BOX_HEIGHT) continue;
      if (Math.abs(top.x0 - bottom.x0) > 2.5 || Math.abs(top.x1 - bottom.x1) > 2.5) continue;
      const left = page.vlines.some(
        (line) => Math.abs(line.x - top.x0) <= 2.5 && line.y0 <= top.y + 2.5 && line.y1 >= bottom.y - 2.5,
      );
      const right = page.vlines.some(
        (line) => Math.abs(line.x - top.x1) <= 2.5 && line.y0 <= top.y + 2.5 && line.y1 >= bottom.y - 2.5,
      );
      if (left && right) push({ box: [top.x0, top.y, top.x1, bottom.y], stroked: true, luminance: null });
    }
  }
  return out;
}

function squareish(box: Box): boolean {
  const w = width(box);
  const h = height(box);
  return Math.abs(w - h) <= Math.max(1.5, Math.max(w, h) * 0.22);
}

/** Equal squares in a row that touch: the cells of a comb field. */
function combs(rects: readonly Shape[]): { cells: Shape[]; box: Box }[] {
  const squares = rects
    .filter((shape) => squareish(shape.box) && width(shape.box) >= 8 && width(shape.box) <= 32)
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  const used = new Set<Shape>();
  const out: { cells: Shape[]; box: Box }[] = [];
  for (const start of squares) {
    if (used.has(start)) continue;
    const chain = [start];
    let last = start;
    for (const next of squares) {
      if (used.has(next) || chain.includes(next)) continue;
      const gap = next.box[0] - last.box[2];
      if (
        Math.abs(next.box[1] - last.box[1]) <= 1.5 &&
        Math.abs(width(next.box) - width(last.box)) <= 1.5 &&
        gap >= -1.5 &&
        gap <= 3
      ) {
        chain.push(next);
        last = next;
      }
    }
    if (chain.length >= 4) {
      for (const cell of chain) used.add(cell);
      out.push({ cells: chain, box: unionOf(chain.map((cell) => cell.box)) });
    }
  }
  return out;
}

/** A frame divided by equal vertical ticks into cells (a comb drawn as one box). */
function tickedCells(page: DetectionPage, box: Box): number {
  const ticks = page.vlines
    .filter(
      (line) =>
        line.x > box[0] + 3 &&
        line.x < box[2] - 3 &&
        line.y0 <= box[1] + height(box) * 0.4 &&
        line.y1 >= box[3] - height(box) * 0.4,
    )
    .map((line) => line.x)
    .sort((a, b) => a - b);
  if (ticks.length < 3) return 0;
  const edges = [box[0], ...ticks, box[2]];
  const pitches = edges.slice(1).map((edge, index) => edge - (edges[index] as number));
  const mean = pitches.reduce((sum, pitch) => sum + pitch, 0) / pitches.length;
  return pitches.every((pitch) => Math.abs(pitch - mean) <= Math.max(1.5, mean * 0.12)) ? pitches.length : 0;
}

/** Whether some text overlaps a quarter or more of `box`: it is lettering on a key, not a mark beside a label. */
function touchesText(context: Context, box: Box): boolean {
  const area = Math.max(1, width(box) * height(box));
  return context.textBoxes.some((text) => intersectionArea(text, box) / area >= 0.25);
}

/** A drawing around `box` (a keyboard, a diagram): many curves and polygons within 40 pt. */
function crowded(page: DetectionPage, box: Box): boolean {
  const around: Box = [box[0] - 40, box[1] - 40, box[2] + 40, box[3] + 40];
  return page.ink.filter((ink) => intersects(ink, around)).length >= 6;
}

/** Rules drawn across a box's inside: a ruled writing area, or an icon, rather than one field. */
function interiorRules(page: DetectionPage, box: Box): number {
  return page.hlines.filter(
    (line) =>
      line.y > box[1] + 2 &&
      line.y < box[3] - 2 &&
      Math.min(line.x1, box[2]) - Math.max(line.x0, box[0]) >= width(box) * 0.6,
  ).length;
}

interface BoxResult {
  readonly candidates: RawCandidate[];
  /** Every rectangle the boxes were drawn from, for the rule filter. */
  readonly boxes: Box[];
}

function boxCandidates(context: Context): BoxResult {
  const { page } = context;
  const rects = allRects(page);
  const boxes = rects.map((rect) => rect.box);
  const out: RawCandidate[] = [];
  const grouped = combs(rects);
  const comboCells = new Set(grouped.flatMap((group) => group.cells));

  const labelOf = (box: Box): { run: TextRun; confidence: Confidence } | null => {
    const left = labelLeft(context.labels, box[0], box);
    if (left !== null) return { run: left, confidence: 'high' };
    const above = labelAbove(context.labels, box);
    return above === null ? null : { run: above, confidence: 'high' };
  };

  for (const group of grouped) {
    if (holdsText(context, group.box)) continue;
    const found = labelOf(group.box);
    if (found === null) continue;
    out.push(
      textCandidate(group.box, found.run.text, found.confidence, 'comb', found.run.size, {
        cells: group.cells.length,
      }),
    );
  }

  for (const shape of rects) {
    const { box } = shape;
    if (comboCells.has(shape)) continue;
    const w = width(box);
    const h = height(box);
    if (page.tables.some((table) => centerInside(box, table.box, -1))) continue;
    if (shape.luminance !== null && shape.luminance < DARK_FILL) continue;
    if (!shape.stroked && (shape.luminance === null || shape.luminance >= WHITE_FILL)) continue;
    if (w < MIN_FIELD_WIDTH - 4 || h < 9 || h > MAX_BOX_HEIGHT || w > page.width * 0.95) continue;
    if (w <= CHECK_MAX && h <= CHECK_MAX) continue; // a checkbox: handled below
    if (holdsText(context, box)) {
      const captioned = shape.stroked ? captionedBox(context, box) : null;
      if (captioned !== null) out.push(captioned);
      continue;
    }
    const cells = tickedCells(page, box);
    // A frame around other drawings is a section, not a field; ticks are the one exception.
    if (cells === 0 && (holdsInk(page, box) || interiorRules(page, box) >= 3)) continue;
    if (crowded(page, box)) continue;
    const found = labelOf(box);
    if (found === null) continue;
    const shaded = !shape.stroked;
    out.push(
      textCandidate(
        box,
        found.run.text,
        shaded ? 'medium' : found.confidence,
        cells > 0 ? 'comb' : 'box',
        found.run.size,
        { ...(cells > 0 ? { cells } : {}), ...(h > MULTILINE_HEIGHT ? { multiline: true } : {}) },
      ),
    );
  }
  return { candidates: out, boxes };
}

// ---- tables ---------------------------------------------------------------

/** How many of a cell's four sides have a rule drawn along them (at least 70 % of the side). */
function enclosedSides(page: DetectionPage, box: Box): number {
  const along = (
    lines: readonly { from: number; to: number; at: number }[],
    at: number,
    from: number,
    to: number,
  ): boolean => {
    const covered = lines
      .filter((line) => Math.abs(line.at - at) <= 2)
      .reduce((sum, line) => sum + Math.max(0, Math.min(line.to, to) - Math.max(line.from, from)), 0);
    return covered >= (to - from) * 0.7;
  };
  const horizontals = page.hlines.map((line) => ({ from: line.x0, to: line.x1, at: line.y }));
  const verticals = page.vlines.map((line) => ({ from: line.y0, to: line.y1, at: line.x }));
  return [
    along(horizontals, box[1], box[0], box[2]),
    along(horizontals, box[3], box[0], box[2]),
    along(verticals, box[0], box[1], box[3]),
    along(verticals, box[2], box[1], box[3]),
  ].filter(Boolean).length;
}

/** Whether a filled rectangle of a non-white colour covers most of `box`: a header band or a shaded label. */
function shaded(page: DetectionPage, box: Box): boolean {
  const area = Math.max(1, width(box) * height(box));
  return page.rects.some(
    (shape) =>
      shape.luminance !== null && shape.luminance < 0.93 && intersectionArea(shape.box, box) / area >= 0.8,
  );
}

/**
 * A box (a table cell, or a frame on its own) that carries its own caption at the top and
 * leaves the rest of it free: the common layout of a paper form (small capitals over a space
 * to write in). The field is the free part, named by the caption.
 */
function captionedBox(context: Context, box: Box): RawCandidate | null {
  const w = width(box);
  const h = height(box);
  if (w < MIN_FIELD_WIDTH || h < 26 || h > MAX_BOX_HEIGHT) return null;
  if (shaded(context.page, box) || holdsInk(context.page, box, 1.5)) return null;
  const inside = context.runs.filter((run) => centerInside(run.box, box, 0.5));
  if (inside.length === 0 || inside.length > 2) return null;
  const textBottom = Math.max(...inside.map((run) => run.box[3]));
  const textTop = Math.min(...inside.map((run) => run.box[1]));
  // The caption sits in the upper part, and what is left under it is room to write.
  if (textTop > box[1] + h * 0.35 || box[3] - textBottom < Math.max(15, (textBottom - textTop) * 1.6))
    return null;
  const label = inside.map((run) => run.text).join(' ');
  if (!nameable(label)) return null;
  const rect: Box = [box[0] + 1.5, textBottom + 1, box[2] - 1.5, box[3] - 1.5];
  const size = inside[0]?.size ?? 9;
  return textCandidate(
    rect,
    label,
    'medium',
    'cell',
    size,
    h > MULTILINE_HEIGHT * 2 ? { multiline: true } : {},
  );
}

function cellCandidates(context: Context): RawCandidate[] {
  const out: RawCandidate[] = [];
  for (const table of context.page.tables) {
    const cells = table.cells;
    const emptyCount = cells.filter((cell) => cell.text.trim() === '').length;
    if (emptyCount === cells.length) continue;
    // A table of data with a hole or two is not a form: empty cells must be a real share of
    // it (a label column beside a column to fill is half), and a grid under headers must be
    // mostly empty body.
    const emptyShare = emptyCount / cells.length;
    const body = cells.filter((cell) => cell.row > 0);
    const emptyBody =
      body.length === 0 ? 0 : body.filter((cell) => cell.text.trim() === '').length / body.length;
    const produced: RawCandidate[] = [];
    const headed: { header: TableCellModel; candidate: RawCandidate }[] = [];
    for (const cell of cells) {
      if (cell.text.trim() !== '') {
        const captioned = enclosedSides(context.page, cell.box) >= 3 ? captionedBox(context, cell.box) : null;
        if (captioned !== null) produced.push(captioned);
        continue;
      }
      const w = width(cell.box);
      const h = height(cell.box);
      if (w < MIN_FIELD_WIDTH || h < 9 || h > MAX_BOX_HEIGHT) continue;
      const shrunk: Box = [cell.box[0] + 1, cell.box[1] + 1, cell.box[2] - 1, cell.box[3] - 1];
      if (enclosedSides(context.page, cell.box) < 3) continue;
      if (holdsInk(context.page, cell.box, 1.5) || holdsText(context, cell.box)) continue;
      // Label: the cell to the left on the same row.
      const neighbour = cells.find(
        (other) =>
          Math.abs(other.box[2] - cell.box[0]) <= 2.5 &&
          overlapY(other.box, cell.box) > Math.min(height(other.box), h) * 0.5 &&
          other.text.trim() !== '',
      );
      if (neighbour !== undefined && neighbour.text.length <= 70 && emptyShare >= 0.25) {
        const text = neighbour.text.split('\n').join(' ');
        if (nameable(text)) {
          produced.push(
            textCandidate(shrunk, text, 'high', 'cell', 10, h > MULTILINE_HEIGHT ? { multiline: true } : {}),
          );
          continue;
        }
      }
      // Label: the header of the column, when the table is a grid to be filled in.
      const header =
        emptyBody < 0.6
          ? undefined
          : cells.find(
              (other) =>
                other.row === 0 &&
                cell.row > 0 &&
                other.text.trim() !== '' &&
                overlapX(other.box, cell.box) > width(cell.box) * 0.6,
            );
      if (header !== undefined && header.text.length <= 40 && nameable(header.text)) {
        headed.push({
          header,
          candidate: textCandidate(
            shrunk,
            `${header.text.split('\n').join(' ')} ${cell.row}`,
            'medium',
            'cell',
            10,
          ),
        });
      }
    }
    // A column to fill in has several empty cells under its header; one cell is not a column.
    for (const entry of headed) {
      if (headed.filter((other) => other.header === entry.header).length >= 2) produced.push(entry.candidate);
    }
    // A table that is mostly empty cells with a label here and there is a layout, not a form.
    if (produced.length <= 80) out.push(...produced);
  }
  return out;
}

// ---- checkboxes and radio buttons -----------------------------------------

/** A label beside a small mark: to its right first, else to its left. */
function labelBeside(context: Context, box: Box): TextRun | null {
  const h = Math.max(height(box), 6);
  let right: TextRun | null = null;
  let left: TextRun | null = null;
  for (const run of context.runs) {
    if (!nameable(run.text, MAX_OPTION_TEXT, MAX_OPTION_WORDS)) continue;
    if (overlapY(run.box, box) < Math.min(h, height(run.box)) * 0.4) continue;
    const gapRight = run.box[0] - box[2];
    if (gapRight >= -1.5 && gapRight <= 14 && (right === null || run.box[0] < right.box[0])) right = run;
    const gapLeft = box[0] - run.box[2];
    if (gapLeft >= -1.5 && gapLeft <= 12 && (left === null || run.box[2] > left.box[2])) left = run;
  }
  return right ?? left;
}

interface Mark {
  readonly box: Box;
  readonly source: 'glyph' | 'drawn';
  readonly size: number;
}

/** The side a glyph's mark is drawn at: a ☐ is smaller than its em box. */
function glyphMark(glyph: { box: Box; size: number }): Box {
  const side = Math.min(16, Math.max(8, glyph.size * 0.8));
  const cx = (glyph.box[0] + glyph.box[2]) / 2;
  const cy = midY(glyph.box);
  return [cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2];
}

function markCandidates(context: Context): RawCandidate[] {
  const { page } = context;
  const out: RawCandidate[] = [];

  const checks: Mark[] = [];
  const combCells = new Set(combs(allRects(page)).flatMap((group) => group.cells));
  for (const shape of allRects(page)) {
    const w = width(shape.box);
    const h = height(shape.box);
    if (combCells.has(shape)) continue;
    if (w < CHECK_MIN || h < CHECK_MIN || w > CHECK_MAX || h > CHECK_MAX || !squareish(shape.box)) continue;
    if (shape.luminance !== null && shape.luminance < DARK_FILL) continue;
    if (!shape.stroked && (shape.luminance === null || shape.luminance >= WHITE_FILL)) continue;
    checks.push({ box: shape.box, source: 'drawn', size: h });
  }
  for (const glyph of context.glyphs) {
    if (CHECK_GLYPHS.has(glyph.c)) checks.push({ box: glyphMark(glyph), source: 'glyph', size: glyph.size });
  }
  for (const mark of checks) {
    if (
      mark.source === 'drawn' &&
      (holdsInk(page, mark.box, 1) ||
        holdsText(context, mark.box) ||
        touchesText(context, mark.box) ||
        crowded(page, mark.box))
    )
      continue;
    const label = labelBeside(context, mark.box);
    if (label === null) continue;
    out.push({
      kind: 'checkbox',
      rect: mark.box,
      label: label.text,
      confidence: 'high',
      source: mark.source === 'glyph' ? 'glyph' : 'square',
      size: label.size,
    });
  }

  // Radio buttons: circles (or ○), at least two aligned.
  const circles: Mark[] = [];
  for (const shape of page.circles) {
    const w = width(shape.box);
    const h = height(shape.box);
    if (w < CHECK_MIN || h < CHECK_MIN || w > CHECK_MAX || h > CHECK_MAX || !squareish(shape.box)) continue;
    if (shape.luminance !== null && shape.luminance < DARK_FILL) continue;
    if (!shape.stroked && (shape.luminance === null || shape.luminance >= WHITE_FILL)) continue;
    if (holdsInk(page, shape.box, 1.2) || holdsText(context, shape.box) || touchesText(context, shape.box))
      continue;
    if (crowded(page, shape.box)) continue;
    circles.push({ box: shape.box, source: 'drawn', size: h });
  }
  for (const glyph of context.glyphs) {
    if (RADIO_GLYPHS.has(glyph.c)) circles.push({ box: glyphMark(glyph), source: 'glyph', size: glyph.size });
  }
  out.push(...radioCandidates(context, circles));
  return out;
}

function radioCandidates(context: Context, circles: readonly Mark[]): RawCandidate[] {
  const labelled = circles
    .map((mark) => ({ mark, label: labelBeside(context, mark.box) }))
    .filter((entry): entry is { mark: Mark; label: TextRun } => entry.label !== null);
  const groups: { mark: Mark; label: TextRun }[][] = [];
  const taken = new Set<unknown>();
  const sorted = [...labelled].sort((a, b) => a.mark.box[1] - b.mark.box[1] || a.mark.box[0] - b.mark.box[0]);
  // Columns first (a question with options listed under it), then rows.
  for (const axis of ['column', 'row'] as const) {
    for (const start of sorted) {
      if (taken.has(start)) continue;
      const chain = [start];
      let last = start;
      for (const next of sorted) {
        if (taken.has(next) || chain.includes(next)) continue;
        const aligned =
          axis === 'column'
            ? Math.abs(next.mark.box[0] - last.mark.box[0]) <= 3 &&
              next.mark.box[1] - last.mark.box[3] <= 28 &&
              next.mark.box[1] > last.mark.box[1]
            : Math.abs(midY(next.mark.box) - midY(last.mark.box)) <= 3 &&
              next.mark.box[0] - last.label.box[2] <= 70 &&
              next.mark.box[0] > last.mark.box[2];
        if (aligned) {
          chain.push(next);
          last = next;
        }
      }
      if (chain.length >= 2) {
        for (const entry of chain) taken.add(entry);
        groups.push(chain);
      }
    }
  }
  const out: RawCandidate[] = [];
  groups.forEach((group, index) => {
    const first = group[0] as { mark: Mark; label: TextRun };
    // The group is named by what asks the question: left of the first circle on its row,
    // else the line above it.
    const rowBand: Box = first.mark.box;
    const left = labelLeft(context.labels, first.mark.box[0], rowBand, 200);
    const above = labelAbove(context.labels, [
      first.mark.box[0],
      first.mark.box[1] - 4,
      first.mark.box[2],
      first.mark.box[3],
    ]);
    const asking = left ?? above;
    for (const entry of group) {
      out.push({
        kind: 'radio',
        rect: entry.mark.box,
        label: asking?.text ?? '',
        confidence: asking === null ? 'medium' : 'high',
        source: entry.mark.source === 'glyph' ? 'glyph' : 'circle',
        size: entry.label.size,
        group: `radio-${index}`,
        option: entry.label.text,
      });
    }
  });
  return out;
}

// ---- labels that end in a colon -------------------------------------------

function colonCandidates(context: Context): RawCandidate[] {
  const { page } = context;
  const out: RawCandidate[] = [];
  for (const run of context.labels) {
    const text = run.text.trim();
    if (!/[:：]$/.test(text) || text.length > 32 || text.split(/\s+/).length > 4 || !nameable(text)) continue;
    const row: Box = [run.box[2], run.box[1], page.width, run.box[3]];
    const next = context.runs
      .filter(
        (other) =>
          other !== run && other.box[0] > run.box[2] && overlapY(other.box, row) > height(run.box) * 0.4,
      )
      .reduce<TextRun | null>(
        (nearest, other) => (nearest === null || other.box[0] < nearest.box[0] ? other : nearest),
        null,
      );
    const right = Math.min(next === null ? page.width - 36 : next.box[0] - 6, page.width - 36);
    const x0 = run.box[2] + 4;
    if (right - x0 < 70) continue;
    // The last line of a paragraph also ends in a colon and has room after it; the line above
    // it, long and starting at the same place, tells them apart from a form's label.
    const continues = context.runs.some(
      (other) =>
        other !== run &&
        other.text.length >= 40 &&
        Math.abs(other.box[0] - run.box[0]) <= 3 &&
        run.box[1] - other.box[3] >= -3 &&
        run.box[1] - other.box[3] <= run.size * 1.1,
    );
    if (continues) continue;
    const rect: Box = [x0, run.box[1] - 1, right, run.box[3] + 1];
    out.push(textCandidate(rect, text, 'medium', 'colon', run.size));
  }
  return out;
}

// ---------------------------------------------------------------------------
// the whole page
// ---------------------------------------------------------------------------

/** How a conflict between two candidates is settled: the earlier source wins. */
const PRIORITY: readonly CandidateSource[] = [
  'square',
  'circle',
  'glyph',
  'comb',
  'box',
  'cell',
  'line',
  'blank',
  'colon',
];

function dropOverlaps(candidates: readonly RawCandidate[]): RawCandidate[] {
  const ordered = [...candidates].sort(
    (a, b) =>
      PRIORITY.indexOf(a.source) - PRIORITY.indexOf(b.source) ||
      a.rect[1] - b.rect[1] ||
      a.rect[0] - b.rect[0],
  );
  const kept: RawCandidate[] = [];
  for (const candidate of ordered) {
    const area = Math.max(1, width(candidate.rect) * height(candidate.rect));
    const clash = kept.some((other) => {
      const shared = intersectionArea(candidate.rect, other.rect);
      return shared > 0 && shared / Math.min(area, Math.max(1, width(other.rect) * height(other.rect))) > 0.3;
    });
    if (!clash) kept.push(candidate);
  }
  return kept.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
}

/** The fields a page suggests, in the page's displayed space, top to bottom. */
export function detectPageFields(page: DetectionPage): RawCandidate[] {
  const context = contextOf(page);
  const { candidates: boxed, boxes } = boxCandidates(context);
  const all = [
    ...boxed,
    ...cellCandidates(context),
    ...ruleCandidates(context, boxes),
    ...blankCandidates(context),
    ...markCandidates(context),
    ...colonCandidates(context),
  ].filter((candidate) => {
    // Lettering far smaller than the page's own text is a figure's labels, a keyboard's keys.
    if (candidate.size < context.bodySize * TINY_RATIO) return false;
    const [x0, y0, x1, y1] = candidate.rect;
    return x0 >= -1 && y0 >= -1 && x1 <= page.width + 1 && y1 <= page.height + 1 && x1 > x0 && y1 > y0;
  });
  const settled = dropOverlaps(all);
  // A scan's rules are read from pixels: even a labelled one is a guess about the picture.
  return page.raster === true
    ? settled.map((candidate) =>
        candidate.source === 'line' ? { ...candidate, confidence: 'medium' as const } : candidate,
      )
    : settled;
}

// ---------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------

/** What a field is called when its page offers no label. */
const FALLBACK_NAME: Record<CandidateKind, string> = {
  text: 'Text',
  checkbox: 'Checkbox',
  radio: 'Radio',
  signature: 'Signature',
};

/**
 * Names from labels: tidy, never empty, with no period, and unique among `taken` (the
 * document's existing fields) and each other. A repeat gets a number (`Ad Soyad 2`).
 */
export function uniqueName(label: string, kind: CandidateKind, taken: Set<string>): string {
  const base = cleanLabel(label) === '' ? FALLBACK_NAME[kind] : cleanLabel(label);
  let name = base;
  for (let count = 2; taken.has(name.toLowerCase()); count += 1) name = `${base} ${count}`;
  taken.add(name.toLowerCase());
  return name;
}
