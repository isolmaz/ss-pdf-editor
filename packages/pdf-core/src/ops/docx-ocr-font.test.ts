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
import type { Font, PDFDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf, type Mupdf, openPdf } from '../engines/mupdf';
import type { OcrWord } from '../engines/tesseract';
import { embedFonts, obfuscateFont, provideStandardMetrics } from './docx-fonts';
import {
  chooseOpenFont,
  type OpenFace,
  type OpenFont,
  ocrAdvance,
  openFontFiles,
  openFontsFor,
  releaseOpenFonts,
  settleReadings,
} from './docx-ocr-font';
import { exportOffice } from './export-office';
import type { TextBox, TextRun } from './layout-scene';
import { renderScan, type Scan, SENTENCES } from './ocr-font-match.fixtures';
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

/** The Windows-platform string of `name` record `id` in a TrueType program (empty when there is none). */
function nameRecord(bytes: Uint8Array, id: number): string {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < dv.getUint16(4); index += 1) {
    const entry = 12 + 16 * index;
    if (String.fromCharCode(...bytes.subarray(entry, entry + 4)) !== 'name') continue;
    const table = dv.getUint32(entry + 8);
    const storage = table + dv.getUint16(table + 4);
    for (let record = 0; record < dv.getUint16(table + 2); record += 1) {
      const at = table + 6 + 12 * record;
      if (dv.getUint16(at) !== 3 || dv.getUint16(at + 6) !== id) continue;
      const start = storage + dv.getUint16(at + 10);
      const raw = bytes.subarray(start, start + dv.getUint16(at + 8));
      return String.fromCharCode(
        ...Array.from(
          { length: raw.length / 2 },
          (_, at) => ((raw[2 * at] as number) << 8) | (raw[2 * at + 1] as number),
        ),
      );
    }
  }
  return '';
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A scan of the sentences set in `family`, and the words the way `ocrTextBoxes` reports them. */
async function scanIn(family: 'Inter' | 'Roboto' | 'Helvetica' | 'Times-Roman'): Promise<{
  mupdf: Mupdf;
  scan: Scan;
  measured: MeasuredWord[];
}> {
  const mupdf = await loadMupdf();
  const open = { Inter: '/fonts/inter/Inter-Regular.ttf', Roboto: '/fonts/roboto/Roboto-Regular.ttf' };
  const font: Font =
    family === 'Inter' || family === 'Roboto'
      ? new mupdf.Font(`${family}-Regular`, publicFile(open[family]))
      : new mupdf.Font(family);
  const scan = renderScan(mupdf, font, { dpi: 200, size: 11, amplitude: 20 });
  return { mupdf, scan, measured: scan.words.map((word) => ({ ...word, confidence: 98 })) };
}

describe('the open family of a scan', () => {
  it('is Inter for a scan set in it, with the faces the family has', async () => {
    serveFonts();
    const { mupdf, scan, measured } = await scanIn('Inter');
    const open = (await chooseOpenFont(mupdf, scan.image, measured, openFontsFor(new Set()))) as OpenFont;
    expect(open.name).toBe('Inter');
    expect(open.bold).toBeDefined();
    expect(open.italic).toBeDefined();
    expect(open.boldItalic).toBeDefined();
  });

  it('settles the reading of a word in the face the page is set in: the stand-in, or the open family', async () => {
    serveFonts();
    const unsettled = (scan: Scan, text: string) => {
      const [x0, y0, x1, y1] = (scan.words[0] as (typeof scan.words)[number]).box;
      const word: OcrWord = {
        text,
        alternatives: [{ text: 'Quick', confidence: 88 }],
        x0,
        y0,
        x1,
        y1,
        confidence: 60,
      };
      return [{ word, size: 11 }];
    };
    // the stand-ins: Arial and Times New Roman are drawn in the base-14 faces behind them
    for (const [family, name, stand] of [
      ['Helvetica', 'Arial', 'Arial'],
      ['Times-Roman', 'Times New Roman', 'Times New Roman'],
    ] as const) {
      const { mupdf, scan } = await scanIn(family);
      const [first] = unsettled(scan, 'Qu1ck');
      const chosen = settleReadings(mupdf, scan.image, [first as NonNullable<typeof first>], name, null);
      // the reading comes with the confidence it was read at, not the settled word's
      expect(chosen.get((first as NonNullable<typeof first>).word), stand).toEqual({
        text: 'Quick',
        confidence: 88,
      });
      // the settled reading is the right one: nothing changes
      const right = unsettled(scan, 'Quick');
      expect(settleReadings(mupdf, scan.image, right, name, null).size).toBe(0);
    }
    // nothing to settle: nothing is drawn
    const { mupdf, scan, measured } = await scanIn('Inter');
    expect(settleReadings(mupdf, scan.image, [], 'Arial', null).size).toBe(0);
    // the open family: its own regular face
    const open = (await chooseOpenFont(mupdf, scan.image, measured, openFontsFor(new Set()))) as OpenFont;
    const [odd] = unsettled(scan, 'Qu1ck');
    const chosen = settleReadings(mupdf, scan.image, [odd as NonNullable<typeof odd>], open.name, open);
    expect(chosen.get((odd as NonNullable<typeof odd>).word)).toEqual({ text: 'Quick', confidence: 88 });
  });

  it('is none for a Helvetica scan or a Times scan: the stand-ins stay', async () => {
    serveFonts();
    for (const family of ['Helvetica', 'Times-Roman'] as const) {
      const { mupdf, scan, measured } = await scanIn(family);
      expect(await chooseOpenFont(mupdf, scan.image, measured, openFontsFor(new Set()))).toBeNull();
    }
  });

  it('judges only the words OCR is sure of, and fetches no font when there is none', async () => {
    // a fresh module: the loader keeps what it fetched
    vi.resetModules();
    const fetched = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetched);
    const fresh = await import('./docx-ocr-font');
    const { mupdf, scan, measured } = await scanIn('Inter');
    const unsure = measured.map((word) => ({ ...word, confidence: 50 }));
    expect(await fresh.chooseOpenFont(mupdf, scan.image, unsure, fresh.openFontsFor(new Set()))).toBeNull();
    // sure, but too short to compare, or not regular: still nothing to judge
    const unjudgeable = measured.map((word) => ({ ...word, text: 'ab' }));
    expect(
      await fresh.chooseOpenFont(mupdf, scan.image, unjudgeable, fresh.openFontsFor(new Set())),
    ).toBeNull();
    expect(await fresh.chooseOpenFont(mupdf, scan.image, [], fresh.openFontsFor(new Set()))).toBeNull();
    expect(fetched).not.toHaveBeenCalled();
  });

  it('is none offline or without the files: the stand-ins stay', async () => {
    // a fresh module: the loader keeps what it fetched
    vi.resetModules();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    const fresh = await import('./docx-ocr-font');
    const { mupdf, scan, measured } = await scanIn('Inter');
    expect(await fresh.chooseOpenFont(mupdf, scan.image, measured, openFontsFor(new Set()))).toBeNull();
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
    const open = (await fresh.chooseOpenFont(
      mupdf,
      scan.image,
      measured,
      openFontsFor(new Set()),
    )) as OpenFont;
    expect(open.name).toBe('Inter');
    expect(open.bold).toBeUndefined();
    expect(open.italic).toBeUndefined();
    expect(open.boldItalic).toBeUndefined();
  });
});

describe('the open families of an export', () => {
  it('are named against the PDF fonts, loaded once and freed at the end', async () => {
    serveFonts();
    const { mupdf, scan, measured } = await scanIn('Inter');
    const fonts = openFontsFor(new Set(['Inter', 'Arial']));
    const first = (await chooseOpenFont(mupdf, scan.image, measured, fonts)) as OpenFont;
    // a PDF font called Inter is embedded: the scan's runs and font table say Inter 2
    expect([first.name, first.family]).toEqual(['Inter 2', 'Inter']);
    expect(fonts.names.has('Inter 2')).toBe(true);
    // the next scan page of the export has the same family: the same fonts, not another parse
    expect(await chooseOpenFont(mupdf, scan.image, measured, fonts)).toBe(first);
    expect(fonts.loaded.size).toBe(1);
    const crowded = (await chooseOpenFont(
      mupdf,
      scan.image,
      measured,
      openFontsFor(new Set(['Inter', 'Inter 2'])),
    )) as OpenFont;
    expect(crowded.name).toBe('Inter 3');
    const destroyed = [first.regular, first.bold, first.italic, first.boldItalic].map((face) =>
      vi.spyOn((face as OpenFace).font, 'destroy'),
    );
    releaseOpenFonts(fonts);
    for (const spy of destroyed) expect(spy).toHaveBeenCalledTimes(1);
    expect(fonts.loaded.size).toBe(0);
    releaseOpenFonts(openFontsFor(new Set()));
  });
});

describe('the advances of the open family', () => {
  it("are the faces' own, the stand-ins' own for Arial, nothing for a glyph the face lacks", async () => {
    serveFonts();
    const { mupdf, scan, measured } = await scanIn('Inter');
    provideStandardMetrics(mupdf);
    const open = (await chooseOpenFont(mupdf, scan.image, measured, openFontsFor(new Set()))) as OpenFont;
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
    const open = (await chooseOpenFont(mupdf, scan.image, measured, openFontsFor(new Set()))) as OpenFont;
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
    return (await chooseOpenFont(mupdf, scan.image, measured, openFontsFor(new Set()))) as OpenFont;
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
    expect([...fonts.families]).toEqual(['NotoSans']);
    expect(fonts.plus([]).families.size).toBe(1);
    expect([
      ...fonts.plus([{ family: 'Noto Sans', style: 'Bold', bytes: new Uint8Array(8) }]).families,
    ]).toEqual(['NotoSans', 'Noto Sans']);
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
  async function pdfOf(
    mupdf: Mupdf,
    scan: Scan,
    firstPage?: (doc: PDFDocument) => void,
  ): Promise<Uint8Array> {
    const { image } = scan;
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, image.width, image.height], true);
    pixmap.getPixels().set(image.data);
    const doc = new mupdf.PDFDocument();
    const width = image.width / image.scale;
    const height = image.height / image.scale;
    const picture = doc.addImage(new mupdf.Image(pixmap.asPNG()));
    firstPage?.(doc);
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, width, height],
        0,
        { XObject: { Im0: picture } },
        `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q\n`,
      ),
    );
    if (firstPage !== undefined) doc.subsetFonts();
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
    family: 'Inter' | 'Roboto' | 'Helvetica' | 'Times-Roman',
    write: typeof exportOffice = exportOffice,
    firstPage?: (doc: PDFDocument) => void,
  ) {
    const { mupdf, scan } = await scanIn(family);
    const result = await write(
      await pdfOf(mupdf, scan, firstPage),
      {
        pages: firstPage === undefined ? [0] : [0, 1],
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
    // the font keeps its copyright and licence records
    const kept = obfuscateFont(program as Uint8Array, key);
    expect(nameRecord(kept, 0)).toContain('Copyright');
    expect(nameRecord(kept, 13)).toContain('SIL Open Font License');
    expect(nameRecord(kept, 14)).toContain('https://');
  });

  it('is embedded beside a PDF font of the same name, and the scan runs name the open one', async () => {
    serveFonts();
    const mupdf = await loadMupdf();
    // a page of the PDF's own, drawn in a Roboto subset: embedded as the family "Roboto"
    const roboto = new mupdf.Font('Roboto-Regular', publicFile('/fonts/roboto/Roboto-Regular.ttf'));
    const hex = [...'Hello']
      .map((char) =>
        roboto
          .encodeCharacter(char.codePointAt(0) as number)
          .toString(16)
          .padStart(4, '0'),
      )
      .join('');
    const { result, zip, document, table, programs } = await exported('Roboto', exportOffice, (doc) =>
      doc.insertPage(
        -1,
        doc.addPage(
          [0, 0, 200, 100],
          0,
          { Font: { F0: doc.addFont(roboto) } },
          `BT /F0 18 Tf 20 50 Td <${hex}> Tj ET\n`,
        ),
      ),
    );
    // both programs are embedded, under two names
    expect(programs.length).toBeGreaterThanOrEqual(2);
    expect(table).toContain('<w:font w:name="Roboto"><w:embedRegular ');
    expect(table).toContain('<w:font w:name="Roboto 2"><w:embedRegular ');
    expect(document).toContain('w:ascii="Roboto 2"');
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.ocrFont')?.params).toEqual({
      families: 'Roboto',
    });
    // the scan's program is the open one: it covers every character the scan sets, the PDF's subset does not
    const programOf = async (name: string): Promise<Font> => {
      const found = new RegExp(
        `<w:font w:name="${name}"><w:embedRegular r:id="rIdFont(\\d+)" w:fontKey="(\\{[^"]+\\})"`,
      ).exec(table) as RegExpExecArray;
      const bytes = await zip.file(`word/fonts/font${found[1]}.odttf`)?.async('uint8array');
      return new mupdf.Font(name, obfuscateFont(bytes as Uint8Array, found[2] as string));
    };
    const open = await programOf('Roboto 2');
    const subset = await programOf('Roboto');
    const scanned = new Set(SENTENCES.join(' ').replaceAll(' ', ''));
    for (const char of scanned) expect(open.encodeCharacter(char.codePointAt(0) as number), char).not.toBe(0);
    expect([...scanned].some((char) => subset.encodeCharacter(char.codePointAt(0) as number) === 0)).toBe(
      true,
    );
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
