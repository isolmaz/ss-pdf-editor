/**
 * Page boxes and page size ("Media/Crop/Trim/Bleed/Art,
 * resize, scale, auto-crop (white margins), rotate/shift content").
 *
 * Six modes over one MuPDF writer (`engines/mupdf-write.ts`): set one box, resize the
 * page with the content placed inside it, scale content (and optionally the boxes),
 * auto-crop the white margins, shift content, rotate content.
 *
 * The rules this writer keeps:
 *
 *  - A box is written as `[x0 y0 x1 y1]` on the page itself. The effective CropBox
 *    falls back to the MediaBox and Trim/Bleed/Art to the CropBox when absent, which is
 *    why a mode that only sizes the page writes `media` **and** `crop`: an absent
 *    CropBox would follow the media box anyway, but a *stale* one would keep hiding
 *    content.
 *  - A content transform wraps the page's content streams: `q 1 0 0 1 x y cm … Q` for a
 *    translation, `q x 0 0 y 0 0 cm … Q` for a scale (`wrapPageContent`). The second
 *    wrap goes outside the first, so translate-then-scale composes to `p → s·(p + t)`
 *    (a marker rectangle at PDF [100,200]-[250,300] lands at [220,440]-[520,640] after a
 *    translation of (10, 20) and a scale of 2) — the reverse order would apply the
 *    translation in already-scaled units.
 *  - Both transforms work in **unrotated user space** and scale about the user-space
 *    origin `(0, 0)`, which is also the origin the `/Annots` geometry is scaled about
 *    (`scaleAnnotations`) — so content and annotations stay aligned. A shift leaves
 *    annotations and links where they are, and the report says so.
 *  - Content rotation writes the page's `/Rotate`. That is the one mechanism that
 *    rotates content, annotations and boxes **together**, and the report states it
 *    instead of claiming a re-written content stream.
 *  - **Auto-crop measures drawn pixels, not text blocks.** Two measured reasons:
 *    `page.toDisplayList(false).getBounds()` returns the page box, not the ink box (a
 *    page whose only ink is a 150×100 rectangle reports [0,0,400,600] — the page's own
 *    clip is part of the list), and the structured-text walk fires `beginTextBlock`
 *    but **no** `onVector` event for those same rectangles (measured: zero events), so
 *    a text+image union would crop away vector art (rules, charts, filled shapes). The
 *    brief's alternative, `page.getBounds(stroke)`, does not exist in 1.28.1: the
 *    installed signature is `Page.getBounds(box?: PageBox): Rect` (`mupdf.d.ts:445`),
 *    i.e. a *page* box, which is the clamp bound here, not the measurement. So the
 *    measurement is `page.toPixmap(Matrix.scale(dpi/72, dpi/72), ColorSpace.DeviceRGB,
 *    false, false)` (`mupdf.d.ts:451`, `Matrix.scale` at `:18`, `ColorSpace.DeviceRGB`
 *    at `:102`) plus a pixel walk (`INK_THRESHOLD`); `showExtras: false` keeps
 *    annotations out of the measurement — they are not page content.
 *  - MuPDF page space is the **displayed** page: crop-box based with `/Rotate` applied
 *    and a top-left origin (measured: a page with CropBox (50,60,300,400) reports
 *    `getBounds('MediaBox')` = [-50,-140,350,460], and a rectangle at PDF
 *    [100,200]-[250,300] has its ink at [50,160]-[200,260]). `pageSpaceToUser()` inverts
 *    that table for all four rotations; every row was verified against a rendered
 *    fixture (rotation 0/90/180/270, one of them with an offset CropBox).
 */

import type { PDFDocument, PDFObject, Pixmap } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { type Mupdf, mapMupdfError } from '../engines/mupdf';
import {
  pdfNumber as num,
  openForWrite,
  pageObjects,
  readNumbers,
  resolved,
  saveRewrite,
  wrapPageContent,
} from '../engines/mupdf-write';
import { type PageGeometry, pageGeometry } from './stamp';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

/** One of the five PDF page boxes (`/MediaBox`, `/CropBox`, `/TrimBox`, `/BleedBox`, `/ArtBox`). */
export type PageBoxKind = 'media' | 'crop' | 'trim' | 'bleed' | 'art';
export type PageBoxesMode = 'set' | 'resize' | 'scale' | 'auto-crop' | 'shift' | 'rotate-content';

export interface PageBoxesOptions {
  readonly mode: PageBoxesMode;
  readonly pages: readonly number[]; // 0-based, explicit (the dialog parses ranges)
  /** mode 'set': which box, and the rectangle in PDF user space, lower-left origin, points. */
  readonly box?: PageBoxKind;
  readonly rect?: readonly [number, number, number, number];
  /** mode 'resize': target size and how the content is placed inside it. */
  readonly width?: number;
  readonly height?: number;
  readonly fit?: 'none' | 'fit' | 'fill' | 'stretch';
  readonly marginMm?: number;
  /** mode 'scale': multiplier applied to the content and, optionally, the boxes. */
  readonly factor?: number;
  readonly scaleBoxes?: boolean;
  /** mode 'auto-crop': how far inside the detected content the crop box lands. */
  readonly paddingMm?: number;
  readonly alsoTrim?: boolean;
  /** mode 'shift': content offset in millimetres (positive = right / up). */
  readonly offsetXmm?: number;
  readonly offsetYmm?: number;
  /** mode 'rotate-content': degrees clockwise applied to the page content. */
  readonly degrees?: 0 | 90 | 180 | 270;
}

/**
 * What one page received. One entry per page, and `box` is the rectangle actually
 * written — `null` for the modes that only move content (`shift`, `rotate-content`)
 * and for `scale` without `scaleBoxes`. Auto-crop and `set` produce a page-specific
 * rectangle (the measured content box, the clamped request), so the result is a list
 * per page rather than one rectangle for the whole run.
 */
export interface PageBoxesResult {
  readonly pages: readonly number[];
  readonly box: readonly [number, number, number, number] | null;
}

/** The visible geometry of one page, as the box dialog and the report read it. */
export interface PageBoxReport {
  readonly pageIndex: number;
  readonly media: readonly [number, number, number, number];
  readonly crop: readonly [number, number, number, number];
  readonly rotation: 0 | 90 | 180 | 270;
  /** Visible size in points: the CropBox, swapped when the page is rotated 90/270. */
  readonly width: number;
  readonly height: number;
}

type Rect = readonly [number, number, number, number];
type PageFit = 'none' | 'fit' | 'fill' | 'stretch';
type DerivedBox = Exclude<PageBoxKind, 'media'>;

/** A request validated before any engine work starts. */
type ValidatedPlan =
  | { readonly mode: 'set'; readonly kind: PageBoxKind; readonly rect: Rect }
  | {
      readonly mode: 'resize';
      readonly width: number;
      readonly height: number;
      readonly fit: PageFit;
      readonly margin: number;
    }
  | { readonly mode: 'scale'; readonly factor: number; readonly scaleBoxes: boolean }
  | { readonly mode: 'auto-crop'; readonly padding: number; readonly alsoTrim: boolean }
  | { readonly mode: 'shift'; readonly dx: number; readonly dy: number }
  | { readonly mode: 'rotate-content'; readonly degrees: 90 | 180 | 270 };

/** Outcome of one page: the box written (if any) and whether the page changed at all. */
interface PagePlan {
  readonly box: Rect | null;
  readonly changed: boolean;
}

interface ChangeStats {
  clampedBoxes: number;
  minSizePages: number;
  emptyMeasurements: number;
  unchangedPages: number;
  annotatedPages: number;
}

const PT_PER_MM = 72 / 25.4;
/** A crop box this small in either axis is a mistake, not a crop (a quarter inch). */
const MIN_CROP_POINTS = 18;
/** Measurement resolution for auto-crop: hair lines must survive, so not 72 dpi. */
const AUTOCROP_DPI = 150;
/** A device pixel is ink when any channel is darker than this (anti-aliasing is lighter than 255). */
const INK_THRESHOLD = 245;
const MIN_PAGE_POINTS = 1;
const MAX_PAGE_POINTS = 20000;
const MAX_MARGIN_MM = 200;
const MAX_OFFSET_MM = 500;
const MIN_SCALE_FACTOR = 0.05;
const MAX_SCALE_FACTOR = 10;

/** The four boxes derived from the MediaBox, in report order. */
const DERIVED_BOXES: readonly DerivedBox[] = ['crop', 'trim', 'bleed', 'art'];

/** PDF dictionary keys of the derived boxes — needed to drop an entry (`/CropBox` default). */
const BOX_ENTRY: Record<DerivedBox, string> = {
  crop: 'CropBox',
  trim: 'TrimBox',
  bleed: 'BleedBox',
  art: 'ArtBox',
};

/** The box names as the report prints them: PDF's own vocabulary, not a translation. */
const BOX_LABEL: Record<PageBoxKind, string> = {
  media: 'MediaBox',
  crop: 'CropBox',
  trim: 'TrimBox',
  bleed: 'BleedBox',
  art: 'ArtBox',
};

function rectOfBox(box: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): Rect {
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}

function isPositive(rect: Rect): boolean {
  return rect[2] > rect[0] && rect[3] > rect[1];
}

function intersect(left: Rect, right: Rect): Rect {
  return [
    Math.max(left[0], right[0]),
    Math.max(left[1], right[1]),
    Math.min(left[2], right[2]),
    Math.min(left[3], right[3]),
  ];
}

function inflate(rect: Rect, amount: number): Rect {
  return [rect[0] - amount, rect[1] - amount, rect[2] + amount, rect[3] + amount];
}

const RECT_EPSILON = 1e-6;

function sameRect(left: Rect, right: Rect): boolean {
  return (
    Math.abs(left[0] - right[0]) < RECT_EPSILON &&
    Math.abs(left[1] - right[1]) < RECT_EPSILON &&
    Math.abs(left[2] - right[2]) < RECT_EPSILON &&
    Math.abs(left[3] - right[3]) < RECT_EPSILON
  );
}

/** Grow a rectangle about its centre until both axes reach `minimum`. */
function ensureMinimum(rect: Rect, minimum: number): Rect {
  const growX = Math.max(0, minimum - (rect[2] - rect[0])) / 2;
  const growY = Math.max(0, minimum - (rect[3] - rect[1])) / 2;
  if (growX === 0 && growY === 0) return rect;
  return [rect[0] - growX, rect[1] - growY, rect[2] + growX, rect[3] + growY];
}

/** Apply the content transform `p → s·(p + t)` to a rectangle's corners. */
function transformRect(
  rect: Rect,
  scaleX: number,
  scaleY: number,
  translateX: number,
  translateY: number,
): Rect {
  const first = { x: scaleX * (rect[0] + translateX), y: scaleY * (rect[1] + translateY) };
  const second = { x: scaleX * (rect[2] + translateX), y: scaleY * (rect[3] + translateY) };
  return [
    Math.min(first.x, second.x),
    Math.min(first.y, second.y),
    Math.max(first.x, second.x),
    Math.max(first.y, second.y),
  ];
}

/** `/Rotate` values are multiples of 90; anything else is rounded to the nearest quarter turn. */
function quarterTurns(angle: number): 0 | 90 | 180 | 270 {
  const normalized = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

/** A four-number box entry as `[x0, y0, x1, y1]`, ascending; `null` when absent or malformed. */
function boxEntry(value: PDFObject): Rect | null {
  const [x0, y0, x1, y1] = readNumbers(value);
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return null;
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** The page's effective box: absent Crop → Media, absent Trim/Bleed/Art → Crop (§14.11.2). */
function readBox(page: PDFObject, kind: PageBoxKind): Rect {
  const media = boxEntry(page.getInheritable('MediaBox')) ?? [0, 0, 612, 792];
  if (kind === 'media') return media;
  const crop = boxEntry(page.getInheritable('CropBox')) ?? media;
  if (kind === 'crop') return crop;
  return boxEntry(page.get(BOX_ENTRY[kind])) ?? crop;
}

function writeBox(page: PDFObject, kind: PageBoxKind, rect: Rect): void {
  page.put(BOX_LABEL[kind], [...rect]);
}

/**
 * Whether the page carries the box itself (an *effective* box is not a present one). A
 * CropBox is inheritable, so one on a `/Pages` node counts; the other three are not.
 */
function hasBox(page: PDFObject, kind: DerivedBox): boolean {
  const entry = kind === 'crop' ? page.getInheritable('CropBox') : page.get(BOX_ENTRY[kind]);
  return resolved(entry) !== null;
}

/**
 * MuPDF page space → PDF user space for the four rotations.
 *
 * MuPDF page space is the **displayed** page: its origin is the CropBox's top-left
 * corner after `/Rotate`, `u` grows right and `v` grows down. Inverting that for a
 * CropBox `(cx, cy, cw, ch)` gives:
 *
 *   rotation 0:   x = cx + u,        y = cy + ch - v
 *   rotation 90:  x = cx + v,        y = cy + u
 *   rotation 180: x = cx + cw - u,   y = cy + v
 *   rotation 270: x = cx + cw - v,   y = cy + ch - u
 */
function pageSpaceToUser(
  rotation: number,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  u: number,
  v: number,
): { readonly x: number; readonly y: number } {
  switch (quarterTurns(rotation)) {
    case 90:
      return { x: box.x + v, y: box.y + u };
    case 180:
      return { x: box.x + box.width - u, y: box.y + v };
    case 270:
      return { x: box.x + box.width - v, y: box.y + box.height - u };
    default:
      return { x: box.x + u, y: box.y + box.height - v };
  }
}

function requireNumber(value: number | undefined, name: string, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `${name} is required and must be a finite number`,
    });
  }
  if (value < minimum || value > maximum) {
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `${name} = ${value} is outside ${minimum}..${maximum}`,
    });
  }
  return value;
}

/** Explicit 0-based pages, deduplicated and ascending so the write order is deterministic. */
function requirePages(pages: readonly number[]): readonly number[] {
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 0) {
      throw new ToolError('range-invalid', {
        engine: 'model',
        pageIndex: page,
        engineMessage: `page index ${page} is not a non-negative integer`,
      });
    }
  }
  return [...new Set(pages)].sort((left, right) => left - right);
}

function readPlanOptions(options: PageBoxesOptions): ValidatedPlan {
  switch (options.mode) {
    case 'set': {
      const kind = options.box;
      const rect = options.rect;
      if (kind === undefined || rect === undefined) {
        throw new ToolError('range-invalid', {
          engine: 'model',
          engineMessage: 'mode "set" needs both `box` and `rect`',
        });
      }
      const [x0, y0, x1, y1] = rect;
      if (![x0, y0, x1, y1].every((value) => Number.isFinite(value)) || x1 <= x0 || y1 <= y0) {
        throw new ToolError('range-invalid', {
          engine: 'model',
          engineMessage: `rect [${x0}, ${y0}, ${x1}, ${y1}] is not a positive rectangle`,
        });
      }
      return { mode: 'set', kind, rect: [x0, y0, x1, y1] };
    }
    case 'resize': {
      const width = requireNumber(options.width, 'width', MIN_PAGE_POINTS, MAX_PAGE_POINTS);
      const height = requireNumber(options.height, 'height', MIN_PAGE_POINTS, MAX_PAGE_POINTS);
      const margin = requireNumber(options.marginMm ?? 0, 'marginMm', 0, MAX_MARGIN_MM) * PT_PER_MM;
      if (width - 2 * margin <= 0 || height - 2 * margin <= 0) {
        throw new ToolError('value-out-of-range', {
          engine: 'model',
          engineMessage: `margin ${margin} pt leaves no room inside ${width}×${height} pt`,
        });
      }
      return { mode: 'resize', width, height, fit: options.fit ?? 'fit', margin };
    }
    case 'scale': {
      return {
        mode: 'scale',
        factor: requireNumber(options.factor, 'factor', MIN_SCALE_FACTOR, MAX_SCALE_FACTOR),
        scaleBoxes: options.scaleBoxes === true,
      };
    }
    case 'auto-crop': {
      return {
        mode: 'auto-crop',
        padding: requireNumber(options.paddingMm ?? 0, 'paddingMm', 0, MAX_MARGIN_MM) * PT_PER_MM,
        alsoTrim: options.alsoTrim === true,
      };
    }
    case 'shift': {
      const dx =
        requireNumber(options.offsetXmm ?? 0, 'offsetXmm', -MAX_OFFSET_MM, MAX_OFFSET_MM) * PT_PER_MM;
      const dy =
        requireNumber(options.offsetYmm ?? 0, 'offsetYmm', -MAX_OFFSET_MM, MAX_OFFSET_MM) * PT_PER_MM;
      if (dx === 0 && dy === 0) {
        throw new ToolError('value-out-of-range', {
          engine: 'model',
          engineMessage: 'a content shift needs a non-zero offset',
        });
      }
      return { mode: 'shift', dx, dy };
    }
    case 'rotate-content': {
      const degrees = options.degrees ?? 0;
      if (degrees !== 90 && degrees !== 180 && degrees !== 270) {
        throw new ToolError('value-out-of-range', {
          engine: 'model',
          engineMessage: `rotating content by ${degrees}° would change nothing`,
        });
      }
      return { mode: 'rotate-content', degrees };
    }
  }
}

export async function applyPageBoxes(
  bytes: Uint8Array,
  options: PageBoxesOptions,
  context: OperationContext,
): Promise<OperationOutcome & { readonly changed: readonly PageBoxesResult[] }> {
  throwIfAborted(context.signal);
  const pages = requirePages(options.pages);
  if (pages.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: 'page boxes needs at least one page',
    });
  }
  const plan = readPlanOptions(options);

  // A document that needs a password is refused by `openForWrite` (`encrypted-unsupported`):
  // a box write on a document whose objects cannot be read would be a silent no-op.
  const { mupdf, doc } = await openForWrite(bytes);
  const stats: ChangeStats = {
    clampedBoxes: 0,
    minSizePages: 0,
    emptyMeasurements: 0,
    unchangedPages: 0,
    annotatedPages: 0,
  };
  const changed: PageBoxesResult[] = [];
  const steps: string[] = ['load'];
  let produced: Uint8Array;
  let pageCount: number;

  try {
    const pageList = pageObjects(doc);
    pageCount = pageList.length;
    for (const pageIndex of pages) {
      if (pageIndex >= pageCount) {
        throw new ToolError('range-invalid', {
          engine: 'mupdf',
          pageIndex,
          engineMessage: `page index ${pageIndex} outside 0..${pageCount - 1}`,
        });
      }
    }
    const measured = plan.mode === 'auto-crop' ? measureInkBounds(mupdf, doc, pages, context) : null;
    if (measured !== null) steps.push('measure');
    steps.push('boxes');

    for (const [position, pageIndex] of pages.entries()) {
      throwIfAborted(context.signal);
      const page = pageList[pageIndex];
      if (page === undefined) throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex });
      const result = applyPlan(doc, page, plan, measured?.get(pageIndex) ?? null, stats);
      if (!result.changed) {
        stats.unchangedPages += 1;
      } else {
        changed.push({ pages: [pageIndex], box: result.box });
      }
      context.onProgress?.({
        phase: 'boxes',
        labelKey: 'op.progress.boxes',
        done: position + 1,
        total: pages.length,
      });
    }

    if (changed.length === 0) {
      // Nothing to write: returning the input untouched keeps the "no unnecessary
      // writer step" rule and leaves the session clean.
      return {
        bytes: bytes.slice(),
        report: {
          engine: 'mupdf',
          steps,
          notes: [note('warning', 'boxes.note.unchanged')],
          inputBytes: bytes.byteLength,
          outputBytes: bytes.byteLength,
          pageCount,
          incremental: true,
        },
        changed,
      };
    }

    steps.push('save');
    produced = saveRewrite(doc, 'page-boxes');
  } catch (error) {
    // Our own `ToolError`s and the abort error pass through unchanged.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'page-boxes');
  } finally {
    doc.destroy();
  }
  throwIfAborted(context.signal);

  const report: OperationReport = {
    engine: 'mupdf',
    steps,
    notes: describe(plan, stats, changed.length),
    inputBytes: bytes.byteLength,
    outputBytes: produced.byteLength,
    pageCount,
    // The document is re-serialised: never incremental.
    incremental: false,
  };
  return { bytes: produced, report, changed };
}

/** One page through the selected mode. */
function applyPlan(
  doc: PDFDocument,
  page: PDFObject,
  plan: ValidatedPlan,
  measured: Rect | null,
  stats: ChangeStats,
): PagePlan {
  switch (plan.mode) {
    case 'set':
      return applySetPage(page, plan, stats);
    case 'resize':
      return applyResizePage(doc, page, plan);
    case 'scale':
      return applyScalePage(doc, page, plan, stats);
    case 'auto-crop':
      return applyAutoCropPage(page, measured, plan, stats);
    case 'shift':
      translateContent(doc, page, plan.dx, plan.dy);
      return { box: null, changed: true };
    case 'rotate-content':
      return applyRotatePage(page, plan.degrees);
  }
}

function translateContent(doc: PDFDocument, page: PDFObject, x: number, y: number): void {
  wrapPageContent(doc, page, `q 1 0 0 1 ${num(x)} ${num(y)} cm`, 'Q');
}

function scaleContent(doc: PDFDocument, page: PDFObject, x: number, y: number): void {
  wrapPageContent(doc, page, `q ${num(x)} 0 0 ${num(y)} 0 0 cm`, 'Q');
}

/** The geometry keys of an annotation that are pairs of user-space coordinates. */
const ANNOTATION_POINT_KEYS = ['RD', 'CL', 'Vertices', 'QuadPoints', 'L', 'Rect'] as const;

/** Multiply the x/y pairs of an array in place. */
function scalePairs(array: PDFObject, x: number, y: number): void {
  for (let index = 0; index < array.length; index += 1) {
    const value = resolved(array.get(index));
    if (value?.isNumber() === true) array.put(index, value.asNumber() * (index % 2 === 0 ? x : y));
  }
}

/**
 * Scale every annotation's geometry about the user-space origin, the origin the content
 * scale uses: `/Rect`, `/QuadPoints`, `/Vertices`, `/L`, `/CL`, `/RD` and each `/InkList`
 * stroke.
 */
function scaleAnnotations(page: PDFObject, x: number, y: number): void {
  const annots = resolved(page.get('Annots'));
  if (annots === null || !annots.isArray()) return;
  for (let index = 0; index < annots.length; index += 1) {
    const annot = resolved(annots.get(index));
    if (annot === null || !annot.isDictionary()) continue;
    for (const key of ANNOTATION_POINT_KEYS) {
      const list = resolved(annot.get(key));
      if (list?.isArray() === true) scalePairs(list, x, y);
    }
    const ink = resolved(annot.get('InkList'));
    if (ink?.isArray() !== true) continue;
    for (let stroke = 0; stroke < ink.length; stroke += 1) {
      const points = resolved(ink.get(stroke));
      if (points?.isArray() === true) scalePairs(points, x, y);
    }
  }
}

function applySetPage(
  page: PDFObject,
  plan: Extract<ValidatedPlan, { readonly mode: 'set' }>,
  stats: ChangeStats,
): PagePlan {
  let rect = plan.rect;
  if (plan.kind === 'media') {
    writeBox(page, 'media', rect);
    clampDerivedBoxes(page, rect, stats);
    return { box: rect, changed: true };
  }

  // Crop/Trim/Bleed/Art must lie inside the MediaBox; clamping is reported rather
  // than quietly accepted, and a request that misses the page entirely is refused.
  const media = readBox(page, 'media');
  const clamped = intersect(rect, media);
  if (!isPositive(clamped)) {
    throw new ToolError('range-invalid', {
      engine: 'mupdf',
      engineMessage: `the requested ${BOX_LABEL[plan.kind]} does not overlap the MediaBox [${media.join(', ')}]`,
    });
  }
  if (!sameRect(clamped, rect)) stats.clampedBoxes += 1;
  rect = clamped;
  writeBox(page, plan.kind, rect);
  return { box: rect, changed: true };
}

/** Keep the derived boxes inside a new MediaBox — a box outside it is an invalid page. */
function clampDerivedBoxes(page: PDFObject, media: Rect, stats: ChangeStats): void {
  for (const kind of DERIVED_BOXES) {
    if (!hasBox(page, kind)) continue;
    const current = readBox(page, kind);
    const clamped = intersect(current, media);
    if (isPositive(clamped)) {
      if (sameRect(clamped, current)) continue;
      writeBox(page, kind, clamped);
    } else {
      // Nothing of the box is left inside the new page: drop the entry so the box
      // falls back to the MediaBox (the /CropBox default) instead of naming an area
      // the page does not have.
      page.delete(BOX_ENTRY[kind]);
    }
    stats.clampedBoxes += 1;
  }
}

/**
 * mode 'resize': a new page size with the existing content placed inside it.
 *
 * The requested width/height are the size the **viewer shows**, so on a 90/270 page
 * the written (unrotated) box extents are their swap, and the scale factors swap with
 * them: the content transform happens in unrotated user space while the fit is
 * computed in displayed space. `fit` picks the factors (`fit` = contain, `fill` =
 * cover, `stretch` = non-uniform, `none` = keep 1:1), and the content is centred in
 * the target minus `margin`, which is why the four `trim`/`bleed`/`art` boxes move with
 * it: they describe the content that just moved.
 */
function applyResizePage(
  doc: PDFDocument,
  page: PDFObject,
  plan: Extract<ValidatedPlan, { readonly mode: 'resize' }>,
): PagePlan {
  const geometry = pageGeometry(page);
  const source = geometry.box;
  if (source.width <= 0 || source.height <= 0) {
    throw new ToolError('range-invalid', {
      engine: 'mupdf',
      engineMessage: `the page's CropBox is ${source.width}×${source.height} pt`,
    });
  }
  const rotated = geometry.rotation === 90 || geometry.rotation === 270;
  const innerWidth = plan.width - 2 * plan.margin;
  const innerHeight = plan.height - 2 * plan.margin;
  const displayWidth = rotated ? source.height : source.width;
  const displayHeight = rotated ? source.width : source.height;

  let displayScaleX = 1;
  let displayScaleY = 1;
  switch (plan.fit) {
    case 'none':
      break;
    case 'fit': {
      const uniform = Math.min(innerWidth / displayWidth, innerHeight / displayHeight);
      displayScaleX = uniform;
      displayScaleY = uniform;
      break;
    }
    case 'fill': {
      const uniform = Math.max(innerWidth / displayWidth, innerHeight / displayHeight);
      displayScaleX = uniform;
      displayScaleY = uniform;
      break;
    }
    case 'stretch':
      displayScaleX = innerWidth / displayWidth;
      displayScaleY = innerHeight / displayHeight;
      break;
  }

  const scaleX = rotated ? displayScaleY : displayScaleX;
  const scaleY = rotated ? displayScaleX : displayScaleY;
  const target: Rect = rotated ? [0, 0, plan.height, plan.width] : [0, 0, plan.width, plan.height];
  const contentWidth = source.width * scaleX;
  const contentHeight = source.height * scaleY;
  const offsetX = (target[2] - 2 * plan.margin - contentWidth) / 2;
  const offsetY = (target[3] - 2 * plan.margin - contentHeight) / 2;
  const translateX = (plan.margin + offsetX) / scaleX - source.x;
  const translateY = (plan.margin + offsetY) / scaleY - source.y;

  for (const kind of DERIVED_BOXES) {
    if (!hasBox(page, kind)) continue;
    writeBox(page, kind, transformRect(readBox(page, kind), scaleX, scaleY, translateX, translateY));
  }
  // Translate first: the two wrappers compose to `p → s·(p + t)` (see the header),
  // so a translation applied after the scale would be multiplied by it.
  if (translateX !== 0 || translateY !== 0) translateContent(doc, page, translateX, translateY);
  if (scaleX !== 1 || scaleY !== 1) scaleContent(doc, page, scaleX, scaleY);
  writeBox(page, 'media', target);
  writeBox(page, 'crop', target);
  return { box: target, changed: true };
}

/** mode 'scale': multiply the content, and on request the boxes, about the user-space origin. */
function applyScalePage(
  doc: PDFDocument,
  page: PDFObject,
  plan: Extract<ValidatedPlan, { readonly mode: 'scale' }>,
  stats: ChangeStats,
): PagePlan {
  scaleContent(doc, page, plan.factor, plan.factor);
  // Scaling the annotations keeps a highlight on the text it marks instead of leaving
  // it behind.
  if (resolved(page.get('Annots'))?.isArray() === true) {
    scaleAnnotations(page, plan.factor, plan.factor);
    stats.annotatedPages += 1;
  }
  if (!plan.scaleBoxes) return { box: null, changed: true };

  const media = transformRect(readBox(page, 'media'), plan.factor, plan.factor, 0, 0);
  for (const kind of DERIVED_BOXES) {
    if (!hasBox(page, kind)) continue;
    writeBox(page, kind, transformRect(readBox(page, kind), plan.factor, plan.factor, 0, 0));
  }
  writeBox(page, 'media', media);
  return { box: media, changed: true };
}

/** mode 'auto-crop': the measured ink box plus padding, clamped to the page and to MIN_CROP_POINTS. */
function applyAutoCropPage(
  page: PDFObject,
  measured: Rect | null,
  plan: Extract<ValidatedPlan, { readonly mode: 'auto-crop' }>,
  stats: ChangeStats,
): PagePlan {
  if (measured === null) {
    // A blank page has no content to crop to; leaving its box alone is the only
    // honest answer (a crop to an empty 18 pt rectangle would hide the page).
    stats.emptyMeasurements += 1;
    return { box: null, changed: false };
  }
  const padded = inflate(measured, plan.padding);
  const enlarged = ensureMinimum(padded, MIN_CROP_POINTS);
  if (!sameRect(enlarged, padded)) stats.minSizePages += 1;
  // Never outside the MediaBox: a CropBox larger than the page is invalid.
  const next = intersect(enlarged, readBox(page, 'media'));
  if (!isPositive(next)) {
    stats.emptyMeasurements += 1;
    return { box: null, changed: false };
  }
  const trimUpToDate = plan.alsoTrim ? sameRect(readBox(page, 'trim'), next) : true;
  if (sameRect(readBox(page, 'crop'), next) && trimUpToDate) {
    stats.unchangedPages += 1;
    return { box: null, changed: false };
  }
  writeBox(page, 'crop', next);
  if (plan.alsoTrim) writeBox(page, 'trim', next);
  return { box: next, changed: true };
}

/**
 * mode 'rotate-content': `/Rotate` is the rotation the viewer applies to the page,
 * so content, annotations and boxes turn together — nothing is left behind at the
 * old orientation, and no content stream is rewritten.
 */
function applyRotatePage(page: PDFObject, degrees: 90 | 180 | 270): PagePlan {
  const rotate = resolved(page.getInheritable('Rotate'));
  const current = quarterTurns(rotate?.isNumber() === true ? rotate.asNumber() : 0);
  const next = quarterTurns(current + degrees);
  if (next === current) return { box: null, changed: false };
  page.put('Rotate', next);
  return { box: null, changed: true };
}

/**
 * Read the visible box geometry of explicit pages, through the same object model the
 * writer uses, so a report cannot disagree with the write. A document that needs a
 * password fails with `encrypted-unsupported` here too.
 */
export async function readPageBoxes(
  bytes: Uint8Array,
  pages: readonly number[],
  signal?: AbortSignal,
): Promise<readonly PageBoxReport[]> {
  const requested = requirePages(pages);
  if (requested.length === 0) return [];
  if (signal !== undefined) throwIfAborted(signal);

  const { doc } = await openForWrite(bytes);
  try {
    const pageList = pageObjects(doc);
    const reports: PageBoxReport[] = [];
    for (const pageIndex of requested) {
      if (signal !== undefined) throwIfAborted(signal);
      const page = pageList[pageIndex];
      if (page === undefined) {
        throw new ToolError('range-invalid', {
          engine: 'mupdf',
          pageIndex,
          engineMessage: `page index ${pageIndex} outside 0..${pageList.length - 1}`,
        });
      }
      const geometry = pageGeometry(page);
      reports.push({
        pageIndex,
        media: readBox(page, 'media'),
        crop: rectOfBox(geometry.box),
        rotation: geometry.rotation,
        width: geometry.display.width,
        height: geometry.display.height,
      });
    }
    return reports;
  } finally {
    doc.destroy();
  }
}

/**
 * Ink bounds of every requested page, in PDF user space, measured on the document being
 * edited before anything is written to it. One pixmap at a time (`showExtras: false`
 * renders page contents without annotations), so the memory cost is a single page bitmap
 * regardless of how many pages are being measured.
 */
function measureInkBounds(
  mupdf: Mupdf,
  doc: PDFDocument,
  pages: readonly number[],
  context: OperationContext,
): Map<number, Rect | null> {
  const measured = new Map<number, Rect | null>();
  const scale = AUTOCROP_DPI / 72;
  const pageList = pageObjects(doc);
  try {
    let position = 0;
    for (const pageIndex of pages) {
      throwIfAborted(context.signal);
      const object = pageList[pageIndex];
      if (object === undefined) continue;
      const geometry = pageGeometry(object);
      const page = doc.loadPage(pageIndex);
      let device: Rect | null;
      try {
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(scale, scale),
          mupdf.ColorSpace.DeviceRGB,
          false,
          false,
        );
        try {
          device = inkBox(pixmap);
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
      measured.set(pageIndex, device === null ? null : deviceToUser(device, scale, geometry));
      position += 1;
      context.onProgress?.({
        phase: 'measure',
        labelKey: 'op.progress.boxes.measure',
        done: position,
        total: pages.length,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'auto-crop:measure');
  }
  return measured;
}

/**
 * The bounding box of non-white device pixels, half-open and offset by the pixmap
 * origin (a page whose boxes sit off the origin renders into an offset pixmap).
 *
 * `null` means the page rendered completely white — no content to crop to.
 */
function inkBox(pixmap: Pixmap): Rect | null {
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const stride = pixmap.getStride();
  const components = pixmap.getNumberOfComponents();
  const pixels = pixmap.getPixels();
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      // DeviceRGB without alpha: three channels per pixel, in order.
      const offset = row + x * components;
      const red = pixels[offset] ?? 255;
      const green = pixels[offset + 1] ?? 255;
      const blue = pixels[offset + 2] ?? 255;
      if (red >= INK_THRESHOLD && green >= INK_THRESHOLD && blue >= INK_THRESHOLD) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0 || y1 < 0) return null;
  return [x0 + pixmap.getX(), y0 + pixmap.getY(), x1 + 1 + pixmap.getX(), y1 + 1 + pixmap.getY()];
}

/** Device pixels → PDF user space through the page's own rotation and CropBox. */
function deviceToUser(device: Rect, scale: number, geometry: PageGeometry): Rect {
  const first = pageSpaceToUser(geometry.rotation, geometry.box, device[0] / scale, device[1] / scale);
  const second = pageSpaceToUser(geometry.rotation, geometry.box, device[2] / scale, device[3] / scale);
  return [
    Math.min(first.x, second.x),
    Math.min(first.y, second.y),
    Math.max(first.x, second.x),
    Math.max(first.y, second.y),
  ];
}

/** The report's sentences: what ran, on how many pages, and what it cost. */
function describe(plan: ValidatedPlan, stats: ChangeStats, count: number): OperationNote[] {
  const notes: OperationNote[] = [];
  switch (plan.mode) {
    case 'set':
      notes.push(note('changed', 'boxes.note.set', { count, box: BOX_LABEL[plan.kind] }));
      notes.push(note('warning', 'boxes.note.boxChangeAnnots'));
      break;
    case 'resize':
      notes.push(
        note('changed', 'boxes.note.resize', {
          count,
          width: round1(plan.width),
          height: round1(plan.height),
        }),
      );
      notes.push(note('lost', 'boxes.note.contentMovedAnnots'));
      break;
    case 'scale':
      notes.push(note('changed', 'boxes.note.scaled', { count, factor: plan.factor }));
      notes.push(note('changed', 'boxes.note.scaleOrigin'));
      if (stats.annotatedPages > 0) {
        notes.push(note('changed', 'boxes.note.annotationsScaled', { count: stats.annotatedPages }));
      }
      if (plan.scaleBoxes) notes.push(note('changed', 'boxes.note.boxesScaled'));
      break;
    case 'auto-crop':
      notes.push(note('changed', 'boxes.note.autoCrop', { count, dpi: AUTOCROP_DPI }));
      if (plan.alsoTrim) notes.push(note('changed', 'boxes.note.trimWritten'));
      notes.push(note('warning', 'boxes.note.boxChangeAnnots'));
      break;
    case 'shift':
      notes.push(
        note('changed', 'boxes.note.shift', {
          count,
          x: round1(plan.dx / PT_PER_MM),
          y: round1(plan.dy / PT_PER_MM),
        }),
      );
      notes.push(note('lost', 'boxes.note.contentMovedAnnots'));
      break;
    case 'rotate-content':
      notes.push(note('changed', 'boxes.note.rotated', { count, degrees: plan.degrees }));
      notes.push(note('changed', 'boxes.note.rotateMovesAnnots'));
      break;
  }
  if (stats.clampedBoxes > 0) {
    notes.push(note('changed', 'boxes.note.clamped', { count: stats.clampedBoxes }));
  }
  if (stats.minSizePages > 0) {
    notes.push(note('changed', 'boxes.note.minCrop', { count: stats.minSizePages, points: MIN_CROP_POINTS }));
  }
  if (stats.emptyMeasurements > 0) {
    notes.push(note('warning', 'boxes.note.emptyContent', { count: stats.emptyMeasurements }));
  }
  if (stats.unchangedPages > 0) {
    notes.push(note('preserved', 'boxes.note.unchangedPages', { count: stats.unchangedPages }));
  }
  // `saveRewrite` sets the producer line before the save.
  notes.push(note('preserved', 'boxes.note.producer'));
  return notes;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
