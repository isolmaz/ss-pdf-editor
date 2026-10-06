/**
 * Signature fields ("İmzalar"): the reader side of digital
 * signatures — which fields a document has and whether each one carries a signature.
 * Nothing here signs anything; signing is `ops/sign.ts`.
 *
 * The engine's field data drives it, with one trap: `getFieldObjects()` keys the
 * AcroForm fields by their fully qualified name and marks a signature widget with
 * `type: 'signature'`, but its `value` is *always* `null` — pdf.js reads a
 * signature's value from the signature dictionary, never from the field. "Signed"
 * therefore comes from `getSignatures()`, the list of signature dictionaries the
 * document carries, and a document without a single signature field never pays for
 * that second read.
 */

import { toToolError } from 'pdf-shared';
import type { PdfDocumentHandle } from './engines/pdfjs-handle';

export interface PdfSignatureField {
  /** Fully qualified field name; the widget id when the field carries no name. */
  readonly name: string;
  /** Widget id inside the document — diagnostics, and the display fallback. */
  readonly id: string;
  /** 0-based page the widget sits on, `null` when the engine reports none. */
  readonly pageIndex: number | null;
  /** True when the document carries a signature dictionary for this field. */
  readonly signed: boolean;
}

/**
 * The field names `getSignatures()` reports. A signature dictionary carries the
 * field's own `/T` while the field map uses the dotted path, so both forms are kept
 * and {@link PdfSignatureField} matches on either.
 */
async function signedFieldNames(document: PdfDocumentHandle): Promise<ReadonlySet<string>> {
  const signatures = await document.raw.getSignatures();
  const names = new Set<string>();
  if (signatures === null || signatures === undefined) return names;

  for (const entry of signatures) {
    if (entry === null || typeof entry !== 'object') continue;
    const meta = entry as { readonly fieldName?: unknown };
    if (typeof meta.fieldName === 'string' && meta.fieldName.length > 0) names.add(meta.fieldName);
  }
  return names;
}

/** Every signature field of the document, in the engine's own order. */
export async function listPdfSignatureFields(
  document: PdfDocumentHandle,
): Promise<readonly PdfSignatureField[]> {
  try {
    const fields = await document.raw.getFieldObjects();
    if (fields === null || fields === undefined) return [];

    const widgets: Omit<PdfSignatureField, 'signed'>[] = [];
    for (const [name, entries] of fields) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        const widget = entry as { readonly type?: unknown; readonly id?: unknown; readonly page?: unknown };
        if (widget.type !== 'signature') continue;
        const id = typeof widget.id === 'string' ? widget.id : '';
        widgets.push({
          name: name.length > 0 ? name : id,
          id,
          pageIndex: typeof widget.page === 'number' ? widget.page : null,
        });
      }
    }
    // Without a field there is nothing to call signed, and the signature
    // dictionaries (a document-level read) are not worth parsing.
    if (widgets.length === 0) return [];

    const signed = await signedFieldNames(document);
    return widgets.map((widget) => {
      const leaf = widget.name.slice(widget.name.lastIndexOf('.') + 1);
      return { ...widget, signed: signed.has(widget.name) || signed.has(leaf) };
    });
  } catch (error) {
    throw toToolError(error, 'pdfjs');
  }
}
