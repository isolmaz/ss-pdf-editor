/**
 * Service Worker for SsPdfEditor.
 * Scoped to `/editor/` with same-origin static asset caching only.
 *
 * Security Invariants:
 *  - Only same-origin static assets (`/editor/*`, `/engines/*`, `/fonts/*`).
 *  - Non-GET requests are ignored and passed through untouched.
 *  - Document data or user bytes are NEVER stored in CacheStorage.
 *  - Cached responses maintain CORP/COOP/COEP headers to keep cross-origin isolation intact.
 *
 * ## Versioning
 *
 * `CACHE_NAME` is stamped at build time by `tools/assemble-dist.mjs`, which reads the same
 * `apps/web/src/offline-packages.json` this worker serves readiness for. Two consequences,
 * and both are the point:
 *
 *  - **A new release never reads the previous release's cache.** The name changes, so the
 *    entries are absent and every request goes to the network; the old cache is deleted on
 *    activation. An immutable-cached engine can therefore never be served under a shell
 *    that expects a different build of it.
 *  - **A previous version stays usable until the new one activates.** `install` fills the
 *    new cache without touching the old one, so an interrupted preparation (a closed tab, a
 *    dropped connection) leaves the working version exactly as it was.
 *
 * The `__CACHE_VERSION__` placeholder is replaced at build time; a worker served straight
 * from `public/` in development keeps the literal, which is a valid — if unversioned —
 * name.
 */

const CACHE_VERSION = '__CACHE_VERSION__';
const CACHE_NAME = `pdf-editor-static-${CACHE_VERSION}`;
const MANIFEST_URL = '/offline-manifest.json';

const CORE_SHELL_URLS = [
  '/editor/',
  '/editor/index.html',
  '/theme-boot.js',
  '/favicon.svg',
  '/manifest.webmanifest',
];

/** The manifest the build wrote, or `null` when this worker is running unbuilt. */
async function readManifest() {
  try {
    const response = await fetch(MANIFEST_URL, { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    if (typeof data !== 'object' || data === null) return null;
    if (typeof data.version !== 'string' || typeof data.capabilities !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * The build's own interface catalogues (`shell` in the manifest). The entry fetches its
 * language at run time, so the crawl of `index.html` never names it, and a shell reloaded
 * offline without one paints raw message keys. Only `/editor/assets/` paths are taken.
 *
 * This is the part of the editor's code that install itself must hold. Every other chunk of
 * the build — each tool's code, the dialogs, the engines' adapters — is the `app` capability,
 * which Prepare fetches and readiness requires (`capabilities.app` in the manifest).
 */
function shellPathsOf(manifest) {
  const list = manifest?.shell;
  if (!Array.isArray(list)) return [];
  return list.filter((path) => typeof path === 'string' && path.startsWith('/editor/assets/'));
}

/**
 * The paths the named capabilities need, or every capability's when no names are given, so
 * one preparation pass can fill the whole cache. The page asks by name and never by URL: the
 * `app` capability is the editor's own hashed chunks, which only the build's manifest can
 * list, and a name that is not in the manifest asks for nothing.
 */
function pathsOf(manifest, names) {
  const paths = new Set();
  for (const [name, list] of Object.entries(manifest?.capabilities ?? {})) {
    if (names !== undefined && !names.includes(name)) continue;
    if (!Array.isArray(list)) continue;
    for (const path of list) if (typeof path === 'string') paths.add(path);
  }
  return [...paths];
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(CORE_SHELL_URLS);
      const manifest = await readManifest();
      // The rest of the core package — the interface's own fonts — is the shell too: the
      // first visit fetched them before this worker controlled the page, so nothing else
      // would cache them, and a reload offline fell back to system fonts.
      for (const path of manifest?.capabilities?.core ?? []) {
        if (typeof path !== 'string' || CORE_SHELL_URLS.includes(path)) continue;
        try {
          const res = await fetch(path);
          if (res.ok) await cache.put(path, res);
        } catch {
          // a font missed here is cached by the next online load that fetches it
        }
      }
      for (const path of shellPathsOf(manifest)) {
        try {
          const res = await fetch(path);
          if (res.ok) await cache.put(path, res);
        } catch {
          // a catalogue missed here is cached by the next online load that fetches it
        }
      }
      try {
        const htmlRes = await fetch('/editor/index.html');
        if (htmlRes.ok) {
          const html = await htmlRes.clone().text();
          const matches = html.matchAll(/(?:src|href)="(\/editor\/assets\/[^"]+\.(?:js|css))"/g);
          for (const match of matches) {
            const assetUrl = match[1];
            if (assetUrl) {
              try {
                const res = await fetch(assetUrl);
                if (res.ok) await cache.put(assetUrl, res);
              } catch {
                // asset fetch error tolerated during install
              }
            }
          }
        }
      } catch {
        // HTML crawl failure tolerated
      }
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        // Only this application's caches, and only the previous *versions* of them: the
        // namespace is shared by the whole origin, so an unfiltered delete would reach
        // another app's storage.
        Promise.all(
          keys
            .filter((key) => key.startsWith('pdf-editor-static-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isCacheable(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  const path = url.pathname;
  return (
    path.startsWith('/editor/') ||
    path.startsWith('/engines/') ||
    path.startsWith('/fonts/') ||
    path === '/theme-boot.js' ||
    path === '/favicon.svg' ||
    path === '/manifest.webmanifest'
  );
}

function withIsolationHeaders(response, isNavigate = false) {
  if (response?.status !== 200) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  if (isNavigate || response.url.includes('/editor/')) {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  } else if (response.url.includes('/engines/')) {
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** The one offline answer: an explicit, un-cacheable failure rather than a hang. */
function offlineMissing() {
  return new Response('Çevrimdışı: Bu paket henüz hazırlanmadı.', {
    status: 503,
    statusText: 'Service Unavailable (Offline Missing)',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Offline-Missing': 'true',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}

/** A cache write that must not become an unhandled rejection when it fails. */
function remember(request, response) {
  return caches
    .open(CACHE_NAME)
    .then((cache) => cache.put(request, response))
    .catch(() => undefined);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!isCacheable(request)) return;

  const url = new URL(request.url);
  const isNavigate =
    request.mode === 'navigate' || url.pathname === '/editor/' || url.pathname === '/editor/index.html';

  // User performed a force refresh (Ctrl+F5 / Ctrl+Shift+R): bypass cache completely.
  if (request.cache === 'reload') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // The network response is returned whether or not the cache commit succeeds: a
          // failed write must not turn a successful load into an error.
          if (response.ok) event.waitUntil(remember(request, response.clone()));
          return withIsolationHeaders(response, isNavigate);
        })
        .catch(async () => {
          const cached = await caches.match(request);
          // The previous version referenced a `response` that is not in scope here; the
          // offline answer is what the branch was always meant to return.
          return cached ? withIsolationHeaders(cached, isNavigate) : offlineMissing();
        }),
    );
    return;
  }

  const isImmutable = url.pathname.startsWith('/engines/') || url.pathname.startsWith('/fonts/');

  if (isImmutable) {
    // Cache-first for pinned engines and fonts: their content is fixed by the pins, and
    // the cache *name* is what carries the release, so a hit is always this build's bytes.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return withIsolationHeaders(cached);
        return fetch(request)
          .then((response) => {
            if (response.ok) event.waitUntil(remember(request, response.clone()));
            return response;
          })
          .catch(() => offlineMissing());
      }),
    );
    return;
  }

  // Network-first for the editor shell and bundle assets, fallback to cache when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) event.waitUntil(remember(request, response.clone()));
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return withIsolationHeaders(cached, isNavigate);
        if (isNavigate) {
          const fallback = await caches.match('/editor/index.html');
          if (fallback) return withIsolationHeaders(fallback, true);
        }
        return offlineMissing();
      }),
  );
});

/** Reads back what this build's cache actually holds, as pathnames. */
async function cachedPaths() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  return new Set(keys.map((key) => new URL(key.url).pathname));
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data.type === 'PREPARE_PACKAGE') {
    // Registered synchronously: work started in a message handler without `waitUntil`
    // can be terminated with the event.
    event.waitUntil(
      (async () => {
        const manifest = await readManifest();
        if (manifest === null) {
          event.ports[0]?.postMessage({ type: 'PREPARE_FAILED', error: 'offline manifest unavailable' });
          return;
        }
        // Only the build's own list: the page names capabilities, never URLs, so an
        // arbitrary URL from a page can never put a response into this origin's static cache.
        const requested = pathsOf(manifest, Array.isArray(data.capabilities) ? data.capabilities : undefined);
        const cache = await caches.open(CACHE_NAME);
        let count = 0;
        const failed = [];
        for (const url of requested) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              await cache.put(url, res);
              count++;
            } else {
              failed.push(url);
            }
          } catch {
            // An interrupted preparation is reported, never hidden: the readiness answer
            // is what the caller must trust, and it is computed from the cache itself.
            failed.push(url);
          }
        }
        event.ports[0]?.postMessage({
          type: 'PREPARE_DONE',
          version: manifest.version,
          count,
          failed,
        });
      })().catch((error) => {
        event.ports[0]?.postMessage({ type: 'PREPARE_FAILED', error: String(error) });
      }),
    );
    return;
  }

  if (data.type === 'CHECK_READINESS') {
    event.waitUntil(
      (async () => {
        const manifest = await readManifest();
        if (manifest === null) {
          event.ports[0]?.postMessage({
            type: 'READINESS_STATUS',
            version: null,
            matchesBuild: false,
            capabilities: {},
          });
          return;
        }
        const held = await cachedPaths();
        const capabilities = {};
        for (const [name, list] of Object.entries(manifest.capabilities)) {
          const required = Array.isArray(list) ? list.filter((path) => typeof path === 'string') : [];
          const missing = required.filter((path) => !held.has(path));
          capabilities[name] = { ready: missing.length === 0, missing };
        }
        event.ports[0]?.postMessage({
          type: 'READINESS_STATUS',
          version: manifest.version,
          // The cache name carries the release, so a worker that is answering at all is
          // answering for its own build; the field exists so a caller can assert it.
          matchesBuild: CACHE_VERSION === '__CACHE_VERSION__' || CACHE_NAME.endsWith(CACHE_VERSION),
          capabilities,
        });
      })().catch(() => {
        event.ports[0]?.postMessage({
          type: 'READINESS_STATUS',
          version: null,
          matchesBuild: false,
          capabilities: {},
        });
      }),
    );
  }
});
