/**
 * `require-tests.mjs` is the non-vacuity gate of `pnpm unit`: what is tested here is that it gates.
 * Each case hands it a Vitest JSON report and reads its exit code and its message.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./require-tests.mjs', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'require-tests-'));
let reports = 0;

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Runs the gate on a report: `null` leaves the file absent, a string is written as it is, anything else as JSON. */
function gate(report: unknown): { status: number | null; output: string } {
  reports += 1;
  const file = join(directory, `report-${reports}.json`);
  if (report !== null) writeFileSync(file, typeof report === 'string' ? report : JSON.stringify(report));
  const result = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('require-tests', () => {
  it('passes a run that collected files and passed tests, and says what it counted', () => {
    const result = gate({
      testResults: [{}, {}],
      numTotalTests: 5,
      numPassedTests: 4,
      numFailedTests: 0,
      numPendingTests: 1,
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain('2 test file(s), 5 test(s) — 4 passed, 0 failed, 1 skipped');
  });

  it('fails a run that discovered no test file', () => {
    const result = gate({ testResults: [], numTotalTests: 0, numPassedTests: 0 });
    expect(result.status).toBe(1);
    expect(result.output).toContain('discovered ZERO test files');
  });

  it('fails a run whose every test was skipped or empty', () => {
    const result = gate({ testResults: [{}], numTotalTests: 3, numPassedTests: 0, numPendingTests: 3 });
    expect(result.status).toBe(1);
    expect(result.output).toContain('1 test file(s) were collected but no test passed');
  });

  it('fails a report whose shape it cannot read', () => {
    const result = gate({ numTotalTests: 4, numPassedTests: 4 });
    expect(result.status).toBe(1);
    expect(result.output).toContain('the report has no `testResults` array');
  });

  it('fails a report that is not JSON', () => {
    const result = gate('{ not json');
    expect(result.status).toBe(1);
    expect(result.output).toContain('is not readable JSON');
  });

  it('fails when there is no report at all, and points at `pnpm unit`', () => {
    const result = gate(null);
    expect(result.status).toBe(1);
    expect(result.output).toContain('no Vitest report at');
    expect(result.output).toContain('run `pnpm unit`');
  });
});
