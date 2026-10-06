/**
 * Globals published by spike #3 (throwaway, `PLAN.md §9/K21`).
 *
 * Spike #2 (`tools/spikes/journal-undo/report.ts`) declares `window.__spikeResult`
 * with its own result type inside the same TypeScript program, so this spike
 * reaches the globals through one explicit cast instead of a second, conflicting
 * `declare global`.
 */
import type { SpikeResult } from './main';

export interface SpikeWindow {
  __runSpike: (options: {
    fontBase64: string;
    fontName?: string;
    fontSource?: string;
  }) => Promise<SpikeResult>;
  __spikeResult: SpikeResult | null;
  __spikeError: string | null;
  __spikeProgress: string[];
}

export const spikeWindow = window as unknown as SpikeWindow;
