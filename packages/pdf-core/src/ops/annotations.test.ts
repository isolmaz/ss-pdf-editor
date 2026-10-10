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
import { PDFDocument as BuilderDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { openWithPdfjs, type PdfDocumentHandle } from '../engines/pdfjs-handle';
import { generationFivePdf } from './annotation.fixtures';
import {
  type AnnotationMark,
  annotationIdsOf,
  annotationKindKey,
  annotationStorageOf,
  boxesOf,
  type ExistingAnnotation,
  hexToRgb,
  kindForSubtype,
  markerFor,
  markerTargets,
  markOutlines,
  markQuadPoints,
  markRect,
  marksFromEngineEntries,
  readAnnotations,
  settleEngineMarks,
  storageEntriesFor,
  writeAnnotations,
} from './annotations';

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
    // Reading the *path* as 8-number quads (the shape a text selection uses) paints a
    // marker stroke as disconnected boxes; it yields no `strokes` at all, and only some
    // of the sampled points survive. This test guards against that.
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

// ---------------------------------------------------------------------------
// helpers shared by the cases below
// ---------------------------------------------------------------------------

const RUN = { signal: new AbortController().signal };

/** A value the types forbid, handed over the way a damaged engine record would. */
const untyped = (value: unknown): never => value as never;

function mark(overrides: Partial<AnnotationMark> = {}): AnnotationMark {
  return {
    id: 'm',
    kind: 'highlight',
    pageIndex: 0,
    quads: [],
    color: '#ff0000',
    opacity: 1,
    contents: '',
    author: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function thrownBy(call: () => unknown): ToolError {
  let outcome: { readonly error: unknown } | null = null;
  try {
    call();
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the call returned instead of throwing');
  if (!isToolError(outcome.error)) throw outcome.error;
  return outcome.error;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  let outcome: { readonly error: unknown } | null = null;
  try {
    await promise;
  } catch (error) {
    outcome = { error };
  }
  if (outcome === null) throw new Error('the call resolved instead of rejecting');
  return outcome.error;
}

describe('hexToRgb', () => {
  it('reads #rrggbb in either case, trimmed, as 0…1 components', () => {
    expect(hexToRgb(' #FF8000 ')).toEqual([1, 128 / 255, 0]);
  });

  it('refuses anything else instead of painting black', () => {
    for (const bad of ['red', '#fff', '#gggggg', '']) {
      const error = thrownBy(() => hexToRgb(bad));
      expect(error.code).toBe('internal');
      expect(error.details.engineMessage).toBe(`annotation colour is not #rrggbb: ${bad}`);
    }
  });
});

describe('boxesOf', () => {
  it('is the rect of a shape, a note or a text box, falling back to its first quad', () => {
    expect(boxesOf(mark({ kind: 'shapes', rect: [1, 2, 3, 4], quads: [[9, 9, 9, 9]] }))).toEqual([
      [1, 2, 3, 4],
    ]);
    expect(boxesOf(mark({ kind: 'note', quads: [[5, 6, 7, 8]] }))).toEqual([[5, 6, 7, 8]]);
    const error = thrownBy(() => boxesOf(mark({ kind: 'freetext' })));
    expect(error.code).toBe('selection-empty');
    expect(error.details.engineMessage).toBe('annotation m (freetext) carries no rectangle');
  });

  it('is every quad of a text-line mark, or the one box around a stroke when it has no quad', () => {
    expect(
      boxesOf(
        mark({
          kind: 'underline',
          quads: [
            [1, 2, 3, 4],
            [5, 6, 7, 8],
          ],
        }),
      ),
    ).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    // The second run has one point and a dangling value; the dangling value is not a point.
    expect(
      boxesOf(
        mark({
          kind: 'ink',
          strokes: [
            [1, 2, 5, 9],
            [3, 0, 8],
          ],
        }),
      ),
    ).toEqual([[1, 0, 5, 9]]);
    expect(thrownBy(() => boxesOf(mark({ kind: 'ink' }))).code).toBe('selection-empty');
    const empty = thrownBy(() => boxesOf(mark({ kind: 'ink', strokes: [[4], []] })));
    expect(empty.code).toBe('selection-empty');
    expect(empty.details.engineMessage).toBe('annotation m (ink) carries no quad');
  });
});

describe('storageEntriesFor', () => {
  it('hands the engine ink in PDF user space, with its path format and the default thickness', () => {
    const ink = mark({
      kind: 'ink',
      strokes: [
        [10, 20, 30, 40],
        [5, 6],
      ],
      quads: [[5, 6, 30, 40]],
      contents: ' note ',
      author: 'Ada',
    });
    const [entry, ...others] = storageEntriesFor(ink, 100, 90);
    expect(others).toEqual([]);
    const nan = Number.NaN;
    expect(entry).toMatchObject({
      id: 'm',
      annotationType: 15,
      pageIndex: 0,
      rotation: 90,
      color: [255, 0, 0],
      opacity: 1,
      contents: `${markerFor('m')} note`,
      popup: { contents: `${markerFor('m')} note` },
      user: 'Ada',
      thickness: 2,
      rect: markRect(ink, 100),
      inkLists: [
        [10, 80, 30, 60],
        [5, 94],
      ],
      paths: {
        points: [
          [10, 80, 30, 60],
          [5, 94],
        ],
        lines: [
          [nan, nan, nan, nan, 10, 80, nan, nan, nan, nan, 30, 60],
          [nan, nan, nan, nan, 5, 94],
        ],
      },
    });
    expect(storageEntriesFor({ ...ink, thickness: 6 }, 100)[0]).toMatchObject({ thickness: 6, rotation: 0 });
  });

  it('refuses ink without a stroke', () => {
    const error = thrownBy(() => storageEntriesFor(mark({ kind: 'ink' }), 100));
    expect(error.code).toBe('selection-empty');
    expect(error.details.engineMessage).toBe('ink annotation m carries no stroke');
  });

  it('leaves notes, shapes and text boxes to the writers that draw them', () => {
    for (const kind of ['note', 'shapes', 'freetext'] as const) {
      expect(storageEntriesFor(mark({ kind, rect: [1, 2, 3, 4] }), 100)).toEqual([]);
    }
  });

  it('writes a text-line mark as a highlight entry carrying its quads, outlines and thickness', () => {
    const underline = mark({ kind: 'underline', quads: [[10, 20, 60, 30]], thickness: 3 });
    expect(storageEntriesFor(underline, 100)).toEqual([
      expect.objectContaining({
        annotationType: 9,
        rect: markRect(underline, 100),
        quadPoints: markQuadPoints(underline, 100),
        outlines: markOutlines(underline, 100),
        thickness: 3,
      }),
    ]);
    expect(storageEntriesFor(mark({ quads: [[1, 2, 3, 4]] }), 50)[0]).toMatchObject({ thickness: 0 });
  });
});

describe('annotationIdsOf', () => {
  it('lists an annotation id and, when the file names one, its marker', () => {
    const base: ExistingAnnotation = {
      id: '4R',
      subtype: 'Square',
      pageIndex: 0,
      kind: 'shapes',
      rect: null,
      contents: '',
      marker: null,
      author: '',
      modified: null,
    };
    expect(annotationIdsOf([base, { ...base, id: '5R', marker: 'abc' }])).toEqual(['4R', '5R', 'abc']);
  });
});

describe('kindForSubtype and annotationKindKey', () => {
  it('maps every subtype this app draws, whatever its case, and nothing else', () => {
    const kinds = [
      'Highlight',
      'UNDERLINE',
      'strikeout',
      'Squiggly',
      'Ink',
      'Square',
      'Circle',
      'Line',
      'Text',
      'FreeText',
    ];
    expect(kinds.map(kindForSubtype)).toEqual([
      'highlight',
      'underline',
      'strikeout',
      'squiggly',
      'ink',
      'shapes',
      'shapes',
      'shapes',
      'note',
      'note',
    ]);
    expect(kindForSubtype('Link')).toBeNull();
    expect(annotationKindKey('freetext')).toBe('ann.kind.freetext');
    expect(annotationKindKey('highlight')).toBe('ann.kind.highlight');
  });
});

describe('marksFromEngineEntries on records that are not ours to take over', () => {
  const ink = { annotationType: 15, id: null, pageIndex: 0, inkLists: [[30, 80, 90, 50]] };
  const take = (value: Record<string, unknown>) =>
    marksFromEngineEntries([{ id: 'e', value }], PAGE_BOX, DEFAULTS);

  it('skips an editor of another family, a record with no page and a page the document lacks', () => {
    expect(take({ ...ink, annotationType: 13 })).toEqual([]);
    expect(take({ ...ink, pageIndex: '0' })).toEqual([]);
    expect(take({ ...ink, pageIndex: 3 })).toEqual([]);
    expect(take({ ...ink, id: 'existing' })).toEqual([]);
  });

  it('skips ink with no usable stroke: no runs, odd runs, NaN runs, a lone point', () => {
    for (const inkLists of [[], undefined, [[1, 2, 3]], [['a', 'b']], [[7]], 'nope']) {
      expect(take({ ...ink, inkLists }), JSON.stringify(inkLists)).toEqual([]);
    }
  });

  it("takes the record's own colour, opacity, words, author and date, or the defaults", () => {
    const [own] = take({
      ...ink,
      color: [0, 128, 255],
      opacity: 0.25,
      contents: 'words',
      user: 'Ayşe',
      creationDate: 'D:20260102030405',
    });
    expect(own).toMatchObject({
      color: '#0080ff',
      opacity: 0.25,
      contents: 'words',
      author: 'Ayşe',
      createdAt: '2026-01-02T03:04:05.000Z',
      thickness: 2,
    });
    const [plain] = take({
      ...ink,
      color: ['x'],
      opacity: '1',
      contents: 4,
      user: null,
      creationDate: 'D:2026',
    });
    expect(plain).toMatchObject({
      color: '#000000',
      opacity: 1,
      contents: '',
      author: '',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const [garbled] = take({ ...ink, creationDate: 'garbage' });
    expect(garbled?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('reads ink out of a paths object without points by falling back to the file-shaped runs', () => {
    const [fromPaths] = take({ ...ink, inkLists: undefined, paths: { points: [[30, 80, 90, 50]] } });
    expect(fromPaths?.strokes).toEqual([[30, 50, 90, 80]]);
    const [fallback] = take({ ...ink, paths: { lines: [] } });
    expect(fallback?.strokes).toEqual([[30, 50, 90, 80]]);
  });
});

describe('marksFromEngineEntries on highlights', () => {
  const highlight = { annotationType: 9, id: null, pageIndex: 0 };
  const take = (value: Record<string, unknown>) =>
    marksFromEngineEntries([{ id: 'h', value }], PAGE_BOX, DEFAULTS);
  const quad = [30, 100, 60, 100, 30, 90, 60, 90];

  it("flips a text selection's 8-number quads against the page top, in either container", () => {
    for (const quadPoints of [quad, new Float32Array(quad), new Float64Array(quad)]) {
      expect(take({ ...highlight, quadPoints })).toEqual([
        expect.objectContaining({ kind: 'highlight', quads: [[30, 30, 60, 40]] }),
      ]);
    }
    // Two quads, and a run whose tail is not a whole quad: only whole quads count.
    const [two] = take({ ...highlight, quadPoints: [...quad, 10, 60, 20, 60, 10, 50, 20, 50, 1, 2, 3] });
    expect(two?.quads).toEqual([
      [30, 30, 60, 40],
      [10, 70, 20, 80],
    ]);
    expect(two?.strokes).toBeUndefined();
  });

  it('reads the legacy outline shape, and refuses a path or a non-list as quads', () => {
    expect(take({ ...highlight, quadPoints: null, outlines: { outline: quad } })).toEqual([
      expect.objectContaining({ quads: [[30, 30, 60, 40]] }),
    ]);
    const nan = Number.NaN;
    const path = [nan, nan, nan, nan, 30, 100, nan, nan, nan, nan, 60, 90];
    // A drawn path in quadPoints is not a quad list: no box, no mark.
    expect(take({ ...highlight, quadPoints: path })).toEqual([]);
    for (const quadPoints of ['x', 4, null, undefined])
      expect(take({ ...highlight, quadPoints })).toEqual([]);
    for (const outlines of [null, 'x', {}, { outline: null }, { outline: 'x' }, { outline: [1, 2, 3] }]) {
      expect(take({ ...highlight, quadPoints: null, outlines }), JSON.stringify(outlines)).toEqual([]);
    }
    // A short run is never a path, and NaN-bearing runs of plain numbers are filtered.
    expect(take({ ...highlight, outlines: { outline: [nan, 1, 2, 3, 4] } })).toEqual([]);
    expect(take({ ...highlight, outlines: { outline: [1, nan, nan, nan, 4, 5] } })).toEqual([]);
  });

  it("keeps selected text's quads over a stroke when both are present, and the thickness it gave", () => {
    const [both] = take({
      ...highlight,
      quadPoints: quad,
      thickness: 7,
      outlines: { points: [[30, 100, 60, 90]] },
    });
    expect(both).toMatchObject({ quads: [[30, 30, 60, 40]], strokes: [[30, 30, 60, 40]], thickness: 7 });
  });

  it('decodes a path whose curves carry control points, or whose points are too few', () => {
    const nan = Number.NaN;
    const curved = [nan, nan, nan, nan, 30, 80, 35, 85, 45, 85, 50, 70];
    const [mark1] = take({ ...highlight, quadPoints: null, outlines: { outline: curved } });
    expect(mark1?.strokes).toEqual([[30, 50, 50, 60]]);
    const lone = [nan, nan, nan, nan, 30, 80];
    expect(take({ ...highlight, quadPoints: null, outlines: { outline: lone } })).toEqual([]);
    expect(
      take({
        ...highlight,
        quadPoints: null,
        outlines: { outline: new Float32Array([nan, nan, nan, nan, 30, 80, nan, nan, nan, nan, 40, 60]) },
      })[0]?.strokes,
    ).toEqual([[30, 50, 40, 70]]);
  });
});

describe('annotationStorageOf', () => {
  const handleWith = (storage: unknown): PdfDocumentHandle =>
    untyped({ raw: { annotationStorage: storage } });

  it('is undefined unless the document exposes a storage with setValue and a numeric size', () => {
    for (const storage of [
      null,
      undefined,
      'x',
      {},
      { setValue() {} },
      { size: 1 },
      { setValue: 1, size: 1 },
      { setValue() {}, size: '1' },
    ]) {
      expect(annotationStorageOf(handleWith(storage)), JSON.stringify(storage)).toBeUndefined();
    }
  });

  it('forwards setValue to the engine and reads its size live', () => {
    const received: unknown[] = [];
    const storage = {
      size: 0,
      setValue(this: { size: number }, key: string, value: unknown) {
        received.push([key, value]);
        this.size += 1;
      },
    };
    const port = annotationStorageOf(handleWith(storage));
    expect(port?.size).toBe(0);
    port?.setValue('k', { a: 1 });
    expect(received).toEqual([['k', { a: 1 }]]);
    expect(port?.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// real files: pdf.js reads and writes, MuPDF names and settles
// ---------------------------------------------------------------------------

/** A file's bytes from a builder callback; every page is 400×500. */
function buildPdf(pages: number, build: (doc: BuilderDocument) => void): Uint8Array {
  const doc = new BuilderDocument();
  for (let index = 0; index < pages; index += 1) doc.insertPage(-1, doc.addPage([0, 0, 400, 500], 0, {}, ''));
  build(doc);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

async function withHandle<T>(bytes: Uint8Array, use: (handle: PdfDocumentHandle) => Promise<T>): Promise<T> {
  const handle = await openWithPdfjs(bytes);
  try {
    return await use(handle);
  } finally {
    handle.destroy();
  }
}

describe('writeAnnotations', () => {
  const blank = () => buildPdf(1, () => {});
  const ink = mark({
    id: 'ink-1',
    kind: 'ink',
    strokes: [[10, 20, 80, 90]],
    quads: [[10, 20, 80, 90]],
    contents: 'hi',
  });

  it('refuses a document that exposes no annotation storage', async () => {
    await withHandle(blank(), async (handle) => {
      const bare: PdfDocumentHandle = Object.create(handle, { raw: { value: { annotationStorage: null } } });
      const error = await rejectionOf(writeAnnotations(bare, { marks: [ink] }, RUN));
      expect(isToolError(error) && error.code).toBe('unsupported');
    });
  });

  it('refuses a mark on a page the document does not have, naming it', async () => {
    await withHandle(blank(), async (handle) => {
      const error = await rejectionOf(writeAnnotations(handle, { marks: [{ ...ink, pageIndex: 4 }] }, RUN));
      expect(isToolError(error) && error.code).toBe('range-invalid');
      expect(isToolError(error) && error.details.engineMessage).toBe('annotation ink-1 targets page 5 of 1');
    });
  });

  it('writes the marks it is given, skips the ids it is told to, and reports progress', async () => {
    await withHandle(blank(), async (handle) => {
      const progress: unknown[] = [];
      const outcome = await writeAnnotations(
        handle,
        {
          marks: [ink, { ...ink, id: 'skipped' }, { ...ink, id: 'ink-2' }],
          skipIds: ['skipped'],
          inputBytes: 5,
        },
        { ...RUN, onProgress: (event) => progress.push([event.done, event.total]) },
      );
      expect(outcome.written).toEqual(['ink-1', 'ink-2']);
      expect(progress).toEqual([
        [1, 3],
        [2, 3],
      ]);
      expect(outcome.report.inputBytes).toBe(5);
      expect(outcome.report.steps).toEqual(['pdfjs.saveDocument', 'annotations.new']);
      const settled = await settleEngineMarks(outcome.bytes, [ink, { ...ink, id: 'ink-2' }], RUN);
      expect(settled.retagged).toEqual([]);
      const read = await withHandle(settled.bytes, (written) => readAnnotations(written, RUN));
      expect(
        read
          .filter((annotation) => annotation.kind !== null)
          .map((annotation) => [annotation.kind, annotation.marker, annotation.contents]),
      ).toEqual([
        ['ink', 'ink-1', 'hi'],
        ['ink', 'ink-2', 'hi'],
      ]);
    });
  });

  it('stops at an aborted signal before saving', async () => {
    await withHandle(blank(), async (handle) => {
      const aborted = new AbortController();
      aborted.abort();
      const error = await rejectionOf(writeAnnotations(handle, { marks: [ink] }, { signal: aborted.signal }));
      expect(error).toMatchObject({ name: 'AbortError' });
      const late = new AbortController();
      const lateError = await rejectionOf(
        writeAnnotations(handle, { marks: [ink] }, { signal: late.signal, onProgress: () => late.abort() }),
      );
      expect(lateError).toMatchObject({ name: 'AbortError' });
    });
  });
});

describe('readAnnotations on odd records and odd files', () => {
  const stubHandle = (
    annotations: readonly unknown[],
    data: Uint8Array = new Uint8Array(),
    view: number[] = [0, 0, 400, 500],
  ): PdfDocumentHandle =>
    untyped({
      pageCount: 1,
      raw: {
        getPage: async () => ({ view, getAnnotations: async () => annotations }),
        getData: async () => data,
      },
    });

  it('skips records that are not objects, and reads the numeric type when the name is missing', async () => {
    const read = await readAnnotations(
      stubHandle(
        [null, 'text', 7, { annotationType: 15, rect: [1, 2, 3, 4], id: 'x' }],
        buildPdf(1, () => {}),
        [Number.NaN, 0, 1, 1],
      ),
      RUN,
    );
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({
      id: 'x',
      subtype: 'Ink',
      kind: 'ink',
      rect: [1, 2, 3, 4],
      annotationType: 15,
    });
    expect(read[0]).not.toHaveProperty('pageBox');
  });

  it('keeps the listing when the file is encrypted and its names cannot be read', async () => {
    const encrypted = buildPdf(1, () => {});
    const doc = BuilderDocument.openDocument(encrypted, 'application/pdf').asPDF();
    const locked = new Uint8Array(
      doc?.saveToBuffer('encrypt=aes-128,user-password=u,owner-password=o').asUint8Array() ?? [],
    );
    doc?.destroy();
    const read = await readAnnotations(stubHandle([{ subtype: 'Square', id: '5R' }], locked), RUN);
    expect(read).toEqual([expect.objectContaining({ id: '5R', marker: null })]);
  });

  it('lists nothing for a file without annotations', async () => {
    expect(
      await withHandle(
        buildPdf(1, () => {}),
        (handle) => readAnnotations(handle, RUN),
      ),
    ).toEqual([]);
  });

  it('names an annotation from its /NM across pages, ignoring direct dictionaries and non-dictionaries', async () => {
    const bytes = buildPdf(2, (doc) => {
      const second = doc.findPage(1);
      const named = doc.addObject({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [10, 10, 50, 50],
        NM: doc.newString(markerFor('square-1')),
      });
      second.put('Annots', [doc.newDictionary(), doc.addObject(5), named]);
    });
    const read = await withHandle(bytes, (handle) => readAnnotations(handle, RUN));
    expect(
      read
        .filter((annotation) => annotation.kind !== null)
        .map((annotation) => [annotation.pageIndex, annotation.kind, annotation.marker]),
    ).toEqual([[1, 'shapes', 'square-1']]);
  });

  it('stops at an aborted signal', async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(await rejectionOf(readAnnotations(stubHandle([]), { signal: aborted.signal }))).toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('markerTargets', () => {
  const file = () =>
    buildPdf(2, (doc) => {
      const second = doc.findPage(1);
      const square = doc.addObject({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [10, 10, 50, 50],
        NM: doc.newString(markerFor('s1')),
      });
      const popup = doc.addObject({
        Type: 'Annot',
        Subtype: 'Popup',
        Rect: [10, 10, 50, 50],
        NM: doc.newString(markerFor('s1')),
      });
      const other = doc.addObject({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [10, 10, 50, 50],
        NM: doc.newString(markerFor('other')),
      });
      const plain = doc.addObject({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 50, 50] });
      second.put('Annots', [doc.newDictionary(), doc.addObject(5), popup, plain, other, square]);
    });

  it('answers nothing for nothing asked', async () => {
    expect(await markerTargets(file(), [], RUN)).toEqual([]);
  });

  it('finds the annotation a marker names, on the page it is asked on only, never a popup', async () => {
    const found = await markerTargets(
      file(),
      [
        { pageIndex: 1, id: 's1' },
        { pageIndex: 0, id: 's1' },
        { pageIndex: 1, id: 'unknown' },
      ],
      RUN,
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ pageIndex: 1, markId: 's1' });
  });

  it('stops at an aborted signal without rewriting the abort', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const error = await rejectionOf(
      markerTargets(file(), [{ pageIndex: 1, id: 's1' }], { signal: aborted.signal }),
    );
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

describe('settleEngineMarks on files with other annotations', () => {
  it('changes nothing when it is given no mark', async () => {
    const bytes = buildPdf(1, () => {});
    const outcome = await settleEngineMarks(bytes, [], RUN);
    expect(outcome.bytes).toBe(bytes);
    expect(outcome.retagged).toEqual([]);
  });

  it('settles a marker into /NM past pages without annotations, direct dictionaries and unrelated annotations', async () => {
    const bytes = buildPdf(2, (doc) => {
      const second = doc.findPage(1);
      const tagged = doc.addObject({
        Type: 'Annot',
        Subtype: 'Ink',
        Rect: [10, 10, 50, 50],
        Contents: doc.newString(`${markerFor('i1')} words`),
      });
      const stranger = doc.addObject({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [1, 1, 5, 5],
        Contents: doc.newString('mine'),
      });
      second.put('Annots', [doc.newDictionary(), doc.addObject(5), stranger, tagged]);
    });
    const progress: unknown[] = [];
    const outcome = await settleEngineMarks(
      bytes,
      [mark({ id: 'i1', kind: 'ink', pageIndex: 1, strokes: [[10, 10, 50, 50]], contents: 'words' })],
      { ...RUN, onProgress: (event) => progress.push([event.done, event.total]) },
    );
    // A page with no /Annots is skipped before its progress event, so only the second page reports.
    expect(progress).toEqual([[2, 2]]);
    expect(outcome.retagged).toEqual([]);
    const read = await withHandle(outcome.bytes, (handle) => readAnnotations(handle, RUN));
    expect(
      read
        .filter((annotation) => annotation.kind !== null)
        .map((annotation) => [annotation.kind, annotation.marker, annotation.contents]),
    ).toEqual([
      ['shapes', null, 'mine'],
      ['ink', 'i1', 'words'],
    ]);
  });

  it('stops at an aborted signal without rewriting the abort', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const error = await rejectionOf(
      settleEngineMarks(
        buildPdf(1, () => {}),
        [mark()],
        { signal: aborted.signal },
      ),
    );
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

describe('readAnnotations on records with partial fields', () => {
  const stub = (
    annotations: readonly unknown[],
    data: Uint8Array,
    signal?: AbortController,
  ): PdfDocumentHandle =>
    untyped({
      pageCount: 1,
      raw: {
        getPage: async () => ({ view: [0, 0, 400, 500], getAnnotations: async () => annotations }),
        getData: async () => {
          signal?.abort();
          return data;
        },
      },
    });
  const blank = () => buildPdf(1, () => {});

  it('reads colour, thickness, replies and words, and drops what is not a number or a string', async () => {
    const read = await readAnnotations(
      stub(
        [
          {
            subtype: 'Square',
            id: 'a',
            color: [255, 300, -4],
            borderStyle: { width: 3 },
            contentsObj: { str: 'words' },
          },
          {
            subtype: 'Square',
            id: 'b',
            color: [1, 2],
            borderStyle: { width: 0 },
            contentsObj: { str: 5 },
            contents: 'plain',
          },
          { subtype: 'Square', id: 'c', color: ['x', 2, 3], replyType: 'Group', inReplyTo: '4R' },
          { subtype: 'Square', id: 'd', color: [Number.NaN, 2, 3], inReplyTo: '4R' },
          { subtype: 'Square', color: new Uint8ClampedArray([9, 8, 7]), rect: [1, 2, 3] },
          { subtype: 'Square', id: 'f', color: 'red', state: { name: 'Accepted' }, stateModel: 'Review' },
        ],
        blank(),
      ),
      RUN,
    );
    expect(read.map((annotation) => annotation.color)).toEqual([
      '#ffff00',
      undefined,
      undefined,
      undefined,
      '#090807',
      undefined,
    ]);
    expect(read[0]).toMatchObject({ thickness: 3, contents: 'words' });
    expect(read[1]).not.toHaveProperty('thickness');
    expect(read[1]?.contents).toBe('plain');
    expect(read[2]).toMatchObject({ replyType: 'Group', inReplyTo: '4R' });
    expect(read[3]).toMatchObject({ replyType: 'R', inReplyTo: '4R' });
    expect(read[0]).not.toHaveProperty('replyType');
    expect(read[4]).toMatchObject({ id: '0-4', rect: null });
    expect(read[5]).toMatchObject({ state: 'Accepted', stateModel: 'Review' });
  });

  it('keeps the strokes of an ink list that are runs of at least one point, and no list otherwise', async () => {
    const read = await readAnnotations(
      stub(
        [
          { subtype: 'Ink', id: 'a', inkLists: [[1, 2, 3, 4], 'x', [7], new Float32Array([5, 6])] },
          { subtype: 'Ink', id: 'b', inkLists: ['x', [7]] },
          { subtype: 'Ink', id: 'c', inkLists: 'nope' },
        ],
        blank(),
      ),
      RUN,
    );
    expect(read[0]?.inkLists).toEqual([
      [1, 2, 3, 4],
      [5, 6],
    ]);
    expect(read[1]).not.toHaveProperty('inkLists');
    expect(read[2]).not.toHaveProperty('inkLists');
  });

  it('refuses a listing whose file the second reader cannot open at all', async () => {
    const error = await rejectionOf(
      readAnnotations(stub([{ subtype: 'Square', id: '5R' }], new Uint8Array([1, 2, 3])), RUN),
    );
    expect(isToolError(error) && error.code).toBe('corrupt-document');
  });

  it('stops when the signal aborts while the file is being named, without rewriting the abort', async () => {
    const controller = new AbortController();
    const error = await rejectionOf(
      readAnnotations(stub([{ subtype: 'Square', id: '5R' }], blank(), controller), {
        signal: controller.signal,
      }),
    );
    expect(error).toMatchObject({ name: 'AbortError' });
  });
});

describe('marksFromEngineEntries on short colours and mixed paths', () => {
  it('pads a colour with fewer than three components with zeros', () => {
    const [red] = marksFromEngineEntries(
      [
        {
          id: 'c',
          value: { annotationType: 15, id: null, pageIndex: 0, inkLists: [[30, 80, 90, 50]], color: [255] },
        },
      ],
      PAGE_BOX,
      DEFAULTS,
    );
    expect(red?.color).toBe('#ff0000');
  });

  it('does not read a path that holds anything but numbers', () => {
    const nan = Number.NaN;
    const entry = { annotationType: 9, id: null, pageIndex: 0, quadPoints: null };
    expect(
      marksFromEngineEntries(
        [
          {
            id: 'p',
            value: {
              ...entry,
              outlines: { outline: [nan, nan, nan, nan, 30, 'x', nan, nan, nan, nan, 40, 60] },
            },
          },
        ],
        PAGE_BOX,
        DEFAULTS,
      ),
    ).toEqual([]);
  });
});

describe('markerTargets on a later generation', () => {
  it('answers with the 17R5 spelling pdf.js reports', async () => {
    const bytes = generationFivePdf(markerFor('g5'));
    const found = await markerTargets(bytes, [{ pageIndex: 0, id: 'g5' }], RUN);
    expect(found).toEqual([{ pageIndex: 0, id: '17R5', markId: 'g5' }]);
  });
});

describe('settleEngineMarks on a tagged annotation', () => {
  const tagged = (subtype: string, contents: string) =>
    buildPdf(1, (doc) => {
      doc.findPage(0).put('Annots', [
        doc.addObject({
          Type: 'Annot',
          Subtype: subtype,
          Rect: [10, 10, 60, 30],
          QuadPoints: [10, 30, 60, 30, 10, 10, 60, 10],
          Contents: doc.newString(contents),
        }),
      ]);
    });

  it('drops /Contents when the mark has no words, keeping the name', async () => {
    const outcome = await settleEngineMarks(
      tagged('Square', `${markerFor('s1')} stale words`),
      [mark({ id: 's1', kind: 'shapes', rect: [10, 10, 60, 30], contents: '  ' })],
      RUN,
    );
    const read = await withHandle(outcome.bytes, (handle) => readAnnotations(handle, RUN));
    expect(read[0]).toMatchObject({ marker: 's1', contents: '' });
  });

  it('refuses a retag whose mark carries a colour that is not #rrggbb', async () => {
    const error = await rejectionOf(
      settleEngineMarks(
        tagged('Highlight', markerFor('u1')),
        [mark({ id: 'u1', kind: 'underline', quads: [[10, 470, 60, 490]], color: 'red' })],
        RUN,
      ),
    );
    expect(isToolError(error) && error.code).toBe('internal');
    expect(isToolError(error) && error.details.engineMessage).toBe('annotation colour is not #rrggbb: red');
  });

  it("leaves a non-dictionary entry of /Annots alone and skips a popup's subtype change", async () => {
    const bytes = buildPdf(1, (doc) => {
      const parent = doc.addObject({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 60, 30] });
      const popup = doc.addObject({
        Type: 'Annot',
        Subtype: 'Popup',
        Rect: [70, 10, 120, 30],
        Parent: parent,
        Contents: doc.newString(markerFor('s1')),
      });
      doc.findPage(0).put('Annots', [doc.addObject(5), parent, popup]);
    });
    const outcome = await settleEngineMarks(
      bytes,
      [mark({ id: 's1', kind: 'shapes', rect: [10, 10, 60, 30] })],
      RUN,
    );
    expect(outcome.retagged).toEqual([]);
    const reread = BuilderDocument.openDocument(outcome.bytes, 'application/pdf').asPDF();
    const annots = reread?.findPage(0).get('Annots');
    expect(annots?.get(0).resolve().asNumber()).toBe(5);
    // The popup lost its marker line (its comment is the mark's words, here none) but took no name.
    expect(annots?.get(2).resolve().get('Contents').isNull()).toBe(true);
    expect(annots?.get(2).resolve().get('NM').isNull()).toBe(true);
    reread?.destroy();
  });
});
