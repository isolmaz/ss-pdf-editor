/**
 * Spike #2 (`tools/spikes/journal-undo/report.ts`) declares
 * `window.__spikeResult` with its own result type inside the same TypeScript
 * program, so this spike reaches the globals through one explicit cast instead
 * of a second, conflicting `declare global` — the convention
 * `tools/spikes/text-replace/globals.ts` already uses.
 */
import type { BranchResult } from './harness';

export interface SpikeWindow {
  __spikeResult: BranchResult[] | null;
  __spikeError: string | null;
  __spikeProgress: string;
  __spikeRun: (() => Promise<BranchResult[]>) | null;
}

export const spikeWindow = window as unknown as SpikeWindow;
