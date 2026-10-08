#!/usr/bin/env node
/**
 * Proves that each fix commit in tools/review/revert-proof.json is guarded by its own test:
 * the test fails (on an assertion) on the fix commit's parent and passes on the fix commit.
 *
 *   node tools/review/revert-proof.mjs [--shard i/n] [--only <sha-prefix>]
 *
 * For every selected entry:
 *   BEFORE  check out `<commit>^`, bring the entry's test and helper files in from the fix commit
 *           (or from `testCommit` when the test landed later), run only the proving tests and
 *           require a non-zero exit. The failure is classified from the output: an expect/assert
 *           failure is `failed-assertion`; a module that does not load, a missing export, a syntax
 *           or type error or "no tests found" is `failed-load`, which proves nothing about behaviour.
 *           A fix whose defect was a throw or a hang rather than a wrong value names that failure in
 *           the entry's `failure` (a regular expression over the output, written down for review):
 *           a run that matches it, and no load pattern, is `failed-declared`. Any other failure is
 *           `failed-load`.
 *   AFTER   check out `<commit>` (or `testCommit`), run the same tests and require exit 0 with at
 *           least one test run.
 * An entry is `proved` only for failed-assertion or failed-declared, then passed. `load-only` and `not-proved` are reported
 * and make the exit code 1, they are never counted as proved.
 *
 * Needs a clean work tree: it checks commits out with `-f`. The original HEAD is restored on exit,
 * on errors and on Ctrl-C. Writes revert-proof-report.json to the repository root.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPORT_FILE = 'revert-proof-report.json';
const MANIFEST_FILE = 'tools/review/revert-proof.json';

const ANSI_COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Output of a finished command: exit code plus stdout and stderr, colours stripped. */
function run(command, cwd) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(ANSI_COLOUR, '');
  const status = result.status ?? (result.error === undefined ? 1 : 127);
  return { status, output: result.error === undefined ? output : `${output}\n${String(result.error)}` };
}

function quote(text) {
  if (/["\r\n]/.test(text)) throw new Error(`cannot quote ${JSON.stringify(text)}`);
  return `"${text}"`;
}

function parseArguments(argv) {
  const options = { shard: null, only: null };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--shard') {
      const match = /^(\d+)\/(\d+)$/.exec(argv[++index] ?? '');
      if (match === null) return null;
      const shard = { index: Number(match[1]), count: Number(match[2]) };
      if (shard.index < 1 || shard.index > shard.count) return null;
      options.shard = shard;
    } else if (argument === '--only') {
      const prefix = argv[++index];
      if (prefix === undefined || prefix === '') return null;
      options.only = prefix;
    } else {
      return null;
    }
  }
  return options;
}

/** Hard evidence the tests never got to run their assertions. */
const LOAD_FAILURE = new RegExp(
  [
    'Failed to (?:load|resolve) (?:url|import)',
    'Cannot find (?:module|package)',
    'ERR_MODULE_NOT_FOUND',
    'does not provide an export named',
    'No test files found',
    'No tests found',
    'Transform failed',
    'error TS\\d+',
    '^\\s*(?:Error: )?(?:Syntax|Parse)Error',
  ].join('|'),
  'm',
);
/** An expect/assert failure, from Vitest and from Playwright. */
const ASSERTION_FAILURE = /AssertionError|Error: expect\(|waiting for expect\(/;

/**
 * @param {string} output of a run that exited non-zero
 * @param {string | undefined} declared the entry's `failure` pattern, if it names one
 * @returns {'failed-assertion' | 'failed-declared' | 'failed-load'}
 */
function classifyFailure(output, declared) {
  if (LOAD_FAILURE.test(output)) return 'failed-load';
  if (ASSERTION_FAILURE.test(output)) return 'failed-assertion';
  if (declared !== undefined && new RegExp(declared).test(output)) return 'failed-declared';
  return 'failed-load';
}

/** True when the run reports at least one passed test (an all-skipped run also exits 0). */
function ranTests(output, kind) {
  const match = (kind === 'e2e' ? /^\s*(\d+) passed/m : /Tests\s+(?:\d+ failed \| )?(\d+) passed/).exec(
    output,
  );
  return match !== null && Number(match[1]) > 0;
}

function lastLines(text, count) {
  return text.trimEnd().split('\n').slice(-count).join('\n');
}

function isTestFile(path) {
  return /\.(?:test|spec)\.tsx?$/.test(path);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) {
    console.error('usage: node tools/review/revert-proof.mjs [--shard i/n] [--only <sha-prefix>]');
    return 2;
  }

  const top = run('git rev-parse --show-toplevel');
  if (top.status !== 0) {
    console.error('revert-proof: not inside a git work tree');
    return 1;
  }
  const root = top.output.trim();

  const dirty = run('git status --porcelain', root)
    .output.split('\n')
    .filter((line) => line.trim() !== '' && !line.trimEnd().endsWith(REPORT_FILE));
  if (dirty.length > 0) {
    console.error('revert-proof: the work tree is not clean; commit, stash or remove:');
    for (const line of dirty) console.error(`  ${line}`);
    return 1;
  }

  // Read the manifest now: the checkouts below replace the work tree.
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_FILE), 'utf8'));
  const selected = manifest
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => options.shard === null || index % options.shard.count === options.shard.index - 1)
    .filter(({ entry }) => options.only === null || entry.commit.startsWith(options.only))
    .map(({ entry }) => entry);
  if (selected.length === 0) {
    console.log('revert-proof: no entry selected');
    return 0;
  }

  const branch = run('git symbolic-ref -q --short HEAD', root).output.trim();
  const original = branch !== '' ? branch : run('git rev-parse HEAD', root).output.trim();
  const lockHash = () =>
    createHash('sha256')
      .update(readFileSync(join(root, 'pnpm-lock.yaml')))
      .digest('hex');
  let installedLock = lockHash();

  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  // Signal handlers run only when the event loop turns, and every step here blocks.
  const turn = () => new Promise((resolve) => setImmediate(resolve));

  /** Check out `ref` forcibly; reinstall when its lockfile is not the one installed. */
  function enter(ref, testSource, tests) {
    const checkout = run(`git checkout -f ${quote(ref)}`, root);
    if (checkout.status !== 0) return { ok: false, output: checkout.output };
    if (testSource !== null && tests.length > 0) {
      const files = run(`git checkout ${quote(testSource)} -- ${tests.map(quote).join(' ')}`, root);
      if (files.status !== 0) return { ok: false, output: files.output };
    }
    if (lockHash() !== installedLock) {
      const install = run('pnpm install --frozen-lockfile --prefer-offline', root);
      if (install.status !== 0) return { ok: false, output: install.output };
      installedLock = lockHash();
    }
    return { ok: true, output: '' };
  }

  function build() {
    for (const command of ['pnpm fetch:engines --sync', 'pnpm build', 'pnpm assemble:dist']) {
      const step = run(command, root);
      if (step.status !== 0) return { ok: false, output: `${command} failed\n${step.output}` };
    }
    return { ok: true, output: '' };
  }

  function testCommand(entry) {
    const files = (entry.run ?? entry.tests.filter(isTestFile)).map(quote).join(' ');
    return entry.kind === 'e2e'
      ? `pnpm exec playwright test ${files} --project=chromium -g ${quote(entry.filter)} --retries=0 --reporter=list`
      : `pnpm exec vitest run ${files} -t ${quote(entry.filter)}`;
  }

  /** Run the entry's tests at the current checkout. */
  function runTests(entry) {
    if (entry.kind === 'e2e') {
      const built = build();
      if (!built.ok) return { status: 1, output: built.output, built: false };
    }
    return { ...run(testCommand(entry), root), built: true };
  }

  const results = [];
  try {
    for (const entry of selected) {
      if (interrupted) break;
      const label = entry.commit.slice(0, 7);
      console.log(`\n== ${label} ${entry.title} [${entry.kind}]`);
      const result = {
        commit: entry.commit,
        title: entry.title,
        before: null,
        after: null,
        verdict: 'not-proved',
      };
      if (entry.kind !== 'unit' && entry.kind !== 'e2e') {
        result.note = entry.note ?? 'no automated proof exists for this fix';
        results.push(result);
        console.log(`   no automated proof: ${result.note}`);
        continue;
      }
      const testSource = entry.testCommit ?? entry.commit;

      await turn();
      // BEFORE: the parent of the fix with the fix's tests brought in.
      const parent = enter(`${entry.commit}^`, testSource, entry.tests);
      if (!parent.ok) {
        result.before = 'failed-load';
        result.note = `before: setup failed: ${lastLines(parent.output, 5)}`;
      } else {
        const before = runTests(entry);
        if (before.status === 0) {
          result.before = 'passed';
        } else if (!before.built) {
          result.before = 'failed-load';
          result.note = `before: build failed: ${lastLines(before.output, 5)}`;
        } else {
          result.before = classifyFailure(before.output, entry.failure);
        }
        console.log(`   before: ${result.before}`);
        if (result.before !== 'failed-assertion') result.beforeOutput = lastLines(before.output, 40);
      }

      if (interrupted) break;
      await turn();
      // AFTER: the fix itself (or the commit that carries the test).
      const fixed = enter(testSource, null, []);
      if (!fixed.ok) {
        result.after = 'failed';
        result.note = `${result.note === undefined ? '' : `${result.note}; `}after: setup failed: ${lastLines(fixed.output, 5)}`;
      } else {
        const after = runTests(entry);
        if (after.status === 0 && ranTests(after.output, entry.kind)) {
          result.after = 'passed';
        } else {
          result.after = 'failed';
          result.afterOutput = lastLines(after.output, 40);
          if (after.status === 0)
            result.note = `${result.note === undefined ? '' : `${result.note}; `}after: the filter matched no test`;
        }
      }
      console.log(`   after: ${result.after}`);

      if (
        (result.before === 'failed-assertion' || result.before === 'failed-declared') &&
        result.after === 'passed'
      )
        result.verdict = 'proved';
      else if (result.before === 'failed-load' && result.after === 'passed') result.verdict = 'load-only';
      results.push(result);
      console.log(`   verdict: ${result.verdict}`);
    }
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    const restored = run(`git checkout -f ${quote(original)}`, root);
    if (restored.status !== 0) {
      console.error(`revert-proof: could not restore ${original}:\n${restored.output}`);
    } else if (lockHash() !== installedLock) {
      run('pnpm install --frozen-lockfile --prefer-offline', root);
    }
  }

  writeFileSync(join(root, REPORT_FILE), `${JSON.stringify(results, null, 2)}\n`);

  console.log('\ncommit   before            after   verdict      title');
  for (const result of results) {
    console.log(
      `${result.commit.slice(0, 7)}  ${String(result.before).padEnd(16)}  ${String(result.after).padEnd(6)}  ${result.verdict.padEnd(11)}  ${result.title.slice(0, 70)}`,
    );
  }
  const notProved = results.filter((result) => result.verdict !== 'proved');
  const missed = selected.length - results.length;
  console.log(`\n${results.length - notProved.length} of ${selected.length} proved; report: ${REPORT_FILE}`);
  if (notProved.length > 0) {
    console.error('\nNot proved:');
    for (const result of notProved)
      console.error(`  ${result.commit.slice(0, 7)} ${result.verdict}: ${result.title}`);
  }
  if (interrupted) console.error('revert-proof: interrupted');
  return notProved.length > 0 || missed > 0 || interrupted ? 1 : 0;
}

process.exitCode = await main();
