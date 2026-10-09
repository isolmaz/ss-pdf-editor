// @vitest-environment happy-dom
/** The memory gauge: what a sample says, when it is taken and who hears about it. */

import { act, renderHook } from '@testing-library/react';
import { SessionStore } from 'pdf-model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  diagnosticsStore,
  initialDiagnosticsState,
  MEMORY_SAMPLE_INTERVAL_MS,
  memorySampled,
  sampleMemory,
  startMemorySampler,
  useMemorySampler,
  useMemoryUsage,
} from './memory-store';

const MIB = 1024 * 1024;
let session: SessionStore;
let heap: number | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  diagnosticsStore.set(initialDiagnosticsState());
  session = new SessionStore();
  heap = undefined;
  Object.defineProperty(performance, 'memory', {
    configurable: true,
    get: () => (heap === undefined ? undefined : { usedJSHeapSize: heap }),
  });
});

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(performance, 'memory');
});

function openTab(size: number) {
  return session.openDocument({ name: 'a.pdf', bytes: new Uint8Array(size), sha256: 'a', pageCount: 1 });
}

describe('sampleMemory', () => {
  it("reports the browser's own heap figure against the tier's budget when it has one", () => {
    heap = 10 * MIB;
    expect(sampleMemory(session, 'desktop')).toEqual({ usedBytes: 10 * MIB, budgetBytes: 512 * MIB });
    expect(sampleMemory(session, 'mobile')).toEqual({ usedBytes: 10 * MIB, budgetBytes: 128 * MIB });
  });

  it('estimates from the open documents plus the engine when the browser reports no heap', () => {
    expect(sampleMemory(session, 'desktop').usedBytes).toBe(24 * MIB);
    openTab(1000);
    expect(sampleMemory(session, 'desktop').usedBytes).toBe(24 * MIB + 1000);
  });

  it('counts a produced working version on top of the source', () => {
    const tab = openTab(1000);
    session.applyOperation({
      tabId: tab.id,
      bytes: new Uint8Array(500),
      pageCount: 1,
      labelKey: 'op.busy',
      engine: 'test',
      steps: [],
      overlays: {},
    });
    expect(sampleMemory(session, 'desktop').usedBytes).toBe(24 * MIB + 1000 + 500);
  });

  it('ignores a heap figure of zero', () => {
    heap = 0;
    expect(sampleMemory(session, 'desktop').usedBytes).toBe(24 * MIB);
  });
});

describe('memorySampled', () => {
  it('wakes nobody for a sample equal to the last one', () => {
    const listener = vi.fn();
    memorySampled({ usedBytes: 1, budgetBytes: 2 });
    diagnosticsStore.subscribe(listener);
    memorySampled({ usedBytes: 1, budgetBytes: 2 });
    expect(listener).not.toHaveBeenCalled();
    memorySampled({ usedBytes: 3, budgetBytes: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    memorySampled({ usedBytes: 3, budgetBytes: 4 });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('startMemorySampler', () => {
  it('samples at once and then on every interval until stopped', () => {
    heap = 1 * MIB;
    const stop = startMemorySampler(session, 'desktop');
    expect(diagnosticsStore.get().memoryUsage?.usedBytes).toBe(1 * MIB);
    heap = 2 * MIB;
    vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS);
    expect(diagnosticsStore.get().memoryUsage?.usedBytes).toBe(2 * MIB);
    stop();
    heap = 3 * MIB;
    vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS * 2);
    expect(diagnosticsStore.get().memoryUsage?.usedBytes).toBe(2 * MIB);
  });
});

describe('the hooks', () => {
  it('hand the latest sample to the component that reads it and stop with it', () => {
    heap = 1 * MIB;
    const { result, unmount } = renderHook(() => {
      useMemorySampler(session, 'desktop');
      return useMemoryUsage();
    });
    expect(result.current?.usedBytes).toBe(1 * MIB);
    heap = 5 * MIB;
    act(() => {
      vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS);
    });
    expect(result.current?.usedBytes).toBe(5 * MIB);
    unmount();
    heap = 9 * MIB;
    vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS);
    expect(diagnosticsStore.get().memoryUsage?.usedBytes).toBe(5 * MIB);
  });

  it('do not re-render a reader of something else on a tick', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      useMemorySampler(session, 'desktop');
    });
    const before = renders;
    act(() => {
      vi.advanceTimersByTime(MEMORY_SAMPLE_INTERVAL_MS * 3);
    });
    expect(renders).toBe(before);
  });
});
