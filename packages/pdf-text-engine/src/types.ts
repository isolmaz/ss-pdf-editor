/**
 * The public type surface of the text engine: the text model, editability,
 * block-local reflow and the font engine.
 *
 * ## Coordinate space (fixed for this whole package)
 *
 * Every geometry value is in **unrotated PDF user space with a top-left origin**:
 * `x` grows to the right, `y` grows **downwards**, unit = PDF point. Every rect is
 * `[x0, y0, x1, y1]` with `x0 < x1`, `y0 < y1` and `y0` measured downwards. This is
 * the same space as `PageRect` in `packages/pdf-core/src/ops/types.ts:44-52`.
 *
 * The engine never emits *rotated page space*: the spike measured that MuPDF
 * **annotation** geometry lives in rotated page space while content streams live in
 * unrotated user space, and that mixing the two fails silently (text survives,
 * nothing is removed — an early engine spike, "The exact APIs
 * called"). The conversion lives in exactly one place: pdf-core's writer
 * (`applyTextEdit`). Everything here is unrotated and top-left.
 *
 * ## Purity
 *
 * These are plain data types. The package never imports pdf.js, MuPDF or
 * React, never reads a file or fetches, and never touches `document`/`window`; the
 * caller loads bytes and hands in plain data, the engine returns plain data.
 */

/** `[x0, y0, x1, y1]`, top-left origin (see the coordinate space note above). */
export type Rect = readonly [number, number, number, number];

/** One glyph of the model: the character, its own box and its measured advance. */
export interface GlyphBox {
  readonly ch: string;
  readonly rect: Rect;
  /** Measured advance along the line direction, in points: this glyph's origin to
   *  the next one; for the last glyph of a line, the along-direction extent of its
   *  own box (an early engine spike measured the same
   *  quantity for a whole line: first char's left edge → last char's right edge). */
  readonly advance: number;
  /** Baseline start point of the glyph, when the extractor reported one. */
  readonly origin?: readonly [number, number];
  /** The glyph's own font size in points. */
  readonly size?: number;
  /** The font name the extractor reported for this glyph's run. */
  readonly fontName?: string;
  /** `#rrggbb`, lower case: the glyph's own fill colour, when the extractor reported it. */
  readonly color?: string;
}

/** A run of glyphs with no word gap inside it. */
export interface TextWord {
  readonly text: string;
  readonly rect: Rect;
  readonly glyphs: readonly GlyphBox[];
}

export interface TextLine {
  readonly text: string;
  readonly rect: Rect;
  readonly words: readonly TextWord[];
  /** y of the baseline. Lines that are not horizontal carry the value the
   *  extractor reported; see `lineOrientation` — the write path is horizontal only. */
  readonly baseline: number;
}

export type TextAlign = 'left' | 'center' | 'right' | 'justify';

export interface TextStyle {
  /** PostScript-ish name reported by the page, e.g. `"ABCDEF+NotoSans"`, or `null`
   *  when the extractor reported no font for the block's glyphs. */
  readonly fontName: string | null;
  readonly fontFamily: 'sans' | 'serif' | 'mono' | 'unknown';
  readonly bold: boolean;
  readonly italic: boolean;
  /** Effective font size in points (the block's median glyph size). */
  readonly fontSize: number;
  /** Baseline-to-baseline distance in points (the block's median consecutive
   *  baseline distance; see `buildTextPage` for the single-line fallback). */
  readonly leading: number;
  /** `#rrggbb`, lower case. */
  readonly color: string;
}

export interface TextBlock {
  /** Stable within a page: `b<index>`, where `<index>` is the block's position in
   *  the page input (`PageTextInput.colors` is keyed by the same index). */
  readonly id: string;
  /** The block's own box: the ink box of its lines, never a padded region. */
  readonly rect: Rect;
  readonly lines: readonly TextLine[];
  /** The lines joined with `'\n'`. */
  readonly text: string;
  readonly style: TextStyle;
  readonly align: TextAlign;
}

export interface TextPage {
  readonly pageIndex: number;
  /** Unrotated page width in points (the `MediaBox` width). */
  readonly width: number;
  /** Unrotated page height in points (the `MediaBox` height). */
  readonly height: number;
  /** The page's `/Rotate`, kept for the UI. It does **not** change this package's
   *  coordinate space: rects stay unrotated, exactly as the writer consumes them. */
  readonly rotation: 0 | 90 | 180 | 270;
  readonly blocks: readonly TextBlock[];
}

/** How a line's glyphs are arranged in page space. */
export type LineOrientation = 'horizontal' | 'reversed' | 'vertical' | 'skewed';

/**
 * One glyph as the extractor reports it. MuPDF's `StructuredText.walk` gives
 * exactly this set per character:
 * the character, the baseline origin, the size, the quad and the font name.
 */
export interface CharInput {
  readonly ch: string;
  /** The glyph's own box (a quad reduced to its bounding box by the extractor). */
  readonly quad: Rect;
  /** Baseline start point of this character. */
  readonly origin: readonly [number, number];
  /** Effective font size in points. */
  readonly size: number;
  /** The font name the extractor reported for this run. */
  readonly fontName: string;
  /** `#rrggbb`, lower case: the fill colour the glyph was drawn with, when known. */
  readonly color?: string;
}

export interface LineInput {
  readonly chars: readonly CharInput[];
  /** The extractor's own line box. The model rebuilds ink boxes from the glyphs,
   *  so this value is informational (a debug overlay can show it). */
  readonly quad: Rect;
  /** y of the baseline in page space (MuPDF reports it per line). */
  readonly baseline: number;
}

export interface BlockInput {
  readonly lines: readonly LineInput[];
  /** The extractor's own block box; informational, as `LineInput.quad` is. */
  readonly quad: Rect;
}

/** Everything `buildTextPage` needs: a page's extracted text, nothing else. */
export interface PageTextInput {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly blocks: readonly BlockInput[];
  /** Per block index, the fill colour detected for its text; a missing entry
   *  means `'#000000'` (black is what an undetected fill colour means in practice). */
  readonly colors?: Readonly<Record<number, string>>;
}

/** `editable`: re-renderable in the same face. `substituted`: editable, but the
 *  replacement is re-rendered in a substitute font.
 *  `not-editable`: never silently damaged — the UI marks it (`4b`). */
export type EditabilityVerdict = 'editable' | 'substituted' | 'not-editable';

/** The single fact behind a verdict. Priority order is documented on
 *  `measureEditability`. */
export type EditabilityReason =
  | 'ok'
  | 'embedded-font'
  | 'standard-font'
  | 'type3'
  | 'no-glyphs'
  | 'rotated'
  | 'skewed'
  | 'scanned'
  | 'image-only';

export interface BlockEditability {
  readonly blockId: string;
  readonly verdict: EditabilityVerdict;
  readonly reason: EditabilityReason;
  /** True when the block's font programme is inside the file (see `describeFontName`
   *  for how the name is read; a subset prefix always means embedded). */
  readonly fontEmbedded: boolean;
  /** True when the block can only be re-rendered with a substituted font. */
  readonly substitutionRequired: boolean;
}

export interface EditabilityReport {
  readonly pageIndex: number;
  readonly blocks: readonly BlockEditability[];
  /** Blocks that can be edited: `editable` **and** `substituted` (a substituted block
   *  is editable, with the `4e` caveat). The strict counts are derivable from `blocks`. */
  readonly editableCount: number;
  readonly nonEditableCount: number;
  /** Page-level reason: `'ok'` when the page has at least one glyph-bearing block,
   *  `'scanned'` when the extractor produced no blocks at all (a page with no text
   *  layer), `'image-only'` when blocks exist but none of them carries glyphs. */
  readonly pageReason: EditabilityReason;
}

/** One face the package may embed. `filePath` is the **served** path — the value the
 *  writer puts in its `fonts` map (so `/fonts/...`, not a filesystem path); the file
 *  on disk is `public` + `filePath`. */
export interface FontCandidate {
  readonly id: string;
  readonly family: 'sans' | 'serif' | 'mono';
  readonly bold: boolean;
  readonly italic: boolean;
  readonly filePath: string;
}

/**
 * Metric table of one parsed font programme. Advances and vertical metrics are in
 * **font units** — divide by `unitsPerEm` to get em fractions; the reflow multiplies
 * by the point size. The font files are referenced as data (`FontCandidate.filePath`)
 * and are never bundled: the caller fetches the bytes and calls `metricsFor`.
 */
export interface FontMetrics {
  readonly unitsPerEm: number;
  /** Advance width in font units for one code point. */
  glyphAdvance(codePoint: number): number;
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  /** True when the font carries a glyph for the code point. */
  hasGlyph(codePoint: number): boolean;
  /** Code points with no glyph, for the report (each entry is the code point as its
   *  own character); filled when `metricsFor` was given the text to check. */
  readonly missing: readonly string[];
}

/**
 * A font engine's glyph lookups — the shape of MuPDF's `Font` (`encodeCharacter`,
 * `advanceGlyph`), declared here so this package needs no engine of its own. Glyph `0`
 * is `.notdef`, the answer for a code point the font does not cover.
 */
export interface GlyphSource {
  /** The glyph id for a code point; `0` when the font has none. */
  encodeCharacter(codePoint: number): number;
  /** A glyph's advance in em (1 = the font's units-per-em). */
  advanceGlyph(glyph: number): number;
}

export interface FontCatalog {
  readonly candidates: readonly FontCandidate[];
  /**
   * Coverage for a candidate, when the caller has already parsed that font with
   * `metricsFor` — it is the only way `matchFont` can report `missingGlyphs`
   * without reading files (this package never does I/O). Absent → the match cannot
   * report coverage and `missingGlyphs` stays empty (documented on `matchFont`).
   */
  readonly metrics?: (candidate: FontCandidate) => FontMetrics | null;
}

export interface FontMatch {
  readonly font: FontCandidate;
  /** A different programme from the block's original ink is required. Note that a
   *  re-render always embeds a fresh font programme even when `substituted` is
   *  false, because a font read back from the file answers glyph id 0 for every
   *  character. */
  readonly substituted: boolean;
  /** True when the original font's family/weight/italic was reproduced exactly. */
  readonly exact: boolean;
  readonly missingGlyphs: readonly string[];
}

/** What `describeFontName` can say about a font name alone. */
export interface FontNameInfo {
  /** The name without the `ABCDEF+` subset prefix. */
  readonly base: string;
  /** The name carried the six-uppercase-letter subset prefix — the spike's
   *  `SPMIZR+Arial` (`NOTES.md`, case a), i.e. an embedded **subset**. */
  readonly subset: boolean;
  readonly family: 'sans' | 'serif' | 'mono' | 'unknown';
  readonly bold: boolean;
  readonly italic: boolean;
  /** One of the base-14 faces a reader supplies itself (never embedded). */
  readonly standard14: boolean;
  /** The name carries a Type3 marker (see `describeFontName` for the limits). */
  readonly type3: boolean;
}

export interface ReflowOptions {
  readonly align?: TextAlign;
  /** Absolute baseline-to-baseline distance in points. Shrinking the face does not
   *  shrink this value; pass a scaled one if the block must keep its rhythm. */
  readonly leading?: number;
  readonly fontSize?: number;
  /** Break a word that does not fit at a code-point boundary and mark it with `-`
   *  (no language dictionary is consulted — see `reflowBlock`). */
  readonly hyphenate?: boolean;
  /** Extra space in points **between** paragraphs (never before the first). */
  readonly paragraphSpacing?: number;
  /** First-line indent of every paragraph, in points. */
  readonly indent?: number;
  /** Hard box for the reflow. `null` derives it from the block (width from the
   *  block, height free — the box grows). */
  readonly box?: Rect | null;
  /** Shrink the font until the text fits, down to this size (auto-shrink asks for
   *  this). Absent → the text is laid out at `fontSize` and may overflow. */
  readonly minFontSize?: number;
}

/** One word's final placement on a line. */
export interface LaidOutWord {
  readonly text: string;
  /** Absolute x of the word's baseline start, in page space (same y as the line). */
  readonly x: number;
}

export interface LaidOutLine {
  readonly text: string;
  /** The line's box: `y` from the ascender to the descender, `x` from the line's
   *  first glyph to its last (a justified line reaches the box's right edge). */
  readonly rect: Rect;
  readonly baseline: number;
  /** Laid-out ink width in points (justification included). */
  readonly width: number;
  /**
   * True when this line's inter-word spaces were **stretched** by justification — it
   * is the box's width that the line reaches, not the text's natural advance. `words`
   * then carries the stretched per-word positions, which is the only way a consumer
   * without a word-spacing primitive can reproduce the line. Absent (or false) means
   * the line is ordinary text: `words` are the natural positions and drawing the whole
   * string at `x` gives the same result.
   */
  readonly justified?: boolean;
  /**
   * Per-word placement, in page space at the line's own baseline — the way a
   * justified line reaches the box's right edge, because justification lives in the
   * inter-word spaces and a consumer with no word-spacing control cannot reproduce it
   * by drawing `text` whole. Every laid-out line carries them: `x` is the **stretched**
   * position on a justified line (its last word ends on the content area's right edge)
   * and the natural position elsewhere. Absent (a hand-built line) means "draw `text`
   * at the line's own `x`".
   */
  readonly words?: readonly LaidOutWord[];
}

export interface ReflowResult {
  readonly lines: readonly LaidOutLine[];
  /** The box the text actually occupies (may exceed the input box). Zero-area and
   *  at the box's top-left corner when the text is empty. */
  readonly rect: Rect;
  /** True when the text does not fit even at `minFontSize`. */
  readonly overflow: boolean;
  /** The size actually used (equal to the requested size unless auto-shrink ran). */
  readonly fontSize: number;
  /** Words broken by hyphenation, in layout order, for the report. */
  readonly hyphenated: readonly string[];
}

export interface ReflowRequest {
  readonly block: TextBlock;
  readonly text: string;
  readonly options?: ReflowOptions;
}

/** Model + edit intent → the serializable request of pdf-core's writer op. */
export interface TextEditIntent {
  readonly page: TextPage;
  readonly blockId: string;
  /** The new paragraph text; `''` (or whitespace only) deletes the block, which
   *  produces an erase-only request. */
  readonly replacement: string;
  readonly options?: ReflowOptions;
  /** The face chosen for the replacement (`matchFont`). Absent → the built-in Noto
   *  Sans fallback, which is what `4e` expects for a substituted block. `metrics`
   *  must be that same face's table, otherwise the line width is a guess. */
  readonly font?: FontCandidate;
}

/** The rectangles to erase on one page, in the app's page space. */
export interface TextEditErase {
  readonly pageIndex: number;
  readonly rects: readonly Rect[];
}

/** One replacement line drawn at baseline `(x, y)` in the app's page space. */
export interface TextEditInsertLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  /** `#rrggbb`. */
  readonly color: string;
  /** A `FontCandidate` id; keys into {@link TextEditRequest.fonts}. */
  readonly fontId: string;
  /** Measured advance width, for the report only — placement uses the baseline. */
  readonly width: number;
  /**
   * Optional per-word placement in the same top-left page space as `x`/`y`;
   * present for a justified line. When absent, `text` is drawn whole at `x`.
   */
  readonly words?: readonly { readonly text: string; readonly x: number }[];
  /**
   * `[left, right]` of the page line this text continues, in the same space as `x`. Text
   * the page still has on that baseline inside it is the line's own, and the writer puts
   * this text beside it in the content stream, so the line reads in order. Absent when
   * none of the line's own text stays (a redrawn paragraph): the text is drawn after the
   * page's content, never beside a neighbouring column's line.
   */
  readonly lineSpan?: readonly [number, number];
}

/** Replacement lines for one page. */
export interface TextEditInsert {
  readonly pageIndex: number;
  readonly lines: readonly TextEditInsertLine[];
}

export interface TextEditRequest {
  readonly erase: readonly TextEditErase[];
  readonly insert: readonly TextEditInsert[];
  /** Font files to embed: id → absolute URL on the app origin (`/fonts/…`). */
  readonly fonts: Readonly<Record<string, string>>;
}
