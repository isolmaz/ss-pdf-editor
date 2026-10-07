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
 *  3. the ByteRange is computed from those offsets and written over the same digits;
 *  4. the range is hashed and signed (`signature-cms.ts`), and the CMS goes into the
 *     `/Contents` placeholder as hex.
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
import { mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  arrayIn,
  dictionaryIn,
  openForWrite,
  pageObjects,
  readName,
  readText,
  resolved,
  saveRewrite,
  text,
} from '../engines/mupdf-write';
import { detachedCmsSignature, type SignatureDigest, type SignatureIdentity } from '../signature-cms';
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
  /** The field to fill; a new one is created under this name when the document has none. */
  readonly name?: string;
  /**
   * Where the visible signature goes, in PDF user space (bottom-left origin). Absent
   * leaves the field invisible, which is what a machine-checked signature usually is.
   */
  readonly rect?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** Page for a new field; defaults to the first page. */
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

/**
 * A `/Sig` field's appearance: a form XObject drawing the lines in Helvetica.
 *
 * Helvetica is a **standard-14** face, so nothing is embedded and every reader has it —
 * which is the right trade for a signature stamp: the appearance is not the signature, and
 * the file must stay small and portable. Text is escaped for a PDF literal string, and the
 * content is built from ASCII only (a Turkish letter in a stamp would need a font this
 * appearance does not have; the field's own `/T` and the CMS carry the real names).
 */
function appearance(
  doc: PDFDocument,
  rect: { readonly width: number; readonly height: number },
  lines: readonly string[],
): PDFObject {
  const escapeLiteral = (text: string): string => text.replace(/[\\()]/g, (character) => `\\${character}`);
  const safe = (text: string): string => text.replace(/[^\x20-\x7e]/g, '?');
  const rows = lines.slice(0, 6);
  const step = 11;
  const size = rows.length > 3 ? 8 : 9;
  const top = rect.height - 12;
  const body = rows
    .map((line, index) => {
      const y = top - index * step;
      if (y < 6) return '';
      return `BT /Helv ${size} Tf 0 0 0 rg 6 ${y.toFixed(2)} Td (${escapeLiteral(safe(line))}) Tj ET\n`;
    })
    .join('');
  return doc.addStream(`0.92 0.92 0.92 rg 0.75 w 0 0 ${rect.width} ${rect.height} re B\n0 0 0 rg\n${body}`, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, rect.width, rect.height],
    Resources: {
      Font: {
        Helv: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' },
      },
    },
  });
}

/** The first existing empty signature field, if the document has one. */
function existingSignatureField(
  doc: PDFDocument,
): { readonly dict: PDFObject; readonly pageIndex: number } | null {
  for (const [pageIndex, page] of pageObjects(doc).entries()) {
    const annots = annotsOf(doc, page);
    if (annots === null) continue;
    for (let index = 0; index < annots.length; index += 1) {
      const dict = resolved(annots.get(index));
      if (dict === null || !dict.isDictionary()) continue;
      const isWidget = readName(dict.get('Subtype')) === 'Widget';
      const isSignature = readName(dict.get('FT')) === 'Sig';
      if (isWidget && isSignature && dict.get('V').isNull()) return { dict, pageIndex };
    }
  }
  return null;
}

/** A fresh `/Widget` + `/FT /Sig` field, wired into the page and the `/AcroForm`. */
function createSignatureField(
  doc: PDFDocument,
  request: SignatureFieldRequest,
  lines: readonly string[],
): { readonly dict: PDFObject; readonly pageIndex: number } {
  const pageIndex = request.pageIndex ?? 0;
  const pages = pageObjects(doc);
  const page = pages[pageIndex];
  if (!Number.isInteger(pageIndex) || page === undefined) {
    throw new ToolError('value-out-of-range', {
      engine: 'mupdf',
      path: 'request.field.pageIndex',
      engineMessage: `page ${pageIndex} is outside 0…${pages.length - 1}`,
    });
  }
  const rect = request.rect;
  const box: [number, number, number, number] =
    rect === undefined ? [0, 0, 0, 0] : [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
  const name = request.name ?? `Signature${Math.floor(Date.now() / 1000)}`;

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
  if (rect !== undefined) dict.put('AP', { N: appearance(doc, rect, lines) });
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

    const lines = appearanceLines(request, date);
    const existing = existingSignatureField(doc);
    const target = existing ?? createSignatureField(doc, request.field ?? {}, lines);
    steps.push(existing === null ? 'field.create' : 'field.reuse');
    notes.push(
      note('changed', existing === null ? 'op.note.sign.fieldCreated' : 'op.note.sign.fieldFilled', {
        name: readText(target.dict.get('T')) ?? '',
      }),
    );

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
    produced = saveRewrite(doc, 'sign');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'sign');
  } finally {
    doc.destroy();
  }
  steps.push('save');

  /**
   * The zero `/Contents` marker is what identifies *this* dictionary: 32 768 zeros cannot
   * plausibly appear twice, and the `/ByteRange` placeholder is then looked for just
   * before it rather than anywhere in the file.
   */
  const contentsAt = indexOfBytes(produced, ascii(contentsMarkerText));
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
  const rangeText =
    `[${String(range[0]).padStart(RANGE_DIGITS, '0')} ${String(range[1]).padStart(RANGE_DIGITS, '0')} ` +
    `${String(range[2]).padStart(RANGE_DIGITS, '0')} ${String(range[3]).padStart(RANGE_DIGITS, '0')}]`;
  produced.set(ascii(rangeText), rangeAt);

  // The signed content: the two segments the range names, concatenated.
  const signed = new Uint8Array(range[1] + range[3]);
  signed.set(produced.subarray(0, range[1]), 0);
  signed.set(produced.subarray(range[2]), range[1]);

  const cms = await detachedCmsSignature(signed, request.identity, {
    ...(request.digest === undefined ? {} : { digest: request.digest }),
    signedAt: date,
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
  const { verifySignatures } = await import('./signature-status');
  const verdicts = await verifySignatures(produced, context.signal);
  const ours = verdicts.at(-1);
  if (ours === undefined) {
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: 'the produced file carries no signature field to verify',
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
    // The file is a signed revision: nothing may rewrite it afterwards.
    incremental: false,
  };
  return { bytes: produced, report };
}
