/**
 * Writing a PAdES B-B signature into a PDF.
 *
 * The operation is the last thing that may touch the file — the plan's save order says so
 * (“… metadata after the final MuPDF write, **signature last**”) — because
 * a signature covers the bytes it was made over: any later rewrite, even one that changes
 * nothing a reader sees, breaks it. Everything here is therefore arranged around one
 * number, the `/ByteRange`, and the file is serialised **once**, with the numbers written
 * into a fixed-width placeholder so nothing shifts after the fact:
 *
 *  1. the signature field, its appearance and the `/Sig` dictionary are built with
 *     `/Contents` and `/ByteRange` as zero-padded placeholders of fixed size;
 *  2. the document is serialised, and the placeholder is located in the produced bytes;
 *  3. the ByteRange is computed from those offsets and written over the same digits (a
 *     value that is not exactly as wide as the placeholder is refused);
 *  4. the range is hashed and signed (`signature-cms.ts`), and the CMS goes into the
 *     `/Contents` placeholder as hex.
 *
 * **A file that already carries a signature is extended, never rewritten.** A rewrite moves
 * every byte an earlier signature's `/ByteRange` covers, so step 2 then *appends* the new
 * field, appearance and signature as an incremental update (every byte of the input stays,
 * which is also what makes a counter-signature possible). Only a file MuPDF cannot append to
 * (one it had to repair on open) is rewritten, and the report then says in a `lost` note
 * that the earlier signatures no longer validate — the way `protectDocument` does.
 *
 * A 16 KiB `/Contents` reservation is the one number worth explaining: a 2048-bit RSA
 * PAdES B-B signature measures roughly 3–4 KB of DER with its certificate chain, and the
 * placeholder must be large enough that the CMS never has to be split. The bytes a reader
 * does not use are zero padding, which is what every signing tool writes.
 *
 * **What this module does not do:** it does not timestamp (B-T is helper-only), and
 * it does not decide what a signed document may be edited by — that is the session's rule:
 * a signed file is a *new version*, and the shell never pretends the working
 * document is the signed one.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  arrayIn,
  dictionaryIn,
  embedNotoSans,
  openForWrite,
  pageObjects,
  readName,
  readNumbers,
  readText,
  resolved,
  saveIncremental,
  saveRewrite,
  subsetEmbeddedFaces,
  text,
} from '../engines/mupdf-write';
import { detachedCmsSignature, type SignatureDigest, type SignatureIdentity } from '../signature-cms';
import { countSignedFields, verifySignatures } from './signature-status';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

/** The `/Contents` reservation, in bytes; the placeholder is twice that in hex characters. */
const CONTENTS_RESERVATION = 16 * 1024;
/**
 * Fixed width of every `/ByteRange` number, so writing the real values cannot move a byte.
 * Ten digits hold every offset a file can have here: the engine's memory ends at 4 GiB, far
 * below 10^10, so the zero-padded numbers always have the placeholder's width.
 */
const RANGE_DIGITS = 10;

export interface SignatureFieldRequest {
  /**
   * The field to fill, by its full name. With a name, only an *empty* signature field of that
   * name is filled; when the document has none, a new field is created under the name (a
   * name another field already uses is refused). Without a name, the first empty signature
   * field the document has is filled, and a new one is created when it has none.
   */
  readonly name?: string;
  /**
   * Where the visible signature goes, in PDF user space (bottom-left origin). Absent
   * leaves a new field invisible, which is what a machine-checked signature usually is.
   * An existing field that already has an area keeps the place its form gave it (the
   * report says so); one without an area is moved here, to `pageIndex`.
   */
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /**
   * Page for a new field, or for an existing field with no area of its own. Defaults to the
   * first page for a new field and to the field's own page for an existing one.
   */
  readonly pageIndex?: number;
  /** Lines drawn into the appearance, top to bottom (signer, date, reason). */
  readonly lines?: readonly string[];
}

export interface SignRequest {
  readonly identity: SignatureIdentity;
  readonly field?: SignatureFieldRequest;
  readonly digest?: SignatureDigest;
  readonly reason?: string;
  readonly location?: string;
  readonly contactInfo?: string;
  /** `/Name`: the signer as a human reads it (the certificate's CN, in practice). */
  readonly signerName?: string;
  /** The moment the signature claims; defaults to now. */
  readonly date?: Date;
}

/** A PDF date (§7.9.3.1), the form a signature dictionary's `/M` carries. */
function pdfDate(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** The lines a visible signature shows, when the caller did not say. */
function appearanceLines(request: SignRequest, date: Date): readonly string[] {
  const given = request.field?.lines;
  if (given !== undefined && given.length > 0) return given;
  return [
    ...(request.reason === undefined ? [] : [`${request.reason}`]),
    ...(request.location === undefined ? [] : [`${request.location}`]),
    pdfDate(date),
  ];
}

/** The most lines a visible stamp shows. */
const STAMP_ROWS = 6;

/**
 * A `/Sig` field's appearance: a form XObject drawing the lines.
 *
 * A stamp of printable ASCII is drawn in Helvetica, a **standard-14** face: nothing is
 * embedded and every reader has it, which keeps the common file small and portable. A line
 * with any other letter (`ş`, `İ`, `ğ`) is outside what that face spells, so the stamp is
 * drawn in the embedded Noto Sans instead, cut to the glyphs it shows. A character that face
 * lacks, a control character or a space other than the plain one is drawn as `?`.
 */
async function appearance(
  doc: PDFDocument,
  rect: { readonly width: number; readonly height: number },
  lines: readonly string[],
): Promise<PDFObject> {
  const rows = lines.slice(0, STAMP_ROWS);
  const mupdf = await loadMupdf();
  const face = rows.some((line) => /\P{ASCII}/u.test(line)) ? await embedNotoSans(mupdf, doc) : null;
  const escapeLiteral = (text: string): string => text.replace(/[\\()]/g, (character) => `\\${character}`);
  const drawable = (character: string): boolean =>
    /[\x20-\x7e]/.test(character) ||
    (face !== null && !/[\p{C}\p{Z}]/u.test(character) && face.covers(character));
  const safe = (text: string): string =>
    Array.from(text, (character) => (drawable(character) ? character : '?')).join('');
  const operand = (text: string): string =>
    face === null ? `(${escapeLiteral(safe(text))})` : face.encode(safe(text));
  const step = 11;
  const size = rows.length > 3 ? 8 : 9;
  const top = rect.height - 12;
  const body = rows
    .map((line, index) => {
      const y = top - index * step;
      if (y < 6) return '';
      return `BT /Stamp ${size} Tf 0 0 0 rg 6 ${y.toFixed(2)} Td ${operand(line)} Tj ET\n`;
    })
    .join('');
  if (face !== null) subsetEmbeddedFaces(mupdf, doc, [face]);
  return doc.addStream(`0.92 0.92 0.92 rg 0.75 w 0 0 ${rect.width} ${rect.height} re B\n0 0 0 rg\n${body}`, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, rect.width, rect.height],
    Resources: {
      Font: {
        Stamp: face?.ref ?? {
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          Encoding: 'WinAnsiEncoding',
        },
      },
    },
  });
}

/** How deep a field tree is followed; a deeper one is a loop or an attack, not a form. */
const MAX_FIELD_DEPTH = 32;

/** A signature field the operation writes into, and the page it sits on. */
interface SignatureTarget {
  readonly dict: PDFObject;
  readonly pageIndex: number;
}

/** An empty field the document already had, with its place in the page's `/Annots`. */
interface ExistingField extends SignatureTarget {
  readonly annots: PDFObject;
  readonly annotIndex: number;
}

/**
 * A field's full name (§12.7.4.2): its own `/T` after those of its `/Parent`s, outermost
 * first, joined by periods — the name the verifier reports the signature under. An empty
 * `/T` counts as no name, as it does there.
 */
function qualifiedName(dict: PDFObject): string {
  const parts: string[] = [];
  let node: PDFObject | null = dict;
  for (let depth = 0; node?.isDictionary() === true && depth < MAX_FIELD_DEPTH; depth += 1) {
    const own = readText(node.get('T'));
    if (own !== null && own !== '') parts.unshift(own);
    node = resolved(node.get('Parent'));
  }
  return parts.join('.');
}

/** Every full field name the document uses: the `/AcroForm` tree and the widgets the pages carry. */
function usedFieldNames(doc: PDFDocument): ReadonlySet<string> {
  const names = new Set<string>();
  const seen = new Set<number>();
  const walk = (entry: PDFObject, prefix: string, depth: number): void => {
    const dict = resolved(entry);
    if (dict === null || !dict.isDictionary() || depth > MAX_FIELD_DEPTH) return;
    if (entry.isIndirect()) {
      if (seen.has(entry.asIndirect())) return;
      seen.add(entry.asIndirect());
    }
    const own = readText(dict.get('T'));
    const name = own === null || own === '' ? prefix : prefix === '' ? own : `${prefix}.${own}`;
    if (name !== '') names.add(name);
    const kids = resolved(dict.get('Kids'));
    if (kids?.isArray() !== true) return;
    for (let index = 0; index < kids.length; index += 1) walk(kids.get(index), name, depth + 1);
  };
  // Every PDF the engine opens has a catalog: a file without one is refused at open.
  const form = resolved(doc.getTrailer().get('Root').get('AcroForm'));
  const fields = resolved(form?.get('Fields'));
  if (fields?.isArray() === true) {
    for (let index = 0; index < fields.length; index += 1) walk(fields.get(index), '', 0);
  }
  for (const page of pageObjects(doc)) {
    const annots = annotsOf(doc, page);
    if (annots === null) continue;
    for (let index = 0; index < annots.length; index += 1) {
      const dict = resolved(annots.get(index));
      if (dict === null || !dict.isDictionary() || readName(dict.get('Subtype')) !== 'Widget') continue;
      const name = qualifiedName(dict);
      if (name !== '') names.add(name);
    }
  }
  return names;
}

/**
 * The empty signature field to fill: the one with the full name `name` when the caller named
 * one — and no other, a field of another name is not the caller's to fill — else the first
 * the document has. `null` when there is none.
 */
function existingSignatureField(doc: PDFDocument, name: string | undefined): ExistingField | null {
  for (const [pageIndex, page] of pageObjects(doc).entries()) {
    const annots = annotsOf(doc, page);
    if (annots === null) continue;
    for (let annotIndex = 0; annotIndex < annots.length; annotIndex += 1) {
      const dict = resolved(annots.get(annotIndex));
      if (dict === null || !dict.isDictionary()) continue;
      const isWidget = readName(dict.get('Subtype')) === 'Widget';
      const isSignature = readName(dict.get('FT')) === 'Sig';
      if (!isWidget || !isSignature || !dict.get('V').isNull()) continue;
      if (name === undefined || qualifiedName(dict) === name) return { dict, pageIndex, annots, annotIndex };
    }
  }
  return null;
}

/** The page `pageIndex` names, or `value-out-of-range` when the document has no such page. */
function pageAt(doc: PDFDocument, pageIndex: number): PDFObject {
  const pages = pageObjects(doc);
  const page = pages[pageIndex];
  if (!Number.isInteger(pageIndex) || page === undefined) {
    throw new ToolError('value-out-of-range', {
      engine: 'mupdf',
      path: 'request.field.pageIndex',
      engineMessage: `page ${pageIndex} is outside 0…${pages.length - 1}`,
    });
  }
  return page;
}

/**
 * The name a new field takes: the one asked for, which no field may already use (two fields
 * of one name are one field to a reader), or a fresh `Signature<n>` when none was asked for.
 */
function newFieldName(used: ReadonlySet<string>, wanted: string | undefined): string {
  if (wanted !== undefined) {
    if (used.has(wanted)) {
      throw new ToolError('value-out-of-range', {
        engine: 'mupdf',
        path: 'request.field.name',
        engineMessage: `a field named ${wanted} already exists and is not an empty signature field`,
      });
    }
    return wanted;
  }
  let number = Math.floor(Date.now() / 1000);
  while (used.has(`Signature${number}`)) number += 1;
  return `Signature${number}`;
}

/** The area a widget's `/Rect` encloses, or `null` for a widget with none (a hidden signature field). */
function areaOf(dict: PDFObject): { x: number; y: number; width: number; height: number } | null {
  const [x0, y0, x1, y1] = readNumbers(dict.get('Rect'));
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) return null;
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  return width > 0 && height > 0 ? { x: Math.min(x0, x1), y: Math.min(y0, y1), width, height } : null;
}

/**
 * Give a field the document already had the look of the signature that fills it: an
 * appearance (`/AP`) drawn from `lines`, at the area the field has.
 *
 * The field keeps the page and the place its form gave it: someone laid the form out for the
 * signature to go there, and a stamp corner picked in a dialog does not know that. A field
 * with no area at all (a hidden one) is the exception — the caller's rectangle is the only
 * way to make it visible, so the field moves to it, onto the caller's page when that differs.
 * Returns `true` when the field kept its own place over a rectangle the caller gave, so the
 * report can say that this one was not used.
 */
async function dressExistingField(
  doc: PDFDocument,
  field: ExistingField,
  request: SignatureFieldRequest,
  lines: readonly string[],
): Promise<boolean> {
  const own = areaOf(field.dict);
  const asked = request.rect;
  if (own !== null) {
    field.dict.put('AP', { N: await appearance(doc, own, lines) });
    return asked !== undefined;
  }
  if (asked === undefined) return false;

  const pageIndex = request.pageIndex ?? field.pageIndex;
  const page = pageAt(doc, pageIndex);
  if (pageIndex !== field.pageIndex) {
    const entry = field.annots.get(field.annotIndex);
    field.annots.delete(field.annotIndex);
    annotsOf(doc, page, true)?.push(entry);
    field.dict.put('P', page);
  }
  field.dict.put('Rect', [asked.x, asked.y, asked.x + asked.width, asked.y + asked.height]);
  field.dict.put('AP', { N: await appearance(doc, asked, lines) });
  return false;
}

/** A fresh `/Widget` + `/FT /Sig` field, wired into the page and the `/AcroForm`. */
async function createSignatureField(
  doc: PDFDocument,
  request: SignatureFieldRequest,
  name: string,
  lines: readonly string[],
): Promise<SignatureTarget> {
  const pageIndex = request.pageIndex ?? 0;
  const page = pageAt(doc, pageIndex);
  const rect = request.rect;
  const box: [number, number, number, number] =
    rect === undefined ? [0, 0, 0, 0] : [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];

  const dict = doc.addObject({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    // Text, never a name: a plain string would be written as `/T /Imza1`, which no
    // reader — this product's own verifier included — reads as the field's name.
    T: text(doc, name),
    // §12.5.3 Table 165: `Print` (4) and `Locked` (128) — a signature widget is printed,
    // and its content is the signature itself.
    F: 132,
    Rect: box,
    P: page,
  });
  if (rect !== undefined) dict.put('AP', { N: await appearance(doc, rect, lines) });
  annotsOf(doc, page, true)?.push(dict);

  // Every PDF the engine opens has a catalog: a file without one is refused at open.
  const catalog = doc.getTrailer().get('Root');
  if (resolved(catalog.get('AcroForm'))?.isDictionary() !== true) catalog.put('AcroForm', doc.addObject({}));
  const acroForm = dictionaryIn(doc, catalog, 'AcroForm');
  arrayIn(doc, acroForm, 'Fields').push(dict);
  // `SigFlags 3` is "SignaturesExist | AppendOnly" (§12.7.2 Table 219): the file states
  // that it carries signatures, which is what a reader needs to offer verification.
  acroForm.put('SigFlags', 3);
  return { dict: dict.resolve(), pageIndex };
}

/** Find a byte sequence in a larger one; `-1` when it is not there. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let at = from; at + needle.length <= haystack.length; at += 1) {
    for (let step = 0; step < needle.length; step += 1) {
      if (haystack[at + step] !== needle[step]) continue outer;
    }
    return at;
  }
  return -1;
}

/** The last occurrence of `needle` at or before `limit`; `-1` when there is none. */
function lastIndexOfBytes(haystack: Uint8Array, needle: Uint8Array, limit: number): number {
  for (let at = Math.min(limit, haystack.length - needle.length); at >= 0; at -= 1) {
    let matches = true;
    for (let step = 0; step < needle.length; step += 1) {
      if (haystack[at + step] !== needle[step]) {
        matches = false;
        break;
      }
    }
    if (matches) return at;
  }
  return -1;
}

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/**
 * The `/ByteRange` text that goes over the placeholder: four numbers zero-padded to
 * `RANGE_DIGITS`. It has to be **exactly** as wide as the placeholder (`placeholderLength`
 * characters) — writing it must not move a single byte, or every offset in it is wrong — so a
 * number too large for the width (padding never truncates) is refused instead of written.
 */
export function byteRangeText(
  range: readonly [number, number, number, number],
  placeholderLength: number,
): string {
  const written = `[${range.map((value) => String(value).padStart(RANGE_DIGITS, '0')).join(' ')}]`;
  if (written.length !== placeholderLength) {
    throw new ToolError('internal', {
      engine: 'mupdf',
      engineMessage:
        `the /ByteRange ${written} is ${written.length} characters wide but the placeholder it ` +
        `overwrites is ${placeholderLength}`,
    });
  }
  return written;
}

export async function signPdf(
  bytes: Uint8Array,
  request: SignRequest,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const date = request.date ?? new Date();
  const { doc } = await openForWrite(bytes);
  const steps: string[] = ['load'];
  const notes: OperationNote[] = [];
  let produced: Uint8Array;
  let pageCount: number;
  /** Whether the new signature is appended after signatures the input already carries. */
  let appended = false;
  /** The full name of the field written, which is how the produced file's verdicts tell it from the rest. */
  let fieldName = '';
  /**
   * The two placeholders, both **fixed width**, so writing the real numbers later cannot
   * move a single byte:
   *
   *  - `/ByteRange` is four integers of `RANGE_DIGITS` digits each (`2000000000`), which the
   *    writer prints as they are; the real, zero-padded values have the same width;
   *  - `/Contents` is a byte string of zeros, which the writer prints as a hex string of
   *    zeros (it is binary, so never a literal).
   *
   * The rewrite uses no object streams, so the signature dictionary is plain bytes a
   * verifier (and this module) can find and fill.
   */
  const rangePlaceholderValue = 2 * 10 ** (RANGE_DIGITS - 1);
  const rangePlaceholderText = `[${Array.from({ length: 4 }, () => String(rangePlaceholderValue)).join(' ')}]`;
  const contentsMarkerText = `<${'0'.repeat(CONTENTS_RESERVATION * 2)}>`;
  try {
    if (!doc.getTrailer().get('Encrypt').isNull()) {
      // An encrypted file would encrypt the placeholders too: the zeros could not be
      // found, and the signed bytes would not be the bytes a reader decrypts.
      throw new ToolError('encrypted-unsupported', {
        engine: 'mupdf',
        engineMessage: 'sign: remove the encryption first; a signature covers the stored bytes',
      });
    }
    pageCount = doc.countPages();
    const form = resolved(doc.getTrailer().get('Root').get('AcroForm'));
    if (resolved(form?.get('Fields'))?.isArray() === true) {
      context.onProgress?.({ phase: 'sign', labelKey: 'op.progress.sign.prepare', done: 0, total: 1 });
    }

    // A rewrite would move every byte an earlier signature covers, so a signed file is
    // appended to whenever MuPDF can; when it cannot, the rewrite goes ahead and says so.
    const earlier = countSignedFields(doc);
    appended = earlier > 0 && doc.canBeSavedIncrementally();

    const lines = appearanceLines(request, date);
    const asked = request.field ?? {};
    const wanted = asked.name === '' ? undefined : asked.name;
    const existing = existingSignatureField(doc, wanted);
    let target: SignatureTarget;
    let keptOwnPlace = false;
    if (existing === null) {
      target = await createSignatureField(doc, asked, newFieldName(usedFieldNames(doc), wanted), lines);
    } else {
      keptOwnPlace = await dressExistingField(doc, existing, asked, lines);
      target = existing;
    }
    fieldName = qualifiedName(target.dict);
    steps.push(existing === null ? 'field.create' : 'field.reuse');
    notes.push(
      note('changed', existing === null ? 'op.note.sign.fieldCreated' : 'op.note.sign.fieldFilled', {
        name: fieldName,
      }),
    );
    if (keptOwnPlace) notes.push(note('preserved', 'op.note.sign.fieldPlaceKept', { name: fieldName }));
    if (earlier > 0) {
      notes.push(
        appended
          ? note('preserved', 'op.note.sign.earlierKept', { count: earlier })
          : note('lost', 'op.note.sign.earlierLost', { count: earlier }),
      );
    }

    context.onProgress?.({ phase: 'sign', labelKey: 'op.progress.sign.digest', done: 0, total: 1 });

    // `/M` and the other text entries are strings (§12.8.1), never names.
    const signature = doc.addObject({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'ETSI.CAdES.detached',
      M: text(doc, pdfDate(date)),
      ByteRange: [rangePlaceholderValue, rangePlaceholderValue, rangePlaceholderValue, rangePlaceholderValue],
      Contents: doc.newByteString(new Uint8Array(CONTENTS_RESERVATION)),
    });
    if (request.signerName !== undefined) signature.put('Name', text(doc, request.signerName));
    if (request.reason !== undefined) signature.put('Reason', text(doc, request.reason));
    if (request.location !== undefined) signature.put('Location', text(doc, request.location));
    if (request.contactInfo !== undefined) signature.put('ContactInfo', text(doc, request.contactInfo));
    target.dict.put('V', signature);
    steps.push('producer');

    throwIfAborted(context.signal);
    produced = appended ? saveIncremental(doc, 'sign') : saveRewrite(doc, 'sign');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'sign');
  } finally {
    doc.destroy();
  }
  steps.push('save');

  // An append keeps every input byte in place — that is the whole reason it was chosen, and
  // what keeps the earlier signatures valid. An engine that answered with anything else is
  // not trusted with a file somebody already signed.
  if (appended) {
    let kept = produced.length > bytes.length;
    for (let index = 0; kept && index < bytes.length; index += 1) kept = produced[index] === bytes[index];
    if (!kept) {
      throw new ToolError('internal', {
        engine: 'mupdf',
        engineMessage: 'the incremental update did not keep the bytes the earlier signatures cover',
      });
    }
  }

  /**
   * The zero `/Contents` marker is what identifies *this* dictionary: 32 768 zeros cannot
   * plausibly appear twice, and the `/ByteRange` placeholder is then looked for just
   * before it rather than anywhere in the file. An append only looks at what it appended —
   * the revisions before it are the earlier signatures' and are not searched.
   */
  const searchFrom = appended ? bytes.length : 0;
  const contentsAt = indexOfBytes(produced, ascii(contentsMarkerText), searchFrom);
  if (contentsAt === -1 || indexOfBytes(produced, ascii(contentsMarkerText), contentsAt + 1) !== -1) {
    throw new ToolError('internal', {
      engine: 'mupdf',
      engineMessage:
        contentsAt === -1
          ? 'the /Contents placeholder did not survive serialisation'
          : 'the file already carries a zero /Contents placeholder of this size',
    });
  }
  const rangeAt = lastIndexOfBytes(produced, ascii(rangePlaceholderText), contentsAt);
  if (rangeAt === -1) {
    throw new ToolError('internal', {
      engine: 'mupdf',
      engineMessage: 'the /ByteRange placeholder did not survive serialisation',
    });
  }

  /**
   * ByteRange semantics (§7.5.5, the convention every verifier follows): the gap between the
   * two segments is the **whole `/Contents` string, its delimiters included** — so the signed
   * bytes are `[0, '<')` and `(>, end]`, and the placeholder in between is what the signature
   * is written into. Measured against this product's own verifier first: a range that kept
   * the `<` and `>` inside the signed half was answered `layout`, because the `/Contents`
   * value no longer sat in the gap.
   */
  const hexStart = contentsAt + 1;
  const gapStart = contentsAt;
  const gapEnd = contentsAt + contentsMarkerText.length;
  const range: readonly [number, number, number, number] = [0, gapStart, gapEnd, produced.length - gapEnd];
  produced.set(ascii(byteRangeText(range, rangePlaceholderText.length)), rangeAt);

  // The signed content: the two segments the range names, concatenated.
  const signed = new Uint8Array(range[1] + range[3]);
  signed.set(produced.subarray(0, range[1]), 0);
  signed.set(produced.subarray(range[2]), range[1]);

  // No `signingTime` attribute: PAdES B-B forbids it (EN 319 142-1 §6.3) and the moment the
  // signature claims is the `/M` written above.
  const cms = await detachedCmsSignature(signed, request.identity, {
    ...(request.digest === undefined ? {} : { digest: request.digest }),
  });
  const hex = [...cms.der]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  if (hex.length > CONTENTS_RESERVATION * 2) {
    throw new ToolError('internal', {
      engine: 'mupdf',
      engineMessage: `the CMS is ${hex.length} hex characters, larger than the ${CONTENTS_RESERVATION * 2}-character reservation`,
    });
  }
  produced.set(ascii(hex.padEnd(CONTENTS_RESERVATION * 2, '0')), hexStart);
  steps.push('cms');

  // The verification is the point of the whole operation: the produced file is read back
  // with the same reader the properties panel uses, and the signature has to come out with
  // its integrity intact. A signature that does not verify must never reach a user as a
  // "signed" file.
  //
  // The verdict is picked by the full name of the field that was written — never by its
  // position, which depends on how a file orders its fields. Two fields of one name cannot be
  // told apart by name, so then any of them that fails fails the signature (fail closed).
  const verdicts = await verifySignatures(produced, context.signal);
  const named = verdicts.filter((entry) => entry.fieldName === fieldName);
  const ours = named.find((entry) => entry.integrity !== 'valid') ?? named[0];
  if (ours === undefined) {
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage:
        verdicts.length === 0
          ? 'the produced file carries no signature field to verify'
          : `the produced file carries no signature in a field named ${JSON.stringify(fieldName)}`,
    });
  }
  if (ours.integrity !== 'valid') {
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage:
        `the produced signature does not verify: integrity "${ours.integrity}", coverage "${ours.coverage}", ` +
        `reason "${ours.reasonKey}", signer ${JSON.stringify(ours.signer)}, ` +
        `subFilter "${ours.subFilter}"`,
    });
  }
  steps.push('verify');
  notes.push(
    note('changed', 'op.note.sign.signed', {
      digest: cms.digest,
      bytes: cms.der.byteLength,
    }),
  );
  notes.push(
    note('preserved', 'op.note.sign.byteRange', {
      start: range[1],
      end: range[2],
      tail: range[3],
    }),
  );
  context.onProgress?.({ phase: 'sign', labelKey: 'op.progress.sign.verify', done: 1, total: 1 });

  const report: OperationReport = {
    engine: 'mupdf',
    steps,
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: produced.byteLength,
    pageCount,
    // An append kept the input's bytes; a rewrite did not. Either way the file is now a signed
    // revision, and nothing may rewrite it afterwards.
    incremental: appended,
  };
  return { bytes: produced, report };
}
