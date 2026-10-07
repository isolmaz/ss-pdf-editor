/**
 * The shared MuPDF writer vocabulary on the inputs the callers' own tests do not reach: a file
 * MuPDF had to repair, pages that inherit their resources, a content entry that is no stream, fonts
 * the engine cannot read, a subset that does not shrink, and characters WinAnsi has no code for.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Font, PDFDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf } from './mupdf';
import {
  canEncodeWinAnsi,
  embedFontFile,
  embedNotoSans,
  pageAsForm,
  pageContentParts,
  pageResources,
  saveIncremental,
  standardFace,
  subsetEmbeddedFaces,
} from './mupdf-write';

function notoRegular(): Uint8Array<ArrayBuffer> {
  const file = createRequire(import.meta.url).resolve(
    '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
    { paths: [process.cwd()] },
  );
  return new Uint8Array(readFileSync(file));
}

function failureOf(task: () => unknown): ToolError {
  try {
    task();
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

beforeEach(() => {
  const font = notoRegular();
  vi.stubGlobal('fetch', async () => new Response(font));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveIncremental', () => {
  it('appends to a file MuPDF can append to, and rewrites one it had to repair', () => {
    const doc = new PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 100, 100], 0, {}, ''));
    const clean = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();

    const open = PDFDocument.openDocument(clean.slice(), 'application/pdf').asPDF();
    if (open === null) throw new Error('not a PDF');
    const appended = saveIncremental(open, 'test');
    open.destroy();
    expect(appended.byteLength).toBeGreaterThan(clean.byteLength);
    expect(new TextDecoder().decode(appended.slice(0, clean.byteLength))).toBe(
      new TextDecoder().decode(clean),
    );

    // A cross-reference table that points nowhere: MuPDF repairs the file on open.
    const text = new TextDecoder().decode(clean).replace(/startxref\s+\d+/, 'startxref\n7');
    const repaired = PDFDocument.openDocument(new TextEncoder().encode(text), 'application/pdf').asPDF();
    if (repaired === null) throw new Error('not a PDF');
    expect(repaired.canBeSavedIncrementally()).toBe(false);
    const rewritten = saveIncremental(repaired, 'test');
    repaired.destroy();
    expect(new TextDecoder().decode(rewritten.slice(0, 5))).toBe('%PDF-');
    expect(rewritten.byteLength).not.toBeGreaterThan(text.length + 400);
  });

  it('maps an engine failure while appending to a tool error naming the context', () => {
    const doc = new PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 100, 100], 0, {}, ''));
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const open = PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
    if (open === null) throw new Error('not a PDF');
    const broken = new Proxy(open, {
      get(target, property) {
        if (property === 'setMetaData') {
          return () => {
            throw new Error('cannot set metadata');
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(failureOf(() => saveIncremental(broken, 'my step')).details.engineMessage).toBe(
      'my step: cannot set metadata',
    );
    open.destroy();
  });
});

describe('page resources and contents', () => {
  it('gives a page that inherits its resources a copy of its own, leaving the siblings alone', () => {
    const doc = new PDFDocument();
    const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    doc.insertPage(0, doc.addPage([0, 0, 100, 100], 0, {}, ''));
    doc.insertPage(1, doc.addPage([0, 0, 100, 100], 0, {}, ''));
    const pages = doc.getTrailer().get('Root').get('Pages');
    pages.put('Resources', { Font: { F1: font } });
    const first = doc.findPage(0);
    const second = doc.findPage(1);
    first.delete('Resources');
    second.delete('Resources');

    const own = pageResources(doc, first);
    own.put('XObject', doc.newDictionary());
    expect(own.get('Font').isDictionary()).toBe(true);
    expect(first.get('Resources').get('XObject').isDictionary()).toBe(true);
    expect(pages.get('Resources').get('XObject').isNull()).toBe(true);
    // A page that already owns its resources gets them back as they are.
    expect(pageResources(doc, first).get('XObject').isDictionary()).toBe(true);
    doc.destroy();
  });

  it('gives a page with no resources at all an empty set of its own', () => {
    const doc = new PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 100, 100], 0, {}, ''));
    const page = doc.findPage(0);
    page.delete('Resources');
    expect(pageResources(doc, page).isDictionary()).toBe(true);
    doc.destroy();
  });

  it('reads the content parts of a page: none, one stream, an array of streams, or an entry that is no stream', () => {
    const doc = new PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 100, 100], 0, {}, '0 0 m'));
    const page = doc.findPage(0);
    expect((pageContentParts(page) as Uint8Array[]).map((part) => new TextDecoder().decode(part))).toEqual([
      '0 0 m',
    ]);
    const two = doc.newArray();
    two.push(doc.addStream('q', {}));
    two.push(doc.addStream('Q', {}));
    page.put('Contents', two);
    expect((pageContentParts(page) as Uint8Array[]).map((part) => new TextDecoder().decode(part))).toEqual([
      'q',
      'Q',
    ]);
    const broken = doc.newArray();
    broken.push(doc.newInteger(3));
    page.put('Contents', broken);
    expect(pageContentParts(page)).toBe('unreadable');
    page.delete('Contents');
    expect(pageContentParts(page)).toBeNull();
    doc.destroy();
  });

  it('turns a page without contents or resources into an empty form, and refuses one whose contents are not streams', () => {
    const source = new PDFDocument();
    source.insertPage(0, source.addPage([0, 0, 100, 100], 0, {}, ''));
    const page = source.findPage(0);
    page.delete('Contents');
    page.delete('Resources');
    const target = new PDFDocument();
    const graft = target.newGraftMap();
    const form = pageAsForm(target, graft, page, { x: 5, y: 6, width: 10, height: 20 });
    expect(form.get('Subtype').asName()).toBe('Form');
    expect(form.get('BBox').length).toBe(4);
    expect(form.get('Resources').isDictionary()).toBe(true);

    const broken = source.newArray();
    broken.push(source.newInteger(3));
    page.put('Contents', broken);
    expect(failureOf(() => pageAsForm(target, graft, page, { x: 0, y: 0, width: 1, height: 1 })).code).toBe(
      'unsupported',
    );
    source.destroy();
    target.destroy();
  });
});

describe('fonts', () => {
  it('embeds the semi-bold face when asked, and says whether it covers a text', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const regular = await embedNotoSans(mupdf, doc);
    const bold = await embedNotoSans(mupdf, doc, { bold: true });
    expect(regular.name).toBe('NotoSans');
    expect(bold.name).toBe('NotoSans-SemiBold');
    expect(regular.covers('Çağrı Işık 123')).toBe(true);
    expect(regular.covers('日本語')).toBe(false);
    expect(regular.covers('   ')).toBe(true);
    expect(regular.encode('Ab')).toMatch(/^<[0-9a-f]{8}>$/);
    expect(regular.widthOfTextAtSize('Ab', 10)).toBeGreaterThan(0);
    expect(regular.heightAtSize(10)).toBeGreaterThan(regular.heightAtSize(10, { descender: false }));
    expect(regular.usedGlyphs()).toHaveLength(2);
    doc.destroy();
  });

  it('refuses bytes that are not a font, and a program cut inside its tables', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const notFont = failureOf(() => embedFontFile(mupdf, doc, 'Broken', new Uint8Array([1, 2, 3, 4])));
    expect(notFont.details.engineMessage).toContain('embed-font');
    // A program cut inside its tables: the engine names the table it misses.
    const cut = failureOf(() => embedFontFile(mupdf, doc, 'Cut', notoRegular().slice(0, 5000)));
    expect(cut.details.engineMessage).toContain('hmtx');
    doc.destroy();
  });

  it('keeps the whole program of a face that cannot be subset or does not shrink', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 100, 100], 0, {}, ''));
    const face = await embedNotoSans(mupdf, doc);
    face.encode('ab');
    const first = subsetEmbeddedFaces(mupdf, doc, [face]);
    expect(first).toBeGreaterThan(100_000);
    // Already a subset of exactly these glyphs: nothing more to save.
    expect(subsetEmbeddedFaces(mupdf, doc, [face])).toBe(0);

    // A face whose reference is no font, one without a program, and one whose program is garbage.
    const notAFont = doc.newInteger(3);
    const dictionary = doc.addObject({});
    const noProgram = doc.addObject({ Type: 'Font', FontDescriptor: doc.addObject({}) });
    const garbageDescriptor = doc.addObject({ FontFile2: doc.addStream('not a font program', {}) });
    const garbage = doc.addObject({ Type: 'Font', FontDescriptor: garbageDescriptor });
    const fake = (ref: ReturnType<typeof doc.addObject>) => ({ ...face, ref, usedGlyphs: () => [3, 4] });
    expect(
      subsetEmbeddedFaces(mupdf, doc, [fake(notAFont), fake(dictionary), fake(noProgram), fake(garbage)]),
    ).toBe(0);
    doc.destroy();
  });
});

describe('standard faces', () => {
  it('registers a standard-14 face, encodes WinAnsi and writes a question mark where it has no code', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const face = standardFace(mupdf, doc, 'Helvetica');
    expect(face.canEncode('Çay €')).toBe(true);
    expect(face.canEncode('ğ')).toBe(false);
    expect(canEncodeWinAnsi('')).toBe(true);
    expect(face.encode('A€ğ')).toBe('<41803f>');
    doc.destroy();
  });

  it('maps a face the engine does not know to a tool error', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    expect(
      failureOf(() => standardFace(mupdf, doc, 'No-Such-Face-Anywhere')).details.engineMessage,
    ).toContain('standard font No-Such-Face-Anywhere');
    doc.destroy();
  });
});

describe('Font object', () => {
  it('is the real engine Font (guard for the stand-ins above)', () => {
    expect(new Font('Helvetica').getName()).toBe('Helvetica');
  });
});
