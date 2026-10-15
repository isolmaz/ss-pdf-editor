import { useEffect, useMemo, useRef } from 'react';

/**
 * The runs a panel starts from a button or an effect, each with the `AbortController` whose
 * signal its engine calls take, and what happens to them when the panel goes away.
 *
 * A panel that is closed (a tab switched, a revision re-mounting it) while its check or its
 * write is still working must stop the engine, not only ignore the answer: the work holds a
 * wasm document and a worker for as long as it runs, and nobody is left to read what it
 * produces. A controller is aborted by whichever comes first: the end of its own run, or the
 * panel leaving. A run that was cut short by the second one is *abandoned*, and an abandoned
 * run publishes nothing — no result, no failure, no notice, no "not busy any more".
 */
export interface AbortableRuns {
  /** Starts a run: the controller whose signal the run's engine calls take. */
  begin(): AbortController;
  /**
   * Ends a run, releasing its controller. Returns whether the run had been abandoned before
   * it ended, so the caller that ends it in a `finally` knows to publish nothing.
   */
  end(controller: AbortController): boolean;
}

export function useAbortableRuns(): AbortableRuns {
  const running = useRef(new Set<AbortController>());

  useEffect(() => {
    const controllers = running.current;
    return () => {
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, []);

  return useMemo(
    () => ({
      begin() {
        const controller = new AbortController();
        running.current.add(controller);
        return controller;
      },
      end(controller) {
        const abandoned = controller.signal.aborted;
        running.current.delete(controller);
        // The engine's own listeners are released with the signal once the run is over.
        controller.abort();
        return abandoned;
      },
    }),
    [],
  );
}
