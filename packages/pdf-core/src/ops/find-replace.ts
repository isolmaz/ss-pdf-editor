/**
 * Find and replace across the document's text.
 *
 * Every page in scope is read once through the text model (`readDocumentText` →
 * `buildTextPage`, the blocks the text tool edits) and the search runs over each block's
 * glyphs, so every match knows exactly which glyphs it covers. A match is then
 * replaced in one of three ways, tried in this order, and all of them end in the
 * text-edit writer (`applyTextEdit`), which erases the old glyphs for real and verifies
 * the result with pdf.js:
 *
 *   - **line** — when the new text is wider or narrower than the old and more text
 *     follows on the line, the match is replaced and the rest of the line is drawn
 *     again after it, moved by the difference, in the fonts, sizes and colours it
 *     already had. Text after a tab-like gap (a column) keeps its place while the moved
 *     text still ends before it.
 *   - **in place** — the matched glyphs are erased and the replacement is drawn at the
 *     first glyph's own baseline, size and colour, using the space up to the next word
 *     (or, at the end of a line, up to whatever stands to its right). A replacement up
 *     to a fifth wider than that room is drawn smaller to fit (`MIN_INLINE_SCALE`).
 *   - **paragraph** — a match that runs across a line break, or a line that cannot
 *     take the change, lays the whole block out again with every match of the block
 *     replaced. Each word keeps its own font, size and colour (`placeParagraph`), and
 *     the paragraph grows into free space below it before it shrinks.
 *
 * A block whose lines share a baseline — table cells, as MuPDF reports a table row —
 * is never laid out as a paragraph: a match there that fits neither way is left
 * alone and reported. Matches in text the model marks as not editable (scanned,
 * rotated, skewed or Type3 text) are counted and left alone too.
 *
 * **Faces.** The best face is the page's own font (`engines/doc-fonts.ts`): drawn with
 * it, the new text looks exactly like the old. It is used when the font has a code for
 * every character *and* that font object already draws each of those characters — a
 * subset holds only the glyphs its producer used, and a glyph the page shows is one the
 * file has. The proof is kept per font object, not per name: two subsets can share a
 * tagged name after a merge. Otherwise the replacement uses Noto Sans when the old text
 * was Noto Sans, a standard face of the same family, weight and slant (Helvetica, Times,
 * Courier) when WinAnsi can spell it, and Noto Sans after that. A substitute is sized so
 * that it would draw the old text as wide as the old font did (within ±15 %), which keeps
 * its visual size close. A standard face is supplied by the reader rather than embedded,
 * and the report says so.
 */

import { ToolError } from 'pdf-shared';
import {
  buildTextPage,
  candidateMatchesFontName,
  describeFontName,
  type FontCandidate,
  type FontMetrics,
  type GlyphBox,
  matchFont,
  measureEditability,
  measureLineWidth,
  planTextEdit,
  type Rect,
  type ReflowOptions,
  reflowBlock,
  type TextAlign,
  type TextBlock,
  type TextEditInsertLine,
  type TextEditRequest,
  type TextPage,
  type TextStyle,
} from 'pdf-text-engine';
import {
  DOCUMENT_FONT_PREFIX,
  type DocumentFont,
  encodes,
  findFont,
  measureText,
  pageFonts,
} from '../engines/doc-fonts';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { canEncodeWinAnsi } from '../engines/mupdf-write';
import { loadTextFonts, readDocumentText, TEXT_FONT_FILES, type TextFontSet } from '../text-source';
import { formatPageRanges } from './page-ranges';
import { applyTextEdit } from './text-edit';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

export interface FindReplaceQuery {
  /** The text to find. Whitespace runs match any word gap, line breaks included. */
  readonly find: string;
  /** The text to put in its place; `''` deletes every match. */
  readonly replace: string;
  readonly matchCase: boolean;
  /** Only matches with no letter or digit directly before or after them. */
  readonly wholeWord: boolean;
}

export interface FindReplaceOptions extends FindReplaceQuery {
  /** 0-based pages to search, in any order. */
  readonly pages: readonly number[];
  /** The text faces and their metrics; the app's own set when absent (`loadTextFonts`). */
  readonly fonts?: TextFontSet;
}

export interface FindReplaceOutcome extends OperationOutcome {
  readonly replaced: number;
}

/** The faces new text can be drawn with beyond the catalogue, and every face's widths. */
export interface FaceSource {
  /**
   * `doc:<name>` when the page's own font `fontName` can draw `text` with glyphs that font
   * object already draws; `null` otherwise.
   */
  own(pageIndex: number, fontName: string, text: string): string | null;
  /** Reflow metrics of the page's own font, under the same condition as {@link own}. */
  ownMetrics(pageIndex: number, fontName: string, text: string): FontMetrics | null;
  /** Width of `text` drawn with `faceId` at `size` on page `pageIndex`, in points. */
  measure(text: string, faceId: string, size: number, pageIndex: number): number;
}

/** What the plan did with the matches, for the report and the tests. */
export interface FindReplacePlan {
  readonly request: TextEditRequest;
  /** Every match, editable or not. */
  readonly found: number;
  /** Matches that are part of the request. */
  readonly replaced: number;
  /** Matches replaced in place or on a moved line. */
  readonly inPlace: number;
  /** Lines drawn again moved (the line way). */
  readonly movedLines: number;
  /** Replacements drawn smaller than they would fit at. */
  readonly shrunk: number;
  /** Blocks laid out again. */
  readonly reflowed: number;
  /** Re-laid blocks that need more room than there was. */
  readonly overflowed: number;
  /** Matches left alone: not editable, or starting inside a ligature. */
  readonly skipped: number;
  /** Matches in a table-like block that fit no way, left alone. */
  readonly noRoom: number;
  /** Matches that already read as the replacement. */
  readonly unchanged: number;
  readonly changedPages: readonly number[];
  readonly skippedPages: readonly number[];
  /** Standard faces the drawn text uses (reader-supplied, not embedded). */
  readonly standardFaces: readonly string[];
  /** The document's own fonts the drawn text uses. */
  readonly ownFonts: readonly string[];
}

/** The smallest share of the surrounding size an in-place replacement may be drawn at. */
export const MIN_INLINE_SCALE = 0.8;

/** The same for a table cell, where nothing else can make room. */
const MIN_CELL_SCALE = 0.6;

/** The smallest share of its size a re-laid paragraph may shrink to. */
const MIN_REFLOW_SCALE = 0.85;

/** The step a re-laid paragraph shrinks by while it does not fit. */
const REFLOW_STEP = 0.025;

/** The bounds of a substitute face's size calibration (see the module comment). */
const CALIBRATION = [0.85, 1.15] as const;

/** The gap kept before the next word, as a share of the size, when a replacement grows. */
const WORD_GAP_EM = 0.25;

/**
 * How far the erase rectangle stays inside the outer glyphs, in points. The next
 * glyph's origin is exactly the last erased glyph's right edge, and the verifier counts
 * text that *starts inside* a rectangle as left over.
 */
const EDGE_INSET_PT = 0.05;

/** The margin text that grows to the right or down keeps from the page edge. */
const PAGE_MARGIN_PT = 36;

/** How far a one-line block's centre may sit from the page's and still count as centred. */
const CENTRED_TOLERANCE_PT = 3;

/** How far a moved line may run past its block's right edge, in points. */
const LINE_OVERRUN_PT = 0.5;

/** A gap between two words wider than this many ems is a tab stop or a column edge. */
const TAB_GAP_EM = 1;

/** A replacement whose width differs by less than this, in points, moves nothing. */
const MOVE_TOLERANCE_PT = 0.5;

/** How close to the block's right edge a line must end to count as justified, in points. */
const JUSTIFIED_TOLERANCE_PT = 1.5;

/** Standard faces by the writer's id (`text-edit.ts`, `STANDARD_14_MEMBERS`). */
export const STANDARD_FACE_NAMES: Readonly<Record<string, string>> = {
  helvetica: 'Helvetica',
  'helvetica-bold': 'Helvetica-Bold',
  'helvetica-oblique': 'Helvetica-Oblique',
  'helvetica-boldoblique': 'Helvetica-BoldOblique',
  'times-roman': 'Times-Roman',
  'times-bold': 'Times-Bold',
  'times-italic': 'Times-Italic',
  'times-bolditalic': 'Times-BoldItalic',
  courier: 'Courier',
  'courier-bold': 'Courier-Bold',
  'courier-oblique': 'Courier-Oblique',
  'courier-boldoblique': 'Courier-BoldOblique',
};

export async function findReplace(
  bytes: Uint8Array,
  options: FindReplaceOptions,
  context: OperationContext,
): Promise<FindReplaceOutcome> {
  throwIfAborted(context.signal);
  if (searchTokens(options.find, options.matchCase).length === 0) {
    throw new ToolError('value-out-of-range', { engine: 'model', engineMessage: 'empty search text' });
  }
  const pages = [...new Set(options.pages)].sort((left, right) => left - right);
  const inputs = await readDocumentText(bytes, pages, context, (done, total) =>
    context.onProgress?.({
      phase: 'findReplace.read',
      labelKey: 'op.progress.findReplace.read',
      done,
      total,
    }),
  );
  throwIfAborted(context.signal);
  const fonts = options.fonts ?? (await loadTextFonts());
  const models = inputs.map((input) => buildTextPage(input));
  const source = await documentFaces(bytes, models, fonts);
  let plan: FindReplacePlan;
  try {
    plan = planFindReplace(models, options, fonts, source.faces);
  } finally {
    source.close();
  }
  if (plan.found === 0) {
    throw new ToolError('no-match', { engine: 'model', engineMessage: 'no match for the search text' });
  }
  if (plan.replaced === 0 && plan.skipped === 0 && plan.noRoom === 0) {
    throw new ToolError('no-match', {
      engine: 'model',
      engineMessage: 'every match already reads as the replacement',
    });
  }
  if (plan.replaced === 0) {
    throw new ToolError('unsupported', {
      engine: 'model',
      engineMessage: `${plan.skipped} matches in text that cannot be edited, ${plan.noRoom} with no room`,
    });
  }

  throwIfAborted(context.signal);
  const outcome = await applyTextEdit(bytes, { ...plan.request, fonts: TEXT_FONT_FILES }, context);
  const notes: OperationNote[] = [
    note('changed', 'op.note.findReplace.replaced', {
      count: plan.replaced,
      pages: formatPageRanges(plan.changedPages),
    }),
  ];
  if (plan.ownFonts.length > 0) {
    notes.push(note('preserved', 'op.note.findReplace.ownFont', { font: plan.ownFonts.join(', ') }));
  }
  if (plan.movedLines > 0)
    notes.push(note('changed', 'op.note.findReplace.moved', { count: plan.movedLines }));
  if (plan.shrunk > 0) notes.push(note('changed', 'op.note.findReplace.shrunk', { count: plan.shrunk }));
  if (plan.reflowed > 0)
    notes.push(note('changed', 'op.note.findReplace.reflowed', { count: plan.reflowed }));
  if (plan.overflowed > 0) {
    notes.push(note('warning', 'op.note.findReplace.overflow', { count: plan.overflowed }));
  }
  if (plan.noRoom > 0) notes.push(note('lost', 'op.note.findReplace.noRoom', { count: plan.noRoom }));
  if (plan.skipped > 0) {
    notes.push(
      note('lost', 'op.note.findReplace.skipped', {
        count: plan.skipped,
        pages: formatPageRanges(plan.skippedPages),
      }),
    );
  }
  if (plan.standardFaces.length > 0) {
    notes.push(note('changed', 'op.note.findReplace.standardFace', { font: plan.standardFaces.join(', ') }));
  }
  return {
    bytes: outcome.bytes,
    replaced: plan.replaced,
    report: {
      ...outcome.report,
      steps: ['text.find', ...outcome.report.steps],
      notes: [...notes, ...outcome.report.notes],
    },
  };
}

/** The base name of a font name: no subset tag. */
function displayName(name: string): string {
  return name.replace(/^[A-Z]{6}\+/u, '');
}

/**
 * The {@link FaceSource} of a document: its own fonts (one MuPDF document, open until
 * `close`), the catalogue's tables and MuPDF's standard faces. "Already drawn" is read
 * from the models: every glyph carries the font name it was drawn with.
 */
async function documentFaces(
  bytes: Uint8Array,
  models: readonly TextPage[],
  fonts: TextFontSet,
): Promise<{ readonly faces: FaceSource; close(): void }> {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  const byPage = new Map<number, readonly DocumentFont[]>();
  const fontsOf = (pageIndex: number): readonly DocumentFont[] => {
    let found = byPage.get(pageIndex);
    if (found === undefined) {
      found = pageFonts(doc.findPage(pageIndex));
      byPage.set(pageIndex, found);
    }
    return found;
  };
  // What each font *object* has drawn, not each font name: subset tags are unique only within
  // the file that made them, so a merge can put two subsets with different glyphs under one
  // name. A font shared by several pages is one object, and its glyphs count on all of them.
  const objectKeys = new Map<string, string>();
  const fontKey = (pageIndex: number, fontName: string): string => {
    const lookup = `${pageIndex}\u0000${fontName}`;
    let key = objectKeys.get(lookup);
    if (key === undefined) {
      const ref = findFont(fontsOf(pageIndex), fontName)?.ref;
      // A direct font dictionary belongs to the page that holds it.
      key = ref?.isIndirect() === true ? `obj:${ref.asIndirect()}` : `page:${lookup}`;
      objectKeys.set(lookup, key);
    }
    return key;
  };
  const drawn = new Map<string, Set<number>>();
  for (const model of models) {
    for (const block of model.blocks) {
      for (const line of block.lines) {
        for (const word of line.words) {
          for (const glyph of word.glyphs) {
            if (glyph.fontName === undefined) continue;
            const key = fontKey(model.pageIndex, glyph.fontName);
            let points = drawn.get(key);
            if (points === undefined) {
              points = new Set();
              drawn.set(key, points);
            }
            for (const character of glyph.ch) points.add(character.codePointAt(0) ?? 0);
          }
        }
      }
    }
  }
  const usable = (pageIndex: number, fontName: string, text: string): DocumentFont | null => {
    const font = findFont(fontsOf(pageIndex), fontName);
    if (font === null || !encodes(font, text)) return null;
    const points = drawn.get(fontKey(pageIndex, fontName));
    for (const character of text) {
      if (character.trim() !== '' && points?.has(character.codePointAt(0) ?? 0) !== true) return null;
    }
    return font;
  };
  const standard = new Map<string, InstanceType<typeof mupdf.Font>>();
  const faces: FaceSource = {
    own: (pageIndex, fontName, text) =>
      usable(pageIndex, fontName, text) === null ? null : `${DOCUMENT_FONT_PREFIX}${fontName}`,
    ownMetrics: (pageIndex, fontName, text) => {
      const font = usable(pageIndex, fontName, text);
      if (font === null) return null;
      const points = drawn.get(fontKey(pageIndex, fontName));
      return {
        unitsPerEm: 1000,
        glyphAdvance: (point) => measureText(font, String.fromCodePoint(point), 1000),
        ascender: font.ascent,
        descender: font.descent,
        lineGap: 0,
        hasGlyph: (point) => point === 0x20 || (points?.has(point) === true && font.codes.has(point)),
        missing: [],
      };
    },
    measure: (text, faceId, size, pageIndex) => {
      if (faceId.startsWith(DOCUMENT_FONT_PREFIX)) {
        const font = findFont(fontsOf(pageIndex), faceId.slice(DOCUMENT_FONT_PREFIX.length));
        if (font === null) {
          throw new ToolError('internal', { engine: 'model', engineMessage: `no document font ${faceId}` });
        }
        return measureText(font, text, size);
      }
      const metrics = fonts.metrics[faceId];
      if (metrics !== undefined) return measureLineWidth(text, size, metrics);
      const name = STANDARD_FACE_NAMES[faceId];
      if (name === undefined) {
        throw new ToolError('internal', { engine: 'model', engineMessage: `no metrics for face ${faceId}` });
      }
      let font = standard.get(name);
      if (font === undefined) {
        font = new mupdf.Font(name);
        standard.set(name, font);
      }
      let width = 0;
      for (const character of text) {
        width += font.advanceGlyph(font.encodeCharacter(character.codePointAt(0) ?? 0), 0);
      }
      return width * size;
    },
  };
  return { faces, close: () => doc.destroy() };
}

/** A glyph of a block, by position. */
interface GlyphAt {
  readonly line: number;
  readonly word: number;
  readonly index: number;
  readonly glyph: GlyphBox;
}

/** One piece of a block's text: a glyph, or the gap between two words or lines. */
interface Unit {
  /** The text the piece stands for in a re-laid paragraph. */
  readonly text: string;
  /** What the search compares, one entry per code point. */
  readonly tokens: readonly string[];
  readonly glyph: GlyphAt | null;
}

/** A match, as the first and last unit it covers (inclusive). */
interface Hit {
  readonly first: number;
  readonly last: number;
}

/**
 * `I` folds to this marker when case does not count: it matches both `i` (English) and
 * `ı` (Turkish), while `İ` folds to `i` and `ı` stays `ı`. Folding `ı` to `i` instead
 * would make `sık` and `sik` the same word, and they are not.
 */
const EITHER_I = '\u0000I';

function foldToken(value: string, matchCase: boolean): string {
  if (matchCase) return value;
  if (value === 'I') return EITHER_I;
  if (value === 'İ') return 'i';
  return value.toLowerCase();
}

function sameToken(left: string, right: string): boolean {
  if (left === right) return true;
  if (left === EITHER_I) return right === 'i' || right === 'ı';
  if (right === EITHER_I) return left === 'i' || left === 'ı';
  return false;
}

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;

function isWordToken(token: string | undefined): boolean {
  if (token === undefined) return false;
  return WORD_CHARACTER.test(token === EITHER_I ? 'I' : token);
}

/** The search text as tokens: compatibility-normalised, gaps collapsed to one space. */
function searchTokens(find: string, matchCase: boolean): readonly string[] {
  const words = find
    .normalize('NFKC')
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== '');
  return [...words.join(' ')].map((character) => foldToken(character, matchCase));
}

function tokensOf(text: string, matchCase: boolean): readonly string[] {
  return [...text.normalize('NFKC')].map((character) => foldToken(character, matchCase));
}

/**
 * Whether the break after `line` only wraps the paragraph: the next line's first word
 * would not have fitted on this one. Anything else (an address, a list) is a line the
 * author ended, and a re-laid block keeps it as a paragraph break.
 */
function softBreak(block: TextBlock, line: number, size: number): boolean {
  const current = block.lines[line];
  const next = block.lines[line + 1];
  const nextWord = next?.words[0];
  if (current === undefined || nextWord === undefined) return false;
  const width = block.rect[2] - block.rect[0];
  const used = current.rect[2] - current.rect[0];
  return used + WORD_GAP_EM * size + (nextWord.rect[2] - nextWord.rect[0]) > width - 1;
}

/** The block as units: glyphs, word gaps and line breaks. */
function unitsOf(block: TextBlock, matchCase: boolean): readonly Unit[] {
  const units: Unit[] = [];
  for (const [lineIndex, line] of block.lines.entries()) {
    if (lineIndex > 0) {
      const previous = units.at(-1);
      const ended = previous?.glyph?.glyph.ch;
      const opens = line.words[0]?.glyphs[0]?.ch ?? '';
      if (ended === '-' || ended === '\u2010' || ended === '\u00ad') {
        // A hyphen at the end of a line joins the next line without a gap. Before a
        // lower-case letter it is taken for hyphenation (`self-ref-` / `erential`) and
        // dropped, so the word matches whole and a re-laid paragraph does not keep a
        // hyphen in the middle of it; a compound broken at its own hyphen
        // (`self-` / `service`) loses that hyphen too, which no rule without a
        // dictionary can tell apart.
        if (previous !== undefined && /^\p{Ll}/u.test(opens)) {
          units[units.length - 1] = { ...previous, text: '', tokens: [] };
        }
      } else {
        const soft = softBreak(block, lineIndex - 1, block.style.fontSize);
        units.push({ text: soft ? ' ' : '\n', tokens: [' '], glyph: null });
      }
    }
    for (const [wordIndex, word] of line.words.entries()) {
      if (wordIndex > 0) units.push({ text: ' ', tokens: [' '], glyph: null });
      for (const [index, glyph] of word.glyphs.entries()) {
        // A soft hyphen is a break opportunity, not text: it neither matches nor
        // survives a re-laid paragraph.
        const soft = glyph.ch === '\u00ad';
        units.push({
          text: soft ? '' : glyph.ch,
          tokens: soft ? [] : tokensOf(glyph.ch, matchCase),
          glyph: { line: lineIndex, word: wordIndex, index, glyph },
        });
      }
    }
  }
  return units;
}

/**
 * Non-overlapping matches in the block, left to right. A match has to begin and end on
 * a unit boundary — `ield` inside a glyph `ﬁ` + `eld` covers half a glyph, which no
 * erase can remove — and such a match is counted in `unaligned`.
 */
function findHits(
  units: readonly Unit[],
  needle: readonly string[],
  wholeWord: boolean,
): { readonly hits: readonly Hit[]; readonly unaligned: number } {
  const tokens: string[] = [];
  const owner: number[] = [];
  const starts = new Set<number>();
  for (const [index, unit] of units.entries()) {
    if (unit.tokens.length > 0) starts.add(tokens.length);
    for (const token of unit.tokens) {
      tokens.push(token);
      owner.push(index);
    }
  }
  const hits: Hit[] = [];
  let unaligned = 0;
  let at = 0;
  while (at + needle.length <= tokens.length) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (!sameToken(needle[offset] ?? '', tokens[at + offset] ?? '')) {
        matches = false;
        break;
      }
    }
    const end = at + needle.length;
    if (matches && wholeWord && (isWordToken(tokens[at - 1]) || isWordToken(tokens[end]))) matches = false;
    if (!matches) {
      at += 1;
      continue;
    }
    if (!starts.has(at) || (end < tokens.length && !starts.has(end))) {
      unaligned += 1;
      at += 1;
      continue;
    }
    hits.push({ first: owner[at] ?? 0, last: owner[end - 1] ?? 0 });
    at = end;
  }
  return { hits, unaligned };
}

/** The writer's id for a standard face of this family, weight and slant. */
function standardFaceId(family: TextStyle['fontFamily'], bold: boolean, italic: boolean): string {
  if (family === 'serif') {
    if (bold) return italic ? 'times-bolditalic' : 'times-bold';
    return italic ? 'times-italic' : 'times-roman';
  }
  const base = family === 'mono' ? 'courier' : 'helvetica';
  if (bold) return `${base}-${italic ? 'boldoblique' : 'bold'}`;
  return italic ? `${base}-oblique` : base;
}

/** The face a replacement is drawn with (see the module comment for the order). */
function replacementFace(
  pageIndex: number,
  glyph: GlyphBox,
  block: TextBlock,
  text: string,
  fonts: TextFontSet,
  faces: FaceSource,
): string {
  const name = glyph.fontName ?? block.style.fontName ?? '';
  const own = name === '' ? null : faces.own(pageIndex, name, text);
  if (own !== null) return own;
  const shipped = fonts.catalog.candidates.find((candidate) => candidateMatchesFontName(candidate, name));
  const shippedMetrics = shipped === undefined ? undefined : fonts.metrics[shipped.id];
  if (shipped !== undefined && shippedMetrics !== undefined && missingIn(text, shippedMetrics) === 0) {
    return shipped.id;
  }
  const info = name === '' ? null : describeFontName(name);
  const family = info === null || info.family === 'unknown' ? block.style.fontFamily : info.family;
  const bold = info === null ? block.style.bold : info.bold;
  const italic = info === null ? block.style.italic : info.italic;
  if (canEncodeWinAnsi(text)) return standardFaceId(family, bold, italic);
  return matchFont({ ...block.style, fontFamily: family, bold, italic }, text, fonts.catalog).font.id;
}

/**
 * The size a substitute face draws at: `size` scaled so that it would draw `original`
 * as wide as `extent`, within {@link CALIBRATION}. The page's own font and a face that
 * cannot spell the original keep `size`.
 */
function calibratedSize(
  pageIndex: number,
  face: string,
  original: string,
  extent: number,
  size: number,
  faces: FaceSource,
): number {
  if (face.startsWith(DOCUMENT_FONT_PREFIX) || original.trim() === '' || !(extent > 0)) return size;
  if (STANDARD_FACE_NAMES[face] !== undefined && !canEncodeWinAnsi(original)) return size;
  const natural = faces.measure(original, face, size, pageIndex);
  if (!(natural > 0)) return size;
  const scale = Math.min(CALIBRATION[1], Math.max(CALIBRATION[0], extent / natural));
  return Math.round(size * scale * 100) / 100;
}

/**
 * The face that draws original text exactly as it was: the page's own font, or the
 * standard face the text already used. `null` when neither can.
 */
function sameFace(pageIndex: number, fontName: string, text: string, faces: FaceSource): string | null {
  const own = faces.own(pageIndex, fontName, text);
  if (own !== null) return own;
  const info = describeFontName(fontName);
  if (!info.standard14 || info.subset || info.family === 'unknown' || !canEncodeWinAnsi(text)) return null;
  return standardFaceId(info.family, info.bold, info.italic);
}

function missingIn(text: string, metrics: FontMetrics): number {
  let missing = 0;
  for (const character of text) {
    if (character.trim() !== '' && !metrics.hasGlyph(character.codePointAt(0) ?? 0)) missing += 1;
  }
  return missing;
}

/** The glyph drawn right after this one on its line, or `null` at the line's end. */
function nextGlyph(
  block: TextBlock,
  at: GlyphAt,
): { readonly glyph: GlyphBox; readonly sameWord: boolean } | null {
  const line = block.lines[at.line];
  const word = line?.words[at.word];
  const inWord = word?.glyphs[at.index + 1];
  if (inWord !== undefined) return { glyph: inWord, sameWord: true };
  const following = line?.words[at.word + 1]?.glyphs[0];
  return following === undefined ? null : { glyph: following, sameWord: false };
}

/** Whether some lines of the block share a baseline: table cells, as MuPDF reports a row. */
function tableLike(block: TextBlock): boolean {
  return block.lines.some((line, index) =>
    block.lines.some((other, at) => at > index && Math.abs(other.baseline - line.baseline) < 1),
  );
}

/**
 * The nearest left edge to the right of `x` of anything else in the line's band: another
 * line of the block (a table cell) or another block. `null` when nothing stands there.
 */
function rightObstacle(page: TextPage, block: TextBlock, lineIndex: number, x: number): number | null {
  const band = block.lines[lineIndex]?.rect ?? block.rect;
  let nearest: number | null = null;
  const consider = (rect: Rect): void => {
    if (rect[0] < x - 0.01 || rect[3] <= band[1] || rect[1] >= band[3]) return;
    nearest = nearest === null ? rect[0] : Math.min(nearest, rect[0]);
  };
  for (const [index, line] of block.lines.entries()) if (index !== lineIndex) consider(line.rect);
  for (const other of page.blocks) if (other !== block) consider(other.rect);
  return nearest;
}

/** How far right text that ends line `lineIndex` of `block` may run. */
function lineEndLimit(
  page: TextPage,
  block: TextBlock,
  lineIndex: number,
  right: number,
  size: number,
): number {
  const obstacle = rightObstacle(page, block, lineIndex, right);
  if (obstacle !== null) return Math.max(right, obstacle - size / 2);
  if (lineIndex === block.lines.length - 1 || tableLike(block)) {
    return Math.max(right, block.rect[2], page.width - PAGE_MARGIN_PT);
  }
  return Math.max(right, block.rect[2]) + LINE_OVERRUN_PT;
}

/** Where the glyphs of the plan go: erase rectangles, drawn lines and what they cost. */
interface Placement {
  readonly rects: readonly Rect[];
  readonly lines: readonly TextEditInsertLine[];
  readonly shrunk: number;
}

/** The box of a run of glyphs, inset at both ends by `EDGE_INSET_PT`. */
function eraseBox(glyphs: readonly GlyphAt[]): Rect {
  const head = glyphs[0]?.glyph.rect ?? [0, 0, 0, 0];
  const tail = glyphs.at(-1)?.glyph.rect ?? head;
  const inset = Math.min(EDGE_INSET_PT, (tail[2] - head[0]) / 4);
  return [
    head[0] + inset,
    Math.min(...glyphs.map((entry) => entry.glyph.rect[1])),
    tail[2] - inset,
    Math.max(...glyphs.map((entry) => entry.glyph.rect[3])),
  ];
}

/** The size a replacement of `width` at `size` is drawn at in `room`, or `null` when it would be too small. */
function fittedSize(size: number, width: number, room: number, minimum: number): number | null {
  if (width <= room + 0.01) return size;
  const scale = room / width;
  if (scale < minimum) return null;
  return Math.floor(size * scale * 100) / 100;
}

/** A replacement's face and size for the match `glyphs`, with the old text's own extent. */
function replacementStyle(
  page: TextPage,
  block: TextBlock,
  glyphs: readonly GlyphAt[],
  replacement: string,
  fonts: TextFontSet,
  faces: FaceSource,
): { readonly face: string; readonly size: number; readonly extent: number; readonly x: number } {
  const head = glyphs[0]?.glyph;
  const tail = glyphs.at(-1)?.glyph ?? head;
  const x = head?.origin?.[0] ?? head?.rect[0] ?? 0;
  const extent = (tail?.rect[2] ?? x) - x;
  const size = head?.size ?? block.style.fontSize;
  if (head === undefined || replacement === '') return { face: '', size, extent, x };
  const face = replacementFace(page.pageIndex, head, block, replacement, fonts, faces);
  const original = glyphs.map((entry) => entry.glyph.ch).join('');
  return { face, size: calibratedSize(page.pageIndex, face, original, extent, size, faces), extent, x };
}

/**
 * One in-place replacement, or `null` when the replacement does not fit where the
 * match was at `minimum` of its size.
 */
function placeInPlace(
  page: TextPage,
  block: TextBlock,
  glyphs: readonly GlyphAt[],
  replacement: string,
  fonts: TextFontSet,
  faces: FaceSource,
  minimum: number,
): Placement | null {
  const head = glyphs[0];
  const tail = glyphs.at(-1);
  if (head === undefined || tail === undefined) return null;
  const rect = eraseBox(glyphs);
  if (replacement === '') return { rects: [rect], lines: [], shrunk: 0 };

  const left = head.glyph.rect[0];
  const right = tail.glyph.rect[2];
  const style = replacementStyle(page, block, glyphs, replacement, fonts, faces);
  const { face, size, x } = style;
  const baseline = head.glyph.origin?.[1] ?? block.lines[head.line]?.baseline ?? rect[3];
  const measure = (drawnSize: number): number => faces.measure(replacement, face, drawnSize, page.pageIndex);
  const width = measure(size);
  const drawnLine = (drawnSize: number, at: number): Placement => ({
    rects: [rect],
    lines: [
      {
        text: replacement,
        x: at,
        y: baseline,
        fontSize: drawnSize,
        color: head.glyph.color ?? block.style.color,
        fontId: face,
        width: measure(drawnSize),
      },
    ],
    shrunk: drawnSize < size ? 1 : 0,
  });

  const line = block.lines[head.line];
  const wholeLine =
    line !== undefined &&
    line.words[0]?.glyphs[0] === head.glyph &&
    line.words.at(-1)?.glyphs.at(-1) === tail.glyph;
  const centre = (left + right) / 2;
  // A one-line block has no alignment the model can read; centred on the page is
  // what a title looks like, and that is where the new title belongs too.
  const align =
    block.lines.length === 1 && Math.abs(centre - page.width / 2) <= CENTRED_TOLERANCE_PT
      ? 'center'
      : block.align;
  if (wholeLine && !tableLike(block) && (align === 'center' || align === 'right')) {
    const lone = block.lines.length === 1;
    const half = Math.max(
      (right - left) / 2,
      (block.rect[2] - block.rect[0]) / 2,
      lone ? Math.min(centre - PAGE_MARGIN_PT, page.width - PAGE_MARGIN_PT - centre) : 0,
    );
    const room =
      align === 'center'
        ? 2 * half
        : right - Math.min(left, block.rect[0], lone ? PAGE_MARGIN_PT : block.rect[0]);
    const drawn = fittedSize(size, width, room, minimum);
    if (drawn === null) return null;
    const drawnWidth = measure(drawn);
    return drawnLine(drawn, align === 'center' ? centre - drawnWidth / 2 : right - drawnWidth);
  }

  const next = nextGlyph(block, tail);
  let limit: number;
  if (next?.sameWord === true) limit = next.glyph.rect[0];
  else if (next !== null)
    limit = next.glyph.rect[0] - Math.min(next.glyph.rect[0] - right, WORD_GAP_EM * size);
  else limit = lineEndLimit(page, block, tail.line, right, size);
  const drawn = fittedSize(size, width, Math.max(limit, right) - x, minimum);
  return drawn === null ? null : drawnLine(drawn, x);
}

/**
 * Whether replacing this match should move the rest of its line: the width changes by
 * more than `MOVE_TOLERANCE_PT` (or the match is deleted) and text follows it within
 * the same column — text after a tab-like gap is positioned on its own and stays.
 */
function movesLine(
  page: TextPage,
  block: TextBlock,
  glyphs: readonly GlyphAt[],
  replacement: string,
  fonts: TextFontSet,
  faces: FaceSource,
): boolean {
  const head = glyphs[0];
  const tail = glyphs.at(-1);
  if (head === undefined || tail === undefined) return false;
  const next = nextGlyph(block, tail);
  const size = head.glyph.size ?? block.style.fontSize;
  if (next === null) return false;
  if (!next.sameWord && next.glyph.rect[0] - tail.glyph.rect[2] > TAB_GAP_EM * size) return false;
  if (replacement === '') return true;
  const style = replacementStyle(page, block, glyphs, replacement, fonts, faces);
  const width = faces.measure(replacement, style.face, style.size, page.pageIndex);
  return Math.abs(width - style.extent) > MOVE_TOLERANCE_PT;
}

/**
 * The line way: every match on line `lineIndex` replaced and the text after it drawn
 * again in its own fonts, moved by the difference, up to the end of the line or to the
 * next tab-like gap (text after one keeps its place while the moved text still ends a
 * word gap before it, and moves along otherwise, as a column would). A deleted match
 * takes the word gap after it along. `null` when a stretch of that text cannot be
 * drawn exactly again (`sameFace`), or when the moved line no longer fits.
 */
function placeLine(
  page: TextPage,
  block: TextBlock,
  lineIndex: number,
  matches: readonly (readonly GlyphAt[])[],
  replacement: string,
  fonts: TextFontSet,
  faces: FaceSource,
): Placement | null {
  const line = block.lines[lineIndex];
  if (line === undefined) return null;
  const glyphs: GlyphAt[] = [];
  for (const [word, entry] of line.words.entries()) {
    for (const [index, glyph] of entry.glyphs.entries()) glyphs.push({ line: lineIndex, word, index, glyph });
  }
  const starts = new Map<GlyphBox, readonly GlyphAt[]>();
  for (const match of matches) {
    const head = match[0];
    if (head !== undefined) starts.set(head.glyph, match);
  }

  const rects: Rect[] = [];
  const lines: TextEditInsertLine[] = [];
  let delta = 0;
  // The first erased glyph of the stretch being moved; `null` outside one.
  let stretch: number | null = null;
  const close = (end: number, limit: number): boolean => {
    const last = glyphs[end - 1];
    if (stretch === null || last === undefined) return true;
    if (last.glyph.rect[2] + delta > limit + 0.01) return false;
    rects.push(eraseBox(glyphs.slice(stretch, end)));
    stretch = null;
    delta = 0;
    return true;
  };

  let index = 0;
  while (index < glyphs.length) {
    const head = glyphs[index];
    if (head === undefined) break;
    const size = head.glyph.size ?? block.style.fontSize;
    const previous = glyphs[index - 1];
    if (stretch !== null && previous !== undefined && previous.word !== head.word) {
      const gap = head.glyph.rect[0] - previous.glyph.rect[2];
      if (gap > TAB_GAP_EM * size) close(index, head.glyph.rect[0] - WORD_GAP_EM * size);
    }
    const x = head.glyph.origin?.[0] ?? head.glyph.rect[0];
    const y = head.glyph.origin?.[1] ?? line.baseline;
    const color = head.glyph.color ?? block.style.color;
    const match = starts.get(head.glyph);
    if (match !== undefined) {
      stretch ??= index;
      const tail = match.at(-1) ?? head;
      const style = replacementStyle(page, block, match, replacement, fonts, faces);
      const width =
        replacement === '' ? 0 : faces.measure(replacement, style.face, style.size, page.pageIndex);
      if (replacement !== '') {
        lines.push({
          text: replacement,
          x: x + delta,
          y,
          fontSize: style.size,
          color,
          fontId: style.face,
          width,
        });
      }
      delta += width - (tail.glyph.rect[2] - x);
      const after = glyphs[index + match.length];
      if (replacement === '' && after !== undefined && after.word !== tail.word) {
        const gap = after.glyph.rect[0] - tail.glyph.rect[2];
        if (gap <= TAB_GAP_EM * size) delta -= gap;
      }
      index += match.length;
      continue;
    }
    if (stretch === null) {
      // Before the first match, or after a tab-like gap: this text stays where it is.
      index += 1;
      continue;
    }
    // A run of the original text: one word, one font, up to the next match.
    let end = index + 1;
    while (end < glyphs.length) {
      const candidate = glyphs[end];
      if (
        candidate === undefined ||
        candidate.word !== head.word ||
        candidate.glyph.fontName !== head.glyph.fontName ||
        starts.has(candidate.glyph)
      ) {
        break;
      }
      end += 1;
    }
    const text = glyphs
      .slice(index, end)
      .map((entry) => entry.glyph.ch)
      .join('');
    const face =
      head.glyph.fontName === undefined ? null : sameFace(page.pageIndex, head.glyph.fontName, text, faces);
    if (face === null) return null;
    lines.push({
      text,
      x: x + delta,
      y,
      fontSize: size,
      color,
      fontId: face,
      width: faces.measure(text, face, size, page.pageIndex),
    });
    index = end;
  }

  const last = glyphs.at(-1)?.glyph;
  if (last === undefined) return null;
  const size = last.size ?? block.style.fontSize;
  if (!close(glyphs.length, lineEndLimit(page, block, lineIndex, last.rect[2], size))) return null;
  return { rects, lines, shrunk: 0 };
}

/** The block's text with every match replaced, line breaks as `unitsOf` decided them. */
function replacedText(units: readonly Unit[], hits: readonly Hit[], replacement: string): string {
  let text = '';
  let next = 0;
  for (const hit of hits) {
    for (let index = next; index < hit.first; index += 1) text += units[index]?.text ?? '';
    text += replacement;
    next = hit.last + 1;
  }
  for (let index = next; index < units.length; index += 1) text += units[index]?.text ?? '';
  return text;
}

/** A piece of a re-laid word: one face, one size, one colour. */
interface Atom {
  readonly text: string;
  readonly face: string;
  readonly size: number;
  readonly color: string;
  readonly width: number;
}

/** A paragraph of a re-laid block: its words and its first line's indent. */
interface Paragraph {
  readonly words: Atom[][];
  readonly indent: number;
}

/**
 * The alignment of a block, read from its lines: justified when every line that does not
 * end a paragraph reaches the block's right edge. The model reads a block whose first
 * line is indented or that holds two paragraphs as left-aligned.
 */
function blockAlign(block: TextBlock, units: readonly Unit[]): TextAlign {
  const ends = new Set<number>([block.lines.length - 1]);
  for (const unit of units) {
    if (unit.text === '\n') {
      // The unit after a hard break opens a line; the line before it ends a paragraph.
      const next = units[units.indexOf(unit) + 1]?.glyph?.line;
      if (next !== undefined) ends.add(next - 1);
    }
  }
  const full = block.lines.filter((_line, index) => !ends.has(index));
  if (
    full.length > 0 &&
    full.every((line) => Math.abs(line.rect[2] - block.rect[2]) <= JUSTIFIED_TOLERANCE_PT) &&
    block.align !== 'center'
  ) {
    return 'justify';
  }
  return block.align;
}

/**
 * The paragraphs of a block with every match replaced, as words of atoms that each keep
 * the font, size and colour they were drawn with. `null` when some original text cannot
 * be drawn exactly again (`sameFace`).
 */
function paragraphsOf(
  page: TextPage,
  block: TextBlock,
  units: readonly Unit[],
  hits: readonly Hit[],
  replacement: string,
  fonts: TextFontSet,
  faces: FaceSource,
): Paragraph[] | null {
  const paragraphs: Paragraph[] = [];
  let words: Atom[][] = [];
  let word: Atom[] = [];
  let indent = (block.lines[0]?.rect[0] ?? block.rect[0]) - block.rect[0];
  let run: { glyphs: GlyphAt[] } | null = null;
  const flushRun = (): boolean => {
    if (run === null) return true;
    const head = run.glyphs[0]?.glyph;
    const text = run.glyphs.map((entry) => entry.glyph.ch).join('');
    run = null;
    if (head === undefined || text === '') return true;
    const face = head.fontName === undefined ? null : sameFace(page.pageIndex, head.fontName, text, faces);
    if (face === null) return false;
    const size = head.size ?? block.style.fontSize;
    word.push({
      text,
      face,
      size,
      color: head.color ?? block.style.color,
      width: faces.measure(text, face, size, page.pageIndex),
    });
    return true;
  };
  const flushWord = (): boolean => {
    if (!flushRun()) return false;
    if (word.length > 0) words.push(word);
    word = [];
    return true;
  };
  const starts = new Map(hits.map((hit) => [hit.first, hit]));

  let index = 0;
  while (index < units.length) {
    const unit = units[index];
    if (unit === undefined) break;
    const hit = starts.get(index);
    if (hit !== undefined) {
      if (!flushRun()) return null;
      const glyphs = units
        .slice(hit.first, hit.last + 1)
        .map((entry) => entry.glyph)
        .filter((glyph): glyph is GlyphAt => glyph !== null);
      const style = replacementStyle(page, block, glyphs, replacement, fonts, faces);
      const color = glyphs[0]?.glyph.color ?? block.style.color;
      const pieces = replacement.split(/\s+/u);
      for (const [at, piece] of pieces.entries()) {
        if (at > 0 && !flushWord()) return null;
        if (piece === '') continue;
        word.push({
          text: piece,
          face: style.face,
          size: style.size,
          color,
          width: faces.measure(piece, style.face, style.size, page.pageIndex),
        });
      }
      index = hit.last + 1;
      continue;
    }
    if (unit.glyph === null) {
      if (!flushWord()) return null;
      if (unit.text === '\n') {
        paragraphs.push({ words, indent });
        words = [];
        const opening = units[index + 1]?.glyph?.line;
        const line = opening === undefined ? undefined : block.lines[opening];
        indent = (line?.rect[0] ?? block.rect[0]) - block.rect[0];
      }
      index += 1;
      continue;
    }
    if (unit.text === '') {
      // A dropped hyphen or a soft hyphen: nothing to draw.
      index += 1;
      continue;
    }
    const current: { glyphs: GlyphAt[] } | null = run;
    const head = current?.glyphs[0]?.glyph;
    if (
      current !== null &&
      head !== undefined &&
      (head.fontName !== unit.glyph.glyph.fontName ||
        head.size !== unit.glyph.glyph.size ||
        head.color !== unit.glyph.glyph.color)
    ) {
      if (!flushRun()) return null;
    }
    if (run === null) run = { glyphs: [] };
    (run as { glyphs: GlyphAt[] }).glyphs.push(unit.glyph);
    index += 1;
  }
  if (!flushWord()) return null;
  paragraphs.push({ words, indent });
  return paragraphs;
}

/** The room below the block before anything else on the page starts, as a baseline limit. */
function lowestBaseline(page: TextPage, block: TextBlock, size: number): number {
  let floor = page.height - PAGE_MARGIN_PT;
  for (const other of page.blocks) {
    if (other === block || other.rect[1] < block.rect[3] - 0.5) continue;
    if (other.rect[2] <= block.rect[0] || other.rect[0] >= block.rect[2]) continue;
    floor = Math.min(floor, other.rect[1] - size * 0.3);
  }
  return Math.max(floor, block.lines.at(-1)?.baseline ?? block.rect[3]);
}

/**
 * The paragraph way with every word in its own face: the block's paragraphs broken into
 * lines across the block's width, aligned as the block was, one baseline per `leading`
 * from the first. It grows into the free space below the block first and shrinks (down
 * to `MIN_REFLOW_SCALE`) only after that. `null` when some original text cannot be drawn
 * again, which leaves {@link placeParagraphInOneFace}.
 */
function placeParagraph(
  page: TextPage,
  block: TextBlock,
  units: readonly Unit[],
  hits: readonly Hit[],
  replacement: string,
  fonts: TextFontSet,
  faces: FaceSource,
): (Placement & { readonly overflow: boolean }) | null {
  const paragraphs = paragraphsOf(page, block, units, hits, replacement, fonts, faces);
  if (paragraphs === null) return null;
  const align = blockAlign(block, units);
  const width = block.rect[2] - block.rect[0];
  const size = block.style.fontSize;
  const leading = block.style.leading > 0 ? block.style.leading : size * 1.2;
  const first = block.lines[0]?.baseline ?? block.rect[3];
  const floor = lowestBaseline(page, block, size);
  const space = (atom: Atom, scale: number): number =>
    faces.measure(' ', atom.face, atom.size * scale, page.pageIndex);

  type Laid = { readonly words: Atom[][]; readonly indent: number; readonly last: boolean; natural: number };
  const layout = (scale: number): Laid[] => {
    const lines: Laid[] = [];
    for (const paragraph of paragraphs) {
      let current: Laid = { words: [], indent: paragraph.indent, last: false, natural: 0 };
      for (const word of paragraph.words) {
        const wordWidth = word.reduce((sum, atom) => sum + atom.width * scale, 0);
        const previous = current.words.at(-1)?.at(-1);
        const gap = previous === undefined ? 0 : space(previous, scale);
        if (current.words.length > 0 && current.natural + gap + wordWidth > width - current.indent + 0.01) {
          lines.push(current);
          current = { words: [], indent: 0, last: false, natural: 0 };
          current.words.push(word);
          current.natural = wordWidth;
          continue;
        }
        current.words.push(word);
        current.natural += gap + wordWidth;
      }
      lines.push({ ...current, last: true });
    }
    return lines;
  };

  let scale = 1;
  let laid = layout(scale);
  const fits = (count: number, at: number): boolean => first + (count - 1) * leading * at <= floor + 0.01;
  while (!fits(laid.length, scale) && scale - REFLOW_STEP >= MIN_REFLOW_SCALE - 1e-9) {
    scale = Math.round((scale - REFLOW_STEP) * 1000) / 1000;
    laid = layout(scale);
  }
  const overflow = !fits(laid.length, scale);

  const lines: TextEditInsertLine[] = [];
  for (const [row, line] of laid.entries()) {
    const y = first + row * leading * scale;
    const available = width - line.indent;
    const gaps = line.words.length - 1;
    const stretch = align === 'justify' && !line.last && gaps > 0 ? (available - line.natural) / gaps : 0;
    let x = block.rect[0] + line.indent;
    if (align === 'center') x += (available - line.natural) / 2;
    else if (align === 'right') x += available - line.natural;
    for (const [at, word] of line.words.entries()) {
      if (at > 0) {
        const previous = line.words[at - 1]?.at(-1);
        x += (previous === undefined ? 0 : space(previous, scale)) + stretch;
      }
      for (const atom of word) {
        lines.push({
          text: atom.text,
          x,
          y,
          fontSize: Math.round(atom.size * scale * 100) / 100,
          color: atom.color,
          fontId: atom.face,
          width: atom.width * scale,
        });
        x += atom.width * scale;
      }
    }
  }
  const metrics = fonts.metrics[fonts.catalog.candidates[0]?.id ?? ''];
  if (metrics === undefined) {
    throw new ToolError('font-missing', { engine: 'pdf-text-engine', engineMessage: 'no catalogue metrics' });
  }
  // The erase is the text tool's own: one padded rectangle per line, never reaching a
  // neighbouring block (`planTextEdit` with an empty replacement erases only).
  const erase = planTextEdit({ page, blockId: block.id, replacement: '' }, metrics).erase;
  return {
    rects: erase.flatMap((entry) => entry.rects),
    lines,
    shrunk: 0,
    overflow,
  };
}

/**
 * The paragraph way in one face, for a block whose original text cannot be drawn again
 * word by word: the text tool's own reflow (`planTextEdit`), in the block's own font
 * when it can spell the new text and in the catalogue's best match otherwise.
 */
function placeParagraphInOneFace(
  page: TextPage,
  block: TextBlock,
  text: string,
  fonts: TextFontSet,
  faces: FaceSource,
): Placement & { readonly overflow: boolean } {
  const ownName = block.style.fontName;
  const ownMetrics = ownName === null ? null : faces.ownMetrics(page.pageIndex, ownName, text);
  let face: FontCandidate;
  let metrics: FontMetrics;
  if (ownName !== null && ownMetrics !== null) {
    face = {
      id: `${DOCUMENT_FONT_PREFIX}${ownName}`,
      family: block.style.fontFamily === 'unknown' ? 'sans' : block.style.fontFamily,
      bold: block.style.bold,
      italic: block.style.italic,
      filePath: '',
    };
    metrics = ownMetrics;
  } else {
    face = matchFont(block.style, text, fonts.catalog).font;
    const table = fonts.metrics[face.id];
    if (table === undefined) {
      throw new ToolError('font-missing', {
        engine: 'pdf-text-engine',
        engineMessage: `no metric table for face ${face.id}`,
      });
    }
    metrics = table;
  }
  const size = block.style.fontSize;
  const floor = lowestBaseline(page, block, size);
  const options: ReflowOptions = {
    align: block.align,
    fontSize: size,
    leading: block.style.leading,
    // Down to the next thing below the block: the paragraph grows into free space and
    // shrinks a little rather than run into whatever follows it.
    box: [block.rect[0], block.rect[1], block.rect[2], Math.max(block.rect[3], floor + size * 0.3)],
    minFontSize: size * MIN_REFLOW_SCALE,
  };
  const overflow = text.trim() !== '' && reflowBlock({ block, text, options }, metrics).overflow;
  const request = planTextEdit({ page, blockId: block.id, replacement: text, options, font: face }, metrics);
  return {
    rects: request.erase.flatMap((entry) => entry.rects),
    lines: request.insert.flatMap((entry) => entry.lines),
    shrunk: 0,
    overflow,
  };
}

/**
 * The plan for every page: which matches are replaced in place, which lines move, which
 * blocks are re-laid, and the writer's request that does all of it. Pure: the pages are
 * models and every font question goes through `faces`, so the tests run it without MuPDF.
 */
export function planFindReplace(
  pages: readonly TextPage[],
  query: FindReplaceQuery,
  fonts: TextFontSet,
  faces: FaceSource,
): FindReplacePlan {
  const needle = searchTokens(query.find, query.matchCase);
  const erase: { pageIndex: number; rects: Rect[] }[] = [];
  const insert: { pageIndex: number; lines: TextEditInsertLine[] }[] = [];
  const changedPages = new Set<number>();
  const skippedPages = new Set<number>();
  let found = 0;
  let replaced = 0;
  let inPlace = 0;
  let movedLines = 0;
  let shrunk = 0;
  let reflowed = 0;
  let overflowed = 0;
  let skipped = 0;
  let noRoom = 0;
  let unchanged = 0;

  for (const page of pages) {
    const editability = measureEditability(page);
    const rects: Rect[] = [];
    const lines: TextEditInsertLine[] = [];
    const take = (placement: Placement): void => {
      rects.push(...placement.rects);
      lines.push(...placement.lines);
      shrunk += placement.shrunk;
    };
    for (const block of page.blocks) {
      const units = unitsOf(block, query.matchCase);
      const { hits, unaligned } =
        needle.length === 0 ? { hits: [], unaligned: 0 } : findHits(units, needle, query.wholeWord);
      found += hits.length + unaligned;
      skipped += unaligned;
      if (unaligned > 0) skippedPages.add(page.pageIndex);
      if (hits.length === 0) continue;
      const verdict =
        editability.blocks.find((entry) => entry.blockId === block.id)?.verdict ?? 'not-editable';
      if (verdict === 'not-editable') {
        skipped += hits.length;
        skippedPages.add(page.pageIndex);
        continue;
      }

      // A match that already reads as the replacement (`istanbul` → `İstanbul` finds
      // `İstanbul` too) is left exactly as it is.
      const changing = hits.filter(
        (hit) =>
          replacedText(units.slice(hit.first, hit.last + 1), [], '').replace(/\s+/gu, ' ') !== query.replace,
      );
      unchanged += hits.length - changing.length;
      if (changing.length === 0) continue;

      const matches = changing.map((hit) =>
        units
          .slice(hit.first, hit.last + 1)
          .map((unit) => unit.glyph)
          .filter((glyph): glyph is GlyphAt => glyph !== null),
      );
      const crossesLines = matches.some((glyphs) => glyphs.some((glyph) => glyph.line !== glyphs[0]?.line));
      let placements: Placement[] | null = null;
      let moved = 0;
      if (!crossesLines) {
        // A line whose matches change width is drawn again moved, so the words after
        // them keep their spacing; a line that cannot move keeps the rest in place.
        placements = [];
        const byLine = new Map<number, (readonly GlyphAt[])[]>();
        for (const glyphs of matches) {
          const lineIndex = glyphs[0]?.line ?? 0;
          byLine.set(lineIndex, [...(byLine.get(lineIndex) ?? []), glyphs]);
        }
        for (const [lineIndex, lineMatches] of byLine) {
          const moving = lineMatches.some((glyphs) =>
            movesLine(page, block, glyphs, query.replace, fonts, faces),
          );
          if (moving) {
            const result = placeLine(page, block, lineIndex, lineMatches, query.replace, fonts, faces);
            if (result !== null) {
              placements.push(result);
              moved += 1;
              continue;
            }
          }
          const singles = lineMatches.map((glyphs) =>
            placeInPlace(page, block, glyphs, query.replace, fonts, faces, MIN_INLINE_SCALE),
          );
          if (singles.every((result): result is Placement => result !== null)) {
            placements.push(...singles);
            continue;
          }
          const result = moving
            ? null
            : placeLine(page, block, lineIndex, lineMatches, query.replace, fonts, faces);
          if (result === null) {
            placements = null;
            break;
          }
          placements.push(result);
          moved += 1;
        }
      }

      if (placements !== null) {
        for (const placement of placements) take(placement);
        inPlace += changing.length;
        movedLines += moved;
        replaced += changing.length;
        changedPages.add(page.pageIndex);
        continue;
      }
      if (tableLike(block)) {
        // Table cells are never laid out as a paragraph: each match is drawn as small as
        // a cell allows, or left alone and reported.
        for (const glyphs of matches) {
          const oneLine = glyphs.every((glyph) => glyph.line === glyphs[0]?.line);
          const result = oneLine
            ? placeInPlace(page, block, glyphs, query.replace, fonts, faces, MIN_CELL_SCALE)
            : null;
          if (result === null) {
            noRoom += 1;
            continue;
          }
          take(result);
          inPlace += 1;
          replaced += 1;
          changedPages.add(page.pageIndex);
        }
        continue;
      }
      const result =
        placeParagraph(page, block, units, changing, query.replace, fonts, faces) ??
        placeParagraphInOneFace(page, block, replacedText(units, changing, query.replace), fonts, faces);
      take(result);
      reflowed += 1;
      if (result.overflow) overflowed += 1;
      replaced += changing.length;
      changedPages.add(page.pageIndex);
    }
    if (rects.length > 0) erase.push({ pageIndex: page.pageIndex, rects });
    if (lines.length > 0) insert.push({ pageIndex: page.pageIndex, lines });
  }

  const used = insert.flatMap((entry) => entry.lines.map((line) => line.fontId));
  return {
    request: { erase, insert, fonts: {} },
    found,
    replaced,
    inPlace,
    movedLines,
    shrunk,
    reflowed,
    overflowed,
    skipped,
    noRoom,
    unchanged,
    changedPages: [...changedPages],
    skippedPages: [...skippedPages],
    standardFaces: [
      ...new Set(
        used.map((id) => STANDARD_FACE_NAMES[id]).filter((name): name is string => name !== undefined),
      ),
    ],
    ownFonts: [
      ...new Set(
        used
          .filter((id) => id.startsWith(DOCUMENT_FONT_PREFIX))
          .map((id) => displayName(id.slice(DOCUMENT_FONT_PREFIX.length))),
      ),
    ],
  };
}
