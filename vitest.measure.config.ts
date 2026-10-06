import { defineConfig } from 'vitest/config';

/**
 * The measurement configuration.
 *
 * Deliberately separate from the default one: `pnpm measure:model` reports numbers and
 * asserts nothing, so it must not run inside `pnpm unit` — a benchmark on the commit path
 * is a benchmark whose thresholds get relaxed until it stops meaning anything. Both
 * configurations resolve the workspace packages through the same Vite pipeline, so the
 * measured code is the code that ships, not a copy.
 */
export default defineConfig({
  test: {
    include: ['tools/measure/**/*.measure.ts'],
    environment: 'node',
    testTimeout: 120_000,
    // One worker: the numbers are about the code, not about how many cores the machine
    // has, and a parallel worker competing for the CPU makes them unreproducible.
    // One worker: the numbers are about the code, not about how many cores the machine
    // has, and a parallel worker competing for the CPU makes them unreproducible.
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
  },
});
