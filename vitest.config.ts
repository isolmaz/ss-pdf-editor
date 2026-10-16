import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Phosphor's icons as one file. The package's ES entry imports about 4,500 modules (an SSR, a
 * client and a definition file per icon), and every isolated test file that draws an icon, or a
 * Kumo control that does, had Node load them again: more than half of the suite's time. Its CommonJS
 * build is the same icons in a single file, but named `.js` in a package Node reads as ES modules,
 * so it is copied under a `.cjs` name, next to `pdf-ui`'s own `react`, and the tests import that.
 * Kumo is inlined so its own icon imports take the same alias. The build is untouched. The copy is
 * written only when it is missing or stale: a second run in the same checkout must not rewrite the
 * file under a run that is reading it.
 */
const phosphorBundle = fileURLToPath(
  new URL('./packages/pdf-ui/node_modules/.vitest/phosphor.cjs', import.meta.url),
);
const phosphorBuild = createRequire(new URL('./packages/pdf-ui/package.json', import.meta.url)).resolve(
  '@phosphor-icons/react',
);
if (!existsSync(phosphorBundle) || !readFileSync(phosphorBundle).equals(readFileSync(phosphorBuild))) {
  mkdirSync(dirname(phosphorBundle), { recursive: true });
  copyFileSync(phosphorBuild, phosphorBundle);
}

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
 * The repository's own tooling is tested here too (the `*.test.ts` files under `tools/`: the audit gates and the
 * pipeline's workflow files), so a gate that stops gating fails `pnpm unit`. The measurement
 * suite (the `*.measure.ts` files under `tools/measure/`) is not a test and stays out: it reports numbers
 * instead of asserting them, and runs under `vitest.measure.config.ts`.
 */
export default defineConfig({
  resolve: { alias: [{ find: /^@phosphor-icons\/react$/, replacement: phosphorBundle }] },
  test: {
    server: { deps: { inline: [/@cloudflare\/kumo/] } },
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/src/**/*.test.tsx',
      'apps/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.tsx',
      'tools/**/*.test.ts',
    ],
    environment: 'node',
    // MuPDF loads from the installed package in Node (`vitest.setup.ts`).
    setupFiles: ['./vitest.setup.ts'],
    // `pnpm coverage` (`tools/coverage/report.mjs`): every source file counts, including the
    // ones no test imports; tests, their fixture builders and declarations do not.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.fixtures.ts', '**/*-fixtures.ts', '**/*.d.ts'],
    },
  },
});
