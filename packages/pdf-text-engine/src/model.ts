/**
 * Page-level text model: *block → line → word → glyph* with
 * font, size, colour, leading and alignment inference.
 *
 * Input is the extractor's plain data (`PageTextInput`), output is plain data
 * (`TextPage`). The extractor is anything that can walk a page's structured text —
 * MuPDF's `StructuredText.walk` gives exactly the fields `CharInput` carries
 * (an early engine spike walked block → line → char and kept
 * the quad, which is what makes rotated text solvable without a second code path).
 *
 * ## What this module infers, and from what
 *
 *   - **words** — from the ink gap between consecutive glyph boxes, orientation-aware;
 *   - **lines** — from the extractor's line grouping, with the words' ink box as the
 *     line box and the extractor's baseline kept;
 *   - **blocks** — lines ordered top-to-bottom **only when the block is horizontal**
 *     (the spike ordered lines by their projection on the line's `down` vector,
 *     an early engine spike; sorting a rotated block by the y
 *     scalar would scramble it, so a non-horizontal block keeps the extractor's order);
 *   - **style** — font name (mode), family/weight/italic from the name
 *     (`describeFontName`), size (median glyph size), leading (median baseline
 *     distance), colour (given per block index).
 *
 * Every rect this module emits is an **ink box** in unrotated user space with a
 * top-left origin — never a padded or predicted region, so a caller can always trace
 * a rect back to glyphs.
 */
import { ToolError } from 'pdf-shared';
import { describeFontName } from './fonts';
import { DEFAULT_LEADING_RATIO } from './reflow';
import type {
  BlockInput,
  CharInput,
  GlyphBox,
  LineInput,
  LineOrientation,
  PageTextInput,
  Rect,
  TextAlign,
  TextBlock,
  TextLine,
  TextPage,
  TextStyle,
  TextWord,
} from './types';

const ENGINE = 'pdf-text-engine';

/**
 * A gap above this fraction of the font size is a word gap, not kerning. The same
 * threshold the codebase already uses on extracted text (`WORD_GAP` in
 * `packages/pdf-core/src/ops/text-export.ts:36-37`, where a gap below it is kerning
 * and above it a space): a space is 0.25–0.33 em in every text face the product
 * meets, and side bearings plus kerning stay under 0.1 em, so 0.15 em separates the
 * two populations with room on both sides.
 */
const WORD_GAP_EM = 0.15;

/**
 * Deviation tolerance for the alignment inference, in points. The model has no
 * alignment flag to read, so it compares the block's line edges. 1 pt sits between
 * the spike's two containment tolerances — it padded a target box by 2 pt and then
 * allowed 0.01 pt of slack — and it is well
 * under one space at body sizes (2.75 pt at 11 pt), so a ragged edge cannot pass as
 * a flush one.
 */
const ALIGN_TOLERANCE_PT = 1;

/**
 * Orientation test: how much of the first→last glyph centre vector has to lie on one
 * axis. 0.98 is cos(11.5°): a line whose centres drift more than that off an axis is
 * neither horizontal nor vertical, and 11.5° of drift over a body block already puts
 * the baseline well outside its own leading. The spike carried a per-line direction
 * vector to solve rotation (`textmodel.ts:88-101`, used by `replace.ts:74-95`); this
 * model recovers the same information from the boxes it was given.
 */
const ORIENTATION_COS_LIMIT = 0.98;

/** Colour used when the extractor reported none for a block. */
/**
 * Paragraph merge (the unit a user edits is a paragraph).
 *
 * MuPDF's blocks are *layout* blocks: a three-line paragraph can arrive as three of
 * them, and a model that keeps them apart makes "edit the paragraph" edit one line —
 * which is what the first acceptance run measured (46 prefilled characters for a
 * 140-character paragraph). Consecutive blocks are therefore merged when all four
 * hold, and every one of them is a deliberately conservative test:
 *
 *   1. both are horizontal (a rotated run is never joined to a horizontal one);
 *   2. same font name, and sizes within {@link MERGE_SIZE_TOLERANCE_PT};
 *   3. the gap between the last baseline and the next block's first baseline is
 *      positive and at most {@link MERGE_GAP_RATIO} × the leading the blocks agree on
 *      — a paragraph break is a *larger* gap, and it stays a separate block;
 *   4. the x-extents overlap by at least {@link MERGE_OVERLAP_RATIO} of the narrower
 *      block, so a column beside a paragraph is not swallowed by it.
 */
const MERGE_SIZE_TOLERANCE_PT = 0.5;
const MERGE_GAP_RATIO = 1.6;
const MERGE_OVERLAP_RATIO = 0.5;

const DEFAULT_COLOR = '#000000';

/** `#rrggbb` is the whole colour vocabulary of the model (`TextStyle.color`). */
const COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/**
 * Whitespace the model treats as a word gap. NBSP counts: the model describes ink,
 * and an NBSP occupies a gap like any other space. The reflow is the opposite case —
 * it keeps NBSP as glue, because there it is a *break opportunity* marker.
 */
const WORD_GAP_CHAR = /[ \t\r\n\f\u00a0]/;

/** A glyph's geometry while a line is being segmented. */
interface PositionedGlyph {
  readonly ch: string;
  readonly rect: Rect;
  readonly origin: readonly [number, number];
  readonly size: number;
  /** The extractor reported whitespace right before this glyph: a word starts here. */
  readonly breakBefore: boolean;
}

/** What the block's glyphs say about its style, before leading and colour are added. */
interface StyleFacts {
  readonly fontName: string | null;
  readonly fontFamily: TextStyle['fontFamily'];
  readonly bold: boolean;
  readonly italic: boolean;
  readonly fontSize: number;
}

/**
 * Build the page model. Blocks follow the input order and are identified by their
 * input index (`b0`, `b1`, … — the same index `PageTextInput.colors` is keyed by);
 * a block that carries no glyphs is dropped rather than emitted empty, so every
 * block in the result has at least one line and a non-empty rect.
 */
export function buildTextPage(input: PageTextInput): TextPage {
  const { pageIndex, width, height, rotation, blocks } = input;
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new ToolError('range-invalid', { engine: ENGINE, engineMessage: `pageIndex ${pageIndex}` });
  }
  if (!(width > 0) || !(height > 0)) {
    throw new ToolError('range-invalid', {
      engine: ENGINE,
      pageIndex,
      engineMessage: `page size ${width} x ${height}`,
    });
  }
  const built: TextBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const source = blocks[index];
    if (source === undefined) continue;
    const block = buildBlock(source, index, input);
    if (block !== null) built.push(block);
  }
  // Paragraphs first, ids second: `id` is documented as `b<index>` into the page
  // input and stays that shape, but after a merge the index is the *paragraph's*
  // position, which is what the UI shows and the writer is asked to edit.
  const merged = mergeParagraphBlocks(built);
  return {
    pageIndex,
    width,
    height,
    rotation,
    blocks: merged.map((block, index) => (block.id === `b${index}` ? block : { ...block, id: `b${index}` })),
  };
}

/**
 * Consecutive paragraph lines joined into one block. The criteria are
 * {@link MERGE_SIZE_TOLERANCE_PT}/{@link MERGE_GAP_RATIO}/{@link MERGE_OVERLAP_RATIO};
 * the merged block keeps the first block's style facts, recomputes leading over its
 * own lines (the median is what a paragraph's rhythm is) and infers alignment again
 * against the wider box.
 */
function mergeParagraphBlocks(blocks: readonly TextBlock[]): readonly TextBlock[] {
  const merged: TextBlock[] = [];
  for (const block of blocks) {
    const previous = merged.at(-1);
    if (previous === undefined || !areParagraphNeighbours(previous, block)) {
      merged.push(block);
      continue;
    }
    const lines = orderLines([...previous.lines, ...block.lines]);
    const rect = unionPair(previous.rect, block.rect);
    merged[merged.length - 1] = {
      ...previous,
      rect,
      lines,
      text: lines.map((line) => line.text).join('\n'),
      style: { ...previous.style, leading: leadingOf(lines, previous.style.fontSize) },
      align: inferAlign(lines, rect, rect[2] - rect[0]),
    };
  }
  return merged;
}

/** The four tests {@link mergeParagraphBlocks} documents, in one place. */
function areParagraphNeighbours(previous: TextBlock, block: TextBlock): boolean {
  if (blockOrientation(previous) !== 'horizontal' || blockOrientation(block) !== 'horizontal') return false;
  if (previous.style.fontName !== block.style.fontName) return false;
  if (Math.abs(previous.style.fontSize - block.style.fontSize) > MERGE_SIZE_TOLERANCE_PT) return false;
  const last = previous.lines.at(-1);
  const first = block.lines[0];
  if (last === undefined || first === undefined) return false;
  const gap = first.baseline - last.baseline;
  const leading = Math.max(previous.style.leading, block.style.leading);
  if (!(gap > 0) || gap > leading * MERGE_GAP_RATIO) return false;
  const overlap = Math.min(previous.rect[2], block.rect[2]) - Math.max(previous.rect[0], block.rect[0]);
  const narrower = Math.min(previous.rect[2] - previous.rect[0], block.rect[2] - block.rect[0]);
  return narrower > 0 && overlap >= narrower * MERGE_OVERLAP_RATIO;
}

function buildBlock(source: BlockInput, index: number, input: PageTextInput): TextBlock | null {
  const facts = styleFor(source);
  const lines: TextLine[] = [];
  let rect: Rect | null = null;
  for (const line of source.lines) {
    const built = buildLine(line);
    if (built === null) continue;
    lines.push(built);
    rect = rect === null ? built.rect : unionPair(rect, built.rect);
  }
  if (rect === null || facts === null) return null;
  const ordered = orderLines(lines);
  const style: TextStyle = {
    ...facts,
    leading: leadingOf(ordered, facts.fontSize),
    color: colorOf(input.colors, index),
  };
  return {
    id: `b${index}`,
    rect,
    lines: ordered,
    text: ordered.map((line) => line.text).join('\n'),
    style,
    align: inferAlign(ordered, rect, input.width),
  };
}

/** One line: glyphs segmented into words, the words' ink box, the extractor's baseline. */
function buildLine(source: LineInput): TextLine | null {
  const direction = directionOf(source.chars);
  const positioned: PositionedGlyph[] = [];
  // A whitespace character the extractor reported is a word boundary **by itself**.
  // The ink-gap test below is the fallback for producers that position words without
  // any space glyph; relying on it alone glued words together wherever the glyph boxes
  // abut across the gap (measured on a LaTeX page: "Thisisasampledocumentto"), and an
  // edit then wrote the whole paragraph back without its spaces.
  let sawGap = false;
  for (const char of source.chars) {
    if (WORD_GAP_CHAR.test(char.ch)) {
      sawGap = positioned.length > 0;
      continue;
    }
    positioned.push({
      ch: char.ch,
      rect: orderRect(char.quad),
      origin: char.origin,
      size: char.size,
      breakBefore: sawGap,
    });
    sawGap = false;
  }
  if (positioned[0] === undefined) return null;

  const words: TextWord[] = [];
  let glyphs: GlyphBox[] = [];
  let lineRect: Rect | null = null;
  let previous: PositionedGlyph | null = null;
  const flush = (): void => {
    const word = wordOf(glyphs);
    glyphs = [];
    if (word === null) return;
    words.push(word);
    lineRect = lineRect === null ? word.rect : unionPair(lineRect, word.rect);
  };

  for (let index = 0; index < positioned.length; index += 1) {
    const glyph = positioned[index];
    if (glyph === undefined) continue;
    if (previous !== null) {
      const gapEm = WORD_GAP_EM * Math.max(previous.size, glyph.size);
      if (glyph.breakBefore || gapBetween(previous.rect, glyph.rect, direction) > gapEm) flush();
    }
    const next = positioned[index + 1];
    glyphs.push({
      ch: glyph.ch,
      rect: glyph.rect,
      advance:
        next === undefined
          ? alongExtent(glyph.rect, direction)
          : (next.origin[0] - glyph.origin[0]) * direction[0] +
            (next.origin[1] - glyph.origin[1]) * direction[1],
    });
    previous = glyph;
  }
  flush();
  if (lineRect === null) return null;
  return {
    text: words.map((word) => word.text).join(' '),
    rect: lineRect,
    words,
    baseline: source.baseline,
  };
}

/** A word from its glyphs; `null` for an empty run. */
function wordOf(glyphs: readonly GlyphBox[]): TextWord | null {
  const head = glyphs[0];
  if (head === undefined) return null;
  let rect = head.rect;
  let text = head.ch;
  for (let index = 1; index < glyphs.length; index += 1) {
    const glyph = glyphs[index];
    if (glyph === undefined) continue;
    rect = unionPair(rect, glyph.rect);
    text += glyph.ch;
  }
  return { text, rect, glyphs };
}

/**
 * Unit writing direction of a line, from its first to its last inked glyph's
 * baseline origin. `[1, 0]` when the line has fewer than two glyphs or they share an
 * origin — the only case where nothing can be measured.
 */
function directionOf(chars: readonly CharInput[]): readonly [number, number] {
  let first: CharInput | null = null;
  let last: CharInput | null = null;
  for (const char of chars) {
    if (WORD_GAP_CHAR.test(char.ch)) continue;
    if (first === null) first = char;
    last = char;
  }
  if (first === null || last === null || first === last) return [1, 0];
  const dx = last.origin[0] - first.origin[0];
  const dy = last.origin[1] - first.origin[1];
  const length = Math.hypot(dx, dy);
  return length === 0 ? [1, 0] : [dx / length, dy / length];
}

/** Ink gap between two consecutive glyph boxes along `direction`, in points. */
function gapBetween(previous: Rect, current: Rect, direction: readonly [number, number]): number {
  const [dx, dy] = direction;
  const previousCenter = ((previous[0] + previous[2]) / 2) * dx + ((previous[1] + previous[3]) / 2) * dy;
  const currentCenter = ((current[0] + current[2]) / 2) * dx + ((current[1] + current[3]) / 2) * dy;
  return (
    currentCenter - previousCenter - (alongExtent(previous, direction) + alongExtent(current, direction)) / 2
  );
}

/** How far a box extends along `direction`: the projection of its own box, which is
 *  the measured advance of a glyph whose successor is unknown. */
function alongExtent(rect: Rect, direction: readonly [number, number]): number {
  return Math.abs(direction[0]) * (rect[2] - rect[0]) + Math.abs(direction[1]) * (rect[3] - rect[1]);
}

/**
 * How a line's glyphs are arranged in page space, decided from the first→last glyph
 * centre vector (`ORIENTATION_COS_LIMIT`). A single-glyph line is `horizontal`: no
 * direction can be measured, and horizontal is what the write path assumes.
 */
export function lineOrientation(line: TextLine): LineOrientation {
  let first: GlyphBox | null = null;
  let last: GlyphBox | null = null;
  for (const word of line.words) {
    for (const glyph of word.glyphs) {
      if (first === null) first = glyph;
      last = glyph;
    }
  }
  if (first === null || last === null || first === last) return 'horizontal';
  const dx = (last.rect[0] + last.rect[2] - first.rect[0] - first.rect[2]) / 2;
  const dy = (last.rect[1] + last.rect[3] - first.rect[1] - first.rect[3]) / 2;
  const length = Math.hypot(dx, dy);
  if (length === 0) return 'horizontal';
  if (Math.abs(dx) / length >= ORIENTATION_COS_LIMIT) return dx >= 0 ? 'horizontal' : 'reversed';
  if (Math.abs(dy) / length >= ORIENTATION_COS_LIMIT) return 'vertical';
  return 'skewed';
}

/** The block's orientation: the first vertical/reversed line wins, else `skewed` if
 *  any line is skewed, else `horizontal`. */
export function blockOrientation(block: TextBlock): LineOrientation {
  let skewed = false;
  for (const line of block.lines) {
    const orientation = lineOrientation(line);
    if (orientation === 'vertical' || orientation === 'reversed') return orientation;
    if (orientation === 'skewed') skewed = true;
  }
  return skewed ? 'skewed' : 'horizontal';
}

/** Lines in reading order for a horizontal block; the extractor's order otherwise,
 *  because a single scalar baseline cannot order rotated lines. */
function orderLines(lines: readonly TextLine[]): readonly TextLine[] {
  const horizontal = lines.every((line) => lineOrientation(line) === 'horizontal');
  if (!horizontal) return lines;
  return [...lines].sort((left, right) => {
    const byBaseline = left.baseline - right.baseline;
    return byBaseline !== 0 ? byBaseline : left.rect[0] - right.rect[0];
  });
}

function styleFor(source: BlockInput): StyleFacts | null {
  const sizes: number[] = [];
  const counts = new Map<string, number>();
  let fontName = '';
  let best = 0;
  for (const line of source.lines) {
    for (const char of line.chars) {
      if (WORD_GAP_CHAR.test(char.ch)) continue;
      if (char.size > 0) sizes.push(char.size);
      if (char.fontName === '') continue;
      const count = (counts.get(char.fontName) ?? 0) + 1;
      counts.set(char.fontName, count);
      if (count > best) {
        best = count;
        fontName = char.fontName;
      }
    }
  }
  const fontSize = median(sizes);
  if (fontSize === null) return null;
  const info = describeFontName(fontName);
  return {
    fontName: fontName === '' ? null : fontName,
    fontFamily: info.family,
    bold: info.bold,
    italic: info.italic,
    fontSize,
  };
}

/**
 * Leading of a block: the median baseline distance between consecutive lines, which
 * is what a paragraph's rhythm actually is. The spike took the distance between the
 * first two baselines instead because
 * it only had the lines it was about to erase; a median over the whole block ignores
 * the one wide gap a paragraph break puts in a MuPDF block.
 *
 * A single-line block has no such distance, so it falls back to
 * `DEFAULT_LEADING_RATIO` × size — the same role the spike's `fallbackLeading`
 * played (`replace.ts:83-91`), where the harness passed the fixture's own leading
 * (18 pt at the 11 pt body size, an early engine spike).
 */
function leadingOf(lines: readonly TextLine[], fontSize: number): number {
  const gaps: number[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1];
    const current = lines[index];
    if (previous === undefined || current === undefined) continue;
    gaps.push(Math.abs(current.baseline - previous.baseline));
  }
  const leading = median(gaps);
  return leading !== null && leading > 0 ? leading : fontSize * DEFAULT_LEADING_RATIO;
}

/** Middle value (mean of the two middles for an even count); `null` when empty so a
 *  caller can tell "no values" from a real zero. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const lower = sorted[middle - 1];
  const upper = sorted[middle];
  if (lower === undefined || upper === undefined) return null;
  return (lower + upper) / 2;
}

function colorOf(colors: Readonly<Record<number, string>> | undefined, index: number): string {
  const color = colors?.[index];
  if (color === undefined) return DEFAULT_COLOR;
  if (!COLOR_PATTERN.test(color)) {
    throw new ToolError('range-invalid', {
      engine: ENGINE,
      engineMessage: `colour ${color} (expected #rrggbb)`,
    });
  }
  return color.toLowerCase();
}

/**
 * Alignment from the block's own edges, since a PDF carries no alignment flag:
 *
 *   1. `justify` — flush left, flush right on every line **but the last**, and the
 *      last line short (that short last line is what tells justified text apart from a
 *      block that simply is flush on both sides);
 *   2. `right` — flush right on every line, ragged left;
 *   3. `center` — no flush edge, every line's centre within `ALIGN_TOLERANCE_PT` of
 *      the block's centre (or, for a single line, of the page's centre — a single
 *      line's ink box cannot say anything about centring by itself);
 *   4. `left` — the default, and also the answer for a block that is flush on both
 *      sides without a short last line, where no evidence separates the cases.
 */
function inferAlign(lines: readonly TextLine[], box: Rect, pageWidth: number): TextAlign {
  const tolerance = ALIGN_TOLERANCE_PT;
  const leftFlush = lines.every((line) => Math.abs(line.rect[0] - box[0]) <= tolerance);
  const rightFlush = lines.every((line) => Math.abs(line.rect[2] - box[2]) <= tolerance);
  const rightFlushBeforeLast = lines
    .slice(0, -1)
    .every((line) => Math.abs(line.rect[2] - box[2]) <= tolerance);
  if (lines.length >= 2 && leftFlush && rightFlushBeforeLast && !rightFlush) return 'justify';
  if (lines.length >= 2 && rightFlush && !leftFlush) return 'right';
  const center = (box[0] + box[2]) / 2;
  if (
    lines.length >= 2 &&
    !leftFlush &&
    lines.every((line) => Math.abs((line.rect[0] + line.rect[2]) / 2 - center) <= tolerance)
  ) {
    return 'center';
  }
  if (lines.length === 1 && Math.abs(center - pageWidth / 2) <= tolerance) return 'center';
  return 'left';
}

/** A rect with its corners in ascending order, whatever order the extractor used. */
function orderRect(rect: Rect): Rect {
  return [
    Math.min(rect[0], rect[2]),
    Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]),
    Math.max(rect[1], rect[3]),
  ];
}

function unionPair(left: Rect, right: Rect): Rect {
  return [
    Math.min(left[0], right[0]),
    Math.min(left[1], right[1]),
    Math.max(left[2], right[2]),
    Math.max(left[3], right[3]),
  ];
}
