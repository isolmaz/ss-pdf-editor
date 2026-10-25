/**
 * The reading order of units laid out left to right on a page (UAX #9 rule L2, undone). The wrong
 * answers that matter: a right-to-left run read from its left end, a left-to-right word inside a
 * right-to-left line read from the wrong side, a neutral (space, number) put on the wrong side of
 * the word it stands between, and a left-to-right sentence with a Hebrew word in it reordered as
 * if it were a Hebrew sentence.
 */

import { describe, expect, it } from 'vitest';
import {
  bidiClass,
  charDirection,
  type Direction,
  displayOrder,
  hasRtlScript,
  letterCounts,
  readingOrder,
  resolveNeutrals,
} from './bidi';

const R: Direction = 'rtl';
const L: Direction = 'ltr';
const N: Direction = null;

describe('bidi', () => {
  it('knows the right-to-left scripts and the direction of a letter', () => {
    expect(hasRtlScript('abc')).toBe(false);
    expect(hasRtlScript('a\u05D0')).toBe(true);
    expect(hasRtlScript('\u0645')).toBe(true);
    expect(hasRtlScript('\uFB1D')).toBe(true);
    expect([charDirection('a'), charDirection('\u05D0'), charDirection('\u0645')]).toEqual([L, R, R]);
    // A digit, a space, a sign and a combining mark have no direction of their own.
    expect(['1', ' ', '-', '\u05B0'].map(charDirection)).toEqual([N, N, N, N]);
    expect(letterCounts('ab \u05D0\u05D1\u05D2 1')).toEqual({ rtl: 3, ltr: 2 });
  });

  it('classes a character as UAX #9 does: letters by script, numbers, separators, terminators, neutrals', () => {
    expect(['a', 'א', 'م', '5', '۵', '٥', '-', '%', '.', ' ', '(', 'ְ'].map(bidiClass)).toEqual([
      'L',
      'R',
      'AL',
      'EN',
      'EN',
      'AN',
      'ES',
      'ET',
      'CS',
      'ON',
      'ON',
      'ON',
    ]);
    // A cluster is classed by its first character.
    expect(bidiClass('אְ')).toBe('R');
    expect(bidiClass('\u{1F600}')).toBe('ON');
  });

  it('puts the units of a right-to-left paragraph where the page shows them, left to right', () => {
    // Letters of the script only: the whole run reversed.
    expect(displayOrder(['R', 'R', 'R'])).toEqual([2, 1, 0]);
    // A number inside it keeps its own order, and stands to the left of the letters read before it.
    expect(displayOrder(['R', 'EN', 'EN'])).toEqual([1, 2, 0]);
    expect(displayOrder([])).toEqual([]);
  });

  it('gives a neutral the direction of the letters on both sides, else the paragraph direction', () => {
    expect(resolveNeutrals([R, N, R], false)).toEqual([R, R, R]);
    expect(resolveNeutrals([L, N, L], true)).toEqual([L, L, L]);
    expect(resolveNeutrals([R, N, L], false)).toEqual([R, L, L]);
    expect(resolveNeutrals([R, N, L], true)).toEqual([R, R, L]);
    // At either end, the paragraph direction stands beyond it.
    expect(resolveNeutrals([N, R], true)).toEqual([R, R]);
    expect(resolveNeutrals([N, R], false)).toEqual([L, R]);
    expect(resolveNeutrals([R, N], false)).toEqual([R, L]);
    expect(resolveNeutrals([N], true)).toEqual([R]);
    expect(resolveNeutrals([], false)).toEqual([]);
  });

  it('reads a right-to-left paragraph from its rightmost unit, a left-to-right unit inside it whole', () => {
    // On the page: three Hebrew words.
    expect(readingOrder([R, R, R], true)).toEqual([2, 1, 0]);
    // Hebrew, a Latin word and a number, Hebrew, on the page left to right.
    expect(readingOrder([R, L, L, R], true)).toEqual([3, 1, 2, 0]);
    // A space between two Hebrew words belongs to the run.
    expect(readingOrder([R, N, R], true)).toEqual([2, 1, 0]);
  });

  it('reads the right-to-left run of a left-to-right paragraph from its right end, the rest as it stands', () => {
    // `xyz` then two Hebrew words that stand right to left after it.
    expect(readingOrder([L, R, R], false)).toEqual([0, 2, 1]);
    // A lone Hebrew word, or the Latin around it, does not move.
    expect(readingOrder([L, R], false)).toEqual([0, 1]);
    expect(readingOrder([R, L], false)).toEqual([0, 1]);
    expect(readingOrder([L, N, L], false)).toEqual([0, 1, 2]);
    expect(readingOrder([L, L], true)).toEqual([0, 1]);
    expect(readingOrder([], true)).toEqual([]);
  });
});
