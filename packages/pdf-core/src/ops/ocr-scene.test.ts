/**
 * `ocrTextBoxes` / `ocrBackground` on pages drawn by MuPDF: real glyphs (Noto Sans, Arial's
 * metric twin Helvetica) with the word boxes measured from the ink, so the size, colour and bold
 * estimates are checked against what was drawn, and a background made of a card, a photo-like
 * gradient and text.
 */

import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { describe, expect, it } from 'vitest';
import type { OcrWord } from '../engines/tesseract';
import type { TextBox } from './layout-scene';
import { ocrBackground, ocrTextBoxes, type RgbaImage } from './ocr-scene';

/* ------------------------------------------------------------------ *
 * a tiny page painter
 * ------------------------------------------------------------------ */

type Rgb = readonly [number, number, number];
type Face = 'noto' | 'notoBold' | 'helvetica';

const FONT_FILES: Partial<Record<Face, string>> = {
  noto: '../../../../public/fonts/noto/NotoSans-Regular.ttf',
  notoBold: '../../../../node_modules/@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf',
};

/** Half a level up, so the 8-bit rasteriser lands on the very level asked for. */
const fraction = (value: number): string => ((value + 0.5) / 255).toFixed(5);
const fillOf = (color: Rgb): string => `${fraction(color[0])} ${fraction(color[1])} ${fraction(color[2])} rg`;

class Page {
  private readonly ops: string[] = [];
  private readonly texts: { face: Face; ops: (glyphs: (text: string) => string) => string }[] = [];
  private readonly used = new Set<Face>();

  constructor(
    readonly width: number,
    readonly height: number,
    background: Rgb,
  ) {
    this.rect(0, 0, width, height, background);
  }

  /** A filled rectangle, top-left y-down points. */
  rect(x: number, y: number, w: number, h: number, color: Rgb): void {
    this.ops.push(`${fillOf(color)} ${x} ${this.height - y - h} ${w} ${h} re f`);
  }

  /** A rounded rectangle. */
  card(x: number, y: number, w: number, h: number, r: number, color: Rgb): void {
    const top = this.height - y;
    const bottom = top - h;
    const k = r * 0.5523;
    this.ops.push(
      `${fillOf(color)} ${x + r} ${top} m ${x + w - r} ${top} l ${x + w - r + k} ${top} ${x + w} ${top - r + k} ${x + w} ${top - r} c ` +
        `${x + w} ${bottom + r} l ${x + w} ${bottom + r - k} ${x + w - r + k} ${bottom} ${x + w - r} ${bottom} c ` +
        `${x + r} ${bottom} l ${x + r - k} ${bottom} ${x} ${bottom + r - k} ${x} ${bottom + r} c ` +
        `${x} ${top - r} l ${x} ${top - r + k} ${x + r - k} ${top} ${x + r} ${top} c f`,
    );
  }

  /** Text with its baseline at `y` (top-left y-down points). */
  text(face: Face, size: number, x: number, y: number, color: Rgb, value: string): void {
    this.used.add(face);
    this.texts.push({
      face,
      ops: (glyphs) =>
        `BT ${fillOf(color)} /${face} ${size} Tf ${x} ${this.height - y} Td ${glyphs(value)} Tj ET`,
    });
  }

  /** The page as RGBA, `scale` pixels per point. */
  async render(scale: number): Promise<RgbaImage> {
    const doc = new mupdf.PDFDocument();
    const fonts: Record<string, unknown> = {};
    const encoders = new Map<Face, (text: string) => string>();
    for (const face of this.used) {
      const file = FONT_FILES[face];
      if (file === undefined) {
        const font = new mupdf.Font('Helvetica');
        fonts[face] = doc.addSimpleFont(font);
        encoders.set(face, (text) => `(${text.replace(/[\\()]/g, '\\$&')})`);
      } else {
        const font = new mupdf.Font(face, readFileSync(new URL(file, import.meta.url)));
        fonts[face] = doc.addFont(font);
        encoders.set(face, (text) => {
          const glyphs = [...text].map((char) =>
            font
              .encodeCharacter(char.codePointAt(0) as number)
              .toString(16)
              .padStart(4, '0'),
          );
          return `<${glyphs.join('')}>`;
        });
      }
    }
    const content = [
      ...this.ops,
      ...this.texts.map((entry) => entry.ops(encoders.get(entry.face) as (text: string) => string)),
    ].join('\n');
    doc.insertPage(0, doc.addPage([0, 0, this.width, this.height], 0, { Font: fonts }, content));
    const page = doc.loadPage(0);
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
    const rgb = pixmap.getPixels();
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const data = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
      data[index * 4] = rgb[index * 3] as number;
      data[index * 4 + 1] = rgb[index * 3 + 1] as number;
      data[index * 4 + 2] = rgb[index * 3 + 2] as number;
      data[index * 4 + 3] = 255;
    }
    doc.destroy();
    return { width, height, data, scale };
  }
}

/** The ink box (page points) inside a region: pixels clearly different from the region's corner. */
function inkBox(
  image: RgbaImage,
  region: readonly [number, number, number, number],
): [number, number, number, number] {
  const { scale, width, data } = image;
  const x0 = Math.floor(region[0] * scale);
  const y0 = Math.floor(region[1] * scale);
  const x1 = Math.ceil(region[2] * scale);
  const y1 = Math.ceil(region[3] * scale);
  const corner = (y0 * width + x0) * 4;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * width + x) * 4;
      const away = Math.max(
        Math.abs((data[at] as number) - (data[corner] as number)),
        Math.abs((data[at + 1] as number) - (data[corner + 1] as number)),
        Math.abs((data[at + 2] as number) - (data[corner + 2] as number)),
      );
      if (away > 80) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return [minX / scale, minY / scale, (maxX + 1) / scale, (maxY + 1) / scale];
}

function wordAt(
  image: RgbaImage,
  text: string,
  region: readonly [number, number, number, number],
  extra: Partial<OcrWord> = {},
): OcrWord {
  const [x0, y0, x1, y1] = inkBox(image, region);
  return { text, x0, y0, x1, y1, confidence: 97, block: 0, paragraph: 0, line: 0, ...extra };
}

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const hex = (color: number): string => color.toString(16).padStart(6, '0');
const runsOf = (box: TextBox) =>
  box.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.runs));

/* ------------------------------------------------------------------ *
 * font size
 * ------------------------------------------------------------------ */

describe('ocrTextBoxes: font size', () => {
  const SAMPLE = 'Hamburgefonstiv bdlq gypj';
  const cases: { face: Face; size: number }[] = [10, 14, 24].flatMap((size) =>
    (['noto', 'helvetica'] as const).map((face) => ({ face, size })),
  );

  it.each(cases)('$face $size pt is estimated within 5 %', async ({ face, size }) => {
    const page = new Page(260, 60, WHITE);
    page.text(face, size, 10, 40, BLACK, SAMPLE);
    const image = await page.render(3);
    const word = wordAt(image, SAMPLE, [2, 2, 258, 58]);
    const run = runsOf(ocrTextBoxes([word], image, 0.9).boxes[0] as TextBox)[0];
    const measured = (run?.size ?? 0) / size;
    expect(Math.abs(measured - 1)).toBeLessThanOrEqual(0.05);
  });

  it('gives a one-line box a 1.2 line and keeps the first baseline where the text is', async () => {
    const page = new Page(260, 60, WHITE);
    page.text('noto', 14, 10, 40, BLACK, SAMPLE);
    const image = await page.render(3);
    const word = wordAt(image, SAMPLE, [2, 2, 258, 58]);
    const [{ box, paragraphs }] = ocrTextBoxes([word], image, 0.9).boxes as [TextBox];
    const paragraph = paragraphs[0] as (typeof paragraphs)[number];
    const size = runsOf({ box, rotation: 0, paragraphs })[0]?.size as number;
    expect(paragraph.lineHeight).toBeCloseTo(1.2 * size, 5);
    // The first baseline is the box top + 0.8 × the line height; the PDF drew it at y = 40.
    expect(box[1] + 0.8 * paragraph.lineHeight).toBeCloseTo(40, 0);
    expect(paragraph.align).toBe('left');
    expect(box[0]).toBe(word.x0);
  });
});

/* ------------------------------------------------------------------ *
 * grouping, alignment, line height
 * ------------------------------------------------------------------ */

function fake(
  text: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  line: number,
  paragraph = 0,
  extra: Partial<OcrWord> = {},
): OcrWord {
  return { text, x0, y0, x1, y1, confidence: 98, block: 0, paragraph, line, ...extra };
}

/** A blank white page: the words' colour is the (black) fallback of "no contrast". */
const blank = (width = 300, height = 300): RgbaImage => ({
  width,
  height,
  data: new Uint8Array(width * height * 4).fill(255),
  scale: 1,
});

describe('ocrTextBoxes: grouping', () => {
  it('makes one box per paragraph, lines by line index, words joined with spaces', () => {
    const words = [
      // given out of order: the second line first, the right word before the left one
      fake('world', 60, 40, 100, 52, 1),
      fake('Hello', 10, 40, 50, 52, 1),
      fake('First', 10, 10, 50, 22, 0),
      fake('line', 55, 10, 80, 22, 0),
      fake('Other', 10, 100, 60, 112, 2, 1),
    ];
    const { boxes, flagged } = ocrTextBoxes(words, blank(), 0.9);
    expect(flagged).toEqual([]);
    expect(boxes).toHaveLength(2);
    const [first, second] = boxes as [(typeof boxes)[number], (typeof boxes)[number]];
    expect(first.paragraphs).toHaveLength(1);
    expect(first.paragraphs[0]?.lines.map((line) => line.runs.map((run) => run.text).join(''))).toEqual([
      'First line',
      'Hello world',
    ]);
    expect(second.paragraphs[0]?.lines[0]?.runs[0]?.text).toBe('Other');
    expect(first.rotation).toBe(0);
    // the union of the words, with the writer's width slack
    expect(first.box[0]).toBe(10);
    expect(first.box[2]).toBeCloseTo(10 + 90 * 1.03 + 2, 6);
    expect(first.box[3]).toBeGreaterThanOrEqual(52);
    const run = runsOf(first)[0];
    expect(run).toMatchObject({ font: 'Arial', italic: false, link: null, bold: false, color: 0 });
    expect(
      ocrTextBoxes(words.slice(0, 1), blank(), 0.9, 'Calibri').boxes[0]?.paragraphs[0]?.lines[0]?.runs[0]
        ?.font,
    ).toBe('Calibri');
  });

  it('takes the line height from the median baseline distance', () => {
    // baselines (no tesseract baseline: from the ink extent) 24, 46, 68: 22 apart
    const words = [0, 1, 2].map((index) =>
      fake(`w${index}`, 10, 10 + index * 22, 60, 26 + index * 22, index),
    );
    const { boxes } = ocrTextBoxes(words, blank(), 0.9);
    expect(boxes[0]?.paragraphs[0]?.lineHeight).toBeCloseTo(22, 5);
  });

  it('uses the baseline tesseract found', () => {
    const words = [
      fake('a', 10, 10, 60, 26, 0, 0, { baseline: { x0: 10, y0: 30, x1: 60, y1: 30 } }),
      fake('b', 10, 40, 60, 56, 1, 0, { baseline: { x0: 10, y0: 62, x1: 60, y1: 62 } }),
    ];
    const { boxes } = ocrTextBoxes(words, blank(), 0.9);
    const paragraph = boxes[0]?.paragraphs[0];
    expect(paragraph?.lineHeight).toBe(32);
    expect(boxes[0]?.box[1]).toBeCloseTo(30 - 0.8 * 32, 6);
  });

  it('lets a word without indices stand alone', () => {
    const words: OcrWord[] = [
      { text: 'a', x0: 10, y0: 10, x1: 20, y1: 22, confidence: 99 },
      { text: 'b', x0: 10, y0: 40, x1: 20, y1: 52, confidence: 99 },
    ];
    expect(ocrTextBoxes(words, blank(), 0.9).boxes).toHaveLength(2);
  });

  it('centres a paragraph whose lines are centred, not one whose lines are all flush left', () => {
    const centred = [fake('long long line', 20, 10, 120, 24, 0), fake('short', 55, 30, 85, 44, 1)];
    const left = [fake('long long line', 20, 10, 120, 24, 0), fake('short', 20, 30, 60, 44, 1)];
    const ragged = [fake('long long line', 20, 10, 120, 24, 0), fake('short', 30, 30, 60, 44, 1)];
    const one = [fake('alone', 20, 10, 120, 24, 0)];
    const first = ocrTextBoxes(centred, blank(), 0.9).boxes[0];
    expect(first?.paragraphs[0]?.align).toBe('center');
    // centred about the same axis as the text
    expect(((first?.box[0] ?? 0) + (first?.box[2] ?? 0)) / 2).toBeCloseTo(70, 6);
    expect(ocrTextBoxes(left, blank(), 0.9).boxes[0]?.paragraphs[0]?.align).toBe('left');
    expect(ocrTextBoxes(ragged, blank(), 0.9).boxes[0]?.paragraphs[0]?.align).toBe('left');
    expect(ocrTextBoxes(one, blank(), 0.9).boxes[0]?.paragraphs[0]?.align).toBe('left');
  });

  it("keeps a paragraph's size across lines without descenders, and a clearly bigger line its own", () => {
    // extents 14, 14, 14.5 and 10.5 (no descender): the upper quartile of the sizes
    const same = [
      fake('Hgyp', 10, 10, 60, 24, 0),
      fake('Hgyp', 10, 30, 60, 44, 1),
      fake('Hgyp', 10, 50, 60, 64.5, 2),
      fake('Hxzm', 10, 70, 60, 80.5, 3),
    ];
    const sizes = (words: OcrWord[]) =>
      ocrTextBoxes(words, blank(), 0.9).boxes[0]?.paragraphs[0]?.lines.map((line) => line.runs[0]?.size);
    // the last line (74 % of it) is the paragraph's size too
    expect(sizes(same)).toEqual([14.5, 14.5, 14.5, 14.5]);
    const heading = [
      fake('Title', 10, 10, 90, 40, 0),
      ...[1, 2, 3].map((n) => fake('Body', 10, 40 + n * 16, 90, 54 + n * 16, n)),
    ];
    expect(sizes(heading)).toEqual([30.5, 14.5, 14.5, 14.5]);
  });
});

/* ------------------------------------------------------------------ *
 * colour and weight
 * ------------------------------------------------------------------ */

describe('ocrTextBoxes: colour and weight', () => {
  it('reads white text on a blue band as white, and dark text on white as dark', async () => {
    const page = new Page(300, 120, WHITE);
    page.rect(0, 0, 300, 50, [30, 60, 160]);
    page.text('noto', 16, 10, 32, WHITE, 'Experience');
    page.text('noto', 16, 10, 90, [20, 20, 20], 'Education');
    const image = await page.render(3);
    const words = [
      wordAt(image, 'Experience', [2, 2, 298, 48], { line: 0, paragraph: 0 }),
      wordAt(image, 'Education', [2, 60, 298, 118], { line: 1, paragraph: 1 }),
    ];
    const { boxes } = ocrTextBoxes(words, image, 0.9);
    const light = runsOf(boxes[0] as TextBox)[0]?.color as number;
    const dark = runsOf(boxes[1] as TextBox)[0]?.color as number;
    expect(hex(light)).toMatch(/^f[0-9a-f]f[0-9a-f]f[0-9a-f]$/);
    for (const channel of [dark >> 16, (dark >> 8) & 255, dark & 255]) expect(channel).toBeLessThan(70);
  });

  it('reads a coloured word as its colour, and merges neighbours of the same look into one run', async () => {
    const page = new Page(300, 60, WHITE);
    page.text('noto', 18, 10, 40, [200, 30, 30], 'Red');
    page.text('noto', 18, 70, 40, [205, 28, 33], 'text');
    page.text('noto', 18, 130, 40, [20, 20, 200], 'Blue');
    const image = await page.render(3);
    const words = [
      wordAt(image, 'Red', [2, 2, 65, 58]),
      wordAt(image, 'text', [66, 2, 125, 58]),
      wordAt(image, 'Blue', [126, 2, 298, 58]),
    ];
    const runs = runsOf(ocrTextBoxes(words, image, 0.9).boxes[0] as TextBox);
    expect(runs.map((run) => run.text)).toEqual(['Red text ', 'Blue']);
    expect(runs[0]?.color).toBe(0xc81e1e);
    expect(runs[1]?.color).toBe(0x1414c8);
  });

  it('calls a heavier line bold against the page and a word with no contrast black', async () => {
    const page = new Page(300, 150, WHITE);
    const body = 'The quick brown fox jumps over';
    page.text('noto', 14, 10, 30, BLACK, body);
    page.text('noto', 14, 10, 60, BLACK, body);
    page.text('notoBold', 14, 10, 90, BLACK, body);
    page.text('noto', 14, 10, 120, BLACK, body);
    const image = await page.render(3);
    const words = [0, 1, 2, 3].map((index) =>
      wordAt(image, body, [2, index * 30 + 5, 298, index * 30 + 35], { line: index, paragraph: 0 }),
    );
    const sizes = ocrTextBoxes(words, image, 0.9).boxes[0]?.paragraphs[0]?.lines.map(
      (line) => line.runs[0]?.bold,
    );
    expect(sizes).toEqual([false, false, true, false]);
    // a word on a flat patch: nothing to read, and no bold on a page of one line
    const flat: OcrWord = fake('x', 10, 10, 30, 22, 0);
    const lone = ocrTextBoxes([flat], blank(), 0.9);
    expect(runsOf(lone.boxes[0] as TextBox)[0]).toMatchObject({ bold: false, color: 0 });
  });
});

/* ------------------------------------------------------------------ *
 * low confidence
 * ------------------------------------------------------------------ */

describe('ocrTextBoxes: low confidence', () => {
  it('makes a low-confidence word a run of its own with a note, and lists it', () => {
    const words = [
      fake('Alpha', 10, 10, 50, 22, 0),
      fake('b1ta', 55, 10, 90, 22, 0, 0, { confidence: 61.4 }),
      fake('gamma', 95, 10, 140, 22, 0),
      fake('delta', 145, 10, 190, 22, 0, 0, { confidence: 89.9 }),
      fake('eps', 195, 10, 210, 22, 0, 0, { confidence: 90 }),
    ];
    const { boxes, flagged } = ocrTextBoxes(words, blank(), 0.9);
    expect(flagged).toEqual([
      { text: 'b1ta', confidence: 0.614 },
      { text: 'delta', confidence: 0.899 },
    ]);
    const runs = runsOf(boxes[0] as TextBox);
    expect(runs.map((run) => [run.text, run.note])).toEqual([
      ['Alpha ', undefined],
      ['b1ta', 'Low OCR confidence (61 %)'],
      [' gamma ', undefined],
      ['delta', 'Low OCR confidence (90 %)'],
      [' eps', undefined],
    ]);
    // the text reads as the words with single spaces
    expect(runs.map((run) => run.text).join('')).toBe('Alpha b1ta gamma delta eps');
  });

  it('spaces two noted words in a row and a noted word at the start', () => {
    const words = [
      fake('x1', 10, 10, 30, 22, 0, 0, { confidence: 50 }),
      fake('y2', 35, 10, 55, 22, 0, 0, { confidence: 40 }),
    ];
    const runs = runsOf(ocrTextBoxes(words, blank(), 0.9).boxes[0] as TextBox);
    expect(runs.map((run) => run.text)).toEqual(['x1', ' y2']);
  });
});

/* ------------------------------------------------------------------ *
 * background
 * ------------------------------------------------------------------ */

const GREY: Rgb = [232, 232, 232];

async function cardPage(): Promise<{ image: RgbaImage; words: OcrWord[] }> {
  const page = new Page(400, 300, GREY);
  // a text-only strip on the grey page
  page.text('noto', 14, 20, 30, BLACK, 'Curriculum Vitae');
  // a white rounded card with text inside
  page.card(20, 60, 160, 100, 12, WHITE);
  page.text('noto', 12, 34, 100, [40, 40, 40], 'Skills and tools');
  // a photo-like block: a coloured gradient
  for (let strip = 0; strip < 80; strip += 1) {
    page.rect(230 + strip, 60, 1, 90, [40 + strip * 2, 90 + Math.round(strip * 1.2), 200 - strip]);
  }
  // a small speck, below the size worth a picture
  page.rect(350, 250, 4, 4, [10, 10, 10]);
  const image = await page.render(2);
  const words = [
    wordAt(image, 'Curriculum Vitae', [10, 10, 200, 40], { line: 0, paragraph: 0 }),
    wordAt(image, 'Skills and tools', [28, 80, 170, 110], { line: 1, paragraph: 1 }),
  ];
  return { image, words };
}

describe('ocrBackground', () => {
  it('finds the page colour and one region each for the card and the photo, none for text', async () => {
    const { image, words } = await cardPage();
    const { pageColor, regions } = ocrBackground(image, words);
    expect(pageColor).toBe(0xe8e8e8);
    expect(regions).toHaveLength(2);
    const [card, photo] = regions as [(typeof regions)[number], (typeof regions)[number]];
    const near = (box: readonly number[], expected: readonly number[]) => {
      for (const [index, value] of box.entries()) {
        expect(Math.abs(value - (expected[index] as number))).toBeLessThanOrEqual(1.5);
      }
    };
    near(card.box, [20, 60, 180, 160]);
    near(photo.box, [230, 60, 310, 150]);
    // the crop is the box, in pixels, at the image's scale
    expect(card.rgba.scale).toBe(2);
    expect(card.rgba.width).toBeCloseTo((card.box[2] - card.box[0]) * 2, 0);
    expect(card.rgba.height).toBeCloseTo((card.box[3] - card.box[1]) * 2, 0);
    expect(card.rgba.data).toHaveLength(card.rgba.width * card.rgba.height * 4);
  });

  it('erases the words: no dark text pixel is left where a word was', async () => {
    const { image, words } = await cardPage();
    const { regions } = ocrBackground(image, words);
    const card = regions[0] as (typeof regions)[number];
    // the card was cut from the erased image: every pixel is white or the page's grey (corners)
    let darkest = 255;
    for (let at = 0; at < card.rgba.data.length; at += 4)
      darkest = Math.min(darkest, card.rgba.data[at] as number);
    expect(darkest).toBeGreaterThanOrEqual(225);
    // the source image is untouched and did have the text
    let source = 255;
    for (let at = 0; at < image.data.length; at += 4) source = Math.min(source, image.data[at] as number);
    expect(source).toBeLessThan(60);
  });

  it('keeps what is not text, and fills a box on a gradient with its surroundings', async () => {
    const page = new Page(200, 100, WHITE);
    page.rect(20, 20, 100, 60, [200, 30, 30]);
    page.text('noto', 12, 30, 55, WHITE, 'Label');
    const image = await page.render(2);
    const word = wordAt(image, 'Label', [25, 30, 115, 70]);
    const { pageColor, regions } = ocrBackground(image, [word]);
    expect(pageColor).toBe(0xffffff);
    expect(regions).toHaveLength(1);
    const crop = regions[0]?.rgba as RgbaImage;
    // the text is gone: the red block is red everywhere
    for (let at = 0; at < crop.data.length; at += 4) {
      if ((crop.data[at + 1] as number) > 100) continue;
      expect(crop.data[at]).toBe(200);
    }
    expect(Math.abs((regions[0]?.box[2] ?? 0) - 120)).toBeLessThanOrEqual(1);
  });

  it('handles words at the image edge and a page that is one box of words', () => {
    const image: RgbaImage = { width: 4, height: 4, data: new Uint8Array(64).fill(255), scale: 1 };
    image.data.fill(0, 0, 8);
    const word: OcrWord = { text: 'x', x0: 0, y0: 0, x1: 4, y1: 4, confidence: 99 };
    const { pageColor, regions } = ocrBackground(image, [word]);
    // the ring is empty, so the word is filled white
    expect(pageColor).toBe(0xffffff);
    expect(regions).toEqual([]);
  });

  it('merges nearby marks and drops specks smaller than 8 × 8 pt', () => {
    const width = 200;
    const image: RgbaImage = {
      width,
      height: 100,
      data: new Uint8Array(width * 100 * 4).fill(255),
      scale: 2,
    };
    const paint = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) image.data.fill(40, (y * width + x) * 4, (y * width + x) * 4 + 3);
      }
    };
    // two blocks 4 px (2 pt) apart merge; a 5 × 5 px speck and a long thin rule are separate
    paint(10, 10, 50, 40);
    paint(54, 10, 90, 40);
    paint(150, 50, 155, 55);
    paint(100, 80, 190, 82);
    const { regions } = ocrBackground(image, []);
    expect(regions.map((region) => region.box)).toEqual([
      [4.5, 4.5, 45.5, 20.5],
      [49.5, 39.5, 95.5, 41.5],
    ]);
  });
});
