#!/usr/bin/env node
/**
 * Post-deploy smoke check: is the build in `dist/` what the live site is serving?
 *
 *   node tools/deploy/smoke.mjs <base-url> [dist-dir=dist]
 *
 * Run by the `deploy` job of `.github/workflows/ci.yml` right after `wrangler deploy`; a
 * failure there rolls the Worker back to the previous version. Checks, against `<base-url>`:
 *
 *  1. `/`, `/en/`, `/editor/` and `/sw.js` answer 200 (a redirect is a failure: these are the
 *     published entry points and each is served directly).
 *  2. `/editor/` references every `/editor/assets/*.js` file that `<dist-dir>/editor/index.html`
 *     references, and each of those files answers 200. Asset names carry a content hash, so
 *     this holds only once the new build is the one being served. The HTML is not compared
 *     byte for byte: a host may inject markup (the headers file exists to forbid exactly that,
 *     but the check must not depend on it).
 *  3. The `/editor/` response carries every header `<dist-dir>/_headers` declares for it,
 *     except `Cache-Control` (a caching policy, not a security header), with the declared value.
 *
 * A deploy takes a moment to reach every edge, so the whole set is retried: up to
 * `ATTEMPTS` times, `DELAY_MS` apart. Exit 0 when one attempt passes, 1 when none does (the
 * last attempt's failures are printed), 2 on a usage error or an unreadable `<dist-dir>`.
 * Node built-ins only, plus the `_headers` parser `tools/preview-dist.mjs` already uses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { headersFor, parseHeadersFile } from '../vite/hosting.mjs';

const ATTEMPTS = 10;
const DELAY_MS = 6_000;
const REQUEST_TIMEOUT_MS = 20_000;
const ENTRY_POINTS = ['/', '/en/', '/editor/', '/sw.js'];

const USAGE = 'usage: node tools/deploy/smoke.mjs <base-url> [dist-dir=dist]';

function usageError(message) {
  console.error(`smoke: ${message}\n${USAGE}`);
  process.exit(2);
}

const [baseArg, distArg = 'dist', ...extra] = process.argv.slice(2);
if (baseArg === undefined || extra.length > 0) usageError('expected <base-url> and an optional <dist-dir>');

let base;
try {
  base = new URL(baseArg);
} catch {
  usageError(`not a URL: ${baseArg}`);
}
if (base.protocol !== 'https:' && base.protocol !== 'http:') usageError(`not an http(s) URL: ${baseArg}`);
const origin = base.origin;

const distDir = resolve(distArg);
const localEditorHtml = join(distDir, 'editor', 'index.html');
const localHeaders = join(distDir, '_headers');
for (const file of [localEditorHtml, localHeaders]) {
  if (!existsSync(file))
    usageError(`${file} does not exist — build and assemble first (pnpm build && pnpm assemble:dist)`);
}

/** The `/editor/assets/*.js` URLs the local editor page references (script and modulepreload tags). */
function referencedScripts(html) {
  return [...new Set(html.match(/\/editor\/assets\/[^"'\s<>]+?\.js(?=["'\s<>]|$)/g) ?? [])].sort();
}

const expectedScripts = referencedScripts(readFileSync(localEditorHtml, 'utf8'));
if (expectedScripts.length === 0) {
  usageError(`${localEditorHtml} references no /editor/assets/*.js file — not an assembled editor page`);
}

const expectedHeaders = Object.entries(
  headersFor(parseHeadersFile(readFileSync(localHeaders, 'utf8')), '/editor/'),
).filter(([name]) => name.toLowerCase() !== 'cache-control');
if (expectedHeaders.length === 0) usageError(`${localHeaders} declares no security headers for /editor/`);

const squash = (value) => value.replace(/\s+/g, ' ').trim();

/** One GET, never following redirects, never served from an intermediary cache. */
async function get(path) {
  return fetch(`${origin}${path}`, {
    redirect: 'manual',
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function describeStatus(response) {
  const location = response.headers.get('location');
  return location === null ? `${response.status}` : `${response.status} -> ${location}`;
}

/** One pass over every check. Returns the failures, empty when the site is serving this build. */
async function checkOnce() {
  const failures = [];

  for (const path of ENTRY_POINTS) {
    try {
      const response = await get(path);
      await response.arrayBuffer();
      if (response.status !== 200) failures.push(`${path}: expected 200, got ${describeStatus(response)}`);
    } catch (error) {
      failures.push(`${path}: request failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let editor;
  try {
    editor = await get('/editor/');
  } catch (error) {
    failures.push(`/editor/: request failed — ${error instanceof Error ? error.message : String(error)}`);
    return failures;
  }
  const liveHtml = await editor.text().catch(() => '');
  if (editor.status === 200) {
    const missing = expectedScripts.filter((script) => !liveHtml.includes(script));
    if (missing.length > 0) {
      failures.push(
        `/editor/ does not reference ${missing.length} of the ${expectedScripts.length} script(s) of the local build (the old build may still be live): ${missing.join(', ')}`,
      );
    }
    for (const [name, wanted] of expectedHeaders) {
      const actual = editor.headers.get(name);
      if (actual === null) failures.push(`/editor/ is missing the ${name} header declared in _headers`);
      else if (squash(actual) !== squash(wanted)) {
        failures.push(
          `/editor/ ${name} differs from _headers: expected "${squash(wanted)}", got "${squash(actual)}"`,
        );
      }
    }
  }
  for (const script of expectedScripts) {
    try {
      const response = await get(script);
      await response.arrayBuffer();
      if (response.status !== 200) failures.push(`${script}: expected 200, got ${describeStatus(response)}`);
    } catch (error) {
      failures.push(`${script}: request failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

let failures = [];
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  failures = await checkOnce();
  if (failures.length === 0) {
    console.log(
      `smoke: ${origin} serves this build — ${ENTRY_POINTS.length} entry points answer 200, ${expectedScripts.length} editor script(s) live, ${expectedHeaders.length} header(s) match (attempt ${attempt}/${ATTEMPTS})`,
    );
    process.exit(0);
  }
  console.log(`smoke: attempt ${attempt}/${ATTEMPTS} failed (${failures.length} problem(s))`);
  if (attempt < ATTEMPTS) await sleep(DELAY_MS);
}

console.error(`\nsmoke: ${origin} is not serving this build after ${ATTEMPTS} attempts:`);
for (const failure of failures) console.error(`  x ${failure}`);
process.exit(1);
