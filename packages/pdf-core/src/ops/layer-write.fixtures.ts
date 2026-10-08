/**
 * Hand-written layer files: the optional-content structure is spelled out object by object, so
 * shapes a producer-friendly builder would not emit (a PDF-1.4 `/OCGs` dictionary, an entry that
 * points at an integer, an `/AS` list with a number in it) are exactly what the writer reads.
 */

import { handPdf } from './forms.fixtures';

/** The three groups every file has: `A` (object 10), `B` (11) and `C` (12). */
const GROUPS = {
  10: '<</Type/OCG/Name(A)>>',
  11: '<</Type/OCG/Name(B)>>',
  12: '<</Type/OCG/Name(C)>>',
};

/**
 * A file with `/OCProperties` (object 6) listing `ocgs` and, unless `config` is `null`, the
 * default configuration `config` (object 7). `ocProperties: false` leaves the catalog without
 * optional content. `extra` adds or replaces objects; `pages` is 1 or 2.
 */
export function layerPdf(
  options: {
    readonly ocgs?: string;
    readonly config?: string | null;
    readonly ocProperties?: boolean;
    readonly pages?: 1 | 2;
    readonly extra?: Readonly<Record<number, string>>;
  } = {},
): Uint8Array {
  const config = options.config === undefined ? '<<>>' : options.config;
  const pages = options.pages ?? 1;
  const objects: Record<number, string> = {
    1: `<</Type/Catalog/Pages 2 0 R${options.ocProperties === false ? '' : '/OCProperties 6 0 R'}>>`,
    2: `<</Type/Pages/Kids[3 0 R${pages === 2 ? ' 4 0 R' : ''}]/Count ${pages}>>`,
    3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>',
    6: `<</OCGs ${options.ocgs ?? '[10 0 R 11 0 R 12 0 R]'}${config === null ? '' : '/D 7 0 R'}>>`,
    ...GROUPS,
    ...options.extra,
  };
  if (pages === 2) objects[4] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>';
  if (config !== null) objects[7] = config;
  return handPdf(objects);
}
