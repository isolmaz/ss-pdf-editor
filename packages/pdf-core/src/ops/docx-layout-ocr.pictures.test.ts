/**
 * The text inside a picture on a page of vector text (`readPictureText`): a picture of text has
 * its words taken out of it and set as text boxes over it; a picture with see-through pixels is
 * left as it is (its glyphs stay behind the words); a picture of a grey scale is read as the
 * colour one is; a shape beside the picture is left alone.
 */

import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import type { Page } from 'mupdf';
import { describe, expect, it, vi } from 'vitest';
import { loadMupdf, type Mupdf } from '../engines/mupdf';
import type { OcrWord } from '../engines/tesseract';
import { exportOffice } from './export-office';
import { line, officeDocument } from './export-office-fixtures';
import type * as Reader from './layout-scene-read';
import type { OperationContext } from './types';

const state = vi.hoisted(() => ({
  grey: 'off' as 'off' | 'grey' | 'greyAlpha',
  /** What stopped the scene from being read grey: the export reads the page as one picture then, which is no grey scene. */
  failure: undefined as unknown,
}));

/** Pictures of the scene are turned grey (or grey with an alpha channel) when `state.grey` says so, as a grey scale scene would hold. */
vi.mock('./layout-scene-read', async (importOriginal) => {
  const original = await importOriginal<typeof Reader>();
  const greyed = (mupdf: Mupdf, data: Uint8Array, withAlpha: boolean): Uint8Array => {
    const image = new mupdf.Image(data);
    const colour = image.toPixmap();
    const width = colour.getWidth();
    const height = colour.getHeight();
    const grey = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, width, height], withAlpha);
    try {
      const from = colour.getPixels();
      const to = grey.getPixels();
      const fromStep = colour.getNumberOfComponents();
      const toStep = withAlpha ? 2 : 1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const source = y * colour.getStride() + x * fromStep;
          const target = y * grey.getStride() + x * toStep;
          to[target] = Math.round(
            0.299 * (from[source] as number) +
              0.587 * (from[source + 1] as number) +
              0.114 * (from[source + 2] as number),
          );
          if (withAlpha) to[target + 1] = 255;
        }
      }
      return grey.asPNG().slice();
    } finally {
      grey.destroy();
      colour.destroy();
      image.destroy();
    }
  };
  return {
    ...original,
    readPageScene: (mupdf: Mupdf, page: Page, contentsOnly?: boolean) => {
      const scene = original.readPageScene(mupdf, page, contentsOnly);
      if (state.grey === 'off') return scene;
      try {
        return {
          ...scene,
          items: scene.items.map((item) =>
            item.kind === 'image'
              ? { ...item, data: greyed(mupdf, item.data, state.grey === 'greyAlpha') }
              : item,
          ),
        };
      } catch (error) {
        state.failure = error;
        throw error;
      }
    },
  };
});

// Each export renders the page, reads it and matches the words against the open faces.
vi.setConfig({ testTimeout: 60_000 });

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const run: OperationContext = { signal: new AbortController().signal };
const options = { pages: [0], baseName: 'scan.pdf', format: 'docx', docxLayout: 'layout' } as const;

/** A tinted page of three lines of four words each, in Courier 12 (7.2 pt a letter): what a scanned letter shows. */
const PARAGRAPH = officeDocument([
  {
    content: [
      '0.85 0.92 1 rg 0 0 400 500 re f',
      ...[0, 1, 2].map((row) => line('courier', 12, 60, 400 - 20 * row, 'aaaa bbbb cccc dddd')),
    ].join('\n'),
  },
]);

const HEADER = 'BT /F1 14 Tf 60 470 Td (Typed header) Tj ET';

/** The paragraph as a picture on a page of typed text: the picture drawn after `placement`, `over` drawn on top. */
async function pageWith(over: string, placement: string): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const source = mupdf.Document.openDocument((await PARAGRAPH).slice(), 'application/pdf');
  const doc = new mupdf.PDFDocument();
  try {
    const pixmap = source
      .loadPage(0)
      .toPixmap(mupdf.Matrix.scale(200 / 72, 200 / 72), mupdf.ColorSpace.DeviceRGB, false, false);
    const image = doc.addImage(new mupdf.Image(pixmap.asPNG()));
    pixmap.destroy();
    const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, 400, 500],
        0,
        {
          XObject: { Im0: image },
          Font: { F1: font },
          ExtGState: { GS1: { Type: 'ExtGState', ca: 0.9 } },
        },
        `${placement} /Im0 Do Q\n${over}\n`,
      ),
    );
    const saved = doc.saveToBuffer('compress');
    const bytes = saved.asUint8Array().slice();
    saved.destroy();
    return bytes;
  } finally {
    doc.destroy();
    source.destroy();
  }
}

/** The twelve words of the picture on the page: its 0.5 scale and its corner (x 100–300, y 150–400 from the top). */
const inPicture = (): OcrWord[] =>
  [0, 1, 2].flatMap((row) =>
    [0, 1, 2, 3].map((column) => {
      const x0 = 60 + 36 * column;
      const y0 = 91 + 20 * row;
      return {
        text: 'abcd'[column]?.repeat(4) ?? '',
        x0: 100 + x0 / 2,
        x1: 100 + (x0 + 28.8) / 2,
        y0: 150 + y0 / 2,
        y1: 150 + (y0 + 12) / 2,
        confidence: 92,
        block: 1,
        paragraph: 1,
        line: row + 1,
      };
    }),
  );

const PLACEMENT = 'q 200 0 0 250 100 100 cm';

/** What the export of `bytes` holds: the text of its boxes, the dark pixels of its pictures, and the page XML. */
async function exported(bytes: Uint8Array) {
  const result = await exportOffice(
    bytes,
    { ...options, ocr: { lowConfidence: 0.9, recognize: async () => inPicture() } },
    run,
  );
  const zip = await JSZip.loadAsync(result.file.bytes);
  const xml = await (zip.file('word/document.xml') as JSZip.JSZipObject).async('string');
  const body = Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagNameNS(W, 't'))
    .map((t) => t.textContent)
    .join('')
    .replaceAll(' ', '');
  const mupdf = await loadMupdf();
  let ink = 0;
  for (const entry of zip.file(/^word\/media\//)) {
    const pixmap = new mupdf.Image(await entry.async('uint8array')).toPixmap();
    const pixels = pixmap.getPixels();
    const step = pixmap.getNumberOfComponents();
    for (let y = 0; y < pixmap.getHeight(); y += 1) {
      for (let x = 0; x < pixmap.getWidth(); x += 1) {
        if ((pixels[y * pixmap.getStride() + x * step] as number) < 100) ink += 1;
      }
    }
    pixmap.destroy();
  }
  return { body, ink, xml };
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('exact layout: text inside a picture on a page of vector text', () => {
  it('takes the words out of an opaque picture, and leaves them in a see-through one', async () => {
    const opaque = await exported(await pageWith(HEADER, PLACEMENT));
    const seeThrough = await exported(await pageWith(HEADER, 'q /GS1 gs 200 0 0 250 100 100 cm'));
    // Three lines, each set twice (DrawingML text and its VML fallback), in both.
    expect(occurrences(opaque.body, 'aaaabbbbccccdddd')).toBe(6);
    expect(occurrences(seeThrough.body, 'aaaabbbbccccdddd')).toBe(6);
    // The picture's own glyphs: gone from the opaque picture, still in the see-through one.
    expect(seeThrough.ink).toBeGreaterThan(1000);
    expect(opaque.ink).toBeLessThan(seeThrough.ink / 10);
  });

  it('leaves a shape of the page where it is, beside the picture it reads', async () => {
    const withShape = await exported(await pageWith(`${HEADER}\n0 0 1 rg 20 20 30 30 re f`, PLACEMENT));
    expect(occurrences(withShape.body, 'aaaabbbbccccdddd')).toBe(6);
    expect(withShape.xml.toUpperCase()).toContain('0000FF');
    const alone = await exported(await pageWith(HEADER, PLACEMENT));
    expect(withShape.ink).toBe(alone.ink);
  });

  it('reads a picture of a grey scale, with or without an alpha channel, as it reads a colour one', async () => {
    const seeThrough = await exported(await pageWith(HEADER, 'q /GS1 gs 200 0 0 250 100 100 cm'));
    for (const grey of ['grey', 'greyAlpha'] as const) {
      state.grey = grey;
      try {
        const read = await exported(await pageWith(HEADER, PLACEMENT));
        expect(state.failure).toBeUndefined();
        expect(occurrences(read.body, 'aaaabbbbccccdddd')).toBe(6);
        expect(read.ink).toBeLessThan(seeThrough.ink / 10);
      } finally {
        state.grey = 'off';
      }
    }
  });
});
