/**
 * The DOCX font builders, against real fonts. The wrong answers that matter: a program that
 * Word cannot index by Unicode (a `cmap` that maps the wrong glyph, or none), a family name
 * Word does not find, a table directory or checksum a strict loader rejects, a restricted font
 * embedded anyway, and an OpenType-CFF wrapper whose metrics are wrong. The programs come from
 * Noto Sans: the whole font, and the subset MuPDF writes into a PDF (what a PDF really holds).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as mupdf from 'mupdf';
import { describe, expect, it } from 'vitest';
import { buildCff, encodeOffset, index } from './docx-font-fixtures';
import { cffForWord, type FontNames, type GlyphMapping, trueTypeForWord } from './docx-font-sfnt';

const NOTO = resolve(__dirname, '../../../../public/fonts/noto');
const REGULAR = new Uint8Array(readFileSync(resolve(NOTO, 'NotoSans-Regular.ttf')));
const SEMIBOLD = new Uint8Array(readFileSync(resolve(NOTO, 'NotoSans-SemiBold.ttf')));
const NAMES: FontNames = { family: 'Sample Face', style: 'Regular' };
const TURKISH = 'AĞİşğıÇçÖöÜü';

// ---------------------------------------------------------------------------------------------
// an independent reader of sfnt files

interface Table {
  readonly tag: string;
  readonly checksum: number;
  readonly offset: number;
  readonly length: number;
}

function directory(bytes: Uint8Array): { version: number; tables: Table[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables: Table[] = [];
  for (let index = 0; index < dv.getUint16(4); index += 1) {
    const at = 12 + 16 * index;
    tables.push({
      tag: String.fromCharCode(...bytes.subarray(at, at + 4)),
      checksum: dv.getUint32(at + 4),
      offset: dv.getUint32(at + 8),
      length: dv.getUint32(at + 12),
    });
  }
  return { version: dv.getUint32(0), tables };
}

function table(bytes: Uint8Array, tag: string): Uint8Array {
  const found = directory(bytes).tables.find((entry) => entry.tag === tag);
  if (found === undefined) throw new Error(`no ${tag} table`);
  return bytes.subarray(found.offset, found.offset + found.length);
}

function sum32(bytes: Uint8Array): number {
  let sum = 0;
  for (let at = 0; at < bytes.length; at += 4) {
    let word = 0;
    for (let byte = 0; byte < 4; byte += 1) word = word * 256 + (bytes[at + byte] ?? 0);
    sum = (sum + word) % 2 ** 32;
  }
  return sum;
}

/** The names of one `name` table, by (platform, id). */
function nameRecords(name: Uint8Array): Map<string, string> {
  const dv = new DataView(name.buffer, name.byteOffset, name.byteLength);
  const out = new Map<string, string>();
  const storage = dv.getUint16(4);
  for (let index = 0; index < dv.getUint16(2); index += 1) {
    const at = 6 + 12 * index;
    const raw = name.subarray(
      storage + dv.getUint16(at + 10),
      storage + dv.getUint16(at + 10) + dv.getUint16(at + 8),
    );
    let text = '';
    if (dv.getUint16(at) === 3) {
      for (let char = 0; char < raw.length; char += 2)
        text += String.fromCharCode((raw[char] ?? 0) * 256 + (raw[char + 1] ?? 0));
    } else {
      text = String.fromCharCode(...raw);
    }
    out.set(`${dv.getUint16(at)}/${dv.getUint16(at + 6)}`, text);
  }
  return out;
}

/** Assert the file is a well-formed sfnt: sorted, aligned, checksummed, `head` adjusted. */
function expectValidSfnt(bytes: Uint8Array, version: number): void {
  const { version: found, tables } = directory(bytes);
  expect(found).toBe(version);
  const tags = tables.map((entry) => entry.tag);
  expect(tags).toEqual([...tags].sort());
  expect(bytes.length % 4).toBe(0);
  for (const entry of tables) {
    expect(entry.offset % 4).toBe(0);
    const data = bytes.slice(entry.offset, entry.offset + entry.length);
    if (entry.tag === 'head') new DataView(data.buffer).setUint32(8, 0);
    expect(sum32(data), entry.tag).toBe(entry.checksum);
  }
  expect(sum32(bytes)).toBe(0xb1b0afba);
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  const entrySelector = Math.floor(Math.log2(tables.length));
  expect(dv.getUint16(6)).toBe(16 * 2 ** entrySelector);
  expect(dv.getUint16(8)).toBe(entrySelector);
  expect(dv.getUint16(10)).toBe(16 * tables.length - 16 * 2 ** entrySelector);
}

/** An sfnt file from raw tables (no checksums: only for inputs). */
function buildSfnt(version: number, tables: Record<string, Uint8Array>): Uint8Array {
  const tags = Object.keys(tables).sort();
  let size = 12 + 16 * tags.length;
  for (const tag of tags) size += ((tables[tag]?.length ?? 0) + 3) & ~3;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, version);
  dv.setUint16(4, tags.length);
  let offset = 12 + 16 * tags.length;
  tags.forEach((tag, index) => {
    const data = tables[tag] ?? new Uint8Array(0);
    for (let at = 0; at < 4; at += 1) out[12 + 16 * index + at] = tag.charCodeAt(at);
    dv.setUint32(12 + 16 * index + 8, offset);
    dv.setUint32(12 + 16 * index + 12, data.length);
    out.set(data, offset);
    offset += (data.length + 3) & ~3;
  });
  return out;
}

/** `bytes` without some tables. */
function without(bytes: Uint8Array, ...drop: string[]): Uint8Array {
  const tables: Record<string, Uint8Array> = {};
  for (const entry of directory(bytes).tables) {
    if (!drop.includes(entry.tag)) tables[entry.tag] = bytes.slice(entry.offset, entry.offset + entry.length);
  }
  return buildSfnt(directory(bytes).version, tables);
}

/** `bytes` with one table's bytes edited. */
function patched(bytes: Uint8Array, tag: string, edit: (data: Uint8Array) => void): Uint8Array {
  const copy = bytes.slice();
  const entry = directory(copy).tables.find((candidate) => candidate.tag === tag);
  if (entry === undefined) throw new Error(`no ${tag} table`);
  edit(copy.subarray(entry.offset, entry.offset + entry.length));
  return copy;
}

/** The cmap subtable (platform, encoding) as { format, lookup } read straight from the bytes. */
function cmapLookup(
  font: Uint8Array,
  platform: number,
  encoding: number,
): { format: number; lookup: (code: number) => number } {
  const cmap = table(font, 'cmap');
  const dv = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  let subtable = -1;
  for (let index = 0; index < dv.getUint16(2); index += 1) {
    if (dv.getUint16(4 + 8 * index) === platform && dv.getUint16(6 + 8 * index) === encoding)
      subtable = dv.getUint32(8 + 8 * index);
  }
  if (subtable < 0) throw new Error(`no cmap (${platform},${encoding})`);
  const format = dv.getUint16(subtable);
  if (format === 12) {
    return {
      format,
      lookup: (code) => {
        for (let group = 0; group < dv.getUint32(subtable + 12); group += 1) {
          const at = subtable + 16 + 12 * group;
          if (code >= dv.getUint32(at) && code <= dv.getUint32(at + 4))
            return dv.getUint32(at + 8) + code - dv.getUint32(at);
        }
        return 0;
      },
    };
  }
  const segCount = dv.getUint16(subtable + 6) / 2;
  return {
    format,
    lookup: (code) => {
      for (let seg = 0; seg < segCount; seg += 1) {
        const end = dv.getUint16(subtable + 14 + 2 * seg);
        const start = dv.getUint16(subtable + 16 + 2 * segCount + 2 * seg);
        if (code < start || code > end) continue;
        const delta = dv.getUint16(subtable + 16 + 4 * segCount + 2 * seg);
        const rangeAt = subtable + 16 + 6 * segCount + 2 * seg;
        const range = dv.getUint16(rangeAt);
        if (range === 0) return (code + delta) & 0xffff;
        const gid = dv.getUint16(rangeAt + range + 2 * (code - start));
        return gid === 0 ? 0 : (gid + delta) & 0xffff;
      }
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// TrueType

/** The Noto glyph ids of `text`, and the program MuPDF keeps for it in a PDF (a subset). */
async function pdfSubset(): Promise<{ program: Uint8Array; gids: Map<number, number> }> {
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font('NotoSans', REGULAR);
  const object = doc.addFont(font);
  const gids = new Map<number, number>();
  let hex = '';
  for (const character of TURKISH) {
    const unicode = character.codePointAt(0) as number;
    const gid = font.encodeCharacter(unicode);
    gids.set(unicode, gid);
    hex += gid.toString(16).padStart(4, '0');
  }
  const page = doc.addPage(
    [0, 0, 300, 300],
    0,
    { Font: { F0: object } },
    `BT /F0 20 Tf 10 100 Td <${hex}> Tj ET\n`,
  );
  doc.insertPage(0, page);
  doc.subsetFonts();
  const saved = doc.saveToBuffer('garbage=compact,compress').asUint8Array().slice();
  doc.destroy();
  const reopened = new mupdf.PDFDocument(saved);
  const subset = reopened.findPage(0).get('Resources').resolve().get('Font').resolve().get('F0').resolve();
  const descriptor = subset.get('DescendantFonts').resolve().get(0).resolve().get('FontDescriptor').resolve();
  const program = descriptor.get('FontFile2').readStream().asUint8Array().slice();
  reopened.destroy();
  font.destroy();
  return { program, gids };
}

function mapOf(gids: ReadonlyMap<number, number>): GlyphMapping[] {
  return [...gids].map(([unicode, gid]) => ({ unicode, gid }));
}

describe('trueTypeForWord', () => {
  it('gives a PDF subset a Unicode cmap that selects the glyphs the PDF draws, and a name Word finds', async () => {
    const { program, gids } = await pdfSubset();
    const out = trueTypeForWord(program, mapOf(gids), NAMES);
    expect(out).not.toBeNull();
    const bytes = out as Uint8Array;
    expectValidSfnt(bytes, 0x00010000);

    const font = new mupdf.Font('x', bytes);
    for (const character of 'ğİşA') {
      const unicode = character.codePointAt(0) as number;
      expect(gids.get(unicode)).toBeGreaterThan(0);
      expect(font.encodeCharacter(unicode), character).toBe(gids.get(unicode));
      expect(cmapLookup(bytes, 3, 1).lookup(unicode)).toBe(gids.get(unicode));
      expect(cmapLookup(bytes, 0, 3).lookup(unicode)).toBe(gids.get(unicode));
    }
    expect(font.encodeCharacter(0x20ac)).toBe(0); // unmapped
    font.destroy();

    const names = nameRecords(table(bytes, 'name'));
    expect(names.get('3/1')).toBe('Sample Face');
    expect(names.get('1/1')).toBe('Sample Face');
    expect(names.get('3/2')).toBe('Regular');
    expect(names.get('3/4')).toBe('Sample Face');
    expect(names.get('3/6')).toBe('SampleFace-Regular');
    expect(names.get('3/16')).toBe('Sample Face');
    expect(names.get('3/17')).toBe('Regular');
    expect(names.get('1/6')).toBe('SampleFace-Regular');
    expect(table(bytes, 'glyf').length).toBe(table(program, 'glyf').length);
  });

  it('adds the cmap, name, OS/2 and post a PDF subset lacks, and measures the face from hhea or, without it, from head', async () => {
    const { gids } = await pdfSubset();
    const bare = without(REGULAR, 'cmap', 'name', 'OS/2', 'post');
    const bytes = trueTypeForWord(bare, mapOf(gids), {
      family: 'Sample Face',
      style: 'Bold Italic',
    }) as Uint8Array;
    expectValidSfnt(bytes, 0x00010000);
    const os2 = table(bytes, 'OS/2');
    const dv = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
    expect(os2.length).toBe(96);
    expect(dv.getUint16(0)).toBe(4);
    expect(dv.getUint16(4)).toBe(700);
    expect(dv.getUint16(8)).toBe(0);
    expect(dv.getUint16(62)).toBe(0x21 | 0x80);
    expect(dv.getUint16(64)).toBe(0x41);
    expect(dv.getUint16(66)).toBe(0x15f); // ş
    expect(dv.getUint32(42) & 0b1111).toBe(0b0111); // Basic Latin, Latin-1, Latin Extended-A; no Extended-B
    expect(dv.getUint32(78)).toBe(1);
    const head = table(bytes, 'head');
    expect(new DataView(head.buffer, head.byteOffset).getUint16(44)).toBe(3);
    expect(new DataView(table(bytes, 'post').buffer, table(bytes, 'post').byteOffset).getUint32(0)).toBe(
      0x00030000,
    );
    const hhea = table(REGULAR, 'hhea');
    expect([dv.getInt16(68), dv.getInt16(70), dv.getUint16(74), dv.getUint16(76)]).toEqual([
      new DataView(hhea.buffer, hhea.byteOffset).getInt16(4),
      new DataView(hhea.buffer, hhea.byteOffset).getInt16(6),
      new DataView(hhea.buffer, hhea.byteOffset).getInt16(4),
      -new DataView(hhea.buffer, hhea.byteOffset).getInt16(6),
    ]);
    const font = new mupdf.Font('x', bytes);
    expect(font.encodeCharacter(0x11f)).toBe(gids.get(0x11f));
    font.destroy();

    const noHhea = trueTypeForWord(
      without(REGULAR, 'cmap', 'name', 'OS/2', 'post', 'hhea'),
      mapOf(gids),
      NAMES,
    ) as Uint8Array;
    const headOf = table(REGULAR, 'head');
    const headDv = new DataView(headOf.buffer, headOf.byteOffset);
    const bare2 = new DataView(table(noHhea, 'OS/2').buffer, table(noHhea, 'OS/2').byteOffset);
    expect([bare2.getInt16(68), bare2.getInt16(70)]).toEqual([headDv.getInt16(42), headDv.getInt16(38)]);
  });

  it('keeps an existing OS/2 and post but aligns the weight and style bits with the names', () => {
    const bold = trueTypeForWord(REGULAR, [{ unicode: 0x41, gid: 36 }], {
      family: 'Strong',
      style: 'Bold',
    }) as Uint8Array;
    expectValidSfnt(bold, 0x00010000);
    const boldOs2 = table(bold, 'OS/2');
    const boldDv = new DataView(boldOs2.buffer, boldOs2.byteOffset);
    expect(boldDv.getUint16(4)).toBe(700);
    expect(boldDv.getUint16(62) & 0x61).toBe(0x20);
    expect(boldOs2.length).toBe(table(REGULAR, 'OS/2').length);
    expect(table(bold, 'post')).toEqual(table(REGULAR, 'post'));

    const plain = trueTypeForWord(SEMIBOLD, [{ unicode: 0x41, gid: 36 }], {
      family: 'Weak',
      style: 'Italic',
    }) as Uint8Array;
    const plainOs2 = table(plain, 'OS/2');
    const plainDv = new DataView(plainOs2.buffer, plainOs2.byteOffset);
    expect(plainDv.getUint16(4)).toBe(599);
    expect(plainDv.getUint16(62) & 0x61).toBe(0x01);
    expect(new DataView(table(plain, 'head').buffer, table(plain, 'head').byteOffset).getUint16(44) & 3).toBe(
      2,
    );
  });

  it('writes a format 12 subtable for code points above the BMP and honours the last mapping of a code point', async () => {
    const map: GlyphMapping[] = [
      { unicode: 0x41, gid: 10 },
      { unicode: 0x41, gid: 36 }, // the later one wins
      { unicode: 0x42, gid: 37 },
      { unicode: 0x1f600, gid: 40 },
      { unicode: 0x1f601, gid: 41 },
      { unicode: 0x1f603, gid: 50 },
      { unicode: 0x43, gid: 0 }, // gid 0 is skipped
      { unicode: 0x44, gid: 999999 }, // beyond the glyphs
      { unicode: 0x45, gid: 1.5 }, // not an integer
      { unicode: -1, gid: 5 },
      { unicode: 0x110000, gid: 5 },
      { unicode: 0xd800, gid: 5 },
      { unicode: 0xffff, gid: 5 },
    ];
    const bytes = trueTypeForWord(REGULAR, map, NAMES) as Uint8Array;
    expectValidSfnt(bytes, 0x00010000);
    const records = new DataView(table(bytes, 'cmap').buffer, table(bytes, 'cmap').byteOffset);
    expect(records.getUint16(2)).toBe(3);
    const wide = cmapLookup(bytes, 3, 10);
    const narrow = cmapLookup(bytes, 3, 1);
    expect(wide.format).toBe(12);
    expect(narrow.format).toBe(4);
    expect(narrow.lookup(0x41)).toBe(36);
    expect(narrow.lookup(0x42)).toBe(37);
    expect(wide.lookup(0x41)).toBe(36);
    expect(wide.lookup(0x1f600)).toBe(40);
    expect(wide.lookup(0x1f601)).toBe(41);
    expect(wide.lookup(0x1f602)).toBe(0);
    expect(wide.lookup(0x1f603)).toBe(50);
    for (const code of [0x43, 0x44, 0x45, 0xd800, 0xffff, 0x10])
      expect(narrow.lookup(code), String(code)).toBe(0);
    const font = new mupdf.Font('x', bytes);
    expect(font.encodeCharacter(0x41)).toBe(36);
    expect(font.encodeCharacter(0x1f601)).toBe(41);
    font.destroy();
  });

  it('uses idDelta for contiguous glyph runs and glyphIdArray for scattered ones', async () => {
    const map: GlyphMapping[] = [
      { unicode: 0x61, gid: 100 }, // a b c d: one delta segment
      { unicode: 0x62, gid: 101 },
      { unicode: 0x63, gid: 102 },
      { unicode: 0x64, gid: 103 },
      { unicode: 0x141, gid: 300 }, // contiguous code points, scattered glyphs
      { unicode: 0x142, gid: 120 },
      { unicode: 0x143, gid: 500 },
      { unicode: 0x200, gid: 7 }, // a lone one
    ];
    const bytes = trueTypeForWord(REGULAR, map, NAMES) as Uint8Array;
    expectValidSfnt(bytes, 0x00010000);
    const narrow = cmapLookup(bytes, 3, 1);
    const font = new mupdf.Font('x', bytes);
    for (const { unicode, gid } of map) {
      expect(narrow.lookup(unicode), String(unicode)).toBe(gid);
      expect(font.encodeCharacter(unicode)).toBe(gid);
    }
    expect(narrow.lookup(0x140)).toBe(0);
    expect(narrow.lookup(0x144)).toBe(0);
    font.destroy();
    const empty = trueTypeForWord(REGULAR, [], NAMES) as Uint8Array;
    expectValidSfnt(empty, 0x00010000);
    expect(cmapLookup(empty, 3, 1).lookup(0x41)).toBe(0);
    expect(new DataView(table(empty, 'OS/2').buffer, table(empty, 'OS/2').byteOffset).getUint16(66)).toBe(
      new DataView(table(REGULAR, 'OS/2').buffer, table(REGULAR, 'OS/2').byteOffset).getUint16(66),
    );
  });

  it('refuses a font whose license forbids embedding', () => {
    const setFsType = (value: number) =>
      patched(REGULAR, 'OS/2', (os2) => new DataView(os2.buffer, os2.byteOffset).setUint16(8, value));
    const map = [{ unicode: 0x41, gid: 36 }];
    expect(trueTypeForWord(setFsType(0x0002), map, NAMES)).toBeNull();
    expect(trueTypeForWord(setFsType(0x0102), map, NAMES)).toBeNull(); // restricted, no-subsetting bit besides
    expect(trueTypeForWord(setFsType(0x0004), map, NAMES)).not.toBeNull(); // preview & print
    expect(trueTypeForWord(setFsType(0x0008), map, NAMES)).not.toBeNull(); // editable
    expect(trueTypeForWord(setFsType(0x0000), map, NAMES)).not.toBeNull();
  });

  it('returns null for what is not an embeddable TrueType program', () => {
    const map = [{ unicode: 0x41, gid: 36 }];
    expect(trueTypeForWord(new Uint8Array(0), map, NAMES)).toBeNull();
    expect(
      trueTypeForWord(new TextEncoder().encode('this is certainly not a font program'), map, NAMES),
    ).toBeNull();
    expect(trueTypeForWord(new Uint8Array(64).fill(7), map, NAMES)).toBeNull();
    const dangling = REGULAR.slice(0, 12 + 16 * 3);
    expect(trueTypeForWord(dangling, map, NAMES)).toBeNull(); // the tables are cut off
    expect(trueTypeForWord(REGULAR.slice(0, 20), map, NAMES)).toBeNull(); // the directory is cut off
    const directory = 12 + 16 * new DataView(REGULAR.buffer, REGULAR.byteOffset).getUint16(4);
    expect(trueTypeForWord(REGULAR.slice(0, directory + 8), map, NAMES)).toBeNull(); // the directory is whole, the tables are cut off
    expect(trueTypeForWord(without(REGULAR, 'head'), map, NAMES)).toBeNull();
    expect(trueTypeForWord(without(REGULAR, 'maxp'), map, NAMES)).toBeNull();
    expect(trueTypeForWord(without(REGULAR, 'glyf'), map, NAMES)).toBeNull();
    expect(trueTypeForWord(without(REGULAR, 'loca'), map, NAMES)).toBeNull();
    const shortHead = buildSfnt(0x00010000, {
      head: new Uint8Array(10),
      maxp: new Uint8Array(6),
      glyf: new Uint8Array(4),
      loca: new Uint8Array(4),
    });
    expect(trueTypeForWord(shortHead, map, NAMES)).toBeNull();
    const shortMaxp = buildSfnt(0x00010000, {
      head: new Uint8Array(54),
      maxp: new Uint8Array(4),
      glyf: new Uint8Array(4),
      loca: new Uint8Array(4),
    });
    expect(trueTypeForWord(shortMaxp, map, NAMES)).toBeNull();
    const cff = buildSfnt(0x4f54544f, { head: new Uint8Array(54), maxp: new Uint8Array(6) });
    expect(trueTypeForWord(cff, map, NAMES)).toBeNull();
  });

  it('accepts the Apple "true" signature and a font with a header but no OS/2 to inspect', () => {
    const truthy = patched(REGULAR, 'head', () => {});
    new DataView(truthy.buffer).setUint32(0, 0x74727565);
    expect(trueTypeForWord(truthy, [{ unicode: 0x41, gid: 36 }], NAMES)).not.toBeNull();
    const tiny = buildSfnt(0x00010000, {
      head: new Uint8Array(54),
      maxp: new Uint8Array([0, 1, 0, 0, 0, 40]),
      glyf: new Uint8Array(4),
      loca: new Uint8Array(4),
      'OS/2': new Uint8Array(4), // too short to carry fsType: replaced
    });
    const out = trueTypeForWord(tiny, [{ unicode: 0x41, gid: 3 }], NAMES) as Uint8Array;
    expectValidSfnt(out, 0x00010000);
    expect(table(out, 'OS/2').length).toBe(96);
  });

  it('returns null when the BMP map does not fit one format 4 subtable', () => {
    const maxp = new Uint8Array(6);
    new DataView(maxp.buffer).setUint16(4, 65535);
    const big = buildSfnt(0x00010000, {
      head: new Uint8Array(54),
      maxp,
      glyf: new Uint8Array(4),
      loca: new Uint8Array(4),
    });
    const sparse: GlyphMapping[] = [];
    for (let index = 0; index < 9000; index += 1) sparse.push({ unicode: 0x100 + 2 * index, gid: 1 + index });
    expect(trueTypeForWord(big, sparse, NAMES)).toBeNull();
    expect(trueTypeForWord(big, sparse.slice(0, 2000), NAMES)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// CFF

const CFF_NAMES: FontNames = { family: 'Carlito Test', style: 'Bold' };
const CFF_MAP: GlyphMapping[] = [
  { unicode: 0x41, gid: 1 },
  { unicode: 0x11f, gid: 2 },
  { unicode: 0x130, gid: 1 },
];
const METRICS = { ascent: 900, descent: -250 };

describe('cffForWord', () => {
  it('wraps a CFF program as an OpenType font Word and LibreOffice can load, with its widths and metrics', async () => {
    const bytes = cffForWord(buildCff(), CFF_MAP, new Map([[1, 640]]), CFF_NAMES, METRICS) as Uint8Array;
    expect(bytes).not.toBeNull();
    expectValidSfnt(bytes, 0x4f54544f);
    expect(directory(bytes).tables.map((entry) => entry.tag)).toEqual([
      'CFF ',
      'OS/2',
      'cmap',
      'head',
      'hhea',
      'hmtx',
      'maxp',
      'name',
      'post',
    ]);
    const cff = buildCff();
    expect(table(bytes, 'CFF ')).toEqual(cff);

    const font = new mupdf.Font('x', bytes);
    expect(font.encodeCharacter(0x41)).toBe(1);
    expect(font.encodeCharacter(0x11f)).toBe(2);
    expect(font.encodeCharacter(0x130)).toBe(1);
    expect(font.encodeCharacter(0x42)).toBe(0);
    expect(font.advanceGlyph(1)).toBeCloseTo(0.64, 5);
    expect(font.advanceGlyph(2)).toBeCloseTo(0.5, 5); // the CFF defaultWidthX
    font.destroy();

    const head = table(bytes, 'head');
    const headDv = new DataView(head.buffer, head.byteOffset);
    expect(headDv.getUint32(12)).toBe(0x5f0f3cf5);
    expect(headDv.getUint16(18)).toBe(1000);
    expect([36, 38, 40, 42].map((at) => headDv.getInt16(at))).toEqual([-200, -1500, 2000, 900]);
    expect(headDv.getUint16(44)).toBe(1);
    expect(headDv.getInt16(50)).toBe(0);

    const hhea = table(bytes, 'hhea');
    const hheaDv = new DataView(hhea.buffer, hhea.byteOffset);
    expect([hheaDv.getInt16(4), hheaDv.getInt16(6), hheaDv.getUint16(10), hheaDv.getUint16(34)]).toEqual([
      900, -250, 640, 3,
    ]);
    const maxp = table(bytes, 'maxp');
    expect([
      new DataView(maxp.buffer, maxp.byteOffset).getUint32(0),
      new DataView(maxp.buffer, maxp.byteOffset).getUint16(4),
    ]).toEqual([0x5000, 3]);
    expect(table(bytes, 'hmtx').length).toBe(12);

    const os2 = table(bytes, 'OS/2');
    const os2Dv = new DataView(os2.buffer, os2.byteOffset);
    expect(os2.length).toBe(96);
    expect([os2Dv.getUint16(0), os2Dv.getUint16(4), os2Dv.getUint16(8)]).toEqual([4, 700, 0]);
    expect(os2Dv.getUint16(62)).toBe(0x20 | 0x80);
    expect([os2Dv.getInt16(68), os2Dv.getInt16(70), os2Dv.getUint16(74), os2Dv.getUint16(76)]).toEqual([
      900, -250, 900, 250,
    ]);
    expect(os2Dv.getInt16(2)).toBe(Math.round((640 + 500 + 640) / 3));
    expect(new DataView(table(bytes, 'post').buffer, table(bytes, 'post').byteOffset).getUint32(0)).toBe(
      0x00030000,
    );
    expect(nameRecords(table(bytes, 'name')).get('3/1')).toBe('Carlito Test');
    expect(nameRecords(table(bytes, 'name')).get('3/4')).toBe('Carlito Test Bold');
    expect(nameRecords(table(bytes, 'name')).get('3/6')).toBe('CarlitoTest-Bold');
  });

  it('takes unitsPerEm from the FontMatrix, from the first Font DICT of a CID-keyed font, or defaults to 1000', () => {
    const upem = (cff: Uint8Array) => {
      const head = table(cffForWord(cff, CFF_MAP, new Map(), CFF_NAMES, METRICS) as Uint8Array, 'head');
      return new DataView(head.buffer, head.byteOffset).getUint16(18);
    };
    expect(upem(buildCff({ matrix: ['0.0005', '0', '0', '0.0005', '0', '0'] }))).toBe(2000);
    expect(upem(buildCff({ matrix: ['5E-4', '0', '0', '5E-4', '0', '0'] }))).toBe(2000);
    expect(upem(buildCff({ matrix: ['0.00005E1', '0', '0', '0.00005E1', '0', '0'] }))).toBe(2000); // a positive exponent
    expect(upem(buildCff({ matrix: null }))).toBe(1000);
    expect(upem(buildCff({ matrix: ['0', '0', '0', '0', '0', '0'] }))).toBe(1000);
    expect(upem(buildCff({ matrix: ['0.00001', '0', '0', '0.00001', '0', '0'] }))).toBe(16384);
    expect(upem(buildCff({ matrix: ['-0.001', '0', '0', '0.001', '0', '0'] }))).toBe(1000);
    expect(upem(buildCff({ matrix: ['0.0005', '0', '0', '0.0005', '0', '0'], cid: 'with-fd' }))).toBe(2000);
    expect(upem(buildCff({ matrix: null, cid: 'with-fd' }))).toBe(1000);
    expect(upem(buildCff({ matrix: ['0.0005', '0', '0', '0.0005', '0', '0'], cid: 'bad-fd' }))).toBe(1000);
    expect(upem(buildCff({ matrix: ['0.0005', '0', '0', '0.0005', '0', '0'], cid: 'no-fd' }))).toBe(1000);
  });

  it('uses the CFF default width for glyphs without an advance, whichever Private DICT holds it', () => {
    const widths = (cff: Uint8Array, advances: ReadonlyMap<number, number>) => {
      const hmtx = table(cffForWord(cff, CFF_MAP, advances, CFF_NAMES, METRICS) as Uint8Array, 'hmtx');
      const dv = new DataView(hmtx.buffer, hmtx.byteOffset);
      return [dv.getUint16(0), dv.getUint16(4), dv.getUint16(8)];
    };
    expect(widths(buildCff(), new Map())).toEqual([500, 500, 500]);
    expect(widths(buildCff({ cid: 'with-fd' }), new Map([[2, 123.4]]))).toEqual([500, 500, 123]);
    expect(
      widths(
        buildCff({ defaultWidth: null }),
        new Map([
          [0, 70000],
          [1, -5],
        ]),
      ),
    ).toEqual([65535, 0, 0]);
  });

  it('reads every DICT number form into the head bounding box and tolerates a missing one', () => {
    const box = (cff: Uint8Array) => {
      const head = table(cffForWord(cff, CFF_MAP, new Map(), CFF_NAMES, METRICS) as Uint8Array, 'head');
      const dv = new DataView(head.buffer, head.byteOffset);
      return [36, 38, 40, 42].map((at) => dv.getInt16(at));
    };
    expect(box(buildCff({ bbox: [-100, 100, 107, -107] }))).toEqual([-100, 100, 107, -107]);
    expect(box(buildCff({ bbox: [-1131, 1131, -108, 108] }))).toEqual([-1131, 1131, -108, 108]);
    expect(box(buildCff({ bbox: [-1132, 1132, 32767, -32768] }))).toEqual([-1132, 1132, 32767, -32768]);
    expect(box(buildCff({ bbox: [-100000, 100000, 0, 1] }))).toEqual([-32768, 32767, 0, 1]); // clamped to 16 bits
    expect(box(buildCff({ bbox: null }))).toEqual([0, 0, 0, 0]);
  });

  it('reads a glyph count that needs two bytes and INDEX offsets of every size', () => {
    const many = buildCff({ glyphs: 9000 });
    const wide: GlyphMapping[] = Array.from({ length: 2000 }, (_, i) => ({
      unicode: 0x100 + 2 * i,
      gid: 1 + i,
    }));
    const bytes = cffForWord(many, wide, new Map(), CFF_NAMES, METRICS) as Uint8Array;
    expectValidSfnt(bytes, 0x4f54544f);
    expect(table(bytes, 'hmtx').length).toBe(4 * 9000);
    const font = new mupdf.Font('x', bytes);
    expect(font.encodeCharacter(0x100 + 2 * 1999)).toBe(2000);
    font.destroy();
    const sparse = Array.from({ length: 9000 }, (_, i) => ({ unicode: 0x100 + 2 * i, gid: 1 + i }));
    expect(cffForWord(many, sparse, new Map(), CFF_NAMES, METRICS)).toBeNull(); // too many segments for format 4

    for (const offSize of [1, 2, 3, 4]) {
      const out = cffForWord(buildCff({ offSize }), CFF_MAP, new Map(), CFF_NAMES, METRICS) as Uint8Array;
      expect(out, String(offSize)).not.toBeNull();
      expect(table(out, 'hmtx').length).toBe(12);
    }
  });

  it('accepts a zero-count Name INDEX and a Private DICT beyond the file (default width 0)', () => {
    const out = cffForWord(buildCff({ nameCount: 0 }), CFF_MAP, new Map(), CFF_NAMES, METRICS) as Uint8Array;
    expect(out).not.toBeNull();
    const zero = (cff: Uint8Array) => {
      const hmtx = table(cffForWord(cff, CFF_MAP, new Map(), CFF_NAMES, METRICS) as Uint8Array, 'hmtx');
      return new DataView(hmtx.buffer, hmtx.byteOffset).getUint16(0);
    };
    expect(zero(buildCff({ badPrivate: true }))).toBe(0);
    expect(zero(buildCff({ badPrivate: true, cid: 'with-fd' }))).toBe(0);
  });

  it('rejects a CFF without a usable header, INDEX, Top DICT or CharStrings', () => {
    const call = (cff: Uint8Array) => cffForWord(cff, CFF_MAP, new Map(), CFF_NAMES, METRICS);
    const good = buildCff();
    expect(call(good)).not.toBeNull();
    expect(call(new Uint8Array(0))).toBeNull();
    expect(call(new Uint8Array([1, 0, 4]))).toBeNull();
    expect(call(new TextEncoder().encode('%!PS-AdobeFont-1.0: not CFF'))).toBeNull();
    expect(call(new Uint8Array([2, ...good.slice(1)]))).toBeNull(); // CFF2
    expect(call(good.slice(0, 6))).toBeNull(); // cut inside the Name INDEX
    expect(call(good.slice(0, 20))).toBeNull(); // cut inside the Top DICT INDEX
    expect(call(good.slice(0, 4))).toBeNull(); // no Name INDEX at all
    expect(call(new Uint8Array([1, 0, 200, 1, ...good.slice(4)]))).toBeNull(); // header size points beyond
    const badOffSize = good.slice();
    badOffSize[6] = 9; // the Name INDEX offSize
    expect(call(badOffSize)).toBeNull();
    const decreasing = good.slice();
    decreasing[7] = 50; // first Name offset past the second
    expect(call(decreasing)).toBeNull();
    expect(call(new Uint8Array([1, 0, 4, 1, ...index([[65]]), ...index([])]))).toBeNull(); // no Top DICT
    const topWith = (dict: number[]) =>
      new Uint8Array([1, 0, 4, 1, ...index([[65]]), ...index([dict]), ...index([]), ...index([])]);
    expect(call(topWith([]))).toBeNull(); // no CharStrings operator
    expect(call(topWith([...encodeOffset(60), 17]))).toBeNull(); // CharStrings beyond the file
    expect(call(topWith([22]))).toBeNull(); // reserved operator byte
    expect(call(topWith([255]))).toBeNull(); // reserved operand byte
    expect(call(topWith([31]))).toBeNull();
    expect(call(topWith([30, 0xd1]))).toBeNull(); // reserved real nibble
    expect(call(topWith([29, 0, 0]))).toBeNull(); // operand runs off the DICT
    expect(call(topWith([28, 0]))).toBeNull();
    expect(call(topWith([247]))).toBeNull();
    expect(call(topWith([251]))).toBeNull();
    // a CharStrings INDEX with no glyphs (offset 18 holds the empty INDEX of the string section)
    const emptyGlyphs = new Uint8Array([
      1,
      0,
      4,
      1,
      ...index([[65]]),
      ...index([[...encodeOffset(23), 17]]),
      ...index([]),
      ...index([]),
    ]);
    expect(emptyGlyphs[23]).toBe(0);
    expect(call(emptyGlyphs)).toBeNull();
  });
});

describe('embedding permission', () => {
  const fsTypeOf = (bytes: Uint8Array): number => {
    const os2 = table(bytes, 'OS/2');
    return new DataView(os2.buffer, os2.byteOffset).getUint16(8);
  };

  it('keeps the source font fsType in an OpenType-CFF font, installable when there is none', () => {
    const rebuilt = (metrics: { ascent: number; descent: number; fsType?: number }) =>
      cffForWord(buildCff(), CFF_MAP, new Map(), CFF_NAMES, metrics) as Uint8Array;
    expect(fsTypeOf(rebuilt({ ...METRICS, fsType: 0x0004 }))).toBe(0x0004); // preview & print
    expect(fsTypeOf(rebuilt({ ...METRICS, fsType: 0x0008 }))).toBe(0x0008); // editable
    expect(fsTypeOf(rebuilt({ ...METRICS, fsType: 0x0108 }))).toBe(0x0108); // editable, no subsetting
    expect(fsTypeOf(rebuilt(METRICS))).toBe(0);
  });

  it('refuses a TrueType font that allows only bitmaps to be embedded', () => {
    const map = [{ unicode: 0x41, gid: 36 }];
    const setFsType = (value: number) =>
      patched(REGULAR, 'OS/2', (os2) => new DataView(os2.buffer, os2.byteOffset).setUint16(8, value));
    expect(trueTypeForWord(setFsType(0x0200), map, NAMES)).toBeNull();
    expect(trueTypeForWord(setFsType(0x0208), map, NAMES)).toBeNull();
    expect(trueTypeForWord(setFsType(0x0100), map, NAMES)).not.toBeNull(); // no subsetting alone is fine
  });
});
