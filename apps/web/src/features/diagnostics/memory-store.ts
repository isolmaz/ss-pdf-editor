/**
 * The memory gauge in the status bar: how much the open documents hold against the device
 * tier's budget, sampled every 2.5 s.
 *
 * The sample lives in a store of its own so that only the component that shows it re-renders on
 * each tick; the shell around it does not.
 */

import type { SessionStore } from 'pdf-model';
import type { DeviceTier } from 'pdf-shared';
import { useEffect } from 'react';
import { createStore, useStore } from '../store';

/** How much memory the open documents hold, against the tier's budget. */
export interface MemoryUsage {
  readonly usedBytes: number;
  readonly budgetBytes: number;
}

export interface DiagnosticsState {
  /** The latest sample; `undefined` until the first one is taken. */
  readonly memoryUsage: MemoryUsage | undefined;
}

export const initialDiagnosticsState = (): DiagnosticsState => ({ memoryUsage: undefined });

export const diagnosticsStore = createStore<DiagnosticsState>(initialDiagnosticsState());

/** The latest memory sample, for a component. */
export function useMemoryUsage(): MemoryUsage | undefined {
  return useStore(diagnosticsStore, (state) => state.memoryUsage);
}

/** The time between two samples. */
export const MEMORY_SAMPLE_INTERVAL_MS = 2500;

const MIB = 1024 * 1024;

/** Record a sample; a sample equal to the last one changes nothing and wakes nobody. */
export function memorySampled(usage: MemoryUsage): void {
  const current = diagnosticsStore.get().memoryUsage;
  if (current?.usedBytes === usage.usedBytes && current.budgetBytes === usage.budgetBytes) return;
  diagnosticsStore.set({ memoryUsage: usage });
}

/**
 * What the open documents hold now. The browser's own JS heap figure is used where it reports one;
 * elsewhere the estimate is the sum of every tab's source and produced bytes plus a fixed 24 MiB
 * for the engine.
 */
export function sampleMemory(session: Pick<SessionStore, 'getSnapshot'>, tier: DeviceTier): MemoryUsage {
  const budgetBytes = (tier === 'mobile' ? 128 : 512) * MIB;
  const heap = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  if (typeof heap?.usedJSHeapSize === 'number' && heap.usedJSHeapSize > 0) {
    return { usedBytes: heap.usedJSHeapSize, budgetBytes };
  }
  const tabBytes = session
    .getSnapshot()
    .tabs.reduce((sum, tab) => sum + tab.source.size + (tab.working.produced?.bytes.byteLength ?? 0), 0);
  return { usedBytes: tabBytes + 24 * MIB, budgetBytes };
}

/** Sample now and then on every interval; returns the function that stops sampling. */
export function startMemorySampler(session: Pick<SessionStore, 'getSnapshot'>, tier: DeviceTier): () => void {
  const sample = () => memorySampled(sampleMemory(session, tier));
  sample();
  const interval = window.setInterval(sample, MEMORY_SAMPLE_INTERVAL_MS);
  return () => window.clearInterval(interval);
}

/** Run the sampler for as long as the calling component is mounted. */
export function useMemorySampler(session: Pick<SessionStore, 'getSnapshot'>, tier: DeviceTier): void {
  useEffect(() => startMemorySampler(session, tier), [session, tier]);
}
