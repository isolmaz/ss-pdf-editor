/**
 * Minimal page-level text model for spike #3 (throwaway, `PLAN.md §9/K21`).
 *
 * This is the smallest slice of the `PLAN.md §5/Phase 4a` model the spike needs:
 * MuPDF structured text is walked into block → line → char, every geometry value
 * stays in **MuPDF page space** (origin top-left, y grows downward), and the
 * character quads give both the baseline origin and the writing direction — which
 * is what makes the rotated cases solvable without a second code path.
 */
import type { Mupdf } from './engine';

export type Rect4 = [number, number, number, number];
export type Vec2 = [number, number];
export type Mat6 = [number, number, number, number, number, number];

export interface GChar {
  readonly c: string;
  /** baseline origin, page space */
  readonly origin: Vec2;
  /** font size as reported by MuPDF's structured text */
  readonly size: number;
  /** [ul.x ul.y ur.x ur.y ll.x ll.y lr.x lr.y], page space */
  readonly quad: readonly number[];
  readonly fontName: string;
}

export interface GLine {
  readonly bbox: Rect4;
  /** unit writing direction, page space */
  readonly dir: Vec2;
  readonly chars: readonly GChar[];
}

export interface GBlock {
  readonly bbox: Rect4;
  readonly lines: readonly GLine[];
}

/**
 * Linear part of a matrix applied to a direction vector. MuPDF matrices are
 * [a b c d e f] with x' = a·x + c·y + e and y' = b·x + d·y + f.
 */
export function mapVector(m: Mat6, v: Vec2): Vec2 {
  return [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
}

export function mapPoint(m: Mat6, p: Vec2): Vec2 {
  const [x, y] = mapVector(m, p);
  return [x + m[4], y + m[5]];
}

export function unit(v: Vec2): Vec2 {
  const length = Math.hypot(v[0], v[1]);
  return length === 0 ? [1, 0] : [v[0] / length, v[1] / length];
}

/** Whitespace-insensitive comparison form used for every text equality check. */
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function unionRect(rects: readonly Rect4[]): Rect4 | null {
  if (rects.length === 0) return null;
  let [x0, y0, x1, y1] = rects[0] as Rect4;
  for (const rect of rects) {
    x0 = Math.min(x0, rect[0]);
    y0 = Math.min(y0, rect[1]);
    x1 = Math.max(x1, rect[2]);
    y1 = Math.max(y1, rect[3]);
  }
  return [x0, y0, x1, y1];
}

export function containsRect(outer: Rect4, inner: Rect4, tolerance: number): boolean {
  return (
    inner[0] >= outer[0] - tolerance &&
    inner[1] >= outer[1] - tolerance &&
    inner[2] <= outer[2] + tolerance &&
    inner[3] <= outer[3] + tolerance
  );
}

/** Read a page's structured text into the block → line → char model. */
export function readBlocks(page: InstanceType<Mupdf['PDFPage']>): GBlock[] {
  const stext = page.toStructuredText('preserve-whitespace');
  const blocks: GBlock[] = [];
  let block: { bbox: Rect4; lines: GLine[] } | null = null;
  let line: { bbox: Rect4; dir: Vec2; chars: GChar[] } | null = null;

  stext.walk({
    beginTextBlock(bbox) {
      block = { bbox, lines: [] };
    },
    beginLine(bbox, _wmode, direction) {
      line = { bbox, dir: unit([direction[0], direction[1]]), chars: [] };
    },
    onChar(c, origin, font, size, quad, _color, _bidi) {
      line?.chars.push({
        c,
        origin: [origin[0], origin[1]],
        size,
        quad: [quad[0], quad[1], quad[2], quad[3], quad[4], quad[5], quad[6], quad[7]],
        fontName: font.getName(),
      });
    },
    endLine() {
      if (block && line && line.chars.length > 0) block.lines.push(line);
      line = null;
    },
    endTextBlock() {
      if (block && block.lines.length > 0) blocks.push(block);
      block = null;
    },
  });

  stext.destroy();
  return blocks;
}

export function lineText(line: GLine): string {
  return normalizeText(line.chars.map((ch) => ch.c).join(''));
}

export function blockText(block: GBlock): string {
  return normalizeText(block.lines.map((l) => lineText(l)).join(' '));
}

/** Every line of every block whose own text contains `needle`. */
export function findLines(blocks: readonly GBlock[], needle: string): GLine[] {
  const wanted = normalizeText(needle);
  return blocks.flatMap((block) => block.lines).filter((line) => lineText(line).includes(wanted));
}

/** The first block that contains all of `needles`. */
export function findBlock(blocks: readonly GBlock[], needles: readonly string[]): GBlock | null {
  const wanted = needles.map((needle) => normalizeText(needle));
  for (const block of blocks) {
    const text = blockText(block);
    if (wanted.every((needle) => text.includes(needle))) return block;
  }
  return null;
}

/** Measured advance of a line in page space: first char's left edge → last char's right edge. */
export function measuredLineWidth(line: GLine): number {
  const first = line.chars[0];
  const last = line.chars[line.chars.length - 1];
  if (!first || !last) return 0;
  const ul: Vec2 = [first.quad[0] ?? 0, first.quad[1] ?? 0];
  const ur: Vec2 = [last.quad[2] ?? 0, last.quad[3] ?? 0];
  return Math.hypot(ur[0] - ul[0], ur[1] - ul[1]);
}
