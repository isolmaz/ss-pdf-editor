/**
 * The Ghostscript engine as the operations see it: `convertWithGhostscript(request)`.
 *
 * In a browser each call starts its own module worker (`ghostscript-worker.ts`), hands the
 * document over by transfer, and terminates the worker when it is done or cancelled. The
 * engine is never loaded until a conversion runs; nothing about it is kept in memory
 * between runs. Without `Worker` (Node: the unit suite and the behaviour checks) the same
 * runner executes in-thread against the same assets.
 *
 * A loader, worker or wasm the browser cannot fetch (offline, or absent from this deployment;
 * the two look the same here) surfaces as `asset-offline`, the code a lazy chunk the browser
 * cannot fetch gets: the engine is fetched on first use and is not in the offline readiness
 * manifest, so connecting and reloading is the one instruction that leads anywhere. A
 * conversion that fails on a document is `pdfa-failed`; running out of memory is
 * `out-of-memory`.
 */

import { ToolError } from 'pdf-shared';
import { GHOSTSCRIPT_ASSETS } from '../assets';
import {
  ghostscriptFactory,
  type PdfaRunRequest,
  type PdfaRunResult,
  runPdfaConversion,
} from './ghostscript-run';
import type { GhostscriptWorkerMessage, GhostscriptWorkerRequest } from './ghostscript-worker';

export type { PdfaRunRequest, PdfaRunResult } from './ghostscript-run';

const OUT_OF_MEMORY =
  /out of memory|oom|cannot enlarge memory|memory access out of bounds|allocation failed/i;

function abortError(): Error {
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  return error;
}

/** The error a failed conversion is reported as, by the stage it failed in. */
export function ghostscriptFailure(stage: 'load' | 'run', message: string): ToolError {
  if (stage === 'load')
    return new ToolError('asset-offline', { engine: 'ghostscript', engineMessage: message });
  if (OUT_OF_MEMORY.test(message)) {
    return new ToolError('out-of-memory', { engine: 'ghostscript', engineMessage: message });
  }
  return new ToolError('pdfa-failed', { engine: 'ghostscript', engineMessage: message });
}

export interface GhostscriptRunOptions {
  readonly signal: AbortSignal;
  /** Called as each page is written. */
  readonly onPage?: (page: number, total: number) => void;
}

/** Run one PDF/A conversion. `request.input` is consumed (transferred) in a browser. */
export function convertWithGhostscript(
  request: PdfaRunRequest,
  options: GhostscriptRunOptions,
): Promise<PdfaRunResult> {
  if (options.signal.aborted) return Promise.reject(abortError());
  if (typeof Worker === 'undefined') return runInThread(request, options);
  return runInWorker(request, options);
}

async function runInThread(request: PdfaRunRequest, options: GhostscriptRunOptions): Promise<PdfaRunResult> {
  let stage: 'load' | 'run' = 'load';
  const factory = ghostscriptFactory(GHOSTSCRIPT_ASSETS.js, GHOSTSCRIPT_ASSETS.wasm);
  try {
    return await runPdfaConversion(
      async (factoryOptions) => {
        const module = await factory(factoryOptions);
        stage = 'run';
        return module;
      },
      request,
      options.onPage,
    );
  } catch (error) {
    throw ghostscriptFailure(stage, error instanceof Error ? error.message : String(error));
  }
}

function runInWorker(request: PdfaRunRequest, options: GhostscriptRunOptions): Promise<PdfaRunResult> {
  return new Promise<PdfaRunResult>((resolve, reject) => {
    const worker = new Worker(new URL('./ghostscript-worker.ts', import.meta.url), { type: 'module' });
    const onAbort = (): void => finish(() => reject(abortError()));
    const finish = (settle: () => void): void => {
      options.signal.removeEventListener('abort', onAbort);
      worker.terminate();
      settle();
    };
    options.signal.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<GhostscriptWorkerMessage>) => {
      const message = event.data;
      if (message.type === 'page') options.onPage?.(message.page, message.total);
      else if (message.type === 'done') finish(() => resolve(message.result));
      else finish(() => reject(ghostscriptFailure(message.stage, message.message)));
    };
    worker.onerror = (event) => {
      // A worker that cannot start at all (its script or an import failed to load).
      finish(() => reject(ghostscriptFailure('load', event.message || 'the worker failed to start')));
    };

    const message: GhostscriptWorkerRequest = {
      js: new URL(GHOSTSCRIPT_ASSETS.js, self.location.href).href,
      wasm: new URL(GHOSTSCRIPT_ASSETS.wasm, self.location.href).href,
      request,
    };
    worker.postMessage(message, [request.input.buffer as ArrayBuffer]);
  });
}
