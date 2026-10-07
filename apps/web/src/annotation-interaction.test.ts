/**
 * Which mark a pointer meets, and what one edit does to the marks it selected.
 *
 * Two of the four cases below are geometry, and both are the kind of thing nothing
 * else in the suite can see. A mark that carries `rotation` is *painted* turned about
 * its own bounding box, so a target built from the stored quads sits where the mark
 * used to be: selectable in one place and dead in another, with the marquee and the
 * rendered mark disagreeing about the same object. And the four families do not move
 * the same way — an annotation accumulates `rotation` while a measurement's chain and a
 * redaction's rectangle bake the turn into their own stored points — so one edit over a
 * mixed selection has to do both, about each mark's own centre, and translate after
 * turning rather than before.
 *
 * The other two are identity, which here is not decoration but the contract: these
 * arrays are React state the overlay memoizes on, and a mark the file already carries
 * exists twice until it is settled. An edit that churns the marks it did not move, or
 * a write path that leaves the written copy of a mark selectable as if it were still
 * pending, are the defects the assertions are shaped to catch.
 */

import type { AnnotationMark, ExistingAnnotation } from 'pdf-core/ops/annotations';
import type { MeasureMark } from 'pdf-core/ops/measure';
import type { MarkTarget } from 'pdf-ui/tools';
import { describe, expect, it } from 'vitest';
import {
  annotationStepLabel,
  buildMarkTargets,
  isEmptyRemoval,
  type MarkedRedaction,
  type MarkTransform,
  normalizePendingMarks,
  planMarkRemoval,
  planMarkTransform,
  removalCount,
  withThreadRecords,
} from './annotation-interaction';

/** The page's own top edge in these fixtures: the reference `pageTop − pdfY` flips on. */
const PAGE_TOP = 800;

/** A text mark over one line run, `[x0, y0, x1, y1]` in the app's own space. */
function highlight(
  id: string,
  quads: readonly (readonly [number, number, number, number])[],
): AnnotationMark {
  return {
    id,
    kind: 'highlight',
    pageIndex: 0,
    quads,
    color: '#ffd400',
    opacity: 0.4,
    contents: '',
    author: 'author',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Ink: a bounding quad plus the strokes that are actually painted. */
function ink(
  id: string,
  quad: readonly [number, number, number, number],
  strokes: readonly (readonly number[])[],
): AnnotationMark {
  return { ...highlight(id, [quad]), kind: 'ink', thickness: 2, strokes };
}

/** A measurement's chain, in the space the ruler stores it in. */
function measurement(id: string, points: readonly (readonly [number, number])[]): MeasureMark {
  return {
    id,
    pageIndex: 0,
    mode: 'distance',
    points: points.map(([x, y]) => ({ x, y })),
    scale: { unit: 'm', pointsPerUnit: 10, ratio: 100, ratioText: '1:100', expression: '1:100' },
    color: '#ff0000',
    opacity: 1,
    author: 'author',
    contents: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A staged redaction: an id and the rectangle behind it, already in the app's space. */
function redaction(id: string, rect: readonly [number, number, number, number]): MarkedRedaction {
  return { id, mark: { pageIndex: 0, space: 'app-v1', rect } };
}

/** The file's copy of one of our marks, as the reader reports it: named by its marker. */
function persistedCopy(id: string, marker: string): ExistingAnnotation {
  return {
    id,
    subtype: 'Highlight',
    pageIndex: 0,
    kind: 'highlight',
    rect: [10, 20, 30, 26],
    contents: 'a note',
    marker,
    author: 'author',
    modified: null,
  };
}

/** The target list for one fixture, built the way the shell builds it. */
function targetsOf(input: {
  readonly annotations?: readonly AnnotationMark[];
  readonly measures?: readonly MeasureMark[];
  readonly redactions?: readonly MarkedRedaction[];
  readonly existing?: readonly ExistingAnnotation[];
}): readonly MarkTarget[] {
  return buildMarkTargets({
    annotations: input.annotations ?? [],
    measures: input.measures ?? [],
    redactions: input.redactions ?? [],
    existing: input.existing ?? [],
    pageTop: () => PAGE_TOP,
    labelFor: (_family, messageKey) => messageKey,
  });
}

describe('buildMarkTargets', () => {
  it('places a turned mark where it is painted, boxes and strokes alike', () => {
    const textMark: AnnotationMark = { ...highlight('a1', [[10, 20, 30, 26]]), rotation: 90 };
    // A stroke whose own box would give a different centre: a horizontal mid-line. Only
    // a turn about the *mark's* centre puts it on the vertical mid-line at x = 20.
    const inkMark: AnnotationMark = { ...ink('i1', [10, 10, 30, 20], [[10, 15, 30, 15]]), rotation: 90 };
    const targets = targetsOf({ annotations: [textMark, inkMark] });
    const textTarget = targets.find((target) => target.key === 'annotation:a1');
    const inkTarget = targets.find((target) => target.key === 'annotation:i1');

    // A 20×6 box about its own centre (20, 23) turns into a 6×20 box centred there.
    expect(textTarget?.boxes).toEqual([[17, 13, 23, 33]]);
    expect(inkTarget?.boxes).toEqual([[15, 5, 25, 25]]);
    expect(inkTarget?.paths).toEqual([[20, 5, 20, 25]]);
    // The stored mark is not what moved: the turn is how it is painted, and only the
    // edit planner may change what is stored.
    expect(textMark.quads).toEqual([[10, 20, 30, 26]]);
    expect(inkMark.strokes).toEqual([[10, 15, 30, 15]]);
  });

  it('lists a mark the file already carries once, as the copy a delete would remove', () => {
    const targets = targetsOf({
      annotations: [highlight('a1', [[10, 20, 30, 26]])],
      measures: [
        measurement('m1', [
          [10, 20],
          [30, 20],
        ]),
      ],
      existing: [persistedCopy('e1', 'a1'), persistedCopy('e2', 'm1')],
    });

    // Both pending copies are gone — the measurement through the same marker a text
    // mark uses — and what is left is the persisted half of each, by page and id.
    expect(targets.map((target) => target.key)).toEqual(['existing:0:e1', 'existing:0:e2']);
  });
});

describe('planMarkTransform', () => {
  it('moves the selected marks and returns everything else by reference', () => {
    const first = highlight('a1', [[10, 20, 30, 26]]);
    const second = highlight('a2', [[10, 40, 30, 46]]);
    const chain = measurement('m1', [
      [10, 20],
      [30, 20],
    ]);
    const staged = redaction('r1', [10, 10, 30, 20]);
    const input = { annotations: [first, second], measures: [chain], redactions: [staged] };
    const move: MarkTransform = { dx: 5, dy: -3, rotation: 0 };
    const plan = planMarkTransform(input, targetsOf(input), ['annotation:a1', 'measure:m1'], move);

    expect(plan.annotations).not.toBe(input.annotations);
    expect(plan.annotations[0]?.quads).toEqual([[15, 17, 35, 23]]);
    expect(plan.annotations[0]).not.toBe(first);
    // Unselected, so untouched: same object, in the same array the other mark left.
    expect(plan.annotations[1]).toBe(second);
    expect(plan.measures[0]?.points).toEqual([
      { x: 15, y: 17 },
      { x: 35, y: 17 },
    ]);
    // Nothing was selected in this family at all, so not even the array is new.
    expect(plan.redactions).toBe(input.redactions);
    // And the state the plan was built from is not the plan: no mutation, ever.
    expect(first.quads).toEqual([[10, 20, 30, 26]]);
    expect(chain.points).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 20 },
    ]);
    expect(staged.mark.rect).toEqual([10, 10, 30, 20]);
  });

  it('turns a chain and a rectangle about each one’s own box, then translates', () => {
    const chain = measurement('m1', [
      [10, 20],
      [30, 20],
    ]);
    const staged = redaction('r1', [10, 10, 30, 20]);
    const input = { annotations: [], measures: [chain], redactions: [staged] };
    // A quarter-turn about each mark's own centre and then +4 on x: the order matters,
    // because neither centre is the origin.
    const turn: MarkTransform = { dx: 4, dy: 0, rotation: 90 };
    const plan = planMarkTransform(input, targetsOf(input), ['measure:m1', 'redaction:r1'], turn);

    // The horizontal chain about (20, 20) becomes a vertical one, then slides right.
    expect(plan.measures[0]?.points).toEqual([
      { x: 24, y: 10 },
      { x: 24, y: 30 },
    ]);
    // The 20×10 rectangle about (20, 15) becomes 10×20, re-ordered ascending.
    expect(plan.redactions[0]?.mark.rect).toEqual([19, 5, 29, 25]);
    expect(plan.redactions[0]?.mark.space).toBe('app-v1');
    expect(plan.measures[0]).not.toBe(chain);
    expect(chain.points).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 20 },
    ]);
    expect(staged.mark.rect).toEqual([10, 10, 30, 20]);
  });

  it('hands the file’s own annotations to the writer instead of moving them itself', () => {
    const input = { annotations: [highlight('a1', [[10, 20, 30, 26]])], measures: [], redactions: [] };
    const existing = [persistedCopy('e1', 'a1'), persistedCopy('e9', 'gone')];
    const plan = planMarkTransform(
      input,
      targetsOf({ ...input, existing }),
      ['existing:0:e1', 'annotation:a1'],
      { dx: 1, dy: 0, rotation: 0 },
    );

    // The persisted annotation is named as a target, not rewritten here; the pending
    // copy it already answers for is not moved either, because it is not a target.
    expect(plan.existing).toEqual([{ pageIndex: 0, id: 'e1' }]);
    expect(plan.annotations).toBe(input.annotations);
  });
});

describe('normalizePendingMarks', () => {
  it('drops the marks the file already carries and keeps every other reference', () => {
    const pending = highlight('a1', [[10, 20, 30, 26]]);
    const live = highlight('a2', [[10, 40, 30, 46]]);
    const written = measurement('m1', [
      [10, 20],
      [30, 20],
    ]);
    const unwritten = measurement('m2', [
      [10, 60],
      [30, 60],
    ]);
    const staged = redaction('r1', [10, 10, 30, 20]);
    const input = {
      annotations: [pending, live],
      measures: [written, unwritten],
      redactions: [staged],
    };
    const existing = [persistedCopy('e1', 'a1'), persistedCopy('e2', 'm1')];

    const settled = normalizePendingMarks(input, existing);

    expect(settled.annotations).toEqual([live]);
    expect(settled.annotations[0]).toBe(live);
    expect(settled.measures).toEqual([unwritten]);
    expect(settled.measures[0]).toBe(unwritten);
    // A redaction is not an annotation the file can carry: nothing of it is left to
    // match against, so its list is not even copied.
    expect(settled.redactions).toBe(input.redactions);
    // Nothing written is pending: with the file carrying none of these marks, the
    // shape the caller already holds comes straight back.
    expect(normalizePendingMarks(input, [])).toBe(input);
  });
});

/** An annotation the file carries that is *not* one of ours (no marker). */
function fileAnnotation(id: string, overrides: Partial<ExistingAnnotation> = {}): ExistingAnnotation {
  return {
    id,
    subtype: 'Highlight',
    pageIndex: 0,
    kind: 'highlight',
    rect: [10, 20, 30, 26],
    contents: 'a note',
    marker: null,
    author: 'author',
    modified: null,
    ...overrides,
  };
}

describe('buildMarkTargets over the file’s own annotations', () => {
  const targetOf = (annotation: ExistingAnnotation, pageTop: number | null = PAGE_TOP) =>
    buildMarkTargets({
      annotations: [],
      measures: [],
      redactions: [],
      existing: [annotation],
      pageTop: () => pageTop,
      labelFor: (_family, messageKey) => messageKey,
    }).find((target) => target.key === `existing:0:${annotation.id}`);

  it('flips y through the page’s own top edge and keeps x, for a /Rect', () => {
    // pageTop 800: a PDF rect 20…26 from the bottom is 774…780 from the top.
    expect(targetOf(fileAnnotation('e1'))?.boxes).toEqual([[10, 774, 30, 780]]);
  });

  it('prefers /QuadPoints over /Rect, and the annotation’s own page box over the reader’s', () => {
    // One quad (upper edge first), PDF y 420…426, on a page whose own box top is 500: the
    // reader would say 800, which would put the target 300 points away from the mark.
    const quad = [10, 426, 30, 426, 10, 420, 30, 420];
    const target = targetOf(fileAnnotation('e1', { quadPoints: quad, pageBox: [0, 0, 600, 500] }));
    expect(target?.boxes).toEqual([[10, 74, 30, 80]]);
  });

  it('carries ink strokes and line vertices flipped, and the stroke width the file states', () => {
    expect(
      targetOf(fileAnnotation('e1', { kind: 'ink', inkLists: [[10, 20, 30, 40]], thickness: 3 }))?.paths,
    ).toEqual([[10, 780, 30, 760]]);
    const line = targetOf(fileAnnotation('e2', { subtype: 'Line', kind: null, vertices: [0, 100, 50, 100] }));
    expect(line?.paths).toEqual([[0, 700, 50, 700]]);
    expect(targetOf(fileAnnotation('e1', { thickness: 3 }))?.strokeWidth).toBe(3);
  });

  it('keeps a mark whose page has no known top selectable by identity, with no geometry', () => {
    const target = targetOf(fileAnnotation('e1'), null);
    expect(target).toBeDefined();
    expect(target?.boxes).toEqual([]);
  });

  it('never offers a form field or a popup as something a selection may delete', () => {
    for (const annotation of [
      fileAnnotation('w', { subtype: 'Widget' }),
      fileAnnotation('p', { subtype: 'Popup' }),
      // A subtype pdf.js could not name still says what it is by its numeric type.
      fileAnnotation('w2', { subtype: '', annotationType: 20 }),
      fileAnnotation('p2', { subtype: '', annotationType: 16 }),
    ])
      expect(targetOf(annotation), annotation.id).toBeUndefined();
    expect(targetOf(fileAnnotation('h', { annotationType: 9 }))).toBeDefined();
  });

  it('lists one annotation once even when the reader reports it twice', () => {
    const targets = targetsOf({ existing: [fileAnnotation('e1'), fileAnnotation('e1')] });
    expect(targets.map((target) => target.key)).toEqual(['existing:0:e1']);
  });
});

describe('buildMarkTargets over the session’s own marks', () => {
  it('carries a stroke width only where the mark has one, and 1 for a measurement without', () => {
    const thick = { ...ink('i1', [10, 10, 30, 20], [[10, 15, 30, 15]]), thickness: 5 };
    const plain = highlight('a1', [[10, 20, 30, 26]]);
    const chain = measurement('m1', [
      [10, 20],
      [30, 20],
    ]);
    const bold = {
      ...measurement('m2', [
        [10, 40],
        [30, 40],
      ]),
      thickness: 4,
    };
    const targets = targetsOf({ annotations: [thick, plain], measures: [chain, bold] });
    expect(targets.find((target) => target.key === 'annotation:i1')?.strokeWidth).toBe(5);
    expect(targets.find((target) => target.key === 'annotation:a1')?.strokeWidth).toBeUndefined();
    expect(targets.find((target) => target.key === 'measure:m1')?.strokeWidth).toBe(1);
    expect(targets.find((target) => target.key === 'measure:m2')?.strokeWidth).toBe(4);
  });
});

describe('buildMarkTargets geometry of the session’s own marks', () => {
  const only = (input: Parameters<typeof targetsOf>[0]) => targetsOf(input)[0];

  it('gives a text mark one box per line run, and a shape, note or typed text its rect', () => {
    const lines: [number, number, number, number][] = [
      [10, 20, 90, 26],
      [10, 30, 50, 36],
    ];
    expect(only({ annotations: [highlight('h', lines)] })?.boxes).toEqual(lines);

    const rect: [number, number, number, number] = [5, 5, 15, 15];
    for (const kind of ['shapes', 'note', 'freetext'] as const) {
      const withRect = { ...highlight('r', lines), kind, rect };
      expect(only({ annotations: [withRect] })?.boxes, kind).toEqual([rect]);
      // Without a rect it is the first quad; without any geometry, no box at all.
      expect(only({ annotations: [{ ...highlight('q', lines), kind }] })?.boxes, kind).toEqual([lines[0]]);
      expect(only({ annotations: [{ ...highlight('e', []), kind }] })?.boxes, kind).toEqual([]);
    }
  });

  it('keeps a turned mark without geometry reachable, and leaves a stray trailing stroke value in place', () => {
    const bare = { ...highlight('bare', []), rotation: 90 as const };
    const noStrokes = only({ annotations: [bare] });
    expect(noStrokes?.boxes).toEqual([]);
    expect(noStrokes && 'paths' in noStrokes).toBe(false);
    expect(only({ annotations: [{ ...bare, strokes: [] }] })?.paths).toEqual([]);

    const odd = { ...ink('i', [10, 10, 30, 20], [[10, 15, 30, 15, 99]]), rotation: 90 as const };
    expect(only({ annotations: [odd] })?.paths).toEqual([[20, 5, 20, 25, 99]]);
  });

  it('gives a measurement without points no box, and one with points its bounding box', () => {
    expect(only({ measures: [measurement('m0', [])] })?.boxes).toEqual([]);
    expect(
      only({
        measures: [
          measurement('m1', [
            [10, 20],
            [30, 40],
          ]),
        ],
      })?.boxes,
    ).toEqual([[10, 20, 30, 40]]);
  });

  it('offers resize handles only for a placed stamp', () => {
    const resizable = (annotation: ExistingAnnotation, pageTop: number | null = PAGE_TOP) =>
      buildMarkTargets({
        annotations: [],
        measures: [],
        redactions: [],
        existing: [annotation],
        pageTop: () => pageTop,
        labelFor: (_family, messageKey) => messageKey,
      })[0]?.resizable;
    expect(resizable(fileAnnotation('s', { subtype: 'Stamp', kind: null }))).toBe(true);
    expect(resizable(fileAnnotation('s', { subtype: 'Stamp', kind: null }), null)).toBeUndefined();
    expect(resizable(fileAnnotation('s', { subtype: 'Stamp', kind: null, rect: null }))).toBeUndefined();
    expect(resizable(fileAnnotation('h', { subtype: 'Highlight' }))).toBeUndefined();
  });
});

describe('planMarkRemoval', () => {
  it('splits a selection by family, drops keys that name nothing, and counts what is left', () => {
    const input = {
      annotations: [highlight('a1', [[10, 20, 30, 26]])],
      measures: [
        measurement('m1', [
          [10, 20],
          [30, 20],
        ]),
      ],
      redactions: [redaction('r1', [10, 10, 30, 20])],
    };
    const targets = targetsOf({ ...input, existing: [fileAnnotation('e1')] });
    const request = planMarkRemoval(targets, [
      'annotation:a1',
      'measure:m1',
      'redaction:r1',
      'existing:0:e1',
      'annotation:ghost',
    ]);

    expect(request).toEqual({
      annotations: ['a1'],
      measures: ['m1'],
      redactions: ['r1'],
      existing: [{ pageIndex: 0, id: 'e1' }],
    });
    expect(removalCount(request)).toBe(4);
    expect(isEmptyRemoval(request)).toBe(false);

    const nothing = planMarkRemoval(targets, ['annotation:ghost']);
    expect(removalCount(nothing)).toBe(0);
    expect(isEmptyRemoval(nothing)).toBe(true);
    // One persisted annotation alone is not "empty" either.
    expect(isEmptyRemoval(planMarkRemoval(targets, ['existing:0:e1']))).toBe(false);
  });
});

describe('planMarkTransform with nothing to move', () => {
  it('keeps a selected measurement without points, and the list it sits in, as they were', () => {
    const empty = measurement('m0', []);
    const input = { annotations: [], measures: [empty], redactions: [] };
    const plan = planMarkTransform(input, targetsOf(input), ['measure:m0'], { dx: 5, dy: 5, rotation: 90 });
    expect(plan.measures[0]).toBe(empty);
    expect(plan.measures).toBe(input.measures);
  });
});

describe('withThreadRecords', () => {
  const comment = (id: string, extra: Partial<ExistingAnnotation> = {}) =>
    fileAnnotation(id, { subtype: 'Text', kind: 'note', ...extra });
  const existing = [
    comment('1R'),
    comment('2R', { inReplyTo: '1R', replyType: 'R' }),
    comment('3R', { inReplyTo: '2R', replyType: 'R', state: 'Accepted', stateModel: 'Review' }),
    comment('4R'),
    comment('5R', { inReplyTo: '4R', replyType: 'R', pageIndex: 1 }),
  ];

  it('adds the replies and state records of a selected comment, at any depth and on their own page', () => {
    expect(withThreadRecords(['existing:0:1R'], existing)).toEqual([
      'existing:0:1R',
      'existing:0:2R',
      'existing:0:3R',
    ]);
    expect(withThreadRecords(['existing:0:4R', 'annotation:a1'], existing)).toEqual([
      'existing:0:4R',
      'annotation:a1',
      'existing:1:5R',
    ]);
  });

  it('does not repeat a record that was already selected, and leaves a selected reply alone', () => {
    expect(withThreadRecords(['existing:0:2R', 'existing:0:1R'], existing)).toEqual([
      'existing:0:2R',
      'existing:0:1R',
      'existing:0:3R',
    ]);
    // Removing only a reply does not take its comment or the other threads with it.
    expect(withThreadRecords(['existing:0:2R'], existing)).toEqual(['existing:0:2R']);
  });

  it('returns the selection itself when nothing in the file is a thread', () => {
    const keys = ['existing:0:1R'];
    expect(withThreadRecords(keys, [comment('1R'), comment('4R')])).toBe(keys);
  });
});

describe('annotationStepLabel', () => {
  const marked = highlight('h1', [[10, 10, 90, 20]]);
  const drawn = ink('i1', [10, 40, 90, 60], [[10, 40, 90, 60]]);

  it('names the kind that was drawn, and a delete as a delete', () => {
    expect(annotationStepLabel([], [marked])).toBe('ann.kind.highlight');
    expect(annotationStepLabel([marked], [marked, drawn])).toBe('ann.kind.ink');
    expect(annotationStepLabel([marked, drawn], [drawn])).toBe('ann.remove');
  });

  it('tells a comment edit from a change to the mark itself', () => {
    expect(annotationStepLabel([marked], [{ ...marked, contents: 'yorum' }])).toBe('ann.edit');
    expect(
      annotationStepLabel([marked], [{ ...marked, review: { state: 'Accepted', author: 'a', at: 'now' } }]),
    ).toBe('ann.edit');
    expect(annotationStepLabel([marked], [{ ...marked, rotation: 90 }])).toBe('ann.transform');
    expect(annotationStepLabel([marked], [{ ...marked, color: '#ff0000', contents: 'x' }])).toBe(
      'ann.transform',
    );
  });

  it('falls back to the panel name only when one step mixes kinds or adds and removes', () => {
    expect(annotationStepLabel([], [marked, drawn])).toBe('panel.comments');
    expect(annotationStepLabel([marked], [drawn])).toBe('panel.comments');
  });
});
