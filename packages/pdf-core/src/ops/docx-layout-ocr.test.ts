/**
 * A scanned page in the "exact layout" Word export: the page is a picture made of a vector
 * sample (a coloured page, a dark panel, a line of text), a fake recogniser returns the words
 * where the text is, and the package is read back as Word would — text boxes with the words,
 * the page colour as a page-sized shape, the panel as a picture, one comment around the word
 * the recogniser was unsure of, and mammoth's word count unchanged by the comment. A page with
 * an invisible text layer is read from the layer without calling the recogniser.
 */

import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import type { OcrWord } from '../engines/tesseract';
import { exportOffice } from './export-office';
import { line, officeDocument } from './export-office-fixtures';
import type { OperationContext } from './types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const run: OperationContext = { signal: new AbortController().signal };

/** A light blue page, a dark panel and a line of text (baseline 100 pt from the top of a 400 × 500 page). */
const SAMPLE = officeDocument([
  {
    content: [
      '0.85 0.92 1 rg 0 0 400 500 re f',
      '0.6 0.1 0.1 rg 40 200 200 100 re f',
      line('helvetica', 14, 60, 400, 'Hello world today'),
    ].join('\n'),
  },
]);

/** The sample as a scan: its page rendered into one picture, plus `layer` as invisible text when given. */
async function scanOf(layer?: string, sample: Promise<Uint8Array> = SAMPLE): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const source = mupdf.Document.openDocument((await sample).slice(), 'application/pdf');
  const scan = new mupdf.PDFDocument();
  try {
    const pixmap = source
      .loadPage(0)
      .toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceRGB, false, false);
    const image = scan.addImage(new mupdf.Image(pixmap.asPNG()));
    pixmap.destroy();
    const font = scan.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    const page = scan.addPage(
      [0, 0, 400, 500],
      0,
      { XObject: { Im0: image }, Font: { F1: font } },
      `q 400 0 0 500 0 0 cm /Im0 Do Q\n${layer === undefined ? '' : `BT /F1 14 Tf 3 Tr 60 400 Td (${layer}) Tj ET\n`}`,
    );
    scan.insertPage(-1, page);
    const saved = scan.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    return bytes;
  } finally {
    scan.destroy();
    source.destroy();
  }
}

/** Where Helvetica 14 puts the three words of the sample line (page points, y down), as tesseract would box them. */
function words(confidences: readonly [number, number, number]): OcrWord[] {
  const boxes: [string, number, number][] = [
    ['Hello', 60, 92],
    ['world', 97, 130],
    ['today', 135, 165],
  ];
  return boxes.map(([text, x0, x1], at) => ({
    text,
    x0,
    x1,
    y0: 89,
    y1: 103,
    confidence: confidences[at] as number,
    block: 1,
    paragraph: 1,
    line: 1,
  }));
}

/** A blank page of `side` × `side` points that is one small picture stretched over it (a scan too big to render whole). */
async function hugeScan(side: number): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const scan = new mupdf.PDFDocument();
  try {
    const tile = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 8, 8], false);
    tile.clear(255);
    const image = scan.addImage(new mupdf.Image(tile));
    tile.destroy();
    const page = scan.addPage(
      [0, 0, side, side],
      0,
      { XObject: { Im0: image } },
      `q ${side} 0 0 ${side} 0 0 cm /Im0 Do Q\n`,
    );
    scan.insertPage(-1, page);
    const saved = scan.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    return bytes;
  } finally {
    scan.destroy();
  }
}

const options = { pages: [0], baseName: 'scan.pdf', format: 'docx', docxLayout: 'layout' } as const;

async function text(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (file === null) throw new Error(`missing ${name}`);
  return file.async('string');
}

describe('exact layout: a scanned page read by OCR', () => {
  it('keeps the first read when the second look cannot run, but stops when the export is cancelled', async () => {
    const recognize = async () => words([96, 50, 97]);
    const result = await exportOffice(
      await scanOf(),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize,
          readWord: async () => {
            throw new Error('the second worker could not start');
          },
        },
      },
      run,
    );
    const zip = await JSZip.loadAsync(result.file.bytes);
    const xml = await text(zip, 'word/document.xml');
    const written = Array.from(
      new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(W, 't'),
    )
      .map((t) => t.textContent)
      .join('');
    expect(written).toContain('Hello world today');
    await expect(
      exportOffice(
        await scanOf(),
        {
          ...options,
          ocr: {
            lowConfidence: 0.9,
            recognize,
            readWord: async () => {
              throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
            },
          },
        },
        run,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reads capitals with English alone only when the caller says that differs from all the languages', async () => {
    const models: string[] = [];
    const sure = async () => words([99, 99, 99]).map((w, at) => (at === 0 ? { ...w, text: 'SOL' } : w));
    for (const englishAlone of [undefined, true]) {
      models.length = 0;
      await exportOffice(
        await scanOf(),
        {
          ...options,
          ocr: {
            lowConfidence: 0.9,
            recognize: sure,
            readWord: async (_png, which) => {
              models.push(which);
              return null;
            },
            ...(englishAlone === undefined ? {} : { englishAlone }),
          },
        },
        run,
      );
      expect(models).toEqual(englishAlone === true ? ['english'] : []);
    }
  });

  it('reads the unsure word again on a crop of it and writes the surer reading', async () => {
    const crops: { size: number; models: string }[] = [];
    const result = await exportOffice(
      await scanOf(),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async () => words([96, 50, 97]).map((w, at) => (at === 1 ? { ...w, text: 'worid' } : w)),
          readWord: async (png, models) => {
            crops.push({ size: png.length, models });
            return { text: 'world', confidence: 93 };
          },
        },
      },
      run,
    );
    // Only the unsure word was read again, once.
    expect(crops).toHaveLength(1);
    expect(crops[0]?.models).toBe('all');
    expect(crops[0]?.size).toBeGreaterThan(100);
    const zip = await JSZip.loadAsync(result.file.bytes);
    const xml = await text(zip, 'word/document.xml');
    const written = Array.from(
      new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(W, 't'),
    )
      .map((t) => t.textContent)
      .join('');
    expect(written).toContain('Hello world today');
  });

  it('writes the words as text boxes, the page colour as a shape, the panel as a picture and one comment', async () => {
    const seen: { scale: number; png: number }[] = [];
    const result = await exportOffice(
      await scanOf(),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async (png, scale) => {
            seen.push({ scale, png: png.length });
            return words([96, 50, 97]);
          },
        },
      },
      run,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.scale).toBeCloseTo(200 / 72, 1);
    const zip = await JSZip.loadAsync(result.file.bytes);
    const xml = await text(zip, 'word/document.xml');
    const document = new DOMParser().parseFromString(xml, 'text/xml');

    // The words, in one text box, with the unsure one commented and nothing else.
    const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
    const boxes = Array.from(document.getElementsByTagNameNS(WP, 'anchor'))
      .map((anchor) => ({
        content: Array.from(anchor.getElementsByTagNameNS(W, 't'))
          .map((t) => t.textContent)
          .join(''),
        left: Number(anchor.getElementsByTagNameNS(WP, 'posOffset')[0]?.textContent) / 12700,
        top: Number(anchor.getElementsByTagNameNS(WP, 'posOffset')[1]?.textContent) / 12700,
      }))
      .filter((box) => box.content !== '');
    // Where the words are on the page: the left edge of the first word, the line around y = 90…103.
    expect(boxes.map((box) => box.content)).toEqual(['Hello world today']);
    expect(boxes[0]?.left).toBeCloseTo(60, 0);
    expect(boxes[0]?.top).toBeGreaterThan(80);
    expect(boxes[0]?.top).toBeLessThan(100);
    expect(xml.match(/<w:commentRangeStart /g)).toHaveLength(2); // the DrawingML text and its VML fallback
    expect(xml.match(/<w:commentReference /g)).toHaveLength(2);
    // The word's letters may be spaced to the scan's box, so its text can be several runs: they are what is commented.
    const noted =
      /<w:commentRangeStart w:id="0"\/>((?:<w:r>(?:(?!<\/w:r>).)*<\/w:r>)+)<w:commentRangeEnd w:id="0"\/><w:r><w:rPr><w:rStyle w:val="CommentReference"\/><\/w:rPr><w:commentReference w:id="0"\/><\/w:r>/.exec(
        xml,
      );
    expect(noted).not.toBeNull();
    expect(Array.from((noted?.[1] ?? '').matchAll(/<w:t [^>]*>([^<]*)<\/w:t>/g), (m) => m[1]).join('')).toBe(
      'world',
    );

    // Comments part, relationship and content type.
    const comments = await text(zip, 'word/comments.xml');
    expect(comments).toContain('w:author="SsPdfEditor"');
    expect(comments).toContain('w:initials="OCR"');
    expect(comments).toContain('Low OCR confidence (50 %)');
    expect(comments.match(/<w:comment /g)).toHaveLength(1);
    expect(await text(zip, '[Content_Types].xml')).toContain(
      '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>',
    );
    expect(await text(zip, 'word/_rels/document.xml.rels')).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"',
    );

    // The background: a page-sized shape in the page colour, and the panel as a picture.
    expect(xml).toMatch(/<a:srgbClr val="D[89A][EF][AB-F][0-9A-F]{2}"/i);
    const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/'));
    expect(media.length).toBeGreaterThanOrEqual(1);

    expect(result.notes.map((note) => [note.kind, note.key])).toEqual(
      expect.arrayContaining([
        ['changed', 'op.note.exportOffice.ocrPages'],
        ['warning', 'op.note.exportOffice.ocrLowConfidence'],
      ]),
    );
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.ocrPages')?.params).toEqual({
      pages: '1',
    });
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.ocrLowConfidence')?.params).toEqual(
      {
        count: 1,
        words: 'world (1)',
      },
    );
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrUnavailable')).toBe(false);
  });

  it('names each unsure word once, the first twenty only, and says there are more', async () => {
    const unsure = (text: string, at: number): OcrWord => ({
      text,
      x0: 20 + (at % 10) * 30,
      x1: 40 + (at % 10) * 30,
      y0: 20 + Math.floor(at / 10) * 20,
      y1: 32 + Math.floor(at / 10) * 20,
      confidence: 30,
      block: 3,
      paragraph: 3,
      line: 3 + Math.floor(at / 10),
    });
    // 'again' is read twice on the page; 25 distinct words in all.
    const found = [
      ...Array.from({ length: 24 }, (_, at) => unsure(`w${at}`, at)),
      unsure('again', 24),
      unsure('again', 25),
    ];
    const result = await exportOffice(
      await scanOf(),
      { ...options, ocr: { lowConfidence: 0.9, recognize: async () => found } },
      run,
    );
    const flagged = result.notes.find((note) => note.key === 'op.note.exportOffice.ocrLowConfidence');
    const listed = String(flagged?.params?.words).split(', ');
    expect(flagged?.params?.count).toBe(26);
    expect(listed).toHaveLength(21);
    expect(listed.slice(0, 3)).toEqual(['w0 (1)', 'w1 (1)', 'w2 (1)']);
    expect(listed.at(-1)).toBe('…');
    expect(new Set(listed).size).toBe(21);
  });

  it('lists a word read twice once when there are few words', async () => {
    const unsure = (text: string, x0: number): OcrWord => ({
      text,
      x0,
      x1: x0 + 20,
      y0: 20,
      y1: 32,
      confidence: 30,
      block: 3,
      paragraph: 3,
      line: 3,
    });
    const result = await exportOffice(
      await scanOf(),
      {
        ...options,
        ocr: { lowConfidence: 0.9, recognize: async () => [unsure('again', 20), unsure('again', 100)] },
      },
      run,
    );
    const flagged = result.notes.find((note) => note.key === 'op.note.exportOffice.ocrLowConfidence');
    expect(flagged?.params).toEqual({ count: 2, words: 'again (1)' });
  });

  it('writes no comments part when every word is sure', async () => {
    const result = await exportOffice(
      await scanOf(),
      { ...options, ocr: { lowConfidence: 0.9, recognize: async () => words([96, 95, 97]) } },
      run,
    );
    const zip = await JSZip.loadAsync(result.file.bytes);
    expect(zip.file('word/comments.xml')).toBeNull();
    expect(await text(zip, '[Content_Types].xml')).not.toContain('comments');
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrLowConfidence')).toBe(false);
  });

  it('drops symbol-only guesses over a picture, keeps those on the page, and flags neither', async () => {
    const guess = (text: string, x0: number, y0: number): OcrWord => ({
      text,
      x0,
      y0,
      x1: x0 + 10,
      y1: y0 + 12,
      confidence: 30,
      block: 2,
      paragraph: 2,
      line: 2,
    });
    // '*' lies over the dark panel (x 40–240, y 200–300 of the 400 × 500 page), '•' on the page colour
    const result = await exportOffice(
      await scanOf(),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async () => [...words([96, 95, 97]), guess('*', 100, 250), guess('•', 300, 60)],
        },
      },
      run,
    );
    const zip = await JSZip.loadAsync(result.file.bytes);
    const xml = await text(zip, 'word/document.xml');
    expect(xml).toContain('•');
    expect(xml).not.toContain('*');
    expect(zip.file('word/comments.xml')).toBeNull();
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrLowConfidence')).toBe(false);
  });

  it('reads a page with an underlined word again without the rule, and writes the word underlined', async () => {
    // the link of the sample line, with a rule just under it
    const underlined = officeDocument([
      {
        content: [
          '1 1 1 rg 0 0 400 500 re f',
          line('helvetica', 14, 60, 400, 'Hello world today'),
          '0 0 0 rg 60 396 105 0.8 re f',
        ].join('\n'),
      },
    ]);
    const seen: number[] = [];
    const result = await exportOffice(
      await scanOf(undefined, underlined),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async (png) => {
            seen.push(png.length);
            return words([96, 95, 97]);
          },
        },
      },
      run,
    );
    // read twice: the second picture is the first without the rule, so it differs
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
    const zip = await JSZip.loadAsync(result.file.bytes);
    const xml = await text(zip, 'word/document.xml');
    expect(xml).toContain('<w:u w:val="single"/>');
  });

  it('reads an invisible text layer instead of calling the recogniser', async () => {
    let calls = 0;
    const result = await exportOffice(
      await scanOf('Hello world today'),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async () => {
            calls += 1;
            return [];
          },
        },
      },
      run,
    );
    expect(calls).toBe(0);
    const zip = await JSZip.loadAsync(result.file.bytes);
    const xml = await text(zip, 'word/document.xml');
    const visible = Array.from(
      new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(W, 't'),
    )
      .map((t) => t.textContent)
      .join('');
    // The layer's words are in the boxes once (DrawingML text plus the VML fallback), not twice as picture text.
    expect(visible.replaceAll(' ', '')).toBe('HelloworldtodayHelloworldtoday');
    expect(zip.file('word/comments.xml')).toBeNull();
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrPages')).toBe(true);
  });

  it('reads the layer even without a recogniser', async () => {
    const result = await exportOffice(await scanOf('Hello world today'), options, run);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrUnavailable')).toBe(false);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrPages')).toBe(true);
  });

  it('keeps the page a picture and says OCR was not available when there is no recogniser', async () => {
    const result = await exportOffice(await scanOf(), options, run);
    const unavailable = result.notes.find((note) => note.key === 'op.note.exportOffice.ocrUnavailable');
    expect(unavailable).toMatchObject({ kind: 'warning', params: { pages: '1' } });
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrPages')).toBe(false);
  });

  it('does not call the recogniser for a page with visible text', async () => {
    let calls = 0;
    await exportOffice(
      await SAMPLE,
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async () => {
            calls += 1;
            return [];
          },
        },
      },
      run,
    );
    expect(calls).toBe(0);
  });

  it('keeps the page a picture and says OCR was not available when the recogniser fails', async () => {
    const result = await exportOffice(
      await scanOf(),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async () => {
            throw new Error('the language pack could not be fetched');
          },
        },
      },
      run,
    );
    const unavailable = result.notes.find((note) => note.key === 'op.note.exportOffice.ocrUnavailable');
    expect(unavailable).toMatchObject({ kind: 'warning', params: { pages: '1' } });
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrPages')).toBe(false);
    const zip = await JSZip.loadAsync(result.file.bytes);
    expect(Object.keys(zip.files).some((name) => name.startsWith('word/media/'))).toBe(true);
  });

  describe('read side by side', () => {
    /** The three-page export of one scan page, with a recogniser that answers each call with a word of its own, after `delays`. */
    async function three(concurrency: number | undefined, delays: readonly number[], signal = run.signal) {
      let started = 0;
      let inFlight = 0;
      let most = 0;
      const signals: AbortSignal[] = [];
      const result = await exportOffice(
        await scanOf(),
        {
          ...options,
          pages: [0, 0, 0],
          ocr: {
            lowConfidence: 0.9,
            ...(concurrency === undefined ? {} : { concurrency }),
            recognize: async (_png, _scale, own) => {
              const call = started;
              started += 1;
              inFlight += 1;
              most = Math.max(most, inFlight);
              signals.push(own);
              try {
                await new Promise((resolve) => setTimeout(resolve, delays[call] ?? 0));
                return words([96, 97, 98]).map((word, at) =>
                  at === 0 ? { ...word, text: `page${call}` } : word,
                );
              } finally {
                inFlight -= 1;
              }
            },
          },
        },
        { signal },
      );
      const zip = await JSZip.loadAsync(result.file.bytes);
      const xml = await text(zip, 'word/document.xml');
      const written = Array.from(
        new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(W, 't'),
      )
        .map((t) => t.textContent)
        .join(' ');
      // Each word is in the page's text twice (as a run and as the line's text), in page order.
      const order = [
        ...new Set([...written.replace(/\s/g, '').matchAll(/page(\d)/g)].map((match) => Number(match[1]))),
      ];
      return { order, most, started, signals };
    }

    it('reads the pages at the same time and writes them in their order, whichever is read first', async () => {
      const { order, most } = await three(3, [60, 30, 0]);
      expect(most).toBe(3);
      expect(order).toEqual([0, 1, 2]);
    });

    it('reads one page at a time unless the recogniser can read more', async () => {
      const { order, most } = await three(undefined, [5, 5, 5]);
      expect(most).toBe(1);
      expect(order).toEqual([0, 1, 2]);
      expect((await three(2, [5, 5, 5])).most).toBe(2);
    });

    it('stops every read when the export is cancelled', async () => {
      const controller = new AbortController();
      const running = three(3, [50, 50, 50], controller.signal);
      setTimeout(() => controller.abort(), 10);
      await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('stops the reads under way, and waits for them, when a page read ahead fails', async () => {
      const signals: AbortSignal[] = [];
      let settled = 0;
      let calls = 0;
      await expect(
        exportOffice(
          await scanOf(),
          {
            ...options,
            pages: [0, 0, 0],
            ocr: {
              lowConfidence: 0.9,
              concurrency: 3,
              recognize: async (_png, _scale, own) => {
                calls += 1;
                const call = calls;
                signals.push(own);
                if (call === 2) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
                try {
                  await new Promise((resolve) => setTimeout(resolve, 40));
                  return words([96, 97, 98]);
                } finally {
                  settled += 1;
                }
              },
            },
          },
          run,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      // The failure of page two is reported as the export's; the other two reads were let finish, not left running.
      expect(calls).toBe(3);
      expect(settled).toBe(2);
      expect(signals.every((own) => own.aborted)).toBe(true);
    });
  });

  it('still stops when the recogniser itself reports the cancellation', async () => {
    await expect(
      exportOffice(
        await scanOf(),
        {
          ...options,
          ocr: {
            lowConfidence: 0.9,
            recognize: async () => {
              throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
            },
          },
        },
        run,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('renders a huge scan within the pixel cap and still puts the words where they are on the page', async () => {
    const side = 3200;
    const seen: { scale: number; png: Uint8Array }[] = [];
    const result = await exportOffice(
      await hugeScan(side),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async (png, scale) => {
            seen.push({ scale, png });
            return [
              {
                text: 'Far',
                x0: 1000,
                x1: 1100,
                y0: 2000,
                y1: 2030,
                confidence: 96,
                block: 1,
                paragraph: 1,
                line: 1,
              },
            ];
          },
        },
      },
      run,
    );
    expect(seen).toHaveLength(1);
    // The PNG's own size (IHDR: width, height as big-endian words at bytes 16 and 20): at most 40 megapixels.
    const header = new DataView((seen[0]?.png ?? new Uint8Array(24)).buffer.slice(0, 24));
    expect(header.getUint32(16) * header.getUint32(20)).toBeLessThanOrEqual(40_000_000);
    expect(seen[0]?.scale).toBeLessThan(200 / 72);
    const zip = await JSZip.loadAsync(result.file.bytes);
    const xml = await text(zip, 'word/document.xml');
    const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
    const document = new DOMParser().parseFromString(xml, 'text/xml');
    const box = Array.from(document.getElementsByTagNameNS(WP, 'anchor')).find((anchor) =>
      Array.from(anchor.getElementsByTagNameNS(W, 't'))
        .map((t) => t.textContent)
        .join('')
        .includes('Far'),
    );
    expect(box).toBeDefined();
    // Word's page is smaller than the PDF's: the word keeps its place in proportion.
    const left = Number(box?.getElementsByTagNameNS(WP, 'posOffset')[0]?.textContent) / 12700;
    const top = Number(box?.getElementsByTagNameNS(WP, 'posOffset')[1]?.textContent) / 12700;
    const shrink = 1584 / side;
    expect(left).toBeCloseTo(1000 * shrink, -1);
    expect(top).toBeGreaterThan(1900 * shrink);
    expect(top).toBeLessThan(2030 * shrink);
  }, 120_000);

  it('stops with an AbortError when cancelled while recognising', async () => {
    const controller = new AbortController();
    await expect(
      exportOffice(
        await scanOf(),
        {
          ...options,
          ocr: {
            lowConfidence: 0.9,
            recognize: async (_png, _scale, signal) => {
              controller.abort();
              signal.throwIfAborted();
              return [];
            },
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
