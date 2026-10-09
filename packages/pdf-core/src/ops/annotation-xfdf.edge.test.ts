/**
 * XFDF at its edges: what the export writes for marks and annotations that lack the optional
 * parts, what it refuses to write, and every way an imported element can be unusable (no
 * rectangle, no strokes, an unreadable colour, a reply to nothing, a reply that answers itself,
 * a review state this app does not hold). Each element is read back from the bytes the other
 * half produced or from XML written by hand, never from the model that made it.
 */

import { DOMParser as XmlDomParser } from '@xmldom/xmldom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toAppSpace } from './annotation-data';
import { parseXfdf, serializeXfdf } from './annotation-xfdf';
import type { AnnotationMark, ExistingAnnotation } from './annotations';

const TOP = 800;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function mark(overrides: Partial<AnnotationMark> & Pick<AnnotationMark, 'id' | 'kind'>): AnnotationMark {
  return {
    pageIndex: 0,
    quads: [],
    color: '#ff8800',
    opacity: 0.5,
    contents: 'words',
    author: 'Ayşe',
    createdAt: '2026-10-01T09:30:00.000Z',
    ...overrides,
  };
}

function annotation(
  overrides: Partial<ExistingAnnotation> & Pick<ExistingAnnotation, 'id' | 'subtype'>,
): ExistingAnnotation {
  return {
    pageIndex: 1,
    kind: null,
    rect: [10, 20, 110, 70],
    contents: 'text',
    marker: null,
    author: 'Ali',
    modified: null,
    ...overrides,
  };
}

/** The elements of an export, one per line of `<annots>`. */
function elementsOf(bytes: Uint8Array): string[] {
  const xml = decode(bytes);
  const body = xml.slice(xml.indexOf('<annots>') + 8, xml.indexOf('</annots>'));
  return body === '' ? [] : body.split('\n');
}

const exportMarks = (
  marks: readonly AnnotationMark[],
  pageTop: (page: number) => number | null = () => TOP,
) => serializeXfdf({ marks, existing: [], pageTop });
const exportExisting = (existing: readonly ExistingAnnotation[]) =>
  serializeXfdf({ marks: [], existing, pageTop: () => TOP });

afterEach(() => vi.unstubAllGlobals());

describe('exporting session marks', () => {
  it('leaves out a mark whose page cannot be measured, and counts it', () => {
    const out = exportMarks(
      [mark({ id: 'a', kind: 'note', rect: [0, 0, 10, 10] }), mark({ id: 'b', kind: 'note', pageIndex: 9 })],
      (page) => (page === 9 ? null : TOP),
    );
    expect([out.count, out.skipped]).toEqual([1, 1]);
    expect(elementsOf(out.bytes)).toHaveLength(1);
  });

  it('writes the name of the PDF, escaped, and nothing when there is none', () => {
    const named = serializeXfdf({ marks: [], existing: [], pageTop: () => TOP, fileName: 'a&b "c".pdf' });
    expect(decode(named.bytes)).toContain('</annots><f href="a&amp;b &quot;c&quot;.pdf"/></xfdf>');
    expect(decode(exportMarks([]).bytes)).toContain('<annots></annots></xfdf>');
  });

  it('writes an ink mark without strokes as an empty list at the default width, and a marker stroke as ink', () => {
    const [bare, marker] = elementsOf(
      exportMarks([
        mark({ id: 'i', kind: 'ink', quads: [[1, 2, 3, 4]] }),
        mark({
          id: 'h',
          kind: 'highlight',
          quads: [[1, 2, 3, 4]],
          strokes: [[10, 100, 20, 200, 30]],
          thickness: 9,
        }),
      ]).bytes,
    );
    expect(bare).toContain('width="2"');
    expect(bare).toContain('<inklist></inklist>');
    expect(marker).toMatch(/^<ink /);
    expect(marker).toContain('width="9"');
    // Flipped through the page top; a trailing coordinate without a partner is dropped.
    expect(marker).toContain('<inklist><gesture>10,700;20,600</gesture></inklist>');
  });

  it('writes a text-markup mark whose strokes are empty as markup, with its four corners', () => {
    const [element] = elementsOf(
      exportMarks([mark({ id: 'u', kind: 'underline', quads: [[10, 100, 110, 120]], strokes: [] })]).bytes,
    );
    expect(element).toMatch(/^<underline /);
    expect(element).toContain('coords="');
  });

  it('writes circles, squares and lines, and a shape with no thickness at width 2', () => {
    const [circle, square, line] = elementsOf(
      exportMarks([
        mark({ id: 'c', kind: 'shapes', shape: 'circle', quads: [[10, 20, 30, 40]] }),
        mark({ id: 's', kind: 'shapes', quads: [[10, 20, 30, 40]] }),
        mark({ id: 'l', kind: 'shapes', shape: 'line', quads: [[10, 20, 30, 40]], thickness: 4 }),
      ]).bytes,
    );
    expect(circle).toMatch(/^<circle .* width="2"/);
    expect(square).toMatch(/^<square .* width="2"/);
    expect(line).toMatch(/^<line .* width="4" start="10,780" end="30,760"/);
  });

  it('writes typed text at 12 points by default, and black for a colour it cannot read', () => {
    const [plain, odd, blue] = elementsOf(
      exportMarks([
        mark({ id: 'f1', kind: 'freetext', color: '#000000', rect: [0, 0, 50, 20] }),
        mark({ id: 'f2', kind: 'freetext', color: '#zzzzzz', fontSize: 9.5, rect: [0, 0, 50, 20] }),
        mark({ id: 'f3', kind: 'freetext', color: '#0000ff', rect: [0, 0, 50, 20] }),
      ]).bytes,
    );
    expect(plain).toContain('<defaultappearance>/Helv 12 Tf 0 0 0 rg</defaultappearance>');
    expect(odd).toContain('<defaultappearance>/Helv 9.5 Tf 0 0 0 rg</defaultappearance>');
    expect(blue).toContain('/Helv 12 Tf 0 0 1 rg');
  });

  it('escapes markup characters and drops control characters, and omits a date it cannot read', () => {
    const [element] = elementsOf(
      exportMarks([
        mark({
          id: 'n',
          kind: 'note',
          rect: [0, 0, 10, 10],
          contents: 'a<b>&"c"\u0001\u000bd',
          author: 'x"y',
          createdAt: 'not a date',
        }),
      ]).bytes,
    );
    expect(element).toContain('<contents>a&lt;b&gt;&amp;&quot;c&quot;d</contents>');
    expect(element).toContain('title="x&quot;y"');
    expect(element).not.toMatch(/ (date|creationdate)=/);
  });

  it('writes a note with no replies and a review of None as one element', () => {
    const out = exportMarks([
      mark({
        id: 'n',
        kind: 'note',
        rect: [0, 0, 10, 10],
        review: { state: 'None', author: 'A', at: '2026-10-02T00:00:00Z' },
      }),
    ]);
    expect(elementsOf(out.bytes)).toHaveLength(1);
  });
});

describe('exporting the file`s own annotations', () => {
  it('writes each subtype as its element, with what the file states and nothing it does not', () => {
    const lines = elementsOf(
      exportExisting([
        annotation({
          id: '10R',
          subtype: 'Highlight',
          quadPoints: [1, 2, 3, 4, 5, 6, 7, 8],
          color: '#ffee00',
          opacity: 0.4,
          thickness: 1.5,
          modified: 'D:20261001093000Z',
        }),
        annotation({ id: '11R', subtype: 'Ink', inkLists: [[1, 2, 3, 4]] }),
        annotation({ id: '12R', subtype: 'Ink' }),
        annotation({ id: '13R', subtype: 'Line', vertices: [5, 6, 7, 8] }),
        annotation({ id: '14R', subtype: 'Line' }),
        annotation({ id: '15R', subtype: 'FreeText', quadPoints: [1, 2, 3, 4, 5, 6, 7, 8] }),
        annotation({ id: '16R', subtype: 'Text', modified: '2026-10-01T09:30:00.000Z', created: 'garbage' }),
        annotation({ id: '17R', subtype: 'Square', created: '' }),
      ]).bytes,
    );
    expect(lines[0]).toBe(
      '<highlight page="1" rect="10,20,110,70" name="10R" title="Ali" date="D:20261001093000Z" color="#FFEE00" opacity="0.4" width="1.5" coords="1,2,3,4,5,6,7,8"><contents>text</contents></highlight>',
    );
    expect(lines[1]).toContain('<inklist><gesture>1,2;3,4</gesture></inklist>');
    expect(lines[2]).toContain('<inklist></inklist>');
    expect(lines[3]).toContain('start="5,6" end="7,8"');
    expect(lines[4]).toContain('start="0,0" end="0,0"');
    expect(lines[5]).not.toContain('coords=');
    expect(lines[6]).toContain('date="D:20261001093000Z"');
    expect(lines[6]).toContain('icon="Comment"');
    expect(lines[6]).not.toContain('creationdate');
    expect(lines[7]).not.toContain('creationdate');
  });

  it('counts what the format cannot carry: widgets, links, stamps and annotations with no rectangle; popups are not counted', () => {
    const out = exportExisting([
      annotation({ id: '1R', subtype: 'Widget' }),
      annotation({ id: '2R', subtype: 'Link' }),
      annotation({ id: '3R', subtype: 'Stamp' }),
      annotation({ id: '4R', subtype: 'Square', rect: null }),
      annotation({ id: '5R', subtype: 'Popup' }),
      annotation({ id: '6R', subtype: 'Square' }),
    ]);
    expect([out.count, out.skipped]).toEqual([1, 4]);
    expect(elementsOf(out.bytes)).toHaveLength(1);
  });

  it('writes a reply under its comment as a hidden or visible record, and does not count it', () => {
    const out = exportExisting([
      annotation({ id: '1R', subtype: 'Text' }),
      annotation({ id: '2R', subtype: 'Text', inReplyTo: '1R', replyType: 'R' }),
      annotation({ id: '3R', subtype: 'Text', inReplyTo: '1R', replyType: 'R', state: 'Accepted' }),
      annotation({
        id: '4R',
        subtype: 'Text',
        inReplyTo: '1R',
        replyType: 'R',
        state: 'Marked',
        stateModel: 'Marked',
      }),
    ]);
    expect(out.count).toBe(1);
    const lines = elementsOf(out.bytes);
    expect(lines[1]).toContain('inreplyto="1R"');
    expect(lines[1]).toContain('flags="print,nozoom,norotate"');
    expect(lines[1]).not.toContain('state=');
    expect(lines[2]).toContain('flags="hidden,print,nozoom,norotate"');
    expect(lines[2]).toContain('state="Accepted" statemodel="Review"');
    expect(lines[3]).toContain('state="Marked" statemodel="Marked"');
  });
});

const xfdf = (annots: string, attributes = ''): Uint8Array =>
  encode(
    `<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"${attributes}><annots>${annots}</annots></xfdf>`,
  );
const highlight = (attributes: string, inner = ''): string =>
  `<highlight rect="10,20,110,70" ${attributes}>${inner}</highlight>`;

describe('importing what cannot be used', () => {
  it('skips an element with no usable rectangle, an unknown element, and a repeated name', async () => {
    const out = await parseXfdf(
      xfdf(
        [
          '<highlight name="a" page="0"/>',
          '<highlight name="b" page="0" rect="1,2,3"/>',
          '<stamp name="c" page="0" rect="1,2,3,4"/>',
          '<square name="d" page="0" rect="1,2,3,4"/>',
          '<square name="d" page="0" rect="5,6,7,8"/>',
        ].join(''),
      ),
    );
    expect(out.marks).toHaveLength(1);
    expect(out.skipped).toBe(4);
  });

  it('reads no marks from a file with no <annots>, and says so by counting nothing', async () => {
    const out = await parseXfdf(encode('<xfdf xmlns="http://ns.adobe.com/xfdf/"><f href="x.pdf"/></xfdf>'));
    expect(out).toMatchObject({ marks: [], skipped: 0, pageUnknown: 0, space: 'pdf-user' });
  });

  it('refuses a file that is not XFDF, and one that is not XML', async () => {
    await expect(parseXfdf(encode('<html><body/></html>'))).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { engine: 'model', engineMessage: 'not an XFDF document' },
    });
    await expect(parseXfdf(encode('<xfdf><annots></xfdf>'))).rejects.toMatchObject({
      code: 'unsupported-format',
      details: { engine: 'model' },
    });
  });

  it('uses the platform parser when there is one', async () => {
    const types: string[] = [];
    vi.stubGlobal(
      'DOMParser',
      class {
        parseFromString(text: string, type: string) {
          types.push(type);
          return new XmlDomParser().parseFromString(text, type);
        }
      },
    );
    const out = await parseXfdf(xfdf('<square name="a" page="0" rect="1,2,3,4"/>'));
    expect(types).toEqual(['application/xml']);
    expect(out.marks).toHaveLength(1);
  });

  it('puts a mark with no page on page 0 and counts it; a negative or unreadable page is page 0 too', async () => {
    const out = await parseXfdf(
      xfdf(
        [
          '<square name="a" rect="1,2,3,4"/>',
          '<square name="b" page="-3" rect="1,2,3,4"/>',
          '<square name="c" page="x" rect="1,2,3,4"/>',
          '<square name="d" page="4" rect="1,2,3,4"/>',
        ].join(''),
      ),
    );
    expect(out.marks.map((entry) => entry.pageIndex)).toEqual([0, 0, 0, 4]);
    expect(out.pageUnknown).toBe(1);
  });

  it('gives a mark with no name an id of its own, and every mark a new one', async () => {
    const [bare, named] = (await parseXfdf(xfdf('<square rect="1,2,3,4"/><square name="n" rect="1,2,3,4"/>')))
      .marks;
    expect(bare?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(named?.id).not.toBe('n');
  });

  it('falls back to the default colour of the kind, and clamps the opacity', async () => {
    const out = await parseXfdf(
      xfdf(
        [
          '<highlight name="a" rect="1,2,3,4" color="red" opacity="0"/>',
          '<square name="b" rect="1,2,3,4" color="#ABCDEF" opacity="5"/>',
          '<square name="c" rect="1,2,3,4" color="#12345"/>',
        ].join(''),
      ),
    );
    expect(out.marks.map((entry) => [entry.color, entry.opacity])).toEqual([
      ['#ffd400', 0.02],
      ['#abcdef', 1],
      ['#e5484d', 1],
    ]);
  });

  it('reads the text from <contents>, from <contents-richtext>, or from the attribute, in that order', async () => {
    const out = await parseXfdf(
      xfdf(
        [
          '<text name="a" rect="1,2,3,4" contents="attr"><contents>plain</contents><contents-richtext> rich </contents-richtext></text>',
          '<text name="b" rect="1,2,3,4" contents="attr"><contents-richtext>  rich  </contents-richtext></text>',
          '<text name="c" rect="1,2,3,4" contents="attr"/>',
          '<text name="d" rect="1,2,3,4"/>',
        ].join(''),
      ),
    );
    expect(out.marks.map((entry) => entry.contents)).toEqual(['plain', 'rich', 'attr', '']);
  });

  it('dates: the creation date, then the date, then now; an author is empty when the file names none', async () => {
    const before = Date.now();
    const out = await parseXfdf(
      xfdf(
        [
          '<text name="a" rect="1,2,3,4" creationdate="D:20261001093000Z" date="D:20270101000000Z" title="T"/>',
          '<text name="b" rect="1,2,3,4" date="D:20270101000000Z"/>',
          '<text name="c" rect="1,2,3,4" date=""/>',
        ].join(''),
      ),
    );
    expect(out.marks.map((entry) => entry.createdAt).slice(0, 2)).toEqual([
      '2026-10-01T09:30:00.000Z',
      '2027-01-01T00:00:00.000Z',
    ]);
    expect(Date.parse(out.marks[2]?.createdAt ?? '')).toBeGreaterThanOrEqual(before);
    expect(out.marks.map((entry) => entry.author)).toEqual(['T', '', '']);
  });

  it('text markup: one box per eight coordinates, or the rectangle when there are fewer', async () => {
    const out = await parseXfdf(
      xfdf(
        [
          highlight('name="a" coords="0,10,10,10,0,0,10,0, 20,40,30,40,20,30,30,30"'),
          highlight('name="b" coords="1,2,3"'),
          highlight('name="c"'),
        ].join(''),
      ),
    );
    expect(out.marks.map((entry) => entry.quads)).toEqual([
      [
        [0, 0, 10, 10],
        [20, 30, 30, 40],
      ],
      [[10, 20, 110, 70]],
      [[10, 20, 110, 70]],
    ]);
  });

  it('ink: needs one stroke of two points; shorter or odd runs are dropped; the width defaults to 2', async () => {
    const ink = (name: string, inner: string, extra = '') =>
      `<ink name="${name}" rect="0,0,50,50"${extra}>${inner}</ink>`;
    const out = await parseXfdf(
      xfdf(
        [
          ink('a', ''),
          ink('b', '<inklist><gesture>1,2</gesture><gesture>1,2,3</gesture></inklist>'),
          ink(
            'c',
            '<inklist><gesture>1,2,3,4</gesture><gesture>5,6,7</gesture><gesture>5,6,7,8</gesture></inklist>',
          ),
          ink('d', '<inklist><gesture>1,2,3,4</gesture></inklist>', ' width="6"'),
        ].join(''),
      ),
    );
    expect(out.skipped).toBe(2);
    expect(out.marks.map((entry) => [entry.strokes, entry.thickness])).toEqual([
      [
        [
          [1, 2, 3, 4],
          [5, 6, 7, 8],
        ],
        2,
      ],
      [[[1, 2, 3, 4]], 6],
    ]);
  });

  it('shapes: a line needs both ends; a square and a circle are their rectangle less half the 2 pt default stroke', async () => {
    const out = await parseXfdf(
      xfdf(
        [
          '<line name="a" rect="0,0,50,50" start="1,2"/>',
          '<line name="b" rect="0,0,50,50" end="1,2"/>',
          '<line name="c" rect="0,0,50,50" start="5,6" end="1,2"/>',
          '<circle name="d" rect="50,60,10,20"/>',
        ].join(''),
      ),
    );
    expect(out.skipped).toBe(2);
    expect(out.marks.map((entry) => [entry.shape, entry.rect, entry.thickness])).toEqual([
      ['line', [5, 6, 1, 2], undefined],
      ['circle', [11, 21, 49, 59], 2],
    ]);
  });

  it('reads a width-less shape back to the same rectangle, and a negative width as no stroke', async () => {
    const read = await parseXfdf(
      xfdf(
        '<square name="a" page="0" rect="10,20,50,60"/><square name="b" page="0" rect="10,20,50,60" width="-4"/>',
      ),
    );
    const [plain, negative] = read.marks;
    expect(negative?.rect).toEqual([10, 20, 50, 60]);
    expect(negative?.thickness).toBe(0);
    // Written again it is the rectangle it was read from, now with the width it was read with.
    const again = new TextDecoder().decode(
      serializeXfdf({
        marks: plain === undefined ? [] : [toAppSpace(plain, 800)],
        existing: [],
        pageTop: () => 800,
      }).bytes,
    );
    expect(again).toMatch(/<square [^>]*rect="10,20,50,60"[^>]*width="2"/);
  });

  it('typed text: size and colour from the default appearance, black without one, nothing without words', async () => {
    const free = (name: string, appearance: string, contents = '<contents>words</contents>') =>
      `<freetext name="${name}" rect="0,0,50,50">${contents}${appearance}</freetext>`;
    const out = await parseXfdf(
      xfdf(
        [
          free('a', ''),
          free('b', '<defaultappearance>/Helv 14 Tf 1 0.5 0 rg</defaultappearance>'),
          free('c', '<defaultappearance>/Helv 9 Tf 2 0 0 rg</defaultappearance>'),
          free('d', '', '<contents>   </contents>'),
          free('e', '', ''),
        ].join(''),
      ),
    );
    expect(out.skipped).toBe(2);
    expect(out.marks.map((entry) => [entry.color, entry.fontSize])).toEqual([
      ['#000000', undefined],
      ['#ff8000', 14],
      ['#ff0000', 9],
    ]);
  });
});

describe('importing replies and review states', () => {
  const note = (name: string) =>
    `<text name="${name}" page="0" rect="1,2,3,4"><contents>root</contents></text>`;
  const record = (attributes: string, contents = 'answer') =>
    `<text page="0" rect="1,2,3,4" ${attributes}><contents>${contents}</contents></text>`;

  it('attaches a reply to a reply to the comment at the end of its chain, oldest first', async () => {
    const out = await parseXfdf(
      xfdf(
        [
          note('root'),
          record('name="r2" inreplyto="r1" date="D:20261003000000Z" title="B"', 'second'),
          record('name="r1" inreplyto="root" creationdate="D:20261002000000Z" title="A"', 'first'),
        ].join(''),
      ),
    );
    expect(out.marks).toHaveLength(1);
    expect(out.marks[0]?.replies?.map((reply) => [reply.author, reply.contents])).toEqual([
      ['A', 'first'],
      ['B', 'second'],
    ]);
  });

  it('counts a reply to nothing, a reply that answers itself, and two that answer each other', async () => {
    const out = await parseXfdf(
      xfdf(
        [
          note('root'),
          record('name="x" inreplyto="missing"'),
          record('name="self" inreplyto="self"'),
          record('name="p" inreplyto="q"'),
          record('name="q" inreplyto="p"'),
          record('inreplyto="missing"'),
        ].join(''),
      ),
    );
    expect(out.skipped).toBe(5);
    expect(out.marks[0]?.replies).toBeUndefined();
  });

  it('counts a state of another model, an unknown state, and a reply with no words', async () => {
    const out = await parseXfdf(
      xfdf(
        [
          note('root'),
          record('name="a" inreplyto="root" state="Marked" statemodel="Marked"'),
          record('name="b" inreplyto="root" state="Weird" statemodel="Review"'),
          record('name="c" inreplyto="root"', '   '),
        ].join(''),
      ),
    );
    expect(out.skipped).toBe(3);
    expect(out.marks[0]?.review).toBeUndefined();
    expect(out.marks[0]?.replies).toBeUndefined();
  });

  it('keeps the newest review state; one written without a model is a Review state', async () => {
    const out = await parseXfdf(
      xfdf(
        [
          note('root'),
          record('name="a" inreplyto="root" state="Accepted" date="D:20261005000000Z" title="New"'),
          record(
            'name="b" inreplyto="root" state="Rejected" statemodel="Review" date="D:20261001000000Z" title="Old"',
          ),
          record('name="c" inreplyto="root" state="Completed" date="D:20261005000000Z" title="Tie"'),
        ].join(''),
      ),
    );
    // A later record with the same time replaces the earlier one; an older one does not.
    expect(out.marks[0]?.review).toEqual({
      state: 'Completed',
      author: 'Tie',
      at: '2026-10-05T00:00:00.000Z',
    });
    expect(out.skipped).toBe(0);
  });

  it('reads a grouped annotation (replyType group) as a mark of its own, not as a reply', async () => {
    const out = await parseXfdf(
      xfdf(
        [note('root'), '<square name="g" inreplyto="root" replyType="group" page="0" rect="1,2,3,4"/>'].join(
          '',
        ),
      ),
    );
    expect(out.marks.map((entry) => entry.kind)).toEqual(['note', 'shapes']);
  });
});
