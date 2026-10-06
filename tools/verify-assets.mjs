#!/usr/bin/env node
/**
 * Verify-only entry point over `tools/asset-pins.json` (`PLAN.md §5` Phase 0 item 3;
 * AGENTS.md > Development Commands: `node tools/verify-assets.mjs`).
 *
 *   node tools/verify-assets.mjs
 *
 * Recomputes the size and SHA-256 of every pinned file under `public/engines/**`, prints one
 * PASS/FAIL line per engine with the totals, and exits 1 when a file is missing or does not match
 * its pin. This is the check CI and the pre-push path run; it never writes anything.
 *
 * The hashing and the comparison live in `tools/fetch-engines.mjs`, so `--update` and this check
 * cannot drift apart.
 */
import { printReport, verifyAssets } from './fetch-engines.mjs';

try {
  const result = verifyAssets();
  printReport(result, { action: 'verify-assets' });
  if (result.problems.length > 0) process.exitCode = 1;
} catch (error) {
  console.error(`\nverify-assets: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
