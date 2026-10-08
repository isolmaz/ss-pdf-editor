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
import { buildTextPage, type TextPage } from 'pdf-text-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { embedNotoSans, subsetEmbeddedFaces } from '../engines/mupdf-write';
import { loadTextFonts, readDocumentText } from '../text-source';
import { documentFaces, type FindReplaceOptions, findReplace } from './find-replace';

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

describe('findReplace', () => {
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

interface Run {
  readonly text: string;
  readonly x: number;
  /** Baseline height above the page's bottom edge. */
  readonly y: number;
  /** The font resource name; `F` unless given. */
  readonly font?: string;
  readonly size?: number;
  /** Word spacing (`Tw`), to justify a line. */
  readonly spacing?: number;
  /** A fill colour operator, e.g. `1 0 0 rg`. */
  readonly fill?: string;
  /** `text` is already the body of a PDF string (with its own escapes, e.g. `\205`). */
  readonly encoded?: boolean;
}

/** A US Letter page drawing every run at its own matrix, in one text object. */
async function typeset(
  runs: readonly Run[],
  fonts: Readonly<Record<string, string>> = { F: 'Helvetica' },
): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const resources: Record<string, ReturnType<typeof doc.addSimpleFont>> = {};
  for (const [name, face] of Object.entries(fonts)) {
    resources[name] = doc.addSimpleFont(new mupdf.Font(face), 'Latin');
  }
  const content = [
    'BT',
    ...runs.map(
      (run) =>
        `${run.fill ?? '0 g'} /${run.font ?? 'F'} ${run.size ?? 12} Tf ${run.spacing ?? 0} Tw 1 0 0 1 ${run.x} ${run.y} Tm (${run.encoded === true ? run.text : run.text.replace(/[\\()]/g, '\\$&')}) Tj`,
    ),
    'ET',
  ].join('\n');
  doc.insertPage(0, doc.addPage([0, 0, 612, 792], 0, { Font: resources }, content));
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

/** The text lines of a paragraph set at `leading`, first baseline at `y`. */
function paragraph(texts: readonly string[], x = 72, y = 700, leading = 14): Run[] {
  return texts.map((text, index) => ({ text, x, y: y - index * leading }));
}

/** The advance width of `text` in a standard face, in points. */
async function widthOf(text: string, size: number, face = 'Helvetica'): Promise<number> {
  const mupdf = await loadMupdf();
  const font = new mupdf.Font(face);
  let width = 0;
  for (const character of text) {
    width += font.advanceGlyph(font.encodeCharacter(character.codePointAt(0) ?? 0), 0);
  }
  return width * size;
}

interface Row {
  /** The row's text, left to right, whitespace collapsed. */
  readonly text: string;
  readonly left: number;
  readonly right: number;
  readonly fonts: readonly string[];
}

/** What the page shows, top to bottom: MuPDF's lines grouped by baseline into rows. */
async function rows(bytes: Uint8Array): Promise<Row[]> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const json = JSON.parse(doc.loadPage(0).toStructuredText('preserve-whitespace').asJSON()) as {
      blocks: {
        lines?: {
          text: string;
          bbox: { x: number; y: number; w: number; h: number };
          font: { name: string };
        }[];
      }[];
    };
    const lines = json.blocks
      .flatMap((block) => block.lines ?? [])
      .map((line) => ({ ...line, middle: line.bbox.y + line.bbox.h / 2 }))
      .sort((left, right) => left.middle - right.middle || left.bbox.x - right.bbox.x);
    const grouped: (typeof lines)[] = [];
    for (const line of lines) {
      const row = grouped.at(-1);
      if (row !== undefined && Math.abs((row[0]?.middle ?? 0) - line.middle) < 3) row.push(line);
      else grouped.push([line]);
    }
    return grouped.map((row) => {
      row.sort((left, right) => left.bbox.x - right.bbox.x);
      return {
        text: row
          .map((line) => line.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim(),
        left: Math.round(Math.min(...row.map((line) => line.bbox.x))),
        right: Math.round(Math.max(...row.map((line) => line.bbox.x + line.bbox.w))),
        fonts: [...new Set(row.map((line) => line.font.name))],
      };
    });
  } finally {
    doc.destroy();
  }
}

const noteKeys = (outcome: { report: { notes: readonly { key: string }[] } }) =>
  outcome.report.notes.map((entry) => entry.key.replace('op.note.findReplace.', ''));

const FOX = [
  'The quick brown fox jumps over the lazy dog and',
  'keeps running through the forest until the',
  'end of the day when it',
];

/** The same paragraph with a second line nearly as long as the first, so that justifying it stays a few points per gap. */
const JUSTIFIABLE = [
  'The quick brown fox jumps over the lazy dog and',
  'keeps running through the dark forest until the',
  'end of the day when it',
];

describe('findReplace paragraphs', () => {
  it('lays a paragraph out again, word by word, when the new text does not fit its line', async () => {
    const input = await typeset(paragraph(FOX));
    const out = await findReplace(
      input,
      query({ find: 'quick', replace: 'extraordinarily quick and speedy', matchCase: true }),
      run,
    );
    const shown = await rows(out.bytes);
    expect(shown.map((row) => row.text)).toEqual([
      'The extraordinarily quick and speedy brown fox',
      'jumps over the lazy dog and keeps running',
      'through the forest until the',
      'end of the day when it',
    ]);
    expect(shown.map((row) => row.left)).toEqual([72, 72, 72, 72]);
    expect(noteKeys(out)).toContain('reflowed');
    expect(noteKeys(out)).not.toContain('overflow');
    expect(out.report.notes.find((entry) => entry.key.endsWith('reflowed'))?.params).toEqual({ count: 1 });
  });

  it('leaves the lines around a changed line whole when the leading is tighter than the glyph boxes', async () => {
    // 12 pt text at 14 pt leading: a glyph box is 16.5 pt tall, so a rectangle over line one
    // reaches into line two, and MuPDF's redaction removes every glyph a rectangle touches.
    const input = await typeset(paragraph(FOX));
    const out = await findReplace(input, query({ find: 'quick ', replace: '', matchCase: true }), run);
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual([
      'The brown fox jumps over the lazy dog and',
      'keeps running through the forest until the',
      'end of the day when it',
    ]);
  });

  it('replaces a match that runs across a line break and lets the paragraph flow on', async () => {
    const input = await typeset(paragraph(FOX));
    const out = await findReplace(
      input,
      query({ find: 'dog and keeps', replace: 'cat', matchCase: true }),
      run,
    );
    expect(out.replaced).toBe(1);
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual([
      'The quick brown fox jumps over the lazy cat',
      'running through the forest until the',
      'end of the day when it',
    ]);
  });

  it('finds a word hyphenated at the end of a line whole, and drops the hyphenation', async () => {
    const input = await typeset(paragraph(['This is a self-ref-', 'erential sentence that goes on']));
    const out = await findReplace(input, query({ find: 'self-referential', replace: 'recursive' }), run);
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual([
      'This is a recursive sentence',
      'that goes on',
    ]);
  });

  it('treats a compound broken at its own hyphen as one word without the hyphen', async () => {
    const input = await typeset(paragraph(['This is a self-', 'service sentence that goes on']));
    const out = await findReplace(input, query({ find: 'selfservice', replace: 'automatic' }), run);
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual([
      'This is a automatic sentence',
      'that goes on',
    ]);
  });

  it('keeps the lines an author ended as paragraph breaks when it lays a block out again', async () => {
    const input = await typeset(
      paragraph(['John Smith', '12 Long Street', 'Springfield, with a longer final line here']),
    );
    const out = await findReplace(
      input,
      query({ find: 'Long', replace: 'Extraordinarily Wide Avenue Boulevard Extension', matchCase: true }),
      run,
    );
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual([
      'John Smith',
      '12 Extraordinarily Wide Avenue',
      'Boulevard Extension Street',
      'Springfield, with a longer final line here',
    ]);
  });
});

/** The lines of `texts` stretched by word spacing to end at `right`; the last line keeps its width. */
async function justified(texts: readonly string[], right: number, x = 72): Promise<Run[]> {
  const runs = paragraph(texts, x);
  return Promise.all(
    runs.map(async (line, index) => ({
      ...line,
      spacing:
        index === runs.length - 1
          ? 0
          : (right - x - (await widthOf(line.text, 12))) / (line.text.split(' ').length - 1),
    })),
  );
}

/** The lines of `texts` each centred on `axis`, or ended at it with `end`. */
async function aligned(texts: readonly string[], axis: number, end = false): Promise<Run[]> {
  return Promise.all(
    paragraph(texts).map(async (line) => {
      const width = await widthOf(line.text, 12);
      return { ...line, x: end ? axis - width : axis - width / 2 };
    }),
  );
}

describe('findReplace alignment', () => {
  it('keeps a justified paragraph justified when it lays the block out again', async () => {
    const input = await typeset(await justified(JUSTIFIABLE, 336));
    const out = await findReplace(
      input,
      query({ find: 'quick', replace: 'extraordinarily quick and speedy', matchCase: true }),
      run,
    );
    const shown = await rows(out.bytes);
    expect(shown.map((row) => row.text)).toEqual([
      'The extraordinarily quick and speedy brown fox',
      'jumps over the lazy dog and keeps running',
      'through the dark forest until the end of the day',
      'when it',
    ]);
    // Every line but the last of a paragraph still ends at the block's right edge.
    expect(shown.map((row) => [row.left, row.right])).toEqual([
      [72, 335],
      [72, 335],
      [72, 335],
      [72, 110],
    ]);
  });

  it('keeps a centred paragraph centred when it lays the block out again', async () => {
    const input = await typeset(await aligned(FOX, 306));
    const out = await findReplace(
      input,
      query({ find: 'quick', replace: 'extraordinarily quick and speedy', matchCase: true }),
      run,
    );
    const shown = await rows(out.bytes);
    expect(shown.map((row) => row.text)).toEqual([
      'The extraordinarily quick and speedy brown fox',
      'jumps over the lazy dog and keeps running',
      'through the forest until the',
      'end of the day when it',
    ]);
    // Each line is centred on the page's axis, including the one that follows a line the
    // author ended: its offset from the block's edge is its alignment, not an indent.
    expect(shown.map((row) => (row.left + row.right) / 2)).toEqual([305.5, 305, 305.5, 305.5]);
  });

  it('keeps a right-aligned paragraph ending at the same edge when it lays the block out again', async () => {
    const input = await typeset(await aligned(FOX, 400, true));
    const out = await findReplace(
      input,
      query({ find: 'quick', replace: 'extraordinarily quick and speedy', matchCase: true }),
      run,
    );
    const shown = await rows(out.bytes);
    expect(shown.map((row) => row.text)).toEqual([
      'The extraordinarily quick and speedy brown fox',
      'jumps over the lazy dog and keeps running',
      'through the forest until the',
      'end of the day when it',
    ]);
    // Every line, the last of each paragraph included, still ends at the right edge.
    expect(shown.map((row) => row.right)).toEqual([399, 399, 399, 399]);
  });
});

/** A single run on its own line. */
const line = (text: string, x = 72, y = 700, extra: Partial<Run> = {}): Run[] => [{ text, x, y, ...extra }];

/** Two cells of one row: `right` starts `gap` points after `left` starts. */
const cells = (left: string, right: string, gap: number): Run[] => [...line(left), ...line(right, 72 + gap)];

describe('findReplace single lines', () => {
  it('draws a longer replacement where the old text was and moves the words after it', async () => {
    const out = await findReplace(
      await typeset(line('alpha beta gamma delta')),
      query({ find: 'beta', replace: 'BETA-LONGER', matchCase: true }),
      run,
    );
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual(['alpha BETA-LONGER gamma delta']);
    expect(noteKeys(out)).toContain('moved');
    expect(out.report.notes.find((entry) => entry.key.endsWith('standardFace'))?.params).toEqual({
      font: 'Helvetica',
    });
  });

  it('closes the gap when the match is deleted, wherever it stands in the line', async () => {
    const deleted = async (find: string) =>
      (
        await rows(
          (
            await findReplace(
              await typeset(line('alpha beta gamma')),
              query({ find, replace: '', matchCase: true }),
              run,
            )
          ).bytes,
        )
      ).map((row) => row.text);
    expect(await deleted('alpha')).toEqual(['beta gamma']);
    expect(await deleted('beta')).toEqual(['alpha gamma']);
    expect(await deleted('gamma')).toEqual(['alpha beta']);
  });

  it('removes a line altogether when its whole text is deleted', async () => {
    const out = await findReplace(
      await typeset([...line('alpha'), ...line('other', 72, 600)]),
      query({ find: 'alpha', replace: '', matchCase: true }),
      run,
    );
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual(['other']);
  });

  it('replaces every match of a line and moves the text between them once', async () => {
    const out = await findReplace(
      await typeset(line('a b a b a')),
      query({ find: 'a', replace: 'XYZ', matchCase: true, wholeWord: true }),
      run,
    );
    expect(out.replaced).toBe(3);
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual(['XYZ b XYZ b XYZ']);
    expect(out.report.notes.find((entry) => entry.key.endsWith('moved'))?.params).toEqual({ count: 1 });
  });

  it('deletes several matches of a line with the gaps after them', async () => {
    const out = await findReplace(
      await typeset(line('a b c a b')),
      query({ find: 'a ', replace: '', matchCase: true }),
      run,
    );
    expect(out.replaced).toBe(2);
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual(['b c b']);
  });

  it('leaves a match that already reads as the replacement alone and replaces the rest', async () => {
    const out = await findReplace(
      await typeset(line('istanbul Istanbul')),
      query({ find: 'istanbul', replace: 'Istanbul' }),
      run,
    );
    expect(out.replaced).toBe(1);
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual(['Istanbul Istanbul']);
  });

  it('keeps text after a column gap where it is while the moved text still ends before it', async () => {
    const input = await typeset([...line('alpha beta'), ...line('column two', 272)]);
    const grown = await findReplace(input, query({ find: 'beta', replace: 'betaX', matchCase: true }), run);
    expect((await rows(grown.bytes)).map((row) => [row.text, row.right])).toEqual([
      ['alpha betaX column two', 332],
    ]);
    const deleted = await findReplace(input, query({ find: 'beta', replace: '', matchCase: true }), run);
    expect((await rows(deleted.bytes)).map((row) => [row.text, row.right])).toEqual([
      ['alpha column two', 332],
    ]);
  });

  it('moves a column along when the new text would run into it', async () => {
    const input = await typeset([...line('alpha beta'), ...line('column two', 130)]);
    const out = await findReplace(
      input,
      query({ find: 'beta', replace: 'betaXXXXXX', matchCase: true }),
      run,
    );
    expect((await rows(out.bytes)).map((row) => [row.text, row.right])).toEqual([
      ['alpha betaXXXXXX column two', 238],
    ]);
    expect(noteKeys(out)).toContain('moved');
  });

  it('draws each run of the moved text in its own font and colour', async () => {
    const input = await typeset(
      [
        { text: 'alpha ', x: 72, y: 700 },
        { text: 'beta delta', x: 72 + (await widthOf('alpha ', 12)), y: 700, font: 'B', fill: '1 0 0 rg' },
      ],
      { F: 'Helvetica', B: 'Helvetica-Bold' },
    );
    const out = await findReplace(
      input,
      query({ find: 'alpha', replace: 'ZZ yyyyyyyyyy', matchCase: true }),
      run,
    );
    expect(out.report.notes.find((entry) => entry.key.endsWith('standardFace'))?.params).toEqual({
      font: 'Helvetica, Helvetica-Bold',
    });
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual(['ZZ yyyyyyyyyy beta delta']);
  });
});

describe('findReplace tables and titles', () => {
  it('shrinks a replacement into its table cell down to 60 % and no further', async () => {
    const fits = await findReplace(
      await typeset(cells('Name', 'Value', 60)),
      query({ find: 'Name', replace: 'Namesssss', matchCase: true }),
      run,
    );
    expect((await rows(fits.bytes)).map((row) => row.text)).toEqual(['Namesssss Value']);
    expect(noteKeys(fits)).toContain('shrunk');
    await expect(
      findReplace(
        await typeset(cells('Name', 'Value', 60)),
        query({ find: 'Name', replace: 'Namesssssssssssssssssss', matchCase: true }),
        run,
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('reports a cell with no room and still replaces the other matches', async () => {
    const out = await findReplace(
      await typeset([...cells('Name', 'Value', 60), ...line('Name here', 72, 600)]),
      query({ find: 'Name', replace: 'Namesssssssssssssssssss', matchCase: true }),
      run,
    );
    expect(out.replaced).toBe(1);
    const lost = out.report.notes.find((entry) => entry.key.endsWith('noRoom'));
    expect(lost).toMatchObject({ kind: 'lost', params: { count: 1 } });
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual([
      'Name Value',
      'Namesssssssssssssssssss here',
    ]);
  });

  it('deletes the text of a table cell and leaves the next cell alone', async () => {
    const out = await findReplace(
      await typeset(cells('Name', 'Value', 60)),
      query({ find: 'Name', replace: '', matchCase: true }),
      run,
    );
    expect((await rows(out.bytes)).map((row) => [row.text, row.left])).toEqual([['Value', 132]]);
  });

  it('keeps a centred title centred when the new title is longer, shorter or has to shrink', async () => {
    const title = await typeset(await aligned(['Title here'], 306));
    const replaced = async (replace: string) => {
      const out = await findReplace(title, query({ find: 'Title here', replace, matchCase: true }), run);
      const [shown] = await rows(out.bytes);
      return { text: shown?.text, left: shown?.left, right: shown?.right, notes: noteKeys(out) };
    };
    expect(await replaced('Longer title')).toMatchObject({ text: 'Longer title', left: 274, right: 337 });
    expect(await replaced('Hi')).toMatchObject({ text: 'Hi', left: 299, right: 311 });
    // 539 pt of text between the 36 pt margins: the page has no more room, so the size gives way.
    const wide =
      'A title far too wide to fit the margins of the page, so it shrinks to fit them all and then some more';
    const shrunk = await replaced(wide);
    expect(shrunk).toMatchObject({ text: wide, left: 36, right: 575 });
    expect(shrunk.notes).toContain('shrunk');
  });

  it('keeps the lines of a right-aligned block ending at the right edge', async () => {
    const input = await typeset(await aligned(['Short line', 'Another line of text right'], 400, true));
    const ends = async (replace: string) => {
      const out = await findReplace(input, query({ find: 'Short line', replace, matchCase: true }), run);
      return (await rows(out.bytes)).map((row) => [row.text, row.right]);
    };
    expect(await ends('Short text')).toEqual([
      ['Short text', 399],
      ['Another line of text right', 399],
    ]);
    expect(await ends('A longer replacement line')).toEqual([
      ['A longer replacement line', 399],
      ['Another line of text right', 399],
    ]);
  });
});

const STANDARD_FACES = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Times-BoldItalic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Courier-BoldOblique',
] as const;

describe('findReplace faces and special text', () => {
  it.each(STANDARD_FACES)('draws new glyphs on a %s page with the same standard face', async (face) => {
    // `q`, `x` and `z` are not on the page, so the page's own font does not count as proof.
    const out = await findReplace(
      await typeset(line('alpha beta gamma'), { F: face }),
      query({ find: 'beta', replace: 'qxz', matchCase: true }),
      run,
    );
    const [shown] = await rows(out.bytes);
    expect(shown?.text).toBe('alpha qxz gamma');
    expect(shown?.fonts).toEqual([face]);
    expect(out.report.notes.find((entry) => entry.key.endsWith('standardFace'))?.params).toEqual({
      font: face,
    });
  });

  it('reads a font that the page holds as a direct dictionary, not an indirect object', async () => {
    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, await typeset(line('alpha beta gamma')));
    // The page's font resource becomes a dictionary of its own, with no object number.
    const page = doc.findPage(0);
    const fonts = page.get('Resources').get('Font');
    const font = fonts.get('F').resolve();
    fonts.put('F', doc.newDictionary());
    for (const key of ['Type', 'Subtype', 'BaseFont']) fonts.get('F').put(key, font.get(key));
    const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    doc.destroy();
    const out = await findReplace(bytes, query({ find: 'beta', replace: 'qxz', matchCase: true }), run);
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual(['alpha qxz gamma']);
  });

  it('does not take a letter that is only part of a longer word for a whole word, in either case', async () => {
    const check = async (text: string) =>
      (
        await rows(
          (
            await findReplace(
              await typeset(line(text)),
              query({ find: 'kar', replace: 'x', wholeWord: true }),
              run,
            )
          ).bytes,
        )
      ).map((row) => row.text);
    expect(await check('Ikar kar')).toEqual(['Ikar x']);
    expect(await check('karI kar')).toEqual(['karI x']);
  });

  it('finds a word across a soft hyphen and replaces the hyphen with it', async () => {
    const mupdf = await loadMupdf();
    const doc = new mupdf.PDFDocument();
    const face = await embedNotoSans(mupdf, doc);
    doc.insertPage(
      0,
      doc.addPage(
        [0, 0, 500, 400],
        0,
        { Font: { F: face.ref } },
        `BT /F 14 Tf 40 300 Td ${face.encode('co\u00ADoperate now')} Tj ET`,
      ),
    );
    const input = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
    doc.destroy();
    const out = await findReplace(input, query({ find: 'cooperate', replace: 'xyz', matchCase: true }), run);
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual(['xyz now']);
  });

  it('refuses a match that would cover half of a glyph, and says so', async () => {
    // `…` is one glyph that reads as three full stops: `..` would cut it in two.
    const input = await typeset(line('Wait\\205 more ..', 72, 700, { encoded: true }));
    const out = await findReplace(input, query({ find: '..', replace: 'x', matchCase: true }), run);
    expect(out.replaced).toBe(1);
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual(['Wait… more x']);
    const skipped = out.report.notes.find((entry) => entry.key.endsWith('skipped'));
    expect(skipped).toMatchObject({ kind: 'lost', params: { count: 2, pages: '1' } });
    await expect(
      findReplace(
        await typeset(line('Wait\\205', 72, 700, { encoded: true })),
        query({ find: '..', replace: 'x', matchCase: true }),
        run,
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('findReplace reports and options', () => {
  it('warns when a re-laid paragraph needs more room than the page has below it', async () => {
    // A paragraph 120 pt above the bottom edge: 70 words more than fill the room down to the margin.
    const tall = paragraph(
      [
        'one two three four five six seven eight nine ten eleven',
        'twelve thirteen fourteen fifteen sixteen',
        'seventeen eighteen nineteen twenty',
      ],
      72,
      120,
    );
    const replace = Array.from({ length: 50 }, (_, index) => `word${index}`).join(' ');
    const out = await findReplace(await typeset(tall), query({ find: 'two', replace, matchCase: true }), run);
    expect(out.report.notes.find((entry) => entry.key.endsWith('overflow'))).toMatchObject({
      kind: 'warning',
      params: { count: 1 },
    });
    const shown = await rows(out.bytes);
    expect(shown).toHaveLength(10);
    expect(shown[0]?.text.startsWith('one word0 word1')).toBe(true);
    expect(shown.at(-1)?.text.endsWith('twenty')).toBe(true);
  });

  it('uses the font set it is given instead of loading the app’s own', async () => {
    const fonts = await loadTextFonts();
    // The catalogue's own fetch is stubbed above; with a font set at hand, nothing is fetched.
    vi.stubGlobal('fetch', async () => {
      throw new Error('the font set was given, no font may be fetched');
    });
    const out = await findReplace(
      await typeset(line('alpha beta gamma')),
      { ...query({ find: 'beta', replace: 'qxz', matchCase: true }), fonts },
      run,
    );
    expect((await rows(out.bytes)).map((row) => row.text)).toEqual(['alpha qxz gamma']);
  });

  it('reports the pages it has read, and stops when aborted', async () => {
    const input = await typeset(line('alpha beta gamma'));
    const progress: { phase: string; done: number; total: number }[] = [];
    const out = await findReplace(input, query({ find: 'beta', replace: 'qxz', matchCase: true }), {
      ...run,
      onProgress: (event) =>
        progress.push({ phase: event.phase, done: event.done ?? -1, total: event.total ?? -1 }),
    });
    expect(out.replaced).toBe(1);
    expect(progress.filter((event) => event.phase === 'findReplace.read')).toEqual([
      { phase: 'findReplace.read', done: 1, total: 1 },
    ]);

    const controller = new AbortController();
    controller.abort();
    await expect(
      findReplace(input, query({ find: 'beta', replace: 'qxz' }), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const late = new AbortController();
    await expect(
      findReplace(input, query({ find: 'beta', replace: 'qxz' }), {
        signal: late.signal,
        onProgress: () => late.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/** The page's text model with the font name taken off every glyph that draws `ch`. */
function withoutFontName(model: TextPage, ch: string): TextPage {
  return {
    ...model,
    blocks: model.blocks.map((block) => ({
      ...block,
      lines: block.lines.map((line) => ({
        ...line,
        words: line.words.map((word) => ({
          ...word,
          glyphs: word.glyphs.map((glyph) => {
            if (glyph.ch !== ch) return glyph;
            const { fontName: _removed, ...bare } = glyph;
            return bare;
          }),
        })),
      })),
    })),
  };
}

/** The font name of the page's first block, which the extractor reported for its glyphs. */
function fontNameOf(model: TextPage): string {
  const name = model.blocks[0]?.style.fontName;
  if (typeof name !== 'string') throw new Error('the page has no font name');
  return name;
}

describe('documentFaces', () => {
  /** `Merhaba dünya` in embedded Noto Sans, read the way `findReplace` reads a page. */
  async function readPage() {
    const bytes = await page([{ text: 'Merhaba dünya', y: 330 }]);
    const inputs = await readDocumentText(bytes, [0], run);
    const model = buildTextPage(inputs[0] ?? { pageIndex: 0, width: 1, height: 1, rotation: 0, blocks: [] });
    const fonts = await loadTextFonts();
    return { bytes, model, fonts, fontName: fontNameOf(model) };
  }

  it('offers the page’s own font for text made of characters that font has drawn', async () => {
    const { bytes, model, fonts, fontName } = await readPage();
    const source = await documentFaces(bytes, [model], fonts);
    try {
      expect(source.faces.own(0, fontName, 'dünya Merhaba')).toBe(`doc:${fontName}`);
      // `z` is in the font's encoding but the page never shows it: a subset need not hold it.
      expect(source.faces.own(0, fontName, 'Merhaba z')).toBeNull();
      expect(source.faces.own(0, 'NoSuchFont', 'Merhaba')).toBeNull();
    } finally {
      source.close();
    }
  });

  it('does not count a glyph that reports no font name as drawn by any font', async () => {
    const { bytes, model, fonts, fontName } = await readPage();
    const source = await documentFaces(bytes, [withoutFontName(model, 'M')], fonts);
    try {
      expect(source.faces.own(0, fontName, 'M')).toBeNull();
      expect(source.faces.own(0, fontName, 'erhaba')).toBe(`doc:${fontName}`);
    } finally {
      source.close();
    }
  });

  it('reflows with the page font’s own advances and only the glyphs the page has drawn', async () => {
    const { bytes, model, fonts, fontName } = await readPage();
    const source = await documentFaces(bytes, [model], fonts);
    const mupdf = await loadMupdf();
    try {
      const metrics = source.faces.ownMetrics(0, fontName, 'Merhaba');
      if (metrics === null) throw new Error('the page font draws Merhaba');
      const regular = new mupdf.Font('NotoSans', noto('400Regular/NotoSans_400Regular.ttf'));
      expect(metrics.unitsPerEm).toBe(1000);
      for (const character of ['M', 'ü', 'y']) {
        const point = character.codePointAt(0) ?? 0;
        expect(metrics.glyphAdvance(point)).toBeCloseTo(
          regular.advanceGlyph(regular.encodeCharacter(point), 0) * 1000,
          0,
        );
        expect(metrics.hasGlyph(point)).toBe(true);
      }
      // A space is always there; `z` was never drawn.
      expect(metrics.hasGlyph(0x20)).toBe(true);
      expect(metrics.hasGlyph(0x7a)).toBe(false);
      expect(metrics.lineGap).toBe(0);
      expect(metrics.missing).toEqual([]);
      expect(source.faces.ownMetrics(0, fontName, 'Merhaba z')).toBeNull();
    } finally {
      source.close();
    }
  });

  it('measures text in the page’s own font, the catalogue’s faces and a standard face', async () => {
    const { bytes, model, fonts, fontName } = await readPage();
    const source = await documentFaces(bytes, [model], fonts);
    const mupdf = await loadMupdf();
    try {
      const regular = new mupdf.Font('NotoSans', noto('400Regular/NotoSans_400Regular.ttf'));
      const helvetica = new mupdf.Font('Helvetica');
      const advance = (font: InstanceType<typeof mupdf.Font>, text: string) =>
        [...text].reduce(
          (sum, character) => sum + font.advanceGlyph(font.encodeCharacter(character.codePointAt(0) ?? 0), 0),
          0,
        );
      expect(source.faces.measure('Merhaba', `doc:${fontName}`, 10, 0)).toBeCloseTo(
        advance(regular, 'Merhaba') * 10,
        1,
      );
      expect(source.faces.measure('Merhaba', 'noto-sans', 10, 0)).toBeCloseTo(
        advance(regular, 'Merhaba') * 10,
        1,
      );
      expect(source.faces.measure('Merhaba', 'helvetica', 10, 0)).toBeCloseTo(
        advance(helvetica, 'Merhaba') * 10,
        5,
      );
      expect(source.faces.measure('Merhaba', 'helvetica', 20, 0)).toBeCloseTo(
        advance(helvetica, 'Merhaba') * 20,
        5,
      );
    } finally {
      source.close();
    }
  });

  it('refuses to measure with a font it does not have', async () => {
    const { bytes, model, fonts } = await readPage();
    const source = await documentFaces(bytes, [model], { ...fonts, metrics: {} });
    try {
      expect(() => source.faces.measure('x', 'doc:NoSuchFont', 10, 0)).toThrowError(
        expect.objectContaining({
          code: 'internal',
          details: { engine: 'model', engineMessage: 'no document font doc:NoSuchFont' },
        }),
      );
      // The set has no table for the catalogue face either, and it is not a standard face.
      expect(() => source.faces.measure('x', 'noto-sans', 10, 0)).toThrowError(
        expect.objectContaining({
          code: 'internal',
          details: { engine: 'model', engineMessage: 'no metrics for face noto-sans' },
        }),
      );
    } finally {
      source.close();
    }
  });
});
