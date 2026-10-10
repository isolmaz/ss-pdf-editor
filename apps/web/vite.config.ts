/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { hosting } from '../../tools/vite/hosting.mjs';
import { phosphorWeights } from '../../tools/vite/phosphor-weights.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// `pnpm coverage` builds with `COVERAGE_BUILD=1` (see `build.minify`).
const coverageBuild = process.env.COVERAGE_BUILD === '1';

// The React Compiler memoises the shell and `pdf-ui`, the only packages that import React, except
// the first-paint modules that gain little from it. A compiled module carries a memo cache that
// roughly doubles its code and gzips badly, and the first-paint budget (`BUILD_BUDGETS` in
// `packages/shared/src/limits.ts`) pays for every compiled module the entry chunk holds. So the
// scope follows the chunk graph:
//   - Compiled: everything in the editor chunk (`features/shell/editor.ts`: the docks, tool rail
//     and strip, viewer, panels), where the renders are, and from the first-paint graph `App`,
//     which stabilises the props it hands the shell, and the status bar with its
//     `usePresentation` hook and `Tooltip`.
//   - Not compiled: the header and its menu bar, the shell body, the home screen, the banners
//     and overlays, the dialog/result/save hosts, the settings pickers, and the `features/`
//     hooks, stores and actions (`.ts` files). They render a few times per session, or only
//     when their own store changes.
// The coverage build leaves the compiler out: its output carries memo-cache branches
// (`$[0] !== x`) that the source maps attribute to the component's lines, where the unit suite
// counts no such branches, so the merged report would list them as uncovered. Vitest never
// loads this config (the root `vitest.config.ts` has no plugins), so the unit suite runs the
// sources uncompiled.
const compilerPreset = reactCompilerPreset();
const reactCompiler = babel({
  presets: [
    {
      ...compilerPreset,
      rolldown: {
        ...compilerPreset.rolldown,
        filter: {
          ...compilerPreset.rolldown.filter,
          id: {
            include: [
              /[\\/]packages[\\/]pdf-ui[\\/]src[\\/]/,
              /[\\/]apps[\\/]web[\\/]src[\\/](?:App\.tsx$|components[\\/]|features[\\/])/,
            ],
            exclude: [
              /[\\/]components[\\/](?:HomeScreen|UpdateBanner|ActivityOverlay|ModernEditorHeader|PageNavigation)\.tsx$/,
              /[\\/]features[\\/].*(?:(?:Forms|Open|Export|Results|Save|Dialog|Stamp)Surfaces?|ShellOverlays|ShellHeader|ShellBody|SignatureWarningPrompt)\.tsx$/,
              /[\\/]features[\\/].*\.ts$/,
              /[\\/]pdf-ui[\\/]src[\\/](?:commands[\\/]MenuBar|components[\\/](?:Language|Theme)Selector|viewer[\\/]ContextMenu|ops[\\/](?:StampPlacement|FieldCandidate)Layer)\.tsx?$/,
            ],
          },
        },
      },
    },
  ],
});

// The editor is served at /editor/; the landing owns /.
export default defineConfig({
  base: '/editor/',
  plugins: [
    phosphorWeights(),
    react(),
    ...(coverageBuild ? [] : [reactCompiler]),
    tailwindcss(),
    ...hosting({ repoRoot, relaxDevCsp: true }),
  ],
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    cssTarget: ['chrome123', 'firefox120', 'safari17.5'],
    sourcemap: true,
    // `pnpm coverage` builds unminified, so the e2e run's coverage maps onto the same
    // statements and branches the unit suite counts (`tools/coverage/report.mjs`).
    minify: !coverageBuild,
  },
  // The Ghostscript worker imports its engine at runtime, which a classic (IIFE) worker
  // bundle cannot do everywhere; module workers can.
  worker: { format: 'es' },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
