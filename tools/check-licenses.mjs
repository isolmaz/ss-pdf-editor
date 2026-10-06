#!/usr/bin/env node
/**
 * Dependency licence audit (a new dependency requires a free-licence
 * check; paid components are not allowed).
 *
 *   node tools/check-licenses.mjs
 *
 * Reads `pnpm licenses list --json` from the repository root and falls back to walking the
 * `node_modules/.pnpm/<store>/node_modules/<pkg>/package.json` files when it is unavailable.
 *
 *   allowed      free licences we accept (SPDX ids, including dual-licence expressions)
 *   copyleft     AGPL/GPL/LGPL/MPL — allowed, but printed separately because they carry
 *                obligations that the bundled licence texts in dist/licenses/ must carry
 *
 *   warn         CC-BY-4.0 — acceptable for assets only, never for code
 *   anything else (unknown, missing, paid/commercial) fails the run with the offending packages.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_DIR = join(ROOT, 'node_modules', '.pnpm');

const ALLOWED = [
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'OFL-1.1',
  'MPL-2.0',
  'Python-2.0',
  'BlueOak-1.0.0',
  'Zlib',
  'AGPL-3.0-or-later',
  'LGPL-3.0-or-later',
  '(MIT OR Apache-2.0)',
  '(BSD-2-Clause OR MIT)',
  '(Apache-2.0 OR MPL-2.0)',
  '(MIT AND Zlib)',
  // `@expo-google-fonts/*`: MIT for the loader code, OFL-1.1 for the font binary it ships — the
  // same code+asset conjunction as `(MIT AND Zlib)`, and both halves are already allowed above.
  '(MIT AND OFL-1.1)',
  // `jszip` (through mammoth, the DOCX reader): dual-licensed, and the MIT option is the one
  // this product takes.
  '(MIT OR GPL-3.0-or-later)',
];

/**
 * Packages whose `license` field is not an SPDX id but whose LICENSE file was read and is a
 * licence on the list above. Keyed by exact version: a new version is checked again.
 */
const VERIFIED = {
  // `"license": "BSD"`; its LICENSE file is the BSD-2-Clause text verbatim (lop → mammoth).
  'duck@0.1.12': 'BSD-2-Clause',
};

/** Assets only (OFL fonts, CC image/word corpora) — warned about, never fatal alone. */
const ASSET_ONLY = ['CC-BY-4.0'];

const COPYLEFT = /\b(?:A?GPL|LGPL|MPL)\b/;

/** SPDX matching is case-insensitive and the parentheses are noise: `(MIT OR Apache-2.0)` == `MIT OR Apache-2.0`. */
const normalize = (expression) =>
  String(expression).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();

const ALLOWED_SET = new Set(ALLOWED.map(normalize));
const ASSET_ONLY_SET = new Set(ASSET_ONLY.map(normalize));

function groupPnpm(payload) {
  const groups = new Map();
  for (const [licence, packages] of Object.entries(payload)) {
    const list = groups.get(licence) ?? [];
    for (const entry of packages) {
      const versions = Array.isArray(entry.versions) && entry.versions.length > 0 ? entry.versions : ['?'];
      for (const version of versions) list.push(`${entry.name}@${version}`);
    }
    groups.set(licence, list);
  }
  return groups;
}

function readPnpmLicenses() {
  const raw = execFileSync('pnpm licenses list --json', {
    cwd: ROOT,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { source: 'pnpm licenses list --json', groups: groupPnpm(JSON.parse(raw)) };
}

function readStoreLicenses() {
  if (!existsSync(STORE_DIR)) throw new Error(`${STORE_DIR} does not exist — run \`pnpm install\` first`);
  const groups = new Map();
  for (const dir of readdirSync(STORE_DIR)) {
    const modules = join(STORE_DIR, dir, 'node_modules');
    if (!existsSync(modules)) continue;
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const names = entry.name.startsWith('@')
        ? readdirSync(join(modules, entry.name), { withFileTypes: true }).map(
            (child) => `${entry.name}/${child.name}`,
          )
        : [entry.name];
      for (const name of names) {
        const metaPath = join(modules, ...name.split('/'), 'package.json');
        if (!existsSync(metaPath)) continue;
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
        const licence = typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? 'UNKNOWN');
        const list = groups.get(licence) ?? [];
        list.push(`${meta.name ?? name}@${meta.version ?? '?'}`);
        groups.set(licence, list);
      }
    }
  }
  return { source: 'node_modules/.pnpm walk (pnpm command unavailable)', groups };
}

/** Move every package {@link VERIFIED} names into the group of the licence its file states. */
function applyVerified(groups) {
  for (const [pkg, licence] of Object.entries(VERIFIED)) {
    for (const [declared, packages] of groups) {
      const index = packages.indexOf(pkg);
      if (index < 0 || declared === licence) continue;
      packages.splice(index, 1);
      if (packages.length === 0) groups.delete(declared);
      groups.set(licence, [...(groups.get(licence) ?? []), pkg]);
    }
  }
  return groups;
}

function classify(groups) {
  applyVerified(groups);
  const counts = [];
  const copyleft = [];
  const warnings = [];
  const violations = [];
  for (const [licence, packages] of groups) {
    const unique = [...new Set(packages)].sort();
    counts.push({ licence, count: unique.length });
    const key = normalize(licence);
    if (ASSET_ONLY_SET.has(key)) warnings.push({ licence, packages: unique });
    else if (!ALLOWED_SET.has(key)) violations.push({ licence, packages: unique });
    else if (COPYLEFT.test(key)) copyleft.push({ licence, packages: unique });
  }
  counts.sort((a, b) => b.count - a.count || a.licence.localeCompare(b.licence));
  copyleft.sort((a, b) => a.licence.localeCompare(b.licence));
  violations.sort((a, b) => a.licence.localeCompare(b.licence));
  return { counts, copyleft, warnings, violations };
}

const { source, groups } = (() => {
  try {
    return readPnpmLicenses();
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`pnpm licenses list unavailable (${reason}) — falling back to the pnpm store walk.`);
    return readStoreLicenses();
  }
})();

const { counts, copyleft, warnings, violations } = classify(groups);
const total = counts.reduce((sum, entry) => sum + entry.count, 0);

console.log(`\nDependency licence audit — source: ${source} — ${total} package(s) (name@version)\n`);
const width = Math.max(...counts.map((entry) => entry.licence.length), 'licence'.length);
console.log(`${'licence'.padEnd(width)}  packages`);
console.log(`${'-'.repeat(width)}  --------`);
for (const entry of counts) console.log(`${entry.licence.padEnd(width)}  ${String(entry.count).padStart(8)}`);
console.log(`${'total'.padEnd(width)}  ${String(total).padStart(8)}`);

console.log(
  '\ncopyleft — obligations carried by the bundled licence texts in dist/licenses/ (AGPL §6/§13 corresponding source, MPL file-level):',
);
if (copyleft.length === 0) console.log('  none');
for (const entry of copyleft) {
  console.log(`  ${entry.licence} (${entry.packages.length})`);
  for (const name of entry.packages) console.log(`      ${name}`);
}

console.log('\nwarnings:');
if (warnings.length === 0) console.log('  none');
for (const entry of warnings) {
  console.log(
    `  ${entry.licence} — assets only, never code (${entry.packages.length}): ${entry.packages.join(', ')}`,
  );
}

if (violations.length === 0) {
  console.log(`\nVERDICT: PASS — ${total} package(s), every licence free and recognised (0 violations).\n`);
} else {
  const bad = violations.reduce((sum, entry) => sum + entry.packages.length, 0);
  console.error(`\nVERDICT: FAIL — ${bad} package(s) with a licence that is neither free nor recognised:\n`);
  for (const entry of violations) console.error(`  ${entry.licence}: ${entry.packages.join(', ')}`);
  console.error('\nRemove the dependency or replace it with a free alternative. See CONTRIBUTING.md.\n');
  process.exitCode = 1;
}
