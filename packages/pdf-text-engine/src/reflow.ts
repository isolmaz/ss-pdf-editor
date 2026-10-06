/**
 * Block-local reflow: line breaking, alignment
 * (left/centre/right/justify), hyphenation, leading, paragraph spacing and
 * indentation, laid out **inside the block's own box**, with the box growing or
 * shrinking and an auto-shrink path for content that does not fit (`fit/auto-shrink`).
 * Page flow and overflow stay out of scope (`4d-2`, a research line).
 *
 * Geometry is the package's one coordinate space: unrotated PDF user space, top-left
 * origin, y downwards, points. Lines are laid out **horizontally**, which is exactly
 * what the writer's request can express (a line carries a baseline start point and a
 * size; there is no rotation field), so a rotated block belongs to `4b`'s
 * not-editable set rather than to this module.
 *
 * The measurement is the spike's: greedy breaking over the font's own advances
 * (it wrapped on
 * `font.advanceGlyph(gid, 0) * size`), with the placement derived from the lines being
 * replaced (`replace.ts:74-95`: leading from the baselines, the block's widest line as
 * the wrap width). The spike's own `advanceScale` calibration came out at 0.9993
 * (`NOTES.md`, case a: measured 317.724 pt / advance sum 28.903), i.e. the advance is
 * already em-relative — `unitsPerEm` is therefore the only conversion, and no fudge
 * factor belongs anywhere in this file.
 */
import { ToolError } from 'pdf-shared';
import type {
  FontMetrics,
  LaidOutLine,
  LaidOutWord,
  Rect,
  ReflowRequest,
  ReflowResult,
  TextAlign,
  TextBlock,
} from './types';

const ENGINE = 'pdf-text-engine';

/**
 * Leading used when neither the options nor the block supplies a usable one, as a
 * fraction of the font size. 1.2 em is the classic single-spaced default
 * (ascender + descender + lineGap) and the only size-independent choice; the spike
 * passed its fixture's own leading in instead (`replace.ts:83-91`'s `fallbackLeading`,
 * 18 pt at the 11 pt body size, an early engine spike) because
 * the harness knew the fixture — a model of an arbitrary document does not.
 */
export const DEFAULT_LEADING_RATIO = 1.2;

/**
 * Ascent used to place the first baseline inside the box when the font's own ascender
 * is not positive. 0.8 em is the common Latin ascent; without the fallback, a metric
 * table reporting a zero ascender would put every baseline exactly on the box top and
 * every line's ink above it.
 */
const DEFAULT_ASCENT_RATIO = 0.8;

/**
 * Auto-shrink step, in points. Half a point is the smallest size difference the UI can
 * present as a distinct choice, and it bounds the search to
 * `2 x (fontSize - minFontSize)` layouts — a deterministic walk rather than a
 * numerical fit, which is what `4d-1`'s "fit / auto-shrink" needs to be reproducible.
 */
const SHRINK_STEP_PT = 0.5;

/**
 * Slack when deciding "does it fit", in points. The spike's advance calibration was
 * 0.9993 (0.07 %, `NOTES.md` case a), which is 0.21 pt on its widest measured line
 * (317.724 pt) — so a quarter point absorbs the only error the measurement is known
 * to carry, while staying far below a space (2.75 pt at 11 pt) and below the 1 pt
 * alignment tolerance. Without it, a line that fits exactly would be reported as
 * overflowing by a rounding error.
 */
const FIT_EPSILON_PT = 0.25;

/** Below this the layout is meaningless and a shrink loop would only spin. */
const MIN_FONT_SIZE_PT = 1;

/** Code points a hyphenated word has to keep on both sides of the break. A
 *  single-character fragment is not a word part in any of the product's languages,
 *  and the requirement is also what guarantees the breaking loop makes progress. */
const MIN_HYPHEN_PART = 2;

const HYPHEN = '-';
const SPACE = ' ';

/** The reflow box, resolved from the options or the block (see `ReflowOptions.box`). */
interface BoxGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** `Number.POSITIVE_INFINITY` when the box was derived from the block: the box's
   *  width is the block's, its height is free (`4d-1`: the box grows). */
  readonly height: number;
}

/** Everything a layout attempt needs except the font size being attempted. */
interface PassOptions {
  readonly metrics: FontMetrics;
  readonly box: BoxGeometry;
  readonly align: TextAlign;
  readonly leading: number;
  readonly indent: number;
  readonly paragraphSpacing: number;
  readonly hyphenate: boolean;
}

/** A line as the breaker produced it, before alignment and baselines are known. */
interface BrokenLine {
  readonly text: string;
  /** The words of `text`, in order — the breaker's own word list, so a consumer can
   *  place them individually without re-splitting the string. */
  readonly words: readonly string[];
  /** Distance from the box's left edge where the line's content area starts. */
  readonly indent: number;
  /** Natural advance width of `text`, in points. */
  readonly natural: number;
  /** True when the natural width does not fit the line's content area. */
  readonly overflow: boolean;
}

interface PassResult {
  readonly lines: readonly LaidOutLine[];
  readonly rect: Rect;
  readonly overflow: boolean;
  readonly hyphenated: readonly string[];
}

/**
 * Natural advance width of `text` at `fontSize`, in points — the quantity the spike
 * broke lines on (`replace.ts:203-212`). Needed by the breaker and by anything that
 * has to predict what the writer will actually draw.
 */
export function measureLineWidth(text: string, fontSize: number, metrics: FontMetrics): number {
  const scale = fontSize / metrics.unitsPerEm;
  let total = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    total += metrics.glyphAdvance(codePoint) * scale;
  }
  return total;
}

/**
 * Lay `text` out in `request.block`'s box.
 *
 * The result is deterministic: the breaker is greedy, the shrink walk is a fixed
 * 0.5 pt series, and ties never depend on iteration order of anything but the input
 * text. An empty text occupies no height and returns no lines.
 */
export function reflowBlock(request: ReflowRequest, metrics: FontMetrics): ReflowResult {
  const { block, text } = request;
  const options = request.options;
  if (!(metrics.unitsPerEm > 0)) {
    throw new ToolError('unsupported', {
      engine: ENGINE,
      engineMessage: `unitsPerEm ${metrics.unitsPerEm}`,
    });
  }
  const requestedSize = options?.fontSize ?? block.style.fontSize;
  if (!(requestedSize > 0)) {
    throw new ToolError('range-invalid', {
      engine: ENGINE,
      engineMessage: `fontSize ${requestedSize}`,
    });
  }
  const indent = options?.indent ?? 0;
  const paragraphSpacing = options?.paragraphSpacing ?? 0;
  if (indent < 0 || paragraphSpacing < 0) {
    throw new ToolError('range-invalid', {
      engine: ENGINE,
      engineMessage: `indent ${indent}, paragraphSpacing ${paragraphSpacing}`,
    });
  }
  const declaredLeading = options?.leading ?? block.style.leading;
  // A non-positive leading would stack every line on one baseline — that is not a
  // tighter layout, it is a broken one, so it falls back like a missing value.
  const leading = declaredLeading > 0 ? declaredLeading : requestedSize * DEFAULT_LEADING_RATIO;
  // Clamp both ways: a minimum above the requested size would *grow* the text, and a
  // minimum below the floor is a size nobody can read.
  const minSize = Math.min(Math.max(options?.minFontSize ?? requestedSize, MIN_FONT_SIZE_PT), requestedSize);
  const pass: PassOptions = {
    metrics,
    box: boxGeometry(block, options?.box ?? null),
    align: options?.align ?? block.align,
    leading,
    indent,
    paragraphSpacing,
    hyphenate: options?.hyphenate ?? false,
  };
  for (let size = requestedSize; ; size -= SHRINK_STEP_PT) {
    const attempt = Math.max(size, minSize);
    const result = layoutPass(pass, text, attempt);
    if (!result.overflow || attempt <= minSize) {
      return {
        lines: result.lines,
        rect: result.rect,
        overflow: result.overflow,
        fontSize: attempt,
        hyphenated: result.hyphenated,
      };
    }
  }
}

/** One layout attempt at one font size, from paragraph splitting to baselines. */
function layoutPass(pass: PassOptions, text: string, fontSize: number): PassResult {
  const { metrics, box, align, leading, indent, paragraphSpacing, hyphenate } = pass;
  const ascent = ascentOf(metrics, fontSize);
  const descent = (metrics.descender * fontSize) / metrics.unitsPerEm;
  const paragraphs = paragraphsOf(text);
  const hyphenated: string[] = [];
  const lines: LaidOutLine[] = [];
  let rect: Rect | null = null;
  // Distance from the box's top edge to the current line's top edge.
  let top = 0;
  let overflow = false;
  for (let index = 0; index < paragraphs.length; index += 1) {
    const words = paragraphs[index];
    if (words === undefined) continue;
    if (index > 0) top += paragraphSpacing;
    const broken = breakParagraph(words, indent, box.width, fontSize, metrics, hyphenate, hyphenated);
    for (let position = 0; position < broken.length; position += 1) {
      const line = broken[position];
      if (line === undefined) continue;
      const available = box.width - line.indent;
      const lastOfParagraph = position === broken.length - 1;
      // A justified line stretches its word spaces to reach the box's right edge, and
      // that stretch travels to the consumer as per-word positions (`words`) because
      // the inter-word space is the only thing justification changes. The last line of
      // a paragraph is not justified (typographic convention: it is the line that shows
      // where the paragraph ends), and a single-word line has no space to stretch, so
      // both keep their natural positions.
      const justify =
        align === 'justify' && !lastOfParagraph && line.text.includes(SPACE) && line.natural < available;
      const width = justify ? available : line.natural;
      const start = box.x + line.indent + lineOffset(align, available, width, justify);
      const baseline = box.y + top + ascent;
      const lineRect: Rect = [start, baseline - ascent, start + width, baseline - descent];
      if (line.overflow) overflow = true;
      rect = rect === null ? lineRect : unionPair(rect, lineRect);
      lines.push({
        text: line.text,
        rect: lineRect,
        baseline,
        width,
        justified: justify,
        words: wordPositions(line, start, available, fontSize, metrics, justify),
      });
      top += leading;
    }
  }
  if (rect !== null && rect[3] - box.y > box.height + FIT_EPSILON_PT) overflow = true;
  // An empty text occupies no height: a zero-area rect at the box's top-left corner.
  const occupied: Rect = rect === null ? [box.x, box.y, box.x, box.y] : rect;
  return {
    lines,
    rect: occupied,
    overflow,
    hyphenated,
  };
}

/**
 * Greedy line breaking for one paragraph, with `indent` for its first line.
 *
 * A word that does not fit alone is only broken when `hyphenate` is on, and then at a
 * **code-point boundary** with a hyphen — no language dictionary is consulted, so this
 * is the deterministic half of `4d-1`'s hyphenation: it never invents a bad syllable
 * break, it just does not know the good ones. A word that still cannot fit (a box
 * narrower than `MIN_HYPHEN_PART` characters plus a hyphen) is placed whole and shows
 * up as an overflow, which is the honest answer rather than an endless loop.
 */
function breakParagraph(
  words: readonly string[],
  indent: number,
  maxWidth: number,
  fontSize: number,
  metrics: FontMetrics,
  hyphenate: boolean,
  hyphenated: string[],
): readonly BrokenLine[] {
  const spaceWidth = measureLineWidth(SPACE, fontSize, metrics);
  const lines: BrokenLine[] = [];
  let line = '';
  let lineWords: string[] = [];
  let lineWidth = 0;
  let lineIndent = indent;
  const flush = (): void => {
    if (line === '') return;
    lines.push({
      text: line,
      words: lineWords,
      indent: lineIndent,
      natural: lineWidth,
      overflow: lineWidth > maxWidth - lineIndent + FIT_EPSILON_PT,
    });
    line = '';
    lineWords = [];
    lineWidth = 0;
    lineIndent = 0;
  };
  for (let index = 0; index < words.length; index += 1) {
    const entry = words[index];
    if (entry === undefined) continue;
    // The current fragment of the word: hyphenation replaces it with the remainder,
    // so it is mutable while the entry it started from is not.
    let word = entry;
    // One word can take several iterations: first it is tried on the current line,
    // then on a fresh one, then broken if the caller allowed it.
    for (;;) {
      const available = maxWidth - lineIndent;
      const wordWidth = measureLineWidth(word, fontSize, metrics);
      const candidateWidth = line === '' ? wordWidth : lineWidth + spaceWidth + wordWidth;
      if (candidateWidth <= available + FIT_EPSILON_PT) {
        const first = line === '';
        lineWords.push(word);
        line = first ? word : `${line} ${word}`;
        lineWidth = candidateWidth;
        break;
      }
      if (line !== '') {
        flush();
        continue;
      }
      const split: { readonly head: string; readonly rest: string } | null = hyphenate
        ? hyphenateWord(word, available, fontSize, metrics)
        : null;
      if (split === null) {
        line = word;
        lineWords.push(word);
        lineWidth = wordWidth;
        break;
      }
      hyphenated.push(word);
      line = split.head;
      lineWords.push(split.head);
      lineWidth = measureLineWidth(split.head, fontSize, metrics);
      flush();
      word = split.rest;
    }
  }
  flush();
  return lines;
}

/** `head` (with the hyphen) and the `rest`, or `null` when no break leaves
 *  `MIN_HYPHEN_PART` code points on both sides. */
function hyphenateWord(
  word: string,
  available: number,
  fontSize: number,
  metrics: FontMetrics,
): { readonly head: string; readonly rest: string } | null {
  const characters = [...word];
  const limit = characters.length - MIN_HYPHEN_PART;
  let head = '';
  for (let index = 0; index < limit; index += 1) {
    const character = characters[index];
    if (character === undefined) break;
    const candidate = `${head}${character}${HYPHEN}`;
    if (measureLineWidth(candidate, fontSize, metrics) > available) break;
    head += character;
  }
  if ([...head].length < MIN_HYPHEN_PART) return null;
  return { head: `${head}${HYPHEN}`, rest: word.slice(head.length) };
}

/** Paragraphs as word lists: hard breaks start a new one, space runs collapse, and an
 *  empty paragraph is dropped (it carries no ink — the space between paragraphs is
 *  `paragraphSpacing`'s job). NBSP is deliberately **not** collapsed and **not** a
 *  break: it is the text's own "do not break here" marker. */
function paragraphsOf(text: string): readonly (readonly string[])[] {
  const paragraphs: string[][] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const collapsed = raw.replace(/[ \t\f\r]+/g, SPACE).trim();
    if (collapsed === '') continue;
    paragraphs.push(collapsed.split(SPACE));
  }
  return paragraphs;
}

/** Where a line's content starts, relative to its content area. */
function lineOffset(align: TextAlign, available: number, width: number, justify: boolean): number {
  if (justify || align === 'left') return 0;
  if (align === 'right') return available - width;
  if (align === 'center') return (available - width) / 2;
  // `justify` on a line that was not stretched (the last one, or a single word).
  return 0;
}

/**
 * Final x of every word on a line, advancing from the line's own start: `natural`
 * spacing when the line was not stretched, and an equal share of the slack added to
 * every inter-word space when it was — which puts the last word's end exactly on the
 * content area's right edge (`start + available`). Word-by-word placement is how a
 * justified line reaches the box edge at all; a consumer that has no word-spacing
 * control draws the whole string at the line's `x` instead.
 */
function wordPositions(
  line: BrokenLine,
  start: number,
  available: number,
  fontSize: number,
  metrics: FontMetrics,
  stretched: boolean,
): readonly LaidOutWord[] {
  const count = line.words.length;
  const spaceWidth = measureLineWidth(SPACE, fontSize, metrics);
  // A single word has no space to stretch; `stretched` always implies more than one.
  const slack = stretched && count > 1 ? (available - line.natural) / (count - 1) : 0;
  const positions: LaidOutWord[] = [];
  let x = start;
  for (const word of line.words) {
    positions.push({ text: word, x });
    x += measureLineWidth(word, fontSize, metrics) + spaceWidth + slack;
  }
  return positions;
}

/** Baseline offset from the line's top edge, falling back when the font reports no
 *  usable ascender (see `DEFAULT_ASCENT_RATIO`). */
function ascentOf(metrics: FontMetrics, fontSize: number): number {
  const ascent = (metrics.ascender * fontSize) / metrics.unitsPerEm;
  return ascent > 0 ? ascent : fontSize * DEFAULT_ASCENT_RATIO;
}

/** The box to lay out in: the caller's, or the block's width with a free height. */
function boxGeometry(block: TextBlock, box: Rect | null): BoxGeometry {
  const source = box ?? block.rect;
  const width = source[2] - source[0];
  const height = box === null ? Number.POSITIVE_INFINITY : source[3] - source[1];
  if (!(width > 0)) {
    throw new ToolError('range-invalid', { engine: ENGINE, engineMessage: `box width ${width}` });
  }
  if (!(height > 0)) {
    throw new ToolError('range-invalid', { engine: ENGINE, engineMessage: `box height ${height}` });
  }
  return { x: source[0], y: source[1], width, height };
}

function unionPair(left: Rect, right: Rect): Rect {
  return [
    Math.min(left[0], right[0]),
    Math.min(left[1], right[1]),
    Math.max(left[2], right[2]),
    Math.max(left[3], right[3]),
  ];
}
