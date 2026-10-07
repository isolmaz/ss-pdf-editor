/**
 * The annotation tool surface.
 *
 * One component, two jobs, because they share the only thing that is hard here —
 * the geometry:
 *
 *  - **input**: the armed tool draws a mark. Text-selection tools (highlight,
 *    underline, strikeout, squiggly) measure the real selection in the text
 *    layer, so a mark covers exactly the words the user selected; ink and the
 *    shapes are pointer gestures in page points; a note is a single click.
 *  - **review**: the marks the session has not written to the file yet are drawn
 *    on top of the page, in the same space the writer converts from, so what the
 *    user sees before saving is what the file will contain afterwards.
 *
 * **Every kind is created here.** The engine's own annotation editors are not used
 * at all any more; the engine-editor half of the annotation writer is retired, and with it the ink editor
 * that made the user's stroke come out dotted: pdf.js's `InkEditor` produced the
 * mark, and the hand-off that converted its engine record read the sampled path as
 * one stroke **per point**, so a continuous pen stroke reached the screen (and then
 * the file) as a trail of round dots. Arming an editor also switched the whole viewer
 * into an editing mode: the editor layer was rebuilt and the base canvas repainted
 * per mark. Creating every kind here removes all of it — one flat, sampled path per
 * gesture, no editor layers, no mode switches. The engine still *displays* the file's
 * annotations, forms and widgets; its editing modes are simply never entered
 * (`PdfViewerPane` builds the stack with `annotationEditorMode: DISABLE`). So the
 * four text tools measure the browser's own selection in the text layer, ink and the
 * shapes are pointer gestures in page points, and a note is a single click.
 *
 * Selection, marquee and movement answer for every mark family at once —
 * measurements and redaction intents included — so `MarkInteractionLayer` owns
 * them. Deletion is a selection action, not a separate eraser.
 * What stays is `data-ann` on the visuals, because consumers look marks up by it.
 *
 * ## Two things the overlay has to get right
 *
 * A highlight is a **tint over the page's own pixels**, not a cover over them: in
 * the file it is a `/Highlight` with `/BM /Multiply`, so the overlay paints it in
 * the same blend mode (`mix-blend-mode: multiply`). A solid fill — what this layer
 * drew before — hid the words it marked at every opacity, and the words only came
 * back when something else repainted the page; multiplied, the glyphs stay dark and
 * the tint darkens them the way a real marker does, at opacity 1 and where two
 * highlights overlap. The blend reaches the page only while nothing between them
 * isolates it, so the blended marks live in their **own root with no `z-index`**: a
 * positioned element with a z-index is a stacking context, a stacking context is an
 * isolated group, and an isolated group's backdrop stops at its own edge — the
 * multiply would then blend against nothing and paint solid again.
 *
 * A highlight has **two creators, and one press decides which**: the browser's own
 * text selection when the press began on the text layer and produced one (the mark
 * carries the selected lines as `quads`, exactly as before), and a freehand marker
 * stroke over everything else — a scan, an image, an area that is not text — where
 * there is nothing to select. Both produce the same kind, so selecting, moving,
 * rotating and deleting need no special case, and the freehand variant is one flat
 * run (`strokes: [[x, y, …]]`, the shape ink already carries) drawn as a single
 * continuous path rather than a trail of dots.
 *
 * An optional `AnnotationMark.rotation` is honored exactly as the writer stores it:
 * the geometry stays unrotated and the mark turns **clockwise about the centre of
 * `annotationBounds`** (`pdf-core/ops/annotation-transform.ts`, the same call the
 * writer and the hit tests use). Turning the stored corners in page space before the
 * projection is the same as turning them in the projected space, because the
 * projection is orientation-preserving at every zoom and for all four page
 * rotations — so a turned mark's outline is the geometry the file will carry.
 *
 * ## Geometry, once
 *
 * `mark-interaction.ts` owns the projection and the layer uses nothing else: a
 * mark's stored box goes through the same `appToDisplayPoint` × page scale pair
 * `MeasureLayer` draws with, at every zoom and for all four rotations. (The old
 * hand-written table here subtracted the container offset twice on the 270° row,
 * so every mark on a `/Rotate 270` page was drawn one dock-width to the left.)
 *
 * ## No interception surface
 *
 * The layer never covers the page: its root is `pointer-events-none` and it
 * listens on `window` while a tool is armed, starting a gesture only on a page and
 * never on a widget or on the shell's chrome (`pageGestureAt`). A transparent box
 * across the canvas would swallow every hover under it and — worse — the text
 * selection the four text tools have to measure, so the browser would have nothing
 * to select and no mark could ever be drawn over words.
 *
 * Drawing over a link is allowed (a mark covers what the user drew on), and a drag
 * that produced one cancels the click that follows it, so the link does not also
 * open (`clickSuppression` in `mark-interaction.ts`). A click that produced nothing
 * stays the link's.
 */

import {
  FREETEXT_DEFAULT_SIZE,
  FREETEXT_LINE_HEIGHT,
  FREETEXT_PADDING,
  freeTextSize,
} from 'pdf-core/ops/annotation-freetext';
import { annotationBounds, type MarkTransform, transformPoint } from 'pdf-core/ops/annotation-transform';
import type { AnnotationKind, AnnotationMark, MarkBox } from 'pdf-core/ops/annotations';
import { annotationKindKey } from 'pdf-core/ops/annotations';
import type { LinkTargetRect } from 'pdf-core/ops/link-edit';
import type { MessageKey, Translator } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import {
  clickSuppression,
  type MarkPageFrame,
  markPageFrameOf,
  pageGestureAt,
  releaseFocusHolder,
} from './mark-interaction';

/**
 * The armed tool. Every annotation kind plus one tool that is **not** an annotation
 * kind: a link is an annotation in the file, but it is not a markup mark the session
 * holds — it is written straight to the file by `ops/link-edit.ts`, so it never
 * enters `AnnotationMark` and never travels the save path. Keeping it out of
 * `AnnotationKind` is what keeps those two models apart.
 *
 * Selection and movement are not creators: `MarkInteractionLayer` owns them
 * across all mark families, with one pointer owner per mode.
 */
export type AnnotationTool = AnnotationKind | 'link';

/** The kinds `markStyle` paints with one styled box per line: ink, shapes and typed text have their own branches. */
type MarkupKind = Exclude<AnnotationKind, 'ink' | 'shapes' | 'freetext'>;

/** A text selection, already reduced to per-line boxes in page points. */
export interface TextSelection {
  readonly pageIndex: number;
  readonly boxes: readonly MarkBox[];
}

export interface AnnotationLayerProps {
  readonly t: Translator;
  /** The armed tool; `null` renders only the marks the session already holds. */
  readonly tool: AnnotationTool | null;
  readonly viewer: ViewerApi;
  /** Marks not yet written to the file — the overlay half. */
  readonly marks: readonly AnnotationMark[];
  readonly onCreate: (mark: AnnotationMark) => void;
  /** Armed tool done (a one-shot mark), so the shell can disarm it. */
  readonly onDone?: () => void;
  /**
   * A dragged rectangle for a tool that is not a mark — only the link tool. The rect
   * is in the same space `ops/link-edit.ts` documents (`LinkTargetRect`), because both
   * sides measure on the rendered page.
   */
  readonly onRegion?: (region: LinkTargetRect) => void;
  /** Colour and opacity new marks inherit from the tool settings. */
  readonly color: string;
  readonly opacity: number;
  readonly thickness: number;
  readonly author: string;
  /** The shape the shapes tool draws; the property strip picks it. */
  readonly shape?: 'square' | 'circle' | 'line';
  /** Typed text: its colour and its size in points. */
  readonly textColor?: string;
  readonly fontSize?: number;
}

/** A text box being typed: where its top-left corner is, in page points. */
interface TextDraft {
  readonly pageIndex: number;
  /** The clicked point, in page points: the box's top-left corner **as the reader sees it**. */
  readonly x: number;
  readonly y: number;
  /**
   * The box's width in points along the screen's horizontal: to the page's visible right
   * edge, at most {@link TEXT_BOX_WIDTH}. On a turned page that is not the page's own x.
   */
  readonly width: number;
}

/** The width a new text box starts with, in points; it wraps inside it. */
const TEXT_BOX_WIDTH = 220;

/** The face the writer embeds, so the box on screen wraps where the file will. */
const TEXT_FACE = '"Pdf Noto Sans", "Noto Sans", sans-serif';

interface DragState {
  readonly pointerId: number;
  readonly pageIndex: number;
  readonly startX: number;
  readonly startY: number;
  /** The press landed on a link: drawing over one must not also open it. */
  readonly onLink: boolean;
  currentX: number;
  currentY: number;
  /** Ink's live stroke, flat `[x, y, …]`, in the format the mark itself carries. */
  points: number[] | null;
}

/** Below this (in page points) a drag is a click, not a rectangle. */
const MIN_MARK_POINTS = 3;

/** The side of a note placed with a click, in page points. */
const NOTE_SIZE = 24;

/** The four tools that measure the browser's own text selection instead of dragging. */
function isTextTool(
  tool: AnnotationTool | null,
): tool is 'highlight' | 'underline' | 'strikeout' | 'squiggly' {
  return tool === 'highlight' || tool === 'underline' || tool === 'strikeout' || tool === 'squiggly';
}

/**
 * Selection → per-line boxes, one entry per page the selection touches.
 *
 * The text layer is a stack of absolutely positioned spans, one per text run, so
 * a selection is measured by walking the DOM ranges it spans and collecting each
 * client rect. Consecutive rects on the same line are merged (a line is usually
 * several spans), and each rect is converted through the viewer's own point
 * mapping — which is why a mark lands exactly on the words even at 250 % zoom on
 * a rotated page.
 *
 * One mark per page: a selection spanning a page break yields one entry per page
 * and the caller creates one mark from each. Returning only the first page would
 * silently mark just the part of the selection above the break.
 */
export function selectionBoxes(viewer: ViewerApi): readonly TextSelection[] {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return [];

  const rects: { pageIndex: number; box: MarkBox }[] = [];
  for (let rangeIndex = 0; rangeIndex < selection.rangeCount; rangeIndex += 1) {
    const range = selection.getRangeAt(rangeIndex);
    for (const client of range.getClientRects()) {
      if (client.width <= 0 || client.height <= 0) continue;
      const first = viewer.pointToPage(client.left, client.top);
      const second = viewer.pointToPage(client.right, client.bottom);
      if (first === null || second === null || first.pageIndex !== second.pageIndex) continue;
      rects.push({
        pageIndex: first.pageIndex,
        box: [
          Math.min(first.x, second.x),
          Math.min(first.y, second.y),
          Math.max(first.x, second.x),
          Math.max(first.y, second.y),
        ],
      });
    }
  }
  if (rects.length === 0) return [];

  const boxesByPage = new Map<number, MarkBox[]>();
  for (const { pageIndex, box } of rects) {
    const page = boxesByPage.get(pageIndex);
    if (page === undefined) boxesByPage.set(pageIndex, [box]);
    else page.push(box);
  }
  return [...boxesByPage].map(([pageIndex, boxes]) => ({ pageIndex, boxes: mergeLineBoxes(boxes) }));
}

/** Merge boxes that overlap vertically (same line, several spans) into one. */
function mergeLineBoxes(boxes: readonly MarkBox[]): readonly MarkBox[] {
  const sorted = [...boxes].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const merged: MarkBox[] = [];
  for (const box of sorted) {
    const previous = merged[merged.length - 1];
    if (previous === undefined) {
      merged.push(box);
      continue;
    }
    const overlapsVertically = box[1] <= previous[3] + 1 && box[3] >= previous[1] - 1;
    if (!overlapsVertically) {
      merged.push(box);
      continue;
    }
    merged[merged.length - 1] = [
      Math.min(previous[0], box[0]),
      Math.min(previous[1], box[1]),
      Math.max(previous[2], box[2]),
      Math.max(previous[3], box[3]),
    ];
  }
  return merged;
}

/**
 * The boxes a mark paints: one quad per line for the text kinds, and `rect` for the
 * kinds that carry a single box (shapes, notes, and anything an importer rebuilt
 * from a `/Rect` alone).
 */
function markBoxes(mark: AnnotationMark): readonly MarkBox[] {
  if (mark.quads.length > 0) return mark.quads;
  return mark.rect === undefined ? [] : [mark.rect];
}

/** A stored `0 … 1` opacity, as CSS wants it. */
function cssOpacity(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function AnnotationLayer({
  t,
  tool,
  viewer,
  marks,
  onCreate,
  onDone,
  onRegion,
  color,
  opacity,
  thickness,
  author,
  shape = 'square',
  textColor = '#000000',
  fontSize = FREETEXT_DEFAULT_SIZE,
}: AnnotationLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  /** The text box being typed, and its field: one at a time, committed on blur. */
  const [draft, setDraft] = useState<TextDraft | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /**
   * The click a press that produced a mark owns, when that press landed on a link:
   * navigation is the *click's* default action, so canceling the pointerdown does
   * not cancel it. Component state rather than effect state because creating a mark
   * re-renders the shell, and an effect-scoped listener would be gone before the
   * click arrives.
   */
  const [click] = useState(clickSuppression);
  /** The ink stroke being drawn: one flat `[x, y, …]` list, the format the mark carries. */
  const [live, setLive] = useState<{ readonly pageIndex: number; readonly points: readonly number[] } | null>(
    null,
  );
  const [preview, setPreview] = useState<{ readonly pageIndex: number; readonly rect: MarkBox } | null>(null);
  // Parent renders (including scroll/history completion) may replace callbacks,
  // but must not cancel an in-flight stroke. Only tool/geometry changes do that.
  const callbacks = useRef({ onCreate, onDone, onRegion });
  useEffect(() => {
    callbacks.current = { onCreate, onDone, onRegion };
  });

  // Mount lifetime, not armed-session lifetime: see `click` above.
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (!click.consume()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, [click]);

  const finishMark = useCallback(
    (kind: AnnotationKind, pageIndex: number, boxes: readonly MarkBox[], extra?: Partial<AnnotationMark>) => {
      const now = new Date().toISOString();
      callbacks.current.onCreate({
        id: crypto.randomUUID(),
        kind,
        pageIndex,
        quads: boxes,
        color,
        opacity,
        contents: '',
        author,
        createdAt: now,
        thickness,
        ...extra,
      });
      // Pen and marker remain armed for the next stroke, as their native predecessors did.
      if (kind !== 'ink' && kind !== 'highlight') callbacks.current.onDone?.();
    },
    [author, color, opacity, thickness],
  );

  useEffect(() => {
    // Nothing of ours to listen for: no tool is armed.
    if (tool === null) return;
    const layer = layerRef.current;

    const resetGesture = (): void => {
      dragRef.current = null;
      setLive(null);
      setPreview(null);
    };

    /**
     * The text tools fire on release: the browser has finished the selection by
     * then, and the measured boxes are the ones the user can see. A selection made
     * earlier must not be re-committed, so only a release whose own press started
     * on a page counts.
     */
    const commitSelection = (kind: AnnotationKind): void => {
      const selections = selectionBoxes(viewer);
      if (selections.length === 0) return;
      for (const selection of selections) finishMark(kind, selection.pageIndex, selection.boxes);
      window.getSelection()?.removeAllRanges();
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || dragRef.current !== null) return;
      const point = viewer.pointToPage(event.clientX, event.clientY);
      if (point === null) return;
      // A link is not protected — a mark has to be drawable over one — but a press
      // that produces a mark consumes the click, so the link does not also open.
      const owner = pageGestureAt(event.clientX, event.clientY);
      if (!owner.available) return;
      click.reset();

      // The text tools must not take the pointer: the browser's own selection is what
      // measures the text they mark. `highlight` is the one of the four that can also be
      // drawn **freehand** — over a scan, or any page area with no text to select — so
      // its press starts sampling instead of returning, and its release decides between
      // the two: the selection when the browser made one, the stroke when it did not.
      if (isTextTool(tool) && tool !== 'highlight') return;
      if (!isTextTool(tool)) {
        releaseFocusHolder();
        event.preventDefault();
      }
      const stroke = tool === 'ink' || tool === 'highlight';

      if (tool === 'freetext') {
        // A press inside the open box is the box's own (a protected target, filtered
        // above); a press anywhere else first blurs it, which commits it. The next box
        // starts only once the current one is gone.
        if (draftRef.current !== null) {
          // The press was cancelled above, so the browser will not move focus: the
          // box is committed here, by the same blur a click elsewhere would cause.
          draftRef.current.blur();
          return;
        }
        const frame = markPageFrameOf(viewer, point.pageIndex);
        const screen = frame?.toScreen({ x: point.x, y: point.y });
        const room =
          frame === null || screen === undefined
            ? TEXT_BOX_WIDTH
            : (frame.left + frame.width - screen.x) / frame.scale;
        setDraft({
          pageIndex: point.pageIndex,
          x: point.x,
          y: point.y,
          width: Math.max(Math.min(TEXT_BOX_WIDTH, room), 40),
        });
        if (owner.onLink) click.suppress();
        return;
      }

      if (tool === 'note') {
        const geometry = viewer.pageGeometry(point.pageIndex);
        const box: MarkBox =
          geometry === null
            ? [point.x, point.y, point.x + NOTE_SIZE, point.y + NOTE_SIZE]
            : [
                Math.min(
                  Math.max(point.x - NOTE_SIZE / 2, geometry.x),
                  geometry.x + geometry.width - NOTE_SIZE,
                ),
                Math.min(Math.max(point.y - NOTE_SIZE / 2, 0), geometry.height - NOTE_SIZE),
                Math.min(
                  Math.max(point.x + NOTE_SIZE / 2, geometry.x + NOTE_SIZE),
                  geometry.x + geometry.width,
                ),
                Math.min(Math.max(point.y + NOTE_SIZE / 2, NOTE_SIZE), geometry.height),
              ];
        finishMark('note', point.pageIndex, [], { rect: box });
        if (owner.onLink) click.suppress();
        return;
      }

      try {
        if (!isTextTool(tool)) layer?.setPointerCapture(event.pointerId);
      } catch {
        // Capture only keeps a drag that leaves the window; the window listeners
        // deliver the rest of the gesture either way.
      }
      dragRef.current = {
        pointerId: event.pointerId,
        pageIndex: point.pageIndex,
        startX: point.x,
        startY: point.y,
        onLink: owner.onLink,
        currentX: point.x,
        currentY: point.y,
        points: stroke ? [point.x, point.y] : null,
      };
      setLive(stroke ? { pageIndex: point.pageIndex, points: [point.x, point.y] } : null);
      // A stroke draws itself; only the rectangle tools show a rectangle while dragging.
      setPreview(stroke ? null : { pageIndex: point.pageIndex, rect: [point.x, point.y, point.x, point.y] });
    };

    const onPointerMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const point = viewer.pointToPage(event.clientX, event.clientY);
      if (point === null || point.pageIndex !== drag.pageIndex) return;
      drag.currentX = point.x;
      drag.currentY = point.y;

      const points = drag.points;
      if (points !== null) {
        points.push(point.x, point.y);
        setLive({ pageIndex: drag.pageIndex, points: [...points] });
        return;
      }
      setPreview({
        pageIndex: drag.pageIndex,
        rect: [
          Math.min(drag.startX, point.x),
          Math.min(drag.startY, point.y),
          Math.max(drag.startX, point.x),
          Math.max(drag.startY, point.y),
        ],
      });
    };

    const onPointerUp = (event: PointerEvent): void => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) {
        if (isTextTool(tool) && pageGestureAt(event.clientX, event.clientY).available) commitSelection(tool);
        return;
      }
      dragRef.current = null;
      const points = drag.points;
      setLive(null);
      setPreview(null);

      if (points !== null) {
        // A selection the browser made is the better answer for a text mark — and a
        // press that never moved can still have made one (a double click selects a
        // word) — so it is measured first. The stroke is the fallback that keeps the
        // marker working where there is no text to select at all: a scan, an image, a
        // blank area.
        const selections = isTextTool(tool) ? selectionBoxes(viewer) : [];
        if (selections.length > 0 && isTextTool(tool)) {
          for (const selection of selections) finishMark(tool, selection.pageIndex, selection.boxes);
          window.getSelection()?.removeAllRanges();
          if (drag.onLink) click.suppress();
          return;
        }
        if (points.length < 4) return; // a dot is not a stroke
        // The stroke's own bounding box, in the same space the writer converts.
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (let index = 0; index + 1 < points.length; index += 2) {
          const x = points[index] ?? 0;
          const y = points[index + 1] ?? 0;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
        // One stroke, **flat**: `strokes` is a list of strokes, each a flat
        // `[x, y, …]` run. The old gesture pushed one two-number array per point and
        // the writer read every one as a separate single-point stroke, so a continuous
        // pen stroke reached the screen and the file as a trail of dots — the bug this
        // branch exists to keep closed. The bbox quad is the mark's fallback geometry
        // for every consumer that reads quads alone (a `highlight` is a `/Highlight`
        // with an `/InkList`, `annotation-shapes.ts`).
        const strokeKind = tool === 'highlight' ? 'highlight' : 'ink';
        finishMark(strokeKind, drag.pageIndex, [[minX, minY, maxX, maxY]], { strokes: [[...points]] });
        if (drag.onLink) click.suppress();
        return;
      }

      const rect: MarkBox = [
        Math.min(drag.startX, drag.currentX),
        Math.min(drag.startY, drag.currentY),
        Math.max(drag.startX, drag.currentX),
        Math.max(drag.startY, drag.currentY),
      ];
      const [x0, y0, x1, y1] = rect;
      if (Math.abs(x1 - x0) < MIN_MARK_POINTS || Math.abs(y1 - y0) < MIN_MARK_POINTS) return;
      if (tool === 'link') {
        // The rectangle is the whole gesture; what it links to is the shell's dialog.
        callbacks.current.onRegion?.({ pageIndex: drag.pageIndex, rect });
        callbacks.current.onDone?.();
        if (drag.onLink) click.suppress();
        return;
      }
      // A line is a line, not a box: the file draws it corner to corner
      // (`annotation-shapes.ts` `lineEndpoints`), so the mark carries that same
      // diagonal as a stroke — the hit test then tests the visible line instead of
      // the whole rectangle around it. The writer ignores `strokes` for shapes.
      finishMark(
        tool,
        drag.pageIndex,
        [rect],
        tool === 'shapes' ? { shape, ...(shape === 'line' ? { strokes: [[...rect]] } : {}) } : {},
      );
      if (drag.onLink) click.suppress();
    };

    const cancel = (event: PointerEvent): void => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      resetGesture();
    };

    /**
     * The window lost focus mid-drag, so the pointerup is never coming: the partial
     * mark is discarded rather than left to be committed by the next click. An
     * element's own `blur` does not bubble, so this is only the window's.
     */
    const onBlur = (): void => {
      resetGesture();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', onBlur);
      resetGesture();
    };
  }, [click, finishMark, shape, tool, viewer]);

  // Disarming the tool drops a box nobody committed.
  useEffect(() => {
    if (tool !== 'freetext') setDraft(null);
  }, [tool]);

  /**
   * Text selected **before** a text-markup tool was armed — from the context menu, the
   * menu bar, the palette or the rail — is marked at once. The tool used to wait for a
   * new selection, so "select, right-click, Highlight" armed the tool and marked nothing.
   * Read through refs: this runs on arming only, not on every style change.
   */
  const armingRef = useRef({ viewer, finishMark });
  armingRef.current = { viewer, finishMark };
  useEffect(() => {
    if (!isTextTool(tool)) return;
    const { viewer: current, finishMark: finish } = armingRef.current;
    const selections = selectionBoxes(current);
    if (selections.length === 0) return;
    for (const selection of selections) finish(tool, selection.pageIndex, selection.boxes);
    window.getSelection()?.removeAllRanges();
  }, [tool]);

  /**
   * Commit the typed box: an empty one is no mark at all. The rectangle keeps the
   * corner the user clicked and the width it offered; its height is what the text
   * measured, which is also what the writer's own layout arrives at.
   */
  const commitDraft = useCallback(
    (field: HTMLTextAreaElement | null) => {
      const current = draft;
      setDraft(null);
      if (current === null || field === null) return;
      const text = field.value.replace(/\s+$/u, '');
      if (text.trim() === '') return;
      const frame = markPageFrameOf(viewer, current.pageIndex);
      if (frame === null) return;
      const size = Math.min(Math.max(fontSize, 1), 200);
      const lines = Math.max(
        1,
        Math.round((field.scrollHeight / frame.scale - 2 * FREETEXT_PADDING) / (size * FREETEXT_LINE_HEIGHT)),
      );
      const height = lines * size * FREETEXT_LINE_HEIGHT + 2 * FREETEXT_PADDING;
      // The box the reader typed into is upright on screen. On a page with its own
      // `/Rotate` that is a *turned* box in page space, so the mark stores the box
      // unturned about the same centre and carries the counter-turn as its own
      // rotation — the writer turns geometry and appearance together
      // (`annotation-transform.ts`), and the file then shows the text the way it was typed.
      const corner = frame.toScreen({ x: current.x, y: current.y });
      const centre = frame.toPage(
        corner.x + (current.width * frame.scale) / 2,
        corner.y + (height * frame.scale) / 2,
      );
      const turn = ((360 - frame.geometry.rotation) % 360) as 0 | 90 | 180 | 270;
      finishMark('freetext', current.pageIndex, [], {
        rect: [
          centre.x - current.width / 2,
          centre.y - height / 2,
          centre.x + current.width / 2,
          centre.y + height / 2,
        ],
        contents: text,
        color: textColor,
        opacity: 1,
        fontSize: size,
        ...(turn === 0 ? {} : { rotation: turn }),
      });
    },
    [draft, finishMark, fontSize, textColor, viewer],
  );

  // One frame lookup per page per render: three marks on a page are measured once.
  const frames = new Map<number, MarkPageFrame | null>();
  const frameFor = (pageIndex: number): MarkPageFrame | null => {
    const cached = frames.get(pageIndex);
    if (cached !== undefined) return cached;
    const frame = markPageFrameOf(viewer, pageIndex);
    frames.set(pageIndex, frame);
    return frame;
  };

  const renderMark = (mark: AnnotationMark): React.ReactNode => {
    const frame = frameFor(mark.pageIndex);
    return frame === null ? null : markVisual(mark, frame);
  };

  /**
   * The stroke being drawn: ink's, or a freehand highlight's — the same path with the
   * mark's own blend. It is built once and placed in whichever root it belongs to, so a
   * marker drag is drawn *multiplied* while it happens and the words under it stay
   * readable during the gesture and not only after the release. Nothing else about the
   * two is different: the geometry is exactly what the committed mark will carry.
   */
  const liveStroke =
    live === null
      ? null
      : (() => {
          const frame = frameFor(live.pageIndex);
          if (frame === null) return null;
          return (
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute overflow-visible z-10"
              style={{
                left: 0,
                top: 0,
                width: 1,
                height: 1,
                mixBlendMode: tool === 'highlight' ? 'multiply' : undefined,
              }}
            >
              <polyline
                points={strokePath(live.points, frame, null)}
                fill="none"
                stroke={color}
                strokeOpacity={cssOpacity(opacity)}
                strokeWidth={Math.max(1, thickness * frame.scale)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          );
        })();

  return (
    <>
      {/*
        The blended half first, in a root **without a z-index**.

        `mix-blend-mode: multiply` blends with what is painted behind the element, and
        the group it can reach ends at the nearest isolated ancestor — which a
        positioned element with a `z-index` is, because a stacking context is an
        isolated group. A multiply inside the `z-20` root below would therefore blend
        against an empty backdrop: the tint would paint solid and hide the words it
        marks, which is exactly the bug. So a highlight lives here instead: above the
        page's own canvas by document order (this layer is mounted after the viewer),
        below every other mark and below the shell's chrome (`z-30` and up). Nothing in
        this root may set `opacity`, `transform`, `filter`, `isolation`, `will-change`
        or `contain: paint` — each of them would isolate it again and turn the tint
        back into a cover.
      */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {marks.filter((mark) => mark.kind === 'highlight').map(renderMark)}
        {/* A freehand marker drag is the same tint as the mark it will become. */}
        {tool === 'highlight' ? liveStroke : null}
      </div>

      <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
        {/* The armed tool's name, for assistive tech. It is a status, not a control:
            every binding stays in `useShortcuts.ts`. */}
        {tool === null ? null : (
          <p className="sr-only" aria-live="polite">
            {t(toolLabelKey(tool))}
          </p>
        )}

        {/* The review half: marks the session holds but the file does not yet. Each
            mark's visuals sit under one `data-ann` node, the identity consumers look
            marks up by. The highlights are the one family drawn in the root above. */}
        {marks.filter((mark) => mark.kind !== 'highlight').map(renderMark)}

        {draft === null
          ? null
          : (() => {
              const frame = frameFor(draft.pageIndex);
              if (frame === null) return null;
              // The field is upright on screen whatever the page's own turn: it is
              // placed at the clicked point in screen space, never rotated.
              const corner = frame.toScreen({ x: draft.x, y: draft.y });
              const placed = {
                left: corner.x,
                top: corner.y,
                width: draft.width * frame.scale,
                height: (fontSize * FREETEXT_LINE_HEIGHT + 2 * FREETEXT_PADDING) * frame.scale,
              };
              return (
                <textarea
                  ref={draftRef}
                  // The box exists to be typed into: focusing it on open is the point.
                  // biome-ignore lint/a11y/noAutofocus: the field was opened by this click
                  autoFocus
                  aria-label={t('ann.freetext.editor')}
                  placeholder={t('ann.freetext.placeholder')}
                  rows={1}
                  onInput={(event) => {
                    const field = event.currentTarget;
                    field.style.height = 'auto';
                    field.style.height = `${field.scrollHeight}px`;
                  }}
                  onBlur={(event) => commitDraft(event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      setDraft(null);
                      callbacks.current.onDone?.();
                    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                  className="pointer-events-auto absolute resize-none overflow-hidden border border-dashed border-kumo-focus bg-kumo-base/70 outline-none"
                  style={{
                    ...placed,
                    height: undefined,
                    minHeight: placed.height,
                    color: textColor,
                    fontFamily: TEXT_FACE,
                    fontSize: fontSize * frame.scale,
                    lineHeight: FREETEXT_LINE_HEIGHT,
                    padding: FREETEXT_PADDING * frame.scale,
                  }}
                />
              );
            })()}

        {/* Ink's live stroke, then the shapes' and the link's live rectangle. */}
        {tool === 'highlight' ? null : liveStroke}
        {preview !== null
          ? (() => {
              const frame = frameFor(preview.pageIndex);
              if (frame === null) return null;
              const placed = frame.toScreenBox(preview.rect);
              if (placed.width <= 4 && placed.height <= 4) return null;
              return (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute border border-kumo-focus"
                  style={{ ...placed, background: color, opacity: Math.min(cssOpacity(opacity), 0.35) }}
                />
              );
            })()
          : null}
      </div>
    </>
  );
}

/**
 * One mark's visuals in `frame`, under the single `data-ann` node consumers look it up
 * by. One function rather than JSX copies, because the layer's two roots and the page
 * thumbnails all draw from it and they have to agree on the geometry down to the pixel.
 * `identity` is off for a copy (a thumbnail): `data-ann` must name one node per mark.
 */
export function markVisual(mark: AnnotationMark, frame: MarkPageFrame, identity = true): React.ReactNode {
  const turn = markTurn(mark);
  // The centre every visual of this mark turns about: the projected `annotationBounds`
  // centre, which is the point the writer bakes its rotation around as well.
  const centre =
    turn === null
      ? null
      : frame.toScreen({
          x: (turn.bounds[0] + turn.bounds[2]) / 2,
          y: (turn.bounds[1] + turn.bounds[3]) / 2,
        });
  const kind = mark.kind;
  if (kind === 'freetext') {
    return (
      <div key={mark.id} className="contents" data-ann={identity ? mark.id : undefined}>
        {textVisual(mark, frame)}
      </div>
    );
  }
  return (
    <div key={mark.id} className="contents" data-ann={identity ? mark.id : undefined}>
      {kind === 'ink' || (kind === 'highlight' && (mark.strokes?.length ?? 0) > 0)
        ? (mark.strokes ?? []).map((strokePoints) => (
            <svg
              key={`${mark.id}:${strokePoints.join(',')}`}
              aria-hidden="true"
              className="pointer-events-none absolute overflow-visible z-10"
              style={{
                left: 0,
                top: 0,
                width: 1,
                height: 1,
                mixBlendMode: kind === 'highlight' ? 'multiply' : undefined,
              }}
            >
              <polyline
                points={strokePath(strokePoints, frame, turn)}
                fill="none"
                stroke={mark.color}
                strokeOpacity={cssOpacity(mark.opacity)}
                // Points are in page points → screen pixels; the stroke has to
                // scale with them, or a 2 pt line stays 2 px at 250 % zoom.
                strokeWidth={Math.max(1, (mark.thickness ?? 2) * frame.scale)}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ))
        : kind === 'shapes'
          ? shapeVisual(mark, frame, turn, centre)
          : markBoxes(mark).map((box) => (
              <span
                key={`${mark.id}:${box.join(',')}`}
                aria-hidden="true"
                className="pointer-events-none absolute z-10"
                style={markStyle(kind, mark, box, frame, turn, centre)}
              />
            ))}
    </div>
  );
}

/** The armed tool's own dictionary key; the link tool is the one kind that is not an annotation kind. */
function toolLabelKey(tool: AnnotationTool): MessageKey {
  if (tool === 'link') return 'link.tool';
  return annotationKindKey(tool);
}

/**
 * A mark's own rotation, as the writer stores and applies it: the turn is **clockwise
 * in a y-down space about the centre of the mark's own bounds**, and the stored
 * geometry stays unrotated (`pdf-core/ops/annotation-transform.ts`).
 *
 * The turn is carried as the core's own request against the core's own bounds, so the
 * overlay turns its points through `transformPoint` — the *same* function the writer
 * paints with and the hit tests measure with. One implementation of the turn, not
 * three that agree until one of them is edited.
 *
 * `null` for the marks that carry no turn — every mark the tools create, and every
 * mark stored before rotate existed — which keeps the common path a single comparison
 * and allocates nothing. A mark with a turn but no geometry is also `null`:
 * `annotationBounds` refuses to guess a centre for it.
 */
interface Turn {
  readonly bounds: MarkBox;
  readonly transform: MarkTransform;
}

function markTurn(mark: AnnotationMark): Turn | null {
  const rotation = mark.rotation ?? 0;
  if (rotation === 0) return null;
  if (mark.rect === undefined && mark.quads.length === 0 && (mark.strokes?.length ?? 0) === 0) return null;
  return { bounds: annotationBounds(mark), transform: { dx: 0, dy: 0, rotation } };
}

/**
 * A mark's turn, as a CSS transform **about the mark's own centre**: the visual turns
 * where it is, instead of being re-drawn into the turned bounding box.
 *
 * That difference is the whole point for the directional marks. An underline is a bar
 * *under* its line, a strikeout crosses the middle of it and a squiggle runs along the
 * baseline, so painting them into the axis-aligned box of a turned mark left them lying
 * flat under turned text; a note's box and a diagonal `/Line` have to turn with the
 * geometry too. For a quarter turn the turned rectangle and the axis-aligned one cover
 * the same pixels, so nothing here is an approximation of the file's own appearance —
 * it is the same rotation the writer bakes, about the same centre.
 *
 * `offsetTop` is the visual's own top edge against the box it was placed in — the
 * highlight and the note *are* their box, a bar sits below or inside it — because the
 * origin is measured from the element's own border box.
 */
function turnVisual(
  placed: { readonly left: number; readonly top: number },
  offsetTop: number,
  centre: { readonly x: number; readonly y: number } | null,
  turn: Turn | null,
): React.CSSProperties {
  if (turn === null || centre === null) return {};
  return {
    transform: `rotate(${turn.transform.rotation}deg)`,
    transformOrigin: `${centre.x - placed.left}px ${centre.y - (placed.top + offsetTop)}px`,
  };
}

/** A shape in the page's own pixels: a bordered box, a circle, or the file's own diagonal. */
function shapeVisual(
  mark: AnnotationMark,
  frame: MarkPageFrame,
  turn: Turn | null,
  centre: { readonly x: number; readonly y: number } | null,
): React.ReactNode {
  const stored = mark.rect ?? mark.quads[0];
  if (stored === undefined) return null;
  const placed = frame.toScreenBox(stored);
  const stroke = Math.max(1, (mark.thickness ?? 2) * frame.scale);
  const opacity = cssOpacity(mark.opacity);

  if (mark.shape === 'line') {
    // `/Line` is written from the stored rect's first corner to its last
    // (`annotation-shapes.ts` `lineEndpoints`), so the overlay draws that same
    // diagonal — a box around it would show a line the file does not contain. Both
    // corners are turned before the projection, so a rotated line keeps its own ends
    // rather than the corners of the turned bounding box.
    const from = { x: stored[0], y: stored[1] };
    const to = { x: stored[2], y: stored[3] };
    const first = frame.toScreen(turn === null ? from : transformPoint(from, turn.bounds, turn.transform));
    const second = frame.toScreen(turn === null ? to : transformPoint(to, turn.bounds, turn.transform));
    return (
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute overflow-visible z-10"
        style={{ left: 0, top: 0, width: 1, height: 1 }}
      >
        <line
          x1={first.x}
          y1={first.y}
          x2={second.x}
          y2={second.y}
          stroke={mark.color}
          strokeOpacity={opacity}
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute z-10"
      style={{
        left: placed.left,
        top: placed.top,
        width: placed.width,
        height: placed.height,
        border: `${stroke}px solid ${mark.color}`,
        opacity,
        ...(mark.shape === 'circle' ? { borderRadius: '50%' } : {}),
        // A box or a circle is its own centre's shape, so it turns about the mark's.
        ...turnVisual(placed, 0, centre, turn),
      }}
    />
  );
}

/**
 * Page points → container pixels for one box of a text mark, in the mark's own colour.
 *
 * The box is projected **unrotated** and the element then turns about the mark's centre
 * (`turnVisual`), which is what keeps an underline under its line and a strikeout
 * through it after a rotation; the highlight multiplies (see the header), so the glyphs
 * stay readable under it at any opacity, which a solid fill never did.
 */
function markStyle(
  kind: MarkupKind,
  mark: AnnotationMark,
  box: MarkBox,
  frame: MarkPageFrame,
  turn: Turn | null,
  centre: { readonly x: number; readonly y: number } | null,
): React.CSSProperties {
  const { left, top, width, height } = frame.toScreenBox(box);
  const base = { left, top, width, height } as const;
  const opacity = cssOpacity(mark.opacity);
  const bar = Math.max(1, (mark.thickness ?? 1.5) * frame.scale);
  switch (kind) {
    case 'highlight':
      // The file's own blend mode for `/Highlight`. `multiply` over the page's dark
      // glyphs leaves them dark, over white leaves the tint, and two overlapping
      // highlights multiply the way two `/Highlight` annotations do.
      return {
        ...base,
        background: mark.color,
        opacity,
        mixBlendMode: 'multiply',
        ...turnVisual(base, 0, centre, turn),
      };
    case 'underline':
      return {
        ...base,
        height: bar,
        marginTop: height,
        background: mark.color,
        opacity: Math.max(opacity, 0.6),
        ...turnVisual(base, height, centre, turn),
      };
    case 'strikeout':
      return {
        ...base,
        height: bar,
        marginTop: height / 2,
        background: mark.color,
        opacity: Math.max(opacity, 0.6),
        ...turnVisual(base, height / 2, centre, turn),
      };
    case 'squiggly':
      return {
        ...base,
        height: bar * 1.5,
        marginTop: height,
        background: `repeating-linear-gradient(90deg, ${mark.color} 0 3px, transparent 3px 6px)`,
        opacity: Math.max(opacity, 0.8),
        ...turnVisual(base, height, centre, turn),
      };
    case 'note':
      // A note is a place on the page with a comment attached, so it is drawn as a
      // filled mark even at a low opacity: an invisible note is an unfindable one.
      return {
        ...base,
        background: mark.color,
        border: `1px solid ${mark.color}`,
        opacity: Math.max(opacity, 0.35),
        ...turnVisual(base, 0, centre, turn),
      };
  }
}

/**
 * A text box's unrotated placement: its own width and height in pixels, centred where
 * the page's projection puts the box. The page's `/Rotate` (and the mark's own turn)
 * then rotate the element about that centre, the way pdf.js draws the file's
 * appearance on a rotated page.
 */
function textBoxPlacement(
  frame: MarkPageFrame,
  box: MarkBox,
  extraTurn = 0,
): { left: number; top: number; width: number; height: number; transform?: string } {
  const projected = frame.toScreenBox(box);
  const width = Math.abs(box[2] - box[0]) * frame.scale;
  const height = Math.abs(box[3] - box[1]) * frame.scale;
  const centreX = projected.left + projected.width / 2;
  const centreY = projected.top + projected.height / 2;
  const turn = (frame.geometry.rotation + extraTurn) % 360;
  return {
    left: centreX - width / 2,
    top: centreY - height / 2,
    width,
    height,
    ...(turn === 0 ? {} : { transform: `rotate(${turn}deg)` }),
  };
}

/** Typed text as the page will show it: the writer's face, size, pitch and padding. */
function textVisual(mark: AnnotationMark, frame: MarkPageFrame): React.ReactNode {
  const box = mark.rect ?? mark.quads[0];
  if (box === undefined) return null;
  const size = freeTextSize(mark);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 overflow-hidden whitespace-pre-wrap break-words"
      style={{
        ...textBoxPlacement(frame, box, mark.rotation ?? 0),
        color: mark.color,
        opacity: cssOpacity(mark.opacity),
        fontFamily: TEXT_FACE,
        fontSize: size * frame.scale,
        lineHeight: FREETEXT_LINE_HEIGHT,
        padding: FREETEXT_PADDING * frame.scale,
      }}
    >
      {mark.contents}
    </div>
  );
}

/** A flat stroke's points, in container pixels, with the mark's own rotation applied. */
function strokePath(points: readonly number[], frame: MarkPageFrame, turn: Turn | null): string {
  const path: string[] = [];
  for (let index = 0; index + 1 < points.length; index += 2) {
    const point = { x: points[index] ?? 0, y: points[index + 1] ?? 0 };
    const placed = frame.toScreen(turn === null ? point : transformPoint(point, turn.bounds, turn.transform));
    path.push(`${placed.x},${placed.y}`);
  }
  return path.join(' ');
}
