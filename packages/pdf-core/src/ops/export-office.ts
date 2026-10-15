/**
 * PDF → Word (DOCX), Excel (XLSX) and CSV.
 *
 * The ideas are pdf2docx's (MIT-licensed Python; nothing of its code is used): read the
 * page as layout — text blocks with their fonts, pictures, ruling lines
 * (`ops/page-layout.ts`) — and rebuild it in the target format's own flow model instead of
 * pinning every line to a coordinate, so the result is editable text that reflows.
 *
 *  - **DOCX**: one section per page (its size, orientation and margins come from the page),
 *    one paragraph per run of lines MuPDF grouped as a block, split where a line ends short
 *    or a gap opens. Runs keep the font family, size, bold, italic and colour; a paragraph
 *    whose type is clearly larger than the body text becomes a heading (`Heading1`–`3`, so
 *    Word's navigation pane and table of contents see it). Alignment, indents, the gap
 *    before a paragraph and the line pitch are measured from the page, in the paragraph's
 *    own column on a two-column page. Ruled tables become Word tables with their merged
 *    cells, tables read from the spacing of the text borderless ones; pictures are placed
 *    inline at their size, and a vector drawing (a chart, a diagram) as one picture of its
 *    region, drawn without its text. Text that stands on a drawing or a picture stays text,
 *    and the picture is anchored behind it. The package is written by hand (WordprocessingML is plain XML in a ZIP) and
 *    read back with mammoth, an independent reader, whose words have to match the words
 *    written. `docxLayout: 'page-images'` writes a different Word file: each page one
 *    picture of the page, exact but not editable (`ops/docx-pages.ts`); `docxLayout:
 *    'layout'` rebuilds each page where the PDF has it, the text in positioned text boxes
 *    above the shapes and pictures (exact and editable, `ops/docx-layout.ts`); the XML the
 *    writers share is in `ops/docx-drawing.ts`.
 *  - **XLSX**: one sheet per table (ruled or read from spacing), with merged cells and
 *    column widths. A page without any table becomes one sheet of its text rows, split at
 *    wide gaps and aligned on shared column starts. A value becomes a number only when it
 *    reads one way: `1.234,5` and `1,234.5` do, `1.234` (a thousand, or one point two three
 *    four) stays text.
 *  - **CSV**: the same tables as the spreadsheet, separated by an empty line, UTF-8 with a
 *    BOM so Excel reads Turkish letters.
 *
 * What is not carried over is said in the report: exact positions, a paragraph's
 * continuation in the next column, form fields, annotations; text on scanned pages (OCR
 * first). The exact layout does carry a filled form field's value and an annotation's text,
 * as text where it is (its appearance), and names the fields whose value nothing draws. The
 * flowing layout leaves out the text the document itself hides and says how much, except the
 * invisible OCR layer over a scanned page's picture.
 */

import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import type { PDFDocument } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError, openPdf } from '../engines/mupdf';
import { readText } from '../engines/mupdf-write';
import { charDirection, hasRtlScript, readingOrder, resolveNeutrals } from './bidi';
import { parseCsv } from './convert-text';
import {
  contentTypesXml,
  corePropertiesXml,
  documentRelsXml,
  EMU,
  imageRelId,
  PACKAGE_RELS,
  TWIPS,
  wordDocumentXml,
  XML_HEAD,
  xml,
  xmlSafe,
  zipped,
} from './docx-drawing';
import { type LayoutDocx, type OcrOptions, writeLayoutDocx } from './docx-layout';
import { coversPage } from './docx-layout-mixed';
import { type PageImage, pageImagesDocx, renderPageImages } from './docx-pages';
import {
  type Box,
  findFigures,
  findTables,
  findTextTables,
  inside,
  type LayoutBlock,
  type LayoutChar,
  type LayoutLine,
  type LayoutTable,
  lineSegments,
  type PageLayout,
  readPageLayout,
  renderRegion,
  segmentInside,
  type TableCell,
  textRows,
} from './page-layout';
import { note, type OperationContext, type OperationNote, type OutputFile, throwIfAborted } from './types';

export type OfficeFormat = 'docx' | 'xlsx' | 'csv';
export type CsvDelimiter = ',' | ';';
/**
 * How a Word file is built: `flow` reads the page as text, tables and pictures that reflow
 * (editable); `page-images` draws each page as one picture of the page (exact, not editable);
 * `layout` rebuilds each page where the PDF has it — shapes, pictures and links in place, the
 * text in positioned text boxes above them (exact and editable).
 */
export type DocxLayout = 'flow' | 'page-images' | 'layout';

export interface OfficeExportOptions {
  /** 0-based page indices, ascending. */
  readonly pages: readonly number[];
  readonly format: OfficeFormat;
  /** Word only; `flow` when left out. */
  readonly docxLayout?: DocxLayout;
  /**
   * Exact layout only: reads the pages that are pictures without text. `recognize` gets the page
   * as a PNG and its pixels per point, and returns the words (page points, confidence 0–100);
   * a word below `lowConfidence` (0–1) is marked with a Word comment and listed in the report.
   * Without it a scanned page stays a picture (and the report says OCR was not available).
   */
  readonly ocr?: OcrOptions;
  readonly baseName: string;
  readonly csvDelimiter?: CsvDelimiter;
  /** Sheet names in the reader's language: `table(1)` → `Table 1`, `page(3)` → `Page 3`. */
  readonly sheetName?: { readonly table: (n: number) => string; readonly page: (n: number) => string };
}

export interface OfficeExportResult {
  readonly file: OutputFile;
  readonly steps: readonly string[];
  readonly notes: readonly OperationNote[];
}

const MIME: Readonly<Record<OfficeFormat, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv;charset=utf-8',
};

/** A gap larger than this before a paragraph is drawn as this (points); see `docxPage`. */
const MAX_GAP = 48;

/* ------------------------------------------------------------------ *
 * shared
 * ------------------------------------------------------------------ */

function words(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/** Families MuPDF substitutes or PDFs name in their PostScript form, as Word knows them. */
const FAMILY_NAMES: Readonly<Record<string, string>> = {
  NimbusSans: 'Arial',
  NimbusSanL: 'Arial',
  Helvetica: 'Arial',
  ArialMT: 'Arial',
  NimbusRoman: 'Times New Roman',
  NimbusRomNo9L: 'Times New Roman',
  Times: 'Times New Roman',
  TimesNewRoman: 'Times New Roman',
  TimesNewRomanPS: 'Times New Roman',
  NimbusMono: 'Courier New',
  NimbusMonoPS: 'Courier New',
  Courier: 'Courier New',
  CourierNew: 'Courier New',
  CourierNewPS: 'Courier New',
  // MuPDF hands these glyphs over as Unicode (Greek letters, ✓, ➔); Word's own Symbol and
  // Wingdings fonts are symbol-encoded and would show other glyphs for the same text.
  Symbol: 'Segoe UI Symbol',
  Dingbats: 'Segoe UI Symbol',
  ZapfDingbats: 'Segoe UI Symbol',
  DejaVuSans: 'DejaVu Sans',
  DejaVuSerif: 'DejaVu Serif',
  DejaVuSansMono: 'DejaVu Sans Mono',
};

/**
 * Families by what they are called, matched on the lower-cased name without punctuation: the
 * ones Word (or any Windows machine) ships are kept by name, the rest of the sans, serif and
 * monospaced families PDFs embed are answered by the metric-compatible standard font of their
 * kind (`HelveticaNeueLTStd`, `Univers`, `MyriadPro` → Arial; `MinionPro`, `Garamond` →
 * Times New Roman). Word and LibreOffice substitute an unknown name with a serif face.
 */
const KEPT =
  /^(?:calibri|cambria|candara|corbel|constantia|consolas|segoe|verdana|georgia|tahoma|trebuchet|noto)/;
const SANS =
  /^(?:itc|adobe|ms|mt|lt)?(?:helvetica|arial|univers|frutiger|myriad|nimbussans|liberationsans|swiss|avenir|futura|gillsans|lato|roboto|opensans|sourcesans|ptsans|franklin)/;
const SERIF =
  /^(?:itc|adobe|ms|mt|lt)?(?:times|minion|garamond|nimbusroman|liberationserif|palatino|bookman|baskerville|caslon|bodoni|didot|centuryschool|newcentury|charter|sabon|utopia)/;
const MONO = /^(?:itc|adobe|ms|mt|lt)?(?:courier|nimbusmono|liberationmono|lucidaconsole)/;

/** What the font's own flags say, for a family the table does not know. */
export interface FontKind {
  readonly serif: boolean;
  readonly mono: boolean;
}

/**
 * `TimesNewRomanPS` → `Times New Roman`; `SegoeUI` → `Segoe UI`; `Calibri` stays;
 * `HelveticaNeueLTStd` → `Arial`. An unknown family is named as it is without `kind`, and by
 * its class (monospaced, serif, else sans) with it.
 */
export function wordFontName(family: string, kind?: FontKind): string {
  const known = FAMILY_NAMES[family];
  if (known !== undefined) return known;
  const key = family.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!KEPT.test(key)) {
    if (SANS.test(key)) return 'Arial';
    if (SERIF.test(key)) return 'Times New Roman';
    if (MONO.test(key)) return 'Courier New';
    if (kind !== undefined) return kind.mono ? 'Courier New' : kind.serif ? 'Times New Roman' : 'Arial';
  }
  return family
    .replace(/PS$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
}

/* ------------------------------------------------------------------ *
 * reading
 * ------------------------------------------------------------------ */

interface ReadPage {
  readonly index: number;
  readonly layout: PageLayout;
  /** Ruled tables. */
  readonly tables: readonly LayoutTable[];
  /** Tables read from the spacing of the text, outside the ruled ones and the drawings. */
  readonly streams: readonly LayoutTable[];
  /** Vector drawings, rendered as pictures (Word only). */
  readonly figures: readonly { readonly box: Box; readonly png: Uint8Array }[];
  /** Characters of the document's own hidden text left out (Word only; `withoutHiddenText`). */
  readonly hidden: number;
  /** Pictures the page paints (`ReadLayout.pictures`), which a sheet cannot carry. */
  readonly pictures: number;
}

/** The box that holds all of `boxes`. */
function unionBox(boxes: readonly Box[]): Box {
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3])),
  ];
}

/**
 * The page as the reader sees it: text the document itself hides (render mode 3, no opacity) is
 * left out, as the exact layout leaves it out, and counted (`dropped`, characters). The hidden text
 * kept is a scan's OCR layer, exported on purpose since it is the only text the scan has: on a
 * page whose pictures cover most of it (`isScanPage`'s test), a hidden character that lies over a
 * picture. One over blank paper is the document's own, wherever it is, and a page's visible text
 * (a Bates number, a header) changes nothing about the layer. Needs the picture blocks, so only a
 * read with `images` can tell.
 */
function withoutHiddenText(layout: PageLayout): { readonly layout: PageLayout; readonly dropped: number } {
  const lines = layout.blocks.flatMap((block) => (block.kind === 'text' ? block.lines : []));
  if (!lines.some((line) => line.chars.some((char) => char.invisible === true))) {
    return { layout, dropped: 0 };
  }
  const pictures = layout.blocks.flatMap((block) => (block.kind === 'image' ? [block.box] : []));
  const area = pictures.reduce(
    (sum, box) => sum + Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]),
    0,
  );
  const scan = coversPage(area, layout.width, layout.height);
  /** Whether a character lies over a picture of a scanned page (its centre inside the picture). */
  const overPicture = (char: LayoutChar): boolean =>
    scan &&
    pictures.some(
      (box) =>
        (char.box[0] + char.box[2]) / 2 >= box[0] &&
        (char.box[0] + char.box[2]) / 2 <= box[2] &&
        (char.box[1] + char.box[3]) / 2 >= box[1] &&
        (char.box[1] + char.box[3]) / 2 <= box[3],
    );
  let dropped = 0;
  const kept = (char: LayoutChar): boolean => {
    if (char.invisible !== true || overPicture(char)) return true;
    if (char.c.trim() !== '') dropped += 1;
    return false;
  };
  const blocks = layout.blocks.flatMap((block): LayoutBlock[] => {
    if (block.kind !== 'text') return [block];
    const remaining = block.lines.flatMap((line): LayoutLine[] => {
      const chars = line.chars.filter(kept);
      if (chars.length === 0) return [];
      return [chars.length === line.chars.length ? line : { ...line, chars, box: lineBox(chars) }];
    });
    if (remaining.length === 0) return [];
    const same =
      remaining.length === block.lines.length && remaining.every((line, at) => line === block.lines[at]);
    return [same ? block : { ...block, lines: remaining, box: unionBox(remaining.map((line) => line.box)) }];
  });
  return { layout: { ...layout, blocks }, dropped };
}

/**
 * Reads the pages one at a time and hands each to `keep` before it reads the next: a page's layout
 * (an object for every character) and the pictures of its drawings are let go as soon as `keep`
 * has taken what the export needs of the page, so a long document is never held whole in memory.
 * MuPDF reads a page synchronously, so unlike the exact layout's reads of scanned pages
 * (`ops/docx-layout.ts`, which OCR in parallel) there is nothing to read ahead of the page being kept.
 */
async function readPages(
  doc: PDFDocument,
  pages: readonly number[],
  images: boolean,
  context: OperationContext,
  keep: (page: ReadPage) => void,
): Promise<void> {
  const mupdf = await loadMupdf();
  for (const [done, index] of pages.entries()) {
    throwIfAborted(context.signal);
    context.onProgress?.({
      phase: 'read',
      labelKey: 'op.progress.exportOffice.read',
      done,
      total: pages.length,
    });
    const page = doc.loadPage(index);
    try {
      // Word only: telling a scan's OCR layer from hidden text takes the pictures (see `withoutHiddenText`).
      const read = readPageLayout(mupdf, page, { images });
      const { layout, dropped: hidden } = images ? withoutHiddenText(read) : { layout: read, dropped: 0 };
      const tables = findTables(layout);
      const ruled = tables.map((table) => table.box);
      // A chart's labels line up like a table's cells, so drawings are found first.
      const drawn = findFigures(layout, ruled);
      // Only a Word document carries the drawings, as pictures.
      const figures = images ? drawn.map((box) => ({ box, png: renderRegion(mupdf, page, box) })) : [];
      const streams = findTextTables(layout, [...ruled, ...drawn]);
      keep({ index, layout, tables, streams, figures, hidden, pictures: read.pictures });
    } finally {
      page.destroy();
    }
    // Give the event loop a turn so the progress bar and Cancel stay live.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/* ------------------------------------------------------------------ *
 * DOCX
 * ------------------------------------------------------------------ */

interface Run {
  readonly text: string;
  readonly font: string;
  /** Half-points, as `w:sz` wants them. */
  readonly half: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly color: number;
  /** Set in a right-to-left script (`w:rtl`), numbers and spaces among it included. */
  readonly rtl: boolean;
}

interface Paragraph {
  readonly kind: 'paragraph';
  readonly runs: readonly Run[];
  readonly box: Box;
  readonly lines: readonly Box[];
  /** Points; `0` for one line. */
  readonly pitch: number;
  /** The size most of the paragraph's characters have. */
  readonly size: number;
  readonly bold: boolean;
  /** Read right to left (`w:bidi`): more of its letters are of a right-to-left script than not. */
  readonly rtl: boolean;
}

interface Picture {
  readonly kind: 'picture';
  readonly box: Box;
  readonly png: Uint8Array;
  /**
   * Text stands on it: it is anchored behind the text to a paragraph that holds its place in
   * the flow, and takes no room there — inline it would push the text it carries to the next page.
   */
  readonly behind: boolean;
}

interface Grid {
  readonly kind: 'table';
  readonly box: Box;
  readonly table: LayoutTable;
  /** Each cell's paragraphs, by `row:column`. */
  readonly cells: ReadonlyMap<string, readonly Paragraph[]>;
}

type Item = Paragraph | Picture | Grid;

function textOf(paragraph: Paragraph): string {
  return paragraph.runs.map((run) => run.text).join('');
}

/** How many visible characters of a list have each size, in half points. */
function sizeCounts(chars: readonly LayoutChar[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const char of chars) {
    if (char.c.trim() === '') continue;
    const half = Math.round(char.size * 2);
    counts.set(half, (counts.get(half) ?? 0) + 1);
  }
  return counts;
}

/** The size, rounded to a half point, that most characters in a list have. */
function commonSize(chars: readonly LayoutChar[]): number {
  return commonOf(sizeCounts(chars));
}

/** The size with the most characters (the first counted of equals), in points; `0` for none. */
function commonOf(counts: ReadonlyMap<number, number>): number {
  let best = 0;
  let bestCount = -1;
  for (const [half, count] of counts) {
    if (count > bestCount) {
      best = half;
      bestCount = count;
    }
  }
  return best / 2;
}

function lineBox(chars: readonly LayoutChar[]): Box {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const char of chars) {
    x0 = Math.min(x0, char.box[0]);
    y0 = Math.min(y0, char.box[1]);
    x1 = Math.max(x1, char.box[2]);
    y1 = Math.max(y1, char.box[3]);
  }
  return [x0, y0, x1, y1];
}

/** The row a line stands on: its middle and how far from it another line still shares the row. */
function rowOf(chars: readonly LayoutChar[]): { middle: number; reach: number; box: Box } {
  const box = lineBox(chars);
  return { middle: (box[1] + box[3]) / 2, reach: (box[3] - box[1]) * 0.3, box };
}

/** Lines in reading order: by row from the top, and along a row from the left. */
function byRow(a: readonly LayoutChar[], b: readonly LayoutChar[]): number {
  const first = rowOf(a);
  const second = rowOf(b);
  if (Math.abs(first.middle - second.middle) <= Math.min(first.reach, second.reach)) {
    return first.box[0] - second.box[0];
  }
  return first.middle - second.middle;
}

/** Whether more of the letters are of a right-to-left script than of any other. */
function rightToLeft(chars: readonly LayoutChar[]): boolean {
  let rtl = 0;
  let ltr = 0;
  for (const char of chars) {
    const direction = charDirection(char.c);
    if (direction === 'rtl') rtl += 1;
    else if (direction === 'ltr') ltr += 1;
  }
  return rtl > ltr;
}

/**
 * Lines that stand on one row and follow each other along it are one line. MuPDF cuts a
 * line where the spacing opens, so the dots that lead from a label to its amount
 * (`. . . . .`) come as a line each, and each would be a paragraph of its own. Right-to-left
 * text follows along the row to the left: the next line is joined when both hold right-to-left
 * letters and it ends where the line so far begins.
 */
function joinRows(lines: readonly LayoutChar[][]): LayoutChar[][] {
  const out: LayoutChar[][] = [];
  for (const chars of lines) {
    const last = out[out.length - 1];
    if (last !== undefined) {
      const before = rowOf(last);
      const next = rowOf(chars);
      const tail = last[last.length - 1] as LayoutChar;
      const sameRow = Math.abs(before.middle - next.middle) <= Math.min(before.reach, next.reach);
      const gap = next.box[0] - before.box[2];
      const leftGap = before.box[0] - next.box[2];
      const rightward = sameRow && gap >= -1 && gap <= tail.size * 2;
      const leftward =
        !rightward &&
        sameRow &&
        leftGap >= -1 &&
        leftGap <= tail.size * 2 &&
        last.some((char) => charDirection(char.c) === 'rtl') &&
        chars.some((char) => charDirection(char.c) === 'rtl');
      if (rightward || leftward) {
        const along = rightward ? gap : leftGap;
        const spaced = tail.c === ' ' || chars[0]?.c === ' ' || along < tail.size * 0.15;
        const space: LayoutChar = {
          ...tail,
          c: ' ',
          box: rightward
            ? [before.box[2], tail.box[1], next.box[0], tail.box[3]]
            : [next.box[2], tail.box[1], before.box[0], tail.box[3]],
        };
        out[out.length - 1] = [...last, ...(spaced ? [] : [space]), ...chars];
        continue;
      }
    }
    out.push([...chars]);
  }
  return out;
}

/** One run of a row's characters that stand together and run one way: what reading order moves whole. */
interface Fragment {
  readonly chars: LayoutChar[];
  readonly direction: 'rtl' | 'ltr';
  x0: number;
  x1: number;
}

/**
 * The characters of one row in the order they are read. MuPDF puts the letters of a run of
 * Hebrew or Arabic in reading order, but the runs of a row stay where the producer showed them
 * on the page, which is left to right across the row; in a right-to-left row the first word is
 * the rightmost. The row is cut into fragments — runs of one direction, and wherever the next
 * character lies back along a run's own way, a new run — and the fragments are put in the
 * order of the bidirectional algorithm (`readingOrder`) from where they stand on the page, so
 * the text is the same whichever order the PDF showed the runs in. Where two fragments are a
 * gap apart with no space between them, a space is put in. A row without a right-to-left
 * character is returned as it is.
 */
function inReadingOrder(row: LayoutChar[], rtlBase: boolean): LayoutChar[] {
  if (!row.some((char) => hasRtlScript(char.c))) return row;
  const resolved = resolveNeutrals(
    row.map((char) => charDirection(char.c)),
    rtlBase,
  );
  const centre = (char: LayoutChar) => (char.box[0] + char.box[2]) / 2;
  const fragments: Fragment[] = [];
  for (const [at, char] of row.entries()) {
    const direction = resolved[at] as 'rtl' | 'ltr';
    const last = fragments[fragments.length - 1];
    const before = row[at - 1];
    // Along a run of right-to-left text the next character lies to the left, along one of
    // left-to-right text to the right; a jump the other way (a quarter of the size) starts a run.
    const slack = char.size * 0.25;
    const jumped =
      before !== undefined &&
      (direction === 'rtl' ? centre(char) > centre(before) + slack : centre(char) < centre(before) - slack);
    if (last === undefined || last.direction !== direction || jumped) {
      fragments.push({ chars: [char], direction, x0: char.box[0], x1: char.box[2] });
    } else {
      // The gap between two characters of a run is a space MuPDF has already put in.
      last.chars.push(char);
      last.x0 = Math.min(last.x0, char.box[0]);
      last.x1 = Math.max(last.x1, char.box[2]);
    }
  }
  const onPage = [...fragments].sort((a, b) => a.x0 + a.x1 - (b.x0 + b.x1));
  const read = readingOrder(
    onPage.map((fragment) => fragment.direction),
    rtlBase,
  ).map((at) => onPage[at] as Fragment);
  const out: LayoutChar[] = [];
  for (const [at, fragment] of read.entries()) {
    const previous = read[at - 1];
    if (previous !== undefined) {
      const tail = previous.chars[previous.chars.length - 1] as LayoutChar;
      const head = fragment.chars[0] as LayoutChar;
      const gap = Math.max(fragment.x0 - previous.x1, previous.x0 - fragment.x1);
      if (gap >= tail.size * 0.15 && tail.c.trim() !== '' && head.c.trim() !== '') {
        const right = fragment.x0 >= previous.x1;
        out.push({
          ...tail,
          c: ' ',
          box: right
            ? [previous.x1, tail.box[1], fragment.x0, tail.box[3]]
            : [fragment.x1, tail.box[1], previous.x0, tail.box[3]],
        });
      }
    }
    out.push(...fragment.chars);
  }
  return out;
}

const HYPHENS = new Set(['-', '\u00AD', '\u2010']);

/**
 * Lines of one block, cut into paragraphs. A new paragraph starts after a line that ends
 * well short of the block's right edge (the last line of a paragraph), where the gap to the
 * next line is wider than the line pitch so far, or at a bullet.
 */
function blockParagraphs(lines: readonly LayoutChar[][]): Paragraph[] {
  const rows = joinRows(lines.filter((chars) => chars.some((char) => char.c.trim() !== '')));
  if (rows.length === 0) return [];
  // Each row in the order it is read; the block's direction decides a row that holds both
  // (a Latin name in a Hebrew sentence), a row that is mostly right-to-left decides itself.
  const hasRtl = rows.some((row) => row.some((char) => hasRtlScript(char.c)));
  const blockRtl = hasRtl && rightToLeft(rows.flat());
  const kept = hasRtl ? rows.map((row) => inReadingOrder(row, blockRtl || rightToLeft(row))) : rows;
  const boxes = kept.map(lineBox);
  const right = Math.max(...boxes.map((box) => box[2]));
  const left = Math.min(...boxes.map((box) => box[0]));
  const groups: number[][] = [];
  for (let index = 0; index < kept.length; index += 1) {
    const box = boxes[index] as Box;
    const group = groups[groups.length - 1];
    if (group === undefined) {
      groups.push([index]);
      continue;
    }
    const previousIndex = group[group.length - 1] as number;
    const previous = boxes[previousIndex] as Box;
    const previousChars = kept[previousIndex] as LayoutChar[];
    const size = commonSize(previousChars);
    const height = previous[3] - previous[1];
    const gap = box[1] - previous[3];
    const pitch =
      group.length > 1
        ? (previous[1] - (boxes[group[0] as number] as Box)[1]) / (group.length - 1)
        : height * 1.25;
    const leading = (kept[index] as LayoutChar[])
      .map((char) => char.c)
      .join('')
      .trimStart();
    // A line ends short at the right edge, or at the left one in right-to-left text, which starts at the right.
    const shortLine = blockRtl
      ? previous[0] > left + Math.max(size * 3, (previous[2] - left) * 0.12)
      : previous[2] < right - Math.max(size * 3, (right - previous[0]) * 0.12);
    const wideGap = gap > Math.max(height * 0.6, pitch - height + size * 0.5);
    const bullet = /^[•▪◦‣●○■□–—*·]/.test(leading) || /^\d{1,2}[.)]\s/.test(leading);
    // A different size starts a new paragraph too: a heading run into its body text.
    const resized = Math.abs(commonSize(kept[index] as LayoutChar[]) - size) >= 1;
    if (shortLine || wideGap || bullet || resized) groups.push([index]);
    else group.push(index);
  }

  return groups.map((group) => {
    const chars: LayoutChar[] = [];
    const runs: Run[] = [];
    let text = '';
    let style: Omit<Run, 'text'> | null = null;
    const paragraphRtl = hasRtl && rightToLeft(group.flatMap((index) => kept[index] as LayoutChar[]));
    const flush = () => {
      if (style !== null && text !== '') runs.push({ ...style, text });
      text = '';
    };
    const push = (char: LayoutChar, c: string) => {
      // A letter says which way it runs; a digit, a space or a sign runs the way the run it is in does.
      const direction = hasRtl ? charDirection(c) : null;
      const next = {
        font: wordFontName(char.font),
        half: Math.max(2, Math.round(char.size * 2)),
        bold: char.bold,
        italic: char.italic,
        color: char.color,
        rtl: direction === null ? (style?.rtl ?? paragraphRtl) : direction === 'rtl',
      };
      // A space takes the style of the run it sits in, so runs are not split around it.
      const same =
        style !== null &&
        (c === ' ' ||
          (style.font === next.font &&
            style.half === next.half &&
            style.bold === next.bold &&
            style.italic === next.italic &&
            style.color === next.color &&
            style.rtl === next.rtl));
      if (!same) {
        flush();
        style = next;
      }
      text += c;
    };
    for (const [position, lineIndex] of group.entries()) {
      const line = kept[lineIndex] as LayoutChar[];
      chars.push(...line);
      if (position > 0) {
        // Join the line to the previous one: drop a hyphen that breaks a word, else a space.
        const nextChar = line.find((char) => char.c.trim() !== '');
        // The text so far, across runs: a hyphen set in another style than the letters
        // before it still breaks the word.
        const written = runs.map((run) => run.text).join('') + text;
        const last = written.slice(-1);
        const beforeLast = written.slice(-2, -1);
        if (
          HYPHENS.has(last) &&
          /\p{L}/u.test(beforeLast) &&
          nextChar !== undefined &&
          /\p{Ll}/u.test(nextChar.c)
        ) {
          // The last character pushed is the hyphen, and it is in `text`, the open run.
          text = text.slice(0, -1);
        } else if (last !== ' ' && line[0]?.c !== ' ') {
          push(line[0] as LayoutChar, ' ');
        }
      }
      for (const char of line) push(char, char.c);
    }
    flush();
    // Leading and trailing spaces are layout, not content.
    const trimmed = runs.map((run, at) => {
      let trimmedText = run.text;
      if (at === 0) trimmedText = trimmedText.replace(/^\s+/, '');
      if (at === runs.length - 1) trimmedText = trimmedText.replace(/\s+$/, '');
      return { ...run, text: trimmedText };
    });
    const lineBoxes = group.map((index) => boxes[index] as Box);
    const first = lineBoxes[0] as Box;
    const last = lineBoxes[lineBoxes.length - 1] as Box;
    const visible = chars.filter((char) => char.c.trim() !== '');
    return {
      kind: 'paragraph',
      runs: trimmed.filter((run) => run.text !== ''),
      box: [
        Math.min(...lineBoxes.map((box) => box[0])),
        first[1],
        Math.max(...lineBoxes.map((box) => box[2])),
        last[3],
      ],
      lines: lineBoxes,
      pitch: lineBoxes.length > 1 ? (last[1] - first[1]) / (lineBoxes.length - 1) : 0,
      size: commonSize(chars),
      bold: visible.length > 0 && visible.every((char) => char.bold),
      rtl: paragraphRtl,
    } satisfies Paragraph;
  });
}

/**
 * Pictures of a page the Word document does not carry (`pageItems` leaves them out): one MuPDF
 * could not draw, and one inside a table, whose cells hold text only. A picture inside a
 * drawing is carried by the drawing's own picture.
 */
function lostPictures(page: ReadPage): number {
  const tables = [...page.tables, ...page.streams];
  return page.layout.blocks.filter(
    (block) =>
      block.kind === 'image' &&
      !page.figures.some((figure) => contains(figure.box, block.box)) &&
      (block.png === null || tables.some((table) => contains(table.box, block.box))),
  ).length;
}

/**
 * The table each character of a page belongs to, when it lies inside one — a segment of a
 * line (`lineSegments`) goes whole, by its centre, so no word is cut at the edge of a
 * table: ruled tables
 * before tables read from spacing, the smallest first — a table drawn inside another one
 * holds its own text, and a table read from spacing that runs across a ruled one leaves the
 * ruled one's text to it. A character is in one table, so its word is written once.
 */
function ownersOf(page: ReadPage): Map<LayoutChar, LayoutTable> {
  const area = (table: LayoutTable) => (table.box[2] - table.box[0]) * (table.box[3] - table.box[1]);
  const bySize = (a: LayoutTable, b: LayoutTable) => area(a) - area(b);
  const ranked = [...[...page.tables].sort(bySize), ...[...page.streams].sort(bySize)];
  const owners = new Map<LayoutChar, LayoutTable>();
  for (const block of page.layout.blocks) {
    if (block.kind !== 'text') continue;
    for (const line of block.lines) {
      for (const segment of lineSegments(line.chars)) {
        const table = ranked.find((candidate) => segmentInside(segment, candidate.box));
        if (table === undefined) continue;
        for (const char of segment) owners.set(char, table);
      }
    }
  }
  return owners;
}

/**
 * A segment cut where one of `edges` lies in a gap of spaces between two of its visible
 * characters — a rule between two cells that MuPDF read as one line with one space across
 * it. Never inside a word, whose characters touch. The spaces of a gap stay with the piece
 * before it.
 */
function cutAtEdges(segment: readonly LayoutChar[], edges: readonly number[]): LayoutChar[][] {
  let piece: LayoutChar[] = [];
  const pieces = [piece];
  let previous: LayoutChar | null = null;
  let pending: LayoutChar[] = [];
  for (const char of segment) {
    if (char.c.trim() === '') {
      pending.push(char);
      continue;
    }
    const before: LayoutChar | null = previous;
    const cut =
      before !== null && pending.length > 0 && edges.some((x) => x >= before.box[2] && x <= char.box[0]);
    if (cut) {
      piece.push(...pending);
      piece = [char];
      pieces.push(piece);
    } else piece.push(...pending, char);
    pending = [];
    previous = char;
  }
  piece.push(...pending);
  return pieces;
}

/**
 * The lines of each cell of a table, from the characters it owns: a character goes to the
 * cell it lies in, or the one nearest when it sits on an edge. A segment goes whole to one
 * cell, unless a column edge of the table lies in a gap inside it.
 */
function cellLines(page: ReadPage, table: LayoutTable, owners: Map<LayoutChar, LayoutTable>) {
  const lines = new Map<TableCell, LayoutChar[][]>();
  const edges = table.xs.slice(1, -1);
  for (const block of page.layout.blocks) {
    if (block.kind !== 'text') continue;
    for (const line of block.lines) {
      const parts = new Map<TableCell, LayoutChar[]>();
      for (const whole of lineSegments(line.chars)) {
        if (whole.some((char) => owners.get(char) !== table)) continue;
        for (const segment of cutAtEdges(whole, edges)) {
          const cell =
            table.cells.find((candidate) => segmentInside(segment, candidate.box, 0)) ??
            (table.cells.find((candidate) => segmentInside(segment, candidate.box, 1)) as TableCell);
          parts.set(cell, [...(parts.get(cell) ?? []), ...segment]);
        }
      }
      for (const [cell, chars] of parts) lines.set(cell, [...(lines.get(cell) ?? []), chars]);
    }
  }
  return lines;
}

/** Whether a character that is not in a table stands on a region (its centre is inside it). */
function textOn(page: ReadPage, owners: Map<LayoutChar, LayoutTable>, box: Box): boolean {
  return page.layout.blocks.some(
    (block) =>
      block.kind === 'text' &&
      block.lines.some((line) =>
        line.chars.some((char) => char.c.trim() !== '' && !owners.has(char) && inside(char, box, 0)),
      ),
  );
}

/**
 * One page as items in reading order: MuPDF's block order, each table where it starts. The
 * text on a drawing or a picture is text like any other; the drawing is rendered without it
 * and, like a picture that text stands on, goes behind the text.
 */
function pageItems(page: ReadPage): Item[] {
  const items: Item[] = [];
  const tables = [...page.tables, ...page.streams];
  const owners = ownersOf(page);
  const placed = new Set<number>();
  for (const block of page.layout.blocks) {
    if (block.kind === 'image') {
      // A picture inside a drawing is part of the drawing's picture, which takes the place
      // of the first picture it holds — the reading position MuPDF gave it.
      const figure = page.figures.findIndex((candidate) => contains(candidate.box, block.box));
      if (figure !== -1) {
        if (!placed.has(figure)) {
          placed.add(figure);
          const { box, png } = page.figures[figure] as { box: Box; png: Uint8Array };
          items.push({ kind: 'picture', box, png, behind: textOn(page, owners, box) });
        }
        continue;
      }
      if (block.png !== null && !tables.some((table) => contains(table.box, block.box))) {
        items.push({
          kind: 'picture',
          box: block.box,
          png: block.png,
          behind: textOn(page, owners, block.box),
        });
      }
      continue;
    }
    const lines = block.lines
      .map((line) => line.chars.filter((char) => !owners.has(char)))
      .filter((chars) => chars.length > 0);
    items.push(...blockParagraphs(lines));
  }
  page.figures.forEach((figure, index) => {
    if (placed.has(index)) return;
    const picture: Picture = {
      kind: 'picture',
      box: figure.box,
      png: figure.png,
      behind: textOn(page, owners, figure.box),
    };
    const at = items.findIndex((item) => item.box[1] >= figure.box[1] - 1);
    if (at === -1) items.push(picture);
    else items.splice(at, 0, picture);
  });
  for (const table of tables) {
    const cells = new Map<string, readonly Paragraph[]>();
    const lines = cellLines(page, table, owners);
    for (const cell of table.cells) {
      const own = [...(lines.get(cell) ?? [])].sort(byRow);
      cells.set(`${cell.row}:${cell.column}`, blockParagraphs(own));
    }
    const grid: Grid = { kind: 'table', box: table.box, table, cells };
    const at = items.findIndex((item) => item.box[1] >= table.box[1] - 1);
    if (at === -1) items.push(grid);
    else items.splice(at, 0, grid);
  }
  return placePictures(items);
}

function isBehind(item: Item): item is Picture {
  return item.kind === 'picture' && item.behind;
}

/** The share of an item's area that a box covers. */
function coveredBy(item: Box, box: Box): number {
  const across = Math.min(item[2], box[2]) - Math.max(item[0], box[0]);
  const down = Math.min(item[3], box[3]) - Math.max(item[1], box[1]);
  const area = (item[2] - item[0]) * (item[3] - item[1]);
  return across > 0 && down > 0 && area > 0 ? (across * down) / area : 0;
}

/** An item is on a picture when the picture covers this much of it. */
const STANDS_ON = 0.25;

/**
 * A picture behind the text hangs from a holder paragraph that stands right before the items
 * on it, so that the picture and its text move together in the flow. When those items are not
 * one run in the flow — another drawing's text, or a column's, comes between them — nothing
 * keeps the text on the picture, and it would land on white paper: the picture is then an
 * ordinary inline one, right before its first item, and the text stays readable under it. A
 * picture that no item stands on (a stamp that covers a corner of a line) has no holder to
 * keep: it stays inline where MuPDF read it.
 */
function placePictures(items: readonly Item[]): Item[] {
  const flow = items.filter((item) => !isBehind(item));
  const placed = items.flatMap((picture, position) => {
    if (!isBehind(picture)) return [];
    const stands = flow.flatMap((item, index) =>
      coveredBy(item.box, picture.box) >= STANDS_ON ? [index] : [],
    );
    const read = items.slice(0, position).filter((item) => !isBehind(item)).length;
    const at = stands[0] ?? read;
    const together = stands.length > 0 && stands.every((index, run) => index === at + run);
    return [{ at, item: together ? picture : { ...picture, behind: false } }];
  });
  const ordered: Item[] = [];
  flow.forEach((item, index) => {
    ordered.push(...placed.filter((entry) => entry.at === index).map((entry) => entry.item), item);
  });
  ordered.push(...placed.filter((entry) => entry.at >= flow.length).map((entry) => entry.item));
  return ordered;
}

function contains(outer: Box, inner: Box): boolean {
  const cx = (inner[0] + inner[2]) / 2;
  const cy = (inner[1] + inner[3]) / 2;
  return cx >= outer[0] && cx <= outer[2] && cy >= outer[1] && cy <= outer[3];
}

interface DocxContext {
  readonly bodySize: number;
  /** Heading sizes (half-points) to their level, largest first. */
  readonly headings: ReadonlyMap<number, number>;
  readonly media: { name: string; png: Uint8Array }[];
  pictureId: number;
  /** Every word written, for the read-back check. */
  writtenWords: number;
}

function headingLevel(paragraph: Paragraph, context: DocxContext): number | null {
  const text = textOf(paragraph);
  if (text.length > 200 || paragraph.lines.length > 3) return null;
  return context.headings.get(Math.round(paragraph.size * 2)) ?? null;
}

function runXml(run: Run): string {
  const props: string[] = [];
  props.push(`<w:rFonts w:ascii="${xml(run.font)}" w:hAnsi="${xml(run.font)}" w:cs="${xml(run.font)}"/>`);
  if (run.bold) props.push('<w:b/><w:bCs/>');
  if (run.italic) props.push('<w:i/><w:iCs/>');
  if (run.color !== 0)
    props.push(`<w:color w:val="${run.color.toString(16).padStart(6, '0').toUpperCase()}"/>`);
  props.push(`<w:sz w:val="${run.half}"/><w:szCs w:val="${run.half}"/>`);
  if (run.rtl) props.push('<w:rtl/>');
  const parts = run.text.split('\t').map((piece) => `<w:t xml:space="preserve">${xml(piece)}</w:t>`);
  return `<w:r><w:rPr>${props.join('')}</w:rPr>${parts.join('<w:tab/>')}</w:r>`;
}

interface Column {
  readonly left: number;
  readonly right: number;
}

function paragraphXml(
  paragraph: Paragraph,
  column: Column,
  before: number,
  extra: string,
  context: DocxContext,
): string {
  // The properties go in the order of the schema (CT_PPrBase): pStyle, pageBreakBefore, bidi,
  // spacing, ind, jc; the section's properties, `sectPr`, come after them all.
  const props: string[] = [];
  const level = headingLevel(paragraph, context);
  if (level !== null) props.push(`<w:pStyle w:val="Heading${level}"/>`);
  if (extra.includes('pageBreakBefore')) props.push('<w:pageBreakBefore/>');
  if (paragraph.rtl) props.push('<w:bidi/>');
  const pitch =
    paragraph.pitch > 0 ? `w:line="${Math.round(paragraph.pitch * TWIPS)}" w:lineRule="atLeast"` : '';
  props.push(`<w:spacing w:before="${Math.round(before * TWIPS)}" w:after="0" ${pitch}/>`.replace(' /', '/'));

  const width = column.right - column.left;
  const centre = (column.left + column.right) / 2;
  // A right-to-left paragraph is measured from its own start, the right edge: its box mirrored
  // across the column reads as left-to-right text, and so do its alignment and indents. `w:bidi`
  // has Word read them the same way (left is the start of the line, right is its end), so the
  // values written are those of the mirror, and the paragraph stands where the PDF has it.
  const mirror = (box: Box): Box => [
    column.left + column.right - box[2],
    box[1],
    column.left + column.right - box[0],
    box[3],
  ];
  const [x0, , x1] = paragraph.rtl ? mirror(paragraph.box) : paragraph.box;
  const lines = paragraph.rtl ? paragraph.lines.map(mirror) : paragraph.lines;
  const centred = lines.every(
    (line) => Math.abs((line[0] + line[2]) / 2 - centre) <= Math.max(4, width * 0.03),
  );
  const ragged = lines.some((line) => Math.abs(line[0] - x0) > 3);
  let align: 'left' | 'center' | 'right' | 'both' = 'left';
  if (centred && (lines.length > 1 ? ragged : x0 - column.left > width * 0.08)) align = 'center';
  else if (Math.abs(x1 - column.right) <= 3 && x0 - column.left > width * 0.3 && lines.length <= 2)
    align = 'right';
  else if (lines.length >= 3 && lines.slice(0, -1).every((line) => Math.abs(line[2] - x1) <= 1.5)) {
    // Every line but the last ends at one edge: justified, in whichever column it stands.
    align = 'both';
  }
  if (align === 'left' || align === 'both') {
    const first = lines[0] as Box;
    const rest = lines.length > 1 ? Math.min(...lines.slice(1).map((line) => line[0])) : first[0];
    // Several lines that start a third of the way across are a second column of text,
    // not an indent; Word gets them as the flowing text they are.
    const columnText = lines.length > 1 && rest - column.left > width * 0.3;
    const left = columnText ? 0 : Math.max(0, rest - column.left);
    const firstLine = first[0] - rest;
    const indent: string[] = [];
    if (left >= 4) indent.push(`w:left="${Math.round(left * TWIPS)}"`);
    if (firstLine >= 2) indent.push(`w:firstLine="${Math.round(firstLine * TWIPS)}"`);
    else if (firstLine <= -2) indent.push(`w:hanging="${Math.round(-firstLine * TWIPS)}"`);
    if (indent.length > 0) props.push(`<w:ind ${indent.join(' ')}/>`);
  }
  if (align !== 'left') props.push(`<w:jc w:val="${align}"/>`);
  if (extra.includes('<w:sectPr')) props.push(extra.slice(extra.indexOf('<w:sectPr')));
  // Counted per paragraph: a style change inside a word splits runs, not words.
  context.writtenWords += words(xmlSafe(textOf(paragraph)));
  return `<w:p><w:pPr>${props.join('')}</w:pPr>${paragraph.runs.map(runXml).join('')}</w:p>`;
}

/** The picture's `a:graphic`, which an inline and an anchored drawing both hold. */
function graphicXml(id: number, name: string, cx: number, cy: number): string {
  return (
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${imageRelId(id)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic>'
  );
}

/**
 * A picture as a paragraph. In the flow it is inline, at its size and indent, shrunk to the
 * column and to `maxHeight` — a picture as tall as the page's text area, with the line it
 * stands in, would not fit the page and be sent to the next. Behind the text it is anchored
 * `offset` points below the top of its holder, a paragraph one point high that takes the
 * item's space before (as a paragraph of its own above it) and carries the page break and the section like any other: it moves
 * with the flow, so the text laid out after it stays where the PDF has it on the picture.
 */
function pictureXml(
  picture: Picture,
  column: Column,
  before: number,
  offset: number,
  extra: string,
  maxHeight: number,
  context: DocxContext,
): string {
  context.pictureId += 1;
  const id = context.pictureId;
  const name = `image${id}.png`;
  context.media.push({ name, png: picture.png });
  const section = extra.includes('<w:sectPr') ? extra.slice(extra.indexOf('<w:sectPr')) : '';
  const pageBreak = extra.includes('pageBreakBefore') ? '<w:pageBreakBefore/>' : '';
  let width = picture.box[2] - picture.box[0];
  let height = picture.box[3] - picture.box[1];
  if (picture.behind) {
    const cx = Math.max(1, Math.round(width * EMU));
    const cy = Math.max(1, Math.round(height * EMU));
    // The space before is a paragraph of its own: Word measures an anchor from the text of its
    // paragraph and LibreOffice from the top of it, space before included.
    const gap = Math.round(before * TWIPS);
    const spacer =
      gap > 0
        ? `<w:p><w:pPr>${pageBreak}<w:spacing w:before="0" w:after="0" w:line="${gap}" w:lineRule="exact"/></w:pPr></w:p>`
        : '';
    return (
      spacer +
      `<w:p><w:pPr>${spacer === '' ? pageBreak : ''}<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${section}</w:pPr>` +
      `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">` +
      '<wp:simplePos x="0" y="0"/>' +
      `<wp:positionH relativeFrom="page"><wp:posOffset>${Math.round(picture.box[0] * EMU)}</wp:posOffset></wp:positionH>` +
      `<wp:positionV relativeFrom="paragraph"><wp:posOffset>${Math.round(offset * EMU)}</wp:posOffset></wp:positionV>` +
      `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
      `<wp:docPr id="${id}" name="Picture ${id}"/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      `${graphicXml(id, name, cx, cy)}</wp:anchor></w:drawing></w:r></w:p>`
    );
  }
  const scale = Math.min(1, (column.right - column.left) / width, maxHeight / height);
  width *= scale;
  height *= scale;
  const cx = Math.max(1, Math.round(width * EMU));
  const cy = Math.max(1, Math.round(height * EMU));
  const left = Math.max(0, picture.box[0] - column.left);
  const props = [
    pageBreak,
    `<w:spacing w:before="${Math.round(before * TWIPS)}" w:after="0"/>`,
    left >= 2 ? `<w:ind w:left="${Math.round(left * TWIPS)}"/>` : '',
    section,
  ].join('');
  return (
    `<w:p><w:pPr>${props}</w:pPr><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    `${graphicXml(id, name, cx, cy)}</wp:inline></w:drawing></w:r></w:p>`
  );
}

function tableXml(grid: Grid, column: Column, context: DocxContext): string {
  const { table } = grid;
  const room = column.right - column.left;
  const total = (table.xs[table.xs.length - 1] as number) - (table.xs[0] as number);
  const scale = total > room ? room / total : 1;
  const widths = table.xs.slice(1).map((x, index) => (x - (table.xs[index] as number)) * scale);
  const rows = table.ys.length - 1;
  const columns = widths.length;
  const byStart = new Map(table.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]));
  const span = (from: number, count: number) =>
    Math.round(widths.slice(from, from + count).reduce((sum, width) => sum + width, 0) * TWIPS);
  const indent = Math.max(0, (table.xs[0] as number) - column.left);
  // A table read from the spacing of the text had no rules, and gets none; a ruled one
  // draws the sides of each cell that have a rule along them (`tcBorders`), not a full grid.
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="nil"/>`)
    .join('');
  const drawn = (cell: TableCell, row: number) => {
    const { borders: sides } = cell;
    if (sides === undefined) return '';
    // In a cell merged down, the row it continues in has its top inside the cell and, but
    // in the last row, its bottom too: only the region's own edges are drawn.
    const lines = {
      top: sides.top && row === cell.row,
      left: sides.left,
      bottom: sides.bottom && row === cell.row + cell.rowSpan - 1,
      right: sides.right,
    };
    const xmlSides = (['top', 'left', 'bottom', 'right'] as const).map((side) =>
      lines[side]
        ? `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`
        : `<w:${side} w:val="nil"/>`,
    );
    return `<w:tcBorders>${xmlSides.join('')}</w:tcBorders>`;
  };
  const out: string[] = [
    '<w:tbl><w:tblPr>',
    `<w:tblW w:w="${span(0, columns)}" w:type="dxa"/>`,
    indent >= 2 ? `<w:tblInd w:w="${Math.round(indent * TWIPS)}" w:type="dxa"/>` : '',
    // A ruled table keeps its rules' widths; one read from spacing has only estimated
    // columns, and Word sizes them to their text instead.
    `<w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="${table.ruled ? 'fixed' : 'autofit'}"/>`,
    '<w:tblCellMar><w:left w:w="57" w:type="dxa"/><w:right w:w="57" w:type="dxa"/></w:tblCellMar>',
    '</w:tblPr><w:tblGrid>',
    ...widths.map((width) => `<w:gridCol w:w="${Math.round(width * TWIPS)}"/>`),
    '</w:tblGrid>',
  ];
  for (let row = 0; row < rows; row += 1) {
    const height = ((table.ys[row + 1] as number) - (table.ys[row] as number)) * TWIPS;
    out.push(`<w:tr><w:trPr><w:trHeight w:val="${Math.round(height)}" w:hRule="atLeast"/></w:trPr>`);
    let col = 0;
    while (col < columns) {
      const start = byStart.get(`${row}:${col}`);
      // A cell that started in a row above and spans into this one continues its merge.
      const above =
        start === undefined
          ? table.cells.find((cell) => cell.column === col && cell.row < row && cell.row + cell.rowSpan > row)
          : undefined;
      // Every grid position starts a cell or lies under one that started above: the cells of
      // `findTables` and `findTextTables` tile their grid.
      const cell = (start ?? above) as TableCell;
      const columnSpan = cell.columnSpan;
      const props = [
        `<w:tcW w:w="${span(col, columnSpan)}" w:type="dxa"/>`,
        columnSpan > 1 ? `<w:gridSpan w:val="${columnSpan}"/>` : '',
        start !== undefined && start.rowSpan > 1 ? '<w:vMerge w:val="restart"/>' : '',
        above !== undefined ? '<w:vMerge/>' : '',
        drawn(cell, row),
      ].join('');
      let body = '<w:p/>';
      if (start !== undefined) {
        // `pageItems` sets the paragraphs of every cell of the table.
        const paragraphs = grid.cells.get(`${row}:${col}`) as readonly Paragraph[];
        const cellColumn = { left: start.box[0] + 2.85, right: start.box[2] - 2.85 };
        const written = paragraphs
          .map((paragraph) => {
            // Inside a cell only alignment and the runs matter; the cell gives the indent.
            // A cell of a table without rules has estimated edges, so no alignment either.
            const written = paragraphXml(paragraph, cellColumn, 0, '', context).replace(
              /<w:ind [^>]*\/>/,
              '',
            );
            return table.ruled ? written : written.replace(/<w:jc [^>]*\/>/, '');
          })
          .join('');
        if (written !== '') body = written;
      }
      out.push(`<w:tc><w:tcPr>${props}</w:tcPr>${body}</w:tc>`);
      col += columnSpan;
    }
    out.push('</w:tr>');
  }
  out.push('</w:tbl>');
  return out.join('');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The text column a box stands in. A page set in two columns has paragraphs of several
 * lines that all start a third of the way across or more; the leftmost such start is the
 * second column, and the first column ends at the widest text left of it. Alignment and
 * indents are then measured in the paragraph's own column — a heading centred over the
 * first column is centred, not indented by half a page.
 */
function textColumns(items: readonly Item[], page: Column): (box: Box) => Column {
  const width = page.right - page.left;
  const starts = items
    .filter((item): item is Paragraph => item.kind === 'paragraph' && item.lines.length > 1)
    .map((paragraph) => Math.min(...paragraph.lines.slice(1).map((line) => line[0])))
    .filter((start) => start - page.left > width * 0.3);
  if (starts.length === 0) return () => page;
  const second = Math.min(...starts);
  const leftEdges = items.map((item) => item.box).filter((box) => box[2] < second);
  const firstRight = leftEdges.length > 0 ? Math.max(...leftEdges.map((box) => box[2])) : second - 12;
  const first: Column = { left: page.left, right: firstRight };
  const other: Column = { left: second, right: page.right };
  return (box) => {
    if (box[0] >= second - 3) return other;
    return box[2] <= firstRight + 1 ? first : page;
  };
}

/** What the Word export keeps of a page once it is read: `readPages` lets the page's layout go. */
interface WordPage {
  readonly width: number;
  readonly height: number;
  /** The page as paragraphs, pictures and tables in reading order. */
  readonly items: readonly Item[];
  /** Characters of the document's own hidden text left out. */
  readonly hidden: number;
  /** Pictures the document does not carry (`lostPictures`). */
  readonly lost: number;
  /** How many characters have each size (half points) and each font family, for the document's body size and font. */
  readonly sizes: ReadonlyMap<number, number>;
  readonly fonts: ReadonlyMap<string, number>;
}

/** The page's characters, in the order MuPDF read them. */
function charsOf(layout: PageLayout): LayoutChar[] {
  return layout.blocks.flatMap((block) =>
    block.kind === 'text' ? block.lines.flatMap((line) => line.chars) : [],
  );
}

/** What the Word export takes from a page; the page itself can then be let go. */
function wordPage(page: ReadPage): WordPage {
  const chars = charsOf(page.layout);
  const fonts = new Map<string, number>();
  for (const char of chars) fonts.set(char.font, (fonts.get(char.font) ?? 0) + 1);
  return {
    width: page.layout.width,
    height: page.layout.height,
    items: pageItems(page),
    hidden: page.hidden,
    lost: lostPictures(page),
    sizes: sizeCounts(chars),
    fonts,
  };
}

/** One page's body XML, its last paragraph carrying the page's section properties. */
function docxPage(page: WordPage, first: boolean, last: boolean, context: DocxContext): string {
  const { width, height, items } = page;
  // A picture behind the text is not in the flow: it sets neither the margins nor the columns.
  const flow = items.filter((item) => item.kind !== 'picture' || !item.behind);
  const boxes = flow.map((item) => item.box);
  const left = boxes.length > 0 ? Math.min(...boxes.map((box) => box[0])) : 72;
  const right = boxes.length > 0 ? Math.max(...boxes.map((box) => box[2])) : width - 72;
  const top = boxes.length > 0 ? Math.min(...boxes.map((box) => box[1])) : 72;
  const bottom = boxes.length > 0 ? Math.max(...boxes.map((box) => box[3])) : height - 72;
  const margins = {
    left: clamp(left, 18, width / 3),
    right: clamp(width - right, 18, width / 3),
    top: clamp(top, 18, 144),
    // Word's fonts are seldom the PDF's own; a little room at the foot keeps a page's
    // content from spilling onto a page of its own.
    bottom: clamp(height - bottom, 18, 36),
  };
  const column: Column = { left: margins.left, right: width - margins.right };
  const columnOf = textColumns(flow, column);
  const twips = (value: number) => Math.round(value * TWIPS);
  const sectPr =
    `<w:sectPr><w:pgSz w:w="${twips(width)}" w:h="${twips(height)}"${width > height ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${twips(margins.top)}" w:right="${twips(margins.right)}" w:bottom="${twips(margins.bottom)}" ` +
    `w:left="${twips(margins.left)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
  const out: string[] = [];
  // `previousBottom` is where the flow stands, in the PDF's own coordinates. Gaps are clamped to
  // MAX_GAP, except for the run of items that stand on a picture behind the text, which keep the
  // text on it where the PDF has it. The first item after the run starts at or under the feet of
  // the run's pictures, whether it is below them in the PDF or beside them (another column's: the
  // flow has no beside, and would print it over the picture). An item that is on none of them
  // ends the run.
  let previousBottom = margins.top;
  let active: Box | null = null;
  // The lowest foot of the run's pictures, in the frame of the newest one; 0 outside a run.
  let floor = 0;
  const planned = items.map((item, index) => {
    const top = item.box[1];
    const standing = active !== null && !isBehind(item) && coveredBy(item.box, active) >= STANDS_ON;
    let before = clamp(top - previousBottom, 0, MAX_GAP);
    if (standing) before = Math.max(0, top - previousBottom);
    // A picture beside the run's (its holder is not below their feet) starts a row of its own band.
    else if (floor > 0 && (!isBehind(item) || top >= floor - 1)) {
      before = Math.max(0, floor - previousBottom) + clamp(top - Math.max(previousBottom, floor), 0, MAX_GAP);
    }
    if (isBehind(item)) {
      // The holder is one point high; the first item on its picture follows it, as far below the
      // picture's top in the flow as it is in the PDF, so the picture hangs `offset` from the
      // holder. The feet of the pictures before it, from the holder, are seen from that offset.
      const stands = items[index + 1] as Item;
      const lead = stands.box[1];
      const offset = 1 + Math.max(0, lead - (Math.max(previousBottom, top) + 1)) - (lead - top);
      // Only a picture beside the run's carries their feet: one that lies on a bigger picture (a
      // photograph on a full-page background) ends above its foot, and the text after it is on
      // the background, not under it.
      const beside = active !== null && (item.box[0] >= active[2] || item.box[2] <= active[0]);
      floor = Math.max(item.box[3], beside ? top + floor - previousBottom - before - offset : 0);
      previousBottom = Math.max(previousBottom, top) + 1;
      active = item.box;
    } else {
      // On the picture the flow follows the PDF from item to item, whatever column it was
      // in before; elsewhere it only moves down.
      previousBottom = standing ? item.box[3] : Math.max(previousBottom, item.box[3]);
      if (!standing) {
        active = null;
        floor = 0;
      }
    }
    return { item, before };
  });
  /**
   * How far below its holder's top a picture behind the text hangs: the text after it is
   * where the flow puts it, and the picture is as far above the first of it as the PDF has it.
   */
  const offsetOf = (index: number, top: number): number => {
    let reach = 0;
    let lead = top;
    for (const next of planned.slice(index + 1)) {
      reach += 1 + next.before;
      if (!isBehind(next.item)) {
        lead = next.item.box[1];
        break;
      }
    }
    return reach - (lead - top);
  };
  planned.forEach(({ item, before }, index) => {
    const breakBefore = index === 0 && !first ? 'pageBreakBefore' : '';
    const section = index === items.length - 1 && !last ? sectPr : '';
    const offset = isBehind(item) ? offsetOf(index, item.box[1]) : 0;
    if (item.kind === 'paragraph') {
      out.push(paragraphXml(item, columnOf(item.box), before, breakBefore + section, context));
    } else if (item.kind === 'picture') {
      // One line's room, a body size, is left under a picture that stands alone on a page.
      const room = height - margins.top - margins.bottom - context.bodySize;
      out.push(pictureXml(item, columnOf(item.box), before, offset, breakBefore + section, room, context));
    } else {
      // A table cannot carry a page break or a section; a hairline paragraph does.
      if (breakBefore !== '')
        out.push(
          '<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>',
        );
      else if (before >= 2)
        out.push(
          `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${twips(before)}" w:lineRule="exact"/></w:pPr></w:p>`,
        );
      else if (out[out.length - 1]?.endsWith('</w:tbl>'))
        // Tables with nothing between them are one table to Word and LibreOffice, whose
        // columns are the sum of both: a hairline paragraph keeps them apart.
        out.push(
          '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>',
        );
      out.push(tableXml(item, column, context));
      if (section !== '') {
        out.push(
          `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>${section}</w:pPr></w:p>`,
        );
      }
    }
  });
  if (items.length === 0) {
    // A blank page stays a page.
    const props = `${first ? '' : '<w:pageBreakBefore/>'}${last ? '' : sectPr}`;
    out.push(`<w:p><w:pPr>${props}</w:pPr></w:p>`);
  }
  // The last page's section is the body's own `w:sectPr`.
  if (last) out.push(sectPr);
  return out.join('');
}

function stylesXml(bodySize: number, bodyFont: string, language: string): string {
  const half = Math.round(bodySize * 2);
  const heading = (level: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    `<w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`;
  return (
    `${XML_HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${xml(bodyFont)}" w:hAnsi="${xml(bodyFont)}" w:cs="${xml(bodyFont)}"/>` +
    `<w:sz w:val="${half}"/><w:szCs w:val="${half}"/>${language === '' ? '' : `<w:lang w:val="${xml(language)}"/>`}</w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    heading(1) +
    heading(2) +
    heading(3) +
    '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
    '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/>' +
    '<w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>' +
    '</w:tblCellMar></w:tblPr></w:style></w:styles>'
  );
}

/** The heading sizes of the whole document (half-points → level), largest first. */
function headingSizes(paragraphs: readonly Paragraph[], bodySize: number): Map<number, number> {
  const sizes = new Set<number>();
  for (const paragraph of paragraphs) {
    const text = textOf(paragraph);
    if (text.length > 200 || paragraph.lines.length > 3) continue;
    if (paragraph.size >= bodySize * 1.3 || (paragraph.bold && paragraph.size >= bodySize * 1.15)) {
      sizes.add(Math.round(paragraph.size * 2));
    }
  }
  const levels = new Map<number, number>();
  [...sizes]
    .sort((a, b) => b - a)
    .forEach((half, index) => {
      levels.set(half, Math.min(3, index + 1));
    });
  return levels;
}

async function writeDocx(
  pages: readonly WordPage[],
  title: string,
  language: string,
  context: OperationContext,
): Promise<{ bytes: Uint8Array; tables: number; streams: number; pictures: number; written: number }> {
  const items = pages.map((page) => page.items);
  const paragraphs = items.flat().flatMap((item) => (item.kind === 'paragraph' ? [item] : []));
  // The body size and font are the ones most characters of the document are set in; the pages
  // counted them as they were read, in the order the characters came.
  const sizeCount = new Map<number, number>();
  const fontCounts = new Map<string, number>();
  for (const page of pages) {
    for (const [half, count] of page.sizes) sizeCount.set(half, (sizeCount.get(half) ?? 0) + count);
    for (const [font, count] of page.fonts) fontCounts.set(font, (fontCounts.get(font) ?? 0) + count);
  }
  const bodySize = commonOf(sizeCount) || 11;
  const bodyFont = wordFontName([...fontCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Arial');
  const docx: DocxContext = {
    bodySize,
    headings: headingSizes(paragraphs, bodySize),
    media: [],
    pictureId: 0,
    writtenWords: 0,
  };

  context.onProgress?.({ phase: 'write', labelKey: 'op.progress.exportOffice.write' });
  const body = pages
    .map((page, index) => docxPage(page, index === 0, index === pages.length - 1, docx))
    .join('');
  const document = wordDocumentXml(body);
  const documentRels = documentRelsXml(docx.media.map((image) => image.name));
  const contentTypes = contentTypesXml(['png']);
  const files: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': PACKAGE_RELS('word/document.xml'),
    'docProps/core.xml': corePropertiesXml(title),
    'word/document.xml': document,
    'word/styles.xml': stylesXml(bodySize, bodyFont, language),
    'word/_rels/document.xml.rels': documentRels,
  };
  for (const image of docx.media) files[`word/media/${image.name}`] = image.png;
  const bytes = await zipped(files);
  return {
    bytes,
    tables: items.flat().filter((item) => item.kind === 'table' && item.table.ruled).length,
    streams: items.flat().filter((item) => item.kind === 'table' && !item.table.ruled).length,
    pictures: docx.media.length,
    written: docx.writtenWords,
  };
}

/** Reads the package back with mammoth: the words it finds must be the words written. */
async function verifyDocx(bytes: Uint8Array, written: number): Promise<void> {
  const mammoth = (await import('mammoth')).default;
  const copy = bytes.slice();
  const input = { buffer: copy, arrayBuffer: copy.buffer } as unknown as Parameters<
    typeof mammoth.extractRawText
  >[0];
  let read: string;
  try {
    read = (await mammoth.extractRawText(input)).value;
  } catch (error) {
    throw new ToolError('verification-failed', {
      engine: 'model',
      engineMessage: `docx read-back failed: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    });
  }
  const found = words(read);
  if (found !== written) {
    throw new ToolError('verification-failed', {
      engine: 'model',
      engineMessage: `docx read-back found ${found} words, ${written} were written`,
    });
  }
}

/* ------------------------------------------------------------------ *
 * spreadsheet rows (XLSX and CSV)
 * ------------------------------------------------------------------ */

interface Sheet {
  readonly name: string;
  /** Rows of cells; `''` is an empty cell. */
  readonly rows: readonly (readonly string[])[];
  /** `[row0, column0, row1, column1]`, inclusive. */
  readonly merges: readonly (readonly [number, number, number, number])[];
  /** Column widths in Excel's character units: a ruled table's from its rules, text rows' from their longest text. */
  readonly widths: readonly number[];
}

function tableSheet(table: LayoutTable, name: string): Sheet {
  const rows = table.ys.length - 1;
  const columns = table.xs.length - 1;
  const grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ''));
  const merges: [number, number, number, number][] = [];
  for (const cell of table.cells) {
    (grid[cell.row] as string[])[cell.column] = cell.text;
    if (cell.rowSpan > 1 || cell.columnSpan > 1) {
      merges.push([cell.row, cell.column, cell.row + cell.rowSpan - 1, cell.column + cell.columnSpan - 1]);
    }
  }
  return {
    name,
    rows: grid,
    merges,
    widths: table.xs.slice(1).map((x, index) => clamp((x - (table.xs[index] as number)) / 5.25, 4, 80)),
  };
}

function rowsSheet(page: ReadPage, name: string): Sheet | null {
  const rows = textRows(page.layout, []);
  if (rows.length === 0) return null;
  const columns = Math.max(...rows.flatMap((row) => row.cells.map(([column]) => column + 1)));
  const grid = rows.map((row) => {
    const cells = Array.from({ length: columns }, () => '');
    for (const [column, text] of row.cells) cells[column] = text;
    return cells;
  });
  // Every row has every column, so the first row puts the columns in the map in order.
  const longest = new Map<number, number>();
  for (const row of grid) {
    for (const [column, text] of row.entries()) {
      const length = Math.max(...text.split('\n').map((piece) => piece.length));
      longest.set(column, Math.max(longest.get(column) ?? 0, length));
    }
  }
  const widths = [...longest.values()].map((length) => clamp(length + 2, 6, 60));
  return { name, rows: grid, merges: [], widths };
}

/** What the spreadsheet formats gather from the pages, a page at a time (`addSheets`). */
interface Gathered {
  readonly sheets: Sheet[];
  /** Pages (1-based) that had no ruled table and became one sheet of text rows. */
  readonly unruled: number[];
  tables: number;
  streams: number;
  textOutside: boolean;
  /** Pictures on the pages: a sheet holds cells only, so none is carried. */
  pictures: number;
}

/** Adds the page's sheets to `found`: its ruled tables, or the text rows of a page without one. */
function addSheets(
  found: Gathered,
  page: ReadPage,
  names: NonNullable<OfficeExportOptions['sheetName']>,
): void {
  found.pictures += page.pictures;
  if (page.tables.length > 0) {
    const owners = ownersOf(page);
    found.textOutside ||= page.layout.blocks.some(
      (block) =>
        block.kind === 'text' &&
        block.lines.some((line) => line.chars.some((char) => char.c.trim() !== '' && !owners.has(char))),
    );
    // The page's tables top to bottom, those without rules among them.
    const all = [...page.tables, ...page.streams].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
    for (const table of all) {
      if (table.ruled) found.tables += 1;
      else found.streams += 1;
      found.sheets.push(tableSheet(table, names.table(found.tables + found.streams)));
    }
    return;
  }
  const sheet = rowsSheet(page, names.page(page.index + 1));
  if (sheet !== null) {
    found.sheets.push(sheet);
    found.unruled.push(page.index + 1);
  }
}

/**
 * A cell's value as a number, only when it reads one way. A single `.` or `,` followed by
 * exactly three digits after one to three digits (`1.234`, `1,234`) is a thousand in one
 * locale and a fraction in the other, so it stays text; so do leading zeros (`007`, an
 * identifier), signs other than `-`, and anything longer than fifteen digits.
 */
export function cellNumber(text: string): number | null {
  const value = text.trim();
  if (!/^-?[\d.,]+$/.test(value) || !/\d/.test(value)) return null;
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  if (body.replace(/\D/g, '').length > 15) return null;
  let digits: string;
  const lastDot = body.lastIndexOf('.');
  const lastComma = body.lastIndexOf(',');
  if (lastDot === -1 && lastComma === -1) {
    if (body.length > 1 && body.startsWith('0')) return null;
    digits = body;
  } else if (lastDot !== -1 && lastComma !== -1) {
    // Both appear: the later one is the decimal mark, the other groups thousands.
    const decimal = lastDot > lastComma ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    const at = body.lastIndexOf(decimal);
    const whole = body.slice(0, at);
    const fraction = body.slice(at + 1);
    // A second decimal mark, or a group out of place, fails the pattern for the whole part.
    if (fraction === '' || !new RegExp(`^\\d{1,3}(\\${group}\\d{3})+$`).test(whole)) return null;
    digits = `${whole.split(group).join('')}.${fraction}`;
  } else {
    const mark = lastDot !== -1 ? '.' : ',';
    const parts = body.split(mark);
    if (parts.some((part) => part === '')) return null;
    if (parts.length > 2) {
      // Repeated, it can only group thousands.
      if (!new RegExp(`^\\d{1,3}(\\${mark}\\d{3})+$`).test(body)) return null;
      digits = parts.join('');
    } else {
      const [whole, fraction] = parts as [string, string];
      if (fraction.length === 3 && whole.length <= 3) return null;
      if (whole.length > 1 && whole.startsWith('0')) return null;
      digits = `${whole}.${fraction}`;
    }
  }
  // At most fifteen digits and one point: always a finite number.
  const number = Number(digits);
  return negative ? -number : number;
}

function columnName(index: number): string {
  let name = '';
  let rest = index + 1;
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

/** Excel's rules for a sheet name: 31 characters, none of `[]:*?/\`, unique. */
function sheetNames(sheets: readonly Sheet[]): string[] {
  const used = new Set<string>();
  return sheets.map((sheet, index) => {
    const base =
      sheet.name
        .replace(/[[\]:*?/\\]/g, ' ')
        .trim()
        .slice(0, 31) || `Sheet${index + 1}`;
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
      n += 1;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

async function writeXlsx(
  sheets: readonly Sheet[],
  title: string,
): Promise<{ bytes: Uint8Array; numbers: number }> {
  let numbers = 0;
  const names = sheetNames(sheets);
  const sheetXml = sheets.map((sheet) => {
    const cols = sheet.widths
      .map(
        (width, index) =>
          `<col min="${index + 1}" max="${index + 1}" width="${width.toFixed(2)}" customWidth="1"/>`,
      )
      .join('');
    const rows = sheet.rows
      .map((row, rowIndex) => {
        const content = row
          .map((text, columnIndex) => {
            if (text === '') return '';
            const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
            const number = cellNumber(text);
            if (number !== null) {
              numbers += 1;
              return `<c r="${ref}"><v>${number}</v></c>`;
            }
            const style = text.includes('\n') ? ' s="1"' : '';
            return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
          })
          .join('');
        return `<row r="${rowIndex + 1}">${content}</row>`;
      })
      .join('');
    const merges =
      sheet.merges.length === 0
        ? ''
        : `<mergeCells count="${sheet.merges.length}">${sheet.merges
            .map(
              ([r0, c0, r1, c1]) =>
                `<mergeCell ref="${columnName(c0)}${r0 + 1}:${columnName(c1)}${r1 + 1}"/>`,
            )
            .join('')}</mergeCells>`;
    return (
      `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<cols>${cols}</cols><sheetData>${rows}</sheetData>${merges}</worksheet>`
    );
  });
  const workbook =
    `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
    names
      .map((name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
      .join('') +
    '</sheets></workbook>';
  const workbookRels =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    names
      .map(
        (_name, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';
  const styles =
    `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
    '</cellXfs></styleSheet>';
  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    names
      .map(
        (_name, index) =>
          `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>';
  const files: Record<string, string> = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': PACKAGE_RELS('xl/workbook.xml'),
    'docProps/core.xml': corePropertiesXml(title),
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': workbookRels,
    'xl/styles.xml': styles,
  };
  sheetXml.forEach((content, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = content;
  });
  return { bytes: await zipped(files), numbers };
}

/** The elements called `name` at any depth of an XML node, in document order (xmldom's lists are not iterable). */
function elementsOf(parent: Document | Element, name: string): Element[] {
  const list = parent.getElementsByTagName(name);
  const out: Element[] = [];
  for (let index = 0; index < list.length; index += 1) out.push(list[index] as Element);
  return out;
}

/** The cells a sheet was written with, in the order they were written: where, and what the cell holds. */
function writtenCells(sheet: Sheet): { ref: string; number: number | null; text: string }[] {
  const out: { ref: string; number: number | null; text: string }[] = [];
  for (const [rowIndex, row] of sheet.rows.entries()) {
    for (const [columnIndex, text] of row.entries()) {
      if (text === '') continue;
      out.push({
        ref: `${columnName(columnIndex)}${rowIndex + 1}`,
        number: cellNumber(text),
        // The characters XML 1.0 cannot carry were dropped when it was written.
        text: xmlSafe(text),
      });
    }
  }
  return out;
}

/**
 * Reads the workbook back with an XML parser, the way a spreadsheet program has to: every part
 * must be well-formed, the workbook must list the sheets that were written under their names,
 * and each sheet must hold the cells that were written, at their references — a number as a
 * number, a text as the same text — and the merged ranges. What fails here is what Excel
 * answers with "we found a problem with some content": a broken escape, a lost or shifted cell.
 */
async function verifyXlsx(bytes: Uint8Array, sheets: readonly Sheet[]): Promise<void> {
  const fail = (message: string, cause?: unknown): never => {
    throw new ToolError('verification-failed', {
      engine: 'model',
      engineMessage: `xlsx read-back ${message}`,
      ...(cause === undefined ? {} : { cause }),
    });
  };
  const parse = (text: string, part: string): Document => {
    let failure: string | null = null;
    const parser = new DOMParser({
      // xmldom 0.8 reads `errorHandler`. It repairs a mismatched tag and reports it as a warning, so
      // anything it reports is a broken part: the writer's own XML gives it nothing to say.
      errorHandler: (_level: string, message: string) => {
        failure ??= message;
      },
    } as never);
    const document = parser.parseFromString(text, 'application/xml') as unknown as Document | undefined;
    if (failure !== null || document === undefined || document.documentElement === null) {
      return fail(`could not read ${part}: ${failure ?? 'empty XML'}`);
    }
    return document;
  };

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    return fail(`could not open the package: ${String(error)}`, error);
  }
  const parts = new Map<string, Document>();
  // The files of the package; the folder entries JSZip makes for their paths hold no part.
  for (const entry of Object.values(zip.files).filter((file) => !file.dir)) {
    parts.set(entry.name, parse(await entry.async('string'), entry.name));
  }
  const part = (name: string): Document => parts.get(name) ?? fail(`found no ${name}`);

  const workbook = part('xl/workbook.xml');
  const names = sheetNames(sheets);
  const listed = elementsOf(workbook, 'sheet').map((sheet) => sheet.getAttribute('name'));
  if (listed.length !== names.length || listed.some((name, at) => name !== names[at])) {
    fail(`found the sheets [${listed.join(', ')}], [${names.join(', ')}] were written`);
  }
  for (const [at, sheet] of sheets.entries()) {
    const number = at + 1;
    const document = part(`xl/worksheets/sheet${number}.xml`);
    const written = writtenCells(sheet);
    const cells = elementsOf(document, 'c');
    if (cells.length !== written.length) {
      fail(`found ${cells.length} cells in sheet ${number}, ${written.length} were written`);
    }
    for (const [index, cell] of cells.entries()) {
      const want = written[index] as (typeof written)[number];
      const ref = cell.getAttribute('r');
      if (ref !== want.ref) fail(`found cell ${ref} in sheet ${number} where ${want.ref} was written`);
      if (want.number !== null) {
        const value = elementsOf(cell, 'v')[0]?.textContent ?? '';
        if (cell.hasAttribute('t') || value === '' || Number(value) !== want.number) {
          fail(`found ${value || 'no number'} in ${ref} of sheet ${number}, ${want.number} was written`);
        }
      } else {
        const text = elementsOf(cell, 't')
          .map((piece) => piece.textContent as string)
          .join('');
        if (cell.getAttribute('t') !== 'inlineStr' || text !== want.text) {
          fail(`found other text in ${ref} of sheet ${number} than was written`);
        }
      }
    }
    const merged = elementsOf(document, 'mergeCell').map((merge) => merge.getAttribute('ref'));
    const wanted = sheet.merges.map(
      ([r0, c0, r1, c1]) => `${columnName(c0)}${r0 + 1}:${columnName(c1)}${r1 + 1}`,
    );
    if (merged.length !== wanted.length || merged.some((range, index) => range !== wanted[index])) {
      fail(
        `found the merged ranges [${merged.join(', ')}] in sheet ${number}, [${wanted.join(', ')}] were written`,
      );
    }
  }
}

/**
 * A text cell that a spreadsheet would read as a formula (`=`, `+`, `-`, `@`, or a tab or
 * carriage return before one): the text comes from the PDF, so `=HYPERLINK(…)` or a DDE call
 * in a page would run when the CSV is opened (CWE-1236). A number such as `-7` is not one.
 */
export function csvFormulaLike(text: string): boolean {
  return /^[=+\-@\t\r]/.test(text) && cellNumber(text) === null;
}

/** The cell as written: a formula-like text gets a leading `'`, the mark Excel and LibreOffice read as "text". */
function csvField(text: string, delimiter: CsvDelimiter): string {
  const value = csvFormulaLike(text) ? `'${text}` : text;
  return /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}

function writeCsv(
  sheets: readonly Sheet[],
  delimiter: CsvDelimiter,
): { bytes: Uint8Array; rows: number; guarded: number } {
  const guarded = sheets.reduce(
    (sum, sheet) => sum + sheet.rows.reduce((count, row) => count + row.filter(csvFormulaLike).length, 0),
    0,
  );
  const blocks = sheets.map((sheet) =>
    sheet.rows.map((row) => row.map((cell) => csvField(cell, delimiter)).join(delimiter)).join('\r\n'),
  );
  const text = `${blocks.join('\r\n\r\n')}\r\n`;
  // The read-back: the same rows come out of an RFC 4180 reader.
  const expected = sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0) + Math.max(0, sheets.length - 1);
  const parsed = parseCsv(text, delimiter);
  if (parsed.length !== expected) {
    throw new ToolError('verification-failed', {
      engine: 'model',
      engineMessage: `csv read-back found ${parsed.length} rows, ${expected} were written`,
    });
  }
  return { bytes: new TextEncoder().encode(`﻿${text}`), rows: expected, guarded };
}

/* ------------------------------------------------------------------ *
 * the operation
 * ------------------------------------------------------------------ */

/**
 * The Word file of page pictures, read back like the flowing one: the pictures hold no
 * text, so the words mammoth finds must be none.
 */
async function writePageImages(
  images: readonly PageImage[],
  stem: string,
  title: string,
  context: OperationContext,
): Promise<OfficeExportResult> {
  context.onProgress?.({ phase: 'write', labelKey: 'op.progress.exportOffice.write' });
  const bytes = await pageImagesDocx(images, title);
  throwIfAborted(context.signal);
  await verifyDocx(bytes, 0);
  const file: OutputFile = { name: `${stem}.docx`, bytes, mime: MIME.docx };
  const notes: OperationNote[] = [
    note('changed', 'op.note.exportOffice.done', { format: 'DOCX', pages: images.length }),
    note('preserved', 'op.note.exportOffice.pageImages', {
      dpi: Math.round(Math.min(...images.map((image) => image.dpi))),
    }),
  ];
  const shrunk = images.filter((image) => image.scale < 1);
  if (shrunk.length > 0) {
    // The smallest factor, rounded, but never 100: a page that was shrunk was shrunk.
    const percent = Math.min(99, Math.round(Math.min(...shrunk.map((image) => image.scale)) * 100));
    notes.push(
      note('changed', 'op.note.exportOffice.pageScaled', {
        pages: shrunk.map((image) => image.index + 1).join(', '),
        percent,
      }),
    );
  }
  return { file, steps: ['office.read', 'office.write', 'verify'], notes };
}

/** Up to this many distinct flagged words are named in the report. */
const MAX_FLAGGED_LISTED = 20;

/** `word (1), other (2)`: the distinct flagged words with their page numbers, the first ones, then an ellipsis when there are more. */
function flaggedList(flagged: readonly { readonly page: number; readonly text: string }[]): string {
  const seen = new Set<string>();
  const listed: string[] = [];
  let more = false;
  for (const word of flagged) {
    const entry = `${word.text} (${word.page})`;
    if (seen.has(entry)) continue;
    if (listed.length === MAX_FLAGGED_LISTED) {
      more = true;
      break;
    }
    seen.add(entry);
    listed.push(entry);
  }
  return listed.join(', ') + (more ? ', …' : '');
}

/**
 * The Word file of the exact layout, read back like the flowing one: the words mammoth finds
 * (it reads the text boxes' VML fallback) must be the words written.
 */
async function writeLayout(layout: LayoutDocx, stem: string): Promise<OfficeExportResult> {
  await verifyDocx(layout.bytes, layout.words);
  const file: OutputFile = { name: `${stem}.docx`, bytes: layout.bytes, mime: MIME.docx };
  const notes: OperationNote[] = [
    note('changed', 'op.note.exportOffice.done', { format: 'DOCX', pages: layout.pages }),
    note('preserved', 'op.note.exportOffice.layout', {
      boxes: layout.boxes,
      shapes: layout.shapes,
      pictures: layout.pictures,
    }),
  ];
  if (layout.scaled.length > 0) {
    // The smallest factor, rounded, but never 100: a page that was shrunk was shrunk.
    const percent = Math.min(99, Math.round(Math.min(...layout.scaled.map((page) => page.scale)) * 100));
    notes.push(
      note('changed', 'op.note.exportOffice.pageScaled', {
        pages: layout.scaled.map((page) => page.page).join(', '),
        percent,
      }),
    );
  }
  if (layout.rasters > 0) {
    notes.push(note('changed', 'op.note.exportOffice.layoutRasters', { count: layout.rasters }));
  }
  if (layout.fonts > 0) {
    notes.push(note('preserved', 'op.note.exportOffice.fontsEmbedded', { count: layout.fonts }));
  }
  if (layout.textless.length > 0) {
    notes.push(note('warning', 'op.note.exportOffice.noText', { pages: layout.textless.join(', ') }));
  }
  if (layout.unreadable > 0) {
    notes.push(note('lost', 'op.note.exportOffice.unreadable', { count: layout.unreadable }));
  }
  if (layout.unseenFields > 0) {
    notes.push(note('lost', 'op.note.exportOffice.layoutFieldsLost', { count: layout.unseenFields }));
  }
  if (layout.ocr.pages.length > 0) {
    notes.push(note('changed', 'op.note.exportOffice.ocrPages', { pages: layout.ocr.pages.join(', ') }));
  }
  if (layout.ocr.mixed.length > 0) {
    notes.push(note('changed', 'op.note.exportOffice.ocrMixedPages', { pages: layout.ocr.mixed.join(', ') }));
  }
  if (layout.ocr.untrusted.length > 0) {
    notes.push(
      note('changed', 'op.note.exportOffice.ocrLayerRejected', { pages: layout.ocr.untrusted.join(', ') }),
    );
  }
  if (layout.ocr.families.length > 0) {
    notes.push(
      note('preserved', 'op.note.exportOffice.ocrFont', { families: layout.ocr.families.join(', ') }),
    );
  }
  if (layout.ocr.flagged.length > 0) {
    notes.push(
      note('warning', 'op.note.exportOffice.ocrLowConfidence', {
        count: layout.ocr.flagged.length,
        words: flaggedList(layout.ocr.flagged),
      }),
    );
  }
  if (layout.ocr.unavailable.length > 0) {
    notes.push(
      note('warning', 'op.note.exportOffice.ocrUnavailable', { pages: layout.ocr.unavailable.join(', ') }),
    );
  }
  return { file, steps: ['office.read', 'office.write', 'verify'], notes };
}

export async function exportOffice(
  bytes: Uint8Array,
  options: OfficeExportOptions,
  context: OperationContext,
): Promise<OfficeExportResult> {
  throwIfAborted(context.signal);
  if (options.pages.length === 0) {
    throw new ToolError('selection-empty', { engine: 'ui', engineMessage: 'export-office: no pages' });
  }
  const mupdf = await loadMupdf();
  throwIfAborted(context.signal);
  const doc = openPdf(mupdf, bytes);
  const steps: string[] = ['office.read'];
  const notes: OperationNote[] = [];
  const asImages = options.format === 'docx' && options.docxLayout === 'page-images';
  const asLayout = options.format === 'docx' && options.docxLayout === 'layout';
  const word = options.format === 'docx';
  const names = options.sheetName ?? {
    table: (n: number) => `Table ${n}`,
    page: (n: number) => `Page ${n}`,
  };
  // What the pages leave behind, a page at a time: the pages themselves are not kept.
  const wordPages: WordPage[] = [];
  const gathered: Gathered = {
    sheets: [],
    unruled: [],
    tables: 0,
    streams: 0,
    textOutside: false,
    pictures: 0,
  };
  const textless: number[] = [];
  let unreadable = 0;
  let images: PageImage[] = [];
  let layout: LayoutDocx | null = null;
  let title: string;
  let language: string;
  const stem = options.baseName.replace(/\.pdf$/i, '') || 'document';
  try {
    title = doc.getMetaData('info:Title')?.trim() || stem;
    // The catalog's `/Lang` (BCP 47, what Word's `w:lang` takes too), when the PDF has one.
    language = readText(doc.getTrailer().get('Root').get('Lang'))?.trim() ?? '';
    if (asImages) images = await renderPageImages(doc, options.pages, context);
    else if (asLayout) {
      layout = await writeLayoutDocx(doc, options.pages, title, language, context, options.ocr ?? null);
    } else {
      await readPages(doc, options.pages, word, context, (page) => {
        const chars = charsOf(page.layout);
        if (chars.every((char) => char.c.trim() === '')) textless.push(page.index + 1);
        unreadable += chars.filter((char) => char.c === '\uFFFD').length;
        if (word) wordPages.push(wordPage(page));
        else addSheets(gathered, page, names);
      });
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'export-office');
  } finally {
    doc.destroy();
  }
  throwIfAborted(context.signal);

  if (asImages) return writePageImages(images, stem, title, context);
  if (layout !== null) return writeLayout(layout, stem);
  const pageCount = options.pages.length;
  let file: OutputFile;
  if (word) {
    steps.push('office.tables', 'office.write');
    const written = await writeDocx(wordPages, title, language, context);
    throwIfAborted(context.signal);
    steps.push('verify');
    await verifyDocx(written.bytes, written.written);
    file = { name: `${stem}.docx`, bytes: written.bytes, mime: MIME.docx };
    notes.push(note('changed', 'op.note.exportOffice.done', { format: 'DOCX', pages: pageCount }));
    notes.push(note('lost', 'op.note.exportOffice.docxApproximate'));
    const hidden = wordPages.reduce((sum, page) => sum + page.hidden, 0);
    if (hidden > 0) notes.push(note('lost', 'op.note.exportOffice.hiddenText', { count: hidden }));
    if (written.tables > 0)
      notes.push(note('preserved', 'op.note.exportOffice.tables', { count: written.tables }));
    if (written.streams > 0) {
      notes.push(note('warning', 'op.note.exportOffice.streamTables', { count: written.streams }));
    }
    if (written.pictures > 0)
      notes.push(note('preserved', 'op.note.exportOffice.pictures', { count: written.pictures }));
    const lost = wordPages.reduce((sum, page) => sum + page.lost, 0);
    if (lost > 0) notes.push(note('lost', 'op.note.exportOffice.picturesLost', { count: lost }));
  } else {
    steps.push('office.tables');
    const { sheets, tables, streams, unruled, textOutside, pictures } = gathered;
    if (sheets.length === 0) {
      throw new ToolError('no-text', {
        engine: 'model',
        engineMessage: 'export-office: the pages hold no text to put in cells',
      });
    }
    steps.push('office.write');
    context.onProgress?.({ phase: 'write', labelKey: 'op.progress.exportOffice.write' });
    if (options.format === 'xlsx') {
      const written = await writeXlsx(sheets, title);
      throwIfAborted(context.signal);
      steps.push('verify');
      await verifyXlsx(written.bytes, sheets);
      file = { name: `${stem}.xlsx`, bytes: written.bytes, mime: MIME.xlsx };
      notes.push(note('changed', 'op.note.exportOffice.done', { format: 'XLSX', pages: pageCount }));
      notes.push(note('changed', 'op.note.exportOffice.sheets', { count: sheets.length }));
      if (written.numbers > 0)
        notes.push(note('changed', 'op.note.exportOffice.numbers', { count: written.numbers }));
    } else {
      steps.push('verify');
      const written = writeCsv(sheets, options.csvDelimiter ?? ',');
      file = { name: `${stem}.csv`, bytes: written.bytes, mime: MIME.csv };
      notes.push(note('changed', 'op.note.exportOffice.done', { format: 'CSV', pages: pageCount }));
      notes.push(
        note('changed', 'op.note.exportOffice.csvRows', { rows: written.rows, tables: sheets.length }),
      );
      if (written.guarded > 0)
        notes.push(note('changed', 'op.note.exportOffice.csvFormulas', { count: written.guarded }));
    }
    if (tables > 0) notes.push(note('preserved', 'op.note.exportOffice.tables', { count: tables }));
    if (streams > 0) notes.push(note('warning', 'op.note.exportOffice.streamTables', { count: streams }));
    if (textOutside) notes.push(note('lost', 'op.note.exportOffice.outsideText'));
    // A sheet holds cells only: every picture of the pages is left out, as the Word file leaves out one it cannot place.
    if (pictures > 0) notes.push(note('lost', 'op.note.exportOffice.sheetPicturesLost', { count: pictures }));
    if (unruled.length > 0) {
      notes.push(note('warning', 'op.note.exportOffice.unruled', { pages: unruled.join(', ') }));
    }
  }
  if (textless.length > 0)
    notes.push(note('warning', 'op.note.exportOffice.noText', { pages: textless.join(', ') }));
  if (unreadable > 0) notes.push(note('lost', 'op.note.exportOffice.unreadable', { count: unreadable }));
  return { file, steps, notes };
}
