/**
 * The shared MuPDF writer vocabulary, against the real engine. The wrong answers that
 * matter: a title written as a *name* (a reader shows nothing), a Turkish letter mangled
 * by the string encoding, object numbers renumbered by the save (a second step then acts
 * on the wrong object), and drawn text that renders but cannot be extracted or searched.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  embedNotoSans,
  openForWrite,
  PRODUCER_LINE,
  pdfDate,
  readName,
  readText,
  saveRewrite,
  subsetEmbeddedFaces,
  text,
} from './mupdf-write';

function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

async function blankPdf(): Promise<Uint8Array> {
  const { mupdf } = await openForWrite(await emptyShell());
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, {}, ''));
  const bytes = saveRewrite(doc);
  doc.destroy();
  return bytes;
}

/** The smallest valid PDF, so `openForWrite` has something to open while the module loads. */
async function emptyShell(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 100, 100], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('mupdf-write', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes text as strings, reads Turkish back unchanged, and keeps names as names', async () => {
    const { doc } = await openForWrite(await blankPdf());
    const info = doc.addObject(doc.newDictionary());
    info.put('Title', text(doc, 'Şişli’de ığdır — İĞÜŞÖÇ'));
    info.put('Kind', 'Report');
    doc.getTrailer().put('Info', info);
    const bytes = saveRewrite(doc);
    doc.destroy();

    const { doc: reread } = await openForWrite(bytes);
    const readInfo = reread.getTrailer().get('Info');
    expect(readText(readInfo.get('Title'))).toBe('Şişli’de ığdır — İĞÜŞÖÇ');
    expect(readName(readInfo.get('Kind'))).toBe('Report');
    expect(readText(readInfo.get('Kind'))).toBeNull();
    expect(readText(readInfo.get('Producer'))).toBe(PRODUCER_LINE);
    reread.destroy();
  });

  it('keeps object numbers across a save', async () => {
    const { doc } = await openForWrite(await blankPdf());
    // An unreferenced object ahead of the marker leaves a gap in the numbering once the
    // save drops it: a renumbering save would move the marker down into that gap.
    doc.addObject(doc.newDictionary());
    const marker = doc.addObject(doc.newDictionary());
    marker.put('Tag', text(doc, 'kept'));
    doc.findPage(0).put('Marker', marker);
    const number = marker.asIndirect();
    const bytes = saveRewrite(doc);
    doc.destroy();

    const { doc: reread } = await openForWrite(bytes);
    const again = reread.findPage(0).get('Marker');
    expect(again.asIndirect()).toBe(number);
    expect(readText(again.get('Tag'))).toBe('kept');
    reread.destroy();
  });

  it('formats a date the way pdf-lib did', () => {
    expect(pdfDate(new Date('2026-09-28T07:05:03.000Z'))).toBe('D:20260928070503Z');
  });

  it('draws text with the embedded face that extracts back as the same words', async () => {
    const { mupdf, doc } = await openForWrite(await blankPdf());
    const face = await embedNotoSans(mupdf, doc);
    const page = doc.findPage(0);
    const resources = doc.addObject({ Font: { F1: face.ref } });
    page.put('Resources', resources);
    const words = 'Merhaba dünya — ğüşıöç İĞÜŞÖÇ';
    const content = `BT /F1 14 Tf 72 700 Td ${face.encode(words)} Tj ET`;
    page.put('Contents', doc.addStream(content, {}));
    expect(face.widthOfTextAtSize(words, 14)).toBeGreaterThan(100);
    expect(face.heightAtSize(14, { descender: false })).toBeGreaterThan(10);
    const bytes = saveRewrite(doc);
    doc.destroy();

    const { doc: reread } = await openForWrite(bytes);
    const extracted = reread.loadPage(0).toStructuredText('preserve-whitespace').asText();
    expect(extracted.trim()).toBe(words);
    reread.destroy();
  });

  it('refuses a document that needs a password and opens one with an owner password only', async () => {
    const mupdf = await import('mupdf');
    const source = mupdf.PDFDocument.openDocument(await blankPdf(), 'application/pdf').asPDF();
    if (source === null) throw new Error('not a PDF');
    const locked = new Uint8Array(
      source.saveToBuffer('encrypt=aes-256,user-password=a,owner-password=b').asUint8Array(),
    );
    const ownerOnly = new Uint8Array(source.saveToBuffer('encrypt=aes-256,owner-password=b').asUint8Array());
    source.destroy();

    await expect(openForWrite(locked)).rejects.toMatchObject({ code: 'encrypted-unsupported' });
    const { doc } = await openForWrite(ownerOnly);
    expect(doc.countPages()).toBe(1);
    doc.destroy();
  });
});

describe('subsetEmbeddedFaces', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const words = 'Şişli’de ığdır — İĞÜŞÖÇ';

  /** A page that draws `words` with the embedded face, saved with or without the subset. */
  async function draw(subset: boolean): Promise<Uint8Array> {
    const { mupdf, doc } = await openForWrite(await blankPdf());
    const face = await embedNotoSans(mupdf, doc);
    const page = doc.findPage(0);
    page.put('Resources', doc.addObject({ Font: { F1: face.ref } }));
    page.put('Contents', doc.addStream(`BT /F1 14 Tf 72 700 Td ${face.encode(words)} Tj ET`, {}));
    if (subset) expect(subsetEmbeddedFaces(mupdf, doc, [face])).toBeGreaterThan(100_000);
    const bytes = saveRewrite(doc);
    doc.destroy();
    return bytes;
  }

  /** The face the page draws with: its font program's size and names, and the extracted text. */
  async function inspect(bytes: Uint8Array) {
    const { doc } = await openForWrite(bytes);
    try {
      const font = doc.findPage(0).get('Resources').get('Font').get('F1').resolve();
      const descendant = font.get('DescendantFonts').resolve().get(0).resolve();
      const descriptor = descendant.get('FontDescriptor').resolve();
      return {
        program: descriptor.get('FontFile2').readStream().getLength(),
        baseFont: font.get('BaseFont').asName(),
        descendantBaseFont: descendant.get('BaseFont').asName(),
        descriptorName: descriptor.get('FontName').asName(),
        extracted: doc.loadPage(0).toStructuredText('preserve-whitespace').asText().trim(),
      };
    } finally {
      doc.destroy();
    }
  }

  it('replaces the whole face with a much smaller subset that still extracts as the same words', async () => {
    const whole = await inspect(await draw(false));
    const subset = await inspect(await draw(true));
    expect(whole.program).toBeGreaterThan(300_000);
    expect(subset.program).toBeLessThan(whole.program / 5);
    expect(whole.extracted).toBe(words);
    expect(subset.extracted).toBe(words);
    // The subset is renamed everywhere the face is named (`ABCDEF+NotoSans`), so a reader sees one face.
    expect(subset.baseFont).toMatch(/^[A-Z]{6}\+NotoSans/);
    expect(subset.descendantBaseFont).toBe(subset.baseFont);
    expect(subset.descriptorName).toBe(subset.baseFont);
    expect(whole.baseFont).not.toContain('+');
  });

  it('keeps the face, and saves nothing, when its descriptor has no font program', async () => {
    const { mupdf, doc } = await openForWrite(await blankPdf());
    const face = await embedNotoSans(mupdf, doc);
    const descendant = face.ref.resolve().get('DescendantFonts').resolve().get(0).resolve();
    descendant.get('FontDescriptor').resolve().delete('FontFile2');
    expect(subsetEmbeddedFaces(mupdf, doc, [face])).toBe(0);
    doc.destroy();
  });
});
