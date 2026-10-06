/**
 * Engine asset locations.
 *
 * Engines are fetched into `public/engines/**` by `pnpm fetch:engines`, verified
 * against `tools/asset-pins.json` and served from our own origin — never from a
 * CDN, never at runtime from a third party. The paths below are absolute on
 * purpose: the editor is served from `/editor/` while the engines live at the
 * site root, exactly as the deployed layout has it.
 */

export const ENGINE_BASE_URL = '/engines';

export const PDFJS_ASSETS = {
  worker: `${ENGINE_BASE_URL}/pdfjs/pdf.worker.mjs`,
  /** Adobe CMaps — without these, CJK documents render incorrectly (source defect 6). */
  cmaps: `${ENGINE_BASE_URL}/pdfjs/cmaps/`,
  /** Standard-14 font data — same defect: missing data means substituted glyphs. */
  standardFonts: `${ENGINE_BASE_URL}/pdfjs/standard_fonts/`,
  /** openjpeg/qcms WASM used for JPEG2000 and ICC colour handling. */
  wasm: `${ENGINE_BASE_URL}/pdfjs/wasm/`,
} as const;

export const MUPDF_ASSETS = {
  wasm: `${ENGINE_BASE_URL}/mupdf/mupdf-wasm.wasm`,
  js: `${ENGINE_BASE_URL}/mupdf/mupdf.js`,
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
  module: `${ENGINE_BASE_URL}/tesseract/tesseract.esm.min.js`,
  worker: `${ENGINE_BASE_URL}/tesseract/worker.min.js`,
  /**
   * SIMD + LSTM core, passed as a **file** and not as a directory: the worker picks
   * the variant itself when handed a directory
   * (`src/worker-script/browser/getCore.js:21`), and the build choice must not
   * happen at runtime — the pinned build is the one the OCR gate was measured on.
   */
  core: `${ENGINE_BASE_URL}/tesseract/tesseract-core-simd-lstm.wasm.js`,
  coreWasm: `${ENGINE_BASE_URL}/tesseract/tesseract-core-simd-lstm.wasm`,
  /** `tessdata_fast` — the default; `best` is the quality gate's comparison. */
  fastLangPath: `${ENGINE_BASE_URL}/tesseract/lang/fast`,
  bestLangPath: `${ENGINE_BASE_URL}/tesseract/lang/best`,
} as const;

/**
 * Document fonts. The standard 14 cannot spell Turkish (WinAnsi has no `ş ğ ı İ`),
 * so every text a capability draws into a document — stamps, page numbers,
 * watermarks, the OCR layer — is embedded from here.
 */
export const NOTO_ASSETS = {
  regular: '/fonts/noto/NotoSans-Regular.ttf',
  semiBold: '/fonts/noto/NotoSans-SemiBold.ttf',
} as const;

/** Languages whose traineddata is pinned for offline use. */
export const OCR_LANGUAGE_CODES = ['tur', 'eng'] as const;
