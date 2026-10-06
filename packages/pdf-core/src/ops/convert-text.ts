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
 * delimiter, doubled quotes and line breaks (RFC 4180).
 */

import { escapeHtml, type HtmlPart } from './convert-ooxml';
import { note, type OperationNote } from './types';

/** Past this many rows a CSV is cut, and the report says so. */
export const MAX_CSV_ROWS = 20_000;

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

/** RFC 4180 fields, any of the three delimiters; a quoted field may span lines. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
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
    else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
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
    const counts = sample.map((line) => parseCsv(line, candidate)[0]?.length ?? 0);
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
  let rows = parseCsv(text, sniffDelimiter(text, tabSeparated ? '\t' : null));
  if (rows.length > MAX_CSV_ROWS) {
    notes.push(note('lost', 'op.note.convert.csvTruncated', { rows: MAX_CSV_ROWS, total: rows.length }));
    rows = rows.slice(0, MAX_CSV_ROWS);
  }
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
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
