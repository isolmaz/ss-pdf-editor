/**
 * `regressions.cjs` is a gate that audits the feature modules, so two things are tested on a
 * copy of the tree (`--root`): it does not read the shell (`apps/web/src/App.tsx` is replaced by
 * an empty module and every check still runs and passes), and it does gate (a defect seeded in
 * `tools/preview-dist.mjs` makes exactly the check about it fail, and the run exit 1).
 */

import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = join(root, 'tools/audit/regressions.cjs');
const PREVIEW_CHECK = 'preview rejects malformed URL encoding without throwing';

let checkout = '';

beforeAll(() => {
  checkout = mkdtempSync(join(tmpdir(), 'regressions-checkout-'));
  const sources = (path: string) => !/[\\/]node_modules(?:[\\/]|$)/.test(path);
  cpSync(join(root, 'packages'), join(checkout, 'packages'), { recursive: true, filter: sources });
  cpSync(join(root, 'apps/web/src'), join(checkout, 'apps/web/src'), { recursive: true, filter: sources });
  mkdirSync(join(checkout, 'public'), { recursive: true });
  cpSync(join(root, 'public/sw.js'), join(checkout, 'public/sw.js'));
  cpSync(join(root, 'public/_headers'), join(checkout, 'public/_headers'));
  mkdirSync(join(checkout, 'tools/vite'), { recursive: true });
  // What the release-version, asset-pin and hosting-header checks load from the tree under audit.
  for (const file of ['release-version.mjs', 'fetch-engines.mjs', 'vite/hosting.mjs']) {
    cpSync(join(root, 'tools', file), join(checkout, 'tools', file));
  }
  cpSync(join(root, 'README.md'), join(checkout, 'README.md'));
}, 120_000);

afterAll(() => {
  rmSync(checkout, { recursive: true, force: true });
});

function audit(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; output: string }> {
  const { promise, resolve } = Promise.withResolvers<{ status: number | null; output: string }>();
  execFile(process.execPath, [script, ...args], { env, maxBuffer: 1 << 28 }, (error, stdout, stderr) => {
    const status = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
    resolve({ status, output: `${stdout}${stderr}` });
  });
  return promise;
}

describe('regressions.cjs', () => {
  it('runs every check without the shell, and fails exactly the check a seeded defect breaks', async () => {
    // No shell source at all: nothing the audit does may depend on it.
    writeFileSync(join(checkout, 'apps/web/src/App.tsx'), 'export {};\n');
    const preview = readFileSync(join(root, 'tools/preview-dist.mjs'), 'utf8');
    const seeded = preview.replace(
      /(decoded = decodeURIComponent\(pathname\);\s*\} catch \{[^}]*?)return null;/,
      "$1throw new Error('seeded defect');",
    );
    expect(seeded).not.toBe(preview);
    writeFileSync(join(checkout, 'tools/preview-dist.mjs'), seeded);

    const resultsFile = join(checkout, 'results.json');
    const run = await audit(['--root', checkout], { ...process.env, AUDIT_RESULTS: resultsFile });

    expect(run.status).toBe(1);
    expect(run.output).toContain(`FAIL ${PREVIEW_CHECK}`);
    const report = JSON.parse(readFileSync(resultsFile, 'utf8')) as {
      root: string;
      results: { name: string; ok: boolean }[];
    };
    expect(report.root).toBe(resolve(checkout));
    expect(report.results.filter((result) => !result.ok).map((result) => result.name)).toEqual([
      PREVIEW_CHECK,
    ]);
    const passed = new Set(report.results.filter((result) => result.ok).map((result) => result.name));
    // One check for each binding the shell used to be read for: save, manual save, prepare, discard.
    for (const name of [
      'save commits the prepared state rather than an obsolete captured state',
      'manual browser save persists the exact source key referenced by the draft',
      'Save/Export preparation still accepts a document without pending redactions',
      'discard deletes an unreferenced source and clears pending engine values',
    ]) {
      expect(passed.has(name), name).toBe(true);
    }
  }, 240_000);
});
