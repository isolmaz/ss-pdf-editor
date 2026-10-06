/**
 * The font header reader (`readFontHeader`) and the metric table built on it
 * (`metricsFor`). The header is the one part of a font programme this package parses
 * itself, so every malformed shape must be refused with `unsupported` — never read past
 * the end, never returned as zeros that would divide every size.
 */

import { describe, expect, it } from 'vitest';
import { metricsFor, readFontHeader } from './fonts';
import type { GlyphSource } from './types';

interface Table {
  readonly tag: string;
  readonly body: Uint8Array;
}

/** A minimal sfnt: the directory and the given tables, laid out back to back. */
function sfnt(version: number, tables: readonly Table[]): Uint8Array {
  const directory = 12 + tables.length * 16;
  const size = tables.reduce((sum, table) => sum + table.body.length, directory);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, version);
  view.setUint16(4, tables.length);
  let offset = directory;
  tables.forEach((table, index) => {
    const record = 12 + index * 16;
    for (let at = 0; at < 4; at += 1) view.setUint8(record + at, table.tag.charCodeAt(at));
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, table.body.length);
    bytes.set(table.body, offset);
    offset += table.body.length;
  });
  return bytes;
}

function head(unitsPerEm: number): Table {
  const body = new Uint8Array(54);
  new DataView(body.buffer).setUint16(18, unitsPerEm);
  return { tag: 'head', body };
}

function hhea(ascender: number, descender: number, lineGap: number): Table {
  const body = new Uint8Array(36);
  const view = new DataView(body.buffer);
  view.setInt16(4, ascender);
  view.setInt16(6, descender);
  view.setInt16(8, lineGap);
  return { tag: 'hhea', body };
}

const TRUETYPE = 0x00010000;
const OTTO = 0x4f54544f;

describe('readFontHeader', () => {
  it('reads unitsPerEm from head and the signed vertical metrics from hhea', () => {
    expect(readFontHeader(sfnt(TRUETYPE, [head(2048), hhea(1900, -500, 67)]))).toEqual({
      unitsPerEm: 2048,
      ascender: 1900,
      descender: -500,
      lineGap: 67,
    });
  });

  it('accepts a CFF-flavoured OpenType font and finds tables in any order', () => {
    expect(readFontHeader(sfnt(OTTO, [hhea(800, -200, 0), head(1000)])).unitsPerEm).toBe(1000);
  });

  it('reads negative vertical metrics with their sign', () => {
    expect(readFontHeader(sfnt(TRUETYPE, [head(1000), hhea(-300, -200, -50)]))).toMatchObject({
      ascender: -300,
      descender: -200,
      lineGap: -50,
    });
  });

  it('accepts the legacy true-tagged sfnt version', () => {
    expect(readFontHeader(sfnt(0x74727565, [head(1000), hhea(1, -1, 0)])).unitsPerEm).toBe(1000);
  });

  it('reads a font that is a view into a larger buffer', () => {
    const font = sfnt(TRUETYPE, [head(2048), hhea(1900, -500, 67)]);
    const padded = new Uint8Array(font.length + 37);
    padded.fill(0xff);
    padded.set(font, 21);
    expect(readFontHeader(padded.subarray(21, 21 + font.length)).unitsPerEm).toBe(2048);
  });

  it('refuses what is not an sfnt: a WOFF wrapper, a collection', () => {
    for (const version of [0x774f4646 /* wOFF */, 0x774f4632 /* wOF2 */, 0x74746366 /* ttcf */]) {
      expect(() => readFontHeader(sfnt(version, [head(1000), hhea(1, -1, 0)]))).toThrow(
        expect.objectContaining({ code: 'unsupported', message: expect.stringMatching(/not a TrueType/) }),
      );
    }
  });

  it('refuses a file shorter than an sfnt header without reading past its end', () => {
    for (const length of [0, 2, 8, 11]) {
      expect(() => readFontHeader(new Uint8Array(length)), String(length)).toThrow(
        expect.objectContaining({ code: 'unsupported', message: expect.stringMatching(/shorter/) }),
      );
    }
  });

  it('refuses a missing table, a truncated table and a directory past the end, each for its own reason', () => {
    const refused = (reason: RegExp) =>
      expect.objectContaining({ code: 'unsupported', message: expect.stringMatching(reason) });
    expect(() => readFontHeader(sfnt(TRUETYPE, [head(1000)]))).toThrow(refused(/no 'hhea' table/));
    const truncated = sfnt(TRUETYPE, [head(1000), hhea(1, -1, 0)]).slice(0, 12 + 32 + 54 + 10);
    expect(() => readFontHeader(truncated)).toThrow(refused(/'hhea' table is truncated/));
    const lying = sfnt(TRUETYPE, [head(1000), hhea(1, -1, 0)]);
    new DataView(lying.buffer).setUint16(4, 500);
    expect(() => readFontHeader(lying)).toThrow(refused(/directory runs past/));
    // The bytes are all there, but the directory itself declares a `head` shorter than a head.
    const short = sfnt(TRUETYPE, [head(1000), hhea(1, -1, 0)]);
    new DataView(short.buffer).setUint32(12 + 12, 20);
    expect(() => readFontHeader(short)).toThrow(refused(/'head' table is truncated/));
  });

  it('accepts unitsPerEm at both ends of 16..16384 and refuses just outside, zero included', () => {
    for (const units of [16, 1000, 16384]) {
      expect(readFontHeader(sfnt(TRUETYPE, [head(units), hhea(1, -1, 0)])).unitsPerEm).toBe(units);
    }
    for (const units of [0, 15, 16385]) {
      expect(() => readFontHeader(sfnt(TRUETYPE, [head(units), hhea(1, -1, 0)])), String(units)).toThrow(
        expect.objectContaining({ code: 'unsupported', message: expect.stringMatching(/out of range/) }),
      );
    }
  });
});

describe('metricsFor', () => {
  /** A two-glyph engine: `A` is glyph 1 at 0.6 em; everything else is `.notdef` at 0.5 em. */
  const glyphs: GlyphSource = {
    encodeCharacter: (codePoint) => (codePoint === 0x41 ? 1 : 0),
    advanceGlyph: (glyph) => (glyph === 1 ? 0.6000001 : 0.5),
  };
  const bytes = sfnt(TRUETYPE, [head(1000), hhea(900, -250, 10)]);

  it('scales em advances to font units and rounds the float residue away', () => {
    const metrics = metricsFor(glyphs, bytes);
    expect(metrics.glyphAdvance(0x41)).toBe(600);
    expect(metrics.glyphAdvance(0x42)).toBe(500);
    expect([metrics.unitsPerEm, metrics.ascender, metrics.descender, metrics.lineGap]).toEqual([
      1000, 900, -250, 10,
    ]);
  });

  it('reports coverage from the engine and lists each missing character once', () => {
    const metrics = metricsFor(glyphs, bytes, 'AşAş');
    expect(metrics.hasGlyph(0x41)).toBe(true);
    expect(metrics.hasGlyph(0x15f)).toBe(false);
    expect(metrics.missing).toEqual(['ş']);
  });
});
