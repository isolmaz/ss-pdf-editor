/**
 * Font inventory of a document ("Document properties
 * panel": font list). Read-only: nothing here changes the file. The walk runs over
 * MuPDF's object model (`engines/mupdf-write.ts` holds the binding rules) and never
 * calls a helper that normalises or creates entries.
 *
 * Path implemented, per ISO 32000-2 §7.8.3 (resource dictionaries) and §9.5–9.7
 * (font dictionaries):
 *   `page.getInheritable('Resources')` → `/Resources /Font` → one entry per font
 *   resource. The lookup walks the page tree and every entry is resolved, so both the
 *   inherited-resources and the indirect-object cases are covered.
 *   - `/BaseFont` (a name; §9.6.4) is the identity the inventory merges on. The
 *     six-letter subset tag (`ABCDEF+Name`, §9.6.4) is read off that same string.
 *   - `/Subtype` is the type: `Type0`, `Type1`, `TrueType`, `Type3`,
 *     `CIDFontType0`, `CIDFontType2`.
 *   - `/Encoding` is either a name (`/WinAnsiEncoding`, a CMap name such as
 *     `/Identity-H`) or a dictionary/stream — a Type0 CMap stream carries
 *     `/CMapName`, a simple-font encoding dictionary carries `/BaseEncoding`
 *     (§9.6.6, §9.7.5). A `/Differences` array has no name to report.
 *   - "Embedded" means a `/FontFile`, `/FontFile2` or `/FontFile3` stream is
 *     reachable from the font descriptor (§9.8.2). For `Type0` the descriptor
 *     hangs on the descendant CIDFont reached through `/DescendantFonts`
 *     (§9.7.4), which is why both are checked.
 *
 * Two hard caps keep a hostile document from owning the tab: `MAX_PAGES` pages
 * are walked and at most `MAX_FONTS` distinct fonts are collected. Both are far
 * above any real document; a capped walk returns what it saw rather than lying
 * about the rest — the panel states the count it renders.
 *
 * Failures are mapped through `mapMupdfError`; the engine's own text stays in
 * `details.engineMessage` and is never rendered. An abort is rethrown as-is so
 * the caller's `signal.aborted` check keeps working.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { mapMupdfError } from '../engines/mupdf';
import { openForWrite, readName, readText, resolved } from '../engines/mupdf-write';
import { throwIfAborted } from './types';

export interface PdfFontInfo {
  readonly baseFont: string;
  /** `Type0` / `Type1` / `TrueType` / `Type3` / `CIDFontType0` / `CIDFontType2`. */
  readonly subtype: string;
  /** A `/FontFile*` stream is present. */
  readonly embedded: boolean;
  /** `/Encoding` name, or the CMap name when the engine exposes one. */
  readonly encoding: string | null;
  /** The `BaseFont` carries the six-letter subset tag (`ABCDEF+Name`). */
  readonly subset: boolean;
  /** 0-based pages whose resources use it, ascending. */
  readonly pages: readonly number[];
}

export const MAX_FONTS = 2000;
export const MAX_PAGES = 20000;

/** `ABCDEF+Name` — six uppercase letters, then `+` (ISO 32000-2 §9.6.4). */
const SUBSET_TAG = /^[A-Z]{6}\+/;

const FONT_FILE_KEYS = ['FontFile', 'FontFile2', 'FontFile3'] as const;

/** `/Name` → `Name`, or the decoded text of a string a broken writer used instead. */
function nameFromDict(dict: PDFObject, key: string): string | null {
  const value = dict.get(key);
  return readName(value) ?? readText(value);
}

function dictionaryAt(parent: PDFObject, key: string): PDFObject | null {
  const value = resolved(parent.get(key));
  return value?.isDictionary() === true ? value : null;
}

/** `/FontFile`, `/FontFile2` or `/FontFile3` present on this descriptor (§9.8.2). */
function descriptorHasFontFile(descriptor: PDFObject | null): boolean {
  if (descriptor === null) return false;
  return FONT_FILE_KEYS.some((key) => resolved(descriptor.get(key)) !== null);
}

/** A `Type0` font embeds through its descendant CIDFont (`/DescendantFonts`, §9.7.4). */
function embeddedFontFile(font: PDFObject): boolean {
  if (descriptorHasFontFile(dictionaryAt(font, 'FontDescriptor'))) return true;

  const descendants = resolved(font.get('DescendantFonts'));
  if (descendants === null || !descendants.isArray()) return false;
  for (let index = 0; index < descendants.length; index += 1) {
    const descendant = resolved(descendants.get(index));
    if (descendant === null || !descendant.isDictionary()) continue;
    if (descriptorHasFontFile(dictionaryAt(descendant, 'FontDescriptor'))) return true;
  }
  return false;
}

/**
 * The encoding in one string: the name itself, or the `/CMapName` of a CMap
 * stream, or the `/BaseEncoding` of an encoding dictionary. An unnamed encoding
 * (a `/Differences` array) is `null` — a fabricated name would be worse than none.
 */
function encodingName(font: PDFObject): string | null {
  const object = resolved(font.get('Encoding'));
  if (object === null) return null;
  if (object.isName()) return object.asName();
  // A CMap stream resolves to its dictionary; both shapes carry the names read here.
  if (object.isDictionary()) return nameFromDict(object, 'CMapName') ?? nameFromDict(object, 'BaseEncoding');
  return null;
}

interface FontAccumulator {
  subtype: string;
  encoding: string | null;
  embedded: boolean;
  readonly pages: Set<number>;
}

function collectPageFonts(pageIndex: number, fonts: PDFObject, merged: Map<string, FontAccumulator>): void {
  const entries: [string, PDFObject][] = [];
  fonts.forEach((value, key) => {
    // A dictionary's keys are names; the callback type also covers an array's indices.
    entries.push([String(key), value]);
  });
  for (const [key, value] of entries) {
    const font = resolved(value);
    // A `/Font` entry that is not a dictionary cannot be read; the other entries still can.
    if (font === null || !font.isDictionary()) continue;

    // `BaseFont` is required by the spec but not always written; the resource key
    // (`/F1`) is then the only name the page itself knows.
    const baseFont = nameFromDict(font, 'BaseFont') ?? key;
    const existing = merged.get(baseFont);
    if (existing !== undefined) {
      existing.pages.add(pageIndex);
      existing.embedded ||= embeddedFontFile(font);
      existing.encoding ??= encodingName(font);
      if (existing.subtype === '') existing.subtype = nameFromDict(font, 'Subtype') ?? '';
      continue;
    }
    if (merged.size >= MAX_FONTS) return;

    merged.set(baseFont, {
      subtype: nameFromDict(font, 'Subtype') ?? '',
      encoding: encodingName(font),
      embedded: embeddedFontFile(font),
      pages: new Set([pageIndex]),
    });
  }
}

function walkPages(doc: PDFDocument, signal: AbortSignal | undefined): readonly PdfFontInfo[] {
  const merged = new Map<string, FontAccumulator>();
  const count = Math.min(doc.countPages(), MAX_PAGES);

  for (let pageIndex = 0; pageIndex < count; pageIndex += 1) {
    if (signal !== undefined) throwIfAborted(signal);

    // `getInheritable` walks the page tree: resources inherited from a `/Pages` node
    // are the normal case for a document with more than one page (§7.7.3.4).
    const resources = resolved(doc.findPage(pageIndex).getInheritable('Resources'));
    if (resources === null || !resources.isDictionary()) continue;
    const fonts = dictionaryAt(resources, 'Font');
    if (fonts === null) continue;

    collectPageFonts(pageIndex, fonts, merged);
    if (merged.size >= MAX_FONTS) break;
  }

  return [...merged].map(([baseFont, info]) => ({
    baseFont,
    subtype: info.subtype,
    embedded: info.embedded,
    encoding: info.encoding,
    subset: SUBSET_TAG.test(baseFont),
    pages: [...info.pages].sort((left, right) => left - right),
  }));
}

/**
 * Every font the document's pages use, merged by `BaseFont` with their page
 * lists unioned. A document without pages or without a `/Font` resource is an
 * empty list, not an error.
 */
export async function listPdfFonts(bytes: Uint8Array, signal?: AbortSignal): Promise<readonly PdfFontInfo[]> {
  // `openForWrite` hands the engine a copy (never the app-owned master buffer);
  // nothing is edited or saved here.
  const { doc } = await openForWrite(bytes);
  try {
    return walkPages(doc, signal);
  } catch (error) {
    // `throwIfAborted` raises a plain `Error` named `AbortError`; mapping it into a
    // `ToolError` would turn a cancellation into a failure the caller must report.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'list fonts');
  } finally {
    doc.destroy();
  }
}
