#!/usr/bin/env node
/**
 * Fetch the pinned engine builds into `public/engines/**` and keep their
 * SHA-256 pins in `tools/asset-pins.json` (engines are fetched by script, pinned
 * by size + hash and never committed).
 *
 *   node tools/fetch-engines.mjs            verify the files on disk against the pins (default)
 *   node tools/fetch-engines.mjs --update   copy the engine builds and rewrite the pins
 *
 * Packages are resolved from the pnpm store (`node_modules/.pnpm/<dir>/node_modules/<pkg>`);
 * version and licence are always read from the package's own `package.json`, never hardcoded.
 * `tools/verify-assets.mjs` reuses `verifyAssets()` + `printReport()` from this file, so the
 * CI/local check and the default mode here can never disagree.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLS_DIR, '..');
const STORE_DIR = join(ROOT, 'node_modules', '.pnpm');

export const PUBLIC_DIR = join(ROOT, 'public');
export const PINS_PATH = join(TOOLS_DIR, 'asset-pins.json');
export const PINS_GENERATED_BY = 'tools/fetch-engines.mjs';

const MIB = 1024 * 1024;
const HASH_CHUNK = 1024 * 1024;

/** OCR languages beyond Turkish and English; the order is `OCR_LANGUAGE_CODES_ALL`'s. */
const OCR_EXTRA_LANGUAGES = [
  'deu',
  'fra',
  'spa',
  'ita',
  'por',
  'nld',
  'pol',
  'ces',
  'hun',
  'ron',
  'swe',
  'aze',
  'kmr',
  'rus',
  'ukr',
  'bul',
  'ell',
  'ara',
  'fas',
  'heb',
  'hin',
  'chi_sim',
  'chi_tra',
  'jpn',
  'kor',
];

/**
 * The engine table.
 *
 * `entries[].from` is relative to the package root, `entries[].to` is relative to the engine's
 * target directory under `public/`. A directory source is copied recursively. `optional: true`
 * marks an artefact a package may not ship — it is skipped instead of failing the run.
 *
 * `optional: true` on the engine itself means "not installed yet": the row exists so that pinning
 * it later is a one-line change, and `--update` reports it as skipped instead of failing.
 *
 * `entries[].package` names a package other than `engine.package` (OCR ships four: the worker, the
 * core, and one data pack per language). Every package an engine pulls from is resolved and
 * recorded in the pins with its own version and licence, so the audit can see the whole set.
 */
const ENGINES = [
  {
    id: 'pdfjs',
    package: 'pdfjs-dist',
    target: 'engines/pdfjs',
    // pdf.js fetches the worker, cMaps, standard fonts and its wasm decoders from `baseUrl`
    // at runtime, so they must be same-origin files rather than bundle imports.
    entries: [
      { from: 'build/pdf.worker.mjs', to: 'pdf.worker.mjs' },
      { from: 'build/pdf.worker.min.mjs', to: 'pdf.worker.min.mjs' },
      { from: 'cmaps', to: 'cmaps' },
      { from: 'standard_fonts', to: 'standard_fonts' },
      { from: 'wasm', to: 'wasm' },
    ],
  },
  {
    id: 'mupdf',
    package: 'mupdf',
    target: 'engines/mupdf',
    entries: [
      { from: 'dist/mupdf.js', to: 'mupdf.js' },
      { from: 'dist/mupdf-wasm.wasm', to: 'mupdf-wasm.wasm' },
      { from: 'dist/mupdf-wasm.js', to: 'mupdf-wasm.js', optional: true },
    ],
  },
  {
    id: 'ghostscript',
    package: '@bentopdf/gs-wasm',
    target: 'engines/ghostscript',
    // PDF/A conversion (`pdf-core/ops/pdfa.ts`): Ghostscript 10.06.0 built for WebAssembly, AGPL-3.0
    // (the package ships its build scripts as the corresponding source). It runs in a module worker
    // (`engines/ghostscript-worker.ts`) that imports `gs.js` from our own origin; `gs.js` finds
    // `gs.wasm` next to itself. The sRGB profile and the PDF/A definition the conversion needs are
    // not separate assets: the profile is read from Ghostscript's own ROM at run time and the
    // definition is written by the worker.
    entries: [
      { from: 'assets/gs.js', to: 'gs.js' },
      { from: 'assets/gs.wasm', to: 'gs.wasm' },
    ],
  },
  {
    id: 'space-grotesk',
    package: '@fontsource/space-grotesk',
    target: 'fonts/space-grotesk',
    // UI typeface (`P6`, `DESIGN.md`): OFL-1.1, self-hosted so the app keeps its
    // offline promise, and never committed — the pins below are the reference.
    // Turkish coverage comes from the `latin-ext` subset: Ğ/ğ U+011E/011F,
    // İ/ı U+0130/0131, Ş/ş U+015E/015F all fall inside U+0100-02BA.
    // Weights kept lean (400/500/600) because a dense tool needs three, not nine.
    entries: [
      { from: 'files/space-grotesk-latin-400-normal.woff2', to: 'space-grotesk-latin-400-normal.woff2' },
      { from: 'files/space-grotesk-latin-500-normal.woff2', to: 'space-grotesk-latin-500-normal.woff2' },
      { from: 'files/space-grotesk-latin-600-normal.woff2', to: 'space-grotesk-latin-600-normal.woff2' },
      {
        from: 'files/space-grotesk-latin-ext-400-normal.woff2',
        to: 'space-grotesk-latin-ext-400-normal.woff2',
      },
      {
        from: 'files/space-grotesk-latin-ext-500-normal.woff2',
        to: 'space-grotesk-latin-ext-500-normal.woff2',
      },
      {
        from: 'files/space-grotesk-latin-ext-600-normal.woff2',
        to: 'space-grotesk-latin-ext-600-normal.woff2',
      },
    ],
  },
  {
    id: 'dm-sans',
    package: '@fontsource/dm-sans',
    target: 'fonts/dm-sans',
    // Body typeface (DESIGN.md): OFL-1.1, self-hosted, offline-first.
    // Turkish coverage via latin-ext.
    entries: [
      { from: 'files/dm-sans-latin-400-normal.woff2', to: 'dm-sans-latin-400-normal.woff2' },
      { from: 'files/dm-sans-latin-500-normal.woff2', to: 'dm-sans-latin-500-normal.woff2' },
      { from: 'files/dm-sans-latin-600-normal.woff2', to: 'dm-sans-latin-600-normal.woff2' },
      { from: 'files/dm-sans-latin-700-normal.woff2', to: 'dm-sans-latin-700-normal.woff2' },
      { from: 'files/dm-sans-latin-ext-400-normal.woff2', to: 'dm-sans-latin-ext-400-normal.woff2' },
      { from: 'files/dm-sans-latin-ext-500-normal.woff2', to: 'dm-sans-latin-ext-500-normal.woff2' },
      { from: 'files/dm-sans-latin-ext-600-normal.woff2', to: 'dm-sans-latin-ext-600-normal.woff2' },
      { from: 'files/dm-sans-latin-ext-700-normal.woff2', to: 'dm-sans-latin-ext-700-normal.woff2' },
    ],
  },
  {
    id: 'handwriting',
    package: '@fontsource/dancing-script',
    target: 'fonts/handwriting',
    // The faces a typed signature is drawn in (OFL-1.1). The signature is rendered to an
    // image in the browser and only that image reaches the file, so these are display
    // faces, never embedded. Turkish letters come from the `latin-ext` subsets.
    entries: [
      { from: 'files/dancing-script-latin-400-normal.woff2', to: 'dancing-script-latin-400-normal.woff2' },
      {
        from: 'files/dancing-script-latin-ext-400-normal.woff2',
        to: 'dancing-script-latin-ext-400-normal.woff2',
      },
      {
        package: '@fontsource/great-vibes',
        from: 'files/great-vibes-latin-400-normal.woff2',
        to: 'great-vibes-latin-400-normal.woff2',
      },
      {
        package: '@fontsource/great-vibes',
        from: 'files/great-vibes-latin-ext-400-normal.woff2',
        to: 'great-vibes-latin-ext-400-normal.woff2',
      },
    ],
  },
  {
    id: 'noto',
    package: '@expo-google-fonts/noto-sans',
    target: 'fonts/noto',
    // Embedding face for stamps, header/footer and signature text (OFL-1.1). Text
    // drawn by the MuPDF writers is embedded from a real TTF rather than a base-14 font: the built-in faces
    // carry no Turkish diacritics (Ğ/ğ, İ/ı, Ş/ş) and cannot be subset reliably. Two of the
    // eighteen weights the package ships: regular for body text, semibold for headings and
    // Bates-style stamps.
    entries: [
      { from: '400Regular/NotoSans_400Regular.ttf', to: 'NotoSans-Regular.ttf' },
      { from: '600SemiBold/NotoSans_600SemiBold.ttf', to: 'NotoSans-SemiBold.ttf' },
    ],
  },
  {
    id: 'tesseract',
    package: 'tesseract.js',
    target: 'engines/tesseract',
    // OCR (Apache-2.0). The worker is a plain script the OCR engine spawns from our
    // own origin; `corePath` points at the core loader below instead of the default CDN, because
    // the browser build makes no third-party request, ever.
    //
    // Which core the worker picks is decided inside `getCore.js`: with the default
    // `OEM.LSTM_ONLY` it importScripts `<corePath>/tesseract-core-simd-lstm.wasm.js` on a SIMD
    // device, otherwise one of the three other loaders. Only the SIMD+LSTM loader is pinned —
    // adding a second variant means adding a row here, never widening the app's capability
    // silently.
    //
    // That loader embeds its own wasm as a base64 data URI — its payload decodes to exactly the
    // 2 871 377 bytes of the `.wasm` next to it — so it fetches **no sibling file at runtime**. The
    // `.wasm` is pinned anyway: it is the artefact the glue is generated from, and the one to hand
    // to anything that wants the binary itself (inspection, a rebuild, a different loader).
    //
    // Traineddata is copied from the package's own `4.0.0` / `4.0.0_best_int` directories; the
    // target names are the asset table's labels. Upstream these are two quality releases rather
    // than two speeds: the `4.0.0` pack is what tesseract.js selects for legacy+LSTM (`oem` 0/2)
    // and the integerized `_best_int` pack what it selects for LSTM-only (`oem` 1, the default) —
    // so the OCR engine points `langPath` at the matching directory and never reaches the CDN
    // (`src/worker-script/index.js` in the package). Served as `.gz` because that is what the
    // worker's gunzip path expects.
    entries: [
      { from: 'dist/worker.min.js', to: 'worker.min.js' },
      // The engine module itself is served, not bundled: bundling re-orders its
      // module-scope bindings and its own `logger` then throws `Cannot access 'i'
      // before initialization` on every OCR run in the production build (measured;
      // the unminified build is clean). Serving the pinned file also keeps the
      // engine byte-identical to the artifact this pin names.
      { from: 'dist/tesseract.esm.min.js', to: 'tesseract.esm.min.js' },
      {
        package: 'tesseract.js-core',
        from: 'tesseract-core-simd-lstm.wasm.js',
        to: 'tesseract-core-simd-lstm.wasm.js',
      },
      {
        package: 'tesseract.js-core',
        from: 'tesseract-core-simd-lstm.wasm',
        to: 'tesseract-core-simd-lstm.wasm',
      },
      {
        package: '@tesseract.js-data/tur',
        from: '4.0.0/tur.traineddata.gz',
        to: 'lang/fast/tur.traineddata.gz',
      },
      {
        package: '@tesseract.js-data/eng',
        from: '4.0.0/eng.traineddata.gz',
        to: 'lang/fast/eng.traineddata.gz',
      },
      {
        package: '@tesseract.js-data/tur',
        from: '4.0.0_best_int/tur.traineddata.gz',
        to: 'lang/best/tur.traineddata.gz',
      },
      {
        package: '@tesseract.js-data/eng',
        from: '4.0.0_best_int/eng.traineddata.gz',
        to: 'lang/best/eng.traineddata.gz',
      },
      // The other languages ship the integerized best model only (`engines/tesseract.ts`,
      // `OCR_LANGUAGE_CODES_ALL`): the LSTM-only worker reads nothing else, and the
      // `4.0.0` Chinese pack alone (27 MB) is over the 25 MiB a deployed asset may be.
      ...OCR_EXTRA_LANGUAGES.map((code) => ({
        package: `@tesseract.js-data/${code}`,
        from: `4.0.0_best_int/${code}.traineddata.gz`,
        to: `lang/best/${code}.traineddata.gz`,
      })),
    ],
  },
];

/** sha256 + byte size, read in 1 MiB chunks so a 10 MiB wasm is never held in memory twice. */
function hashAndSize(absPath) {
  const hash = createHash('sha256');
  const fd = openSync(absPath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(HASH_CHUNK);
    let bytes = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, HASH_CHUNK, null);
      if (read === 0) break;
      hash.update(read === HASH_CHUNK ? chunk : chunk.subarray(0, read));
      bytes += read;
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

/** SPDX id from a package.json, accepting the legacy `license: { type }` / `licenses` shapes. */
function licenseOf(meta) {
  if (typeof meta.license === 'string') return meta.license;
  if (meta.license && typeof meta.license.type === 'string') return meta.license.type;
  if (Array.isArray(meta.licenses) && meta.licenses.length > 0) {
    return meta.licenses.map((entry) => entry.type ?? '?').join(' OR ');
  }
  return null;
}

/** pnpm names the store directory for `<scope>/<name>` as `<scope>+<name>@<version>`. */
function storePrefix(name) {
  return `${name.replace('/', '+')}@`;
}

function compareVersions(a, b) {
  const left = String(a).split(/[.+-]/);
  const right = String(b).split(/[.+-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? '';
    const y = right[i] ?? '';
    const nx = Number.parseInt(x, 10);
    const ny = Number.parseInt(y, 10);
    const order = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : nx - ny;
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Find an installed package in the pnpm store. Several versions may be present (two workspace
 * packages disagreeing); the highest wins and the others are reported by the caller.
 */
function resolvePackage(name) {
  if (!existsSync(STORE_DIR)) return { installed: false };
  const candidates = [];
  for (const entry of readdirSync(STORE_DIR)) {
    if (!entry.startsWith(storePrefix(name))) continue;
    const dir = join(STORE_DIR, entry, 'node_modules', ...name.split('/'));
    const metaPath = join(dir, 'package.json');
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    candidates.push({ dir, version: meta.version ?? '?', license: licenseOf(meta) });
  }
  if (candidates.length === 0) return { installed: false };
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return {
    installed: true,
    name,
    ...candidates[0],
    otherVersions: candidates.slice(1).map((c) => c.version),
  };
}

function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs));
    else out.push(abs);
  }
  return out;
}

/** Every package an engine copies from: its own, plus any `entries[].package` override. */
function enginePackages(engine) {
  const names = new Set([engine.package]);
  for (const entry of engine.entries ?? []) {
    if (entry.package) names.add(entry.package);
  }
  return [...names];
}

/** The version column: one package prints its version, a set prints how many packages it covers. */
function describePackages(packages) {
  if (!Array.isArray(packages) || packages.length === 0) return null;
  return packages.length === 1 ? packages[0].version : `${packages.length} packages`;
}

function pinnedPath(absPath) {
  return relative(PUBLIC_DIR, absPath).split(sep).join('/');
}

/** Copy one engine's artefacts into `public/<target>` and return their pins, sorted by path. */
function copyEngine(engine, packages) {
  const files = [];
  const skipped = [];
  const problems = [];
  for (const entry of engine.entries) {
    const owner = packages.get(entry.package ?? engine.package);
    if (owner === undefined) {
      // Unreachable: `update()` resolves every package named by `enginePackages()` first and
      // abandons the row when one is missing. Failing here keeps that invariant honest.
      problems.push(`${engine.package}: ${entry.from} has no resolved package ${entry.package}`);
      continue;
    }
    const src = join(owner.dir, entry.from);
    if (!existsSync(src)) {
      (entry.optional ? skipped : problems).push(`${owner.name}: ${entry.from}`);
      continue;
    }
    const dest = join(PUBLIC_DIR, engine.target, entry.to);
    // A re-fetch must not leave files from the previous package version behind, so a tree is
    // replaced wholesale instead of merged.
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
    for (const file of statSync(dest).isDirectory() ? walkFiles(dest) : [dest]) {
      const { bytes, sha256 } = hashAndSize(file);
      files.push({ path: pinnedPath(file), bytes, sha256 });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, skipped, problems };
}

function writePins(engines) {
  const ordered = {};
  for (const id of Object.keys(engines).sort()) ordered[id] = engines[id];
  writeFileSync(
    PINS_PATH,
    `${JSON.stringify({ generatedBy: PINS_GENERATED_BY, engines: ordered }, null, 2)}\n`,
  );
}

export function loadPins(pinsPath = PINS_PATH) {
  if (!existsSync(pinsPath)) {
    throw new Error(`no pins at ${relative(ROOT, pinsPath)} — run: node tools/fetch-engines.mjs --update`);
  }
  const pins = JSON.parse(readFileSync(pinsPath, 'utf8'));
  if (!pins || typeof pins.engines !== 'object' || pins.engines === null) {
    throw new Error(`${relative(ROOT, pinsPath)} has no "engines" map`);
  }
  return pins;
}

/** Recompute size + sha256 of every pinned file. Returns rows plus every difference found. */
export function verifyAssets({ pinsPath = PINS_PATH, publicDir = PUBLIC_DIR } = {}) {
  const pins = loadPins(pinsPath);
  const rows = [];
  const problems = [];
  for (const id of Object.keys(pins.engines).sort()) {
    const engine = pins.engines[id];
    const files = engine.files ?? [];
    let bytes = 0;
    const engineProblems = [];
    for (const pin of files) {
      const abs = join(publicDir, ...pin.path.split('/'));
      const diff = (kind, detail) => {
        const problem = { engine: id, path: pin.path, kind, detail };
        engineProblems.push(problem);
        problems.push(problem);
      };
      if (!existsSync(abs)) {
        diff('missing', 'file is not on disk');
        continue;
      }
      const actual = hashAndSize(abs);
      bytes += actual.bytes;
      if (actual.bytes !== pin.bytes) {
        diff('size', `pinned ${pin.bytes} B, on disk ${actual.bytes} B`);
      } else if (actual.sha256 !== pin.sha256) {
        diff('sha256', `pinned ${pin.sha256}, on disk ${actual.sha256}`);
      }
    }
    rows.push({
      id,
      version: describePackages(engine.packages),
      packages: engine.packages ?? [],
      files: files.length,
      bytes,
      problems: engineProblems,
    });
  }
  return {
    rows,
    problems,
    totalFiles: rows.reduce((sum, row) => sum + row.files, 0),
    totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0),
  };
}

function printTable(headers, rows) {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i].length)));
  const line = (cells) =>
    cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');
  console.log(line(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

const EMPTY = '-';

/** One line per engine with PASS/FAIL, the totals row, every difference, then the verdict. */
export function printReport(result, { action = 'verify' } = {}) {
  const mib = (bytes) => (bytes / MIB).toFixed(2);
  const rows = result.rows.map((row) => [
    row.id,
    row.version ?? EMPTY,
    String(row.files),
    mib(row.bytes),
    row.problems.length === 0 ? 'PASS' : `FAIL (${row.problems.length})`,
  ]);
  rows.push([
    'total',
    EMPTY,
    String(result.totalFiles),
    mib(result.totalBytes),
    result.problems.length === 0 ? 'PASS' : 'FAIL',
  ]);
  printTable(['engine', 'version', 'files', 'MiB', 'status'], rows);
  for (const problem of result.problems) {
    console.log(`  x ${problem.engine}/${problem.path}: ${problem.kind} — ${problem.detail}`);
  }
  console.log(
    result.problems.length === 0
      ? `\n${action}: ${result.totalFiles} pinned file(s) match — ${mib(result.totalBytes)} MiB across ${result.rows.length} engine(s).`
      : `\n${action}: ${result.problems.length} difference(s) against tools/asset-pins.json.`,
  );
}

function update({ write = true } = {}) {
  const engines = {};
  const rows = [];
  const failures = [];
  const notes = [];
  for (const engine of ENGINES) {
    // Every package the row copies from is resolved up front: a row that names a package the store
    // does not have fails by name instead of pinning a half-complete set.
    const packages = new Map();
    const unresolved = [];
    for (const name of enginePackages(engine)) {
      const pkg = resolvePackage(name);
      if (!pkg.installed) {
        unresolved.push({ name, reason: 'not installed — run `pnpm install`' });
        continue;
      }
      if (!pkg.license) {
        unresolved.push({
          name: `${name}@${pkg.version}`,
          reason: 'package.json declares no licence — pinning it would hide a licence-audit hole',
        });
        continue;
      }
      if (pkg.otherVersions.length > 0) {
        notes.push(`${name}: ${pkg.otherVersions.join(', ')} also installed — pinning ${pkg.version}`);
      }
      packages.set(name, pkg);
    }
    if (unresolved.length > 0) {
      if (engine.optional) {
        rows.push([engine.id, EMPTY, EMPTY, EMPTY, 'not installed (skipped)']);
        notes.push(
          `${unresolved.map((entry) => entry.name).join(', ')} is not installed — its row is skipped (install it to enable)`,
        );
        continue;
      }
      failures.push(...unresolved.map((entry) => `${entry.name}: ${entry.reason}`));
      continue;
    }
    const { files, skipped, problems } = engine.recordOnly
      ? { files: [], skipped: [], problems: [] }
      : copyEngine(engine, packages);
    if (problems.length > 0) {
      failures.push(`${engine.package}: missing artefact(s) ${problems.join(', ')}`);
      continue;
    }
    if (skipped.length > 0) notes.push(`skipped optional artefact(s): ${skipped.join(', ')}`);
    const recorded = [...packages.values()]
      .map((pkg) => ({ name: pkg.name, version: pkg.version, license: pkg.license }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    engines[engine.id] = { packages: recorded, files };
    rows.push([
      engine.id,
      describePackages(recorded) ?? EMPTY,
      String(files.length),
      (files.reduce((sum, file) => sum + file.bytes, 0) / MIB).toFixed(2),
      engine.recordOnly ? 'record only' : 'copied',
    ]);
  }

  const totalFiles = rows.reduce((sum, row) => sum + (Number.parseInt(row[2], 10) || 0), 0);
  const totalMib = rows.reduce((sum, row) => sum + (Number.parseFloat(row[3]) || 0), 0);
  rows.push([
    'total',
    EMPTY,
    String(totalFiles),
    totalMib.toFixed(2),
    failures.length === 0 ? 'copied' : 'FAIL',
  ]);
  printTable(['engine', 'version', 'files', 'MiB', 'status'], rows);
  for (const note of notes) console.log(`  - ${note}`);

  if (failures.length > 0) {
    console.error(`\nfetch-engines ${write ? '--update' : '--sync'}: ${failures.length} problem(s)\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('\nNo pins written.');
    process.exitCode = 1;
    return;
  }
  if (!write) {
    // `--sync` materialises the binaries a fresh checkout does not carry (they are
    // gitignored) and then holds them against the **committed** pins. Nothing is
    // rewritten: a mismatch must fail the build, not silently update the reference.
    console.log(
      `\nfetch-engines --sync: ${totalFiles} file(s) copied from node_modules — verifying against the committed pins`,
    );
    const result = verifyAssets();
    printReport(result, { action: 'fetch-engines (sync → verify)' });
    if (result.problems.length > 0) process.exitCode = 1;
    return;
  }
  writePins(engines);
  console.log(
    `\nfetch-engines --update: ${totalFiles} file(s) pinned — ${totalMib.toFixed(2)} MiB — wrote ${relative(ROOT, PINS_PATH)}`,
  );
}

function verify() {
  const result = verifyAssets();
  printReport(result, { action: 'fetch-engines (verify)' });
  if (result.problems.length > 0) process.exitCode = 1;
}

const USAGE = `usage: node tools/fetch-engines.mjs [--update|--sync]

  (default)   verify public/engines/** against tools/asset-pins.json
  --update    copy the pinned engine builds and rewrite tools/asset-pins.json
  --sync      copy the engine builds from node_modules, then verify them against the
              committed pins (nothing is rewritten) — this is what a fresh CI checkout runs`;

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const unknown = args.filter(
    (arg) => arg !== '--update' && arg !== '-u' && arg !== '--sync' && arg !== '-s',
  );
  if (unknown.length > 0) {
    console.error(`fetch-engines: unknown argument(s): ${unknown.join(', ')}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const sync = args.includes('--sync') || args.includes('-s');
  const write = args.includes('--update') || args.includes('-u');
  if (sync) update({ write: false });
  else if (write) update();
  else verify();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`\nfetch-engines: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
