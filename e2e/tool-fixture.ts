/**
 * A real, two-page PDF for the tool regressions, plus the readback the specs assert on.
 *
 * The document is assembled byte by byte for the same reason `fixture-pdf.ts` is:
 * `mupdf` and `pdfjs-dist` are dependencies of the `packages/*` workspaces, not of the
 * repository root, so a test that needs a document must either write one or reach the
 * engines through the workspace that declares them. Both happen here — the fixture is
 * hand-built (objects, a computed cross-reference table, a trailer), and the readback
 * resolves `mupdf` and `pdfjs-dist` through `packages/pdf-core`, which declares both,
 * so the assertion reads the produced file the way a reader would instead of echoing
 * application state.
 *
 * What the document carries, and why each piece exists:
 *
 *  - **Four text lines on page 1 and one on page 2** — real glyph runs, so "the page's
 *    own text survived" is checkable by extracting text from the bytes, and so a tool
 *    gesture has text to select.
 *  - **Saved annotations of mixed subtypes** (`/Highlight`, two `/Ink`, a `/FreeText`
 *    note) — the file's own marks, spread over separate bands so a marquee can take
 *    exactly the ones a case means and nothing else.
 *  - **A `/Widget` text field with a value** — the form half of "original content and
 *    forms are intact", and a press target that must never be consumed by a mark tool.
 *  - **An internal `/Link` (a `/Dest` to page 2, no `/URI`)** — a link inside the saved
 *    highlight's rectangle, so "selecting a mark that coincides with a link selects the
 *    mark without navigating" and "the hand tool still navigates" are both reachable
 *    without a network request.
 *
 * All coordinates are page points in PDF user space (origin bottom-left) on a
 * `595 × 842` media box whose origin is zero, which is what lets a spec map a stored
 * coordinate onto the page element's own box and zoom.
 */

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The page box every coordinate in this file is measured in. */
export const FIXTURE_PAGE = { width: 595, height: 842 } as const;

/** Page 1's text runs, by baseline. The words are the spec's own landmarks. */
export const PAGE_ONE_LINES = [
  { text: 'Fixture line one reads clearly', baseline: 770 },
  { text: 'Second line under the saved ink', baseline: 700 },
  { text: 'Third line stays untouched', baseline: 640 },
  { text: 'Fourth line for redaction marks', baseline: 580 },
] as const;

/** Page 2's single line: the anchor the text checks read on the second page. */
export const PAGE_TWO_LINE = { text: 'Second page anchor line', baseline: 770 } as const;

/**
 * The annotations the file already carries, in PDF user space.
 *
 * `rect` is what the shell hit-tests an existing annotation by, so each rectangle is
 * the mark's own painted area rather than a loose box around it. The two ink strokes
 * are horizontal lines on their own baseline (700), which is what makes a turn of one
 * of them readable in the produced bytes: a 90° turn about its own centre has to come
 * back as a vertical stroke through the same centre, not as a swapped `/Rect`.
 */
export const SAVED_MARKS = {
  /** Over line one; the link below shares its rectangle. */
  highlight: { contents: 'Saved highlight over line one', rect: [72, 764, 320, 782] },
  /** The file's own left stroke, on the 700 baseline. */
  inkLeft: { contents: 'Saved ink left', rect: [72, 690, 288, 710], stroke: [72, 700, 288, 700] },
  /** The file's own right stroke, on the same baseline. */
  inkRight: { contents: 'Saved ink right', rect: [312, 690, 528, 710], stroke: [312, 700, 528, 700] },
  /** A source note on the right, well away from every gesture band. */
  sourceNote: { contents: 'Saved source note body', rect: [400, 560, 560, 600] },
} as const;

/** The form field page 1 carries, and the value it already holds. */
export const FORM_FIELD = { name: 'customer', value: 'Grace Hopper', rect: [72, 460, 300, 482] } as const;

/** The link annotation: page 1's highlight rectangle, going to page 2. No `/URI`. */
export const INTERNAL_LINK = { rect: [72, 764, 320, 782], targetPageIndex: 1 } as const;

/** Object numbers, in the order `toolFixturePdf` emits them (1-based, as the xref says). */
const OBJECTS = {
  catalog: 1,
  pages: 2,
  pageOne: 3,
  pageOneContents: 4,
  font: 5,
  info: 6,
  highlight: 7,
  inkLeft: 8,
  inkRight: 9,
  sourceNote: 10,
  widget: 11,
  acroForm: 12,
  pageTwo: 13,
  pageTwoContents: 14,
  pageTwoHighlight: 15,
  link: 16,
} as const;

/** A quad run for a text-line highlight: upper-left, upper-right, lower-left, lower-right. */
function quadPoints(rect: readonly [number, number, number, number]): string {
  const [x0, y0, x1, y1] = rect;
  return `${x0} ${y1} ${x1} ${y1} ${x0} ${y0} ${x1} ${y0}`;
}

/** A content stream object, its `/Length` the exact byte count of the ASCII payload. */
function stream(content: string): string {
  return `<< /Length ${content.length} >>\nstream\n${content}endstream`;
}

/**
 * Assemble objects, their cross-reference table and a trailer, exactly as a writer
 * would. All content is ASCII, so one character is one byte and the offsets are real.
 */
function buildPdf(bodies: readonly string[]): Uint8Array {
  const chunks: string[] = ['%PDF-1.7\n'];
  const offsets: number[] = [];
  let offset = (chunks[0] ?? '').length;
  for (const [index, body] of bodies.entries()) {
    offsets.push(offset);
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    offset += chunk.length;
  }

  // Every xref entry is exactly 20 bytes: 10-digit offset, generation, in-use flag, EOL.
  const xref = [
    'xref\n',
    `0 ${bodies.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`),
  ].join('');
  const trailer = `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${offset}\n%%EOF\n`;

  const source = chunks.join('') + xref + trailer;
  return new Uint8Array([...source].map((character) => character.charCodeAt(0)));
}

/** The fixture document. A fresh array each call, so a test may hand it out twice. */
export function toolFixturePdf(): Uint8Array {
  const pageOneContent = PAGE_ONE_LINES.map(
    (line) => `BT /F1 12 Tf 1 0 0 1 72 ${line.baseline} Tm (${line.text}) Tj ET\n`,
  ).join('');
  const pageTwoContent = `BT /F1 12 Tf 1 0 0 1 72 ${PAGE_TWO_LINE.baseline} Tm (${PAGE_TWO_LINE.text}) Tj ET\n`;
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  const bodies: string[] = [];
  bodies[OBJECTS.catalog - 1] =
    `<< /Type /Catalog /Pages ${OBJECTS.pages} 0 R /AcroForm ${OBJECTS.acroForm} 0 R >>`;
  bodies[OBJECTS.pages - 1] =
    `<< /Type /Pages /Kids [${OBJECTS.pageOne} 0 R ${OBJECTS.pageTwo} 0 R] /Count 2 >>`;
  bodies[OBJECTS.pageOne - 1] =
    `<< /Type /Page /Parent ${OBJECTS.pages} 0 R /MediaBox [0 0 ${FIXTURE_PAGE.width} ${FIXTURE_PAGE.height}] ` +
    `/Resources << /Font << /F1 ${OBJECTS.font} 0 R >> >> /Contents ${OBJECTS.pageOneContents} 0 R ` +
    `/Annots [${OBJECTS.highlight} 0 R ${OBJECTS.inkLeft} 0 R ${OBJECTS.inkRight} 0 R ` +
    `${OBJECTS.sourceNote} 0 R ${OBJECTS.widget} 0 R ${OBJECTS.link} 0 R] >>`;
  bodies[OBJECTS.pageOneContents - 1] = stream(pageOneContent);
  bodies[OBJECTS.font - 1] = font;
  bodies[OBJECTS.info - 1] = '<< /Title (tool-interaction fixture) /Producer (pdf-editor e2e) >>';
  bodies[OBJECTS.highlight - 1] =
    `<< /Type /Annot /Subtype /Highlight /Rect [${SAVED_MARKS.highlight.rect.join(' ')}] ` +
    `/QuadPoints [${quadPoints(SAVED_MARKS.highlight.rect)}] /C [1 0.85 0.2] /CA 0.6 /F 4 ` +
    `/Contents (${SAVED_MARKS.highlight.contents}) >>`;
  bodies[OBJECTS.inkLeft - 1] =
    `<< /Type /Annot /Subtype /Ink /Rect [${SAVED_MARKS.inkLeft.rect.join(' ')}] ` +
    `/InkList [[${SAVED_MARKS.inkLeft.stroke.join(' ')}]] /C [0.15 0.25 0.85] /BS << /W 6 >> /F 4 ` +
    `/Contents (${SAVED_MARKS.inkLeft.contents}) >>`;
  bodies[OBJECTS.inkRight - 1] =
    `<< /Type /Annot /Subtype /Ink /Rect [${SAVED_MARKS.inkRight.rect.join(' ')}] ` +
    `/InkList [[${SAVED_MARKS.inkRight.stroke.join(' ')}]] /C [0.85 0.25 0.15] /BS << /W 6 >> /F 4 ` +
    `/Contents (${SAVED_MARKS.inkRight.contents}) >>`;
  bodies[OBJECTS.sourceNote - 1] =
    `<< /Type /Annot /Subtype /FreeText /Rect [${SAVED_MARKS.sourceNote.rect.join(' ')}] ` +
    `/Contents (${SAVED_MARKS.sourceNote.contents}) /DA (/F1 10 Tf 0 g) /C [1 1 0.85] /F 4 >>`;
  bodies[OBJECTS.widget - 1] =
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (${FORM_FIELD.name}) /V (${FORM_FIELD.value}) ` +
    `/Rect [${FORM_FIELD.rect.join(' ')}] /DA (/F1 12 Tf 0 g) /F 4 /P ${OBJECTS.pageOne} 0 R >>`;
  bodies[OBJECTS.acroForm - 1] =
    `<< /Fields [${OBJECTS.widget} 0 R] /DA (/F1 12 Tf 0 g) /DR << /Font << /F1 ${OBJECTS.font} 0 R >> >> >>`;
  bodies[OBJECTS.pageTwo - 1] =
    `<< /Type /Page /Parent ${OBJECTS.pages} 0 R /MediaBox [0 0 ${FIXTURE_PAGE.width} ${FIXTURE_PAGE.height}] ` +
    `/Resources << /Font << /F1 ${OBJECTS.font} 0 R >> >> /Contents ${OBJECTS.pageTwoContents} 0 R ` +
    `/Annots [${OBJECTS.pageTwoHighlight} 0 R] >>`;
  bodies[OBJECTS.pageTwoContents - 1] = stream(pageTwoContent);
  bodies[OBJECTS.pageTwoHighlight - 1] =
    `<< /Type /Annot /Subtype /Highlight /Rect [${SAVED_MARKS.highlight.rect.join(' ')}] ` +
    `/QuadPoints [${quadPoints(SAVED_MARKS.highlight.rect)}] /C [0.2 0.8 0.3] /CA 0.6 /F 4 ` +
    '/Contents (Second page highlight) >>';
  bodies[OBJECTS.link - 1] =
    `<< /Type /Annot /Subtype /Link /Rect [${INTERNAL_LINK.rect.join(' ')}] /Border [0 0 0] /F 4 ` +
    `/Dest [${OBJECTS.pageTwo} 0 R /Fit] >>`;

  return buildPdf(bodies);
}

// ---------------------------------------------------------------------------
// readback: the produced file, read with the engines the workspaces declare
// ---------------------------------------------------------------------------

/**
 * `packages/pdf-core` declares both `mupdf` (the writer's engine) and `pdfjs-dist` (the
 * reader's), and the repository root deliberately declares neither — so the require
 * context of that workspace's manifest is what makes them resolvable here.
 */
const coreRequire = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url));

/** Where the vendored standard-font data lives; pdf.js needs it to read base-14 text. */
const STANDARD_FONTS = fileURLToPath(
  new URL('../public/engines/pdfjs/standard_fonts/', import.meta.url),
).replaceAll('\\', '/');

/** The slice of a MuPDF object this readback walks (the root does not declare `mupdf`). */
interface PdfObjectLike {
  isNull(): boolean;
  isString(): boolean;
  isName(): boolean;
  isNumber(): boolean;
  isArray(): boolean;
  asString(): string;
  asName(): string;
  asNumber(): number;
  resolve(): PdfObjectLike;
  get(...path: (string | number)[]): PdfObjectLike;
  readonly length: number;
  toString(): string;
}
interface PdfDocumentLike {
  countPages(): number;
  findPage(index: number): PdfObjectLike;
  getTrailer(): PdfObjectLike;
  getMetaData(key: string): string | undefined;
  destroy(): void;
}
interface MupdfLike {
  PDFDocument: {
    openDocument(bytes: Uint8Array, magic: string): { asPDF(): PdfDocumentLike | null };
  };
}

/** A PDF name without its slash; `''` when the value is not a name. */
function nameOf(value: PdfObjectLike): string {
  if (value.isNull()) return '';
  const target = value.resolve();
  return target.isName() ? target.asName() : '';
}

/** A PDF string's text (hex strings decode the same way); `''` when not a string. */
function textOf(value: PdfObjectLike): string {
  if (value.isNull()) return '';
  const target = value.resolve();
  return target.isString() ? target.asString() : '';
}

/** A PDF number's value, or `null` when the entry is absent or not a number. */
function numberOf(value: PdfObjectLike): number | null {
  if (value.isNull()) return null;
  const target = value.resolve();
  return target.isNumber() ? target.asNumber() : null;
}

/** A flat number run (`/Rect`, `/C`), read entry by entry. */
function numbersOf(value: PdfObjectLike): number[] {
  if (value.isNull()) return [];
  const array = value.resolve();
  if (!array.isArray()) return [];
  const numbers: number[] = [];
  for (let index = 0; index < array.length; index += 1) {
    const entry = numberOf(array.get(index));
    if (entry !== null) numbers.push(entry);
  }
  return numbers;
}

/** Every entry of an array of arrays (`/InkList`), each read as a flat number run. */
function runsOf(value: PdfObjectLike): number[][] {
  if (value.isNull()) return [];
  const array = value.resolve();
  if (!array.isArray()) return [];
  const runs: number[][] = [];
  for (let index = 0; index < array.length; index += 1) runs.push(numbersOf(array.get(index)));
  return runs;
}

/** One annotation of the produced file, as a reader sees it. */
export interface ProducedAnnotation {
  readonly pageIndex: number;
  readonly subtype: string;
  readonly contents: string;
  /** The field name a `/Widget` carries, so a form field is not mistaken for a mark. */
  readonly fieldName: string | null;
  readonly rect: readonly number[];
  /** A text-markup annotation's `/QuadPoints`: its boxes' own corners, as the file holds them. */
  readonly quadPoints: readonly number[];
  /** A drawn stroke's `/InkList`: one flat `[x, y, …]` run per stroke. */
  readonly inkLists: readonly (readonly number[])[];
  /** The stroke's dash entry (`/BS /D`: the pattern and its phase); empty when solid. */
  readonly dashPattern: readonly number[];
  readonly color: readonly number[];
  readonly borderWidth: number | null;
  /** The `/Dest` a `/Link` carries, as the file spells it, for the internal-destination fixture. */
  readonly destPageRef: string | null;
}

export interface ProducedPdf {
  readonly pageCount: number;
  readonly annotations: readonly ProducedAnnotation[];
  readonly formValue: string | null;
  /** The Info title and producer, as an independent parser reads them. */
  readonly title: string | null;
  readonly producer: string | null;
  /** The keys of `/Root /Names /EmbeddedFiles /Names`, in file order. */
  readonly attachmentNames: readonly string[];
  /** Top-level outline titles, following `/First` → `/Next`. */
  readonly outlineTitles: readonly string[];
}

/**
 * The share of pixels (0–1) that are not white inside `rect` (PDF user space, an unturned
 * page whose box starts at the origin) when MuPDF paints page `pageIndex` with its
 * annotations — what another reader shows, not what the file merely declares. An
 * annotation whose appearance draws nothing scores 0.
 */
export async function inkWithin(
  bytes: Uint8Array,
  pageIndex: number,
  rect: readonly [number, number, number, number],
): Promise<number> {
  interface Pixmap {
    getWidth(): number;
    getHeight(): number;
    getNumberOfComponents(): number;
    getPixels(): Uint8ClampedArray;
  }
  interface RenderModule {
    readonly Matrix: { readonly identity: unknown };
    readonly ColorSpace: { readonly DeviceRGB: unknown };
    readonly Document: {
      openDocument(
        bytes: Uint8Array,
        magic: string,
      ): {
        loadPage(index: number): {
          toPixmap(matrix: unknown, space: unknown, alpha: boolean, annots: boolean): Pixmap;
        };
        destroy(): void;
      };
    };
  }
  // The root does not declare `mupdf`; it is resolved from the workspace that does.
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as RenderModule;
  const doc = mupdf.Document.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pixmap = doc
      .loadPage(pageIndex)
      .toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const stride = pixmap.getNumberOfComponents();
    const pixels = pixmap.getPixels();
    const [x0, y0, x1, y1] = rect;
    let inked = 0;
    let total = 0;
    for (let y = Math.max(0, Math.floor(height - y1)); y < Math.min(height, Math.ceil(height - y0)); y += 1) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x += 1) {
        const at = (y * width + x) * stride;
        total += 1;
        if ((pixels[at] ?? 255) < 235 || (pixels[at + 1] ?? 255) < 235 || (pixels[at + 2] ?? 255) < 235)
          inked += 1;
      }
    }
    return total === 0 ? 0 : inked / total;
  } finally {
    doc.destroy();
  }
}

/**
 * Read the produced bytes with MuPDF's object model: every page's annotations by
 * subtype, the field name a widget carries, the form value the field still holds, the
 * Info title and producer, the embedded-file names and the top-level outline titles.
 */
export async function readProducedPdf(bytes: Uint8Array): Promise<ProducedPdf> {
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as MupdfLike;
  // A copy: the caller's array may be asserted on again.
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('the produced file is not a PDF');
  try {
    const annotations: ProducedAnnotation[] = [];
    const pageCount = doc.countPages();
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const entry = doc.findPage(pageIndex).get('Annots');
      if (entry.isNull()) continue;
      const array = entry.resolve();
      for (let at = 0; at < array.length; at += 1) {
        const dict = array.get(at).resolve();
        const borderStyle = dict.get('BS');
        const dest = dict.get('Dest');
        annotations.push({
          pageIndex,
          subtype: nameOf(dict.get('Subtype')),
          contents: textOf(dict.get('Contents')),
          fieldName: textOf(dict.get('T')) || null,
          rect: numbersOf(dict.get('Rect')),
          quadPoints: numbersOf(dict.get('QuadPoints')),
          inkLists: runsOf(dict.get('InkList')),
          dashPattern: borderStyle.isNull() ? [] : numbersOf(borderStyle.resolve().get('D')),
          color: numbersOf(dict.get('C')),
          borderWidth: borderStyle.isNull() ? null : numberOf(borderStyle.resolve().get('W')),
          destPageRef: dest.isNull() ? null : dest.toString(),
        });
      }
    }

    // The value lives on the field object the `/AcroForm` lists, whatever shape the
    // writer gave the file: `AcroForm` and `Fields[0]` may both be indirect.
    const root = doc.getTrailer().get('Root');
    const fields = root.get('AcroForm', 'Fields');
    const value = fields.isNull() || fields.length === 0 ? '' : textOf(fields.get(0).resolve().get('V'));

    const pairs = root.get('Names', 'EmbeddedFiles', 'Names');
    const attachmentNames: string[] = [];
    for (let index = 0; !pairs.isNull() && index + 1 < pairs.length; index += 2) {
      attachmentNames.push(textOf(pairs.get(index)));
    }

    const outlineTitles: string[] = [];
    let item = root.get('Outlines', 'First');
    // Bounded: a cyclic chain in a produced file must fail the assertion, not hang the run.
    for (let guard = 0; !item.isNull() && guard < 1000; guard += 1) {
      const node = item.resolve();
      outlineTitles.push(textOf(node.get('Title')));
      item = node.get('Next');
    }

    return {
      pageCount,
      annotations,
      formValue: value === '' ? null : value,
      title: doc.getMetaData('info:Title') || null,
      producer: doc.getMetaData('info:Producer') || null,
      attachmentNames,
      outlineTitles,
    };
  } finally {
    doc.destroy();
  }
}

/**
 * Every page's extracted text, read from the bytes with `pdf.js` — the reader's own
 * answer to "is the page's text still there", not the application's.
 */
export async function readProducedPageTexts(
  bytes: Uint8Array,
  firstPages = Number.POSITIVE_INFINITY,
): Promise<readonly string[]> {
  const pdfjsPath = coreRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = (await import(pathToFileURL(pdfjsPath).href)) as {
    getDocument(options: Record<string, unknown>): { promise: Promise<PdfJsDocument> };
  };
  interface PdfJsTextItem {
    readonly str: string;
  }
  interface PdfJsPage {
    getTextContent(): Promise<{ readonly items: readonly PdfJsTextItem[] }>;
  }
  interface PdfJsDocument {
    readonly numPages: number;
    getPage(index: number): Promise<PdfJsPage>;
    cleanup(): Promise<void>;
  }

  const document = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    // pdf.js wants a URL *prefix*, trailing separator included.
    standardFontDataUrl: STANDARD_FONTS,
  }).promise;
  const pages: string[] = [];
  for (let index = 1; index <= Math.min(document.numPages, firstPages); index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(' '));
  }
  await document.cleanup();
  return pages;
}

/**
 * The same fixture, **encrypted** with AES-256 and an open password — by the pinned MuPDF
 * the application ships, so the file is one the product itself could have written.
 */
export async function encryptedToolFixturePdf(
  password: string,
  openPassword: string = password,
): Promise<Uint8Array> {
  interface MupdfBuffer {
    asUint8Array(): Uint8Array;
    destroy(): void;
  }
  interface MupdfModule {
    readonly Document: {
      openDocument(
        bytes: Uint8Array,
        magic: string,
      ): { asPDF(): { saveToBuffer(options: string): MupdfBuffer } };
    };
  }
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as MupdfModule;
  const pdf = mupdf.Document.openDocument(toolFixturePdf(), 'application/pdf').asPDF();
  const buffer = pdf.saveToBuffer(
    `encrypt=aes-256,user-password=${openPassword},owner-password=${password}-owner`,
  );
  try {
    return new Uint8Array(buffer.asUint8Array());
  } finally {
    buffer.destroy();
  }
}

/** The same fixture with an Info `/Author` (and `/Subject`) set by the pinned MuPDF: metadata to remove or show. */
export async function authoredToolFixturePdf(author: string, subject: string): Promise<Uint8Array> {
  interface MupdfBuffer {
    asUint8Array(): Uint8Array;
    destroy(): void;
  }
  interface MupdfModule {
    readonly Document: {
      openDocument(
        bytes: Uint8Array,
        magic: string,
      ): {
        asPDF(): {
          setMetaData(key: string, value: string): void;
          saveToBuffer(options: string): MupdfBuffer;
        };
      };
    };
  }
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as MupdfModule;
  const pdf = mupdf.Document.openDocument(toolFixturePdf(), 'application/pdf').asPDF();
  pdf.setMetaData('info:Author', author);
  pdf.setMetaData('info:Subject', subject);
  const buffer = pdf.saveToBuffer('');
  try {
    return new Uint8Array(buffer.asUint8Array());
  } finally {
    buffer.destroy();
  }
}

/**
 * One object of the produced file, printed by MuPDF: a page's dictionary entry (`page` is
 * the 0-based index), an entry below the catalogue (`null`) or of the trailer (`'trailer'`). `''` when absent.
 * Direct values print as the file spells them (`[ 10 20 310 420 ]`), so a spec can match a
 * page box or a label tree without a parser of its own.
 */
export async function readProducedEntry(
  bytes: Uint8Array,
  page: number | 'trailer' | null,
  ...path: (string | number)[]
): Promise<string> {
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as MupdfLike;
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('the produced file is not a PDF');
  try {
    const root =
      page === 'trailer'
        ? doc.getTrailer()
        : page === null
          ? doc.getTrailer().get('Root')
          : doc.findPage(page);
    const entry = root.get(...path);
    return entry.isNull() ? '' : entry.resolve().toString();
  } finally {
    doc.destroy();
  }
}

/**
 * An N-page PDF whose every page carries one line of text, `<label> <number>`, so the
 * order of a produced file is readable from its text. Built byte by byte like the fixture
 * above: ASCII only, a computed cross-reference table.
 *
 * `rotations` gives page `i` its own `/Rotate` (a page the file already turns is the case
 * a viewer gets wrong), `size` its `/MediaBox`; the text sits near the top-left corner of
 * the unturned page either way, so a turned page's orientation is readable from it.
 */
export function labelledPdf(
  label: string,
  pages: number,
  options: { readonly rotations?: readonly number[]; readonly size?: readonly [number, number] } = {},
): Uint8Array {
  const [width, height] = options.size ?? [595, 842];
  const bodies: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids: number[] = [];
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let index = 0; index < pages; index += 1) {
    const content = `BT /F1 24 Tf 72 ${height - 142} Td (${label} ${index + 1}) Tj ET\n`;
    const rotate = options.rotations?.[index] ?? 0;
    kids.push(bodies.length + 1);
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}]${rotate === 0 ? '' : ` /Rotate ${rotate}`} /Resources << /Font << /F1 3 0 R >> >> /Contents ${bodies.length + 2} 0 R >>`,
    );
    bodies.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  bodies[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages} >>`;

  let source = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${xref}`;
  source += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${source.indexOf('xref\n')}\n%%EOF\n`;
  return new Uint8Array([...source].map((character) => character.charCodeAt(0)));
}

/**
 * A one-page document carrying a sticky note (`/Text`, icon "Note") of its own, written by
 * the pinned MuPDF: the annotation every reader draws with an icon.
 */
export async function textNotePdf(contents: string): Promise<Uint8Array> {
  interface MupdfBuffer {
    asUint8Array(): Uint8Array;
    destroy(): void;
  }
  interface NoteModule {
    readonly PDFDocument: {
      openDocument(
        bytes: Uint8Array,
        magic: string,
      ): {
        loadPage(index: number): {
          createAnnotation(type: string): {
            setRect(rect: readonly number[]): void;
            setContents(text: string): void;
            setIcon(name: string): void;
            update(): void;
          };
        };
        saveToBuffer(options: string): MupdfBuffer;
        destroy(): void;
      };
    };
  }
  // The root does not declare `mupdf`; it is resolved from the workspace that does.
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as NoteModule;
  const doc = mupdf.PDFDocument.openDocument(labelledPdf('Noted', 1), 'application/pdf');
  try {
    const note = doc.loadPage(0).createAnnotation('Text');
    note.setRect([400, 600, 420, 620]);
    note.setContents(contents);
    note.setIcon('Note');
    note.update();
    const buffer = doc.saveToBuffer('');
    try {
      return new Uint8Array(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  } finally {
    doc.destroy();
  }
}

/**
 * An image-only PDF — a scan: no text layer at all. Every page shows the given printed
 * lines, large and black on white. The page is first typeset as a text PDF, rasterised by
 * the pinned MuPDF, and only the picture is embedded in the result, so the only way words
 * can later be found on a page is by recognising the picture.
 */
export async function scannedPdf(pageLines: readonly (readonly string[])[]): Promise<Uint8Array> {
  interface MupdfPixmap {
    asPNG(): Uint8Array;
    destroy(): void;
  }
  interface MupdfObject {
    destroy(): void;
  }
  interface MupdfBuffer {
    asUint8Array(): Uint8Array;
    destroy(): void;
  }
  interface ScanModule {
    readonly Matrix: { scale(x: number, y: number): unknown };
    readonly ColorSpace: { readonly DeviceGray: unknown };
    readonly Image: new (data: Uint8Array) => unknown;
    readonly Document: {
      openDocument(
        bytes: Uint8Array,
        magic: string,
      ): {
        loadPage(index: number): {
          toPixmap(matrix: unknown, space: unknown, alpha: boolean, annots: boolean): MupdfPixmap;
        };
        destroy(): void;
      };
    };
    readonly PDFDocument: new () => {
      addImage(image: unknown): MupdfObject;
      addPage(mediabox: number[], rotate: number, resources: unknown, contents: string): MupdfObject;
      insertPage(at: number, page: MupdfObject): void;
      saveToBuffer(options: string): MupdfBuffer;
      destroy(): void;
    };
  }
  const width = 595;
  const height = 842;
  const scale = 3;
  const bodies: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids: number[] = [];
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  for (const lines of pageLines) {
    const content = lines
      .map((line, row) => `BT /F1 40 Tf 60 ${height - 120 - row * 90} Td (${line}) Tj ET\n`)
      .join('');
    kids.push(bodies.length + 1);
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${bodies.length + 2} 0 R >>`,
    );
    bodies.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  bodies[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageLines.length} >>`;
  let source = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${xref}`;
  source += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${source.indexOf('xref\n')}\n%%EOF\n`;
  const typeset = new Uint8Array([...source].map((character) => character.charCodeAt(0)));

  // The root does not declare `mupdf`; it is resolved from the workspace that does.
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as ScanModule;
  const text = mupdf.Document.openDocument(typeset, 'application/pdf');
  const scan = new mupdf.PDFDocument();
  try {
    for (let index = 0; index < pageLines.length; index += 1) {
      const pixmap = text
        .loadPage(index)
        .toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceGray, false, false);
      const image = scan.addImage(new mupdf.Image(pixmap.asPNG()));
      pixmap.destroy();
      const page = scan.addPage(
        [0, 0, width, height],
        0,
        { XObject: { Im0: image } },
        `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`,
      );
      scan.insertPage(-1, page);
    }
    const saved = scan.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    return bytes;
  } finally {
    scan.destroy();
    text.destroy();
  }
}
