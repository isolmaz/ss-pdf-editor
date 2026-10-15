/**
 * The browser's text selection, measured as per-line boxes in page points.
 *
 * This is a module of its own, and not part of `AnnotationLayer.tsx`, because the shell reaches it
 * from the first-paint chunk (the context menu's "annotate the selection" entries) while the layer
 * is an editor-chunk component: a function kept in the layer's module pulled the whole layer, with
 * the transforms it imports, into the first-paint JavaScript.
 */

import type { MarkBox } from 'pdf-core/ops/annotations';
import type { ViewerApi } from '../viewer/PdfViewerPane';

/** A text selection, already reduced to per-line boxes in page points. */
export interface TextSelection {
  readonly pageIndex: number;
  readonly boxes: readonly MarkBox[];
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
  return [...boxesByPage].map(([pageIndex, boxes]) => ({
    pageIndex,
    boxes: mergeLineBoxes(boxes, viewer.pageGeometry(pageIndex)?.rotation ?? 0),
  }));
}

/**
 * Merge boxes that share a line (several spans of one line) into one.
 *
 * The boxes are in the page's own, unrotated space, where the lines of an upright page
 * (`/Rotate` 0 or 180) are rows stacked down `y`, but the lines of a page turned a
 * quarter (90 or 270) are columns stacked along `x`: a line on the screen runs along the
 * page's `y`. A line is therefore the boxes that overlap on the axis the lines are stacked
 * on, and merging them by their `y` on a turned page joins every line that happens to
 * cover the same stretch of `y` — all of them — into one box over the whole text block.
 */
function mergeLineBoxes(boxes: readonly MarkBox[], rotation: 0 | 90 | 180 | 270): readonly MarkBox[] {
  // The tuple indices of the stacking axis' two edges, and of the other axis' first edge.
  const [near, far, along] =
    rotation === 90 || rotation === 270 ? ([0, 2, 1] as const) : ([1, 3, 0] as const);
  const sorted = [...boxes].sort((a, b) => a[near] - b[near] || a[along] - b[along]);
  const merged: MarkBox[] = [];
  for (const box of sorted) {
    const previous = merged[merged.length - 1];
    if (previous === undefined) {
      merged.push(box);
      continue;
    }
    const sameLine = box[near] <= previous[far] + 1 && box[far] >= previous[near] - 1;
    if (!sameLine) {
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
