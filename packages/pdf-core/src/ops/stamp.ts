/**
 * Stamping: header/footer, page numbers, Bates numbering and watermarks.
 *
 * A9's source defect was `/Rotate` blindness — page numbering landed sideways on
 * rotated pages. Placement here is computed in **displayed page space** (the page
 * as the user sees it, after `/Rotate`) and mapped back into unrotated user space
 * through the inverse page rotation, with the drawn glyphs rotated by `+rotation`
 * so they read horizontally on screen. `displayToUserPoint` is pure and exported,
 * which is what makes the mapping checkable without rendering a page.
 *
 * A10 gains the image watermark, the page range and a real print-exclusion flag
 * (an optional-content group whose print state is off — see `createPrintOcg`).
 *
 * Fonts: the stamp face is embedded (OFL Noto Sans), because the standard 14
 * cannot represent Turkish characters (`ş ğ ı İ`) — the source project's
 * WinAnsi assumption is why its stamps broke on Turkish text.
 *
 * How a stamp reaches the page (the MuPDF writer vocabulary, `engines/mupdf-write.ts`):
 *  - one page's stamp is **one** operator string in **one** new content stream —
 *    marked content (`BDC … EMC`) may not span streams — appended after the existing
 *    content, which is wrapped in `q`/`Q` first (`appendPageContent`), so the stamp
 *    starts in a clean graphics state;
 *  - the face, the image, the opacity state and the print group are registered under
 *    fresh names in the page's **own** `/Resources` (`addPageResource`; a page that
 *    inherited its resources gets a copy first);
 *  - text is drawn with the embedded face's glyph ids (`Tj` on a hex string; the font
 *    is Identity-H with a `/ToUnicode`), so a stamp stays extractable and searchable;
 *  - `font.heightAtSize(size)` includes the descender; `{ descender: false }` gives
 *    the ascent alone.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { type Mupdf, mapMupdfError } from '../engines/mupdf';
import {
  addPageResource,
  appendPageContent,
  arrayIn,
  dictionaryIn,
  type EmbeddedFace,
  embedNotoSans,
  openForWrite,
  pageObjects,
  text as pdfText,
  producerKeptNote,
  readText,
  resolved,
  saveRewrite,
  subsetEmbeddedFaces,
  visibleBox,
} from '../engines/mupdf-write';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

export type StampAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'center';

export interface StampTextOptions {
  readonly kind: 'header-footer';
  readonly pages: readonly number[];
  readonly anchor: StampAnchor;
  /** Template with `{page}`, `{total}`, `{date}`, `{file}` tokens. */
  readonly template: string;
  readonly startAt: number;
  readonly fontSize: number;
  readonly marginMm: number;
  readonly skipFirst: boolean;
  /** When set, page 1 uses this template instead. */
  readonly firstPageTemplate?: string;
}

export interface BatesOptions {
  readonly kind: 'bates';
  readonly pages: readonly number[];
  readonly anchor: StampAnchor;
  readonly prefix: string;
  readonly startAt: number;
  readonly digits: number;
  readonly fontSize: number;
  readonly marginMm: number;
}

export interface WatermarkOptions {
  readonly kind: 'watermark';
  readonly pages: readonly number[];
  readonly text?: string;
  readonly image?: { readonly bytes: Uint8Array; readonly name: string };
  readonly opacity: number;
  readonly rotationDegrees: number;
  readonly scale: number;
  readonly tile: boolean;
  readonly tileSpacing: number;
  readonly noPrint: boolean;
}

export type StampOptions = StampTextOptions | BatesOptions | WatermarkOptions;

const PT_PER_MM = 72 / 25.4;

/** Stamp colours: near-black page furniture, mid grey watermarks (printer friendly). */
const FURNITURE_COLOUR = 0.15;
const WATERMARK_COLOUR = 0.5;

/** The four values `/Rotate` can hold. */
type PageRotation = 0 | 90 | 180 | 270;

/**
 * Displayed page geometry: the visible box (CropBox, falling back to MediaBox —
 * that is what a reader shows), the `/Rotate` value, and the size the page has
 * once that rotation is applied.
 */
export interface PageGeometry {
  readonly rotation: PageRotation;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly display: { readonly width: number; readonly height: number };
}

/** A page dictionary's geometry: its inheritable `/Rotate` and visible box. */
export function pageGeometry(page: PDFObject): PageGeometry {
  const rotate = resolved(page.getInheritable('Rotate'));
  return geometryOf(rotate?.isNumber() === true ? rotate.asNumber() : 0, visibleBox(page));
}

/** The geometry for a `/Rotate` value (any multiple of 90, negative included) and a box. */
export function geometryOf(rotationDegrees: number, box: PageGeometry['box']): PageGeometry {
  const normalized = (((rotationDegrees % 360) + 360) % 360) as PageRotation;
  const swapped = normalized === 90 || normalized === 270;
  return {
    rotation: normalized,
    box,
    display: swapped ? { width: box.height, height: box.width } : { width: box.width, height: box.height },
  };
}

/**
 * Displayed-space point → unrotated user space for the page's rotation (the
 * inverse of the rotation a reader applies), with `W`/`H` the **unrotated** box
 * extents:
 *
 *   rotation 0:   user = (x + dx,         y + dy)
 *   rotation 90:  user = (x + W - dy,     y + dx)
 *   rotation 180: user = (x + W - dx,     y + H - dy)
 *   rotation 270: user = (x + dy,         y + H - dx)
 *
 * Forward direction, from the displayed page's lower-left corner:
 *   90° → display = (y, W - x) · 180° → (W - x, H - y) · 270° → (H - y, x)
 *
 * Exported so the rule can be checked without rendering a page.
 */
export function displayToUserPoint(
  geometry: PageGeometry,
  displayX: number,
  displayY: number,
): { readonly x: number; readonly y: number } {
  const { x, y, width, height } = geometry.box;
  switch (geometry.rotation) {
    case 90:
      return { x: x + width - displayY, y: y + displayX };
    case 180:
      return { x: x + width - displayX, y: y + height - displayY };
    case 270:
      return { x: x + displayY, y: y + height - displayX };
    default:
      return { x: x + displayX, y: y + displayY };
  }
}

/** Lower-left corner of a text/image block for an anchor, `margin` from the edges. */
function anchorBlock(
  geometry: PageGeometry,
  anchor: StampAnchor,
  blockWidth: number,
  blockHeight: number,
  margin: number,
): { readonly x: number; readonly y: number } {
  const { width, height } = geometry.display;
  const x = anchor.endsWith('left')
    ? margin
    : anchor.endsWith('right')
      ? width - margin - blockWidth
      : (width - blockWidth) / 2;
  const y = anchor.startsWith('top')
    ? height - margin - blockHeight
    : anchor.startsWith('bottom')
      ? margin
      : (height - blockHeight) / 2;
  return { x, y };
}

/**
 * Origin for content drawn in a frame rotated by `userRotationDegrees`: the frame
 * extends `alongExtent` along its own x axis and `acrossExtent` along +y, and its
 * centre sits on `centre`. Returns the operator's origin (its text/image anchor
 * point), not the block's corner.
 */
function rotatedFrameOrigin(
  centre: { readonly x: number; readonly y: number },
  userRotationDegrees: number,
  alongExtent: number,
  acrossExtent: number,
): { readonly x: number; readonly y: number } {
  const radians = (userRotationDegrees * Math.PI) / 180;
  const alongX = Math.cos(radians);
  const alongY = Math.sin(radians);
  // The perpendicular ("up" of the rotated frame) is (-sin, cos).
  return {
    x: centre.x - (alongExtent / 2) * alongX + (acrossExtent / 2) * alongY,
    y: centre.y - (alongExtent / 2) * alongY - (acrossExtent / 2) * alongX,
  };
}

/** Ascending, validated page list; the shape every stamp loop consumes. */
function orderedPages(pages: readonly number[], pageCount: number): number[] {
  if (pages.length === 0) {
    throw new ToolError('selection-empty', { engine: 'model', engineMessage: 'no pages to stamp' });
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
  return [...pages].sort((a, b) => a - b);
}

/** Rejected loudly, never silently clamped. */
function requireRange(value: number, min: number, max: number, field: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    // Its own code, not `range-invalid`: a numeric field out of bounds has nothing
    // to do with a page range, and the page-range hint ("type 1-3, 5 or 8-10")
    // told the user to fix the wrong control.
    throw new ToolError('value-out-of-range', {
      engine: 'model',
      engineMessage: `${field} must be between ${min} and ${max}`,
    });
  }
  return value;
}

/** `{page}`, `{total}`, `{date}`, `{file}`; an unknown token stays visible, never dropped. */
function resolveTemplate(
  template: string,
  tokens: { readonly page: number; readonly total: number; readonly date: string; readonly file: string },
): { readonly text: string; readonly usedEmptyFile: boolean } {
  return {
    text: template
      .replaceAll('{page}', String(tokens.page))
      .replaceAll('{total}', String(tokens.total))
      .replaceAll('{date}', tokens.date)
      .replaceAll('{file}', tokens.file),
    usedEmptyFile: template.includes('{file}') && tokens.file === '',
  };
}

/** `dd.MM.yyyy` — the device clock, fixed at stamping time (Turkish convention). */
function stampDate(now: Date): string {
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
}

/** Bates: `prefix` + the counter zero-padded to `digits`; a longer counter simply grows. */
function batesText(prefix: string, value: number, digits: number): string {
  return `${prefix}${String(value).padStart(digits, '0')}`;
}

/** Info `/Title` where present — the only file name a document carries about itself. */
function documentTitle(doc: PDFDocument): string {
  const info = resolved(doc.getTrailer().get('Info'));
  return (info === null ? '' : (readText(info.get('Title')) ?? '')).trim();
}

/** The `/ExtGState` name for a fill and stroke opacity, or `undefined` when opaque. */
function opacityState(doc: PDFDocument, page: PDFObject, opacity: number): string | undefined {
  if (opacity >= 1) return undefined;
  const state = doc.addObject({ Type: 'ExtGState', ca: opacity, CA: opacity });
  return addPageResource(doc, page, 'ExtGState', 'GS', state);
}

/**
 * The print-exclusion group (`noPrint`). Drawn page content has no annotation
 * flag to set, so print suppression is expressed the way the format provides it:
 * the mark is associated with an optional-content group whose **print state is
 * off** — the group's usage dictionary (`/Usage /Print /PrintState /OFF`), which is
 * what the default configuration's automatic state (`/D /AS`, event `/Print`,
 * category `/Print`) reads when the print event happens.
 *
 * A reader that ignores optional content entirely still prints the mark;
 * `stampDocument` reports that as a warning instead of pretending the flag is
 * universal.
 */
function createPrintOcg(doc: PDFDocument): PDFObject {
  const group = doc.addObject({
    Type: 'OCG',
    // ASCII on purpose: `/Name` is user visible, and a layer name should not depend on
    // how a reader decodes PDFDocEncoding.
    Name: pdfText(doc, 'SsPdfEditor no-print stamp'),
    Usage: { Print: { PrintState: 'OFF' } },
  });

  const catalog = doc.getTrailer().get('Root').resolve();
  if (resolved(catalog.get('OCProperties'))?.isDictionary() !== true) {
    catalog.put('OCProperties', doc.addObject({}));
  }
  const ocProperties = dictionaryIn(doc, catalog, 'OCProperties');
  arrayIn(doc, ocProperties, 'OCGs').push(group);
  const config = dictionaryIn(doc, ocProperties, 'D');
  // Visible while viewing, automatically off when the print event happens.
  arrayIn(doc, config, 'ON').push(group);
  arrayIn(doc, config, 'AS').push({ Event: 'Print', Category: ['Print'], OCGs: [group] });
  return group;
}

/** PNG/JPEG by magic bytes — the formats the dialog offers; a name would only guess. */
function imageFormat(bytes: Uint8Array, name: string): 'png' | 'jpeg' {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  throw new ToolError('unsupported', {
    engine: 'mupdf',
    engineMessage: 'watermark image must be PNG or JPEG',
    path: name,
  });
}

interface WatermarkImage {
  readonly ref: PDFObject;
  readonly width: number;
  readonly height: number;
}

/** What the run embedded once, before the pages: a picture, or the text face. */
type Drawing =
  | { readonly kind: 'image'; readonly image: WatermarkImage; readonly options: WatermarkOptions }
  | { readonly kind: 'text'; readonly font: EmbeddedFace };

/** What a stamp draws on one page: a picture, or text in the embedded face. */
type StampSubject =
  | { readonly kind: 'image'; readonly image: WatermarkImage; readonly options: WatermarkOptions }
  | {
      readonly kind: 'text';
      readonly font: EmbeddedFace;
      readonly text: string;
      readonly options: StampOptions;
    };

/** Embed a PNG or JPEG as an image XObject (alpha becomes its `/SMask`). */
function embedImage(mupdf: Mupdf, doc: PDFDocument, bytes: Uint8Array, name: string): WatermarkImage {
  imageFormat(bytes, name);
  try {
    const image = new mupdf.Image(bytes.slice());
    try {
      return { ref: doc.addImage(image), width: image.getWidth(), height: image.getHeight() };
    } finally {
      image.destroy();
    }
  } catch (error) {
    throw mapMupdfError(error, 'embed watermark image');
  }
}

/** Every watermark tile/level's centre, in displayed page space. */
function watermarkCentres(
  geometry: PageGeometry,
  tile: boolean,
  spacingMm: number,
): readonly { x: number; y: number }[] {
  if (!tile) return [{ x: geometry.display.width / 2, y: geometry.display.height / 2 }];
  const pitch = requireRange(spacingMm, 5, 500, 'tileSpacing') * PT_PER_MM;
  const columns = Math.max(1, Math.floor(geometry.display.width / pitch));
  const rows = Math.max(1, Math.floor(geometry.display.height / pitch));
  const centres: { x: number; y: number }[] = [];
  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      centres.push({
        x: (geometry.display.width * (column + 0.5)) / columns,
        y: (geometry.display.height * (row + 0.5)) / rows,
      });
    }
  }
  return centres;
}

/** A content-stream number: four decimals at most, no trailing zeros, no `-0`. */
function num(value: number): string {
  const fixed = value.toFixed(4).replace(/\.?0+$/, '');
  return fixed === '-0' ? '0' : fixed;
}

/** The rotation-and-translation matrix of a frame turned by `degrees` at `origin`. */
function frameMatrix(degrees: number, origin: { readonly x: number; readonly y: number }): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), origin.x, origin.y];
}

/**
 * One page's stamp as a single operator string (see the file header: marked content
 * may not span content streams).
 */
function pageOperators(
  doc: PDFDocument,
  page: PDFObject,
  subject: StampSubject,
  propertyKey: string | undefined,
): string {
  const geometry = pageGeometry(page);
  const operators: string[] = [];
  if (propertyKey !== undefined) operators.push(`/OC /${propertyKey} BDC`);

  if (subject.kind === 'image') {
    const { image, options } = subject;
    const width = requireRange(options.scale, 0.05, 5, 'scale') * geometry.display.width;
    const height = width * (image.height / image.width);
    const userRotation = geometry.rotation + options.rotationDegrees;
    const state = opacityState(doc, page, options.opacity);
    const xObjectKey = addPageResource(doc, page, 'XObject', 'Watermark', image.ref);
    for (const centre of watermarkCentres(geometry, options.tile, options.tileSpacing)) {
      const userCentre = displayToUserPoint(geometry, centre.x, centre.y);
      const origin = rotatedFrameOrigin(userCentre, userRotation, width, height);
      const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = frameMatrix(userRotation, origin);
      operators.push('q');
      if (state !== undefined) operators.push(`/${state} gs`);
      operators.push(
        `${num(a * width)} ${num(b * width)} ${num(c * height)} ${num(d * height)} ${num(e)} ${num(f)} cm`,
        `/${xObjectKey} Do`,
        'Q',
      );
    }
    if (propertyKey !== undefined) operators.push('EMC');
    return operators.join('\n');
  }

  const { font, text, options } = subject;

  /**
   * The size, by kind. A header/footer states its own point size; a watermark
   * states a *fraction of the page width* — the dialog's contract is "1 = as wide
   * as the page" — so the size is whatever makes the drawn text that wide, which
   * is also what the image branch does with the same word. The previous fallback
   * (`'fontSize' in options ? options.fontSize : 0`) handed every text watermark a
   * size of 0, and the 4–200 guard then refused it as out of range: no text
   * watermark could be placed at all, and the refusal read as a page-range error.
   */
  const userRotation = geometry.rotation + (options.kind === 'watermark' ? options.rotationDegrees : 0);
  const state = options.kind === 'watermark' ? opacityState(doc, page, options.opacity) : undefined;
  const widthPerPoint = font.widthOfTextAtSize(text, 1);
  const size =
    options.kind === 'watermark'
      ? (requireRange(options.scale, 0.05, 5, 'scale') * geometry.display.width) / widthPerPoint
      : requireRange(options.fontSize, 4, 200, 'fontSize');
  if (!Number.isFinite(size) || size <= 0) {
    throw new ToolError('unsupported', {
      engine: 'model',
      engineMessage: 'watermark text has no measurable width',
    });
  }
  const ascent = font.heightAtSize(size, { descender: false });
  const descent = font.heightAtSize(size) - ascent;
  const encoded = font.encode(text);
  const textWidth = font.widthOfTextAtSize(text, size);
  const fontKey = addPageResource(doc, page, 'Font', 'NS', font.ref);

  const origins: { readonly x: number; readonly y: number }[] = [];
  if (options.kind === 'watermark') {
    for (const centre of watermarkCentres(geometry, options.tile, options.tileSpacing)) {
      const userCentre = displayToUserPoint(geometry, centre.x, centre.y);
      origins.push(rotatedFrameOrigin(userCentre, userRotation, textWidth, ascent - descent));
    }
  } else {
    const margin = requireRange(options.marginMm, 0, 100, 'marginMm') * PT_PER_MM;
    const block = anchorBlock(geometry, options.anchor, textWidth, ascent + descent, margin);
    origins.push(displayToUserPoint(geometry, block.x, block.y + descent));
  }

  // Both branches supply PDF user-space origins; watermark frames were already
  // positioned around their converted centres above.
  const grey = num(options.kind === 'watermark' ? WATERMARK_COLOUR : FURNITURE_COLOUR);
  for (const userPoint of origins) {
    operators.push('q');
    if (state !== undefined) operators.push(`/${state} gs`);
    operators.push(
      'BT',
      `${grey} g`,
      `/${fontKey} ${num(size)} Tf`,
      `${frameMatrix(userRotation, userPoint).map(num).join(' ')} Tm`,
      `${encoded} Tj`,
      'ET',
      'Q',
    );
  }

  if (propertyKey !== undefined) operators.push('EMC');
  return operators.join('\n');
}

export async function stampDocument(
  bytes: Uint8Array,
  options: StampOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const { mupdf, doc } = await openForWrite(bytes);
  try {
    return await stampOpened(mupdf, doc, bytes, options, context);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw mapMupdfError(error, 'stamp');
  } finally {
    doc.destroy();
  }
}

async function stampOpened(
  mupdf: Mupdf,
  doc: PDFDocument,
  bytes: Uint8Array,
  options: StampOptions,
  context: OperationContext,
): Promise<OperationOutcome> {
  const notes: OperationNote[] = [];
  const steps: string[] = ['load'];
  const pages = pageObjects(doc);
  const total = pages.length;
  const selected = orderedPages(options.pages, total);

  if (options.kind === 'watermark') {
    if (options.text === undefined && options.image === undefined) {
      throw new ToolError('unsupported', {
        engine: 'model',
        engineMessage: 'watermark needs text or an image',
      });
    }
    if (options.text !== undefined && options.image !== undefined) {
      // Drawing one and dropping the other would be a silent loss; the dialog
      // offers a single kind, so both at once is a caller error.
      throw new ToolError('unsupported', {
        engine: 'model',
        engineMessage: 'watermark takes either text or an image, not both',
      });
    }
  }

  const stampPages =
    options.kind === 'header-footer' && options.skipFirst ? selected.filter((page) => page !== 0) : selected;
  if (stampPages.length === 0) {
    throw new ToolError('selection-empty', {
      engine: 'model',
      engineMessage: 'every selected page was skipped',
    });
  }

  if ('fontSize' in options) requireRange(options.fontSize, 4, 200, 'fontSize');
  if (options.kind !== 'watermark') requireRange(options.marginMm, 0, 100, 'marginMm');
  else requireRange(options.opacity, 0, 1, 'opacity');

  // The picture watermark is the only stamp without text: everything else needs the face.
  let drawing: Drawing;
  if (options.kind === 'watermark' && options.image !== undefined) {
    const { bytes: imageBytes, name } = options.image;
    drawing = { kind: 'image', image: embedImage(mupdf, doc, imageBytes, name), options };
    steps.push('image');
    notes.push(note('changed', 'op.note.stamp.imageEmbedded', { name }));
  } else {
    drawing = { kind: 'text', font: await embedNotoSans(mupdf, doc) };
    steps.push('font');
  }

  const printOcg = options.kind === 'watermark' && options.noPrint ? createPrintOcg(doc) : undefined;
  if (printOcg !== undefined) {
    steps.push('ocg');
    notes.push(note('warning', 'op.note.stamp.noPrint'));
  }

  const title = options.kind === 'header-footer' ? documentTitle(doc) : '';
  const date = stampDate(new Date());
  let emptyFileToken = false;
  let rotatedPages = 0;

  context.onProgress?.({ phase: 'stamp', labelKey: 'op.progress.stamp', done: 0, total: stampPages.length });

  for (const [index, pageIndex] of stampPages.entries()) {
    throwIfAborted(context.signal);
    // `orderedPages` has checked every index against the page count.
    const page = pages[pageIndex] as PDFObject;
    const geometry = pageGeometry(page);
    if (geometry.rotation !== 0) rotatedPages += 1;

    let text = '';
    if (options.kind === 'bates') {
      text = batesText(options.prefix, options.startAt + index, Math.max(1, Math.floor(options.digits)));
    } else if (options.kind === 'header-footer') {
      const template =
        options.firstPageTemplate !== undefined && pageIndex === 0
          ? options.firstPageTemplate
          : options.template;
      const filled = resolveTemplate(template, {
        // The first stamped page shows `startAt`; `{total}` is the document's page
        // count, so "Page 3 of 12" means the document, not the selection.
        page: options.startAt + index,
        total,
        date,
        file: title,
      });
      emptyFileToken ||= filled.usedEmptyFile;
      text = filled.text;
    } else {
      // The picture watermark draws no text.
      text = options.text ?? '';
    }

    if (drawing.kind === 'text' && text.trim() === '') {
      throw new ToolError('selection-empty', {
        engine: 'model',
        engineMessage: 'stamp text resolved to an empty string',
      });
    }

    const propertyKey =
      printOcg === undefined ? undefined : addPageResource(doc, page, 'Properties', 'OC', printOcg);
    const subject: StampSubject = drawing.kind === 'image' ? drawing : { ...drawing, text, options };
    appendPageContent(doc, page, pageOperators(doc, page, subject, propertyKey));
    context.onProgress?.({
      phase: 'stamp',
      labelKey: 'op.progress.stamp',
      done: index + 1,
      total: stampPages.length,
    });
  }
  steps.push('stamp');

  throwIfAborted(context.signal);
  if (drawing.kind === 'text') subsetEmbeddedFaces(mupdf, doc, [drawing.font]);
  const out = saveRewrite(doc, 'stamp');
  steps.push('save');

  notes.push(note('changed', 'op.note.stamp.drawn', { count: stampPages.length }));
  if (drawing.kind === 'text') {
    notes.push(note('changed', 'op.note.stamp.fontEmbedded', { font: drawing.font.name }));
  }
  if (rotatedPages > 0) notes.push(note('preserved', 'op.note.stamp.rotateAware', { count: rotatedPages }));
  if (options.kind === 'watermark') notes.push(note('changed', 'op.note.stamp.overContent'));
  if (emptyFileToken) notes.push(note('warning', 'op.note.stamp.fileTokenEmpty'));
  const untouched = total - stampPages.length;
  if (untouched > 0) notes.push(note('preserved', 'op.note.stamp.untouchedPages', { count: untouched }));
  notes.push(producerKeptNote());

  const report: OperationReport = {
    engine: 'mupdf',
    steps,
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: out.byteLength,
    pageCount: total,
    // Re-serialised: the incremental fast path is over.
    incremental: false,
  };
  return { bytes: out, report };
}
