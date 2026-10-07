#!/usr/bin/env node
/**
 * `pnpm coverage`: what the unit suite and the browser suite execute, together, measured on
 * the project's own sources (`packages/*\/src`, `apps/*\/src`; tests, fixture builders and
 * declarations out).
 *
 * 1. The unit suite runs under V8 coverage (`vitest.config.ts`), every source file counted,
 *    including the ones no unit test imports.
 * 2. The editor is built unminified (`COVERAGE_BUILD=1`, see `apps/web/vite.config.ts`) and
 *    assembled, and the whole Playwright suite runs against it with `E2E_COVERAGE` set: each
 *    test's page records V8 coverage of `/editor/assets/*.js` (`e2e/test.ts`).
 * 3. The production build is restored, whatever the browser run's outcome, so `dist/` never
 *    keeps the unminified build.
 * 4. The browser coverage is mapped back to the sources through the build's source maps with
 *    `ast-v8-to-istanbul` — the converter the unit suite's provider uses — and its counts are
 *    added to the unit result's statements, functions and branches, met by where each starts
 *    (`addBrowserCounts`). An unminified bundle keeps the statements and branches the sources
 *    have, so both sides count the same things.
 *
 * Output: `coverage/report/` (HTML in `html/`, `coverage-summary.json`, `coverage-final.json`)
 * and a per-package table on the console. Web workers (Ghostscript) and the service worker
 * are outside what a page records; their code is in neither the sources counted here nor
 * the browser figures.
 *
 * `--skip-e2e` reports the unit suite alone (no build, no browser).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeProcessCovs } from '@bcoe/v8-coverage';
import convert from 'ast-v8-to-istanbul';
import MCR from 'monocart-coverage-reports';
import { parseAstAsync } from 'vitest/node';

const root = fileURLToPath(new URL('../..', import.meta.url));
const out = join(root, 'coverage');
const unitDir = join(out, 'unit');
const e2eDir = join(out, 'e2e-v8');
const reportDir = join(out, 'report');
const webAssets = join(root, 'apps/web/dist/assets');
const skipE2e = process.argv.includes('--skip-e2e');

/** Runs `pnpm <args>`: through pnpm's own entry when `pnpm coverage` started this, else the shell's. */
function run(label, args, env = {}) {
  const options = { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } };
  const pnpm = process.env.npm_execpath;
  const result = pnpm?.endsWith('.cjs')
    ? spawnSync(process.execPath, [pnpm, ...args], options)
    : spawnSync(['pnpm', ...args].join(' '), { ...options, shell: true });
  return result.status === 0 ? null : `${label} failed (exit ${result.status})`;
}

function fail(message) {
  console.error(`coverage: ${message}`);
  process.exit(1);
}

/** The sources counted, as `vitest.config.ts` lists them: no tests, fixture builders or declarations. */
function isProjectSource(path) {
  const rel = relative(root, path).split(sep).join('/');
  return (
    /^(packages|apps)\/[^/]+\/src\/.+\.tsx?$/.test(rel) &&
    !/(\.test\.tsx?|\.fixtures\.ts|-fixtures\.ts|\.d\.ts)$/.test(rel)
  );
}

/** One spelling per file on both sides, so the merge meets the same key. */
function normalised(coverageMap) {
  const result = {};
  for (const [key, file] of Object.entries(coverageMap)) {
    const path = resolve(key);
    if (isProjectSource(path)) result[path] = { ...file, path };
  }
  return result;
}

rmSync(out, { recursive: true, force: true });

const unitError = run('the unit suite', [
  'exec',
  'vitest',
  'run',
  '--coverage',
  '--coverage.reporter=json',
  `--coverage.reportsDirectory=${relative(root, unitDir)}`,
]);
if (unitError !== null) fail(unitError);
const unit = normalised(JSON.parse(readFileSync(join(unitDir, 'coverage-final.json'), 'utf8')));

let browser = [];
if (!skipE2e) {
  const buildError =
    run('the coverage build', ['build'], { COVERAGE_BUILD: '1' }) ?? run('assemble:dist', ['assemble:dist']);
  const e2eError =
    buildError ?? run('the browser suite', ['exec', 'playwright', 'test'], { E2E_COVERAGE: e2eDir });
  // The browser figures need the coverage build's files, so they are converted before the
  // production build replaces them; a conversion that throws still gets the build restored.
  let convertError = null;
  if (e2eError === null) {
    try {
      browser = await convertBrowserCoverage();
    } catch (error) {
      convertError = `the browser coverage could not be converted: ${error.message}`;
    }
  }
  const restoreError = run('the production build', ['build']) ?? run('assemble:dist', ['assemble:dist']);
  for (const error of [buildError, e2eError, convertError, restoreError]) if (error !== null) fail(error);
}

async function convertBrowserCoverage() {
  if (!existsSync(e2eDir)) throw new Error(`the browser suite wrote nothing to ${relative(root, e2eDir)}`);
  const recorded = readdirSync(e2eDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(e2eDir, name), 'utf8')));
  const { result } = mergeProcessCovs(recorded);
  // One source can sit in more than one chunk; each chunk's conversion is its own entry.
  const converted = [];
  for (const script of result) {
    const file = join(webAssets, new URL(script.url).pathname.slice('/editor/assets/'.length));
    if (!existsSync(file))
      throw new Error(`${script.url} is not in this build (${relative(root, webAssets)})`);
    // Re-export facades and the bundler's runtime carry no map: none of their code is ours.
    if (!existsSync(`${file}.map`)) continue;
    const code = readFileSync(file, 'utf8');
    const map = await convert({
      code,
      ast: parseAstAsync(code),
      sourceMap: JSON.parse(readFileSync(`${file}.map`, 'utf8')),
      coverage: { url: pathToFileURL(file).href, functions: script.functions },
    });
    const own = normalised(map);
    if (Object.keys(own).length > 0) converted.push(own);
  }
  return converted;
}

/**
 * Adds a browser conversion's counts to the unit structure of the same file. Both sides map
 * their statements back through a source map, and the two maps agree on where a statement,
 * function or branch starts but rarely on where it ends (measured: start positions meet for
 * 97 % of statements, end positions for 4 %), so items are met by their start. The unit side
 * counts every source file, so its structure is the denominator; a browser item with no unit
 * counterpart is dropped rather than counted.
 */
function addBrowserCounts(merged, browserFile, tally) {
  const start = ({ line, column }) => `${line}:${column}`;
  const sum = (entries) => {
    const counts = new Map();
    for (const [where, count] of entries) counts.set(where, (counts.get(where) ?? 0) + count);
    return counts;
  };
  const statements = sum(
    Object.entries(browserFile.statementMap).map(([id, loc]) => [start(loc.start), browserFile.s[id]]),
  );
  const functions = sum(
    Object.entries(browserFile.fnMap).map(([id, fn]) => [start(fn.loc.start), browserFile.f[id]]),
  );
  const branches = new Map(
    Object.entries(browserFile.branchMap).map(([id, branch]) => [
      `${start(branch.loc.start)} ${branch.type} ${branch.locations.length}`,
      browserFile.b[id],
    ]),
  );
  for (const [id, loc] of Object.entries(merged.statementMap))
    merged.s[id] += statements.get(start(loc.start)) ?? 0;
  for (const [id, fn] of Object.entries(merged.fnMap))
    merged.f[id] += functions.get(start(fn.loc.start)) ?? 0;
  for (const [id, branch] of Object.entries(merged.branchMap)) {
    const counts = branches.get(`${start(branch.loc.start)} ${branch.type} ${branch.locations.length}`);
    if (counts !== undefined) merged.b[id] = merged.b[id].map((count, at) => count + counts[at]);
  }
  const unitStarts = new Set(Object.values(merged.statementMap).map((loc) => start(loc.start)));
  for (const loc of Object.values(browserFile.statementMap)) {
    tally.browserStatements += 1;
    if (unitStarts.has(start(loc.start))) tally.met += 1;
  }
}

const merged = structuredClone(unit);
const tally = { met: 0, browserStatements: 0 };
for (const chunk of browser) {
  for (const [path, file] of Object.entries(chunk))
    if (merged[path] !== undefined) addBrowserCounts(merged[path], file, tally);
}

mkdirSync(reportDir, { recursive: true });
const mcr = MCR({
  name: skipE2e ? 'SsPdfEditor — unit coverage' : 'SsPdfEditor — unit + browser coverage',
  outputDir: reportDir,
  reports: [['html', { subdir: 'html' }], ['json-summary'], ['json']],
  logging: 'error',
});
await mcr.add(merged);
const results = await mcr.generate();
if (!skipE2e) {
  console.log(
    `\nBrowser statements met in the unit structure: ${tally.met} of ${tally.browserStatements} (the rest are dropped, never counted).`,
  );
}

const summary = JSON.parse(readFileSync(join(reportDir, 'coverage-summary.json'), 'utf8'));
const groups = new Map();
for (const [path, file] of Object.entries(summary)) {
  if (path === 'total') continue;
  const rel = relative(root, resolve(root, path)).split(sep).join('/');
  const group = rel.split('/').slice(0, 2).join('/');
  const totals = groups.get(group) ?? {
    lines: [0, 0],
    statements: [0, 0],
    branches: [0, 0],
    functions: [0, 0],
  };
  for (const metric of Object.keys(totals)) {
    totals[metric][0] += file[metric].covered;
    totals[metric][1] += file[metric].total;
  }
  groups.set(group, totals);
}
const percent = ([covered, total]) => (total === 0 ? '100.00' : ((100 * covered) / total).toFixed(2));
const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
console.log(`\n${results?.name ?? 'coverage'}\n`);
console.log(
  `${'package'.padEnd(26)}${['lines', 'statements', 'branches', 'functions'].map((m) => m.padStart(12)).join('')}`,
);
for (const [group, totals] of rows) {
  console.log(
    `${group.padEnd(26)}${['lines', 'statements', 'branches', 'functions'].map((m) => `${percent(totals[m])}%`.padStart(12)).join('')}`,
  );
}
const total = summary.total;
console.log(
  `${'total'.padEnd(26)}${['lines', 'statements', 'branches', 'functions'].map((m) => `${total[m].pct.toFixed(2)}%`.padStart(12)).join('')}`,
);
console.log(`\nReport: ${relative(root, join(reportDir, 'html', 'index.html'))}`);
writeFileSync(join(reportDir, 'packages.json'), `${JSON.stringify(Object.fromEntries(rows), null, 2)}\n`);
