/**
 * What a running operation's report becomes on screen. The wrong answers that matter: a
 * `{done}`/`{page}` placeholder printed raw because the caller passed no params, a
 * fractional page count ("2.4/10") from OCR's mid-page reports, and a count that runs past
 * the total once the last page is done.
 */

import { describe, expect, it } from 'vitest';
import { createTranslator } from './i18n';
import { progressCounts, progressLabel, progressLine } from './progress';

const t = createTranslator('en');

describe('progressCounts', () => {
  it('rounds a fractional done down for the count and keeps its fraction for the percentage', () => {
    expect(progressCounts({ done: 2.4, total: 10 })).toEqual({ done: 2, total: 10, percent: 24, page: 3 });
    expect(progressCounts({ done: 0, total: 4 })).toEqual({ done: 0, total: 4, percent: 0, page: 1 });
  });

  it('never reports more than the total, and never a page past the last one', () => {
    expect(progressCounts({ done: 10, total: 10 })).toEqual({ done: 10, total: 10, percent: 100, page: 10 });
    expect(progressCounts({ done: 12, total: 10 })).toEqual({ done: 10, total: 10, percent: 100, page: 10 });
    expect(progressCounts({ done: -3, total: 10 })).toEqual({ done: 0, total: 10, percent: 0, page: 1 });
  });

  it('counts a report without a total as nothing to count against', () => {
    expect(progressCounts({})).toEqual({ done: 0, total: 0, percent: 0, page: 1 });
    expect(progressCounts({ done: 5 })).toEqual({ done: 0, total: 0, percent: 0, page: 1 });
    expect(progressCounts({ done: 1, total: 0 })).toEqual({ done: 0, total: 0, percent: 0, page: 1 });
  });
});

describe('progressLabel', () => {
  it('fills the label`s own counters with whole numbers in both languages', () => {
    const report = { labelKey: 'ocr.running', done: 2.4, total: 10 } as const;
    expect(progressLabel(t, report)).toBe('Recognizing page 3/10');
    expect(progressLabel(createTranslator('tr'), report)).toBe('Sayfa 3/10 tanınıyor');
  });

  it('stays on the last page when the last page is done, and leaves a counter-free label as it is', () => {
    expect(progressLabel(t, { labelKey: 'ocr.running', done: 10, total: 10 })).toBe('Recognizing page 10/10');
    expect(progressLabel(t, { labelKey: 'op.running' })).toBe('Processing…');
  });
});

describe('progressLine', () => {
  it('adds the whole-number count after the sentence when the report has a total', () => {
    expect(progressLine(t, { labelKey: 'compare.running', done: 2.6, total: 5 })).toBe('Comparing… (2/5)');
    expect(progressLine(t, { labelKey: 'ocr.running', done: 2.4, total: 10 })).toBe(
      'Recognizing page 3/10 (2/10)',
    );
  });

  it('shows the sentence alone when there is nothing to count against', () => {
    expect(progressLine(t, { labelKey: 'compare.running' })).toBe('Comparing…');
    expect(progressLine(t, { labelKey: 'compare.running', done: 0, total: 0 })).toBe('Comparing…');
  });
});
