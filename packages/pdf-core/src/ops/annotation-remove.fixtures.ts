/**
 * Hand-written pages for annotation removal: the `/Annots` array is spelled out, so entries no
 * writer would produce (a direct dictionary, an integer, one object listed twice, an object of
 * generation 5, a reference to nothing) are exactly what the remover reads.
 */

import { handPdf } from './forms.fixtures';

/** A `/Square` at a distinct rectangle: annotation `n` of a fixture. */
export const square = (n: number, extra = ''): string =>
  `<</Type/Annot/Subtype/Square/Rect[${n} ${n} ${n + 10} ${n + 10}]${extra}>>`;

/**
 * A file whose page 1 (object 3) has `/Annots` `annots` and, when `second` is given, a page 2
 * (object 4) with `/Annots` `second`. `extra` holds the annotation objects (numbers from 10).
 * `annots: null` leaves the page without the key.
 */
export function annotatedPages(options: {
  readonly annots: string | null;
  readonly second?: string | null;
  readonly extra: Readonly<Record<number, string>>;
}): Uint8Array {
  const hasSecond = options.second !== undefined;
  const annots = (value: string | null | undefined) =>
    value === null || value === undefined ? '' : `/Annots ${value}`;
  const objects: Record<number, string> = {
    1: '<</Type/Catalog/Pages 2 0 R>>',
    2: `<</Type/Pages/Kids[3 0 R${hasSecond ? ' 4 0 R' : ''}]/Count ${hasSecond ? 2 : 1}>>`,
    3: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]${annots(options.annots)}>>`,
    ...options.extra,
  };
  if (hasSecond) objects[4] = `<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]${annots(options.second)}>>`;
  return handPdf(objects);
}

/** `bytes` with object `number` given generation `generation` (in its header and its xref entry). */
export function withGeneration(bytes: Uint8Array, number: number, generation: number): Uint8Array {
  const lines = new TextDecoder().decode(bytes).split('\n');
  const header = lines.indexOf(`${number} 0 obj`);
  const xref = lines.indexOf('xref');
  const entry = xref + 2 + number;
  if (header < 0 || xref < 0) throw new Error(`object ${number} not found`);
  lines[header] = `${number} ${generation} obj`;
  lines[entry] = (lines[entry] ?? '').replace('00000 n', `${String(generation).padStart(5, '0')} n`);
  return new TextEncoder().encode(lines.join('\n'));
}
