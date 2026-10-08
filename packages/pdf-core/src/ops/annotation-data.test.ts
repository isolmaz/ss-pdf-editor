/**
 * Comment exchange files. The wrong answers that matter: a note that comes back from
 * its own export with no place on the page (its place is in `rect`, not `quads`), and
 * an Acrobat comment that lands mirrored about the page's middle because its user-space
 * coordinates were read as the app's top-left space.
 */

import { isToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import {
  isoFromAcrobatDate,
  parseAcrobatCommentsFdf,
  parseAnnotationData,
  parseAnnotationsFdf,
  parseAnnotationsJson,
  serializeAnnotationsFdf,
  serializeAnnotationsJson,
  toAppSpace,
} from './annotation-data';
import { type AnnotationMark, commentText, taggedContents } from './annotations';
import { serializeFdf } from './form-data';

function note(): AnnotationMark {
  return {
    id: 'n1',
    kind: 'note',
    pageIndex: 1,
    quads: [],
    rect: [100, 120, 124, 144],
    color: '#ffd400',
    opacity: 0.8,
    contents: 'Kontrol et',
    author: 'Ayşe',
    createdAt: '2026-09-28T10:00:00.000Z',
  };
}

function typed(): AnnotationMark {
  return {
    ...note(),
    id: 't1',
    kind: 'freetext',
    rect: [50, 60, 270, 79],
    contents: 'Merhaba dünya',
    color: '#000000',
    opacity: 1,
    fontSize: 14,
  };
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('annotation data round trip', () => {
  it('keeps a note and a text box where they were, through JSON', () => {
    const parsed = parseAnnotationsJson(decode(serializeAnnotationsJson([note(), typed()], 3)));
    expect(parsed.space).toBe('app');
    expect(parsed.skipped).toBe(0);
    const [first, second] = parsed.marks;
    expect(first?.rect).toEqual([100, 120, 124, 144]);
    expect(second).toMatchObject({ kind: 'freetext', rect: [50, 60, 270, 79], fontSize: 14 });
  });

  it('keeps a note and a text box where they were, through the FDF records', () => {
    const parsed = parseAnnotationData(serializeAnnotationsFdf([note(), typed()], 3));
    expect(parsed.space).toBe('app');
    expect(parsed.marks.map((mark) => mark.rect)).toEqual([
      [100, 120, 124, 144],
      [50, 60, 270, 79],
    ]);
    expect(parsed.marks[1]?.fontSize).toBe(14);
  });
});

describe('annotation data with Turkish text and a thread', () => {
  const threaded = (): AnnotationMark => ({
    ...note(),
    contents: 'Şişli ığüöç (kontrol) \\ İĞÜŞÖÇ',
    replies: [
      { id: 'r1', author: 'Mehmet', contents: 'Düzelttim: çağrı', createdAt: '2026-10-02T08:00:00.000Z' },
    ],
    review: { state: 'Accepted', author: 'Mehmet', at: '2026-10-03T08:00:00.000Z' },
  });

  it.each([
    ['FDF', () => parseAnnotationData(serializeAnnotationsFdf([threaded()], 3))],
    ['JSON', () => parseAnnotationsJson(decode(serializeAnnotationsJson([threaded()], 3)))],
  ])('%s keeps the words whole, the reply and the review, and mints a new reply id', (_name, read) => {
    const [mark] = read().marks;
    expect(mark?.contents).toBe('Şişli ığüöç (kontrol) \\ İĞÜŞÖÇ');
    expect(mark?.author).toBe('Ayşe');
    expect(mark?.replies).toHaveLength(1);
    expect(mark?.replies?.[0]).toMatchObject({
      author: 'Mehmet',
      contents: 'Düzelttim: çağrı',
      createdAt: '2026-10-02T08:00:00.000Z',
    });
    expect(mark?.replies?.[0]?.id).not.toBe('r1');
    expect(mark?.review).toEqual({ state: 'Accepted', author: 'Mehmet', at: '2026-10-03T08:00:00.000Z' });
  });

  it('refuses text that is neither FDF nor JSON, and an FDF that carries no annotation records', () => {
    expect(() => parseAnnotationData(new TextEncoder().encode('hello'))).toThrow(/annotation data file/);
    const form = serializeFdf([{ name: 'customer', value: 'Ada' }]);
    expect(() => parseAnnotationData(form)).toThrow();
    expect(() => parseAnnotationsJson('{"marks": 3}')).toThrow(/no marks array/);
  });
});

describe('toAppSpace', () => {
  it('mirrors user-space geometry about the page top, keeping each box ordered', () => {
    const inUserSpace: AnnotationMark = {
      ...note(),
      kind: 'ink',
      quads: [[10, 700, 60, 740]],
      rect: [10, 700, 60, 740],
      strokes: [[10, 700, 60, 740]],
    };
    const placed = toAppSpace(inUserSpace, 842);
    expect(placed.quads).toEqual([[10, 102, 60, 142]]);
    expect(placed.rect).toEqual([10, 102, 60, 142]);
    expect(placed.strokes).toEqual([[10, 142, 60, 102]]);
  });

  it('mirrors a line`s two ends point by point, so it keeps its direction', () => {
    const line: AnnotationMark = {
      ...note(),
      kind: 'shapes',
      shape: 'line',
      quads: [[10, 700, 60, 740]],
      rect: [60, 740, 10, 700],
    };
    expect(toAppSpace(line, 842).rect).toEqual([60, 102, 10, 142]);
  });
});

describe('commentText', () => {
  it('shows the words of a comment an older write tagged with its marker, without the marker', () => {
    expect(commentText(taggedContents(note()))).toBe('Kontrol et');
  });

  it('shows nothing for a mark written without a comment', () => {
    expect(commentText(taggedContents({ ...note(), contents: '' }))).toBe('');
  });

  it('leaves a comment from another application as it is', () => {
    expect(commentText('Reviewed by legal')).toBe('Reviewed by legal');
  });
});

describe('serializeAnnotationsJson layout', () => {
  it('is indented for people by default and compact on request, with the same content', () => {
    const pretty = decode(serializeAnnotationsJson([note()], 3));
    const compact = decode(serializeAnnotationsJson([note()], 3, false));
    expect(pretty).toContain('\n  "marks"');
    expect(compact).not.toContain('\n');
    expect(JSON.parse(compact)).toEqual(JSON.parse(pretty));
  });
});

describe('annotation data details', () => {
  it('writes no reply record for a mark without replies, and one for a mark with them', () => {
    const plain = decode(serializeAnnotationsFdf([{ ...note(), replies: [] }], 3));
    expect(plain).not.toContain('replies');
    const reply = { id: 'r', author: 'A', contents: 'x', createdAt: '2026-10-02T08:00:00.000Z' };
    expect(decode(serializeAnnotationsFdf([{ ...note(), replies: [reply] }], 3))).toContain('replies');
    expect(decode(serializeAnnotationsJson([{ ...note(), replies: [] }], 3, false))).not.toContain('replies');
  });

  it('reads an FDF with no records at all as an empty review, not as a foreign file', () => {
    const parsed = parseAnnotationData(serializeFdf([]));
    expect(parsed.marks).toEqual([]);
    expect(parsed.skipped).toBe(0);
  });

  it('keeps a mark on the first page, and skips one with a negative page', () => {
    const base = JSON.parse(decode(serializeAnnotationsJson([note()], 3))) as {
      marks: Record<string, unknown>[];
    };
    const withPage = (pageIndex: number) =>
      parseAnnotationsJson(JSON.stringify({ marks: [{ ...base.marks[0], pageIndex }] }));
    expect(withPage(0).marks[0]?.pageIndex).toBe(0);
    expect(withPage(-1).skipped).toBe(1);
  });

  it('ignores array entries that are neither text nor objects', () => {
    const base = JSON.parse(decode(serializeAnnotationsJson([note()], 3))) as {
      marks: Record<string, unknown>[];
    };
    for (const junk of [[5], [null], [true]]) {
      const parsed = parseAnnotationsJson(JSON.stringify({ marks: [{ ...base.marks[0], strokes: junk }] }));
      expect(parsed.marks[0]?.strokes).toBeUndefined();
    }
  });
});

describe('Acrobat comment FDF', () => {
  const fdf = (...dictionaries: string[]): Uint8Array =>
    new TextEncoder().encode(
      `%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ ${dictionaries
        .map((dictionary, at) => `<< /T (c${at}) /V (${dictionary}) >>`)
        .join(' ')} ] >> >>\nendobj\n%%EOF\n`,
    );

  it('reads a highlight: kind, colour, boxes, text, author, opacity, date and its own id', () => {
    const parsed = parseAnnotationData(
      fdf(
        '<< /Subtype /Highlight /NM (guid-1) /Page 0 /Rect [10 20 110 40] /C [1 0 0] /CA 0.5 ' +
          '/QuadPoints [10 40 110 40 10 20 110 20] /Contents (Merhaba) /T (Ayse) /M (D:20261002080000) >>',
      ),
    );
    expect(parsed.space).toBe('pdf-user');
    expect(parsed.skipped).toBe(0);
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.marks[0]).toMatchObject({
      id: 'guid-1',
      kind: 'highlight',
      pageIndex: 0,
      quads: [[10, 20, 110, 40]],
      rect: [10, 20, 110, 40],
      color: '#ff0000',
      opacity: 0.5,
      contents: 'Merhaba',
      author: 'Ayse',
      createdAt: '2026-10-02T08:00:00.000Z',
    });
    expect(parsed.pageUnknown).toBe(0);
  });

  it('names a comment after its field when it has no id, and by position when it has neither', () => {
    const [byField] = parseAnnotationData(fdf('<< /Subtype /Text /Rect [1 2 3 4] >>')).marks;
    expect(byField?.id).toBe('c0');
    const withId = parseAnnotationData(fdf('<< /Subtype /Text /NM (own) /Rect [1 2 3 4] >>')).marks[0];
    expect(withId?.id).toBe('own');
    const unnamed = new TextEncoder().encode(
      '%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ << /T () /V (<< /Subtype /Text /Rect [1 2 3 4] >>) >> ] >> >>\nendobj\n',
    );
    expect(parseAnnotationData(unnamed).marks[0]?.id).toBe('acrobat-0');
  });

  it('falls back to the rect when there are no quad points, and skips a comment with no place', () => {
    const parsed = parseAnnotationData(
      fdf('<< /Subtype /Square /Rect [1 2 3 4] >>', '<< /Subtype /Highlight /Rect [1 2 3] >>'),
    );
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.marks[0]?.quads).toEqual([[1, 2, 3, 4]]);
    expect(parsed.marks[0]).toMatchObject({ kind: 'shapes', shape: 'square' });
    expect(parsed.skipped).toBe(1);
    expect(parsed.pageUnknown).toBe(1);
  });

  it('keeps an ink stroke of exactly two points and drops a shorter one', () => {
    const parsed = parseAnnotationData(fdf('<< /Subtype /Ink /Rect [0 0 9 9] /InkList [[1 2 3 4] [5 6]] >>'));
    expect(parsed.marks[0]?.strokes).toEqual([[1, 2, 3, 4]]);
  });

  it('clamps a colour channel and reads a grey value as the three channels', () => {
    const [bright, grey] = parseAnnotationData(
      fdf(
        '<< /Subtype /Underline /Rect [1 2 3 4] /C [2 0.5 0] >>',
        '<< /Subtype /Underline /Rect [1 2 3 4] /C [0.2] >>',
      ),
    ).marks;
    expect(bright?.color).toBe('#ff8000');
    expect(grey?.color).toBe('#333333');
  });
});

// ---------------------------------------------------------------------------
// the whole record model, and the readers' refusals
// ---------------------------------------------------------------------------

/** A mark with every optional field set. */
function full(): AnnotationMark {
  return {
    id: 'f1',
    kind: 'shapes',
    pageIndex: 2,
    quads: [[1.23456, 2, 30, 40]],
    rect: [5, 6, 50, 60],
    strokes: [[1, 2, 3.14262, 4]],
    shape: 'circle',
    rotation: 90,
    thickness: 3,
    fontSize: 11,
    color: '#102030',
    opacity: 0.6,
    contents: 'words',
    author: 'Ayşe',
    createdAt: '2026-09-28T10:00:00.000Z',
    replies: [{ id: 'r1', author: 'Can', contents: 'agreed', createdAt: '2026-09-29T10:00:00.000Z' }],
    review: { state: 'Accepted', author: 'Can', at: '2026-09-30T10:00:00.000Z' },
  };
}

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function refusal(call: () => unknown): string {
  let message: string | null = null;
  try {
    call();
  } catch (error) {
    if (!isToolError(error)) throw error;
    message = `${error.code}: ${error.details.engineMessage}`;
  }
  if (message === null) throw new Error('the call returned instead of throwing');
  return message;
}

describe('every field of a mark survives both containers', () => {
  const expected = {
    kind: 'shapes',
    pageIndex: 2,
    quads: [[1.235, 2, 30, 40]],
    rect: [5, 6, 50, 60],
    strokes: [[1, 2, 3.143, 4]],
    shape: 'circle',
    rotation: 90,
    thickness: 3,
    fontSize: 11,
    color: '#102030',
    opacity: 0.6,
    contents: 'words',
    author: 'Ayşe',
    createdAt: '2026-09-28T10:00:00.000Z',
    review: { state: 'Accepted', author: 'Can', at: '2026-09-30T10:00:00.000Z' },
  };

  it.each([
    ['JSON', () => parseAnnotationsJson(decode(serializeAnnotationsJson([full()], 5)))],
    ['FDF', () => parseAnnotationsFdf(serializeAnnotationsFdf([full()], 5))],
  ])('through %s', (_name, read) => {
    const parsed = read();
    expect(parsed.pageCount).toBe(5);
    expect(parsed.skipped).toBe(0);
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.marks[0]).toMatchObject(expected);
    // A reply keeps its words and author but gets a fresh id: an import is a new review.
    expect(parsed.marks[0]?.replies).toEqual([
      { id: expect.any(String), author: 'Can', contents: 'agreed', createdAt: '2026-09-29T10:00:00.000Z' },
    ]);
    expect(parsed.marks[0]?.replies?.[0]?.id).not.toBe('r1');
    expect(parsed.marks[0]?.id).not.toBe('f1');
  });
});

describe('a record set that is not a drawable mark', () => {
  const json = (...marks: unknown[]) => parseAnnotationsJson(JSON.stringify({ marks }));
  const base = { kind: 'highlight', pageIndex: 0, quads: ['1 2 3 4'] };

  it('skips and counts each way a mark can be unusable', () => {
    const parsed = json(
      base,
      { ...base, kind: 'sticker' },
      { ...base, kind: undefined },
      { ...base, pageIndex: undefined },
      { ...base, pageIndex: -2 },
      { ...base, quads: [] },
      { ...base, quads: ['1 2 3'] },
      { ...base, rotation: 45 },
      { ...base, page: 'x', pageIndex: 'x' },
      null,
      'text',
    );
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.skipped).toBe(10);
  });

  it('reads a mark with only a rect, quads spelled with commas and a single string, and booleans away', () => {
    const [byRect, commas, single] = json(
      { kind: 'note', pageIndex: 1, rect: '1 2 3 4' },
      { ...base, quads: ['1,2, 3 ,4', 'x y z w', '5 6 7 8 9'] },
      { ...base, quads: '9 8 7 6', flag: true, nothing: null },
    ).marks;
    expect(byRect).toMatchObject({ kind: 'note', rect: [1, 2, 3, 4], quads: [] });
    expect(commas?.quads).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(single?.quads).toEqual([[9, 8, 7, 6]]);
  });

  it('applies the defaults, clamps the opacity and accepts every turn', () => {
    const [plain, faint, solid, turned] = json(
      base,
      { ...base, opacity: 0 },
      { ...base, opacity: 5 },
      { ...base, rotation: 270, createdAt: '2026-01-01T00:00:00.000Z', thickness: 'x', fontSize: 'y' },
    ).marks;
    expect(plain).toMatchObject({ color: '#ffd400', opacity: 0.4, contents: '', author: '' });
    expect(plain?.createdAt).toMatch(/^\d{4}-/);
    expect(plain).not.toHaveProperty('thickness');
    expect(plain).not.toHaveProperty('rotation');
    expect(faint?.opacity).toBe(0.02);
    expect(solid?.opacity).toBe(1);
    expect(turned).toMatchObject({ rotation: 270, createdAt: '2026-01-01T00:00:00.000Z' });
    expect(turned).not.toHaveProperty('thickness');
    expect(turned).not.toHaveProperty('fontSize');
  });

  it('keeps the replies that are readable and the review that is valid, and drops the rest', () => {
    const [mark] = json({
      ...base,
      replies: [
        { author: 'A', contents: 'ok', createdAt: '2026-01-01T00:00:00.000Z' },
        { contents: 'no author, no date' },
        { author: 'B', contents: '   ' },
        { author: 'C' },
        7,
        null,
      ],
      review: { state: 'Rejected' },
    }).marks;
    expect(mark?.replies?.map((reply) => [reply.author, reply.contents])).toEqual([
      ['A', 'ok'],
      ['', 'no author, no date'],
    ]);
    expect(mark?.replies?.[1]?.createdAt).toMatch(/^\d{4}-/);
    expect(mark?.review).toMatchObject({ state: 'Rejected', author: '' });
    expect(mark?.review?.at).toMatch(/^\d{4}-/);
    const [none, badState, notObject] = json(
      { ...base, review: { state: 'Bogus' } },
      { ...base, review: { state: 7 } },
      { ...base, review: 'x' },
    ).marks;
    for (const bad of [none, badState, notObject]) expect(bad).not.toHaveProperty('review');
    expect(json({ ...base, replies: [] }).marks[0]).not.toHaveProperty('replies');
  });
});

describe('the record containers refuse what is not theirs', () => {
  it('refuses JSON that is not parseable, not an object or without a marks array', () => {
    expect(refusal(() => parseAnnotationsJson('{'))).toMatch(
      /^unsupported-format: annotation JSON is not parseable: SyntaxError/,
    );
    expect(refusal(() => parseAnnotationsJson('[]'))).toBe(
      'unsupported-format: annotation JSON must be an object',
    );
    expect(refusal(() => parseAnnotationsJson('null'))).toBe(
      'unsupported-format: annotation JSON must be an object',
    );
    expect(refusal(() => parseAnnotationsJson('{"marks":3}'))).toBe(
      'unsupported-format: annotation JSON carries no marks array',
    );
  });

  it('reads a page count only when it is a number', () => {
    expect(parseAnnotationsJson('{"marks":[],"pageCount":"4"}').pageCount).toBeNull();
    expect(parseAnnotationsJson('{"marks":[],"pageCount":4}').pageCount).toBe(4);
  });

  it('refuses an FDF of other records and skips malformed record names and counts', () => {
    const foreign = serializeFdf([{ name: 'name', value: 'x' }]);
    expect(refusal(() => parseAnnotationsFdf(foreign))).toBe(
      'unsupported-format: FDF file carries no ann.* records',
    );
    const parsed = parseAnnotationsFdf(
      serializeFdf([
        { name: 'ann.pageCount', value: 'many' },
        { name: 'ann.version', value: '1' },
        { name: 'ann.1.kind', value: 'highlight' },
        { name: 'ann.1.page', value: '0' },
        { name: 'ann.1.quads', value: ['1 2 3 4'] },
        { name: 'ann.0.kind', value: 'bogus' },
        { name: 'ann.2.kind', value: true },
        { name: 'ann.2.', value: 'x' },
      ]),
    );
    expect(parsed.pageCount).toBeNull();
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.marks[0]?.quads).toEqual([[1, 2, 3, 4]]);
    expect(parsed.skipped).toBe(2);
  });

  it('refuses a file that is neither FDF nor JSON, and passes a non-FDF text to the Acrobat reader as refused', () => {
    expect(refusal(() => parseAnnotationData(bytesOf('hello')))).toBe(
      'unsupported-format: not an annotation data file (neither JSON nor FDF)',
    );
    expect(refusal(() => parseAcrobatCommentsFdf(bytesOf('%PDF-1.7')))).toBe(
      'unsupported-format: not an FDF file',
    );
    expect(refusal(() => parseAnnotationData(bytesOf('{"marks":"x"}')))).toBe(
      'unsupported-format: annotation JSON carries no marks array',
    );
  });
});

describe('Acrobat comment FDF in every shape it comes in', () => {
  const entries = (...fields: string[]): Uint8Array =>
    bytesOf(`%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ ${fields.join(' ')} ] >> >>\nendobj\n%%EOF\n`);
  const asString = (name: string, dictionary: string) => `<< /T (${name}) /V (${dictionary}) >>`;

  it('refuses a comment file with no annotation at all', () => {
    expect(refusal(() => parseAcrobatCommentsFdf(entries()))).toBe(
      'unsupported-format: the FDF carries no /Fields entries that look like annotations',
    );
  });

  it('reads an annotation stored as a dictionary, counts a value that is not one, and skips an unknown subtype', () => {
    const parsed = parseAcrobatCommentsFdf(
      entries(
        '<< /T (direct) /V << /Subtype /Text /Rect [1 2 3 4] /Page 2 /Contents (hi) >> >>',
        '<< /T (plain) /V (just words) >>',
        '<< /T (num) /V 5 >>',
        asString('stamp', '<< /Subtype /Stamp /Rect [1 2 3 4] >>'),
        '<< /T (open) >>',
        '<< /V (x) >>',
        '<< /T /V (x) >>',
        '<< /T (end) /V',
      ),
    );
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.marks[0]).toMatchObject({ id: 'direct', kind: 'note', pageIndex: 2, contents: 'hi' });
    // Unreadable: the words, the number and the entry whose value is cut off by the array's end; skipped: the stamp.
    expect(parsed.skipped).toBe(4);
    expect(parsed.pageUnknown).toBe(0);
    expect(parsed.space).toBe('pdf-user');
  });

  it('places a comment with a negative or fractional /Page on a real page, and one with none on page 1', () => {
    const parsed = parseAcrobatCommentsFdf(
      entries(
        asString('a', '<< /Subtype /Text /Rect [1 2 3 4] /Page -3 >>'),
        asString('b', '<< /Subtype /Text /Rect [1 2 3 4] /Page 1.9 >>'),
        asString('c', '<< /Subtype /Text /Rect [1 2 3 4] >>'),
      ),
    );
    expect(parsed.marks.map((mark) => mark.pageIndex)).toEqual([0, 1, 0]);
    expect(parsed.pageUnknown).toBe(1);
  });

  it("takes a typed box's size and ink colour from /DA, and its opacity, words and colour from the rest", () => {
    const [typedBox, plainBox, grey] = parseAcrobatCommentsFdf(
      entries(
        asString(
          't',
          '<< /Subtype /FreeText /Rect [1 2 3 4] /DA (/Helv 12 Tf 0 0 1 rg) /CA 3 /Contents (a) /T (me) >>',
        ),
        asString('u', '<< /Subtype /FreeText /Rect [1 2 3 4] /DA (/Helv Tf) /CA -1 >>'),
        asString('g', '<< /Subtype /Highlight /Rect [1 2 3 4] /C 0.5 /M (D:2026) /NM 77 >>'),
      ),
    ).marks;
    expect(typedBox).toMatchObject({
      kind: 'freetext',
      fontSize: 12,
      color: '#0000ff',
      opacity: 1,
      contents: 'a',
      author: 'me',
    });
    expect(plainBox).toMatchObject({ color: '#000000', opacity: 0 });
    expect(plainBox).not.toHaveProperty('fontSize');
    expect(grey).toMatchObject({ id: '77', color: '#808080', createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it("reads quad points in any corner order, ink strokes, a shape's subtype and a missing colour", () => {
    const [quad, ink, circle, none] = parseAcrobatCommentsFdf(
      entries(
        asString(
          'q',
          '<< /Subtype /Underline /QuadPoints [30 40 10 40 30 20 10 20 5 6 7 8 9 10 11 12] /C [] >>',
        ),
        asString('i', '<< /Subtype /Ink /Rect [0 0 9 9] /InkList [[1 2 3 4 5 6] 7 [8]] >>'),
        asString('c', '<< /Subtype /Circle /Rect [1 2 3 4] /C [0.1 0.2] >>'),
        asString('n', '<< /Subtype /Squiggly /Rect [1 2 3 4] >>'),
      ),
    ).marks;
    expect(quad?.quads).toEqual([
      [10, 20, 30, 40],
      [5, 6, 11, 12],
    ]);
    expect(quad?.color).toBe('#f5c400');
    expect(ink?.strokes).toEqual([[1, 2, 3, 4, 5, 6]]);
    expect(circle).toMatchObject({ kind: 'shapes', shape: 'circle', color: '#1a1a1a' });
    expect(none).toMatchObject({ kind: 'squiggly', color: '#f5c400' });
  });

  it('turns an Acrobat date into ISO and anything else into now', () => {
    expect(isoFromAcrobatDate(" D:20261002080910+03'00' ")).toBe('2026-10-02T08:09:10.000Z');
    expect(isoFromAcrobatDate('D:202610')).toBe('2026-10-01T00:00:00.000Z');
    expect(isoFromAcrobatDate('yesterday')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('annotation data corners', () => {
  const highlight: AnnotationMark = {
    id: 'h1',
    kind: 'highlight',
    pageIndex: 0,
    quads: [[1, 2, 3, 4]],
    color: '#ffd400',
    opacity: 0.4,
    contents: '',
    author: '',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('writes nothing for the optional fields a mark does not have', () => {
    const json = JSON.parse(decode(serializeAnnotationsJson([highlight], 1, false))) as { marks: object[] };
    expect(Object.keys(json.marks[0] ?? {}).sort()).toEqual(
      ['author', 'color', 'contents', 'createdAt', 'kind', 'opacity', 'pageIndex', 'quads'].sort(),
    );
    const parsed = parseAnnotationsFdf(serializeAnnotationsFdf([highlight], 1));
    expect(parsed.marks[0]).not.toHaveProperty('rect');
    expect(parsed.marks[0]).not.toHaveProperty('strokes');
  });

  it('mirrors a mark that has no rect or strokes without inventing them', () => {
    const flipped = toAppSpace(highlight, 100);
    expect(flipped.quads).toEqual([[1, 96, 3, 98]]);
    expect(flipped).not.toHaveProperty('rect');
    expect(flipped).not.toHaveProperty('strokes');
  });

  it("mirrors a box's rect as a box and its strokes point by point", () => {
    const flipped = toAppSpace(
      { ...highlight, kind: 'freetext', rect: [10, 20, 30, 50], strokes: [[1, 2, 3, 4]] },
      100,
    );
    expect(flipped.rect).toEqual([10, 50, 30, 80]);
    expect(flipped.strokes).toEqual([[1, 98, 3, 96]]);
    expect(flipped.quads).toEqual([[1, 96, 3, 98]]);
  });

  it('reads an FDF whose records are empty arrays, empty strings, or reply and review texts that are not records', () => {
    const [mark] = parseAnnotationsFdf(
      serializeFdf([
        { name: 'ann.0.kind', value: 'note' },
        { name: 'ann.0.page', value: '0' },
        { name: 'ann.0.quads', value: '' },
        { name: 'ann.0.rect', value: '1 2 3 4' },
        { name: 'ann.0.color', value: [] },
        { name: 'ann.0.replies', value: ['null', '7', 'not json', '{"contents":"kept"}'] },
        { name: 'ann.0.review', value: 'null' },
      ]),
    ).marks;
    expect(mark).toMatchObject({ kind: 'note', rect: [1, 2, 3, 4], color: '#ffd400' });
    expect(mark?.replies?.map((reply) => reply.contents)).toEqual(['kept']);
    expect(mark).not.toHaveProperty('review');
    const [numeric] = parseAnnotationsFdf(
      serializeFdf([
        { name: 'ann.0.kind', value: 'note' },
        { name: 'ann.0.page', value: '0' },
        { name: 'ann.0.rect', value: '1 2 3 4' },
        { name: 'ann.0.review', value: '7' },
      ]),
    ).marks;
    expect(numeric).not.toHaveProperty('review');
    expect(
      parseAnnotationsJson('{"marks":[{"kind":"note","pageIndex":0,"rect":"1 2 3 4","quads":""}]}').marks,
    ).toHaveLength(1);
  });

  it('ignores a record whose index is too long to be a number', () => {
    const parsed = parseAnnotationsFdf(
      serializeFdf([
        { name: `ann.${'9'.repeat(400)}.kind`, value: 'note' },
        { name: 'ann.0.kind', value: 'note' },
        { name: 'ann.0.page', value: '0' },
        { name: 'ann.0.rect', value: '1 2 3 4' },
      ]),
    );
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.skipped).toBe(0);
  });

  it('orders marks by their index, not by where their records sit', () => {
    const record = (index: number, page: number) => [
      { name: `ann.${index}.kind`, value: 'note' },
      { name: `ann.${index}.page`, value: String(page) },
      { name: `ann.${index}.rect`, value: '1 2 3 4' },
    ];
    const parsed = parseAnnotationsFdf(serializeFdf([...record(2, 20), ...record(0, 0), ...record(1, 10)]));
    expect(parsed.marks.map((mark) => mark.pageIndex)).toEqual([0, 10, 20]);
  });

  it("refuses an FDF that is neither of ours nor Acrobat's with the Acrobat reader's answer", () => {
    expect(refusal(() => parseAnnotationData(serializeFdf([{ name: 'name', value: 'x' }])))).toBe(
      'unsupported-format: the FDF carries no /Fields entries that look like annotations',
    );
  });
});

describe('Acrobat comment FDF with unusual values', () => {
  const wrap = (...fields: string[]) =>
    bytesOf(`%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ ${fields.join(' ')} ] >> >>\nendobj\n%%EOF\n`);
  const field = (dictionary: string, name = 'c') => `<< /T (${name}) /V (${dictionary}) >>`;

  it('reads numbers given as strings and a colour that is not numeric as black', () => {
    const [mark, named, text] = parseAcrobatCommentsFdf(
      wrap(
        field('<< /Subtype /Text /Rect [1 2 3 4] /Page (2) /CA (0.5) /C (abc) /Contents 42 >>'),
        field('<< /Subtype /Text /Rect [1 2 3 4] /Page (x) /CA (abc) /C /Pink >>', 'd'),
        field('<< /Subtype (Text) /Rect [1 2 3 4] >>', 'e'),
      ),
    ).marks;
    expect(mark).toMatchObject({ pageIndex: 2, opacity: 0.5, color: '#000000', contents: '42' });
    expect(named).toMatchObject({ pageIndex: 0, opacity: 1, color: '#000000' });
    expect(text).toBeUndefined();
  });

  it('keeps the dictionary it could read when a key has no value, a stray string sits in it or it never closes', () => {
    const parsed = parseAcrobatCommentsFdf(
      wrap(
        field('<< /Subtype /Text /Rect [1 2 3 4] /Empty >>', 'a'),
        field('<< (stray) /Subtype /Text /Rect [1 2 3 4] >>', 'b'),
        field('<< /Subtype /Text /Rect [1 2 3 4] /Page', 'c'),
        field('<< /Subtype /Ink /Rect [0 0 9 9] /InkList 5 >>', 'd'),
      ),
    );
    expect(parsed.marks.map((mark) => mark.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(parsed.marks[3]?.strokes).toEqual([]);
    expect(parsed.skipped).toBe(0);
  });

  it('skips the items of a numeric array that are not numbers', () => {
    const [mark] = parseAcrobatCommentsFdf(wrap(field('<< /Subtype /Text /Rect [1 2 /Foo 3 4] >>'))).marks;
    expect(mark?.rect).toEqual([1, 2, 3, 4]);
  });

  it('counts an entry whose value is cut off by the end of the file', () => {
    const parsed = parseAcrobatCommentsFdf(
      bytesOf(`%FDF-1.2\n${field('<< /Subtype /Text /Rect [1 2 3 4] >>')} /T (cut) /V`),
    );
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.skipped).toBe(0);
  });
});
