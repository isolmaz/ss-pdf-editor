/**
 * Text editing against real bytes: MuPDF erases, the writer draws, pdf.js verifies. The
 * wrong answers that matter: old text that survives the erase, a replacement drawn with
 * a face that cannot spell `ş` (drawn as boxes instead of substituted and reported), a
 * standard face embedded when nothing needed embedding, and a line drawn somewhere else
 * than its baseline.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyTextEdit } from './text-edit';

const run = { signal: new AbortController().signal };

function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

/** A 400×300 page: `Eski satir` at baseline y=100 from the top, `Kalan` below it. */
async function page(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const content = 'BT /F 14 Tf 40 200 Td (Eski satir) Tj ET BT /F 14 Tf 40 100 Td (Kalan) Tj ET';
  doc.insertPage(0, doc.addPage([0, 0, 400, 300], 0, { Font: { F: font } }, content));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** A 900×800 page with one line of 40 pt text near the top. */
async function tallPage(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  doc.insertPage(
    0,
    doc.addPage([0, 0, 900, 800], 0, { Font: { F: font } }, 'BT /F 40 Tf 40 700 Td (Eski satir) Tj ET'),
  );
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Lines MuPDF extracts, with their boxes in displayed space, and the fonts the page uses. */
async function read(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const json = JSON.parse(doc.loadPage(0).toStructuredText('preserve-whitespace').asJSON()) as {
      blocks: { lines?: { text: string; x: number; y: number; font: { name: string } }[] }[];
    };
    return json.blocks.flatMap((block) => block.lines ?? []);
  } finally {
    doc.destroy();
  }
}

const line = (text: string, y: number, fontId: string) => ({
  text,
  x: 40,
  y,
  fontSize: 14,
  color: '#000000',
  fontId,
  width: 100,
});

describe('applyTextEdit', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('erases a line and draws its replacements at their baselines, substituting where WinAnsi cannot spell', async () => {
    const out = await applyTextEdit(
      await page(),
      {
        erase: [{ pageIndex: 0, rects: [[35, 82, 200, 104]] }],
        insert: [
          {
            pageIndex: 0,
            lines: [line('Yeni Şule', 100, 'helvetica'), line('Plain text', 130, 'helvetica')],
          },
        ],
        fonts: {},
      },
      run,
    );
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).toContain('op.note.textEdit.fontSubstituted');
    expect(keys).toContain('op.note.textEdit.verifiedErased');
    const lines = await read(out.bytes);
    const texts = lines.map((entry) => entry.text);
    expect(texts).not.toContain('Eski satir');
    expect(texts).toEqual(expect.arrayContaining(['Yeni Şule', 'Plain text', 'Kalan']));
    const yeni = lines.find((entry) => entry.text === 'Yeni Şule');
    const plain = lines.find((entry) => entry.text === 'Plain text');
    // The baseline point MuPDF reports is where the line was asked to be.
    expect(yeni?.x).toBeCloseTo(40, 0);
    expect(yeni?.y).toBeCloseTo(100, 0);
    expect(plain?.y).toBeCloseTo(130, 0);
    expect(yeni?.font.name).toMatch(/Noto/);
    expect(plain?.font.name).toMatch(/Helvetica/);
  });

  it('draws a justified line word by word', async () => {
    const out = await applyTextEdit(
      await page(),
      {
        erase: [],
        insert: [
          {
            pageIndex: 0,
            lines: [
              {
                ...line('İki kelime', 250, 'noto'),
                words: [
                  { text: 'İki', x: 40 },
                  { text: 'kelime', x: 200 },
                ],
              },
            ],
          },
        ],
        fonts: {},
      },
      run,
    );
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.textEdit.justified');
    const words = (await read(out.bytes)).filter((entry) => entry.y > 240);
    expect(words.map((entry) => [entry.text, Math.round(entry.x)])).toEqual([
      ['İki', 40],
      ['kelime', 200],
    ]);
  });

  describe('a paragraph that runs off the page', () => {
    /** 17 words at 40 pt in five lines; the first four are justified word by word. */
    const ROWS = [
      ['Bu', 'metin', 'uzun', 'bir'],
      ['paragraf', 'olarak', 'sayfaya', 'yerleştirilir'],
      ['ve', 'iki', 'yana', 'yaslanır'],
      ['sonra', 'son', 'satır', 'kısa'],
      ['kalır'],
    ];
    const paragraph = (firstBaseline: number) =>
      ROWS.map((row, index) => ({
        text: row.join(' '),
        x: 40,
        y: firstBaseline + index * 50,
        fontSize: 40,
        color: '#000000',
        fontId: 'noto',
        width: 520,
        ...(row.length > 1 ? { words: row.map((word, at) => ({ text: word, x: 40 + at * 130 })) } : {}),
      }));
    const edit = (bytes: Uint8Array, firstBaseline: number) =>
      applyTextEdit(
        bytes,
        {
          erase: [{ pageIndex: 0, rects: [[35, 60, 300, 110]] }],
          insert: [{ pageIndex: 0, lines: paragraph(firstBaseline) }],
          fonts: {},
        },
        run,
      );

    it('is verified when every line lies on the page, justified or not', async () => {
      const out = await edit(await tallPage(), 100);
      expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.textEdit.verifiedInserted');
      const texts = (await read(out.bytes)).map((entry) => entry.text);
      expect(texts).toContain('kalır');
    });

    it('is refused, naming exactly the lines pdf.js cannot report, when its last lines fall below the page', async () => {
      // The page is 800 pt high: baselines at 700 and 750 are on it, 800 is on its edge and
      // 850 and 900 are off it. pdf.js does not report text drawn outside the page, so those
      // lines are not extractable — the same words are, once they are moved up.
      await expect(edit(await tallPage(), 700)).rejects.toMatchObject({
        code: 'verification-failed',
        details: {
          engineMessage:
            'page 0: inserted text is not extractable: “sonra son satır kısa” · page 0: inserted text is not extractable: “kalır”',
        },
      });
    });
  });
});
