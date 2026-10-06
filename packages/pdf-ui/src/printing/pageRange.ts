/**
 * Page-range parsing for the print dialog ("printing with
 * page range and scale").
 *
 * The field is free text, so the parser is forgiving exactly where a keyboard
 * differs from ASCII and strict where guessing would print the wrong pages:
 * `1-3, 5, 8-10` is the contract; `;` works like `,`; spaces are allowed around
 * the dash (`1 - 3`); the dashes a Turkish keyboard layout, a numeric keypad or
 * autocorrect produce (`–`, `—`, `−`, the non-breaking hyphen) read as `-`; a
 * range typed backwards (`3-1`) prints 1–3; every page number is clamped to
 * `1..pageCount`.
 *
 * Duplicates collapse and the result is ascending, so the renderer walks the
 * list once and never sorts or de-duplicates. Nothing here throws: an unreadable
 * token or a selection with no page in it is a value the dialog can show.
 */

/** What {@link parsePageRange} makes of the user's text. */
export type PageRangeResult =
  | { readonly ok: true; readonly pages: readonly number[] }
  | { readonly ok: false; readonly reason: 'invalid' | 'empty'; readonly value: string };

/**
 * Dashes other than ASCII `-`: U+2010..U+2015 (hyphen to horizontal bar), U+2212
 * (minus), U+FE63 and U+FF0D (small and fullwidth hyphen-minus).
 */
const DASHES = /[\u2010-\u2015\u2212\uFE63\uFF0D]/g;

/** A pasted range carries non-breaking spaces; U+00A0, U+2007 and U+202F. */
const NON_BREAKING_SPACES = /[\u00A0\u2007\u202F]/g;

/** `,` is the documented separator, `;` the one several European layouts print. */
const SEPARATORS = /[,;]+/;

const DIGITS = /^\d+$/;

/**
 * Parses one range field into the 1-based pages to print.
 *
 * `value: ''` is an empty selection, not an unreadable one; `reason` tells the
 * two apart so the dialog can show `print.emptyRange` or `print.invalidRange`
 * with the offending token.
 */
export function parsePageRange(value: string, pageCount: number): PageRangeResult {
  // No pages to select from: the same outcome as an empty field, so the caller
  // shows one message for both.
  if (pageCount < 1) return { ok: false, reason: 'empty', value: '' };

  const selected = new Set<number>();
  for (const part of value.replace(DASHES, '-').replace(NON_BREAKING_SPACES, ' ').split(SEPARATORS)) {
    const token = part.trim();
    // '1,,2' and a trailing comma are not errors.
    if (token.length === 0) continue;
    const range = readToken(token, pageCount);
    if (range === null) return { ok: false, reason: 'invalid', value: token };
    for (let page = range[0]; page <= range[1]; page += 1) selected.add(page);
  }

  if (selected.size === 0) return { ok: false, reason: 'empty', value: '' };
  return { ok: true, pages: [...selected].sort((left, right) => left - right) };
}

/**
 * One `n` or `n-m` token as a clamped `[first, last]` pair, or `null` when the
 * token is not a range at all. A second dash (`1-2-3`) makes the two halves
 * ambiguous, so it is rejected instead of guessed at.
 */
function readToken(token: string, pageCount: number): readonly [number, number] | null {
  const dash = token.indexOf('-');
  if (dash === -1) {
    const page = pageOf(token);
    return page === null ? null : [clamp(page, pageCount), clamp(page, pageCount)];
  }
  if (dash !== token.lastIndexOf('-')) return null;

  const from = pageOf(token.slice(0, dash).trim());
  const to = pageOf(token.slice(dash + 1).trim());
  if (from === null || to === null) return null;
  // '3-1' is unambiguous, just typed backwards.
  return [clamp(Math.min(from, to), pageCount), clamp(Math.max(from, to), pageCount)];
}

function pageOf(text: string): number | null {
  return DIGITS.test(text) ? Number.parseInt(text, 10) : null;
}

function clamp(page: number, pageCount: number): number {
  return Math.min(Math.max(page, 1), pageCount);
}
