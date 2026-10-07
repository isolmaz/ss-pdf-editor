/**
 * Test-only: the engine handle and the documents the unit tests of the dialog specs run on.
 *
 * `pdf-ui` does not declare MuPDF (it reaches the engine through `pdf-core`), but its dialog
 * specs run real operations over real bytes in the unit suite. The suite's setup already
 * points `pdf-core`'s loader at the installed package, so the tests ask that same loader.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createTranslator } from 'pdf-shared';
import { vi } from 'vitest';
import { loadMupdf } from '../../pdf-core/src/engines/mupdf';
import { initialParams } from './dialogs/fields';
import type {
  DialogParams,
  FieldValue,
  OperationDialogSpec,
  OpRunContext,
  OpRunResult,
} from './dialogs/types';

export const mupdfForTests = loadMupdf;

/**
 * A PDF whose page `n` shows the given lines of Helvetica 12 text from the top-left, one
 * 16-point step apart. A page without lines is blank. `size` is the `/MediaBox` extent.
 */
export async function textPdf(
  pages: readonly (readonly string[])[],
  size: readonly [number, number] = [595, 842],
): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  for (const lines of pages) {
    const content = lines
      .map((line, row) => `BT /F1 12 Tf 72 ${size[1] - 72 - row * 16} Td (${line}) Tj ET\n`)
      .join('');
    doc.insertPage(-1, doc.addPage([0, 0, size[0], size[1]], 0, { Font: { F1: font } }, content));
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** A dialog run context over `bytes`; the page count is read from the file unless given. */
export async function runContext(
  bytes: Uint8Array,
  overrides: Partial<OpRunContext> = {},
): Promise<OpRunContext> {
  const pageCount = overrides.pageCount ?? (await pageCountOf(bytes));
  return {
    signal: new AbortController().signal,
    onProgress: () => undefined,
    bytes,
    pageCount,
    name: 'doc.pdf',
    currentPage: 0,
    selectedPages: [],
    t: createTranslator('en'),
    ...overrides,
  };
}

/** Run a dialog spec the way the host does: the spec's own defaults, then the values the test sets. */
export async function runDialog(
  spec: OperationDialogSpec,
  values: Readonly<Record<string, FieldValue>>,
  bytes: Uint8Array,
  overrides: Partial<OpRunContext> = {},
): Promise<OpRunResult> {
  const params: DialogParams = { ...initialParams(spec.fields), ...values };
  return await spec.run(params, await runContext(bytes, overrides));
}

/** The page count of a produced file, read by MuPDF. */
export async function pageCountOf(bytes: Uint8Array): Promise<number> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return doc.countPages();
  } finally {
    doc.destroy();
  }
}

/** Every page's text as MuPDF extracts it. */
export async function pageTextsOf(bytes: Uint8Array): Promise<string[]> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const texts: string[] = [];
    for (let index = 0; index < doc.countPages(); index += 1) {
      texts.push(doc.loadPage(index).toStructuredText('preserve-whitespace').asText());
    }
    return texts;
  } finally {
    doc.destroy();
  }
}

const notoFile = (path: string): Uint8Array<ArrayBuffer> => {
  const require = createRequire(import.meta.url);
  return new Uint8Array(
    readFileSync(require.resolve(`@expo-google-fonts/noto-sans/${path}`, { paths: [process.cwd()] })),
  );
};

/**
 * The app serves its fonts from its own origin; in the unit suite there is none. This gives the
 * code under test an origin and answers the font requests with the very font files the app
 * ships (Noto Sans regular and semi-bold). Call `removeFontOrigin` after the test.
 */
export function useFontOrigin(): void {
  const regular = notoFile('400Regular/NotoSans_400Regular.ttf');
  const semiBold = notoFile('600SemiBold/NotoSans_600SemiBold.ttf');
  vi.stubGlobal('location', { origin: 'http://localhost' });
  vi.stubGlobal(
    'fetch',
    async (input: unknown) => new Response(String(input).includes('SemiBold') ? semiBold : regular),
  );
}

export function removeFontOrigin(): void {
  vi.unstubAllGlobals();
}

/** One outline entry as MuPDF reads it back: the title, the 0-based target page and the children. */
export interface OutlineEntry {
  readonly title: string;
  readonly page: number | null;
  readonly children: readonly OutlineEntry[];
}

/** The produced file's outline tree, read by MuPDF. */
export async function outlineOf(bytes: Uint8Array): Promise<OutlineEntry[]> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const walk = (items: ReturnType<typeof doc.loadOutline>): OutlineEntry[] =>
      (items ?? []).map((item) => ({
        title: item.title ?? '',
        page: item.page ?? null,
        children: walk(item.down ?? null),
      }));
    return walk(doc.loadOutline());
  } finally {
    doc.destroy();
  }
}

const XFA_TEMPLATE =
  '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"><subform><field name="Name"><ui><textEdit/></ui></field><field name="City"><ui><textEdit/></ui></field></subform></subform></template>';

/** The form data an `xfaFormPdf` carries: two values under `form1`. */
export const XFA_DATASETS =
  '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Name>Ada</Name><City>Ankara</City></form1></xfa:data></xfa:datasets>';

/**
 * A PDF carrying an XFA form: `static` also has AcroForm widgets (a text field `Name[0]`),
 * `dynamic` has none and asks to be rendered, `none` has no XFA at all (an empty AcroForm).
 */
export async function xfaFormPdf(kind: 'static' | 'dynamic' | 'none'): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 400, 300], 0, {}, ''));
  const page = doc.findPage(0);
  const fields = [];
  if (kind === 'static') {
    const root = doc.addObject({ T: doc.newString('form1[0]'), Kids: [] });
    const box = doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 160, 20] });
    const name = doc.addObject({
      Type: 'Annot',
      Subtype: 'Widget',
      Rect: [20, 250, 180, 270],
      P: page,
      F: 4,
      FT: 'Tx',
      T: doc.newString('Name[0]'),
      Parent: root,
      AP: { N: box },
    });
    root.get('Kids').push(name);
    page.put('Annots', [name]);
    fields.push(root);
  }
  const form = doc.addObject({ Fields: fields });
  doc.getTrailer().get('Root').put('AcroForm', form);
  if (kind !== 'none') {
    const array = doc.newArray();
    for (const [name, body] of [
      ['preamble', '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">'],
      ['template', XFA_TEMPLATE],
      ['datasets', XFA_DATASETS],
      ['postamble', '<xfa:postamble/>'],
    ] as const) {
      array.push(doc.newString(name));
      array.push(doc.addStream(body, doc.newDictionary()));
    }
    form.put('XFA', array);
  }
  if (kind === 'dynamic') doc.getTrailer().get('Root').put('NeedsRendering', true);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/**
 * What the text tool hands the text-edit dialog when the user points at block `blockIndex`
 * of page `pageIndex`: the page read by MuPDF, the model built from it, the app's fonts.
 * Needs `useFontOrigin()`.
 */
export async function textEditSelection(
  bytes: Uint8Array,
  pageIndex = 0,
  blockIndex = 0,
): Promise<NonNullable<OpRunContext['textEdit']>> {
  const { readPageText, loadTextFonts } = await import('../../pdf-core/src/text-source');
  const { buildTextPage } = await import('pdf-text-engine');
  const source = await readPageText(bytes, pageIndex, { signal: new AbortController().signal });
  const model = buildTextPage(source);
  const block = model.blocks[blockIndex];
  if (block === undefined) throw new Error(`page ${pageIndex} has no block ${blockIndex}`);
  return { pageIndex, block, model, fonts: await loadTextFonts() };
}

/** Each page's displayed `[width, height]` in points, as MuPDF reads it. */
export async function pageSizesOf(bytes: Uint8Array): Promise<[number, number][]> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const sizes: [number, number][] = [];
    for (let index = 0; index < doc.countPages(); index += 1) {
      const [x0, y0, x1, y1] = doc.loadPage(index).getBounds();
      sizes.push([Math.round(x1 - x0), Math.round(y1 - y0)]);
    }
    return sizes;
  } finally {
    doc.destroy();
  }
}

/** The links of one page: their rectangle and where they go (`uri` or `#page=n`, 1-based). */
export async function linksOf(bytes: Uint8Array, pageIndex = 0): Promise<{ rect: number[]; uri: string }[]> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return doc
      .loadPage(pageIndex)
      .getLinks()
      .map((link) => ({ rect: link.getBounds().map(Math.round), uri: link.getURI() }));
  } finally {
    doc.destroy();
  }
}

/** A solid grey PNG, `width` × `height` pixels. */
export async function pngBytes(width = 20, height = 10): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  pixmap.clear(128);
  const png = new Uint8Array(pixmap.asPNG());
  pixmap.destroy();
  return png;
}

/** A page's `/MediaBox`, `/CropBox` (or null when absent) and `/Rotate` as the file stores them. */
export async function pageBoxesOf(
  bytes: Uint8Array,
  pageIndex = 0,
): Promise<{ media: number[]; crop: number[] | null; trim: number[] | null; rotate: number }> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const page = doc.findPage(pageIndex);
    const read = (key: string): number[] | null => {
      const entry = page.getInheritable(key);
      if (!entry.isArray()) return null;
      return Array.from(
        { length: entry.length },
        (_, at) => Math.round(entry.get(at).asNumber() * 100) / 100,
      );
    };
    const rotate = page.getInheritable('Rotate');
    return {
      media: read('MediaBox') ?? [],
      crop: read('CropBox'),
      trim: read('TrimBox'),
      rotate: rotate.isNumber() ? rotate.asNumber() : 0,
    };
  } finally {
    doc.destroy();
  }
}

/** The first text line of a page as MuPDF lays it out: its text and the origin of its box (displayed space, top-left origin). */
export async function firstLineOf(
  bytes: Uint8Array,
  pageIndex = 0,
): Promise<{ text: string; x: number; y: number }> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const json = JSON.parse(doc.loadPage(pageIndex).toStructuredText('preserve-whitespace').asJSON()) as {
      blocks: { lines?: { text: string; x: number; y: number }[] }[];
    };
    const line = json.blocks.flatMap((block) => block.lines ?? [])[0];
    if (line === undefined) throw new Error(`page ${pageIndex} has no text`);
    return { text: line.text, x: line.x, y: line.y };
  } finally {
    doc.destroy();
  }
}
