/**
 * Engine loading for spike #4 (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * MuPDF comes from its **pinned production location** `/engines/mupdf/mupdf.js`
 * (byte-identical to `mupdf@1.28.1` from npm), so the spike runs the build the
 * product will ship. Types come from the npm package, which is that same build;
 * `import type` keeps the npm copy out of the bundle entirely.
 *
 * pdf.js is used only as the **independent second reader** for the audit.
 */
import type { Document, PDFAnnotation, PDFDocument, PDFPage } from 'mupdf';

export type PdfDoc = PDFDocument;
export type PdfPage = PDFPage;
export type PdfAnnot = PDFAnnotation;

/** The module namespace object as the pinned `/engines/mupdf/mupdf.js` exposes it. */
export interface Mupdf {
  readonly Document: typeof Document;
  readonly PDFDocument: typeof PDFDocument;
  readonly PDFPage: typeof PDFPage;
}

const MUPDF_URL = '/engines/mupdf/mupdf.js';

let mupdfPromise: Promise<Mupdf> | null = null;

export function loadMupdf(): Promise<Mupdf> {
  mupdfPromise ??= import(/* @vite-ignore */ MUPDF_URL) as Promise<Mupdf>;
  return mupdfPromise;
}

/** Engines work on a **disposable copy** of the bytes (`K15`). */
export function openPdf(mupdf: Mupdf, bytes: Uint8Array): PdfDoc {
  const document = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  const pdf = document.asPDF();
  if (!pdf) throw new Error('opened document is not a PDF');
  return pdf;
}

/** `saveToBuffer(options)` returns a wasm-owned buffer: copy it, then free it. */
export function savePdf(doc: PdfDoc, options: string): Uint8Array {
  const buffer = doc.saveToBuffer(options);
  const bytes = new Uint8Array(buffer.asUint8Array());
  buffer.destroy();
  return bytes;
}

/** Same, but the caller keeps the error text (used for the incremental probe). */
export function trySavePdf(doc: PdfDoc, options: string): { bytes: Uint8Array | null; error: string | null } {
  try {
    return { bytes: savePdf(doc, options), error: null };
  } catch (error) {
    return { bytes: null, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}
