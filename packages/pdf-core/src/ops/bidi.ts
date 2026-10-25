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

/** The classes of UAX #9 (table 4) that a word of a right-to-left script, its numbers and its Latin letters tell apart. */
export type BidiClass = 'L' | 'R' | 'AL' | 'EN' | 'AN' | 'ES' | 'ET' | 'CS' | 'ON';

const ARABIC_BLOCKS = /[؀-޿ࡠ-ࣿﭐ-﷿ﹰ-﻿]/;
const EUROPEAN_DIGIT = /[0-9۰-۹]/;
const ARABIC_DIGIT = /[٠-٩٫٬]/;
const EUROPEAN_SEPARATOR = /[+\-−]/;
const EUROPEAN_TERMINATOR = /[#$%¢-¥°٪‰‱₠-⃏]/;
const COMMON_SEPARATOR = /[,./: ]/;

/** The class of one unit (a grapheme cluster), by its first character; anything else is a neutral. */
export function bidiClass(unit: string): BidiClass {
  const first = String.fromCodePoint(unit.codePointAt(0) as number);
  if (EUROPEAN_DIGIT.test(first)) return 'EN';
  if (ARABIC_DIGIT.test(first)) return 'AN';
  if (EUROPEAN_SEPARATOR.test(first)) return 'ES';
  if (EUROPEAN_TERMINATOR.test(first)) return 'ET';
  if (COMMON_SEPARATOR.test(first)) return 'CS';
  const direction = charDirection(first);
  if (direction === null) return 'ON';
  if (direction === 'ltr') return 'L';
  return ARABIC_BLOCKS.test(first) ? 'AL' : 'R';
}

/**
 * Where the units of one right-to-left paragraph stand on the page, left to right: indices into
 * `classes`, which are in reading order. This is the algorithm of UAX #9 for a single embedding
 * level, forwards: numbers and their separators (rules W2–W7), neutrals (N1–N2), the levels (I1–I2)
 * and the reversals (L2). A producer that draws glyphs in this order is read back in reading order
 * by an extractor that runs the algorithm over what the page shows. Rule L4, the mirrored glyph of
 * a bracket, is left out: it only changes how a glyph looks, and extractors do not undo it.
 */
export function displayOrder(classes: readonly BidiClass[]): number[] {
  const types = [...classes];
  const count = types.length;
  let strong: BidiClass = 'R';
  for (let at = 0; at < count; at += 1) {
    const type = types[at];
    if (type === 'L' || type === 'R' || type === 'AL') strong = type;
    else if (type === 'EN' && strong === 'AL') types[at] = 'AN';
  }
  for (let at = 0; at < count; at += 1) {
    if (types[at] === 'AL') types[at] = 'R';
  }
  for (let at = 1; at < count - 1; at += 1) {
    const before = types[at - 1];
    if (types[at] === 'ES' && before === 'EN' && types[at + 1] === 'EN') types[at] = 'EN';
    else if (types[at] === 'CS' && (before === 'EN' || before === 'AN') && types[at + 1] === before) {
      types[at] = before;
    }
  }
  for (let at = 0; at < count; at += 1) {
    if (types[at] !== 'EN') continue;
    for (let back = at - 1; types[back] === 'ET'; back -= 1) types[back] = 'EN';
    for (let ahead = at + 1; types[ahead] === 'ET'; ahead += 1) types[ahead] = 'EN';
  }
  strong = 'R';
  for (let at = 0; at < count; at += 1) {
    const type = types[at];
    if (type === 'ES' || type === 'ET' || type === 'CS') types[at] = 'ON';
    else if (type === 'L' || type === 'R') strong = type;
    else if (type === 'EN' && strong === 'L') types[at] = 'L';
  }
  // A run of neutrals takes the direction of the letters on both sides when they agree (a number
  // counts as right-to-left), and the paragraph's, right-to-left, when they do not.
  for (let at = 0; at < count; at += 1) {
    if (types[at] !== 'ON') continue;
    let end = at;
    while (types[end] === 'ON') end += 1;
    types.fill(types[at - 1] === 'L' && types[end] === 'L' ? 'L' : 'R', at, end);
    at = end - 1;
  }
  // Level 1 is right-to-left letters; left-to-right letters and numbers sit one level above it. Reversing
  // the level-2 runs first and then the whole line is rule L2.
  const order = types.map((_type, at) => at);
  let start = -1;
  for (let at = 0; at <= count; at += 1) {
    const raised = at < count && types[at] !== 'R';
    if (raised && start === -1) start = at;
    else if (!raised && start !== -1) {
      reverse(order, start, at - 1);
      start = -1;
    }
  }
  return order.reverse();
}
