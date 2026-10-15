/**
 * Text extraction (defect: "transparent engine choice").
 *
 * The engine is chosen by measurement, not by hope: pages whose text layer is
 * empty are reported so the UI can say "this looks scanned — OCR first" instead
 * of silently returning nothing.
 *
 * Layout is derived from the text layer, because pdf.js's flattened
 * `getPageText()` (the adapter's convenience call) joins items with single spaces
 * and loses both line and paragraph breaks. Items are grouped into lines by
 * baseline and lines into paragraphs by the vertical gap; the numbers are in
 * `pageToParagraphs`. The heuristic assumes upright text — a page of sideways
 * text still exports its characters, but its line grouping is content order, and
 * the report says so.
 *
 * A line with right-to-left text (Hebrew, Arabic) is joined in reading order, not
 * left to right: pdf.js turns each item's text into reading order and says which way
 * it runs (`dir`), and `readingPieces` puts the items of the line in the order the
 * bidirectional algorithm reads them (`ops/bidi.ts`).
 */

import { ToolError, toToolError } from 'pdf-shared';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { type Direction, letterCounts, readingOrder } from './bidi';
import { type OperationContext, type OutputFile, throwIfAborted } from './types';

export type TextExportFormat = 'text' | 'markdown';

export interface TextExportOptions {
  readonly pages: readonly number[];
  readonly format: TextExportFormat;
  readonly baseName: string;
}

export interface TextExportResult {
  readonly file: OutputFile;
  /** Pages that produced no text at all (scanned pages). */
  readonly emptyPages: readonly number[];
  readonly characterCount: number;
}

/** One text-layer piece with the geometry the layout rules need. */
interface TextPiece {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly width: number;
  /** pdf.js marks an item right-to-left when its text holds a right-to-left letter; a space or a number has no direction. */
  readonly direction: Direction;
}

/** A line is only a paragraph partner of the previous one when it follows closely. */
const PARAGRAPH_GAP = 1.6;
/** Word gaps below this fraction of the font size are kerning, not a space. */
const WORD_GAP = 0.15;

/** Groups text pieces into lines (baseline order) and lines into paragraphs. */
function pageToParagraphs(pieces: readonly TextPiece[]): string[][] {
  if (pieces.length === 0) return [];
  const tolerance = (piece: TextPiece) => Math.max(1, piece.size * 0.5);
  const lines: { y: number; size: number; pieces: TextPiece[] }[] = [];
  for (const piece of pieces) {
    const line = lines.find((candidate) => Math.abs(candidate.y - piece.y) <= tolerance(piece));
    if (line === undefined) {
      lines.push({ y: piece.y, size: piece.size, pieces: [piece] });
      continue;
    }
    line.pieces.push(piece);
    line.size = Math.max(line.size, piece.size);
  }
  // PDF user space grows upwards, so the first line has the largest baseline.
  lines.sort((a, b) => b.y - a.y);

  const paragraphs: string[][] = [];
  let current: string[] = [];
  let previous: { y: number; size: number } | undefined;
  for (const line of lines) {
    const text = joinLine(line.pieces);
    if (text === '') continue;
    if (previous !== undefined && previous.y - line.y > PARAGRAPH_GAP * Math.max(previous.size, line.size)) {
      paragraphs.push(current);
      current = [];
    }
    current.push(text);
    previous = { y: line.y, size: line.size };
  }
  if (current.length > 0) paragraphs.push(current);
  return paragraphs;
}

/**
 * The pieces of a line in the order they are read. They stand left to right on the page, which is
 * the reading order unless the line holds right-to-left text: there the first word is the
 * rightmost, so the pieces are put back by the bidirectional algorithm (`readingOrder`). Each
 * piece keeps its own text, which pdf.js has already turned into reading order.
 */
function readingPieces(onPage: readonly TextPiece[]): readonly TextPiece[] {
  if (!onPage.some((piece) => piece.direction === 'rtl')) return onPage;
  let rtl = 0;
  let ltr = 0;
  for (const piece of onPage) {
    const counts = letterCounts(piece.text);
    rtl += counts.rtl;
    ltr += counts.ltr;
  }
  const order = readingOrder(
    onPage.map((piece) => piece.direction),
    rtl > ltr,
  );
  return order.map((at) => onPage[at] as TextPiece);
}

/**
 * Join in reading order (left to right, or right to left in right-to-left text); a real word gap
 * between neighbours becomes a space, a kerning gap does not.
 */
function joinLine(pieces: readonly TextPiece[]): string {
  const ordered = readingPieces([...pieces].sort((a, b) => a.x - b.x));
  let result = '';
  let previous: TextPiece | undefined;
  for (const piece of ordered) {
    // The gap between the pieces' near edges, whichever side the next one lies on.
    const gap =
      previous === undefined
        ? 0
        : Math.max(piece.x - (previous.x + previous.width), previous.x - (piece.x + piece.width));
    const needsSpace = previous !== undefined && gap > WORD_GAP * Math.max(previous.size, piece.size);
    result += `${needsSpace ? ' ' : ''}${piece.text}`;
    previous = piece;
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * Plain text keeps the document's own line breaks and marks paragraphs with a
 * blank line. Markdown re-flows them (a wrapped line is one paragraph line) and
 * separates pages with a thematic break, which is both valid Markdown and easy to
 * spot.
 */
function formatPage(paragraphs: readonly string[][], format: TextExportFormat): string {
  const lines = paragraphs.map((paragraph) => paragraph.join(format === 'markdown' ? ' ' : '\n'));
  return lines.join('\n\n');
}

/** 1-based page number between pages; the export has no other header. */
function pageSeparator(format: TextExportFormat, pageNumber: number): string {
  return format === 'markdown' ? '\n\n---\n\n' : `\n\n----- ${pageNumber} -----\n\n`;
}

export async function exportText(
  bytes: Uint8Array,
  options: TextExportOptions,
  context: OperationContext,
): Promise<TextExportResult> {
  throwIfAborted(context.signal);
  if (options.pages.length === 0) {
    throw new ToolError('selection-empty', { engine: 'model', engineMessage: 'no pages to export' });
  }

  // The adapter hands pdf.js a disposable copy, so the master buffer is safe.
  const handle = await openWithPdfjs(bytes, { signal: context.signal });
  const emptyPages: number[] = [];
  const bodies: { readonly pageNumber: number; readonly text: string }[] = [];

  try {
    const pageCount = handle.pageCount;
    const ordered = [...options.pages].sort((a, b) => a - b);
    for (const page of ordered) {
      if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) {
        throw new ToolError('range-invalid', {
          engine: 'model',
          engineMessage: 'page index out of bounds',
          pageIndex: page,
        });
      }
    }
    context.onProgress?.({
      phase: 'text',
      labelKey: 'op.progress.textExport',
      done: 0,
      total: ordered.length,
    });

    for (const [index, pageIndex] of ordered.entries()) {
      throwIfAborted(context.signal);
      let text: string;
      try {
        const page = await handle.raw.getPage(pageIndex + 1);
        const content = await page.getTextContent();
        // Marked-content markers carry structure, not text; only `TextItem`s have
        // `str` and a text matrix. Written as an explicit loop so the pdf.js item
        // union narrows by its own discriminant instead of being asserted.
        const pieces: TextPiece[] = [];
        for (const item of content.items) {
          if (!('str' in item)) continue;
          pieces.push({
            text: item.str,
            x: item.transform[4],
            y: item.transform[5],
            size: Math.hypot(item.transform[1], item.transform[3]) || item.height || 1,
            width: item.width,
            direction: item.dir === 'rtl' ? 'rtl' : letterCounts(item.str).ltr > 0 ? 'ltr' : null,
          });
        }
        text = formatPage(pageToParagraphs(pieces), options.format);
      } catch (error) {
        throw toToolError(error, 'pdfjs');
      }
      if (text === '') emptyPages.push(pageIndex);
      bodies.push({ pageNumber: pageIndex + 1, text });
      context.onProgress?.({
        phase: 'text',
        labelKey: 'op.progress.textExport',
        done: index + 1,
        total: ordered.length,
      });
    }
  } finally {
    // The handle owns a pdf.js worker; leaking it leaks the whole document copy.
    await handle.destroy();
  }

  const body = bodies
    .map((entry, index) =>
      index === 0 ? entry.text : `${pageSeparator(options.format, entry.pageNumber)}${entry.text}`,
    )
    .join('');
  const stem = options.baseName.replace(/\.pdf$/i, '');
  const markdown = options.format === 'markdown';
  // A UTF-8 BOM makes Windows Notepad show Turkish characters correctly; Markdown
  // parsers treat it as content, so only the plain-text file gets one.
  const encoded = new TextEncoder().encode(markdown ? `${body}\n` : `\uFEFF${body}\n`);

  const file: OutputFile = {
    name: markdown ? `${stem}.md` : `${stem}.txt`,
    bytes: encoded,
    mime: markdown ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8',
  };
  return { file, emptyPages, characterCount: bodies.reduce((total, entry) => total + entry.text.length, 0) };
}
