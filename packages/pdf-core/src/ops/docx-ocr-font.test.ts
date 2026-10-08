/**
 * The open font of a rebuilt scan: the page is set in Noto Sans when its word boxes fit it clearly
 * better than Arial (a Helvetica or Times scan keeps its stand-in), and the package then carries
 * the font — `fontTable.xml`, an obfuscated `.odttf`, runs naming it — so Word and LibreOffice
 * draw it. The font bytes come through the app's own loader (`engines/noto.ts`), here a stubbed
 * `fetch` serving the files of `public/fonts/noto`.
 */

import { readFileSync } from 'node:fs';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import type { OcrWord } from '../engines/tesseract';
import { embedFonts, obfuscateFont, provideStandardMetrics } from './docx-fonts';
import { loadOpenFont, OPEN_FONT, type OpenFont, ocrAdvance, openFontFiles } from './docx-ocr-font';
import { exportOffice } from './export-office';
import { officeDocument } from './export-office-fixtures';
import type { TextBox, TextRun } from './layout-scene';
import { ocrTextBoxes, type RgbaImage } from './ocr-scene';
import type { OperationContext } from './types';

const run: OperationContext = { signal: new AbortController().signal };
const noto = (file: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../../public/fonts/noto/${file}`, import.meta.url)));

/** Serves the shipped Noto Sans files to the app's loader, as the origin would. */
function serveNoto(): void {
  const files = new Map([
    ['/fonts/noto/NotoSans-Regular.ttf', noto('NotoSans-Regular.ttf')],
    ['/fonts/noto/NotoSans-SemiBold.ttf', noto('NotoSans-SemiBold.ttf')],
  ]);
  vi.stubGlobal(
    'fetch',
    async (url: string) => new Response(files.get(url)?.slice() ?? null, { status: 200 }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const blank = (): RgbaImage => ({
  width: 1500,
  height: 400,
  data: new Uint8Array(1500 * 400 * 4).fill(255),
  scale: 1,
});

const WORDS = [
  'macros',
  'summon',
  'mourns',
  'common',
  'ounces',
  'women',
  'seven',
  'crumes',
  'ramose',
  'overs',
  'arcane',
  'summer',
];

/** The words of a 20 pt line as `family` sets them (a pixel's wobble on each box), x-height only so their size reads 20. */
function setIn(advance: (code: number) => number): OcrWord[] {
  let x = 10;
  return WORDS.map((text, index) => {
    if (index % 3 === 0) x = 10;
    const em = [...text].reduce((sum, char) => sum + advance(char.codePointAt(0) as number), 0);
    const width = em * 20 + (index % 2 === 0 ? 0.3 : -0.3);
    const word: OcrWord = {
      text,
      x0: x,
      x1: x + width,
      y0: 40 + 30 * Math.floor(index / 3),
      y1: 40 + 30 * Math.floor(index / 3) + 0.53 * 20,
      confidence: 98,
      block: 0,
      paragraph: 0,
      line: Math.floor(index / 3),
    };
    x += width + 8;
    return word;
  });
}

describe('the family of a scan: Noto Sans when it fits clearly better', () => {
  async function familyOfScanSetIn(family: string): Promise<string | undefined> {
    serveNoto();
    const mupdf = await loadMupdf();
    provideStandardMetrics(mupdf);
    const advance = ocrAdvance(await loadOpenFont(mupdf));
    const words = setIn((code) => advance(family, false, false, code) as number);
    const box = ocrTextBoxes(words, blank(), 0.9, [], advance).boxes[0] as TextBox;
    return box.paragraphs[0]?.lines[0]?.runs[0]?.font;
  }

  it('sets a page whose words are Noto Sans in Noto Sans', async () => {
    expect(await familyOfScanSetIn('Noto Sans')).toBe(OPEN_FONT);
  });

  it('keeps Arial for a Helvetica scan and Times New Roman for a Times scan', async () => {
    expect(await familyOfScanSetIn('Arial')).toBe('Arial');
    expect(await familyOfScanSetIn('Times New Roman')).toBe('Times New Roman');
  });

  it('stays in the stand-ins when the font cannot be loaded', async () => {
    // a fresh module: the loader keeps what it fetched
    vi.resetModules();
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline');
    });
    const fresh = await import('./docx-ocr-font');
    const mupdf = await loadMupdf();
    provideStandardMetrics(mupdf);
    expect(await fresh.loadOpenFont(mupdf)).toBeNull();
    const advance = ocrAdvance(null);
    expect(advance(OPEN_FONT, false, false, 97)).toBeUndefined();
    expect(advance('Arial', false, false, 97)).toBeCloseTo(0.556, 3);
  });
});

describe('the advances of the open font', () => {
  it("are the program's: semi-bold wider than regular, nothing for a glyph it lacks, the stand-ins' own for Arial", async () => {
    serveNoto();
    const mupdf = await loadMupdf();
    provideStandardMetrics(mupdf);
    const advance = ocrAdvance(await loadOpenFont(mupdf));
    const regular = advance(OPEN_FONT, false, false, 0x6d) as number;
    const bold = advance(OPEN_FONT, true, false, 0x6d) as number;
    expect(regular).toBeGreaterThan(0.8);
    expect(bold).toBeGreaterThan(regular);
    expect(advance(OPEN_FONT, false, true, 0x6d)).toBe(regular);
    expect(advance(OPEN_FONT, false, false, 0x65e5)).toBeUndefined();
    expect(advance('Arial', false, false, 0x6d)).toBeCloseTo(0.833, 3);
  });
});

describe('the font files of a scan', () => {
  const textRun = (text: string, font: string, bold: boolean): TextRun => ({
    text,
    font,
    size: 12,
    bold,
    italic: false,
    color: 0,
    link: null,
  });
  const boxOf = (...runs: TextRun[]): TextBox => ({
    box: [0, 0, 100, 20],
    rotation: 0,
    paragraphs: [{ align: 'left', lineHeight: 14, lines: [{ runs }] }],
  });

  it('are the regular and the bold of Noto Sans for the runs set in it, with the characters they use', async () => {
    serveNoto();
    const open = await loadOpenFont(await loadMupdf());
    const files = openFontFiles(open as OpenFont, [
      boxOf(
        textRun('Şu abc', OPEN_FONT, false),
        textRun('bold', OPEN_FONT, true),
        textRun('日本', 'Arial', false),
      ),
    ]);
    expect(files.map((file) => [file.family, file.style])).toEqual([
      [OPEN_FONT, 'Regular'],
      [OPEN_FONT, 'Bold'],
    ]);
    for (const file of files) expect([...file.bytes.subarray(0, 4)]).toEqual([0, 1, 0, 0]);
  });

  it('are none when no run is set in it, and only the weights used when some are', async () => {
    serveNoto();
    const open = (await loadOpenFont(await loadMupdf())) as OpenFont;
    expect(openFontFiles(open, [boxOf(textRun('plain', 'Arial', false))])).toEqual([]);
    expect(openFontFiles(open, [boxOf(textRun('plain', OPEN_FONT, true))]).map((file) => file.style)).toEqual(
      ['Bold'],
    );
  });
});

describe('the font files of a scan: a program that cannot be rebuilt', () => {
  it('is left out', async () => {
    serveNoto();
    const open = (await loadOpenFont(await loadMupdf())) as OpenFont;
    const broken: OpenFont = { ...open, regular: { ...open.regular, bytes: new Uint8Array(64) } };
    const boxes: TextBox[] = [
      {
        box: [0, 0, 100, 20],
        rotation: 0,
        paragraphs: [
          {
            align: 'left',
            lineHeight: 14,
            lines: [
              {
                runs: [
                  {
                    text: 'abc',
                    font: OPEN_FONT,
                    size: 12,
                    bold: false,
                    italic: false,
                    color: 0,
                    link: null,
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
    expect(openFontFiles(broken, boxes)).toEqual([]);
  });
});

describe('fonts added to the embedded ones', () => {
  /** A one-page PDF of "abc" in Noto Sans, whose font `embedFonts` embeds as `NotoSans`. */
  async function notoPdfDoc() {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const font = new mupdf.Font('NotoSans-Regular', noto('NotoSans-Regular.ttf'));
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
    const program = noto('NotoSans-Regular.ttf');
    expect(fonts.plus([{ family: 'NotoSans', style: 'Regular', bytes: program }])).toBe(fonts);
    const more = fonts.plus([{ family: OPEN_FONT, style: 'Bold', bytes: program }]);
    expect(more.count).toBe(2);
    expect(Object.keys(more.files).filter((name) => name.endsWith('.odttf'))).toEqual([
      'word/fonts/font1.odttf',
      'word/fonts/font2.odttf',
    ]);
    expect(more.files['word/fontTable.xml']).toContain('<w:font w:name="Noto Sans"><w:embedBold ');
    expect(more.files['word/fontTable.xml']).toContain('<w:font w:name="NotoSans"><w:embedRegular ');
  });
});

describe('exact layout: a scan set in Noto Sans', () => {
  /** A blank scan of 400 × 500 points (one picture over the page). */
  async function blankScan(): Promise<Uint8Array> {
    const sample = await officeDocument([{ content: '1 1 1 rg 0 0 400 500 re f' }]);
    const mupdf = await loadMupdf();
    const source = mupdf.Document.openDocument(sample.slice(), 'application/pdf');
    const scan = new mupdf.PDFDocument();
    try {
      const pixmap = source
        .loadPage(0)
        .toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceRGB, false, false);
      const image = scan.addImage(new mupdf.Image(pixmap.asPNG()));
      pixmap.destroy();
      scan.insertPage(
        -1,
        scan.addPage([0, 0, 400, 500], 0, { XObject: { Im0: image } }, 'q 400 0 0 500 0 0 cm /Im0 Do Q\n'),
      );
      const saved = scan.saveToBuffer('compress');
      const bytes = saved.asUint8Array().slice();
      saved.destroy();
      return bytes;
    } finally {
      scan.destroy();
      source.destroy();
    }
  }

  it('names Noto Sans in the runs and embeds it in the package', async () => {
    serveNoto();
    const mupdf = await loadMupdf();
    provideStandardMetrics(mupdf);
    const advance = ocrAdvance(await loadOpenFont(mupdf));
    const result = await exportOffice(
      await blankScan(),
      {
        pages: [0],
        baseName: 'scan.pdf',
        format: 'docx',
        docxLayout: 'layout',
        ocr: {
          lowConfidence: 0.9,
          recognize: async () => setIn((code) => advance(OPEN_FONT, false, false, code) as number),
        },
      },
      run,
    );
    const zip = await JSZip.loadAsync(result.file.bytes);
    const document = (await zip.file('word/document.xml')?.async('string')) ?? '';
    expect(document).toContain(`w:ascii="${OPEN_FONT}"`);
    expect(document).not.toContain('w:ascii="Arial"');
    const table = (await zip.file('word/fontTable.xml')?.async('string')) ?? '';
    expect(table).toMatch(
      /<w:font w:name="Noto Sans"><w:embedRegular r:id="rIdFont1" w:fontKey="\{[0-9A-F-]{36}\}"\/><\/w:font>/,
    );
    const key = /w:fontKey="(\{[^"]+\})"/.exec(table)?.[1] as string;
    const program = await zip.file('word/fonts/font1.odttf')?.async('uint8array');
    expect(program).toBeDefined();
    // obfuscated as Word does it: de-obfuscated, a TrueType file
    expect([...obfuscateFont(program as Uint8Array, key).subarray(0, 4)]).toEqual([0, 1, 0, 0]);
    expect((program as Uint8Array).length).toBeGreaterThan(100_000);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.fontsEmbedded')).toBe(true);
  });

  it("keeps Arial and embeds nothing when the words are Helvetica's", async () => {
    serveNoto();
    const mupdf = await loadMupdf();
    provideStandardMetrics(mupdf);
    const advance = ocrAdvance(await loadOpenFont(mupdf));
    const result = await exportOffice(
      await blankScan(),
      {
        pages: [0],
        baseName: 'scan.pdf',
        format: 'docx',
        docxLayout: 'layout',
        ocr: {
          lowConfidence: 0.9,
          recognize: async () => setIn((code) => advance('Arial', false, false, code) as number),
        },
      },
      run,
    );
    const zip = await JSZip.loadAsync(result.file.bytes);
    const document = (await zip.file('word/document.xml')?.async('string')) ?? '';
    expect(document).toContain('w:ascii="Arial"');
    expect(Object.keys(zip.files).filter((name) => name.endsWith('.odttf'))).toEqual([]);
  });
});
