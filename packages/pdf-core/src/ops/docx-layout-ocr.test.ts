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
async function scanOf(layer?: string): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const source = mupdf.Document.openDocument((await SAMPLE).slice(), 'application/pdf');
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

const options = { pages: [0], baseName: 'scan.pdf', format: 'docx', docxLayout: 'layout' } as const;

async function text(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (file === null) throw new Error(`missing ${name}`);
  return file.async('string');
}

describe('exact layout: a scanned page read by OCR', () => {
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
