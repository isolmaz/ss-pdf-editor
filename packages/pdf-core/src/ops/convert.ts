/**
 * Other documents to PDF: Word, Excel, PowerPoint, HTML, plain text, CSV, EPUB and FB2,
 * converted in this tab by MuPDF's layout engine. Nothing is uploaded.
 *
 * Each format becomes one or more *parts* — HTML this module styles
 * (`convert-ooxml.ts`, `convert-text.ts`), or the file itself where MuPDF reads the
 * format well (HTML, EPUB, FB2) — and every part is laid out on pages and run through
 * one MuPDF `DocumentWriter`, so the result is vector text that can be selected and
 * searched, not pictures of pages. A slide keeps its slide's page size; every other
 * part takes the page size, orientation and margin the caller chose.
 *
 * What the reflowed source knows about its own structure travels with it:
 *
 *  - its headings become the outline (`applyOutlineEdit`);
 *  - its links become link annotations (`applyLinkEdit`): `http:`, `https:` and
 *    `mailto:` addresses as they are, links inside the document as page destinations.
 *    Any other scheme is left out, and the report counts what was;
 *  - its title becomes `/Title` (the document's own, else the file name).
 *
 * MuPDF reaches nothing outside the file: an HTML page's remote stylesheet or image is
 * not fetched (there is no network path in this product), and the report says so when
 * the page asked for one. The output is reopened and its page count compared with what
 * was laid out before it is returned.
 */

import type { Document as MupdfDocument } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError } from '../engines/mupdf';
import { openForWrite, saveRewrite } from '../engines/mupdf-write';
import { type ConvertFormat, convertFormatOf, formatLabel } from './convert-formats';
import { docxToHtml, type HtmlPart, pptxToHtml, xlsxToHtml } from './convert-ooxml';
import { csvToHtml, textToHtml } from './convert-text';
import { BLANK_PAGE_SIZES, type BlankOrientation } from './create';
import { applyLinkEdit, type LinkAdd } from './link-edit';
import { applyOutlineEdit, type OutlineNodeInput } from './outline-edit';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

export { CONVERT_ACCEPT, type ConvertFormat, convertFormatOf, formatLabel } from './convert-formats';

/** A larger input is refused before it is read: MuPDF's layout holds it all in memory. */
export const MAX_CONVERT_INPUT = 100 * 1024 * 1024;
/** A layout that runs past this many pages is stopped, not written. */
export const MAX_CONVERT_PAGES = 3000;

export type ConvertPageSize = 'a4' | 'letter' | 'a5' | 'legal';

export interface ConvertRequest {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly pageSize: ConvertPageSize;
  readonly orientation: BlankOrientation;
  /** Page margin for reflowed parts, in millimetres (0–50). */
  readonly marginMm: number;
}

export interface ConvertOutcome extends OperationOutcome {
  readonly format: ConvertFormat;
  /** The title written into the PDF. */
  readonly title: string;
}

/** The look of the HTML this module generates: readable, neutral, table grid drawn. */
const GENERATED_CSS = `
body { font-family: sans-serif; font-size: 10.5pt; line-height: 1.35; margin: 0 }
h1 { font-size: 18pt; margin: 0 0 8pt }
h2 { font-size: 14pt; margin: 0 0 6pt }
h3 { font-size: 12pt; margin: 0 0 4pt }
p { margin: 0 0 6pt }
table { border-collapse: collapse; margin: 0 0 8pt }
td, th { border: 0.75pt solid #888; padding: 2pt 4pt; vertical-align: top }
th { background-color: #eee; font-weight: bold }
td.n { text-align: right }
pre.text { font-family: monospace; font-size: 9.5pt; white-space: pre-wrap; margin: 0 }
img { max-width: 100% }
.slide { font-size: 18pt }
.slide h1 { font-size: 30pt; margin: 0 0 12pt }
.slide p, .slide li { margin: 0 0 8pt }
.slide td, .slide th { font-size: 16pt }
`;

const NATIVE_MAGIC: Readonly<Partial<Record<ConvertFormat, string>>> = {
  html: 'text/html',
  epub: 'application/epub+zip',
  fb2: 'application/x-fictionbook',
};

interface Part {
  readonly bytes: Uint8Array;
  readonly magic: string;
  readonly page: { readonly width: number; readonly height: number } | null;
}

function wrapHtml(part: HtmlPart): Part {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${GENERATED_CSS}</style></head><body>${part.html}</body></html>`;
  return { bytes: new TextEncoder().encode(html), magic: 'text/html', page: part.page };
}

/** `http(s)://` or `//` in a `src`, `href` or `url(…)`: something MuPDF will not fetch. */
const REMOTE_REFERENCE = /(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i;

const SAFE_LINK = /^(?:https?:|mailto:)/i;

const HTML_TITLE = /<title[^>]*>([^<]*)<\/title>/i;

/** The five XML entities and numeric references, for a `<title>` read as text. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function stem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

export async function convertToPdf(
  request: ConvertRequest,
  context: OperationContext,
): Promise<ConvertOutcome> {
  throwIfAborted(context.signal);
  const format = convertFormatOf(request.name);
  if (format === null) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path: request.name,
      engineMessage: 'not a format this converter reads',
    });
  }
  if (request.bytes.byteLength > MAX_CONVERT_INPUT) {
    throw new ToolError('file-too-large', { engine: 'model', path: request.name });
  }
  if (!(request.pageSize in BLANK_PAGE_SIZES)) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `unknown page size ${request.pageSize}`,
    });
  }
  const margin =
    Math.min(Math.max(Number.isFinite(request.marginMm) ? request.marginMm : 15, 0), 50) * (72 / 25.4);
  const [portraitWidth, portraitHeight] = BLANK_PAGE_SIZES[request.pageSize];
  const chosen =
    request.orientation === 'landscape'
      ? { width: portraitHeight, height: portraitWidth }
      : { width: portraitWidth, height: portraitHeight };

  context.onProgress?.({ phase: 'read', labelKey: 'op.progress.convert.read' });
  const steps: string[] = ['convert.read'];
  const notes: OperationNote[] = [];
  let parts: Part[];
  let sourceTitle: string | null = null;
  if (format === 'docx' || format === 'xlsx' || format === 'pptx') {
    const reader = format === 'docx' ? docxToHtml : format === 'xlsx' ? xlsxToHtml : pptxToHtml;
    const result = await reader(request.bytes, request.name);
    parts = result.parts.map(wrapHtml);
    sourceTitle = result.title;
    notes.push(...result.notes);
  } else if (format === 'txt' || format === 'csv' || format === 'tsv') {
    const result = format === 'txt' ? textToHtml(request.bytes) : csvToHtml(request.bytes, format === 'tsv');
    parts = result.parts.map(wrapHtml);
    notes.push(...result.notes);
  } else {
    if (format === 'html') {
      const head = new TextDecoder('utf-8').decode(request.bytes.subarray(0, 4 * 1024 * 1024));
      if (REMOTE_REFERENCE.test(head)) notes.push(note('lost', 'op.note.convert.remoteSkipped'));
      // MuPDF reports no title for HTML; the page's own `<title>` is the one it shows.
      const title = HTML_TITLE.exec(head)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
      if (title !== '') sourceTitle = decodeEntities(title);
    }
    parts = [{ bytes: request.bytes, magic: NATIVE_MAGIC[format] ?? 'text/html', page: null }];
  }
  throwIfAborted(context.signal);

  const mupdf = await loadMupdf();
  const buffer = new mupdf.Buffer();
  const writer = new mupdf.DocumentWriter(buffer, 'pdf', '');
  const outline: OutlineNodeInput[] = [];
  const links: LinkAdd[] = [];
  let unsafeLinks = 0;
  let pageCount = 0;
  steps.push('convert.layout', 'convert.write');
  try {
    for (const part of parts) {
      let source: MupdfDocument | null = null;
      try {
        source = mupdf.Document.openDocument(part.bytes, part.magic);
        const page = part.page ?? chosen;
        // A slide is the slide; everything else gets the chosen margin. The user stylesheet
        // only adds the page margin, so a document's own CSS keeps the rest of its look.
        source.style(true, `@page { margin: ${part.page === null ? margin.toFixed(2) : '18'}pt }`);
        source.layout(page.width, page.height, 11);
        if (sourceTitle === null) {
          const title = source.getMetaData('info:Title')?.trim() ?? '';
          if (title !== '') sourceTitle = title;
        }
        const offset = pageCount;
        const count = source.countPages();
        if (offset + count > MAX_CONVERT_PAGES) {
          throw new ToolError('page-limit', { engine: 'mupdf', path: request.name });
        }
        for (let index = 0; index < count; index += 1) {
          throwIfAborted(context.signal);
          context.onProgress?.({
            phase: 'write',
            labelKey: 'op.progress.convert.write',
            done: offset + index,
          });
          const sourcePage = source.loadPage(index);
          const device = writer.beginPage(sourcePage.getBounds());
          sourcePage.run(device, mupdf.Matrix.identity);
          writer.endPage();
          for (const link of sourcePage.getLinks()) {
            const [x0, y0, x1, y1] = link.getBounds();
            const target = { pageIndex: offset + index, rect: [x0, y0, x1, y1] as const };
            if (link.isExternal()) {
              const uri = link.getURI();
              if (SAFE_LINK.test(uri)) {
                links.push({ target, destination: { kind: 'uri', uri }, border: [0, 0, 0] });
              } else unsafeLinks += 1;
              continue;
            }
            const destination = source.resolveLinkDestination(link);
            const targetPage = source.resolveLink(link);
            if (targetPage < 0 || targetPage >= count) continue;
            links.push({
              target,
              destination: {
                kind: 'page',
                pageIndex: offset + targetPage,
                ...(Number.isFinite(destination.x) && Number.isFinite(destination.y)
                  ? { x: destination.x, y: destination.y }
                  : {}),
              },
              border: [0, 0, 0],
            });
          }
          sourcePage.destroy();
        }
        const items = source.loadOutline();
        if (items !== null) {
          const convert = (
            item: NonNullable<ReturnType<MupdfDocument['loadOutline']>>[number],
          ): OutlineNodeInput => {
            const at = item.uri === undefined ? -1 : (source?.resolveLink(item.uri) ?? -1);
            const destination =
              item.uri === undefined || at < 0 ? null : (source?.resolveLinkDestination(item.uri) ?? null);
            return {
              title: (item.title ?? '').trim() || '—',
              destination:
                at < 0
                  ? null
                  : {
                      pageIndex: offset + at,
                      ...(destination !== null &&
                      Number.isFinite(destination.x) &&
                      Number.isFinite(destination.y)
                        ? { x: destination.x, y: destination.y }
                        : {}),
                    },
              ...(item.down === undefined ? {} : { children: item.down.map(convert) }),
            };
          };
          outline.push(...items.map(convert));
        }
        pageCount += count;
      } finally {
        source?.destroy();
      }
    }
    writer.close();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw mapMupdfError(error, 'convertToPdf');
  }
  if (pageCount === 0) {
    throw new ToolError('unsupported-format', {
      engine: 'mupdf',
      path: request.name,
      engineMessage: 'nothing to lay out',
    });
  }

  const title = sourceTitle ?? stem(request.name);
  let bytes: Uint8Array;
  {
    const { doc } = await openForWrite(buffer.asUint8Array().slice());
    try {
      doc.setMetaData('info:Title', title);
      bytes = saveRewrite(doc, 'convertToPdf');
    } finally {
      doc.destroy();
    }
  }
  steps.push('save');

  if (outline.length > 0) {
    const outcome = await applyOutlineEdit(bytes, { kind: 'replace-all', nodes: outline }, context);
    bytes = outcome.bytes;
    steps.push('convert.outline');
  }
  if (links.length > 0) {
    const outcome = await applyLinkEdit(bytes, { add: links }, context);
    bytes = outcome.bytes;
    steps.push('convert.links');
  }
  if (unsafeLinks > 0) notes.push(note('lost', 'op.note.convert.linksSkipped', { count: unsafeLinks }));

  // Read back: the file opens and holds every page that was laid out.
  {
    const { doc } = await openForWrite(bytes);
    try {
      const written = doc.countPages();
      if (written !== pageCount) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `converted ${pageCount} pages but the file holds ${written}`,
        });
      }
    } finally {
      doc.destroy();
    }
  }
  steps.push('verify');
  notes.unshift(
    note('changed', 'op.note.convert.done', {
      name: request.name,
      format: formatLabel(format),
      pages: pageCount,
    }),
  );

  return {
    bytes,
    format,
    title,
    report: {
      engine: 'mupdf',
      steps,
      notes,
      inputBytes: request.bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount,
      incremental: false,
    },
  };
}
