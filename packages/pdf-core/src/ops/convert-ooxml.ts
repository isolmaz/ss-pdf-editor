/**
 * Office Open XML read into HTML, for the conversion to PDF (`ops/convert.ts`).
 *
 * MuPDF opens `.docx`/`.xlsx`/`.pptx` itself, but only as reflowed text: a spreadsheet
 * came out as its numbers with every label and the grid gone, a slide as one paragraph,
 * and a Word table as a list of cells (measured with MuPDF 1.28.1). So each format is
 * read here into the HTML MuPDF's own layout engine does well — tables with borders,
 * headings, lists, images as data URIs — and MuPDF lays that out and writes the PDF.
 *
 *  - **docx** goes through mammoth (BSD-2-Clause): paragraphs, headings, lists, tables,
 *    bold/italic/underline, links and embedded images. It reads nothing outside the file
 *    (`externalFileAccess` stays off).
 *  - **xlsx** is read here: every sheet becomes one table of its used range, shared and
 *    inline strings, numbers, booleans, built-in and custom date formats, merged cells.
 *    Formulas show their cached value; charts and formatting are not drawn.
 *  - **pptx** is read here: every slide becomes one page of the slide's own size, with its
 *    text in reading order (titles as headings), its tables and its pictures. The slide
 *    design — positions, backgrounds, themes — is not reproduced.
 *
 * The reports say which of these approximations applied (`op.note.convert.*`).
 */

import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { ToolError } from 'pdf-shared';
import { note, type OperationNote } from './types';

/** One piece of the output: HTML laid out on pages of `width` × `height` points. */
export interface HtmlPart {
  readonly html: string;
  /** Page size for this part; `null` takes the caller's chosen page. */
  readonly page: { readonly width: number; readonly height: number } | null;
}

export interface OoxmlResult {
  readonly parts: readonly HtmlPart[];
  /** `dc:title` from `docProps/core.xml`, when the file has one. */
  readonly title: string | null;
  /** What the conversion approximated or left out, for the report. */
  readonly notes: readonly OperationNote[];
}

/** A spreadsheet is cut to this used range; past it the report says what was left out. */
export const MAX_SHEET_ROWS = 5000;
export const MAX_SHEET_COLUMNS = 100;
/** A ZIP entry larger than this is not read (a zip bomb's whole point is the expansion). */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** EMU per point (ECMA-376 §20.1.2.1): 914400 per inch, 72 points per inch. */
const EMU_PER_POINT = 12700;

/* ------------------------------------------------------------------ *
 * XML and HTML helpers
 * ------------------------------------------------------------------ */

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseXml(text: string, path: string): Document {
  let failure: string | null = null;
  const parser = new DOMParser({
    // xmldom 0.8 reads `errorHandler`; an `onError` key is ignored. Only a fatal error
    // stops the conversion: a producer's quirk is a warning and the part still reads.
    errorHandler: (level: string, message: string) => {
      if (level === 'fatalError') failure = message;
    },
  } as never);
  const document = parser.parseFromString(text, 'application/xml') as unknown as Document;
  if (failure !== null || document.documentElement === null) {
    throw new ToolError('corrupt-document', { engine: 'model', path, engineMessage: failure ?? 'empty XML' });
  }
  return document;
}

/** Element children whose local name is `name` (namespace prefixes vary between producers). */
function children(parent: Element | Document | null | undefined, name: string): Element[] {
  const out: Element[] = [];
  if (parent === null || parent === undefined) return out;
  const nodes = parent.childNodes;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as Element;
    if (node.nodeType === 1 && node.localName === name) out.push(node);
  }
  return out;
}

function child(parent: Element | Document | null | undefined, name: string): Element | null {
  return children(parent, name)[0] ?? null;
}

/** Every descendant with this local name, in document order. */
function descendants(parent: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const all = parent.getElementsByTagName('*');
  for (let index = 0; index < all.length; index += 1) {
    const node = all[index] as Element;
    if (node.localName === name) out.push(node);
  }
  return out;
}

const RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/**
 * A relationship id (`r:id`, `r:embed`): the attribute in the relationships namespace,
 * never the element's own unprefixed one — `<p:sldId id="256" r:id="rId2"/>` carries both.
 */
function relationshipAttribute(element: Element, name: string): string | null {
  const attributes = element.attributes;
  for (let index = 0; index < attributes.length; index += 1) {
    const item = attributes[index] as Attr;
    if (item.localName === name && item.namespaceURI === RELATIONSHIPS_NS) return item.value;
  }
  // A producer that wrote the prefix without declaring it.
  return element.getAttribute(`r:${name}`);
}

async function openZip(bytes: Uint8Array, path: string): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new ToolError('corrupt-document', { engine: 'model', path, engineMessage: String(error) });
  }
}

/** A ZIP entry as text, or `null` when absent. */
async function entryText(zip: JSZip, name: string): Promise<string | null> {
  const entry = zip.file(name);
  if (entry === null) return null;
  const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof size === 'number' && size > MAX_ENTRY_BYTES) {
    throw new ToolError('file-too-large', { engine: 'model', path: name });
  }
  return entry.async('string');
}

async function entryBytes(zip: JSZip, name: string): Promise<Uint8Array | null> {
  const entry = zip.file(name);
  if (entry === null) return null;
  return entry.async('uint8array');
}

/** `a/b/../c.xml` → `a/c.xml`; relationship targets are relative to their part's folder. */
function resolvePath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece !== '.' && piece !== '') parts.push(piece);
  }
  return parts.join('/');
}

/** A part's relationships: id → resolved target path (or the raw URL for external ones). */
async function relationships(
  zip: JSZip,
  part: string,
): Promise<Map<string, { target: string; external: boolean }>> {
  const folder = part.split('/').slice(0, -1).join('/');
  const file = part.split('/').pop() ?? '';
  const text = await entryText(zip, `${folder === '' ? '' : `${folder}/`}_rels/${file}.rels`);
  const map = new Map<string, { target: string; external: boolean }>();
  if (text === null) return map;
  for (const rel of descendants(parseXml(text, `${part}.rels`), 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id === null || target === null) continue;
    const external = rel.getAttribute('TargetMode') === 'External';
    map.set(id, { target: external ? target : resolvePath(part, target), external });
  }
  return map;
}

/** `docProps/core.xml`'s `dc:title`, trimmed, or `null`. */
async function coreTitle(zip: JSZip): Promise<string | null> {
  const text = await entryText(zip, 'docProps/core.xml');
  if (text === null) return null;
  const title = descendants(parseXml(text, 'docProps/core.xml'), 'title')[0]?.textContent?.trim() ?? '';
  return title === '' ? null : title;
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

function base64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/** An image part as a data URI MuPDF can decode, or `null` for formats it cannot (EMF, WMF, SVG). */
async function imageDataUri(zip: JSZip, path: string): Promise<string | null> {
  const type = IMAGE_TYPES[(path.split('.').pop() ?? '').toLowerCase()];
  if (type === undefined) return null;
  const bytes = await entryBytes(zip, path);
  return bytes === null ? null : `data:${type};base64,${base64(bytes)}`;
}

/* ------------------------------------------------------------------ *
 * docx (mammoth)
 * ------------------------------------------------------------------ */

export async function docxToHtml(bytes: Uint8Array, path: string): Promise<OoxmlResult> {
  const zip = await openZip(bytes, path);
  if (zip.file('word/document.xml') === null) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path,
      engineMessage: 'no word/document.xml',
    });
  }
  const mammoth = (await import('mammoth')).default;
  const copy = bytes.slice();
  // Node's mammoth reads `buffer`, the browser build `arrayBuffer`; both see the same bytes.
  const input = { buffer: copy, arrayBuffer: copy.buffer } as unknown as Parameters<
    typeof mammoth.convertToHtml
  >[0];
  const result = await mammoth.convertToHtml(input, {
    externalFileAccess: false,
    // Word's title styles are headings to a reader; mammoth's default map leaves them as
    // paragraphs, so a document's title was neither large nor in the outline.
    styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
  });
  const notes: OperationNote[] = [note('changed', 'op.note.convert.docxApproximate')];
  return { parts: [{ html: result.value, page: null }], title: await coreTitle(zip), notes };
}

/* ------------------------------------------------------------------ *
 * xlsx
 * ------------------------------------------------------------------ */

/** Built-in number formats that are dates or times (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** A custom format code that shows a date or time: a d/m/y/h/s outside quotes and brackets. */
function isDateFormat(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  return /[dmyhs]/i.test(bare) && !/^[#0.,%E+\- ]*$/i.test(bare);
}

/** An Excel serial (1900 system, the 1900-02-29 bug included) as ISO date or date-time. */
function serialDate(serial: number, date1904: boolean): string {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const millis = Math.round(serial * 86_400_000);
  const value = new Date(epoch + millis);
  const iso = value.toISOString();
  return millis % 86_400_000 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/** `B12` → `{ column: 1, row: 11 }` (zero-based). */
function cellIndex(reference: string): { readonly column: number; readonly row: number } | null {
  const match = /^([A-Z]+)(\d+)$/i.exec(reference);
  if (match === null) return null;
  let column = 0;
  for (const letter of (match[1] as string).toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64);
  return { column: column - 1, row: Number(match[2]) - 1 };
}

function sharedString(si: Element): string {
  const direct = child(si, 't');
  if (direct !== null) return direct.textContent ?? '';
  return children(si, 'r')
    .map((run) => child(run, 't')?.textContent ?? '')
    .join('');
}

export async function xlsxToHtml(bytes: Uint8Array, path: string): Promise<OoxmlResult> {
  const zip = await openZip(bytes, path);
  const workbookText = await entryText(zip, 'xl/workbook.xml');
  if (workbookText === null) {
    throw new ToolError('unsupported-format', { engine: 'model', path, engineMessage: 'no xl/workbook.xml' });
  }
  const workbook = parseXml(workbookText, 'xl/workbook.xml');
  const date1904 = ['1', 'true'].includes(
    descendants(workbook, 'workbookPr')[0]?.getAttribute('date1904') ?? '',
  );
  const rels = await relationships(zip, 'xl/workbook.xml');

  const sharedText = await entryText(zip, 'xl/sharedStrings.xml');
  const strings =
    sharedText === null
      ? []
      : children(parseXml(sharedText, 'sharedStrings').documentElement, 'si').map(sharedString);

  /** Style index → is this cell a date. */
  const dateStyles: boolean[] = [];
  const stylesText = await entryText(zip, 'xl/styles.xml');
  if (stylesText !== null) {
    const styles = parseXml(stylesText, 'xl/styles.xml');
    const custom = new Map<number, string>();
    for (const format of descendants(styles, 'numFmt')) {
      custom.set(Number(format.getAttribute('numFmtId')), format.getAttribute('formatCode') ?? '');
    }
    const cellXfs = descendants(styles, 'cellXfs')[0];
    for (const xf of children(cellXfs, 'xf')) {
      const id = Number(xf.getAttribute('numFmtId') ?? 0);
      const code = custom.get(id);
      dateStyles.push(BUILTIN_DATE_FORMATS.has(id) || (code !== undefined && isDateFormat(code)));
    }
  }

  const parts: HtmlPart[] = [];
  let truncated = 0;
  const sheets = descendants(workbook, 'sheet');
  for (const sheet of sheets) {
    const name = sheet.getAttribute('name') ?? '';
    const target = rels.get(relationshipAttribute(sheet, 'id') ?? '')?.target;
    if (target === undefined) continue;
    const sheetText = await entryText(zip, target);
    if (sheetText === null) continue;
    const document = parseXml(sheetText, target);

    const grid = new Map<number, Map<number, string>>();
    let maxRow = -1;
    let maxColumn = -1;
    for (const row of descendants(document, 'row')) {
      for (const cell of children(row, 'c')) {
        const at = cellIndex(cell.getAttribute('r') ?? '');
        if (at === null) continue;
        if (at.row >= MAX_SHEET_ROWS || at.column >= MAX_SHEET_COLUMNS) {
          truncated += 1;
          continue;
        }
        const type = cell.getAttribute('t') ?? 'n';
        const raw = child(cell, 'v')?.textContent ?? '';
        let value: string;
        if (type === 's') value = strings[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = sharedString(child(cell, 'is') ?? cell);
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'n' && raw !== '' && dateStyles[Number(cell.getAttribute('s') ?? 0)] === true) {
          value = serialDate(Number(raw), date1904);
        } else value = raw;
        if (value === '') continue;
        let line = grid.get(at.row);
        if (line === undefined) {
          line = new Map();
          grid.set(at.row, line);
        }
        line.set(at.column, value);
        maxRow = Math.max(maxRow, at.row);
        maxColumn = Math.max(maxColumn, at.column);
      }
    }

    /** Merged ranges: the top-left cell spans, the rest are skipped. */
    const spans = new Map<string, { rows: number; columns: number }>();
    const covered = new Set<string>();
    for (const merge of descendants(document, 'mergeCell')) {
      const [from, to] = (merge.getAttribute('ref') ?? '').split(':');
      const start = cellIndex(from ?? '');
      const end = cellIndex(to ?? from ?? '');
      if (start === null || end === null) continue;
      spans.set(`${start.row}:${start.column}`, {
        rows: end.row - start.row + 1,
        columns: end.column - start.column + 1,
      });
      for (let r = start.row; r <= end.row; r += 1) {
        for (let c = start.column; c <= end.column; c += 1) {
          if (r !== start.row || c !== start.column) covered.add(`${r}:${c}`);
        }
      }
    }

    let html = `<h2>${escapeHtml(name)}</h2>`;
    if (maxRow < 0) {
      html += '<p class="empty">—</p>';
    } else {
      html += '<table class="sheet">';
      for (let r = 0; r <= maxRow; r += 1) {
        html += '<tr>';
        for (let c = 0; c <= maxColumn; c += 1) {
          if (covered.has(`${r}:${c}`)) continue;
          const span = spans.get(`${r}:${c}`);
          const attributes =
            span === undefined
              ? ''
              : `${span.rows > 1 ? ` rowspan="${span.rows}"` : ''}${span.columns > 1 ? ` colspan="${span.columns}"` : ''}`;
          const value = grid.get(r)?.get(c) ?? '';
          const numeric = value !== '' && Number.isFinite(Number(value));
          // An empty cell still holds a no-break space: MuPDF draws a cell with no content
          // with no width and no border, which broke the sheet's grid.
          html += `<td${attributes}${numeric ? ' class="n"' : ''}>${value === '' ? '&#160;' : escapeHtml(value)}</td>`;
        }
        html += '</tr>';
      }
      html += '</table>';
    }
    parts.push({ html, page: null });
  }
  if (parts.length === 0) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path,
      engineMessage: 'the workbook has no sheets',
    });
  }
  const notes: OperationNote[] = [note('changed', 'op.note.convert.xlsxApproximate')];
  if (truncated > 0) {
    notes.push(
      note('lost', 'op.note.convert.xlsxTruncated', {
        rows: MAX_SHEET_ROWS,
        columns: MAX_SHEET_COLUMNS,
        cells: truncated,
      }),
    );
  }
  return { parts, title: await coreTitle(zip), notes };
}

/* ------------------------------------------------------------------ *
 * pptx
 * ------------------------------------------------------------------ */

interface SlideContext {
  readonly zip: JSZip;
  readonly rels: Map<string, { target: string; external: boolean }>;
  skippedImages: number;
}

function runsHtml(paragraph: Element): string {
  let html = '';
  for (let index = 0; index < paragraph.childNodes.length; index += 1) {
    const node = paragraph.childNodes[index] as Element;
    if (node.nodeType !== 1) continue;
    if (node.localName === 'br') {
      html += '<br>';
      continue;
    }
    if (node.localName !== 'r' && node.localName !== 'fld') continue;
    const text = escapeHtml(child(node, 't')?.textContent ?? '');
    if (text === '') continue;
    const props = child(node, 'rPr');
    let piece = text;
    if (props?.getAttribute('b') === '1') piece = `<b>${piece}</b>`;
    if (props?.getAttribute('i') === '1') piece = `<i>${piece}</i>`;
    if ((props?.getAttribute('u') ?? 'none') !== 'none') piece = `<u>${piece}</u>`;
    // `sz` is in hundredths of a point (ECMA-376 §21.1.2.3.9).
    const size = Number(props?.getAttribute('sz') ?? Number.NaN) / 100;
    if (Number.isFinite(size) && size >= 4 && size <= 200)
      piece = `<span style="font-size:${size}pt">${piece}</span>`;
    html += piece;
  }
  return html;
}

function textBodyHtml(body: Element, heading: boolean): string {
  let html = '';
  let list = false;
  for (const paragraph of children(body, 'p')) {
    const content = runsHtml(paragraph);
    if (content === '') continue;
    const props = child(paragraph, 'pPr');
    const bullet = props !== null && (child(props, 'buChar') !== null || child(props, 'buAutoNum') !== null);
    if (heading) {
      html += `<h1>${content}</h1>`;
      continue;
    }
    if (bullet && !list) {
      html += '<ul>';
      list = true;
    } else if (!bullet && list) {
      html += '</ul>';
      list = false;
    }
    html += bullet ? `<li>${content}</li>` : `<p>${content}</p>`;
  }
  if (list) html += '</ul>';
  return html;
}

function tableHtml(table: Element, width: number | null): string {
  let html = width === null ? '<table>' : `<table style="width:${width.toFixed(1)}pt">`;
  for (const row of children(table, 'tr')) {
    html += '<tr>';
    for (const cell of children(row, 'tc')) {
      if (cell.getAttribute('hMerge') === '1' || cell.getAttribute('vMerge') === '1') continue;
      const span = Number(cell.getAttribute('gridSpan') ?? 1);
      const body = child(cell, 'txBody');
      html += `<td${span > 1 ? ` colspan="${span}"` : ''}>${body === null ? '' : textBodyHtml(body, false)}</td>`;
    }
    html += '</tr>';
  }
  return `${html}</table>`;
}

/** The shapes of a tree in reading order: top to bottom, then left to right. */
function readingOrder(shapes: Element[]): Element[] {
  const position = (shape: Element): readonly [number, number] => {
    const offset = descendants(shape, 'off')[0];
    return [Number(offset?.getAttribute('y') ?? 0), Number(offset?.getAttribute('x') ?? 0)];
  };
  return shapes
    .map((shape, index) => ({ shape, index, at: position(shape) }))
    .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.index - b.index)
    .map((item) => item.shape);
}

async function shapeTreeHtml(tree: Element, context: SlideContext): Promise<string> {
  const shapes = Array.from(
    { length: tree.childNodes.length },
    (_value, index) => tree.childNodes[index] as Element,
  ).filter(
    (node) => node.nodeType === 1 && ['sp', 'pic', 'graphicFrame', 'grpSp'].includes(node.localName ?? ''),
  );
  let html = '';
  for (const shape of readingOrder(shapes)) {
    if (shape.localName === 'grpSp') {
      html += await shapeTreeHtml(shape, context);
      continue;
    }
    if (shape.localName === 'sp') {
      const body = child(shape, 'txBody');
      if (body === null) continue;
      const placeholder = descendants(shape, 'ph')[0]?.getAttribute('type') ?? '';
      html += textBodyHtml(body, placeholder === 'title' || placeholder === 'ctrTitle');
      continue;
    }
    if (shape.localName === 'graphicFrame') {
      const table = descendants(shape, 'tbl')[0];
      // The frame's width on the slide (`p:xfrm/a:ext/@cx`), so a table is as wide as drawn.
      const frameWidth = Number(descendants(shape, 'ext')[0]?.getAttribute('cx') ?? 0) / EMU_PER_POINT;
      if (table !== undefined) html += tableHtml(table, frameWidth > 0 ? frameWidth : null);
      continue;
    }
    // A picture: its size on the slide, its bytes from the slide's relationships.
    const blip = descendants(shape, 'blip')[0];
    const target =
      blip === undefined ? undefined : context.rels.get(relationshipAttribute(blip, 'embed') ?? '');
    const uri =
      target === undefined || target.external ? null : await imageDataUri(context.zip, target.target);
    if (uri === null) {
      context.skippedImages += 1;
      continue;
    }
    const extent = descendants(shape, 'ext')[0];
    const width = Number(extent?.getAttribute('cx') ?? 0) / EMU_PER_POINT;
    const height = Number(extent?.getAttribute('cy') ?? 0) / EMU_PER_POINT;
    html +=
      width > 0 && height > 0
        ? `<p><img src="${uri}" style="width:${width.toFixed(1)}pt;height:${height.toFixed(1)}pt"></p>`
        : `<p><img src="${uri}"></p>`;
  }
  return html;
}

export async function pptxToHtml(bytes: Uint8Array, path: string): Promise<OoxmlResult> {
  const zip = await openZip(bytes, path);
  const presentationText = await entryText(zip, 'ppt/presentation.xml');
  if (presentationText === null) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path,
      engineMessage: 'no ppt/presentation.xml',
    });
  }
  const presentation = parseXml(presentationText, 'ppt/presentation.xml');
  const size = descendants(presentation, 'sldSz')[0];
  const page = {
    width: Number(size?.getAttribute('cx') ?? 9144000) / EMU_PER_POINT,
    height: Number(size?.getAttribute('cy') ?? 6858000) / EMU_PER_POINT,
  };
  const rels = await relationships(zip, 'ppt/presentation.xml');
  const parts: HtmlPart[] = [];
  let skippedImages = 0;
  for (const id of descendants(presentation, 'sldId')) {
    const target = rels.get(relationshipAttribute(id, 'id') ?? '')?.target;
    if (target === undefined) continue;
    const slideText = await entryText(zip, target);
    if (slideText === null) continue;
    const slide = parseXml(slideText, target);
    if (slide.documentElement.getAttribute('show') === '0') continue;
    const context: SlideContext = { zip, rels: await relationships(zip, target), skippedImages: 0 };
    const tree = descendants(slide, 'spTree')[0];
    const html = tree === undefined ? '' : await shapeTreeHtml(tree, context);
    skippedImages += context.skippedImages;
    parts.push({ html: `<div class="slide">${html === '' ? '<p></p>' : html}</div>`, page });
  }
  if (parts.length === 0) {
    throw new ToolError('unsupported-format', {
      engine: 'model',
      path,
      engineMessage: 'the presentation has no slides',
    });
  }
  const notes: OperationNote[] = [note('changed', 'op.note.convert.pptxApproximate')];
  if (skippedImages > 0) notes.push(note('lost', 'op.note.convert.imagesSkipped', { count: skippedImages }));
  return { parts, title: await coreTitle(zip), notes };
}
