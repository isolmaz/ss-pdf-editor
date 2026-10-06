import type { MeasureRotation } from 'pdf-core/ops/measure';
import { describe, expect, it, vi } from 'vitest';
import {
  clickSuppression,
  hitTargets,
  type MarkPageFrame,
  type MarkRect,
  type MarkTarget,
  markPageFrame,
  markTargetKey,
  marqueeTargets,
  targetBounds,
  targetMarqueeHit,
  targetPointHit,
} from './mark-interaction';

/**
 * The geometry every mark tool shares, and the defects the old overlays shipped
 * restated as behaviour.
 *
 * Each case here is a failure that was reachable in the product, not a fixture
 * exercising the code:
 *
 *  - a stroke is stored as **sparse vertices**, so a hit test that read only the
 *    stored vertices met nothing until it reached a corner of a long line;
 *  - a mark's own stroke width is part of what it covers, so a hairline and a
 *    20 pt line are not equally easy to click; the reach adds half the stroke;
 *  - the projection's 270° row subtracted the container offset twice, which put
 *    every mark on a `/Rotate 270` page one dock-width to the left;
 *  - and a mark's box was placed as if the page box started at 0, so a cropped
 *    page (`/CropBox [20 30 620 830]`) drew its marks 20 pt off.
 *
 * The projection cases are one row per rotation because each one is its own branch
 * of the core's table — the 0/90/180 rows are correct today and are here so a
 * change to the shared helper cannot quietly move them.
 */

function target(overrides: Partial<MarkTarget> = {}): MarkTarget {
  return {
    key: 'annotation:one',
    family: 'annotation',
    id: 'one',
    pageIndex: 0,
    boxes: [[100, 100, 200, 200]],
    label: 'Highlight',
    ...overrides,
  };
}

/** A cropped page (`/CropBox [20 30 620 830]`) drawn at 50 %, 60 px into its container. */
function frameFor(rotation: MeasureRotation): MarkPageFrame {
  const quarterTurn = rotation === 90 || rotation === 270;
  const frame = markPageFrame({
    rotation,
    originX: 20,
    top: 830,
    width: 600,
    height: 800,
    // pdf.js hands the element the *displayed* size: 800×600 for a quarter turn.
    page: { x: 100, y: 50, width: quarterTurn ? 400 : 300, height: quarterTurn ? 300 : 400 },
    container: { x: 40, y: 80, width: 1200, height: 900 },
  });
  if (frame === null) throw new Error(`the ${rotation}° fixture must project`);
  return frame;
}

describe('the page projection', () => {
  it('places the page box on the page element from its crop origin, at every rotation', () => {
    for (const { rotation, quarter } of [
      // The app-space top-left quarter of the page, and where a turn puts it.
      { rotation: 0, quarter: { left: 60, top: -30, width: 75, height: 100 } },
      { rotation: 90, quarter: { left: 360, top: -30, width: 100, height: 75 } },
      { rotation: 180, quarter: { left: 285, top: 270, width: 75, height: 100 } },
      { rotation: 270, quarter: { left: 60, top: 195, width: 100, height: 75 } },
    ] as const) {
      const frame = frameFor(rotation);
      expect(frame.toScreenBox([20, 0, 620, 800]), `rotation ${rotation}`).toEqual({
        left: 60,
        top: -30,
        width: frame.width,
        height: frame.height,
      });
      expect(frame.toScreenBox([20, 0, 170, 200]), `rotation ${rotation}`).toEqual(quarter);
    }
  });

  it('places a point against the crop origin, not against zero', () => {
    const frame = frameFor(0);
    // 20 pt of crop origin at 50 % is 10 px: assuming a zero-origin box drew every
    // mark 10 px left of the words it was measured over.
    expect(frame.toScreen({ x: 20, y: 0 })).toEqual({ x: 60, y: -30 });
    expect(frame.toScreen({ x: 120, y: 100 })).toEqual({ x: 110, y: 20 });
  });

  it('inverts its own projection, so a marquee measured in pixels lands in page points', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      const frame = frameFor(rotation);
      for (const point of [
        { x: 20, y: 0 },
        { x: 320, y: 400 },
        { x: 620, y: 800 },
      ]) {
        const screen = frame.toScreen(point);
        const back = frame.toPage(screen.x, screen.y);
        expect(back.x, `rotation ${rotation}`).toBeCloseTo(point.x, 6);
        expect(back.y, `rotation ${rotation}`).toBeCloseTo(point.y, 6);
      }
    }
  });

  it('clips a mark to its own page instead of painting over the gutter', () => {
    const frame = frameFor(0);
    // 500…700 pt against a 600 pt page: the visible part is 480…600, i.e. 60 px at 50 %.
    expect(frame.toScreenBox([500, 0, 700, 100] as MarkRect)).toEqual({
      left: 300,
      top: -30,
      width: 60,
      height: 50,
    });
  });
});

describe('the hit tests', () => {
  it('hits a sparse stroke between its stored vertices', () => {
    const ink = target({ boxes: [], paths: [[0, 0, 400, 0]], strokeWidth: 2 });
    expect(targetPointHit(ink, { x: 200, y: 0 }, 0)).toBe(true);
    // 1 pt away is inside the stroke's own half-width; 2 pt away is not.
    expect(targetPointHit(ink, { x: 200, y: 1 }, 0)).toBe(true);
    expect(targetPointHit(ink, { x: 200, y: 2 }, 0)).toBe(false);
  });

  it('hits exactly at the click slop and misses just past it', () => {
    const highlight = target();
    expect(targetPointHit(highlight, { x: 300, y: 150 }, 100)).toBe(true);
    expect(targetPointHit(highlight, { x: 300, y: 150 }, 99.9)).toBe(false);
    // Half the mark's own stroke is added: a 4 pt line is reachable 2 pt away.
    const ink = target({ boxes: [], paths: [[100, 0, 300, 0]], strokeWidth: 4 });
    expect(targetPointHit(ink, { x: 200, y: 2 }, 0)).toBe(true);
    expect(targetPointHit(ink, { x: 200, y: 2.01 }, 0)).toBe(false);
  });

  it('hit-tests only the page the point is on', () => {
    const first = target({ key: 'annotation:a', id: 'a', pageIndex: 1, boxes: [[0, 0, 20, 20]] });
    const intent = target({ key: 'redaction:r', id: 'r', pageIndex: 1, boxes: [[40, 0, 60, 20]] });
    const elsewhere = target({ key: 'annotation:x', id: 'x', pageIndex: 0, boxes: [[0, 0, 20, 20]] });
    expect(
      hitTargets([first, intent, elsewhere], { pageIndex: 1, x: 10, y: 10 }, 0).map((mark) => mark.key),
    ).toEqual(['annotation:a']);
    expect(hitTargets([first, elsewhere], { pageIndex: 0, x: 10, y: 10 }, 0).map((mark) => mark.key)).toEqual(
      ['annotation:x'],
    );
  });

  it('marquees the marks its rectangle overlaps, edges included', () => {
    const highlight = target({ key: 'annotation:h', id: 'h', pageIndex: 2 });
    const other = target({ key: 'measure:m', id: 'm', pageIndex: 5, boxes: [[0, 0, 10, 10]] });
    expect(marqueeTargets([highlight, other], [{ pageIndex: 2, rect: [150, 150, 250, 250] }])).toEqual([
      highlight,
    ]);
    expect(targetMarqueeHit(highlight, [200, 100, 300, 200])).toBe(true);
    expect(targetMarqueeHit(highlight, [201, 100, 300, 200])).toBe(false);
  });

  it('marquees a stroke crossing the rectangle between two vertices', () => {
    const ink = target({ boxes: [], paths: [[0, 0, 400, 0]], strokeWidth: 2 });
    expect(targetMarqueeHit(ink, [195, -10, 205, 10])).toBe(true);
    expect(targetMarqueeHit(ink, [195, 20, 205, 40])).toBe(false);
  });

  it('bounds everything a target paints, for the selection outline', () => {
    expect(targetBounds(target({ boxes: [[100, 100, 200, 200]], paths: [[0, 40, 400, 40]] }))).toEqual([
      0, 40, 400, 200,
    ]);
    expect(targetBounds(target({ boxes: [] }))).toBeNull();
  });

  it('qualifies a file annotation’s identity with its page', () => {
    expect(markTargetKey('annotation', 'a1', 2)).toBe('annotation:a1');
    expect(markTargetKey('existing', 'a1', 2)).toBe('existing:2:a1');
  });
});

describe('the page projection — edges and refusals', () => {
  it('clips a mark to its page on every side, not only the right one', () => {
    const frame = frameFor(0);
    // The page box is x 20…620, y 0…800 at 50 %: 300 x 400 px, top-left at (60, -30).
    // A box hanging off the left and bottom edges keeps only the part inside.
    expect(frame.toScreenBox([-100, 700, 100, 900] as MarkRect)).toEqual({
      left: 60,
      top: 320,
      width: 40,
      height: 50,
    });
    // Hanging off the top edge and the right edge together.
    expect(frame.toScreenBox([560, -50, 700, 40] as MarkRect)).toEqual({
      left: 60 + 270,
      top: -30,
      width: 30,
      height: 20,
    });
  });

  it('gives a mark wholly outside its page no area at all', () => {
    const frame = frameFor(0);
    const box = frame.toScreenBox([900, 900, 1000, 1000] as MarkRect);
    expect(box.width).toBe(0);
    expect(box.height).toBe(0);
  });

  it('accepts a box whose corners are given the other way round', () => {
    const frame = frameFor(0);
    expect(frame.toScreenBox([120, 100, 20, 0] as MarkRect)).toEqual(
      frame.toScreenBox([20, 0, 120, 100] as MarkRect),
    );
  });

  it('refuses to project a page that has no size, in the document or on screen', () => {
    const base = {
      rotation: 0,
      originX: 0,
      top: 800,
      width: 600,
      height: 800,
      page: { x: 0, y: 0, width: 300, height: 400 },
      container: { x: 0, y: 0, width: 1000, height: 1000 },
    } as const;
    expect(markPageFrame(base)).not.toBeNull();
    expect(markPageFrame({ ...base, width: 0 })).toBeNull();
    expect(markPageFrame({ ...base, height: 0 })).toBeNull();
    expect(markPageFrame({ ...base, page: { ...base.page, width: 0 } })).toBeNull();
    expect(markPageFrame({ ...base, page: { ...base.page, height: 0 } })).toBeNull();
  });
});

describe('the hit tests — reach and degenerate shapes', () => {
  const stroke = (strokeWidth: number, path: readonly number[] = [0, 0, 400, 0]) =>
    target({ boxes: [], paths: [path], strokeWidth });

  it('does not reach past either end of a stroke', () => {
    const ink = stroke(2);
    expect(targetPointHit(ink, { x: 400, y: 0 }, 0)).toBe(true);
    expect(targetPointHit(ink, { x: 401, y: 0 }, 0)).toBe(true);
    expect(targetPointHit(ink, { x: 401.5, y: 0 }, 0)).toBe(false);
    expect(targetPointHit(ink, { x: 500, y: 0 }, 0)).toBe(false);
    expect(targetPointHit(ink, { x: -50, y: 0 }, 0)).toBe(false);
  });

  it('treats a negative click slop as none, and adds the half stroke on top of a positive one', () => {
    const ink = stroke(4);
    expect(targetPointHit(ink, { x: 200, y: 2.5 }, -10)).toBe(false);
    expect(targetPointHit(ink, { x: 200, y: 2 }, -10)).toBe(true);
    expect(targetPointHit(ink, { x: 200, y: 5 }, 3)).toBe(true);
    expect(targetPointHit(ink, { x: 200, y: 5.1 }, 3)).toBe(false);
  });

  it('hits a single-vertex stroke only around that vertex, and a zero-length segment like a point', () => {
    const dot = stroke(2, [50, 50]);
    expect(targetPointHit(dot, { x: 50, y: 50.9 }, 0)).toBe(true);
    expect(targetPointHit(dot, { x: 50, y: 52 }, 0)).toBe(false);
    const still = stroke(2, [50, 50, 50, 50]);
    expect(targetPointHit(still, { x: 50, y: 50.9 }, 0)).toBe(true);
    expect(targetPointHit(still, { x: 50, y: 52 }, 0)).toBe(false);
  });

  it('is never hit by a mark that has no geometry', () => {
    const empty = target({ boxes: [], paths: [[]] });
    expect(targetPointHit(empty, { x: 0, y: 0 }, 1000)).toBe(false);
    expect(targetMarqueeHit(empty, [-1000, -1000, 1000, 1000])).toBe(false);
    expect(targetPointHit(target({ boxes: [] }), { x: 0, y: 0 }, 1000)).toBe(false);
  });

  it('adds the half stroke to a marquee, for a stroke and for a box', () => {
    const ink = stroke(4);
    // The rectangle starts 1.5 pt off the line: inside its 2 pt half-width, outside 1 pt.
    expect(targetMarqueeHit(ink, [100, 1.5, 120, 30])).toBe(true);
    expect(targetMarqueeHit(ink, [100, 2.5, 120, 30])).toBe(false);
    const framed = target({ boxes: [[100, 100, 200, 200]], strokeWidth: 4 });
    expect(targetMarqueeHit(framed, [201.5, 100, 300, 200])).toBe(true);
    expect(targetMarqueeHit(framed, [202.5, 100, 300, 200])).toBe(false);
  });

  it('selects a stroke that lies entirely inside the marquee, or that only has an end inside it', () => {
    const ink = stroke(0, [10, 10, 20, 20]);
    expect(targetMarqueeHit(ink, [0, 0, 100, 100])).toBe(true);
    const reaching = stroke(0, [50, 50, 500, 50]);
    expect(targetMarqueeHit(reaching, [0, 0, 100, 100])).toBe(true);
    expect(targetMarqueeHit(reaching, [0, 0, 40, 100])).toBe(false);
  });

  it('selects a stroke that passes straight through the marquee without a vertex inside it', () => {
    const diagonal = stroke(0, [0, 0, 100, 100]);
    expect(targetMarqueeHit(diagonal, [40, 40, 60, 60])).toBe(true);
    expect(targetMarqueeHit(diagonal, [60, 20, 80, 40])).toBe(false);
  });

  it('marquees only the page the rectangle was drawn on', () => {
    const here = target({ key: 'annotation:h', id: 'h', pageIndex: 2 });
    expect(marqueeTargets([here], [{ pageIndex: 3, rect: [0, 0, 1000, 1000] }])).toEqual([]);
    expect(
      marqueeTargets(
        [here],
        [
          { pageIndex: 3, rect: [0, 0, 1000, 1000] },
          { pageIndex: 2, rect: [0, 0, 1000, 1000] },
        ],
      ),
    ).toEqual([here]);
  });

  it('bounds a target made of strokes alone, and ignores the stroke width', () => {
    expect(
      targetBounds(
        target({
          boxes: [],
          paths: [
            [5, 6, 50, 60],
            [70, 1],
          ],
          strokeWidth: 10,
        }),
      ),
    ).toEqual([5, 1, 70, 60]);
  });
});

describe('clickSuppression', () => {
  it('swallows the click that follows a gesture once, and only inside its window', () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
    try {
      const guard = clickSuppression();
      expect(guard.consume()).toBe(false);
      guard.suppress();
      now += 999;
      expect(guard.consume()).toBe(true);
      expect(guard.consume()).toBe(false);
      guard.suppress();
      now += 1_001;
      expect(guard.consume()).toBe(false);
      guard.suppress();
      guard.reset();
      expect(guard.consume()).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });
});
