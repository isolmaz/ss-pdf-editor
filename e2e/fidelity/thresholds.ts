import type { Threshold } from './report';

export type ThresholdTable = Record<string, Record<string, Partial<Threshold>>>;

/**
 * The gate for one sample in one mode. A key present on the sample wins, even when it is
 * `null` ("measured, not gated"); only a missing key falls back to the mode's `default`.
 */
export function thresholdFor(table: ThresholdTable, mode: string, sample: string): Threshold {
  const modeTable = table[mode] ?? {};
  const pick = (key: keyof Threshold): number | null => {
    const own = modeTable[sample];
    if (own && key in own) return own[key] ?? null;
    return modeTable.default?.[key] ?? null;
  };
  return { ssim: pick('ssim'), words: pick('words') };
}
