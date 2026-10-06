/**
 * Native takeover must understand the installed editor's serialization, not the
 * file reader's InkList shape. Existing-object edits and unknown editor families
 * remain native: re-creating either as an overlay would duplicate or flatten it.
 *
 * The container types are the engine's, not convenient ones: `InkEditor.serialize`
 * hands each stroke back as a `Float32Array` (`InkDrawOutline.serialize` →
 * `Outline._rescale`, `build/pdf.mjs`), while a record read back from a file carries
 * plain arrays — the takeover reads both.
 */
import { describe, expect, it } from 'vitest';
import { type AnnotationMark, marksFromEngineEntries, storageEntriesFor } from './annotations';

/** The page box every expectation below is measured against: top edge at 130. */
const PAGE_BOX = [{ x: 20, y: 30, width: 100, height: 100 }];
const DEFAULTS = { color: '#000000', opacity: 1, author: '' };

describe('marksFromEngineEntries', () => {
  it('takes over new native ink while retaining existing edits and unsupported editors for the native writer', () => {
    const ink = {
      annotationType: 15,
      id: null,
      pageIndex: 0,
      color: [255, 0, 0],
      opacity: 0.5,
      thickness: 4,
      paths: { points: [new Float32Array([30, 80, 90, 50])] },
    };
    const marks = marksFromEngineEntries(
      [
        { id: 'new-ink', value: ink },
        { id: 'edited-ink', value: { ...ink, id: '7R' } },
        { id: 'unknown-editor', value: { ...ink, annotationType: 13 } },
      ],
      PAGE_BOX,
      DEFAULTS,
    );
    expect(marks).toEqual([
      expect.objectContaining({
        id: 'new-ink',
        kind: 'ink',
        strokes: [[30, 50, 90, 80]],
        color: '#ff0000',
        opacity: 0.5,
        thickness: 4,
      }),
    ]);
  });

  it('reads a file-shaped ink record with plain-array runs and flips it against the page box', () => {
    const marks = marksFromEngineEntries(
      [
        {
          id: 'new-ink',
          value: { annotationType: 15, id: null, pageIndex: 0, inkLists: [[30, 80, 90, 50]] },
        },
      ],
      PAGE_BOX,
      DEFAULTS,
    );
    expect(marks).toEqual([
      expect.objectContaining({ kind: 'ink', strokes: [[30, 50, 90, 80]], quads: [[30, 50, 90, 80]] }),
    ]);
  });

  it('takes a drawn free highlight over as ONE continuous stroke, not as rows of boxes', () => {
    // The installed free highlight's serialization (`FreeHighlightOutline.serialize`,
    // `build/pdf.mjs`): the drawn path is a moveto group of four placeholders plus
    // the point, then one six-number group per following point — `[NaN x4, x, y]`
    // for a straight run — and `points` carries the same samples as plain ordinates.
    // Reading the *path* as 8-number quads (the shape a text selection uses) is what
    // painted a marker stroke as disconnected boxes, so this fails the old code: it
    // produced no `strokes` at all, and only some of the sampled points survived.
    const path = [
      Number.NaN,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      30,
      80,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      50,
      70,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      70,
      75,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      Number.NaN,
      90,
      50,
    ];
    const marks = marksFromEngineEntries(
      [
        {
          id: 'free-highlight',
          value: {
            annotationType: 9,
            id: null,
            pageIndex: 0,
            color: [255, 212, 0],
            opacity: 0.4,
            thickness: 12,
            quadPoints: null,
            outlines: { outline: path, points: [new Float32Array([30, 80, 50, 70, 70, 75, 90, 50])] },
          },
        },
      ],
      PAGE_BOX,
      DEFAULTS,
    );

    expect(marks).toEqual([
      expect.objectContaining({
        id: 'free-highlight',
        kind: 'highlight',
        // Four sampled points, in order, flipped against the page's top edge (130).
        strokes: [[30, 50, 50, 60, 70, 55, 90, 80]],
        // The box around the stroke, which is what a hit test and the writer's rect use.
        quads: [[30, 50, 90, 80]],
        color: '#ffd400',
        opacity: 0.4,
        thickness: 12,
      }),
    ]);
  });

  it('decodes a drawn path even when the sampled runs are missing, and never as quads', () => {
    const path = [Number.NaN, Number.NaN, Number.NaN, Number.NaN, 30, 80, Number.NaN, 0, 0, 0, 90, 50];
    const marks = marksFromEngineEntries(
      [
        {
          id: 'free-highlight',
          value: { annotationType: 9, id: null, pageIndex: 0, outlines: { outline: path } },
        },
      ],
      PAGE_BOX,
      DEFAULTS,
    );
    expect(marks).toEqual([
      expect.objectContaining({ kind: 'highlight', strokes: [[30, 50, 90, 80]], quads: [[30, 50, 90, 80]] }),
    ]);
  });

  it('leaves a stroked highlight to the marker writer instead of the engine', () => {
    const marker: AnnotationMark = {
      id: 'marker',
      kind: 'highlight',
      pageIndex: 0,
      quads: [[30, 50, 90, 80]],
      strokes: [[30, 50, 50, 60, 90, 80]],
      color: '#ffd400',
      opacity: 0.4,
      contents: '',
      author: '',
      createdAt: '2026-09-22T00:00:00.000Z',
      thickness: 12,
    };
    // The engine fills polygons, so it must not be handed a stroke: an empty entry
    // list is what routes the mark to `writeStrokeHighlights`.
    expect(storageEntriesFor(marker, 130)).toEqual([]);
    // A highlight with line boxes stays the engine's own work.
    expect(storageEntriesFor({ ...marker, strokes: undefined }, 130)).toHaveLength(1);
  });
});
