import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from 'playwright/test';

/**
 * Browser gate for the shipped shell.
 *
 * The specs run against the **assembled** `dist/` served by the repository's own preview
 * server (`tools/preview-dist.mjs`), not against a dev server and not against mocks: that
 * server applies `public/_headers` exactly as Cloudflare will, so COOP/COEP, the CSP and
 * the cache policy are part of what is being tested rather than a relaxed local stand-in.
 *
 * Build first — `pnpm build && pnpm assemble:dist` — then `pnpm e2e`. Without `dist/` there
 * is nothing to serve, so `webServer` is omitted and every spec fails on connection
 * refused: that is deliberate, because a green run must mean "the built app works".
 *
 * Chromium only: the editor is a Chromium-targeted PWA (File System Access, OPFS), and the
 * other engines would need system libraries this gate does not install.
 */

const distEntry = fileURLToPath(new URL('./dist/editor/index.html', import.meta.url));
const PORT = 4178;

/**
 * The PDF → Word fidelity harness (`e2e/fidelity/`, run by `pnpm fidelity`) is its own project,
 * present only when `FIDELITY` is set: it needs LibreOffice, takes minutes and measures rather
 * than gates, so `pnpm e2e` and `pnpm coverage` neither run nor list it.
 */
const fidelity = Boolean(process.env.FIDELITY);
const FIDELITY_SPECS = '**/e2e/fidelity/**';

export default defineConfig({
  testDir: './e2e',
  // OCR recognises rendered pages with a WASM engine; the spec narrows its own scope so
  // this stays generous rather than unreachable.
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  // `E2E_WORKERS` caps the browsers run at once (Playwright's default is half the cores), so a
  // full run, `pnpm coverage` included, can leave room on a machine someone is working on.
  ...(process.env.E2E_WORKERS === undefined ? {} : { workers: Number(process.env.E2E_WORKERS) }),
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // `list` is the console reporter in both cases; with `CI` set (a build pipeline) the
  // HTML report is written too, for reading a failed run afterwards (the hosted workflow,
  // `.github/workflows/ci.yml`, uploads it when a shard fails).
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // The shell follows the browser's language when no choice is stored, so the context is
    // pinned: the specs must not change meaning on a Turkish or German machine.
    locale: 'en-US',
  },
  projects: [
    {
      name: 'chromium',
      // The worker's own install and update are measured in seconds on an idle machine and
      // in tens of seconds beside four workers rendering and recognising pages: those tests
      // run on their own, after this project.
      grepInvert: /@service-worker/,
      testIgnore: FIDELITY_SPECS,
      use: {
        // No extra launch flags. Cross-origin isolation comes from the response headers
        // (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
        // require-corp` on `/editor/*` in `public/_headers`), which the preview server
        // sends — a flag such as `--disable-web-security` would test a different, more
        // permissive browser than the one users run.
        ...devices['Desktop Chrome'],
        // The full Chromium build rather than the separate headless shell: it is the same
        // engine the PWA targets, and `playwright install chromium` fetches just this one.
        channel: 'chromium',
      },
    },
    {
      name: 'service-worker',
      grep: /@service-worker/,
      testIgnore: FIDELITY_SPECS,
      // Runs once the rest has passed. A targeted run of these tests alone takes `--no-deps`,
      // or the whole chromium project runs first.
      dependencies: ['chromium'],
      use: {
        // No extra launch flags. Cross-origin isolation comes from the response headers
        // (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
        // require-corp` on `/editor/*` in `public/_headers`), which the preview server
        // sends — a flag such as `--disable-web-security` would test a different, more
        // permissive browser than the one users run.
        ...devices['Desktop Chrome'],
        // The full Chromium build rather than the separate headless shell: it is the same
        // engine the PWA targets, and `playwright install chromium` fetches just this one.
        channel: 'chromium',
      },
    },
    ...(fidelity
      ? [
          {
            name: 'fidelity',
            testMatch: /fidelity\/.*\.spec\.ts/,
            // One LibreOffice conversion and one measurement per test: a retry would only repeat
            // a slow, deterministic failure.
            retries: 0,
            use: {
              ...devices['Desktop Chrome'],
              channel: 'chromium',
            },
          },
        ]
      : []),
  ],
  webServer: existsSync(distEntry)
    ? {
        command: 'pnpm preview',
        url: `http://localhost:${PORT}/editor/`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    : undefined,
});
