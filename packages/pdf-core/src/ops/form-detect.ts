/**
 * Prepare form: find the fields a flat PDF means to have, let the user review them, and
 * create them as real AcroForm fields.
 *
 * Two operations, with the review in between (the UI owns it):
 *
 *  - {@link detectFormFields} is a **read**. It runs each page through MuPDF twice — the
 *    structured-text walker for the words, a device for the drawing — and hands the model to
 *    the pure rules in `form-detect-rules.ts`. Nothing is written, so a document that is
 *    only inspected keeps its incremental fast path.
 *  - {@link createDetectedFields} writes the candidates the user kept through
 *    `createFormFields`, then **reads the result back**: every field must exist under its
 *    name, with its type, on its page, at the rectangle it was asked for.
 *
 * ## Spaces
 *
 * The rules work in MuPDF's displayed page space (turned by `/Rotate`, origin top-left). The
 * app's marks live in *app space* — upright user-space x, y counted down from the page box's
 * top edge (`mark-interaction.ts`) — and a widget's `/Rect` is user space. A candidate carries
 * app space, so the overlay places it with the same frame every other mark uses; the writer
 * flips it once, and a turned page gets `/MK /R` so a field draws upright on it.
 *
 * ## What a scan is
 *
 * A scanned page has no drawing to read: its rules are pixels. A page that is only a picture
 * *with* a text layer (OCR has run) is read from its pixels for horizontal rules, which
 * is reliable for underlines and nothing else (no boxes, no circles), and its fields are
 * `medium` however well they are labelled. A page that is only a picture with *no* text has
 * no labels to name a field with; it is reported as needing OCR first rather than guessed at.
 *
 * ## Prior art
 *
 * FFDNet / CommonForms train an object detector on rendered pages; Acrobat's Prepare Form
 * and Foxit's form recognition are rule-based on the page's drawing, as this is. A learned
 * model would need a download and would run on pixels; this runs on the vectors the file
 * already holds and needs none.
 */

import type { Matrix, Page, Path, PDFPage } from 'mupdf';
import { ToolError } from 'pdf-shared';
import {
  loadMupdf,
  type Mupdf,
  mapMupdfError,
  openPdf,
  readPageBox,
  readPageRotation,
  topLeftRectToUserSpace,
  type UserBox,
} from '../engines/mupdf';
import {
  type Box,
  type CandidateKind,
  type CandidateSource,
  type Confidence,
  type DetectChar,
  type DetectionPage,
  detectPageFields,
  type HLine,
  type RawCandidate,
  type Shape,
  uniqueName,
  type VLine,
} from './form-detect-rules';
import {
  createFormFields,
  type FieldCreation,
  type FormFieldKind,
  readFormFields,
  readFormWidgets,
} from './forms';
import {
  apply,
  borrowed,
  findTables,
  type LayoutBlock,
  readPageLayout,
  rgb,
  transformBox,
} from './page-layout';
import { note, type OperationContext, type OperationOutcome, throwIfAborted } from './types';

export type { CandidateKind, CandidateSource, Confidence } from './form-detect-rules';

/** A field the page suggests, in app space, ready to be reviewed and created. */
export interface FieldCandidate {
  /** Stable within one detection; the review keys on it. */
  readonly id: string;
  readonly kind: CandidateKind;
  /** 0-based page. */
  readonly pageIndex: number;
  /** `x0, y0, x1, y1` in app space: upright user-space x, y down from the page box's top edge. */
  readonly rect: Box;
  /** The field's name; a radio button carries its group's. */
  readonly name: string;
  /** The label the name came from, as printed. */
  readonly label: string;
  readonly confidence: Confidence;
  readonly source: CandidateSource;
  /** Font size in points for a text field. */
  readonly size: number;
  /** Radio buttons of one group share this key (unique across pages). */
  readonly group?: string;
  /** A radio button's own text. */
  readonly option?: string;
  /** Equal cells of a comb field. */
  readonly cells?: number;
  readonly multiline?: boolean;
}

export interface FormDetection {
  readonly candidates: readonly FieldCandidate[];
  readonly pageCount: number;
  /** Pages that are only a picture and carry no text: nothing to name a field from. */
  readonly needsOcr: readonly number[];
  /** Pages whose rules were read from pixels. */
  readonly rasterPages: readonly number[];
  /** Candidates dropped because a form field already sits there. */
  readonly alreadyFields: number;
  /** More than `MAX_CANDIDATES` were found; the rest are not listed. */
  readonly truncated: boolean;
}

/** One page cannot be asked for more fields than a person could review. */
const MAX_CANDIDATES = 400;
/** A picture over this share of the page makes it a scan. */
const SCAN_SHARE = 0.55;
/** Raster resolution for a scan's rules, pixels per point. */
const RASTER_SCALE = 2;

// ---------------------------------------------------------------------------
// reading a page
// ---------------------------------------------------------------------------

interface PageDrawing {
  readonly rects: Shape[];
  readonly circles: Shape[];
  readonly ink: Box[];
  readonly dots: { x: number; y: number }[];
  /** Largest share of the page a single picture covers. */
  pictureShare: number;
}

function luminanceOf(color: readonly number[]): number {
  const value = rgb(color);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

interface Subpath {
  points: [number, number][];
  lines: number;
  curves: number;
}

/** A subpath's points in page space, with how many lines and curves it holds. */
function walkSubpaths(path: Path, ctm: Matrix): Subpath[] {
  const out: Subpath[] = [];
  // MuPDF opens every path with a `moveTo`, so a line or a curve always extends the last subpath.
  const last = (): Subpath => out[out.length - 1] as Subpath;
  path.walk({
    moveTo(x, y) {
      out.push({ points: [apply(ctm, x, y) as [number, number]], lines: 0, curves: 0 });
    },
    lineTo(x, y) {
      const current = last();
      current.points.push(apply(ctm, x, y) as [number, number]);
      current.lines += 1;
    },
    curveTo(x1, y1, x2, y2, x3, y3) {
      const current = last();
      current.points.push(
        apply(ctm, x1, y1) as [number, number],
        apply(ctm, x2, y2) as [number, number],
        apply(ctm, x3, y3) as [number, number],
      );
      current.curves += 1;
    },
    closePath() {},
  });
  return out;
}

function boundsOf(points: readonly (readonly [number, number])[]): Box {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Whether four or five points walk the outline of an upright rectangle. */
function isRectangle(points: readonly (readonly [number, number])[]): boolean {
  const corners =
    points.length === 5 && samePoint(points[0] as [number, number], points[4] as [number, number])
      ? points.slice(0, 4)
      : points;
  if (corners.length !== 4) return false;
  for (let index = 0; index < 4; index += 1) {
    const from = corners[index] as readonly [number, number];
    const to = corners[(index + 1) % 4] as readonly [number, number];
    const horizontal = Math.abs(from[1] - to[1]) <= 0.3;
    const vertical = Math.abs(from[0] - to[0]) <= 0.3;
    if (horizontal === vertical) return false;
  }
  return true;
}

function samePoint(a: readonly [number, number], b: readonly [number, number]): boolean {
  return Math.abs(a[0] - b[0]) <= 0.3 && Math.abs(a[1] - b[1]) <= 0.3;
}

/**
 * The drawing of a page: rectangles, circles, dots (a dotted line is many of them), and the
 * box of everything else painted. Straight rules are read by `readPageLayout`.
 */
function readDrawing(
  mupdf: Mupdf,
  page: Page,
  shift: (x: number, y: number) => readonly [number, number],
): PageDrawing {
  const [px0, py0, px1, py1] = page.getBounds();
  const pageArea = (px1 - px0) * (py1 - py0);
  const drawing: PageDrawing = { rects: [], circles: [], ink: [], dots: [], pictureShare: 0 };
  const place = (box: Box): Box => {
    const [x0, y0] = shift(box[0], box[1]);
    const [x1, y1] = shift(box[2], box[3]);
    return [x0, y0, x1, y1];
  };

  const paint = (path: Path, ctm: Matrix, stroked: boolean, color: readonly number[]): void => {
    const shapes: { readonly kind: 'rect' | 'circle'; readonly box: Box }[] = [];
    for (const sub of walkSubpaths(path, ctm)) {
      if (sub.points.length < 2) continue;
      const box = place(boundsOf(sub.points));
      const w = box[2] - box[0];
      const h = box[3] - box[1];
      if (w * h > pageArea * 0.5) continue;
      if (w <= 3.2 && h <= 3.2) {
        drawing.dots.push({ x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 });
        continue;
      }
      if (sub.curves === 0 && isRectangle(sub.points) && Math.min(w, h) > 2.5) {
        shapes.push({ kind: 'rect', box });
        continue;
      }
      // Curves all round and no straight side: a circle (an ellipse is not one).
      if (sub.curves >= 4 && sub.lines <= 1 && Math.min(w, h) > 2.5) {
        shapes.push({ kind: 'circle', box });
        continue;
      }
      // A rounded rectangle is a box with soft corners: curves at the corners, lines between.
      if (sub.curves >= 4 && sub.lines >= 2 && Math.min(w, h) > 2.5) {
        shapes.push({ kind: 'rect', box });
        continue;
      }
      // A straight rule is not ink; anything else drawn inside a square makes it a marked one.
      if (Math.min(w, h) > 1.5 && drawing.ink.length < 40000) drawing.ink.push(box);
    }
    // A fill of an outline inside an outline is how a border is painted (a browser's rounded
    // input, a radio button's ring): one stroked shape, whatever colour the border is.
    const rings = new Set<number>();
    if (!stroked) {
      shapes.forEach((outer, at) => {
        if (rings.has(at)) return;
        const inner = shapes.findIndex(
          (other, index) =>
            index !== at &&
            !rings.has(index) &&
            other.kind === outer.kind &&
            other.box[0] - outer.box[0] >= 0.2 &&
            other.box[1] - outer.box[1] >= 0.2 &&
            outer.box[2] - other.box[2] >= 0.2 &&
            outer.box[3] - other.box[3] >= 0.2 &&
            other.box[0] - outer.box[0] <= 4 &&
            other.box[1] - outer.box[1] <= 4,
        );
        if (inner < 0) return;
        rings.add(at);
        rings.add(inner);
        (outer.kind === 'rect' ? drawing.rects : drawing.circles).push({
          box: outer.box,
          stroked: true,
          luminance: null,
        });
      });
    }
    shapes.forEach((shape, at) => {
      if (rings.has(at)) return;
      (shape.kind === 'rect' ? drawing.rects : drawing.circles).push({
        box: shape.box,
        stroked,
        luminance: stroked ? null : luminanceOf(color),
      });
    });
  };

  const picture = (box: Box): void => {
    const shown = place(box);
    const share = ((shown[2] - shown[0]) * (shown[3] - shown[1])) / Math.max(1, pageArea);
    drawing.pictureShare = Math.max(drawing.pictureShare, share);
    if (share < 0.02 && drawing.ink.length < 40000) drawing.ink.push(shown);
  };

  const device = new mupdf.Device({
    fillPath(path, _evenOdd, ctm, _colorspace, color) {
      paint(path, ctm, false, color);
    },
    strokePath(path, _stroke, ctm, _colorspace, color) {
      paint(path, ctm, true, color);
    },
    fillShade(shade, ctm) {
      borrowed(shade);
      picture(transformBox(shade.getBounds(), ctm));
    },
    fillImage(image, ctm) {
      borrowed(image);
      picture(transformBox([0, 0, 1, 1], ctm));
    },
    fillImageMask(image, ctm) {
      borrowed(image);
      picture(transformBox([0, 0, 1, 1], ctm));
    },
  });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }
  return drawing;
}

/** Many small dots in a row: a dotted line. */
function dottedLines(dots: readonly { x: number; y: number }[]): HLine[] {
  const rows = new Map<number, number[]>();
  for (const dot of dots) {
    const key = Math.round(dot.y / 1.5);
    const row = rows.get(key) ?? [];
    row.push(dot.x);
    rows.set(key, row);
  }
  const lines: HLine[] = [];
  for (const [key, xs] of rows) {
    xs.sort((a, b) => a - b);
    let start = 0;
    for (let index = 1; index <= xs.length; index += 1) {
      const gap =
        index < xs.length ? (xs[index] as number) - (xs[index - 1] as number) : Number.POSITIVE_INFINITY;
      if (gap > 7) {
        const run = xs.slice(start, index);
        if (run.length >= 8 && (run[run.length - 1] as number) - (run[0] as number) >= 28) {
          lines.push({ x0: run[0] as number, x1: run[run.length - 1] as number, y: key * 1.5 });
        }
        start = index;
      }
    }
  }
  return lines;
}

/**
 * The horizontal rules of a scanned page, from its pixels.
 *
 * The page is rendered in grey at `RASTER_SCALE`, thresholded, and every run of dark
 * pixels wider than the shortest field is kept when it is thin (at most about 2 pt):
 * a letter never makes a run that long, a photo or a filled box makes a thick one. Runs on
 * neighbouring rows that overlap are one rule.
 */
function rasterRules(mupdf: Mupdf, page: Page): HLine[] {
  const matrix = mupdf.Matrix.scale(RASTER_SCALE, RASTER_SCALE);
  const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceGray, false, true);
  try {
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const stride = pixmap.getStride();
    const channels = pixmap.getNumberOfComponents();
    const pixels = pixmap.getPixels();
    const histogram = new Array<number>(256).fill(0);
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const level = pixels[y * stride + x * channels] as number;
        histogram[level] = (histogram[level] as number) + 1;
      }
    }
    // Otsu: the threshold that separates paper from ink best.
    let total = 0;
    let weighted = 0;
    for (let level = 0; level < 256; level += 1) {
      total += histogram[level] as number;
      weighted += level * (histogram[level] as number);
    }
    let backgroundWeight = 0;
    let backgroundSum = 0;
    let best = 0;
    let threshold = 128;
    for (let level = 0; level < 256; level += 1) {
      backgroundWeight += histogram[level] as number;
      if (backgroundWeight === 0) continue;
      const foregroundWeight = total - backgroundWeight;
      if (foregroundWeight === 0) break;
      backgroundSum += level * (histogram[level] as number);
      const meanBackground = backgroundSum / backgroundWeight;
      const meanForeground = (weighted - backgroundSum) / foregroundWeight;
      const between = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
      if (between > best) {
        best = between;
        threshold = level;
      }
    }
    threshold = Math.min(threshold, 150);

    const minRun = Math.floor(28 * RASTER_SCALE);
    interface Run {
      x0: number;
      x1: number;
      y0: number;
      y1: number;
      sum: number;
    }
    let open: Run[] = [];
    const done: Run[] = [];
    for (let y = 0; y < height; y += 1) {
      const rowRuns: { x0: number; x1: number }[] = [];
      let start = -1;
      let lastDark = -1;
      for (let x = 0; x <= width; x += 1) {
        const dark = x < width && (pixels[y * stride + x * channels] as number) <= threshold;
        if (dark) {
          if (start < 0) start = x;
          lastDark = x;
        } else if (start >= 0 && x - lastDark > 2) {
          if (lastDark - start + 1 >= minRun) rowRuns.push({ x0: start, x1: lastDark });
          start = -1;
        }
      }
      const next: Run[] = [];
      for (const run of rowRuns) {
        const parent = open.find(
          (candidate) =>
            Math.min(candidate.x1, run.x1) - Math.max(candidate.x0, run.x0) >
            0.8 * Math.min(candidate.x1 - candidate.x0, run.x1 - run.x0),
        );
        if (parent === undefined) next.push({ ...run, y0: y, y1: y, sum: y });
        else {
          parent.x0 = Math.min(parent.x0, run.x0);
          parent.x1 = Math.max(parent.x1, run.x1);
          parent.y1 = y;
          parent.sum += y;
          next.push(parent);
        }
      }
      for (const run of open) if (!next.includes(run)) done.push(run);
      open = next;
    }
    done.push(...open);
    return done
      .filter((run) => run.y1 - run.y0 + 1 <= Math.ceil(2.2 * RASTER_SCALE))
      .map((run) => ({
        x0: run.x0 / RASTER_SCALE,
        x1: (run.x1 + 1) / RASTER_SCALE,
        y: (run.sum / (run.y1 - run.y0 + 1) + 0.5) / RASTER_SCALE,
      }));
  } finally {
    pixmap.destroy();
  }
}

interface ReadPage {
  readonly model: DetectionPage;
  readonly picture: boolean;
  readonly hasText: boolean;
  readonly raster: boolean;
}

/** One page as the rules want it. */
export function readDetectionPage(mupdf: Mupdf, page: Page): ReadPage {
  const [px0, py0, px1, py1] = page.getBounds();
  const shift = (x: number, y: number): readonly [number, number] => [x - px0, y - py0];
  const layout = readPageLayout(mupdf, page, { images: false });
  const drawing = readDrawing(mupdf, page, shift);

  // `images: false` reads no picture blocks; the filter is what narrows the type.
  const lines = layout.blocks
    .filter((block): block is Extract<LayoutBlock, { kind: 'text' }> => block.kind === 'text')
    .flatMap((block) =>
      block.lines.map((line) => ({
        chars: line.chars.map((char): DetectChar => ({ c: char.c, box: char.box, size: char.size })),
      })),
    );
  const hasText = lines.some((line) => line.chars.some((char) => char.c.trim() !== ''));
  const hlines: HLine[] = [];
  const vlines: VLine[] = [];
  for (const rule of layout.rulings) {
    if (rule.y0 === rule.y1) hlines.push({ x0: rule.x0, x1: rule.x1, y: rule.y0 });
    else vlines.push({ x: rule.x0, y0: rule.y0, y1: rule.y1 });
  }
  hlines.push(...dottedLines(drawing.dots));

  const picture = drawing.pictureShare >= SCAN_SHARE;
  let raster = false;
  // A scan has its rules in pixels. Only a page with text can use them (labels), and only
  // a page whose own drawing offers no rules.
  if (picture && hasText && hlines.length < 3) {
    hlines.push(...rasterRules(mupdf, page));
    raster = true;
  }

  const tables = findTables(layout).map((table) => ({
    box: table.box,
    cells: table.cells.map((cell) => ({
      row: cell.row,
      column: cell.column,
      box: cell.box,
      text: cell.text,
    })),
  }));
  return {
    model: {
      width: px1 - px0,
      height: py1 - py0,
      lines,
      hlines,
      vlines,
      rects: drawing.rects,
      circles: drawing.circles,
      ink: drawing.ink,
      tables,
      ...(raster ? { raster: true } : {}),
    },
    picture,
    hasText,
    raster,
  };
}

// ---------------------------------------------------------------------------
// spaces
// ---------------------------------------------------------------------------

/**
 * A rectangle in MuPDF's displayed space → app space (upright user-space x, y down from the
 * page box's top edge). The inverse of `userToPageSpace` in `engines/mupdf.ts`, composed with
 * the one flip `topLeftToUserPoint` does.
 */
export function displayToAppRect(rotation: 0 | 90 | 180 | 270, box: UserBox, rect: Box): Box {
  const toApp = (u: number, v: number): readonly [number, number] => {
    switch (rotation) {
      case 90:
        return [v + box.x, box.height - u];
      case 180:
        return [box.x + box.width - u, box.height - v];
      case 270:
        return [box.x + box.width - v, u];
      default:
        return [u + box.x, v];
    }
  };
  const [ax, ay] = toApp(rect[0], rect[1]);
  const [bx, by] = toApp(rect[2], rect[3]);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}

function rotationOf(page: PDFPage): 0 | 90 | 180 | 270 {
  try {
    return readPageRotation(page);
  } catch {
    // An odd /Rotate is refused where it would corrupt a write; reading treats it as upright.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

/** Existing widgets, per page, in app space: a field there already is not proposed again. */
async function existingWidgets(
  bytes: Uint8Array,
  pages: readonly { readonly box: UserBox; readonly rotation: 0 | 90 | 180 | 270 }[],
): Promise<{ names: Set<string>; rects: Map<number, Box[]> }> {
  const names = new Set<string>();
  const rects = new Map<number, Box[]>();
  for (const field of await readFormWidgets(bytes)) {
    names.add(field.name.toLowerCase());
    for (const widget of field.widgets) {
      // A widget that sits on no page of the document cannot be over a candidate.
      if (widget.pageIndex === null) continue;
      const page = pages[widget.pageIndex] as { readonly box: UserBox };
      const list = rects.get(widget.pageIndex) ?? [];
      const [x0, y0, x1, y1] = widget.rect;
      list.push([x0, page.box.y + page.box.height - y1, x1, page.box.y + page.box.height - y0]);
      rects.set(widget.pageIndex, list);
    }
  }
  return { names, rects };
}

function overlapsAny(rect: Box, others: readonly Box[]): boolean {
  const area = Math.max(1, (rect[2] - rect[0]) * (rect[3] - rect[1]));
  return others.some((other) => {
    const w = Math.min(rect[2], other[2]) - Math.max(rect[0], other[0]);
    const h = Math.min(rect[3], other[3]) - Math.max(rect[1], other[1]);
    return w > 0 && h > 0 && (w * h) / area > 0.3;
  });
}

/**
 * Find the fields of a document without any: a read.
 *
 * Existing fields are left alone: a candidate that lies over a widget is dropped (and
 * counted), and a new name never repeats an existing one.
 */
export async function detectFormFields(bytes: Uint8Array, context: OperationContext): Promise<FormDetection> {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    const pageCount = doc.countPages();
    const geometry: { box: UserBox; rotation: 0 | 90 | 180 | 270 }[] = [];
    for (let index = 0; index < pageCount; index += 1) {
      const page = doc.loadPage(index);
      try {
        geometry.push({ box: readPageBox(page), rotation: rotationOf(page) });
      } finally {
        page.destroy();
      }
    }
    const existing = await existingWidgets(bytes, geometry);
    const taken = new Set(existing.names);
    const candidates: FieldCandidate[] = [];
    const needsOcr: number[] = [];
    const rasterPages: number[] = [];
    let alreadyFields = 0;
    let truncated = false;

    for (let index = 0; index < pageCount && !truncated; index += 1) {
      throwIfAborted(context.signal);
      context.onProgress?.({
        phase: 'detect',
        labelKey: 'op.progress.formDetect',
        done: index,
        total: pageCount,
      });
      const page = doc.loadPage(index);
      let raw: RawCandidate[];
      try {
        const read = readDetectionPage(mupdf, page);
        if (read.picture && !read.hasText) {
          needsOcr.push(index);
          raw = [];
        } else {
          if (read.raster) rasterPages.push(index);
          raw = detectPageFields(read.model);
        }
      } finally {
        page.destroy();
      }
      const pageGeometry = geometry[index] as { box: UserBox; rotation: 0 | 90 | 180 | 270 };
      const groupNames = new Map<string, string>();
      for (const [order, candidate] of raw.entries()) {
        const rect = displayToAppRect(pageGeometry.rotation, pageGeometry.box, candidate.rect);
        if (overlapsAny(rect, existing.rects.get(index) ?? [])) {
          alreadyFields += 1;
          continue;
        }
        if (candidates.length >= MAX_CANDIDATES) {
          truncated = true;
          break;
        }
        let name: string;
        if (candidate.kind === 'radio' && candidate.group !== undefined) {
          const key = `${index}:${candidate.group}`;
          const known = groupNames.get(key);
          name = known ?? uniqueName(candidate.label, 'radio', taken);
          groupNames.set(key, name);
        } else name = uniqueName(candidate.label, candidate.kind, taken);
        candidates.push({
          id: `${index + 1}-${order + 1}`,
          kind: candidate.kind,
          pageIndex: index,
          rect,
          name,
          label: candidate.label,
          confidence: candidate.confidence,
          source: candidate.source,
          size: candidate.size,
          ...(candidate.group === undefined ? {} : { group: `${index}:${candidate.group}` }),
          ...(candidate.option === undefined ? {} : { option: candidate.option }),
          ...(candidate.cells === undefined ? {} : { cells: candidate.cells }),
          ...(candidate.multiline === true ? { multiline: true } : {}),
        });
      }
      // Give the event loop a turn so the progress bar and Cancel stay live.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { candidates, pageCount, needsOcr, rasterPages, alreadyFields, truncated };
  } catch (error) {
    if (error instanceof ToolError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw mapMupdfError(error, 'form.detect');
  } finally {
    doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

/** What `createDetectedFields` made, for the report and the tests. */
export interface CreatedField {
  readonly name: string;
  readonly kind: FormFieldKind;
  readonly pageIndex: number;
  readonly widgets: number;
}

const FONT_MIN = 6;
const FONT_MAX = 12;

/** A font that fits a field of this height and follows the label's size. */
function fontFor(candidate: FieldCandidate): number {
  const height = candidate.rect[3] - candidate.rect[1];
  return Math.round(Math.min(FONT_MAX, Math.max(FONT_MIN, Math.min(candidate.size, height - 3))) * 2) / 2;
}

/**
 * Create the fields the user kept, then read them back.
 *
 * The read-back is the point: a field is only created if the document, parsed again from
 * the bytes this returns, holds a field of that name and type on that page at that
 * rectangle (within 0.75 pt). Anything else throws `verification-failed` and the caller
 * keeps its document.
 */
export async function createDetectedFields(
  bytes: Uint8Array,
  candidates: readonly FieldCandidate[],
  context: OperationContext,
): Promise<OperationOutcome & { readonly created: readonly CreatedField[] }> {
  if (candidates.length === 0) throw new ToolError('selection-empty', { engine: 'mupdf' });
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  const geometry = new Map<number, { box: UserBox; rotation: 0 | 90 | 180 | 270 }>();
  try {
    for (const index of new Set(candidates.map((candidate) => candidate.pageIndex))) {
      if (index < 0 || index >= doc.countPages()) {
        throw new ToolError('range-invalid', {
          engine: 'mupdf',
          engineMessage: `candidate on page ${index + 1} of ${doc.countPages()}`,
        });
      }
      const page = doc.loadPage(index);
      try {
        geometry.set(index, { box: readPageBox(page), rotation: readPageRotation(page) });
      } finally {
        page.destroy();
      }
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw mapMupdfError(error, 'form.detect');
  } finally {
    doc.destroy();
  }

  const userRect = (candidate: FieldCandidate): readonly [number, number, number, number] => {
    const page = geometry.get(candidate.pageIndex) as { box: UserBox };
    const [x0, y0, x1, y1] = topLeftRectToUserSpace(page.box, candidate.rect);
    return [x0, y0, x1 - x0, y1 - y0];
  };
  const rotationOfPage = (candidate: FieldCandidate): 0 | 90 | 180 | 270 =>
    (geometry.get(candidate.pageIndex) as { rotation: 0 | 90 | 180 | 270 }).rotation;

  const specs: FieldCreation[] = [];
  const expected: {
    name: string;
    kind: FormFieldKind;
    pageIndex: number;
    rects: (readonly [number, number, number, number])[];
  }[] = [];
  const done = new Set<string>();
  for (const candidate of candidates) {
    if (done.has(candidate.id)) continue;
    const common = {
      pageIndex: candidate.pageIndex,
      plain: true,
      rotation: rotationOfPage(candidate),
    } as const;
    if (candidate.kind === 'radio' && candidate.group !== undefined) {
      const members = candidates.filter((other) => other.kind === 'radio' && other.group === candidate.group);
      for (const member of members) done.add(member.id);
      if (members.length >= 2) {
        // Option texts must differ: they are what the field's value is read back as.
        const seen = new Set<string>();
        const options = members.map((member, order) => {
          const named = (member.option ?? '').trim();
          const base = named === '' ? `Option ${order + 1}` : named;
          let option = base;
          for (let count = 2; seen.has(option); count += 1) option = `${base} ${count}`;
          seen.add(option);
          return option;
        });
        const rects = members.map(userRect);
        specs.push({
          ...common,
          kind: 'radio',
          name: candidate.name,
          rect: rects[0] as readonly [number, number, number, number],
          options,
          optionRects: rects,
        });
        expected.push({ name: candidate.name, kind: 'radio', pageIndex: candidate.pageIndex, rects });
        continue;
      }
      // A radio group with one button left cannot be answered or cleared: a checkbox it is.
      const rect = userRect(candidate);
      specs.push({ ...common, kind: 'checkbox', name: candidate.name, rect });
      expected.push({
        name: candidate.name,
        kind: 'checkbox',
        pageIndex: candidate.pageIndex,
        rects: [rect],
      });
      continue;
    }
    done.add(candidate.id);
    const rect = userRect(candidate);
    if (candidate.kind === 'checkbox') {
      specs.push({ ...common, kind: 'checkbox', name: candidate.name, rect });
      expected.push({
        name: candidate.name,
        kind: 'checkbox',
        pageIndex: candidate.pageIndex,
        rects: [rect],
      });
    } else if (candidate.kind === 'signature') {
      specs.push({ ...common, kind: 'signature', name: candidate.name, rect });
      expected.push({
        name: candidate.name,
        kind: 'signature',
        pageIndex: candidate.pageIndex,
        rects: [rect],
      });
    } else {
      specs.push({
        ...common,
        kind: 'text',
        name: candidate.name,
        rect,
        fontSize: fontFor(candidate),
        ...(candidate.multiline === true ? { multiline: true } : {}),
        ...(candidate.cells === undefined ? {} : { comb: candidate.cells }),
      });
      expected.push({ name: candidate.name, kind: 'text', pageIndex: candidate.pageIndex, rects: [rect] });
    }
  }

  const before = (await readFormFields(bytes)).length;
  const outcome = await createFormFields(bytes, specs, context);
  throwIfAborted(context.signal);

  // Read the result back, as a reader would find it.
  const widgets = await readFormWidgets(outcome.bytes);
  const problems: string[] = [];
  if (widgets.length !== before + specs.length) {
    problems.push(`${widgets.length} fields after, ${before} + ${specs.length} expected`);
  }
  for (const want of expected) {
    const found = widgets.find((field) => field.name === want.name);
    if (found === undefined) {
      problems.push(`${want.name}: missing`);
      continue;
    }
    if (found.kind !== want.kind) problems.push(`${want.name}: ${found.kind}, expected ${want.kind}`);
    if (found.widgets.length !== want.rects.length) {
      problems.push(`${want.name}: ${found.widgets.length} widgets, expected ${want.rects.length}`);
      continue;
    }
    for (const [at, rect] of want.rects.entries()) {
      // The two lists have the same length (checked above).
      const widget = found.widgets[at] as (typeof found.widgets)[number];
      const [x, y, w, h] = rect;
      const matches =
        widget.pageIndex === want.pageIndex &&
        Math.abs(widget.rect[0] - x) <= 0.75 &&
        Math.abs(widget.rect[1] - y) <= 0.75 &&
        Math.abs(widget.rect[2] - (x + w)) <= 0.75 &&
        Math.abs(widget.rect[3] - (y + h)) <= 0.75;
      if (!matches) problems.push(`${want.name}: widget ${at + 1} is not where it was placed`);
    }
  }
  if (problems.length > 0) {
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: problems.slice(0, 8).join('; '),
    });
  }

  const created: CreatedField[] = expected.map((want) => ({
    name: want.name,
    kind: want.kind,
    pageIndex: want.pageIndex,
    widgets: want.rects.length,
  }));
  return {
    ...outcome,
    created,
    report: {
      ...outcome.report,
      steps: ['load', 'form.createField', 'verify', 'save'],
      notes: [
        note('changed', 'formDetect.note.created', { count: specs.length }),
        note('preserved', 'formDetect.note.pageUnchanged'),
        note('preserved', 'formDetect.note.verified'),
        note('warning', 'formDetect.note.review'),
      ],
    },
  };
}
