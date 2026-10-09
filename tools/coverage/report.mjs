#!/usr/bin/env node
/**
 * `pnpm coverage`: what the unit suite and the browser suite execute, together, measured on
 * the project's own sources (`packages/*\/src`, `apps/*\/src`; tests, fixture builders and
 * declarations out).
 *
 * 1. The unit suite runs under V8 coverage (`vitest.config.ts`), every source file counted,
 *    including the ones no unit test imports.
 * 2. The editor is built unminified and without the React Compiler (`COVERAGE_BUILD=1`, see
 *    `apps/web/vite.config.ts`) and assembled, and the Playwright suite runs against it with
 *    `E2E_COVERAGE` set: each page of a test records V8 coverage of `/editor/assets/*.js` and
 *    the test writes it to its own file in `coverage/e2e-v8/` when the page closes
 *    (`e2e/test.ts`), so a worker keeps nothing between tests.
 * 3. The production build is restored, whatever the browser run's outcome, so `dist/` never
 *    keeps the unminified build.
 * 4. The records are merged a batch at a time (`mergedRecords`: the merge walks the record
 *    built so far once per batch, never all the pages at once), mapped back to the sources
 *    through the build's source maps with `ast-v8-to-istanbul` — the converter the unit suite's
 *    provider uses — and their counts are added to the unit result's statements, functions and
 *    branches, met by where each starts or, failing that, by the lines each covers (`meet`,
 *    `addBrowserCounts`). An unminified, compiler-free bundle keeps the statements and branches
 *    the sources have (the compiler's memo-cache branches would map onto component lines the
 *    unit side does not count), so both sides count the same things.
 *
 * With no mode flag all of this runs in one process, on one machine. The hosted workflows
 * split it over jobs, each of which holds a part of the run and none the whole of it:
 *
 * - `--unit-only` runs step 1 and stops, leaving `coverage/unit/coverage-final.json`.
 * - `--e2e-shard=N/M` runs steps 2 and 3 for shard N of M: the chromium project's
 *    `playwright test --shard=N/M`, and, in shard M, the service-worker tests, which run alone
 *    and after the rest. It leaves the records in `coverage/e2e-v8/` and fails when Playwright does.
 * - `--merge=<dir>[,<dir>...]` runs step 4 and the report. The directories (searched at any
 *    depth) hold the unit suite's `coverage-final.json` and the shards' records. It builds the
 *    editor again with `COVERAGE_BUILD=1`, which is deterministic, so the records meet the
 *    same scripts as in the shards (a script the build does not have stops the run), converts
 *    with that build's maps and restores the production build.
 *
 * Output: `coverage/report/` (HTML in `html/`, `coverage-summary.json`, `coverage-final.json`)
 * and a per-package table on the console. Web workers (Ghostscript) and the service worker
 * are outside what a page records; their code is in neither the sources counted here nor
 * the browser figures.
 *
 * `--skip-e2e` reports the unit suite alone (no build, no browser).
 *
 * `--min=<percent>` is a floor on each of the four totals (lines, statements, branches,
 * functions): once the report and the table are printed, the run exits 1 naming every total
 * that is lower and the files that miss it (the CI and nightly workflows pass `--min=100` to
 * `--merge`). The value is checked before anything runs, so a typo costs no build. The modes
 * are exclusive, and `--min` belongs to the ones that print a report.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
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
const unitOnly = process.argv.includes('--unit-only');
const shardArg = process.argv.find((arg) => arg.startsWith('--e2e-shard'));
const mergeArg = process.argv.find((arg) => arg.startsWith('--merge'));
/** How many records `mergedRecords` holds at once, besides the merge so far. */
const BATCH = 16;

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

const METRICS = ['lines', 'statements', 'branches', 'functions'];
const minArg = process.argv.find((arg) => arg.startsWith('--min'));
let floor = null;
if (minArg !== undefined) {
  const value = minArg.startsWith('--min=') ? minArg.slice('--min='.length) : '';
  floor = value.trim() === '' ? Number.NaN : Number(value);
  if (!Number.isFinite(floor) || floor < 0 || floor > 100) {
    fail(`--min expects a percentage from 0 to 100, as --min=<percent> (got "${minArg}")`);
  }
}

const modes = [
  skipE2e && '--skip-e2e',
  unitOnly && '--unit-only',
  shardArg !== undefined && '--e2e-shard',
  mergeArg !== undefined && '--merge',
].filter(Boolean);
if (modes.length > 1) fail(`${modes.join(' and ')} are separate modes: pick one`);

let shard = null;
if (shardArg !== undefined) {
  const match = /^--e2e-shard=(\d+)\/(\d+)$/.exec(shardArg);
  shard = match === null ? null : { index: Number(match[1]), count: Number(match[2]) };
  if (shard === null || shard.index < 1 || shard.index > shard.count) {
    fail(`--e2e-shard expects N/M with 1 <= N <= M, as --e2e-shard=<N>/<M> (got "${shardArg}")`);
  }
}

let mergeDirs = null;
if (mergeArg !== undefined) {
  mergeDirs = (mergeArg.startsWith('--merge=') ? mergeArg.slice('--merge='.length) : '')
    .split(',')
    .map((dir) => dir.trim())
    .filter((dir) => dir !== '')
    .map((dir) => resolve(dir));
  if (mergeDirs.length === 0) {
    fail(`--merge expects directories, as --merge=<dir>[,<dir>...] (got "${mergeArg}")`);
  }
}

if (floor !== null && (unitOnly || shard !== null)) {
  fail('--min applies to a report, and --unit-only and --e2e-shard print none');
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

/** Runs the unit suite under V8 coverage into `coverage/unit`; the error, or null. */
function runUnitSuite() {
  return run('the unit suite', [
    'exec',
    'vitest',
    'run',
    '--coverage',
    '--coverage.reporter=json',
    `--coverage.reportsDirectory=${relative(root, unitDir)}`,
  ]);
}

/** Runs `playwright test <args>` with the pages' coverage recorded into `coverage/e2e-v8`; the error, or null. */
function runBrowserSuite(args) {
  return run('the browser suite', ['exec', 'playwright', 'test', ...args], { E2E_COVERAGE: e2eDir });
}

/**
 * Builds the editor for coverage (unminified, without the React Compiler), assembled when
 * `assemble` is set because the browser suite runs against `dist/`, calls `during` (which returns
 * an error message, or null) and restores the production build whatever `during` did, so no
 * build directory keeps the unminified one. Returns the first error, or null.
 */
async function withCoverageBuild(assemble, during) {
  const assembled = () => (assemble ? run('assemble:dist', ['assemble:dist']) : null);
  const buildError = run('the coverage build', ['build'], { COVERAGE_BUILD: '1' }) ?? assembled();
  const duringError = buildError ?? (await during());
  const restoreError = run('the production build', ['build']) ?? assembled();
  return duringError ?? restoreError;
}

/** The files under `dirs`, at any depth, whose name `accepts`; a directory that is not there holds none. */
function filesUnder(dirs, accepts) {
  const files = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (accepts(entry.name)) files.push(path);
    }
  };
  for (const dir of dirs) visit(dir);
  return files.sort();
}

/**
 * The merge of the browser records in `files` (`e2e-<id>.json.gz`, one page each, a V8
 * process coverage). They are read `BATCH` at a time and merged with the merge so far, so
 * memory holds that many records and the merge, never every page's.
 */
function mergedRecords(files) {
  let merged = { result: [] };
  let batch = [merged];
  for (const file of files) {
    try {
      batch.push(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')));
    } catch (error) {
      throw new Error(`${relative(root, file)} is not a readable record (${error.message})`);
    }
    if (batch.length > BATCH) {
      merged = mergeProcessCovs(batch);
      batch = [merged];
    }
  }
  return batch.length > 1 ? mergeProcessCovs(batch) : merged;
}

/**
 * The browser records under `dirs` converted against the build in `apps/web/dist`, which
 * must be the coverage build they were recorded on. Returns the conversions, or the error.
 */
async function convertRecords(dirs) {
  try {
    return { browser: await convertBrowserCoverage(dirs), error: null };
  } catch (error) {
    return { browser: [], error: `the browser coverage could not be converted: ${error.message}` };
  }
}

async function convertBrowserCoverage(dirs) {
  const files = filesUnder(dirs, (name) => /^e2e-.+\.json\.gz$/.test(name));
  if (files.length === 0) {
    throw new Error(`no browser records in ${dirs.map((dir) => relative(root, dir) || '.').join(', ')}`);
  }
  const { result } = mergedRecords(files);
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
 * Meets each unit item with the browser items of one conversion and calls `add(unitId,
 * browserId)` for every pair; returns the browser ids that met one. Items are met by where they
 * start: both sides map back through a source map, and the two maps agree on starts far more
 * often than on ends. Where they do not (measured: a declaration starts at its initialiser on
 * the unit side and at its name on the browser side, `const x = lazy(…)` at `lazy` against
 * `x`), a unit item no browser item starts at is met by the browser item over the same lines,
 * but only when that item is the only one over those lines on each side, so no count can land
 * on a neighbour.
 */
function meet(unit, browser, add) {
  const group = (items, key) => {
    const groups = new Map();
    for (const item of items) {
      const ids = groups.get(item[key]);
      if (ids === undefined) groups.set(item[key], [item.id]);
      else ids.push(item.id);
    }
    return groups;
  };
  const browserStarts = group(browser, 'at');
  const browserLines = group(browser, 'lines');
  const unitLines = group(unit, 'lines');
  const used = new Set();
  for (const item of unit) {
    const sameLines = browserLines.get(item.lines) ?? [];
    const matches =
      browserStarts.get(item.at) ??
      (unitLines.get(item.lines)?.length === 1 && sameLines.length === 1 ? sameLines : []);
    for (const id of matches) {
      add(item.id, id);
      used.add(id);
    }
  }
  return used;
}

/**
 * Adds a browser conversion's counts to the unit structure of the same file, statement,
 * function and branch, met as `meet` describes. The unit side counts every source file, so its
 * structure is the denominator; a browser item with no unit counterpart is dropped rather than
 * counted.
 */
function addBrowserCounts(merged, browserFile, tally) {
  const start = ({ line, column }) => `${line}:${column}`;
  const lines = (loc) => `${loc.start.line}-${loc.end.line}`;
  const items = (map, describe) => Object.entries(map).map(([id, entry]) => ({ id, ...describe(entry) }));
  const statement = (loc) => ({ at: start(loc.start), lines: lines(loc) });
  const fn = (entry) => ({ at: start(entry.loc.start), lines: lines(entry.loc) });
  const branch = (entry) => {
    const shape = `${entry.type} ${entry.locations.length}`;
    return { at: `${start(entry.loc.start)} ${shape}`, lines: `${lines(entry.loc)} ${shape}` };
  };
  const met = meet(
    items(merged.statementMap, statement),
    items(browserFile.statementMap, statement),
    (unitId, browserId) => {
      merged.s[unitId] += browserFile.s[browserId];
    },
  );
  meet(items(merged.fnMap, fn), items(browserFile.fnMap, fn), (unitId, browserId) => {
    merged.f[unitId] += browserFile.f[browserId];
  });
  meet(items(merged.branchMap, branch), items(browserFile.branchMap, branch), (unitId, browserId) => {
    merged.b[unitId] = merged.b[unitId].map((count, at) => count + browserFile.b[browserId][at]);
  });
  tally.browserStatements += Object.keys(browserFile.statementMap).length;
  tally.met += met.size;
}

/** Adds the browser conversions to the unit coverage, writes the report and the table, applies the floor. */
async function report(unit, browser) {
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

  if (floor !== null) {
    // Compared on the counts, so 99.999 % never rounds up to a 100 % floor.
    const below = (metric) => 100 * metric.covered < floor * metric.total;
    const short = METRICS.filter((metric) => below(total[metric]));
    if (short.length > 0) {
      for (const [path, file] of Object.entries(summary)) {
        if (path === 'total') continue;
        const missed = METRICS.filter((metric) => below(file[metric])).map(
          (metric) => `${metric} ${file[metric].covered}/${file[metric].total}`,
        );
        if (missed.length > 0) console.error(`  ${relative(root, path)}: ${missed.join(', ')}`);
      }
      fail(
        short.map((metric) => `total ${metric} ${total[metric].pct.toFixed(2)}%`).join(', ') +
          ` below the floor ${floor}%`,
      );
    }
  }
}

function readUnit(file) {
  return normalised(JSON.parse(readFileSync(file, 'utf8')));
}

if (unitOnly) {
  rmSync(unitDir, { recursive: true, force: true });
  const unitError = runUnitSuite();
  if (unitError !== null) fail(unitError);
} else if (shard !== null) {
  rmSync(e2eDir, { recursive: true, force: true });
  // The service-worker tests run alone and after the chromium project (`playwright.config.ts`);
  // the last shard takes them, since a sharded run does not order one project after another.
  const shardError = await withCoverageBuild(
    true,
    () =>
      runBrowserSuite(['--project=chromium', `--shard=${shard.index}/${shard.count}`]) ??
      (shard.index === shard.count ? runBrowserSuite(['--project=service-worker', '--no-deps']) : null),
  );
  if (shardError !== null) fail(shardError);
} else if (mergeDirs !== null) {
  const unitFiles = filesUnder(mergeDirs, (name) => name === 'coverage-final.json');
  if (unitFiles.length !== 1) {
    fail(
      `--merge expects one coverage-final.json, the unit suite's, under ${mergeDirs.join(', ')} (found ${unitFiles.length})`,
    );
  }
  let browser = [];
  const mergeError = await withCoverageBuild(false, async () => {
    const converted = await convertRecords(mergeDirs);
    browser = converted.browser;
    return converted.error;
  });
  if (mergeError !== null) fail(mergeError);
  rmSync(reportDir, { recursive: true, force: true });
  await report(readUnit(unitFiles[0]), browser);
} else {
  rmSync(out, { recursive: true, force: true });
  const unitError = runUnitSuite();
  if (unitError !== null) fail(unitError);
  const unit = readUnit(join(unitDir, 'coverage-final.json'));
  let browser = [];
  if (!skipE2e) {
    const browserError = await withCoverageBuild(true, async () => {
      const suiteError = runBrowserSuite([]);
      if (suiteError !== null) return suiteError;
      const converted = await convertRecords([e2eDir]);
      browser = converted.browser;
      return converted.error;
    });
    if (browserError !== null) fail(browserError);
  }
  await report(unit, browser);
}
