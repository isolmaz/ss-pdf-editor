/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { hosting } from '../../tools/vite/hosting.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Phase 0 spike harness — throwaway prototypes (PLAN.md §9/K21), never shipped.
// Served at the URL root so it can exercise the same /engines/** policy as
// production.
export default defineConfig({
  plugins: hosting({ repoRoot, crossOriginIsolation: true }),
  publicDir: false,
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
