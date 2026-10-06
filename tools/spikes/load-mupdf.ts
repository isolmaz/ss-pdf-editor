/**
 * MuPDF for the browser spikes (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * The engine comes from its pinned production location `/engines/mupdf/mupdf.js`
 * (byte-identical to the `mupdf` npm package), served by the spike harness under the
 * same `/engines/**` policy as production. `import type` keeps the npm copy out of the
 * bundle.
 */
import type * as Mupdf from 'mupdf';

const MUPDF_URL = '/engines/mupdf/mupdf.js';

let pending: Promise<typeof Mupdf> | null = null;

export function loadMupdf(): Promise<typeof Mupdf> {
  pending ??= import(/* @vite-ignore */ MUPDF_URL) as Promise<typeof Mupdf>;
  return pending;
}
