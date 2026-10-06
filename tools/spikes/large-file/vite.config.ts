/// <reference types="node" />
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { hosting } from '../../../tools/vite/hosting.mjs';

// Spike #5 harness config (throwaway — `PLAN.md §9/K21`, never shipped).
//
// Two reasons this is a config of its own rather than the shared spike config:
//   1. `performance.measureUserAgentSpecificMemory()` only exists in a
//      **cross-origin isolated** realm, and `public/_headers` scopes COOP/COEP
//      to `/editor/*` (the product's scope, not the spikes'). The same
//      production pair is re-applied here for the spike's own port instead of
//      loosening the production headers file.
//   2. the spike gets its own port so sibling spikes can run in parallel.
const spikeRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const isolation: Plugin = {
  name: 'spike5:isolation',
  configureServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

/**
 * Serves the Node-built fixture from the OS temp directory, so the page never
 * has to build one (the fix recorded after two runs died in the in-page fixture
 * stage — `NOTES.md`). Same origin as the page, so it is fetched under the real
 * header policy with no CORS involved, and the file itself stays outside the
 * repository.
 *
 *   SPIKE5_FIXTURE=<path to .pdf> pnpm --filter spikes exec vite --config tools/spikes/large-file/vite.config.ts
 *
 * `/spike5/fixture.pdf` — the document; `/spike5/fixture.json` — the generator's
 * summary sidecar, which is what fills the note's fixture numbers.
 */
function fixture(): Plugin {
  const path = process.env.SPIKE5_FIXTURE ?? '';
  return {
    name: 'spike5:fixture',
    configureServer(server) {
      if (path === '') {
        server.config.logger.warn(
          '[spike5] SPIKE5_FIXTURE is not set — /spike5/fixture.pdf will 404; set it to the Node-built fixture path.',
        );
      }
      server.middlewares.use((request, response, next) => {
        if (!request.url) return next();
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname !== '/spike5/fixture.pdf' && pathname !== '/spike5/fixture.json') return next();
        const file = pathname.endsWith('.json') ? `${path}.json` : path;
        if (file === '' || !existsSync(file) || !statSync(file).isFile()) {
          response.statusCode = 404;
          response.end(`no fixture at ${file || '(unset SPIKE5_FIXTURE)'}`);
          return;
        }
        response.setHeader(
          'Content-Type',
          pathname.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/pdf',
        );
        response.setHeader('Content-Length', String(statSync(file).size));
        response.setHeader('Cache-Control', 'no-store');
        createReadStream(file).pipe(response);
      });
    },
  };
}

export default defineConfig({
  root: spikeRoot,
  plugins: [hosting({ repoRoot }), isolation, fixture()],
  publicDir: false,
  // Pinned to loopback IPv4: `localhost` resolves to `::1` here and Node 26's
  // Vite listens on IPv6 only, which makes the browser tool's readiness probe
  // and any `127.0.0.1` URL fail while the server is actually up.
  server: { port: Number(process.env.SPIKE5_PORT ?? 5185), strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
