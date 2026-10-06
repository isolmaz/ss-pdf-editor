/**
 * The build step that drops Phosphor's `thin` and `light` weights. The wrong answers that
 * matter: it cuts a weight the interface draws (an icon vanishes), it breaks the module's
 * syntax (the build fails or, worse, the icon map is wrong), a `]` or a quote inside an
 * SVG path string ends the entry early, and it rewrites files that are not icon
 * definitions.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dropWeights, phosphorWeights } from '../../../tools/vite/phosphor-weights.mjs';

/** The keys of the `Map` a definition module builds, by running it against a stub of React. */
function weightsOf(source: string): string[] {
  const body = source.replace(/^import .*$/m, '').replace(/export \{[\s\S]*\};?\s*$/, 'return a;');
  const map = new Function('e', body)({ createElement: () => null, Fragment: 0 }) as Map<string, unknown>;
  return [...map.keys()];
}

const synthetic = `import * as e from "react";
const a = new Map([
  ["thin", e.createElement("path", { d: "M1 1 ] [ \\" ' ]]" })],
  ["light", e.createElement("path", { d: "M2 2" })],
  ["regular", e.createElement("path", { d: "M3 [3] ]" })],
  ["bold", e.createElement("path", { d: "M4 4" })],
  ["fill", e.createElement("path", { d: "M5 5" })],
  ["duotone", e.createElement("path", { d: "M6 6" })]
]);
export { a as default };
`;

describe('dropWeights', () => {
  it('removes the thin and light entries and keeps the others, brackets in path strings included', () => {
    const out = dropWeights(synthetic) as string;
    expect(weightsOf(synthetic)).toEqual(['thin', 'light', 'regular', 'bold', 'fill', 'duotone']);
    expect(weightsOf(out)).toEqual(['regular', 'bold', 'fill', 'duotone']);
    // The kept entries are untouched, byte for byte.
    expect(out).toContain('["regular", e.createElement("path", { d: "M3 [3] ]" })]');
    expect(out).not.toContain('M1 1');
    expect(out).not.toContain('M2 2');
  });

  it('is a no-op on a module without those weights', () => {
    const only = synthetic.replace(/\s*\["(thin|light)"[^\n]*\n/g, '\n');
    expect(dropWeights(only)).toBe(only);
  });

  it('cuts the weights out of a real Phosphor definition and leaves valid code', () => {
    const require = createRequire(new URL('./', import.meta.url));
    const file = join(dirname(require.resolve('@phosphor-icons/react')), 'defs', 'Acorn.es.js');
    const source = readFileSync(file, 'utf8');
    expect(weightsOf(source).sort()).toEqual(['bold', 'duotone', 'fill', 'light', 'regular', 'thin']);
    expect(weightsOf(dropWeights(source) as string).sort()).toEqual(['bold', 'duotone', 'fill', 'regular']);
  });
});

describe('phosphorWeights plugin', () => {
  const plugin = phosphorWeights() as {
    transform(code: string, id: string): { code: string } | null;
  };

  it('transforms only Phosphor definition modules, whatever the path separator', () => {
    const posix = '/repo/node_modules/@phosphor-icons/react/dist/defs/Acorn.es.js';
    const windows = 'C:\\repo\\node_modules\\@phosphor-icons\\react\\dist\\defs\\Acorn.es.js?v=1';
    expect(plugin.transform(synthetic, posix)?.code).toBe(dropWeights(synthetic));
    expect(plugin.transform(synthetic, windows)?.code).toBe(dropWeights(synthetic));
    expect(plugin.transform(synthetic, '/repo/src/App.tsx')).toBeNull();
    expect(
      plugin.transform(synthetic, '/repo/node_modules/@phosphor-icons/react/dist/index.es.js'),
    ).toBeNull();
  });
});
