/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { hosting } from '../../tools/vite/hosting.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Landing + legal pages: static HTML on the shared token layer, no framework
// JS (PLAN.md §4.7, K31). Phase 0 delivers the shell; content lands at Phase 5.
export default defineConfig({
  plugins: [tailwindcss(), ...hosting({ repoRoot })],
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    cssTarget: ['chrome123', 'firefox120', 'safari17.5'],
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        gizlilik: fileURLToPath(new URL('gizlilik.html', import.meta.url)),
        kosullar: fileURLToPath(new URL('kosullar.html', import.meta.url)),
        en_index: fileURLToPath(new URL('en/index.html', import.meta.url)),
        en_privacy: fileURLToPath(new URL('en/privacy.html', import.meta.url)),
        en_terms: fileURLToPath(new URL('en/terms.html', import.meta.url)),
      },
    },
  },
  server: { port: 5175, strictPort: true },
  preview: { port: 4175, strictPort: true },
});
