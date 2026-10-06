/**
 * Comment threads from a file's annotations. The wrong answers that matter: a reply to a
 * reply that is not folded under its comment (or is given the wrong depth), an older
 * review state that wins over a newer one, a `/RT /Group` annotation treated as a reply,
 * and a record whose comment is gone vanishing from the list instead of staying a row.
 */

import { describe, expect, it } from 'vitest';
import { commentThreads, reviewDateMillis } from './annotation-threads';
import type { ExistingAnnotation } from './annotations';

function annotation(id: string, extra: Partial<ExistingAnnotation> = {}): ExistingAnnotation {
  return {
    id,
    subtype: 'Text',
    pageIndex: 0,
    kind: 'note',
    rect: [0, 0, 20, 20],
    contents: id,
    author: 'A',
    modified: null,
    ...extra,
  };
}

describe('commentThreads', () => {
  it('folds a reply to a reply under the comment, with its depth, oldest first', () => {
    const { threads, records } = commentThreads([
      annotation('1R'),
      annotation('3R', { inReplyTo: '2R', modified: 'D:20261003100000Z' }),
      annotation('2R', { inReplyTo: '1R', modified: 'D:20261002100000Z' }),
    ]);
    expect([...records].sort()).toEqual(['2R', '3R']);
    const thread = threads.get('1R');
    expect(thread?.replies.map((item) => [item.annotation.id, item.depth])).toEqual([
      ['2R', 1],
      ['3R', 2],
    ]);
    expect([...(thread?.records ?? [])].sort()).toEqual(['2R', '3R']);
    expect(thread?.review).toBeNull();
    expect(threads.has('2R')).toBe(false);
  });

  it('takes the newest Review state, keeps it out of the replies, and reads Marked on its own', () => {
    const { threads } = commentThreads([
      annotation('1R'),
      annotation('2R', {
        inReplyTo: '1R',
        state: 'Accepted',
        stateModel: 'Review',
        modified: 'D:20261001100000Z',
      }),
      annotation('4R', {
        inReplyTo: '1R',
        state: 'Completed',
        stateModel: 'Review',
        modified: 'D:20261005100000Z',
      }),
      annotation('3R', {
        inReplyTo: '1R',
        state: 'Rejected',
        stateModel: 'Review',
        modified: 'D:20261003100000Z',
      }),
      annotation('5R', {
        inReplyTo: '1R',
        state: 'Marked',
        stateModel: 'Marked',
        modified: 'D:20261004100000Z',
      }),
      annotation('6R', { inReplyTo: '1R', contents: 'a reply', modified: 'D:20261002100000Z' }),
    ]);
    const thread = threads.get('1R');
    expect(thread?.review).toMatchObject({ state: 'Completed', at: 'D:20261005100000Z' });
    expect(thread?.marked).toBe(true);
    expect(thread?.replies.map((item) => item.annotation.id)).toEqual(['6R']);
    expect(thread?.records).toHaveLength(5);
  });

  it('leaves /RT /Group annotations and orphaned records as rows of their own', () => {
    const { threads, records } = commentThreads([
      annotation('1R'),
      annotation('2R', { inReplyTo: '1R', replyType: 'Group' }),
      annotation('3R', { inReplyTo: '99R' }),
      annotation('4R', { inReplyTo: '5R' }),
      annotation('5R', { inReplyTo: '4R' }),
    ]);
    expect(records.size).toBe(0);
    expect(threads.size).toBe(0);
  });
});

describe('reviewDateMillis', () => {
  it('reads PDF dates, partial PDF dates and ISO 8601, and answers 0 for anything else', () => {
    expect(reviewDateMillis('D:20261005103045Z')).toBe(Date.UTC(2026, 9, 5, 10, 30, 45));
    expect(reviewDateMillis('D:2026')).toBe(Date.UTC(2026, 0, 1));
    expect(reviewDateMillis('2026-10-05T10:30:45.000Z')).toBe(Date.UTC(2026, 9, 5, 10, 30, 45));
    expect(reviewDateMillis('not a date')).toBe(0);
    expect(reviewDateMillis(null)).toBe(0);
    expect(reviewDateMillis(undefined)).toBe(0);
  });
});
