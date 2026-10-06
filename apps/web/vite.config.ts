/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { hosting } from '../../tools/vite/hosting.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// The editor is served at /editor/ (K31); the landing owns /.
export default defineConfig({
  base: '/editor/',
  plugins: [react(), tailwindcss(), ...hosting({ repoRoot, relaxDevCsp: true })],
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssTarget: ['chrome123', 'firefox120', 'safari17.5'],
    sourcemap: true,
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
