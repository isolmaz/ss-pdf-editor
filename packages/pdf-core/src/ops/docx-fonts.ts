/**
 * The PDF's own fonts inside the "exact layout" Word export, so Word and LibreOffice draw the
 * glyphs the PDF draws instead of an Arial/Times stand-in.
 *
 * ## What is embedded
 *
 * 1. Per page, a MuPDF device records for every font the *visible* text uses (`fillText` /
 *    `strokeText`; invisible text is `ignoreText`, never recorded) the Unicode → glyph-id pairs
 *    actually drawn, and the advance of each glyph.
 * 2. The font programs are found in the page's resources (and its forms'): `FontFile2`
 *    (TrueType), `FontFile3` as a bare CFF (`Type1C`, `CIDFontType0C`) or a whole OpenType file.
 *    `FontFile` (Type 1) is not supported and keeps the Arial/Times fallback. The device's font
 *    is matched to the resource by `BaseFont`, the subset tag included (two subsets of one
 *    face are two programs); a name that carries no tag in the resources matches without it.
 * 3. `trueTypeForWord` / `cffForWord` (`docx-font-sfnt.ts`) rebuild each program as a small
 *    TrueType file whose `cmap` maps exactly those Unicode values to those glyphs. A font whose
 *    licence bits forbid embedding (OS/2 `fsType` 2), or one the builder cannot rebuild,
 *    keeps the fallback.
 * 4. Fonts are named by family (`HelveticaWorld-Bold` → family `HelveticaWorld`, style Bold).
 *    Two different programs of one family and style (the subsets of two pages) get the family
 *    ` 2`, ` 3` … so every program stays addressable.
 * 5. The package parts (`word/fontTable.xml`, `word/fonts/*.odttf`, `word/settings.xml`) are
 *    written obfuscated as ECMA-376 Part 1 §17.8.1 says.
 */

import type { Font, PDFDocument, PDFObject, PDFPage, Text } from 'mupdf';
import type { Mupdf } from '../engines/mupdf';
import { readName, resolved } from '../engines/mupdf-write';
import { XML_HEAD, xml } from './docx-drawing';
import { cffForWord, type FontNames, type GlyphMapping, trueTypeForWord } from './docx-font-sfnt';
import { fontFamily } from './page-layout';
import { type OperationContext, throwIfAborted } from './types';

/* ------------------------------------------------------------------ *
 * obfuscation (ECMA-376 Part 1 §17.8.1)
 * ------------------------------------------------------------------ */

/**
 * Obfuscates (and, being an XOR, de-obfuscates) an embedded font. The key is the GUID of the
 * font's `w:fontKey` (`{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`): its 32 hex digits are 16
 * bytes read from the left, and the key is those bytes in *reverse* order (the last two digits
 * of the GUID are `key[0]`). The first 32 bytes of the font are XORed with the key twice over
 * (`font[i] ^= key[i % 16]`); the rest is untouched. LibreOffice's `EmbeddedFontsHelper`
 * builds the same key (it reads the GUID string from position 35 down to 1 in steps of two).
 */
export function obfuscateFont(font: Uint8Array, guid: string): Uint8Array {
  const digits = guid.replace(/[{}-]/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(digits)) throw new RangeError(`Not a GUID: ${guid}`);
  const key = new Uint8Array(16);
  for (let at = 0; at < 16; at += 1) key[15 - at] = Number.parseInt(digits.slice(at * 2, at * 2 + 2), 16);
  const out = font.slice();
  for (let at = 0; at < Math.min(32, out.length); at += 1)
    out[at] = (out[at] as number) ^ (key[at % 16] as number);
  return out;
}

/** A GUID (`{…}`, upper case) derived from the font's bytes and its number, so the same export gives the same bytes. */
function guidOf(font: Uint8Array, index: number): string {
  const hex: string[] = [];
  for (let lane = 0; lane < 4; lane += 1) {
    let hash = (0x811c9dc5 ^ Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(lane + 1, 0x85ebca6b)) >>> 0;
    for (let at = 0; at < font.length; at += 1)
      hash = Math.imul(hash ^ (font[at] as number), 0x01000193) >>> 0;
    hex.push(hash.toString(16).toUpperCase().padStart(8, '0'));
  }
  const all = hex.join('');
  return `{${all.slice(0, 8)}-${all.slice(8, 12)}-${all.slice(12, 16)}-${all.slice(16, 20)}-${all.slice(20, 32)}}`;
}

/* ------------------------------------------------------------------ *
 * reading the font programs
 * ------------------------------------------------------------------ */

const u16 = (data: Uint8Array, at: number): number => ((data[at] as number) << 8) | (data[at + 1] as number);
const u32 = (data: Uint8Array, at: number): number => (u16(data, at) * 0x10000 + u16(data, at + 2)) >>> 0;
const tag = (data: Uint8Array, at: number): string => String.fromCharCode(...data.subarray(at, at + 4));

/** The table directory of an sfnt file (a collection's first font), or `null` when it is none. */
function sfntTables(data: Uint8Array): Map<string, { offset: number; length: number }> | null {
  if (data.length < 12) return null;
  let base = 0;
  if (tag(data, 0) === 'ttcf') base = u32(data, 12);
  const head = tag(data, base);
  if (u32(data, base) !== 0x00010000 && head !== 'true' && head !== 'OTTO') return null;
  const count = u16(data, base + 4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < count; index += 1) {
    const at = base + 12 + index * 16;
    if (at + 16 > data.length) return null;
    tables.set(tag(data, at), { offset: u32(data, at + 8), length: u32(data, at + 12) });
  }
  return tables;
}

/** Whether the font's licence bits (OS/2 `fsType` = 2, "restricted licence") forbid embedding it. */
function embeddingRestricted(
  tables: Map<string, { offset: number; length: number }>,
  data: Uint8Array,
): boolean {
  const os2 = tables.get('OS/2');
  if (os2 === undefined || os2.length < 10 || os2.offset + 10 > data.length) return false;
  return (u16(data, os2.offset + 8) & 0x000f) === 2;
}

/** A CFF INDEX at `at`: where its objects start and where it ends. */
function cffIndex(data: Uint8Array, at: number): { count: number; offsets: number[]; end: number } | null {
  if (at + 2 > data.length) return null;
  const count = u16(data, at);
  if (count === 0) return { count: 0, offsets: [], end: at + 2 };
  const size = data[at + 2] as number;
  if (size < 1 || size > 4) return null;
  const base = at + 3 + (count + 1) * size - 1;
  const offsets: number[] = [];
  for (let index = 0; index <= count; index += 1) {
    let value = 0;
    for (let byte = 0; byte < size; byte += 1)
      value = value * 256 + (data[at + 3 + index * size + byte] as number);
    offsets.push(base + value);
  }
  const end = offsets[count] as number;
  return end <= data.length ? { count, offsets, end } : null;
}

/**
 * For a CID-keyed CFF (a `ROS` operator in its Top DICT) the glyph MuPDF names by CID, mapped
 * to its index in the font's charstrings through the charset; `null` for a name-keyed font,
 * whose glyph ids are the indices themselves.
 */
function cffCidToGid(cff: Uint8Array): Map<number, number> | null {
  const header = cff[2];
  if (header === undefined) return null;
  const names = cffIndex(cff, header);
  const tops = names === null ? null : cffIndex(cff, names.end);
  const top = tops === null || tops.count < 1 ? null : cff.subarray(tops.offsets[0], tops.offsets[1]);
  if (top === null || tops === null) return null;
  let ros = false;
  let charset = 0;
  let strings = 0;
  const operands: number[] = [];
  for (let at = 0; at < top.length; ) {
    const b0 = top[at] as number;
    if (b0 <= 21) {
      let op = b0;
      at += 1;
      if (b0 === 12) {
        op = 1200 + (top[at] as number);
        at += 1;
      }
      if (op === 1230) ros = true;
      if (op === 15) charset = operands[operands.length - 1] ?? 0;
      if (op === 17) strings = operands[operands.length - 1] ?? 0;
      operands.length = 0;
    } else if (b0 === 28) {
      operands.push(((((top[at + 1] as number) << 8) | (top[at + 2] as number)) << 16) >> 16);
      at += 3;
    } else if (b0 === 29) {
      operands.push(u32(top, at + 1) | 0);
      at += 5;
    } else if (b0 === 30) {
      at += 1;
      while (at < top.length && ((top[at] as number) & 0x0f) !== 0x0f && (top[at] as number) >> 4 !== 0x0f)
        at += 1;
      at += 1;
      operands.push(0);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      at += 1;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + (top[at + 1] as number) + 108);
      at += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - (top[at + 1] as number) - 108);
      at += 2;
    } else at += 1;
  }
  if (!ros || charset <= 2) return null;
  const charStrings = cffIndex(cff, strings);
  if (charStrings === null) return null;
  const map = new Map<number, number>([[0, 0]]);
  const format = cff[charset] as number;
  let at = charset + 1;
  let gid = 1;
  if (format === 0) {
    for (; gid < charStrings.count; gid += 1, at += 2) map.set(u16(cff, at), gid);
  } else {
    while (gid < charStrings.count && at + 3 <= cff.length) {
      const first = u16(cff, at);
      const left = format === 1 ? (cff[at + 2] as number) : u16(cff, at + 2);
      at += format === 1 ? 3 : 4;
      for (let step = 0; step <= left && gid < charStrings.count; step += 1, gid += 1)
        map.set(first + step, gid);
    }
  }
  return map;
}

/** A font program found in a page's resources. */
interface Source {
  /** The font file's object number: one program, however many fonts or pages share it. */
  readonly key: number;
  readonly descriptor: PDFObject;
  readonly file: PDFObject;
}

/** `ABCDEF+Name` → `Name`. */
const untagged = (name: string): string => name.replace(/^[A-Z]{6}\+/, '');

/** The program of a font dictionary (the descendant's, for a Type0 font), or `null` when it has none MuPDF could pass on. */
function sourceOf(font: PDFObject): { names: string[]; source: Source } | null {
  const names: string[] = [];
  const add = (name: string | null) => {
    // The tagged name tells apart two subsets of one face; the stripped one is the fallback.
    if (name !== null) names.push(name, untagged(name));
  };
  add(readName(font.get('BaseFont')));
  let owner = font;
  if (readName(font.get('Subtype')) === 'Type0') {
    const descendant = resolved(resolved(font.get('DescendantFonts'))?.get(0));
    if (descendant === null) return null;
    add(readName(descendant.get('BaseFont')));
    owner = descendant;
  }
  const descriptor = resolved(owner.get('FontDescriptor'));
  if (descriptor === null) return null;
  for (const entry of ['FontFile2', 'FontFile3']) {
    const file = descriptor.get(entry);
    // The reference itself is kept: a stream is known as one only through its object number.
    if (file.isNull() || !file.isIndirect() || !file.isStream()) continue;
    return { names, source: { key: file.asIndirect(), descriptor, file } };
  }
  return null;
}

const FORM_DEPTH = 6;

/** The fonts of a page's resources and of the forms it draws: stripped `BaseFont` → program. */
function pageSources(page: PDFPage): Map<string, Source> {
  const found = new Map<string, Source>();
  const seen = new Set<number>();
  const visit = (resources: PDFObject | null, depth: number): void => {
    if (resources === null || !resources.isDictionary()) return;
    resolved(resources.get('Font'))?.forEach((entry) => {
      const read = sourceOf(resolved(entry) ?? entry);
      if (read === null) return;
      for (const name of read.names) if (!found.has(name)) found.set(name, read.source);
    });
    if (depth >= FORM_DEPTH) return;
    resolved(resources.get('XObject'))?.forEach((entry) => {
      const form = resolved(entry);
      if (form === null || readName(form.get('Subtype')) !== 'Form') return;
      const id = entry.isIndirect() ? entry.asIndirect() : 0;
      if (id !== 0) {
        if (seen.has(id)) return;
        seen.add(id);
      }
      visit(resolved(form.get('Resources')), depth + 1);
    });
  };
  visit(resolved(page.getObject().getInheritable('Resources')), 0);
  return found;
}

/* ------------------------------------------------------------------ *
 * what a page draws
 * ------------------------------------------------------------------ */

/** What a font was seen to draw: glyphs by Unicode value and their advances in em. */
interface Drawn {
  readonly unicode: Map<number, number>;
  readonly advance: Map<number, number>;
  readonly bold: boolean;
  readonly italic: boolean;
}

/** The faces (MuPDF font names) the visible text of the page uses, with the glyphs they draw. */
function drawnOnPage(mupdf: Mupdf, page: PDFPage): Map<string, Drawn> {
  const drawn = new Map<string, Drawn>();
  const remember = (font: Font, gid: number, unicode: number): void => {
    const name = font.getName();
    let face = drawn.get(name);
    if (face === undefined) {
      face = {
        unicode: new Map(),
        advance: new Map(),
        bold: font.isBold() || /bold|black|heavy|semibold|demi/i.test(name),
        italic: font.isItalic() || /italic|oblique/i.test(name),
      };
      drawn.set(name, face);
    }
    if (!face.unicode.has(unicode)) face.unicode.set(unicode, gid);
    if (!face.advance.has(gid)) face.advance.set(gid, font.advanceGlyph(gid));
  };
  const record = (text: Text): void => {
    // A ligature glyph comes as its first character with the glyph, then each further character
    // with gid -1 (measured on mupdf@1.28.1). It is no glyph for that first character alone (an
    // "fi" would draw in every "f"), so a glyph is held until the next one shows it stands alone.
    let held: { font: Font; gid: number; unicode: number } | undefined;
    const settle = (): void => {
      if (held !== undefined) remember(held.font, held.gid, held.unicode);
      held = undefined;
    };
    text.walk({
      showGlyph(font, _trm, gid, unicode) {
        if (gid < 0) {
          held = undefined;
          return;
        }
        settle();
        if (gid === 0 || unicode < 32 || unicode === 0xfffd) return;
        held = { font, gid, unicode };
      },
    });
    settle();
  };
  const device = new mupdf.Device({
    fillText: (text) => record(text),
    strokeText: (text) => record(text),
  });
  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    device.destroy();
  }
  return drawn;
}

/* ------------------------------------------------------------------ *
 * collecting, naming, building
 * ------------------------------------------------------------------ */

/** One font program over the whole document. */
interface Program {
  readonly source: Source;
  readonly baseName: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly unicode: Map<number, number>;
  readonly advance: Map<number, number>;
}

/** The face a run is set in when its font is embedded. */
export interface EmbeddedFace {
  /** The family name the document's `w:rFonts` carries. */
  readonly family: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** The advance, in em, the embedded program gives the character (`undefined` when it has no glyph for it). */
  advance(unicode: number): number | undefined;
}

/* ------------------------------------------------------------------ *
 * the base-14 stand-ins
 * ------------------------------------------------------------------ */

/** The MuPDF names of the metric-compatible base-14 fonts behind Arial, Times New Roman and Courier New. */
const STANDARD: Readonly<Record<string, readonly [string, string, string, string]>> = {
  Arial: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  'Times New Roman': ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  'Courier New': ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

let standardEngine: Mupdf | null = null;
const standardFonts = new Map<string, Font>();

/** Makes `standardAdvance` available: the MuPDF the base-14 metrics are read from (`embedFonts` provides it). */
export function provideStandardMetrics(mupdf: Mupdf): void {
  if (standardEngine !== mupdf) standardFonts.clear();
  standardEngine = mupdf;
}

/**
 * The advance in em of a Unicode value in the stand-in Word falls back to for `family`
 * (Arial, Times New Roman, Courier New: MuPDF's metric-compatible base-14 fonts), or
 * `undefined` for any other family, or before `provideStandardMetrics`.
 */
export function standardAdvance(
  family: string,
  bold: boolean,
  italic: boolean,
  unicode: number,
): number | undefined {
  const names = STANDARD[family];
  if (names === undefined || standardEngine === null) return undefined;
  const name = names[(bold ? 1 : 0) + (italic ? 2 : 0)] as string;
  let font = standardFonts.get(name);
  if (font === undefined) {
    font = new standardEngine.Font(name);
    standardFonts.set(name, font);
  }
  return font.advanceGlyph(font.encodeCharacter(unicode), 0);
}

type Style = FontNames['style'];

const styleOf = (bold: boolean, italic: boolean): Style =>
  bold ? (italic ? 'Bold Italic' : 'Bold') : italic ? 'Italic' : 'Regular';

const EMBED_ELEMENT: Readonly<Record<Style, string>> = {
  Regular: 'embedRegular',
  Bold: 'embedBold',
  Italic: 'embedItalic',
  'Bold Italic': 'embedBoldItalic',
};

const REL_FONT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font';
const REL_FONT_TABLE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable';
const REL_SETTINGS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';
const WORD_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** The fonts of a document, embedded: the lookup the text writer needs and the package parts. */
export interface EmbeddedFonts {
  /** Fonts embedded (font programs, one per family and style). */
  readonly count: number;
  /** The embedded face for a MuPDF font name (`LayoutChar.face`) on page `pageIndex`, or `undefined`. */
  faceOf(pageIndex: number, face: string): EmbeddedFace | undefined;
  /** The `word/…` parts to add to the package (empty when nothing is embedded). */
  readonly files: Readonly<Record<string, string | Uint8Array>>;
  /** `[Content_Types].xml` / `word/_rels/document.xml.rels` with the font parts added. */
  contentTypes(base: string): string;
  documentRels(base: string): string;
}

/** Nothing embedded. */
const NONE: EmbeddedFonts = {
  count: 0,
  faceOf: () => undefined,
  files: {},
  contentTypes: (base) => base,
  documentRels: (base) => base,
};

/**
 * Reads the fonts the pages draw and embeds them. A page that cannot be read, a font that
 * cannot be found or rebuilt: that font keeps the fallback, the export goes on.
 */
export async function embedFonts(
  mupdf: Mupdf,
  doc: PDFDocument,
  pages: readonly number[],
  context: OperationContext,
): Promise<EmbeddedFonts> {
  provideStandardMetrics(mupdf);
  const programs = new Map<number, Program>();
  /** Per page: MuPDF font name → program key. */
  const used = new Map<number, Map<string, number>>();
  for (const index of pages) {
    throwIfAborted(context.signal);
    const page = doc.loadPage(index);
    try {
      const sources = pageSources(page);
      if (sources.size === 0) continue;
      const faces = new Map<string, number>();
      for (const [name, face] of drawnOnPage(mupdf, page)) {
        const source = sources.get(name) ?? sources.get(untagged(name));
        if (source === undefined) continue;
        let program = programs.get(source.key);
        if (program === undefined) {
          program = {
            source,
            baseName: untagged(name),
            bold: face.bold,
            italic: face.italic,
            unicode: new Map(),
            advance: new Map(),
          };
          programs.set(source.key, program);
        }
        for (const [unicode, gid] of face.unicode)
          if (!program.unicode.has(unicode)) program.unicode.set(unicode, gid);
        for (const [gid, advance] of face.advance) program.advance.set(gid, advance);
        faces.set(name, source.key);
      }
      if (faces.size > 0) used.set(index, faces);
    } catch {
      // A page MuPDF cannot run draws no embedded fonts; its text keeps the fallback.
    } finally {
      page.destroy();
    }
    // Give the event loop a turn so the progress bar and Cancel stay live.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (programs.size === 0) return NONE;

  // Names: the first program of a family and style keeps the family, later ones are "Family 2", "Family 3", …
  const taken = new Set<string>();
  const built = new Map<number, { family: string; style: Style; bytes: Uint8Array }>();
  for (const [key, program] of programs) {
    const style = styleOf(program.bold, program.italic);
    const base = fontFamily(program.baseName);
    let family = base;
    for (let n = 2; taken.has(`${family}|${style}`); n += 1) family = `${base} ${n}`;
    const bytes = buildProgram(program, { family, style });
    if (bytes === null) continue;
    taken.add(`${family}|${style}`);
    built.set(key, { family, style, bytes });
  }
  if (built.size === 0) return NONE;

  const byFamily = new Map<string, Map<Style, { rid: string; key: string }>>();
  const files: Record<string, string | Uint8Array> = {};
  const rels: string[] = [];
  let number = 0;
  for (const entry of built.values()) {
    number += 1;
    const rid = `rIdFont${number}`;
    const guid = guidOf(entry.bytes, number);
    files[`word/fonts/font${number}.odttf`] = obfuscateFont(entry.bytes, guid);
    rels.push(`<Relationship Id="${rid}" Type="${REL_FONT}" Target="fonts/font${number}.odttf"/>`);
    const styles = byFamily.get(entry.family) ?? new Map<Style, { rid: string; key: string }>();
    styles.set(entry.style, { rid, key: guid });
    byFamily.set(entry.family, styles);
  }
  const order: Style[] = ['Regular', 'Bold', 'Italic', 'Bold Italic'];
  files['word/fontTable.xml'] =
    `${XML_HEAD}<w:fonts ${WORD_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    [...byFamily]
      .map(
        ([family, styles]) =>
          `<w:font w:name="${xml(family)}">` +
          order
            .flatMap((style) => {
              const embed = styles.get(style);
              return embed === undefined
                ? []
                : [`<w:${EMBED_ELEMENT[style]} r:id="${embed.rid}" w:fontKey="${embed.key}"/>`];
            })
            .join('') +
          '</w:font>',
      )
      .join('') +
    '</w:fonts>';
  files['word/_rels/fontTable.xml.rels'] =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
  files['word/settings.xml'] =
    `${XML_HEAD}<w:settings ${WORD_NS}><w:embedTrueTypeFonts/><w:saveSubsetFonts/></w:settings>`;

  return {
    count: built.size,
    faceOf(pageIndex, face) {
      const key = used.get(pageIndex)?.get(face);
      const entry = key === undefined ? undefined : built.get(key);
      if (entry === undefined) return undefined;
      const program = programs.get(key as number) as Program;
      return {
        family: entry.family,
        bold: entry.style.startsWith('Bold'),
        italic: entry.style.endsWith('Italic'),
        advance(unicode) {
          const gid = program.unicode.get(unicode);
          return gid === undefined ? undefined : program.advance.get(gid);
        },
      };
    },
    files,
    contentTypes: (base) =>
      base
        .replace(
          '<Default Extension="xml"',
          '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/><Default Extension="xml"',
        )
        .replace(
          '</Types>',
          '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
            '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
        ),
    documentRels: (base) =>
      base.replace(
        '</Relationships>',
        `<Relationship Id="rIdFontTable" Type="${REL_FONT_TABLE}" Target="fontTable.xml"/>` +
          `<Relationship Id="rIdSettings" Type="${REL_SETTINGS}" Target="settings.xml"/></Relationships>`,
      ),
  };
}

/** The Word-ready font for a program, or `null` when it cannot or may not be embedded. */
function buildProgram(program: Program, names: FontNames): Uint8Array | null {
  let data: Uint8Array;
  try {
    data = new Uint8Array(program.source.file.readStream().asUint8Array());
  } catch {
    return null;
  }
  const map = (convert: (gid: number) => number | undefined): GlyphMapping[] => {
    const out: GlyphMapping[] = [];
    for (const [unicode, gid] of program.unicode) {
      const mapped = convert(gid);
      if (mapped !== undefined) out.push({ unicode, gid: mapped });
    }
    return out;
  };
  const descriptor = program.source.descriptor;
  const numberOf = (key: string, fallback: number): number => {
    const value = descriptor.get(key);
    return value.isNumber() ? value.asNumber() : fallback;
  };
  try {
    const tables = sfntTables(data);
    if (tables !== null) {
      if (embeddingRestricted(tables, data)) return null;
      if (tables.has('glyf'))
        return trueTypeForWord(
          data,
          map((gid) => gid),
          names,
        );
      const cff = tables.get('CFF ');
      const head = tables.get('head');
      if (cff === undefined || head === undefined) return null;
      const unitsPerEm = u16(data, head.offset + 18) || 1000;
      return cffForWord(
        data.subarray(cff.offset, cff.offset + cff.length),
        map((gid) => gid),
        scaled(program.advance, unitsPerEm),
        names,
        {
          ascent: (numberOf('Ascent', 800) * unitsPerEm) / 1000,
          descent: (numberOf('Descent', -200) * unitsPerEm) / 1000,
        },
      );
    }
    if (data[0] !== 1 || (data[1] ?? 0) !== 0) return null;
    // A bare CFF: MuPDF names the glyphs of a CID-keyed one by CID, the builder by index.
    const cids = cffCidToGid(data);
    const mapping = map((gid) => (cids === null ? gid : cids.get(gid)));
    const advances = new Map<number, number>();
    for (const [gid, advance] of scaled(program.advance, 1000))
      advances.set(cids === null ? gid : (cids.get(gid) ?? -1), advance);
    return cffForWord(data, mapping, advances, names, {
      ascent: numberOf('Ascent', 800),
      descent: numberOf('Descent', -200),
    });
  } catch {
    return null;
  }
}

/** Advances in em → font units. */
function scaled(advance: ReadonlyMap<number, number>, unitsPerEm: number): Map<number, number> {
  return new Map([...advance].map(([gid, em]) => [gid, Math.round(em * unitsPerEm)]));
}
