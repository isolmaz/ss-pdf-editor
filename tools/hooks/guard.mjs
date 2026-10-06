#!/usr/bin/env node
/**
 * Git hook guard for the pdf-editor repository.
 *
 *   node tools/hooks/guard.mjs staged    # pre-commit: paths staged for this commit
 *   node tools/hooks/guard.mjs tracked   # pre-push:   every tracked path, plus size checks
 *
 * It enforces the repository hygiene rules that AGENTS.md states
 * ("Disk/bundle hygiene") and PLAN.md §3.6 relies on: engine builds,
 * traineddata/wasm/font binaries, private keys, env files and oversized blobs
 * never enter git. Dependency-free and fast, so a fresh clone can commit.
 *
 * On commit it also runs `biome check --staged`, so formatting, import order and lint
 * stay clean file by file. A checkout without `node_modules` has no Biome to run; the
 * guard then says so and lets the commit through rather than blocking a fresh clone.
 *
 * The full quality gate (typecheck/unit/build/license audit) runs locally through
 * `pnpm ci:full` — this hook only guards the tree and its format.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const ENGINE_PATH = /^public\/engines\//;
const KEY_FILE = /\.(pem|key|p12|pfx)$/i;
const ENV_FILE = /(^|\/)\.env($|\.)(?!example$)/;
const BINARY_ASSET = /\.(wasm|traineddata|woff2?|ttf|otf)$/i;
const SECRETS_DIR = /^secrets\//;
const MAX_BYTES = 5 * 1024 * 1024;

const RULES = [
  [
    ENGINE_PATH,
    'engine assets live under public/engines/** and are fetched by `pnpm fetch:engines` (PLAN.md §3.6)',
  ],
  [SECRETS_DIR, 'the secrets/ directory is never committed'],
  [KEY_FILE, 'private keys (*.pem, *.key, *.p12, *.pfx) are never committed'],
  [ENV_FILE, 'env files are never committed (only .env.example is tracked)'],
  [BINARY_ASSET, 'wasm/traineddata/font binaries are fetched by script, never committed'],
];

function listFiles() {
  const args =
    mode === 'staged' ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z'];
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}

const failures = [];
for (const file of listFiles()) {
  for (const [pattern, why] of RULES) {
    if (pattern.test(file)) failures.push(`${file}\n    blocked by ${pattern} — ${why}`);
  }
  if (mode === 'tracked') {
    try {
      const size = statSync(`${root}/${file}`).size;
      if (size > MAX_BYTES) {
        failures.push(
          `${file}\n    ${(size / 1048576).toFixed(1)} MiB exceeds the 5 MiB commit limit — fetch it by script or ask the owner`,
        );
      }
    } catch {
      /* deleted-but-listed: nothing to measure */
    }
  }
}

if (failures.length > 0) {
  console.error(`\nguard (${mode}): ${failures.length} problem(s)\n`);
  for (const line of failures) console.error(`  ${line}`);
  console.error('\nNothing was committed. See AGENTS.md > Disk/bundle hygiene.\n');
  process.exit(1);
}

if (mode === 'staged') {
  const biome = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'biome.cmd' : 'biome');
  if (!existsSync(biome)) {
    console.log('guard (staged): Biome is not installed (run `pnpm install`) — format check skipped.');
  } else {
    try {
      execFileSync(`"${biome}" check --staged --no-errors-on-unmatched --files-ignore-unknown=true`, {
        cwd: root,
        shell: true,
        stdio: 'inherit',
      });
    } catch {
      console.error('\nguard (staged): `biome check` failed on the staged files — nothing was committed.');
      console.error(
        'Run `pnpm exec biome check --write <file>` on those files, stage them and commit again.\n',
      );
      process.exit(1);
    }
  }
}
