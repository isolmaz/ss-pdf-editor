/**
 * Reading order of right-to-left text (Hebrew, Arabic, Syriac, Thaana), for the exports that
 * rebuild a line from pieces laid out on the page.
 *
 * A PDF draws glyphs at places, and the engines hand text over line by line: pdf.js and MuPDF
 * each undo the bidirectional algorithm inside one run of text (a run of Hebrew comes back as
 * the word is written and read), but the runs of a line — the words a producer showed one at a
 * time, a Latin name between two Hebrew words, a number — still come in the order they stand
 * on the page, left to right. In right-to-left text the first word is the rightmost, so sorting
 * by position reads the line backwards.
 *
 * The pieces are put back by the algorithm's own reordering (UAX #9, rule L2), run the other
 * way: from the order on the page to the order of reading. A piece is a unit that keeps its
 * inner order (a pdf.js item, a run of characters); only whole units move. The callers leave a
 * line without a right-to-left character alone.
 */

/** Which way a piece of text runs: strong right-to-left or left-to-right, `null` for neither (spaces, digits, punctuation). */
export type Direction = 'rtl' | 'ltr' | null;

/** The blocks of the right-to-left scripts: Hebrew, Arabic and its supplements, Syriac, Thaana, N'Ko, and the presentation forms. */
const RTL_BLOCKS = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const LETTER = /\p{L}/u;

/** Whether the text holds a character of a right-to-left script (a letter, a mark or a digit of it). */
export function hasRtlScript(text: string): boolean {
  return RTL_BLOCKS.test(text);
}

/** The direction of one character: a letter has one, a digit, a space, a mark or a sign does not. */
export function charDirection(c: string): Direction {
  if (!LETTER.test(c)) return null;
  return RTL_BLOCKS.test(c) ? 'rtl' : 'ltr';
}

/** How many letters of the text run right to left, and how many left to right. */
export function letterCounts(text: string): { readonly rtl: number; readonly ltr: number } {
  let rtl = 0;
  let ltr = 0;
  for (const c of text) {
    const direction = charDirection(c);
    if (direction === 'rtl') rtl += 1;
    else if (direction === 'ltr') ltr += 1;
  }
  return { rtl, ltr };
}

/**
 * Each neutral unit takes the direction of the strong units on both sides when they agree, and
 * the paragraph's direction when they do not (rules N1 and N2); a neutral at an end is between
 * that end and the strong unit beside it, which the paragraph's direction stands for.
 */
export function resolveNeutrals(directions: readonly Direction[], rtlBase: boolean): ('rtl' | 'ltr')[] {
  const base = rtlBase ? 'rtl' : 'ltr';
  // The strong direction before and after each unit, in one pass each way; the paragraph's own
  // direction stands beyond both ends (the algorithm's `sos` and `eos`).
  const before: ('rtl' | 'ltr')[] = [];
  const after: ('rtl' | 'ltr')[] = [];
  let seen: 'rtl' | 'ltr' = base;
  for (const direction of directions) {
    before.push(seen);
    seen = direction ?? seen;
  }
  seen = base;
  for (let at = directions.length - 1; at >= 0; at -= 1) {
    after[at] = seen;
    seen = directions[at] ?? seen;
  }
  return directions.map((direction, at) => {
    if (direction !== null) return direction;
    const left = before[at] as 'rtl' | 'ltr';
    return left === after[at] ? left : base;
  });
}

/**
 * The order in which units laid out left to right on the page are read: indices into
 * `directions`. `rtlBase` is the direction of the paragraph — the first unit read is its
 * rightmost, and a run of left-to-right units inside keeps its own left-to-right order.
 *
 * The page order is the reading order after rule L2 of the algorithm (reverse every run of
 * units at an embedding level, from the highest level down to the lowest odd one), so reading
 * order is that rule's undoing: the same reversals, from the lowest level up. Levels are the
 * algorithm's: in a right-to-left paragraph right-to-left units are level 1 and left-to-right
 * ones level 2, in a left-to-right paragraph they are level 1 and level 0.
 */
export function readingOrder(directions: readonly Direction[], rtlBase: boolean): number[] {
  const order = directions.map((_direction, at) => at);
  const resolved = resolveNeutrals(directions, rtlBase);
  const levels = resolved.map((direction) => (direction === 'rtl' ? 1 : rtlBase ? 2 : 0));
  const highest = Math.max(...levels);
  // `order` is the arrangement being undone; a unit takes its level with it as it moves, so the
  // runs of each pass are read from the arrangement the passes before it left.
  for (let level = 1; level <= highest; level += 1) {
    let start = -1;
    for (let at = 0; at <= order.length; at += 1) {
      const inRun = at < order.length && (levels[order[at] as number] as number) >= level;
      if (inRun && start === -1) start = at;
      else if (!inRun && start !== -1) {
        reverse(order, start, at - 1);
        start = -1;
      }
    }
  }
  return order;
}

function reverse(list: number[], from: number, to: number): void {
  for (let low = from, high = to; low < high; low += 1, high -= 1) {
    const kept = list[low] as number;
    list[low] = list[high] as number;
    list[high] = kept;
  }
}
