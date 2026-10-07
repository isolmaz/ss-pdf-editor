/**
 * Plan an edit for the writer: turn a model + an
 * edit intent into the **serializable request** pdf-core's `applyTextEdit` consumes.
 *
 * The two halves of the plan are the two halves the spike measured:
 *
 *   - **erase** — one rect per line of the block, widened by `ERASE_PAD_PT`, merged
 *     where they actually overlap. The spike erased a single padded box around the
 *     whole block (`pad(box, 1.5)`), and its case c quantified the risk of a wide region: a
 *     region edge that reaches a rule's edge pixels changes 14 px of 1,440 in the
 *     band while the rule itself survives (`NOTES.md`, case c). Per-line rects are
 *     tighter than a block box, so 1 pt is enough — and a rect is additionally capped
 *     at half the distance to any neighbouring block, so an erase can never reach
 *     another block's ink.
 *   - **insert** — the reflowed lines as `{ text, x, y, fontSize, color, fontId, words }`
 *     with `y` the **baseline** start. The writer draws each line horizontally at that
 *     point and does the rotation maths itself; everything here stays unrotated,
 *     top-left (the spike's single most expensive discovery was that MuPDF annotation
 *     geometry is *rotated* page space while content streams are unrotated user space,
 *     and that mixing them up fails silently — `NOTES.md`, "The exact APIs called").
 *     `words` is the per-word x of every line of a **justified** block (stretched where
 *     justification stretched it), which is how justification survives a writer with no
 *     word-spacing primitive.
/**
 * The text-edit request types are defined in `./types` so this package remains
 * free of cycles and has no dependency on `pdf-core`.
 */
import { ToolError } from 'pdf-shared';
import { FALLBACK_FONT_CANDIDATE } from './fonts';
import { measureLineWidth, reflowBlock } from './reflow';
import type {
  FontMetrics,
  Rect,
  TextAlign,
  TextBlock,
  TextEditErase,
  TextEditInsert,
  TextEditInsertLine,
  TextEditIntent,
  TextEditRequest,
} from './types';

const ENGINE = 'pdf-text-engine';

/**
 * Erase padding, in points, on each side of a line's ink box. The spike's harness
 * used 1.5 pt on a *block* box; a line's
 * own ink box already excludes the inter-line gaps that made the block box generous,
 * so 1 pt is the smallest pad that still covers the antialiasing fringe of the
 * outermost glyph edge (2 px at the spike's 2x render scale) — and staying minimal is
 * the lesson of its case c, where a region that merely *touched* a table rule changed
 * 14 px of that rule's band.
 */
const ERASE_PAD_PT = 3;

/**
 * Smallest extent an erase rect may have, in points. The writer validates ascending
 * rects (`x1 > x0`, `y1 > y0`); a glyph box with zero area — possible in a broken
 * extraction — would otherwise be refused. 0.1 pt is a tenth of a stem width at 11 pt,
 * so it cannot grow the erased area visibly.
 */
const MIN_ERASE_EXTENT_PT = 0.1;

/**
 * The request for one text edit. Deterministic: the same model, intent and metric
 * table always produce the same request.
 *
 * A `replacement` that is empty (or whitespace only) deletes the block: the request
 * carries the erase and no insert at all. Otherwise the replacement is reflowed
 * inside the block's own box (`ReflowOptions.box` overrides it) and inserted line by
 * line. `intent.font` absent → the built-in Noto Sans fallback, i.e. `4e`'s expected
 * substitution; `metrics` must be that same face's table (see `TextEditIntent.font`).
 *
 * A justified block carries its stretch in `words`: every line of it gets the per-word
 * x of each word, so the writer can draw the line word by word and its right edge lands
 * on the box edge (the lines justification leaves alone — the last of a paragraph, a
 * single-word line — carry their natural positions, which draw identically). No other
 * alignment emits `words` at all: drawing word by word there would only add accumulated
 * rounding, and it would make the writer's own "justified" report note fire for an edit
 * with no justification in it. `width` stays the **natural** advance width — the number
 * the writer's report wants — because a justified line's laid-out width is the box's
 * width, which is geometry rather than text measurement.
 */
export function planTextEdit(intent: TextEditIntent, metrics: FontMetrics): TextEditRequest {
  const page = intent.page;
  const block = page.blocks.find((candidate) => candidate.id === intent.blockId);
  if (block === undefined) {
    throw new ToolError('range-invalid', {
      engine: ENGINE,
      pageIndex: page.pageIndex,
      engineMessage: `block ${intent.blockId}`,
    });
  }
  const font = intent.font ?? FALLBACK_FONT_CANDIDATE;
  const rects = eraseRects(block, page.blocks);
  const erase: TextEditErase[] = rects.length === 0 ? [] : [{ pageIndex: page.pageIndex, rects }];
  if (intent.replacement.trim() === '') return { erase, insert: [], fonts: {} };
  const align = intent.options?.align ?? block.align;
  const box =
    intent.options?.box ??
    fittedBox(
      block,
      page,
      intent.replacement,
      intent.options?.fontSize ?? block.style.fontSize,
      align,
      metrics,
    );
  const reflow = reflowBlock(
    // `align` last: an explicit `undefined` in the caller's options must not undo the
    // block's own alignment.
    { block, text: intent.replacement, options: { ...intent.options, box, align } },
    metrics,
  );
  const lines: TextEditInsertLine[] = reflow.lines.map((line) => ({
    text: line.text,
    // The line's own start x already carries alignment and justification start.
    x: line.rect[0],
    y: line.baseline,
    fontSize: reflow.fontSize,
    color: block.style.color,
    fontId: font.id,
    // Natural width: the writer's report uses it, and the stretched geometry of a
    // justified line is carried by `words` instead.
    width: measureLineWidth(line.text, reflow.fontSize, metrics),
    // Every line of a justified block carries its word placements — stretched where
    // justification stretched it, natural where it did not (the last line of a
    // paragraph, a single-word line). Any other alignment is drawn whole at `x`: word
    // by word would only add accumulated rounding, and the writer reports "justified"
    // from the presence of `words`.
    words: align === 'justify' ? line.words : undefined,
  }));
  const insert: TextEditInsert[] = [{ pageIndex: page.pageIndex, lines }];
  return { erase, insert, fonts: { [font.id]: font.filePath } };
}

/**
 * How far a box may widen past the block's own ink, as a share of the widest line that
 * has to fit: enough for a substitute face (Noto Sans sets Latin text about 6 % wider
 * than Helvetica), never enough to turn a column into a page-wide line.
 */
const MAX_WIDEN_RATIO = 1.25;

/**
 * The reflow box: the block's own, widened so every line the reader kept on one line
 * still fits on one line in the face it is redrawn with.
 *
 * The block's width is its ink in the **original** face. The replacement is drawn in the
 * matched face, usually Noto Sans, which is wider; a box of the old width broke every
 * full line the reader never touched, and a six-line list came back as eleven lines over
 * the content below it. The box grows by what the widest hard line needs, away from the
 * side its alignment anchors (right for left and justified text, left for right-aligned,
 * both for centred), but never past the page edge, never into a block beside it, and
 * never by more than {@link MAX_WIDEN_RATIO}: a line past that really is longer than the
 * line and wraps, inside the box the other lines widened. Its height stays free, as the
 * derived box's.
 *
 * `null` keeps the derived box: nothing needed widening, or there was no room.
 */
function fittedBox(
  block: TextBlock,
  page: TextEditIntent['page'],
  text: string,
  fontSize: number,
  align: TextAlign,
  metrics: FontMetrics,
): Rect | null {
  const [x0, y0, x1, y1] = block.rect;
  const width = x1 - x0;
  // A line past the widening limit really is longer than the line and wraps in the
  // widened box; it does not take the widening away from the lines that only need it.
  const needed = Math.max(
    0,
    ...text
      .split(/\r\n|\r|\n/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line !== '')
      .map((line) => measureLineWidth(line, fontSize, metrics))
      .filter((lineWidth) => lineWidth <= width * MAX_WIDEN_RATIO),
  );
  if (needed <= width) return null;
  // The room on each side: the page edge, or the nearest block that shares a band of
  // this block's height.
  let leftLimit = 0;
  let rightLimit = page.width;
  for (const other of page.blocks) {
    if (other === block || other.rect[3] <= y0 || other.rect[1] >= y1) continue;
    if (other.rect[0] >= x1) rightLimit = Math.min(rightLimit, other.rect[0] - ERASE_PAD_PT);
    if (other.rect[2] <= x0) leftLimit = Math.max(leftLimit, other.rect[2] + ERASE_PAD_PT);
  }
  const grow = needed - width;
  let left = x0;
  let right = x1;
  if (align === 'right') left = x0 - grow;
  else if (align === 'center') {
    left = x0 - grow / 2;
    right = x1 + grow / 2;
  } else right = x1 + grow;
  if (left < leftLimit || right > rightLimit) return null;
  return [left, y0, right, Number.POSITIVE_INFINITY];
}

/** One rect per line of the block: padded, never reaching another block, merged where
 *  the block's own line boxes overlap. */
function eraseRects(block: TextBlock, blocks: readonly TextBlock[]): readonly Rect[] {
  const others = blocks.filter((candidate) => candidate !== block);
  const padded: Rect[] = [];
  for (const line of block.lines) padded.push(withMinimumExtent(paddedLineRect(line.rect, others)));
  return mergeOverlapping(padded);
}

/**
 * A line's ink box widened by `ERASE_PAD_PT`, capped on each side by half the gap to
 * the nearest block that shares that side's band. A neighbour that merely touches the
 * band caps the pad at zero — the rect then stops exactly at the line's own ink, which
 * is still enough to erase it.
 */
function paddedLineRect(line: Rect, others: readonly TextBlock[]): Rect {
  let left = ERASE_PAD_PT;
  let right = ERASE_PAD_PT;
  let top = ERASE_PAD_PT;
  let bottom = ERASE_PAD_PT;
  for (const other of others) {
    const rect = other.rect;
    if (rect[3] >= line[1] && rect[1] <= line[3]) {
      if (rect[2] <= line[0]) left = Math.min(left, (line[0] - rect[2]) / 2);
      if (rect[0] >= line[2]) right = Math.min(right, (rect[0] - line[2]) / 2);
    }
    if (rect[2] >= line[0] && rect[0] <= line[2]) {
      if (rect[3] <= line[1]) top = Math.min(top, (line[1] - rect[3]) / 2);
      if (rect[1] >= line[3]) bottom = Math.min(bottom, (rect[1] - line[3]) / 2);
    }
  }
  return [line[0] - left, line[1] - top, line[2] + right, line[3] + bottom];
}

/** Grows a degenerate rect to `MIN_ERASE_EXTENT_PT`, centred on it. */
function withMinimumExtent(rect: Rect): Rect {
  const padX = Math.max(0, (MIN_ERASE_EXTENT_PT - (rect[2] - rect[0])) / 2);
  const padY = Math.max(0, (MIN_ERASE_EXTENT_PT - (rect[3] - rect[1])) / 2);
  return [rect[0] - padX, rect[1] - padY, rect[2] + padX, rect[3] + padY];
}

/**
 * Union of the rects that actually overlap in both axes. Deliberately not a vertical
 * merge of adjacent lines: that would grow a rect across the inter-line gap, i.e.
 * towards whatever sits above or below the block, which is exactly what the erase is
 * not allowed to touch.
 */
function mergeOverlapping(rects: readonly Rect[]): readonly Rect[] {
  const merged: Rect[] = [];
  for (const rect of rects) {
    let current = rect;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const other = merged[index];
      if (other === undefined) continue;
      const overlaps =
        other[0] <= current[2] && current[0] <= other[2] && other[1] <= current[3] && current[1] <= other[3];
      if (!overlaps) continue;
      current = [
        Math.min(other[0], current[0]),
        Math.min(other[1], current[1]),
        Math.max(other[2], current[2]),
        Math.max(other[3], current[3]),
      ];
      merged.splice(index, 1);
    }
    merged.push(current);
  }
  return merged;
}
