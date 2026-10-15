// @vitest-environment happy-dom
/**
 * What a selection measures: the browser's text selection as per-line boxes in page points. The
 * page is a 600 × 800 pt box drawn at 50 % at (100, 50) (a second one at (100, 500)), so a page
 * point is half its pixels away from the page's corner.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewerApi } from '../viewer/PdfViewerPane';
import { clientOf, type FakePage, fakeViewer } from './layer-viewer.fixtures';
import { markPageFrameOf } from './mark-interaction';
import { selectionBoxes } from './selection-boxes';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A text selection the browser made: happy-dom has no layout, so the client rects are given. */
function selectText(rects: readonly { left: number; top: number; right: number; bottom: number }[]) {
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => ({
      getClientRects: () =>
        rects.map((rect) => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top })),
    }),
  } as unknown as Selection);
}

/** The client rectangle of a page-point box. */
function rectOf(x0: number, y0: number, x1: number, y1: number, pageIndex = 0) {
  const first = clientOf({ x: x0, y: y0 }, pageIndex);
  const second = clientOf({ x: x1, y: y1 }, pageIndex);
  return { left: first.clientX, top: first.clientY, right: second.clientX, bottom: second.clientY };
}

describe('what a selection measures', () => {
  it('has nothing to measure without a selection, a collapsed one or one with no ranges', () => {
    const viewer = fakeViewer();
    vi.spyOn(window, 'getSelection').mockReturnValueOnce(null);
    expect(selectionBoxes(viewer)).toEqual([]);
    vi.spyOn(window, 'getSelection').mockReturnValueOnce({ isCollapsed: true, rangeCount: 1 } as Selection);
    expect(selectionBoxes(viewer)).toEqual([]);
    vi.spyOn(window, 'getSelection').mockReturnValueOnce({ isCollapsed: false, rangeCount: 0 } as Selection);
    expect(selectionBoxes(viewer)).toEqual([]);
  });

  it('skips empty rects and rects off the pages or across a page break', () => {
    selectText([
      { left: 120, top: 100, right: 120, bottom: 120 },
      { left: 120, top: 100, right: 160, bottom: 100 },
      { left: 5, top: 5, right: 20, bottom: 20 },
      { left: 120, top: 440, right: 160, bottom: 520 },
    ]);
    expect(selectionBoxes(fakeViewer())).toEqual([]);
  });

  it('merges the spans of one line, keeps lines apart and splits per page', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      isCollapsed: false,
      rangeCount: 2,
      getRangeAt: (index: number) => ({
        getClientRects: () =>
          (index === 0
            ? [rectOf(300, 300, 400, 320), rectOf(100, 100, 200, 120), rectOf(200, 102, 300, 122)]
            : [rectOf(100, 100, 200, 120, 1), rectOf(100, 130, 150, 150)]
          ).map((rect) => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top })),
      }),
    } as unknown as Selection);
    expect(selectionBoxes(fakeViewer())).toEqual([
      {
        pageIndex: 0,
        boxes: [
          [100, 100, 300, 122],
          [100, 130, 150, 150],
          [300, 300, 400, 320],
        ],
      },
      { pageIndex: 1, boxes: [[100, 100, 200, 120]] },
    ]);
  });

  it('orders boxes that start on the same height from left to right', () => {
    selectText([rectOf(300, 100, 400, 120), rectOf(100, 100, 200, 120)]);
    expect(selectionBoxes(fakeViewer())).toEqual([{ pageIndex: 0, boxes: [[100, 100, 400, 120]] }]);
  });

  it('measures a page whose geometry the viewer does not give as an upright one', () => {
    const viewer = { ...fakeViewer(), pageGeometry: () => null } as ViewerApi;
    selectText([rectOf(100, 100, 200, 120), rectOf(200, 102, 300, 122)]);
    expect(selectionBoxes(viewer)).toEqual([{ pageIndex: 0, boxes: [[100, 100, 300, 122]] }]);
  });

  /**
   * A page turned a quarter, with the real projection: the page is 600 × 800 pt, drawn 400 × 300
   * px, so a screen line runs along the page's own y axis and the lines are stacked along its x.
   */
  function turnedViewer(rotation: 90 | 270): ViewerApi {
    const page: FakePage = {
      rect: { x: 100, y: 50, width: 400, height: 300 },
      box: { x: 0, y: 0, width: 600, height: 800 },
      rotation,
    };
    const base = fakeViewer({ pages: [page] });
    return {
      ...base,
      pointToPage: (clientX: number, clientY: number) => {
        const frame = markPageFrameOf(base, 0);
        const inside =
          clientX >= page.rect.x &&
          clientX <= page.rect.x + page.rect.width &&
          clientY >= page.rect.y &&
          clientY <= page.rect.y + page.rect.height;
        return frame === null || !inside ? null : { pageIndex: 0, ...frame.toPage(clientX, clientY) };
      },
    } as ViewerApi;
  }

  it.each<[90 | 270]>([[90], [270]])(
    'keeps the lines of a page turned %s° apart and merges the spans of each',
    (rotation) => {
      // Two screen lines (y 100–120 and 150–170), two spans each along x 120–200 and 200–300.
      selectText([
        { left: 120, top: 100, right: 200, bottom: 120 },
        { left: 200, top: 101, right: 300, bottom: 121 },
        { left: 120, top: 150, right: 200, bottom: 170 },
        { left: 200, top: 151, right: 300, bottom: 171 },
      ]);
      const [selection] = selectionBoxes(turnedViewer(rotation));
      const boxes = selection?.boxes ?? [];
      expect(boxes).toHaveLength(2);
      for (const box of boxes) {
        // One line is 21 px thick across the page's x (42 pt) and 180 px long along its y (360 pt).
        expect(box[2] - box[0]).toBeCloseTo(42, 6);
        expect(box[3] - box[1]).toBeCloseTo(360, 6);
      }
      // The two lines are 50 px (100 pt) apart across x, and do not touch.
      expect(Math.abs((boxes[1]?.[0] ?? 0) - (boxes[0]?.[0] ?? 0))).toBeCloseTo(100, 6);
    },
  );
});
