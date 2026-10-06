/**
 * The run/cancel state machine every operation dialog shares (`PLAN.md §3.4`,
 * §5/Phase 2 acceptance: "every panel has cancel + progress + undoable
 * application").
 *
 * One hook, so that eighteen capabilities cannot each invent their own
 * progress/cancel behaviour:
 *
 * ```
 * idle ──run──▶ running ──┬──▶ done       (result published)
 *                         ├──▶ error      (ToolError → Turkish message + hint)
 *                         └──▶ cancelled  (cancel(), or the dialog unmounted)
 * ```
 *
 * Three properties are the point of the hook:
 *
 *  - **The hook owns the `AbortController`.** The dialog's `context` arrives from
 *    the shell with a placeholder signal; `run` replaces it, so cancellation is
 *    wired to the dialog's own lifetime rather than to whatever the shell passed.
 *  - **Cancellation is immediate and final.** `cancel()` publishes `cancelled` at
 *    once — the user gets an answer to the click — and every late write checks
 *    `signal.aborted`, so a slow engine that ignores the signal can never publish
 *    a result behind a cancellation.
 *  - **No controller outlives the component.** Unmounting (closing the dialog,
 *    switching document) aborts the work instead of leaving a job running with no
 *    surface able to cancel it.
 */

import type { OperationProgress } from 'pdf-core';
import { toToolError } from 'pdf-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DialogParams, OperationDialogSpec, OperationRunContext, OpRunResult } from './types';

export type OperationRunStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

/** A `ToolError` already read through the dictionary — the two sentences a user needs. */
export interface OperationFailure {
  /** `messageKey` — what happened. */
  readonly message: string;
  /** `hintKey` — what to do next. */
  readonly hint: string;
  /**
   * The engine's own error text, verbatim. Diagnostics only — it is never rendered
   * as the user message (`AGENTS.md > Errors`), but a failed operation with no
   * evidence is undiagnosable, so it travels to the surface as a `data-` attribute
   * a probe (or the user's local diagnostics copy) can read.
   */
  readonly diagnostic: string | null;
}

/** Re-exported so the hook's callers keep one import path (`types.ts` owns it). */
export type { OperationRunContext } from './types';

export interface OperationRunState {
  readonly status: OperationRunStatus;
  /** The last tick the engine reported; `null` before the first one. */
  readonly progress: OperationProgress | null;
  readonly result: OpRunResult | null;
  readonly error: OperationFailure | null;
  run: (spec: OperationDialogSpec, params: DialogParams, context: OperationRunContext) => void;
  cancel: () => void;
  reset: () => void;
}

interface OperationRunSnapshot {
  readonly status: OperationRunStatus;
  readonly progress: OperationProgress | null;
  readonly result: OpRunResult | null;
  readonly error: OperationFailure | null;
}

const IDLE: OperationRunSnapshot = { status: 'idle', progress: null, result: null, error: null };
const CANCELLED: OperationRunSnapshot = {
  status: 'cancelled',
  progress: null,
  result: null,
  error: null,
};

export function useOperationRun(): OperationRunState {
  const [snapshot, setSnapshot] = useState<OperationRunSnapshot>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  const run = useCallback((spec: OperationDialogSpec, params: DialogParams, context: OperationRunContext) => {
    // One operation at a time. The confirm button is disabled while running, so
    // this only guards a programmatic second start — which would interleave two
    // progress streams into one bar.
    if (controllerRef.current !== null) return;

    const controller = new AbortController();
    const { signal } = controller;
    controllerRef.current = controller;
    setSnapshot({ status: 'running', progress: null, result: null, error: null });

    void (async () => {
      try {
        const result = await spec.run(params, {
          ...context,
          signal,
          onProgress: (progress) => {
            // A tick that arrives after the cancel must not revive the bar.
            if (signal.aborted) return;
            setSnapshot((previous) => (previous.status === 'running' ? { ...previous, progress } : previous));
          },
        });
        if (signal.aborted) return;
        setSnapshot({ status: 'done', progress: null, result, error: null });
      } catch (cause) {
        // An abort is control flow, not a failure: `cancel()` has already
        // published the terminal state and printed the dictionary's sentence.
        if (signal.aborted) return;
        const failure = toToolError(cause, 'ui');
        setSnapshot({
          status: 'error',
          progress: null,
          result: null,
          error: {
            message: context.t(failure.messageKey),
            hint: context.t(failure.hintKey),
            diagnostic: failure.details.engineMessage ?? null,
          },
        });
      } finally {
        // Identity check, not a null write: a run started after a cancel must keep
        // its own controller.
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    })();
  }, []);

  const cancel = useCallback(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    controller.abort();
    controllerRef.current = null;
    setSnapshot(CANCELLED);
  }, []);

  const reset = useCallback(() => {
    // Resetting is a way out of any state, including a run that is still going.
    controllerRef.current?.abort();
    controllerRef.current = null;
    setSnapshot(IDLE);
  }, []);

  return { ...snapshot, run, cancel, reset };
}
