/**
 * How the document search and find and replace compare text when case does not count, one
 * character (code point) at a time, so that both read a text the same way.
 *
 * `I` is either `i` (English) or `ı` (Turkish), `İ` is `i`, and `ı` stays `ı`: `istanbul` finds
 * `İSTANBUL`, `SIK` finds both `sık` and `sik`, and `sık` never finds `sik`. Folding `ı` to `i`
 * would make the last two the same word. A final sigma `ς` is the letter σ and a long s `ſ` is
 * an s, which lower-casing leaves alone.
 */

/**
 * `I` folds to this marker when case does not count: it matches both `i` and `ı`. It is
 * compared with {@link sameToken}, never with `===`.
 */
export const EITHER_I = '\u0000I';

/** A character as the comparison sees it. */
export function foldToken(value: string, matchCase: boolean): string {
  if (matchCase) return value;
  if (value === 'I') return EITHER_I;
  if (value === 'İ') return 'i';
  if (value === 'ς') return 'σ';
  if (value === 'ſ') return 's';
  return value.toLowerCase();
}

/** Whether two folded characters are the same; `right` is `undefined` past the end of a text. */
export function sameToken(left: string, right: string | undefined): boolean {
  if (left === right) return true;
  if (left === EITHER_I) return right === 'i' || right === 'ı';
  if (right === EITHER_I) return left === 'i' || left === 'ı';
  return false;
}
