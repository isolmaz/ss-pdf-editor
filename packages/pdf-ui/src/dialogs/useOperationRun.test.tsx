// @vitest-environment happy-dom
/**
 * The run/cancel state machine: what a dialog reads from it while a job runs, after it finishes,
 * fails or is cancelled, and what it must never publish behind a cancellation.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import type { OperationReport } from 'pdf-core';
import { createTranslator, ToolError } from 'pdf-shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { OperationDialogSpec, OperationRunContext, OpRunContext, OpRunResult } from './types';
import { useOperationRun } from './useOperationRun';

const t = createTranslator('en');
const context: OperationRunContext = {
  bytes: new Uint8Array(),
  pageCount: 3,
  name: 'a.pdf',
  currentPage: 0,
  selectedPages: [],
  t,
};
const report: OperationReport = {
  engine: 'model',
  pageCount: 3,
  inputBytes: 10,
  outputBytes: 10,
  incremental: true,
  steps: [],
  notes: [],
};
const produced: OpRunResult = { files: [], report };

/** A run the test settles by hand, so it can interleave ticks, cancels and settlement. */
function pending() {
  let seen: OpRunContext | undefined;
  let resolve: (result: OpRunResult) => void = () => {};
  let reject: (cause: unknown) => void = () => {};
  const spec: OperationDialogSpec = {
    id: 'probe',
    titleKey: 'op.scope',
    confirmKey: 'op.scope',
    resultKind: 'replace',
    fields: [],
    run: (_params, runContext) => {
      seen = runContext;
      return new Promise<OpRunResult>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
    },
  };
  return {
    spec,
    context: () => {
      if (seen === undefined) throw new Error('the run has not started');
      return seen;
    },
    resolve: (result: OpRunResult) => resolve(result),
    reject: (cause: unknown) => reject(cause),
  };
}

afterEach(cleanup);

describe('useOperationRun', () => {
  it('starts idle, runs, shows the engine ticks and publishes the result', async () => {
    const job = pending();
    const { result } = renderHook(() => useOperationRun());
    expect(result.current.status).toBe('idle');

    act(() => result.current.run(job.spec, {}, context));
    expect(result.current.status).toBe('running');
    expect(result.current.progress).toBeNull();

    act(() => job.context().onProgress({ phase: 'render', labelKey: 'op.running', done: 1, total: 3 }));
    expect(result.current.progress).toEqual({ phase: 'render', labelKey: 'op.running', done: 1, total: 3 });

    await act(async () => job.resolve(produced));
    expect(result.current.status).toBe('done');
    expect(result.current.result).toBe(produced);
    expect(result.current.progress).toBeNull();
  });

  it('gives the run its own signal, not the one the shell passed', () => {
    const job = pending();
    const { result } = renderHook(() => useOperationRun());
    act(() => result.current.run(job.spec, {}, context));
    expect(job.context().signal.aborted).toBe(false);
    act(() => result.current.cancel());
    expect(job.context().signal.aborted).toBe(true);
  });

  it('ignores a second start while a run is in flight', () => {
    const first = pending();
    const second = pending();
    const { result } = renderHook(() => useOperationRun());
    act(() => result.current.run(first.spec, {}, context));
    act(() => result.current.run(second.spec, {}, context));
    expect(() => second.context()).toThrow('the run has not started');
    expect(result.current.status).toBe('running');
  });

  it('answers a cancel at once and publishes nothing the engine settles with afterwards', async () => {
    const job = pending();
    const { result } = renderHook(() => useOperationRun());
    act(() => result.current.run(job.spec, {}, context));

    act(() => result.current.cancel());
    expect(result.current.status).toBe('cancelled');

    act(() => job.context().onProgress({ phase: 'render', labelKey: 'op.running', done: 2, total: 3 }));
    expect(result.current.progress).toBeNull();
    expect(result.current.status).toBe('cancelled');

    await act(async () => job.resolve(produced));
    expect(result.current.status).toBe('cancelled');
    expect(result.current.result).toBeNull();
  });

  it('treats a rejection after a cancel as control flow, not as a failure', async () => {
    const job = pending();
    const { result } = renderHook(() => useOperationRun());
    act(() => result.current.run(job.spec, {}, context));
    act(() => result.current.cancel());
    await act(async () => job.reject(new DOMException('stopped', 'AbortError')));
    expect(result.current.status).toBe('cancelled');
    expect(result.current.error).toBeNull();
  });

  it('cancel with nothing running changes nothing', () => {
    const { result } = renderHook(() => useOperationRun());
    act(() => result.current.cancel());
    expect(result.current.status).toBe('idle');
  });

  it('reads a failure through the dictionary and keeps the engine text for diagnostics', async () => {
    const job = pending();
    const { result } = renderHook(() => useOperationRun());
    act(() => result.current.run(job.spec, {}, context));
    await act(async () => job.reject(new Error('kaboom')));
    expect(result.current.status).toBe('error');
    expect(result.current.error).toEqual({
      message: 'Something unexpected went wrong.',
      hint: 'Try again; report it if it keeps happening.',
      diagnostic: 'kaboom',
    });
  });

  it('has no diagnostic for a failure the engine gave no text for', async () => {
    const job = pending();
    const { result } = renderHook(() => useOperationRun());
    act(() => result.current.run(job.spec, {}, context));
    await act(async () => job.reject(new ToolError('internal', { engine: 'test' })));
    expect(result.current.error?.diagnostic).toBeNull();
  });

  it('lets a finished run start again, and drops a tick that arrives after the result', async () => {
    const first = pending();
    const { result } = renderHook(() => useOperationRun());
    act(() => result.current.run(first.spec, {}, context));
    await act(async () => first.resolve(produced));

    act(() => first.context().onProgress({ phase: 'render', labelKey: 'op.running', done: 3, total: 3 }));
    expect(result.current.status).toBe('done');
    expect(result.current.progress).toBeNull();

    const second = pending();
    act(() => result.current.run(second.spec, { a: 1 }, context));
    expect(result.current.status).toBe('running');
  });

  it('aborts the work of a dialog that closes mid-run', () => {
    const job = pending();
    const { result, unmount } = renderHook(() => useOperationRun());
    act(() => result.current.run(job.spec, {}, context));
    unmount();
    expect(job.context().signal.aborted).toBe(true);
  });
});
