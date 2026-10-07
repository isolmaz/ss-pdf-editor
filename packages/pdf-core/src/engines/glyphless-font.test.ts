/**
 * The glyph-less font: text in scripts Noto Sans has no glyph for (Arabic, Hebrew, CJK)
 * must come back from MuPDF and pdf.js as the very Unicode that was written, nothing may
 * be drawn, and a right-to-left word written in visual order (what the OCR layer does)
 * must extract in reading order. The font program itself must be a well-formed TrueType.
 */

import { describe, expect, it } from 'vitest';
import { visualOrder } from '../ops/ocr';
import { embedGlyphless, glyphlessFontProgram } from './glyphless-font';
import { openWithPdfjs } from './pdfjs-handle';

/** A page with one invisible line per entry, each drawn in the glyph-less font. */
async function pageWith(lines: readonly string[]): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const face = embedGlyphless(doc);
  const content = lines
    .map((line, index) => `BT /G 20 Tf 3 Tr 20 ${180 - index * 40} Td ${face.encode(line)} Tj ET`)
    .join('\n');
  doc.insertPage(0, doc.addPage([0, 0, 300, 200], 0, { Font: { G: face.ref } }, content));
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

async function mupdfText(bytes: Uint8Array): Promise<string[]> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const page = doc.loadPage(0);
    const json = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
      blocks: { lines?: { text: string }[] }[];
    };
    const pixmap = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false);
    expect(pixmap.getPixels().every((value) => value === 255)).toBe(true);
    return json.blocks.flatMap((block) => (block.lines ?? []).map((line) => line.text));
  } finally {
    doc.destroy();
  }
}

async function pdfjsText(bytes: Uint8Array): Promise<string[]> {
  const handle = await openWithPdfjs(bytes);
  try {
    const content = await handle.textContent(0);
    return content.items.map((item) => item.text).filter((text) => text !== '');
  } finally {
    await handle.destroy();
  }
}

const ARABIC = 'مرحبا بالعالم';
const HEBREW = 'שלום עולם';
const CJK = '日本語のテキスト、中文字';

describe('glyph-less font', () => {
  it('writes a well-formed TrueType program MuPDF accepts', async () => {
    const program = glyphlessFontProgram();
    const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
    expect(view.getUint32(0)).toBe(0x00010000);
    const tags: string[] = [];
    let head = -1;
    for (let index = 0; index < view.getUint16(4); index += 1) {
      const entry = 12 + index * 16;
      const tag = String.fromCharCode(...program.subarray(entry, entry + 4));
      tags.push(tag);
      if (tag === 'head') head = view.getUint32(entry + 8);
    }
    expect(tags).toEqual(['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']);
    expect(view.getUint32(head + 12)).toBe(0x5f0f3cf5);
    // The whole file sums to 0xB1B0AFBA once `checkSumAdjustment` is set (OpenType `head`).
    let sum = 0;
    for (let offset = 0; offset < program.length; offset += 4) {
      const word = [0, 1, 2, 3].reduce((acc, step) => acc * 256 + (program[offset + step] ?? 0), 0);
      sum = (sum + word) >>> 0;
    }
    expect(sum).toBe(0xb1b0afba);
    const mupdf = await import('mupdf');
    const font = new mupdf.Font('GlyphLessFont', program);
    expect(font.getName()).toBe('GlyphLessFont');
    // The cmap maps nothing (the PDF's CIDToGIDMap does), so every code point is glyph 0.
    expect([0x41, 0x5d1, 0xffff].map((code) => font.encodeCharacter(code))).toEqual([0, 0, 0]);
    // Two glyphs, each half an em wide; a glyph id past `numGlyphs` has no advance.
    expect([0, 1, 2, 5].map((glyph) => font.advanceGlyph(glyph))).toEqual([0.5, 0.5, 0, 0]);
  });

  it('extracts Arabic, Hebrew and CJK back as the same Unicode through MuPDF and pdf.js', async () => {
    // Visual order for a right-to-left line, as the OCR layer writes it.
    const bytes = await pageWith([visualOrder(ARABIC), visualOrder(HEBREW), CJK]);
    expect(await mupdfText(bytes)).toEqual([ARABIC, HEBREW, CJK]);
    expect(await pdfjsText(bytes)).toEqual([ARABIC, HEBREW, CJK]);
  });

  it('keeps a right-to-left word in reading order only when it is written in visual order', async () => {
    // Logical order written as is comes back reversed: the reason `visualOrder` exists.
    const logical = await pageWith([HEBREW]);
    expect(await mupdfText(logical)).toEqual(['םלוע םולש']);
    const visual = await pageWith(['םלוע םולש']);
    expect(await mupdfText(visual)).toEqual([HEBREW]);
    expect(visualOrder(HEBREW)).toBe('םלוע םולש');
    expect(visualOrder('Çarşı 123')).toBe('Çarşı 123');
  });

  it('encodes one CID per UTF-16 code unit and measures half an em per unit', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    try {
      const face = embedGlyphless(doc);
      expect(face.encode('Aב')).toBe('<004105d1>');
      expect(face.encode('\u{1F600}')).toBe('<d83dde00>');
      expect(face.widthOfTextAtSize('abcd', 10)).toBe(20);
    } finally {
      doc.destroy();
    }
  });
});
