/**
 * Font files fit for a DOCX. A font program inside a PDF is a subset made for that PDF: the
 * glyphs are addressed by glyph id, and the file carries no usable Unicode `cmap` (often no
 * `cmap`, `name`, `OS/2` or `post` at all). Word and LibreOffice choose glyphs by Unicode and
 * pick a font by its `name` table, so a program lifted out of a PDF has to be given both before
 * it can be embedded in a `.docx`. Two builders do that, over plain bytes:
 *
 *  - `trueTypeForWord` takes a PDF `FontFile2` program and replaces its `cmap` and `name`;
 *  - `cffForWord` takes a bare CFF program (`FontFile3`) and wraps it as an OpenType-CFF font.
 *
 * Neither reads the PDF: the caller supplies the Unicode → glyph id pairs.
 */

/** One Unicode code point and the glyph the font draws for it. */
export interface GlyphMapping {
  readonly unicode: number;
  readonly gid: number;
}

/** The names the font is embedded under (`family` is what a `w:rFonts` run names). */
export interface FontNames {
  readonly family: string;
  readonly style: 'Regular' | 'Bold' | 'Italic' | 'Bold Italic';
}

const SFNT_TRUETYPE = 0x00010000;
const SFNT_TRUE = 0x74727565; // 'true'
const SFNT_OTTO = 0x4f54544f; // 'OTTO'
const HEAD_MAGIC = 0x5f0f3cf5;
const CHECKSUM_MAGIC = 0xb1b0afba;
/** `OS/2` fsType bits 1–3 hold the embedding permission; 2 alone is "restricted license". */
const FS_TYPE_RESTRICTED = 0x0002;
const FS_TYPE_PERMISSION_MASK = 0x000f;
/** fsType bit 9: only bitmaps of the font may be embedded, not its outlines. */
const FS_TYPE_BITMAP_ONLY = 0x0200;

/** Whether an `OS/2` fsType forbids embedding the font's outlines (restricted license, or bitmaps only). */
export function fsTypeForbidsEmbedding(fsType: number): boolean {
  return (fsType & FS_TYPE_PERMISSION_MASK) === FS_TYPE_RESTRICTED || (fsType & FS_TYPE_BITMAP_ONLY) !== 0;
}

const FS_SELECTION_ITALIC = 0x0001;
const FS_SELECTION_BOLD = 0x0020;
const FS_SELECTION_REGULAR = 0x0040;
const FS_SELECTION_USE_TYPO_METRICS = 0x0080;

const MAC_STYLE_BOLD = 0x0001;
const MAC_STYLE_ITALIC = 0x0002;

const OS2_SIZE = 96;

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------------------------
// bytes

function tag(text: string): number {
  return (
    ((text.charCodeAt(0) << 24) |
      (text.charCodeAt(1) << 16) |
      (text.charCodeAt(2) << 8) |
      text.charCodeAt(3)) >>>
    0
  );
}

function tagText(value: number): string {
  return String.fromCharCode(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function int16(value: number): number {
  return clamp(Math.round(value), -32768, 32767);
}

function uint16(value: number): number {
  return clamp(Math.round(value), 0, 65535);
}

/** The 32-bit checksum of a table (zero-padded to a multiple of four bytes). */
function checksum(data: Uint8Array): number {
  let sum = 0;
  const whole = data.length - (data.length % 4);
  for (let at = 0; at < whole; at += 4) {
    const word =
      ((data[at] ?? 0) << 24) |
      ((data[at + 1] ?? 0) << 16) |
      ((data[at + 2] ?? 0) << 8) |
      (data[at + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  let tail = 0;
  for (let at = whole; at < data.length; at += 1) tail |= (data[at] ?? 0) << (24 - 8 * (at - whole));
  return (sum + (tail >>> 0)) >>> 0;
}

/**
 * Lay tables out as an sfnt file: directory sorted by tag, every table 4-byte aligned,
 * checksums computed, and `head.checkSumAdjustment` set for the whole file.
 */
function assemble(sfntVersion: number, tables: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const count = tags.length;
  const directorySize = 12 + 16 * count;
  const offsets: number[] = [];
  let total = directorySize;
  for (const name of tags) {
    offsets.push(total);
    total += ((tables.get(name)?.length ?? 0) + 3) & ~3;
  }
  const out = new Uint8Array(total);
  const dv = view(out);
  const entrySelector = Math.floor(Math.log2(count));
  const searchRange = 16 * 2 ** entrySelector;
  dv.setUint32(0, sfntVersion);
  dv.setUint16(4, count);
  dv.setUint16(6, searchRange);
  dv.setUint16(8, entrySelector);
  dv.setUint16(10, 16 * count - searchRange);
  let headAt = -1;
  tags.forEach((name, index) => {
    const data = tables.get(name) ?? new Uint8Array(0);
    const offset = offsets[index] ?? 0;
    out.set(data, offset);
    if (name === 'head') {
      headAt = offset;
      dv.setUint32(offset + 8, 0); // checkSumAdjustment is zero while the table is summed
    }
    const record = 12 + 16 * index;
    dv.setUint32(record, tag(name));
    dv.setUint32(record + 4, checksum(out.subarray(offset, offset + data.length)));
    dv.setUint32(record + 8, offset);
    dv.setUint32(record + 12, data.length);
  });
  if (headAt >= 0) dv.setUint32(headAt + 8, (CHECKSUM_MAGIC - checksum(out)) >>> 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// cmap

/** The usable pairs, by Unicode: the last pair for a code point wins, gid 0 and out-of-range gids go. */
function cleanMap(map: readonly GlyphMapping[], numGlyphs: number): [number, number][] {
  const byUnicode = new Map<number, number>();
  for (const { unicode, gid } of map) {
    if (!Number.isInteger(unicode) || !Number.isInteger(gid)) continue;
    if (unicode < 0 || unicode > 0x10ffff || (unicode >= 0xd800 && unicode <= 0xdfff) || unicode === 0xffff)
      continue;
    if (gid < 1 || gid >= numGlyphs) continue;
    byUnicode.set(unicode, gid);
  }
  return [...byUnicode].sort((a, b) => a[0] - b[0]);
}

interface Segment {
  readonly start: number;
  readonly end: number;
  readonly delta: number;
  readonly ids: readonly number[] | null;
}

/** A format 4 subtable for the BMP pairs, or null when it does not fit its 16-bit length. */
function cmapFormat4(pairs: readonly [number, number][]): Uint8Array | null {
  const segments: Segment[] = [];
  const bmp = pairs.filter(([unicode]) => unicode <= 0xffff);
  let at = 0;
  while (at < bmp.length) {
    let last = at;
    while (last + 1 < bmp.length && (bmp[last + 1]?.[0] ?? 0) === (bmp[last]?.[0] ?? 0) + 1) last += 1;
    const [start, firstGid] = bmp[at] ?? [0, 0];
    const run = bmp.slice(at, last + 1);
    const contiguous = run.every(([, gid], index) => gid === firstGid + index);
    segments.push({
      start,
      end: start + run.length - 1,
      delta: (firstGid - start) & 0xffff,
      ids: contiguous ? null : run.map(([, gid]) => gid),
    });
    at = last + 1;
  }
  segments.push({ start: 0xffff, end: 0xffff, delta: 1, ids: null });

  const segCount = segments.length;
  const glyphIds = segments.reduce((sum, segment) => sum + (segment.ids?.length ?? 0), 0);
  const length = 16 + 8 * segCount + 2 * glyphIds;
  if (length > 0xffff) return null;
  const out = new Uint8Array(length);
  const dv = view(out);
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * 2 ** entrySelector;
  dv.setUint16(0, 4);
  dv.setUint16(2, length);
  dv.setUint16(4, 0);
  dv.setUint16(6, 2 * segCount);
  dv.setUint16(8, searchRange);
  dv.setUint16(10, entrySelector);
  dv.setUint16(12, 2 * segCount - searchRange);
  const endAt = 14;
  const startAt = endAt + 2 * segCount + 2;
  const deltaAt = startAt + 2 * segCount;
  const rangeAt = deltaAt + 2 * segCount;
  const arrayAt = rangeAt + 2 * segCount;
  let used = 0;
  segments.forEach((segment, index) => {
    dv.setUint16(endAt + 2 * index, segment.end);
    dv.setUint16(startAt + 2 * index, segment.start);
    if (segment.ids === null) {
      dv.setUint16(deltaAt + 2 * index, segment.delta);
      return;
    }
    dv.setUint16(rangeAt + 2 * index, 2 * (segCount - index + used));
    for (const gid of segment.ids) {
      dv.setUint16(arrayAt + 2 * used, gid);
      used += 1;
    }
  });
  return out;
}

/** A format 12 subtable for all pairs. */
function cmapFormat12(pairs: readonly [number, number][]): Uint8Array {
  const groups: [number, number, number][] = [];
  for (const [unicode, gid] of pairs) {
    const group = groups[groups.length - 1];
    if (group !== undefined && unicode === group[1] + 1 && gid === group[2] + (unicode - group[0])) {
      group[1] = unicode;
    } else {
      groups.push([unicode, unicode, gid]);
    }
  }
  const out = new Uint8Array(16 + 12 * groups.length);
  const dv = view(out);
  dv.setUint16(0, 12);
  dv.setUint32(4, out.length);
  dv.setUint32(12, groups.length);
  groups.forEach(([start, end, gid], index) => {
    dv.setUint32(16 + 12 * index, start);
    dv.setUint32(20 + 12 * index, end);
    dv.setUint32(24 + 12 * index, gid);
  });
  return out;
}

/** The `cmap` table: (0,3) and (3,1) share the format 4 subtable; (3,10) is format 12 when needed. */
function buildCmap(pairs: readonly [number, number][]): Uint8Array | null {
  const format4 = cmapFormat4(pairs);
  if (format4 === null) return null;
  const format12 = pairs.some(([unicode]) => unicode > 0xffff) ? cmapFormat12(pairs) : null;
  const records = format12 === null ? 2 : 3;
  const header = 4 + 8 * records;
  const out = new Uint8Array(header + format4.length + (format12?.length ?? 0));
  const dv = view(out);
  dv.setUint16(2, records);
  const records4: [number, number][] = [
    [0, 3],
    [3, 1],
  ];
  records4.forEach(([platform, encoding], index) => {
    dv.setUint16(4 + 8 * index, platform);
    dv.setUint16(6 + 8 * index, encoding);
    dv.setUint32(8 + 8 * index, header);
  });
  out.set(format4, header);
  if (format12 !== null) {
    dv.setUint16(20, 3);
    dv.setUint16(22, 10);
    dv.setUint32(24, header + format4.length);
    out.set(format12, header + format4.length);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// name, OS/2, post

function utf16be(text: string): Uint8Array {
  const out = new Uint8Array(text.length * 2);
  const dv = view(out);
  for (let at = 0; at < text.length; at += 1) dv.setUint16(2 * at, text.charCodeAt(at));
  return out;
}

/** MacRoman for the ASCII range; anything else becomes `?`. */
function macRomanAscii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    out[at] = code < 0x80 ? code : 0x3f;
  }
  return out;
}

/** A `name` record kept from a font's own table: where it applies and its raw string. */
interface NameRecord {
  readonly platform: number;
  readonly encoding: number;
  readonly language: number;
  readonly id: number;
  readonly data: Uint8Array;
}

/** The IDs of the notices a font carries about its authors and its licence: copyright, trademark, licence text, licence URL. */
const NOTICE_IDS: readonly number[] = [0, 7, 13, 14];

/** The notice records (IDs 0, 7, 13, 14) of a format 0 `name` table; a record cut off by the table's end is left out. */
function noticesOf(name: Uint8Array | undefined): NameRecord[] {
  if (name === undefined || name.length < 6) return [];
  const dv = view(name);
  const storage = dv.getUint16(4);
  const records: NameRecord[] = [];
  for (let index = 0; index < dv.getUint16(2); index += 1) {
    const at = 6 + 12 * index;
    if (at + 12 > name.length) break;
    const id = dv.getUint16(at + 6);
    const start = storage + dv.getUint16(at + 10);
    const end = start + dv.getUint16(at + 8);
    if (!NOTICE_IDS.includes(id) || end > name.length) continue;
    records.push({
      platform: dv.getUint16(at),
      encoding: dv.getUint16(at + 2),
      language: dv.getUint16(at + 4),
      id,
      data: name.slice(start, end),
    });
  }
  return records;
}

/**
 * The `name` table: IDs 1, 2, 3, 4, 5, 6, 16, 17 as Mac (1,0,0) and Windows (3,1,0x409) records,
 * and `notices` (the font's own copyright and licence records) after them, in the table's sort order.
 * LibreOffice 26.2 silently drops an embedded font whose `name` has no ID 3 (unique identifier):
 * measured by swapping this table into a font it accepts.
 */
function buildName(names: FontNames, notices: readonly NameRecord[] = []): Uint8Array {
  const compact = (text: string) => text.replace(/[^A-Za-z0-9]/g, '');
  const postScript = `${compact(names.family)}-${compact(names.style)}`.slice(0, 63);
  const full = names.style === 'Regular' ? names.family : `${names.family} ${names.style}`;
  const strings: [number, string][] = [
    [1, names.family],
    [2, names.style],
    [3, `${postScript};1.0`],
    [4, full],
    [5, 'Version 1.000'],
    [6, postScript],
    [16, names.family],
    [17, names.style],
  ];
  const entries: NameRecord[] = [];
  for (const [id, text] of strings)
    entries.push({ platform: 1, encoding: 0, language: 0, id, data: macRomanAscii(text) });
  for (const [id, text] of strings)
    entries.push({ platform: 3, encoding: 1, language: 0x409, id, data: utf16be(text) });
  entries.push(...notices);
  entries.sort(
    (a, b) => a.platform - b.platform || a.encoding - b.encoding || a.language - b.language || a.id - b.id,
  );
  const header = 6 + 12 * entries.length;
  const out = new Uint8Array(header + entries.reduce((sum, entry) => sum + entry.data.length, 0));
  const dv = view(out);
  dv.setUint16(2, entries.length);
  dv.setUint16(4, header);
  let storage = 0;
  entries.forEach((entry, index) => {
    const at = 6 + 12 * index;
    dv.setUint16(at, entry.platform);
    dv.setUint16(at + 2, entry.encoding);
    dv.setUint16(at + 4, entry.language);
    dv.setUint16(at + 6, entry.id);
    dv.setUint16(at + 8, entry.data.length);
    dv.setUint16(at + 10, storage);
    out.set(entry.data, header + storage);
    storage += entry.data.length;
  });
  return out;
}

/** A `post` table, version 3: no glyph names. */
function buildPost(): Uint8Array {
  const out = new Uint8Array(32);
  view(out).setUint32(0, 0x00030000);
  view(out).setInt16(8, -100); // underlinePosition
  view(out).setInt16(10, 50); // underlineThickness
  return out;
}

/** The Unicode-range bits (OS/2 `ulUnicodeRange1`) the repertoire touches. */
const UNICODE_RANGE_BITS: readonly (readonly [number, number, number])[] = [
  [0, 0x20, 0x7e], // Basic Latin
  [1, 0x80, 0xff], // Latin-1 Supplement
  [2, 0x100, 0x17f], // Latin Extended-A
  [3, 0x180, 0x24f], // Latin Extended-B
  [7, 0x370, 0x3ff], // Greek and Coptic
  [9, 0x400, 0x4ff], // Cyrillic
];

interface Os2Spec {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly typoAscender: number;
  readonly typoDescender: number;
  readonly winAscent: number;
  readonly winDescent: number;
  readonly averageWidth: number;
  /** The embedding permission bits, as the font the program comes from has them. */
  readonly fsType: number;
}

function styleFlags(names: FontNames): { bold: boolean; italic: boolean } {
  return {
    bold: names.style === 'Bold' || names.style === 'Bold Italic',
    italic: names.style === 'Italic' || names.style === 'Bold Italic',
  };
}

function fsSelectionOf(bold: boolean, italic: boolean): number {
  const style = (italic ? FS_SELECTION_ITALIC : 0) | (bold ? FS_SELECTION_BOLD : 0);
  return (style === 0 ? FS_SELECTION_REGULAR : style) | FS_SELECTION_USE_TYPO_METRICS;
}

/** A minimal `OS/2` table, version 4. */
function buildOs2(spec: Os2Spec, pairs: readonly [number, number][]): Uint8Array {
  const out = new Uint8Array(OS2_SIZE);
  const dv = view(out);
  let ranges = 0;
  for (const [bit, low, high] of UNICODE_RANGE_BITS) {
    if (pairs.some(([unicode]) => unicode >= low && unicode <= high)) ranges |= 1 << bit;
  }
  const hasLatin = pairs.some(([unicode]) => unicode === 0x41);
  dv.setUint16(0, 4);
  dv.setInt16(2, int16(spec.averageWidth));
  dv.setUint16(4, spec.bold ? 700 : 400);
  dv.setUint16(6, 5); // medium width
  dv.setUint16(8, spec.fsType);
  dv.setInt16(10, 650); // ySubscriptXSize
  dv.setInt16(12, 600);
  dv.setInt16(16, 140);
  dv.setInt16(18, 650);
  dv.setInt16(20, 600);
  dv.setInt16(24, 480);
  dv.setInt16(26, 50); // yStrikeoutSize
  dv.setInt16(28, 300); // yStrikeoutPosition
  dv.setUint32(42, ranges >>> 0);
  out.set(textEncoder.encode('NONE'), 58);
  dv.setUint16(62, fsSelectionOf(spec.bold, spec.italic));
  dv.setUint16(64, pairs.length === 0 ? 0 : Math.min(pairs[0]?.[0] ?? 0, 0xffff));
  dv.setUint16(66, pairs.length === 0 ? 0 : Math.min(pairs[pairs.length - 1]?.[0] ?? 0, 0xffff));
  dv.setInt16(68, int16(spec.typoAscender));
  dv.setInt16(70, int16(spec.typoDescender));
  dv.setUint16(74, uint16(spec.winAscent));
  dv.setUint16(76, uint16(spec.winDescent));
  dv.setUint32(78, hasLatin ? 1 : 0); // ulCodePageRange1: Latin 1
  dv.setUint16(92, 32); // usBreakChar
  return out;
}

// ---------------------------------------------------------------------------------------------
// TrueType

interface Sfnt {
  readonly version: number;
  readonly tables: Map<string, Uint8Array>;
}

/** The table directory of an sfnt file, or null when it is not one or a table runs off the end. */
function parseSfnt(bytes: Uint8Array): Sfnt | null {
  if (bytes.length < 12) return null;
  const dv = view(bytes);
  const version = dv.getUint32(0);
  if (version !== SFNT_TRUETYPE && version !== SFNT_TRUE && version !== SFNT_OTTO) return null;
  const count = dv.getUint16(4);
  if (12 + 16 * count > bytes.length) return null;
  const tables = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    const record = 12 + 16 * index;
    const offset = dv.getUint32(record + 8);
    const length = dv.getUint32(record + 12);
    if (offset + length > bytes.length) return null;
    const name = tagText(dv.getUint32(record));
    if (!tables.has(name)) tables.set(name, bytes.slice(offset, offset + length));
  }
  return { version, tables };
}

/**
 * A TrueType program (PDF FontFile2) with a new Unicode `cmap` built from `map` and its `name`
 * table rewritten to `names`; every other table is kept. A missing `OS/2`, `post`, `name` or
 * `cmap` is added. Null when the font forbids embedding (`OS/2` fsType "restricted license"),
 * is not a TrueType font with `head`, `maxp`, `glyf` and `loca`, or has a map too sparse for a
 * format 4 subtable. `keepNotices` carries the font's own copyright, trademark and licence records
 * (`name` IDs 0, 7, 13, 14) into the new table: for a font that is whole and open-licensed.
 */
export function trueTypeForWord(
  ttf: Uint8Array,
  map: readonly GlyphMapping[],
  names: FontNames,
  options: { readonly keepNotices?: boolean } = {},
): Uint8Array | null {
  const sfnt = parseSfnt(ttf);
  if (sfnt === null || sfnt.version === SFNT_OTTO) return null;
  const { tables } = sfnt;
  const head = tables.get('head');
  const maxp = tables.get('maxp');
  if (head === undefined || head.length < 54 || maxp === undefined || maxp.length < 6) return null;
  if (!tables.has('glyf') || !tables.has('loca')) return null;
  const os2 = tables.get('OS/2');
  if (os2 !== undefined && os2.length >= 10) {
    const fsType = view(os2).getUint16(8);
    if (fsTypeForbidsEmbedding(fsType)) return null;
  }

  const pairs = cleanMap(map, view(maxp).getUint16(4));
  const cmap = buildCmap(pairs);
  if (cmap === null) return null;
  const { bold, italic } = styleFlags(names);

  const headDv = view(head);
  const hhea = tables.get('hhea');
  const ascender = hhea !== undefined && hhea.length >= 8 ? view(hhea).getInt16(4) : headDv.getInt16(42);
  const descender = hhea !== undefined && hhea.length >= 8 ? view(hhea).getInt16(6) : headDv.getInt16(38);
  headDv.setUint16(
    44,
    (headDv.getUint16(44) & ~(MAC_STYLE_BOLD | MAC_STYLE_ITALIC)) |
      (bold ? MAC_STYLE_BOLD : 0) |
      (italic ? MAC_STYLE_ITALIC : 0),
  );

  if (os2 !== undefined && os2.length >= 64) {
    // keep the table, but make its style bits agree with the names
    const os2Dv = view(os2);
    const weight = os2Dv.getUint16(4);
    os2Dv.setUint16(4, bold ? Math.max(weight, 700) : Math.min(weight, 599));
    const kept = os2Dv.getUint16(62) & ~(FS_SELECTION_ITALIC | FS_SELECTION_BOLD | FS_SELECTION_REGULAR);
    os2Dv.setUint16(
      62,
      kept | (fsSelectionOf(bold, italic) & (FS_SELECTION_ITALIC | FS_SELECTION_BOLD | FS_SELECTION_REGULAR)),
    );
  } else {
    tables.set(
      'OS/2',
      buildOs2(
        {
          bold,
          italic,
          typoAscender: ascender,
          typoDescender: descender,
          winAscent: Math.max(0, ascender),
          winDescent: Math.abs(descender),
          averageWidth: 0,
          fsType: 0,
        },
        pairs,
      ),
    );
  }
  if (!tables.has('post')) tables.set('post', buildPost());
  tables.set('cmap', cmap);
  tables.set('name', buildName(names, options.keepNotices === true ? noticesOf(tables.get('name')) : []));
  return assemble(SFNT_TRUETYPE, tables);
}

// ---------------------------------------------------------------------------------------------
// CFF

/** The slice of a CFF INDEX this module needs: where each object sits, and where the INDEX ends. */
interface CffIndex {
  readonly count: number;
  /** `count + 1` absolute offsets: object `i` is `[offsets[i], offsets[i + 1])`. */
  readonly offsets: readonly number[];
  readonly end: number;
}

function readIndex(bytes: Uint8Array, at: number): CffIndex | null {
  if (at + 2 > bytes.length) return null;
  const dv = view(bytes);
  const count = dv.getUint16(at);
  if (count === 0) return { count: 0, offsets: [], end: at + 2 };
  const offSize = bytes[at + 2] ?? 0;
  if (offSize < 1 || offSize > 4) return null;
  const table = at + 3;
  const base = table + (count + 1) * offSize - 1;
  if (base >= bytes.length) return null;
  const offsets: number[] = [];
  let previous = 1;
  for (let index = 0; index <= count; index += 1) {
    let value = 0;
    for (let byte = 0; byte < offSize; byte += 1)
      value = value * 256 + (bytes[table + index * offSize + byte] ?? 0);
    if (value < previous || base + value > bytes.length) return null;
    previous = value;
    offsets.push(base + value);
  }
  return { count, offsets, end: offsets[count] ?? base };
}

/** A DICT as operator → operands; two-byte operators (12 n) are keyed `1200 + n`. Null when malformed. */
function readDict(bytes: Uint8Array, start: number, end: number): Map<number, number[]> | null {
  const dict = new Map<number, number[]>();
  let operands: number[] = [];
  let at = start;
  while (at < end) {
    const b0 = bytes[at] ?? 0;
    at += 1;
    if (b0 <= 21) {
      let operator = b0;
      if (b0 === 12) {
        operator = 1200 + (bytes[at] ?? 0);
        at += 1;
      }
      dict.set(operator, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(((((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)) << 16) >> 16);
      at += 2;
    } else if (b0 === 29) {
      operands.push(
        ((bytes[at] ?? 0) << 24) |
          ((bytes[at + 1] ?? 0) << 16) |
          ((bytes[at + 2] ?? 0) << 8) |
          (bytes[at + 3] ?? 0),
      );
      at += 4;
    } else if (b0 === 30) {
      let text = '';
      let done = false;
      while (!done && at < end) {
        const byte = bytes[at] ?? 0;
        at += 1;
        for (const nibble of [byte >> 4, byte & 15]) {
          if (done) break;
          if (nibble <= 9) text += String(nibble);
          else if (nibble === 10) text += '.';
          else if (nibble === 11) text += 'E';
          else if (nibble === 12) text += 'E-';
          else if (nibble === 14) text += '-';
          else if (nibble === 15) done = true;
          else return null;
        }
      }
      operands.push(Number.parseFloat(text));
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + (bytes[at] ?? 0) + 108);
      at += 1;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - (bytes[at] ?? 0) - 108);
      at += 1;
    } else {
      return null; // reserved operator or operand byte
    }
  }
  return at === end ? dict : null;
}

interface CffFacts {
  readonly numGlyphs: number;
  readonly unitsPerEm: number;
  readonly bbox: readonly [number, number, number, number];
  readonly defaultWidth: number;
}

function privateDefaultWidth(bytes: Uint8Array, dict: Map<number, number[]>): number {
  const [size, offset] = dict.get(18) ?? [];
  if (size === undefined || offset === undefined || offset < 0 || size < 0 || offset + size > bytes.length)
    return 0;
  return readDict(bytes, offset, offset + size)?.get(20)?.[0] ?? 0;
}

/** What the OpenType wrapper needs from a bare CFF program; null when it cannot be parsed. */
function readCff(bytes: Uint8Array): CffFacts | null {
  if (bytes.length < 4 || bytes[0] !== 1) return null;
  const hdrSize = bytes[2] ?? 0;
  const names = readIndex(bytes, hdrSize);
  if (names === null) return null;
  const tops = readIndex(bytes, names.end);
  if (tops === null || tops.count < 1) return null;
  const top = readDict(bytes, tops.offsets[0] ?? 0, tops.offsets[1] ?? 0);
  if (top === null) return null;

  const charStringsAt = top.get(17)?.[0];
  if (charStringsAt === undefined) return null;
  const charStrings = readIndex(bytes, charStringsAt);
  if (charStrings === null || charStrings.count === 0) return null;

  // a CID-keyed font keeps its FontMatrix and Private DICT in the first Font DICT
  let source = top;
  const fdArrayAt = top.get(1236)?.[0];
  if (top.has(1230) && fdArrayAt !== undefined) {
    const fdArray = readIndex(bytes, fdArrayAt);
    const first = fdArray === null ? null : readDict(bytes, fdArray.offsets[0] ?? 0, fdArray.offsets[1] ?? 0);
    if (first !== null) source = first;
  }
  const matrix = top.get(1207) ?? source.get(1207);
  const scale = matrix?.[0] ?? 0.001;
  const unitsPerEm = scale > 0 ? clamp(Math.round(1 / scale), 16, 16384) : 1000;
  const box = top.get(5) ?? [];
  const bbox: [number, number, number, number] = [box[0] ?? 0, box[1] ?? 0, box[2] ?? 0, box[3] ?? 0];
  return { numGlyphs: charStrings.count, unitsPerEm, bbox, defaultWidth: privateDefaultWidth(bytes, source) };
}

function buildHead(facts: CffFacts, bold: boolean, italic: boolean): Uint8Array {
  const out = new Uint8Array(54);
  const dv = view(out);
  dv.setUint32(0, 0x00010000);
  dv.setUint32(4, 0x00010000); // fontRevision
  dv.setUint32(12, HEAD_MAGIC);
  dv.setUint16(16, 3); // baseline at y = 0, left sidebearing at x = 0
  dv.setUint16(18, facts.unitsPerEm);
  dv.setInt16(36, int16(facts.bbox[0]));
  dv.setInt16(38, int16(facts.bbox[1]));
  dv.setInt16(40, int16(facts.bbox[2]));
  dv.setInt16(42, int16(facts.bbox[3]));
  dv.setUint16(44, (bold ? MAC_STYLE_BOLD : 0) | (italic ? MAC_STYLE_ITALIC : 0));
  dv.setUint16(46, 8); // lowestRecPPEM
  dv.setInt16(48, 2); // fontDirectionHint
  return out;
}

function buildHhea(ascent: number, descent: number, advanceMax: number): Uint8Array {
  const out = new Uint8Array(36);
  const dv = view(out);
  dv.setUint32(0, 0x00010000);
  dv.setInt16(4, int16(ascent));
  dv.setInt16(6, int16(descent));
  dv.setUint16(10, uint16(advanceMax));
  dv.setUint16(16, uint16(advanceMax)); // xMaxExtent
  dv.setInt16(18, 1); // caretSlopeRise
  return out;
}

/**
 * A bare CFF program (PDF FontFile3 `Type1C` / `CIDFontType0C`) as an OpenType-CFF font: the
 * `CFF ` table as given, plus `cmap` (from `map`), `head`, `hhea`, `hmtx` (`advances` by glyph
 * id, glyphs without one get the CFF `defaultWidthX`), `maxp` 0.5, `name`, `OS/2` 4 and
 * `post` 3; `metrics.fsType` is the source font's embedding permission, kept as it is (0 when the
 * program has no `OS/2` of its own to take it from). Null when the CFF cannot be parsed or the map is too sparse for a format 4 subtable.
 */
export function cffForWord(
  cff: Uint8Array,
  map: readonly GlyphMapping[],
  advances: ReadonlyMap<number, number>,
  names: FontNames,
  metrics: { readonly ascent: number; readonly descent: number; readonly fsType?: number },
): Uint8Array | null {
  const facts = readCff(cff);
  if (facts === null) return null;
  const pairs = cleanMap(map, facts.numGlyphs);
  const cmap = buildCmap(pairs);
  if (cmap === null) return null;
  const { bold, italic } = styleFlags(names);

  const hmtx = new Uint8Array(4 * facts.numGlyphs);
  const hmtxDv = view(hmtx);
  let widest = 0;
  for (let gid = 0; gid < facts.numGlyphs; gid += 1) {
    const width = uint16(advances.get(gid) ?? facts.defaultWidth);
    hmtxDv.setUint16(4 * gid, width);
    widest = Math.max(widest, width);
  }
  const mapped = pairs.map(([, gid]) => view(hmtx).getUint16(4 * gid));
  const averageWidth =
    mapped.length === 0 ? 0 : mapped.reduce((sum, width) => sum + width, 0) / mapped.length;

  const maxp = new Uint8Array(6);
  view(maxp).setUint32(0, 0x00005000);
  view(maxp).setUint16(4, facts.numGlyphs);
  const hhea = buildHhea(metrics.ascent, metrics.descent, widest);
  view(hhea).setUint16(34, facts.numGlyphs);

  const tables = new Map<string, Uint8Array>([
    ['CFF ', cff],
    [
      'OS/2',
      buildOs2(
        {
          bold,
          italic,
          typoAscender: metrics.ascent,
          typoDescender: -Math.abs(metrics.descent),
          winAscent: Math.max(0, metrics.ascent),
          winDescent: Math.abs(metrics.descent),
          averageWidth,
          fsType: metrics.fsType ?? 0,
        },
        pairs,
      ),
    ],
    ['cmap', cmap],
    ['head', buildHead(facts, bold, italic)],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['maxp', maxp],
    ['name', buildName(names)],
    ['post', buildPost()],
  ]);
  return assemble(SFNT_OTTO, tables);
}
