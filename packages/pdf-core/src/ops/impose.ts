/**
 * Imposition: N-up, booklet and poster.
 *
 * The source project lost page cropping, never rotated content, and had no paper
 * options. Here the sheet geometry is computed explicitly, source content is
 * rotated into its cell (that is what makes a 2-up of landscape pages readable),
 * and margins/gutter/crop marks are part of the layout rather than decorations.
 *
 * How a page reaches a sheet (the MuPDF writer vocabulary, `engines/mupdf-write.ts`):
 *  - `pageAsForm` turns a page into a Form XObject from its **content streams and
 *    resources** (grafted once per document), bounded by its CropBox — which
 *    preserves cropping (source defect A16). The page's `/Rotate` is **not** applied:
 *    its own rotation is added to the placement rotation, or a rotated source lands
 *    sideways.
 *  - a Form XObject carries no `/Annots` (links, annotations, form widgets), no
 *    outline and no page labels; that is reported as a loss.
 *  - fonts and images are copied, so the content stays vector: text in the
 *    imposed sheets remains selectable and searchable, nothing is rasterised.
 *
 * Saddle-stitch order (`booklet`): with `N` pages padded up to a multiple of 4 and
 * sheet `i` counted from the outside in, the front side carries `[N - 2i, 2i + 1]`
 * and the back side `[2i + 2, N - 2i - 1]` — the classic imposition that folds
 * into reading order 1, 2-3, 4-5, …, N.
 *
 * `buildPrintDocument` (the print dialog's "produce the PDF to print")
 * lays the same cells out for a **duplex** printer. Its sheet order is the whole
 * feature, so it is written out here instead of being derived in code:
 *
 * | `duplex` | sides per sheet | pages per sheet | the back side |
 * |---|---|---|---|
 * | `simplex` | 1 | `perSheet` | not written at all |
 * | `long-edge` | 2 | `2 × perSheet` | flipped about the sheet's **long** edge |
 * | `short-edge` | 2 | `2 × perSheet` | flipped about the sheet's **short** edge |
 *
 * A PDF page cannot say "I am the back of the previous page", so the file states
 * it by *sheet order* — output pages `2i` and `2i + 1` are the two sides of
 * sheet `i`, the convention a duplex driver maps back onto the paper — and by
 * drawing the back side so each of its cells lands behind the front cell with the
 * same index. The flip axis decides which way that is, as cell indices of a
 * `C × R` grid (`c`, `r`; the back's slot `k` is drawn at `c'`, `r'`):
 *
 * | `duplex` | portrait sheet (height > width) | landscape sheet |
 * |---|---|---|
 * | `long-edge` | `c' = C-1-c`, `r' = r` | `c' = c`, `r' = R-1-r` |
 * | `short-edge` | `c' = c`, `r' = R-1-r` | `c' = C-1-c`, `r' = r` |
 *
 * Reason for the table: the sheet's long edge is the vertical axis on a portrait
 * page and the horizontal one on a landscape page, so "flip about the long edge"
 * mirrors the cells horizontally on the former and vertically on the latter.
 * Mirroring the *placement* — never the content — is what cancels the flip the
 * printer performs: a reader who flips the printed sheet about that axis sees the
 * back side in the front side's cell positions, in reading order. The axis is
 * therefore not decoration: choosing the other one produces a different file
 * (the mirror is the identity only when the grid has a single row or column),
 * and the report names the axis the user has to set on the printer.
 *
 * Two consequences, both stated to the user rather than hidden:
 *  - `duplex` is a *file* rule, not a printer setting: printing the result
 *    single-sided yields every side as its own sheet, which the report warns
 *    about (`print.note.duplex*`);
 *  - with `booklet`, `perSheet` must be 4 (two panels per side, `imposeDocument`'s
 *    own signature grid) and the fold fixes the pairing, so the back side is
 *    written in classic order: `long-edge` stacks the two panels on a portrait
 *    sheet, `short-edge` puts them side by side on a landscape one. Both folds
 *    run parallel to the paper's short edge, which is why a signature prints with
 *    the driver's *short edge* flip either way.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError, openPdf } from '../engines/mupdf';
import {
  copyDocumentInfo,
  openForWrite,
  pageAsForm,
  pageObjects,
  pdfNumber,
  saveRewrite,
} from '../engines/mupdf-write';
import { type PageGeometry, pageGeometry } from './stamp';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

export type PaperSize = 'a4' | 'a3' | 'letter';

export interface NUpOptions {
  readonly mode: 'nup';
  readonly pages: readonly number[];
  readonly perSheet: 2 | 4 | 6 | 8 | 9 | 16;
  readonly paper: PaperSize;
  readonly orientation: 'auto' | 'portrait' | 'landscape';
  readonly gutterMm: number;
  readonly marginMm: number;
  readonly rotateContent: boolean;
}

export interface BookletOptions {
  readonly mode: 'booklet';
  readonly pages: readonly number[];
  readonly paper: PaperSize;
  readonly gutterMm: number;
  readonly marginMm: number;
}

export interface PosterOptions {
  readonly mode: 'poster';
  readonly pages: readonly number[];
  readonly paper: PaperSize;
  readonly columns: number;
  readonly rows: number;
  readonly overlapMm: number;
  readonly cropMarks: boolean;
}

export type ImposeOptions = NUpOptions | BookletOptions | PosterOptions;

export interface ImposePlan {
  readonly sheets: number;
  readonly perSheet: number;
  /** Blank pages appended so a booklet signature is complete. */
  readonly padded: number;
}

const PT_PER_MM = 72 / 25.4;

/** ISO A4/A3 and US Letter in points (1 pt = 1/72 inch). */
const PAPER_SIZES: Readonly<Record<PaperSize, { readonly width: number; readonly height: number }>> = {
  a4: { width: 595.28, height: 841.89 },
  a3: { width: 841.89, height: 1190.55 },
  letter: { width: 612, height: 792 },
};

/** Cells per sheet as `[columns, rows]`, filled in reading order (first page top-left). */
const GRIDS: Readonly<
  Record<
    NUpOptions['perSheet'],
    { readonly portrait: readonly [number, number]; readonly landscape: readonly [number, number] }
  >
> = {
  2: { portrait: [1, 2], landscape: [2, 1] },
  4: { portrait: [2, 2], landscape: [2, 2] },
  6: { portrait: [2, 3], landscape: [3, 2] },
  8: { portrait: [2, 4], landscape: [4, 2] },
  9: { portrait: [3, 3], landscape: [3, 3] },
  16: { portrait: [4, 4], landscape: [4, 4] },
};

/** Crop marks: 6 mm registration crosses, 2 mm clear of the trim corner, hairline. */
const MARK_LENGTH_PT = 6 * PT_PER_MM;

function requireRange(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `${field} must be between ${min} and ${max}`,
    });
  }
  return value;
}

function requiredPages(pages: readonly number[], pageCount: number): number[] {
  if (pages.length === 0) {
    throw new ToolError('selection-empty', { engine: 'model', engineMessage: 'no pages to impose' });
  }
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) {
      throw new ToolError('range-invalid', {
        engine: 'model',
        engineMessage: 'page index out of bounds',
        pageIndex: page,
      });
    }
  }
  return [...pages];
}

function sheetSize(
  paper: PaperSize,
  orientation: 'portrait' | 'landscape',
): { width: number; height: number } {
  const size = PAPER_SIZES[paper];
  return orientation === 'portrait'
    ? { width: size.width, height: size.height }
    : { width: size.height, height: size.width };
}

function gridFor(
  perSheet: NUpOptions['perSheet'],
  orientation: 'portrait' | 'landscape',
): { columns: number; rows: number } {
  const [columns, rows] = GRIDS[perSheet][orientation];
  return { columns, rows };
}

/** Uniform scale that fits a `width`x`height` box into a cell. */
function fitScale(cellWidth: number, cellHeight: number, width: number, height: number): number {
  return Math.min(cellWidth / width, cellHeight / height);
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/** Cell size for a grid, honouring margins and gutters (both in mm). */
function cellSize(sheet: Size, columns: number, rows: number, marginMm: number, gutterMm: number): Size {
  const margin = requireRange(marginMm, 0, 100, 'marginMm') * PT_PER_MM;
  const gutter = requireRange(gutterMm, 0, 100, 'gutterMm') * PT_PER_MM;
  const width = (sheet.width - 2 * margin - gutter * (columns - 1)) / columns;
  const height = (sheet.height - 2 * margin - gutter * (rows - 1)) / rows;
  if (width <= 0 || height <= 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: 'margins and gutter leave no room for cells',
    });
  }
  return { width, height };
}

/** Cell rectangle on the sheet, in sheet coordinates; cell 0 is the top-left one. */
function cellRectangle(
  sheet: Size,
  cell: Size,
  columns: number,
  index: number,
  marginMm: number,
  gutterMm: number,
): { x: number; y: number; width: number; height: number } {
  const margin = marginMm * PT_PER_MM;
  const gutter = gutterMm * PT_PER_MM;
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: margin + column * (cell.width + gutter),
    y: sheet.height - margin - (row + 1) * cell.height - row * gutter,
    width: cell.width,
    height: cell.height,
  };
}

/**
 * The origin a drawing operator needs so that the content, rotated by `rotation`
 * (a multiple of 90), has its **lower-left corner** at `lowerLeft`. The content
 * spans `[0, drawnWidth] x [0, drawnHeight]` in its own frame; rotating that frame
 * by 0/90/180/270 moves the corner, so the origin is shifted back accordingly.
 */
function anchorForLowerLeft(
  lowerLeft: { readonly x: number; readonly y: number },
  rotation: number,
  drawnWidth: number,
  drawnHeight: number,
): { x: number; y: number } {
  const normalised = ((rotation % 360) + 360) % 360;
  switch (normalised) {
    case 90:
      return { x: lowerLeft.x + drawnHeight, y: lowerLeft.y };
    case 180:
      return { x: lowerLeft.x + drawnWidth, y: lowerLeft.y + drawnHeight };
    case 270:
      return { x: lowerLeft.x, y: lowerLeft.y + drawnWidth };
    default:
      return { x: lowerLeft.x, y: lowerLeft.y };
  }
}

/** Same anchor, for content centred on a point. */
function anchorCentred(
  centre: { readonly x: number; readonly y: number },
  rotation: number,
  drawnWidth: number,
  drawnHeight: number,
): { x: number; y: number } {
  const normalised = ((rotation % 360) + 360) % 360;
  const swapped = normalised === 90 || normalised === 270;
  const boxWidth = swapped ? drawnHeight : drawnWidth;
  const boxHeight = swapped ? drawnWidth : drawnHeight;
  return anchorForLowerLeft(
    { x: centre.x - boxWidth / 2, y: centre.y - boxHeight / 2 },
    normalised,
    drawnWidth,
    drawnHeight,
  );
}

/**
 * The sheet orientation whose cells let the pages be printed largest — the
 * `auto` choice, measured instead of guessed: a portrait A4 sheet holding two
 * portrait pages stacks them (scale ~0.47) while the landscape sheet places them
 * side by side (scale ~0.64), which is the layout a 2-up should have.
 */
function chooseOrientation(options: NUpOptions, averageAspect: number): 'portrait' | 'landscape' {
  const synthetic = { width: averageAspect, height: 1 };
  let best: { orientation: 'portrait' | 'landscape'; scale: number } | undefined;
  for (const orientation of ['portrait', 'landscape'] as const) {
    const sheet = sheetSize(options.paper, orientation);
    const grid = gridFor(options.perSheet, orientation);
    const cell = cellSize(sheet, grid.columns, grid.rows, options.marginMm, options.gutterMm);
    const scale = fitScale(cell.width, cell.height, synthetic.width, synthetic.height);
    if (best === undefined || scale > best.scale) best = { orientation, scale };
  }
  return best?.orientation ?? 'portrait';
}

/** Cross-shaped registration marks centred on the trim lines of one tile. */
function cropMarkOperators(
  sheet: Size,
  column: number,
  row: number,
  columns: number,
  rows: number,
  overlap: number,
): string[] {
  const half = overlap / 2;
  // Trailing edges of a tile are cut in the middle of the duplicated strip; the
  // leading edges of the first row/column are the sheet's own edges (no cut).
  const left = column > 0 ? half : 0;
  const right = sheet.width - (column < columns - 1 ? half : 0);
  const bottom = row < rows - 1 ? half : 0;
  const top = sheet.height - (row > 0 ? half : 0);
  const operators: string[] = [];
  for (const corner of [
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: left, y: top },
    { x: right, y: top },
  ]) {
    const horizontal = {
      start: { x: Math.max(0, corner.x - MARK_LENGTH_PT), y: corner.y },
      end: { x: Math.min(sheet.width, corner.x + MARK_LENGTH_PT), y: corner.y },
    };
    const vertical = {
      start: { x: corner.x, y: Math.max(0, corner.y - MARK_LENGTH_PT) },
      end: { x: corner.x, y: Math.min(sheet.height, corner.y + MARK_LENGTH_PT) },
    };
    for (const line of [horizontal, vertical]) {
      if (line.start.x === line.end.x && line.start.y === line.end.y) continue;
      operators.push(lineOperators(line.start, line.end));
    }
  }
  return operators;
}

/** A straight hairline in black: one crop-mark stroke. */
function lineOperators(start: { x: number; y: number }, end: { x: number; y: number }): string {
  const n = pdfNumber;
  return `q 0 G 0.5 w ${n(start.x)} ${n(start.y)} m ${n(end.x)} ${n(end.y)} l S Q`;
}

/** One embedded source page and the geometry it is placed by. */
interface EmbeddedSource {
  readonly form: PDFObject;
  readonly geometry: PageGeometry;
}

/**
 * The sheets of an output document, drawn one at a time: a sheet collects operators and
 * the form XObjects it names, and becomes a page when it is finished.
 */
class SheetWriter {
  private operators: string[] = [];
  private xObjects: Record<string, PDFObject> = {};
  private names = new Map<PDFObject, string>();
  private size: { readonly width: number; readonly height: number } | null = null;

  constructor(private readonly out: PDFDocument) {}

  begin(size: { readonly width: number; readonly height: number }): void {
    this.operators = [];
    this.xObjects = {};
    this.names = new Map();
    this.size = size;
  }

  /** `drawPage`: translate to `(x, y)`, turn by `rotate` degrees, scale, draw the form. */
  drawPage(form: PDFObject, x: number, y: number, scale: number, rotate: number): void {
    let name = this.names.get(form);
    if (name === undefined) {
      name = `P${this.names.size}`;
      this.names.set(form, name);
      this.xObjects[name] = form;
    }
    const radians = (rotate * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const matrix = [cos * scale, sin * scale, -sin * scale, cos * scale, x, y].map(pdfNumber).join(' ');
    this.operators.push(`q ${matrix} cm /${name} Do Q`);
  }

  push(...operators: readonly string[]): void {
    this.operators.push(...operators);
  }

  finish(): void {
    if (this.size === null) return;
    const page = this.out.addPage(
      [0, 0, this.size.width, this.size.height],
      0,
      { XObject: this.xObjects },
      this.operators.join('\n'),
    );
    this.out.insertPage(this.out.countPages(), page);
    this.size = null;
  }
}

/** One form XObject per source page, however often the page appears. */
function sourceEmbedder(
  source: PDFDocument,
  out: PDFDocument,
  context: OperationContext,
): (pageIndex: number) => EmbeddedSource {
  const pages = pageObjects(source);
  const graft = out.newGraftMap();
  const embedded = new Map<number, EmbeddedSource>();
  return (pageIndex) => {
    const cached = embedded.get(pageIndex);
    if (cached !== undefined) return cached;
    throwIfAborted(context.signal);
    const page = pages[pageIndex];
    if (page === undefined) throw new ToolError('range-invalid', { engine: 'mupdf', pageIndex });
    const geometry = pageGeometry(page);
    // The CropBox, so a sheet shows what a reader shows (source defect A16); the form
    // moves that box to the origin, and `/Rotate` is applied by hand.
    const entry = { form: pageAsForm(out, graft, page, geometry.box), geometry };
    embedded.set(pageIndex, entry);
    return entry;
  };
}

export function planImposition(sourcePages: number, options: ImposeOptions): ImposePlan {
  if (!Number.isSafeInteger(sourcePages) || sourcePages < 0) {
    throw new ToolError('range-invalid', { engine: 'model', engineMessage: 'invalid source page count' });
  }
  switch (options.mode) {
    case 'nup':
      return { sheets: Math.ceil(sourcePages / options.perSheet), perSheet: options.perSheet, padded: 0 };
    case 'booklet': {
      // A folded sheet carries four pages (two per side), so the signature grows
      // to a multiple of four in the imposition order used below.
      const sheets = Math.ceil(sourcePages / 4);
      return { sheets, perSheet: 4, padded: sheets * 4 - sourcePages };
    }
    default: {
      const columns = requireRange(options.columns, 1, 10, 'columns');
      const rows = requireRange(options.rows, 1, 10, 'rows');
      return { sheets: sourcePages * columns * rows, perSheet: 1, padded: 0 };
    }
  }
}

export async function imposeDocument(
  bytes: Uint8Array,
  options: ImposeOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const { mupdf, doc: source } = await openForWrite(bytes);
  const out = new mupdf.PDFDocument();
  try {
    return imposeOpened(source, out, bytes, options, context);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'impose');
  } finally {
    out.destroy();
    source.destroy();
  }
}

function imposeOpened(
  source: PDFDocument,
  out: PDFDocument,
  bytes: Uint8Array,
  options: ImposeOptions,
  context: OperationContext,
): OperationOutcome {
  const pages = requiredPages(options.pages, source.countPages());
  const plan = planImposition(pages.length, options);
  const notes: OperationNote[] = [];
  const steps: string[] = ['load'];
  const embed = sourceEmbedder(source, out, context);
  const sheet = new SheetWriter(out);

  /** Draws one embedded page into a cell, centred and scaled to fit. */
  const drawIntoCell = (
    embedded: EmbeddedSource,
    rectangle: { x: number; y: number; width: number; height: number },
    turn: boolean,
  ): number => {
    const { geometry } = embedded;
    const rotation = geometry.rotation + (turn ? 90 : 0);
    const visible = turn
      ? { width: geometry.display.height, height: geometry.display.width }
      : geometry.display;
    const scale = fitScale(rectangle.width, rectangle.height, visible.width, visible.height);
    const anchor = anchorCentred(
      { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 },
      rotation,
      geometry.box.width * scale,
      geometry.box.height * scale,
    );
    sheet.drawPage(embedded.form, anchor.x, anchor.y, scale, rotation);
    return scale;
  };

  let sheetsProduced = 0;
  let rotatedPlacements = 0;

  if (options.mode === 'nup') {
    const aspectSum = pages.reduce((total, index) => {
      const display = embed(index).geometry.display;
      return total + display.width / display.height;
    }, 0);
    const orientation =
      options.orientation === 'auto'
        ? chooseOrientation(options, aspectSum / pages.length)
        : options.orientation;
    const size = sheetSize(options.paper, orientation);
    const grid = gridFor(options.perSheet, orientation);
    const cell = cellSize(size, grid.columns, grid.rows, options.marginMm, options.gutterMm);
    steps.push('pages');

    for (let sheetIndex = 0; sheetIndex < plan.sheets; sheetIndex += 1) {
      sheet.begin(size);
      for (let slot = 0; slot < options.perSheet; slot += 1) {
        const pageIndex = pages[sheetIndex * options.perSheet + slot];
        if (pageIndex === undefined) break;
        throwIfAborted(context.signal);
        const embedded = embed(pageIndex);
        const { geometry } = embedded;
        const rectangle = cellRectangle(size, cell, grid.columns, slot, options.marginMm, options.gutterMm);
        const upright = fitScale(
          rectangle.width,
          rectangle.height,
          geometry.display.width,
          geometry.display.height,
        );
        const turned = fitScale(
          rectangle.width,
          rectangle.height,
          geometry.display.height,
          geometry.display.width,
        );
        // `rotateContent` turns a page whose aspect fights its cell; without the
        // option the page is placed exactly as authored (scaled, never turned).
        const turn = options.rotateContent && turned > upright;
        if (turn) rotatedPlacements += 1;
        drawIntoCell(embedded, rectangle, turn);
      }
      sheet.finish();
      sheetsProduced += 1;
      context.onProgress?.({
        phase: 'impose',
        labelKey: 'op.progress.impose',
        done: Math.min((sheetIndex + 1) * options.perSheet, pages.length),
        total: pages.length,
      });
    }
  } else if (options.mode === 'booklet') {
    // A saddle-stitch signature is printed landscape: two panels side by side.
    const size = sheetSize(options.paper, 'landscape');
    const cell = cellSize(size, 2, 1, options.marginMm, options.gutterMm);
    const total = plan.sheets * 4;
    steps.push('pages');

    const panel = (side: number): { x: number; y: number; width: number; height: number } =>
      side === 0
        ? cellRectangle(size, cell, 2, 0, options.marginMm, options.gutterMm)
        : cellRectangle(size, cell, 2, 1, options.marginMm, options.gutterMm);

    for (let sheetIndex = 0; sheetIndex < plan.sheets; sheetIndex += 1) {
      const fronts = [total - 2 * sheetIndex, 2 * sheetIndex + 1];
      const backs = [2 * sheetIndex + 2, total - 2 * sheetIndex - 1];
      for (const side of [fronts, backs]) {
        sheet.begin(size);
        for (const [panelIndex, pageNumber] of side.entries()) {
          throwIfAborted(context.signal);
          const sourceIndex = pages[pageNumber - 1];
          if (sourceIndex === undefined) continue; // padding page of the signature
          drawIntoCell(embed(sourceIndex), panel(panelIndex), false);
        }
        sheet.finish();
        sheetsProduced += 1;
        context.onProgress?.({
          phase: 'impose',
          labelKey: 'op.progress.impose',
          done: sheetsProduced,
          total: plan.sheets * 2,
        });
      }
    }
    if (plan.padded > 0) notes.push(note('changed', 'op.note.impose.padded', { count: plan.padded }));
  } else {
    const columns = requireRange(options.columns, 1, 10, 'columns');
    const rows = requireRange(options.rows, 1, 10, 'rows');
    const overlap = requireRange(options.overlapMm, 0, 50, 'overlapMm') * PT_PER_MM;
    const size = sheetSize(options.paper, 'portrait');
    const pitchX = size.width - overlap;
    const pitchY = size.height - overlap;
    // The enlarged page fits the whole tile grid: one uniform scale keeps the aspect
    // ratio, nothing of the page is cut, and the last tiles may carry blank edge area
    // instead of a stretched page. (The pdf-lib writer took the larger of the two
    // scales, which cut the page's right or bottom edge.)
    const covered = {
      width: size.width + pitchX * (columns - 1),
      height: size.height + pitchY * (rows - 1),
    };
    steps.push('tiles');

    for (const pageIndex of pages) {
      const embedded = embed(pageIndex);
      const { geometry } = embedded;
      const scale = Math.min(
        covered.width / geometry.display.width,
        covered.height / geometry.display.height,
      );
      const visible = {
        width: geometry.display.width * scale,
        height: geometry.display.height * scale,
      };
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          throwIfAborted(context.signal);
          sheet.begin(size);
          // Rows count from the top, so the first sheet carries the top-left corner: a
          // tile shows the band of the enlarged page whose top edge is `row` pitches
          // below the page's top, so the page's lower-left corner sits that far below
          // the sheet's own. (The pdf-lib writer had the sign reversed: every row but
          // the last came out blank.)
          const lowerLeft = { x: -column * pitchX, y: size.height + row * pitchY - visible.height };
          const anchor = anchorForLowerLeft(
            lowerLeft,
            geometry.rotation,
            geometry.box.width * scale,
            geometry.box.height * scale,
          );
          sheet.drawPage(embedded.form, anchor.x, anchor.y, scale, geometry.rotation);
          if (options.cropMarks) sheet.push(...cropMarkOperators(size, column, row, columns, rows, overlap));
          sheet.finish();
          sheetsProduced += 1;
          context.onProgress?.({
            phase: 'impose',
            labelKey: 'op.progress.impose',
            done: sheetsProduced,
            total: plan.sheets,
          });
        }
      }
    }
    if (options.cropMarks) notes.push(note('changed', 'op.note.impose.cropMarks'));
  }

  if (sheetsProduced === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: 'imposition produced no sheets',
    });
  }

  copyDocumentInfo(source, out);
  steps.push('save');
  const produced = saveRewrite(out, 'impose');

  notes.push(note('changed', 'op.note.impose.sheets', { sheets: sheetsProduced }));
  notes.push(note('preserved', 'op.note.impose.vector'));
  notes.push(note('lost', 'op.note.impose.lostInteractive'));
  notes.push(note('preserved', 'op.note.impose.infoCopied'));
  if (rotatedPlacements > 0)
    notes.push(note('changed', 'op.note.impose.rotated', { count: rotatedPlacements }));
  notes.push(note('preserved', 'op.note.metadata.producerKept'));

  const report: OperationReport = {
    engine: 'mupdf',
    steps,
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: produced.byteLength,
    pageCount: out.countPages(),
    // A freshly built document: never incremental.
    incremental: false,
  };
  return { bytes: produced, report };
}

/* ------------------------------------------------------------------ *
 * Print imposition: the PDF a duplex printer can be handed
 * ------------------------------------------------------------------ */

/** Which side of a physical sheet carries which half of the job (file header table). */
export type PrintDuplex = 'simplex' | 'long-edge' | 'short-edge';

/** How a source page meets its cell. `actual` never enlarges, `shrink-to-fit` only shrinks. */
export type PrintScale = 'fit' | 'shrink-to-fit' | 'actual';

export interface PrintImpositionOptions {
  /** 0-based source pages, in output order. */
  readonly pages: readonly number[];
  /** Cells on one side; a saddle-stitch signature needs exactly 4. */
  readonly perSheet: 1 | 2 | 4 | 6 | 8 | 9 | 16;
  readonly booklet: boolean;
  readonly duplex: PrintDuplex;
  readonly marginMm: number;
  readonly paper: PaperSize;
  readonly landscape: boolean;
  readonly cropMarks: boolean;
  readonly scale: PrintScale;
}

/** Cells of one layout, per sheet orientation (`1` is print-only: `imposeDocument` starts at 2). */
const PRINT_GRIDS: Readonly<
  Record<
    PrintImpositionOptions['perSheet'],
    { readonly portrait: readonly [number, number]; readonly landscape: readonly [number, number] }
  >
> = {
  1: { portrait: [1, 1], landscape: [1, 1] },
  ...GRIDS,
};

/** Registration marks: a 6 mm cross, 2 mm clear of the trim corner, hairline. */
const MARK_GAP_PT = 2 * PT_PER_MM;

/** Tolerance for "does this placement overflow its cell"; points are small enough. */
const CELL_EPSILON_PT = 0.01;

/** One side of a sheet: the source page drawn in each cell, `null` = an empty cell. */
export interface PrintSheetPlan {
  readonly front: readonly (number | null)[];
  /** `null` for a simplex sheet — no back side is written at all. */
  readonly back: readonly (number | null)[] | null;
}

/** The sheet order of a print job: what `buildPrintDocument` draws, without an engine. */
export interface PrintPlan {
  readonly sheets: readonly PrintSheetPlan[];
  readonly columns: number;
  readonly rows: number;
  /** The orientation the sheets are drawn in (a signature decides it from `duplex`). */
  readonly orientation: 'portrait' | 'landscape';
  /** Blank pages appended so a signature is complete. */
  readonly padded: number;
}

/**
 * The cell the back side's `slot` is drawn into, mirrored across the flip axis.
 * The sheet's long edge is vertical on a portrait page and horizontal on a
 * landscape one, so the same option mirrors columns on one and rows on the other
 * (the table in the file header).
 */
function mirroredBackCell(
  slot: number,
  columns: number,
  rows: number,
  duplex: PrintDuplex,
  portrait: boolean,
): number {
  const column = slot % columns;
  const row = Math.floor(slot / columns);
  const mirrorColumns = duplex === 'long-edge' ? portrait : !portrait;
  const targetColumn = mirrorColumns ? columns - 1 - column : column;
  const targetRow = mirrorColumns ? row : rows - 1 - row;
  return targetRow * columns + targetColumn;
}

/** `count` cells starting at `start`; a page the job runs out of is an empty cell. */
function cellBlock(pages: readonly number[], start: number, count: number): (number | null)[] {
  return Array.from({ length: count }, (_unused, offset) => pages[start + offset] ?? null);
}

/**
 * Resolve the sheet order of a print job. Pure: what is printed where is decided
 * here, reviewed without an engine, and drawn by `buildPrintDocument`.
 */
export function planPrintSheets(pageCount: number, options: PrintImpositionOptions): PrintPlan {
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: 'invalid source page count',
      path: String(pageCount),
    });
  }
  const pages = requiredPages(options.pages, pageCount);
  requireRange(options.marginMm, 0, 100, 'marginMm');
  if (options.booklet && options.perSheet !== 4) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `a saddle-stitch signature carries 2 panels on each of its 2 sides: perSheet must be 4, not ${options.perSheet}`,
    });
  }
  if (options.booklet && options.duplex === 'simplex') {
    throw new ToolError('unsupported', {
      engine: 'model',
      engineMessage:
        'a signature has a front and a back side: simplex would print one side of every folded sheet, so duplex must be long-edge or short-edge',
    });
  }

  if (options.booklet) {
    // The fold decides the layout: a crease parallel to the short edge puts the
    // panels side by side on a landscape sheet, a crease parallel to the long
    // edge stacks them on a portrait one. Both are the classic signature order
    // (front `[N-2i, 2i+1]`, back `[2i+2, N-2i-1]`) drawn in reading order.
    const orientation = options.duplex === 'short-edge' ? 'landscape' : 'portrait';
    const columns = orientation === 'landscape' ? 2 : 1;
    const rows = orientation === 'landscape' ? 1 : 2;
    const signature = Math.ceil(pages.length / 4) * 4;
    const sheets: PrintSheetPlan[] = [];
    for (let index = 0; index < signature / 4; index += 1) {
      const front = [signature - 2 * index, 2 * index + 1];
      const back = [2 * index + 2, signature - 2 * index - 1];
      sheets.push({
        front: front.map((pageNumber) => pages[pageNumber - 1] ?? null),
        back: back.map((pageNumber) => pages[pageNumber - 1] ?? null),
      });
    }
    return { sheets, columns, rows, orientation, padded: signature - pages.length };
  }

  const orientation: 'portrait' | 'landscape' = options.landscape ? 'landscape' : 'portrait';
  const grid = PRINT_GRIDS[options.perSheet][orientation];
  const { width, height } = sheetSize(options.paper, orientation);
  const portrait = height > width;
  const cellsPerSide = grid[0] * grid[1];
  // A duplex sheet carries one side's worth of pages on each of its two sides,
  // so a job of `n` pages needs half as many sheets as a simplex one.
  const perSheetPages = options.duplex === 'simplex' ? cellsPerSide : cellsPerSide * 2;
  const sheetCount = Math.ceil(pages.length / perSheetPages);
  const sheets: PrintSheetPlan[] = [];
  for (let index = 0; index < sheetCount; index += 1) {
    const start = index * perSheetPages;
    const front = cellBlock(pages, start, cellsPerSide);
    if (options.duplex === 'simplex') {
      sheets.push({ front, back: null });
      continue;
    }
    const slots = cellBlock(pages, start + cellsPerSide, cellsPerSide);
    if (slots.every((page) => page === null)) {
      sheets.push({ front, back: null });
      continue;
    }
    const back: (number | null)[] = Array.from({ length: cellsPerSide }, () => null);
    for (const [slot, page] of slots.entries()) {
      back[mirroredBackCell(slot, grid[0], grid[1], options.duplex, portrait)] = page;
    }
    sheets.push({ front, back });
  }
  return { sheets, columns: grid[0], rows: grid[1], orientation, padded: 0 };
}

/** The scale one page gets in its cell; `actual` and `shrink-to-fit` never enlarge. */
function printCellScale(mode: PrintScale, cell: Size, display: Size): number {
  const fit = fitScale(cell.width, cell.height, display.width, display.height);
  if (mode === 'actual') return 1;
  return mode === 'shrink-to-fit' ? Math.min(fit, 1) : fit;
}

/** Clip drawing to one cell, so a page bigger than its cell cannot overlap its neighbour. */
function cellClipOperators(rectangle: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): string {
  const box = [rectangle.x, rectangle.y, rectangle.width, rectangle.height].map(pdfNumber).join(' ');
  return `q ${box} re W n`;
}

/** Registration crosses around one cell's trim corners. */
function cellCropMarks(rectangle: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): string[] {
  const half = MARK_LENGTH_PT / 2;
  const corners = [
    { x: rectangle.x, y: rectangle.y, dx: -1, dy: -1 },
    { x: rectangle.x + rectangle.width, y: rectangle.y, dx: 1, dy: -1 },
    { x: rectangle.x, y: rectangle.y + rectangle.height, dx: -1, dy: 1 },
    { x: rectangle.x + rectangle.width, y: rectangle.y + rectangle.height, dx: 1, dy: 1 },
  ];
  const operators: string[] = [];
  for (const corner of corners) {
    const at = { x: corner.x + corner.dx * MARK_GAP_PT, y: corner.y + corner.dy * MARK_GAP_PT };
    operators.push(
      lineOperators({ x: at.x - half, y: at.y }, { x: at.x + half, y: at.y }),
      lineOperators({ x: at.x, y: at.y - half }, { x: at.x, y: at.y + half }),
    );
  }
  return operators;
}

/**
 * Produce the document to print: the pages placed on the sheets the layout asks
 * for, in the sheet order `planPrintSheets` resolved. Print settings the browser
 * dialog owns — which tray, duplex on the printer, quality — are not PDF data;
 * this file carries the *layout* and states in the report which flip axis the
 * printer has to be set to.
 */
export async function buildPrintDocument(
  bytes: Uint8Array,
  options: PrintImpositionOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const mupdf = await loadMupdf();
  // Read-only: the source is only measured and embedded, so it is opened without the
  // writer's password check — a re-layout of pages the caller already has the plaintext
  // of must not stop at it.
  const source = openPdf(mupdf, bytes);
  const out = new mupdf.PDFDocument();
  try {
    return printOpened(source, out, bytes, options, context);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'buildPrintDocument');
  } finally {
    out.destroy();
    source.destroy();
  }
}

function printOpened(
  source: PDFDocument,
  out: PDFDocument,
  bytes: Uint8Array,
  options: PrintImpositionOptions,
  context: OperationContext,
): OperationOutcome {
  const plan = planPrintSheets(source.countPages(), options);
  const size = sheetSize(options.paper, plan.orientation);
  const cell = cellSize(size, plan.columns, plan.rows, options.marginMm, 0);
  const steps: string[] = ['load', 'sheets'];
  const notes: OperationNote[] = [];
  const embed = sourceEmbedder(source, out, context);
  const sheet = new SheetWriter(out);

  let sides = 0;
  let clipped = 0;
  for (const [sheetIndex, sheetPlan] of plan.sheets.entries()) {
    for (const cells of [sheetPlan.front, sheetPlan.back]) {
      if (cells === null) continue;
      sheet.begin(size);
      for (const [cellIndex, pageIndex] of cells.entries()) {
        if (pageIndex === null) continue;
        throwIfAborted(context.signal);
        const embedded = embed(pageIndex);
        const { geometry } = embedded;
        const rectangle = cellRectangle(size, cell, plan.columns, cellIndex, options.marginMm, 0);
        const scale = printCellScale(options.scale, rectangle, geometry.display);
        const overflow =
          geometry.display.width * scale > rectangle.width + CELL_EPSILON_PT ||
          geometry.display.height * scale > rectangle.height + CELL_EPSILON_PT;
        if (overflow) {
          // A placement wider than its cell would cover the neighbouring page;
          // the cell is the trim, so the page is cut at it instead.
          sheet.push(cellClipOperators(rectangle));
          clipped += 1;
        }
        const anchor = anchorCentred(
          { x: rectangle.x + rectangle.width / 2, y: rectangle.y + rectangle.height / 2 },
          geometry.rotation,
          geometry.box.width * scale,
          geometry.box.height * scale,
        );
        sheet.drawPage(embedded.form, anchor.x, anchor.y, scale, geometry.rotation);
        if (overflow) sheet.push('Q');
        if (options.cropMarks) sheet.push(...cellCropMarks(rectangle));
      }
      sheet.finish();
      sides += 1;
    }
    context.onProgress?.({
      phase: 'sheets',
      labelKey: 'print.progress.sheets',
      done: sheetIndex + 1,
      total: plan.sheets.length,
    });
  }

  if (sides === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: 'the print layout produced no sheet sides',
    });
  }

  copyDocumentInfo(source, out);
  steps.push('save');
  const produced = saveRewrite(out, 'buildPrintDocument');

  notes.push(note('changed', 'print.note.sheets', { sheets: plan.sheets.length, sides }));
  if (options.duplex === 'simplex') {
    notes.push(note('changed', 'print.note.simplex'));
  } else if (options.booklet) {
    notes.push(note('changed', 'print.note.booklet'));
  } else {
    notes.push(
      note('changed', options.duplex === 'long-edge' ? 'print.note.duplexLong' : 'print.note.duplexShort'),
    );
  }
  if (plan.padded > 0) notes.push(note('changed', 'print.note.padded', { count: plan.padded }));
  if (clipped > 0) notes.push(note('warning', 'print.note.actual', { count: clipped }));
  if (options.cropMarks) notes.push(note('changed', 'print.note.cropMarks'));
  notes.push(note('preserved', 'print.note.vector'));
  notes.push(note('lost', 'print.note.lost'));
  notes.push(note('preserved', 'print.note.info'));

  return {
    bytes: produced,
    report: {
      engine: 'mupdf',
      steps,
      notes,
      inputBytes: bytes.byteLength,
      outputBytes: produced.byteLength,
      pageCount: out.countPages(),
      incremental: false,
    },
  };
}
