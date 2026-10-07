/**
 * The document's own fonts as faces new text can be drawn with.
 *
 * A replacement drawn with the font the page already uses looks exactly like the text
 * around it, which no substitute can. Two facts decide whether that is possible:
 *
 *   - **the code for a character** — read from `/ToUnicode` (code → text, inverted),
 *     or, for a simple font without one, from its base encoding and `/Differences`;
 *   - **whether the glyph is in the file** — an embedded subset holds only the glyphs
 *     the producer used, and an encoding happily names codes the subset does not have.
 *     That half is not answered here: the caller only draws characters the page itself
 *     already drew with this font (`find-replace.ts`), which is proof the glyph exists.
 *
 * Type3 fonts and composite fonts with any CMap other than `Identity-H` are not used.
 * Widths come from `/Widths` (simple) or `/W` and `/DW` (composite), in thousandths of
 * an em, so a measured line is the width a reader will draw.
 *
 * MuPDF's text extraction reports the font's own name in its own spelling
 * (`NimbusSans-Bold` for `/BaseFont /Nimbus#20Sans#20Bold`), so names are compared
 * with case, spaces and punctuation removed ({@link sameFontName}).
 */

import type { PDFObject } from 'mupdf';
import { readName, readNumbers, resolved } from './mupdf-write';

/** The face id prefix of a document font in a text-edit request: `doc:<name>`. */
export const DOCUMENT_FONT_PREFIX = 'doc:';

export interface DocumentFont {
  /** Every name the font goes by: `/BaseFont`, the descendant's, `/FontName`. */
  readonly names: readonly string[];
  /** The font as a resource dictionary refers to it (the indirect reference when it is one). */
  readonly ref: PDFObject;
  readonly codeBytes: 1 | 2;
  /** Code point → character code. */
  readonly codes: ReadonlyMap<number, number>;
  /** A code's advance, in thousandths of an em; `0` when the font gives none. */
  width(code: number): number;
  /** `/Ascent` and `/Descent` of the font descriptor, in thousandths of an em. */
  readonly ascent: number;
  readonly descent: number;
}

/** The width of a word gap drawn as a `TJ` adjustment when the font has no space glyph. */
const GAP_THOUSANDTHS = 250;

/** How deep form XObjects are searched for fonts. */
const FORM_DEPTH = 3;

/** `/W` ranges longer than this are not expanded (a broken or hostile width table). */
const MAX_RANGE = 0x10000;

/** `ABCDEF+Name` → `Name`, then lower case letters and digits only. */
function normalized(name: string): string {
  return name
    .replace(/^[A-Z]{6}\+/u, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '');
}

/**
 * Whether two spellings name one font. The subset tags must agree when both carry one:
 * `AAAAAA+Arial` and `BAAAAA+Arial` are two different subsets of Arial.
 */
export function sameFontName(left: string, right: string): boolean {
  const tag = /^([A-Z]{6})\+/u;
  const leftTag = tag.exec(left)?.[1];
  const rightTag = tag.exec(right)?.[1];
  if (leftTag !== undefined && rightTag !== undefined && leftTag !== rightTag) return false;
  return normalized(left) !== '' && normalized(left) === normalized(right);
}

/**
 * Every font of the page: its resources and, with `forms`, those of the forms it draws.
 *
 * `forms: false` is for a document that is redacted: resolving an image XObject of a
 * page and then applying redactions to it made MuPDF (1.28.1) save that image as a
 * dictionary without its stream (measured: `format error: object is not a stream` on
 * every render, the picture gone), while reading the font dictionaries left it intact.
 */
export function pageFonts(
  page: PDFObject,
  options: { readonly forms?: boolean } = {},
): readonly DocumentFont[] {
  const forms = options.forms ?? true;
  const fonts: DocumentFont[] = [];
  const seen = new Set<string>();
  const visit = (resources: PDFObject | null, depth: number): void => {
    if (resources === null || !resources.isDictionary()) return;
    const dictionary = resolved(resources.get('Font'));
    dictionary?.forEach((entry) => {
      const key = entry.isIndirect() ? `r${entry.asIndirect()}` : null;
      if (key !== null && seen.has(key)) return;
      if (key !== null) seen.add(key);
      const font = readDocumentFont(entry);
      if (font !== null) fonts.push(font);
    });
    if (!forms || depth >= FORM_DEPTH) return;
    resolved(resources.get('XObject'))?.forEach((entry) => {
      const form = resolved(entry);
      if (form === null || readName(form.get('Subtype')) !== 'Form') return;
      visit(resolved(form.get('Resources')), depth + 1);
    });
  };
  visit(resolved(page.getInheritable('Resources')), 0);
  return fonts;
}

/** The font of `fonts` the extractor's `name` refers to, or `null`. */
export function findFont(fonts: readonly DocumentFont[], name: string): DocumentFont | null {
  return fonts.find((font) => font.names.some((candidate) => sameFontName(candidate, name))) ?? null;
}

/** A font dictionary as a {@link DocumentFont}, or `null` when new text cannot be encoded for it. */
export function readDocumentFont(ref: PDFObject): DocumentFont | null {
  const font = resolved(ref);
  if (font === null || !font.isDictionary()) return null;
  const subtype = readName(font.get('Subtype'));
  const names: string[] = [];
  const addName = (value: string | null): void => {
    if (value !== null && value !== '' && !names.includes(value)) names.push(value);
  };
  addName(readName(font.get('BaseFont')));

  if (subtype === 'Type0') {
    if (readName(font.get('Encoding')) !== 'Identity-H') return null;
    const descendant = resolved(resolved(font.get('DescendantFonts'))?.get(0));
    if (descendant === null) return null;
    addName(readName(descendant.get('BaseFont')));
    addName(readName(resolved(descendant.get('FontDescriptor'))?.get('FontName')));
    const codes = toUnicodeCodes(font.get('ToUnicode'), 2);
    if (codes === null || codes.size === 0) return null;
    const widths = compositeWidths(descendant);
    return { names, ref, codeBytes: 2, codes, width: widths, ...verticalMetrics(descendant) };
  }

  if (subtype !== 'Type1' && subtype !== 'TrueType' && subtype !== 'MMType1') return null;
  addName(readName(resolved(font.get('FontDescriptor'))?.get('FontName')));
  const codes = toUnicodeCodes(font.get('ToUnicode'), 1) ?? encodingCodes(font.get('Encoding'));
  if (codes === null || codes.size === 0) return null;
  const first = resolved(font.get('FirstChar'))?.asNumber() ?? 0;
  const widths = readNumbers(font.get('Widths'));
  const missing = resolved(resolved(font.get('FontDescriptor'))?.get('MissingWidth'))?.asNumber() ?? 0;
  return {
    names,
    ref,
    codeBytes: 1,
    codes,
    width: (code) => widths[code - first] ?? missing,
    ...verticalMetrics(font),
  };
}

/** Ascent and descent from the font descriptor; 800 and −200 when it states none. */
function verticalMetrics(font: PDFObject): { readonly ascent: number; readonly descent: number } {
  const descriptor = resolved(font.get('FontDescriptor'));
  const ascent = resolved(descriptor?.get('Ascent'))?.asNumber() ?? 0;
  const descent = resolved(descriptor?.get('Descent'))?.asNumber() ?? 0;
  return { ascent: ascent > 0 ? ascent : 800, descent: descent < 0 ? descent : -200 };
}

/** The `/W` array and `/DW` of a CIDFont as a width lookup. */
function compositeWidths(descendant: PDFObject): (code: number) => number {
  const fallback = resolved(descendant.get('DW'))?.asNumber() ?? 1000;
  const table = new Map<number, number>();
  const array = resolved(descendant.get('W'));
  if (array?.isArray() === true) {
    let index = 0;
    while (index < array.length) {
      const start = resolved(array.get(index))?.asNumber();
      const next = resolved(array.get(index + 1));
      if (start === undefined || next === null) break;
      if (next.isArray()) {
        for (let offset = 0; offset < next.length; offset += 1) {
          const width = resolved(next.get(offset))?.asNumber();
          if (width !== undefined) table.set(start + offset, width);
        }
        index += 2;
      } else {
        const end = next.asNumber();
        const width = resolved(array.get(index + 2))?.asNumber() ?? fallback;
        for (let code = start; code <= end && code - start < MAX_RANGE; code += 1) table.set(code, width);
        index += 3;
      }
    }
  }
  return (code) => table.get(code) ?? fallback;
}

/** UTF-16BE hex → the one code point it spells, or `null` (ligatures and the like). */
function singleCodePoint(hex: string): number | null {
  if (hex.length % 4 !== 0 || hex.length === 0) return null;
  const units: number[] = [];
  for (let index = 0; index < hex.length; index += 4)
    units.push(Number.parseInt(hex.slice(index, index + 4), 16));
  const text = String.fromCharCode(...units);
  if ([...text].length !== 1) return null;
  // One code point means the string is not empty.
  return text.codePointAt(0) as number;
}

/** Capture group `index` of a match of a pattern in which that group is mandatory, so it always took part. */
function group(match: RegExpMatchArray, index: number): string {
  return match[index] as string;
}

/** The character a code point is, one per iteration of a string, so never empty. */
function pointOf(character: string): number {
  return character.codePointAt(0) as number;
}

/**
 * `/ToUnicode` inverted: code point → code. Only entries whose code is `bytes` long and
 * whose text is one code point are kept; when two codes spell one character, the first
 * listed wins.
 */
function toUnicodeCodes(entry: PDFObject, bytes: 1 | 2): Map<number, number> | null {
  if (entry.isNull() || !entry.isStream()) return null;
  let source: string;
  try {
    source = entry.readStream().asString();
  } catch {
    return null;
  }
  const codes = new Map<number, number>();
  const put = (code: number, point: number | null): void => {
    if (point !== null && !codes.has(point)) codes.set(point, code);
  };
  const hexLength = bytes * 2;
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
    for (const pair of group(block, 1).matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/gu)) {
      const code = group(pair, 1);
      const text = group(pair, 2);
      if (code.length !== hexLength) continue;
      put(Number.parseInt(code, 16), singleCodePoint(text));
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    const body = group(block, 1);
    for (const range of body.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/gu,
    )) {
      const low = group(range, 1);
      const high = group(range, 2);
      const target = group(range, 3);
      if (low.length !== hexLength || high.length !== hexLength) continue;
      const start = Number.parseInt(low, 16);
      const end = Number.parseInt(high, 16);
      // Codes are one or two bytes, so a range spans at most 0xFFFF codes: never an absurd one.
      if (end < start) continue;
      if (target.startsWith('[')) {
        const items = [...target.matchAll(/<([0-9a-fA-F]+)>/gu)].map((match) => group(match, 1));
        for (let code = start; code <= end; code += 1) {
          const item = items[code - start];
          if (item !== undefined) put(code, singleCodePoint(item));
        }
      } else {
        const base = target.slice(1, -1);
        const first = singleCodePoint(base);
        if (first === null) continue;
        for (let code = start; code <= end; code += 1) put(code, first + (code - start));
      }
    }
  }
  return codes;
}

/** Glyph names `/Differences` commonly uses, beyond `uniXXXX` and single letters. */
const GLYPH_NAMES: Readonly<Record<string, number>> = {
  space: 0x20,
  exclam: 0x21,
  quotedbl: 0x22,
  numbersign: 0x23,
  dollar: 0x24,
  percent: 0x25,
  ampersand: 0x26,
  quotesingle: 0x27,
  parenleft: 0x28,
  parenright: 0x29,
  asterisk: 0x2a,
  plus: 0x2b,
  comma: 0x2c,
  hyphen: 0x2d,
  period: 0x2e,
  slash: 0x2f,
  zero: 0x30,
  one: 0x31,
  two: 0x32,
  three: 0x33,
  four: 0x34,
  five: 0x35,
  six: 0x36,
  seven: 0x37,
  eight: 0x38,
  nine: 0x39,
  colon: 0x3a,
  semicolon: 0x3b,
  less: 0x3c,
  equal: 0x3d,
  greater: 0x3e,
  question: 0x3f,
  at: 0x40,
  bracketleft: 0x5b,
  backslash: 0x5c,
  bracketright: 0x5d,
  underscore: 0x5f,
  braceleft: 0x7b,
  bar: 0x7c,
  braceright: 0x7d,
  quoteleft: 0x2018,
  quoteright: 0x2019,
  quotedblleft: 0x201c,
  quotedblright: 0x201d,
  endash: 0x2013,
  emdash: 0x2014,
  bullet: 0x2022,
  ellipsis: 0x2026,
  Euro: 0x20ac,
  Scedilla: 0x15e,
  scedilla: 0x15f,
  Gbreve: 0x11e,
  gbreve: 0x11f,
  Idotaccent: 0x130,
  dotlessi: 0x131,
  Ccedilla: 0xc7,
  ccedilla: 0xe7,
  Odieresis: 0xd6,
  odieresis: 0xf6,
  Udieresis: 0xdc,
  udieresis: 0xfc,
};

function glyphNamePoint(name: string): number | null {
  if (/^[A-Za-z]$/u.test(name)) return pointOf(name);
  const unicode = /^uni([0-9A-Fa-f]{4})$/u.exec(name);
  if (unicode !== null) return Number.parseInt(group(unicode, 1), 16);
  // Own names only: `constructor` and `__proto__` are on every object and are not glyphs.
  return Object.hasOwn(GLYPH_NAMES, name) ? (GLYPH_NAMES[name] as number) : null;
}

/** A base encoding's code → code point table, through the platform's own decoder. */
function baseEncoding(name: string | null): Map<number, number> {
  const codes = new Map<number, number>();
  const label =
    name === 'MacRomanEncoding' ? 'macintosh' : name === 'WinAnsiEncoding' ? 'windows-1252' : null;
  if (label === null) {
    // StandardEncoding (the default of a Type1 font): ASCII but for the two quotes.
    for (let code = 0x20; code <= 0x7e; code += 1) {
      if (code !== 0x27 && code !== 0x60) codes.set(code, code);
    }
    return codes;
  }
  const decoder = new TextDecoder(label);
  for (let code = 0x20; code <= 0xff; code += 1) {
    if (code === 0x7f) continue;
    // Both decoders map every byte (WHATWG windows-1252 and macintosh have no holes), to one character.
    codes.set(code, pointOf(decoder.decode(new Uint8Array([code]))));
  }
  return codes;
}

/** A simple font's `/Encoding` inverted (code point → code), or `null` when it has none. */
function encodingCodes(entry: PDFObject): Map<number, number> | null {
  const target = resolved(entry);
  if (target === null) return null;
  let base: string | null;
  let differences: PDFObject | null = null;
  if (target.isName()) base = target.asName();
  else if (target.isDictionary()) {
    base = readName(target.get('BaseEncoding'));
    differences = resolved(target.get('Differences'));
  } else return null;
  const byCode = baseEncoding(base);
  if (differences?.isArray() === true) {
    let code = 0;
    for (let index = 0; index < differences.length; index += 1) {
      const item = resolved(differences.get(index));
      if (item === null) continue;
      if (item.isNumber()) {
        code = item.asNumber();
        continue;
      }
      if (item.isName()) {
        const point = glyphNamePoint(item.asName());
        if (point === null) byCode.delete(code);
        else byCode.set(code, point);
        code += 1;
      }
    }
  }
  const codes = new Map<number, number>();
  for (const [code, point] of byCode) if (!codes.has(point)) codes.set(point, code);
  return codes;
}

/** Whether every character of `text` has a code; white space may be drawn as gaps instead. */
export function encodes(font: DocumentFont, text: string): boolean {
  for (const character of text) {
    if (character.trim() === '') continue;
    const code = font.codes.get(pointOf(character));
    if (code === undefined || font.width(code) <= 0) return false;
  }
  return true;
}

/** The width of `text` at `size`, the way {@link showText} draws it. */
export function measureText(font: DocumentFont, text: string, size: number): number {
  let total = 0;
  for (const character of text) {
    const code = font.codes.get(pointOf(character));
    total += code === undefined ? GAP_THOUSANDTHS : font.width(code);
  }
  return (total * size) / 1000;
}

/**
 * The show operator for `text`: `<codes> Tj`, or a `TJ` array whose word gaps are
 * position adjustments when the font has no space glyph. Call only when
 * {@link encodes} holds.
 */
export function showText(font: DocumentFont, text: string): string {
  const hex = (code: number): string => code.toString(16).padStart(font.codeBytes * 2, '0');
  const parts: string[] = [];
  let run = '';
  for (const character of text) {
    const code = font.codes.get(pointOf(character));
    if (code !== undefined) {
      run += hex(code);
      continue;
    }
    if (run !== '') parts.push(`<${run}>`);
    run = '';
    parts.push(String(-GAP_THOUSANDTHS));
  }
  if (run !== '') parts.push(`<${run}>`);
  if (parts.length === 1 && parts[0]?.startsWith('<') === true) return `${parts[0]} Tj`;
  return `[${parts.join(' ')}] TJ`;
}
