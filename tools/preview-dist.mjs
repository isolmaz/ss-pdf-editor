#!/usr/bin/env node
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
/**
 * Local preview of the assembled `dist/` under the **production header policy**.
 *
 * `public/_headers` is parsed by the same code the Vite plugin uses, so what
 * this server sends is what Cloudflare will send — CSP, COOP/COEP on
 * `/editor/*`, cache rules. That is the point: the editor and the site must run
 * under the real policy, not a relaxed substitute.
 *
 * Usage: node tools/preview-dist.mjs [--root dist] [--port 4178]
 */
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headersFor, parseHeadersFile } from './vite/hosting.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

const distRoot = join(root, readArg('--root', 'dist'));
const port = Number.parseInt(readArg('--port', '4178'), 10);
const headersFile = join(distRoot, '_headers');
const sections = existsSync(headersFile) ? parseHeadersFile(readFileSync(headersFile, 'utf8')) : [];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

/** Cloudflare static-assets "clean URL" behaviour: /gizlilik -> gizlilik.html. */
function resolveFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape (`/%E0%A4%A`) is a request for something this server does not
    // have, not a reason to end the process: `URIError` used to escape the request
    // handler, close the connection and exit with code 1.
    return null;
  }
  const relativePath = normalize(decoded).replace(/^([/\\])+/, '');
  if (relativePath.includes('..')) return null;
  const candidates = [relativePath, `${relativePath}.html`, join(relativePath, 'index.html')];
  for (const candidate of candidates) {
    const file = join(distRoot, candidate);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

/**
 * Cloudflare's `not_found_handling: "404-page"`: the nearest `404.html`, looked up from the
 * request's own directory towards the root, so `/en/…` gets the English page and every
 * other path the Turkish one at the root.
 */
function notFoundPage(pathname) {
  const parts = pathname.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
  const directory = pathname.endsWith('/') ? parts : parts.slice(0, -1);
  for (let depth = directory.length; depth >= 0; depth -= 1) {
    const candidate = join(distRoot, ...directory.slice(0, depth), '404.html');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const headers = headersFor(sections, url.pathname);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);

  const file = resolveFile(url.pathname);
  if (file === null) {
    const notFound = notFoundPage(url.pathname);
    res.statusCode = 404;
    res.setHeader('Content-Type', MIME['.html']);
    res.end(notFound === null ? 'Not found' : readFileSync(notFound));
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
  res.setHeader('Content-Length', statSync(file).size);
  // Streamed, not read whole: a synchronous read of a 30 MB engine blocks every other
  // request, and a parallel e2e run then waits seconds for a 4 KB `sw.js`.
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}).listen(port, () => {
  console.log(`preview-dist: ${distRoot} on http://localhost:${port}`);
  const policy = headersFor(sections, '/editor/');
  for (const [name, value] of Object.entries(policy)) console.log(`  /editor/  ${name}: ${value}`);
});
