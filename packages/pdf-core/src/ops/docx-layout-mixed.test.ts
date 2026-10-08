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
): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const source = mupdf.Document.openDocument((await sample).slice(), 'application/pdf');
  const scan = new mupdf.PDFDocument();
  try {
    const pixmap = source
      .loadPage(0)
      .toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceRGB, false, false);
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
    const saved = scan.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    return bytes;
  } finally {
    scan.destroy();
    source.destroy();
  }
}

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
      await scanWith(HEADER),
      {
        ...options,
        ocr: {
          lowConfidence: 0.9,
          recognize: async (png, scale) => {
            seen.push({ png, scale });
            // the header's own word, which the masked render cannot show, is among them
            return [...scanned(), word('Typed', 60, 95, 20, 34)];
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
    expect(occurrences(body.replaceAll(' ', ''), 'Helloworldtoday')).toBe(2);
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.ocrMixedPages')?.params).toEqual({
      pages: '1',
    });
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrPages')).toBe(false);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrUnavailable')).toBe(false);
    // The scan stays behind as a picture, the page colour as a shape.
    const zip = await JSZip.loadAsync(result.file.bytes);
    expect(Object.keys(zip.files).some((name) => name.startsWith('word/media/'))).toBe(true);
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
  /** The sample's picture at half size, in the lower middle of the page: x 100–300, y 150–400 from the top. */
  const placement = 'q 200 0 0 250 100 100 cm';
  /** Where the picture's line of text lies on the page (the sample's 60…165 × 89…103 halved, shifted by the picture's corner). */
  const inPicture = (confidence = 90): OcrWord[] => [
    word('Hello', 130, 146, 194, 201, confidence),
    word('world', 148, 165, 194, 201, confidence),
    word('today', 167, 182, 194, 201, confidence),
  ];

  it('makes the words of the picture text boxes, keeps the typed header once and the picture behind', async () => {
    const seen: Uint8Array[] = [];
    const result = await exportOffice(
      await scanWith(HEADER, SAMPLE, placement),
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
    expect(occurrences(body, 'Helloworldtoday')).toBe(2);
    expect(body).not.toContain('stray');
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.ocrMixedPages')?.params).toEqual({
      pages: '1',
    });
    // the picture is still there, set again without its words
    const zip = await JSZip.loadAsync(result.file.bytes);
    expect(Object.keys(zip.files).some((name) => name.startsWith('word/media/'))).toBe(true);
  });

  it('leaves the page as it was for a picture without ink, unsure words, too few words, or no recogniser', async () => {
    let calls = 0;
    const cases: [Promise<Uint8Array>, () => Promise<OcrWord[]>][] = [
      [scanWith(HEADER, BLANK, placement), async () => inPicture()],
      [scanWith(HEADER, SAMPLE, placement), async () => inPicture(40)],
      [scanWith(HEADER, SAMPLE, placement), async () => inPicture().slice(0, 2)],
      [
        scanWith(HEADER, SAMPLE, placement),
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
            recognize: async (...args) => {
              calls += 1;
              void args;
              return recognize();
            },
          },
        },
        run,
      );
      const body = (await written(result.file.bytes)).replaceAll(' ', '');
      expect(occurrences(body, 'Typedheader')).toBe(2);
      expect(body).not.toContain('Helloworldtoday');
      expect(result.notes.some((note) => note.key === 'op.note.exportOffice.ocrMixedPages')).toBe(false);
    }
    // the blank picture is not even read
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

  it('takes the words of a picture only when there are enough and they are sure', () => {
    const box: [number, number, number, number] = [100, 100, 200, 200];
    const at = (x: number, confidence: number) => word('w', x, x + 10, 140, 150, confidence);
    const sure = [at(110, 90), at(130, 80), at(150, 70)];
    expect(wordsInPicture([...sure, at(300, 90)], box)).toEqual(sure);
    expect(wordsInPicture([at(110, 90), at(130, 80), at(300, 90)], box)).toEqual([]);
    expect(wordsInPicture([at(110, 50), at(130, 50), at(150, 50)], box)).toEqual([]);
    expect(wordsInPicture([], box)).toEqual([]);
    // above, below and left of the box
    expect(
      wordsInPicture(
        [word('w', 110, 120, 50, 60), word('w', 110, 120, 250, 260), word('w', 10, 20, 140, 150)],
        box,
      ),
    ).toEqual([]);
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
