/// <reference types="node" />
/**
 * The unit suite's engine seams: **the engines load from the installed packages** instead
 * of from the browser URLs the adapters use (`/engines/...`, which only a served build
 * has). The bytes are the same pinned packages the build copies, so code under test runs
 * the engines it ships with — only the loaders change, which is the only use mocks are
 * reserved for.
 *
 * - MuPDF: `loadMupdf` imports the installed `mupdf` module.
 * - pdf.js: the standard-font, CMap and wasm directories point at the installed
 *   `pdfjs-dist`. In Node, pdf.js reads them with `fs.readFile(base + name)`, so they are
 *   plain directory paths ending in `/`. Without them every page that uses a
 *   standard-14 font logs "Unable to load font data" and renders with a substitute.
 *
 * The packages are resolved from `packages/pdf-core`, the workspace that declares them:
 * pnpm's isolation keeps them out of the root's own resolution.
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { vi } from 'vitest';

const coreRequire = createRequire(new URL('./packages/pdf-core/package.json', import.meta.url));
const mupdfUrl = pathToFileURL(coreRequire.resolve('mupdf')).href;
// pdf.js insists on a trailing `/`; Node's `fs` accepts forward slashes on Windows too.
const pdfjsDir = dirname(coreRequire.resolve('pdfjs-dist/package.json')).replaceAll('\\', '/');

// Ghostscript is a fetched engine (`public/engines/ghostscript`, `pnpm fetch:engines`): the
// emscripten loader is imported by file URL and its wasm read by path, as Node does.
const ghostscriptDir = new URL('./public/engines/ghostscript/', import.meta.url);
const ghostscriptAssets = {
  js: new URL('gs.js', ghostscriptDir).href,
  wasm: fileURLToPath(new URL('gs.wasm', ghostscriptDir)),
};

vi.mock('./packages/pdf-core/src/engines/mupdf.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./packages/pdf-core/src/engines/mupdf.ts')>();
  return { ...actual, loadMupdf: () => import(/* @vite-ignore */ mupdfUrl) };
});

vi.mock('./packages/pdf-core/src/assets.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./packages/pdf-core/src/assets.ts')>();
  return {
    ...actual,
    PDFJS_ASSETS: {
      ...actual.PDFJS_ASSETS,
      cmaps: `${pdfjsDir}/cmaps/`,
      standardFonts: `${pdfjsDir}/standard_fonts/`,
      wasm: `${pdfjsDir}/wasm/`,
    },
    GHOSTSCRIPT_ASSETS: ghostscriptAssets,
  };
});

// The interface catalogues are chunks the shell loads before its first render
// (`apps/web/src/main.tsx`); the suite loads both the same way, so a translator built in a
// test has its words.
const { loadLocale } = await import('./packages/shared/src/i18n/index.ts');
await loadLocale('tr');
await loadLocale('en');
