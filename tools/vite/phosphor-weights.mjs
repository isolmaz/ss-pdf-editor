/**
 * Drop the icon weights the interface never draws from Phosphor's icon definitions.
 *
 * Every Phosphor icon ships its drawing in six weights (`defs/<Icon>.es.js`: a `Map` of
 * `thin`, `light`, `regular`, `bold`, `fill`, `duotone`), and the `weight` prop picks
 * one at render time — so a bundler cannot know which ones are dead and keeps all six of
 * every icon it imports. The editor draws `regular` (the default), `bold`, `fill` and
 * `duotone`, and Kumo only `regular`, `bold` and `fill`; nothing passes `thin` or
 * `light`. This build-time transform removes those two entries from each definition
 * map, which takes about a third of the icon bytes out of the entry chunk.
 *
 * An icon asked for a dropped weight renders nothing, as Phosphor does for any weight
 * a definition does not have. `tools/vite/phosphor-weights.mjs` is the one place that
 * lists the kept weights: a new `weight="light"` needs it added here.
 */

const DROPPED = ['thin', 'light'];

/** The index just past the `]` that closes the `[` at `open`, skipping string literals. */
function closingBracket(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      for (index += 1; index < source.length && source[index] !== quote; index += 1) {
        if (source[index] === '\\') index += 1;
      }
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** One definition module with the dropped weights' map entries removed. */
export function dropWeights(source) {
  let out = source;
  for (const weight of DROPPED) {
    const entry = new RegExp(`\\[\\s*"${weight}"\\s*,`);
    const match = entry.exec(out);
    if (match === null) continue;
    const end = closingBracket(out, match.index);
    if (end < 0) continue;
    // The entry and the comma that separates it from the next one.
    const after = /^\s*,/.exec(out.slice(end));
    out = out.slice(0, match.index) + out.slice(end + (after === null ? 0 : after[0].length));
  }
  return out;
}

export function phosphorWeights() {
  return {
    name: 'phosphor-weights',
    enforce: 'pre',
    transform(code, id) {
      if (!/@phosphor-icons[\\/]react[\\/]dist[\\/]defs[\\/][^\\/]+\.es\.js$/.test(id.split('?')[0] ?? ''))
        return null;
      const next = dropWeights(code);
      return next === code ? null : { code: next, map: null };
    },
  };
}
