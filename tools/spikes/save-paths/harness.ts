/**
 * Measurement plumbing for spike #1 — timing, peak memory, pass/fail checks.
 *
 * Memory: `performance.measureUserAgentSpecificMemory()` needs
 * `crossOriginIsolated`. Under the current `public/_headers` policy COOP/COEP
 * are scoped to `/editor/*`, so `/save-paths/` is *not* isolated; the harness
 * records which API produced the number instead of pretending they are equal.
 */

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface MemorySample {
  readonly api: string;
  readonly bytes: number | null;
  readonly crossOriginIsolated: boolean;
}

/**
 * Sampled peaks for one branch. `heapPeak` comes from the cheap Chromium heap
 * counter (10 ms), `processPeak` from `measureUserAgentSpecificMemory()` when the
 * page is cross-origin isolated (250 ms). The baseline is whatever the previous
 * branch left behind — the page cannot force a GC, so these are upper bounds on
 * the branch's own footprint, not an isolated per-branch measurement.
 */
export interface MemoryPeak {
  readonly heapPeak: number | null;
  readonly processPeak: number | null;
  readonly processSamples: number;
}

export class MemorySampler {
  #heapTimer: number | undefined;
  #processTimer: number | undefined;
  #heapPeak: number | null = null;
  #processPeak: number | null = null;
  #samples = 0;

  start(): void {
    const perf = performance as MeasurementPerformance;
    if (perf.memory) {
      this.#heapPeak = perf.memory.usedJSHeapSize;
      this.#heapTimer = window.setInterval(() => {
        const current = perf.memory?.usedJSHeapSize;
        if (current !== undefined && (this.#heapPeak === null || current > this.#heapPeak)) {
          this.#heapPeak = current;
        }
      }, 10);
    }
    if (typeof perf.measureUserAgentSpecificMemory === 'function') {
      const tick = async () => {
        try {
          const sample = await perf.measureUserAgentSpecificMemory?.();
          this.#samples += 1;
          if (sample && (this.#processPeak === null || sample.bytes > this.#processPeak)) {
            this.#processPeak = sample.bytes;
          }
        } catch {
          // refused while the agent is busy — the samples already taken stand
        }
      };
      void tick();
      this.#processTimer = window.setInterval(() => {
        void tick();
      }, 250);
    }
  }

  stop(): MemoryPeak {
    window.clearInterval(this.#heapTimer);
    window.clearInterval(this.#processTimer);
    return { heapPeak: this.#heapPeak, processPeak: this.#processPeak, processSamples: this.#samples };
  }
}

export interface BranchResult {
  readonly id: string;
  readonly title: string;
  readonly ok: boolean;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly deltaBytes: number;
  readonly ms: number;
  readonly memoryApi: string;
  readonly memBefore: number | null;
  readonly memAfter: number | null;
  readonly memDelta: number | null;
  /** Sampled peaks during the branch — see `MemoryPeak`. */
  readonly peak: MemoryPeak;
  /** `planSave()` interpretation of the same change set (`pdf-model`). */
  readonly planPaths: string;
  readonly planIncremental: boolean | null;
  /** Measured file-format fact: output starts with the exact input bytes. */
  readonly incrementalFormat: boolean | null;
  readonly checks: Check[];
  readonly notes: readonly string[];
  readonly error: string | null;
}

interface HeapMemory {
  usedJSHeapSize: number;
}

/** Chromium-only APIs that the DOM lib does not declare. */
export interface MeasurementPerformance extends Performance {
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  memory?: HeapMemory;
}

export async function measureMemory(): Promise<MemorySample> {
  const isolated = globalThis.crossOriginIsolated === true;
  const perf = performance as MeasurementPerformance;
  if (typeof perf.measureUserAgentSpecificMemory === 'function') {
    try {
      const sample = await perf.measureUserAgentSpecificMemory();
      return { api: 'measureUserAgentSpecificMemory', bytes: sample.bytes, crossOriginIsolated: isolated };
    } catch {
      // Not cross-origin isolated (or measurement refused) — fall through.
    }
  }
  if (perf.memory) {
    return {
      api: 'performance.memory.usedJSHeapSize (fallback)',
      bytes: perf.memory.usedJSHeapSize,
      crossOriginIsolated: isolated,
    };
  }
  return { api: 'unavailable', bytes: null, crossOriginIsolated: isolated };
}

export class Recorder {
  readonly checks: Check[] = [];
  readonly notes: string[] = [];

  check(name: string, pass: boolean, detail: string): void {
    this.checks.push({ name, pass, detail: pass ? detail : `FAIL — ${detail}` });
  }

  note(text: string): void {
    this.notes.push(text);
  }

  failed(): number {
    return this.checks.filter((entry) => !entry.pass).length;
  }
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** True when `output` is the input with an appended incremental update. */
export function isIncrementalOver(output: Uint8Array, input: Uint8Array): boolean {
  if (output.byteLength <= input.byteLength) return false;
  return equalBytes(output.subarray(0, input.byteLength), input);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
