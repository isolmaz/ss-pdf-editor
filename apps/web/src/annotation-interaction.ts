/**
 * The common mark layer's App half (`local://tool-interaction-contract.txt`, and the
 * selection/edit API of `local://selection-edit-contract.txt`).
 *
 * Four families of mark live on the page — the session's own annotations, its
 * measurements, its redaction intents and the annotations the file already carries —
 * and every one of them has to be *one* thing to the tools: one identity, one
 * geometry, one label. That conversion happens here, and only here, for three reasons.
 *
 * **The geometry is not the same geometry.** Session marks are stored in the app's
 * own space (`ViewerApi.pointToPage`): unrotated user space, origin at the top-left
 * of the page's view box, points, growing downward. A PDF annotation's `/Rect` is in
 * PDF user space, origin bottom-left — so an existing annotation's rectangle is
 * flipped through the page's geometry before it can be compared with a mark the user
 * just drew (`top - pdfY`, `x` untouched; the contract's `pageGeometry().top`). The
 * two spaces are one subtraction apart and that subtraction is the whole difference
 * between a target the pointer meets and a target it cannot reach.
 *
 * **A mark can also be turned.** `AnnotationMark.rotation` is a quarter-turn about
 * the mark's *own* bounding-box centre, applied when the mark is painted rather than
 * stored, so a target built from the stored geometry alone would sit where the mark
 * used to be. The conversion follows the same turn, through core's own
 * `transformPoint`, for exactly the same reason the flip is not re-implemented here.
 *
 * **The identity is not the same identity.** A mark the session holds and the file's
 * copy of that same mark are one thing to the user: our own writer stamps
 * `pdf-editor-ann:<id>` into `/Contents` (`ops/annotations.ts`), so a file annotation
 * whose marker names a pending mark is that mark — it is listed once, and the
 * persisted half wins, because deleting it is what actually removes the bytes. The same
 * reading is `normalizePendingMarks`' work on the session's own lists, so that one mark
 * is not painted twice — or moved twice.
 *
 * Nothing here touches React, the store or the engine: the target list is a pure
 * projection of the model the shell already holds, which is what lets it be memoized,
 * and an edit plan is a value built beside its input rather than out of it. The bytes
 * stay somebody else's job — a plan names the file annotations a writer has to reach,
 * and claims nothing that writer has not verified.
 */

import {
  annotationBounds,
  type MarkTransform,
  transformAnnotationMark,
  transformPoint,
} from 'pdf-core/ops/annotation-transform';
import type { AnnotationMark, ExistingAnnotation } from 'pdf-core/ops/annotations';
import { annotationKindKey, markerId } from 'pdf-core/ops/annotations';
import type { MeasureMark } from 'pdf-core/ops/measure';
import type { RedactRect } from 'pdf-core/ops/redact';
import type { MessageKey } from 'pdf-shared';
import { type MarkFamily, type MarkTarget, markTargetKey } from 'pdf-ui/tools';

/**
 * The identity convention lives in `mark-interaction.ts` and is re-exported here
 * rather than restated: a second spelling of "which mark is this" is exactly the bug
 * class the common layer exists to remove, and the panel rows and the layer's
 * selection have to name the same target.
 */
export { markTargetKey };

/** A redaction intent as the session stores it: an id and the rectangle behind it. */
export interface MarkedRedaction {
  readonly id: string;
  readonly mark: RedactRect;
}

/**
 * The page's flip reference: the PDF user-space y that is the top of the page's
 * **view box** (`viewBox[3]`), which is what `ViewerApi.pointToPage` flips against.
 * `null` when the viewer cannot answer for that page yet.
 *
 * `pageGeometry().y + pageGeometry().height` is that same number read from the fields
 * the viewer has always returned, so this conversion does not depend on the added
 * `top`/`originX` members to be correct.
 */
export type PageTopReader = (pageIndex: number) => number | null;

/** A box in the app's own space: `[x0, y0, x1, y1]`, top-left origin, points. */
type Box = readonly [number, number, number, number];

/** Everything the target list is built from. */
export interface MarkTargetInput {
  readonly annotations: readonly AnnotationMark[];
  readonly measures: readonly MeasureMark[];
  readonly redactions: readonly MarkedRedaction[];
  readonly existing: readonly ExistingAnnotation[];
  readonly pageTop: PageTopReader;
  /** The already-translated family name; a target's label is never a raw id. */
  readonly labelFor: (family: MarkFamily, messageKey: MessageKey, subtype?: string) => string;
}

/** `/Widget` and `/Popup` are never a user's mark: a field's widget is the field, a popup is its note's window. */
function isDeletableAnnotation(annotation: ExistingAnnotation): boolean {
  if (annotation.subtype === 'Widget' || annotation.subtype === 'Popup') return false;
  // `annotationType` is pdf.js's own numeric vocabulary (`20` Widget, `16` Popup), the
  // second reading of the same fact: a subtype pdf.js could not name must not turn a
  // form field into something a selection is allowed to remove.
  return annotation.annotationType !== 20 && annotation.annotationType !== 16;
}

/**
 * Every session mark id the file already carries.
 *
 * Read from the one marker convention our writers share: `markerFor` stamps
 * `pdf-editor-ann:<id>` into `/Contents` for text marks, shapes and measurements
 * alike (`ops/annotations.ts`, `ops/annotation-shapes.ts`, `ops/measure.ts`), so one
 * read of the file's annotations names a persisted copy of any of those families. A
 * mark whose id is in this set has bytes; it is not pending any more.
 *
 * The marker carries a document-unique `crypto.randomUUID()`, so the id alone is the
 * identity — the page is not part of it, and it does not have to be: the same reading
 * has to hold for the target list, the normalizer and the writer, or a mark's
 * identity would depend on which of them asked.
 */
function persistedMarkIds(existing: readonly ExistingAnnotation[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const annotation of existing) {
    const marker = markerId(annotation.contents);
    if (marker !== null) ids.add(marker);
  }
  return ids;
}

/** `items` without the ones a persisted id names; the same array when nothing is dropped. */
function withoutPersisted<T extends { readonly id: string }>(
  items: readonly T[],
  persisted: ReadonlySet<string>,
): readonly T[] {
  if (persisted.size === 0) return items;
  const kept = items.filter((item) => !persisted.has(item.id));
  return kept.length === items.length ? items : kept;
}

/**
 * The session's own marks, as the state holds them: the three families this module
 * projects, normalizes and edits. One shape for one thing, because the normalizer and
 * the planner take the same three arrays.
 */
export interface PendingMarks {
  readonly annotations: readonly AnnotationMark[];
  readonly measures: readonly MeasureMark[];
  readonly redactions: readonly MarkedRedaction[];
}

/**
 * Drop the session marks the file already carries.
 *
 * A write path that materializes surviving overlays into the PDF returns the same
 * pending lists it started from — and after that the same mark exists twice: as the
 * bytes the viewer now reads out of the file, and as the session object that wrote
 * them. Painful twice over: the page paints both copies, and acting on both
 * "deletes" or moves a mark whose written half stays exactly where it is. This is the
 * one place that duplication is resolved — rendering reads its lists through here, and
 * every intent (removal, transform) is built on the lists it returns — so a mark's
 * identity in the session and a mark's identity in the file cannot drift apart.
 *
 * Measurements are included because they are the same convention, not a special case:
 * `writeMeasureAnnotations` stamps the same marker into `/Contents`, which is how a
 * written ruler is recognized without guessing at its geometry.
 *
 * Redaction intents are **not** annotation writes: a redaction's effect is the content
 * it removed, nothing of it is left in the file to match against, so the staged list
 * passes through untouched.
 *
 * Pure and identity-preserving: nothing is mutated, an array with nothing dropped is
 * returned as the same reference, and every surviving mark is the same object.
 */
export function normalizePendingMarks(
  input: PendingMarks,
  existing: readonly ExistingAnnotation[],
): PendingMarks {
  const persisted = persistedMarkIds(existing);
  const annotations = withoutPersisted(input.annotations, persisted);
  const measures = withoutPersisted(input.measures, persisted);
  if (annotations === input.annotations && measures === input.measures) return input;
  return { annotations, measures, redactions: input.redactions };
}

/**
 * The flip reference for an existing annotation's `/Rect`: the **source page's** own
 * top edge when the reader reports it (`pageBox`, in the writer's vocabulary), and the
 * viewer's geometry otherwise. A viewport's view box can be a borrowed default when a
 * document's pages differ, and a borrowed one flips the mark to the wrong end of the
 * page.
 */
function existingPageTop(annotation: ExistingAnnotation, readPageTop: PageTopReader): number | null {
  const top = annotation.pageBox?.[3];
  return typeof top === 'number' ? top : readPageTop(annotation.pageIndex);
}

/** A flat PDF quad run (four corners per quad, lower-left origin) → the app's boxes. */
function pdfQuadsToAppBoxes(quadPoints: readonly number[], pageTop: number): readonly Box[] {
  const boxes: Box[] = [];
  for (let index = 0; index + 7 < quadPoints.length; index += 8) {
    const xs = [
      quadPoints[index] ?? 0,
      quadPoints[index + 2] ?? 0,
      quadPoints[index + 4] ?? 0,
      quadPoints[index + 6] ?? 0,
    ];
    const ys = [
      quadPoints[index + 1] ?? 0,
      quadPoints[index + 3] ?? 0,
      quadPoints[index + 5] ?? 0,
      quadPoints[index + 7] ?? 0,
    ];
    boxes.push(
      pdfRectToAppBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], pageTop),
    );
  }
  return boxes;
}

/** A flat PDF stroke (`[x, y, …]`, lower-left origin) → the same stroke, y flipped. */
function pdfStrokeToApp(stroke: readonly number[], pageTop: number): readonly number[] {
  const flipped: number[] = [];
  for (const [index, value] of stroke.entries()) {
    flipped.push(index % 2 === 0 ? value : pageTop - value);
  }
  return flipped;
}

/** `[x0, y0, x1, y1]` with `x0 <= x1` and `y0 <= y1`. */
function orderedBox(a: Box): Box {
  return [Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3])];
}

/**
 * A PDF rectangle (bottom-left origin, user space) → the app's box (top-left origin).
 * `x` is absolute user-space x, exactly as a stored mark's x is; only `y` flips.
 */
function pdfRectToAppBox(rect: Box, pageTop: number): Box {
  const [x0, pdfY0, x1, pdfY1] = rect;
  return orderedBox([x0, pageTop - pdfY1, x1, pageTop - pdfY0]);
}

/** The boxes a mark paints, in the app's space; empty when the mark carries no geometry. */
function annotationBoxes(mark: AnnotationMark): readonly Box[] {
  if (mark.kind === 'shapes' || mark.kind === 'note' || mark.kind === 'freetext') {
    const rect = mark.rect ?? mark.quads[0];
    return rect === undefined ? [] : [rect];
  }
  return mark.quads;
}

/**
 * A box as the mark is painted: two opposite corners through the quarter-turn about
 * the mark's own bounding-box centre, ordered again afterwards.
 *
 * A quarter-turn maps a rectangle onto a rectangle, so the two corners are the whole
 * box — one `transformPoint` pair, core's arithmetic, exact at 90° steps.
 */
function rotatedBox(box: Box, bounds: Box, transform: MarkTransform): Box {
  const first = transformPoint({ x: box[0], y: box[1] }, bounds, transform);
  const second = transformPoint({ x: box[2], y: box[3] }, bounds, transform);
  return orderedBox([first.x, first.y, second.x, second.y]);
}

/** A flat `[x, y, …]` run through the same turn, point by point. */
function rotatedPath(path: readonly number[], bounds: Box, transform: MarkTransform): readonly number[] {
  const turned: number[] = [];
  for (let index = 0; index + 1 < path.length; index += 2) {
    const point = transformPoint({ x: path[index] ?? 0, y: path[index + 1] ?? 0 }, bounds, transform);
    turned.push(point.x, point.y);
  }
  // A trailing odd value is not a point, so it is not turned — but it is kept where it
  // is, exactly as core's own run walk keeps it, so a target's path and a written mark's
  // path stay the same run even when the run was malformed to begin with.
  if (path.length % 2 === 1) turned.push(path[path.length - 1] ?? 0);
  return turned;
}

/**
 * The geometry a mark paints — which is the geometry the pointer has to meet.
 *
 * `AnnotationMark.rotation` is applied at paint time, about the mark's own
 * bounding-box centre, so a target built from the stored quads and strokes would be
 * selectable where the mark *was* and dead where it is *drawn*: hit testing, the
 * selection box and the canvas would disagree about the same mark. Both go through
 * the same centre with the same angle, so they cannot slide apart even for a mark
 * whose quads and strokes would give different centres of their own.
 *
 * An unturned mark is its own target geometry: the stored boxes and stroke arrays
 * travel to the layer unconverted. A mark with no geometry at all has no centre
 * `annotationBounds` will answer for and nothing to turn — it keeps its empty target
 * and stays reachable by identity.
 */
function annotationPaint(mark: AnnotationMark): {
  readonly boxes: readonly Box[];
  readonly paths: readonly (readonly number[])[] | undefined;
} {
  const boxes = annotationBoxes(mark);
  const strokes = mark.strokes;
  const rotation = mark.rotation ?? 0;
  if (rotation === 0) return { boxes, paths: strokes };
  if (boxes.length === 0 && (strokes === undefined || strokes.length === 0)) {
    return { boxes, paths: strokes };
  }
  /**
   * The mark's own stored-geometry bounds: the box the renderer and the writer both
   * turn about, so the stored quads and strokes are turned exactly once — the
   * already-painted result is never turned again.
   */
  const bounds = annotationBounds(mark);
  const turn: MarkTransform = { dx: 0, dy: 0, rotation };
  return {
    boxes: boxes.map((box) => rotatedBox(box, bounds, turn)),
    paths: strokes?.map((stroke) => rotatedPath(stroke, bounds, turn)),
  };
}

/** The bounding box of a measurement's points, or `null` when it has none. */
function measureBox(mark: MeasureMark): Box | null {
  if (mark.points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of mark.points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return [minX, minY, maxX, maxY];
}

/** A measurement's polyline as one flat `[x0, y0, x1, y1, …]` run. */
function measurePath(mark: MeasureMark): readonly number[] {
  const flat: number[] = [];
  for (const point of mark.points) flat.push(point.x, point.y);
  return flat;
}

const MEASURE_LABELS: Readonly<Record<MeasureMark['mode'], MessageKey>> = {
  distance: 'tools.measure.distance',
  perimeter: 'tools.measure.perimeter',
  area: 'tools.measure.area',
};

/**
 * Every mark the page shows, in one list with one identity space.
 *
 * The order is the layer's paint order: session marks first (the user's own work is
 * what the pointer meets first), then the file's annotations.
 */
export function buildMarkTargets(input: MarkTargetInput): readonly MarkTarget[] {
  const targets: MarkTarget[] = [];

  /**
   * Our own marks as the file carries them: the writers stamp
   * `pdf-editor-ann:<id>` into `/Contents` (`markerFor`), so a file annotation
   * carrying that marker *is* the session mark of the same id. The pair is listed once
   * — as the persisted entry, because that is the one whose deletion removes bytes —
   * and the pending copy is dropped below, the same reading `normalizePendingMarks`
   * does for the lists the caller renders from.
   */
  const persisted = persistedMarkIds(input.existing);

  for (const mark of input.annotations) {
    if (persisted.has(mark.id)) continue;
    // The mark as the canvas shows it: a rotation is part of where the mark is, so
    // the boxes and paths the pointer meets are the painted ones (`annotationPaint`).
    const paint = annotationPaint(mark);
    targets.push({
      key: markTargetKey('annotation', mark.id, mark.pageIndex),
      family: 'annotation',
      id: mark.id,
      pageIndex: mark.pageIndex,
      boxes: paint.boxes,
      ...(paint.paths === undefined ? {} : { paths: paint.paths }),
      ...(mark.thickness === undefined ? {} : { strokeWidth: mark.thickness }),
      label: input.labelFor('annotation', annotationKindKey(mark.kind)),
    });
  }

  for (const mark of input.measures) {
    /**
     * The same rule as a text mark's, because the marker is the same: a measurement the
     * file already carries is listed once, as the persisted annotation whose deletion
     * removes it — a written ruler is never selectable twice.
     */
    if (persisted.has(mark.id)) continue;
    const box = measureBox(mark);
    targets.push({
      key: markTargetKey('measure', mark.id, mark.pageIndex),
      family: 'measure',
      id: mark.id,
      pageIndex: mark.pageIndex,
      boxes: box === null ? [] : [box],
      paths: [measurePath(mark)],
      strokeWidth: mark.thickness ?? 1,
      label: input.labelFor('measure', MEASURE_LABELS[mark.mode]),
    });
  }

  for (const item of input.redactions) {
    targets.push({
      key: markTargetKey('redaction', item.id, item.mark.pageIndex),
      family: 'redaction',
      id: item.id,
      pageIndex: item.mark.pageIndex,
      /**
       * The stored rectangle is already in the app's space and already carries the
       * version that says so (`RedactRect.space`), so it travels unconverted — the
       * one family whose geometry needs no projection at all.
       */
      boxes: [orderedBox(item.mark.rect)],
      label: input.labelFor('redaction', 'redact.title'),
    });
  }

  const seen = new Set<string>();
  for (const annotation of input.existing) {
    if (!isDeletableAnnotation(annotation)) continue;
    const key = markTargetKey('existing', annotation.id, annotation.pageIndex);
    if (seen.has(key)) continue;
    seen.add(key);
    const top = existingPageTop(annotation, input.pageTop);
    const kindLabel: readonly [MessageKey, string | undefined] =
      annotation.kind === null
        ? ['ann.inFile', annotation.subtype]
        : [annotationKindKey(annotation.kind), undefined];
    /**
     * The file's own geometry, converted once: `/QuadPoints` where the subtype has
     * them (every text markup in the file), its `/Rect` otherwise, and the raw strokes
     * `/InkList` or `/Vertices` carry where they exist. `y` flips through the page's
     * own top edge; `x` is absolute user-space x, exactly as a stored mark's x is.
     */
    const quads =
      annotation.quadPoints !== undefined && annotation.quadPoints.length >= 8 ? annotation.quadPoints : null;
    const strokes = annotation.inkLists ?? (annotation.vertices === undefined ? null : [annotation.vertices]);
    targets.push({
      key,
      family: 'existing',
      id: annotation.id,
      pageIndex: annotation.pageIndex,
      // No geometry the viewer can place yet: the mark is still selectable, and
      // removable, by identity, so it is never silently unreachable.
      boxes:
        top === null
          ? []
          : quads !== null
            ? pdfQuadsToAppBoxes(quads, top)
            : annotation.rect === null
              ? []
              : [pdfRectToAppBox(annotation.rect, top)],
      ...(top === null || strokes === null
        ? {}
        : { paths: strokes.map((stroke) => pdfStrokeToApp(stroke, top)) }),
      ...(annotation.thickness === undefined ? {} : { strokeWidth: annotation.thickness }),
      label: input.labelFor('existing', kindLabel[0], kindLabel[1]),
    });
  }

  return targets;
}

/**
 * A removal, in the vocabulary the two removal paths share: session marks by id —
 * one list per family, because each list is filtered from its own overlay array —
 * and the file's annotations by page and id, which is what the core writer resolves.
 */
export interface MarkRemovalRequest {
  readonly annotations: readonly string[];
  readonly measures: readonly string[];
  readonly redactions: readonly string[];
  readonly existing: readonly { readonly pageIndex: number; readonly id: string }[];
}

/**
 * Split a selection into the families the shell acts on: the session's own marks by
 * id, one list per family — because each list is filtered from its own overlay array
 * — and the file's annotations by page and id, which is what the core writer
 * resolves.
 *
 * This is the one place a selection is read. Removal (`Delete`) and the geometry
 * planner both start here, so the two can never disagree about which family a key
 * belongs to, or about which ids one edit carries.
 *
 * Keys that are not in `targets` are dropped: a selection that outlived the object it
 * named (a tab switch, an undo) must not be turned into an id the writer is asked to
 * resolve. The persisted list is de-duplicated by page and id, because the same
 * annotation reached through two keys is still one annotation in the file.
 */
export function planMarkRemoval(
  targets: readonly MarkTarget[],
  selectedKeys: readonly string[],
): MarkRemovalRequest {
  const wanted = new Set(selectedKeys);
  const annotations: string[] = [];
  const measures: string[] = [];
  const redactions: string[] = [];
  const existing: { pageIndex: number; id: string }[] = [];
  const persisted = new Set<string>();
  for (const target of targets) {
    if (!wanted.has(target.key)) continue;
    switch (target.family) {
      case 'annotation':
        annotations.push(target.id);
        break;
      case 'measure':
        measures.push(target.id);
        break;
      case 'redaction':
        redactions.push(target.id);
        break;
      case 'existing': {
        const identity = `${target.pageIndex}:${target.id}`;
        if (persisted.has(identity)) break;
        persisted.add(identity);
        existing.push({ pageIndex: target.pageIndex, id: target.id });
        break;
      }
    }
  }
  return { annotations, measures, redactions, existing };
}

/** A removal with nothing to do — the guard both removal paths share. */
export function isEmptyRemoval(request: MarkRemovalRequest): boolean {
  return (
    request.annotations.length === 0 &&
    request.measures.length === 0 &&
    request.redactions.length === 0 &&
    request.existing.length === 0
  );
}

/** How many marks a removal takes out, for a notice that names a number. */
export function removalCount(request: MarkRemovalRequest): number {
  return (
    request.annotations.length + request.measures.length + request.redactions.length + request.existing.length
  );
}

/**
 * What one geometry edit does to a mark, in the app's own space: `dx`/`dy` in page
 * points, `rotation` a clockwise quarter-turn about **each mark's own** bounding-box
 * centre, with the translation applied after the turn.
 *
 * Core's type, re-exported rather than restated: the planner, the writer that commits
 * the same edit into the file and the renderer that draws the result all have to mean
 * the same thing by "rotate 90°", and three spellings of it is two too many.
 */
export type { MarkTransform };

/**
 * One geometry edit, ready to apply: the three session families, whole, plus the file
 * annotations the same edit has to reach.
 *
 * The arrays are whole so a caller can put them straight back into the state they
 * came from. Every mark the edit did not select — and every family array with nothing
 * selected in it — is the *same reference* it arrived as: an edit that moves
 * annotations must not churn the measurements, and the overlay memoizes on identity.
 *
 * `existing` is a set of **targets, not a result**: those marks are bytes in the file,
 * and the only thing that can move them is the core writer
 * (`transformPdfAnnotations`), which reopens the document and verifies what it wrote.
 * The plan names them and claims nothing; a plan is a description of an edit.
 */
export interface MarkEditPlan {
  readonly annotations: readonly AnnotationMark[];
  readonly measures: readonly MeasureMark[];
  readonly redactions: readonly MarkedRedaction[];
  readonly existing: readonly { readonly pageIndex: number; readonly id: string }[];
}

/**
 * Move and turn the marks a selection names, and nothing else.
 *
 * A selection is held in target keys, but a target is a *projection* of an object,
 * not the object: the edit goes back through the family and id each key carries, so
 * the key that outlived its mark (a tab switch, an undo, a delete in the shell) moves
 * nothing rather than moving something else.
 *
 * The array is returned unchanged when nothing in it was selected, and an item with
 * nothing to move (a measurement with no points) keeps its reference: identity is
 * preserved wherever there is nothing to change.
 */
function mapSelected<T extends { readonly id: string }>(
  items: readonly T[],
  selected: ReadonlySet<string>,
  transform: (item: T) => T,
): readonly T[] {
  if (selected.size === 0) return items;
  let changed = false;
  const next = items.map((item) => {
    if (!selected.has(item.id)) return item;
    const moved = transform(item);
    if (moved !== item) changed = true;
    return moved;
  });
  return changed ? next : items;
}

/**
 * A measurement, moved: every point of the chain goes through the turn about the
 * measurement's own bounding box, and then the translation.
 *
 * `MeasureMark` has no `rotation` of its own — its points *are* its geometry — so the
 * turn is baked into the chain, exactly where the viewer then draws it. Every derived
 * fact (length, perimeter, area, bearing) is a fact of the chain, so a moved
 * measurement stays consistent with itself.
 */
function transformMeasure(mark: MeasureMark, transform: MarkTransform): MeasureMark {
  const bounds = measureBox(mark);
  // Nothing to move: the mark stays the object it is, for the same reason an
  // unselected one does.
  if (bounds === null) return mark;
  return {
    ...mark,
    points: mark.points.map((point) => transformPoint(point, bounds, transform)),
  };
}

/**
 * A staged redaction, moved: its four corners through the same turn about its own
 * box, and the box re-ordered afterwards.
 *
 * A quarter-turn of an axis-aligned box is still axis-aligned, so the corners' own
 * bounds *are* the rectangle the user will see — and the stored mark keeps its
 * `space` version, because the rectangle it labels is still in that space.
 */
function transformRedaction(item: MarkedRedaction, transform: MarkTransform): MarkedRedaction {
  const rect = orderedBox(item.mark.rect);
  const moved = [
    { x: rect[0], y: rect[1] },
    { x: rect[2], y: rect[1] },
    { x: rect[2], y: rect[3] },
    { x: rect[0], y: rect[3] },
  ].map((corner) => transformPoint(corner, rect, transform));
  const xs = moved.map((point) => point.x);
  const ys = moved.map((point) => point.y);
  const next = orderedBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  return { id: item.id, mark: { ...item.mark, rect: next } };
}

/**
 * Plan one move/rotate of the current selection.
 *
 * The four families do not move the same way, and that difference is the whole reason
 * this function exists:
 *
 *  - **annotations** go through core's `transformAnnotationMark`, which translates the
 *    stored quads/strokes and *accumulates* `rotation` on the mark. The stored geometry
 *    stays unrotated and the renderer turns it once at paint time; baking the turn
 *    here instead would turn every mark twice, and would also lose the fact that a
 *    90° mark is still a 90° mark to the writer.
 *  - **measurements** and **redactions** have no rotation of their own, so their points
 *    and rectangle corners are turned once, about their own box, through core's
 *    `transformPoint` and stored turned. A redaction rectangle is re-ordered because
 *    the writer and the verifier both compare ascending boxes.
 *  - **the file's annotations** cannot move here at all. They are in the bytes, so the
 *    plan returns the `pageIndex`/`id` refs the core writer resolves, and the write
 *    path is what verifies the result by reopening it.
 *
 * Keys are read through `planMarkRemoval`, the selection split `Delete` uses, so both
 * paths agree on which key is which object and on which persisted annotation is
 * already named once.
 */
export function planMarkTransform(
  input: PendingMarks,
  targets: readonly MarkTarget[],
  keys: readonly string[],
  transform: MarkTransform,
): MarkEditPlan {
  const split = planMarkRemoval(targets, keys);
  // The same split, read as membership: a mark moves only when an id of its own
  // family names it.
  const annotationIds = new Set(split.annotations);
  const measureIds = new Set(split.measures);
  const redactionIds = new Set(split.redactions);
  return {
    annotations: mapSelected(input.annotations, annotationIds, (mark) =>
      transformAnnotationMark(mark, transform),
    ),
    measures: mapSelected(input.measures, measureIds, (mark) => transformMeasure(mark, transform)),
    redactions: mapSelected(input.redactions, redactionIds, (item) => transformRedaction(item, transform)),
    existing: split.existing,
  };
}
