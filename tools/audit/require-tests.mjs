#!/usr/bin/env node
/**
 * The non-vacuity gate for the unit suite.
 *
 * `vitest run --passWithNoTests` is what the repository wants for a checkout that has no
 * tests yet — but as a CI gate it has one failure mode that looks exactly like success:
 * a glob that matches nothing (a renamed directory, a config typo, a `test.include`
 * change) exits 0 with an empty run, so the "unit" step proves nothing and says nothing.
 *
 * This guard reads the JSON report the `unit` script already produces and fails when the
 * run discovered **zero test files**. It does not weaken or replace Vitest: the exit code
 * of `vitest run` is still the gate for test failures, and `--passWithNoTests` stays in
 * place for local work. It only refuses to let an empty run pass for coverage.
 *
 * Usage: node tools/audit/require-tests.mjs [report.json]
 *        (default: node_modules/.vitest-report.json, as written by `pnpm unit`)
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const reportPath = resolve(root, process.argv[2] ?? 'node_modules/.vitest-report.json');

if (!existsSync(reportPath)) {
  console.error(`require-tests: no Vitest report at ${reportPath}`);
  console.error(
    'require-tests: run `pnpm unit` (the report is written by the unit script), not this file alone.',
  );
  process.exit(1);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  console.error(`require-tests: ${reportPath} is not readable JSON — ${error.message}`);
  process.exit(1);
}

const files = Array.isArray(report.testResults) ? report.testResults.length : null;
if (files === null) {
  console.error('require-tests: the report has no `testResults` array; the reporter changed shape.');
  console.error('require-tests: refusing to certify a run whose size cannot be read.');
  process.exit(1);
}

const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const tests = count(report.numTotalTests);
const passed = count(report.numPassedTests);
const failed = count(report.numFailedTests);
const pending = count(report.numPendingTests);

console.log(
  `require-tests: ${files} test file(s), ${tests} test(s) — ${passed} passed, ${failed} failed, ${pending} skipped`,
);

if (files > 0 && passed === 0) {
  console.error(
    `require-tests: ${files} test file(s) were collected but no test passed (${tests} test(s), ${pending} skipped).`,
  );
  console.error('require-tests: a run whose every test is empty or skipped is not a passing gate.');
  process.exit(1);
}

if (files === 0) {
  console.error('require-tests: the suite discovered ZERO test files — an empty run is not a passing gate.');
  console.error('require-tests: check the Vitest `include` globs before trusting this step.');
  process.exit(1);
}
