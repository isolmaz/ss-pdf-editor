import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { ScriptCov } from '@bcoe/v8-coverage';
import { test as base, expect, type Page } from 'playwright/test';

/**
 * The one `test` every spec uses: Playwright's, with an automatic referee that fails a
 * test whose page logged a console error or threw an uncaught exception. A flow that
 * "works" while the console burns is not working, and most of what QA found by hand
 * first showed up there (a 404 icon, a render that threw on a turned page).
 *
 * The referee listens on the test's browser context, not on its first page: a test that
 * opens its own pages (two windows on one vault, the print window) is refereed on every
 * one of them.
 *
 * A test that provokes an error on purpose — a damaged file, a wrong password — names
 * the messages it expects with `test.use({ allowedErrors: [/…/] })`; anything else
 * still fails it.
 *
 * With `E2E_COVERAGE` set to a directory (`pnpm coverage` sets it), every page of a test's
 * browser context also records the V8 coverage of the editor's own scripts, and writes it there
 * as its own gzipped file the moment the page is collected: a worker holds no coverage between
 * tests, however many it runs. `tools/coverage/report.mjs` merges the files a batch at a time,
 * maps them back to the sources and adds them to the unit suite's coverage.
 */

const coverageDir = process.env.E2E_COVERAGE;

/** The editor's bundled scripts; the engines under `/engines/` are not this project's code. */
const isEditorScript = (url: string): boolean => {
  try {
    const { pathname } = new URL(url);
    return pathname.startsWith('/editor/assets/') && pathname.endsWith('.js');
  } catch {
    return false;
  }
};

/** Writes one page's coverage to its own file, as the V8 process coverage `mergeProcessCovs` takes. */
const writeRecord = (dir: string, scripts: ScriptCov[]): void => {
  if (scripts.length === 0) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `e2e-${randomUUID()}.json.gz`),
    gzipSync(JSON.stringify({ result: scripts }), { level: 1 }),
  );
};

export const test = base.extend<{ allowedErrors: readonly RegExp[]; pageErrors: readonly string[] }>({
  allowedErrors: [[], { option: true }],
  pageErrors: [
    async ({ context, allowedErrors }, use) => {
      const errors: string[] = [];
      context.on('console', (message) => {
        // A failed load names its URL only in the location, not in the text.
        const where = message.location().url;
        if (message.type() === 'error')
          errors.push(`console: ${message.text()}${where === '' ? '' : ` (${where})`}`);
      });
      context.on('weberror', (error) => errors.push(`exception: ${error.error().message}`));
      await use(errors);
      const unexpected = errors.filter((error) => !allowedErrors.some((pattern) => pattern.test(error)));
      expect(unexpected, 'console errors and uncaught exceptions').toEqual([]);
    },
    { auto: true },
  ],
  context: async ({ context }, use) => {
    if (coverageDir === undefined) {
      await use(context);
      return;
    }
    // Every page of the context records, the test's `page` and the ones a test opens itself
    // (two windows, the print window): coverage starts before `newPage` returns, so before the
    // test can navigate, and is collected before a test's own `close()` would discard it.
    const recording = new Set<Page>();
    const collect = async (page: Page): Promise<void> => {
      if (!recording.delete(page) || page.isClosed()) return;
      const entries = await page.coverage.stopJSCoverage();
      writeRecord(
        coverageDir,
        entries
          .filter((entry) => isEditorScript(entry.url))
          .map(({ scriptId, url, functions }) => ({ scriptId, url, functions })),
      );
    };
    const record = async (page: Page): Promise<void> => {
      if (recording.has(page)) return;
      recording.add(page);
      await page.coverage.startJSCoverage({ resetOnNavigation: false });
      const close = page.close.bind(page);
      page.close = async (options) => {
        await collect(page);
        return close(options);
      };
    };
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      await record(page);
      return page;
    };
    // A page the app opens (a popup) is recorded from its first event on, as early as it can be.
    context.on('page', (page) => void record(page));
    await use(context);
    for (const page of [...recording]) await collect(page);
  },
});

export { expect };
