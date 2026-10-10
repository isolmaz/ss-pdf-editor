#!/usr/bin/env node
/**
 * Build-budget gate (`pnpm check:budgets`, after `pnpm --filter web build`).
 *
 * The first-paint JavaScript is the entry chunk plus every `<link rel="modulepreload">` script that
 * `apps/web/dist/index.html` names: the browser fetches all of them before the home screen can
 * render. This script gzips each (Node's `zlib.gzipSync`, default level, so the figure is
 * reproducible; Vite's own reporter prints about 1-3% more) and fails when the sum is over
 * `BUILD_BUDGETS.firstPaintJsGzipBytes` in `packages/shared/src/limits.ts`, the one place the
 * number lives. It prints one line per file, so a regression shows which chunk grew.
 *
 *   node tools/check-build-budgets.mjs [path/to/dist/index.html]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIB = 1024;

/** `BUILD_BUDGETS.firstPaintJsGzipBytes`, read from the source so the number is not copied here. */
export function readFirstPaintBudget(limitsSource) {
  const block = /BUILD_BUDGETS\s*=\s*\{([\s\S]*?)\}/.exec(limitsSource)?.[1] ?? '';
  const expression = /firstPaintJsGzipBytes:\s*([0-9 *]+)/.exec(block)?.[1];
  if (expression === undefined) throw new Error('BUILD_BUDGETS.firstPaintJsGzipBytes not found in limits.ts');
  return expression.split('*').reduce((product, part) => product * Number(part.trim()), 1);
}

/** The module entry script and every modulepreload link of an HTML document, in document order. */
export function firstPaintScripts(html) {
  const found = [];
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/g)) {
    const attributes = Object.fromEntries(
      [...(match[2] ?? '').matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)].map((pair) => [pair[1], pair[2] ?? '']),
    );
    if (match[1] === 'script' && attributes.type === 'module' && attributes.src) {
      found.push({ role: 'entry', url: attributes.src });
    } else if (match[1] === 'link' && attributes.rel === 'modulepreload' && attributes.href) {
      found.push({ role: 'modulepreload', url: attributes.href });
    }
  }
  return found;
}

/** Measure a built `index.html`: each script's gzip size and their total. */
export function measureFirstPaint(indexPath, base = '/editor/') {
  const distDir = dirname(indexPath);
  const scripts = firstPaintScripts(readFileSync(indexPath, 'utf8')).map((script) => {
    if (!script.url.startsWith(base)) throw new Error(`${script.url} is outside the base ${base}`);
    const bytes = readFileSync(join(distDir, script.url.slice(base.length)));
    return { ...script, gzip: gzipSync(bytes).length };
  });
  if (!scripts.some((script) => script.role === 'entry'))
    throw new Error(`${indexPath} names no module entry script`);
  return { scripts, total: scripts.reduce((sum, script) => sum + script.gzip, 0) };
}

/** The verdict: the sum against the budget. */
export function verdictFor(total, budget) {
  return { ok: total <= budget, over: total - budget };
}

const kib = (bytes) => (bytes / KIB).toFixed(1);

function main() {
  const indexPath = resolve(process.argv[2] ?? join(repoRoot, 'apps/web/dist/index.html'));
  const budget = readFirstPaintBudget(readFileSync(join(repoRoot, 'packages/shared/src/limits.ts'), 'utf8'));
  const { scripts, total } = measureFirstPaint(indexPath);
  for (const script of scripts) {
    console.log(`${script.role.padEnd(14)} ${kib(script.gzip).padStart(7)} KiB  ${script.url}`);
  }
  const verdict = verdictFor(total, budget);
  console.log(
    `first-paint JS: ${kib(total)} KiB gzip over ${scripts.length} files, budget ${kib(budget)} KiB: ${verdict.ok ? 'PASS' : 'FAIL'}`,
  );
  if (!verdict.ok) {
    console.error(`check-build-budgets: ${kib(verdict.over)} KiB over the first-paint budget`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`check-build-budgets: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
