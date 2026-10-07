/**
 * Font metric tables for the text engine (`text-source.ts > readFontMetrics`), read with
 * the engine that embeds the same bytes (MuPDF) plus the font header.
 *
 * The expected numbers are what `@pdf-lib/fontkit` 1.1.1 — the parser these tables came
 * from before — reported for the same files (measured 2026-10-04, before it was
 * removed): an independent reader, so a change in how advances are scaled or rounded,
 * or in which header table the vertical metrics come from, shows up here as a number.
 * The wrong answers that matter: an advance in em instead of font units, a rounding that
 * moves one glyph by a unit (and with it every line break after it), a covered Turkish
 * letter reported missing, and an unreadable programme let through as an empty table.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf } from './engines/mupdf';
import {
  loadFontMetrics,
  loadTextFonts,
  readDocumentText,
  readFontMetrics,
  readPageText,
  TEXT_FONT_CANDIDATES,
  TEXT_FONT_FILES,
} from './text-source';

function noto(file: string): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  return new Uint8Array(
    readFileSync(require.resolve(`@expo-google-fonts/noto-sans/${file}`, { paths: [process.cwd()] })),
  );
}

const advances = (metrics: Awaited<ReturnType<typeof readFontMetrics>>, text: string) =>
  Object.fromEntries(
    [...text].map((character) => [character, metrics.glyphAdvance(character.codePointAt(0) ?? 0)]),
  );

describe('readFontMetrics', () => {
  it('reads Noto Sans Regular as fontkit did: header, advances in font units, coverage', async () => {
    const metrics = await readFontMetrics(noto('400Regular/NotoSans_400Regular.ttf'), 'noto-regular');
    expect([metrics.unitsPerEm, metrics.ascender, metrics.descender, metrics.lineGap]).toEqual([
      1000, 1069, -293, 0,
    ]);
    expect(advances(metrics, 'AW şİğıÖ€')).toEqual({
      A: 639,
      W: 930,
      ' ': 260,
      ş: 479,
      İ: 339,
      ğ: 615,
      ı: 258,
      Ö: 781,
      '€': 572,
    });
    for (const character of 'şŞğĞıİöÖüÜçÇ')
      expect(metrics.hasGlyph(character.codePointAt(0) ?? 0)).toBe(true);
    // A code point the face does not cover: no glyph, and the `.notdef` advance.
    expect(metrics.hasGlyph(0x4e00)).toBe(false);
    expect(metrics.glyphAdvance(0x10ffff)).toBe(600);
    expect(metrics.missing).toEqual([]);
  });

  it('reads Noto Sans SemiBold as fontkit did', async () => {
    const metrics = await readFontMetrics(noto('600SemiBold/NotoSans_600SemiBold.ttf'), 'noto-semibold');
    expect([metrics.unitsPerEm, metrics.ascender, metrics.descender, metrics.lineGap]).toEqual([
      1000, 1069, -293, 0,
    ]);
    expect(advances(metrics, 'AW şİğıÖ€')).toEqual({
      A: 672,
      W: 953,
      ' ': 260,
      ş: 493,
      İ: 370,
      ğ: 626,
      ı: 283,
      Ö: 787,
      '€': 572,
    });
    expect(metrics.glyphAdvance(0x10ffff)).toBe(593);
  });

  it('refuses bytes that are not a font programme instead of returning an empty table', async () => {
    const notAFont = new TextEncoder().encode('%PDF-1.7 this is not a font programme at all');
    await expect(readFontMetrics(notAFont, 'broken.ttf')).rejects.toMatchObject({ code: 'unsupported' });
  });
});

const run = { signal: new AbortController().signal };

/** One page per content stream, 200×200 pt, Helvetica as `/F`. */
async function pages(...contents: string[]): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const helvetica = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
  for (const content of contents) {
    doc.insertPage(-1, doc.addPage([0, 0, 200, 200], 0, { Font: { F: helvetica } }, content));
  }
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

const text = (block: { lines: readonly { chars: readonly { ch: string }[] }[] }): string[] =>
  block.lines.map((line) => line.chars.map((char) => char.ch).join(''));

/** Noto Sans whose directory states a shorter `hhea` table than the header reader needs; MuPDF still loads it. */
function withShortHheaTable(): Uint8Array {
  const bytes = noto('400Regular/NotoSans_400Regular.ttf');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < view.getUint16(4); index += 1) {
    const record = 12 + index * 16;
    if (String.fromCharCode(...bytes.subarray(record, record + 4)) === 'hhea')
      view.setUint32(record + 12, 20);
  }
  return bytes;
}

describe('readFontMetrics failures', () => {
  it("keeps the header reader's own ToolError for a programme MuPDF loads but whose header is unreadable", async () => {
    const failure = await readFontMetrics(withShortHheaTable(), 'short-hhea.ttf').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ToolError);
    expect(failure).toMatchObject({
      code: 'unsupported',
      details: { engine: 'pdf-text-engine', engineMessage: "font header: the 'hhea' table is truncated" },
    });
  });
});

describe('readPageText', () => {
  it('reads the page box, the characters with their face and size, the baseline and the glyph colour', async () => {
    const bytes = await pages('1 0 0 rg BT /F 12 Tf 10 100 Td (Hi) Tj ET');
    const page = await readPageText(bytes, 0, run);
    expect([page.pageIndex, page.width, page.height, page.rotation]).toEqual([0, 200, 200, 0]);
    expect(page.blocks).toHaveLength(1);
    const line = page.blocks[0]?.lines[0];
    expect(line?.chars.map((char) => [char.ch, char.size, char.fontName, char.color])).toEqual([
      ['H', 12, 'Helvetica', '#ff0000'],
      ['i', 12, 'Helvetica', '#ff0000'],
    ]);
    // The baseline is the first glyph's origin, flipped to the model's top-left axis.
    expect(line?.baseline).toBe(100);
    expect(line?.chars[0]?.origin).toEqual([10, 100]);
    expect(page.colors).toEqual({ 0: '#ff0000' });
  });

  it('colours a block with the colour most of its non-space glyphs were drawn with', async () => {
    const bytes = await pages('BT /F 12 Tf 10 100 Td 1 0 0 rg (A) Tj 0 0 1 rg (B B B) Tj ET');
    const page = await readPageText(bytes, 0, run);
    expect(page.blocks).toHaveLength(1);
    expect(text(page.blocks[0] ?? { lines: [] })).toEqual(['AB B B']);
    expect(page.colors).toEqual({ 0: '#0000ff' });
  });

  it('gives a whitespace-only block the page dominant colour from pdf.js and leaves a coloured block its own', async () => {
    const bytes = await pages(
      [
        '1 0 0 rg BT /F 12 Tf 10 180 Td (First) Tj ET',
        '0 0 1 rg BT /F 12 Tf 10 120 Td (   ) Tj ET',
        '1 0 0 rg BT /F 12 Tf 10 60 Td (Last) Tj ET',
      ].join('\n'),
    );
    const page = await readPageText(bytes, 0, run);
    expect(page.blocks.map(text)).toEqual([['First'], ['   '], ['Last']]);
    // Text operators: two under red, one under blue — red is the page's colour, so the blue
    // spaces (which carry no ink of their own to count) get it, and the glyph blocks keep theirs.
    expect(page.colors).toEqual({ 0: '#ff0000', 1: '#ff0000', 2: '#ff0000' });
  });

  it.each<90 | 180 | 270>([90, 180, 270])(
    'reports a page rotated by %s degrees in unrotated user space, the same geometry the unrotated page gives',
    async (rotation) => {
      const mupdf = await loadMupdf();
      const read = async (rotate: 0 | 90 | 180 | 270) => {
        const doc = new mupdf.PDFDocument();
        const helvetica = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
        const content = 'BT /F 12 Tf 10 50 Td (Hi) Tj ET';
        doc.insertPage(0, doc.addPage([0, 0, 300, 200], rotate, { Font: { F: helvetica } }, content));
        const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
        doc.destroy();
        return readPageText(bytes, 0, run);
      };
      const upright = await read(0);
      const turned = await read(rotation);
      expect([turned.width, turned.height, turned.rotation]).toEqual([300, 200, rotation]);
      const [uprightLine, turnedLine] = [upright.blocks[0]?.lines[0], turned.blocks[0]?.lines[0]];
      // A 300×200 page with the text 50 pt above the bottom: 150 pt below the top.
      expect(uprightLine?.baseline).toBeCloseTo(150, 3);
      expect(turnedLine?.baseline).toBeCloseTo(150, 3);
      for (const [index, expected] of (uprightLine?.chars ?? []).entries()) {
        const actual = turnedLine?.chars[index];
        expect(actual?.ch).toBe(expected.ch);
        expect(actual?.origin[0]).toBeCloseTo(expected.origin[0], 3);
        expect(actual?.origin[1]).toBeCloseTo(expected.origin[1], 3);
        for (const side of [0, 1, 2, 3] as const) {
          expect(actual?.quad[side]).toBeCloseTo(expected.quad[side], 3);
        }
      }
      expect(uprightLine?.chars[0]?.origin).toEqual([10, 150]);
    },
  );

  it('reports no blocks and no colours for a page without text', async () => {
    const page = await readPageText(await pages('0 0 10 10 re f'), 0, run);
    expect(page.blocks).toEqual([]);
    expect(page.colors).toEqual({});
  });

  it.each([-1, 1, 0.5, Number.NaN])(
    'refuses page index %s with range-invalid, naming the page count',
    async (index) => {
      const bytes = await pages('BT /F 12 Tf 10 100 Td (x) Tj ET');
      const failure = await readPageText(bytes, index, run).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ToolError);
      expect(failure).toMatchObject({
        code: 'range-invalid',
        details: { engine: 'mupdf', pageIndex: index, engineMessage: `page ${index} of 1` },
      });
    },
  );

  it('is cancelled by an aborted signal with the AbortError shape, before any engine work', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readPageText(await pages('BT /F 12 Tf 10 100 Td (x) Tj ET'), 0, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('readDocumentText', () => {
  it('reads the chosen pages through one document, reporting progress after each', async () => {
    const bytes = await pages(
      '1 0 0 rg BT /F 12 Tf 10 100 Td (One) Tj ET',
      'BT /F 12 Tf 10 100 Td (Two) Tj ET',
      '0 0 1 rg BT /F 12 Tf 10 100 Td (Three) Tj ET',
    );
    const progress: [number, number][] = [];
    const read = await readDocumentText(bytes, [2, 0], run, (done, total) => progress.push([done, total]));
    expect(read.map((page) => [page.pageIndex, page.blocks.flatMap(text), page.colors])).toEqual([
      [2, ['Three'], { 0: '#0000ff' }],
      [0, ['One'], { 0: '#ff0000' }],
    ]);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('leaves a whitespace-only block without a colour instead of asking pdf.js', async () => {
    const bytes = await pages('1 0 0 rg BT /F 12 Tf 10 100 Td (   ) Tj ET');
    const [page] = await readDocumentText(bytes, [0], run);
    expect(page?.blocks.flatMap(text)).toEqual(['   ']);
    expect(page?.colors).toEqual({});
  });

  it('stops at the next page when the signal is aborted from the progress callback', async () => {
    const bytes = await pages('BT /F 12 Tf 10 100 Td (A) Tj ET', 'BT /F 12 Tf 10 100 Td (B) Tj ET');
    const controller = new AbortController();
    const seen: number[] = [];
    await expect(
      readDocumentText(bytes, [0, 1], { signal: controller.signal }, (done) => {
        seen.push(done);
        controller.abort();
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual([1]);
  });

  it('refuses a page outside the document with range-invalid and releases the document', async () => {
    const bytes = await pages('BT /F 12 Tf 10 100 Td (A) Tj ET');
    await expect(readDocumentText(bytes, [0, 3], run)).rejects.toMatchObject({
      code: 'range-invalid',
      details: { pageIndex: 3, engineMessage: 'page 3 of 1' },
    });
  });

  it('is cancelled before engine work by an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readDocumentText(await pages('BT /F 12 Tf 10 100 Td (A) Tj ET'), [0], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('font loading', () => {
  const regular = noto('400Regular/NotoSans_400Regular.ttf');
  const semiBold = noto('600SemiBold/NotoSans_600SemiBold.ttf');
  const served = async (input: unknown) =>
    new Response(String(input).includes('SemiBold') ? semiBold : regular);

  beforeEach(() => {
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal('fetch', served);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const failureOf = (files: Record<string, string>) =>
    loadFontMetrics(files).catch((error: unknown) => error);

  it('fetches each served file from the document origin and reads its metric table', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: URL) => {
      requested.push(input.href);
      return served(input);
    });
    const metrics = await loadFontMetrics(TEXT_FONT_FILES);
    expect(Object.keys(metrics)).toEqual(['noto-sans', 'noto-sans-semibold']);
    expect(requested).toEqual(
      Object.values(TEXT_FONT_FILES).map((path) => new URL(path, 'http://localhost').href),
    );
    expect(metrics['noto-sans']?.glyphAdvance(0x41)).toBe(639);
    expect(metrics['noto-sans-semibold']?.glyphAdvance(0x41)).toBe(672);
  });

  it('refuses to resolve a font URL when there is no document origin', async () => {
    vi.stubGlobal('location', undefined);
    expect(await failureOf({ x: '/fonts/a.ttf' })).toMatchObject({
      code: 'internal',
      details: {
        engine: 'fonts',
        path: '/fonts/a.ttf',
        engineMessage: 'no document origin to resolve the font URL against',
      },
    });
  });

  it('refuses a path that is not a URL as font-missing', async () => {
    const failure = await failureOf({ x: 'http://[broken' });
    expect(failure).toMatchObject({
      code: 'font-missing',
      details: { engine: 'fonts', engineMessage: 'font URL cannot be resolved: http://[broken' },
    });
    expect((failure as ToolError).cause).toBeInstanceOf(TypeError);
  });

  it('refuses an absolute URL that leaves the app origin without requesting it', async () => {
    const fetched = vi.fn(served);
    vi.stubGlobal('fetch', fetched);
    expect(await failureOf({ x: 'https://fonts.example.com/a.ttf' })).toMatchObject({
      code: 'internal',
      details: { engineMessage: 'font URL leaves the app origin: https://fonts.example.com' },
    });
    expect(fetched).not.toHaveBeenCalled();
  });

  it.each([
    ['an Error', new Error('offline'), 'offline'],
    ['a bare value', 'blocked', 'blocked'],
  ])('reports a failed request (%s) as asset-missing with its message', async (_name, thrown, message) => {
    vi.stubGlobal('fetch', async () => {
      throw thrown;
    });
    const failure = await failureOf({ x: '/fonts/a.ttf' });
    expect(failure).toMatchObject({
      code: 'asset-missing',
      details: { engine: 'fonts', engineMessage: `font request failed: ${message}` },
    });
    expect((failure as ToolError).cause).toBe(thrown);
  });

  it('reports a non-success response as asset-missing with its status', async () => {
    vi.stubGlobal('fetch', async () => new Response('gone', { status: 404 }));
    expect(await failureOf({ x: '/fonts/a.ttf' })).toMatchObject({
      code: 'asset-missing',
      details: { engineMessage: 'font asset responded 404' },
    });
  });

  it('refuses a served file that is not a font programme', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>not a font</html>'));
    expect(await failureOf({ x: '/fonts/a.ttf' })).toMatchObject({ code: 'unsupported' });
  });

  it('builds the catalogue over the two faces once per session, and does not remember a failure', async () => {
    vi.stubGlobal('fetch', async () => new Response('missing', { status: 503 }));
    await expect(loadTextFonts()).rejects.toMatchObject({ code: 'asset-missing' });

    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: URL) => {
      requested.push(input.pathname);
      return served(input);
    });
    const fonts = await loadTextFonts();
    expect(requested).toHaveLength(2);
    expect(fonts.catalog.candidates).toBe(TEXT_FONT_CANDIDATES);
    expect(TEXT_FONT_CANDIDATES.map((candidate) => candidate.id)).toEqual([
      'noto-sans',
      'noto-sans-semibold',
    ]);
    const [regularFace, boldFace] = TEXT_FONT_CANDIDATES;
    expect(regularFace && fonts.catalog.metrics?.(regularFace)).toBe(fonts.metrics['noto-sans']);
    expect(boldFace && fonts.catalog.metrics?.(boldFace)).toBe(fonts.metrics['noto-sans-semibold']);
    // A face that is not one of ours has no table.
    expect(
      fonts.catalog.metrics?.({
        id: 'other',
        family: 'serif',
        bold: false,
        italic: false,
        filePath: '/o.ttf',
      }),
    ).toBeNull();

    // The second call is the cached set: nothing more is fetched.
    expect(await loadTextFonts()).toBe(fonts);
    expect(requested).toHaveLength(2);
  });
});
