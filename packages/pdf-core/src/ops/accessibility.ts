/**
 * Document accessibility: a check that reports **facts** about a
 * file, a writer that produces a tagged file with real marked-content sequences, and an
 * alt-text writer for the images and form fields a check found.
 *
 * ## The one rule: never claim more than was measured
 *
 * There is **no score, no percentage and no conformance verdict** anywhere in this
 * module, and that is deliberate. A number would be invented: nothing here evaluates
 * reading order, tables, lists, colour contrast, font embedding or whether an alt text
 * actually describes its image. `AccessibilityReport` therefore has three separate
 * places and never conflates them —
 *
 *   - `findings` (`problem` / `ok` / `unchecked`): what the checks that ran found, each
 *     naming the page or the object it concerns;
 *   - `checked`: the checks that ran at all;
 *   - `notChecked`: the PDF/UA requirements this check does **not** evaluate. It is a
 *     list because "we did not look" is a fact about the report, and a user who is told
 *     only "no problems found" would read it as a clean bill of health.
 *
 * `unchecked` is the third state and it is not decoration: a page whose content stream
 * cannot be decoded makes the image inventory for that page *unknown*, and reporting it
 * as "no images without alt text" would be a lie about a check that never ran.
 *
 * ## Tagging: the structure tree must point at content that exists
 *
 * A `/StructTreeRoot` whose `/P` elements carry `/K <</Type /MCR /MCID n>>` is worth
 * nothing unless the page content stream really contains a `/P <</MCID n>> BDC … EMC`
 * sequence *around the drawing operators it claims*. A tree pointing at nothing is the
 * exact failure this module is built to avoid, so tagging is done in this order:
 *
 *   1. the page's content stream is decoded and **tokenized** (a real content-stream
 *      scanner: strings, hex strings, arrays, dicts, comments and `BI … ID … EI` inline
 *      images are delimited, so image bytes can never be mistaken for operators);
 *   2. the text model (`pdf-text-engine`, built from MuPDF's glyphs, read through one
 *      document: `readDocumentText`) supplies
 *      the blocks; each text-showing operator is located by tracking `q/Q`, `cm`, `BT`,
 *      `Tm`, `Td`, `TD`, `T*`, `TL`, `Tf` and assigned to the block whose rect contains
 *      it (nearest block, within a font-size-relative slack);
 *   3. marked-content operators are spliced into the **original bytes** at instruction
 *      boundaries — the existing stream is never re-serialised, so nothing else in it
 *      can move;
 *   4. `tagDocument` re-opens its own output and counts the marked-content sequences
 *      against the tree's MCRs before handing back a byte; a mismatch is
 *      `verification-failed`.
 *
 * A page whose text cannot be related to its content honestly (no text layer, no
 * extractable blocks, an undecodable stream, ranges that overlap) is **left untagged**
 * and named in the report. The operation never invents a paragraph for a page it could
 * not read.
 *
 * ## What this module refuses
 *
 * A document that already has a `/StructTreeRoot` is refused with `unsupported`: merging
 * two structure trees is not implemented, and silently writing a second one would
 * double-tag the file. An empty alt text is refused with `value-out-of-range` — an empty
 * `/Alt` is worse than none (decorative content belongs in an `/Artifact`, which this
 * module does not write), so the caller must say something or say nothing.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import type { MessageKey } from 'pdf-shared';
import { ToolError } from 'pdf-shared';
import type { PageTextInput, Rect } from 'pdf-text-engine';
import { buildTextPage } from 'pdf-text-engine';
import { mapMupdfError } from '../engines/mupdf';
import {
  openForWrite,
  pageObjects,
  producerKeptNote,
  readName,
  readText,
  resolved,
  saveRewrite,
  text,
  visibleBox,
} from '../engines/mupdf-write';
import { readDocumentText, readPageText } from '../text-source';
import { inlineImageEnd } from './pdfa-content';
import { NS_DC, parseXmp, xmpList } from './pdfa-xmp';
import { EDITOR_ROLES } from './struct-roles';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

/* ------------------------------------------------------------------ *
 * Dictionary keys
 * ------------------------------------------------------------------ */

/**
 * The `MessageKey` seam. Every key below is declared in
 * `packages/shared/src/i18n/parts/a11y.ts` (Turkish) and `en-parts/a11y.ts` (English);
 * the cast is the single place a key string becomes a `MessageKey` — the same seam
 * `RedactionAuditPanel` uses for its own copy keys.
 */
function dictKey(value: string): MessageKey {
  return value as MessageKey;
}

/** Every dictionary key this module reports with, in one greppable place. */
export const A11Y_KEYS = {
  /* progress */
  progressCheck: dictKey('op.progress.a11y.check'),
  progressTag: dictKey('op.progress.a11y.tag'),
  progressVerify: dictKey('op.progress.a11y.verify'),

  /* tagDocument notes */
  tagged: dictKey('op.note.a11y.tagged'),
  markInfoSet: dictKey('op.note.a11y.markInfoSet'),
  langSet: dictKey('op.note.a11y.langSet'),
  langKept: dictKey('op.note.a11y.langKept'),
  langNoLanguage: dictKey('op.note.a11y.langNoLanguage'),
  pageNoBlocks: dictKey('op.note.a11y.pageNoBlocks'),
  pageUnmatched: dictKey('op.note.a11y.pageUnmatched'),
  pageUnreadable: dictKey('op.note.a11y.pageUnreadable'),
  pageOverlap: dictKey('op.note.a11y.pageOverlap'),
  placement: dictKey('op.note.a11y.placement'),
  headingGuess: dictKey('op.note.a11y.headingGuess'),
  orderFromContent: dictKey('op.note.a11y.orderFromContent'),
  contentRewritten: dictKey('op.note.a11y.contentRewritten'),
  figureNoAlt: dictKey('op.note.a11y.figureNoAlt'),
  nothingTagged: dictKey('op.note.a11y.nothingTagged'),
  elementLimit: dictKey('op.note.a11y.elementLimit'),
  formsNotTagged: dictKey('op.note.a11y.formsNotTagged'),
  textReadFailed: dictKey('op.note.a11y.textReadFailed'),

  /* setImageAlt notes */
  altSet: dictKey('op.note.a11y.altSet'),
  altShared: dictKey('op.note.a11y.altShared'),
  altNotDrawn: dictKey('op.note.a11y.altNotDrawn'),
  tooltipSet: dictKey('op.note.a11y.tooltipSet'),
  targetMissing: dictKey('op.note.a11y.targetMissing'),

  /* check findings */
  checkStructTree: dictKey('op.a11y.check.structTree'),
  checkStructTreeOk: dictKey('op.a11y.check.structTreeOk'),
  checkStructTruncated: dictKey('op.a11y.check.structTruncated'),
  checkFigureTreeTruncated: dictKey('op.a11y.check.figureTreeTruncated'),
  checkMarkInfo: dictKey('op.a11y.check.markInfo'),
  checkMarkInfoOk: dictKey('op.a11y.check.markInfoOk'),
  checkLang: dictKey('op.a11y.check.lang'),
  checkLangOk: dictKey('op.a11y.check.langOk'),
  checkInfoTitle: dictKey('op.a11y.check.infoTitle'),
  checkInfoTitleOk: dictKey('op.a11y.check.infoTitleOk'),
  checkXmpMissing: dictKey('op.a11y.check.xmpMissing'),
  checkXmpMalformed: dictKey('op.a11y.check.xmpMalformed'),
  checkXmpTitle: dictKey('op.a11y.check.xmpTitle'),
  checkXmpTitleOk: dictKey('op.a11y.check.xmpTitleOk'),
  checkImageAlt: dictKey('op.a11y.check.imageAlt'),
  checkImageAltOk: dictKey('op.a11y.check.imageAltOk'),
  checkFieldTooltip: dictKey('op.a11y.check.fieldTooltip'),
  checkFieldTooltipOk: dictKey('op.a11y.check.fieldTooltipOk'),
  checkLinkContents: dictKey('op.a11y.check.linkContents'),
  checkLinkContentsOk: dictKey('op.a11y.check.linkContentsOk'),
  checkParagraphs: dictKey('op.a11y.check.paragraphs'),
  checkParagraphsOk: dictKey('op.a11y.check.paragraphsOk'),
  checkParagraphsUnchecked: dictKey('op.a11y.check.paragraphsUnchecked'),
  checkPageUnreadable: dictKey('op.a11y.check.pageUnreadable'),
  checkListClipped: dictKey('op.a11y.check.listClipped'),
  checkFieldTreeTruncated: dictKey('op.a11y.check.fieldTreeTruncated'),
  checkNestedTooDeep: dictKey('op.a11y.check.nestedTooDeep'),

  /* what the check looked at */
  checkedStructTree: dictKey('op.a11y.checked.structTree'),
  checkedMarkInfo: dictKey('op.a11y.checked.markInfo'),
  checkedLang: dictKey('op.a11y.checked.lang'),
  checkedTitles: dictKey('op.a11y.checked.titles'),
  checkedImageAlt: dictKey('op.a11y.checked.imageAlt'),
  checkedFieldTooltip: dictKey('op.a11y.checked.fieldTooltip'),
  checkedLinkContents: dictKey('op.a11y.checked.linkContents'),
  checkedParagraphs: dictKey('op.a11y.checked.paragraphs'),

  /* what the check did not look at — the report's own honesty list */
  notCheckedReadingOrder: dictKey('op.a11y.notChecked.readingOrder'),
  notCheckedTables: dictKey('op.a11y.notChecked.tables'),
  notCheckedArtifacts: dictKey('op.a11y.notChecked.artifacts'),
  notCheckedFonts: dictKey('op.a11y.notChecked.fonts'),
  notCheckedAnnotStructure: dictKey('op.a11y.notChecked.annotStructure'),
  notCheckedAltQuality: dictKey('op.a11y.notChecked.altQuality'),
  notCheckedVisual: dictKey('op.a11y.notChecked.visual'),
  notCheckedRaster: dictKey('op.a11y.notChecked.raster'),
  notCheckedConformance: dictKey('op.a11y.notChecked.conformance'),
} as const;

/** The checks that ran, in report order. */
const CHECKED_KEYS: readonly MessageKey[] = [
  A11Y_KEYS.checkedStructTree,
  A11Y_KEYS.checkedMarkInfo,
  A11Y_KEYS.checkedLang,
  A11Y_KEYS.checkedTitles,
  A11Y_KEYS.checkedImageAlt,
  A11Y_KEYS.checkedFieldTooltip,
  A11Y_KEYS.checkedLinkContents,
  A11Y_KEYS.checkedParagraphs,
];

/**
 * The PDF/UA requirements this check does **not** evaluate. Every entry is a sentence
 * about the report, not about the document, and the panel renders the list verbatim —
 * it is the reason the module can say "these are the facts" without implying "this file
 * is accessible".
 */
const NOT_CHECKED_KEYS: readonly MessageKey[] = [
  A11Y_KEYS.notCheckedReadingOrder,
  A11Y_KEYS.notCheckedTables,
  A11Y_KEYS.notCheckedArtifacts,
  A11Y_KEYS.notCheckedFonts,
  A11Y_KEYS.notCheckedAnnotStructure,
  A11Y_KEYS.notCheckedAltQuality,
  A11Y_KEYS.notCheckedVisual,
  A11Y_KEYS.notCheckedRaster,
  A11Y_KEYS.notCheckedConformance,
];

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

/** `problem` = found; `ok` = the check ran and found nothing; `unchecked` = the check could not run. */
export type AccessibilityFindingState = 'problem' | 'ok' | 'unchecked';

export interface AccessibilityFinding {
  /** Stable per check (`struct-tree`, `mark-info`, `lang`, `title-info`, `image-alt`, …). */
  readonly id: string;
  readonly state: AccessibilityFindingState;
  /** The sentence, as a dictionary key. */
  readonly key: MessageKey;
  readonly params?: Readonly<Record<string, string | number>>;
  /** The 0-based page the finding concerns, when it concerns one. */
  readonly pageIndex?: number;
  /**
   * PDF notation the user can look up (`image Im1`, `field MüşteriAdı`,
   * `annotation 12 0 R`) — identifiers, never prose, so nothing English can leak into
   * the Turkish interface (`redact-audit.ts` uses the same rule).
   */
  readonly where?: string;
}

/** One image XObject that a page's content stream actually draws. */
export interface AccessibilityImage {
  /** The first page that draws it — the page whose resources name it. */
  readonly pageIndex: number;
  /** The `/Resources /XObject` name on that page, without the leading slash. */
  readonly name: string;
  /** `12 0 R`. */
  readonly ref: string;
  /** Every 0-based page whose content stream draws it, in page order. */
  readonly pages: readonly number[];
  /**
   * The alt text a reader gives the image, trimmed: the `/Alt` of the `Figure` element(s) that own it
   * in a tagged file, otherwise the XObject's `/Alt`; `null` when there is none or it is empty.
   */
  readonly alt: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

/** One AcroForm field, by its fully qualified name. */
export interface AccessibilityField {
  readonly name: string;
  /** The `/TU` tooltip; `null` when the field carries none. */
  readonly tooltip: string | null;
  /** The page its widget sits on, when the widget names one. */
  readonly pageIndex: number | null;
}

export interface AccessibilityStructure {
  readonly present: boolean;
  /** False when `/StructTreeRoot` is present but is not a dictionary this walk can enter. */
  readonly readable: boolean;
  /** Elements carrying an `/S` role that the walk visited. */
  readonly elementCount: number;
  /** Element counts by role (`P`, `H1`, `Figure`, …). */
  readonly roles: Readonly<Record<string, number>>;
  readonly paragraphCount: number;
  /** True when the walk stopped at its own bound — the counts are then lower bounds. */
  readonly truncated: boolean;
}

export interface AccessibilityReport {
  readonly pageCount: number;
  readonly findings: readonly AccessibilityFinding[];
  /** The checks that ran, in order. */
  readonly checked: readonly MessageKey[];
  /** The requirements this check does not evaluate — read this before the findings. */
  readonly notChecked: readonly MessageKey[];
  readonly images: readonly AccessibilityImage[];
  readonly fields: readonly AccessibilityField[];
  readonly structure: AccessibilityStructure;
}

/**
 * The page-text extractor `tagDocument` reads blocks with. The default is
 * `readDocumentText` — MuPDF's glyph walk through the engine adapter, the same path the
 * text tool uses, with the whole document opened once instead of once per page. A reader
 * given here is called page by page. The Node probe injects its own reader because the adapter resolves
 * MuPDF **by the URL the browser build serves it from** (`engines/mupdf.ts`), which no
 * Node process has; the probe's reader walks the npm `mupdf` package and returns the
 * same `PageTextInput`, so the model under test is unchanged.
 */
export type PageTextReader = (
  bytes: Uint8Array,
  pageIndex: number,
  context: OperationContext,
) => Promise<PageTextInput>;

export interface TagDocumentOptions {
  /**
   * BCP-47 language written into the catalog's `/Lang` when the document has none.
   *
   * There is no honest way to guess a document's language, so this module does not: the
   * caller states it (the panel passes the interface's own locale) and the report says
   * which language was written. Without it no `/Lang` is written and the report carries
   * a warning that says so.
   */
  readonly language?: string;
  /** See {@link PageTextReader}. Absent → MuPDF through the adapter. */
  readonly pageText?: PageTextReader;
  /**
   * What the reading-order editor decided for an untagged file: the order of the
   * elements in the tree, the role of each block and the alt text of each figure.
   * Without a plan the order is the content stream's and the roles are the size-based
   * guess, exactly as before.
   */
  readonly plan?: TagPlan;
}

/** One page of a {@link TagPlan}; ids are the `TagCandidate` ids of that page. */
export interface TagPlanPage {
  /** Candidate ids in the order their elements go in the tree; the unlisted follow in content order. */
  readonly order?: readonly string[];
  /** A role per candidate id; `Artifact` marks the content as decorative and writes no element. */
  readonly roles?: Readonly<Record<string, string>>;
  /** `/Alt` per figure id. */
  readonly alts?: Readonly<Record<string, string>>;
}

export interface TagPlan {
  readonly pages: Readonly<Record<number, TagPlanPage>>;
}

/** An alt text for an image XObject, or a tooltip for a form field. */
export type AltTextEdit =
  | {
      /** The image's resource name on this page — the pair `checkAccessibility` reports. */
      readonly kind: 'image';
      readonly pageIndex: number;
      readonly name: string;
      readonly alt: string;
    }
  | {
      /** The field's fully qualified name (`checkAccessibility` reports it the same way). */
      readonly kind: 'field';
      readonly name: string;
      readonly tooltip: string;
    };

function refuse(message: string, path: string): never {
  throw new ToolError('unsupported', { engine: 'mupdf', path, engineMessage: message });
}

/* ------------------------------------------------------------------ *
 * Bounds
 * ------------------------------------------------------------------ */

/**
 * How far from a block's ink box a text-showing operator's origin may sit and still be
 * called that block's: 2 pt plus half the block's own font size. The half-em covers the
 * distance from a line's ink box to its baseline (the model builds line boxes from glyph
 * quads, so a line of x-height-only letters has its baseline at the box's bottom edge),
 * and 2 pt covers the side bearing before the first glyph. It is deliberately smaller
 * than one line of leading at body sizes, so the next paragraph down cannot win.
 */
const MATCH_SLACK_BASE_PT = 2;
const MATCH_SLACK_EM = 0.5;

/**
 * A block is a heading when its size is unmistakable on its own (1.4× the body size) or
 * when it is bold *and* clearly larger (1.2×). Both thresholds are deliberately coarse:
 * this is a guess written into the file's structure, and the report says so
 * (`op.note.a11y.headingGuess`). Nothing here guesses *levels* beyond ranking the
 * heading sizes, and nothing beyond the six standard levels is written as a heading.
 */
const HEADING_SIZE_RATIO = 1.4;
const HEADING_BOLD_RATIO = 1.2;
const MAX_HEADING_LEVELS = 6;

/** Nesting depth of `Do`-reached form XObjects the image inventory descends into. */
export const FORM_DEPTH_LIMIT = 3;
/** Elements the structure-tree walk visits before it stops and says so. */
const STRUCT_WALK_LIMIT = 4000;
/** Elements the structure model, and the walk that finds the figure of a picture, read before they stop. */
export const STRUCT_NODE_LIMIT = 30_000;
/** AcroForm fields the walk visits (a `/Kids` cycle cannot run forever). */
export const FIELD_WALK_LIMIT = 3000;
/** Distinct image XObjects the check lists. */
const IMAGE_LIMIT = 2000;
/** Detail rows one check lists before it summarises the rest. */
export const FINDING_ROW_LIMIT = 40;
/** Structure elements `tagDocument` writes before it stops tagging further pages. */
const TAG_ELEMENT_LIMIT = 5000;
/** Instructions a page's content stream may hold before the scan is refused as absurd. */
const INSTRUCTION_LIMIT = 1_000_000;
/** Pages whose glyphs are read through one MuPDF document before they are reduced to blocks. */
const PAGE_READ_BATCH = 64;

/* ------------------------------------------------------------------ *
 * Content stream: tokenizer
 * ------------------------------------------------------------------ */

type Operand =
  | { readonly kind: 'number'; readonly number: number }
  /** A name operand, without the leading slash. */
  | { readonly kind: 'name'; readonly name: string }
  /** A string, hex string, array, dict, boolean or `null`: delimited, never read. */
  | { readonly kind: 'other' };

const OTHER: Operand = { kind: 'other' };

/**
 * One instruction of a content stream: its operands, its operator, and the byte range
 * that holds them. `start` is the first byte of the instruction (its first operand, or
 * the operator when it has none) and `end` is one past the operator — the range the
 * writer copies when it splices marked-content operators in.
 */
export interface Instruction {
  readonly operator: string;
  readonly operands: readonly Operand[];
  readonly start: number;
  readonly end: number;
}

const WHITESPACE = new Set<number>([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
// `(`, `)`, `<`, `>`, `[`, `]`, `{`, `}`, `/`, `%` — PDF 32000-1 §7.2.3.
const DELIMITER = new Set<number>([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const NUMBER_TOKEN = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function isWhitespace(byte: number): boolean {
  return WHITESPACE.has(byte);
}

function isDelimiter(byte: number): boolean {
  return DELIMITER.has(byte);
}

function isRegular(byte: number): boolean {
  return !isWhitespace(byte) && !isDelimiter(byte);
}

/** `(…)`: nesting counts and a backslash escapes the next byte (§7.3.4.2). */
function skipLiteralString(buffer: Uint8Array, from: number): number {
  let depth = 0;
  let cursor = from;
  while (cursor < buffer.length) {
    const byte = buffer[cursor] as number;
    if (byte === 0x5c) {
      cursor += 2;
      continue;
    }
    if (byte === 0x28) depth += 1;
    else if (byte === 0x29) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
    cursor += 1;
  }
  return buffer.length;
}

/**
 * Composite objects nested deeper than this are not a content stream this scanner trusts:
 * the skippers recurse once per level, and a hostile `[<<[<<…` must end as an unreadable
 * page, not as a stack overflow.
 */
const NESTING_LIMIT = 256;

/** `%` to the end of the line (§7.2.4): a comment inside an array or dictionary can hold any delimiter. */
function skipComment(buffer: Uint8Array, from: number): number {
  let cursor = from;
  while (cursor < buffer.length && buffer[cursor] !== 0x0a && buffer[cursor] !== 0x0d) cursor += 1;
  return cursor;
}

/** `<…>` hex string: up to and including the first `>`. */
function skipHexString(buffer: Uint8Array, from: number): number {
  let cursor = from + 1;
  while (cursor < buffer.length && buffer[cursor] !== 0x3e) cursor += 1;
  return Math.min(cursor + 1, buffer.length);
}

/**
 * `<…>` hex strings and `<<…>>` dictionaries.
 *
 * A dictionary is walked as the objects it holds, not as bytes: a literal string inside it
 * (`(A>>B)`) can carry a `>>`, and a hex string's own closing `>` sits right in front of the
 * dictionary's (`<</ActualText<FEFF0041>>>`), so counting `>>` pairs ends the dictionary one
 * byte early and leaves a stray `>` behind that makes the whole page unreadable.
 */
function skipAngle(buffer: Uint8Array, from: number, level = 0): number {
  if (buffer[from + 1] !== 0x3c) return skipHexString(buffer, from);
  if (level > NESTING_LIMIT) return buffer.length;
  let depth = 0;
  let cursor = from;
  while (cursor < buffer.length) {
    const byte = buffer[cursor] as number;
    if (byte === 0x3c) {
      if (buffer[cursor + 1] === 0x3c) {
        depth += 1;
        cursor += 2;
      } else cursor = skipHexString(buffer, cursor);
    } else if (byte === 0x3e && buffer[cursor + 1] === 0x3e) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) return cursor;
    } else if (byte === 0x28) cursor = skipLiteralString(buffer, cursor);
    else if (byte === 0x5b) cursor = skipArray(buffer, cursor, level + 1);
    else if (byte === 0x25) cursor = skipComment(buffer, cursor);
    else cursor += 1;
  }
  return buffer.length;
}

/** `[…]`: strings, dictionaries and comments inside it cannot end the array early. */
function skipArray(buffer: Uint8Array, from: number, level = 0): number {
  if (level > NESTING_LIMIT) return buffer.length;
  let cursor = from + 1;
  while (cursor < buffer.length) {
    const byte = buffer[cursor] as number;
    if (byte === 0x28) cursor = skipLiteralString(buffer, cursor);
    else if (byte === 0x3c) cursor = skipAngle(buffer, cursor, level + 1);
    else if (byte === 0x5b) cursor = skipArray(buffer, cursor, level + 1);
    else if (byte === 0x25) cursor = skipComment(buffer, cursor);
    else if (byte === 0x5d) return cursor + 1;
    else cursor += 1;
  }
  return buffer.length;
}

/** `/Name#20With#28escapes` → `Name With(escapes)` (§7.3.5). */
function decodeNameEscapes(name: string): string {
  if (!name.includes('#')) return name;
  return name.replace(/#([0-9a-fA-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * The content stream as instructions. `null` means the buffer is not a content stream
 * this scanner can delimit (unbalanced delimiters, dangling operands, a truncated
 * inline image) — the caller then reports the page as unreadable instead of guessing,
 * because a wrong instruction boundary would put a `BDC` in the middle of a string.
 */
export function readInstructions(buffer: Uint8Array): readonly Instruction[] | null {
  const instructions: Instruction[] = [];
  let operands: Operand[] = [];
  let cursor = 0;
  let start = 0;

  while (cursor < buffer.length) {
    const byte = buffer[cursor] as number;
    if (isWhitespace(byte)) {
      cursor += 1;
      continue;
    }
    if (byte === 0x25) {
      while (cursor < buffer.length && buffer[cursor] !== 0x0a && buffer[cursor] !== 0x0d) {
        cursor += 1;
      }
      continue;
    }
    const tokenStart = cursor;
    if (byte === 0x2f) {
      cursor += 1;
      let raw = '';
      while (cursor < buffer.length && isRegular(buffer[cursor] as number)) {
        raw += String.fromCharCode(buffer[cursor] as number);
        cursor += 1;
      }
      if (operands.length === 0) start = tokenStart;
      operands.push({ kind: 'name', name: decodeNameEscapes(raw) });
      continue;
    }
    if (byte === 0x28) {
      cursor = skipLiteralString(buffer, cursor);
      if (operands.length === 0) start = tokenStart;
      operands.push(OTHER);
      continue;
    }
    if (byte === 0x3c) {
      cursor = skipAngle(buffer, cursor);
      if (operands.length === 0) start = tokenStart;
      operands.push(OTHER);
      continue;
    }
    if (byte === 0x5b) {
      cursor = skipArray(buffer, cursor);
      if (operands.length === 0) start = tokenStart;
      operands.push(OTHER);
      continue;
    }
    if (byte === 0x5d || byte === 0x3e || byte === 0x7d || byte === 0x7b || byte === 0x29) {
      // A closing delimiter with nothing open: not the content stream this scanner knows.
      return null;
    }
    let token = '';
    while (cursor < buffer.length && isRegular(buffer[cursor] as number)) {
      token += String.fromCharCode(buffer[cursor] as number);
      cursor += 1;
    }
    if (NUMBER_TOKEN.test(token)) {
      if (operands.length === 0) start = tokenStart;
      operands.push({ kind: 'number', number: Number(token) });
      continue;
    }
    if (operands.length === 0) start = tokenStart;
    if (token === 'BI') {
      // `BI … ID <binary> EI`: the data is not tokenizable and its bytes can spell anything, `Do`
      // included, so it is ended by the one rule the PDF/A reader ends it by (`inlineImageEnd`),
      // which also keeps `/EI`-shaped names and `(EI)` strings in the image dictionary from
      // ending the scan early. `cursor` is past the `BI` token, so a byte precedes every `EI`.
      const end = inlineImageEnd(buffer, cursor);
      if (end === null) return null;
      instructions.push({ operator: 'BI', operands: [], start, end });
      if (instructions.length > INSTRUCTION_LIMIT) return null;
      cursor = end;
      operands = [];
      start = end;
      continue;
    }
    instructions.push({ operator: token, operands, start, end: cursor });
    if (instructions.length > INSTRUCTION_LIMIT) return null;
    operands = [];
    start = cursor;
  }
  // Operands with no operator behind them is a truncated stream, not a lost operand.
  return operands.length === 0 ? instructions : null;
}

/**
 * The content-stream scanner under its public names: the sanitiser's hidden-layer pass
 * (`sanitize-layers.ts`) cuts marked-content sections out of a page at exactly the
 * instruction boundaries tagging splices at, and a second scanner would be a second idea of
 * where a string or an inline image ends.
 */
export type { Instruction as ContentInstruction, Operand as ContentOperand };
export { readInstructions as readContentInstructions };

/** The first `count` operands when every one of them is a number, otherwise `null`. */
export function numbersOf(instruction: Instruction, count: number): readonly number[] | null {
  if (instruction.operands.length < count) return null;
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const operand = instruction.operands[index];
    if (operand === undefined || operand.kind !== 'number') return null;
    values.push(operand.number);
  }
  return values;
}

/* ------------------------------------------------------------------ *
 * Content stream: the pass that locates drawing operators
 * ------------------------------------------------------------------ */

/** `[a b c d e f]` in PDF's row-vector convention (§8.3.3). */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m1` applied first, then `m2` — the composition `cm`/`Td`/`Tm` all use. */
export function concatMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function transformPoint(
  matrix: Matrix,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
}

/** One text-showing operator, at the point its text matrix puts it (user space). */
export interface ShowOp {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  /** The size in force (`Tf`), in points; `0` when the stream never set one. */
  readonly fontSize: number;
  readonly fontName: string | null;
}

/** One `Do` operator, with the resource name it draws. */
export interface DrawOp {
  readonly index: number;
  readonly name: string;
}

export interface ContentScan {
  readonly bytes: Uint8Array;
  readonly instructions: readonly Instruction[];
  readonly shows: readonly ShowOp[];
  readonly draws: readonly DrawOp[];
}

/**
 * Walk a page's operators and report where text is shown and what is drawn.
 *
 * The graphics state is followed far enough to answer one question honestly — *where
 * does this show operator put its text in user space* — which needs the CTM (`q`, `Q`,
 * `cm`) and the text matrices (`BT`, `Tm`, `Td`, `TD`, `T*`, `TL`). Advances *within* a
 * run are not computed (that would need the font's `/Widths`), so consecutive show
 * operators on one line report the same origin; a block's rect covers its whole line, so
 * the assignment is unaffected. Rotated text is covered because the matrices are: the
 * origin goes through `Tm` and then the CTM, whatever they hold.
 */
function walkContent(instructions: readonly Instruction[]): {
  readonly shows: readonly ShowOp[];
  readonly draws: readonly DrawOp[];
} {
  const shows: ShowOp[] = [];
  const draws: DrawOp[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let leading = 0;
  let fontSize = 0;
  let fontName: string | null = null;

  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index] as Instruction;
    switch (instruction.operator) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q': {
        const saved = stack.pop();
        if (saved !== undefined) ctm = saved;
        break;
      }
      case 'cm': {
        const values = numbersOf(instruction, 6);
        if (values !== null) {
          ctm = concatMatrix(
            [
              values[0] as number,
              values[1] as number,
              values[2] as number,
              values[3] as number,
              values[4] as number,
              values[5] as number,
            ],
            ctm,
          );
        }
        break;
      }
      case 'BT':
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case 'Tf': {
        const name = instruction.operands[0];
        const size = instruction.operands[1];
        if (name !== undefined && name.kind === 'name') fontName = name.name;
        if (size !== undefined && size.kind === 'number') fontSize = size.number;
        break;
      }
      case 'TL': {
        const value = instruction.operands[0];
        if (value !== undefined && value.kind === 'number') leading = value.number;
        break;
      }
      case 'TD':
      case 'Td': {
        const values = numbersOf(instruction, 2);
        if (values === null) break;
        if (instruction.operator === 'TD') leading = -(values[1] as number);
        tlm = concatMatrix([1, 0, 0, 1, values[0] as number, values[1] as number], tlm);
        tm = tlm;
        break;
      }
      case 'Tm': {
        const values = numbersOf(instruction, 6);
        if (values !== null) {
          tm = [
            values[0] as number,
            values[1] as number,
            values[2] as number,
            values[3] as number,
            values[4] as number,
            values[5] as number,
          ];
          tlm = tm;
        }
        break;
      }
      case 'T*':
      case "'":
      case '"':
      case 'Tj':
      case 'TJ': {
        // `T*` only moves to the next line; `'` and `"` move **and** show (§9.4.3).
        if (instruction.operator === 'T*' || instruction.operator === "'" || instruction.operator === '"') {
          tlm = concatMatrix([1, 0, 0, 1, 0, -leading], tlm);
          tm = tlm;
        }
        if (instruction.operator === 'T*') break;
        const point = transformPoint(concatMatrix(tm, ctm), 0, 0);
        shows.push({ index, x: point.x, y: point.y, fontSize, fontName });
        break;
      }
      case 'Do': {
        const name = instruction.operands[0];
        if (name !== undefined && name.kind === 'name') draws.push({ index, name: name.name });
        break;
      }
      default:
        break;
    }
  }
  return { shows, draws };
}

/* ------------------------------------------------------------------ *
 * Reading a page's content
 * ------------------------------------------------------------------ */

/** The stream bytes, decoded; `null` when the filter chain is one this reader cannot run. */
export function decodeStream(stream: PDFObject): Uint8Array | null {
  if (!stream.isStream()) return null;
  try {
    const buffer = stream.readStream();
    try {
      return new Uint8Array(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  } catch {
    // A filter this build cannot run (or a truncated stream) is a *fact* about the file:
    // the caller reports the page as unreadable rather than treating it as empty.
    return null;
  }
}

/**
 * Every stream behind a page's `/Contents` as one buffer, or `null` when one of them
 * cannot be decoded. The streams are concatenated with a newline, which is exactly what
 * a reader does with an array of content streams (§7.8.2): introducing a whitespace byte
 * between them cannot change the token stream.
 */
export function pageContent(page: PDFObject): { readonly bytes: Uint8Array } | null {
  const contents = page.get('Contents');
  if (contents.isNull()) return { bytes: new Uint8Array(0) };
  const target = contents.isStream() ? null : resolved(contents);
  const entries: PDFObject[] = [];
  if (target?.isArray() === true) {
    for (let index = 0; index < target.length; index += 1) entries.push(target.get(index));
  } else {
    entries.push(contents);
  }
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    if (entry.isNull()) continue;
    const decoded = decodeStream(entry);
    if (decoded === null) return null;
    parts.push(decoded, new Uint8Array([0x0a]));
  }
  return { bytes: concatBytes(parts) };
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export type PageScan =
  | { readonly ok: true; readonly scan: ContentScan }
  | { readonly ok: false; readonly reason: 'decode' | 'malformed' };

export function scanPage(page: PDFObject): PageScan {
  const content = pageContent(page);
  if (content === null) return { ok: false, reason: 'decode' };
  const instructions = readInstructions(content.bytes);
  if (instructions === null) return { ok: false, reason: 'malformed' };
  const walked = walkContent(instructions);
  return {
    ok: true,
    scan: { bytes: content.bytes, instructions, shows: walked.shows, draws: walked.draws },
  };
}

/* ------------------------------------------------------------------ *
 * Text: blocks, matching, headings
 * ------------------------------------------------------------------ */

/**
 * One block as the tagger needs it. The page model's glyphs are thrown away: what a
 * tagged run needs is *where* the block's ink is and whether it looks like a heading,
 * and keeping every glyph of every page of a large document alive for the second pass
 * would cost more than the tagging itself.
 */
export interface BlockRegion {
  readonly id: string;
  /**
   * Model space (`pdf-core/src/text-source.ts`, "Space"): user-space x, `y` the distance
   * below the box's top edge (`box.y + box.height − userY`).
   */
  readonly rect: Rect;
  readonly fontSize: number;
  readonly bold: boolean;
  /** Characters the block holds — the weight the body-size vote uses. */
  readonly characters: number;
  /** The block's text, lines joined by a space — what the reading-order editor labels it with. */
  readonly text: string;
}

export function toRegions(input: PageTextInput): readonly BlockRegion[] {
  const page = buildTextPage(input);
  return page.blocks.map((block) => ({
    id: block.id,
    rect: block.rect,
    fontSize: block.style.fontSize,
    bold: block.style.bold,
    characters: block.text.length,
    text: block.text.replace(/\s+/g, ' ').trim(),
  }));
}

/** The page box the model's `y` is measured from the top of (`CropBox`, per `readPageText`). */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Distance from a point to a rect, `0` when it is inside. */
function rectDistance(rect: Rect, x: number, y: number): number {
  const dx = x < rect[0] ? rect[0] - x : x > rect[2] ? x - rect[2] : 0;
  const dy = y < rect[1] ? rect[1] - y : y > rect[3] ? y - rect[3] : 0;
  return Math.hypot(dx, dy);
}

interface BlockMatch {
  readonly blockIndex: number;
  readonly first: number;
  readonly last: number;
  readonly count: number;
  /** The instruction index of every show the block owns, ascending. */
  readonly shows: readonly number[];
}

export interface MatchResult {
  readonly matches: readonly BlockMatch[];
  /** Shows that landed on some block (sum of `count`). */
  readonly matched: number;
  /** Shows whose nearest block was outside its slack. */
  readonly unmatched: number;
  /** Shows whose nearest block was a tie between two blocks — the first won. */
  readonly ambiguous: number;
}

/**
 * Assign every text-showing operator to a block: the block whose ink box is nearest,
 * when that distance is within the slack. Blocks whose shows are non-adjacent in the
 * stream are still reported as one range (`first`…`last`), and the caller drops the
 * range if it overlaps another — a tagged range must not cut through another range's
 * text.
 */
export function matchBlocks(
  shows: readonly ShowOp[],
  regions: readonly BlockRegion[],
  box: Box,
): MatchResult {
  const owned = new Map<number, { first: number; last: number; count: number; shows: number[] }>();
  let matched = 0;
  let unmatched = 0;
  let ambiguous = 0;

  for (const show of shows) {
    // The show's user-space `y` into the model's: the distance below the box's top edge.
    const point = { x: show.x, y: box.y + box.height - show.y };
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let ties = 0;
    for (let index = 0; index < regions.length; index += 1) {
      const region = regions[index] as BlockRegion;
      const slack = Math.max(MATCH_SLACK_BASE_PT, region.fontSize * MATCH_SLACK_EM);
      const distance = rectDistance(region.rect, point.x, point.y);
      if (distance > slack) continue;
      if (distance < bestDistance - 0.001) {
        bestDistance = distance;
        best = index;
        ties = 1;
      } else if (Math.abs(distance - bestDistance) <= 0.001) {
        ties += 1;
      }
    }
    if (best < 0) {
      unmatched += 1;
      continue;
    }
    if (ties > 1) ambiguous += 1;
    matched += 1;
    const entry = owned.get(best);
    if (entry === undefined) {
      owned.set(best, { first: show.index, last: show.index, count: 1, shows: [show.index] });
    } else {
      entry.last = show.index;
      entry.count += 1;
      entry.shows.push(show.index);
    }
  }

  const matches: BlockMatch[] = [];
  for (const [blockIndex, entry] of owned) {
    matches.push({
      blockIndex,
      first: entry.first,
      last: entry.last,
      count: entry.count,
      shows: entry.shows,
    });
  }
  matches.sort((left, right) => left.first - right.first);
  return { matches, matched, unmatched, ambiguous };
}

/**
 * The body font size: the round point size with the most characters behind it. A
 * heading pollutes the vote only in proportion to its own text, and every document this
 * app meets has more body text than headings. An empty document answers `0`, which
 * switches heading detection off rather than inventing a body size.
 */
function bodyFontSize(pages: readonly (readonly BlockRegion[])[]): number {
  const weight = new Map<number, number>();
  for (const regions of pages) {
    for (const region of regions) {
      const size = Math.round(region.fontSize);
      if (size <= 0) continue;
      weight.set(size, (weight.get(size) ?? 0) + Math.max(1, region.characters));
    }
  }
  let bestSize = 0;
  let bestWeight = 0;
  for (const [size, characters] of weight) {
    if (characters > bestWeight) {
      bestWeight = characters;
      bestSize = size;
    }
  }
  return bestSize;
}

/**
 * Size → role. The largest heading size becomes `/H1`, the next `/H2`, and so on; sizes
 * beyond the sixth distinct heading size are **not** written as headings at all, because
 * a seventh level does not exist and calling one of them `/H6` would state a nesting the
 * document does not have (`MAX_HEADING_LEVELS`).
 */
function headingRoles(
  regions: readonly (readonly BlockRegion[])[],
  body: number,
): ReadonlyMap<number, string> {
  // No body size means no text worth a vote (or text too small to round to a point): nothing
  // can be told apart from it, so nothing is a heading.
  if (body <= 0) return new Map();
  const sizes = new Set<number>();
  for (const page of regions) {
    for (const region of page) {
      const isHeading =
        region.fontSize >= body * HEADING_SIZE_RATIO ||
        (region.bold && region.fontSize >= body * HEADING_BOLD_RATIO);
      if (isHeading) sizes.add(Math.round(region.fontSize));
    }
  }
  const ranked = [...sizes].sort((left, right) => right - left).slice(0, MAX_HEADING_LEVELS);
  return new Map(ranked.map((size, index) => [size, `H${String(index + 1)}`]));
}

/* ------------------------------------------------------------------ *
 * Tagging: marked content
 * ------------------------------------------------------------------ */

export interface Claim {
  /** Instruction index the `BDC` goes in front of. */
  readonly first: number;
  /** Instruction index the `EMC` goes after. */
  readonly last: number;
  /** The structure type, or `Artifact` for content that gets no element. */
  readonly role: string;
  /** The candidate id: the text model's block id (`b3`) or `f<instruction>` for a figure. */
  readonly blockId: string;
  /** `/Alt` for a figure, copied from the XObject when it has one. */
  readonly alt: string | null;
  /** The marked-content id; `-1` for an artifact, which has none. */
  readonly mcid: number;
}

/**
 * Where a marked-content sequence may open and close. Three nesting rules hold for `BDC … EMC`
 * (ISO 32000-1 §14.6, and what PDF/UA validators flag): a sequence must not straddle two
 * text objects (`BT … ET`), must not straddle a graphics-state level (`q … Q`), and must not
 * cut across a marked-content sequence the page already has (`BDC … [BDC … EMC] … EMC` nests,
 * `BDC … [BDC … EMC … ] EMC` does not). One sequence *inside* a text object is fine — several
 * blocks often share one. The scan records, for every position (the point before an
 * instruction), which text object it is in and how deep the `q` stack and the stack of open
 * marked-content sequences are, so a claim can be widened to the nearest range that opens and
 * closes at the same level.
 */
export interface Nesting {
  /** `object[p]`: the text object the position before instruction `p` is inside, `-1` outside. Length `n + 1`. */
  readonly object: readonly number[];
  /** `depth[p]`: the `q` depth before instruction `p`. Length `n + 1`. */
  readonly depth: readonly number[];
  /** `marked[p]`: how many `BMC`/`BDC` sequences are open before instruction `p`. Length `n + 1`. */
  readonly marked: readonly number[];
}

export function nestingOf(instructions: readonly Instruction[]): Nesting {
  const object: number[] = [-1];
  const depth: number[] = [0];
  const marked: number[] = [0];
  let current = -1;
  let next = 0;
  let level = 0;
  let open = 0;
  for (const instruction of instructions) {
    if (instruction.operator === 'BT') {
      current = next;
      next += 1;
    } else if (instruction.operator === 'ET') current = -1;
    else if (instruction.operator === 'q') level += 1;
    else if (instruction.operator === 'Q' && level > 0) level -= 1;
    else if (instruction.operator === 'BMC' || instruction.operator === 'BDC') open += 1;
    else if (instruction.operator === 'EMC' && open > 0) open -= 1;
    object.push(current);
    depth.push(level);
    marked.push(open);
  }
  return { object, depth, marked };
}

/**
 * Widen `[a, b]` until `levels` (a stack depth before every instruction) is the same at both
 * ends and never drops below it in between: everything opened inside the range is closed
 * inside it, and nothing that was already open outside it is closed inside it. `null` when the
 * stream never reaches such a range (a level that is opened and never closed).
 */
function settleLevels(
  levels: readonly number[],
  a: number,
  b: number,
  count: number,
): { readonly a: number; readonly b: number } | null {
  let first = a;
  let last = b;
  let lowest = levels[first] as number;
  for (let position = first; position <= last + 1; position += 1) {
    lowest = Math.min(lowest, levels[position] as number);
  }
  if ((levels[first] as number) > lowest) {
    let cursor = first;
    while (cursor > 0 && (levels[cursor] as number) !== lowest) cursor -= 1;
    if ((levels[cursor] as number) !== lowest) return null;
    first = cursor;
  }
  if ((levels[last + 1] as number) > (levels[first] as number)) {
    let cursor = last + 1;
    while (cursor < count && (levels[cursor + 1] as number) > (levels[first] as number)) cursor += 1;
    if (cursor >= count) return null;
    last = cursor;
  }
  return { a: first, b: last };
}

/**
 * The smallest range containing `[first, last]` that a marked-content sequence can wrap
 * without straddling two text objects, a `q` level or a marked-content sequence the stream
 * already has; `null` when no such range exists in the stream (an unbalanced `q`, a text
 * object or sequence that never ends).
 */
export function expandToNesting(
  instructions: readonly Instruction[],
  nesting: Nesting,
  first: number,
  last: number,
): { readonly first: number; readonly last: number } | null {
  let a = first;
  let b = last;
  const count = instructions.length;
  for (let round = 0; round < 64; round += 1) {
    let changed = false;
    const startObject = nesting.object[a] as number;
    const endObject = nesting.object[b + 1] as number;
    if (startObject !== endObject) {
      if (startObject !== -1) {
        let cursor = a;
        while (cursor > 0 && (instructions[cursor] as Instruction).operator !== 'BT') cursor -= 1;
        if ((instructions[cursor] as Instruction).operator !== 'BT') return null;
        a = cursor;
      }
      if (endObject !== -1) {
        let cursor = b + 1;
        while (cursor < count && (instructions[cursor] as Instruction).operator !== 'ET') cursor += 1;
        if (cursor >= count) return null;
        b = cursor;
      }
      changed = true;
    }
    for (const levels of [nesting.depth, nesting.marked]) {
      const settled = settleLevels(levels, a, b, count);
      if (settled === null) return null;
      if (settled.a !== a || settled.b !== b) changed = true;
      a = settled.a;
      b = settled.b;
    }
    if (!changed) return { first: a, last: b };
  }
  return null;
}

/**
 * Splice `/P <</MCID n>> BDC … EMC` (or `/Artifact BMC … EMC`) into the page's own bytes at
 * instruction boundaries.
 *
 * The original bytes are copied verbatim between the insertions — a content stream holds
 * strings, hex strings and inline image data whose re-serialisation could change meaning,
 * and there is no reason to rewrite what is already correct. Only the claims handed in
 * are inserted; the caller has already made sure they do not overlap.
 */
export function spliceMarkedContent(
  scan: ContentScan,
  claims: readonly Claim[],
): { readonly bytes: Uint8Array; readonly open: number; readonly close: number } {
  const opens = new Map<number, Claim>();
  const closes = new Set<number>();
  for (const claim of claims) {
    opens.set(claim.first, claim);
    closes.add(claim.last);
  }
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let cursor = 0;
  for (let index = 0; index < scan.instructions.length; index += 1) {
    const instruction = scan.instructions[index] as Instruction;
    const open = opens.get(index);
    if (open !== undefined) {
      chunks.push(
        encoder.encode(
          open.role === 'Artifact' ? '\n/Artifact BMC\n' : `\n/P <</MCID ${String(open.mcid)}>> BDC\n`,
        ),
      );
    }
    chunks.push(scan.bytes.subarray(cursor, instruction.start));
    chunks.push(scan.bytes.subarray(instruction.start, instruction.end));
    cursor = instruction.end;
    if (closes.has(index)) chunks.push(encoder.encode('\nEMC\n'));
  }
  chunks.push(scan.bytes.subarray(cursor));
  return { bytes: concatBytes(chunks), open: opens.size, close: closes.size };
}

/* ------------------------------------------------------------------ *
 * Writing the structure tree
 * ------------------------------------------------------------------ */

interface TaggedElement {
  readonly role: string;
  /** The marked-content ids the element owns on the page; more than one when its text spans several text objects. */
  readonly mcids: readonly number[];
  readonly alt: string | null;
}

interface TaggedPage {
  readonly pageIndex: number;
  /** The page dictionary's indirect reference, which every `/Pg` names. */
  readonly pageRef: PDFObject;
  /** The elements in tree order (the plan's, or content order). */
  readonly elements: readonly TaggedElement[];
  /** The marked-content operators and nesting faults the page's stream had before the splice, to verify the delta. */
  readonly before: MarkedContentShape;
  /** Sequences the splice added; `artifacts` of them are `/Artifact BMC`. */
  readonly added: { readonly total: number; readonly artifacts: number };
}

interface StructureWriteResult {
  readonly elements: number;
  readonly paragraphs: number;
  readonly headings: number;
  readonly figures: number;
}

/**
 * Write `/StructTreeRoot` → `/Document` → one element per marked-content sequence, with
 * the parent tree a tagged PDF needs to be navigable (§14.7.4.4): `/StructParents` on
 * each tagged page is the number-tree key, and the entry behind it is the array indexed
 * by MCID — so an assistive technology that meets `/MCID 3` on page 2 can find the
 * element that owns it without walking the tree. The page's structure tree is written
 * *after* the content, never the other way round: every MCR this writes already has a
 * `BDC` in the file.
 */
function writeStructure(doc: PDFDocument, pages: readonly TaggedPage[]): StructureWriteResult {
  const root = doc.addObject({ Type: 'StructTreeRoot' });
  const documentElement = doc.addObject({ Type: 'StructElem', S: 'Document', P: root, K: [] });
  root.put('K', [documentElement]);

  const nums = doc.newArray();
  const counts = new Map<string, number>();
  let elements = 0;
  // The next free key: past the highest one in use. Keys are page indexes, and a page that
  // was left untagged (an empty cover, a scan) leaves a hole, so the count of tagged pages
  // is a number some later page already uses (`pdfua.ts` computes it the same way).
  let nextKey = 0;

  for (const page of pages) {
    // The parent-tree entry is indexed by MCID, so it is built in MCID order and is
    // exactly as long as the page's highest MCID plus one.
    const parents: (PDFObject | undefined)[] = [];
    for (const element of page.elements) {
      const dict = doc.addObject({
        Type: 'StructElem',
        S: element.role,
        P: documentElement,
        Pg: page.pageRef,
        K: element.mcids.map((mcid) => ({ Type: 'MCR', Pg: page.pageRef, MCID: mcid })),
      });
      if (element.alt !== null) dict.put('Alt', text(doc, element.alt));
      documentElement.get('K').push(dict);
      for (const mcid of element.mcids) parents[mcid] = dict;
      counts.set(element.role, (counts.get(element.role) ?? 0) + 1);
      elements += 1;
    }
    const entry = doc.newArray();
    for (const parent of parents) entry.push(parent ?? doc.newNull());
    nums.push(page.pageIndex);
    nums.push(doc.addObject(entry));
    resolved(page.pageRef)?.put('StructParents', page.pageIndex);
    nextKey = Math.max(nextKey, page.pageIndex + 1);
  }

  root.put('ParentTree', doc.addObject({ Nums: nums }));
  root.put('ParentTreeNextKey', nextKey);
  catalogOf(doc).put('StructTreeRoot', root);

  return {
    elements,
    paragraphs: counts.get('P') ?? 0,
    headings: [...counts].reduce((total, [role, count]) => (role.startsWith('H') ? total + count : total), 0),
    figures: counts.get('Figure') ?? 0,
  };
}

/* ------------------------------------------------------------------ *
 * Reading values out of the file
 * ------------------------------------------------------------------ */

/**
 * A text string's value, trimmed; `null` when the entry is missing, is not a text
 * string or is empty. A value this reader cannot decode is reported as **absent** rather
 * than as present-and-unreadable: it is not a fact the user can act on, and pretending a
 * value exists would send them looking for text no reader shows.
 */
export function textOf(value: PDFObject | null | undefined): string | null {
  const decoded = readText(value)?.trim() ?? '';
  return decoded === '' ? null : decoded;
}

/** The dictionary an entry resolves to (a stream's dictionary included), or `null`. */
export function dictOf(value: PDFObject | null | undefined): PDFObject | null {
  const object = resolved(value);
  return object?.isDictionary() === true ? object : null;
}

export function nameOf(value: PDFObject | null | undefined): string | null {
  return readName(value);
}

export function intOf(dict: PDFObject | null, key: string): number | null {
  const value = dict === null ? null : resolved(dict.get(key));
  return value?.isNumber() === true ? value.asNumber() : null;
}

export function catalogOf(doc: PDFDocument): PDFObject {
  const catalog = resolved(doc.getTrailer().get('Root'));
  if (catalog === null) {
    throw new ToolError('corrupt-document', { engine: 'mupdf', engineMessage: 'the document has no /Root' });
  }
  return catalog;
}

/** `N 0 R` for an indirect entry, `?` when the file gives none. */
export function refName(entry: PDFObject): string {
  return entry.isIndirect() ? `${entry.asIndirect()} 0 R` : '?';
}

/** Page object number → 0-based page index. */
export function pageNumbers(pages: readonly PDFObject[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const [index, page] of pages.entries()) {
    if (page.isIndirect()) map.set(page.asIndirect(), index);
  }
  return map;
}

/* ------------------------------------------------------------------ *
 * The check
 * ------------------------------------------------------------------ */

function finding(
  id: string,
  state: AccessibilityFindingState,
  key: MessageKey,
  extra: {
    readonly params?: Readonly<Record<string, string | number>>;
    readonly pageIndex?: number;
    readonly where?: string;
  } = {},
): AccessibilityFinding {
  const base: {
    id: string;
    state: AccessibilityFindingState;
    key: MessageKey;
    params?: Readonly<Record<string, string | number>>;
    pageIndex?: number;
    where?: string;
  } = { id, state, key };
  if (extra.params !== undefined) base.params = extra.params;
  if (extra.pageIndex !== undefined) base.pageIndex = extra.pageIndex;
  if (extra.where !== undefined) base.where = extra.where;
  return base;
}

/** `1, 3, 7` — page numbers as the report shows them (1-based, clipped to a line). */
function pageList(pages: readonly number[]): string {
  const shown = pages.slice(0, 8).map((pageIndex) => pageIndex + 1);
  const text = shown.join(', ');
  return pages.length > shown.length ? `${text}…` : text;
}

/**
 * Every image XObject a content stream actually draws, including the ones drawn by a
 * form XObject it reaches with `Do`. Resources resolve **per stream**: a form's own
 * `/Resources` win over the page's, which is what a reader does, and a form that names
 * no resources falls back to the page's.
 */
function collectDrawnImages(
  resources: PDFObject | null,
  bytes: Uint8Array,
  depth: number,
  visited: Set<string>,
  out: { ref: string; name: string; dict: PDFObject }[],
  state: { tooDeep: boolean },
): void {
  if (depth > FORM_DEPTH_LIMIT) {
    state.tooDeep = true;
    return;
  }
  const instructions = readInstructions(bytes);
  if (instructions === null) return;
  const { draws } = walkContent(instructions);
  for (const draw of draws) {
    const xobjects = dictOf(resources?.get('XObject'));
    if (xobjects === null) continue;
    const entry = xobjects.get(draw.name);
    // A stream is a stream only by reference (`engines/mupdf-write.ts`), so it has a number.
    if (entry.isNull() || !entry.isStream()) continue;
    const dict = resolved(entry) as PDFObject;
    const subtype = nameOf(dict.get('Subtype'));
    if (subtype === 'Image') {
      const key = refName(entry);
      if (out.some((candidate) => candidate.ref === key)) continue;
      out.push({ ref: key, name: draw.name, dict });
      continue;
    }
    if (subtype === 'Form') {
      const key = refName(entry);
      if (visited.has(key)) continue;
      visited.add(key);
      const decoded = decodeStream(entry);
      if (decoded === null) continue;
      const inner = dictOf(dict.get('Resources')) ?? resources;
      collectDrawnImages(inner, decoded, depth + 1, visited, out, state);
    }
  }
}

/**
 * The accessibility facts of a file. Nothing is scored and nothing is concluded: every
 * row is a statement about an object, and `notChecked` says which PDF/UA requirements
 * were not examined at all. `bytes` are never modified.
 */
export async function checkAccessibility(
  bytes: Uint8Array,
  context: OperationContext,
): Promise<AccessibilityReport> {
  throwIfAborted(context.signal);
  const { doc } = await openForWrite(bytes);
  try {
    return inspect(doc, context);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw mapMupdfError(error, 'check accessibility');
  } finally {
    doc.destroy();
  }
}

function inspect(doc: PDFDocument, context: OperationContext): AccessibilityReport {
  const pages = pageObjects(doc);
  const pageCount = pages.length;
  const catalog = catalogOf(doc);
  const findings: AccessibilityFinding[] = [];
  context.onProgress?.({ phase: 'a11y', labelKey: A11Y_KEYS.progressCheck, done: 0, total: pageCount + 1 });

  /* ---- structure tree ---- */
  const structValue = catalog.get('StructTreeRoot');
  const structDict = dictOf(structValue);
  const roles = new Map<string, number>();
  let elementCount = 0;
  let structureTruncated = false;
  if (structDict !== null) {
    const budget = { left: STRUCT_WALK_LIMIT };
    walkStructure(
      structDict,
      (element) => {
        const role = nameOf(element.get('S'));
        if (role === null) return;
        roles.set(role, (roles.get(role) ?? 0) + 1);
        elementCount += 1;
      },
      budget,
      0,
    );
    structureTruncated = budget.left <= 0;
  }
  const structure: AccessibilityStructure = {
    present: !structValue.isNull(),
    readable: structDict !== null,
    elementCount,
    roles: Object.fromEntries(roles),
    paragraphCount: roles.get('P') ?? 0,
    truncated: structureTruncated,
  };

  findings.push(
    structure.present
      ? finding('struct-tree', 'ok', A11Y_KEYS.checkStructTreeOk, {
          params: { objects: elementCount },
        })
      : finding('struct-tree', 'problem', A11Y_KEYS.checkStructTree),
  );
  if (structureTruncated) {
    findings.push(
      finding('struct-tree', 'unchecked', A11Y_KEYS.checkStructTruncated, {
        params: { limit: STRUCT_WALK_LIMIT },
      }),
    );
  }

  /* ---- MarkInfo ---- */
  const markInfo = dictOf(catalog.get('MarkInfo'));
  const markedValue = markInfo === null ? null : resolved(markInfo.get('Marked'));
  const marked = markedValue?.isBoolean() === true && markedValue.asBoolean();
  findings.push(
    marked
      ? finding('mark-info', 'ok', A11Y_KEYS.checkMarkInfoOk)
      : markInfo === null
        ? finding('mark-info', 'problem', A11Y_KEYS.checkMarkInfo)
        : finding('mark-info', 'problem', A11Y_KEYS.checkMarkInfo, {
            where: '/MarkInfo /Marked',
          }),
  );

  /* ---- language ---- */
  const lang = textOf(catalog.get('Lang'));
  findings.push(
    lang === null
      ? finding('lang', 'problem', A11Y_KEYS.checkLang)
      : finding('lang', 'ok', A11Y_KEYS.checkLangOk, { params: { lang } }),
  );

  /* ---- titles: Info and XMP are two different facts ---- */
  const info = dictOf(doc.getTrailer().get('Info'));
  const infoTitle = info === null ? null : textOf(info.get('Title'));
  findings.push(
    infoTitle === null
      ? finding('title-info', 'problem', A11Y_KEYS.checkInfoTitle, { where: '/Info /Title' })
      : finding('title-info', 'ok', A11Y_KEYS.checkInfoTitleOk),
  );
  const packet = readXmpPacket(catalog);
  const xmpTitle = packet === null ? null : xmpTitleState(packet);
  if (packet === null) {
    findings.push(finding('title-xmp', 'problem', A11Y_KEYS.checkXmpMissing, { where: '/Metadata' }));
  } else if (xmpTitle === 'malformed') {
    findings.push(finding('title-xmp', 'problem', A11Y_KEYS.checkXmpMalformed, { where: '/Metadata' }));
  } else if (xmpTitle === 'missing') {
    findings.push(finding('title-xmp', 'problem', A11Y_KEYS.checkXmpTitle, { where: 'dc:title' }));
  } else {
    findings.push(finding('title-xmp', 'ok', A11Y_KEYS.checkXmpTitleOk));
  }

  /* ---- images actually drawn ---- */
  const pageRefs = pageNumbers(pages);
  // In a tagged file the alt text of a picture is the `/Alt` of the `Figure` that owns it.
  const figureIndex = readFigureIndex(catalog, pageRefs);
  const pageFigures = new Map<number, FigureElement[]>();
  const images = new Map<string, { name: string; pages: number[]; dict: PDFObject }>();
  const unreadablePages: number[] = [];
  const tooDeepPages: number[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    throwIfAborted(context.signal);
    context.onProgress?.({
      phase: 'a11y',
      labelKey: A11Y_KEYS.progressCheck,
      done: pageIndex + 1,
      total: pageCount + 1,
    });
    const content = pageContent(page);
    const instructions = content === null ? null : readInstructions(content.bytes);
    if (content === null || instructions === null) {
      unreadablePages.push(pageIndex);
      continue;
    }
    const resources = dictOf(page.getInheritable('Resources'));
    const drawn: { ref: string; name: string; dict: PDFObject }[] = [];
    const state = { tooDeep: false };
    collectDrawnImages(resources, content.bytes, 1, new Set<string>(), drawn, state);
    if (figureIndex !== null) {
      collectPageFigures(page, pageIndex, content.bytes, instructions, figureIndex, pageFigures);
    }
    if (state.tooDeep) tooDeepPages.push(pageIndex);
    for (const image of drawn) {
      if (images.size >= IMAGE_LIMIT) break;
      const existing = images.get(image.ref);
      if (existing === undefined) {
        images.set(image.ref, { name: image.name, pages: [pageIndex], dict: image.dict });
      } else {
        // `drawn` lists an image once per page, so this page is new to it.
        existing.pages.push(pageIndex);
      }
    }
  }
  for (const pageIndex of unreadablePages) {
    findings.push(
      finding('images', 'unchecked', A11Y_KEYS.checkPageUnreadable, {
        pageIndex,
        params: { page: pageIndex + 1 },
      }),
    );
  }
  for (const pageIndex of tooDeepPages.slice(0, FINDING_ROW_LIMIT)) {
    findings.push(
      finding('images', 'unchecked', A11Y_KEYS.checkNestedTooDeep, {
        pageIndex,
        params: { page: pageIndex + 1, depth: FORM_DEPTH_LIMIT },
      }),
    );
  }

  const listed: AccessibilityImage[] = [];
  let missingAlt = 0;
  let unjudged = 0;
  for (const [ref, image] of images) {
    const figures = figureIndex === null ? [] : figuresOf(figureIndex, pageFigures, Number.parseInt(ref, 10));
    const alt = altOf(figures, image.dict);
    listed.push({
      pageIndex: image.pages[0] as number,
      name: image.name,
      ref,
      pages: [...image.pages],
      alt,
      width: intOf(image.dict, 'Width'),
      height: intOf(image.dict, 'Height'),
    });
    // A picture whose figure the walk may not have reached is not called unowned.
    if (alt === null && figures.length === 0 && figureIndex?.truncated === true) {
      unjudged += 1;
    } else if (alt === null) {
      missingAlt += 1;
      if (missingAlt <= FINDING_ROW_LIMIT) {
        findings.push(
          finding('image-alt', 'problem', A11Y_KEYS.checkImageAlt, {
            pageIndex: image.pages[0],
            params: { name: image.name, pages: pageList(image.pages), count: image.pages.length },
            where: `image ${ref}`,
          }),
        );
      }
    }
  }
  if (missingAlt > FINDING_ROW_LIMIT) {
    findings.push(
      finding('image-alt', 'problem', A11Y_KEYS.checkListClipped, {
        params: { count: missingAlt, shown: FINDING_ROW_LIMIT },
      }),
    );
  }
  if (unjudged > 0) {
    findings.push(finding('image-alt', 'unchecked', A11Y_KEYS.checkFigureTreeTruncated));
  }
  if (listed.length > 0 && missingAlt === 0 && unjudged === 0) {
    findings.push(
      finding('image-alt', 'ok', A11Y_KEYS.checkImageAltOk, { params: { count: listed.length } }),
    );
  }

  /* ---- form fields ---- */
  const fields = readFields(catalog, pageRefs, context);
  let missingTooltip = 0;
  for (const field of fields.items) {
    if (field.tooltip === null) {
      missingTooltip += 1;
      if (missingTooltip <= FINDING_ROW_LIMIT) {
        findings.push(
          finding('field-tooltip', 'problem', A11Y_KEYS.checkFieldTooltip, {
            ...(field.pageIndex === null ? {} : { pageIndex: field.pageIndex }),
            params: { name: field.name },
            where: `field ${field.name}`,
          }),
        );
      }
    }
  }
  if (missingTooltip > FINDING_ROW_LIMIT) {
    findings.push(
      finding('field-tooltip', 'problem', A11Y_KEYS.checkListClipped, {
        params: { count: missingTooltip, shown: FINDING_ROW_LIMIT },
      }),
    );
  }
  if (fields.items.length > 0 && missingTooltip === 0) {
    findings.push(
      finding('field-tooltip', 'ok', A11Y_KEYS.checkFieldTooltipOk, {
        params: { count: fields.items.length },
      }),
    );
  }
  if (fields.truncated) {
    findings.push(
      finding('field-tooltip', 'unchecked', A11Y_KEYS.checkFieldTreeTruncated, {
        params: { limit: FIELD_WALK_LIMIT },
      }),
    );
  }

  /* ---- link annotations ---- */
  let links = 0;
  let linksWithoutContents = 0;
  for (const [pageIndex, page] of pages.entries()) {
    const annots = resolved(page.get('Annots'));
    if (annots?.isArray() !== true) continue;
    for (let position = 0; position < annots.length; position += 1) {
      const entry = annots.get(position);
      const annot = dictOf(entry);
      if (annot === null) continue;
      if (nameOf(annot.get('Subtype')) !== 'Link') continue;
      links += 1;
      if (textOf(annot.get('Contents')) !== null) continue;
      linksWithoutContents += 1;
      if (linksWithoutContents <= FINDING_ROW_LIMIT) {
        findings.push(
          finding('link-contents', 'problem', A11Y_KEYS.checkLinkContents, {
            pageIndex,
            params: { page: pageIndex + 1 },
            where: `annotation ${refName(entry)}`,
          }),
        );
      }
    }
  }
  if (linksWithoutContents > FINDING_ROW_LIMIT) {
    findings.push(
      finding('link-contents', 'problem', A11Y_KEYS.checkListClipped, {
        params: { count: linksWithoutContents, shown: FINDING_ROW_LIMIT },
      }),
    );
  }
  if (links > 0 && linksWithoutContents === 0) {
    findings.push(
      finding('link-contents', 'ok', A11Y_KEYS.checkLinkContentsOk, { params: { count: links } }),
    );
  }

  /* ---- paragraphs ---- */
  if (structDict === null) {
    findings.push(finding('paragraphs', 'unchecked', A11Y_KEYS.checkParagraphsUnchecked));
  } else if (structure.paragraphCount > 0) {
    findings.push(
      finding('paragraphs', 'ok', A11Y_KEYS.checkParagraphsOk, {
        params: { count: structure.paragraphCount },
      }),
    );
  } else {
    findings.push(finding('paragraphs', 'problem', A11Y_KEYS.checkParagraphs));
  }

  context.onProgress?.({
    phase: 'a11y',
    labelKey: A11Y_KEYS.progressCheck,
    done: pageCount + 1,
    total: pageCount + 1,
  });

  return {
    pageCount,
    findings,
    checked: CHECKED_KEYS,
    notChecked: NOT_CHECKED_KEYS,
    images: listed,
    fields: fields.items,
    structure,
  };
}

/**
 * The `/Metadata` packet as text, or `null` when the catalog has no `/Metadata` stream.
 * This mirrors `ops/metadata.ts > readXmpStream` (private there): the properties panel
 * reads it through `readMetadata`, this op already holds the opened document and does
 * not pay for a second parse of the file.
 */
export function readXmpPacket(catalog: PDFObject): string | null {
  const decoded = decodeStream(catalog.get('Metadata'));
  return decoded === null ? null : new TextDecoder().decode(decoded);
}

/**
 * What the packet says about `dc:title`, read from the **parsed** packet (the XML reader the
 * PDF/A checker uses): a title is a non-empty value of the Dublin Core property, in the
 * element form (including every `rdf:li` of its language alternative) or the attribute form.
 * A substring test found `dc:title` in a comment and in an empty `<dc:title/>`, neither of
 * which a reader ever shows as the document's title. A packet that is not well-formed XML is
 * its own answer: no reader can take a title out of it.
 */
function xmpTitleState(packet: string): 'present' | 'missing' | 'malformed' {
  const parsed = parseXmp(new TextEncoder().encode(packet));
  if (!parsed.wellFormed) return 'malformed';
  return xmpList(parsed, NS_DC, 'title')?.some((value) => value.trim() !== '') === true
    ? 'present'
    : 'missing';
}

/** Children of a structure element, recursing into the ones that carry a role. */
function walkStructure(
  parent: PDFObject,
  visit: (element: PDFObject) => void,
  budget: { left: number },
  depth: number,
): void {
  if (depth > 64) return;
  const kids = resolved(parent.get('K'));
  if (kids === null) return;
  const entries: PDFObject[] = [];
  if (kids.isArray()) {
    for (let index = 0; index < kids.length; index += 1) entries.push(kids.get(index));
  } else {
    entries.push(parent.get('K'));
  }
  for (const entry of entries) {
    if (budget.left <= 0) return;
    const object = dictOf(entry);
    if (object === null) continue;
    budget.left -= 1;
    visit(object);
    walkStructure(object, visit, budget, depth + 1);
  }
}

/* ------------------------------------------------------------------ *
 * Figures: where a tagged file keeps the alt text of a picture
 * ------------------------------------------------------------------ */

/** A `Figure` structure element: the dictionary that carries `/Alt`, and what it says. */
interface FigureElement {
  readonly dict: PDFObject;
  readonly alt: string | null;
}

/** The `Figure` elements of a structure tree, by the content they own. */
interface FigureIndex {
  /** `pageIndex:mcid` → the figure whose marked content that is. */
  readonly byContent: ReadonlyMap<string, FigureElement>;
  /** Object number of an annotation or XObject → the figures that point at it with an `OBJR`. */
  readonly byObject: ReadonlyMap<number, readonly FigureElement[]>;
  /** The tree has more elements or levels than the walk reads: a figure may be missing from the index. */
  readonly truncated: boolean;
}

/**
 * The `Figure` elements of the file's structure tree and the content each one owns, or
 * `null` when the file has no readable tree.
 *
 * A reader takes a picture's alternative text from the `/Alt` of the `Figure` that owns it
 * (ISO 14289-1 §7.3): an `/Alt` on the image XObject is a key no reader looks at. A figure
 * owns its content through marked-content ids (`/K` integers and `MCR`s, found on the page
 * by the id of the sequence around the `Do`) or through an `OBJR` to the XObject itself.
 * `/RoleMap` is followed, so a custom type mapped onto `Figure` is one. A tree the walk could not
 * read to the end says so (`truncated`): a picture with no figure in the index may have one.
 */
function readFigureIndex(catalog: PDFObject, pageRefs: ReadonlyMap<number, number>): FigureIndex | null {
  const root = dictOf(catalog.get('StructTreeRoot'));
  if (root === null) return null;
  const roleMap = dictOf(root.get('RoleMap'));
  const isFigure = (role: string | null): boolean => {
    let current = role;
    for (let hops = 0; current !== null && hops < 8; hops += 1) {
      if (current === 'Figure') return true;
      current = roleMap === null ? null : nameOf(roleMap.get(current));
    }
    return false;
  };
  const pageOf = (value: PDFObject): number | null =>
    value.isIndirect() ? (pageRefs.get(value.asIndirect()) ?? null) : null;
  const byContent = new Map<string, FigureElement>();
  const byObject = new Map<number, FigureElement[]>();
  const budget = { left: STRUCT_NODE_LIMIT };
  let truncated = false;

  const visit = (element: PDFObject, inherited: number | null, depth: number): void => {
    if (depth > 64) {
      truncated = true;
      return;
    }
    const page = pageOf(element.get('Pg')) ?? inherited;
    const figure: FigureElement | null = isFigure(nameOf(element.get('S')))
      ? { dict: element, alt: textOf(element.get('Alt')) }
      : null;
    const kids = resolved(element.get('K'));
    if (kids === null) return;
    const entries: PDFObject[] = [];
    if (kids.isArray()) {
      for (let index = 0; index < kids.length; index += 1) entries.push(kids.get(index));
    } else entries.push(element.get('K'));
    for (const entry of entries) {
      if (budget.left <= 0) {
        truncated = true;
        return;
      }
      if (entry.isNumber()) {
        if (figure !== null && page !== null) byContent.set(`${page}:${entry.asNumber()}`, figure);
        continue;
      }
      const dict = dictOf(entry);
      if (dict === null) continue;
      const type = nameOf(dict.get('Type'));
      if (type === 'MCR') {
        const mcid = intOf(dict, 'MCID');
        const at = pageOf(dict.get('Pg')) ?? page;
        if (figure !== null && mcid !== null && at !== null) byContent.set(`${at}:${mcid}`, figure);
        continue;
      }
      if (type === 'OBJR') {
        const target = dict.get('Obj');
        if (figure !== null && target.isIndirect()) {
          const number = target.asIndirect();
          byObject.set(number, [...(byObject.get(number) ?? []), figure]);
        }
        continue;
      }
      budget.left -= 1;
      visit(dict, page, depth + 1);
    }
  };
  visit(root, null, 0);
  return { byContent, byObject, truncated };
}

/**
 * The `/MCID` an inline property list carries (`/P <</MCID 3>> BDC`): the integer behind the
 * key at the top level of the dictionary. The dictionary is walked as objects, so a
 * `/MCID` spelled inside a string (`/ActualText (/MCID 9)`) or a nested dictionary is not it.
 */
function inlineMcid(buffer: Uint8Array, instruction: Instruction): number | null {
  let depth = 0;
  let cursor = instruction.start;
  while (cursor < instruction.end) {
    const byte = buffer[cursor] as number;
    if (byte === 0x3c && buffer[cursor + 1] === 0x3c) {
      depth += 1;
      cursor += 2;
    } else if (byte === 0x3e && buffer[cursor + 1] === 0x3e) {
      depth -= 1;
      cursor += 2;
    } else if (byte === 0x3c) cursor = skipHexString(buffer, cursor);
    else if (byte === 0x28) cursor = skipLiteralString(buffer, cursor);
    else if (byte === 0x5b) cursor = skipArray(buffer, cursor);
    else if (byte === 0x25) cursor = skipComment(buffer, cursor);
    else if (byte === 0x2f) {
      let end = cursor + 1;
      let key = '';
      while (end < instruction.end && isRegular(buffer[end] as number)) {
        key += String.fromCharCode(buffer[end] as number);
        end += 1;
      }
      cursor = end;
      if (depth !== 1 || decodeNameEscapes(key) !== 'MCID') continue;
      // The value is the integer that follows: a few bytes are all it can take.
      let tail = '';
      for (let at = cursor; at < Math.min(instruction.end, cursor + 24); at += 1) {
        tail += String.fromCharCode(buffer[at] as number);
      }
      const value = /^\s*(\d+)/.exec(tail);
      return value === null ? null : Number(value[1]);
    } else cursor += 1;
  }
  return null;
}

/**
 * The marked-content id around each `Do`, by instruction index: that of the innermost open
 * sequence that has one, whether it is written inline (`<</MCID 3>>`) or named in the page's
 * `/Properties` (`/MC0 BDC`).
 */
function drawMcids(
  buffer: Uint8Array,
  instructions: readonly Instruction[],
  properties: PDFObject | null,
): ReadonlyMap<number, number> {
  const found = new Map<number, number>();
  const open: (number | null)[] = [];
  for (const [index, instruction] of instructions.entries()) {
    if (instruction.operator === 'BMC') open.push(null);
    else if (instruction.operator === 'BDC') {
      const list = instruction.operands[1];
      open.push(
        list?.kind === 'name'
          ? intOf(dictOf(properties?.get(list.name)), 'MCID')
          : list?.kind === 'other'
            ? inlineMcid(buffer, instruction)
            : null,
      );
    } else if (instruction.operator === 'EMC') open.pop();
    else if (instruction.operator === 'Do') {
      for (let level = open.length - 1; level >= 0; level -= 1) {
        const mcid = open[level];
        if (mcid !== null && mcid !== undefined) {
          found.set(index, mcid);
          break;
        }
      }
    }
  }
  return found;
}

/**
 * Add to `into` (image XObject number → figures) the figure that owns each image this page
 * draws directly. An image drawn inside a marked-content sequence no figure owns, or inside
 * a form XObject, has no figure here, and its alt text stays where it was.
 */
function collectPageFigures(
  page: PDFObject,
  pageIndex: number,
  buffer: Uint8Array,
  instructions: readonly Instruction[],
  index: FigureIndex,
  into: Map<number, FigureElement[]>,
): void {
  const resources = dictOf(page.getInheritable('Resources'));
  const xobjects = dictOf(resources?.get('XObject'));
  if (xobjects === null) return;
  const { draws } = walkContent(instructions);
  if (draws.length === 0) return;
  const mcids = drawMcids(buffer, instructions, dictOf(resources?.get('Properties')));
  for (const draw of draws) {
    const entry = xobjects.get(draw.name);
    if (entry.isNull() || !entry.isStream()) continue;
    if (nameOf((resolved(entry) as PDFObject).get('Subtype')) !== 'Image') continue;
    const mcid = mcids.get(draw.index);
    const figure = mcid === undefined ? undefined : index.byContent.get(`${pageIndex}:${mcid}`);
    if (figure === undefined) continue;
    const number = entry.asIndirect();
    const known = into.get(number) ?? [];
    if (!known.includes(figure)) into.set(number, [...known, figure]);
  }
}

/** The figures of every image the document draws, from every page. */
function imageFigures(pages: readonly PDFObject[], index: FigureIndex): Map<number, FigureElement[]> {
  const into = new Map<number, FigureElement[]>();
  for (const [pageIndex, page] of pages.entries()) {
    const content = pageContent(page);
    const instructions = content === null ? null : readInstructions(content.bytes);
    if (content === null || instructions === null) continue;
    collectPageFigures(page, pageIndex, content.bytes, instructions, index, into);
  }
  return into;
}

/** The figures that own image `number`: through the marked content that draws it, or an `OBJR`. */
function figuresOf(
  index: FigureIndex,
  drawn: ReadonlyMap<number, readonly FigureElement[]>,
  number: number,
): readonly FigureElement[] {
  return [...new Set([...(drawn.get(number) ?? []), ...(index.byObject.get(number) ?? [])])];
}

/**
 * What alt text an image has, as a reader sees it. In a tagged file whose structure tree
 * owns the image through `Figure` elements, that is their `/Alt` — all of them must have one;
 * anywhere else it is the XObject's own `/Alt`, the key the untagged flow copies into the
 * figure when it tags the file.
 */
function altOf(figures: readonly FigureElement[], image: PDFObject): string | null {
  if (figures.length === 0) return textOf(image.get('Alt'));
  return figures.every((figure) => figure.alt !== null) ? (figures[0] as FigureElement).alt : null;
}

/**
 * What an AcroForm node is (§12.7.4.2): a **group** whose `/Kids` are fields of their own
 * (a kid with a `/T`, or with kids), a **field** — a leaf, or a field whose `/Kids` are all
 * widget annotations, as in a radio group — or **empty**: `/Kids` that hold nothing to read.
 * A widget annotation is never a field of its own when it is the kid of a field, so a radio
 * group is one field with several widgets, not one field per widget.
 */
type FieldNode =
  | { readonly kind: 'group'; readonly kids: PDFObject }
  | { readonly kind: 'field'; readonly widgets: PDFObject | null }
  | { readonly kind: 'empty' };

function fieldNode(dict: PDFObject): FieldNode {
  const kids = resolved(dict.get('Kids'));
  if (kids?.isArray() !== true) return { kind: 'field', widgets: null };
  // A merged field/widget (`/Subtype /Widget` with a `/T`) is the field, whatever its kids.
  if (nameOf(dict.get('Subtype')) === 'Widget') return { kind: 'field', widgets: kids };
  let widgets = false;
  for (let index = 0; index < kids.length; index += 1) {
    const kid = dictOf(kids.get(index));
    if (kid === null) continue;
    if (!kid.get('T').isNull() || !kid.get('Kids').isNull()) return { kind: 'group', kids };
    widgets = true;
  }
  return widgets ? { kind: 'field', widgets: kids } : { kind: 'empty' };
}

/**
 * Whether a node that is not a group is a field of its own, named `qualified`. An unnamed
 * leaf under a named group is one of the group's own widgets (a group that mixes widgets with
 * child fields): it is not a field and not a second copy of the group. `readFields` and
 * `findField` both ask this, so the field a report lists is the field a fix writes to.
 */
function isNamedField(
  node: FieldNode,
  own: string | null,
  qualified: string,
): node is Extract<FieldNode, { readonly kind: 'field' }> {
  return node.kind === 'field' && qualified !== '' && !(own === null && node.widgets === null);
}

/** Every AcroForm field, by fully qualified name, with the page its widget sits on. */
export function readFields(
  catalog: PDFObject,
  pageRefs: ReadonlyMap<number, number>,
  context: OperationContext,
): { readonly items: readonly AccessibilityField[]; readonly truncated: boolean } {
  const items: AccessibilityField[] = [];
  const acro = dictOf(catalog.get('AcroForm'));
  const fields = acro === null ? null : resolved(acro.get('Fields'));
  const budget = { left: FIELD_WALK_LIMIT };

  const walk = (entries: PDFObject, prefix: string): void => {
    for (let index = 0; index < entries.length; index += 1) {
      if (budget.left <= 0) return;
      budget.left -= 1;
      throwIfAborted(context.signal);
      const dict = dictOf(entries.get(index));
      if (dict === null) continue;
      const own = textOf(dict.get('T'));
      const name = own === null ? prefix : prefix === '' ? own : `${prefix}.${own}`;
      const node = fieldNode(dict);
      if (node.kind === 'group') {
        walk(node.kids, name);
        continue;
      }
      if (!isNamedField(node, own, name)) continue;
      items.push({
        name,
        // `/TU` is the field's own (Table 220 does not make it inheritable), and a widget's is
        // not read: the tooltip is the field's accessible name, kept on the parent of a radio group's widgets.
        tooltip: textOf(dict.get('TU')),
        pageIndex: widgetPage(dict, node.widgets, pageRefs),
      });
    }
  };

  if (fields?.isArray() === true) walk(fields, '');
  return { items, truncated: budget.left <= 0 };
}

/** The page a field's widget sits on: `/P` on the field, or on the first widget kid. */
function widgetPage(
  field: PDFObject,
  kids: PDFObject | null,
  pageRefs: ReadonlyMap<number, number>,
): number | null {
  const candidates: PDFObject[] = [field];
  if (kids !== null) {
    for (let index = 0; index < kids.length; index += 1) {
      const kid = dictOf(kids.get(index));
      if (kid !== null) candidates.push(kid);
    }
  }
  for (const candidate of candidates) {
    const reference = candidate.get('P');
    if (!reference.isIndirect()) continue;
    const index = pageRefs.get(reference.asIndirect());
    if (index !== undefined) return index;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Tagging the document
 * ------------------------------------------------------------------ */

/** One page's tagging plan: what goes into the structure tree, and where. */
export interface PagePlan {
  readonly pageIndex: number;
  readonly pageRef: PDFObject;
  readonly regions: readonly BlockRegion[];
  readonly scan: ContentScan;
  readonly matched: MatchResult;
  readonly draws: readonly { readonly index: number; readonly role: string; readonly alt: string | null }[];
}

/**
 * Produce a tagged file: a real structure tree over real marked-content sequences, with
 * `/MarkInfo` and `/Lang` where they were missing.
 *
 * Every page is read through the **existing text model** (`readDocumentText` → `buildTextPage`,
 * the same blocks the text tool edits) and only pages whose text can be related to their
 * content are tagged. The notes name every page that was left alone and why; a document
 * with nothing taggable comes back **unchanged** with an empty step list, which the UI
 * shows as a report with no write behind it.
 */
export async function tagDocument(
  bytes: Uint8Array,
  context: OperationContext,
  options: TagDocumentOptions = {},
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const { doc } = await openForWrite(bytes);
  try {
    return await tagOpened(doc, bytes, context, options);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw mapMupdfError(error, 'tag document');
  } finally {
    doc.destroy();
  }
}

/** The result of reading every page's text and placing it in its content stream. */
export interface PlannedPages {
  readonly plans: readonly PagePlan[];
  /** Heading size → role, from the whole document's text. */
  readonly roles: ReadonlyMap<number, string>;
  /** The body font size the heading guess was measured against. */
  readonly body: number;
  /** Why pages were left out, as the warnings the tagger reports. */
  readonly notes: readonly OperationNote[];
}

/**
 * Passes one and two of tagging, shared by the writer and by the reading-order editor's
 * read of an untagged file: the text model of every page, then each page's text-showing
 * operators matched to its blocks. A page whose text cannot be related to its content
 * honestly is left out and **named in the notes** — it is never given an invented block.
 */
export async function planPages(
  doc: PDFDocument,
  bytes: Uint8Array,
  context: OperationContext,
  readPage?: PageTextReader,
): Promise<PlannedPages> {
  const notes: OperationNote[] = [];
  const pages = pageObjects(doc);
  const pageCount = pages.length;
  const span = pageCount + 2;

  /* ---- pass 1: the text model of every page (no content streams retained) ---- */
  const regions: (readonly BlockRegion[])[] = [];
  const failedPages: number[] = [];
  const progress = (pageIndex: number): void =>
    context.onProgress?.({
      phase: 'a11y',
      labelKey: A11Y_KEYS.progressTag,
      done: pageIndex + 1,
      total: span,
    });
  const readEach = async (reader: PageTextReader): Promise<void> => {
    regions.length = 0;
    failedPages.length = 0;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      throwIfAborted(context.signal);
      progress(pageIndex);
      try {
        regions.push(toRegions(await reader(bytes, pageIndex, context)));
      } catch (error) {
        if (isAbort(error)) throw error;
        // A page whose text cannot be read is left untagged and named. The failure is not
        // swallowed: it becomes a note the user reads.
        regions.push([]);
        failedPages.push(pageIndex);
      }
    }
  };
  if (readPage !== undefined) await readEach(readPage);
  else {
    // The engine's own reader walks pages through **one** MuPDF document per batch. Reading
    // page by page re-opened (and copied) the file once per page, and went to pdf.js for a text
    // colour that tagging never looks at. A batch bounds what is held at once: the glyphs of a
    // batch are reduced to regions before the next one is read, as they were page by page.
    try {
      for (let first = 0; first < pageCount; first += PAGE_READ_BATCH) {
        const batch = Array.from(
          { length: Math.min(PAGE_READ_BATCH, pageCount - first) },
          (_, offset) => first + offset,
        );
        const inputs = await readDocumentText(bytes, batch, context, (done) => progress(first + done - 1));
        for (const input of inputs) regions.push(toRegions(input));
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      // One page the engine cannot read must not cost the others their tags: read them one at a
      // time, so that page alone is named in the notes.
      await readEach(readPageText);
    }
  }

  const body = bodyFontSize(regions);
  const roles = headingRoles(regions, body);

  /* ---- pass 2: place, mark, and keep only what the write needs ---- */
  const plans: PagePlan[] = [];
  let elementBudget = TAG_ELEMENT_LIMIT;
  for (const [pageIndex, page] of pages.entries()) {
    throwIfAborted(context.signal);
    context.onProgress?.({
      phase: 'a11y',
      labelKey: A11Y_KEYS.progressTag,
      done: pageIndex + 2,
      total: span,
    });
    // Pass one pushed exactly one entry per page, in page order.
    const pageRegions = regions[pageIndex] as readonly BlockRegion[];
    const scanned = scanPage(page);
    if (!scanned.ok) {
      notes.push(note('warning', A11Y_KEYS.pageUnreadable, { page: pageIndex + 1, reason: scanned.reason }));
      continue;
    }
    if (pageRegions.length === 0) {
      // Nothing to tag, unless the page draws an image — a picture is content too.
      if (scanned.scan.draws.length === 0 && failedPages.includes(pageIndex)) {
        notes.push(note('warning', A11Y_KEYS.textReadFailed, { page: pageIndex + 1 }));
        continue;
      }
      if (scanned.scan.draws.length === 0) {
        notes.push(note('warning', A11Y_KEYS.pageNoBlocks, { page: pageIndex + 1 }));
        continue;
      }
    }
    const matched = matchBlocks(scanned.scan.shows, pageRegions, visibleBox(page));
    if (pageRegions.length > 0 && matched.matches.length === 0) {
      notes.push(
        note('warning', A11Y_KEYS.pageUnmatched, {
          page: pageIndex + 1,
          blocks: pageRegions.length,
          shows: scanned.scan.shows.length,
        }),
      );
      continue;
    }
    if (matched.unmatched > 0 || matched.ambiguous > 0) {
      notes.push(
        note('warning', A11Y_KEYS.placement, {
          page: pageIndex + 1,
          matched: matched.matched,
          ambiguous: matched.ambiguous,
          unmatched: matched.unmatched,
        }),
      );
    }
    const figures = figureClaims(page, scanned.scan);
    plans.push({
      pageIndex,
      pageRef: page,
      regions: pageRegions,
      scan: scanned.scan,
      matched,
      draws: figures,
    });
    elementBudget -= matched.matches.length + figures.length;
    if (elementBudget < 0) {
      notes.push(note('warning', A11Y_KEYS.elementLimit, { limit: TAG_ELEMENT_LIMIT }));
      break;
    }
  }
  return { plans, roles, body, notes };
}

async function tagOpened(
  doc: PDFDocument,
  bytes: Uint8Array,
  context: OperationContext,
  options: TagDocumentOptions,
): Promise<OperationOutcome> {
  const notes: OperationNote[] = [];
  const steps: string[] = ['load'];
  const pages = pageObjects(doc);
  const pageCount = pages.length;
  const catalog = catalogOf(doc);

  if (!catalog.get('StructTreeRoot').isNull()) {
    refuse('the document already has a structure tree; merging two is not implemented', 'bytes');
  }

  const planned = await planPages(doc, bytes, context, options.pageText);
  const { plans, roles, body } = planned;
  notes.push(...planned.notes);
  const span = pageCount + 2;

  /* ---- splice: marked content first, structure tree second ---- */
  const tagged: TaggedPage[] = [];
  let figuresWithoutAlt = 0;
  for (const plan of plans) {
    const pagePlan = options.plan?.pages[plan.pageIndex];
    const claims = claimsFor(plan, roles, pagePlan);
    if (claims.claims.length === 0) {
      if (plan.regions.length > 0) {
        notes.push(
          note('warning', A11Y_KEYS.pageOverlap, { page: plan.pageIndex + 1, skipped: claims.skipped }),
        );
      }
      continue;
    }
    if (claims.skipped > 0) {
      notes.push(
        note('warning', A11Y_KEYS.pageOverlap, { page: plan.pageIndex + 1, skipped: claims.skipped }),
      );
    }
    const spliced = spliceMarkedContent(plan.scan, claims.claims);
    // The rewrite compresses the new stream (`compress`).
    resolved(plan.pageRef)?.put('Contents', doc.addStream(spliced.bytes, {}));
    for (const claim of claims.claims) {
      if (claim.role === 'Figure' && claim.alt === null) figuresWithoutAlt += 1;
    }
    tagged.push({
      pageIndex: plan.pageIndex,
      pageRef: plan.pageRef,
      elements: treeOrder(claims.claims, pagePlan).map((group) => ({
        role: group.role,
        mcids: group.mcids,
        alt: group.alt,
      })),
      before: markedContentCounts(plan.scan.instructions),
      added: {
        total: claims.claims.length,
        artifacts: claims.claims.filter((claim) => claim.role === 'Artifact').length,
      },
    });
  }

  if (tagged.length === 0) {
    notes.push(note('warning', A11Y_KEYS.nothingTagged));
    notes.push(producerKeptNote());
    return {
      bytes,
      report: {
        engine: 'mupdf',
        steps: ['load', 'text', 'scan'],
        notes,
        inputBytes: bytes.byteLength,
        outputBytes: bytes.byteLength,
        pageCount,
        // Nothing was written: the file is returned exactly as it arrived.
        incremental: true,
      },
    };
  }

  const structure = writeStructure(doc, tagged);
  steps.push('structure');
  notes.push(
    note('changed', A11Y_KEYS.tagged, {
      pages: tagged.length,
      total: pageCount,
      paragraphs: structure.paragraphs,
      headings: structure.headings,
      figures: structure.figures,
    }),
  );
  notes.push(note('changed', A11Y_KEYS.markInfoSet));
  catalog.put('MarkInfo', { Marked: true });

  const existingLang = textOf(catalog.get('Lang'));
  if (existingLang !== null) {
    notes.push(note('preserved', A11Y_KEYS.langKept, { lang: existingLang }));
  } else if (options.language === undefined || options.language.trim() === '') {
    notes.push(note('warning', A11Y_KEYS.langNoLanguage));
  } else {
    const language = options.language.trim();
    catalog.put('Lang', text(doc, language));
    notes.push(note('changed', A11Y_KEYS.langSet, { lang: language }));
  }

  notes.push(note('changed', A11Y_KEYS.contentRewritten, { pages: tagged.length }));
  if (structure.headings > 0) {
    notes.push(note('warning', A11Y_KEYS.headingGuess, { body, count: structure.headings }));
  }
  if (figuresWithoutAlt > 0) {
    notes.push(note('warning', A11Y_KEYS.figureNoAlt, { count: figuresWithoutAlt }));
  }
  notes.push(note('warning', A11Y_KEYS.orderFromContent));
  notes.push(note('warning', A11Y_KEYS.formsNotTagged));

  steps.push('producer');
  notes.push(producerKeptNote());

  throwIfAborted(context.signal);
  const out = saveRewrite(doc, 'tag document');
  steps.push('save');

  await verifyTagged(out, tagged, context);
  steps.push('verify');
  context.onProgress?.({
    phase: 'a11y',
    labelKey: A11Y_KEYS.progressVerify,
    done: span,
    total: span,
  });

  return {
    bytes: out,
    report: {
      engine: 'mupdf',
      steps,
      notes,
      inputBytes: bytes.byteLength,
      outputBytes: out.byteLength,
      pageCount,
      // Page content streams were rewritten: the incremental fast path is over.
      incremental: false,
    },
  };
}

/** `throwIfAborted`'s error, recognised so a page read is never re-labelled as a fault. */
export function isAbort(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * What a writer throws for an error caught around engine work: the caller's own abort passes
 * through untouched, a `ToolError` already says what failed, anything else is MuPDF's and is
 * mapped with the step (`context`) that was running.
 */
export function engineFailure(error: unknown, context: string): Error {
  return isAbort(error) ? error : mapMupdfError(error, context);
}

/** The image `Do` operators of one page, with the alt text their XObject already carries. */
export function figureClaims(
  page: PDFObject,
  scan: ContentScan,
): readonly { readonly index: number; readonly role: string; readonly alt: string | null }[] {
  const resources = dictOf(page.getInheritable('Resources'));
  const xobjects = resources === null ? null : dictOf(resources.get('XObject'));
  if (xobjects === null) return [];
  const claims: { index: number; role: string; alt: string | null }[] = [];
  // Every drawing of an image is a figure, the same picture drawn twice included: an
  // unmarked `Do` is content a reader would meet outside the tree.
  for (const draw of scan.draws) {
    const entry = xobjects.get(draw.name);
    if (entry.isNull() || !entry.isStream()) continue;
    // A stream resolves to itself.
    const dict = resolved(entry) as PDFObject;
    if (nameOf(dict.get('Subtype')) !== 'Image') continue;
    claims.push({ index: draw.index, role: 'Figure', alt: textOf(dict.get('Alt')) });
  }
  return claims;
}

/** Whether any instruction in `[from, to]` is a show that another block owns. */
function hasOtherOwner(
  owner: ReadonlyMap<number, number>,
  blockIndex: number,
  from: number,
  to: number,
): boolean {
  for (let index = from; index <= to; index += 1) {
    const other = owner.get(index);
    if (other !== undefined && other !== blockIndex) return true;
  }
  return false;
}

/**
 * The claims of one page: the matched text runs and the figures, in content-stream
 * order, with an MCID each. A run that overlaps an already-claimed range is dropped —
 * two `/P` elements cannot both own the same `Tj`, and cutting one in half would make
 * the tree describe content it does not cover. The dropped count is reported.
 */
export function claimsFor(
  plan: PagePlan,
  roles: ReadonlyMap<number, string>,
  pagePlan?: TagPlanPage,
): { readonly claims: readonly Claim[]; readonly skipped: number } {
  const nesting = nestingOf(plan.scan.instructions);
  const planned = (id: string, fallback: string): string => {
    const wanted = pagePlan?.roles?.[id];
    return wanted !== undefined && (wanted === 'Artifact' || EDITOR_ROLES.includes(wanted))
      ? wanted
      : fallback;
  };
  const candidates: { first: number; last: number; role: string; blockId: string; alt: string | null }[] = [];
  let skipped = 0;
  const widen = (first: number, last: number) =>
    expandToNesting(plan.scan.instructions, nesting, first, last);
  const owner = new Map<number, number>();
  for (const match of plan.matched.matches) {
    for (const show of match.shows) owner.set(show, match.blockIndex);
  }
  for (const match of plan.matched.matches) {
    const region = plan.regions[match.blockIndex] as BlockRegion;
    const role = planned(region.id, roles.get(Math.round(region.fontSize)) ?? 'P');
    // A block's shows are grouped into sequences that stay inside one text object and one
    // `q` level, with none of another block's text between them. A block that spans several
    // text objects (a list drawn item by item, a paragraph around an image) becomes several
    // sequences that all belong to one element, never one sequence stretched over them.
    const segments: { first: number; last: number }[] = [];
    for (const show of match.shows) {
      const current = segments[segments.length - 1];
      if (
        current !== undefined &&
        (nesting.object[current.first] as number) !== -1 &&
        nesting.object[current.first] === nesting.object[show + 1] &&
        nesting.depth[current.first] === nesting.depth[show + 1] &&
        !hasOtherOwner(owner, match.blockIndex, current.last + 1, show - 1)
      ) {
        current.last = show;
      } else {
        segments.push({ first: show, last: show });
      }
    }
    for (const segment of segments) {
      const range = widen(segment.first, segment.last);
      if (range === null) {
        skipped += 1;
        continue;
      }
      candidates.push({ ...range, role, blockId: region.id, alt: null });
    }
  }
  for (const figure of plan.draws) {
    // A `Do` is neither a `BT`/`ET` nor a `q`/`Q`, so its own range already opens and closes at one level.
    const range = widen(figure.index, figure.index) as { readonly first: number; readonly last: number };
    const id = `f${String(figure.index)}`;
    candidates.push({
      ...range,
      role: planned(id, figure.role),
      blockId: id,
      alt: pagePlan?.alts?.[id]?.trim() || figure.alt,
    });
  }
  candidates.sort((left, right) => left.first - right.first);

  // A page whose stream already carries marked-content ids (an untagged file that lost its
  // tree, say) must not get a second claim on the same number.
  let base = 0;
  for (const found of latin1(plan.scan.bytes).matchAll(/\/MCID\s+(\d+)/g)) {
    base = Math.max(base, Number(found[1]) + 1);
  }

  const claims: Claim[] = [];
  let cursor = -1;
  let next = base;
  for (const candidate of candidates) {
    if (candidate.first <= cursor) {
      skipped += 1;
      continue;
    }
    const artifact = candidate.role === 'Artifact';
    claims.push({ ...candidate, mcid: artifact ? -1 : next });
    if (!artifact) next += 1;
    cursor = candidate.last;
  }
  return { claims, skipped };
}

/**
 * The claims of a page in the order their elements go in the tree: the plan's `order`
 * first, then every claim it did not mention, in content order. Artifacts have no element.
 */
export function treeOrder(claims: readonly Claim[], pagePlan?: TagPlanPage): readonly ElementClaims[] {
  // One element per block: the claims of a block that spans several text objects share it.
  const groups = new Map<string, ElementClaims>();
  for (const claim of claims) {
    if (claim.role === 'Artifact') continue;
    const group = groups.get(claim.blockId);
    if (group === undefined) {
      groups.set(claim.blockId, {
        role: claim.role,
        blockId: claim.blockId,
        alt: claim.alt,
        mcids: [claim.mcid],
      });
    } else group.mcids.push(claim.mcid);
  }
  const wanted = pagePlan?.order ?? [];
  const ordered: ElementClaims[] = [];
  for (const id of wanted) {
    const group = groups.get(id);
    if (group === undefined) continue;
    ordered.push(group);
    groups.delete(id);
  }
  for (const group of groups.values()) ordered.push(group);
  return ordered;
}

/** One element's claims: the marked-content ids it owns on a page, in content order. */
export interface ElementClaims {
  readonly role: string;
  readonly blockId: string;
  readonly alt: string | null;
  readonly mcids: number[];
}

/**
 * Re-open the produced file and count its own marked-content sequences against the
 * structure tree. Three things are checked, and any of them failing is
 * `verification-failed`: the tree exists with a `/Document`, the
 * marked-content count of each page matches the MCRs written for it, and every MCID the
 * tree names is really in that page's content stream. A tree pointing at nothing is the
 * failure this whole operation is built to avoid, so it is measured rather than assumed.
 */
async function verifyTagged(
  produced: Uint8Array,
  tagged: readonly TaggedPage[],
  context: OperationContext,
): Promise<void> {
  let opened: Awaited<ReturnType<typeof openForWrite>>;
  try {
    opened = await openForWrite(produced);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: `the tagged file does not re-open: ${message}`,
    });
  }
  const { doc } = opened;
  try {
    const catalog = catalogOf(doc);
    if (dictOf(catalog.get('StructTreeRoot')) === null) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: 'the produced file has no /StructTreeRoot',
      });
    }
    const marked = resolved(dictOf(catalog.get('MarkInfo'))?.get('Marked'));
    if (marked?.isBoolean() !== true || !marked.asBoolean()) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: 'the produced file has no /MarkInfo << /Marked true >>',
      });
    }
    const pages = pageObjects(doc);
    for (const page of tagged) {
      throwIfAborted(context.signal);
      const object = pages[page.pageIndex];
      const content = object === undefined ? null : pageContent(object);
      if (content === null) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `page ${page.pageIndex + 1} content is unreadable after the write`,
        });
      }
      const instructions = readInstructions(content.bytes);
      if (instructions === null) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `page ${page.pageIndex + 1} content cannot be tokenized after the write`,
        });
      }
      const text = latin1(content.bytes);
      const found = new Set<number>();
      for (const match of text.matchAll(/\/P <<\/MCID (\d+)>> BDC/g)) {
        found.add(Number(match[1]));
      }
      // The splice added exactly the sequences it claims to have added and left the stream
      // balanced. They are counted as operators, so a page that already carried marked
      // content of its own (optional content, artifacts) verifies as well.
      const after = markedContentCounts(instructions);
      const opened = after.opens - page.before.opens;
      const closed = after.closes - page.before.closes;
      if (opened !== page.added.total || closed !== page.added.total) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `page ${page.pageIndex + 1} gained ${opened} marked-content starts and ${closed} ends, expected ${page.added.total}`,
        });
      }
      // Equal counts are not enough: the new sequences must nest with the text objects, the
      // `q` levels and the sequences the page already had. What the page was already doing
      // wrong is not the splice's doing, so only what it *gained* is refused.
      const crossed = after.crossings - page.before.crossings;
      const stray = after.strays - page.before.strays;
      if (crossed > 0 || stray > 0) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `page ${page.pageIndex + 1} marked content does not nest: ${crossed} sequences cross a text object, a graphics-state level or another sequence and ${stray} closing operators have nothing to close`,
        });
      }
      for (const element of page.elements) {
        for (const mcid of element.mcids) {
          if (!found.has(mcid)) {
            throw new ToolError('verification-failed', {
              engine: 'mupdf',
              engineMessage: `page ${page.pageIndex + 1} structure points at /MCID ${mcid}, which is not in its content stream`,
            });
          }
        }
      }
    }
  } finally {
    doc.destroy();
  }
}

/**
 * What the splice is verified by: how many marked-content operators a stream has, and whether
 * the three kinds of scope that must nest — `q … Q`, `BT … ET` and `BMC/BDC … EMC` — do.
 *
 * Counting `BDC`s against `EMC`s cannot tell `BDC BDC EMC EMC` from `BDC q EMC Q`: both are
 * balanced and only the first is a content stream. The scopes are therefore walked as one
 * stack, the way a reader that rejects crossed sequences walks them.
 */
export interface MarkedContentShape {
  /** `BMC` and `BDC` operators. */
  readonly opens: number;
  /** `EMC` operators. */
  readonly closes: number;
  /** Scopes forced shut by the closer of an enclosing scope before their own closer (`BDC … ET`, `q … EMC`). */
  readonly crossings: number;
  /** Closers (`Q`, `ET`, `EMC`) with no open scope of their kind. */
  readonly strays: number;
}

export function markedContentCounts(instructions: readonly Instruction[]): MarkedContentShape {
  const GRAPHICS = 0;
  const TEXT = 1;
  const MARKED = 2;
  let opens = 0;
  let closes = 0;
  let crossings = 0;
  let strays = 0;
  const stack: number[] = [];
  // Per kind, how many scopes of it are on the stack: a closer with none is stray in O(1), so
  // a stream of a million `Q`s above a deep stack of `BDC`s costs a million steps, not a trillion.
  const open = [0, 0, 0];
  const push = (kind: number): void => {
    stack.push(kind);
    open[kind] = (open[kind] as number) + 1;
  };
  const close = (kind: number): void => {
    if (open[kind] === 0) {
      strays += 1;
      return;
    }
    for (;;) {
      const top = stack.pop() as number;
      open[top] = (open[top] as number) - 1;
      if (top === kind) return;
      crossings += 1;
    }
  };
  for (const instruction of instructions) {
    switch (instruction.operator) {
      case 'q':
        push(GRAPHICS);
        break;
      case 'Q':
        close(GRAPHICS);
        break;
      case 'BT':
        push(TEXT);
        break;
      case 'ET':
        close(TEXT);
        break;
      case 'BMC':
      case 'BDC':
        opens += 1;
        push(MARKED);
        break;
      case 'EMC':
        closes += 1;
        close(MARKED);
        break;
      default:
        break;
    }
  }
  return { opens, closes, crossings, strays };
}

/** One byte is one character: the notation a content stream is written in (§7.2). */
export function latin1(bytes: Uint8Array): string {
  let text = '';
  const chunk = 8192;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    text += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * Alt text
 * ------------------------------------------------------------------ */

/**
 * Write `/Alt` on named image XObjects and `/TU` on named form fields.
 *
 * The two are one operation because they are the same user task — "say what this is" —
 * and because a form field's tooltip is the only accessible name a field has.
 *
 * **An image is one object, not one page.** When several pages draw the same XObject,
 * the alt text is written to that object and therefore appears on all of them; the
 * report says so with the page list rather than implying a per-page alt text that a PDF
 * cannot carry. An object that exists only in a page's resources and is never drawn gets
 * its alt text and a warning that no content stream draws it.
 */
export async function setImageAlt(
  bytes: Uint8Array,
  edits: readonly AltTextEdit[],
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  for (const edit of edits) {
    const value = edit.kind === 'image' ? edit.alt : edit.tooltip;
    if (value.trim() === '') {
      throw new ToolError('value-out-of-range', {
        engine: 'model',
        path: edit.kind === 'image' ? 'edit.alt' : 'edit.tooltip',
        engineMessage: 'an empty alt text is worse than none: say what the object is',
      });
    }
  }
  const { doc } = await openForWrite(bytes);
  let out: Uint8Array;
  let pageCount: number;
  const notes: OperationNote[] = [];
  const steps: string[] = ['load'];
  const applied: {
    readonly pageIndex: number;
    readonly name: string;
    readonly alt: string;
    readonly number: number;
  }[] = [];
  const appliedFields: { readonly name: string; readonly tooltip: string }[] = [];
  try {
    const pages = pageObjects(doc);
    pageCount = pages.length;
    const catalog = catalogOf(doc);
    let missing = 0;
    const figureIndex = edits.some((edit) => edit.kind === 'image')
      ? readFigureIndex(catalog, pageNumbers(pages))
      : null;
    const pageFigures = figureIndex === null ? null : imageFigures(pages, figureIndex);

    for (const edit of edits) {
      throwIfAborted(context.signal);
      if (edit.kind === 'field') {
        const field = findField(catalog, edit.name);
        if (field === null) {
          missing += 1;
          continue;
        }
        field.put('TU', text(doc, edit.tooltip));
        appliedFields.push({ name: edit.name, tooltip: edit.tooltip });
        continue;
      }
      const target = findImage(pages, edit.pageIndex, edit.name);
      if (target === null) {
        missing += 1;
        continue;
      }
      // In a tagged file the picture's alt text is its `Figure`'s: that is where a reader looks,
      // and an `/Alt` on the XObject would change nothing it shows. A file whose tree owns the
      // image through no figure (an untagged file, an image in an artifact) keeps the XObject's.
      const figures =
        figureIndex === null || pageFigures === null
          ? []
          : figuresOf(figureIndex, pageFigures, target.number);
      if (figures.length === 0 && figureIndex?.truncated === true) {
        throw new ToolError('unsupported', {
          engine: 'mupdf',
          path: 'edits',
          engineMessage: 'the structure tree is too large to find the figure that owns the image',
        });
      }
      if (figures.length === 0) target.dict.put('Alt', text(doc, edit.alt));
      for (const figure of figures) figure.dict.put('Alt', text(doc, edit.alt));
      applied.push({ pageIndex: edit.pageIndex, name: edit.name, alt: edit.alt, number: target.number });
    }

    if (applied.length === 0 && appliedFields.length === 0) {
      notes.push(note('warning', 'op.note.image.noneFound', { count: missing }));
      notes.push(producerKeptNote());
      return {
        bytes,
        report: {
          engine: 'mupdf',
          steps: ['load'],
          notes,
          inputBytes: bytes.byteLength,
          outputBytes: bytes.byteLength,
          pageCount,
          incremental: true,
        },
      };
    }

    for (const entry of applied) {
      const drawn = drawnPages(pages, entry.number);
      notes.push(
        note('changed', A11Y_KEYS.altSet, {
          name: entry.name,
          page: entry.pageIndex + 1,
          alt: entry.alt,
          pages: pageList(drawn),
        }),
      );
      if (drawn.length > 1) {
        notes.push(
          note('warning', A11Y_KEYS.altShared, {
            name: entry.name,
            count: drawn.length,
            pages: pageList(drawn),
          }),
        );
      }
      if (drawn.length === 0) {
        notes.push(note('warning', A11Y_KEYS.altNotDrawn, { name: entry.name, page: entry.pageIndex + 1 }));
      }
    }
    for (const entry of appliedFields) {
      notes.push(note('changed', A11Y_KEYS.tooltipSet, { name: entry.name, tooltip: entry.tooltip }));
    }
    if (missing > 0) {
      notes.push(note('warning', A11Y_KEYS.targetMissing, { count: missing }));
    }
    steps.push('alt');
    steps.push('producer');
    throwIfAborted(context.signal);
    out = saveRewrite(doc, 'set alt text');
  } catch (error) {
    if (isAbort(error)) throw error;
    throw mapMupdfError(error, 'set alt text');
  } finally {
    doc.destroy();
  }
  steps.push('save');

  await verifyAlt(out, applied, appliedFields);
  steps.push('verify');

  return {
    bytes: out,
    report: {
      engine: 'mupdf',
      steps,
      notes,
      inputBytes: bytes.byteLength,
      outputBytes: out.byteLength,
      pageCount,
      incremental: false,
    },
  };
}

/** The image a `(pageIndex, name)` pair names — its object number and dictionary — or `null`. */
function findImage(
  pages: readonly PDFObject[],
  pageIndex: number,
  name: string,
): { readonly number: number; readonly dict: PDFObject } | null {
  const page = Number.isInteger(pageIndex) ? pages[pageIndex] : undefined;
  if (page === undefined) return null;
  const resources = dictOf(page.getInheritable('Resources'));
  const xobjects = resources === null ? null : dictOf(resources.get('XObject'));
  const entry = xobjects?.get(name);
  if (entry === undefined || entry.isNull() || !entry.isStream()) return null;
  // A stream resolves to itself, and a stream is always an indirect object.
  const dict = resolved(entry) as PDFObject;
  if (nameOf(dict.get('Subtype')) !== 'Image') return null;
  return { number: entry.asIndirect(), dict };
}

/** Every page whose content stream draws the image object `number` — the sharing fact. */
function drawnPages(pages: readonly PDFObject[], number: number): readonly number[] {
  const found: number[] = [];
  for (const [index, page] of pages.entries()) {
    const content = pageContent(page);
    if (content === null) continue;
    const instructions = readInstructions(content.bytes);
    if (instructions === null) continue;
    const { draws } = walkContent(instructions);
    for (const draw of draws) {
      if (findImage(pages, index, draw.name)?.number === number) {
        found.push(index);
        break;
      }
    }
  }
  return found;
}

/** A form field by fully qualified name, anywhere in the AcroForm tree. */
export function findField(catalog: PDFObject, name: string): PDFObject | null {
  const acro = dictOf(catalog.get('AcroForm'));
  const fields = acro === null ? null : resolved(acro.get('Fields'));
  if (fields?.isArray() !== true) return null;

  const walk = (entries: PDFObject, prefix: string, depth: number): PDFObject | null => {
    if (depth > 32) return null;
    for (let index = 0; index < entries.length; index += 1) {
      const dict = dictOf(entries.get(index));
      if (dict === null) continue;
      const own = textOf(dict.get('T'));
      const qualified = own === null ? prefix : prefix === '' ? own : `${prefix}.${own}`;
      const node = fieldNode(dict);
      if (node.kind === 'group') {
        const found = walk(node.kids, qualified, depth + 1);
        if (found !== null) return found;
        continue;
      }
      // The field's own dictionary — the parent of a radio group's widgets — is what carries `/TU`.
      if (isNamedField(node, own, qualified) && qualified === name) return dict;
    }
    return null;
  };

  return walk(fields, '', 0);
}

/** The written text is read back out of the produced file; a mismatch is a failed write. */
async function verifyAlt(
  produced: Uint8Array,
  images: readonly { readonly pageIndex: number; readonly name: string; readonly alt: string }[],
  fields: readonly { readonly name: string; readonly tooltip: string }[],
): Promise<void> {
  let opened: Awaited<ReturnType<typeof openForWrite>>;
  try {
    opened = await openForWrite(produced);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: `the file does not re-open after writing alt text: ${message}`,
    });
  }
  const { doc } = opened;
  try {
    const pages = pageObjects(doc);
    const catalog = catalogOf(doc);
    const figureIndex = images.length === 0 ? null : readFigureIndex(catalog, pageNumbers(pages));
    const pageFigures = figureIndex === null ? null : imageFigures(pages, figureIndex);
    for (const image of images) {
      const found = findImage(pages, image.pageIndex, image.name);
      // The text is read back from where it was written: every figure that owns the image, or the XObject.
      const figures =
        found === null || figureIndex === null || pageFigures === null
          ? []
          : figuresOf(figureIndex, pageFigures, found.number);
      const carriers = figures.length > 0 ? figures.map((figure) => figure.dict) : [found?.dict ?? null];
      for (const carrier of carriers) {
        const alt = carrier === null ? null : textOf(carrier.get('Alt'));
        if (alt !== image.alt.trim()) {
          throw new ToolError('verification-failed', {
            engine: 'mupdf',
            engineMessage: `image "${image.name}" reads back "${alt ?? ''}" instead of "${image.alt}"`,
          });
        }
      }
    }
    for (const field of fields) {
      const dict = findField(catalog, field.name);
      const tooltip = dict === null ? null : textOf(dict.get('TU'));
      if (tooltip !== field.tooltip.trim()) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `field "${field.name}" reads back "${tooltip ?? ''}" instead of "${field.tooltip}"`,
        });
      }
    }
  } finally {
    doc.destroy();
  }
}
