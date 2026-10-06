/**
 * Memory measurement helpers for spike #5 (throwaway — `PLAN.md §9/K21`).
 *
 * Two APIs, deliberately reported side by side because they answer different
 * questions:
 *   · `performance.measureUserAgentSpecificMemory()` — the agent-cluster total
 *     (main realm + the pdf.js worker + their backing stores). It forces a
 *     garbage collection before measuring, so it reports what is *retained*.
 *     It only exists in a cross-origin isolated realm, which is why the spike
 *     harness sets COOP/COEP (see `vite.config.ts`).
 *   · `performance.memory.usedJSHeapSize` — the JS heap of the main realm only;
 *     it does **not** include ArrayBuffer/typed-array backing stores, so a
 *     300 MB master copy is invisible to it. It also never GCs, hence the
 *     "peak" snapshots taken by polling during long operations.
 */
import type { MemoryApiInfo, MemoryStep, PeakMemory, RealmBreakdown } from './types';

interface JsHeap {
  readonly usedJSHeapSize: number;
  readonly totalJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}

interface AttributionEntry {
  readonly url?: string;
  readonly scope?: string;
  readonly container?: { readonly id?: string; readonly src?: string };
}

interface MemoryBreakdownEntry {
  readonly bytes: number;
  readonly attribution?: readonly AttributionEntry[];
  readonly types?: readonly string[];
}

interface UaSpecificMemoryResult {
  readonly bytes: number;
  readonly breakdown?: readonly MemoryBreakdownEntry[];
}

interface MemoryPerformance extends Performance {
  readonly memory?: JsHeap;
  measureUserAgentSpecificMemory?: () => Promise<UaSpecificMemoryResult>;
}

const startedAt = performance.now();

function perf(): MemoryPerformance {
  return performance as MemoryPerformance;
}

export function jsHeapUsedBytes(): number | null {
  return perf().memory?.usedJSHeapSize ?? null;
}

export function memoryApiInfo(): MemoryApiInfo {
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    uaSpecificMemory: typeof perf().measureUserAgentSpecificMemory === 'function',
    jsHeap: perf().memory !== undefined,
    jsHeapLimitBytes: perf().memory?.jsHeapSizeLimit ?? null,
  };
}

/**
 * Polls `performance.memory` while a long operation runs, to capture a peak the
 * step-boundary samples cannot see — the old + new buffer overlap inside
 * `saveDocument()`, for example.
 */
export class HeapPoller {
  peak = 0;
  samples = 0;
  private handle: number | null = null;

  constructor(private readonly intervalMs = 200) {}

  start(): void {
    this.peak = jsHeapUsedBytes() ?? 0;
    this.samples = 0;
    this.handle = window.setInterval(() => {
      const used = jsHeapUsedBytes();
      this.samples += 1;
      if (used !== null && used > this.peak) this.peak = used;
    }, this.intervalMs);
  }

  stop(): number | null {
    if (this.handle !== null) window.clearInterval(this.handle);
    this.handle = null;
    return this.peak > 0 ? this.peak : null;
  }
}

/** Why both APIs are quoted, and what neither of them can see. */
export const PEAK_CAVEAT =
  'Sampled during the run, not at step boundaries. performance.memory.usedJSHeapSize excludes ArrayBuffer ' +
  'backing stores, so the master copy and the save buffer are invisible to it; it is the JS-heap peak, nothing more. ' +
  'performance.measureUserAgentSpecificMemory() forces a garbage collection on every call, so its samples are ' +
  'retained-memory readings taken 250 ms apart — the page cannot force a GC between them, which is why the peak ' +
  'between two samples can be missed and why the run times are measured under that polling load.';

/**
 * The recipe's sampler: `performance.memory.usedJSHeapSize` every 10 ms plus
 * `performance.measureUserAgentSpecificMemory()` every 250 ms, keeping the max
 * of each. Started before the first engine call and stopped after `destroy()`.
 */
export class PeakMemoryTracker {
  readonly jsHeapIntervalMs: number;
  readonly agentClusterIntervalMs: number;
  private readonly heap: HeapPoller;
  private handle: number | null = null;
  private agentClusterPeakBytes: number | null = null;
  private agentClusterSamples = 0;
  private agentClusterFailures = 0;

  constructor(jsHeapIntervalMs = 10, agentClusterIntervalMs = 250) {
    this.jsHeapIntervalMs = jsHeapIntervalMs;
    this.agentClusterIntervalMs = agentClusterIntervalMs;
    this.heap = new HeapPoller(jsHeapIntervalMs);
  }

  start(): void {
    this.heap.start();
    void this.sample();
    this.handle = window.setInterval(() => void this.sample(), this.agentClusterIntervalMs);
  }

  private async sample(): Promise<void> {
    const measure = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    };
    if (typeof measure.measureUserAgentSpecificMemory !== 'function') {
      this.agentClusterFailures += 1;
      return;
    }
    try {
      const sample = await measure.measureUserAgentSpecificMemory.call(measure);
      this.agentClusterSamples += 1;
      if (this.agentClusterPeakBytes === null || sample.bytes > this.agentClusterPeakBytes) {
        this.agentClusterPeakBytes = sample.bytes;
      }
    } catch {
      this.agentClusterFailures += 1;
    }
  }

  async stop(): Promise<PeakMemory> {
    if (this.handle !== null) window.clearInterval(this.handle);
    this.handle = null;
    const jsHeapPeakBytes = this.heap.stop();
    await this.sample();
    return {
      jsHeapPeakBytes,
      jsHeapSamples: this.heap.samples,
      jsHeapIntervalMs: this.jsHeapIntervalMs,
      agentClusterPeakBytes: this.agentClusterPeakBytes,
      agentClusterSamples: this.agentClusterSamples,
      agentClusterFailures: this.agentClusterFailures,
      agentClusterIntervalMs: this.agentClusterIntervalMs,
      caveat: PEAK_CAVEAT,
    };
  }
}

export interface MemoryReading {
  readonly step: MemoryStep;
  readonly breakdown: readonly RealmBreakdown[];
  readonly measuredApi: string;
  readonly error: string | null;
}

function describeRealm(entry: AttributionEntry | undefined): string {
  if (!entry) return '(unspecified)';
  if (entry.container?.src) return `container: ${entry.container.src}`;
  if (entry.url) return entry.url;
  if (entry.scope) return entry.scope;
  return '(unspecified)';
}

/** One retained-memory sample. `comment` and `accountedBytes` come from the caller's own bookkeeping. */
export async function sampleMemory(
  step: string,
  comment: string,
  accountedBytes: number | null,
): Promise<MemoryReading> {
  const jsHeapBytes = jsHeapUsedBytes();
  const atMs = Math.round(performance.now() - startedAt);

  let agentClusterBytes: number | null = null;
  let measuredApi = 'none';
  let error: string | null = null;
  const breakdown: RealmBreakdown[] = [];

  const measure = perf().measureUserAgentSpecificMemory;
  if (typeof measure === 'function') {
    try {
      const sample = await measure.call(perf());
      agentClusterBytes = sample.bytes;
      measuredApi = 'measureUserAgentSpecificMemory';
      const entries = [...(sample.breakdown ?? [])].sort((a, b) => b.bytes - a.bytes).slice(0, 4);
      for (const entry of entries) {
        breakdown.push({
          step,
          label: describeRealm(entry.attribution?.[0]),
          bytes: entry.bytes,
          types: entry.types ?? [],
        });
      }
    } catch (caught) {
      error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
      measuredApi = 'failed';
    }
  } else {
    error = 'measureUserAgentSpecificMemory unavailable (realm is not cross-origin isolated)';
  }

  if (agentClusterBytes === null && jsHeapBytes !== null) measuredApi = 'performance.memory only';

  return {
    measuredApi,
    error,
    breakdown,
    step: { step, agentClusterBytes, jsHeapBytes, atMs, accountedBytes, comment },
  };
}

/** Waits for the next animation frame — used to read frame latency under memory pressure. */
export function nextFrame(): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  requestAnimationFrame((timestamp) => resolve(timestamp));
  return promise;
}
