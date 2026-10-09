/**
 * XFDF export and import. The wrong answers that matter: a mark that comes back in the
 * wrong place (XFDF is PDF user space, the session is top-left), a line that points the
 * other way, Turkish text that is mangled by the XML round trip, a reply or review state
 * that is detached from its comment, a state model this app does not hold imported as a
 * review, and a file that is not XFDF accepted as an empty review.
 */

import { describe, expect, it } from 'vitest';
import { toAppSpace } from './annotation-data';
import { isXfdf, parseXfdf, serializeXfdf } from './annotation-xfdf';
import type { AnnotationMark, ExistingAnnotation } from './annotations';

const TOP = 800;
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function mark(overrides: Partial<AnnotationMark> & Pick<AnnotationMark, 'id' | 'kind'>): AnnotationMark {
  return {
    pageIndex: 2,
    quads: [],
    color: '#ff8800',
    opacity: 0.5,
    contents: 'Şişli ığüöç',
    author: 'Ayşe',
    createdAt: '2026-10-01T09:30:00.000Z',
    ...overrides,
  };
}

const session: readonly AnnotationMark[] = [
  mark({
    id: 'hl',
    kind: 'highlight',
    quads: [
      [10, 100, 110, 120],
      [10, 125, 80, 145],
    ],
  }),
  mark({
    id: 'ink',
    kind: 'ink',
    quads: [[10, 10, 90, 50]],
    strokes: [[10, 10, 50, 50, 90, 20]],
    thickness: 3,
  }),
  mark({ id: 'ln', kind: 'shapes', shape: 'line', quads: [[50, 60, 300, 400]], rect: [50, 60, 300, 400] }),
  mark({ id: 'sq', kind: 'shapes', shape: 'square', quads: [[20, 30, 120, 90]], rect: [20, 30, 120, 90] }),
  mark({
    id: 'ft',
    kind: 'freetext',
    color: '#1a4dff',
    opacity: 1,
    rect: [50, 60, 270, 79],
    fontSize: 14,
    contents: 'Merhaba dünya',
  }),
  mark({
    id: 'note',
    kind: 'note',
    rect: [100, 120, 124, 144],
    replies: [
      { id: 'r-late', author: 'Mehmet', contents: 'Sonra', createdAt: '2026-10-03T09:00:00.000Z' },
      { id: 'r-early', author: 'Zeynep', contents: 'Önce', createdAt: '2026-10-02T09:00:00.000Z' },
    ],
    review: { state: 'Accepted', author: 'Mehmet', at: '2026-10-04T09:00:00.000Z' },
  }),
];

describe('XFDF round trip of the session marks', () => {
  it('brings every kind back where it was drawn, with its words, colour and thickness', async () => {
    const out = serializeXfdf({ marks: session, existing: [], pageTop: () => TOP });
    expect(out.count).toBe(6);
    expect(out.skipped).toBe(0);
    expect(isXfdf(out.bytes)).toBe(true);

    const parsed = await parseXfdf(out.bytes);
    expect(parsed.space).toBe('pdf-user');
    expect(parsed.skipped).toBe(0);
    expect(parsed.marks).toHaveLength(6);
    const back = parsed.marks.map((entry) => toAppSpace(entry, TOP));
    const [hl, ink, line, square, text, note] = back;

    expect(hl).toMatchObject({ kind: 'highlight', pageIndex: 2, color: '#ff8800', opacity: 0.5 });
    expect(hl?.quads).toEqual([
      [10, 100, 110, 120],
      [10, 125, 80, 145],
    ]);
    expect(hl?.contents).toBe('Şişli ığüöç');
    expect(hl?.author).toBe('Ayşe');
    expect(hl?.createdAt).toBe('2026-10-01T09:30:00.000Z');
    expect(ink).toMatchObject({ kind: 'ink', strokes: [[10, 10, 50, 50, 90, 20]], thickness: 3 });
    // A line's rect is its two ends in drag order: it must not come back pointing the other way.
    expect(line).toMatchObject({ kind: 'shapes', shape: 'line', rect: [50, 60, 300, 400] });
    expect(square).toMatchObject({ kind: 'shapes', shape: 'square', rect: [20, 30, 120, 90] });
    expect(text).toMatchObject({
      kind: 'freetext',
      rect: [50, 60, 270, 79],
      fontSize: 14,
      color: '#1a4dff',
      contents: 'Merhaba dünya',
    });
    expect(note).toMatchObject({ kind: 'note', rect: [100, 120, 124, 144] });
  });

  it('keeps a stroked rectangle, ellipse and ink box their size however often they travel through XFDF', async () => {
    // The XFDF `rect` is the annotation's rectangle, which holds the whole stroke; the
    // shape itself is that rectangle less half the stroke on every side.
    let marks: readonly AnnotationMark[] = [
      mark({
        id: 'sq',
        kind: 'shapes',
        shape: 'square',
        quads: [[100, 100, 200, 150]],
        rect: [100, 100, 200, 150],
        thickness: 10,
      }),
      mark({
        id: 'ci',
        kind: 'shapes',
        shape: 'circle',
        quads: [[50, 300, 150, 360]],
        rect: [50, 300, 150, 360],
        thickness: 4,
      }),
      mark({
        id: 'ink',
        kind: 'ink',
        quads: [[10, 10, 90, 50]],
        strokes: [[10, 10, 50, 50, 90, 20]],
        thickness: 6,
      }),
    ];
    for (let trip = 0; trip < 3; trip += 1) {
      const parsed = await parseXfdf(serializeXfdf({ marks, existing: [], pageTop: () => TOP }).bytes);
      marks = parsed.marks.map((entry) => toAppSpace(entry, TOP));
    }
    const [square, circle, ink] = marks;
    expect(square).toMatchObject({
      rect: [100, 100, 200, 150],
      quads: [[100, 100, 200, 150]],
      thickness: 10,
    });
    expect(circle).toMatchObject({ rect: [50, 300, 150, 360], quads: [[50, 300, 150, 360]], thickness: 4 });
    expect(ink).toMatchObject({ quads: [[10, 10, 90, 50]], thickness: 6 });
  });

  it('narrows a rectangle thinner than its stroke to its centre line, never to an inverted box', async () => {
    const parsed = await parseXfdf(
      encode(
        `<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots><square name="s" page="0" rect="10,20,14,40" width="10"/></annots></xfdf>`,
      ),
    );
    // 4 pt wide under a 10 pt stroke: the width closes on x = 12; the 20 pt height loses 5 a side.
    expect(parsed.marks[0]?.rect).toEqual([12, 25, 12, 35]);
  });

  it('keeps the replies (oldest first) and the review state on their comment, and mints fresh ids', async () => {
    const parsed = await parseXfdf(serializeXfdf({ marks: session, existing: [], pageTop: () => TOP }).bytes);
    const note = parsed.marks[5];
    expect(note?.replies?.map((reply) => [reply.author, reply.contents])).toEqual([
      ['Zeynep', 'Önce'],
      ['Mehmet', 'Sonra'],
    ]);
    expect(note?.review).toEqual({ state: 'Accepted', author: 'Mehmet', at: '2026-10-04T09:00:00.000Z' });
    // The other marks carry no thread.
    expect(parsed.marks.slice(0, 5).every((entry) => entry.replies === undefined)).toBe(true);
    // Fresh ids: neither the originals nor the replies' own ids survive an import.
    const originals = new Set([...session.map((entry) => entry.id), 'r-late', 'r-early']);
    const ids = [...parsed.marks.map((entry) => entry.id), ...(note?.replies ?? []).map((reply) => reply.id)];
    expect(ids.some((id) => originals.has(id))).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('writes a state set by nobody in particular as the bare state, as Acrobat does', () => {
    const anonymous = mark({ id: 'n', kind: 'note', rect: [1, 1, 21, 21] });
    const text = new TextDecoder().decode(
      serializeXfdf({
        marks: [{ ...anonymous, review: { state: 'Accepted', author: '', at: '2026-10-04T09:00:00.000Z' } }],
        existing: [],
        pageTop: () => TOP,
      }).bytes,
    );
    expect(text).toContain('<contents>Accepted</contents>');
    expect(text).not.toContain('set by');
  });
});

describe('XFDF export of the file`s own annotations', () => {
  const file = (id: string, extra: Partial<ExistingAnnotation>): ExistingAnnotation => ({
    id,
    subtype: 'Text',
    pageIndex: 0,
    kind: null,
    rect: [100, 600, 124, 624],
    contents: '',
    marker: null,
    author: 'Ayşe',
    modified: 'D:20261001093000Z',
    ...extra,
  });

  it('writes user-space geometry, threads and skips what the format cannot carry', async () => {
    const out = serializeXfdf({
      marks: [],
      pageTop: () => TOP,
      existing: [
        file('10R', {
          subtype: 'Highlight',
          rect: [10, 680, 110, 700],
          quadPoints: [10, 700, 110, 700, 10, 680, 110, 680],
          color: '#ffd400',
          contents: 'Şişli',
        }),
        file('11R', { subtype: 'Text', contents: 'Kontrol' }),
        file('12R', { subtype: 'Text', contents: 'Cevap', inReplyTo: '11R', replyType: 'R' }),
        file('13R', {
          subtype: 'Text',
          inReplyTo: '11R',
          replyType: 'R',
          state: 'Rejected',
          stateModel: 'Review',
        }),
        file('14R', { subtype: 'Stamp', contents: 'stamp' }),
        file('15R', { subtype: 'Widget' }),
        file('16R', { subtype: 'Popup' }),
        file('17R', {
          subtype: 'Line',
          rect: [10, 10, 100, 50],
          vertices: [100, 10, 10, 50],
        }),
        file('18R', { subtype: 'Link', rect: [10, 10, 60, 30] }),
      ],
    });
    // Comments: highlight, note, line. The reply and the state are not comments; the stamp,
    // the widget and the link are counted as left out, the popup (part of its comment) is not.
    expect(out.count).toBe(3);
    expect(out.skipped).toBe(3);
    const xml = decode(out.bytes);
    expect(xml).toContain('coords="10,700,110,700,10,680,110,680"');
    expect(xml).toContain('start="100,10"');
    expect(xml).toContain('end="10,50"');

    const parsed = await parseXfdf(out.bytes);
    expect(parsed.marks.map((entry) => entry.kind)).toEqual(['highlight', 'note', 'shapes']);
    expect(parsed.marks[0]?.quads).toEqual([[10, 680, 110, 700]]);
    const note = parsed.marks[1];
    expect(note?.replies?.map((reply) => reply.contents)).toEqual(['Cevap']);
    expect(note?.review?.state).toBe('Rejected');
    // The page the file's own annotation sits on is written as it is (0-based).
    expect(parsed.marks.every((entry) => entry.pageIndex === 0)).toBe(true);
  });
});

describe('parseXfdf and isXfdf', () => {
  const wrap = (inner: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>${inner}</annots></xfdf>`;

  it('skips and counts a Marked state, a reply to a comment that is not there and an unreadable element', async () => {
    const parsed = await parseXfdf(
      encode(
        wrap(
          '<text page="0" rect="1,1,21,21" name="a" title="X"><contents>kept</contents></text>' +
            '<text page="0" rect="1,1,21,21" name="m" inreplyto="a" state="Marked" statemodel="Marked"/>' +
            '<text page="0" rect="1,1,21,21" name="o" inreplyto="gone"><contents>orphan</contents></text>' +
            '<square page="0" name="norect"/>' +
            '<stamp page="0" rect="1,1,2,2" name="s"/>',
        ),
      ),
    );
    expect(parsed.marks).toHaveLength(1);
    expect(parsed.marks[0]?.contents).toBe('kept');
    expect(parsed.marks[0]?.review).toBeUndefined();
    expect(parsed.marks[0]?.replies).toBeUndefined();
    expect(parsed.skipped).toBe(4);
  });

  it('refuses a document that is malformed or is not XFDF', async () => {
    await expect(parseXfdf(encode('<xfdf><annots><text></annots></xfdf>'))).rejects.toMatchObject({
      code: 'unsupported-format',
    });
    await expect(parseXfdf(encode('<html><body/></html>'))).rejects.toMatchObject({
      code: 'unsupported-format',
    });
    await expect(parseXfdf(encode('{"marks": []}'))).rejects.toMatchObject({ code: 'unsupported-format' });
  });

  it('recognises XFDF by its root element, with a BOM or a comment first, and nothing else', () => {
    expect(isXfdf(encode(wrap('')))).toBe(true);
    expect(isXfdf(encode('﻿<!-- review --><xfdf xmlns="http://ns.adobe.com/xfdf/"/>'))).toBe(true);
    expect(isXfdf(encode('<?xml version="1.0"?><html/>'))).toBe(false);
    expect(isXfdf(encode('%FDF-1.2\n1 0 obj'))).toBe(false);
  });
});
