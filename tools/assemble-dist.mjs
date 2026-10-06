#!/usr/bin/env node
/**
 * Build the deployable static layout into `dist/`.
 *
 *   dist/                 <- apps/site/dist (landing at /, /gizlilik, /kosullar)
 *   dist/editor/          <- apps/web/dist  (the PWA, base /editor/)
 *   dist/{_headers,404.html,robots.txt,sitemap.xml,manifest.webmanifest,favicon.svg,theme-boot.js}
 *   dist/engines/**       <- pinned engine builds (fetched, never committed)
 *
 * One Cloudflare Worker (static assets) serves this tree; deploying stays manual and is
 * never a CI step.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'dist');

function copyInto(from, to) {
  if (!existsSync(from)) {
    console.error(`assemble-dist: missing ${relative(root, from)} — run the build first`);
    process.exit(1);
  }
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}

function sizeOf(path) {
  const stats = statSync(path);
  if (stats.isFile()) return stats.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += sizeOf(join(path, entry.name));
  }
  return total;
}

rmSync(out, { recursive: true, force: true });
copyInto(join(root, 'apps/site/dist'), out);
copyInto(join(root, 'apps/web/dist'), join(out, 'editor'));
copyInto(join(root, 'public'), out);

/**
 * The offline identity: one version for the cache name, the manifest and the
 * worker, derived from the pinned asset hashes and the release stamp. Deriving it here —
 * from `tools/asset-pins.json`, the same table `verify-assets` enforces — is what makes
 * "the cached engine belongs to this shell" a checkable fact instead of an assumption:
 * change a pin, and every cache name in the distribution changes with it.
 */
const pins = JSON.parse(readFileSync(join(root, 'tools/asset-pins.json'), 'utf8'));
const pinned = Object.values(pins.engines).flatMap((engine) => engine.files);
const stamp =
  readFileSync(join(root, 'package.json'), 'utf8').match(/"version":\s*"([^"]+)"/)?.[1] ?? '0.0.0';
const digest = createHash('sha256');
digest.update(stamp);
for (const file of [...pinned].sort((left, right) => (left.path < right.path ? -1 : 1))) {
  digest.update(file.path);
  digest.update(file.sha256);
}
const version = `${stamp}-${digest.digest('hex').slice(0, 12)}`;

const packages = JSON.parse(readFileSync(join(root, 'apps/web/src/offline-packages.json'), 'utf8'));
writeFileSync(
  join(out, 'offline-manifest.json'),
  `${JSON.stringify({ version, capabilities: packages.capabilities }, null, 2)}\n`,
);

/**
 * The project's own licence ships **with** the distribution, not only in the repository:
 * the licence text is what tells a recipient what they may do with the copy they were
 * given, and a minifier strips the comments that would otherwise carry it.
 *
 * `LICENSE` is the only hand-written notice the distribution needs; every third-party
 * obligation travels as the bundled licence texts under `dist/licenses/` below.
 */
const licenceFile = join(root, 'LICENSE');
if (!existsSync(licenceFile)) {
  console.error('assemble-dist: missing LICENSE — the distribution must carry its licence');
  process.exit(1);
}
copyFileSync(licenceFile, join(out, 'LICENSE'));

/**
 * Every bundled licence text, copied into `dist/licenses/`.
 *
 * MIT, BSD, Apache-2.0, OFL-1.1 and AGPL-3.0 all require the notice to accompany the
 * copies that are distributed, and a minifier strips the comments that would otherwise
 * carry it. The sources are the **installed packages** — the same bytes the engines come
 * from — rather than the pin table: `tools/asset-pins.json` exists to guarantee the
 * *runtime* engine bytes, and mixing licence texts into it would blur what that gate
 * proves. Each entry names the package it came from, so the copy is checkable.
 *
 * A missing licence file is a hard failure. Shipping the code without its notice is the
 * one outcome this step exists to prevent.
 */
const LICENCE_SOURCES = [
  ['mupdf', 'mupdf/LICENSE'],
  ['tesseract.js', 'tesseract.js/LICENSE.md'],
  ['tesseract.js-core', 'tesseract.js-core/LICENSE'],
  ['@fontsource/space-grotesk', '@fontsource/space-grotesk/LICENSE'],
  ['@fontsource/dm-sans', '@fontsource/dm-sans/LICENSE'],
  ['@fontsource/dancing-script', '@fontsource/dancing-script/LICENSE'],
  ['@fontsource/great-vibes', '@fontsource/great-vibes/LICENSE'],
  ['@expo-google-fonts/noto-sans', '@expo-google-fonts/noto-sans/LICENSE'],
  ['@expo-google-fonts/noto-sans (font)', '@expo-google-fonts/noto-sans/LICENSE_FONT'],
  ['pdfjs-dist', 'pdfjs-dist/LICENSE'],
  ['pkijs', 'pkijs/LICENSE'],
  ['@noble/hashes', '@noble/hashes/LICENSE'],
  ['asn1js', 'asn1js/LICENSE'],
  ['bytestreamjs', 'bytestreamjs/LICENSE'],
  ['pvtsutils', 'pvtsutils/LICENSE'],
  ['pvutils', 'pvutils/LICENSE'],
  ['react', 'react/LICENSE'],
  ['react-dom', 'react-dom/LICENSE'],
  ['scheduler', 'scheduler/LICENSE'],
  ['use-sync-external-store', 'use-sync-external-store/LICENSE'],
  ['@cloudflare/kumo', '@cloudflare/kumo/LICENSE'],
  ['@phosphor-icons/react', '@phosphor-icons/react/LICENSE'],
];

/**
 * The installed directory of a dependency, resolved the way Node does.
 *
 * pnpm keeps a flat store under `node_modules/.pnpm/<name>@<version>/node_modules/<name>`
 * and links only the packages a workspace actually declares, so a transitive dependency
 * (`pvtsutils`, `scheduler`) has no top-level link at all. Reading
 * `node_modules/<name>` would therefore report "not installed" for packages that are
 * installed and bundled. `require.resolve` walks the real resolution path from each
 * workspace that consumes the dependency, which is the only answer that matches what the
 * bundler actually pulls in.
 */
function packageDir(name) {
  const from = [
    join(root, 'apps', 'web'),
    join(root, 'packages', 'pdf-core'),
    join(root, 'packages', 'pdf-ui'),
    join(root, 'packages', 'pdf-model'),
    join(root, 'packages', 'shared'),
    root,
  ];
  for (const base of from) {
    const require = createRequire(join(base, 'package.json'));
    // `resolve('<name>/package.json')` is the direct answer, but a package may refuse
    // that subpath in its `exports` map (`mupdf` does). Resolving the entry point and
    // walking up to the directory that owns `package.json` works either way, because
    // every entry point lives inside the package it belongs to.
    try {
      return dirname(require.resolve(`${name}/package.json`));
    } catch {
      // Fall through to the entry-point walk.
    }
    try {
      let current = dirname(require.resolve(name));
      for (let depth = 0; depth < 8; depth += 1) {
        if (existsSync(join(current, 'package.json'))) return current;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch {
      // Not resolvable from this workspace; try the next one.
    }
  }
  // A purely transitive dependency has no link to resolve through (`scheduler` arrives under
  // `react-dom`, `bytestreamjs` under `pkijs`). pnpm's store names each package directory
  // `<name>@<version>`, so the last resort is an exact-name scan of that store — still a
  // real installed copy, never a download.
  const store = join(root, 'node_modules', '.pnpm');
  const flat = name.replace('/', '+');
  if (existsSync(store)) {
    const prefix = `${flat}@`;
    const match = readdirSync(store)
      .filter(
        (entry) => entry === flat || entry.startsWith(prefix) || entry.startsWith(`${prefix.slice(0, -1)}_`),
      )
      .sort()
      .pop();
    if (match !== undefined) {
      const candidate = join(store, match, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return candidate;
    }
  }
  return null;
}

const licenceDir = join(out, 'licenses');
mkdirSync(licenceDir, { recursive: true });
const licenceIndex = [];
const missingLicences = [];
for (const [label, relative] of LICENCE_SOURCES) {
  const packageName = label.replace(' (font)', '');
  const base = packageDir(packageName);
  if (base === null) {
    missingLicences.push(`${label}: package not installed`);
    continue;
  }
  const source = join(base, relative.slice(packageName.length + 1));
  if (!existsSync(source)) {
    missingLicences.push(`${label}: ${relative} not found in the package`);
    continue;
  }
  const target = `${packageName.replace('@', '').replace('/', '-')}${relative.endsWith('LICENSE_FONT') ? '-font' : ''}.txt`;
  copyFileSync(source, join(licenceDir, target));
  licenceIndex.push({ component: label, file: `licenses/${target}` });
}
/**
 * Every npm package the editor bundle actually carries must have its text above. The
 * editor build writes source maps, and their `sources` name each package a chunk came
 * from — the bundler's own record, so a new transitive dependency (`@noble/hashes`
 * arrived under `pkijs` unnoticed) fails here instead of shipping without its notice.
 * No maps at all is a failure too: the audit would otherwise pass by seeing nothing.
 */
function bundledPackages(dir) {
  const names = new Set();
  let maps = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.map')) {
        maps += 1;
        for (const source of JSON.parse(readFileSync(path, 'utf8')).sources ?? []) {
          const match = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(source);
          if (match?.[1] !== undefined) names.add(match[1]);
        }
      }
    }
  };
  walk(dir);
  return { names, maps };
}
const licensed = new Set(LICENCE_SOURCES.map(([label]) => label.replace(' (font)', '')));
const editorBundle = bundledPackages(join(root, 'apps/web/dist'));
if (editorBundle.maps === 0)
  missingLicences.push('apps/web/dist: no source maps to audit the bundle against');
for (const name of [...editorBundle.names].sort()) {
  if (!licensed.has(name))
    missingLicences.push(`${name}: bundled into the editor, no entry in LICENCE_SOURCES`);
}
if (missingLicences.length > 0) {
  console.error('assemble-dist: bundled licence texts are missing:');
  for (const entry of missingLicences) console.error(`  - ${entry}`);
  process.exit(1);
}
// The pinned pdf.js wasm/cmap/font licences travel inside `public/engines/**` already;
// record them so the index describes the whole distribution.
writeFileSync(
  join(licenceDir, 'INDEX.json'),
  `${JSON.stringify(
    {
      note: 'Licence texts bundled with this distribution. Generated by tools/assemble-dist.mjs.',
      components: licenceIndex,
      engineAssets: 'dist/engines/pdfjs/** carries its own LICENSE_* files (cmaps, standard_fonts, wasm).',
    },
    null,
    2,
  )}\n`,
);
console.log(`assemble-dist: ${licenceIndex.length} bundled licence text(s) copied to dist/licenses/`);

const workerPath = join(out, 'sw.js');
const worker = readFileSync(workerPath, 'utf8');
if (!worker.includes('__CACHE_VERSION__')) {
  console.error(
    'assemble-dist: sw.js has no __CACHE_VERSION__ placeholder — refusing to ship an unversioned worker',
  );
  process.exit(1);
}
writeFileSync(workerPath, worker.replaceAll('__CACHE_VERSION__', version));
console.log(`assemble-dist: offline manifest ${version} (${pinned.length} pinned asset(s))`);

const rows = [
  ['/            (landing)', join(out, 'index.html')],
  ['/en/         (landing en)', join(out, 'en/index.html')],
  ['/editor/     (editor)', join(out, 'editor/index.html')],
  ['/engines/    (pinned engines)', join(out, 'engines')],
];
console.log('assemble-dist: dist/ ready');
for (const [label, path] of rows) {
  if (!existsSync(path)) {
    console.error(`  ${label} — MISSING (${relative(root, path)})`);
    process.exit(1);
  }
  console.log(`  ${label} — ${(sizeOf(path) / 1048576).toFixed(2)} MiB`);
}
console.log(`  total — ${(sizeOf(out) / 1048576).toFixed(2)} MiB`);
