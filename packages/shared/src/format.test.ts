import { describe, expect, it } from 'vitest';
import { formatBytes, formatDegrees, formatPercent } from './format';

describe('formatBytes', () => {
  it('writes bytes, kilobytes and megabytes with one decimal', () => {
    expect(formatBytes(1023, 'en')).toBe('1023 B');
    expect(formatBytes(1024, 'en')).toBe('1.0 KB');
    expect(formatBytes(1536, 'en')).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024, 'en')).toBe('1.0 MB');
    expect(formatBytes(5.25 * 1024 * 1024, 'en')).toBe('5.3 MB');
  });

  it('writes the decimal mark of the locale', () => {
    expect(formatBytes(1536, 'tr')).toBe('1,5 KB');
    expect(formatBytes(5.25 * 1024 * 1024, 'tr')).toBe('5,3 MB');
    expect(formatBytes(900, 'tr')).toBe('900 B');
  });
});

describe('formatPercent', () => {
  it('rounds to a whole percent and puts the sign where the language does', () => {
    expect(formatPercent(1.4, 'en')).toBe('140%');
    expect(formatPercent(1.256, 'en')).toBe('126%');
    expect(formatPercent(1.4, 'tr')).toBe('%140');
    expect(formatPercent(0.25, 'tr')).toBe('%25');
  });

  it('keeps the decimals asked for, with the mark of the locale', () => {
    expect(formatPercent(0.0037, 'en', 2)).toBe('0.37%');
    expect(formatPercent(0.0037, 'tr', 2)).toBe('%0,37');
    expect(formatPercent(0.125, 'tr', 2)).toBe('%12,50');
    expect(formatPercent(0.0037, 'tr')).toBe('%0');
  });
});

describe('formatDegrees', () => {
  it('writes an angle to one decimal, with the decimal mark of the locale', () => {
    expect(formatDegrees(1.84, 'en')).toBe('1.8°');
    expect(formatDegrees(1.84, 'tr')).toBe('1,8°');
    expect(formatDegrees(12, 'tr')).toBe('12,0°');
    expect(formatDegrees(0.1, 'en')).toBe('0.1°');
  });
});
