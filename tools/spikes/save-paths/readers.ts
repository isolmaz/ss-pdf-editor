/**
 * Cross-reader verification helpers (pdf.js + MuPDF) — `PLAN.md §5/Phase 0`
 * requires a second reader, not just the writer's own opinion of its output.
 *
 * pdf.js is imported directly (not through `pdf-core`) because the spike needs
 * `annotationStorage` and `extractPages`, which the adapter deliberately does
 * not expose. MuPDF is loaded from the served engine build (`/engines/**`), the
 * same bytes production will use — the npm package only supplies the types.
 */
import type * as Mupdf from 'mupdf';
import * as pdfjs from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = '/engines/pdfjs/pdf.worker.mjs';

const PDFJS_ASSET_OPTIONS = {
  cMapUrl: '/engines/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/engines/pdfjs/standard_fonts/',
  wasmUrl: '/engines/pdfjs/wasm/',
} as const;

export type MupdfModule = typeof Mupdf;
export type MupdfDocument = Mupdf.PDFDocument;
export type MupdfPage = Mupdf.PDFPage;

export interface PdfjsOpen {
  readonly doc: pdfjs.PDFDocumentProxy;
  readonly close: () => Promise<void>;
}

export async function openPdfjs(bytes: Uint8Array, password?: string): Promise<PdfjsOpen> {
  // `bytes.slice()` keeps the caller's master copy safe: pdf.js may transfer
  // (detach) whatever buffer it is handed (`PLAN.md §9/K15`).
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    ...PDFJS_ASSET_OPTIONS,
    ...(password === undefined ? {} : { password }),
  });
  const doc = await task.promise;
  return { doc, close: () => task.destroy() };
}

export async function pdfjsText(doc: pdfjs.PDFDocumentProxy, pageNumber?: number): Promise<string[]> {
  const pages = pageNumber ? [pageNumber] : Array.from({ length: doc.numPages }, (_, i) => i + 1);
  const out: string[] = [];
  for (const number of pages) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    out.push(
      content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }
  return out;
}

export interface PdfjsInspection {
  readonly pageCount: number;
  /** Extracted text per page, in output order. */
  readonly text: string[];
  readonly annotations: Array<{ page: number; subtype: string; rect: number[]; contents: string }>;
  readonly formFields: Record<string, unknown>;
  readonly info: Record<string, unknown>;
  readonly hasXmp: boolean;
}

export async function inspectWithPdfjs(bytes: Uint8Array, password?: string): Promise<PdfjsInspection> {
  const { doc, close } = await openPdfjs(bytes, password);
  try {
    const text = await pdfjsText(doc);
    const annotations: PdfjsInspection['annotations'] = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      // pdf.js types `getAnnotations()` loosely; the spike reads three fields.
      type RawAnnot = { subtype?: string; rect?: number[]; contentsObj?: { str?: string } };
      let pageAnnots: RawAnnot[] = [];
      try {
        pageAnnots = (await page.getAnnotations()) as RawAnnot[];
      } catch {
        pageAnnots = [];
      }
      for (const annot of pageAnnots) {
        annotations.push({
          page: number,
          subtype: annot.subtype ?? 'unknown',
          rect: (annot.rect ?? []).map((value) => Math.round(value * 100) / 100),
          contents: annot.contentsObj?.str ?? '',
        });
      }
    }
    let formFields: Record<string, unknown> = {};
    try {
      // pdf.js types each field as a bare `Object`; the spike reads `value`.
      const fields = (await doc.getFieldObjects()) as Record<string, Array<{ value?: unknown }>> | null;
      if (fields) {
        formFields = Object.fromEntries(
          Object.entries(fields).map(([name, entries]) => [name, entries.map((entry) => entry.value)]),
        );
      }
    } catch (error) {
      formFields = { __error: String(error) };
    }
    const metadata = await doc.getMetadata();
    // pdf.js types the info dictionary as a bare `Object`.
    const info = metadata.info as Record<string, unknown>;
    return {
      pageCount: doc.numPages,
      text,
      annotations,
      formFields,
      info,
      hasXmp: Boolean(metadata.metadata),
    };
  } finally {
    await close();
  }
}

/* ------------------------------------------------------------------ MuPDF */

let mupdfModule: Promise<MupdfModule> | null = null;

/** The engine build is a URL served at runtime, not a bundler-resolvable module. */
const MUPDF_ENGINE_URL = '/engines/mupdf/mupdf.js';

export function loadMupdf(): Promise<MupdfModule> {
  mupdfModule ??= import(/* @vite-ignore */ MUPDF_ENGINE_URL) as Promise<MupdfModule>;
  return mupdfModule;
}

export interface MupdfOpen {
  readonly mupdf: MupdfModule;
  readonly doc: MupdfDocument;
  readonly needsPassword: boolean;
  readonly authenticated: boolean | null;
  readonly encryption: string | null;
}

export async function openMupdf(bytes: Uint8Array, password?: string): Promise<MupdfOpen> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf') as MupdfDocument;
  const needsPassword = doc.needsPassword();
  const authenticated = needsPassword ? doc.authenticatePassword(password ?? '') > 0 : null;
  return {
    mupdf,
    doc,
    needsPassword,
    authenticated,
    encryption: doc.getMetaData(mupdf.Document.META_ENCRYPTION) ?? null,
  };
}

export async function mupdfText(doc: MupdfDocument): Promise<string[]> {
  const out: string[] = [];
  for (let index = 0; index < doc.countPages(); index += 1) {
    const page = doc.loadPage(index) as MupdfPage;
    try {
      out.push(page.toStructuredText('preserve-whitespace').asText().replace(/\s+/g, ' ').trim());
    } finally {
      page.destroy();
    }
  }
  return out;
}

export interface MupdfInspection {
  readonly pageCount: number;
  readonly text: string[];
  readonly encrypted: boolean;
  readonly encryption: string | null;
  readonly needsPassword: boolean;
  readonly permissions: Record<string, boolean>;
}

export async function inspectWithMupdf(bytes: Uint8Array, password?: string): Promise<MupdfInspection> {
  const { mupdf, doc, encryption, needsPassword } = await openMupdf(bytes, password);
  try {
    // `Object.keys` widens to `string`; the table's own key type is the contract.
    const permissionNames = Object.keys(mupdf.Document.PERMISSION) as Mupdf.DocumentPermission[];
    const permissions: Record<string, boolean> = {};
    for (const name of permissionNames) {
      permissions[name] = doc.hasPermission(name);
    }
    return {
      pageCount: doc.countPages(),
      text: await mupdfText(doc),
      encrypted: Boolean(encryption),
      encryption,
      needsPassword,
      permissions,
    };
  } finally {
    doc.destroy();
  }
}

/** Raw byte search (latin1) — object-level evidence that text left the file. */
export function countBytes(haystack: Uint8Array, needle: string): number {
  const latin1 = latin1String(haystack);
  let count = 0;
  let index = latin1.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = latin1.indexOf(needle, index + needle.length);
  }
  return count;
}

function latin1String(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return out;
}
