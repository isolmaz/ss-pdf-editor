/**
 * A page read as layout: text blocks with their characters' fonts, sizes and colours,
 * pictures, and the ruling lines tables are drawn with — what the Office exports
 * (`ops/export-office.ts`) rebuild a Word document or a spreadsheet from.
 *
 * Everything is in **page space**: points, origin at the top-left corner of the page as it
 * is shown (MuPDF applies `/Rotate` and the crop box), y down.
 *
 * ## Tables
 *
 * MuPDF's own `table-hunt` was measured first (1.28.1): on a converted Word page it took
 * the whole page of paragraphs for a two-column table, and on a ruled spreadsheet grid it
 * found nothing. So tables are found here, the way Tabula's "lattice" mode finds them: the
 * page is run through a device that records every stroked line and every hairline-thin
 * filled rectangle, the horizontal and vertical ones are merged, and a connected set of at
 * least two of each is a grid. A cell is the space between neighbouring grid lines; a
 * missing line between two cells merges them. A page whose table has no rules at all is
 * read by `textRows` instead: lines split at wide gaps, aligned on shared column starts
 * ("stream" mode).
 */

import type {
  ColorSpace,
  Image,
  Matrix,
  Page,
  Path,
  Pixmap,
  Rect,
  Shade,
  StrokeState,
  StructuredText,
  Text,
} from 'mupdf';
import type { Mupdf } from '../engines/mupdf';

export type Box = readonly [number, number, number, number];

export interface LayoutChar {
  readonly c: string;
  readonly box: Box;
  /**
   * The y of the character's origin in page space: the baseline of upright text. (The box
   * reaches from the font's ascent to its descent, which differ between fonts.)
   */
  readonly baseline: number;
  readonly size: number;
  /** Family without the subset prefix or the style suffix (`ABCDEF+Arial-BoldMT` → `Arial`). */
  readonly font: string;
  /** The font's full name as MuPDF has it, subset tag included (`ABCDEF+Arial-BoldMT`): what the fonts of the page resources are matched by. */
  readonly face?: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly mono: boolean;
  /** The font's own serif flag (unreliable between the styles of one family). */
  readonly serif: boolean;
  /** `0xRRGGBB`. */
  readonly color: number;
  /** Drawn invisibly (render mode 3, or a zero alpha): the text layer a scan's OCR leaves behind. */
  readonly invisible?: true;
  /** The fill opacity of text drawn translucent (above 0, below 1); absent when solid. */
  readonly alpha?: number;
  /**
   * Where the glyph starts and how far it advances, for a line that runs at a slant (neither
   * across nor up/down the page, so the box says nothing of its geometry): its origin in page
   * space and the width of its quad along the line's direction.
   */
  readonly pen?: { readonly x: number; readonly y: number; readonly advance: number };
}

export interface LayoutLine {
  readonly box: Box;
  /** MuPDF's unit direction of the text along the line in page space: (1, 0) across, (0, -1) up, (0, 1) down. */
  readonly dir: readonly [number, number];
  readonly chars: readonly LayoutChar[];
}

export type LayoutBlock =
  | { readonly kind: 'text'; readonly box: Box; readonly lines: readonly LayoutLine[] }
  | {
      readonly kind: 'image';
      readonly box: Box;
      /** PNG, or `null` when the picture could not be decoded. */
      readonly png: Uint8Array | null;
    };

/** A ruling line: horizontal (`y0 === y1`) or vertical (`x0 === x1`). */
export interface Ruling {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface TableCell {
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly box: Box;
  readonly text: string;
  /** Which sides of the cell are drawn (a ruled table only): a side without a rule along it is left blank. */
  readonly borders?: {
    readonly top: boolean;
    readonly right: boolean;
    readonly bottom: boolean;
    readonly left: boolean;
  };
}

export interface LayoutTable {
  readonly box: Box;
  /** Column boundaries, left to right (`columns + 1` values). */
  readonly xs: readonly number[];
  /** Row boundaries, top to bottom (`rows + 1` values). */
  readonly ys: readonly number[];
  readonly cells: readonly TableCell[];
  /** Drawn with rules (`findTables`), or read from the spacing of the text (`findTextTables`). */
  readonly ruled: boolean;
}

/**
 * Something drawn that is not text: a path, a shading or a picture, by its box. `seed`
 * marks what only a drawing has — a curve, a polygon that is not a rectangle, a gradient, a
 * picture; plain rectangles and lines are cell shading, frames and rules as often as they
 * are parts of a drawing, so they only join a figure that a seed started (`findFigures`).
 */
export interface Mark {
  readonly box: Box;
  readonly seed: boolean;
}

export interface PageLayout {
  readonly width: number;
  readonly height: number;
  readonly blocks: readonly LayoutBlock[];
  readonly rulings: readonly Ruling[];
  readonly marks: readonly Mark[];
}

/** A picture larger than this (pixels on its long side) is scaled down for the export. */
const MAX_IMAGE_SIDE = 2000;
/** Lines closer than this are the same line; gaps up to this join segments of one rule. */
const SNAP = 1.5;
/** A rule shorter than this is a glyph detail or a tick, not a table line. */
const MIN_RULE = 6;
/** A filled rectangle thinner than this is drawn as a line. */
const HAIRLINE = 2.5;

/**
 * Whether a font's name says it is bold, for a font whose flags do not: Bold, Black, Heavy,
 * SemiBold, Demi, and the foundries' `-Dem` (`ITCFranklinGothicStd-Dem`).
 */
export const BOLD_NAME = /bold|black|heavy|semibold|demi|[-,\s]dem(?![a-z])/i;

/** `ABCDEF+Arial-BoldMT` → `Arial`; `TimesNewRomanPS-ItalicMT` → `TimesNewRomanPS`. */
export function fontFamily(name: string): string {
  const bare = name.replace(/^[A-Z]{6}\+/, '');
  // `split` always yields a first piece.
  const family = bare.split(/[-,]/)[0] as string;
  return family.replace(/(?:PS)?MT$/, '').trim() || 'Arial';
}

export function rgb(color: readonly number[] | null | undefined): number {
  if (color === null || color === undefined || color.length === 0) return 0;
  if (color.length === 1) {
    const [value] = color as [number];
    const grey = Math.round(value * 255);
    return (grey << 16) | (grey << 8) | grey;
  }
  if (color.length === 4) {
    const [c, m, y, k] = color as [number, number, number, number];
    const channel = (value: number) => Math.round(255 * (1 - Math.min(1, value + k)));
    return (channel(c) << 16) | (channel(m) << 8) | channel(y);
  }
  const [r, g, b] = color as [number, number, number];
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

export function apply(matrix: Matrix, x: number, y: number): readonly [number, number] {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

/**
 * mupdf.js 1.28.1 hands a device callback its shade or image in a wrapper that takes no
 * reference of its own, yet registers it with the class's finalizer, which drops one when
 * the wrapper is collected. Measured: after a few garbage collections the engine asserted
 * ("remove non-existent hash entry") and the next render failed ("Unexpected mesh type 0").
 * Taking the wrapper off the finalizer leaves the object to its owner, the page run. (The
 * structured-text walker's fonts and images were measured the same way and are sound.)
 */
export function borrowed(value: Shade | Image): void {
  const owner = value.constructor as { _finalizer?: FinalizationRegistry<unknown> };
  owner._finalizer?.unregister(value);
}

export function transformBox(box: Rect, matrix: Matrix): Box {
  const corners = [
    apply(matrix, box[0], box[1]),
    apply(matrix, box[2], box[1]),
    apply(matrix, box[2], box[3]),
    apply(matrix, box[0], box[3]),
  ];
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * A path's box, and whether it is a drawing: it has a curve, or a subpath that is neither
 * a line nor an upright rectangle.
 */
function pathShape(path: Path, ctm: Matrix): { box: Box; drawing: boolean } {
  const xs: number[] = [];
  const ys: number[] = [];
  let curves = 0;
  let corners = 0;
  let maxCorners = 0;
  let slanted = false;
  let last: readonly [number, number] | null = null;
  const point = (x: number, y: number) => {
    const at = apply(ctm, x, y);
    xs.push(at[0]);
    ys.push(at[1]);
    if (last !== null && Math.abs(at[0] - last[0]) > 0.5 && Math.abs(at[1] - last[1]) > 0.5) slanted = true;
    last = at;
  };
  path.walk({
    moveTo(x, y) {
      maxCorners = Math.max(maxCorners, corners);
      corners = 1;
      last = null;
      point(x, y);
    },
    lineTo(x, y) {
      corners += 1;
      point(x, y);
    },
    curveTo(x1, y1, x2, y2, x3, y3) {
      curves += 1;
      point(x1, y1);
      point(x2, y2);
      point(x3, y3);
    },
    closePath() {},
  });
  maxCorners = Math.max(maxCorners, corners);
  if (xs.length === 0) return { box: [0, 0, 0, 0], drawing: false };
  return {
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    drawing: curves > 0 || slanted || maxCorners > 5,
  };
}

/** Each subpath of a path as its points, in page space. */
export function subpaths(path: Path, ctm: Matrix): (readonly [number, number])[][] {
  const out: (readonly [number, number])[][] = [];
  let current: (readonly [number, number])[] = [];
  path.walk({
    moveTo(x, y) {
      if (current.length > 0) out.push(current);
      current = [apply(ctm, x, y)];
    },
    lineTo(x, y) {
      current.push(apply(ctm, x, y));
    },
    curveTo(_x1, _y1, _x2, _y2, x3, y3) {
      // A curve is never a table rule; it breaks the run of straight segments.
      out.push(current);
      current = [apply(ctm, x3, y3)];
    },
    closePath() {
      // A subpath starts with its `moveTo`, so it always has a first point to close on.
      current.push(current[0] as readonly [number, number]);
    },
  });
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * A picture as it shows on the page: drawn through its own transform into a transparent
 * RGB pixmap the size of its box, so a soft mask (a drop shadow's fade, a cut-out logo),
 * a rotation or a flip comes out as the reader saw it. `Image.toPixmap()` gives the raw
 * samples instead — an `/SMask` image then turned into a grey box with black corners. The
 * draw device does not apply that mask either (measured, MuPDF 1.28.1), so `softMasked`
 * folds it into the picture's alpha first.
 * The resolution is the image's own, capped at `MAX_IMAGE_SIDE` on the long side.
 */
function drawImage(mupdf: Mupdf, bbox: Rect, transform: Matrix, image: Image): Uint8Array {
  const boxWidth = Math.max(1, bbox[2] - bbox[0]);
  const boxHeight = Math.max(1, bbox[3] - bbox[1]);
  const native = Math.max(image.getWidth(), image.getHeight()) / Math.max(boxWidth, boxHeight);
  const scale = Math.max(0.25, Math.min(native, MAX_IMAGE_SIDE / Math.max(boxWidth, boxHeight)));
  const width = Math.max(1, Math.round(boxWidth * scale));
  const height = Math.max(1, Math.round(boxHeight * scale));
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], true);
  try {
    pixmap.clear();
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    try {
      const place = mupdf.Matrix.concat(
        mupdf.Matrix.translate(-bbox[0], -bbox[1]),
        mupdf.Matrix.scale(scale, scale),
      );
      const masked = softMasked(mupdf, image);
      try {
        device.fillImage(masked ?? image, mupdf.Matrix.concat(transform, place), 1);
      } finally {
        masked?.destroy();
      }
      device.close();
    } finally {
      device.destroy();
    }
    return pixmap.asPNG();
  } finally {
    pixmap.destroy();
  }
}

/**
 * The picture with its soft mask as its alpha channel, or `null` when it has no mask. The
 * three pixel views are taken after every allocation: they are windows on the wasm heap,
 * which an allocation may move.
 */
export function softMasked(mupdf: Mupdf, image: Image): Image | null {
  const mask = image.getMask();
  if (mask === null) return null;
  const pixmaps: Pixmap[] = [];
  try {
    let base = image.toPixmap();
    pixmaps.push(base);
    if (base.getColorSpace()?.isRGB() !== true || base.getAlpha() !== 0) {
      base = base.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
      pixmaps.push(base);
    }
    const width = base.getWidth();
    const height = base.getHeight();
    let soft = mask.toPixmap();
    pixmaps.push(soft);
    // The mask comes as a stencil (alpha only, no colour space); its alpha is the grey that is read.
    soft = soft.convertToColorSpace(mupdf.ColorSpace.DeviceGray, false);
    pixmaps.push(soft);
    if (soft.getWidth() !== width || soft.getHeight() !== height) {
      soft = soft.warp(
        [
          [0, 0],
          [soft.getWidth(), 0],
          [soft.getWidth(), soft.getHeight()],
          [0, soft.getHeight()],
        ],
        width,
        height,
      );
      pixmaps.push(soft);
    }
    const out = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], true);
    pixmaps.push(out);
    const baseStride = base.getStride();
    const softStride = soft.getStride();
    const outStride = out.getStride();
    const from = base.getPixels();
    const alpha = soft.getPixels();
    const to = out.getPixels();
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const a = alpha[y * softStride + x] as number;
        const source = y * baseStride + x * 3;
        const target = y * outStride + x * 4;
        // MuPDF's pixmaps hold premultiplied colour.
        to[target] = ((from[source] as number) * a) / 255;
        to[target + 1] = ((from[source + 1] as number) * a) / 255;
        to[target + 2] = ((from[source + 2] as number) * a) / 255;
        to[target + 3] = a;
      }
    }
    return new mupdf.Image(out);
  } finally {
    for (const pixmap of pixmaps) pixmap.destroy();
  }
}

/** Sine of the angle (1.5°) within which a line counts as running along an axis of the page. */
const AXIS_SLACK = 0.026;

/**
 * Whether a line's direction (`LayoutLine.dir`) is none of across (1, 0), down (0, 1) and up
 * (0, -1) — within 1.5° — so its text is set at a slant (or upside down).
 */
export function slanted(dir: readonly [number, number]): boolean {
  const [x, y] = dir;
  const across = x > 0 && Math.abs(y) < AXIS_SLACK;
  const vertical = Math.abs(x) < AXIS_SLACK && Math.abs(y) > 0;
  return !across && !vertical;
}

/** What the structured-text walker reads: the blocks, and every line's characters with their origins. */
interface Walked {
  readonly blocks: LayoutBlock[];
  /** Every line's `chars` with each character's origin (page space, unshifted), for `invisible`. */
  readonly walked: { readonly chars: LayoutChar[]; readonly origins: (readonly [number, number])[] }[];
}

/** `text` read to blocks, lines and characters (page space shifted by `shift`); `text` is destroyed. */
function walkText(
  mupdf: Mupdf,
  text: StructuredText,
  shift: (x: number, y: number) => readonly [number, number],
): Walked {
  const blocks: LayoutBlock[] = [];
  let lines: LayoutLine[] = [];
  let chars: LayoutChar[] = [];
  const walked: Walked['walked'] = [];
  let origins: (readonly [number, number])[] = [];
  let blockBox: Box = [0, 0, 0, 0];
  let lineBox: Box = [0, 0, 0, 0];
  let lineDir: readonly [number, number] = [1, 0];
  try {
    text.walk({
      onImageBlock(bbox, transform, image) {
        let png: Uint8Array | null = null;
        try {
          png = drawImage(mupdf, bbox, transform, image);
        } catch {
          // An image MuPDF cannot decode is left out; the caller counts the missing ones.
          png = null;
        }
        const [x0, y0] = shift(bbox[0], bbox[1]);
        const [x1, y1] = shift(bbox[2], bbox[3]);
        blocks.push({ kind: 'image', box: [x0, y0, x1, y1], png });
      },
      beginTextBlock(bbox) {
        const [x0, y0] = shift(bbox[0], bbox[1]);
        const [x1, y1] = shift(bbox[2], bbox[3]);
        blockBox = [x0, y0, x1, y1];
        lines = [];
      },
      beginLine(bbox, _wmode, direction) {
        const [x0, y0] = shift(bbox[0], bbox[1]);
        const [x1, y1] = shift(bbox[2], bbox[3]);
        lineBox = [x0, y0, x1, y1];
        lineDir = [direction[0], direction[1]];
        chars = [];
        origins = [];
      },
      onChar(c, origin, font, size, quad, color) {
        // Read per character: the binding hands over a new `Font` wrapper for every one, and two
        // fonts may share a name (or have none) while their flags differ.
        const name = font.getName();
        const face = {
          font: fontFamily(name),
          face: name,
          bold: font.isBold() || BOLD_NAME.test(name),
          italic: font.isItalic() || /italic|oblique/i.test(name),
          mono: font.isMono(),
          serif: font.isSerif(),
        };
        const xs = [quad[0], quad[2], quad[4], quad[6]];
        const ys = [quad[1], quad[3], quad[5], quad[7]];
        const [x0, y0] = shift(Math.min(...xs), Math.min(...ys));
        const [x1, y1] = shift(Math.max(...xs), Math.max(...ys));
        origins.push([origin[0], origin[1]]);
        const [ox, oy] = shift(origin[0], origin[1]);
        chars.push({
          c,
          box: [x0, y0, x1, y1],
          baseline: oy,
          size,
          color: rgb(color),
          ...face,
          ...(slanted(lineDir)
            ? { pen: { x: ox, y: oy, advance: Math.hypot(quad[2] - quad[0], quad[3] - quad[1]) } }
            : {}),
        });
      },
      endLine() {
        walked.push({ chars, origins });
        lines.push({ box: lineBox, dir: lineDir, chars });
      },
      endTextBlock() {
        blocks.push({ kind: 'text', box: blockBox, lines });
      },
    });
  } finally {
    text.destroy();
  }
  return { blocks, walked };
}

/**
 * ZapfDingbats code → the symbol it draws: the marks a form field's button draws (PDF 32000-1
 * `/MK /CA`: `4` check, `l` circle, `8` cross, `u` diamond, `n` square, `H` star) and the
 * check mark MuPDF writes itself (`3`), with their neighbours in the font.
 */
const ZAPF_SYMBOLS: Readonly<Record<string, string>> = {
  '3': '\u2713',
  '4': '\u2714',
  '5': '\u2715',
  '6': '\u2716',
  '7': '\u2717',
  '8': '\u2718',
  H: '\u2605',
  l: '\u25CF',
  m: '\u274D',
  n: '\u25A0',
  s: '\u25B2',
  t: '\u25BC',
  u: '\u25C6',
};
/** MuPDF's own ZapfDingbats numbers its glyphs from the space (code 0x20 is glyph 1): code = glyph + 0x1F. */
const ZAPF_GLYPH_BASE = 0x1f;

/** What a page's device calls say about its glyphs, to be applied to the characters the structured-text walker read. */
interface GlyphNotes {
  /** Device calls to spread into the page's `Device`. */
  readonly calls: {
    readonly fillText: (
      text: Text,
      ctm: Matrix,
      colorspace: ColorSpace,
      color: number[],
      alpha: number,
    ) => void;
    readonly strokeText: (
      text: Text,
      stroke: StrokeState,
      ctm: Matrix,
      colorspace: ColorSpace,
      color: number[],
      alpha: number,
    ) => void;
    readonly ignoreText: (text: Text, ctm: Matrix) => void;
  };
  /** Marks the characters of `walked` that the page draws without showing (`invisible`) or faded (`alpha`). */
  apply(walked: Walked['walked']): void;
}

/**
 * The glyphs a page draws invisibly (render mode 3, opacity 0) or faded, found by where their
 * origin lies (a grid of a quarter point, a neighbouring cell counting too), for the characters
 * of the structured-text walker, which does not say how a glyph is drawn. With `symbols`, the
 * glyphs of MuPDF's built-in ZapfDingbats are told too: the walker gives their code as a letter
 * or number (`3` for a check mark, U+0014 for another), so such a character is replaced by the
 * symbol the glyph draws, and one that has none known is `invisible` — no text to write.
 */
function glyphNotes(symbols: boolean): GlyphNotes {
  /** The origins of the glyphs drawn invisibly, on a grid of a quarter point. */
  const hidden = new Set<string>();
  /** The same, for glyphs filled with an opacity between 0 and 1: their opacity. */
  const faded = new Map<string, number>();
  /** The same, for ZapfDingbats glyphs: the symbol, or `''` for one with none known. */
  const dingbats = new Map<string, string>();
  const keyOf = (x: number, y: number): string => `${Math.round(x * 4)},${Math.round(y * 4)}`;
  const hide = (text: Text, ctm: Matrix, opacity?: number): void => {
    text.walk({
      showGlyph(_font, trm) {
        const [x, y] = apply(ctm, trm[4], trm[5]);
        const key = keyOf(x, y);
        if (opacity === undefined) hidden.add(key);
        else faded.set(key, opacity);
      },
    });
  };
  const draw = (text: Text, ctm: Matrix): void => {
    text.walk({
      showGlyph(font, trm, gid, unicode) {
        // A glyph already read as a symbol of the Dingbats block (an embedded font's own map) stays.
        if ((unicode >= 0x2700 && unicode <= 0x27bf) || !/^(zapf)?dingbats$/i.test(font.getName())) return;
        const [x, y] = apply(ctm, trm[4], trm[5]);
        dingbats.set(keyOf(x, y), ZAPF_SYMBOLS[String.fromCharCode(gid + ZAPF_GLYPH_BASE)] ?? '');
      },
    });
  };
  return {
    calls: {
      fillText(text, ctm, _colorspace, _color, alpha) {
        if (alpha === 0) hide(text, ctm);
        else if (alpha < 1) hide(text, ctm, Math.round(alpha * 1000) / 1000);
        if (symbols) draw(text, ctm);
      },
      strokeText(text, _stroke, ctm, _colorspace, _color, alpha) {
        if (alpha === 0) hide(text, ctm);
      },
      ignoreText: hide,
    },
    apply(walked) {
      if (hidden.size === 0 && faded.size === 0 && dingbats.size === 0) return;
      for (const line of walked) {
        for (const [at, origin] of line.origins.entries()) {
          const gx = Math.round(origin[0] * 4);
          const gy = Math.round(origin[1] * 4);
          let found = false;
          let opacity: number | undefined;
          let symbol: string | undefined;
          for (let dx = -1; dx <= 1 && !found; dx += 1) {
            for (let dy = -1; dy <= 1 && !found; dy += 1) {
              const key = `${gx + dx},${gy + dy}`;
              found = hidden.has(key);
              opacity ??= faded.get(key);
              symbol ??= dingbats.get(key);
            }
          }
          const char = line.chars[at] as LayoutChar;
          if (found) line.chars[at] = { ...char, invisible: true };
          else if (symbol === '') line.chars[at] = { ...char, invisible: true };
          else if (symbol !== undefined)
            line.chars[at] = { ...char, c: symbol, ...(opacity === undefined ? {} : { alpha: opacity }) };
          else if (opacity !== undefined) line.chars[at] = { ...char, alpha: opacity };
        }
      }
    },
  };
}

/** The page's characters, blocks and pictures, through MuPDF's structured-text walker. */
export function readPageLayout(mupdf: Mupdf, page: Page, options: { readonly images: boolean }): PageLayout {
  const [px0, py0, px1, py1] = page.getBounds();
  const shift = (x: number, y: number): readonly [number, number] => [x - px0, y - py0];
  const { blocks, walked } = walkText(
    mupdf,
    page.toStructuredText(options.images ? 'preserve-whitespace,preserve-images' : 'preserve-whitespace'),
    shift,
  );

  const rulings: Ruling[] = [];
  const keep = (x0: number, y0: number, x1: number, y1: number): void => {
    const [ax, ay] = shift(x0, y0);
    const [bx, by] = shift(x1, y1);
    if (Math.abs(ay - by) <= 0.5 && Math.abs(ax - bx) >= MIN_RULE) {
      const y = (ay + by) / 2;
      rulings.push({ x0: Math.min(ax, bx), y0: y, x1: Math.max(ax, bx), y1: y });
    } else if (Math.abs(ax - bx) <= 0.5 && Math.abs(ay - by) >= MIN_RULE) {
      const x = (ax + bx) / 2;
      rulings.push({ x0: x, y0: Math.min(ay, by), x1: x, y1: Math.max(ay, by) });
    }
  };
  const marks: Mark[] = [];
  const area = (px1 - px0) * (py1 - py0);
  const mark = (box: Box, seed: boolean): void => {
    const [x0, y0] = shift(box[0], box[1]);
    const [x1, y1] = shift(box[2], box[3]);
    const width = x1 - x0;
    const height = y1 - y0;
    // A page-sized fill is the paper's colour, not a drawing.
    if (width * height > area * 0.6 || (width < 0.5 && height < 0.5)) return;
    marks.push({ box: [x0, y0, x1, y1], seed });
  };
  const glyphs = glyphNotes(false);
  const device = new mupdf.Device({
    ...glyphs.calls,
    fillShade(shade, ctm) {
      borrowed(shade);
      mark(transformBox(shade.getBounds(), ctm), true);
    },
    fillImage(image, ctm) {
      borrowed(image);
      mark(transformBox([0, 0, 1, 1], ctm), true);
    },
    fillImageMask(image, ctm) {
      borrowed(image);
      mark(transformBox([0, 0, 1, 1], ctm), true);
    },
    strokePath(path, _stroke, ctm) {
      const shape = pathShape(path, ctm);
      mark(shape.box, shape.drawing);
      for (const points of subpaths(path, ctm)) {
        for (let index = 1; index < points.length; index += 1) {
          const from = points[index - 1] as readonly [number, number];
          const to = points[index] as readonly [number, number];
          keep(from[0], from[1], to[0], to[1]);
        }
      }
    },
    fillPath(path, _evenOdd, ctm) {
      const shape = pathShape(path, ctm);
      mark(shape.box, shape.drawing);
      for (const points of subpaths(path, ctm)) {
        if (points.length < 3) continue;
        const xs = points.map((point) => point[0]);
        const ys = points.map((point) => point[1]);
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs);
        const y0 = Math.min(...ys);
        const y1 = Math.max(...ys);
        if (y1 - y0 <= HAIRLINE && x1 - x0 >= MIN_RULE) keep(x0, (y0 + y1) / 2, x1, (y0 + y1) / 2);
        else if (x1 - x0 <= HAIRLINE && y1 - y0 >= MIN_RULE) keep((x0 + x1) / 2, y0, (x0 + x1) / 2, y1);
      }
    },
  });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }
  glyphs.apply(walked);

  return { width: px1 - px0, height: py1 - py0, blocks, rulings, marks };
}

/** The text of a page's annotations and form fields, and the fields whose value nothing shows. */
export interface Appearances {
  /** What their appearance streams draw as text; `readPageLayout` leaves it out. */
  readonly layout: PageLayout;
  /** Form fields that hold a value (or are checked) while their appearance draws nothing at their place. */
  readonly unseen: number;
}

/** A widget flagged hidden or no-view is not drawn, so it is not "unseen" either; nor is one under an optional-content entry (`/OC`), which may hide it. */
const WIDGET_NOT_SHOWN = 2 | 32;
/** How far outside its rectangle a field's appearance may lie and still be that field's (points). */
const FIELD_SLACK = 2;

/**
 * The text that the annotations' and form fields' appearance streams draw, read apart from the
 * page's own content (`toStructuredText` of the page skips them), and how many form fields have a
 * value that nothing of the appearance shows — no appearance stream, or one that draws nothing:
 * a text or choice field needs text at its place, a checked box or radio button (its own
 * appearance state `/AS`, not the group's `/V`) any drawing or text. Text drawn without being
 * shown (render mode 3, opacity 0) is left out, as in `readPageLayout`; a ZapfDingbats mark is the
 * symbol it draws, not the letter of its code.
 */
export function readAppearances(mupdf: Mupdf, page: Page): Appearances {
  const bounds = page.getBounds();
  const [px0, py0, px1, py1] = bounds;
  const shift = (x: number, y: number): readonly [number, number] => [x - px0, y - py0];
  const inks: Box[] = [];
  const ink = (box: Box): void => {
    const [x0, y0] = shift(box[0], box[1]);
    const [x1, y1] = shift(box[2], box[3]);
    inks.push([x0, y0, x1, y1]);
  };
  const glyphs = glyphNotes(true);
  const list = new mupdf.DisplayList(bounds);
  let walked: Walked;
  try {
    const recorder = new mupdf.DisplayListDevice(list);
    try {
      page.runPageAnnots(recorder, mupdf.Matrix.identity);
      page.runPageWidgets(recorder, mupdf.Matrix.identity);
      recorder.close();
    } finally {
      recorder.destroy();
    }
    const device = new mupdf.Device({
      ...glyphs.calls,
      fillPath: (path, _evenOdd, ctm) => ink(pathShape(path, ctm).box),
      strokePath: (path, _stroke, ctm) => ink(pathShape(path, ctm).box),
      fillShade(shade, ctm) {
        borrowed(shade);
        ink(transformBox(shade.getBounds(), ctm));
      },
      fillImage(image, ctm) {
        borrowed(image);
        ink(transformBox([0, 0, 1, 1], ctm));
      },
      fillImageMask(image, ctm) {
        borrowed(image);
        ink(transformBox([0, 0, 1, 1], ctm));
      },
    });
    try {
      list.run(device, mupdf.Matrix.identity);
      device.close();
    } finally {
      device.destroy();
    }
    walked = walkText(mupdf, list.toStructuredText('preserve-whitespace'), shift);
  } finally {
    list.destroy();
  }
  glyphs.apply(walked.walked);
  // What shows as text: not hidden, not whitespace, and no control character (a glyph of no known meaning).
  const letters: Box[] = [];
  for (const block of walked.blocks.filter(
    (entry): entry is Extract<typeof entry, { kind: 'text' }> => entry.kind === 'text',
  )) {
    for (const line of block.lines) {
      for (const char of line.chars) {
        if (char.invisible !== true && char.c.trim() !== '' && (char.c.codePointAt(0) as number) >= 0x20) {
          letters.push(char.box);
        }
      }
    }
  }
  const at = (boxes: readonly Box[], rect: Box): boolean =>
    boxes.some((box) => {
      const x = (box[0] + box[2]) / 2;
      const y = (box[1] + box[3]) / 2;
      return (
        x >= rect[0] - FIELD_SLACK &&
        x <= rect[2] + FIELD_SLACK &&
        y >= rect[1] - FIELD_SLACK &&
        y <= rect[3] + FIELD_SLACK
      );
    });
  let unseen = 0;
  // The page keeps these wrappers for the next read of it (the raster fallback reads the page again): none is destroyed here.
  for (const widget of page instanceof mupdf.PDFPage ? page.getWidgets() : []) {
    try {
      const dict = widget.getObject();
      if ((widget.getFlags() & WIDGET_NOT_SHOWN) !== 0 || !dict.get('OC').isNull()) continue;
      const value = widget.getValue().trim();
      const typed = widget.isText() || widget.isChoice();
      // A button is checked by the state its own widget shows; a group's `/V` is the same for every kid.
      const state = dict.get('AS');
      const checked =
        (widget.isCheckbox() || widget.isRadioButton()) &&
        (state.isName() ? state.asName() !== 'Off' : value !== '' && value !== 'Off');
      if (typed ? value === '' : !checked) continue;
      const [wx0, wy0, wx1, wy1] = widget.getBounds();
      const [x0, y0] = shift(wx0, wy0);
      const [x1, y1] = shift(wx1, wy1);
      if (!at(typed ? letters : [...letters, ...inks], [x0, y0, x1, y1])) unseen += 1;
    } catch {
      // A field MuPDF cannot read (a parent chain that loops) says nothing of its value: it is not counted.
    }
  }
  return {
    layout: { width: px1 - px0, height: py1 - py0, blocks: walked.blocks, rulings: [], marks: [] },
    unseen,
  };
}

/* ------------------------------------------------------------------ *
 * figures
 * ------------------------------------------------------------------ */

function overlaps(a: Box, b: Box, gap: number): boolean {
  return a[0] <= b[2] + gap && b[0] <= a[2] + gap && a[1] <= b[3] + gap && b[1] <= a[3] + gap;
}

/** A figure smaller than this on either side is an icon or a bullet; it stays out. */
const MIN_FIGURE = 24;
/** A line of this many characters inside a region makes it a text box, not a figure. */
const FIGURE_PROSE = 40;
/** Above this many drawn things on a page, it is treated as one drawing. */
const MAX_MARKS = 2000;

/** Whether a drawn region stays a figure (see `findFigures`). */
function keepFigure(layout: PageLayout, tables: readonly Box[], box: Box): boolean {
  const lines = layout.blocks.flatMap((block) => (block.kind === 'text' ? block.lines : []));
  if (box[2] - box[0] < MIN_FIGURE || box[3] - box[1] < MIN_FIGURE) return false;
  if (tables.some((table) => overlaps(table, box, 0))) return false;
  // A page that is one big drawing (a scanned page with vector rules over it, a form) is
  // left as it is: the text stays text.
  if ((box[2] - box[0]) * (box[3] - box[1]) > layout.width * layout.height * 0.6) return false;
  return !lines.some((line) => line.chars.filter((char) => inside(char, box)).length >= FIGURE_PROSE);
}

/**
 * Regions drawn with vector graphics — charts, diagrams, logos, a drawing around a picture
 * — that a Word document can only carry as a picture. Seeds (`Mark.seed`) start a region;
 * any mark touching it joins, until nothing more does. A region that holds a line of prose
 * is a coloured text box and is left to the text, and one inside or across a table is the
 * table's.
 */
export function findFigures(layout: PageLayout, tables: readonly Box[]): Box[] {
  const union = (a: Box, b: Box): Box => [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ];
  const same = (a: Box, b: Box) => a.every((value, index) => value === b[index]);
  const seeds = layout.marks.filter((mark) => mark.seed).map((mark) => mark.box);
  if (seeds.length === 0) return [];
  // A page of thousands of paths (a map, a plan, text drawn as outlines) is one drawing;
  // growing it mark by mark would cost the square of its paths.
  if (layout.marks.length > MAX_MARKS) {
    const all = layout.marks.reduce((box, mark) => union(box, mark.box), seeds[0] as Box);
    return keepFigure(layout, tables, all) ? [all] : [];
  }
  let regions: Box[] = seeds;
  // Grow every region over the marks that touch it and merge regions that meet, until
  // nothing changes.
  let changed = true;
  while (changed) {
    changed = false;
    const next: Box[] = [];
    for (const region of regions) {
      let box = region;
      for (const mark of layout.marks) {
        if (overlaps(box, mark.box, 1)) box = union(box, mark.box);
      }
      if (!same(box, region)) changed = true;
      const into = next.findIndex((other) => overlaps(other, box, 4));
      if (into === -1) next.push(box);
      else {
        next[into] = union(next[into] as Box, box);
        changed = true;
      }
    }
    regions = next;
  }
  return regions.filter((box) => keepFigure(layout, tables, box));
}

/**
 * What a page paints besides text, as the device calls that carry it to a draw device. The
 * clips of text stay: they open a clip that a later `popClip` closes.
 */
const PAINTING = [
  'fillPath',
  'strokePath',
  'clipPath',
  'clipStrokePath',
  'clipText',
  'clipStrokeText',
  'fillShade',
  'fillImage',
  'fillImageMask',
  'clipImageMask',
  'popClip',
  'beginMask',
  'endMask',
  'beginGroup',
  'endGroup',
] as const;

/**
 * A region of the page as a picture — the drawing and its pictures — on a transparent
 * ground, at twice the page's resolution (144 dpi), capped at `MAX_IMAGE_SIDE` on the long
 * side. The text on it is not drawn: it goes to Word as text, over the picture, so it can be
 * read and edited (`pageItems`).
 */
export function renderRegion(mupdf: Mupdf, page: Page, box: Box): Uint8Array {
  const [px0, py0] = page.getBounds();
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  const scale = Math.min(2, MAX_IMAGE_SIDE / Math.max(width, height));
  const pixmap = new mupdf.Pixmap(
    mupdf.ColorSpace.DeviceRGB,
    [0, 0, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))],
    true,
  );
  try {
    pixmap.clear();
    const target = new mupdf.DrawDevice(
      mupdf.Matrix.concat(
        mupdf.Matrix.translate(-(box[0] + px0), -(box[1] + py0)),
        mupdf.Matrix.scale(scale, scale),
      ),
      pixmap,
    );
    // The page runs through a device of its own that hands everything but text on to the
    // draw device. Shades and pictures come borrowed, as in `readPageLayout`.
    const callbacks: Record<string, (...args: unknown[]) => void> = {};
    for (const name of PAINTING) {
      callbacks[name] = (...args) => {
        for (const arg of args) {
          if (arg instanceof mupdf.Shade || arg instanceof mupdf.Image) borrowed(arg);
        }
        (target[name] as (...forwarded: unknown[]) => void).apply(target, args);
      };
    }
    const device = new mupdf.Device(callbacks as never);
    try {
      page.run(device, mupdf.Matrix.identity);
      device.close();
      target.close();
    } finally {
      device.destroy();
      target.destroy();
    }
    return pixmap.asPNG();
  } finally {
    pixmap.destroy();
  }
}

/* ------------------------------------------------------------------ *
 * tables from rulings ("lattice")
 * ------------------------------------------------------------------ */

/** Collinear, touching segments merged into one. */
function mergeRules(rules: readonly Ruling[], horizontal: boolean): Ruling[] {
  const key = (rule: Ruling) => (horizontal ? rule.y0 : rule.x0);
  const start = (rule: Ruling) => (horizontal ? rule.x0 : rule.y0);
  const end = (rule: Ruling) => (horizontal ? rule.x1 : rule.y1);
  const sorted = [...rules].sort((a, b) => key(a) - key(b) || start(a) - start(b));
  const merged: Ruling[] = [];
  for (const rule of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && Math.abs(key(last) - key(rule)) <= SNAP && start(rule) <= end(last) + SNAP) {
      const reach = Math.max(end(last), end(rule));
      merged[merged.length - 1] = horizontal
        ? { x0: last.x0, y0: last.y0, x1: reach, y1: last.y1 }
        : { x0: last.x0, y0: last.y0, x1: last.x1, y1: reach };
      continue;
    }
    merged.push(rule);
  }
  return merged;
}

/** Sorted values with neighbours closer than `SNAP` collapsed to their mean. */
function cluster(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const value of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && value - (last[last.length - 1] as number) <= SNAP * 2) last.push(value);
    else out.push([value]);
  }
  return out.map((group) => group.reduce((sum, value) => sum + value, 0) / group.length);
}

/** The share of a cell edge a rule has to run along for the cell to be split from its neighbour. */
const SPLIT_SIDE = 0.6;
/** The share of a cell side that rules have to cover for the side to be drawn. */
const DRAWN_SIDE = 0.75;
/** A table's outer edge further than this from its outermost rule is a border the page does not draw. */
const OUTER_GAP = 6;

function covers(
  rule: Ruling,
  horizontal: boolean,
  at: number,
  from: number,
  to: number,
  share = SPLIT_SIDE,
): boolean {
  const position = horizontal ? rule.y0 : rule.x0;
  if (Math.abs(position - at) > SNAP * 2) return false;
  const start = horizontal ? rule.x0 : rule.y0;
  const end = horizontal ? rule.x1 : rule.y1;
  // The rule has to run along most of the cell edge, not just touch it.
  const overlap = Math.min(end, to) - Math.max(start, from);
  return overlap >= (to - from) * share;
}

/**
 * Completes a rule group's grid where its outer border is not drawn: the group's box is
 * the extent of all its rules, and a side of it that no row or column line lies near gets an
 * undrawn line, so the cells along it are cells of the grid (a column of a form whose rules
 * stop at the first row line, a table framed on two sides only). The lines are added to
 * `xs` and `ys` in place; no rule is added, so the cells' sides there are drawn blank.
 *
 * A grid is only completed along an axis that already has two lines of its own (a single
 * divider crossed by a rule is not a lattice), at a side that two rules reach (a heading
 * between two rules, touched by a divider, is not a table), and when the strip added holds
 * text and is at least a quarter as wide as the cell next to it, or is at least half as wide
 * (a rule that overshoots its neighbour by a few points does not make a row, nor does a
 * divider that runs past a header rule and a footer rule make the page a table). The text
 * is a line that lies wholly in the strip: a caption that only touches it stays a paragraph.
 * A strip above or below the rules that holds lines of text one under the other (a header
 * row and a first row that no rule separates) is cut between them into the rows they are,
 * where the gap between two lines is at least a quarter of a line, a pitch of about 1.7 times
 * the size (a header cell wrapped in two lines at the font's own leading stays one row). No
 * pitch alone tells every wrapped leading from every row pitch: this one keeps the leadings
 * up to 16 pt at 10 pt type in a cell and cuts the pitches from 18 pt.
 * The cuts are returned, for they separate their rows although no rule is drawn there.
 */
function completeOuterEdges(
  horizontal: readonly Ruling[],
  vertical: readonly Ruling[],
  xs: number[],
  ys: number[],
  linesIn: (box: Box) => readonly Box[],
): number[] {
  const separate: number[] = [];
  const all = [...horizontal, ...vertical];
  const x0 = Math.min(...all.map((rule) => rule.x0));
  const x1 = Math.max(...all.map((rule) => rule.x1));
  const y0 = Math.min(...all.map((rule) => rule.y0));
  const y1 = Math.max(...all.map((rule) => rule.y1));
  const reaching = (rules: readonly Ruling[], reach: (rule: Ruling) => boolean) =>
    rules.filter(reach).length >= 2;
  const worth = (strip: number, pitch: number, box: Box) =>
    strip >= pitch / 2 || (strip >= pitch / 4 && linesIn(box).length > 0);
  /** The rows of text in a horizontal strip: the cuts between lines that stand one under the other. */
  const cuts = (box: Box): number[] => {
    const out: number[] = [];
    let foot = Number.NEGATIVE_INFINITY;
    for (const line of [...linesIn(box)].sort((a, b) => a[1] - b[1])) {
      if (foot !== Number.NEGATIVE_INFINITY && line[1] - foot >= (line[3] - line[1]) / 4)
        out.push((foot + line[1]) / 2);
      foot = Math.max(foot, line[3]);
    }
    return out;
  };
  const firstX = xs[0] as number;
  const lastX = xs[xs.length - 1] as number;
  const firstY = ys[0] as number;
  const lastY = ys[ys.length - 1] as number;
  // The rules decide the other axis too: read both before either is changed.
  if (xs.length >= 2) {
    const left = firstX - x0 > OUTER_GAP && reaching(horizontal, (rule) => rule.x0 <= x0 + SNAP);
    const right = x1 - lastX > OUTER_GAP && reaching(horizontal, (rule) => rule.x1 >= x1 - SNAP);
    if (left && worth(firstX - x0, (xs[1] as number) - firstX, [x0, y0, firstX, y1])) xs.unshift(x0);
    if (right && worth(x1 - lastX, lastX - (xs[xs.length - 2] as number), [lastX, y0, x1, y1])) xs.push(x1);
  }
  if (ys.length >= 2) {
    const top = firstY - y0 > OUTER_GAP && reaching(vertical, (rule) => rule.y0 <= y0 + SNAP);
    const bottom = y1 - lastY > OUTER_GAP && reaching(vertical, (rule) => rule.y1 >= y1 - SNAP);
    if (top && worth(firstY - y0, (ys[1] as number) - firstY, [x0, y0, x1, firstY])) {
      const cut = cuts([x0, y0, x1, firstY]);
      separate.push(...cut);
      ys.unshift(y0, ...cut);
      ys.sort((a, b) => a - b);
    }
    if (bottom && worth(y1 - lastY, lastY - (ys[ys.length - 2] as number), [x0, lastY, x1, y1])) {
      const cut = cuts([x0, lastY, x1, y1]);
      separate.push(...cut);
      ys.push(y1, ...cut);
      ys.sort((a, b) => a - b);
    }
  }
  return separate;
}

function textIn(lines: readonly LayoutLine[], box: Box): string {
  const out: string[] = [];
  for (const line of lines) {
    let row = '';
    for (const char of line.chars) {
      const cx = (char.box[0] + char.box[2]) / 2;
      const cy = (char.box[1] + char.box[3]) / 2;
      if (cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3]) row += char.c;
    }
    if (row.trim() !== '') out.push(row.trim());
  }
  return out.join('\n');
}

/** The ruled tables of a page, top to bottom. */
export function findTables(layout: PageLayout): LayoutTable[] {
  const horizontal = mergeRules(
    layout.rulings.filter((rule) => rule.y0 === rule.y1),
    true,
  );
  const vertical = mergeRules(
    layout.rulings.filter((rule) => rule.x0 === rule.x1),
    false,
  );
  // Connected components: a horizontal and a vertical rule touch where they cross.
  const all = [
    ...horizontal.map((rule) => ({ rule, h: true })),
    ...vertical.map((rule) => ({ rule, h: false })),
  ];
  const parent = all.map((_item, index) => index);
  const root = (index: number): number => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current] as number] as number;
      current = parent[current] as number;
    }
    return current;
  };
  for (let i = 0; i < horizontal.length; i += 1) {
    const h = horizontal[i] as Ruling;
    for (let j = 0; j < vertical.length; j += 1) {
      const v = vertical[j] as Ruling;
      if (
        v.x0 >= h.x0 - SNAP * 2 &&
        v.x0 <= h.x1 + SNAP * 2 &&
        h.y0 >= v.y0 - SNAP * 2 &&
        h.y0 <= v.y1 + SNAP * 2
      ) {
        parent[root(i)] = root(horizontal.length + j);
      }
    }
  }
  const groups = new Map<number, { h: Ruling[]; v: Ruling[] }>();
  all.forEach((item, index) => {
    const key = root(index);
    const group = groups.get(key) ?? { h: [], v: [] };
    (item.h ? group.h : group.v).push(item.rule);
    groups.set(key, group);
  });

  const lines = layout.blocks.flatMap((block) => (block.kind === 'text' ? block.lines : []));
  const tables: LayoutTable[] = [];
  for (const group of groups.values()) {
    const ys = cluster(group.h.map((rule) => rule.y0));
    const xs = cluster(group.v.map((rule) => rule.x0));
    const cut = completeOuterEdges(group.h, group.v, xs, ys, (strip) =>
      lines
        .filter(
          (line) =>
            line.box[0] >= strip[0] - 1 &&
            line.box[1] >= strip[1] - 1 &&
            line.box[2] <= strip[2] + 1 &&
            line.box[3] <= strip[3] + 1 &&
            line.chars.some((char) => char.c.trim() !== ''),
        )
        .map((line) => line.box),
    );
    if (xs.length < 3 || ys.length < 2) continue;
    const rows = ys.length - 1;
    const columns = xs.length - 1;
    const covered = new Set<string>();
    const cells: TableCell[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        if (covered.has(`${row}:${column}`)) continue;
        const top = ys[row] as number;
        const bottom = ys[row + 1] as number;
        // Grow right while no vertical rule separates this cell from the next.
        let columnSpan = 1;
        while (
          column + columnSpan < columns &&
          !group.v.some((rule) => covers(rule, false, xs[column + columnSpan] as number, top, bottom))
        ) {
          columnSpan += 1;
        }
        const left = xs[column] as number;
        let right = xs[column + columnSpan] as number;
        // Grow down while no horizontal rule separates this cell from the one below.
        let rowSpan = 1;
        while (
          row + rowSpan < rows &&
          !cut.includes(ys[row + rowSpan] as number) &&
          !group.h.some((rule) => covers(rule, true, ys[row + rowSpan] as number, left, right))
        ) {
          rowSpan += 1;
        }
        // A merged region is a rectangle: one that runs into a cell already placed is a
        // missing rule that does not bound a whole region, and its cell stays single.
        let clash = false;
        for (let r = row; r < row + rowSpan; r += 1) {
          for (let c = column; c < column + columnSpan; c += 1) {
            if ((r !== row || c !== column) && covered.has(`${r}:${c}`)) clash = true;
          }
        }
        if (clash) {
          columnSpan = 1;
          rowSpan = 1;
          right = xs[column + 1] as number;
        }
        for (let r = row; r < row + rowSpan; r += 1) {
          for (let c = column; c < column + columnSpan; c += 1) covered.add(`${r}:${c}`);
        }
        const foot = ys[row + rowSpan] as number;
        const box: Box = [left, top, right, foot];
        const side = (horizontal: boolean, at: number, from: number, to: number) =>
          (horizontal ? group.h : group.v).some((rule) => covers(rule, horizontal, at, from, to, DRAWN_SIDE));
        const borders = {
          top: side(true, top, left, right),
          bottom: side(true, foot, left, right),
          left: side(false, left, top, foot),
          right: side(false, right, top, foot),
        };
        cells.push({ row, column, rowSpan, columnSpan, box, text: textIn(lines, box), borders });
      }
    }
    // A frame around one paragraph, or rules under headings, is not a table.
    const filled = cells.filter((cell) => cell.text !== '').length;
    if (cells.length < 4 || filled < 2) continue;
    tables.push({
      box: [xs[0] as number, ys[0] as number, xs[xs.length - 1] as number, ys[ys.length - 1] as number],
      xs,
      ys,
      cells,
      ruled: true,
    });
  }
  return tables.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

/* ------------------------------------------------------------------ *
 * unruled rows ("stream")
 * ------------------------------------------------------------------ */

export interface TextRow {
  readonly y: number;
  /** Cells as `[columnIndex, text]`. */
  readonly cells: readonly (readonly [number, string])[];
}

/** Whether a character's centre lies inside a box (with a little tolerance). */
export function inside(char: LayoutChar, box: Box, tolerance = 1): boolean {
  const cx = (char.box[0] + char.box[2]) / 2;
  const cy = (char.box[1] + char.box[3]) / 2;
  return (
    cx >= box[0] - tolerance &&
    cx <= box[2] + tolerance &&
    cy >= box[1] - tolerance &&
    cy <= box[3] + tolerance
  );
}

interface Piece {
  readonly x0: number;
  readonly x1: number;
  readonly text: string;
  /** The text block the piece's line belongs to. */
  readonly block: number;
}

interface VisualRow {
  readonly y: number;
  top: number;
  bottom: number;
  readonly pieces: Piece[];
}

/**
 * A line cut into segments where the gap between two visible characters is wider than about
 * two spaces: the cells of a table that a line runs through, the words of a label and
 * its value. A segment keeps the spaces between its characters; the spaces that stand in a
 * gap go with the segment before it. Characters of one segment are never told apart.
 */
export function lineSegments(chars: readonly LayoutChar[]): LayoutChar[][] {
  const segments: LayoutChar[][] = [];
  let previous: LayoutChar | null = null;
  let pending: LayoutChar[] = [];
  for (const char of chars) {
    if (char.c.trim() === '') {
      pending.push(char);
      continue;
    }
    const gap = previous === null ? 0 : char.box[0] - previous.box[2];
    const wide = previous !== null && gap > Math.max(char.size, previous.size) * 1.2;
    const segment = segments[segments.length - 1];
    if (segment === undefined || wide) {
      // Spaces that open the line go with the first segment, those in a gap with the one before.
      if (segment !== undefined) segment.push(...pending);
      segments.push([...(segment === undefined ? pending : []), char]);
    } else segment.push(...pending, char);
    pending = [];
    previous = char;
  }
  const last = segments[segments.length - 1];
  if (last !== undefined) last.push(...pending);
  return segments;
}

/** Whether the centre of a segment's visible characters (a segment has some) lies inside a box (see `inside`). */
export function segmentInside(segment: readonly LayoutChar[], box: Box, tolerance = 1): boolean {
  const visible = segment.filter((char) => char.c.trim() !== '');
  const bounds: Box = [
    Math.min(...visible.map((char) => char.box[0])),
    Math.min(...visible.map((char) => char.box[1])),
    Math.max(...visible.map((char) => char.box[2])),
    Math.max(...visible.map((char) => char.box[3])),
  ];
  return inside({ ...(visible[0] as LayoutChar), box: bounds }, box, tolerance);
}

/**
 * The text outside `exclude` as visual rows: each line is cut into segments
 * (`lineSegments`), a segment is outside when its centre is, and lines that share a
 * baseline (the cells of one table row are often separate lines, or separate blocks) form
 * one row.
 */
function visualRows(layout: PageLayout, exclude: readonly Box[]): VisualRow[] {
  const rows: VisualRow[] = [];
  for (const [blockIndex, block] of layout.blocks.entries()) {
    if (block.kind !== 'text') continue;
    for (const line of block.lines) {
      const segments = lineSegments(line.chars).filter(
        (segment) => !exclude.some((box) => segmentInside(segment, box)),
      );
      if (segments.length === 0) continue;
      const groups = segments.map((segment) => segment.filter((char) => char.c.trim() !== ''));
      const pieces = segments.map((segment, index) => {
        const group = groups[index] as LayoutChar[];
        return {
          x0: (group[0] as LayoutChar).box[0],
          x1: (group[group.length - 1] as LayoutChar).box[2],
          block: blockIndex,
          text: segment
            .map((char) => char.c)
            .join('')
            .replace(/\s+/g, ' ')
            .trim(),
        };
      });
      const top = Math.min(...groups.flat().map((char) => char.box[1]));
      const bottom = Math.max(...groups.flat().map((char) => char.box[3]));
      const y = (top + bottom) / 2;
      const same = rows.find((row) => Math.abs(row.y - y) <= Math.max(2, (bottom - top) * 0.3));
      if (same !== undefined) {
        same.pieces.push(...pieces);
        same.top = Math.min(same.top, top);
        same.bottom = Math.max(same.bottom, bottom);
      } else rows.push({ y, top, bottom, pieces });
    }
  }
  rows.sort((a, b) => a.y - b.y);
  for (const row of rows) row.pieces.sort((a, b) => a.x0 - b.x0);
  return rows;
}

/**
 * Text outside the ruled tables as rows of cells, for a spreadsheet: every piece's left
 * edge is snapped to a column shared with the page's other rows.
 */
export function textRows(layout: PageLayout, exclude: readonly Box[]): TextRow[] {
  const rows = visualRows(layout, exclude);
  // Column anchors: every piece's left edge, clustered across the page.
  const anchors: number[] = [];
  for (const x of rows.flatMap((row) => row.pieces.map((piece) => piece.x0)).sort((a, b) => a - b)) {
    const last = anchors[anchors.length - 1];
    if (last === undefined || x - last > 8) anchors.push(x);
  }
  const columnOf = (x: number): number => {
    let best = 0;
    for (let index = 0; index < anchors.length; index += 1) {
      if ((anchors[index] as number) <= x + 4) best = index;
    }
    return best;
  };
  return rows.map((row) => {
    const cells: [number, string][] = [];
    for (const piece of row.pieces) {
      let column = columnOf(piece.x0);
      const last = cells[cells.length - 1];
      if (last !== undefined && column <= last[0]) column = last[0] + 1;
      cells.push([column, piece.text]);
    }
    return { y: row.y, cells };
  });
}

/** Cells longer than this on average are prose set in columns, not a table. */
const MAX_STREAM_CELL = 30;

/** Pieces this long, at the median, in a column's block are lines of prose, not cells. */
const PROSE_LINE = 20;

/** The share of the column's width a line of wrapped prose, a line of words, fills, all but its last. */
const PROSE_FILL = 0.92;

/**
 * How many columns hold a text block of prose: three or more lines of one block, long ones
 * at the median, that are either the block's own column — the block holds no piece of
 * another column — or wrap, each line but the last filling the column's width. Two such
 * columns side by side are two columns of text whose lines happen to stand on the same
 * baselines; read as a table, a reader would take them row by row across the columns
 * instead of one column after the other. A table whose cells are as long (20–30 characters)
 * is one block with cells of every width, and stays a table.
 */
function proseColumns(pieces: readonly Piece[], columnOf: (piece: Piece) => number): number {
  const groups = new Map<string, { column: number; block: number; lines: Piece[] }>();
  for (const piece of pieces) {
    const column = columnOf(piece);
    const key = `${column}:${piece.block}`;
    const group = groups.get(key) ?? { column, block: piece.block, lines: [] };
    group.lines.push(piece);
    groups.set(key, group);
  }
  const columns = new Set<number>();
  for (const { column, block, lines } of groups.values()) {
    const lengths = lines.map((line) => line.text.length).sort((x, y) => x - y);
    if (lines.length < 3 || (lengths[Math.floor(lengths.length / 2)] as number) < PROSE_LINE) continue;
    const own = pieces.every((piece) => piece.block !== block || columnOf(piece) === column);
    const inColumn = pieces.filter((piece) => columnOf(piece) === column);
    const width =
      Math.max(...inColumn.map((piece) => piece.x1)) - Math.min(...inColumn.map((piece) => piece.x0));
    // A column of references or amounts is as wide in every row too: wrapped lines hold words.
    const wraps = lines
      .slice(0, -1)
      .every((line) => line.text.includes(' ') && line.x1 - line.x0 >= PROSE_FILL * width);
    if (own || wraps) columns.add(column);
  }
  return columns.size;
}

/**
 * A table without rules, from consecutive rows that each hold two or more pieces of text.
 * Its columns are the gaps that run through all of its rows: every piece is projected onto
 * the x axis and the covered stretches merged, so a left-, right- or centre-aligned column
 * is one column. Prose set in two columns also has two pieces a row; its long pieces are
 * what tell it apart (`MAX_STREAM_CELL`).
 */
function streamTable(rows: readonly VisualRow[]): LayoutTable | null {
  if (rows.length < 2) return null;
  const pieces = rows.flatMap((row) => row.pieces);
  const average = pieces.reduce((sum, piece) => sum + piece.text.length, 0) / pieces.length;
  if (average > MAX_STREAM_CELL) return null;
  const spans: [number, number][] = [];
  for (const piece of [...pieces].sort((a, b) => a.x0 - b.x0)) {
    const last = spans[spans.length - 1];
    if (last !== undefined && piece.x0 <= last[1] + 2) last[1] = Math.max(last[1], piece.x1);
    else spans.push([piece.x0, piece.x1]);
  }
  if (spans.length < 2 || spans.length > 20) return null;
  // Every piece lies in the span built from it, so the column always exists.
  const columnOf = (piece: Piece): number => {
    const centre = (piece.x0 + piece.x1) / 2;
    return spans.findIndex((span) => centre >= span[0] - 1 && centre <= span[1] + 1);
  };
  if (proseColumns(pieces, columnOf) >= 2) return null;
  const xs = [
    (spans[0] as [number, number])[0] - 2,
    ...spans.slice(1).map((span, index) => ((spans[index] as [number, number])[1] + span[0]) / 2),
    (spans[spans.length - 1] as [number, number])[1] + 2,
  ];
  const ys = [
    (rows[0] as VisualRow).top - 1,
    ...rows.slice(1).map((row, index) => ((rows[index] as VisualRow).bottom + row.top) / 2),
    (rows[rows.length - 1] as VisualRow).bottom + 1,
  ];
  const cells: TableCell[] = [];
  let full = 0;
  rows.forEach((row, rowIndex) => {
    const texts = spans.map(() => [] as string[]);
    for (const piece of row.pieces) (texts[columnOf(piece)] as string[]).push(piece.text);
    if (texts.filter((text) => text.length > 0).length >= 2) full += 1;
    texts.forEach((text, column) => {
      cells.push({
        row: rowIndex,
        column,
        rowSpan: 1,
        columnSpan: 1,
        box: [
          xs[column] as number,
          ys[rowIndex] as number,
          xs[column + 1] as number,
          ys[rowIndex + 1] as number,
        ],
        text: text.join(' '),
      });
    });
  });
  if (full < 2) return null;
  return {
    box: [xs[0] as number, ys[0] as number, xs[xs.length - 1] as number, ys[ys.length - 1] as number],
    xs,
    ys,
    cells,
    ruled: false,
  };
}

/**
 * Tables drawn without rules ("stream" mode): runs of consecutive rows with two or more
 * pieces each, no wider apart than one and a half lines. A row of one piece ends a run.
 */
export function findTextTables(layout: PageLayout, exclude: readonly Box[]): LayoutTable[] {
  const tables: LayoutTable[] = [];
  let run: VisualRow[] = [];
  const close = () => {
    const table = streamTable(run);
    if (table !== null) tables.push(table);
    run = [];
  };
  for (const row of visualRows(layout, exclude)) {
    if (row.pieces.length < 2) {
      close();
      continue;
    }
    const last = run[run.length - 1];
    if (last !== undefined) {
      const height = Math.max(row.bottom - row.top, last.bottom - last.top);
      if (row.top - last.bottom > height * 1.5) close();
    }
    run.push(row);
  }
  close();
  return tables;
}
