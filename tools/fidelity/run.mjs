#!/usr/bin/env node
/**
 * `pnpm fidelity [playwright args…]`: the PDF → Word export fidelity run.
 *
 * Sets `FIDELITY=1` (which is what adds the `fidelity` project to `playwright.config.ts`),
 * clears the previous results, runs Playwright, then merges the per-test results into
 * `test-results/fidelity/report.{json,md}` whether or not a test failed. The exit code is
 * Playwright's. Written in Node so it behaves the same on Windows and Linux.
 *
 * Needs the assembled `dist/` (`pnpm build && pnpm assemble:dist`) and LibreOffice
 * (`LIBREOFFICE=/path/to/soffice`, or `soffice` on the PATH). Other environment variables are
 * listed at the top of `e2e/fidelity/fidelity.spec.ts`.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const playwrightCli = join(
  dirname(createRequire(import.meta.url).resolve('playwright/package.json')),
  'cli.js',
);

rmSync(join(root, 'test-results', 'fidelity'), { recursive: true, force: true });

const env = { ...process.env, FIDELITY: '1' };
const run = spawnSync(
  process.execPath,
  [playwrightCli, 'test', '--project=fidelity', ...process.argv.slice(2)],
  { cwd: root, env, stdio: 'inherit' },
);

spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'e2e/fidelity/report.ts'], {
  cwd: root,
  env,
  stdio: 'inherit',
});

process.exit(run.status ?? 1);
