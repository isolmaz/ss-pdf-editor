/**
 * The common mark surface: selection, the marquee and the move, for every family
 * of mark the session can hold (`PLAN.md §5/Phase 3`, contract
 * `local://selection-edit-contract.txt`).
 *
 * It exists because there used to be three partial answers to "delete a mark".
 * `AnnotationLayer` hit-tested only its own session marks, from a hardcoded 8-point
 * pad, with a per-mark button that the layer's own gesture overlay shadowed in the
 * DOM; `MeasureLayer` accepted `selectedId`/`onSelect` that nothing ever passed;
 * redaction marks were drawn nowhere at all, so an intent to erase a page area was
 * invisible until it was applied. One layer, one hit test, one selection — and the
 * document itself is never touched here: the shell owns the write, its journal and
 * its undo.
 *
 * ## One pointer owner, and the browser keeps the rest
 *
 * The layer never covers the page: its root is `pointer-events-none`, and it
 * listens on `window` instead of putting an intercepting `<div>` over the canvas.
 * That is what keeps pdf.js's own text selection and the form widgets alive —
 * a full-canvas listener makes every drag a marquee and every form field
 * unclickable, which is the failure mode this design exists to avoid. A gesture
 * starts only when
 *
 *  - the pointer is over a page (`pointToPage` answers), and
 *  - it is not over a form control, a pdf.js widget or another protected control
 *    (`PROTECTED_TARGETS` in `mark-interaction.ts`), which is what keeps a drag
 *    inside the property strip, a dialog or a panel out of the marks' hands, and
 *  - **in select mode** the browser reports no text there — neither a caret
 *    inside a run's own text nor a press inside a text-layer run's box
 *    (`caretPositionFromPoint`/`caretRangeFromPoint`, then the run under the
 *    point): text is the text layer's, and a drag across words — or across the
 *    leading at the top or bottom of one — must still select words, not draw a
 *    rubber band.
 *
 * Mark hits are the one exception: clicking a mark selects it and suppresses the
 * text selection underneath, because the user aimed at the mark. A press the layer
 * consumes also releases the property or form input that was focused, because
 * `preventDefault` is exactly what stops the browser moving focus to the page — and
 * an input still holding the keyboard turns the next Ctrl+Z into its own undo.
 *
 * A **link** is reported by that guard rather than refused. A persisted `/Link` is a
 * mark like any other and the common select has to reach it, so the press is
 * consumed when it actually handles one — a target under the pointer — and that
 * consumption cancels the click's own navigation (`clickSuppression` in
 * `mark-interaction.ts`), because navigation is the *click's* default action and
 * survives the pointerdown a tool cancels. A link nobody handled, and every link
 * while no mark tool is armed, navigates exactly as it did before.
 *
 * ## Gestures are atomic
 *
 * A marquee collects every target its rectangle overlaps and emits **one**
 * `onSelectionChange` at pointer-up, with the press's own modifier merging into
 * what was selected. A drag on a mark carries **the whole selection**, previews
 * itself as dashed outlines in the page's own projection, and commits as one
 * `onMove` at pointer-up with the pointer's travel in page points; `pointercancel`,
 * `lostpointercapture` and a window blur discard it without touching anything.
 *
 * Keyboard stays where it was: `useShortcuts.ts` owns every binding, and this
 * layer registers no key listener of its own.
 */

import { useEffect, useRef, useState } from 'react';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import {
  clickSuppression,
  hitTargets,
  type MarkArea,
  type MarkPageFrame,
  type MarkPoint,
  type MarkRect,
  type MarkTarget,
  markPageFrameOf,
  marqueeTargets,
  pageGestureAt,
  releaseFocusHolder,
  targetBounds,
} from './mark-interaction';

/** The one interaction this surface arms. `null` renders the selection and takes no pointer. */
export type MarkInteractionMode = 'select';

export interface MarkInteractionLayerProps {
  readonly viewer: ViewerApi;
  /** The armed interaction; `null` renders the marks' selection only, and takes no pointer. */
  readonly mode: MarkInteractionMode | null;
  /** Every family's marks, in paint order. */
  readonly targets: readonly MarkTarget[];
  readonly selectedKeys: readonly string[];
  /** Suspends every listener; a gesture in flight is discarded. */
  readonly disabled?: boolean;
  readonly onSelectionChange: (keys: readonly string[]) => void;
  /**
   * One call per completed drag, with every key that moved and the distance the
   * pointer carried it, in page points (the space the core transforms in). Absent
   * means a press selects and never drags, so a read-only surface offers no drag it
   * could not commit.
   */
  readonly onMove?: (keys: readonly string[], dx: number, dy: number) => void;
}

/** A click's own slop, in screen pixels: turned into page points by the page's scale. */
const CLICK_SLOP_PX = 4;
/**
 * The movement that turns a press into a drag rather than a click: a marquee on
 * blank page, a move on a mark. Below it the press is a click — a mark selects, an
 * empty press clears — so a shaky hand never moves a mark by a pixel.
 */
const DRAG_SLOP_PX = 3;
/** A page's own text run, as pdf.js writes it into `.textLayer`. */
const TEXT_RUN = '.textLayer span';
/**
 * A preview box: the outline of where the marks are being carried, never a fill —
 * it is a position, not a mark, and the paper under it has to stay readable.
 */
const PREVIEW_BOX_CLASS = 'absolute border border-dashed border-pdf-accent/70';

/**
 * `caretPositionFromPoint` is the standard (`Document.caretPositionFromPoint`);
 * Chromium shipped `caretRangeFromPoint` long before it. Either one answers the
 * question that matters: would the browser start selecting text here?
 *
 * They answer it in two shapes, and only the first is a text node. A press **on the
 * glyphs** resolves inside a text node — a caret however it is read, in a page's
 * text layer or in a rendered note. A press in the **leading of the same run** — a
 * pdf.js span is taller than the glyphs it holds, so the top and bottom of its own
 * box are leading, not blank — resolves to the *span*, and a press in the gap
 * between two runs resolves to the layer's own box. The first is still the text's:
 * it is where the browser anchors a selection and drags it across the words, so the
 * run's own box decides. The second is blank page, and blank page is the marquee's.
 */
function hasNativeCaret(x: number, y: number): boolean {
  // The DOM types declare both; old engines ship neither, and Chromium grew
  // `caretRangeFromPoint` long before it grew the standard `caretPositionFromPoint`.
  const caret =
    typeof document.caretPositionFromPoint === 'function' ? document.caretPositionFromPoint(x, y) : null;
  const range =
    caret === null && typeof document.caretRangeFromPoint === 'function'
      ? document.caretRangeFromPoint(x, y)
      : null;
  const container = caret?.offsetNode ?? range?.startContainer ?? null;
  if (
    container !== null &&
    container.nodeType === Node.TEXT_NODE &&
    (container.textContent ?? '').trim() !== ''
  ) {
    // Caret APIs also return the nearest text node for blank space between lines.
    // Reserve only the run's actual painted box; otherwise a marquee cannot start there.
    const run = container.parentElement?.closest(TEXT_RUN);
    if (run !== null && run !== undefined) {
      const bounds = run.getBoundingClientRect();
      return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
    }
  }
  // The caret's *element* (the leading of a run, or the layer's own box between
  // runs) and, on old engines, no caret at all: only a run's own box is text.
  const element = document.elementFromPoint(x, y);
  const run = element === null ? null : element.closest(TEXT_RUN);
  return run !== null && (run.textContent ?? '').trim() !== '';
}

interface MarqueeGesture {
  readonly kind: 'marquee';
  readonly pointerId: number;
  readonly additive: boolean;
  /**
   * The press, in **content** pixels (client minus the scrolled content's origin), so a
   * wheel scroll during the drag keeps the anchored corner on the page it was pressed on.
   */
  readonly originX: number;
  readonly originY: number;
  /** The pointer, in client pixels; re-based on the content origin whenever it is read. */
  clientX: number;
  clientY: number;
}

/** One moving mark: the page-space box to preview and the frame it projects through. */
interface MoveBox {
  readonly frame: MarkPageFrame;
  readonly bounds: MarkRect;
}

interface MoveGesture {
  readonly kind: 'move';
  readonly pointerId: number;
  /** Every key the drag carries: the whole selection, not just the mark under the pointer. */
  readonly keys: readonly string[];
  readonly moving: readonly MoveBox[];
  /**
   * The page the drag is anchored to: its frame turns the pointer's pixels into the
   * page points the commit is measured in, at every rotation.
   */
  readonly anchor: MarkPageFrame;
  /** The press point, in the anchor frame's page space. */
  readonly origin: MarkPoint;
  /** The press point in client pixels: what the drag threshold is measured against. */
  readonly clientX: number;
  readonly clientY: number;
  dx: number;
  dy: number;
  /** Cleared until the pointer passes the threshold: a press that never moved is a click. */
  started: boolean;
}

type Gesture = MarqueeGesture | MoveGesture;

/** What the handler closures read, so a listener registered once never goes stale. */
interface LatestMarkProps {
  readonly viewer: ViewerApi;
  readonly targets: readonly MarkTarget[];
  readonly selectedKeys: readonly string[];
  readonly mode: MarkInteractionMode | null;
  readonly onSelectionChange: (keys: readonly string[]) => void;
  readonly onMove?: ((keys: readonly string[], dx: number, dy: number) => void) | undefined;
}

/**
 * A drag's distance is the inverse projection of the pointer's own travel, so it
 * arrives with float noise (`12.000000000000002`). A thousandth of a point is far
 * below anything a page can show, and the writer would otherwise stamp the noise
 * into the `/Rect` it translates.
 */
function pagePoints(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function MarkInteractionLayer({
  viewer,
  mode,
  targets,
  selectedKeys,
  disabled = false,
  onSelectionChange,
  onMove,
}: MarkInteractionLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const marqueeRef = useRef<HTMLSpanElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  /**
   * The click a handled press on a link owns. It is component state rather than
   * effect state on purpose: moving a persisted link makes the shell busy, which
   * disables or unmounts — and unmounting would take a listener registered inside
   * the gesture effect with it, letting the very click we consumed navigate.
   */
  const [click] = useState(clickSuppression);

  const latest = useRef<LatestMarkProps>({
    viewer,
    targets,
    selectedKeys,
    mode,
    onSelectionChange,
    onMove,
  });
  useEffect(() => {
    latest.current = { viewer, targets, selectedKeys, mode, onSelectionChange, onMove };
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

  /**
   * The move preview outlives its gesture by exactly one render. A commit reaches
   * the marks asynchronously — the shell journals it, and a persisted mark's write
   * takes longer still — so the dashed outlines stand until the geometry they
   * preview arrives, and are cleared the moment it does. Clearing them at the drop
   * would flash the marks back where they started; a live drag keeps them, because
   * the pointer owns the preview until it lets go.
   *
   * No dependency array, on purpose: a render **is** the event here (the shell draws
   * new geometry, re-arms the tool, or disables the layer), and every one of them
   * retires a preview standing on its own.
   */
  useEffect(() => {
    if (gestureRef.current?.kind === 'move') return;
    previewRef.current?.replaceChildren();
  });

  useEffect(() => {
    if (mode === null || disabled) return;
    const layer = layerRef.current;
    const marqueeNode = marqueeRef.current;
    const previewNode = previewRef.current;

    if (marqueeNode !== null) marqueeNode.style.display = 'none';

    /** A click's slop in page points, so the same 4 px of forgiveness works at every zoom. */
    const clickSlop = (pageIndex: number): number => {
      const frame = markPageFrameOf(latest.current.viewer, pageIndex);
      return frame === null ? CLICK_SLOP_PX : CLICK_SLOP_PX / frame.scale;
    };

    /** The marquee's two corners in content pixels, the frame the overlay draws in. */
    const marqueeBox = (gesture: MarqueeGesture) => {
      const container = latest.current.viewer.containerRect();
      const x = gesture.clientX - container.x;
      const y = gesture.clientY - container.y;
      return {
        minX: Math.min(x, gesture.originX),
        minY: Math.min(y, gesture.originY),
        maxX: Math.max(x, gesture.originX),
        maxY: Math.max(y, gesture.originY),
      };
    };

    const paintMarquee = (gesture: MarqueeGesture): void => {
      if (marqueeNode === null) return;
      const box = marqueeBox(gesture);
      marqueeNode.style.display = 'block';
      marqueeNode.style.left = `${box.minX}px`;
      marqueeNode.style.top = `${box.minY}px`;
      marqueeNode.style.width = `${box.maxX - box.minX}px`;
      marqueeNode.style.height = `${box.maxY - box.minY}px`;
    };

    /**
     * The move's outline preview, one box per moving mark.
     *
     * The boxes are written straight into their own node rather than rendered: the
     * layer is mounted for the whole life of the document, `targets` is every mark
     * on every page, and a pointer move has to cost a style write and nothing else.
     * Children are reused across moves, so an element is created once per mark per
     * drag.
     */
    const paintMovePreview = (gesture: MoveGesture): void => {
      if (previewNode === null) return;
      const placed = gesture.moving.map((mark) =>
        mark.frame.toScreenBox([
          mark.bounds[0] + gesture.dx,
          mark.bounds[1] + gesture.dy,
          mark.bounds[2] + gesture.dx,
          mark.bounds[3] + gesture.dy,
        ]),
      );
      while (previewNode.childElementCount > placed.length) previewNode.lastElementChild?.remove();
      while (previewNode.childElementCount < placed.length) {
        const box = previewNode.appendChild(document.createElement('span'));
        box.className = PREVIEW_BOX_CLASS;
        box.setAttribute('aria-hidden', 'true');
        box.dataset.markMovePreview = '';
      }
      placed.forEach((box, index) => {
        const node = previewNode.children[index];
        if (!(node instanceof HTMLElement)) return;
        // A hairline mark still gets a box the user can see, straddling its geometry.
        node.style.left = `${box.left - 1}px`;
        node.style.top = `${box.top - 1}px`;
        node.style.width = `${Math.max(box.width, 2)}px`;
        node.style.height = `${Math.max(box.height, 2)}px`;
      });
    };

    /**
     * The marquee's own rectangles, one per page any target lives on.
     *
     * `MarkPageFrame.toPage` answers in content pixels — the frame `marqueeBox` returns.
     * Feeding it client pixels put every marquee a dock-width down and to the right of
     * the pointer, which selected marks the gesture never crossed and missed the ones
     * it did.
     */
    const marqueeAreas = (gesture: MarqueeGesture): readonly MarkArea[] => {
      const { viewer: currentViewer, targets: currentTargets } = latest.current;
      const { minX, minY, maxX, maxY } = marqueeBox(gesture);
      const areas: MarkArea[] = [];
      const seen = new Set<number>();
      for (const target of currentTargets) {
        if (seen.has(target.pageIndex)) continue;
        seen.add(target.pageIndex);
        const frame = markPageFrameOf(currentViewer, target.pageIndex);
        if (frame === null) continue;
        const first = frame.toPage(minX, minY);
        const second = frame.toPage(maxX, maxY);
        areas.push({ pageIndex: target.pageIndex, rect: [first.x, first.y, second.x, second.y] });
      }
      return areas;
    };

    /**
     * Everything a drag needs, measured once at the press: the frames of every page
     * the selection touches (a page's own `/Rotate` is its own) and the page-space
     * box of every mark that will move. A pointer move then only projects and writes.
     */
    const moveBoxes = (
      keys: readonly string[],
      currentTargets: readonly MarkTarget[],
    ): { readonly boxes: readonly MoveBox[]; readonly frames: Map<number, MarkPageFrame> } => {
      const frames = new Map<number, MarkPageFrame>();
      const boxes: MoveBox[] = [];
      for (const key of keys) {
        const target = currentTargets.find((candidate) => candidate.key === key);
        if (target === undefined) continue;
        let frame = frames.get(target.pageIndex);
        if (frame === undefined) {
          const measured = markPageFrameOf(latest.current.viewer, target.pageIndex);
          if (measured === null) continue;
          frames.set(target.pageIndex, measured);
          frame = measured;
        }
        const bounds = targetBounds(target);
        if (bounds === null) continue;
        boxes.push({ frame, bounds });
      }
      return { boxes, frames };
    };

    /** Abandon an unfinished gesture: a canceled drag moves nothing, not even part of it. */
    const abandonGesture = (): void => {
      if (gestureRef.current === null) return;
      gestureRef.current = null;
      if (marqueeNode !== null) marqueeNode.style.display = 'none';
      previewNode?.replaceChildren();
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 || gestureRef.current !== null) return;
      const {
        viewer: currentViewer,
        targets: currentTargets,
        selectedKeys: currentSelection,
      } = latest.current;
      const point = currentViewer.pointToPage(event.clientX, event.clientY);
      // The gutter between pages is not a page: nothing to select, nothing to clear.
      if (point === null) return;
      const owner = pageGestureAt(event.clientX, event.clientY);
      if (!owner.available) return;
      // A press this layer does not consume must leave the next click alone.
      click.reset();
      // A preview left standing by the previous drag is stale the moment a new one
      // starts; a commit that lands clears it on its own render.
      previewNode?.replaceChildren();
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;

      const hits = hitTargets(currentTargets, point, clickSlop(point.pageIndex));
      const hit = hits[hits.length - 1];
      if (hit !== undefined) {
        let keys: readonly string[];
        if (!additive) {
          // A press on a mark that is already selected keeps the selection as it is:
          // the drag that follows carries all of it, and collapsing to the mark
          // under the pointer first would silently drop the rest.
          keys = currentSelection.includes(hit.key) ? currentSelection : [hit.key];
        } else if (currentSelection.includes(hit.key)) {
          keys = currentSelection.filter((key) => key !== hit.key);
        } else {
          keys = [...currentSelection, hit.key];
        }
        if (keys !== currentSelection) latest.current.onSelectionChange(keys);
        // The click was aimed at the mark, so the text selection underneath it is stale.
        window.getSelection()?.removeAllRanges();
        event.preventDefault();
        releaseFocusHolder();
        // A link under the mark does not also navigate: this press was handled.
        if (owner.onLink) click.suppress();

        const { onMove: move } = latest.current;
        if (move === undefined || !keys.includes(hit.key)) return;
        const { boxes, frames } = moveBoxes(keys, currentTargets);
        const anchor = frames.get(point.pageIndex);
        if (anchor === undefined) return;
        const container = currentViewer.containerRect();
        gestureRef.current = {
          kind: 'move',
          pointerId: event.pointerId,
          keys,
          moving: boxes,
          anchor,
          origin: anchor.toPage(event.clientX - container.x, event.clientY - container.y),
          clientX: event.clientX,
          clientY: event.clientY,
          dx: 0,
          dy: 0,
          started: false,
        };
        try {
          layer?.setPointerCapture(event.pointerId);
        } catch {
          // Capture is a bonus (drags that leave the window); the window listeners
          // below deliver the gesture either way.
        }
        return;
      }

      // Text stays the text layer's: a drag across words selects words, and a link
      // nothing handled stays the link's.
      if (owner.onLink || hasNativeCaret(event.clientX, event.clientY)) return;

      const origin = currentViewer.containerRect();
      gestureRef.current = {
        kind: 'marquee',
        pointerId: event.pointerId,
        additive,
        originX: event.clientX - origin.x,
        originY: event.clientY - origin.y,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      event.preventDefault();
      releaseFocusHolder();
      try {
        layer?.setPointerCapture(event.pointerId);
      } catch {
        // As above: the gesture does not depend on capture.
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      const gesture = gestureRef.current;
      if (gesture === null || gesture.pointerId !== event.pointerId) return;

      if (gesture.kind === 'marquee') {
        gesture.clientX = event.clientX;
        gesture.clientY = event.clientY;
        paintMarquee(gesture);
        return;
      }

      if (!gesture.started) {
        const travel = Math.max(
          Math.abs(event.clientX - gesture.clientX),
          Math.abs(event.clientY - gesture.clientY),
        );
        if (travel < DRAG_SLOP_PX) return;
        gesture.started = true;
      }
      // Re-based on the content origin of this moment: a wheel scroll during the drag
      // moves the pages, and the anchor frame was measured in content pixels.
      const container = latest.current.viewer.containerRect();
      const point = gesture.anchor.toPage(event.clientX - container.x, event.clientY - container.y);
      gesture.dx = pagePoints(point.x - gesture.origin.x);
      gesture.dy = pagePoints(point.y - gesture.origin.y);
      paintMovePreview(gesture);
    };

    const onPointerUp = (event: PointerEvent): void => {
      const gesture = gestureRef.current;
      if (gesture === null || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;

      if (gesture.kind === 'move') {
        // One gesture, one intent: the whole selection moves as one journalled step.
        // A press that never passed the threshold committed nothing and stays a click.
        if (gesture.started && (gesture.dx !== 0 || gesture.dy !== 0)) {
          latest.current.onMove?.(gesture.keys, gesture.dx, gesture.dy);
        } else {
          previewNode?.replaceChildren();
        }
        return;
      }

      if (marqueeNode !== null) marqueeNode.style.display = 'none';
      const box = marqueeBox(gesture);
      const moved = Math.max(box.maxX - box.minX, box.maxY - box.minY) >= DRAG_SLOP_PX;
      if (!moved) {
        // An empty click clears, and a modifier-click keeps what was there.
        if (!gesture.additive) latest.current.onSelectionChange([]);
        return;
      }
      const hits = marqueeTargets(latest.current.targets, marqueeAreas(gesture)).map((hit) => hit.key);
      let keys: readonly string[];
      if (!gesture.additive) keys = hits;
      else {
        const merged = [...latest.current.selectedKeys];
        for (const key of hits) if (!merged.includes(key)) merged.push(key);
        keys = merged;
      }
      latest.current.onSelectionChange(keys);
    };

    const onPointerCancel = (event: PointerEvent): void => {
      if (gestureRef.current?.pointerId !== event.pointerId) return;
      abandonGesture();
    };
    const onLostPointerCapture = (): void => {
      abandonGesture();
    };

    /**
     * The window lost focus mid-gesture, so the pointerup is never coming: the
     * intent is discarded here rather than left to be committed by the next click.
     * An element's own `blur` does not bubble, so this is only the window's.
     */
    const onBlur = (): void => {
      abandonGesture();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('blur', onBlur);
    layer?.addEventListener('lostpointercapture', onLostPointerCapture);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('blur', onBlur);
      layer?.removeEventListener('lostpointercapture', onLostPointerCapture);
      abandonGesture();
    };
  }, [click, disabled, mode]);

  // One frame lookup per page per render: a page with three marks on it is
  // measured once, not three times.
  const frames = new Map<number, MarkPageFrame | null>();
  const frameFor = (pageIndex: number): MarkPageFrame | null => {
    const cached = frames.get(pageIndex);
    if (cached !== undefined) return cached;
    const frame = markPageFrameOf(viewer, pageIndex);
    frames.set(pageIndex, frame);
    return frame;
  };
  const selection = new Set(selectedKeys);

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {/* Redaction intents are drawn whenever they exist, tools or no tools: the
          mark *is* the area that will be erased, and until now nothing on the page
          showed it — only a panel row did. Seeing the mark is what makes marking
          destructive-later-but-visible-now honest; applying it stays a separate,
          explicit step. */}
      {targets
        .filter((target) => target.family === 'redaction')
        .flatMap((target) => {
          const frame = frameFor(target.pageIndex);
          if (frame === null) return [];
          return target.boxes.map((box) => {
            const placed = frame.toScreenBox(box);
            if (placed.width <= 0 && placed.height <= 0) return null;
            return (
              <span
                key={`${target.key}:${box.join(',')}`}
                aria-hidden="true"
                data-mark-family={target.family}
                data-mark-key={target.key}
                className="absolute border border-red-600/70 bg-red-600/20"
                style={placed}
              />
            );
          });
        })}

      {/* The selection's own bounds, for every family and every mark in it. A
          translucent ring and a hairline border, never an opaque fill: the mark
          under it — the text a highlight covers — has to stay as readable as the
          document is. */}
      {targets.map((target) => {
        if (!selection.has(target.key)) return null;
        const frame = frameFor(target.pageIndex);
        const bounds = targetBounds(target);
        if (frame === null || bounds === null) return null;
        const placed = frame.toScreenBox(bounds);
        return (
          <span
            key={target.key}
            aria-hidden="true"
            data-mark-selection={target.family}
            data-mark-key={target.key}
            className="absolute rounded-xs border-2 border-pdf-accent ring-2 ring-pdf-accent/40"
            style={{
              left: placed.left - 2,
              // A hairline stroke still gets a box the user can see.
              top: placed.top - 2,
              width: Math.max(placed.width, 2) + 4,
              height: Math.max(placed.height, 2) + 4,
            }}
          />
        );
      })}

      {/* The move's own preview, and the rubber band. React renders the containers
          once and never touches their children or `style` again: the marquee's
          geometry and the preview's boxes are written straight into the DOM by the
          gesture, so a pointer move costs no reconciliation at all. */}
      <div ref={previewRef} />
      <span
        ref={marqueeRef}
        aria-hidden="true"
        data-mark-marquee=""
        className="absolute border border-kumo-focus bg-kumo-focus/10"
        style={{ display: 'none' }}
      />
    </div>
  );
}
