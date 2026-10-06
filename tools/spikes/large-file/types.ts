/**
 * Result shape for spike #5 (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * Everything the decision note needs is in here: fixture recipe outcome, the
 * per-step memory table, timings, save behaviour, the degradation probe and the
 * provisional-target verdicts. `window.__spikeResult` is this object, and it is
 * written to localStorage after every step so a tab crash during the
 * degradation probe does not lose the numbers.
 */

export type Step =
  | 'baseline'
  | 'fixture'
  | 'opened'
  | 'first-page'
  | 'rendered'
  | 'saved'
  | 'released'
  | 'destroyed';

export interface MemoryStep {
  readonly step: string;
  /** `performance.measureUserAgentSpecificMemory().bytes` — the agent cluster total. */
  readonly agentClusterBytes: number | null;
  /** `performance.memory.usedJSHeapSize` — the JS heap only (no ArrayBuffer backing store). */
  readonly jsHeapBytes: number | null;
  readonly atMs: number;
  readonly accountedBytes: number | null;
  readonly comment: string;
}

export interface RealmBreakdown {
  readonly step: string;
  readonly label: string;
  readonly bytes: number;
  readonly types: readonly string[];
}

export interface MemoryApiInfo {
  readonly crossOriginIsolated: boolean;
  readonly uaSpecificMemory: boolean;
  readonly jsHeap: boolean;
  readonly jsHeapLimitBytes: number | null;
}

export interface FixtureInfo {
  readonly id: string;
  /** Where the bytes came from — the page never builds a fixture (`NOTES.md` re-run recipe). */
  readonly origin: string;
  readonly pages: number;
  readonly bytes: number;
  readonly dpi: number;
  readonly raster: string;
  readonly quality: number;
  readonly grain: number;
  readonly perPageJpegBytes: number;
  readonly minJpegBytes: number;
  readonly maxJpegBytes: number;
  readonly distinctJpegSizes: number;
  /** Sum of the embedded JPEG payloads vs the final PDF size — proves the writer kept every page distinct. */
  readonly jpegBytes: number;
  readonly pdfOverJpegRatio: number;
  readonly generateMs: number;
}

export interface SaveInfo {
  readonly attempted: boolean;
  readonly keyUsed: string | null;
  readonly keysTried: readonly string[];
  readonly ms: number | null;
  readonly inputBytes: number;
  readonly outputBytes: number | null;
  readonly deltaBytes: number | null;
  /** Incremental save = output starts with the exact input bytes. */
  readonly incrementalFormat: boolean | null;
  /** The new field value is present in the appended update. */
  readonly markerFoundInTail: boolean | null;
  readonly fieldValueAfterReopen: string | null;
  readonly peakHeapDuringSaveBytes: number | null;
  readonly error: string | null;
}

export interface RenderingInfo {
  readonly pages: number;
  readonly scale: number;
  readonly perPageMs: readonly number[];
  readonly totalMs: number;
  readonly canvasBytes: number;
}

export interface RunInfo {
  readonly id: string;
  readonly label: string;
  readonly pages: number;
  readonly bytes: number;
  /** HTTP pull of the fixture into this page — the "open the file from disk" cost, before parsing. */
  loadMs: number;
  openMs: number;
  firstPageMs: number | null;
  openToFirstPageMs: number | null;
  render: RenderingInfo | null;
  save: SaveInfo | null;
  dataDetachedAfterOpen: boolean;
  destroyMs: number | null;
  releasedAgentClusterBytes: number | null;
  readonly error: string | null;
}

/**
 * Peaks sampled **during** the run, which is the only way to see the
 * old-buffer/new-buffer overlap inside `saveDocument()` — step-boundary samples
 * miss it. The caveat is part of the number: see `caveat`.
 */
export interface PeakMemory {
  /** Max of `performance.memory.usedJSHeapSize` (JS heap only — ArrayBuffer backing stores are invisible to it). */
  readonly jsHeapPeakBytes: number | null;
  readonly jsHeapSamples: number;
  readonly jsHeapIntervalMs: number;
  /** Max of `performance.measureUserAgentSpecificMemory().bytes` (agent cluster: main realm + pdf.js worker). */
  readonly agentClusterPeakBytes: number | null;
  readonly agentClusterSamples: number;
  readonly agentClusterFailures: number;
  readonly agentClusterIntervalMs: number;
  readonly caveat: string;
}

export interface DegradationInfo {
  readonly documentOpen: boolean;
  readonly extraAllocatedBytes: number;
  readonly allocationMs: number;
  readonly failedAtBytes: number | null;
  readonly failureMode: string;
  readonly renderDuringPressureMs: number | null;
  readonly cancelDuringPressureMs: number | null;
  readonly cancelHonoured: boolean | null;
  readonly frameGapMs: number | null;
  readonly secondHeavyJob: string;
  readonly heapDuringPressureBytes: number | null;
  readonly survived: boolean;
}

export interface TargetCheck {
  readonly target: string;
  readonly measured: string;
  readonly verdict: 'confirmed' | 'missed' | 'not tested';
}

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface SpikeResult {
  readonly environment: {
    readonly userAgent: string;
    readonly platform: string;
    readonly hardwareConcurrency: number;
    readonly deviceMemoryGb: number | null;
    readonly crossOriginIsolated: boolean;
    readonly startedAt: string;
  };
  readonly memoryApi: MemoryApiInfo;
  /** Sampled peaks for the whole run (both APIs), reported side by side with their caveat. */
  peaks: PeakMemory;
  readonly fixtures: FixtureInfo[];
  readonly runs: RunInfo[];
  readonly memory: MemoryStep[];
  readonly breakdown: RealmBreakdown[];
  degradation: DegradationInfo | null;
  readonly targets: TargetCheck[];
  readonly checks: Check[];
  readonly notes: string[];
  phase: string;
  readonly failures: string[];
}
