/**
 * Engine asset locations.
 *
 * Engines are fetched into `public/engines/**` by `pnpm fetch:engines`, verified
 * against `tools/asset-pins.json` and served from our own origin — never from a
 * CDN, never at runtime from a third party. The paths below are absolute on
 * purpose: the editor is served from `/editor/` while the engines live at the
 * site root, exactly as the deployed layout has it.
 *
 * ## Versioned URLs
 *
 * `/engines/*` is served `immutable` for a year (`public/_headers`), so an engine's URL has
 * to change whenever its bytes do — otherwise a browser (or the service worker's own
 * `fetch`) keeps handing the new shell the old engine. Every engine therefore lives in a
 * **version directory**: `/engines/<engine>/<version>/<file>`. `<version>` is `v` and 12 hex
 * digits of a digest of the engine's pinned files (`engineVersions` in
 * `tools/fetch-engines.mjs`), recorded in `engine-versions.json`, which `pnpm verify:assets`
 * holds against the pins. It is a directory and not a `?v=` query because the engines
 * resolve their neighbours themselves: `mupdf.js` imports `./mupdf-wasm.js`, which fetches
 * `mupdf-wasm.wasm`, and pdf.js and tesseract.js append file names to the directory URLs
 * they are given. A query would reach the first file only.
 *
 * The build (`tools/assemble-dist.mjs`) puts each engine's files in that directory, and the
 * dev server (`tools/vite/hosting.mjs`) maps it back to `public/engines/<engine>/`. The
 * offline manifest lists the same URLs (`servedEnginePath`).
 */

import engineVersions from './engine-versions.json';

export const ENGINE_BASE_URL = '/engines';

/** The engines served from `/engines/<id>/<version>/`. */
export type EngineId = keyof typeof engineVersions.versions;

/** The URL of `file` — a path inside the engine, or a directory ending in `/` — of a pinned engine. */
export function engineUrl(engine: EngineId, file: string): string {
  return `${ENGINE_BASE_URL}/${engine}/${engineVersions.versions[engine]}/${file}`;
}

const LOGICAL_ENGINE_PATH = /^\/engines\/([^/]+)\/(.+)$/;

/**
 * The served URL of a path written as `/engines/<engine>/<file>`, which is how
 * `apps/web/src/offline-packages.json` names engine files. Any other path is returned as it
 * is. An engine the pins do not serve is a defect in the list and throws.
 */
export function servedEnginePath(path: string): string {
  const match = LOGICAL_ENGINE_PATH.exec(path);
  if (match === null) return path;
  const [, engine = '', file = ''] = match;
  if (!Object.hasOwn(engineVersions.versions, engine)) {
    throw new Error(`${path}: "${engine}" is not an engine the pins serve`);
  }
  return engineUrl(engine as EngineId, file);
}

export const PDFJS_ASSETS = {
  worker: engineUrl('pdfjs', 'pdf.worker.mjs'),
  /** Adobe CMaps — without these, CJK documents render incorrectly. */
  cmaps: engineUrl('pdfjs', 'cmaps/'),
  /** Standard-14 font data — without it, glyphs are substituted. */
  standardFonts: engineUrl('pdfjs', 'standard_fonts/'),
  /** openjpeg/qcms WASM used for JPEG2000 and ICC colour handling. */
  wasm: engineUrl('pdfjs', 'wasm/'),
  /** The annotation layer's note icons (`annotation-<name>.svg`), for a note without `/AP`. */
  images: engineUrl('pdfjs', 'images/'),
} as const;

/**
 * The MuPDF loader. Its wasm (`mupdf-wasm.wasm`) and glue (`mupdf-wasm.js`) are never named
 * here: they resolve next to this file, so the version directory carries over to them.
 */
export const MUPDF_ASSETS = {
  js: engineUrl('mupdf', 'mupdf.js'),
} as const;

/**
 * Ghostscript compiled to WebAssembly (PDF/A conversion). Loaded only when that tool runs,
 * inside a module worker: `js` is the emscripten loader, imported at runtime and never
 * bundled; the 15.5 MB `wasm` is fetched beside it.
 */
export const GHOSTSCRIPT_ASSETS = {
  js: engineUrl('ghostscript', 'gs.js'),
  wasm: engineUrl('ghostscript', 'gs.wasm'),
} as const;

/**
 * tesseract.js workers and language packs. All four paths are passed to
 * `createWorker` explicitly: tesseract.js otherwise resolves its worker, core and
 * language data from a CDN (browser default `workerPath` in
 * `src/worker/browser/defaultOptions.js`, `langPath` in
 * `src/worker-script/index.js`), which would be a third-party request and a network
 * call in the browser build.
 */
export const TESSERACT_ASSETS = {
  /**
   * The engine module itself, loaded at runtime instead of bundled. Bundling it
   * re-orders its module-scope bindings and its own `logger` then throws
   * `Cannot access 'i' before initialization` on every OCR run in the production
   * build (measured; the unminified build is clean). Served from our own origin
   * under `script-src 'self'`, byte-identical to the pinned artefact.
   */
  module: engineUrl('tesseract', 'tesseract.esm.min.js'),
  worker: engineUrl('tesseract', 'worker.min.js'),
  /**
   * SIMD + LSTM core, passed as a **file** and not as a directory: the worker picks
   * the variant itself when handed a directory
   * (`src/worker-script/browser/getCore.js:21`), and the build choice must not
   * happen at runtime — the pinned build is the one the OCR gate was measured on.
   * The core carries its wasm inline (a base64 data URL in the `.wasm.js` file), so the
   * pinned `.wasm` beside it is never requested and has no URL here.
   */
  core: engineUrl('tesseract', 'tesseract-core-simd-lstm.wasm.js'),
  /** `tessdata_fast` — the default; `best` is the quality gate's comparison. */
  fastLangPath: engineUrl('tesseract', 'lang/fast'),
  bestLangPath: engineUrl('tesseract', 'lang/best'),
} as const;

/**
 * Document fonts. The standard 14 cannot spell Turkish (WinAnsi has no `ş ğ ı İ`),
 * so every text a capability draws into a document — stamps, page numbers,
 * watermarks, the OCR layer — is embedded from here.
 *
 * These URLs carry no version and `public/_headers` does not mark them immutable: a pinned
 * font can change under the same path, so the browser revalidates it, and the worker's
 * cache name (which includes every pinned font's digest) is what keeps its copy current.
 */
export const NOTO_ASSETS = {
  regular: '/fonts/noto/NotoSans-Regular.ttf',
  semiBold: '/fonts/noto/NotoSans-SemiBold.ttf',
} as const;

/** Languages whose traineddata is pinned for offline use. */
export const OCR_LANGUAGE_CODES = ['tur', 'eng'] as const;
