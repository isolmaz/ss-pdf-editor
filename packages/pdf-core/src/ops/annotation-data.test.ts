/**
 * Comment exchange files. The wrong answers that matter: a note that comes back from
 * its own export with no place on the page (its place is in `rect`, not `quads`), and
 * an Acrobat comment that lands mirrored about the page's middle because its user-space
 * coordinates were read as the app's top-left space.
 */

import { describe, expect, it } from 'vitest';
import {
  parseAnnotationData,
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
