import { defineConfig } from 'vitest/config';

/**
 * The unit suite's boundary.
 *
 * Vitest's default glob is `**\/*.{test,spec}.?(c|m)[jt]s?(x)`, which also matches
 * `e2e/*.spec.ts` — Playwright's files. Those import `playwright/test`, whose
 * `describe`/`test` are a different implementation: Vitest collects them, they throw at
 * collection time, and the unit gate fails for a reason that has nothing to do with a unit
 * test. `tsconfig.json` includes `e2e/**` for typechecking, so the two suites live in the
 * same tree and the boundary has to be stated rather than inferred.
 *
 * The measurement suite (`tools/measure/**`) is excluded for the opposite reason: it
 * reports numbers instead of asserting them, and runs under `vitest.measure.config.ts`.
 */
export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/src/**/*.test.tsx',
      'apps/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.tsx',
    ],
    environment: 'node',
    // MuPDF loads from the installed package in Node (`vitest.setup.ts`).
    setupFiles: ['./vitest.setup.ts'],
  },
});
