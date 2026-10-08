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
 * The zone's bot protection answers HTML requests from datacenter networks (GitHub's runners)
 * with a challenge: 403 and `cf-mitigated: challenge`. Such an answer is the zone's, not the
 * Worker's, so it is reported and not counted as a failure; any other non-200 still fails. What
 * the challenge hides is covered by checks it does not touch:
 *  4. Every `/editor/assets/*.js` file of this build answers 200 (check 2): asset names carry a
 *     content hash and a Workers deployment serves only its own assets, so the entry script of a
 *     new build answering is what shows the custom domain serves this build. `/sw.js` is byte
 *     for byte `<dist-dir>/sw.js`: the worker that decides what the editor caches arrives
 *     unaltered (its cache version follows the engine pins, not the editor build).
 *  5. The first editor script carries every header `_headers` declares for it (the `/editor/*`
 *     rule), so the security headers are checked even when `/editor/` itself is challenged.
 *
 * A deploy takes a moment to reach every edge, so the whole set is retried: up to
 * `ATTEMPTS` times, `DELAY_MS` apart, and never past `DEADLINE_MS`: a site that hangs must end
 * as a failed check the deploy job can roll back, not run into the job's timeout. Exit 0 when
 * one attempt passes, 1 when none does (the last attempt's failures are printed), 2 on a usage
 * error or an unreadable `<dist-dir>`.
 * Node built-ins only, plus the `_headers` parser `tools/preview-dist.mjs` already uses.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { headersFor, parseHeadersFile } from '../vite/hosting.mjs';

const ATTEMPTS = 10;
const DELAY_MS = 6_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEADLINE_MS = 5 * 60_000;
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
const localWorker = join(distDir, 'sw.js');
for (const file of [localEditorHtml, localHeaders, localWorker]) {
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

const headerRules = parseHeadersFile(readFileSync(localHeaders, 'utf8'));
/** What `_headers` declares for `path`, less `Cache-Control` (a caching policy, not a security header). */
const declaredFor = (path) =>
  Object.entries(headersFor(headerRules, path)).filter(([name]) => name.toLowerCase() !== 'cache-control');
const expectedHeaders = declaredFor('/editor/');
if (expectedHeaders.length === 0) usageError(`${localHeaders} declares no security headers for /editor/`);
const headerProbe = expectedScripts[0];
const expectedProbeHeaders = declaredFor(headerProbe);
const localWorkerBytes = readFileSync(localWorker);

const squash = (value) => value.replace(/\s+/g, ' ').trim();

/** One GET, never following redirects, never served from an intermediary cache. */
async function get(path) {
  return fetch(`${origin}${path}`, {
    redirect: 'manual',
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** The zone's bot challenge, recognised only by its exact shape. */
function isChallenge(response) {
  return response.status === 403 && response.headers.get('cf-mitigated') === 'challenge';
}

/** Failures for every header `wanted` lists that `response` lacks or carries with another value. */
function headerFailures(path, response, wanted) {
  const failures = [];
  for (const [name, value] of wanted) {
    const actual = response.headers.get(name);
    if (actual === null) failures.push(`${path} is missing the ${name} header declared in _headers`);
    else if (squash(actual) !== squash(value)) {
      failures.push(
        `${path} ${name} differs from _headers: expected "${squash(value)}", got "${squash(actual)}"`,
      );
    }
  }
  return failures;
}

function describeStatus(response) {
  const location = response.headers.get('location');
  return location === null ? `${response.status}` : `${response.status} -> ${location}`;
}

/**
 * One pass over every check. Returns the failures, empty when the site is serving this build,
 * and the entry points the zone answered with a challenge.
 */
async function checkOnce() {
  const failures = [];
  const challenged = [];

  for (const path of ENTRY_POINTS) {
    try {
      const response = await get(path);
      const body = Buffer.from(await response.arrayBuffer());
      if (isChallenge(response)) challenged.push(path);
      else if (response.status !== 200)
        failures.push(`${path}: expected 200, got ${describeStatus(response)}`);
      else if (path === '/sw.js' && !body.equals(localWorkerBytes)) {
        failures.push("/sw.js is not byte for byte the local build's worker");
      }
    } catch (error) {
      failures.push(`${path}: request failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let editor;
  try {
    editor = await get('/editor/');
  } catch (error) {
    failures.push(`/editor/: request failed — ${error instanceof Error ? error.message : String(error)}`);
    return { failures, challenged };
  }
  const liveHtml = await editor.text().catch(() => '');
  if (editor.status === 200) {
    const missing = expectedScripts.filter((script) => !liveHtml.includes(script));
    if (missing.length > 0) {
      failures.push(
        `/editor/ does not reference ${missing.length} of the ${expectedScripts.length} script(s) of the local build (the old build may still be live): ${missing.join(', ')}`,
      );
    }
    failures.push(...headerFailures('/editor/', editor, expectedHeaders));
  }
  for (const script of expectedScripts) {
    try {
      const response = await get(script);
      await response.arrayBuffer();
      if (response.status !== 200) failures.push(`${script}: expected 200, got ${describeStatus(response)}`);
      else if (script === headerProbe)
        failures.push(...headerFailures(script, response, expectedProbeHeaders));
    } catch (error) {
      failures.push(`${script}: request failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { failures, challenged };
}

const deadline = Date.now() + DEADLINE_MS;
let failures = [];
let attempt = 0;
while (attempt < ATTEMPTS && Date.now() < deadline) {
  attempt += 1;
  const result = await checkOnce();
  failures = result.failures;
  if (failures.length === 0) {
    const answered = ENTRY_POINTS.length - result.challenged.length;
    console.log(
      `smoke: ${origin} serves this build — ${expectedScripts.length} editor script(s) of this build live, /sw.js as built, ${answered} of ${ENTRY_POINTS.length} entry points answer 200, the security headers match (attempt ${attempt}/${ATTEMPTS})`,
    );
    if (result.challenged.length > 0) {
      console.log(
        `smoke: the zone's bot protection challenged ${result.challenged.join(', ')} from this network (403, cf-mitigated: challenge); their HTML was not read`,
      );
    }
    process.exit(0);
  }
  console.log(`smoke: attempt ${attempt}/${ATTEMPTS} failed (${failures.length} problem(s))`);
  if (attempt < ATTEMPTS && Date.now() + DELAY_MS < deadline) await sleep(DELAY_MS);
}

console.error(`\nsmoke: ${origin} is not serving this build after ${attempt} attempt(s):`);
for (const failure of failures) console.error(`  x ${failure}`);
process.exit(1);
