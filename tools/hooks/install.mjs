#!/usr/bin/env node
/**
 * Point git at this repository's own hooks (`.githooks/`), so `pre-commit` and `pre-push`
 * run `tools/hooks/guard.mjs` — the rule that engine builds, binaries, keys and oversized
 * blobs never enter git (`AGENTS.md` > Disk/bundle hygiene).
 *
 * `core.hooksPath` cannot be committed, so a fresh clone starts without the guard. This
 * runs from the `prepare` script, i.e. after `pnpm install`, and is deliberately quiet and
 * non-fatal: a tarball, a CI cache or a machine without git has nothing to configure, and
 * an install must never fail over a local convenience.
 */
import { execFileSync } from 'node:child_process';

try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'ignore' });
  console.log('git hooks: core.hooksPath = .githooks (pre-commit and pre-push active)');
} catch {
  // Not a git checkout, or git is unavailable: nothing to configure.
}
