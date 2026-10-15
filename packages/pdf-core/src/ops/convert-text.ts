/**
 * Plain text and CSV read into HTML, for the conversion to PDF (`ops/convert.ts`).
 *
 * The bytes are decoded as UTF-8 first (a BOM is honoured), and only when that fails
 * as Windows-1254 — the Turkish code page, which every older Turkish text file and
 * Excel CSV export is written in — so `ş`, `ğ` and `ı` survive either way. The report
 * says which decoding was used when it was not UTF-8.
 *
 * Text keeps its line breaks and runs of spaces (`white-space: pre-wrap`) and wraps at
 * the page edge. A CSV becomes one table: the delimiter is the one that splits the first
 * line most consistently (comma, semicolon or tab), and quoted fields may hold the
 * delimiter, doubled quotes and line breaks (RFC 4180). Rows past `MAX_CSV_ROWS` are cut and
 * reported; a table wider than `MAX_CSV_COLUMNS` or past `MAX_CSV_CELLS` cells is refused as
 * `file-too-large`.
 */

import { ToolError } from 'pdf-shared';
import { escapeHtml, type HtmlPart } from './convert-ooxml';
import { note, type OperationNote } from './types';

/** Past this many rows a CSV is cut, and the report says so. */
export const MAX_CSV_ROWS = 20_000;
/**
 * A CSV with a row of more fields than this is refused. Every row is padded to the widest one, so
 * one row of 100 001 fields over 20 000 rows was two billion cells.
 */
export const MAX_CSV_COLUMNS = 1_000;
/** A CSV table (the kept rows × the widest row) of more cells than this is refused. */
export const MAX_CSV_CELLS = 2_000_000;

export interface DecodedText {
  readonly text: string;
  readonly encoding: 'utf-8' | 'windows-1254';
}

export function decodeText(bytes: Uint8Array): DecodedText {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1254').decode(bytes), encoding: 'windows-1254' };
  }
}

export function textToHtml(bytes: Uint8Array): {
  readonly parts: readonly HtmlPart[];
  readonly notes: OperationNote[];
} {
  const decoded = decodeText(bytes);
  const notes: OperationNote[] = [];
  if (decoded.encoding !== 'utf-8')
    notes.push(note('changed', 'op.note.convert.encoding', { encoding: 'Windows-1254' }));
  return { parts: [{ html: `<pre class="text">${escapeHtml(decoded.text)}</pre>`, page: null }], notes };
}

/**
 * RFC 4180 fields, any of the three delimiters; a quoted field may span lines. A row keeps at most
 * `maxColumns + 1` fields: the one past the limit tells the caller the row is too wide, and the
 * rest of that row is read but not stored, so a line of a hundred million delimiters costs time
 * and no memory.
 */
export function parseCsv(text: string, delimiter: string, maxColumns = Number.POSITIVE_INFINITY): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const addField = (): void => {
    if (row.length <= maxColumns) row.push(field);
    field = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"' && field === '') quoted = true;
    else if (character === delimiter) addField();
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      addField();
      rows.push(row);
      row = [];
    } else field += character;
  }
  if (field !== '' || row.length > 0) {
    addField();
    rows.push(row);
  }
  return rows;
}

/** The delimiter that gives the first lines the same, largest field count. */
export function sniffDelimiter(text: string, hint: string | null): string {
  if (hint !== null) return hint;
  const sample = text.split(/\r?\n/, 5).filter((line) => line !== '');
  let best = ',';
  let bestScore = -1;
  for (const candidate of [',', ';', '\t']) {
    const counts = sample.map((line) => parseCsv(line, candidate, MAX_CSV_COLUMNS)[0]?.length ?? 0);
    const first = counts[0] ?? 0;
    const consistent = counts.every((count) => count === first);
    const score = first > 1 ? first + (consistent ? 100 : 0) : 0;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function csvToHtml(
  bytes: Uint8Array,
  tabSeparated: boolean,
): { readonly parts: readonly HtmlPart[]; readonly notes: OperationNote[] } {
  const decoded = decodeText(bytes);
  const notes: OperationNote[] = [];
  if (decoded.encoding !== 'utf-8')
    notes.push(note('changed', 'op.note.convert.encoding', { encoding: 'Windows-1254' }));
  const text = decoded.text.replace(/^﻿/, '');
  let rows = parseCsv(text, sniffDelimiter(text, tabSeparated ? '\t' : null), MAX_CSV_COLUMNS);
  if (rows.length > MAX_CSV_ROWS) {
    notes.push(note('lost', 'op.note.convert.csvTruncated', { rows: MAX_CSV_ROWS, total: rows.length }));
    rows = rows.slice(0, MAX_CSV_ROWS);
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  // Every row is drawn as wide as the widest, so the table is rows × width cells, not the fields read.
  if (width > MAX_CSV_COLUMNS) {
    throw new ToolError('file-too-large', {
      engine: 'model',
      engineMessage: `a CSV row has more than ${MAX_CSV_COLUMNS} fields`,
    });
  }
  if (rows.length * width > MAX_CSV_CELLS) {
    throw new ToolError('file-too-large', {
      engine: 'model',
      engineMessage: `${rows.length} rows of ${width} fields make more than ${MAX_CSV_CELLS} cells`,
    });
  }
  let html = '<table class="sheet">';
  rows.forEach((row, index) => {
    const cell = index === 0 ? 'th' : 'td';
    html += '<tr>';
    for (let column = 0; column < width; column += 1) {
      const value = row[column] ?? '';
      const numeric = index > 0 && value !== '' && Number.isFinite(Number(value.replace(',', '.')));
      html += `<${cell}${numeric ? ' class="n"' : ''}>${escapeHtml(value)}</${cell}>`;
    }
    html += '</tr>';
  });
  html += '</table>';
  return { parts: [{ html, page: null }], notes };
}
