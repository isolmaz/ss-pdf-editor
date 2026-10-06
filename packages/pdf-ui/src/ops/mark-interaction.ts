/**
 * The geometry and the data contract every mark tool shares (`PLAN.md §5/Phase 3`).
 *
 * Four families of marks can be selected, marqueed and moved on the canvas —
 * session annotations, measurements, redaction intents and the annotations the
 * file already contains — and the shell projects all four into one list of
 * {@link MarkTarget}s. This module owns the two things that must not have a
 * second implementation:
 *
 *  - **the projection**: app space → container pixels, and its inverse. It is
 *    `ops/measure.ts`'s `appToDisplayPoint` × the page's own CSS scale, exactly
 *    the pair `MeasureLayer` draws with, so a mark, a measurement and a link
 *    rectangle land on the same pixels at every zoom and for all four rotations.
 *    It used to be a second, hand-written rotation table inside
 *    `AnnotationLayer`, whose 270° row subtracted the container offset twice and
 *    put every mark on a `/Rotate 270` page one dock-width to the left.
 *  - **the hit tests**: page points only, and *segments*, not vertices. A stroke
 *    is stored as sparse vertices, so a point-to-vertex test misses the middle of
 *    a long stroke; every distance below is measured to the segment that carries
 *    the mark, which is what makes a click land on the line the user drew rather
 *    than on its corners.
 *
 * It also owns the two DOM facts both layers have to agree on: whether a press is
 * the mark tools' at all ({@link pageGestureAt}: a page's own surface, off every
 * protected control, with a link reported rather than refused) and how the click a
 * consumed press owns is cancelled ({@link clickSuppression}) — because navigation
 * is the click's default action and a layer-scoped listener dies with the gesture.
 *
 * Nothing here touches a document, React state or the marks themselves:
 * `AnnotationLayer` renders marks with it, `MarkInteractionLayer` selects,
 * marquees and moves with it, and the two therefore agree on what a mark covers by
 * construction.
 */

import type { MeasurePageGeometry, MeasureRotation } from 'pdf-core/ops/measure';
import { appToDisplayPoint, displaySize, displayToAppPoint } from 'pdf-core/ops/measure';
import type { ViewerApi } from '../viewer/PdfViewerPane';

// ---------------------------------------------------------------------------
// the data contract
// ---------------------------------------------------------------------------

/** Which model a target came from — the shell's namespaces, one per owner. */
export type MarkFamily = 'annotation' | 'measure' | 'redaction' | 'existing';

/**
 * One selectable thing on the page, in the space every mark in this app
 * is stored in: unrotated page points with the origin at the page box's top-left
 * corner (`x` is the absolute PDF user-space x, `y` is `top − pdfY`).
 *
 * `boxes` are the painted areas — the hit test for text marks, shapes, notes,
 * measurement bounds and redaction rectangles. `paths` are flattened `x, y`
 * polylines for the marks that are a line rather than an area (ink strokes,
 * measurement chains, a file annotation's `/InkList`); both may be present, and a
 * mark is hit when **either** matches.
 */
export interface MarkTarget {
  /** Unique, family-prefixed identity; see {@link markTargetKey}. */
  readonly key: string;
  readonly family: MarkFamily;
  readonly id: string;
  readonly pageIndex: number;
  readonly boxes: readonly (readonly [number, number, number, number])[];
  readonly paths?: readonly (readonly number[])[];
  /** Stroke width in points, for the marks that paint a line. */
  readonly strokeWidth?: number;
  /** Already translated by the shell. */
  readonly label: string;
}

/**
 * The identity convention, in one place: a family prefix, plus the page index for
 * the annotations the file already carries — the same PDF annotation id can be
 * the identity of a mark on one page only, and a persisted id must never be able
 * to collide with a session mark's `crypto.randomUUID()`.
 */
export function markTargetKey(family: MarkFamily, id: string, pageIndex: number): string {
  return family === 'existing' ? `${family}:${pageIndex}:${id}` : `${family}:${id}`;
}

/** A point, in whichever space the function's name says. */
export interface MarkPoint {
  readonly x: number;
  readonly y: number;
}

/** An ascending page-space rectangle: `[x0, y0, x1, y1]`. */
export type MarkRect = readonly [number, number, number, number];

/** A rectangle on one page — the marquee's own shape, once it is in page space. */
export interface MarkArea {
  readonly pageIndex: number;
  readonly rect: MarkRect;
}

/** Ascending corners, whatever order they arrive in. */
function normaliseRect(rect: MarkRect): MarkRect {
  return [
    Math.min(rect[0], rect[2]),
    Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]),
    Math.max(rect[1], rect[3]),
  ];
}

// ---------------------------------------------------------------------------
// projection: one page, app space ⇄ container pixels
// ---------------------------------------------------------------------------

/** What the projection needs, as `ViewerApi` answers it. */
export interface MarkFrameInput {
  readonly rotation: MeasureRotation;
  /** `viewport.viewBox[0]` — the page box's left edge in PDF user space, never assumed 0. */
  readonly originX: number;
  /** `viewport.viewBox[3]` — the top edge; a mark's `y` is measured down from here. */
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly page: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly container: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** A placed page: the core's conversions plus where the page element sits. */
export interface MarkPageFrame {
  readonly geometry: MeasurePageGeometry;
  /** CSS pixels per page point — one number, because a page keeps its aspect. */
  readonly scale: number;
  /** The page element's origin inside the scroll container. */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** App-space page point → container pixel. */
  toScreen(point: MarkPoint): MarkPoint;
  /** Container-relative pixel → app-space page point (the inverse, for marquees). */
  toPage(x: number, y: number): MarkPoint;
  /** App-space rectangle → container-pixel box, clipped to the page it belongs to. */
  toScreenBox(rect: MarkRect): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * The projection for one page. `box.y` is the *bottom* edge of the page box
 * (`top − height`), because `appToDisplayPoint` measures a mark's `y` down from
 * the box's top while `x` stays absolute user space.
 */
export function markPageFrame(input: MarkFrameInput): MarkPageFrame | null {
  const geometry: MeasurePageGeometry = {
    rotation: input.rotation,
    box: { x: input.originX, y: input.top - input.height, width: input.width, height: input.height },
  };
  const displayed = displaySize(geometry);
  if (displayed.width <= 0 || displayed.height <= 0) return null;
  if (input.page.width <= 0 || input.page.height <= 0) return null;

  const scale = input.page.width / displayed.width;
  const left = input.page.x - input.container.x;
  const top = input.page.y - input.container.y;

  return {
    geometry,
    scale,
    left,
    top,
    width: input.page.width,
    height: input.page.height,
    toScreen(point) {
      const display = appToDisplayPoint(geometry, point);
      return { x: left + display.u * scale, y: top + display.v * scale };
    },
    toPage(x, y) {
      return displayToAppPoint(geometry, (x - left) / scale, (y - top) / scale);
    },
    toScreenBox(rect) {
      const [x0, y0, x1, y1] = normaliseRect(rect);
      let minU = Number.POSITIVE_INFINITY;
      let minV = Number.POSITIVE_INFINITY;
      let maxU = Number.NEGATIVE_INFINITY;
      let maxV = Number.NEGATIVE_INFINITY;
      for (const [x, y] of [
        [x0, y0],
        [x1, y0],
        [x0, y1],
        [x1, y1],
      ] as const) {
        const display = appToDisplayPoint(geometry, { x, y });
        // Clipped to the page, so a mark that runs past a page edge cannot paint
        // over the gutter or the next page.
        minU = Math.min(minU, Math.max(0, display.u));
        minV = Math.min(minV, Math.max(0, display.v));
        maxU = Math.max(maxU, Math.min(displayed.width, display.u));
        maxV = Math.max(maxV, Math.min(displayed.height, display.v));
      }
      return {
        left: left + minU * scale,
        top: top + minV * scale,
        width: Math.max(0, (maxU - minU) * scale),
        height: Math.max(0, (maxV - minV) * scale),
      };
    },
  };
}

/**
 * The frame for one page, read from the viewer.
 *
 * `viewer.pageGeometry` answers pdf.js's `viewport.viewBox` — the page box's own
 * left edge (`x`), bottom edge (`y`), extents and `/Rotate`. The projection needs
 * the box's **top** edge, which is `y + height` = `viewBox[3]`: a mark's `y` is
 * `top − pdfY`. Both come from the geometry the measure core already uses, so a
 * cropped page is placed off its real crop origin rather than an assumed zero.
 */
export function markPageFrameOf(viewer: ViewerApi, pageIndex: number): MarkPageFrame | null {
  const view = viewer.pageGeometry(pageIndex);
  const page = viewer.pageRect(pageIndex);
  if (view === null || page === null) return null;
  return markPageFrame({
    rotation: view.rotation,
    originX: view.x,
    top: view.y + view.height,
    width: view.width,
    height: view.height,
    page,
    container: viewer.containerRect(),
  });
}

// ---------------------------------------------------------------------------
// pointer ownership: does a mark tool own this pointer?
// ---------------------------------------------------------------------------

/**
 * The page's own surfaces, as pdf.js builds them (`.page` is `PageView.div`'s
 * class, `pdf_viewer.mjs:6543`). A gesture starts **only** inside one of these,
 * which is what keeps the shell's chrome out of it: the floating toolbar, the
 * rails, the menus, the palette, a dialog and a tooltip portal are not page
 * content, and an overlay that read their clicks as page gestures would break
 * hover, tool switching and every menu at once.
 */
export const PAGE_SURFACES = '.page, .canvasWrapper, .textLayer, .annotationLayer, .annotationEditorLayer';

/**
 * Elements inside a page that own their own pointer, always: form fields and any
 * other text editing (a pdf.js widget, a form value, an engine editor's field) and
 * pdf.js's own buttons. A mark tool never takes these — swallowing a press inside
 * an input is how a working control becomes a dead one.
 */
export const PROTECTED_TARGETS =
  'input, textarea, select, button, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * A link, including the ones this app writes with the link tool and pdf.js renders
 * into `.annotationLayer` as an `<a>`.
 *
 * Links are deliberately **not** protected. A persisted `/Link` annotation is an
 * object like any other, and the common select has to reach it; if the layer
 * refused every anchor, the annotation layer's own handler would win the click and
 * the link would navigate instead of being selected. So the layer decides: a press
 * it **consumes** (a target under the pointer) cancels the click that follows it,
 * and a link nobody handled navigates exactly as before.
 */
export const LINK_TARGETS = 'a[href], area[href]';

/** What the pointer is over, for the question "does a mark tool own this press?". */
export interface PageGestureOwner {
  /** A gesture may start here: on a page surface, off every protected control. */
  readonly available: boolean;
  /** A link is under the pointer: navigation, unless this press is consumed. */
  readonly onLink: boolean;
}

/**
 * May a mark tool take this pointer? Only on a page, and only where the browser is
 * not already offering the control underneath — a drag inside a form field is the
 * field's, and swallowing it is how a working control becomes a dead one. A link is
 * reported rather than refused: the caller consumes it only when it actually
 * handles the press, and cancels exactly that click's navigation.
 */
export function pageGestureAt(clientX: number, clientY: number): PageGestureOwner {
  const under = document.elementFromPoint(clientX, clientY);
  if (!(under instanceof Element)) return { available: false, onLink: false };
  const onLink = under.closest(LINK_TARGETS) !== null;
  if (under.closest(PAGE_SURFACES) === null) return { available: false, onLink: false };
  if (under.closest(PROTECTED_TARGETS) !== null) return { available: false, onLink: false };
  return { available: true, onLink };
}

/**
 * Control that holds the keyboard while it is focused: the property strip's inputs,
 * the form fields pdf.js renders, a comment row's own editor. `button` is absent on
 * purpose — a rail button holds no text, and releasing it is the browser's own
 * default, not a tool's business.
 */
const FOCUS_HOLDERS =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * A press a tool **consumed** is a press the browser never got, and the focus
 * change is one of the things it did not get: a property input stays focused through
 * a canvas gesture, so the next Ctrl+Z is *that input's* undo and never the
 * journal's. A consumed press aimed at the page moved the keyboard to the page, so
 * the holder is let go — `blur()` and never a `focus()` call, which is what keeps
 * the viewer's scroll container where the user left it. The pointer's own focus
 * holder is not released here: `pageGestureAt` refuses those presses long before a
 * gesture is consumed. Both consuming layers call this so there is one answer to
 * "where does the keyboard go when a tool takes the press".
 */
export function releaseFocusHolder(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches(FOCUS_HOLDERS)) active.blur();
}

/**
 * How long a click may take to arrive after the press it belongs to. Browsers
 * dispatch `click` immediately after `pointerup`, so a suppression older than this
 * belongs to nothing and must never eat an unrelated click.
 */
const CLICK_WINDOW_MS = 1000;

/**
 * The click that follows a press a mark tool **consumed**.
 *
 * Navigation is a *default action of the click*, not of the pointerdown, so a tool
 * that took a link press has to cancel the click too — and the suppression has to
 * outlive the gesture: moving a persisted link makes the shell busy, which can
 * disable or unmount the layer between the pointerup and the click. So it is not
 * component-effect state, it is a clock: `suppress()` at the moment the gesture is
 * handled, `reset()` at every new press, and `consume()` once per click, which
 * answers whether that click was the one this press owned.
 */
export interface ClickSuppression {
  suppress(): void;
  reset(): void;
  consume(): boolean;
}

export function clickSuppression(): ClickSuppression {
  let until = 0;
  return {
    suppress() {
      until = performance.now() + CLICK_WINDOW_MS;
    },
    reset() {
      until = 0;
    },
    consume() {
      const owned = until !== 0 && performance.now() <= until;
      until = 0;
      return owned;
    },
  };
}

// ---------------------------------------------------------------------------
// hit tests: page points, painted areas, segments
// ---------------------------------------------------------------------------

/** Below this (page points) a difference is rounding, not geometry. */
const EPSILON = 1e-9;

/** Distance from a point to a segment; the segment's own length when it is a point. */
function pointToSegmentDistance(point: MarkPoint, a: MarkPoint, b: MarkPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Do the two segments touch? Collinear overlap counts, so an edge lying along a stroke still cuts it. */
function segmentsIntersect(a: MarkPoint, b: MarkPoint, c: MarkPoint, d: MarkPoint): boolean {
  const orientation = (p: MarkPoint, q: MarkPoint, r: MarkPoint): number =>
    (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  const onSegment = (p: MarkPoint, q: MarkPoint, r: MarkPoint): boolean =>
    Math.min(p.x, r.x) - EPSILON <= q.x &&
    q.x <= Math.max(p.x, r.x) + EPSILON &&
    Math.min(p.y, r.y) - EPSILON <= q.y &&
    q.y <= Math.max(p.y, r.y) + EPSILON;

  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if ((o1 > 0 !== o2 > 0 || o1 === 0 || o2 === 0) && (o3 > 0 !== o4 > 0 || o3 === 0 || o4 === 0)) {
    if (o1 === 0 && onSegment(a, c, b)) return true;
    if (o2 === 0 && onSegment(a, d, b)) return true;
    if (o3 === 0 && onSegment(c, a, d)) return true;
    if (o4 === 0 && onSegment(c, b, d)) return true;
    if (o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true;
  }
  return false;
}

/** A point's distance to a rectangle: 0 when it is inside. */
function pointToRectDistance(point: MarkPoint, rect: MarkRect): number {
  const [x0, y0, x1, y1] = normaliseRect(rect);
  const dx = Math.max(x0 - point.x, 0, point.x - x1);
  const dy = Math.max(y0 - point.y, 0, point.y - y1);
  if (dx === 0 && dy === 0) return 0;
  return Math.hypot(dx, dy);
}

/** A segment's distance to a rectangle: 0 when it touches or crosses it. */
function segmentToRectDistance(a: MarkPoint, b: MarkPoint, rect: MarkRect): number {
  const [x0, y0, x1, y1] = normaliseRect(rect);
  if (pointToRectDistance(a, rect) === 0 || pointToRectDistance(b, rect) === 0) return 0;
  const corners: readonly MarkPoint[] = [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
  for (let index = 0; index < corners.length; index += 1) {
    const c = corners[index] as MarkPoint;
    const d = corners[(index + 1) % corners.length] as MarkPoint;
    if (segmentsIntersect(a, b, c, d)) return 0;
  }
  return Math.min(
    pointToSegmentDistance({ x: x0, y: y0 }, a, b),
    pointToSegmentDistance({ x: x1, y: y1 }, a, b),
  );
}

/** Do the two rectangles share any page point? Touching edges count. */
function rectsIntersect(a: MarkRect, b: MarkRect): boolean {
  const [ax0, ay0, ax1, ay1] = normaliseRect(a);
  const [bx0, by0, bx1, by1] = normaliseRect(b);
  return ax0 <= bx1 + EPSILON && bx0 <= ax1 + EPSILON && ay0 <= by1 + EPSILON && by0 <= ay1 + EPSILON;
}

/** The polyline's points, in pairs. */
function pathPoints(path: readonly number[]): readonly MarkPoint[] {
  const points: MarkPoint[] = [];
  for (let index = 0; index + 1 < path.length; index += 2) {
    points.push({ x: path[index] ?? 0, y: path[index + 1] ?? 0 });
  }
  return points;
}

/** A point's distance to a flattened polyline — segment by segment, not vertex by vertex. */
function pointToPathDistance(point: MarkPoint, path: readonly number[]): number {
  const points = pathPoints(path);
  const first = points[0];
  if (first === undefined) return Number.POSITIVE_INFINITY;
  let best = Math.hypot(point.x - first.x, point.y - first.y);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1] as MarkPoint;
    const current = points[index] as MarkPoint;
    best = Math.min(best, pointToSegmentDistance(point, previous, current));
  }
  return best;
}

/** The path's distance to a rectangle. */
function pathToRectDistance(path: readonly number[], rect: MarkRect): number {
  const points = pathPoints(path);
  const first = points[0];
  if (first === undefined) return Number.POSITIVE_INFINITY;
  let best = pointToRectDistance(first, rect);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1] as MarkPoint;
    const current = points[index] as MarkPoint;
    best = Math.min(best, segmentToRectDistance(previous, current, rect));
  }
  return best;
}

/**
 * The radius a mark is hit within: the caller's own radius (a click's slop, in page
 * points) plus half the mark's painted stroke, so a hairline is as clickable as a
 * thick one. Painted areas are padded by the same amount.
 */
function hitRadius(target: MarkTarget, radius: number): number {
  return Math.max(radius, 0) + (target.strokeWidth ?? 0) / 2;
}

/** Is the point on — or within `radius` page points of — anything this target paints? */
export function targetPointHit(target: MarkTarget, point: MarkPoint, radius: number): boolean {
  const reach = hitRadius(target, radius);
  for (const box of target.boxes) {
    if (pointToRectDistance(point, box) <= reach) return true;
  }
  for (const path of target.paths ?? []) {
    if (pointToPathDistance(point, path) <= reach) return true;
  }
  return false;
}

/** Does the rectangle share a page point with anything this target paints? */
export function targetMarqueeHit(target: MarkTarget, rect: MarkRect): boolean {
  const reach = (target.strokeWidth ?? 0) / 2;
  for (const box of target.boxes) {
    if (rectsIntersect(box, rect)) return true;
    // A target whose only painted box is a hairline-thin rectangle still counts
    // when the marquee is inside the stroke's own width of it.
    if (
      rectsIntersect(
        [
          Math.min(box[0], box[2]) - reach,
          Math.min(box[1], box[3]) - reach,
          Math.max(box[0], box[2]) + reach,
          Math.max(box[1], box[3]) + reach,
        ],
        rect,
      )
    ) {
      return true;
    }
  }
  for (const path of target.paths ?? []) {
    if (pathToRectDistance(path, rect) <= reach) return true;
  }
  return false;
}

/** Everything the target paints, as one page-space rectangle; `null` when it paints nothing. */
export function targetBounds(target: MarkTarget): MarkRect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const include = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const box of target.boxes) {
    const [x0, y0, x1, y1] = normaliseRect(box);
    include(x0, y0);
    include(x1, y1);
  }
  for (const path of target.paths ?? []) {
    for (const point of pathPoints(path)) include(point.x, point.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return [minX, minY, maxX, maxY];
}

// ---------------------------------------------------------------------------
// the set-level questions the layer asks
// ---------------------------------------------------------------------------

/** The targets on this page the point is on, in list order. */
export function hitTargets(
  targets: readonly MarkTarget[],
  point: MarkPoint & { readonly pageIndex: number },
  radius: number,
): readonly MarkTarget[] {
  return targets.filter(
    (target) => target.pageIndex === point.pageIndex && targetPointHit(target, point, radius),
  );
}

/** The targets intersecting any of the marquee's per-page rectangles. */
export function marqueeTargets(
  targets: readonly MarkTarget[],
  areas: readonly MarkArea[],
): readonly MarkTarget[] {
  return targets.filter((target) =>
    areas.some((area) => area.pageIndex === target.pageIndex && targetMarqueeHit(target, area.rect)),
  );
}
