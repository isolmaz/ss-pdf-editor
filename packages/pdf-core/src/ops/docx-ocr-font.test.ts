/**
 * The open family of a rebuilt scan: the words OCR read are drawn again in every family the app
 * ships and in the stand-ins, and a scan clearly set in an open family is set in it by name, its
 * own advances placing the letters, with the package carrying the faces the runs use
 * (`fontTable.xml`, obfuscated `.odttf` files) so Word and LibreOffice draw them. A Helvetica or
 * Times scan keeps its stand-in and embeds nothing; offline the stand-ins stay. The scans are
 * synthetic: sentences drawn by MuPDF in a real font, with noise (`ocr-font-match.fixtures.ts`).
 * The fonts come through the app's own loader (`ocr-font-catalog.ts`), here a stubbed `fetch`
 * serving the files of `public/fonts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import JSZip from 'jszip';
import type { Font } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf, type Mupdf, openPdf } from '../engines/mupdf';
import type { OcrWord } from '../engines/tesseract';
import { embedFonts, obfuscateFont, provideStandardMetrics } from './docx-fonts';
import { chooseOpenFont, type OpenFont, ocrAdvance, openFontFiles } from './docx-ocr-font';
import { exportOffice } from './export-office';
import type { TextBox, TextRun } from './layout-scene';
import { renderScan, type Scan } from './ocr-font-match.fixtures';
import type { MeasuredWord } from './ocr-scene';
import type { OperationContext } from './types';

// Every case draws the words in eleven faces: seconds on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

const run: OperationContext = { signal: new AbortController().signal };
const publicFile = (path: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../../public${path}`, import.meta.url)));

/** Serves the shipped fonts to the app's loader, as the origin would; a file the app does not ship is a 404. */
function serveFonts(): void {
  vi.stubGlobal('fetch', async (url: string) =>
    existsSync(new URL(`../../../../public${url}`, import.meta.url))
      ? new Response(publicFile(url).slice(), { status: 200 })
      : new Response(null, { status: 404 }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A scan of the sentences set in `family`, and the words the way `ocrTextBoxes` reports them. */
async function scanIn(family: 'Inter' | 'Helvetica' | 'Times-Roman'): Promise<{
  mupdf: Mupdf;
  scan: Scan;
  measured: MeasuredWord[];
}> {
  const mupdf = await loadMupdf();
  const font: Font =
    family === 'Inter'
      ? new mupdf.Font('Inter-Regular', publicFile('/fonts/inter/Inter-Regular.ttf'))
      : new mupdf.Font(family);
  const scan = renderScan(mupdf, font, { dpi: 200, size: 11, amplitude: 20 });
  return { mupdf, scan, measured: scan.words.map((word) => ({ ...word, confidence: 98 })) };
}

describe('the open family of a scan', () => {
  it('is Inter for a scan set in it, with the faces the family has', async () => {
    serveFonts();
    const { mupdf, scan, measured } = await scanIn('Inter');
    const open = (await chooseOpenFont(mupdf, scan.image, measured)) as OpenFont;
    expect(open.name).toBe('Inter');
    expect(open.bold).toBeDefined();
    expect(open.italic).toBeDefined();
    expect(open.boldItalic).toBeDefined();
  });

  it('is none for a Helvetica scan or a Times scan: the stand-ins stay', async () => {
    serveFonts();
    for (const family of ['Helvetica', 'Times-Roman'] as const) {
      const { mupdf, scan, measured } = await scanIn(family);
      expect(await chooseOpenFont(mupdf, scan.image, measured)).toBeNull();
    }
  });

  it('judges only the words OCR is sure of', async () => {
    serveFonts();
    const { mupdf, scan, measured } = await scanIn('Inter');
    // every word unsure: nothing to draw, every family scores 0, no family is ahead
    expect(
      await chooseOpenFont(
        mupdf,
        scan.image,
        measured.map((word) => ({ ...word, confidence: 50 })),
      ),
    ).toBeNull();
  });

  it('is none offline or without the files: the stand-ins stay', async () => {
    // a fresh module: the loader keeps what it fetched
    vi.resetModules();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    const fresh = await import('./docx-ocr-font');
    const { mupdf, scan, measured } = await scanIn('Inter');
    expect(await fresh.chooseOpenFont(mupdf, scan.image, measured)).toBeNull();
  });

  it('keeps the family whose regular loads when the others are missing, and the faces it has', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', async (url: string) =>
      url === '/fonts/inter/Inter-Regular.ttf'
        ? new Response(publicFile(url).slice(), { status: 200 })
        : new Response(null, { status: 404 }),
    );
    const fresh = await import('./docx-ocr-font');
    const { mupdf, scan, measured } = await scanIn('Inter');
    const open = (await fresh.chooseOpenFont(mupdf, scan.image, measured)) as OpenFont;
    expect(open.name).toBe('Inter');
    expect(open.bold).toBeUndefined();
    expect(open.italic).toBeUndefined();
    expect(open.boldItalic).toBeUndefined();
  });
});

describe('the advances of the open family', () => {
  it("are the faces' own, the stand-ins' own for Arial, nothing for a glyph the face lacks", async () => {
    serveFonts();
    const { mupdf, scan, measured } = await scanIn('Inter');
    provideStandardMetrics(mupdf);
    const open = (await chooseOpenFont(mupdf, scan.image, measured)) as OpenFont;
    const advance = ocrAdvance(open);
    const regular = advance('Inter', false, false, 0x6d) as number;
    const bold = advance('Inter', true, false, 0x6d) as number;
    expect(regular).toBeGreaterThan(0.8);
    expect(bold).toBeGreaterThan(regular);
    expect(advance('Inter', false, true, 0x6d)).toBeCloseTo(regular, 1);
    expect(advance('Inter', true, true, 0x6d)).toBeGreaterThan(regular);
    expect(advance('Inter', false, false, 0x65e5)).toBeUndefined();
    expect(advance('Arial', false, false, 0x6d)).toBeCloseTo(0.833, 3);
    expect(ocrAdvance(null)('Inter', false, false, 0x6d)).toBeUndefined();
  });

  it('are the nearest face the family has when a face is missing', async () => {
    serveFonts();
    const { mupdf, scan, measured } = await scanIn('Inter');
    const open = (await chooseOpenFont(mupdf, scan.image, measured)) as OpenFont;
    const { bold: _bold, italic: _italic, boldItalic: _boldItalic, ...regularOnly } = open;
    const advance = ocrAdvance(regularOnly);
    const regular = advance('Inter', false, false, 0x6d);
    for (const [bold, italic] of [
      [true, false],
      [false, true],
      [true, true],
    ] as const) {
      expect(advance('Inter', bold, italic, 0x6d)).toBe(regular);
    }
    const noBoldItalic = ocrAdvance({ ...regularOnly, ...(open.bold ? { bold: open.bold } : {}) });
    expect(noBoldItalic('Inter', true, true, 0x6d)).toBe(noBoldItalic('Inter', true, false, 0x6d));
    expect(noBoldItalic('Inter', true, true, 0x6d)).not.toBe(regular);
  });
});

describe('the font files of a scan', () => {
  const textRun = (text: string, font: string, bold = false, italic = false): TextRun => ({
    text,
    font,
    size: 12,
    bold,
    italic,
    color: 0,
    link: null,
  });
  const boxOf = (...runs: TextRun[]): TextBox => ({
    box: [0, 0, 100, 20],
    rotation: 0,
    paragraphs: [{ align: 'left', lineHeight: 14, lines: [{ runs }] }],
  });
  const styles = (files: { style: string }[]): string[] => files.map((file) => file.style);

  async function interFont(): Promise<OpenFont> {
    serveFonts();
    const { mupdf, scan, measured } = await scanIn('Inter');
    return (await chooseOpenFont(mupdf, scan.image, measured)) as OpenFont;
  }

  it('are the faces the runs use, each with the characters they use, as TrueType', async () => {
    const open = await interFont();
    const files = openFontFiles(
      [open],
      [
        boxOf(
          textRun('Şu abc', 'Inter'),
          textRun('bold', 'Inter', true),
          textRun('slant', 'Inter', false, true),
          textRun('both', 'Inter', true, true),
          textRun('日本', 'Arial'),
        ),
      ],
    );
    expect(files.map((file) => [file.family, file.style])).toEqual([
      ['Inter', 'Regular'],
      ['Inter', 'Bold'],
      ['Inter', 'Italic'],
      ['Inter', 'Bold Italic'],
    ]);
    for (const file of files) expect([...file.bytes.subarray(0, 4)]).toEqual([0, 1, 0, 0]);
  });

  it('are none when no run is set in the family, and only the weights used when some are', async () => {
    const open = await interFont();
    expect(openFontFiles([open], [boxOf(textRun('plain', 'Arial'))])).toEqual([]);
    expect(openFontFiles([], [boxOf(textRun('plain', 'Inter'))])).toEqual([]);
    expect(styles(openFontFiles([open], [boxOf(textRun('plain', 'Inter', true))]))).toEqual(['Bold']);
  });

  it('are the nearest face when the family lacks one: a bold run takes the regular file', async () => {
    const { bold: _bold, ...rest } = await interFont();
    expect(styles(openFontFiles([rest], [boxOf(textRun('plain', 'Inter', true))]))).toEqual(['Regular']);
  });

  it('leave out a program that cannot be rebuilt', async () => {
    const open = await interFont();
    const broken: OpenFont = { ...open, regular: { ...open.regular, bytes: new Uint8Array(64) } };
    expect(openFontFiles([broken], [boxOf(textRun('abc', 'Inter'))])).toEqual([]);
  });
});

describe('fonts added to the embedded ones', () => {
  /** A one-page PDF of "abc" in Noto Sans, whose font `embedFonts` embeds as `NotoSans`. */
  async function notoPdfDoc() {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const font = new mupdf.Font('NotoSans-Regular', publicFile('/fonts/noto/NotoSans-Regular.ttf'));
    const hex = [...'abc']
      .map((char) =>
        font
          .encodeCharacter(char.codePointAt(0) as number)
          .toString(16)
          .padStart(4, '0'),
      )
      .join('');
    doc.insertPage(
      0,
      doc.addPage(
        [0, 0, 200, 100],
        0,
        { Font: { F0: doc.addFont(font) } },
        `BT /F0 18 Tf 20 50 Td <${hex}> Tj ET\n`,
      ),
    );
    doc.subsetFonts();
    const bytes = new Uint8Array(doc.saveToBuffer('garbage=compact,compress').asUint8Array());
    return { mupdf, doc: openPdf(mupdf, bytes) };
  }

  it('join the table and the package, unless the family and style are embedded already', async () => {
    const { mupdf, doc } = await notoPdfDoc();
    const fonts = await embedFonts(mupdf, doc, [0], run);
    expect(fonts.count).toBe(1);
    const program = publicFile('/fonts/noto/NotoSans-Regular.ttf');
    expect(fonts.plus([{ family: 'NotoSans', style: 'Regular', bytes: program }])).toBe(fonts);
    const more = fonts.plus([{ family: 'Noto Sans', style: 'Bold', bytes: program }]);
    expect(more.count).toBe(2);
    expect(Object.keys(more.files).filter((name) => name.endsWith('.odttf'))).toEqual([
      'word/fonts/font1.odttf',
      'word/fonts/font2.odttf',
    ]);
    expect(more.files['word/fontTable.xml']).toContain('<w:font w:name="Noto Sans"><w:embedBold ');
    expect(more.files['word/fontTable.xml']).toContain('<w:font w:name="NotoSans"><w:embedRegular ');
  });
});

describe('exact layout: a scan set in an open family', () => {
  /** The scan's picture as one page of a PDF, 200 dpi, and the words as the recogniser would give them (page points). */
  async function pdfOf(mupdf: Mupdf, scan: Scan): Promise<Uint8Array> {
    const { image } = scan;
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, image.width, image.height], true);
    pixmap.getPixels().set(image.data);
    const doc = new mupdf.PDFDocument();
    const width = image.width / image.scale;
    const height = image.height / image.scale;
    const picture = doc.addImage(new mupdf.Image(pixmap.asPNG()));
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, width, height],
        0,
        { XObject: { Im0: picture } },
        `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`,
      ),
    );
    const saved = doc.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    return bytes;
  }

  const wordsOf = (scan: Scan): OcrWord[] =>
    scan.words.map((word) => ({
      text: word.text,
      x0: word.box[0],
      y0: word.box[1],
      x1: word.box[2],
      y1: word.box[3],
      confidence: 98,
      block: 0,
      paragraph: 0,
      line: Math.round(word.box[3]),
    }));

  async function exported(
    family: 'Inter' | 'Helvetica' | 'Times-Roman',
    write: typeof exportOffice = exportOffice,
  ) {
    const { mupdf, scan } = await scanIn(family);
    const result = await write(
      await pdfOf(mupdf, scan),
      {
        pages: [0],
        baseName: 'scan.pdf',
        format: 'docx',
        docxLayout: 'layout',
        ocr: { lowConfidence: 0.9, recognize: async () => wordsOf(scan) },
      },
      run,
    );
    const zip = await JSZip.loadAsync(result.file.bytes);
    return {
      result,
      zip,
      document: (await zip.file('word/document.xml')?.async('string')) ?? '',
      table: (await zip.file('word/fontTable.xml')?.async('string')) ?? '',
      programs: Object.keys(zip.files).filter((name) => name.endsWith('.odttf')),
    };
  }

  it('names Inter in the runs, embeds it and says so', async () => {
    serveFonts();
    const { result, zip, document, table, programs } = await exported('Inter');
    expect(document).toContain('w:ascii="Inter"');
    expect(document).not.toContain('w:ascii="Arial"');
    expect(table).toMatch(
      /<w:font w:name="Inter"><w:embedRegular r:id="rIdFont1" w:fontKey="\{[0-9A-F-]{36}\}"\/>/,
    );
    const key = /w:fontKey="(\{[^"]+\})"/.exec(table)?.[1] as string;
    const program = await zip.file(programs[0] as string)?.async('uint8array');
    // obfuscated as Word does it: de-obfuscated, a TrueType file
    expect([...obfuscateFont(program as Uint8Array, key).subarray(0, 4)]).toEqual([0, 1, 0, 0]);
    expect((program as Uint8Array).length).toBeGreaterThan(100_000);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.fontsEmbedded')).toBe(true);
    const named = result.notes.find((note) => note.key === 'op.note.exportOffice.ocrFont');
    expect(named?.params).toEqual({ families: 'Inter' });
  });

  it("keeps Arial and embeds nothing when the words are Helvetica's", async () => {
    serveFonts();
    const { result, document, programs } = await exported('Helvetica');
    expect(document).toContain('w:ascii="Arial"');
    expect(programs).toEqual([]);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrFont')).toBe(false);
  });

  it("keeps Times New Roman and embeds nothing when the words are Times'", async () => {
    serveFonts();
    const { document, programs } = await exported('Times-Roman');
    expect(document).toContain('w:ascii="Times New Roman"');
    expect(programs).toEqual([]);
  });

  it('falls back to the stand-ins offline', async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    const fresh = await import('./export-office');
    const { document, programs } = await exported('Inter', fresh.exportOffice);
    expect(document).not.toContain('w:ascii="Inter"');
    expect(document).toMatch(/w:ascii="(Arial|Times New Roman|Courier New)"/);
    expect(programs).toEqual([]);
  });
});
