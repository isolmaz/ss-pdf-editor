/**
 * A Node module-resolution hook for the scripts that run product code outside a browser
 * (`sign-check.mts`): the MuPDF adapter imports the engine by its **served URL**
 * (`/engines/mupdf/v<digest>/mupdf.js`, `engines/mupdf.ts`), which only a served build has. Here that
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
      // `/engines/mupdf/<version>/mupdf.js`: the served URL names the engine's pinned version.
      if (/\/engines\/mupdf\/v[0-9a-f]{12}\/mupdf\.js$/.test(path)) {
        return { url: MUPDF_URL, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}
