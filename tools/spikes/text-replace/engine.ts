/**
 * Engine loading for spike #3 (throwaway — `PLAN.md §9/K21`, never shipped).
 *
 * MuPDF is loaded from its **pinned production location** `/engines/mupdf/mupdf.js`
 * (that copy is byte-identical to `mupdf@1.28.1` from npm — verified with SHA-256),
 * so the spike runs the same build the product will ship rather than a bundled
 * substitute. Types come from the npm package, which is that same build.
 *
 * pdf.js is reached through `pdf-core`'s adapter (the sanctioned entry point) and is
 * used here only as the **independent second reader** for text extraction.
 */
import type * as MupdfTypes from 'mupdf';
import { openWithPdfjs } from 'pdf-core';

export type Mupdf = typeof MupdfTypes;
/** A PDF document open in MuPDF (`Document.openDocument` is typed as the base class). */
export type PdfDoc = InstanceType<Mupdf['PDFDocument']>;
export type PdfPage = InstanceType<Mupdf['PDFPage']>;
export type PdfDevice = InstanceType<Mupdf['Device']>;
export type PdfFont = InstanceType<Mupdf['Font']>;
export type PdfObjectT = InstanceType<Mupdf['PDFObject']>;
export type PdfPixmap = InstanceType<Mupdf['Pixmap']>;

const MUPDF_URL = '/engines/mupdf/mupdf.js';

let mupdfPromise: Promise<Mupdf> | null = null;

export function loadMupdf(): Promise<Mupdf> {
  mupdfPromise ??= import(/* @vite-ignore */ MUPDF_URL) as Promise<Mupdf>;
  return mupdfPromise;
}

/** Every engine in this spike works on a **disposable copy** of the bytes (`K15`). */
export function openPdf(mupdf: Mupdf, bytes: Uint8Array): PdfDoc {
  return mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf') as PdfDoc;
}

export function savePdf(doc: PdfDoc, options: string): Uint8Array {
  const buffer = doc.saveToBuffer(options);
  const bytes = new Uint8Array(buffer.asUint8Array());
  buffer.destroy();
  return bytes;
}

export { openWithPdfjs };
