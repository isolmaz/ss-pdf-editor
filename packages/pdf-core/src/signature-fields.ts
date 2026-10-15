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
 * The fully qualified names of the fields that carry a signature. `getSignatures()` reports
 * the field's own `/T` only (`Sig1` for `a.Sig1`), which says nothing about *which* `Sig1`
 * signed — so the entry's `id` is used instead: it begins with the reference of the field
 * that holds the signature (`12R:0-…`), and `getFieldObjects()` lists that same reference
 * under the field's qualified name. An entry that names no listed field keeps the name it
 * reported, which is the qualified name of a top-level field.
 */
async function signedFieldNames(
  document: PdfDocumentHandle,
  qualifiedNameById: ReadonlyMap<string, string>,
): Promise<ReadonlySet<string>> {
  const signatures = await document.raw.getSignatures();
  const names = new Set<string>();
  if (signatures === null || signatures === undefined) return names;

  for (const entry of signatures) {
    if (entry === null || typeof entry !== 'object') continue;
    const reference = 'id' in entry && typeof entry.id === 'string' ? entry.id.split(':', 1)[0] : undefined;
    const qualified = reference === undefined ? undefined : qualifiedNameById.get(reference);
    if (reference !== undefined && qualified !== undefined) {
      // A field with no name is listed by its reference (`listPdfSignatureFields` below).
      names.add(qualified.length > 0 ? qualified : reference);
    } else if ('fieldName' in entry && typeof entry.fieldName === 'string' && entry.fieldName.length > 0) {
      names.add(entry.fieldName);
    }
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
    // Every listed field by reference, whatever its type: the field that holds a signature may be
    // a parent whose kids are the widgets.
    const qualifiedNameById = new Map<string, string>();
    for (const [name, entries] of fields) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        const widget = entry as { readonly type?: unknown; readonly id?: unknown; readonly page?: unknown };
        if (typeof widget.id === 'string') qualifiedNameById.set(widget.id, name);
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

    const signed = await signedFieldNames(document, qualifiedNameById);
    return widgets.map((widget) => ({ ...widget, signed: signed.has(widget.name) }));
  } catch (error) {
    throw toToolError(error, 'pdfjs');
  }
}
