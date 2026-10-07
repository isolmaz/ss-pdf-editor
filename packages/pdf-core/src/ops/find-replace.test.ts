/**
 * Find and replace against real bytes, re-read with MuPDF's own text extraction. The
 * wrong answers that matter: old text that survives the erase, a replacement that
 * contains the old text (`2024` → `2024–2025`) mistaken for a leftover or replaced
 * twice, Turkish `İ`/`ı` folded together so `sık` and `sik` become one word, a
 * whole-word search that cuts into a longer word, text that cannot be edited (rotated)
 * silently ignored instead of counted and reported, and a replacement drawn in another
 * face than the page's own when the page's own can draw it.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { PDFDocument } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { embedNotoSans, subsetEmbeddedFaces } from '../engines/mupdf-write';
import { type FindReplaceOptions, findReplace } from './find-replace';

const run = { signal: new AbortController().signal };

function noto(file: string): Uint8Array<ArrayBuffer> {
  const resolved = createRequire(import.meta.url).resolve(`@expo-google-fonts/noto-sans/${file}`, {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(resolved));
}

interface Line {
  readonly text: string;
  /** Baseline height above the page's bottom edge. */
  readonly y: number;
  /** Rotation of the line in degrees; `0` for ordinary text. */
  readonly angle?: number;
}

/** A 500×400 page with each line in embedded Noto Sans at 14 pt, one block per line. */
async function page(lines: readonly Line[]): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const face = await embedNotoSans(mupdf, doc);
  const content = lines
    .map((line) => {
      const radians = ((line.angle ?? 0) * Math.PI) / 180;
      const [cos, sin] = [Math.cos(radians), Math.sin(radians)];
      return `BT /F 14 Tf ${cos} ${sin} ${-sin} ${cos} 40 ${line.y} Tm ${face.encode(line.text)} Tj ET`;
    })
    .join('\n');
  doc.insertPage(0, doc.addPage([0, 0, 500, 400], 0, { Font: { F: face.ref } }, content));
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

/** A US Letter page drawing `content` with Helvetica as `/F`. */
async function helveticaPage(content: string): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const helvetica = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
  doc.insertPage(0, doc.addPage([0, 0, 612, 792], 0, { Font: { F: helvetica } }, content));
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

/** The page's text lines in content-stream order, as PDFium and screen readers read them. */
async function streamLines(bytes: Uint8Array): Promise<string[]> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return doc
      .loadPage(0)
      .toStructuredText('preserve-whitespace')
      .asText()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } finally {
    doc.destroy();
  }
}

/**
 * What a reader shows, top to bottom: MuPDF's lines grouped by baseline and joined left to
 * right (a replaced word is drawn after the old content, so extraction order is not
 * reading order), and the distinct fonts they are drawn with.
 */
async function read(bytes: Uint8Array) {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const json = JSON.parse(doc.loadPage(0).toStructuredText('preserve-whitespace').asJSON()) as {
      blocks: {
        lines?: { text: string; bbox: { x: number; y: number; h: number }; font: { name: string } }[];
      }[];
    };
    const lines = json.blocks
      .flatMap((block) => block.lines ?? [])
      .map((line) => ({ ...line, middle: line.bbox.y + line.bbox.h / 2 }))
      .sort((left, right) => left.middle - right.middle || left.bbox.x - right.bbox.x);
    const rows: (typeof lines)[] = [];
    for (const line of lines) {
      const row = rows.at(-1);
      if (row !== undefined && Math.abs((row[0]?.middle ?? 0) - line.middle) < 6) row.push(line);
      else rows.push([line]);
    }
    for (const row of rows) row.sort((left, right) => left.bbox.x - right.bbox.x);
    return {
      texts: rows.map((row) => row.map((line) => line.text).join('')),
      fonts: [...new Set(lines.map((line) => line.font.name))],
    };
  } finally {
    doc.destroy();
  }
}

const query = (patch: Partial<FindReplaceOptions> & Pick<FindReplaceOptions, 'find' | 'replace'>) => ({
  matchCase: false,
  wholeWord: false,
  pages: [0],
  ...patch,
});

describe('findReplace', () => {
  beforeEach(() => {
    const regular = noto('400Regular/NotoSans_400Regular.ttf');
    const semiBold = noto('600SemiBold/NotoSans_600SemiBold.ttf');
    vi.stubGlobal('location', { origin: 'http://localhost' });
    vi.stubGlobal(
      'fetch',
      async (input: unknown) => new Response(String(input).includes('SemiBold') ? semiBold : regular),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('replaces a word in place and moves the rest of the line when the new word is longer', async () => {
    const input = await page([
      { text: 'Merhaba Eski dünya', y: 330 },
      { text: 'Başka bir satır', y: 250 },
    ]);
    const out = await findReplace(input, query({ find: 'Eski', replace: 'Çok daha uzun yeni' }), run);
    expect(out.replaced).toBe(1);
    const after = await read(out.bytes);
    expect(after.texts).toEqual(['Merhaba Çok daha uzun yeni dünya', 'Başka bir satır']);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.findReplace.replaced');
  });

  it('keeps stream reading order and reports no overflow when a shorter word replaces a longer one', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const helvetica = doc.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin');
    const lines = [1, 2, 3].map((k) => `Line ${k} of Page 1 - the quick brown fox jumps`);
    const content = [
      `BT /F 18 Tf 1 0 0 1 72 740 Tm (Title of the page) Tj ET`,
      ...lines.map((text, index) => `BT /F 12 Tf 1 0 0 1 72 ${700 - index * 24} Tm (${text}) Tj ET`),
    ].join('\n');
    doc.insertPage(0, doc.addPage([0, 0, 612, 792], 0, { Font: { F: helvetica } }, content));
    const input = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    doc.destroy();

    const out = await findReplace(input, query({ find: 'quick', replace: 'slow' }), run);
    expect(out.replaced).toBe(3);
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.findReplace.moved');

    // Stream order, as PDFium and screen readers read it: no sorting by geometry here.
    const reread = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      const streamText = reread
        .loadPage(0)
        .toStructuredText('preserve-whitespace')
        .asText()
        .replace(/\s+/g, '');
      expect(streamText).toBe(
        `Titleofthepage${lines.map((text) => text.replace('quick', 'slow').replace(/\s+/g, '')).join('')}`,
      );
    } finally {
      reread.destroy();
    }
  });

  it('keeps a column whole when the match starts a line of the column beside it', async () => {
    const left = [1, 2, 3].map((k) => `Left column line ${k} text`);
    const right = [1, 2, 3].map((k) => `quick right column ${k} words`);
    const input = await helveticaPage(
      [
        ...left.map((text, index) => `BT /F 12 Tf 1 0 0 1 72 ${700 - index * 24} Tm (${text}) Tj ET`),
        ...right.map((text, index) => `BT /F 12 Tf 1 0 0 1 330 ${700 - index * 24} Tm (${text}) Tj ET`),
      ].join('\n'),
    );
    const out = await findReplace(input, query({ find: 'quick', replace: 'slow', matchCase: true }), run);
    expect(out.replaced).toBe(3);
    // The right column's lines have nothing of their own left of the match: a left-column
    // line on the same baseline is not theirs to follow, or the columns read interleaved.
    expect(await streamLines(out.bytes)).toEqual([
      ...left,
      ...right.map((text) => text.replace('quick', 'slow')),
    ]);
  });

  it('draws spliced text where it belongs under a scaled matrix, in stream order', async () => {
    const lines = [1, 2, 3].map((k) => `Line ${k} the quick brown fox`);
    // Half-scale CTM, text coordinates doubled: the page shows the lines at x = 72.
    const input = await helveticaPage(
      `q 0.5 0 0 0.5 0 0 cm ${lines
        .map((text, index) => `BT /F 24 Tf 1 0 0 1 144 ${1400 - index * 48} Tm (${text}) Tj ET`)
        .join(' ')} Q`,
    );
    const out = await findReplace(input, query({ find: 'quick', replace: 'quickest', matchCase: true }), run);
    expect(out.replaced).toBe(3);
    const expected = lines.map((text) => text.replace('quick', 'quickest'));
    expect(await streamLines(out.bytes)).toEqual(expected);
    // Each line still starts at the page's x = 72 and keeps its baseline: the splice undid the
    // scale in force where it landed, and drew nothing twice the size or off the line.
    const mupdf = await loadMupdf();
    const reread = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      const json = JSON.parse(reread.loadPage(0).toStructuredText('preserve-whitespace').asJSON()) as {
        blocks: { lines?: { text: string; bbox: { x: number; y: number } }[] }[];
      };
      const boxes = json.blocks.flatMap((block) => block.lines ?? []);
      expect(boxes.map((line) => [line.text.trim(), Math.round(line.bbox.x)])).toEqual(
        expected.map((text) => [text, 72]),
      );
    } finally {
      reread.destroy();
    }
  });

  it('verifies a replacement that contains the old text: 2024 becomes 2024–2025 once per match', async () => {
    const input = await page([
      { text: 'Dönem 2024 raporu', y: 330 },
      { text: 'Bütçe 2024 yılı', y: 250 },
    ]);
    const out = await findReplace(input, query({ find: '2024', replace: '2024–2025' }), run);
    expect(out.replaced).toBe(2);
    expect((await read(out.bytes)).texts).toEqual(['Dönem 2024–2025 raporu', 'Bütçe 2024–2025 yılı']);
  });

  it('keeps Turkish İ and ı apart when case does not count', async () => {
    const input = await page([
      { text: 'İstanbul', y: 340 },
      { text: 'ISPARTA', y: 300 },
      { text: 'sık', y: 260 },
      { text: 'sik', y: 220 },
    ]);
    const replaceOnly = async (find: string, replace: string, matchCase = false) => {
      const out = await findReplace(input, query({ find, replace, matchCase }), run);
      return { replaced: out.replaced, texts: (await read(out.bytes)).texts };
    };
    // `İ` folds to i, so a lower-case Latin search finds it.
    expect((await replaceOnly('istanbul', 'Ankara')).texts).toEqual(['Ankara', 'ISPARTA', 'sık', 'sik']);
    // `I` is either i or ı, so it matches a Turkish dotless search and a Latin one alike.
    expect((await replaceOnly('ısparta', 'Konya')).texts).toEqual(['İstanbul', 'Konya', 'sık', 'sik']);
    expect((await replaceOnly('isparta', 'Konya')).texts).toEqual(['İstanbul', 'Konya', 'sık', 'sik']);
    // `ı` is not `i`: `sik` finds only the dotted word, `sık` only the dotless one.
    expect((await replaceOnly('sik', 'x')).texts).toEqual(['İstanbul', 'ISPARTA', 'sık', 'x']);
    expect((await replaceOnly('sık', 'x')).texts).toEqual(['İstanbul', 'ISPARTA', 'x', 'sik']);
    // A capital `I` in the search is either, so both words match.
    expect((await replaceOnly('SIK', 'x')).replaced).toBe(2);
    // With case counting, `isparta` is not `ISPARTA`.
    await expect(
      findReplace(input, query({ find: 'isparta', replace: 'x', matchCase: true }), run),
    ).rejects.toMatchObject({
      code: 'no-match',
    });
  });

  it('matches whole words only on request', async () => {
    const input = await page([{ text: 'kar karar kar. skar', y: 330 }]);
    const whole = await findReplace(input, query({ find: 'kar', replace: 'yağ', wholeWord: true }), run);
    expect(whole.replaced).toBe(2);
    expect((await read(whole.bytes)).texts).toEqual(['yağ karar yağ. skar']);
    const any = await findReplace(input, query({ find: 'kar', replace: 'yağ' }), run);
    expect(any.replaced).toBe(4);
  });

  it('counts and reports a match in rotated text instead of editing it, and refuses when nothing else matches', async () => {
    const input = await page([
      { text: 'Merhaba dünya', y: 330 },
      { text: 'Merhaba eğik', y: 120, angle: 35 },
    ]);
    const out = await findReplace(input, query({ find: 'Merhaba', replace: 'Selam' }), run);
    expect(out.replaced).toBe(1);
    const skipped = out.report.notes.find((entry) => entry.key === 'op.note.findReplace.skipped');
    expect(skipped?.kind).toBe('lost');
    expect(skipped?.params).toMatchObject({ count: 1 });
    const texts = (await read(out.bytes)).texts;
    expect(texts).toContain('Selam dünya');
    expect(texts.some((text) => text.includes('Merhaba eğik'))).toBe(true);

    const onlyRotated = await page([{ text: 'Merhaba eğik', y: 120, angle: 35 }]);
    await expect(
      findReplace(onlyRotated, query({ find: 'Merhaba', replace: 'Selam' }), run),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('draws the replacement with the page’s own font when it can, and says so', async () => {
    const input = await page([
      { text: 'Eski ürün', y: 330 },
      { text: 'Yeni sayfa', y: 250 },
    ]);
    const before = await read(input);
    const own = await findReplace(input, query({ find: 'ürün', replace: 'Yeni' }), run);
    const after = await read(own.bytes);
    expect(after.texts).toEqual(['Eski Yeni', 'Yeni sayfa']);
    expect(after.fonts).toEqual(before.fonts);
    expect(own.report.notes.map((entry) => entry.key)).toContain('op.note.findReplace.ownFont');
    // `Ğ` was never drawn with the page's font, so it cannot be claimed as the page's own.
    const substituted = await findReplace(input, query({ find: 'ürün', replace: 'Ğ' }), run);
    expect(substituted.report.notes.map((entry) => entry.key)).not.toContain('op.note.findReplace.ownFont');
    expect((await read(substituted.bytes)).texts[0]).toBe('Eski Ğ');
  });

  it('claims the page’s own font only for glyphs that font object drew, even under a shared subset name', async () => {
    const lines = ['Eski urun', 'Yeni zzz'];
    /**
     * Each line on its own page in Noto Sans subset to the glyphs that document drew, and
     * the subset named `ABCDEE+NotoSans` (as two files from one producer can be).
     */
    const subsetPages = async (texts: readonly string[]): Promise<PDFDocument> => {
      const mupdf = await loadMupdf();
      const doc = new mupdf.PDFDocument();
      const face = await embedNotoSans(mupdf, doc);
      for (const text of texts) {
        const content = `BT /F 14 Tf 40 330 Td ${face.encode(text)} Tj ET`;
        doc.insertPage(-1, doc.addPage([0, 0, 500, 400], 0, { Font: { F: face.ref } }, content));
      }
      subsetEmbeddedFaces(mupdf, doc, [face]);
      const type0 = face.ref.resolve();
      const descendant = type0.get('DescendantFonts').resolve().get(0).resolve();
      for (const [dict, key] of [
        [type0, 'BaseFont'],
        [descendant, 'BaseFont'],
        [descendant.get('FontDescriptor').resolve(), 'FontName'],
      ] as const) {
        dict.put(key, doc.newName('ABCDEE+NotoSans'));
      }
      return doc;
    };
    const save = (doc: PDFDocument): Uint8Array => {
      const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
      doc.destroy();
      return bytes;
    };
    // Two files merged: two font objects, two subsets, one name.
    const merged = new (await loadMupdf()).PDFDocument();
    for (const text of lines) {
      const part = await subsetPages([text]);
      merged.graftPage(-1, part, 0);
      part.destroy();
    }
    const twoSubsets = save(merged);
    // One file: one font object drawing both pages.
    const oneFont = save(await subsetPages(lines));
    const replace = query({ find: 'urun', replace: 'zzz', pages: [0, 1], matchCase: true });

    // Page 2's subset drew `z`; page 1's has no `z`, so a substitute draws the new word.
    const substituted = await findReplace(twoSubsets, replace, run);
    expect(substituted.replaced).toBe(1);
    expect(substituted.report.notes.map((entry) => entry.key)).not.toContain('op.note.findReplace.ownFont');
    expect((await read(substituted.bytes)).texts[0]).toBe('Eski zzz');
    // One font object on both pages: what it drew on page 2 is in the program page 1 uses.
    const shared = await findReplace(oneFont, replace, run);
    expect(shared.report.notes.map((entry) => entry.key)).toContain('op.note.findReplace.ownFont');
    expect((await read(shared.bytes)).texts[0]).toBe('Eski zzz');
  });

  it('refuses an empty search and a search with no match', async () => {
    const input = await page([{ text: 'Merhaba', y: 330 }]);
    await expect(findReplace(input, query({ find: '   ', replace: 'x' }), run)).rejects.toMatchObject({
      code: 'value-out-of-range',
    });
    await expect(findReplace(input, query({ find: 'yok', replace: 'x' }), run)).rejects.toMatchObject({
      code: 'no-match',
    });
    // Matches that already read as the replacement are not a change.
    await expect(
      findReplace(input, query({ find: 'Merhaba', replace: 'Merhaba' }), run),
    ).rejects.toMatchObject({
      code: 'no-match',
    });
  });
});
