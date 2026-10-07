/**
 * Text editing against real bytes: MuPDF erases, the writer draws, pdf.js verifies. The
 * wrong answers that matter: old text that survives the erase, a replacement drawn with
 * a face that cannot spell `ş` (drawn as boxes instead of substituted and reported), a
 * standard face embedded when nothing needed embedding, and a line drawn somewhere else
 * than its baseline.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ToolError } from 'pdf-shared';
import type { TextEditInsertLine } from 'pdf-text-engine';
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

const line = (text: string, y: number, fontId: string): TextEditInsertLine => ({
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

const insertOnly = (lines: TextEditInsertLine[], extra: Record<string, unknown> = {}) => ({
  erase: [],
  insert: [{ pageIndex: 0, lines }],
  fonts: {},
  ...extra,
});

const failureOf = (request: unknown, bytes: Promise<Uint8Array> = page()) =>
  bytes
    .then((input) => applyTextEdit(input, request as Parameters<typeof applyTextEdit>[1], run))
    .then(
      () => null,
      (error: unknown) => error,
    );

describe('applyTextEdit request validation', () => {
  it.each([
    [
      'an erase on a negative page',
      { erase: [{ pageIndex: -1, rects: [[0, 0, 10, 10]] }], insert: [], fonts: {} },
      'range-invalid',
      'page index -1 is not a 0-based page number',
    ],
    [
      'an insert on a fractional page',
      { erase: [], insert: [{ pageIndex: 1.5, lines: [line('x', 50, 'helvetica')] }], fonts: {} },
      'range-invalid',
      'page index 1.5 is not a 0-based page number',
    ],
    [
      'a rectangle with a NaN coordinate',
      { erase: [{ pageIndex: 0, rects: [[0, Number.NaN, 10, 10]] }], insert: [], fonts: {} },
      'range-invalid',
      'erase rect [0, NaN, 10, 10] is not a positive rectangle',
    ],
    [
      'a rectangle with no width',
      { erase: [{ pageIndex: 0, rects: [[10, 0, 10, 10]] }], insert: [], fonts: {} },
      'range-invalid',
      'erase rect [10, 0, 10, 10] is not a positive rectangle',
    ],
    [
      'a rectangle with no height',
      { erase: [{ pageIndex: 0, rects: [[0, 10, 10, 10]] }], insert: [], fonts: {} },
      'range-invalid',
      'erase rect [0, 10, 10, 10] is not a positive rectangle',
    ],
    [
      'a font size of zero',
      insertOnly([{ ...line('x', 50, 'helvetica'), fontSize: 0 }]),
      'value-out-of-range',
      'fontSize must be between 1 and 1000',
    ],
    [
      'a font size above the limit',
      insertOnly([{ ...line('x', 50, 'helvetica'), fontSize: 1001 }]),
      'value-out-of-range',
      'fontSize must be between 1 and 1000',
    ],
    [
      'a NaN font size',
      insertOnly([{ ...line('x', 50, 'helvetica'), fontSize: Number.NaN }]),
      'value-out-of-range',
      'fontSize must be between 1 and 1000',
    ],
    [
      'a colour that is not #rrggbb',
      insertOnly([{ ...line('x', 50, 'helvetica'), color: 'red' }]),
      'value-out-of-range',
      'colour red is not #rrggbb',
    ],
    [
      'a word placed at a NaN x',
      insertOnly([
        {
          ...line('ab cd', 50, 'helvetica'),
          words: [
            { text: 'ab', x: 40 },
            { text: 'cd', x: Number.NaN },
          ],
        },
      ]),
      'value-out-of-range',
      'word placement for “cd” has no finite x',
    ],
    [
      'no rectangle and no line',
      { erase: [], insert: [], fonts: {} },
      'selection-empty',
      'text edit request carries neither a rectangle nor a line',
    ],
  ])('refuses %s', async (_name, request, code, message) => {
    const failure = await failureOf(request);
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({ code, details: { engineMessage: message } });
  });

  it('draws nothing, and says nothing was rendered, for lines without text', async () => {
    const input = await page();
    const out = await applyTextEdit(
      input,
      insertOnly([line('', 50, 'helvetica'), { ...line('', 60, 'helvetica'), words: [] }]),
      run,
    );
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).not.toContain('op.note.textEdit.rendered');
    expect(keys).not.toContain('op.note.textEdit.fontSubstituted');
    expect((await read(out.bytes)).map((entry) => entry.text)).toEqual(['Eski satir', 'Kalan']);
    expect(out.report.steps).toEqual(['mupdf:open', 'load', 'save', 'pdfjs:verify']);
  });

  it('refuses a page index past the end of the document, for an erase and for an insert alike', async () => {
    for (const request of [
      { erase: [{ pageIndex: 3, rects: [[0, 0, 10, 10]] }], insert: [], fonts: {} },
      { erase: [], insert: [{ pageIndex: 3, lines: [line('x', 50, 'helvetica')] }], fonts: {} },
    ]) {
      expect(await failureOf(request)).toMatchObject({
        code: 'range-invalid',
        details: { engine: 'mupdf', pageIndex: 3, engineMessage: 'page index 3 outside 0..0' },
      });
    }
  });

  it('merges several requests for one page and applies the pages in ascending order', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    const font = doc.addObject({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: 'WinAnsiEncoding',
    });
    for (const text of ['First', 'Second']) {
      doc.insertPage(
        -1,
        doc.addPage([0, 0, 400, 300], 0, { Font: { F: font } }, `BT /F 14 Tf 40 200 Td (${text}) Tj ET`),
      );
    }
    const input = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const progress: number[] = [];
    const out = await applyTextEdit(
      input,
      {
        erase: [
          { pageIndex: 1, rects: [[35, 82, 200, 104]] },
          { pageIndex: 0, rects: [[35, 82, 200, 104]] },
          { pageIndex: 1, rects: [[300, 10, 350, 20]] },
        ],
        insert: [],
        fonts: {},
      },
      {
        signal: run.signal,
        onProgress: (event) => {
          if (event.phase === 'textEdit.erase' && event.labelKey === 'op.progress.redact') {
            progress.push(event.done ?? 0);
          }
        },
      },
    );
    expect(progress).toEqual([1, 2, 3]);
    expect(out.report.pageCount).toBe(2);
    const erasedNote = out.report.notes.find((entry) => entry.key === 'op.note.textEdit.erased');
    expect(erasedNote?.params).toMatchObject({ rects: 3, pages: 2 });
  });
});

/** Like `page()`, but the font states its widths, so a line can be drawn with the codes the page already uses. */
async function documentFontPage(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
    FirstChar: 32,
    LastChar: 126,
    Widths: Array.from({ length: 95 }, () => 500),
  });
  const content = 'BT /F 14 Tf 40 200 Td (Eski satir) Tj ET BT /F 14 Tf 40 100 Td (Kalan) Tj ET';
  doc.insertPage(0, doc.addPage([0, 0, 400, 300], 0, { Font: { F: font } }, content));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('applyTextEdit faces', () => {
  const notes = (out: Awaited<ReturnType<typeof applyTextEdit>>, key: string) =>
    out.report.notes.filter((entry) => entry.key === key).map((entry) => entry.params);

  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'http://localhost' });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('embeds a face named in request.fonts once for every line that uses it, fetched from the document origin', async () => {
    const requested: string[] = [];
    const font = notoRegular();
    vi.stubGlobal('fetch', async (input: URL) => {
      requested.push(input.href);
      return new Response(font);
    });
    const out = await applyTextEdit(
      await page(),
      insertOnly([line('Yeni Şule', 60, 'my-face'), line('Başka satır', 80, 'my-face')], {
        fonts: { 'my-face': '/fonts/my-face.ttf' },
      }),
      run,
    );
    expect(requested).toEqual(['http://localhost/fonts/my-face.ttf']);
    expect(notes(out, 'op.note.textEdit.fontEmbedded')).toEqual([{ font: 'my-face' }]);
    expect(notes(out, 'op.note.textEdit.fontSubstituted')).toEqual([]);
    expect((await read(out.bytes)).map((entry) => entry.text)).toEqual(
      expect.arrayContaining(['Yeni Şule', 'Başka satır']),
    );
  });

  it('draws with the standard face the id names, whatever its case, spacing or underscores, embedding nothing', async () => {
    const out = await applyTextEdit(
      await page(),
      insertOnly([
        line('Bir', 60, ' TIMES_Roman '),
        line('Iki', 80, 'times roman'),
        line('Uc', 100, 'Courier-Bold'),
      ]),
      run,
    );
    expect(notes(out, 'op.note.textEdit.rendered')).toEqual([{ font: 'Times-Roman, Courier-Bold' }]);
    expect(notes(out, 'op.note.textEdit.fontEmbedded')).toEqual([]);
    expect(notes(out, 'op.note.textEdit.fontSubstituted')).toEqual([]);
    const fonts = Object.fromEntries((await read(out.bytes)).map((entry) => [entry.text, entry.font.name]));
    expect(fonts).toMatchObject({ Bir: 'Times-Roman', Iki: 'Times-Roman', Uc: 'Courier-Bold' });
  });

  it('substitutes Noto Sans, embedded once, for an unknown id and for text a standard face cannot spell', async () => {
    vi.stubGlobal('fetch', async () => new Response(notoRegular()));
    const out = await applyTextEdit(
      await page(),
      insertOnly([
        line('Bir', 60, 'comic-sans'),
        line('Iki', 80, 'comic-sans'),
        line('Üç Şule', 100, 'helvetica'),
        // Symbol and Zapf Dingbats are not text faces: they are never mapped.
        line('Dört', 120, 'symbol'),
      ]),
      run,
    );
    expect(notes(out, 'op.note.textEdit.fontSubstituted')).toEqual([
      { requested: 'comic-sans', font: 'Noto Sans' },
      { requested: 'helvetica', font: 'Noto Sans' },
      { requested: 'symbol', font: 'Noto Sans' },
    ]);
    expect(notes(out, 'op.note.textEdit.fontEmbedded')).toEqual([{ font: 'Noto Sans' }]);
    const fonts = await read(out.bytes);
    for (const text of ['Bir', 'Iki', 'Üç Şule', 'Dört']) {
      expect(fonts.find((entry) => entry.text === text)?.font.name).toMatch(/Noto/);
    }
  });

  describe("the document's own fonts", () => {
    const docLine = (text: string, y: number, name: string) => line(text, y, `doc:${name}`);

    it('draws with the page font when it can spell the line, embedding nothing, and substitutes when it cannot', async () => {
      const out = await applyTextEdit(
        await documentFontPage(),
        insertOnly([
          docLine('Merhaba', 60, 'Helvetica'),
          docLine('Dunya', 80, 'Helvetica'),
          {
            ...docLine('iki kelime', 100, 'Helvetica'),
            words: [
              { text: 'iki', x: 40 },
              { text: 'kelime', x: 120 },
            ],
          },
          docLine('Şule', 120, 'Helvetica'),
          docLine('Hayalet', 140, 'NoSuchFont'),
        ]),
        run,
      );
      expect(notes(out, 'op.note.textEdit.fontSubstituted')).toEqual([
        { requested: 'Helvetica', font: 'Noto Sans' },
        { requested: 'NoSuchFont', font: 'Noto Sans' },
      ]);
      const lines = await read(out.bytes);
      const fontOf = (text: string) => lines.find((entry) => entry.text === text)?.font.name;
      expect(fontOf('Merhaba')).toBe('Helvetica');
      expect(fontOf('Dunya')).toBe('Helvetica');
      expect(fontOf('Şule')).toMatch(/Noto/);
      expect(fontOf('Hayalet')).toMatch(/Noto/);
      expect(notes(out, 'op.note.textEdit.fontEmbedded')).toEqual([{ font: 'Noto Sans' }]);
    });

    it('keeps the font alive when the erase removes the last text that used it', async () => {
      const out = await applyTextEdit(
        await documentFontPage(),
        {
          erase: [
            {
              pageIndex: 0,
              rects: [
                [35, 82, 200, 104],
                [35, 182, 200, 204],
              ],
            },
          ],
          insert: [{ pageIndex: 0, lines: [docLine('Yeni', 100, 'Helvetica')] }],
          fonts: {},
        },
        run,
      );
      const lines = await read(out.bytes);
      expect(lines.map((entry) => [entry.text, entry.font.name])).toEqual([['Yeni', 'Helvetica']]);
    });
  });
});

describe('applyTextEdit font downloads', () => {
  const fonts = { 'my-face': '/fonts/my-face.ttf' };
  const request = () => insertOnly([line('Yeni', 60, 'my-face')], { fonts });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refuses to resolve a font URL without a document origin', async () => {
    vi.stubGlobal('location', undefined);
    expect(await failureOf(request())).toMatchObject({
      code: 'internal',
      details: {
        engine: 'mupdf',
        path: '/fonts/my-face.ttf',
        engineMessage: 'no document origin to resolve the font URL against',
      },
    });
  });

  it('refuses a font URL that cannot be resolved as font-missing', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost' });
    const failure = await failureOf(
      insertOnly([line('Yeni', 60, 'my-face')], { fonts: { 'my-face': 'http://[bad' } }),
    );
    expect(failure).toMatchObject({
      code: 'font-missing',
      details: { engineMessage: 'font URL cannot be resolved: http://[bad' },
    });
    expect((failure as ToolError).cause).toBeInstanceOf(TypeError);
  });

  it('refuses a font URL on another origin without requesting it', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost' });
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const failure = await failureOf(
      insertOnly([line('Yeni', 60, 'my-face')], { fonts: { 'my-face': 'https://cdn.example.com/a.ttf' } }),
    );
    expect(failure).toMatchObject({
      code: 'internal',
      details: { engineMessage: 'font URL leaves the app origin: https://cdn.example.com' },
    });
    expect(fetched).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', new Error('offline'), 'offline'],
    ['a bare value', 'blocked', 'blocked'],
  ])('reports a failed request (%s) as asset-missing', async (_name, thrown, message) => {
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('fetch', async () => {
      throw thrown;
    });
    const failure = await failureOf(request());
    expect(failure).toMatchObject({
      code: 'asset-missing',
      details: { engineMessage: `font request failed: ${message}` },
    });
    expect((failure as ToolError).cause).toBe(thrown);
  });

  it('reports a non-success response as asset-missing with its status', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 503 }));
    expect(await failureOf(request())).toMatchObject({
      code: 'asset-missing',
      details: { engineMessage: 'font asset responded 503' },
    });
  });

  it('keeps a cancellation during the download a cancellation, not a missing asset', async () => {
    vi.stubGlobal('location', { origin: 'http://localhost' });
    const controller = new AbortController();
    vi.stubGlobal('fetch', async () => {
      controller.abort();
      throw new Error('the operation was aborted');
    });
    await expect(applyTextEdit(await page(), request(), { signal: controller.signal })).rejects.toMatchObject(
      {
        name: 'AbortError',
      },
    );
  });
});

describe('applyTextEdit cancellation and progress', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => new Response(notoRegular()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const both = () => ({
    erase: [{ pageIndex: 0, rects: [[35, 82, 200, 104]] as [number, number, number, number][] }],
    insert: [{ pageIndex: 0, lines: [line('Yeni', 100, 'helvetica')] }],
    fonts: {},
  });

  it('reports every phase in order with its own counters', async () => {
    const events: string[] = [];
    await applyTextEdit(await page(), both(), {
      signal: run.signal,
      onProgress: (event) => events.push(`${event.phase}:${event.labelKey}:${event.done}/${event.total}`),
    });
    expect(events).toEqual([
      'textEdit.erase:op.progress.redact:1/1',
      'textEdit.erase:op.progress.redact.save:0/1',
      'textEdit.write:op.progress.textEdit.write:1/1',
      'textEdit.write:op.progress.textEdit.write:1/1',
      'textEdit.verify:op.progress.textEdit.verify:1/2',
      'textEdit.verify:op.progress.textEdit.verify:2/2',
    ]);
  });

  it('maps a cancellation during the erase phase to the aborted ToolError of the engine mapper', async () => {
    const controller = new AbortController();
    const failure = await applyTextEdit(await page(), both(), {
      signal: controller.signal,
      onProgress: (event) => {
        if (event.phase === 'textEdit.erase') controller.abort();
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({ code: 'aborted', details: { engine: 'mupdf' } });
  });

  it.each(['textEdit.write', 'textEdit.verify'])(
    'is cancelled as an AbortError when the signal is aborted during the %s phase',
    async (phase) => {
      const controller = new AbortController();
      await expect(
        applyTextEdit(await page(), both(), {
          signal: controller.signal,
          onProgress: (event) => {
            if (event.phase === phase) controller.abort();
          },
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    },
  );

  it('is cancelled before any work when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(applyTextEdit(await page(), both(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

/** A 400×300 page whose content stream is `content`, in the same Helvetica `/F` as `page()`. */
async function contentPage(content: string): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  doc.insertPage(0, doc.addPage([0, 0, 400, 300], 0, { Font: { F: font } }, content));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('applyTextEdit placement in reading order', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => new Response(notoRegular()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ROW =
    'BT /F 14 Tf 40 200 Td (Alpha) Tj ET BT /F 14 Tf 140 200 Td (Gamma) Tj ET BT /F 14 Tf 40 100 Td (Other) Tj ET';
  const texts = async (bytes: Uint8Array) => (await read(bytes)).map((entry) => entry.text);
  const spanned = (text: string, x: number, lineSpan: [number, number]): TextEditInsertLine => ({
    ...line(text, 100, 'helvetica'),
    x,
    lineSpan,
  });

  it('puts a replacement right after the run of its line that stands to its left', async () => {
    const out = await applyTextEdit(
      await contentPage(ROW),
      {
        erase: [{ pageIndex: 0, rects: [[135, 82, 200, 104]] }],
        insert: [{ pageIndex: 0, lines: [spanned('Delta', 140, [40, 200])] }],
        fonts: {},
      },
      run,
    );
    // Appended after the page's own stream it would read Alpha, Other, Delta.
    expect(await texts(out.bytes)).toEqual(['Alpha', 'Delta', 'Other']);
  });

  it('puts a replacement before the first run of its line when nothing of the line stands to its left', async () => {
    const out = await applyTextEdit(
      await contentPage(ROW),
      insertOnly([spanned('Zeta', 20, [20, 200])]),
      run,
    );
    expect(await texts(out.bytes)).toEqual(['ZetaAlpha', 'Gamma', 'Other']);
  });

  it('appends the replacement after the page stream when no run of its line lies inside the span', async () => {
    const out = await applyTextEdit(
      await contentPage(ROW),
      insertOnly([spanned('Omega', 300, [290, 390])]),
      run,
    );
    expect(await texts(out.bytes)).toEqual(['Alpha', 'Gamma', 'Other', 'Omega']);
  });

  it('appends the replacement when the matrix in force at its anchor cannot be inverted', async () => {
    // `0 0 0 1 0 100 cm` maps every point to x = 0: no matrix undoes it.
    const content =
      'q 0 0 0 1 0 100 cm BT /F 14 Tf 40 100 Td (Flat) Tj ET Q BT /F 14 Tf 40 50 Td (Other) Tj ET';
    const out = await applyTextEdit(
      await contentPage(content),
      insertOnly([spanned('Zed', 0, [0, 50])]),
      run,
    );
    expect((await texts(out.bytes)).at(-1)).toBe('Zed');
  });

  it.each([
    ['a text object that never closes', 'BT /F 14 Tf 40 200 Td (Alpha) Tj'],
    [
      'a text object that opens another before it closes',
      'BT /F 14 Tf 40 200 Td (Alpha) Tj BT /F 14 Tf 140 200 Td (Gamma) Tj ET',
    ],
  ])('appends the replacement after %s', async (_name, content) => {
    const out = await applyTextEdit(
      await contentPage(content),
      insertOnly([spanned('Beta', 100, [40, 200])]),
      run,
    );
    expect((await texts(out.bytes)).at(-1)).toBe('Beta');
  });

  it('refuses to report success for a page whose content stream cannot be parsed, where the new text is swallowed by its open string', async () => {
    const failure = await failureOf(
      insertOnly([spanned('Beta', 100, [40, 200])]),
      contentPage('BT /F 14 Tf 40 200 Td (Alpha) Tj ET (never closed'),
    );
    expect(failure).toMatchObject({
      code: 'verification-failed',
      details: { engineMessage: 'page 0: inserted text is not extractable: “Beta”' },
    });
  });

  it('appends the replacement to a page whose content stream uses a filter that cannot be decoded', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    const font = doc.addObject({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: 'WinAnsiEncoding',
    });
    const stream = doc.addStream('BT /F 14 Tf 40 200 Td (Alpha) Tj ET', { Filter: 'NoSuchDecode' });
    doc.insertPage(0, doc.addPage([0, 0, 400, 300], 0, { Font: { F: font } }, ''));
    doc.findPage(0).put('Contents', stream);
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const out = await applyTextEdit(bytes, insertOnly([spanned('Beta', 100, [40, 200])]), run);
    expect(await texts(out.bytes)).toContain('Beta');
  });
});

describe('applyTextEdit with edge-case text', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => new Response(notoRegular()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warns that nothing was erased when the rectangle covers no text', async () => {
    const out = await applyTextEdit(
      await page(),
      { erase: [{ pageIndex: 0, rects: [[300, 10, 390, 30]] }], insert: [], fonts: {} },
      run,
    );
    const byKey = (key: string) => out.report.notes.filter((entry) => entry.key === key);
    expect(byKey('op.note.textEdit.nothingErased')).toHaveLength(1);
    expect(byKey('op.note.textEdit.erased')[0]?.params).toMatchObject({ rects: 1, pages: 1, removed: '—' });
    expect(byKey('op.note.textEdit.verifiedErased')).toHaveLength(0);
    expect((await read(out.bytes)).map((entry) => entry.text)).toEqual(['Eski satir', 'Kalan']);
  });

  it('skips a word that has no text and draws the others where they were placed', async () => {
    const out = await applyTextEdit(
      await page(),
      insertOnly([
        {
          ...line('ab cd', 250, 'helvetica'),
          words: [
            { text: '', x: 40 },
            { text: 'ab', x: 100 },
            { text: 'cd', x: 200 },
          ],
        },
      ]),
      run,
    );
    const words = (await read(out.bytes)).filter((entry) => entry.y > 240);
    expect(words.map((entry) => [entry.text, Math.round(entry.x)])).toEqual([
      ['ab', 100],
      ['cd', 200],
    ]);
  });

  it('draws nothing for a line whose only word is empty, and still verifies the page', async () => {
    const input = await page();
    const out = await applyTextEdit(
      input,
      insertOnly([{ ...line('x', 250, 'helvetica'), words: [{ text: '', x: 40 }] }]),
      run,
    );
    expect((await read(out.bytes)).map((entry) => entry.text)).toEqual(['Eski satir', 'Kalan']);
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.textEdit.verifiedInserted');
  });

  it('accepts a line of spaces: it is drawn but there is nothing to find in it', async () => {
    const out = await applyTextEdit(await page(), insertOnly([line('   ', 250, 'helvetica')]), run);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.textEdit.rendered');
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.textEdit.verifiedInserted');
  });
});

describe('applyTextEdit remaining placement and report paths', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => new Response(notoRegular()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws a replacement under the inverse of the matrix in force at its anchor, where it was asked to be', async () => {
    // Scaled ×2: the run's user-space origin is (40, 200), i.e. baseline 100 from the top.
    const content = 'q 2 0 0 2 0 0 cm BT /F 7 Tf 20 100 Td (Scaled) Tj ET Q';
    const out = await applyTextEdit(
      await contentPage(content),
      insertOnly([{ ...line('Delta', 100, 'helvetica'), x: 150, lineSpan: [40, 200] }]),
      run,
    );
    const delta = (await read(out.bytes)).find((entry) => entry.text === 'Delta');
    expect(delta?.x).toBeCloseTo(150, 0);
    expect(delta?.y).toBeCloseTo(100, 0);
  });

  it('keeps the document order of two replacements that anchor to the same run', async () => {
    const out = await applyTextEdit(
      await contentPage('BT /F 14 Tf 40 200 Td (Alpha) Tj ET BT /F 14 Tf 40 100 Td (Other) Tj ET'),
      insertOnly([
        { ...line('Beta', 100, 'helvetica'), x: 150, lineSpan: [40, 300] },
        { ...line('Gamma', 100, 'helvetica'), x: 250, lineSpan: [40, 300] },
      ]),
      run,
    );
    const order = (await read(out.bytes)).map((entry) => entry.text).join('|');
    expect(order.indexOf('Beta')).toBeLessThan(order.indexOf('Gamma'));
  });

  it('keeps a page font in place when the erase leaves another line using it', async () => {
    const out = await applyTextEdit(
      await documentFontPage(),
      {
        erase: [{ pageIndex: 0, rects: [[35, 82, 200, 104]] }],
        insert: [{ pageIndex: 0, lines: [line('Yeni', 100, 'doc:Helvetica')] }],
        fonts: {},
      },
      run,
    );
    expect((await read(out.bytes)).map((entry) => [entry.text, entry.font.name])).toEqual([
      ['Kalan', 'Helvetica'],
      ['Yeni', 'Helvetica'],
    ]);
  });

  it('clips a very long erased text in the report to one line of interface text', async () => {
    const long = 'abcdefghij '.repeat(25).trim();
    const out = await applyTextEdit(
      await contentPage(`BT /F 4 Tf 5 200 Td (${long}) Tj ET`),
      { erase: [{ pageIndex: 0, rects: [[0, 80, 400, 104]] }], insert: [], fonts: {} },
      run,
    );
    const removed = out.report.notes.find((entry) => entry.key === 'op.note.textEdit.erased')?.params
      ?.removed;
    expect(typeof removed).toBe('string');
    expect(String(removed)).toHaveLength(160);
    expect(String(removed).endsWith('…')).toBe(true);
    expect(String(removed).startsWith('abcdefghij')).toBe(true);
  });

  it('treats a glyph with no extent as not covered and erases nothing', async () => {
    const out = await applyTextEdit(
      await contentPage('BT /F 14 Tf 0 Tz 40 200 Td (Zero) Tj ET'),
      { erase: [{ pageIndex: 0, rects: [[35, 82, 200, 104]] }], insert: [], fonts: {} },
      run,
    );
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.textEdit.nothingErased');
  });
});
