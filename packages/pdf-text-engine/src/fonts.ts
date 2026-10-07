/**
 * Font engine: name classification, the face catalogue,
 * metric tables (font headers read here, glyph lookups from the embedding engine) and
 * original-font → similar-font matching.
 *
 * The catalogue holds **paths as data**. Nothing here reads a file, fetches or
 * touches the DOM: the caller fetches the bytes (from `FontCandidate.filePath`,
 * which is the served path under `public/`) and hands them to `metricsFor`.
 *
 * Two measured constraints shape this module:
 *   - a font read back from a saved file answers `encodeCharacter(char) === 0` for
 *     **every** character (round-2 variant A), so the original programme is never
 *     reused: each edit round embeds a fresh one. Matching is therefore about the
 *     *face*, never about reusing the original bytes;
 *   - the substitute must be subset before saving (675,382 → 157,570 B, 4.3×, round-2
 *     variant B) — that is the save pipeline's job (pdf-core), and it works only
 *     because this module hands over a complete font programme.
 */

import { ToolError } from 'pdf-shared';
import type {
  FontCandidate,
  FontCatalog,
  FontMatch,
  FontMetrics,
  FontNameInfo,
  GlyphSource,
  TextStyle,
} from './types';

const ENGINE = 'pdf-text-engine';

/**
 * The faces this package can embed, both pinned by `tools/fetch-engines.mjs:118-131`
 * and present in `tools/asset-pins.json` (they are fetched into `public/fonts/noto/`,
 * which is gitignored — the catalogue points at them, it does not bundle them).
 * The paths are the served paths, identical to `NOTO_ASSETS` in
 * `packages/pdf-core/src/assets.ts:64-67`, because the writer's `fonts` map takes
 * same-origin URLs.
 *
 * Turkish coverage is the reason these two and not the base-14 faces: they carry
 * Ğ/ğ, İ/ı, Ş/ş, and `tools/fetch-engines.mjs:122-126` records why a base-14 face
 * cannot stand in for them.
 */
const NOTO_SANS_REGULAR: FontCandidate = {
  id: 'noto-sans',
  family: 'sans',
  bold: false,
  italic: false,
  filePath: '/fonts/noto/NotoSans-Regular.ttf',
};

const NOTO_SANS_SEMIBOLD: FontCandidate = {
  id: 'noto-sans-semibold',
  family: 'sans',
  bold: true,
  italic: false,
  filePath: '/fonts/noto/NotoSans-SemiBold.ttf',
};

export const DEFAULT_FONT_CANDIDATES: readonly FontCandidate[] = [NOTO_SANS_REGULAR, NOTO_SANS_SEMIBOLD];

/**
 * The face every fallback lands on. `FontMatch.font` and a plan's insert lines are
 * non-optional, so a match must be able to name a face even for an empty catalogue;
 * Noto Sans regular is the honest choice (`4e`): it is the face the product already
 * embeds for stamps and header/footer text, and it covers Turkish.
 */
export const FALLBACK_FONT_CANDIDATE: FontCandidate = NOTO_SANS_REGULAR;

/** `ABCDEF+NotoSans` — the six-uppercase-letter prefix of an embedded subset
 *  (measured in an early engine spike: the fixture's `Arial` becomes
 *  `SPMIZR+Arial`, 560,660 B → 27,518 B). */
const SUBSET_PREFIX = /^[A-Z]{6}\+/;

/** Family keywords, matched against the lower-cased alphanumeric name. Checked
 *  mono → sans → serif on purpose: `DejaVuSansMono` must be mono, and `SansSerif`
 *  must be sans rather than serif. */
const MONO_KEYWORDS = ['mono', 'courier', 'consol', 'menlo', 'monaco', 'typewriter'];
const SANS_KEYWORDS = [
  'sans',
  'helvetica',
  'arial',
  'grotesk',
  'grotesque',
  'verdana',
  'tahoma',
  'calibri',
  'segoe',
  'roboto',
  'lato',
  'gothic',
  'frutiger',
  'myriad',
  'futura',
  'univers',
  'candara',
  'corbel',
  'geneva',
  'carlito',
];
const SERIF_KEYWORDS = [
  'serif',
  'times',
  'georgia',
  'garamond',
  'cambria',
  'book',
  'palatino',
  'minion',
  'charter',
  'baskerville',
  'didot',
  'caslon',
  'century',
  'constantia',
  'rockwell',
  'merriweather',
  'lora',
  'playfair',
  // `NimbusRoman`, `LMRoman10`, `Times-Roman`: sans faces named "roman" are caught first.
  'roman',
  'charis',
];

/** Weights ≥ 600 collapse to `bold` (the model is a boolean, `4e` needs a face
 *  choice, and the catalogue has exactly one bold face). `medium` (500) does not. */
const BOLD_KEYWORDS = ['bold', 'black', 'heavy', 'demi'];

/**
 * The base-14 faces a reader supplies itself: never embedded, never reproducible by
 * us for Turkish text. The names are normalised (lower case, alphanumerics only),
 * so `Times-Roman` → `timesroman`. `Times New Roman` normalises to `timesnewroman`
 * and is deliberately **not** in this set — that name is a different face, normally
 * embedded.
 */
const STANDARD_14_NAMES: Record<string, true> = {
  courier: true,
  courierbold: true,
  courieroblique: true,
  courierboldoblique: true,
  helvetica: true,
  helveticabold: true,
  helveticaoblique: true,
  helveticaboldoblique: true,
  timesroman: true,
  timesbold: true,
  timesitalic: true,
  timesbolditalic: true,
  symbol: true,
  zapfdingbats: true,
};

/** Lower case, alphanumerics only — the form every keyword table is matched against. */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * What a font name alone can tell us. This is the whole evidence the model has —
 * the extractor reports a name, not an embedding flag — so the vocabulary is
 * deliberately conservative:
 *
 *   - a subset prefix proves embedding;
 *   - a base-14 name proves the opposite (the reader supplies the programme);
 *   - anything else is *assumed* embedded. An unembedded non-base-14 face (an old
 *     PDF relying on reader substitution) is therefore reported as `embedded: true`,
 *     which is the safe direction: the verdict becomes `substituted` either way, so
 *     the edit path does not change.
 *   - Type3 is only recognised when the name carries the marker. MuPDF reports the
 *     glyph outlines of Type3 text like any other font, so a name without the marker
 *     cannot be told apart from a TrueType face — a documented limit of 4b, not a
 *     silent assumption.
 */
export function describeFontName(fontName: string): FontNameInfo {
  const subset = SUBSET_PREFIX.test(fontName);
  const base = subset ? fontName.slice(7) : fontName;
  const normalized = normalizeName(base);
  let family: FontNameInfo['family'] = 'unknown';
  if (MONO_KEYWORDS.some((keyword) => normalized.includes(keyword))) family = 'mono';
  else if (SANS_KEYWORDS.some((keyword) => normalized.includes(keyword))) family = 'sans';
  else if (SERIF_KEYWORDS.some((keyword) => normalized.includes(keyword))) family = 'serif';
  return {
    base,
    subset,
    family,
    bold: BOLD_KEYWORDS.some((keyword) => normalized.includes(keyword)),
    italic: normalized.includes('italic') || normalized.includes('oblique'),
    standard14: STANDARD_14_NAMES[normalized] === true,
    type3: normalized.includes('type3'),
  };
}

/**
 * Whether a catalogue face *is* the file's own face, by name: every alphanumeric
 * token of the candidate id (minus the `regular` filler) has to appear in the
 * reported base name. `'NotoSans'`/`'ABCDEF+NotoSans'` match `noto-sans`;
 * `'Arial'` does not.
 *
 * This is the test behind `measureEditability`'s `ok` verdict: it is the only way to
 * say "we ship this programme ourselves" with a name as the sole evidence (see the
 * `describeFontName` note on what the extractor reports).
 */
export function candidateMatchesFontName(candidate: FontCandidate, fontName: string): boolean {
  const base = normalizeName(describeFontName(fontName).base);
  const tokens = candidate.id
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '' && token !== 'regular');
  return tokens.length > 0 && tokens.every((token) => base.includes(token));
}

/**
 * The catalogue as `matchFont` consumes it. The optional `metrics` provider is how a
 * caller gives the matcher coverage without this package doing I/O: pass a function
 * that returns the table from `metricsFor` for a candidate it has already fetched
 * (a `Map` keyed by `filePath` is the usual shape), and coverage-aware matching and
 * `missingGlyphs` reporting become available.
 */
export function createFontCatalog(
  candidates: readonly FontCandidate[],
  metrics?: (candidate: FontCandidate) => FontMetrics | null,
): FontCatalog {
  return { candidates, metrics };
}

/** Family is filtered before this runs; weight outweighs italic (2:1), and the
 *  numbers are the ranking formula the tie-breaking relies on. */
function rankScore(candidate: FontCandidate, bold: boolean, italic: boolean): number {
  return (candidate.bold === bold ? 2 : 0) + (candidate.italic === italic ? 1 : 0);
}

/** Candidates ranked best-first for a target family/weight/italic. Ties keep the
 *  catalogue's own order (the sort is stable), so the result is deterministic. */
function rankCandidates(
  candidates: readonly FontCandidate[],
  family: FontCandidate['family'],
  bold: boolean,
  italic: boolean,
): readonly FontCandidate[] {
  const sameFamily = candidates.filter((candidate) => candidate.family === family);
  const pool = sameFamily.length > 0 ? sameFamily : candidates;
  return [...pool].sort((left, right) => rankScore(right, bold, italic) - rankScore(left, bold, italic));
}

/** Code points of `text` with no glyph in `metrics`, de-duplicated, in text order. */
function missingGlyphsOf(text: string, metrics: FontMetrics): readonly string[] {
  const missing: string[] = [];
  for (const character of text) {
    // A string iterator yields whole code points, never an empty string.
    if (metrics.hasGlyph(character.codePointAt(0) as number)) continue;
    if (!missing.includes(character)) missing.push(character);
  }
  return missing;
}

/**
 * Best face for this text: the highest-ranked candidate that covers every code point
 * when the catalogue can answer coverage, else the best-ranked one (its gaps are
 * reported in `missingGlyphs`). A face with a complete coverage beats a better
 * family/weight match that cannot render a Turkish character — `4e`'s "automatic
 * fallback for missing glyphs".
 */
function pickCandidate(
  ranked: readonly FontCandidate[],
  text: string,
  metrics: FontCatalog['metrics'],
): FontCandidate | null {
  const head = ranked[0];
  if (head === undefined) return null;
  if (metrics === undefined) return head;
  let firstParsed: FontCandidate | null = null;
  for (const candidate of ranked) {
    const table = metrics(candidate);
    if (table === null) continue;
    if (firstParsed === null) firstParsed = candidate;
    if (missingGlyphsOf(text, table).length === 0) return candidate;
  }
  return firstParsed ?? head;
}

/**
 * The face to set `text` in, for a block whose style is `style`.
 *
 * `exact` is about the face (family, weight, italic), exactly as the contract says;
 * it is deliberately **not** a promise that the programme is the original one — a
 * re-render always embeds a fresh programme, because a font read back from the file
 * has no usable cmap (`NOTES.md`, variant A). `substituted` is `!exact`.
 *
 * `missingGlyphs` is empty when the catalogue carries no `metrics` provider: without
 * a parsed programme the coverage of a face simply is not knowable offline, and an
 * empty list is the honest answer rather than a guess.
 */
export function matchFont(style: TextStyle, text: string, catalog: FontCatalog): FontMatch {
  const family = style.fontFamily === 'unknown' ? 'sans' : style.fontFamily;
  const ranked = rankCandidates(catalog.candidates, family, style.bold, style.italic);
  const chosen = pickCandidate(ranked, text, catalog.metrics) ?? FALLBACK_FONT_CANDIDATE;
  const exact =
    chosen.family === style.fontFamily && chosen.bold === style.bold && chosen.italic === style.italic;
  const table = catalog.metrics?.(chosen) ?? null;
  return {
    font: chosen,
    substituted: !exact,
    exact,
    missingGlyphs: table === null ? [] : missingGlyphsOf(text, table),
  };
}

/** The vertical metrics an sfnt font states once, in its `head` and `hhea` tables. */
export interface FontHeader {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
}

/** sfnt versions with `head`/`hhea` tables: TrueType (`0x00010000`, `true`) and CFF (`OTTO`). */
const SFNT_VERSIONS = new Set([0x00010000, 0x74727565, 0x4f54544f]);

/**
 * `unitsPerEm` (`head`) and ascender/descender/line gap (`hhea`) from a TrueType or
 * OpenType font programme — four numbers at fixed offsets, read with every offset
 * bounds-checked. Everything per glyph (the cmap, the advances) is the font engine's
 * job (`GlyphSource`); this is only what MuPDF's font object does not expose.
 *
 * The `hhea` values are the ones fontkit reported as `ascent`/`descent`/`lineGap`, the
 * figures the line layout was measured with. A collection (`ttcf`) or a web wrapper
 * (WOFF/WOFF2) is refused rather than guessed at: every face the product embeds is a
 * served `.ttf`.
 */
export function readFontHeader(bytes: Uint8Array): FontHeader {
  const fail = (reason: string): never => {
    throw new ToolError('unsupported', { engine: ENGINE, engineMessage: `font header: ${reason}` });
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 12) fail('the file is shorter than an sfnt header');
  if (!SFNT_VERSIONS.has(view.getUint32(0))) fail('not a TrueType or OpenType font programme');
  const tableCount = view.getUint16(4);
  if (12 + tableCount * 16 > view.byteLength) fail('the table directory runs past the end of the file');
  const tables = new Map<string, { readonly offset: number; readonly length: number }>();
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    tables.set(tag, { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
  }
  const table = (tag: string, minimum: number): number => {
    const entry = tables.get(tag);
    if (entry === undefined) return fail(`no '${tag}' table`);
    if (entry.length < minimum || entry.offset + minimum > view.byteLength) {
      return fail(`the '${tag}' table is truncated`);
    }
    return entry.offset;
  };
  const head = table('head', 54);
  const hhea = table('hhea', 36);
  const unitsPerEm = view.getUint16(head + 18);
  // `head.unitsPerEm` is 16..16384 by the specification; zero would divide every size.
  if (unitsPerEm < 16 || unitsPerEm > 16384) fail(`unitsPerEm ${unitsPerEm} is out of range`);
  return {
    unitsPerEm,
    ascender: view.getInt16(hhea + 4),
    descender: view.getInt16(hhea + 6),
    lineGap: view.getInt16(hhea + 8),
  };
}

/**
 * Metric table for a font programme: the glyph lookups from the font engine that will
 * embed it (`glyphs`, MuPDF's `Font` over the same `bytes`) and the header numbers read
 * from the bytes (`readFontHeader`). No I/O: the caller fetched the bytes and built the
 * font object.
 *
 * Advances come back in font units, rounded: MuPDF reports them in em, and a programme's
 * `hmtx` stores integers — measured against fontkit over every code point of both Noto
 * faces, the rounded values and the coverage are identical (largest float residue
 * 0.00009 units).
 *
 * `text` is optional and only feeds `missing`; coverage is always available through
 * `hasGlyph`, so a caller that reuses one table for several paragraphs can leave it
 * out and ask `hasGlyph`/`matchFont` per string.
 *
 * Encoding the code points for the content stream is *not* this table's job: the
 * writer asks its own font object for glyph ids.
 */
export function metricsFor(glyphs: GlyphSource, bytes: Uint8Array, text?: string): FontMetrics {
  // A programme without readable headers is a broken asset, and a broken metric table
  // would silently produce wrong line breaks.
  const font = readFontHeader(bytes);
  const glyphAdvance = (codePoint: number): number =>
    Math.round(glyphs.advanceGlyph(glyphs.encodeCharacter(codePoint)) * font.unitsPerEm);
  const metrics: FontMetrics = {
    unitsPerEm: font.unitsPerEm,
    glyphAdvance,
    ascender: font.ascender,
    descender: font.descender,
    lineGap: font.lineGap,
    hasGlyph: (codePoint) => glyphs.encodeCharacter(codePoint) !== 0,
    missing: [],
  };
  return text === undefined ? metrics : { ...metrics, missing: missingGlyphsOf(text, metrics) };
}
