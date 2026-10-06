/**
 * Embedded files ("Ekler") of a PDF: the attachment list a
 * reader can show and write out. Read-only by contract — nothing here changes the
 * document.
 *
 * pdf.js answers `getAttachments()` with a **lookup table**, not with the payloads:
 * v6 returns `{ filename, description }` per entry and hands the bytes to
 * `getAttachmentContent(id)` on demand, while older builds inlined them as
 * `content`. Both shapes are normalised here, and an entry whose payload is
 * neither bytes nor a string stays listable instead of breaking the panel.
 */

import { ToolError, toToolError } from 'pdf-shared';
import type { PdfDocumentHandle } from './engines/pdfjs-handle';

export interface PdfAttachment {
  /** Lookup key — the name-tree key the engine hands the bytes back under. */
  readonly id: string;
  /** Basename to display and to write the file out as. */
  readonly filename: string;
  /** Description when the document carries one, otherwise an empty string. */
  readonly description: string;
  /** Payload, only when the engine already delivered it: usually `null`. */
  readonly content: Uint8Array<ArrayBuffer> | null;
}

/**
 * Engines and engine versions disagree about the payload type: bytes are the rule,
 * a binary (latin-1) string is what pdf.js ≤4 handed out, and anything else is a
 * document we cannot read an attachment from.
 *
 * The result is pinned to an `ArrayBuffer`-backed view on purpose: the bytes are the
 * ones a caller hands to a `Blob`/`File`, and those accept nothing else. Payloads
 * reaching this adapter crossed the worker boundary, so they are never shared.
 */
function asBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof Uint8Array) return value as Uint8Array<ArrayBuffer>;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      bytes[index] = value.charCodeAt(index) & 0xff;
    }
    return bytes;
  }
  return null;
}

/**
 * Every attachment of the document, in the engine's own order. A document without
 * attachments — or without an embedded-file name tree at all — is an empty list,
 * not an error: that is the normal case for most PDFs.
 */
export async function listPdfAttachments(document: PdfDocumentHandle): Promise<readonly PdfAttachment[]> {
  try {
    const table = await document.raw.getAttachments();
    if (table === null || table === undefined) return [];

    const attachments: PdfAttachment[] = [];
    for (const [id, entry] of table) {
      // The engine's own type claims these members exist; a file specification that
      // points at a non-existing stream does not honour it, so they are read as
      // unknown and validated here.
      const meta: {
        readonly filename?: unknown;
        readonly description?: unknown;
        readonly content?: unknown;
      } = entry;
      attachments.push({
        id,
        filename: typeof meta.filename === 'string' && meta.filename.length > 0 ? meta.filename : id,
        description: typeof meta.description === 'string' ? meta.description : '',
        content: asBytes(meta.content),
      });
    }
    return attachments;
  } catch (error) {
    throw toToolError(error, 'pdfjs');
  }
}

/**
 * The bytes of one attachment — the payload `getAttachments()` did not carry.
 * `corrupt-document` is the honest answer for an attachment whose stream is
 * missing or unreadable: writing a zero-byte file would hide that from the user.
 */
export async function readPdfAttachment(
  document: PdfDocumentHandle,
  attachment: PdfAttachment,
): Promise<Uint8Array<ArrayBuffer>> {
  if (attachment.content !== null) return attachment.content;

  let content: unknown;
  try {
    content = await document.raw.getAttachmentContent(attachment.id);
  } catch (error) {
    throw toToolError(error, 'pdfjs');
  }
  const bytes = asBytes(content);
  if (bytes === null) {
    throw new ToolError('corrupt-document', { engine: 'pdfjs', path: attachment.filename });
  }
  return bytes;
}
