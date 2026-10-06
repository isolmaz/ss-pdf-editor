import { test as base, expect } from 'playwright/test';

/**
 * The one `test` every spec uses: Playwright's, with an automatic referee that fails a
 * test whose page logged a console error or threw an uncaught exception. A flow that
 * "works" while the console burns is not working, and most of what QA found by hand
 * first showed up there (a 404 icon, a render that threw on a turned page).
 *
 * A test that provokes an error on purpose — a damaged file, a wrong password — names
 * the messages it expects with `test.use({ allowedErrors: [/…/] })`; anything else
 * still fails it.
 */
export const test = base.extend<{ allowedErrors: readonly RegExp[]; pageErrors: readonly string[] }>({
  allowedErrors: [[], { option: true }],
  pageErrors: [
    async ({ page, allowedErrors }, use) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        // A failed load names its URL only in the location, not in the text.
        const where = message.location().url;
        if (message.type() === 'error')
          errors.push(`console: ${message.text()}${where === '' ? '' : ` (${where})`}`);
      });
      page.on('pageerror', (error) => errors.push(`exception: ${error.message}`));
      await use(errors);
      const unexpected = errors.filter((error) => !allowedErrors.some((pattern) => pattern.test(error)));
      expect(unexpected, 'console errors and uncaught exceptions').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
