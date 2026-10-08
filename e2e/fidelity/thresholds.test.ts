import { describe, expect, it } from 'vitest';
import { type ThresholdTable, thresholdFor } from './thresholds';

const table: ThresholdTable = {
  flow: {
    default: { ssim: 0.8, words: 0.9 },
    nulled: { ssim: null, words: null },
    partial: { ssim: 0.5 },
    numbers: { ssim: 0.7, words: 0.95 },
  },
};

describe('thresholdFor', () => {
  it('falls back to the default for a missing sample', () => {
    expect(thresholdFor(table, 'flow', 'unknown')).toEqual({ ssim: 0.8, words: 0.9 });
  });

  it('keeps an explicit null as "not gated" despite a numeric default', () => {
    expect(thresholdFor(table, 'flow', 'nulled')).toEqual({ ssim: null, words: null });
  });

  it('uses the sample number, and the default for a missing key', () => {
    expect(thresholdFor(table, 'flow', 'numbers')).toEqual({ ssim: 0.7, words: 0.95 });
    expect(thresholdFor(table, 'flow', 'partial')).toEqual({ ssim: 0.5, words: 0.9 });
  });

  it('is not gated for a missing mode', () => {
    expect(thresholdFor(table, 'nope', 'numbers')).toEqual({ ssim: null, words: null });
  });
});
