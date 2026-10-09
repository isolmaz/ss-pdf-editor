/**
 * A Node module-resolution hook for the scripts that run product code outside a browser
 * (`sign-check.mts`): the MuPDF adapter imports the engine by its **served URL**
 * (`/engines/mupdf/mupdf.js`, `engines/mupdf.ts`), which only a served build has. Here that
 * one specifier resolves to the same pinned `mupdf` package the build copies, installed
 * under `packages/pdf-core` — the loader changes, the engine does not (the unit suite does
 * the same in `vitest.setup.ts`).
 *
 * Usage: `installMupdfHook()` before product code loads the engine.
 */

import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const coreRequire = createRequire(new URL('../../packages/pdf-core/package.json', import.meta.url));
const MUPDF_URL = pathToFileURL(coreRequire.resolve('mupdf')).href;

/** Resolve the served engine URL to the installed package, in this thread. */
export function installMupdfHook() {
  registerHooks({
    resolve(specifier, context, next) {
      const path = specifier.split('?')[0] ?? specifier;
      if (path.endsWith('/engines/mupdf/mupdf.js')) return { url: MUPDF_URL, shortCircuit: true };
      return next(specifier, context);
    },
  });
}
