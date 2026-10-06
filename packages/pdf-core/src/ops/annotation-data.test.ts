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
import { type AnnotationMark, commentText, contentsFor } from './annotations';

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
});

describe('commentText', () => {
  it('shows the words of a comment this app wrote, without its marker', () => {
    expect(commentText(contentsFor(note()))).toBe('Kontrol et');
  });

  it('shows nothing for a mark written without a comment', () => {
    expect(commentText(contentsFor({ ...note(), contents: '' }))).toBe('');
  });

  it('leaves a comment from another application as it is', () => {
    expect(commentText('Reviewed by legal')).toBe('Reviewed by legal');
  });
});
