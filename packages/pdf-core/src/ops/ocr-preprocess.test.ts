/**
 * Turning a crooked scan upright before OCR (`ocr-preprocess.ts`), on pages MuPDF renders: the
 * skew found, the page turned on the same canvas, and a level page left alone.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { line, officeDocument } from './export-office-fixtures';
import type { TextBox, TextParagraph, TextRun } from './layout-scene';
import {
  detectSkew,
  type Grey,
  isSkewed,
  otsu,
  rotateAbout,
  toGrey,
  turnBoxes,
  turnImage,
  uprightScan,
} from './ocr-preprocess';
import type { RgbaImage } from './ocr-scene';

const SENTENCES = [
  'The quick brown fox jumps over the lazy dog',
  'Pack my box with five dozen liquor jugs',
  'How vexingly quick daft zebras jump today',
  'Sphinx of black quartz judge my vow',
  'Amazingly few discotheques provide jukeboxes',
  'Jackdaws love my big sphinx of quartz',
  'The five boxing wizards jump quickly',
  'Crazy Fredrick bought many very exquisite opal jewels',
  'We promptly judged antique ivory buckles',
  'A wizard job is to vex chumps quickly in fog',
];

/** Operators in the sheet's own frame, turned by `degrees` (positive: lines descend to the right) about the page centre. */
function turned(degrees: number, operators: string): string {
  const phi = (-degrees * Math.PI) / 180;
  const c = Math.cos(phi).toFixed(6);
  const s = Math.sin(phi).toFixed(6);
  return `q ${c} ${s} ${-s} ${c} 200 250 cm\n${operators}\nQ`;
}

/** Ten lines of text, level, in the sheet's own frame; `color` the ink. */
const textLines = (color = '0 0 0'): string =>
  SENTENCES.map((text, at) => line('helvetica', 12, -160, 170 - at * 34, text, color)).join('\n');

/** Ten lines of text; `degrees` is the skew (positive: lines descend to the right), `color` the ink. */
const pageContent = (degrees: number, color = '0 0 0'): string => turned(degrees, textLines(color));

/** The page (400 × 500 pt, or `size`) drawn at `dpi` as RGBA pixels. */
async function render(content: string, dpi: number, size?: readonly [number, number]): Promise<RgbaImage> {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(
    (await officeDocument([{ content, ...(size === undefined ? {} : { size }) }])).slice(),
    'application/pdf',
  );
  try {
    const pixmap = doc
      .loadPage(0)
      .toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceRGB, false, false);
    try {
      const width = pixmap.getWidth();
      const height = pixmap.getHeight();
      const from = pixmap.getPixels();
      const stride = pixmap.getStride();
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          for (let channel = 0; channel < 3; channel += 1) {
            data[(y * width + x) * 4 + channel] = from[y * stride + x * 3 + channel] as number;
          }
          data[(y * width + x) * 4 + 3] = 255;
        }
      }
      return { width, height, data, scale: dpi / 72 };
    } finally {
      pixmap.destroy();
    }
  } finally {
    doc.destroy();
  }
}

const grey = (width: number, height: number, fill: (x: number, y: number) => number): Grey => {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[y * width + x] = fill(x, y);
  return { width, height, data };
};

/**
 * What is not a line of text but draws long straight ink: a crooked card's outline (three
 * weights), a crooked dark card, one hairline across the page, a thick diagonal and two thinner
 * ones. Each is drawn `degrees` off level on a page of level text.
 */
const STROKES: Readonly<Record<string, (degrees: number) => string>> = {
  'a crooked card outline, 0.5 pt': (d) => turned(d, '0.5 w -150 -230 300 80 re S'),
  'a crooked card outline, 1 pt': (d) => turned(d, '1 w -150 -230 300 80 re S'),
  'a crooked card outline, 2 pt': (d) => turned(d, '2 w -150 -230 300 80 re S'),
  'a crooked dark card': (d) => turned(d, '0.15 g -150 -230 300 80 re f'),
  'one 1-pt line, 5 inches long': (d) => turned(d, '1 w -180 -190 m 180 -190 l S'),
  'a 3-pt diagonal': (d) => turned(d, '3 w -170 200 m 170 200 l S'),
  'two 2-pt diagonals': (d) => turned(d, '2 w -170 200 m 170 200 l S 2 w -170 215 m 170 215 l S'),
};

describe('skew', () => {
  for (const [name, stroke] of Object.entries(STROKES)) {
    it(`leaves level text alone beside ${name}, at 3° and -3°, at 150 and 300 dpi`, async () => {
      for (const degrees of [3, -3]) {
        for (const dpi of [150, 300]) {
          const image = await render(`${pageContent(0)}\n${stroke(degrees)}`, dpi);
          const found = detectSkew(toGrey(image));
          expect(isSkewed(found), `${degrees}° at ${dpi} dpi: ${JSON.stringify(found)}`).toBe(false);
        }
      }
    });
  }

  it('leaves 8 lines of level text alone beside a 1-pt dashed rule, crooked by 3° or 1°, at 150 and 300 dpi', async () => {
    // eight short lines: the dashes are a long run of ink beside little text
    const eight = SENTENCES.slice(0, 8)
      .map((text, at) => line('helvetica', 12, -160, 170 - at * 34, text.slice(0, 25)))
      .join('\n');
    for (const degrees of [3, 1, -3, -1]) {
      for (const dpi of [150, 300]) {
        const dashes = turned(degrees, '[6 4] 0 d 1 w -180 -190 m 180 -190 l S');
        const found = detectSkew(toGrey(await render(`${turned(0, eight)}\n${dashes}`, dpi)));
        expect(isSkewed(found), `${degrees}° at ${dpi} dpi: ${JSON.stringify(found)}`).toBe(false);
      }
    }
  });

  it('lets the text decide on a crooked page with a level frame and a level rule', async () => {
    const frame = '1 w -170 -235 340 470 re S 0.5 w -150 -200 m 150 -200 l S';
    for (const degrees of [3, -2.4]) {
      const found = detectSkew(toGrey(await render(`${pageContent(degrees)}\n${turned(0, frame)}`, 150)));
      expect(Math.abs(found.angle - degrees)).toBeLessThan(0.2);
      expect(isSkewed(found)).toBe(true);
    }
  });

  it('leaves a page with one short line (a page number) alone, however the line measures', async () => {
    for (const dpi of [150, 300]) {
      const image = await render(line('helvetica', 10, 180, 40, 'Page 3'), dpi);
      expect(isSkewed(detectSkew(toGrey(image))), `${dpi} dpi`).toBe(false);
    }
  });

  it('leaves a sheet whose text runs up the page alone, level or a little crooked, in small and large type', async () => {
    const large = SENTENCES.map((text, at) => line('helvetica', 28, -160, 170 - at * 78, text)).join('\n');
    for (const operators of [textLines(), large]) {
      for (const degrees of [0, 1.4, 4.5, -1.5]) {
        for (const quarter of [90, 270]) {
          const found = detectSkew(toGrey(await render(turned(quarter + degrees, operators), 150)));
          expect(isSkewed(found), `${quarter}+${degrees}°: ${JSON.stringify(found)}`).toBe(false);
        }
      }
    }
  });

  it('asks for a clear peak: a skew that stands only a little above the rest is not turned', () => {
    expect(isSkewed({ angle: 3, confidence: 2.4 })).toBe(false);
    expect(isSkewed({ angle: 3, confidence: 4 })).toBe(true);
  });

  it('finds the skew of text on a page with a ruled table drawn at the same skew, the rules not counted', async () => {
    // The table's rules are one piece with its frame, longer than text ever is: the lines decide.
    const rules =
      '1 w -170 -235 340 470 re S -170 100 m 170 100 l S -170 0 m 170 0 l S -170 -100 m 170 -100 l S';
    const found = detectSkew(toGrey(await render(turned(-2.5, `${textLines()}\n${rules}`), 150)));
    expect(Math.abs(found.angle + 2.5)).toBeLessThan(0.2);
    expect(isSkewed(found)).toBe(true);
  });

  it('finds a 3° skew within 0.2° and a skew of the other sign with its sign', async () => {
    for (const degrees of [3, -2.4]) {
      const found = detectSkew(toGrey(await render(pageContent(degrees), 150)));
      expect(Math.abs(found.angle - degrees)).toBeLessThan(0.2);
      expect(found.confidence).toBeGreaterThan(1.3);
      expect(isSkewed(found)).toBe(true);
    }
  });

  it('measures a large render on a reduced copy, with the same angle', async () => {
    const found = detectSkew(toGrey(await render(pageContent(3), 300)));
    expect(Math.abs(found.angle - 3)).toBeLessThan(0.2);
  });

  it('leaves a page that is level (or nearly), turned a quarter, or without text alone', async () => {
    for (const degrees of [0, 0.1, 12]) {
      expect(isSkewed(detectSkew(toGrey(await render(pageContent(degrees), 150))))).toBe(false);
    }
    expect(detectSkew(grey(300, 300, () => 255))).toEqual({ angle: 0, confidence: 1 });
    expect(isSkewed({ angle: 3, confidence: 1.1 })).toBe(false);
    expect(isSkewed({ angle: 7, confidence: 5 })).toBe(false);
  });

  it('turns a crooked page upright on the same canvas, so the ink is level and the page size is unchanged', async () => {
    const image = await render(pageContent(3), 150);
    const upright = uprightScan(image);
    expect(upright).not.toBeNull();
    const turned = (upright as { image: RgbaImage; angle: number }).image;
    expect(Math.abs((upright as { angle: number }).angle - 3)).toBeLessThan(0.2);
    expect([turned.width, turned.height, turned.scale]).toEqual([image.width, image.height, image.scale]);
    expect(Math.abs(detectSkew(toGrey(turned)).angle)).toBeLessThan(0.3);
    // Opaque, and the corners that came in are paper, not black.
    expect(turned.data[3]).toBe(255);
    expect(turned.data[0]).toBeGreaterThan(200);
  });

  it('leaves a level page, or one without text, as it is (no copy at all)', async () => {
    expect(uprightScan(await render(pageContent(0.1), 150))).toBeNull();
    const blank: RgbaImage = {
      width: 200,
      height: 200,
      data: new Uint8Array(200 * 200 * 4).fill(255),
      scale: 1,
    };
    expect(uprightScan(blank)).toBeNull();
  });

  it('turns a black square by the angle about the centre: it lands where the rotation says', () => {
    const width = 400;
    const height = 300;
    const data = new Uint8Array(width * height * 4).fill(255);
    for (let y = 40; y < 50; y += 1)
      for (let x = 300; x < 310; x += 1) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    const turned = turnImage({ width, height, data, scale: 1 }, 3);
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1)
        if ((turned.data[(y * width + x) * 4] as number) < 128) {
          sx += x + 0.5;
          sy += y + 0.5;
          n += 1;
        }
    // Lines descending by 3° are made level: a point right of the centre moves down.
    const radians = (3 * Math.PI) / 180;
    const dx = 305 - width / 2;
    const dy = 45 - height / 2;
    expect(Math.abs(sx / n - (width / 2 + dx * Math.cos(radians) + dy * Math.sin(radians)))).toBeLessThan(1);
    expect(Math.abs(sy / n - (height / 2 - dx * Math.sin(radians) + dy * Math.cos(radians)))).toBeLessThan(1);
    expect(n).toBeGreaterThan(90);
  });

  it('thresholds between the two grey levels of a page', () => {
    expect(otsu(Uint8Array.from([10, 10, 10, 240, 240, 240]))).toBeGreaterThanOrEqual(10);
    expect(otsu(Uint8Array.from([10, 10, 10, 240, 240, 240]))).toBeLessThan(240);
  });
});

describe('the map between the upright copy and the scan', () => {
  it('puts a mark of the copy where the scan has it: the round trip is within a pixel', () => {
    const width = 400;
    const height = 300;
    const data = new Uint8Array(width * height * 4).fill(255);
    for (let y = 40; y < 50; y += 1)
      for (let x = 300; x < 310; x += 1) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    for (const angle of [3, -2.4]) {
      const copy = turnImage({ width, height, data, scale: 1 }, angle);
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = 0; y < height; y += 1)
        for (let x = 0; x < width; x += 1)
          if ((copy.data[(y * width + x) * 4] as number) < 128) {
            sx += x + 0.5;
            sy += y + 0.5;
            n += 1;
          }
      const [x, y] = rotateAbout(sx / n, sy / n, width / 2, height / 2, angle);
      expect(Math.abs(x - 305)).toBeLessThan(1);
      expect(Math.abs(y - 45)).toBeLessThan(1);
      const [bx, by] = rotateAbout(x, y, width / 2, height / 2, -angle);
      expect(Math.abs(bx - sx / n)).toBeLessThan(1e-9);
      expect(Math.abs(by - sy / n)).toBeLessThan(1e-9);
    }
  });
});

describe('turnBoxes', () => {
  const run = (starts: number[]): TextRun => ({
    text: 'a b',
    font: 'Arial',
    size: 10,
    bold: false,
    italic: false,
    color: 0,
    link: null,
    fit: { advances: [0.5, 0.3, 0.5], starts, ends: starts.map((value) => value + 5), hscale: 1 },
  });
  const upright: TextBox = {
    box: [100, 50, 160, 66],
    rotation: 0,
    paragraphs: [
      { align: 'left', lineHeight: 12, inset: 2, lines: [{ runs: [run([100, Number.NaN, 112])] }] },
    ],
  };

  it('turns each frame by the angle about the page centre, its own centre where the scan has it', () => {
    const [turned] = turnBoxes([upright], 3, 200, 150);
    const box = turned as TextBox;
    expect(box.rotation).toBe(3);
    const [cx, cy] = rotateAbout(130, 58, 200, 150, 3);
    expect((box.box[0] + box.box[2]) / 2).toBeCloseTo(cx, 9);
    expect((box.box[1] + box.box[3]) / 2).toBeCloseTo(cy, 9);
    expect([box.box[2] - box.box[0], box.box[3] - box.box[1]]).toEqual([60, 16]);
  });

  it('moves the letters with the frame, leaves an unplaced space unplaced, and keeps the rest of the paragraph', () => {
    const box = turnBoxes([upright], 3, 200, 150)[0] as TextBox;
    const shift = box.box[0] - 100;
    const fit = (box.paragraphs[0] as TextParagraph).lines[0]?.runs[0]?.fit as NonNullable<TextRun['fit']>;
    expect(fit.starts[0]).toBeCloseTo(100 + shift, 9);
    expect(fit.starts[1]).toBeNaN();
    expect(fit.ends[2]).toBeCloseTo(117 + shift, 9);
    expect(box.paragraphs[0]?.inset).toBe(2);
    expect(fit.advances).toEqual([0.5, 0.3, 0.5]);
  });

  it('writes a skew of the other sign as the clockwise angle in 0…360, and passes a run without a fit', () => {
    const plain: TextBox = {
      ...upright,
      paragraphs: [
        { align: 'left', lineHeight: 12, lines: [{ runs: [{ ...run([1, 2, 3]), fit: undefined }] }] },
      ],
    };
    const box = turnBoxes([plain], -2.4, 200, 150)[0] as TextBox;
    expect(box.rotation).toBeCloseTo(357.6, 9);
    expect(box.paragraphs[0]?.lines[0]?.runs[0]?.fit).toBeUndefined();
  });
});
