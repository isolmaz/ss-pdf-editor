/**
 * Comment threads from a file's annotations. The wrong answers that matter: a reply to a
 * reply that is not folded under its comment (or is given the wrong depth), an older
 * review state that wins over a newer one, a `/RT /Group` annotation treated as a reply,
 * and a record whose comment is gone vanishing from the list instead of staying a row.
 */

import { describe, expect, it } from 'vitest';
import { commentThreads, formatPdfDate, parsePdfDate, reviewDateMillis } from './annotation-threads';
import type { ExistingAnnotation } from './annotations';

function annotation(id: string, extra: Partial<ExistingAnnotation> = {}): ExistingAnnotation {
  return {
    id,
    subtype: 'Text',
    pageIndex: 0,
    kind: 'note',
    rect: [0, 0, 20, 20],
    contents: id,
    marker: null,
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

  it('orders replies by the moment their dates name, not by the clock face of a time zone', () => {
    // 09:00 at +03:00 is 06:00 UTC: earlier than the 07:00 UTC reply, though its digits are larger.
    const { threads } = commentThreads([
      annotation('1R'),
      annotation('2R', { inReplyTo: '1R', modified: 'D:20261002070000Z' }),
      annotation('3R', { inReplyTo: '1R', modified: "D:20261002090000+03'00'" }),
    ]);
    expect(threads.get('1R')?.replies.map((item) => item.annotation.id)).toEqual(['3R', '2R']);
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

  it('orders replies by their creation date when they have no modification date, undated ones first', () => {
    const { threads } = commentThreads([
      annotation('1R'),
      annotation('2R', { inReplyTo: '1R', created: 'D:20261003100000Z' }),
      annotation('3R', { inReplyTo: '1R', created: 'D:20261001100000Z' }),
      annotation('4R', { inReplyTo: '1R' }),
      annotation('5R', { inReplyTo: '1R', modified: 'D:20261002100000Z', created: 'D:20261009100000Z' }),
    ]);
    expect(threads.get('1R')?.replies.map((item) => item.annotation.id)).toEqual(['4R', '3R', '5R', '2R']);
  });

  it('reads a state record without a state model as a Review, dated by its creation date or by nothing', () => {
    const { threads } = commentThreads([
      annotation('1R'),
      annotation('2R', { inReplyTo: '1R', state: 'Accepted', author: 'Bea', created: 'D:20261001100000Z' }),
      annotation('3R'),
      annotation('4R', { inReplyTo: '3R', state: 'Rejected', author: 'Cem' }),
    ]);
    expect(threads.get('1R')?.review).toEqual({ state: 'Accepted', author: 'Bea', at: 'D:20261001100000Z' });
    expect(threads.get('1R')?.replies).toEqual([]);
    expect(threads.get('3R')?.review).toEqual({ state: 'Rejected', author: 'Cem', at: null });
    expect(threads.get('3R')?.marked).toBe(false);
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

  it('applies the time zone of a PDF date, in every spelling a producer writes it', () => {
    const utc = Date.UTC(2026, 9, 2, 6, 0, 0);
    for (const raw of [
      "D:20261002080000+02'00'",
      "D:20261002080000+02'00",
      'D:20261002080000+0200',
      'D:20261002080000+02',
      "D:20261002080000+02'",
      'D:20261002060000Z',
      "D:20261002060000Z00'00'",
      "D:20261001223000-07'30'",
    ]) {
      expect(reviewDateMillis(raw), raw).toBe(utc);
    }
  });

  it('answers 0 for a date no calendar has, instead of rolling it into the next month or year', () => {
    for (const raw of [
      'D:20241301', // month 13 was read as January of the next year
      'D:20240100', // day 0 was read as the last day of the year before
      'D:20240230', // the 30th of February
      'D:20230229', // not a leap year
      'D:20260101250000', // hour 25
      'D:20260101006000', // minute 60
      'D:20260101000060', // second 60
      "D:20260101000000+24'00'", // a zone of a day
      "D:20260101000000+02'60'",
      'D:00000101',
      'D:2026010',
      'D:20261002080000 +02',
      'D:2026-10-02',
    ]) {
      expect(reviewDateMillis(raw), raw).toBe(0);
    }
    expect(reviewDateMillis('D:20240229')).toBe(Date.UTC(2024, 1, 29));
  });
});

describe('parsePdfDate', () => {
  it('is null for what is not a date, and the moment for what is', () => {
    expect(parsePdfDate('D:20241301')).toBeNull();
    expect(parsePdfDate('2026-10-02T08:00:00Z')).toBeNull();
    expect(parsePdfDate(" D:20261002080910+03'00' ")).toBe(Date.UTC(2026, 9, 2, 5, 9, 10));
    // A two-digit year is the year it says, not 19xx (`Date.UTC(99, …)` is 1999).
    expect(parsePdfDate('D:0099')).toBe(new Date('0099-01-01T00:00:00Z').getTime());
  });
});

describe('formatPdfDate', () => {
  it('writes the UTC moment as D:YYYYMMDDHHmmSSZ, which parsePdfDate reads back', () => {
    const moment = Date.UTC(2026, 9, 2, 6, 5, 4);
    expect(formatPdfDate(moment)).toBe('D:20261002060504Z');
    expect(parsePdfDate(formatPdfDate(moment) as string)).toBe(moment);
    expect(formatPdfDate(Number.NaN)).toBeNull();
    expect(formatPdfDate(Date.UTC(10000, 0, 1))).toBeNull();
  });
});
