/**
 * Real text over a scan ("mixed" pages) and the trust gate of an invisible text layer in the
 * exact-layout Word export. The pages are synthetic: a scan is a rendered vector sample set as
 * one picture, the typed text is drawn over it, and a fake recogniser says where the words are.
 * The wrong answers that matter: the typed text read by OCR too (twice in the file), the scan's
 * words left a picture, a layer of unreadable characters trusted, a good layer thrown away, a
 * page that is only vector text or only a picture with text on it sent to OCR.
 */

import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import type { PDFDocument } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import type { OcrWord } from '../engines/tesseract';
import {
  dropMasked,
  inkBoxes,
  isMixedPage,
  isScanPage,
  layerTrusted,
  maskBoxes,
  pictureStats,
  textPictures,
  visibleBoxes,
  wordsInPicture,
} from './docx-layout-mixed';
import { exportOffice } from './export-office';
import { line, officeDocument } from './export-office-fixtures';
import type { PageScene } from './layout-scene';
import { readPageScene } from './layout-scene-read';
import type { RgbaImage } from './ocr-scene';
import type { OperationContext } from './types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const run: OperationContext = { signal: new AbortController().signal };
const options = { pages: [0], baseName: 'scan.pdf', format: 'docx', docxLayout: 'layout' } as const;

/** A tinted page, a dark panel and a line of text: what the scan shows (baseline 100 pt from the top of a 400 × 500 page). */
const SAMPLE = officeDocument([
  {
    content: [
      '0.85 0.92 1 rg 0 0 400 500 re f',
      '0.6 0.1 0.1 rg 40 200 200 100 re f',
      line('helvetica', 14, 60, 400, 'Hello world today'),
    ].join('\n'),
  },
]);
/**
 * A tinted page of three lines of four words each, in Courier 12 (7.2 pt a letter): what a
 * scanned letter shows, where the sample's dark panel is a picture that is not text.
 */
const PARAGRAPH = officeDocument([
  {
    content: [
      '0.85 0.92 1 rg 0 0 400 500 re f',
      ...[0, 1, 2].map((row) => line('courier', 12, 60, 400 - 20 * row, 'aaaa bbbb cccc dddd')),
    ].join('\n'),
  },
]);
/** Where the twelve words of the paragraph are (page points, y down), as tesseract would box them. */
const paragraphWords = (confidence = 92): OcrWord[] =>
  [0, 1, 2].flatMap((row) =>
    [0, 1, 2, 3].map((column) => ({
      ...word(
        'abcd'[column]?.repeat(4) ?? '',
        60 + 36 * column,
        60 + 36 * column + 28.8,
        91 + 20 * row,
        103 + 20 * row,
        confidence,
      ),
      line: row + 1,
    })),
  );
/** A scan with nothing on it but the tint. */
const BLANK = officeDocument([{ content: '0.85 0.92 1 rg 0 0 400 500 re f' }]);

/**
 * The sample as a page of one picture, then `over` drawn on top (the resources are Helvetica `F1`
 * and a Courier `F2` whose `/ToUnicode` hands code 1 over as U+0001, which reads back as U+FFFD).
 */
async function scanWith(
  over: string,
  sample: Promise<Uint8Array> = SAMPLE,
  placement = 'q 400 0 0 500 0 0 cm',
  extra: { readonly transparent?: boolean; readonly annotate?: (doc: PDFDocument) => void } = {},
): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const source = mupdf.Document.openDocument((await sample).slice(), 'application/pdf');
  const scan = new mupdf.PDFDocument();
  try {
    const pixmap = source
      .loadPage(0)
      .toPixmap(
        mupdf.Matrix.scale(200 / 72, 200 / 72),
        mupdf.ColorSpace.DeviceRGB,
        extra.transparent === true,
        false,
      );
    const image = scan.addImage(new mupdf.Image(pixmap.asPNG()));
    pixmap.destroy();
    const unicode = scan.addStream(
      [
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
        '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
        '1 begincodespacerange <00> <FF> endcodespacerange',
        '1 beginbfchar <01> <0001> endbfchar',
        'endcmap end end',
      ].join('\n'),
      {},
    );
    const fonts = {
      F1: scan.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }),
      F2: scan.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier', ToUnicode: unicode }),
    };
    const page = scan.addPage(
      [0, 0, 400, 500],
      0,
      { XObject: { Im0: image }, Font: fonts },
      `${placement} /Im0 Do Q\n${over}\n`,
    );
    scan.insertPage(-1, page);
    if (extra.annotate !== undefined) extra.annotate(scan);
    const saved = scan.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    return bytes;
  } finally {
    scan.destroy();
    source.destroy();
  }
}

/** An opaque black Square annotation over `rect` (PDF space, from the bottom): the "black box" of a pseudo-redaction. */
const blackBox =
  (rect: [number, number, number, number]) =>
  (doc: PDFDocument): void => {
    const [x0, y0, x1, y1] = rect;
    const appearance = doc.addStream(`0 g 0 0 ${x1 - x0} ${y1 - y0} re f`, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, x1 - x0, y1 - y0],
    });
    const annotation = doc.addObject({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: rect,
      F: 4,
      AP: { N: appearance },
    });
    const annotations = doc.newArray();
    annotations.push(annotation);
    doc.loadPage(0).getObject().put('Annots', annotations);
  };

/** A typed header over the scan's top (baseline 30 pt from the top). */
const HEADER = 'BT /F1 14 Tf 60 470 Td (Typed header) Tj ET';

/** The scene of a one-page document drawn by `content`. */
async function sceneOf(bytes: Uint8Array): Promise<PageScene> {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(bytes.slice(), 'application/pdf');
  try {
    const page = doc.loadPage(0);
    try {
      return readPageScene(mupdf, page);
    } finally {
      page.destroy();
    }
  } finally {
    doc.destroy();
  }
}

const word = (text: string, x0: number, x1: number, y0: number, y1: number, confidence = 95): OcrWord => ({
  text,
  x0,
  x1,
  y0,
  y1,
  confidence,
  block: 1,
  paragraph: 1,
  line: 1,
});

/** Where Helvetica 14 puts the three words of the sample line (page points, y down). */
const scanned = (): OcrWord[] => [
  word('Hello', 60, 92, 89, 103),
  word('world', 97, 130, 89, 103),
  word('today', 135, 165, 89, 103),
];

/** The text of each rendition of each box (DrawingML text and its VML fallback), joined. */
async function written(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await (zip.file('word/document.xml') as JSZip.JSZipObject).async('string');
  return Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(W, 't'))
    .map((t) => t.textContent)
    .join('');
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** The red channel of the PNG at a page point, as the recogniser was given it. */
async function redAt(png: Uint8Array, scale: number, x: number, y: number): Promise<number> {
  const mupdf = await loadMupdf();
  const pixmap = new mupdf.Image(png).toPixmap();
  try {
    const at =
      Math.round(y * scale) * pixmap.getStride() + Math.round(x * scale) * pixmap.getNumberOfComponents();
    return pixmap.getPixels()[at] as number;
  } finally {
    pixmap.destroy();
  }
}

describe('exact layout: real text over a scan', () => {
  it('keeps the typed header once as text and makes the scanned words text boxes', async () => {
    const seen: { png: Uint8Array; scale: number }[] = [];
    const result = await exportOffice(
      await scanWith(HEADER, PARAGRAPH),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async (png, scale) => {
            seen.push({ png, scale });
            // the header's own word, which the masked render cannot show, is among them
            return [...paragraphWords(), word('Typed', 60, 95, 20, 34)];
          },
        },
      },
      run,
    );
    expect(seen).toHaveLength(1);
    // The recogniser's picture has the header painted over with the scan's own tint (red 217), not black or white.
    const first = seen[0] ?? { png: new Uint8Array(), scale: 1 };
    const red = await redAt(first.png, first.scale, 75, 24);
    expect(red).toBeGreaterThan(205);
    expect(red).toBeLessThan(230);
    const body = await written(result.file.bytes);
    // Each box is written twice (DrawingML and its fallback), so once as text is twice here.
    expect(occurrences(body, 'Typed')).toBe(2);
    expect(occurrences(body.replaceAll(' ', ''), 'Typedheader')).toBe(2);
    expect(occurrences(body.replaceAll(' ', ''), 'aaaabbbbccccdddd')).toBe(6);
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.ocrMixedPages')?.params).toEqual({
      pages: '1',
    });
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrPages')).toBe(false);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrUnavailable')).toBe(false);
    // The scan stays behind as a picture, the page colour as a shape.
    const zip = await JSZip.loadAsync(result.file.bytes);
    expect(Object.keys(zip.files).some((name) => name.startsWith('word/media/'))).toBe(true);
  });

  it('leaves a page as it was when its picture is not text: a diagram, a few words of a logo, unsure reads', async () => {
    // the sample's dark panel and tint lie under these "words", so almost none of the picture's ink is text
    const diagram = paragraphWords();
    for (const found of [
      diagram,
      paragraphWords().slice(0, 7),
      paragraphWords(60),
      paragraphWords().slice(0, 4),
    ]) {
      const result = await exportOffice(
        await scanWith(HEADER),
        { ...options, ocr: { lowConfidence: 0.9, recognize: async () => found } },
        run,
      );
      expect(occurrences(await written(result.file.bytes), 'Typed')).toBe(2);
      expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrMixedPages')).toBe(false);
    }
  });

  it('leaves a page as it was when the picture holds nothing but the typed text', async () => {
    let calls = 0;
    const result = await exportOffice(
      await scanWith(HEADER, BLANK),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async () => {
            calls += 1;
            return scanned();
          },
        },
      },
      run,
    );
    expect(calls).toBe(0);
    expect(occurrences(await written(result.file.bytes), 'Typed')).toBe(2);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrMixedPages')).toBe(false);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrUnavailable')).toBe(false);
  });

  it('leaves a page as it was when OCR finds no scanned words, only unsure ones, or cannot run', async () => {
    for (const recognize of [
      async () => [word('Typed', 60, 95, 20, 34)],
      async () => scanned().map((entry) => ({ ...entry, confidence: 20 })),
      async () => {
        throw new Error('the language pack could not be fetched');
      },
    ]) {
      const result = await exportOffice(
        await scanWith(HEADER),
        { ...options, ocr: { lowConfidence: 0.9, recognize } },
        run,
      );
      expect(occurrences(await written(result.file.bytes), 'Typed')).toBe(2);
      expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrMixedPages')).toBe(false);
      expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrUnavailable')).toBe(false);
    }
  });

  it('reads a trusted invisible layer on a mixed page without the recogniser, minus the words under the typed text', async () => {
    let calls = 0;
    const layer = 'BT /F1 14 Tf 3 Tr 60 400 Td (Hello world today) Tj 60 470 Td (Typed) Tj ET';
    const result = await exportOffice(
      await scanWith(`${HEADER}\n${layer}`),
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
    const body = (await written(result.file.bytes)).replaceAll(' ', '');
    expect(occurrences(body, 'Typedheader')).toBe(2);
    expect(occurrences(body, 'Helloworldtoday')).toBe(2);
    expect(occurrences(body, 'Typed')).toBe(2);
  });

  it('leaves a mixed page as it was when the layer under the typed text is all there is', async () => {
    const result = await exportOffice(
      await scanWith(`${HEADER}\nBT /F1 14 Tf 3 Tr 60 466 Td (Typed header) Tj ET`),
      { ...options, ocr: { lowConfidence: 0.9, recognize: async () => scanned() } },
      run,
    );
    expect(occurrences(await written(result.file.bytes), 'Typed')).toBe(2);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrMixedPages')).toBe(false);
  });

  it('does not call the recogniser for typed text over a small picture, or typed text alone', async () => {
    let calls = 0;
    const ocr = {
      lowConfidence: 0.9,
      recognize: async () => {
        calls += 1;
        return scanned();
      },
    };
    await exportOffice(await SAMPLE, { ...options, ocr }, run);
    const small = await officeDocument([
      {
        content: ['0.5 g 0 0 400 500 re f', line('helvetica', 14, 60, 400, 'Typed header')].join('\n'),
        images: { Im0: { width: 8, height: 8, rgb: [20, 40, 60] } },
      },
    ]);
    await exportOffice(small, { ...options, ocr }, run);
    expect(calls).toBe(0);
  });
});

describe('exact layout: text inside a picture on a page of vector text', () => {
  /** The paragraph's page at half size, in the lower middle of the page: x 100–300, y 150–400 from the top. */
  const placement = 'q 200 0 0 250 100 100 cm';
  /** The twelve words of the picture, on the page (the picture's 0.5 scale and corner). */
  const inPicture = (confidence = 92): OcrWord[] =>
    paragraphWords(confidence).map((entry) => ({
      ...entry,
      x0: 100 + entry.x0 / 2,
      x1: 100 + entry.x1 / 2,
      y0: 150 + entry.y0 / 2,
      y1: 150 + entry.y1 / 2,
    }));

  it('makes the words of the picture text boxes, keeps the typed header once and the picture behind', async () => {
    const seen: Uint8Array[] = [];
    const result = await exportOffice(
      await scanWith(HEADER, PARAGRAPH, placement),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async (png) => {
            seen.push(png);
            // the header is masked out of what OCR is given, yet a stray read of it is among the words
            return [...inPicture(), word('Typed', 60, 95, 20, 34), word('stray', 20, 40, 450, 470, 95)];
          },
        },
      },
      run,
    );
    expect(seen).toHaveLength(1);
    const body = (await written(result.file.bytes)).replaceAll(' ', '');
    expect(occurrences(body, 'Typedheader')).toBe(2);
    expect(occurrences(body, 'aaaabbbbccccdddd')).toBe(6);
    expect(body).not.toContain('stray');
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.ocrMixedPages')?.params).toEqual({
      pages: '1',
    });
    // the picture is still there, set again without its words
    const zip = await JSZip.loadAsync(result.file.bytes);
    expect(Object.keys(zip.files).some((name) => name.startsWith('word/media/'))).toBe(true);
  });

  it('leaves the picture as it was when it has no ink, few or unsure words, or ink that is not text', async () => {
    let calls = 0;
    const cases: [Promise<Uint8Array>, () => Promise<OcrWord[]>][] = [
      [scanWith(HEADER, BLANK, placement), async () => inPicture()],
      [scanWith(HEADER, PARAGRAPH, placement), async () => inPicture(60)],
      [scanWith(HEADER, PARAGRAPH, placement), async () => inPicture().slice(0, 7)],
      // a logo or a chart: words, but the ink is the emblem and the bars (the sample's dark panel)
      [scanWith(HEADER, SAMPLE, placement), async () => inPicture()],
      [
        scanWith(HEADER, PARAGRAPH, placement),
        async () => {
          throw new Error('the language pack could not be fetched');
        },
      ],
    ];
    for (const [bytes, recognize] of cases) {
      const result = await exportOffice(
        await bytes,
        {
          ...options,
          ocr: {
            lowConfidence: 0.9,
            recognize: async () => {
              calls += 1;
              return recognize();
            },
          },
        },
        run,
      );
      const body = (await written(result.file.bytes)).replaceAll(' ', '');
      expect(occurrences(body, 'Typedheader')).toBe(2);
      expect(body).not.toContain('aaaabbbb');
      expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrMixedPages')).toBe(false);
    }
    // the blank picture and the logo-like one (the sample: a panel and a line) are not even read
    expect(calls).toBe(3);
  });
});

describe('exact layout: the invisible layer trust gate', () => {
  const garbage =
    'BT /F2 14 Tf 3 Tr 60 400 Td (\\001\\001\\001\\001 \\001\\001\\001\\001 \\001\\001\\001\\001\\001) Tj ET';

  it('reads a layer of unreadable characters with OCR instead and says so', async () => {
    let calls = 0;
    const result = await exportOffice(
      await scanWith(garbage),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async () => {
            calls += 1;
            return scanned();
          },
        },
      },
      run,
    );
    expect(calls).toBe(1);
    const body = (await written(result.file.bytes)).replaceAll(' ', '');
    expect(occurrences(body, 'Helloworldtoday')).toBe(2);
    expect(body).not.toContain('\uFFFD');
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.ocrLayerRejected')?.params).toEqual(
      {
        pages: '1',
      },
    );
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.ocrPages')?.params).toEqual({
      pages: '1',
    });
  });

  it('still reuses a good layer, and says nothing about a layer', async () => {
    let calls = 0;
    const result = await exportOffice(
      await scanWith('BT /F1 14 Tf 3 Tr 60 400 Td (Hello world today) Tj ET'),
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
    expect(occurrences((await written(result.file.bytes)).replaceAll(' ', ''), 'Helloworldtoday')).toBe(2);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrLayerRejected')).toBe(false);
  });

  it('falls back to the layer when it is not trusted but OCR cannot run, or is not there', async () => {
    for (const ocr of [
      {
        lowConfidence: 0.9,
        recognize: async (): Promise<OcrWord[]> => {
          throw new Error('offline');
        },
      },
      null,
    ]) {
      const result = await exportOffice(
        await scanWith(garbage),
        ocr === null ? options : { ...options, ocr },
        run,
      );
      expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrLayerRejected')).toBe(false);
      expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrPages')).toBe(true);
      expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrUnavailable')).toBe(false);
    }
  });

  it('trusts a layer with fewer than a tenth of its characters unreadable, not one with a tenth', async () => {
    const layer = (bad: number) =>
      `BT /F2 3 Tf 3 Tr 40 400 Td (${'a'.repeat(100 - bad)}${'\\001'.repeat(bad)}) Tj ET`;
    expect(layerTrusted(await sceneOf(await scanWith(layer(0))))).toBe(true);
    expect(layerTrusted(await sceneOf(await scanWith(layer(9))))).toBe(true);
    expect(layerTrusted(await sceneOf(await scanWith(layer(10))))).toBe(false);
  });

  it('trusts a page with no layer, and judges turned lines against the dominant direction', async () => {
    expect(layerTrusted(await sceneOf(await scanWith('')))).toBe(true);
    const across = `BT /F1 4 Tf 3 Tr 40 400 Td (${'a'.repeat(95)}) Tj ET`;
    // a block turned a quarter round by design: 5 of 100 characters is within the gate, 20 of 100 is not
    const turned = (count: number) => `BT /F1 4 Tf 3 Tr 0 1 -1 0 300 100 Tm (${'b'.repeat(count)}) Tj ET`;
    expect(layerTrusted(await sceneOf(await scanWith(`${across}\n${turned(4)}`)))).toBe(true);
    expect(layerTrusted(await sceneOf(await scanWith(`${across}\n${turned(20)}`)))).toBe(false);
    // two lines in the same direction weigh together
    const second = `BT /F1 4 Tf 3 Tr 40 380 Td (${'c'.repeat(50)}) Tj ET`;
    expect(layerTrusted(await sceneOf(await scanWith(`${across}\n${second}\n${turned(10)}`)))).toBe(true);
  });
});

describe('mixed page helpers', () => {
  it('tells a scan, a mixed page and a plain page apart', async () => {
    const mixed = await sceneOf(await scanWith(HEADER));
    expect(isMixedPage(mixed)).toBe(true);
    expect(isScanPage(mixed)).toBe(false);
    const scan = await sceneOf(await scanWith(''));
    expect(isScanPage(scan)).toBe(true);
    expect(isMixedPage(scan)).toBe(false);
    const plain = await sceneOf(await SAMPLE);
    expect(isScanPage(plain)).toBe(false);
    expect(isMixedPage(plain)).toBe(false);
  });

  it('boxes the visible text by run: a gap splits a line, the invisible layer has no box', async () => {
    const scene = await sceneOf(
      await scanWith(
        [
          'BT /F1 14 Tf 60 470 Td (Near words) Tj ET',
          'BT /F1 14 Tf 300 470 Td (Far) Tj ET',
          'BT /F1 14 Tf 3 Tr 60 400 Td (hidden) Tj ET',
        ].join('\n'),
      ),
    );
    const boxes = visibleBoxes(scene);
    expect(boxes).toHaveLength(2);
    const [near = [0, 0, 0, 0], far = [0, 0, 0, 0]] = [...boxes].sort((a, b) => a[0] - b[0]);
    expect(near[0]).toBeCloseTo(60, 0);
    expect(near[2]).toBeLessThan(150);
    expect(far[0]).toBeGreaterThan(290);
    // within the page, near the top
    expect(near[1]).toBeLessThan(35);
    expect(near[3]).toBeGreaterThan(25);
  });

  const image = (width: number, height: number, colour: readonly number[]): RgbaImage => {
    const data = new Uint8Array(width * height * 4);
    for (let at = 0; at < width * height; at += 1) data.set([...colour, 255], at * 4);
    return { width, height, data, scale: 1 };
  };

  it('paints a box with the colour around it and returns the same image when there is no box', () => {
    const page = image(40, 40, [10, 200, 30]);
    // text-like marks inside the box
    page.data.set([0, 0, 0, 255], (20 * 40 + 20) * 4);
    expect(maskBoxes(page, [])).toBe(page);
    const masked = maskBoxes(page, [[15, 15, 25, 25]]);
    expect(masked).not.toBe(page);
    expect(Array.from(masked.data.subarray((20 * 40 + 20) * 4, (20 * 40 + 20) * 4 + 3))).toEqual([
      10, 200, 30,
    ]);
    // the original is untouched
    expect(page.data[(20 * 40 + 20) * 4]).toBe(0);
    // a box at the page's edge samples what lies on the page; a box over all of it falls back to white
    expect(Array.from(maskBoxes(page, [[0, 0, 10, 10]]).data.subarray(0, 3))).toEqual([10, 200, 30]);
    expect(Array.from(maskBoxes(page, [[0, 0, 40, 40]]).data.subarray(0, 3))).toEqual([255, 255, 255]);
  });

  it('finds the boxes with ink of their own: some of their pixels, not most, differ from the background', () => {
    const inside: [number, number, number, number] = [0, 0, 40, 40];
    const elsewhere: [number, number, number, number] = [100, 100, 120, 120];
    const blank = image(40, 40, [255, 255, 255]);
    expect(inkBoxes(blank, [inside])).toEqual([]);
    const marked = image(40, 40, [255, 255, 255]);
    for (let y = 10; y < 14; y += 1)
      for (let x = 5; x < 35; x += 1) marked.data.set([0, 0, 0], (y * 40 + x) * 4);
    expect(inkBoxes(marked, [inside, elsewhere])).toEqual([inside]);
    expect(inkBoxes(image(40, 40, [0, 0, 0]), [inside])).toEqual([]);
    const photo = image(40, 40, [255, 255, 255]);
    for (let y = 0; y < 40; y += 1)
      for (let x = 0; x < 20; x += 1) photo.data.set([0, 0, 0], (y * 40 + x) * 4);
    expect(inkBoxes(photo, [inside])).toEqual([]);
  });

  it('searches the pictures of at least 2 % of the page for text', async () => {
    const scene = await sceneOf(await scanWith(HEADER, SAMPLE, 'q 200 0 0 250 100 100 cm'));
    expect(textPictures(scene)).toHaveLength(1);
    const small = await sceneOf(await scanWith(HEADER, SAMPLE, 'q 20 0 0 20 100 100 cm'));
    expect(textPictures(small)).toHaveLength(0);
    expect(textPictures(await sceneOf(await SAMPLE))).toHaveLength(0);
  });

  /** A white page of 100 × 100 with black bars where text is: `rows` rows of ink 4 high, x 10…90. */
  const barred = (rows: number): RgbaImage => {
    const page = image(100, 100, [255, 255, 255]);
    for (let row = 0; row < rows; row += 1)
      for (let y = 10 + 10 * row; y < 14 + 10 * row; y += 1)
        for (let x = 10; x < 90; x += 1) page.data.set([0, 0, 0], (y * 100 + x) * 4);
    return page;
  };
  const wordOn = (row: number, column: number, confidence = 90): OcrWord => ({
    ...word('w', 10 + 10 * column, 18 + 10 * column, 8 + 10 * row, 16 + 10 * row, confidence),
    line: row,
  });
  const wholePage: [number, number, number, number] = [0, 0, 100, 100];

  it('measures a picture: the words, their lines and confidence, and how much of the ink is under them', () => {
    const rows = [0, 1];
    const words = rows.flatMap((row) => [0, 1, 2, 3, 4, 5, 6, 7].map((column) => wordOn(row, column)));
    const stats = pictureStats(barred(2), wholePage, words);
    expect(stats).toMatchObject({ words: 16, lines: 2, confidence: 90 });
    expect(stats.inkInWords).toBeCloseTo(1, 1);
    expect(stats.paper).toBeGreaterThan(0.8);
    // the same words over ink that is elsewhere
    expect(pictureStats(barred(6), wholePage, words).inkInWords).toBeLessThan(0.4);
    // no words, no ink, a box off the image
    expect(pictureStats(image(100, 100, [255, 255, 255]), wholePage, []).inkInWords).toBe(0);
    expect(pictureStats(barred(2), [200, 200, 300, 300], []).paper).toBe(0);
  });

  it('takes the words of a picture only when there are enough, on lines, sure, and over most of its ink', () => {
    const rows = [0, 1];
    const eight = rows.flatMap((row) => [0, 1, 2, 3].map((column) => wordOn(row, column)));
    expect(wordsInPicture(barred(2), eight, wholePage)).toEqual(eight);
    // a word outside the box is not taken
    const outside = { ...wordOn(0, 0), x0: 300, x1: 310 };
    expect(wordsInPicture(barred(2), [...eight, outside], wholePage)).toEqual(eight);
    // seven words, unsure words, one line, ink elsewhere
    expect(wordsInPicture(barred(2), eight.slice(0, 7), wholePage)).toEqual([]);
    expect(
      wordsInPicture(
        barred(2),
        eight.map((entry) => ({ ...entry, confidence: 70 })),
        wholePage,
      ),
    ).toEqual([]);
    const oneLine = [0, 1, 2, 3, 4, 5, 6, 7].map((column) => wordOn(0, column));
    expect(wordsInPicture(barred(2), oneLine, wholePage)).toEqual([]);
    expect(wordsInPicture(barred(8), eight, wholePage)).toEqual([]);
    expect(wordsInPicture(barred(2), [], wholePage)).toEqual([]);
    // above, below and left of the box
    const away = [word('w', 110, 120, 50, 60), word('w', 110, 120, 250, 260), word('w', 10, 20, 140, 150)];
    expect(wordsInPicture(barred(2), away, [100, 100, 200, 200])).toEqual([]);
  });

  it('drops words on a masked box and unsure slivers next to one, and keeps the rest', () => {
    const boxes: [number, number, number, number][] = [[100, 100, 200, 120]];
    const kept = [
      word('far', 300, 330, 100, 120),
      word('above', 100, 130, 60, 80, 10),
      word('left', 20, 40, 100, 120, 10),
      word('sure', 201, 230, 100, 120, 90),
      word('edge', 90, 110, 100, 120, 90),
    ];
    const dropped = [
      word('inside', 110, 150, 102, 118),
      word('sliver', 201, 205, 100, 120, 10),
      word('corner', 201, 205, 121, 125, 10),
    ];
    expect(dropMasked([...kept, ...dropped], boxes, 1).map((entry) => entry.text)).toEqual(
      kept.map((entry) => entry.text),
    );
    expect(dropMasked(dropped, [], 1)).toEqual(dropped);
  });
});

describe('exact layout: what the reader sees is what OCR reads', () => {
  it('gives the recogniser the page with its annotations: text under an opaque box is not read', async () => {
    // the box lies over the picture's first two rows (page y 90..130 from the top)
    const covered = blackBox([50, 360, 250, 412]);
    for (const [bytes, calls, at] of [
      [await scanWith('', PARAGRAPH, 'q 400 0 0 500 0 0 cm', { annotate: covered }), 1, 110],
      [
        await scanWith(HEADER, PARAGRAPH, 'q 200 0 0 250 100 100 cm', {
          annotate: blackBox([100, 100 + 100, 300, 100 + 200]),
        }),
        1,
        250,
      ],
    ] as const) {
      const seen: { png: Uint8Array; scale: number }[] = [];
      await exportOffice(
        bytes,
        {
          ...options,
          ocr: {
            lowConfidence: 0.9,
            recognize: async (png, scale) => {
              seen.push({ png, scale });
              return [];
            },
          },
        },
        run,
      );
      expect(seen).toHaveLength(calls);
      const first = seen[0] ?? { png: new Uint8Array(), scale: 1 };
      // the black box is in the picture the recogniser reads (the paragraph's tint is red 217 there)
      expect(await redAt(first.png, first.scale, 150, at)).toBeLessThan(30);
    }
  });

  it('drops the words of an invisible layer that lie under an opaque box, keeping the others', async () => {
    const layer =
      'BT /F1 14 Tf 3 Tr 60 400 Td (Hello) Tj ET\nBT /F1 14 Tf 3 Tr 60 380 Td (secret) Tj ET\nBT /F1 14 Tf 3 Tr 60 360 Td (Other) Tj ET';
    const sample = officeDocument([
      {
        content: [
          '0.85 0.92 1 rg 0 0 400 500 re f',
          line('helvetica', 14, 60, 400, 'Hello'),
          line('helvetica', 14, 60, 380, 'secret'),
          line('helvetica', 14, 60, 360, 'Other'),
        ].join('\n'),
      },
    ]);
    let calls = 0;
    const result = await exportOffice(
      await scanWith(layer, sample, 'q 400 0 0 500 0 0 cm', { annotate: blackBox([55, 375, 130, 395]) }),
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
    const body = await written(result.file.bytes);
    expect(occurrences(body, 'Hello')).toBe(2);
    expect(occurrences(body, 'Other')).toBe(2);
    expect(body).not.toContain('secret');
  });
});

describe('exact layout: watermarks and pictures drawn twice', () => {
  const WATERMARK = 'BT /F1 40 Tf 0.7071 0.7071 -0.7071 0.7071 60 100 Tm (CONFIDENTIAL) Tj ET';

  it('boxes diagonal text by character, not as one box over the page', async () => {
    const boxes = visibleBoxes(await sceneOf(await scanWith(WATERMARK)));
    expect(boxes.length).toBeGreaterThanOrEqual(10);
    for (const box of boxes) expect((box[2] - box[0]) * (box[3] - box[1])).toBeLessThan(6000);
    // and upright text is still boxed by run, a vertical line too
    const upright = visibleBoxes(
      await sceneOf(await scanWith('BT /F1 14 Tf 0 1 -1 0 300 100 Tm (Turned words) Tj ET')),
    );
    expect(upright).toHaveLength(1);
  });

  it('leaves the scan under a watermark: only the watermark is painted over', async () => {
    const seen: { png: Uint8Array; scale: number }[] = [];
    await exportOffice(
      await scanWith(WATERMARK),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async (png, scale) => {
            seen.push({ png, scale });
            return scanned();
          },
        },
      },
      run,
    );
    const first = seen[0] ?? { png: new Uint8Array(), scale: 1 };
    // the dark panel (x 40–240, y 200–300 from the top, red 153) away from the diagonal's line stays; the old one-box mask painted it over
    expect(await redAt(first.png, first.scale, 80, 290)).toBeLessThan(170);
    expect(await redAt(first.png, first.scale, 80, 290)).toBeGreaterThan(130);
  });

  it('writes the words of a picture drawn twice once', async () => {
    // the same picture again, over the lower part of the first one
    const twice = 'q 100 0 0 125 150 150 cm /Im0 Do Q';
    const result = await exportOffice(
      await scanWith(`${HEADER}\n${twice}`, PARAGRAPH, 'q 200 0 0 250 100 100 cm'),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async () => [
            ...paragraphWords().map((entry) => ({
              ...entry,
              x0: 100 + entry.x0 / 2,
              x1: 100 + entry.x1 / 2,
              y0: 150 + entry.y0 / 2,
              y1: 150 + entry.y1 / 2,
            })),
          ],
        },
      },
      run,
    );
    const body = (await written(result.file.bytes)).replaceAll(' ', '');
    expect(occurrences(body, 'aaaabbbbccccdddd')).toBe(6);
  });

  it('does not paint black over the see-through parts of a picture whose words are read', async () => {
    const text = officeDocument([
      {
        content: [
          '0 g',
          ...[0, 1, 2].map((row) => line('courier', 12, 60, 400 - 20 * row, 'aaaa bbbb cccc dddd')),
        ].join('\n'),
      },
    ]);
    const result = await exportOffice(
      await scanWith(HEADER, text, 'q 200 0 0 250 100 100 cm', { transparent: true }),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async () =>
            paragraphWords().map((entry) => ({
              ...entry,
              x0: 100 + entry.x0 / 2,
              x1: 100 + entry.x1 / 2,
              y0: 150 + entry.y0 / 2,
              y1: 150 + entry.y1 / 2,
            })),
        },
      },
      run,
    );
    const zip = await JSZip.loadAsync(result.file.bytes);
    const mupdf = await loadMupdf();
    for (const name of Object.keys(zip.files).filter(
      (entry) => entry.startsWith('word/media/') && zip.file(entry) !== null,
    )) {
      const picture = new mupdf.Image(await (zip.file(name) as JSZip.JSZipObject).async('uint8array'));
      const pixmap = picture.toPixmap();
      try {
        // the corner of the transparent picture is still transparent (or white when flattened), never opaque black
        const px = pixmap.getPixels();
        const channels = pixmap.getNumberOfComponents();
        const corner = Array.from(px.subarray(0, channels));
        const opaqueBlack = corner.slice(0, 3).every((value) => value === 0) && (corner[3] ?? 255) === 255;
        expect(opaqueBlack).toBe(false);
      } finally {
        pixmap.destroy();
        picture.destroy();
      }
    }
  });
});

describe('exact layout: cheap decisions about pictures', () => {
  it('does not render or read a page whose picture is a logo, a photograph or empty', async () => {
    let calls = 0;
    const ocr = {
      lowConfidence: 0.9,
      recognize: async () => {
        calls += 1;
        return paragraphWords();
      },
    };
    for (const sample of [SAMPLE, BLANK]) {
      await exportOffice(
        await scanWith(HEADER, sample, 'q 200 0 0 250 100 100 cm'),
        { ...options, ocr },
        run,
      );
    }
    expect(calls).toBe(0);
  });

  it('keeps a JPEG picture a JPEG when its words are erased', async () => {
    const mupdf = await loadMupdf();
    const source = mupdf.Document.openDocument((await PARAGRAPH).slice(), 'application/pdf');
    const pixmap = source
      .loadPage(0)
      .toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceRGB, false, false);
    const jpeg = pixmap.asJPEG(90, false);
    const doc = new mupdf.PDFDocument();
    const image = doc.addImage(new mupdf.Image(jpeg));
    const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, 400, 500],
        0,
        { XObject: { Im0: image }, Font: { F1: font } },
        `${HEADER.replace('/F1', '/F1')}\nq 200 0 0 250 100 100 cm /Im0 Do Q\n`,
      ),
    );
    const bytes = doc.saveToBuffer('compress').asUint8Array().slice();
    pixmap.destroy();
    source.destroy();
    doc.destroy();
    const result = await exportOffice(
      bytes,
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async () =>
            paragraphWords().map((entry) => ({
              ...entry,
              x0: 100 + entry.x0 / 2,
              x1: 100 + entry.x1 / 2,
              y0: 150 + entry.y0 / 2,
              y1: 150 + entry.y1 / 2,
            })),
        },
      },
      run,
    );
    expect(occurrences((await written(result.file.bytes)).replaceAll(' ', ''), 'aaaabbbbccccdddd')).toBe(6);
    const zip = await JSZip.loadAsync(result.file.bytes);
    expect(Object.keys(zip.files).filter((name) => /word\/media\/.*\.jpe?g$/.test(name))).not.toHaveLength(0);
  });
});
