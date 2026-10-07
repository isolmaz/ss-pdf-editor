import { describe, expect, it } from 'vitest';
import { parsePageRange } from './pageRange';

describe('parsePageRange', () => {
  it('reads single pages and ranges, ascending and without duplicates', () => {
    expect(parsePageRange('8-10, 1-3, 5, 2', 12)).toEqual({ ok: true, pages: [1, 2, 3, 5, 8, 9, 10] });
  });

  it('accepts ; as a separator, spaces around the dash and the dashes other keyboards type', () => {
    expect(parsePageRange('1 - 2; 4\u20135; 7\u22128; 10\u201411', 12)).toEqual({
      ok: true,
      pages: [1, 2, 4, 5, 7, 8, 10, 11],
    });
    // A pasted range with non-breaking spaces around the dash.
    expect(parsePageRange('2\u00a0-\u202f3', 5)).toEqual({ ok: true, pages: [2, 3] });
  });

  it('prints a backwards range forwards and clamps every number to the document', () => {
    expect(parsePageRange('3-1', 5)).toEqual({ ok: true, pages: [1, 2, 3] });
    expect(parsePageRange('0, 4-99', 6)).toEqual({ ok: true, pages: [1, 4, 5, 6] });
  });

  it('skips empty tokens between separators', () => {
    expect(parsePageRange(',1,,2,', 3)).toEqual({ ok: true, pages: [1, 2] });
  });

  it('names the token it cannot read: a word, a half range, two dashes', () => {
    expect(parsePageRange('1, two', 5)).toEqual({ ok: false, reason: 'invalid', value: 'two' });
    expect(parsePageRange('2-', 5)).toEqual({ ok: false, reason: 'invalid', value: '2-' });
    expect(parsePageRange('-3', 5)).toEqual({ ok: false, reason: 'invalid', value: '-3' });
    expect(parsePageRange('1-2-3', 5)).toEqual({ ok: false, reason: 'invalid', value: '1-2-3' });
  });

  it('calls a field with no page in it, or a document with no pages, an empty selection', () => {
    expect(parsePageRange(' , ; ', 5)).toEqual({ ok: false, reason: 'empty', value: '' });
    expect(parsePageRange('1-3', 0)).toEqual({ ok: false, reason: 'empty', value: '' });
  });
});
