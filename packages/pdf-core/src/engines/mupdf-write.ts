/**
 * MuPDF as the **writer** (the pdf-lib → MuPDF consolidation, 2026-09-28).
 *
 * Every operation that used to load a document with pdf-lib, edit its object graph and
 * save it now does the same through MuPDF's own object model. One engine then parses,
 * edits, verifies and serialises: the document a writer reads back is the document the
 * engine wrote, with no second parser's idea of the file in between.
 *
 * This module is the small vocabulary the writers share, and the rules that are easy to
 * get wrong with MuPDF's JavaScript binding:
 *
 * - **A plain JS string becomes a PDF *name*.** `obj.put('Title', 'Rapor')` writes
 *   `/Title /Rapor`, a name, and a reader shows no title at all. Every text value goes
 *   through {@link text} (`doc.newString`, which picks PDFDocEncoding or UTF-16BE).
 * - **Integers and reals are told apart by value.** `0.5` is a real, `1` an integer —
 *   which is what PDF wants, so numbers need no wrapper.
 * - **A missing key is the shared `PDFObject.Null`, which has no document**: calling
 *   `resolve()` or `get()` on it throws. Every lookup goes through {@link resolved}.
 * - **A stream is a stream only by reference.** `isStream()` and `readStream()` work on
 *   the indirect object; the dictionary `resolve()` returns is not a stream. Test and read
 *   streams on the entry itself (after an `isNull()` check), never on its resolved value.
 * - **Nothing is written until {@link saveRewrite}**, and every document opened here is
 *   destroyed by the caller: wasm memory is not garbage-collected.
 *
 * The save is a full rewrite with unused objects collected and streams compressed —
 * the shape pdf-lib's save had — but **object numbers are kept** (`garbage` without
 * `compact`): a writer that resolves an annotation by reference and a second step that
 * acts on it must see the same numbers.
 */

import type { Font, PDFDocument, PDFGraftMap, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { metricsFor } from 'pdf-text-engine';
import { note, type OperationNote } from '../ops/types';
import { loadMupdf, type Mupdf, mapMupdfError, openPdf, savePdf } from './mupdf';
import { notoSansBytes } from './noto';

/**
 * The producer line every writer merges back in — product policy:
 * `clean` never removes it. Defined here, where it is written, and re-exported by
 * `ops/metadata.ts` for the operations that report it.
 */
export const PRODUCER_LINE = 'SsPdfEditor (MuPDF 1.28)';

/**
 * The report line every rewrite adds: the producer the file now carries. One builder, because
 * the message has a `{producer}` slot and a writer that called `note()` without it printed
 * the placeholder itself (watermark, numbering, N-up).
 */
export function producerKeptNote(): OperationNote {
  return note('preserved', 'op.note.metadata.producerKept', { producer: PRODUCER_LINE });
}

/** Full rewrite, unused objects dropped, streams compressed; object numbers kept. */
export const MUPDF_REWRITE_OPTIONS = 'garbage,compress';

/** A document opened for writing, with the module it came from. */
export interface WritableDocument {
  readonly mupdf: Mupdf;
  readonly doc: PDFDocument;
}

/**
 * Open bytes for editing. The caller destroys `doc` (normally in a `finally`).
 *
 * A document that needs a password to be read is refused (`encrypted-unsupported`):
 * its objects cannot be read, so an edit would be written over content the writer never
 * saw. A document encrypted with an owner password only opens and is saved with its
 * encryption kept — that is MuPDF's default for a save.
 */
export async function openForWrite(bytes: Uint8Array): Promise<WritableDocument> {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  if (doc.needsPassword()) {
    doc.destroy();
    throw new ToolError('encrypted-unsupported', {
      engine: 'mupdf',
      engineMessage: 'the document needs a password to be read',
    });
  }
  return { mupdf, doc };
}

/**
 * Serialise the edited document: the producer line is set first ({@link PRODUCER_LINE}),
 * then the file is rewritten — with {@link MUPDF_REWRITE_OPTIONS} unless a writer that
 * owns the whole file (compression) passes its own measured option string.
 */
export function saveRewrite(doc: PDFDocument, context = 'save', options = MUPDF_REWRITE_OPTIONS): Uint8Array {
  try {
    doc.setMetaData('info:Producer', PRODUCER_LINE);
    return savePdf(doc, options);
  } catch (error) {
    throw mapMupdfError(error, context);
  }
}

/**
 * Serialise the edited document as an incremental update: every byte of the input stays and
 * the changed objects are appended, so a signature over the input keeps covering what it
 * signed. When MuPDF cannot append (`canBeSavedIncrementally()` is false — a repaired file,
 * or after `applyRedactions()`, where an append would keep the erased revision), the file is
 * rewritten instead; callers that must never rewrite check that themselves first.
 */
export function saveIncremental(doc: PDFDocument, context = 'save'): Uint8Array {
  if (!doc.canBeSavedIncrementally()) return saveRewrite(doc, context);
  try {
    doc.setMetaData('info:Producer', PRODUCER_LINE);
    return savePdf(doc, 'incremental');
  } catch (error) {
    throw mapMupdfError(error, context);
  }
}

/**
 * Carry a document's Info into a file another writer produced: title, author, subject,
 * keywords and creator as they are, and the two dates when they are PDF dates (a
 * malformed date is not carried over). The producer line is set when `target` is saved.
 */
export function copyDocumentInfo(source: PDFDocument, target: PDFDocument): void {
  for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator']) {
    const value = source.getMetaData(`info:${key}`);
    if (value !== undefined && value !== '') target.setMetaData(`info:${key}`, value);
  }
  for (const key of ['CreationDate', 'ModDate']) {
    const value = source.getMetaData(`info:${key}`)?.trim();
    if (value !== undefined && /^D:\d{4}/.test(value)) target.setMetaData(`info:${key}`, value);
  }
}

/** A text string (never a name): PDFDocEncoding when it fits, UTF-16BE otherwise. */
export function text(doc: PDFDocument, value: string): PDFObject {
  return doc.newString(value);
}

/**
 * The object an entry refers to, or `null` when the entry is missing or a PDF null. Not
 * for streams: see the header.
 */
export function resolved(object: PDFObject | null | undefined): PDFObject | null {
  if (object === null || object === undefined || object.isNull()) return null;
  const target = object.resolve();
  return target.isNull() ? null : target;
}

/** The text a string object carries, or `null` for anything that is not a string. */
export function readText(object: PDFObject | null | undefined): string | null {
  const target = resolved(object);
  return target?.isString() === true ? target.asString() : null;
}

/** The name an object carries (without the slash), or `null`. */
export function readName(object: PDFObject | null | undefined): string | null {
  const target = resolved(object);
  return target?.isName() === true ? target.asName() : null;
}

/** Every number of an array, in order; non-numbers are skipped. */
export function readNumbers(object: PDFObject | null | undefined): number[] {
  const target = resolved(object);
  if (target === null || !target.isArray()) return [];
  const out: number[] = [];
  for (let index = 0; index < target.length; index += 1) {
    const entry = resolved(target.get(index));
    if (entry?.isNumber() === true) out.push(entry.asNumber());
  }
  return out;
}

/** A PDF date string (`D:YYYYMMDDHHmmSSZ`) in UTC — the form pdf-lib's `fromDate` wrote. */
export function pdfDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const day = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
  const time = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `D:${day}${time}Z`;
}

/** The page dictionaries, in page order. */
export function pageObjects(doc: PDFDocument): PDFObject[] {
  const pages: PDFObject[] = [];
  const count = doc.countPages();
  for (let index = 0; index < count; index += 1) pages.push(doc.findPage(index));
  return pages;
}

/**
 * The page's visible box — `/CropBox`, `/MediaBox` when there is none, both inheritable —
 * normalised to `{ x, y, width, height }` in PDF user space. A page with neither is US
 * Letter, the default MuPDF itself applies.
 */
export function visibleBox(page: PDFObject): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} {
  const corners = [
    readNumbers(page.getInheritable('CropBox')),
    readNumbers(page.getInheritable('MediaBox')),
  ].find((values) => values.length >= 4) ?? [0, 0, 612, 792];
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = corners;
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

/** The page's `/Annots` array, created when `create` is set and it is missing. */
export function annotsOf(doc: PDFDocument, page: PDFObject, create = false): PDFObject | null {
  const existing = resolved(page.get('Annots'));
  if (existing?.isArray() === true) return existing;
  if (!create) return null;
  const array = doc.addObject(doc.newArray());
  page.put('Annots', array);
  return array.resolve();
}

/**
 * The dictionary under `key`, created (direct, in `parent`) when it is missing. Not for
 * streams: see the header.
 */
export function dictionaryIn(doc: PDFDocument, parent: PDFObject, key: string): PDFObject {
  const existing = resolved(parent.get(key));
  if (existing?.isDictionary() === true) return existing;
  const created = doc.newDictionary();
  parent.put(key, created);
  return parent.get(key);
}

/** The array under `key`, created (direct, in `parent`) when it is missing. */
export function arrayIn(doc: PDFDocument, parent: PDFObject, key: string): PDFObject {
  const existing = resolved(parent.get(key));
  if (existing?.isArray() === true) return existing;
  parent.put(key, doc.newArray());
  return parent.get(key);
}

/**
 * The page's **own** `/Resources`. A page that inherits its resources from a `/Pages`
 * node gets a shallow copy of them first, so a name added for this page is not added to
 * every sibling that shares the node.
 */
export function pageResources(doc: PDFDocument, page: PDFObject): PDFObject {
  const own = resolved(page.get('Resources'));
  if (own?.isDictionary() === true) return own;
  const copy = doc.newDictionary();
  const inherited = resolved(page.getInheritable('Resources'));
  if (inherited?.isDictionary() === true) {
    inherited.forEach((value, key) => {
      copy.put(key, value);
    });
  }
  page.put('Resources', copy);
  return page.get('Resources');
}

/**
 * Register `value` under a fresh name in the page's `/Resources /<category>` and return
 * that name (`prefix`, `prefix1`, `prefix2`, … — never an existing entry).
 */
export function addPageResource(
  doc: PDFDocument,
  page: PDFObject,
  category: 'Font' | 'XObject' | 'ExtGState' | 'Properties',
  prefix: string,
  value: PDFObject,
): string {
  const entries = dictionaryIn(doc, pageResources(doc, page), category);
  let name = prefix;
  for (let suffix = 1; !entries.get(name).isNull(); suffix += 1) name = `${prefix}${suffix}`;
  entries.put(name, value);
  return name;
}

/**
 * Put the page's existing content between `before` and `after`, each a stream of its own
 * (`q 1 0 0 1 x y cm` … `Q` moves everything drawn). Nothing already on the page is
 * re-encoded. A second call wraps the first, so its `before` runs first: wrapping a
 * translation and then a scale composes to `p → s·(p + t)`.
 */
export function wrapPageContent(doc: PDFDocument, page: PDFObject, before: string, after: string): void {
  const existing = page.get('Contents');
  const contents = doc.newArray();
  // The existing content gets its own `q`/`Q` too, so a transform it leaves set cannot
  // leak into `after`.
  contents.push(doc.addStream(`${before}\nq\n`, {}));
  if (!existing.isNull()) {
    const target = existing.isStream() ? null : resolved(existing);
    if (target?.isArray() === true) {
      for (let index = 0; index < target.length; index += 1) contents.push(target.get(index));
    } else {
      contents.push(existing);
    }
  }
  contents.push(doc.addStream(`\nQ\n${after}\n`, {}));
  page.put('Contents', contents);
}

/**
 * The decoded bytes of each stream in a page's `/Contents` (one stream or an array of
 * them), in order; `null` when the page has no contents, `'unreadable'` when an entry is
 * not a stream.
 */
export function pageContentParts(page: PDFObject): Uint8Array[] | null | 'unreadable' {
  const contents = page.get('Contents');
  if (contents.isNull()) return null;
  const entries: PDFObject[] = [];
  const target = contents.isStream() ? null : resolved(contents);
  if (target?.isArray() === true) {
    for (let index = 0; index < target.length; index += 1) entries.push(target.get(index));
  } else {
    entries.push(contents);
  }
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    if (!entry.isStream()) return 'unreadable';
    const buffer = entry.readStream();
    try {
      parts.push(new Uint8Array(buffer.asUint8Array()));
    } finally {
      buffer.destroy();
    }
  }
  return parts;
}

/**
 * A page of another document as a form XObject of `target`: its content streams joined,
 * its resources grafted through `graft` (so a font or image two pages share is copied
 * once), `/BBox` the given box and `/Matrix` moving that box's corner to the origin. The
 * page's `/Rotate` is **not** applied and its annotations do not come along — the caller
 * turns the placement and reports the loss.
 */
export function pageAsForm(
  target: PDFDocument,
  graft: PDFGraftMap,
  page: PDFObject,
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): PDFObject {
  const parts = pageContentParts(page);
  if (parts === 'unreadable') {
    throw new ToolError('unsupported', {
      engine: 'mupdf',
      engineMessage: "a page's /Contents is not a stream that can be embedded",
    });
  }
  const content = parts ?? [];
  const joined = new Uint8Array(content.reduce((total, part) => total + part.length + 1, 0));
  let at = 0;
  for (const part of content) {
    joined.set(part, at);
    // A newline between parts: a stream boundary may fall between two operators.
    joined[at + part.length] = 0x0a;
    at += part.length + 1;
  }
  const resources = resolved(page.getInheritable('Resources'));
  return target.addStream(joined, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [box.x, box.y, box.x + box.width, box.y + box.height],
    Matrix: [1, 0, 0, 1, -box.x, -box.y],
    Resources: resources === null ? {} : graft.graftObject(page.getInheritable('Resources')),
  });
}

/** A content-stream number: six decimals at most, no trailing zeros, no `-0`. */
export function pdfNumber(value: number): string {
  const fixed = value.toFixed(6).replace(/\.?0+$/, '');
  return fixed === '-0' || fixed === '' ? '0' : fixed;
}

/**
 * Draw `operators` over the page. The existing content is wrapped in `q`/`Q` first — a
 * stream that leaves a transform or a colour set would otherwise shift or tint what is
 * appended — and the new operators go in a stream of their own after it. Nothing already
 * on the page is re-encoded.
 */
export function appendPageContent(doc: PDFDocument, page: PDFObject, operators: string): void {
  const existing = page.get('Contents');
  const contents = doc.newArray();
  const hasExisting = !existing.isNull();
  if (hasExisting) {
    contents.push(doc.addStream('q\n', {}));
    // A stream is a stream only by reference; an array is read on its resolved value.
    const target = existing.isStream() ? null : resolved(existing);
    if (target?.isArray() === true) {
      for (let index = 0; index < target.length; index += 1) contents.push(target.get(index));
    } else {
      contents.push(existing);
    }
  }
  contents.push(doc.addStream(`${hasExisting ? 'Q\n' : ''}${operators}\n`, {}));
  page.put('Contents', contents);
}

/**
 * An embedded face and what drawing text with it needs: the font resource, the glyph
 * encoding for a `Tj` operand, and widths/heights from the text engine's metric tables
 * (`pdf-text-engine > metricsFor`, over this same MuPDF font object), so line breaks stay
 * where the layout measured them.
 */
export interface EmbeddedFace {
  /** The `/Font` resource to reference from a resource dictionary. */
  readonly ref: PDFObject;
  /** The face's name, for the report (`NotoSans`, `NotoSans-SemiBold`). */
  readonly name: string;
  /** `<…>` hex operand for `Tj`: two-byte glyph ids (the resource is Identity-H). */
  encode(value: string): string;
  /** Whether the face has a glyph for every character (a missing one encodes as glyph 0). */
  covers(value: string): boolean;
  widthOfTextAtSize(value: string, size: number): number;
  /** Ascender only when `descender` is false; ascender minus descender otherwise. */
  heightAtSize(size: number, options?: { readonly descender?: boolean }): number;
  /** Every glyph id `encode` has handed out so far — the glyphs a subset must keep. */
  usedGlyphs(): readonly number[];
}

/** Embed the pinned Noto Sans (regular or semi-bold) into `doc`. */
export async function embedNotoSans(
  mupdf: Mupdf,
  doc: PDFDocument,
  options: { readonly bold?: boolean } = {},
): Promise<EmbeddedFace> {
  const bytes = await notoSansBytes(options.bold === true);
  return embedFontFile(mupdf, doc, options.bold === true ? 'NotoSans-SemiBold' : 'NotoSans', bytes);
}

/**
 * Embed a whole TrueType/OpenType program as an Identity-H font with a `/ToUnicode`
 * CMap (MuPDF's `addFont`), measured with the same metric tables the text engine uses.
 * `name` is what the report shows; a file that is not a font is `unsupported-format`.
 */
export function embedFontFile(mupdf: Mupdf, doc: PDFDocument, name: string, bytes: Uint8Array): EmbeddedFace {
  let font: Font;
  let ref: PDFObject;
  try {
    font = new mupdf.Font(name, bytes);
    ref = doc.addFont(font);
  } catch (error) {
    throw mapMupdfError(error, 'embed-font');
  }
  let metrics: ReturnType<typeof metricsFor>;
  try {
    metrics = metricsFor(font, bytes);
  } catch (error) {
    throw new ToolError(
      'unsupported-format',
      { engine: 'mupdf', engineMessage: `embed-font: ${name} has no readable metrics` },
      { cause: error },
    );
  }
  const scale = (size: number) => size / metrics.unitsPerEm;
  const used = new Set<number>();
  return {
    ref,
    name,
    encode(value) {
      let hex = '';
      for (const character of value) {
        const glyph = font.encodeCharacter(character.codePointAt(0) ?? 0);
        used.add(glyph);
        hex += glyph.toString(16).padStart(4, '0');
      }
      return `<${hex}>`;
    },
    usedGlyphs: () => [...used],
    covers(value) {
      for (const character of value) {
        if (/\s/.test(character)) continue;
        if (font.encodeCharacter(character.codePointAt(0) ?? 0) === 0) return false;
      }
      return true;
    },
    widthOfTextAtSize(value, size) {
      let units = 0;
      for (const character of value) units += metrics.glyphAdvance(character.codePointAt(0) ?? 0);
      return units * scale(size);
    },
    heightAtSize(size, heightOptions = {}) {
      const ascent = metrics.ascender * scale(size);
      return heightOptions.descender === false ? ascent : ascent - metrics.descender * scale(size);
    },
  };
}

/**
 * Replace each face's whole font program with a subset of the glyphs it drew.
 *
 * `embedFontFile` embeds the whole file — Noto Sans is 629 KB — and every save that
 * typed a word carried all of it. MuPDF can subset (`subsetFonts`), but only a whole
 * document at a time, and that would also cut and rename the fonts the document came
 * with: a form's `/DR` font would lose the glyphs a reader needs to type a new value.
 * So the subset is made **elsewhere**: the face is grafted into a scratch document
 * with one page that draws exactly the glyphs `encode` handed out, MuPDF subsets that
 * document, and the subset program and its tagged name (`ABCDEF+NotoSans`) are copied
 * back over this face alone. Glyph ids are kept (Identity-H draws by id), so the
 * content already written is untouched.
 *
 * A face this cannot subset keeps its whole program: the subset is a saving, never a
 * condition of the write. Returns the bytes of font program saved.
 */
export function subsetEmbeddedFaces(mupdf: Mupdf, doc: PDFDocument, faces: readonly EmbeddedFace[]): number {
  let saved = 0;
  for (const face of faces) {
    const descriptor = fontDescriptorOf(face.ref);
    const program = descriptor === null ? null : descriptor.get('FontFile2');
    if (descriptor === null || program === null || !program.isStream()) continue;
    const scratch = new mupdf.PDFDocument();
    try {
      const grafted = scratch.graftObject(face.ref);
      const glyphs = face.usedGlyphs();
      const shown = glyphs.map((glyph) => glyph.toString(16).padStart(4, '0')).join('');
      const resources = scratch.newDictionary();
      const fonts = scratch.newDictionary();
      fonts.put('F', grafted);
      resources.put('Font', fonts);
      scratch.insertPage(-1, scratch.addPage([0, 0, 612, 792], 0, resources, `BT /F 12 Tf <${shown}> Tj ET`));
      scratch.subsetFonts();
      const subsetDescriptor = fontDescriptorOf(grafted);
      const subsetProgram = subsetDescriptor?.get('FontFile2');
      if (subsetDescriptor === null || subsetProgram === undefined || !subsetProgram.isStream()) continue;
      const bytes = subsetProgram.readStream().asUint8Array().slice();
      const before = program.readStream().getLength();
      if (bytes.byteLength === 0 || bytes.byteLength >= before) continue;
      descriptor.put('FontFile2', doc.addStream(bytes, { Length1: bytes.byteLength }));
      const tagged = readName(subsetDescriptor.get('FontName'));
      if (tagged !== null) {
        descriptor.put('FontName', doc.newName(tagged));
        const type0 = resolved(face.ref);
        type0?.put('BaseFont', doc.newName(tagged));
        resolved(resolved(type0?.get('DescendantFonts'))?.get(0))?.put('BaseFont', doc.newName(tagged));
      }
      saved += before - bytes.byteLength;
    } catch {
      // The whole program stays; see above.
    } finally {
      scratch.destroy();
    }
  }
  return saved;
}

/** A Type0 font's descriptor (through its descendant), or a simple font's own. */
function fontDescriptorOf(font: PDFObject): PDFObject | null {
  const dict = resolved(font);
  if (dict === null || !dict.isDictionary()) return null;
  const descendant = resolved(resolved(dict.get('DescendantFonts'))?.get(0));
  const descriptor = resolved((descendant ?? dict).get('FontDescriptor'));
  return descriptor?.isDictionary() === true ? descriptor : null;
}

/** WinAnsiEncoding's 0x80–0x9F block: the code points it puts there (§D.2). */
const WIN_ANSI_HIGH: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/** A character's WinAnsi byte, or `null` when the encoding has no code for it. */
function winAnsiByte(codePoint: number): number | null {
  if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) return codePoint;
  return WIN_ANSI_HIGH.get(codePoint) ?? null;
}

/** Whether WinAnsiEncoding has a code for every character of the text. */
export function canEncodeWinAnsi(value: string): boolean {
  return [...value].every((character) => winAnsiByte(character.codePointAt(0) ?? 0) !== null);
}

/** A standard-14 text face, drawn through WinAnsiEncoding; nothing is embedded. */
export interface StandardFace {
  readonly ref: PDFObject;
  readonly name: string;
  /** Whether WinAnsi has a code for every character (`ğ ş ı İ` have none). */
  canEncode(value: string): boolean;
  /** `<…>` hex operand for `Tj`; call only when {@link canEncode} holds. */
  encode(value: string): string;
}

/** Register a standard-14 face (`Helvetica-Bold`, `Times-Roman`, …) with WinAnsiEncoding. */
export function standardFace(mupdf: Mupdf, doc: PDFDocument, name: string): StandardFace {
  let ref: PDFObject;
  try {
    ref = doc.addSimpleFont(new mupdf.Font(name), 'Latin');
  } catch (error) {
    throw mapMupdfError(error, `standard font ${name}`);
  }
  return {
    ref,
    name,
    canEncode: canEncodeWinAnsi,
    encode(value) {
      let hex = '';
      for (const character of value) {
        hex += (winAnsiByte(character.codePointAt(0) ?? 0) ?? 0x3f).toString(16).padStart(2, '0');
      }
      return `<${hex}>`;
    },
  };
}

/** A `ToolError` for a page index the document does not have. */
export function pageOutOfRange(pageIndex: number, context: string): ToolError {
  return new ToolError('range-invalid', {
    engine: 'mupdf',
    pageIndex,
    engineMessage: `${context}: page ${pageIndex} is outside the document`,
  });
}
