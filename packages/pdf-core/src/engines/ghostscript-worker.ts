/**
 * The Ghostscript worker: one conversion per worker, then it is terminated. The 15.5 MB
 * module and the file's bytes live in this thread's memory only, so a cancel (`terminate`)
 * frees all of it at once and the editor's own memory never carries the engine.
 *
 * Protocol (`ghostscript.ts` is the other end):
 *  - in:  `{ js, wasm, request }`
 *  - out: `{ type: 'page', page, total }` while it runs, then `{ type: 'done', result }`
 *    (the output buffer is transferred) or `{ type: 'error', stage, message }`.
 */

import {
  ghostscriptFactory,
  type PdfaRunRequest,
  type PdfaRunResult,
  runPdfaConversion,
} from './ghostscript-run';

export interface GhostscriptWorkerRequest {
  readonly js: string;
  readonly wasm: string;
  readonly request: PdfaRunRequest;
}

export type GhostscriptWorkerMessage =
  | { readonly type: 'page'; readonly page: number; readonly total: number }
  | { readonly type: 'done'; readonly result: PdfaRunResult }
  | { readonly type: 'error'; readonly stage: 'load' | 'run'; readonly message: string };

/** The worker scope, typed by what this file uses (the project compiles with the DOM library). */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<GhostscriptWorkerRequest>) => void) | null;
  postMessage(message: GhostscriptWorkerMessage, transfer: Transferable[]): void;
};

function post(message: GhostscriptWorkerMessage, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

scope.onmessage = (event) => {
  const { js, wasm, request } = event.data;
  // `stage` tells a missing or broken engine file (the user can fix it by downloading the
  // package again) from a conversion that failed on this document.
  let stage: 'load' | 'run' = 'load';
  const factory = ghostscriptFactory(js, wasm);
  runPdfaConversion(
    async (options) => {
      const module = await factory(options);
      stage = 'run';
      return module;
    },
    request,
    (page, total) => post({ type: 'page', page, total }),
  ).then(
    (result) => post({ type: 'done', result }, [result.output.buffer as ArrayBuffer]),
    (error: unknown) =>
      post({ type: 'error', stage, message: error instanceof Error ? error.message : String(error) }),
  );
};
