import { describe, expect, it } from 'vitest';
import { compressionPresets } from './export-presets';

/**
 * Regression: the export dialog's compression level (HIGH / MEDIUM / LOW) was read and
 * dropped, so every level opened the same Optimize form.
 */
describe('compressionPresets', () => {
  it('gives each level its own form values', () => {
    const levels = ['high', 'medium', 'low'].map((level) => compressionPresets(level));
    expect(new Set(levels.map((preset) => JSON.stringify(preset))).size).toBe(3);
  });

  it('rasterises only for the high level and clears metadata from the medium level up', () => {
    expect(compressionPresets('high')).toMatchObject({ mode: 'raster' });
    expect(compressionPresets('medium')).toEqual({ mode: 'structure', stripMetadata: true });
    expect(compressionPresets('low')).toEqual({ mode: 'structure', stripMetadata: false });
  });
});
