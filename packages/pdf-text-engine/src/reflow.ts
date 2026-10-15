/**
 * Block-local reflow: line breaking, alignment
 * (left/centre/right/justify), hyphenation, leading, paragraph spacing and
 * indentation, laid out **inside the block's own box**, with the box growing or
 * shrinking and an auto-shrink path for content that does not fit (`fit/auto-shrink`).
 * Page flow and overflow stay out of scope.
 *
 * Geometry is the package's one coordinate space: unrotated PDF user space, top-left
 * origin, y downwards, points. Lines are laid out **horizontally**, which is exactly
 * what the writer's request can express (a line carries a baseline start point and a
 * size; there is no rotation field), so a rotated block belongs to the
 * not-editable set (`measureEditability`) rather than to this module.
 *
 * The measurement is greedy breaking over the font's own advances
 * (`font.advanceGlyph(gid, 0) * size`), with the placement derived from the lines being
 * replaced (leading from the baselines, the block's widest line as the wrap width).
 * The advance is already em-relative (a measured 317.724 pt line against an advance
 * sum of 28.903 em gives a scale of 0.9993) — `unitsPerEm` is therefore the only
 * conversion, and no fudge factor belongs anywhere in this file.
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
 * (ascender + descender + lineGap) and the only size-independent choice: a model of an
 * arbitrary document has no leading of its own to offer.
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
 * numerical fit, which keeps "fit / auto-shrink" reproducible.
 */
const SHRINK_STEP_PT = 0.5;

/**
 * Slack when deciding "does it fit", in points. The advance calibration is
 * 0.9993 (0.07 %), which is 0.21 pt on the widest measured line
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

/**
 * Ideographic text — Han, kana, Bopomofo, the CJK and full-width punctuation: a line
 * may break between any two of these characters, because the script has no spaces to
 * break at. Hangul is **not** here: Korean is written with spaces, and its words break
 * there like any other.
 */
const IDEOGRAPHIC_CLASS = String.raw`\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Bopomofo}\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff60\uffe0-\uffe6`;

/**
 * Thai, Lao, Khmer and Burmese: also written without spaces, but a break between two
 * of their characters is wrong — the break has to fall between *words*, which only a
 * dictionary knows, so the runtime's own (`Intl.Segmenter`) says where they are.
 */
const DICTIONARY_CLASS = String.raw`\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}`;

const IDEOGRAPHIC = new RegExp(`^[${IDEOGRAPHIC_CLASS}]`, 'u');
const DICTIONARY_SCRIPT = new RegExp(`^[${DICTIONARY_CLASS}]`, 'u');
/** Whether a piece of text holds a character of either kind: the only text that has break points inside a word. */
const UNSPACED = new RegExp(`[${IDEOGRAPHIC_CLASS}${DICTIONARY_CLASS}]`, 'u');

/** A piece of text that starts with a character that never begins a line: closing marks, sentence punctuation, the prolonged-sound mark, small kana. */
const NO_LINE_START =
  /^[、。，．・：；！？）］｝〕〉》」』】〙〗〟’”‥…ー々ゝゞヽヾぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ)\]}!?,.:;ๆ]/u;
/** A piece of text that ends with a character that never ends a line: an opening bracket or quote. */
const NO_LINE_END = /[（［｛〔〈《「『【〘〖〝‘“([{]$/u;

// `und` is the root locale: the break points must not depend on the language of the machine.
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });
const WORDS = new Intl.Segmenter('und', { granularity: 'word' });

/** The reflow box, resolved from the options or the block (see `ReflowOptions.box`). */
interface BoxGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** `Number.POSITIVE_INFINITY` when the box was derived from the block: the box's
   *  width is the block's, its height is free (the box grows). */
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
   *  place them individually without re-splitting the string. A word of text written
   *  without spaces may continue on the next line: the entry is then its part on this one. */
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
 * Natural advance width of `text` at `fontSize`, in points — the quantity lines are
 * broken on. Needed by the breaker and by anything that
 * has to predict what the writer will actually draw.
 */
export function measureLineWidth(text: string, fontSize: number, metrics: FontMetrics): number {
  const scale = fontSize / metrics.unitsPerEm;
  let total = 0;
  for (const character of text) {
    // A string iterator yields whole code points, never an empty string.
    total += metrics.glyphAdvance(character.codePointAt(0) as number) * scale;
  }
  return total;
}

/**
 * Lay `text` out in `request.block`'s box.
 *
 * The result is deterministic: the breaker is greedy, the shrink walk is a fixed
 * 0.5 pt series, and ties never depend on iteration order of anything but the input
 * text. An empty text occupies no height and returns no lines.
 *
 * Lines break at spaces, and — for text written without them — between ideographic
 * characters (Chinese, Japanese) and between the words of Thai, Lao, Khmer and Burmese
 * (`unitsOf`). Such a break adds no space and no hyphen. The one input that is not this
 * package's own is the word dictionary behind the Thai-family breaks: it is the
 * runtime's (`Intl.Segmenter`), so those break points follow its ICU data.
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
  for (const [index, words] of paragraphs.entries()) {
    if (index > 0) top += paragraphSpacing;
    const broken = breakParagraph(words, indent, box.width, fontSize, metrics, hyphenate, hyphenated);
    for (const [position, line] of broken.entries()) {
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
 * `tokens` are the paragraph's space-separated words, each as the break units it is made
 * of (`unitsOf`): one unit for a word of a spaced language, several for text written
 * without spaces. A line may end between two tokens (the space is dropped) and between
 * two units of one token (nothing is added: the pieces were adjacent in the text, and
 * stay adjacent on the next line).
 *
 * A word that does not fit alone is only broken when `hyphenate` is on, and then at a
 * **code-point boundary** with a hyphen — no language dictionary is consulted, so this
 * is the deterministic half of hyphenation: it never invents a bad syllable
 * break, it just does not know the good ones. Only a word of a spaced language is
 * hyphenated: text that has break points of its own never gets a hyphen. A unit that
 * still cannot fit (a box narrower than `MIN_HYPHEN_PART` characters plus a hyphen) is
 * placed whole and shows up as an overflow, which is the honest answer rather than an
 * endless loop.
 */
function breakParagraph(
  tokens: readonly (readonly string[])[],
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
  // Only ever called with a non-empty line: words are never empty (`paragraphsOf`), every
  // word ends up on the line before the next flush, and the last word is still on it.
  const flush = (): void => {
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
  for (const units of tokens) {
    // `unitsOf` never answers an empty list, so the first unit exists. A word whose only
    // unit holds ideographic or dictionary-script text is no spaced-language word.
    const hyphenatable = hyphenate && units.length === 1 && !UNSPACED.test(units[0] as string);
    for (const [position, entry] of units.entries()) {
      // The current fragment of the unit: hyphenation replaces it with the remainder,
      // so it is mutable while the entry it started from is not.
      let word = entry;
      // One unit can take several iterations: first it is tried on the current line,
      // then on a fresh one, then broken if the caller allowed it.
      for (;;) {
        const available = maxWidth - lineIndent;
        const wordWidth = measureLineWidth(word, fontSize, metrics);
        // A unit after the first continues its token: it follows the previous one
        // directly when they share a line, and starts a fragment of its own when they
        // do not (the line was flushed in between, so `line` is empty).
        const continues = position > 0 && line !== '';
        const candidateWidth = line === '' ? wordWidth : lineWidth + (continues ? 0 : spaceWidth) + wordWidth;
        if (candidateWidth <= available + FIT_EPSILON_PT) {
          if (continues) {
            // `line` is not empty, so a fragment of this token is on it already.
            lineWords.push(`${lineWords.pop() as string}${word}`);
            line += word;
          } else {
            lineWords.push(word);
            line = line === '' ? word : `${line} ${word}`;
          }
          lineWidth = candidateWidth;
          break;
        }
        if (line !== '') {
          flush();
          continue;
        }
        const split: { readonly head: string; readonly rest: string } | null = hyphenatable
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
  let head = '';
  // The last `MIN_HYPHEN_PART` code points always stay for the rest.
  for (const character of characters.slice(0, characters.length - MIN_HYPHEN_PART)) {
    const candidate = `${head}${character}${HYPHEN}`;
    if (measureLineWidth(candidate, fontSize, metrics) > available) break;
    head += character;
  }
  if ([...head].length < MIN_HYPHEN_PART) return null;
  return { head: `${head}${HYPHEN}`, rest: word.slice(head.length) };
}

/** Paragraphs as word lists, each word as its break units (`unitsOf`): hard breaks start
 *  a new paragraph, space runs collapse, and an empty paragraph is dropped (it carries no
 *  ink — the space between paragraphs is `paragraphSpacing`'s job). NBSP is deliberately
 *  **not** collapsed and **not** a break: it is the text's own "do not break here" marker. */
function paragraphsOf(text: string): readonly (readonly (readonly string[])[])[] {
  const paragraphs: (readonly string[])[][] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const collapsed = raw.replace(/[ \t\f\r]+/g, SPACE).trim();
    if (collapsed === '') continue;
    paragraphs.push(collapsed.split(SPACE).map(unitsOf));
  }
  return paragraphs;
}

/**
 * The pieces of one space-delimited word a line may end between; they join back into
 * the word without a gap. A word of a spaced language is one piece — `Segmenter` is not
 * asked about it, so a hyphenated compound or an apostrophe is never a break point.
 *
 * Text written without spaces has break points of its own:
 *  - every ideographic character (Han, kana, CJK punctuation) is a piece, as it is in
 *    CJK typesetting, where a line may end after any of them;
 *  - a run of Thai, Lao, Khmer or Burmese is cut into words by the runtime's
 *    dictionary (`Intl.Segmenter`), because a break inside a word is a misspelling;
 *  - any other run (Latin letters, digits) between them stays whole.
 * Pieces then stick together where a break would be a typographic fault: a closing mark
 * never begins a line (it joins the piece before it) and an opening bracket never ends
 * one (it joins the piece after it). Grapheme clusters are never split.
 */
function unitsOf(word: string): readonly string[] {
  if (!UNSPACED.test(word)) return [word];
  const runs: { kind: 'ideographic' | 'dictionary' | 'other'; text: string }[] = [];
  for (const { segment } of GRAPHEMES.segment(word)) {
    const kind = IDEOGRAPHIC.test(segment)
      ? 'ideographic'
      : DICTIONARY_SCRIPT.test(segment)
        ? 'dictionary'
        : 'other';
    const last = runs[runs.length - 1];
    // Each ideographic character is a piece of its own; the other kinds gather into runs.
    if (kind !== 'ideographic' && last?.kind === kind) last.text += segment;
    else runs.push({ kind, text: segment });
  }
  const pieces: string[] = [];
  for (const run of runs) {
    if (run.kind === 'dictionary') {
      for (const { segment } of WORDS.segment(run.text)) pieces.push(segment);
    } else {
      pieces.push(run.text);
    }
  }
  const units: string[] = [];
  for (const piece of pieces) {
    const previous = units[units.length - 1];
    if (previous !== undefined && (NO_LINE_START.test(piece) || NO_LINE_END.test(previous))) {
      units[units.length - 1] = previous + piece;
    } else {
      units.push(piece);
    }
  }
  return units;
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
