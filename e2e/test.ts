import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeProcessCovs, type ScriptCov } from '@bcoe/v8-coverage';
import { test as base, expect } from 'playwright/test';

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
 * With `E2E_COVERAGE` set to a directory (`pnpm coverage` sets it), the `page` of every
 * test also records the V8 coverage of the editor's own scripts; each worker merges what
 * its tests recorded and writes one file there when it ends. `tools/coverage/report.mjs`
 * maps those files back to the sources and merges them with the unit suite's coverage.
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

export const test = base.extend<
  { allowedErrors: readonly RegExp[]; pageErrors: readonly string[] },
  { v8Coverage: ScriptCov[][] }
>({
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
  v8Coverage: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from this pattern; this one has none.
    async ({}, use) => {
      const recorded: ScriptCov[][] = [];
      await use(recorded);
      if (coverageDir === undefined || recorded.length === 0) return;
      const merged = mergeProcessCovs(recorded.map((result) => ({ result })));
      mkdirSync(coverageDir, { recursive: true });
      writeFileSync(join(coverageDir, `e2e-${randomUUID()}.json`), JSON.stringify(merged));
    },
    { scope: 'worker' },
  ],
  page: async ({ page, v8Coverage }, use) => {
    if (coverageDir === undefined) {
      await use(page);
      return;
    }
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    if (page.isClosed()) return;
    const entries = await page.coverage.stopJSCoverage();
    v8Coverage.push(
      entries
        .filter((entry) => isEditorScript(entry.url))
        .map(({ scriptId, url, functions }) => ({ scriptId, url, functions })),
    );
  },
});

export { expect };
