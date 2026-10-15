/**
 * Comment exchange files. The wrong answers that matter: a comment file Acrobat cannot read
 * (the FDF this app writes must be Acrobat's own container — `/FDF /Annots` of annotation
 * objects — not form records with comment-shaped names), one that Acrobat wrote and this app
 * cannot (hex strings, indirect objects, appearance streams, `/IRT` replies), a note that
 * comes back from its own export with no place on the page, an Acrobat comment that lands
 * mirrored about the page's middle, and an import that carries one bad value (a date with a
 * month 13, a colour, a shape, a page) into a session whose every later save then fails.
 */

import { isToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import {
  isoFromAcrobatDate,
  keepMarksOnPages,
  parseAcrobatCommentsFdf,
  parseAnnotationData,
  parseAnnotationsFdf,
  parseAnnotationsJson,
  serializeAnnotationsFdf,
  serializeAnnotationsJson,
  toAppSpace,
} from './annotation-data';
import { type AnnotationMark, commentText, taggedContents } from './annotations';
import {
  bytesAsCharacters,
  type FdfObject,
  type FormDataRecord,
  readFdfFile,
  resolveFdf,
  serializeFdf,
  tokenizePdfSource,
} from './form-data';

/** The page top every export below is measured against. */
const TOP = 842;

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
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
/** A file's bytes from a string of one-byte characters: Acrobat's files are bytes, not UTF-8. */
const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** The FDF of `marks` as the app writes it, with every page `TOP` high. */
function exportFdf(
  marks: readonly AnnotationMark[],
  extra: Partial<Parameters<typeof serializeAnnotationsFdf>[0]> = {},
) {
  return serializeAnnotationsFdf({ marks, pageTop: () => TOP, fileName: 'review.pdf', ...extra });
}

/** An FDF read back and turned the right way up, the way the importer places it. */
function roundTrip(marks: readonly AnnotationMark[]): readonly AnnotationMark[] {
  const parsed = parseAnnotationData(exportFdf(marks).bytes);
  expect(parsed.space).toBe('pdf-user');
  expect(parsed.skipped).toBe(0);
  return parsed.marks.map((mark) => toAppSpace(mark, TOP));
}

/**
 * The FDF this app wrote before it wrote Acrobat's: one `ann.<index>.<field>` record per
 * field in a form-data FDF. Nothing writes it now; the files that are out there are read.
 */
function legacyFdf(marks: readonly AnnotationMark[], pageCount: number): Uint8Array {
  const boxes = (list: readonly (readonly number[])[]) =>
    list.map((box) => box.map((value) => Number(value.toFixed(3))).join(' '));
  const records: FormDataRecord[] = [
    { name: 'ann.version', value: '1' },
    { name: 'ann.pageCount', value: String(pageCount) },
    { name: 'ann.count', value: String(marks.length) },
  ];
  for (const [index, mark] of marks.entries()) {
    const prefix = `ann.${index}`;
    records.push(
      { name: `${prefix}.kind`, value: mark.kind },
      { name: `${prefix}.page`, value: String(mark.pageIndex) },
      { name: `${prefix}.quads`, value: boxes(mark.quads) },
      { name: `${prefix}.color`, value: mark.color },
      { name: `${prefix}.opacity`, value: String(mark.opacity) },
      { name: `${prefix}.contents`, value: mark.contents },
      { name: `${prefix}.author`, value: mark.author },
      { name: `${prefix}.created`, value: mark.createdAt },
    );
    const optional: [string, string | readonly string[] | undefined][] = [
      ['thickness', mark.thickness === undefined ? undefined : String(mark.thickness)],
      ['rotation', mark.rotation === undefined ? undefined : String(mark.rotation)],
      ['shape', mark.shape],
      ['rect', mark.rect === undefined ? undefined : boxes([mark.rect])],
      ['fontSize', mark.fontSize === undefined ? undefined : String(mark.fontSize)],
      ['strokes', mark.strokes === undefined ? undefined : boxes(mark.strokes)],
      [
        'replies',
        mark.replies?.length
          ? mark.replies.map((reply) =>
              JSON.stringify({ author: reply.author, contents: reply.contents, createdAt: reply.createdAt }),
            )
          : undefined,
      ],
      ['review', mark.review === undefined ? undefined : JSON.stringify(mark.review)],
    ];
    for (const [field, value] of optional) {
      if (value !== undefined) records.push({ name: `${prefix}.${field}`, value });
    }
  }
  return serializeFdf(records);
}

type Plain = string | number | null | readonly Plain[] | { readonly [key: string]: Plain };

/** An FDF object as plain values: a name is `/Name`, a reference `{ ref: N }`, a string its text. */
function plain(value: FdfObject | undefined): Plain {
  if (value === undefined) return null;
  switch (value.type) {
    case 'string':
      return value.text;
    case 'name':
      return `/${value.text}`;
    case 'number':
      return value.value;
    case 'ref':
      return { ref: value.number };
    case 'array':
      return value.items.map(plain);
    case 'dict':
      return Object.fromEntries([...value.entries].map(([key, item]) => [key, plain(item)]));
    default:
      return null;
  }
}

/** The annotation objects `/FDF /Annots` lists, in that order, read back with the FDF tokenizer. */
function writtenAnnotations(bytes: Uint8Array): readonly Record<string, Plain>[] {
  const file = readFdfFile(tokenizePdfSource(bytesAsCharacters(bytes), { bytes: true }));
  const root = file.roots.find((dict) => dict.entries.has('FDF'));
  const fdf = resolveFdf(file, root?.entries.get('FDF'));
  const annots = fdf?.type === 'dict' ? resolveFdf(file, fdf.entries.get('Annots')) : undefined;
  if (annots?.type !== 'array') throw new Error('the file lists no /Annots');
  return annots.items.map((item) => plain(resolveFdf(file, item)) as Record<string, Plain>);
}

/** A session with every kind of mark the app makes, on three pages, with a thread on the first. */
function session(): AnnotationMark[] {
  const base = {
    pageIndex: 0,
    quads: [] as AnnotationMark['quads'],
    color: '#ff8800',
    opacity: 0.5,
    contents: 'Kontrol et',
    author: 'Ayşe',
    createdAt: '2026-09-28T10:00:00.000Z',
  };
  return [
    {
      ...base,
      id: 'hl',
      kind: 'highlight',
      quads: [
        [72, 100, 200, 112],
        [72, 114, 150, 126],
      ],
      contents: 'Şişli ığüöç (kontrol) \\ İĞÜŞÖÇ',
      replies: [
        { id: 'r1', author: 'Mehmet', contents: 'Düzelttim: çağrı', createdAt: '2026-10-02T08:00:00.000Z' },
      ],
      review: { state: 'Accepted', author: 'Mehmet', at: '2026-10-03T08:00:00.000Z' },
    },
    { ...base, id: 'ul', kind: 'underline', pageIndex: 1, quads: [[72, 200, 180, 212]] },
    { ...base, id: 'so', kind: 'strikeout', pageIndex: 1, quads: [[72, 220, 180, 232]] },
    { ...base, id: 'sq', kind: 'squiggly', pageIndex: 2, quads: [[72, 240, 180, 252]] },
    {
      ...base,
      id: 'ink',
      kind: 'ink',
      quads: [[10, 20, 110, 80]],
      strokes: [[10, 20, 60, 80, 110, 40]],
      thickness: 3,
    },
    {
      ...base,
      id: 'sqr',
      kind: 'shapes',
      shape: 'square',
      pageIndex: 1,
      quads: [[40, 60, 200, 160]],
      rect: [40, 60, 200, 160],
      thickness: 2,
    },
    {
      ...base,
      id: 'cir',
      kind: 'shapes',
      shape: 'circle',
      pageIndex: 2,
      quads: [[40, 60, 200, 160]],
      rect: [40, 60, 200, 160],
      thickness: 4,
    },
    {
      ...base,
      id: 'lin',
      kind: 'shapes',
      shape: 'line',
      quads: [[50, 180, 250, 300]],
      rect: [50, 300, 250, 180],
      thickness: 2,
    },
    { ...base, id: 'nt', kind: 'note', rect: [100, 120, 124, 144] },
    {
      ...base,
      id: 'tx',
      kind: 'freetext',
      pageIndex: 1,
      rect: [50, 60, 270, 79],
      color: '#0000ff',
      opacity: 1,
      fontSize: 14,
      contents: 'Merhaba dünya',
    },
  ];
}

describe('annotation data round trip', () => {
  it('keeps a note and a text box where they were, through JSON', () => {
    const parsed = parseAnnotationsJson(decode(serializeAnnotationsJson([note(), typed()], 3)));
    expect(parsed.space).toBe('app');
    expect(parsed.skipped).toBe(0);
    const [first, second] = parsed.marks;
    expect(first?.rect).toEqual([100, 120, 124, 144]);
    expect(second).toMatchObject({ kind: 'freetext', rect: [50, 60, 270, 79], fontSize: 14 });
  });

  it('keeps a note and a text box where they were, through Acrobat’s FDF', () => {
    const parsed = parseAnnotationData(exportFdf([note(), typed()]).bytes);
    expect(parsed.space).toBe('pdf-user');
    const placed = parsed.marks.map((mark) => toAppSpace(mark, TOP));
    expect(placed.map((mark) => mark.rect)).toEqual([
      [100, 120, 124, 144],
      [50, 60, 270, 79],
    ]);
    expect(placed[1]?.fontSize).toBe(14);
  });
});

describe('the FDF the app writes is Acrobat’s comment container', () => {
  const fileId = ['9F3A1C0DE4B24A6C8D5E7F10A2B3C4D5', 'A1B2C3D4E5F60718293A4B5C6D7E8F90'] as const;

  it('is %FDF-1.2, a catalog with /FDF /Annots, /F and /ID, and one /Type /Annot object per annotation', () => {
    const out = exportFdf(session(), { fileId });
    const text = decode(out.bytes);
    expect(text.startsWith('%FDF-1.2\n1 0 obj\n<< /FDF << /Annots [2 0 R 3 0 R 4 0 R')).toBe(true);
    expect(text).toContain(
      '/F (review.pdf) /UF (review.pdf) /ID [<9F3A1C0DE4B24A6C8D5E7F10A2B3C4D5><A1B2C3D4E5F60718293A4B5C6D7E8F90>] >> /Type /Catalog >>',
    );
    expect(text.endsWith('\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')).toBe(true);
    // The catalog and the 21 annotations: ten comments, nine popups, a reply and a state.
    expect(text.match(/^\d+ 0 obj$/gm)).toHaveLength(22);
    expect(out.count).toBe(10);
    expect(out.skipped).toBe(0);

    const written = writtenAnnotations(out.bytes);
    expect(written).toHaveLength(21);
    expect(written.every((dict) => dict.Type === '/Annot')).toBe(true);
    expect(written.map((dict) => dict.Subtype)).toEqual([
      '/Highlight',
      '/Popup',
      '/Text',
      '/Text',
      '/Underline',
      '/Popup',
      '/StrikeOut',
      '/Popup',
      '/Squiggly',
      '/Popup',
      '/Ink',
      '/Popup',
      '/Square',
      '/Popup',
      '/Circle',
      '/Popup',
      '/Line',
      '/Popup',
      '/Text',
      '/Popup',
      '/FreeText',
    ]);
    // `/Page` is the 0-based page, on the popups and the replies too.
    expect(written.map((dict) => dict.Page)).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2, 0, 0, 0, 0, 1,
    ]);
  });

  it('writes the keys a reader needs on a highlight: place, colour, words, author, dates, quads, popup', () => {
    const [highlight, popup] = writtenAnnotations(exportFdf(session()).bytes);
    expect(highlight).toMatchObject({
      Rect: [72, 716, 200, 742],
      QuadPoints: [72, 742, 200, 742, 72, 730, 200, 730, 72, 728, 150, 728, 72, 716, 150, 716],
      C: [1, 0.533, 0],
      CA: 0.5,
      NM: 'hl',
      T: 'Ayşe',
      Contents: 'Şişli ığüöç (kontrol) \\ İĞÜŞÖÇ',
      M: 'D:20260928100000Z',
      CreationDate: 'D:20260928100000Z',
      F: 4,
      Popup: { ref: 3 },
    });
    expect(highlight).not.toHaveProperty('IRT');
    expect(popup).toMatchObject({ Parent: { ref: 2 }, Rect: [200, 642, 380, 742] });
  });

  it('writes a reply and a review state as /Text annotations that answer the comment by /IRT', () => {
    const [, , reply, state] = writtenAnnotations(exportFdf(session()).bytes);
    expect(reply).toMatchObject({
      IRT: { ref: 2 },
      RT: '/R',
      T: 'Mehmet',
      Contents: 'Düzelttim: çağrı',
      CreationDate: 'D:20261002080000Z',
      F: 28,
    });
    expect(state).toMatchObject({
      IRT: { ref: 2 },
      State: 'Accepted',
      StateModel: 'Review',
      T: 'Mehmet',
      Contents: 'Accepted set by Mehmet',
      CreationDate: 'D:20261003080000Z',
      F: 30,
    });
  });

  it('writes the shapes with their stroke, a line by its ends, ink by its strokes and a text box by /DA', () => {
    const written = writtenAnnotations(exportFdf(session()).bytes);
    const byName = (name: string) => written.find((dict) => dict.NM === name);
    expect(byName('ink')).toMatchObject({
      InkList: [[10, 822, 60, 762, 110, 802]],
      BS: { W: 3 },
      Rect: [8.5, 760.5, 111.5, 823.5],
    });
    expect(byName('sqr')).toMatchObject({ BS: { W: 2 }, Rect: [39, 681, 201, 783] });
    expect(byName('cir')).toMatchObject({ BS: { W: 4 }, Rect: [38, 680, 202, 784] });
    expect(byName('lin')).toMatchObject({ L: [50, 542, 250, 662], BS: { W: 2 } });
    expect(byName('nt')).toMatchObject({ Rect: [100, 698, 124, 722], Name: '/Comment' });
    const text = byName('tx');
    expect(text).toMatchObject({ DA: '/Helv 14 Tf 0 0 1 rg', Rect: [50, 763, 270, 782], CA: 1 });
    // A typed box has no ground colour and no popup: its words are the box.
    expect(text).not.toHaveProperty('C');
    expect(text).not.toHaveProperty('Popup');
  });

  it('is read back as the same marks: kind, page, place, colour, words, author, thread', () => {
    const marks = session();
    const back = roundTrip(marks);
    expect(back.map((mark) => [mark.kind, mark.pageIndex])).toEqual(
      marks.map((mark) => [mark.kind, mark.pageIndex]),
    );
    for (const [at, mark] of marks.entries()) {
      const read = back[at] as AnnotationMark;
      expect(read, mark.id).toMatchObject({
        color: mark.color,
        opacity: mark.opacity,
        contents: mark.contents,
        author: mark.author,
        createdAt: mark.createdAt,
      });
      // Where it is: the boxes of a text mark and an ink, the rectangle or the two ends of the rest.
      if (['highlight', 'underline', 'strikeout', 'squiggly'].includes(mark.kind)) {
        expect(read.quads).toEqual(mark.quads);
      }
      if (mark.kind === 'ink') {
        expect(read.quads).toEqual(mark.quads);
        expect(read.strokes).toEqual(mark.strokes);
        expect(read.thickness).toBe(mark.thickness);
      }
      if (mark.kind === 'shapes') {
        expect(read.shape).toBe(mark.shape);
        expect(read.rect).toEqual(mark.rect);
      }
      if (mark.kind === 'note' || mark.kind === 'freetext') expect(read.rect).toEqual(mark.rect);
    }
    expect(back[9]?.fontSize).toBe(14);
    // The thread: the reply and the state come back on the comment they answered, with their own
    // dates and authors, and every mark and reply has a fresh id.
    expect(back[0]?.replies).toEqual([
      {
        id: expect.any(String),
        author: 'Mehmet',
        contents: 'Düzelttim: çağrı',
        createdAt: '2026-10-02T08:00:00.000Z',
      },
    ]);
    expect(back[0]?.replies?.[0]?.id).not.toBe('r1');
    expect(back[0]?.review).toEqual({ state: 'Accepted', author: 'Mehmet', at: '2026-10-03T08:00:00.000Z' });
    expect(back[0]?.id).not.toBe('hl');
    expect(back[1]).not.toHaveProperty('replies');
    expect(back[1]).not.toHaveProperty('review');
  });

  it('writes the file name and the /ID only when it has them, and only an /ID that is hex', () => {
    const bare = decode(serializeAnnotationsFdf({ marks: [], pageTop: () => TOP }).bytes);
    expect(bare).toContain('<< /FDF << /Annots [] >> /Type /Catalog >>');
    for (const bad of [
      ['xyz', '12'],
      ['abc', '12'],
      ['', '12'],
    ] as const) {
      expect(decode(exportFdf([note()], { fileId: bad }).bytes)).not.toContain('/ID');
    }
    expect(decode(exportFdf([note()], { fileId: ['ab12', 'cd34'] }).bytes)).toContain('/ID [<ab12><cd34>]');
    expect(decode(exportFdf([note()], { fileName: 'Rapor (özet).pdf' }).bytes)).toContain('/F (\\376\\377');
    const [first] = writtenAnnotations(exportFdf([note()]).bytes);
    expect(first).toMatchObject({ Subtype: '/Text', Page: 1 });
  });

  it('counts a mark on a page it cannot measure, and writes nothing at a guess', () => {
    const out = exportFdf(session(), { pageTop: (page) => (page === 1 ? null : TOP) });
    expect(out.count).toBe(6);
    expect(out.skipped).toBe(4);
    const pages = writtenAnnotations(out.bytes).map((dict) => dict.Page);
    expect(pages).not.toContain(1);
  });

  it('writes what a mark leaves out at its defaults: a 2 pt border, 12 pt text, an empty ink list', () => {
    // Each commented mark is followed by its popup; the typed box has none.
    const [square, , ink, , text] = writtenAnnotations(
      exportFdf([
        {
          ...note(),
          id: 'a',
          kind: 'shapes',
          shape: 'square',
          quads: [[40, 60, 200, 160]],
          rect: [40, 60, 200, 160],
        },
        { ...note(), id: 'b', kind: 'ink', quads: [[10, 20, 110, 80]] },
        { ...note(), id: 'c', kind: 'freetext', rect: [50, 60, 270, 79] },
      ]).bytes,
    );
    expect(square).toMatchObject({ BS: { W: 2 }, Rect: [39, 681, 201, 783] });
    expect(ink).toMatchObject({ InkList: [], BS: { W: 2 }, Rect: [9, 761, 111, 823] });
    expect(text).toMatchObject({ DA: '/Helv 12 Tf 1 0.831 0 rg' });
  });

  it('leaves out the dates of a mark whose date is not a time, and the mark still reads back', () => {
    const out = exportFdf([{ ...note(), createdAt: 'not a date' }]);
    const [written] = writtenAnnotations(out.bytes);
    expect(written).not.toHaveProperty('M');
    expect(written).not.toHaveProperty('CreationDate');
    const before = Date.now();
    const [read] = parseAnnotationData(out.bytes).marks;
    expect(Date.parse(read?.createdAt ?? '')).toBeGreaterThanOrEqual(before);
  });

  it('writes ASCII text with parentheses and backslashes so that it reads back whole', () => {
    const [read] = roundTrip([{ ...note(), contents: 'a (b) \\ c) (', author: "O'Neil" }]);
    expect(read).toMatchObject({ contents: 'a (b) \\ c) (', author: "O'Neil" });
  });

  it('writes a marker stroke as the ink it is drawn as, and a reply to a typed box under that box', () => {
    const reply = { id: 'r', author: 'B', contents: 'ok', createdAt: '2026-10-02T08:00:00.000Z' };
    const marker: AnnotationMark = {
      ...note(),
      id: 'mk',
      kind: 'highlight',
      quads: [[10, 20, 110, 40]],
      strokes: [[10, 30, 110, 30]],
      thickness: 12,
      replies: [reply],
    };
    const boxed: AnnotationMark = { ...typed(), replies: [{ ...reply, id: 'r2' }] };
    const written = writtenAnnotations(exportFdf([marker, boxed]).bytes);
    expect(written.map((dict) => dict.Subtype)).toEqual(['/Ink', '/Popup', '/Text', '/FreeText', '/Text']);
    // The typed box has no popup, so its reply points at the box itself: object 5.
    expect(written[4]?.IRT).toEqual({ ref: 5 });
    const [stroke] = roundTrip([marker]);
    expect(stroke).toMatchObject({ kind: 'ink', thickness: 12, strokes: [[10, 30, 110, 30]] });
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
    ['FDF', () => parseAnnotationData(exportFdf([threaded()]).bytes)],
    ['legacy FDF', () => parseAnnotationData(legacyFdf([threaded()], 3))],
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

  it('keeps a marker that sits in the middle of the words: only the head of the text is the marker', () => {
    const quoted = 'He wrote pdf-editor-ann:abc in the margin';
    expect(commentText(quoted)).toBe(quoted);
    expect(commentText(taggedContents({ ...note(), contents: quoted }))).toBe(quoted);
    // The head marker goes, and a second one further on is the writer's own text.
    expect(commentText('pdf-editor-ann:n1 see pdf-editor-ann:other')).toBe('see pdf-editor-ann:other');
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
  it('writes no reply for a mark without replies, and one /IRT per reply for a mark with them', () => {
    const plainFdf = decode(exportFdf([{ ...note(), replies: [] }]).bytes);
    expect(plainFdf).not.toContain('/IRT');
    const reply = { id: 'r', author: 'A', contents: 'x', createdAt: '2026-10-02T08:00:00.000Z' };
    expect(decode(exportFdf([{ ...note(), replies: [reply] }]).bytes)).toContain('/IRT 2 0 R');
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

/** An Acrobat comment file whose `/Annots` hold the given dictionaries themselves. */
const annotsFdf = (...dictionaries: string[]): Uint8Array =>
  bytesOf(
    `%FDF-1.2\n1 0 obj\n<< /FDF << /Annots [ ${dictionaries.join(' ')} ] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );

/** A comment file with every body an indirect object (numbers from 2), all of them listed in `/Annots`. */
function objectsFdf(...bodies: string[]): Uint8Array {
  const listed = bodies.map((_, at) => `${at + 2} 0 R`).join(' ');
  return latin1(
    [
      '%FDF-1.2',
      '1 0 obj',
      `<< /FDF << /Annots [ ${listed} ] >> >>`,
      'endobj',
      ...bodies.flatMap((body, at) => [`${at + 2} 0 obj`, body, 'endobj']),
      'trailer',
      '<< /Root 1 0 R >>',
      '%%EOF',
      '',
    ].join('\n'),
  );
}

describe('Acrobat comment FDF', () => {
  it('reads a highlight: kind, colour, boxes, text, author, opacity and date, under a fresh id', () => {
    const parsed = parseAnnotationData(
      annotsFdf(
        '<< /Subtype /Highlight /NM (guid-1) /Page 0 /Rect [10 20 110 40] /C [1 0 0] /CA 0.5 ' +
          '/QuadPoints [10 40 110 40 10 20 110 20] /Contents (Merhaba) /T (Ayse) /M (D:20261002080000) >>',
      ),
    );
    expect(parsed.space).toBe('pdf-user');
    expect(parsed.skipped).toBe(0);
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.marks[0]).toMatchObject({
      kind: 'highlight',
      pageIndex: 0,
      quads: [[10, 20, 110, 40]],
      color: '#ff0000',
      opacity: 0.5,
      contents: 'Merhaba',
      author: 'Ayse',
      createdAt: '2026-10-02T08:00:00.000Z',
    });
    expect(parsed.marks[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(parsed.pageUnknown).toBe(0);
  });

  it('gives every comment an id of its own, whatever its /NM says, even when two share one', () => {
    const parsed = parseAnnotationData(
      annotsFdf(
        '<< /Subtype /Text /NM (own) /Rect [1 2 3 4] >>',
        '<< /Subtype /Text /NM (own) /Rect [1 2 3 4] >>',
        '<< /Subtype /Text /Rect [1 2 3 4] >>',
      ),
    );
    expect(parsed.marks).toHaveLength(3);
    expect(new Set(parsed.marks.map((mark) => mark.id)).size).toBe(3);
    expect(parsed.marks.map((mark) => mark.id)).not.toContain('own');
  });

  it('falls back to the rect when there are no quad points, and skips a comment with no place', () => {
    const parsed = parseAnnotationData(
      annotsFdf(
        '<< /Subtype /Square /Rect [10 20 110 70] /BS << /W 4 >> >>',
        '<< /Subtype /Underline /Rect [1 2 3 4] >>',
        '<< /Subtype /Highlight /Rect [1 2 3] >>',
      ),
    );
    expect(parsed.marks).toHaveLength(2);
    // A shape's `/Rect` holds its whole stroke: half the border is taken off all round.
    expect(parsed.marks[0]).toMatchObject({
      kind: 'shapes',
      shape: 'square',
      quads: [[12, 22, 108, 68]],
      rect: [12, 22, 108, 68],
      thickness: 4,
    });
    expect(parsed.marks[1]?.quads).toEqual([[1, 2, 3, 4]]);
    expect(parsed.skipped).toBe(1);
    expect(parsed.pageUnknown).toBe(2);
  });

  it('reads the border width from /Border when there is no /BS, and 2 points when there is neither', () => {
    const [bordered, plainBox] = parseAnnotationData(
      annotsFdf(
        '<< /Subtype /Circle /Rect [10 20 110 70] /Border [0 0 6] >>',
        '<< /Subtype /Circle /Rect [10 20 110 70] >>',
      ),
    ).marks;
    expect(bordered).toMatchObject({ rect: [13, 23, 107, 67], thickness: 6 });
    expect(plainBox).toMatchObject({ rect: [11, 21, 109, 69], thickness: 2 });
  });

  it('takes the box of an ink from its strokes, and of a line from its ends, when there is no /Rect', () => {
    const [ink, line] = parseAnnotationData(
      annotsFdf('<< /Subtype /Ink /InkList [[10 20 60 80 110 40]] >>', '<< /Subtype /Line /L [9 8 1 2] >>'),
    ).marks;
    // The default 2 pt stroke is taken off the strokes' own box, half on each side.
    expect(ink).toMatchObject({
      quads: [[11, 21, 109, 79]],
      strokes: [[10, 20, 60, 80, 110, 40]],
      thickness: 2,
    });
    expect(line).toMatchObject({ quads: [[1, 2, 9, 8]], rect: [9, 8, 1, 2], shape: 'line' });
  });

  it('skips a square and a note that have no /Rect, since they have no place', () => {
    const parsed = parseAnnotationData(
      annotsFdf('<< /Subtype /Square >>', '<< /Subtype /Circle /Rect [1 2] >>', '<< /Subtype /Text >>'),
    );
    expect(parsed.marks).toEqual([]);
    expect(parsed.skipped).toBe(3);
  });

  it('reads a number too large for a double as no number: the page is unknown and the opacity the default', () => {
    const huge = '9'.repeat(400);
    const parsed = parseAnnotationData(
      annotsFdf(`<< /Subtype /Text /Rect [1 2 3 4] /Page ${huge} /CA ${huge} >>`),
    );
    expect(parsed.marks[0]).toMatchObject({ pageIndex: 0, opacity: 1 });
    expect(parsed.pageUnknown).toBe(1);
  });

  it('keeps an ink stroke of exactly two points and drops a shorter one', () => {
    const parsed = parseAnnotationData(
      annotsFdf('<< /Subtype /Ink /Rect [0 0 9 9] /InkList [[1 2 3 4] [5 6]] >>'),
    );
    expect(parsed.marks[0]?.strokes).toEqual([[1, 2, 3, 4]]);
    expect(parsed.marks[0]).toMatchObject({ quads: [[1, 1, 8, 8]], thickness: 2 });
  });

  it('skips an ink with no stroke, a line with no ends and a typed box with no words, and counts them', () => {
    const parsed = parseAnnotationData(
      annotsFdf(
        '<< /Subtype /Ink /Rect [0 0 9 9] /InkList 5 >>',
        '<< /Subtype /Ink /Rect [0 0 9 9] /InkList [[1 2] [3]] >>',
        '<< /Subtype /Line /Rect [0 0 9 9] >>',
        '<< /Subtype /FreeText /Rect [0 0 9 9] /Contents (   ) >>',
        '<< /Subtype /Line /Rect [0 0 9 9] /L [9 8 1 2] >>',
      ),
    );
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.skipped).toBe(4);
    // A line's `rect` is its two ends in the order the file gives them.
    expect(parsed.marks[0]).toMatchObject({ kind: 'shapes', shape: 'line', rect: [9, 8, 1, 2] });
  });

  it('clamps a colour channel and reads a grey value as the three channels', () => {
    const [bright, grey] = parseAnnotationData(
      annotsFdf(
        '<< /Subtype /Underline /Rect [1 2 3 4] /C [2 0.5 0] >>',
        '<< /Subtype /Underline /Rect [1 2 3 4] /C [0.2] >>',
      ),
    ).marks;
    expect(bright?.color).toBe('#ff8000');
    expect(grey?.color).toBe('#333333');
  });
});

describe('Acrobat comment FDF as Acrobat writes it', () => {
  /**
   * The shape of a file Acrobat's “Export comments” writes: CR line ends, a binary comment line,
   * dictionaries without spaces, a hex `/ID` and hex and escaped strings, every annotation an
   * indirect object, a popup for each comment, replies by `/IRT` (a reply to a reply too), a
   * review state, an annotation this app has no kind for, and an appearance stream whose bytes
   * are not tokens (an unbalanced `(`, `<<` and `[`).
   */
  const acrobat = (): Uint8Array =>
    latin1(
      [
        '%FDF-1.2',
        '%\u00e2\u00e3\u00cf\u00d3',
        '1 0 obj',
        '<</FDF<</Annots[2 0 R 3 0 R 4 0 R 5 0 R 6 0 R 7 0 R 8 0 R 9 0 R]/F(Report 2026.pdf)' +
          '/ID[<9F3A1C0DE4B24A6C8D5E7F10A2B3C4D5><A1B2C3D4E5F60718293A4B5C6D7E8F90>]/UF(Report 2026.pdf)>>/Type/Catalog>>',
        'endobj',
        '2 0 obj',
        '<</AP<</N 10 0 R>>/C[1.0 0.9 0.0]/CA 0.5/Contents(G\u00f6zden ge\\347ir \\(acil\\))' +
          "/CreationDate(D:20261002100000+02'00')/F 4/M(D:20261002100500+02'00')/NM(0f3d9c7e-1111)/Page 0/Popup 3 0 R" +
          '/QuadPoints[72.0 712.0 200.0 712.0 72.0 700.0 200.0 700.0]/Rect[72.0 700.0 200.0 712.0]' +
          '/Subj(Highlight)/Subtype/Highlight/T<FEFF00410079015F0065>/Type/Annot>>',
        'endobj',
        '3 0 obj',
        '<</Open false/Page 0/Parent 2 0 R/Rect[210.0 612.0 390.0 712.0]/Subtype/Popup/Type/Annot>>',
        'endobj',
        '4 0 obj',
        "<</C[1.0 1.0 0.0]/Contents(Is the total right?)/CreationDate(D:20261002090000+02'00')/F 28/Name/Comment" +
          '/NM(note-1)/Page 1/Popup 5 0 R/Rect[100.0 700.0 124.0 724.0]/Subj(Sticky Note)/Subtype/Text/T(Ali)/Type/Annot>>',
        'endobj',
        '5 0 obj',
        '<</Open false/Page 1/Parent 4 0 R/Rect[130.0 624.0 310.0 724.0]/Subtype/Popup/Type/Annot>>',
        'endobj',
        '6 0 obj',
        "<</Contents(Yes, checked.)/CreationDate(D:20261003090000+02'00')/F 28/IRT 4 0 R/NM(reply-1)/Page 1/RT/R" +
          '/Rect[100.0 704.0 120.0 724.0]/Subtype/Text/T(Mehmet)/Type/Annot>>',
        'endobj',
        '7 0 obj',
        "<</Contents(Thanks!)/CreationDate(D:20261003100000+02'00')/F 28/IRT 6 0 R/NM(reply-2)/Page 1/RT/R" +
          '/Rect[100.0 704.0 120.0 724.0]/Subtype/Text/T(Ali)/Type/Annot>>',
        'endobj',
        '8 0 obj',
        "<</Contents(Accepted set by Mehmet)/CreationDate(D:20261004120000-05'00')/F 30/IRT 4 0 R/NM(state-1)/Page 1/RT/R" +
          '/Rect[100.0 704.0 120.0 724.0]/State(Accepted)/StateModel(Review)/Subtype/Text/T(Mehmet)/Type/Annot>>',
        'endobj',
        '9 0 obj',
        '<</NM(poly-1)/Page 0/Rect[10 10 50 50]/Subtype/Polygon/Type/Annot/Vertices[10 10 50 10 30 50]>>',
        'endobj',
        '10 0 obj',
        '<</BBox[0 0 128 12]/Filter/FlateDecode/Length 31/Subtype/Form>>',
        'stream\r\nq (not closed << 0.5 g [ \u0000\u0080\u00ff <4',
        'endstream',
        'endobj',
        'trailer',
        '<</Root 1 0 R>>',
        '%%EOF',
        '',
      ].join('\r'),
    );

  it.each([
    ['the Acrobat reader', () => parseAcrobatCommentsFdf(acrobat())],
    ['the format dispatcher', () => parseAnnotationData(acrobat())],
  ])('reads it through %s: comments, popups left alone, the thread by /IRT, zones applied', (_name, read) => {
    const parsed = read();
    expect(parsed.space).toBe('pdf-user');
    expect(parsed.pageCount).toBeNull();
    expect(parsed.pageUnknown).toBe(0);
    // A polygon is counted; the two popups are part of their comments and are not.
    expect(parsed.skipped).toBe(1);
    expect(parsed.marks).toHaveLength(2);
    const [highlight, sticky] = parsed.marks;
    expect(highlight).toMatchObject({
      kind: 'highlight',
      pageIndex: 0,
      quads: [[72, 700, 200, 712]],
      color: '#ffe600',
      opacity: 0.5,
      contents: 'Gözden geçir (acil)',
      author: 'Ayşe',
      // The creation date, 10:00 at +02:00, and not the modification date.
      createdAt: '2026-10-02T08:00:00.000Z',
    });
    expect(sticky).toMatchObject({
      kind: 'note',
      pageIndex: 1,
      rect: [100, 700, 124, 724],
      color: '#ffff00',
      contents: 'Is the total right?',
      author: 'Ali',
    });
    // The reply to a reply is on the comment its chain ends at, oldest first.
    expect(sticky?.replies?.map((reply) => [reply.author, reply.contents, reply.createdAt])).toEqual([
      ['Mehmet', 'Yes, checked.', '2026-10-03T07:00:00.000Z'],
      ['Ali', 'Thanks!', '2026-10-03T08:00:00.000Z'],
    ]);
    expect(sticky?.review).toEqual({ state: 'Accepted', author: 'Mehmet', at: '2026-10-04T17:00:00.000Z' });
    expect(highlight).not.toHaveProperty('replies');
  });

  it('turns what it read the right way up with the page top, so a comment keeps its place', () => {
    const [highlight] = parseAcrobatCommentsFdf(acrobat()).marks;
    expect(toAppSpace(highlight as AnnotationMark, 792).quads).toEqual([[72, 80, 200, 92]]);
  });

  it('counts a reply to nothing, a state of another model, a reply that loops and a state it does not know', () => {
    const parsed = parseAcrobatCommentsFdf(
      objectsFdf(
        '<< /Subtype /Text /Page 0 /Rect [1 2 3 4] /Contents (root) >>',
        '<< /Subtype /Text /Page 0 /Rect [1 2 3 4] /Contents (orphan) /IRT 99 0 R >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /IRT 2 0 R /State (Marked) /StateModel (Marked) >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /IRT 6 0 R /Contents (a) >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /IRT 5 0 R /Contents (b) >>',
        '<< /Subtype /Text /Page 0 /Rect [5 6 7 8] /Contents (grouped) /IRT 2 0 R /RT /Group >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /IRT 2 0 R /State /Bogus >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /IRT 2 0 R /Contents (   ) >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /IRT 2 0 R /Contents (fine) /T (X) /CreationDate (D:20261002080000Z) >>',
      ),
    );
    // One orphan, one other model, two in the loop, one unknown state, one blank reply.
    expect(parsed.skipped).toBe(6);
    expect(parsed.marks.map((mark) => mark.contents)).toEqual(['root', 'grouped']);
    expect(parsed.marks[0]?.replies).toEqual([
      { id: expect.any(String), author: 'X', contents: 'fine', createdAt: '2026-10-02T08:00:00.000Z' },
    ]);
    expect(parsed.marks[1]).not.toHaveProperty('replies');
  });

  it('keeps the newest of several review states', () => {
    const [mark] = parseAcrobatCommentsFdf(
      objectsFdf(
        '<< /Subtype /Text /Page 0 /Rect [1 2 3 4] >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /IRT 2 0 R /State (Accepted) /T (A) /M (D:20261001000000Z) >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /IRT 2 0 R /State (Rejected) /T (B) /M (D:20261005000000Z) >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /IRT 2 0 R /State (Completed) /T (C) /M (D:20261003000000Z) >>',
      ),
    ).marks;
    expect(mark?.review).toMatchObject({ state: 'Rejected', author: 'B', at: '2026-10-05T00:00:00.000Z' });
  });

  it('reads an object that is listed twice once, and a direct dictionary next to an indirect one', () => {
    const file = latin1(
      '%FDF-1.2\n1 0 obj\n<< /FDF << /Annots [ 2 0 R 2 0 R << /Subtype /Text /Page 3 /Rect [1 2 3 4] >> ] >> >>\n' +
        'endobj\n2 0 obj\n<< /Subtype /Text /Page 2 /Rect [1 2 3 4] >>\nendobj\n',
    );
    const parsed = parseAcrobatCommentsFdf(file);
    expect(parsed.marks.map((mark) => mark.pageIndex)).toEqual([2, 3]);
    expect(parsed.skipped).toBe(0);
  });

  it('refuses a comment file with no /Annots at all, and reads an empty /Annots as an empty review', () => {
    const none = bytesOf('%FDF-1.2\n1 0 obj\n<< /FDF << /F (a.pdf) >> >>\nendobj\n%%EOF\n');
    expect(refusal(() => parseAcrobatCommentsFdf(none))).toBe(
      'unsupported-format: the FDF carries no /FDF /Annots array',
    );
    const empty = parseAcrobatCommentsFdf(annotsFdf());
    expect(empty).toMatchObject({ marks: [], skipped: 0, pageUnknown: 0, space: 'pdf-user' });
  });

  it('reads a comment file whose dictionary carries an /ID of hex strings, as every file Acrobat writes does', () => {
    const file = bytesOf(
      '%FDF-1.2\n1 0 obj\n<</FDF<</Annots[<</Subtype/Text/Rect[1 2 3 4]/Page 1/Contents(hi)>>]' +
        '/ID[<0123ABCD><4567EF01>]>>>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n',
    );
    for (const parsed of [parseAcrobatCommentsFdf(file), parseAnnotationData(file)]) {
      expect(parsed.marks).toHaveLength(1);
      expect(parsed.marks[0]).toMatchObject({ kind: 'note', pageIndex: 1, contents: 'hi' });
      expect(parsed.space).toBe('pdf-user');
    }
  });

  it('counts a value that is not an annotation, a reference to nothing and an unknown subtype', () => {
    const parsed = parseAcrobatCommentsFdf(
      annotsFdf(
        '<< /Subtype /Text /Rect [1 2 3 4] /Page 2 /Contents (hi) >>',
        '(just words)',
        '5',
        '99 0 R',
        '<< /Subtype /Stamp /Rect [1 2 3 4] >>',
        '<< /Rect [1 2 3 4] >>',
      ),
    );
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.marks[0]).toMatchObject({ kind: 'note', pageIndex: 2, contents: 'hi' });
    expect(parsed.skipped).toBe(5);
    expect(parsed.pageUnknown).toBe(0);
  });

  it('places a comment with a negative or fractional /Page on a real page, and one with none on page 1', () => {
    const parsed = parseAcrobatCommentsFdf(
      annotsFdf(
        '<< /Subtype /Text /Rect [1 2 3 4] /Page -3 >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /Page 1.9 >>',
        '<< /Subtype /Text /Rect [1 2 3 4] >>',
      ),
    );
    expect(parsed.marks.map((mark) => mark.pageIndex)).toEqual([0, 1, 0]);
    expect(parsed.pageUnknown).toBe(1);
  });

  it("takes a typed box's size and ink colour from /DA, and its opacity, words and colour from the rest", () => {
    const [typedBox, plainBox, grey] = parseAcrobatCommentsFdf(
      annotsFdf(
        '<< /Subtype /FreeText /Rect [1 2 3 4] /DA (/Helv 12 Tf 0 0 1 rg) /CA 3 /Contents (a) /T (me) >>',
        '<< /Subtype /FreeText /Rect [1 2 3 4] /DA (/Helv Tf) /CA -1 /Contents (b) >>',
        '<< /Subtype /Highlight /Rect [1 2 3 4] /C 0.5 /M (D:2026) /NM 77 >>',
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
    expect(plainBox).toMatchObject({ color: '#000000', opacity: 0, contents: 'b' });
    expect(plainBox).not.toHaveProperty('fontSize');
    expect(grey).toMatchObject({ color: '#808080', createdAt: '2026-01-01T00:00:00.000Z' });
  });

  it("reads quad points in any corner order, ink strokes, a shape's subtype and a missing colour", () => {
    const [quad, ink, circle, none] = parseAcrobatCommentsFdf(
      annotsFdf(
        '<< /Subtype /Underline /QuadPoints [30 40 10 40 30 20 10 20 5 6 7 8 9 10 11 12] /C [] >>',
        '<< /Subtype /Ink /Rect [0 0 9 9] /InkList [[1 2 3 4 5 6] 7 [8]] >>',
        '<< /Subtype /Circle /Rect [1 2 3 4] /C [0.1 0.2] >>',
        '<< /Subtype /Squiggly /Rect [1 2 3 4] >>',
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
});

describe('an Acrobat file cannot reach the prototype', () => {
  it('skips a /Subtype that is the name of something every object has, instead of importing a mark of no kind', () => {
    const parsed = parseAcrobatCommentsFdf(
      annotsFdf(
        '<< /Subtype /constructor /Rect [1 2 3 4] >>',
        '<< /Subtype /__proto__ /Rect [1 2 3 4] >>',
        '<< /Subtype /toString /Rect [1 2 3 4] >>',
        '<< /Subtype /hasOwnProperty /Rect [1 2 3 4] >>',
        '<< /Subtype /valueOf /Rect [1 2 3 4] >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /Contents (real) >>',
      ),
    );
    expect(parsed.skipped).toBe(5);
    expect(parsed.marks.map((mark) => [mark.kind, mark.contents])).toEqual([['note', 'real']]);
  });

  it('keeps /__proto__ as a key like any other: it neither sets a /Subtype nor changes the prototype', () => {
    const parsed = parseAcrobatCommentsFdf(
      annotsFdf(
        '<< /Subtype /Text /Rect [1 2 3 4] /__proto__ << /Subtype /Highlight /Contents (polluted) >> /Contents (own) >>',
        '<< /__proto__ << /Subtype /Highlight /Rect [1 2 3 4] >> >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /constructor << /Subtype /Highlight >> /Contents (kept) >>',
      ),
    );
    expect(parsed.marks.map((mark) => [mark.kind, mark.contents])).toEqual([
      ['note', 'own'],
      ['note', 'kept'],
    ]);
    // The second has no /Subtype of its own, however deep the dictionary it nests.
    expect(parsed.skipped).toBe(1);
    expect(({} as Record<string, unknown>).Subtype).toBeUndefined();
    expect('Subtype' in Object.prototype).toBe(false);
  });

  it('skips a JSON shape that is a name from the prototype, and ignores a __proto__ key in a mark', () => {
    const file = `{"marks":[
      {"kind":"shapes","pageIndex":0,"quads":["1 2 3 4"],"shape":"constructor"},
      {"kind":"shapes","pageIndex":0,"quads":["1 2 3 4"],"shape":"__proto__"},
      {"kind":"shapes","pageIndex":0,"quads":["1 2 3 4"],"shape":"toString"},
      {"kind":"note","pageIndex":0,"rect":"1 2 3 4","__proto__":{"kind":"highlight"}}]}`;
    const parsed = parseAnnotationsJson(file);
    expect(parsed.skipped).toBe(3);
    expect(parsed.marks.map((mark) => mark.kind)).toEqual(['note']);
  });
});

describe('dates that are not dates', () => {
  it('turns an Acrobat date into ISO with its time zone applied, and anything else into now', () => {
    expect(isoFromAcrobatDate(" D:20261002080910+03'00' ")).toBe('2026-10-02T05:09:10.000Z');
    expect(isoFromAcrobatDate("D:20261002080910-05'30'")).toBe('2026-10-02T13:39:10.000Z');
    expect(isoFromAcrobatDate('D:202610')).toBe('2026-10-01T00:00:00.000Z');
    expect(isoFromAcrobatDate('yesterday')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('answers the time of the import for an impossible date instead of throwing a RangeError', () => {
    for (const impossible of [
      'D:20241301000000',
      'D:20240100',
      'D:20240230',
      'D:20260101250000',
      'D:20260101006000',
      "D:20260101000000+25'00'",
    ]) {
      const before = Date.now();
      const iso = isoFromAcrobatDate(impossible);
      expect(Date.parse(iso), impossible).toBeGreaterThanOrEqual(before);
      expect(Date.parse(iso), impossible).toBeLessThanOrEqual(Date.now());
    }
  });

  it('imports a comment whose date is impossible, and the comments after it', () => {
    const before = Date.now();
    const parsed = parseAnnotationData(
      annotsFdf(
        '<< /Subtype /Text /Rect [1 2 3 4] /Contents (a) /CreationDate (D:20241301000000Z) >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /Contents (b) /M (D:20240100) >>',
        "<< /Subtype /Text /Rect [1 2 3 4] /Contents (c) /CreationDate (D:20261002080000+02'00') >>",
      ),
    );
    expect(parsed.marks.map((mark) => mark.contents)).toEqual(['a', 'b', 'c']);
    expect(parsed.skipped).toBe(0);
    const [first, second, third] = parsed.marks.map((mark) => mark.createdAt);
    expect(Date.parse(first ?? '')).toBeGreaterThanOrEqual(before);
    expect(Date.parse(second ?? '')).toBeGreaterThanOrEqual(before);
    expect(third).toBe('2026-10-02T06:00:00.000Z');
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

describe('every field of a mark survives the records it was written as', () => {
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
    ['the FDF records this app used to write', () => parseAnnotationsFdf(legacyFdf([full()], 5))],
    ['the same, found by the dispatcher', () => parseAnnotationData(legacyFdf([full()], 5))],
  ])('through %s', (_name, read) => {
    const parsed = read();
    expect(parsed.space).toBe('app');
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

  it('reads a file this app wrote before it wrote Acrobat’s container, from its bytes', () => {
    const file = bytesOf(
      [
        '%FDF-1.2',
        '1 0 obj',
        '<< /FDF << /Fields [',
        '<< /T (ann.version) /V (1) >>',
        '<< /T (ann.pageCount) /V (3) >>',
        '<< /T (ann.count) /V (1) >>',
        '<< /T (ann.0.kind) /V (note) >>',
        '<< /T (ann.0.page) /V (1) >>',
        '<< /T (ann.0.quads) /V [ ] >>',
        '<< /T (ann.0.color) /V (#ffd400) >>',
        '<< /T (ann.0.opacity) /V (0.8) >>',
        '<< /T (ann.0.contents) /V (Kontrol et) >>',
        '<< /T (ann.0.author) /V (Ayse) >>',
        '<< /T (ann.0.created) /V (2026-09-28T10:00:00.000Z) >>',
        '<< /T (ann.0.rect) /V [ (100 120 124 144) ] >>',
        '] >> >>',
        'endobj',
        'trailer',
        '<< /Root 1 0 R >>',
        '%%EOF',
        '',
      ].join('\n'),
    );
    const parsed = parseAnnotationData(file);
    expect(parsed).toMatchObject({ space: 'app', pageCount: 3, skipped: 0 });
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.marks[0]).toMatchObject({
      kind: 'note',
      pageIndex: 1,
      rect: [100, 120, 124, 144],
      color: '#ffd400',
      opacity: 0.8,
      contents: 'Kontrol et',
      author: 'Ayse',
      createdAt: '2026-09-28T10:00:00.000Z',
    });
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

  it('turns a colour that is not #rrggbb into the default, and skips what the writer would refuse', () => {
    const shaped = { kind: 'shapes', pageIndex: 0, quads: ['1 2 3 4'] };
    const parsed = json(
      { ...base, color: 'red' },
      { ...base, color: '#fff' },
      { ...base, color: ' #AABBCC ' },
      { ...shaped, shape: 'circle' },
      shaped,
      { ...base, shape: 'constructor' },
      { ...shaped, shape: 'constructor' },
      { ...shaped, shape: '__proto__' },
      { ...shaped, shape: 'star' },
      { ...base, pageIndex: 1.5 },
    );
    expect(parsed.skipped).toBe(4);
    expect(parsed.marks.map((entry) => [entry.kind, entry.color, entry.shape])).toEqual([
      ['highlight', '#ffd400', undefined],
      ['highlight', '#ffd400', undefined],
      ['highlight', '#aabbcc', undefined],
      ['shapes', '#ffd400', 'circle'],
      ['shapes', '#ffd400', undefined],
      // A shape on a mark that is not a shape means nothing, and is not carried.
      ['highlight', '#ffd400', undefined],
    ]);
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
    const [plainMark, faint, solid, turned] = json(
      base,
      { ...base, opacity: 0 },
      { ...base, opacity: 5 },
      { ...base, rotation: 270, createdAt: '2026-01-01T00:00:00.000Z', thickness: 'x', fontSize: 'y' },
    ).marks;
    expect(plainMark).toMatchObject({ color: '#ffd400', opacity: 0.4, contents: '', author: '' });
    expect(plainMark?.createdAt).toMatch(/^\d{4}-/);
    expect(plainMark).not.toHaveProperty('thickness');
    expect(plainMark).not.toHaveProperty('rotation');
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

describe('keepMarksOnPages', () => {
  const at = (pageIndex: number): AnnotationMark => ({ ...note(), pageIndex });
  const result = (pages: number[], skipped = 0) => ({
    marks: pages.map(at),
    skipped,
    pageCount: null,
    space: 'app' as const,
  });

  it('drops the marks on pages the document does not have and adds them to what was skipped', () => {
    const kept = keepMarksOnPages(result([0, 1, 2, 5, 3, -1, 1.5], 1), 3);
    expect(kept.marks.map((mark) => mark.pageIndex)).toEqual([0, 1, 2]);
    expect(kept.skipped).toBe(5);
    expect(kept).toMatchObject({ space: 'app', pageCount: null });
  });

  it('answers the same result when every mark fits, and nothing fits a document with no pages', () => {
    const whole = result([0, 1, 2], 2);
    expect(keepMarksOnPages(whole, 3)).toBe(whole);
    expect(keepMarksOnPages(whole, 0)).toMatchObject({ marks: [], skipped: 5 });
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
    const parsed = parseAnnotationsFdf(legacyFdf([highlight], 1));
    expect(parsed.marks[0]).not.toHaveProperty('rect');
    expect(parsed.marks[0]).not.toHaveProperty('strokes');
    // Acrobat's container has no key for what the mark does not have either.
    const [written] = writtenAnnotations(exportFdf([highlight]).bytes);
    expect(Object.keys(written ?? {}).sort()).toEqual(
      'C CA CreationDate F M NM Page Popup QuadPoints Rect Subtype Type'.split(' '),
    );
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

  it("refuses an FDF that is neither this app's records nor Acrobat's comments", () => {
    expect(refusal(() => parseAnnotationData(serializeFdf([{ name: 'name', value: 'x' }])))).toBe(
      'unsupported-format: the FDF carries neither /Annots comments nor ann.* records',
    );
    expect(
      refusal(() => parseAnnotationData(bytesOf('%FDF-1.2\n1 0 obj\n<< /FDF << /F (a.pdf) >> >>\nendobj\n'))),
    ).toBe('unsupported-format: the FDF carries neither /Annots comments nor ann.* records');
  });
});

describe('Acrobat comment FDF with unusual values', () => {
  it('reads numbers given as strings and a colour that is not numeric as black', () => {
    const [mark, named, text] = parseAcrobatCommentsFdf(
      annotsFdf(
        '<< /Subtype /Text /Rect [1 2 3 4] /Page (2) /CA (0.5) /C (abc) /Contents 42 >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /Page (x) /CA (abc) /C /Pink >>',
        '<< /Subtype (Text) /Rect [1 2 3 4] >>',
      ),
    ).marks;
    expect(mark).toMatchObject({ pageIndex: 2, opacity: 0.5, color: '#000000', contents: '42' });
    expect(named).toMatchObject({ pageIndex: 0, opacity: 1, color: '#000000' });
    expect(text).toBeUndefined();
  });

  it('keeps the dictionary it could read when a key has no value or a stray string sits in it', () => {
    const parsed = parseAcrobatCommentsFdf(
      annotsFdf(
        '<< /Subtype /Text /Rect [1 2 3 4] /Empty >>',
        '<< (stray) /Subtype /Text /Rect [1 2 3 4] >>',
        '<< /Subtype /Text /Rect [1 2 3 4] /Contents >>',
      ),
    );
    expect(parsed.marks).toHaveLength(3);
    expect(parsed.skipped).toBe(0);
    expect(parsed.marks[2]?.contents).toBe('');
  });

  it('skips the items of a numeric array that are not numbers', () => {
    const [mark] = parseAcrobatCommentsFdf(annotsFdf('<< /Subtype /Text /Rect [1 2 /Foo 3 4] >>')).marks;
    expect(mark?.rect).toEqual([1, 2, 3, 4]);
  });

  it('keeps what it could read when the file ends inside a dictionary', () => {
    const parsed = parseAcrobatCommentsFdf(
      bytesOf('%FDF-1.2\n1 0 obj\n<< /FDF << /Annots [ << /Subtype /Text /Rect [1 2 3 4] /Page'),
    );
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.marks[0]).toMatchObject({ kind: 'note', rect: [1, 2, 3, 4], pageIndex: 0 });
    expect(parsed.skipped).toBe(0);
  });

  it('refuses a file that stops inside a string, as corrupt', () => {
    const cut = bytesOf('%FDF-1.2\n1 0 obj\n<< /FDF << /Annots [ << /Contents (cut');
    expect(refusal(() => parseAcrobatCommentsFdf(cut))).toBe(
      'corrupt-document: FDF string literal is not terminated',
    );
  });
});
