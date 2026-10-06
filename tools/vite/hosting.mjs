/**
 * Hosting policy for local dev/preview — the "production headers from day one"
 * rule.
 *
 * `public/_headers` is the single source of truth for the production policy
 * (Cloudflare applies it at the edge, for Pages and static-assets Workers alike). This plugin parses that same file
 * and applies the matching headers to the Vite dev server and `vite preview`,
 * so the editor and the site run under the real CSP + COOP/COEP instead of a
 * relaxed developer substitute.
 *
 * It also serves the repository `public/` directory at the URL root in dev, so
 * `/engines/**` resolves exactly as it will in production.
 *
 * Dev-only relaxation: `@vitejs/plugin-react` injects an inline react-refresh
 * preamble that a strict `script-src 'self'` blocks. The dev server therefore
 * appends `'unsafe-inline'` to `script-src` only when `relaxDevCsp` is true,
 * and says so in the log. `vite preview` (and production) keep the strict file
 * policy unchanged — that is where verification runs.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

/**
 * Parse a Cloudflare `_headers` file into path -> header records.
 * Header lines may be indented; a line starting with `#` is a comment.
 */
export function parseHeadersFile(text) {
  const sections = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue;
    const isHeader = /^\s/.test(rawLine);
    if (!isHeader) {
      current = { path: rawLine.trim(), headers: {} };
      sections.push(current);
      continue;
    }
    if (current === null) continue;
    const separator = rawLine.indexOf(':');
    if (separator < 0) continue;
    const name = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    current.headers[name] = value;
  }
  return sections;
}

function matches(pattern, pathname) {
  if (pattern === '/*') return true;
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    return pathname.startsWith(`${base}/`);
  }
  return pathname === pattern;
}

/** Cloudflare joins same-name headers from every matching rule. */
export function headersFor(sections, pathname) {
  const result = {};
  for (const section of sections) {
    if (!matches(section.path, pathname)) continue;
    for (const [name, value] of Object.entries(section.headers)) {
      result[name] = result[name] === undefined ? value : `${result[name]}, ${value}`;
    }
  }
  return result;
}

function applyHeaders(sections, relaxDevCsp) {
  return (req, res, next) => {
    if (!req.url) return next();
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const headers = headersFor(sections, pathname);
    for (const [name, value] of Object.entries(headers)) {
      const isCsp = name.toLowerCase() === 'content-security-policy';
      res.setHeader(
        name,
        isCsp && relaxDevCsp
          ? value.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          : value,
      );
    }
    next();
  };
}

/** Serve `<repo>/public/**` at the URL root (dev): `/engines/**`, `/robots.txt`, … */
function servePublicDir(publicDir) {
  return (req, res, next) => {
    if (!req.url) return next();
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const relative = normalize(pathname).replace(/^([/\\])+/, '');
    if (relative.includes('..')) return next();
    const file = join(publicDir, relative);
    if (!existsSync(file) || !statSync(file).isFile()) return next();
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  };
}

export function hosting({ repoRoot, relaxDevCsp = false }) {
  const headersFile = join(repoRoot, 'public', '_headers');
  const sections = existsSync(headersFile) ? parseHeadersFile(readFileSync(headersFile, 'utf8')) : [];
  if (relaxDevCsp) {
    console.log(
      `[hosting] ${sections.length} header section(s) from public/_headers; dev CSP relaxed with script-src 'unsafe-inline' (react-refresh preamble) — preview and production stay strict.`,
    );
  }
  return [
    {
      name: 'pdf-editor:hosting-headers',
      // Braces matter: connect's `use()` returns the app, and Vite treats a
      // function returned from `configureServer` as a post-hook and calls it
      // with no arguments — which crashed every dev/preview start.
      configureServer: (server) => {
        server.middlewares.use(applyHeaders(sections, relaxDevCsp));
      },
    },
    {
      name: 'pdf-editor:public-dir',
      configureServer: (server) => {
        server.middlewares.use(servePublicDir(join(repoRoot, 'public')));
      },
    },
  ];
}
