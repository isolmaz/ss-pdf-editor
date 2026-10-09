/**
 * A crooked scan read on its upright copy (`ocr-preprocess.ts`): the words and the regions are
 * the copy's, but the erasing is done on the scan itself, along the quad a word becomes, and the
 * pictures are cut from the scan, so the page keeps its look.
 */

import { describe, expect, it } from 'vitest';
import type { OcrWord } from '../engines/tesseract';
import { rotateAbout, turnImage } from './ocr-preprocess';
import { eraseRules, eraseRulesTurned, ocrBackground, type RgbaImage, type Rule } from './ocr-scene';

const WIDTH = 400;
const HEIGHT = 300;
const ANGLE = 3;

/** A white page with filled rectangles (x0, y0, x1, y1, grey or colour) in the upright frame. */
function upright(
  marks: readonly (readonly [number, number, number, number, readonly [number, number, number]])[],
): RgbaImage {
  const data = new Uint8Array(WIDTH * HEIGHT * 4).fill(255);
  for (const [x0, y0, x1, y1, color] of marks) {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) data.set([...color, 255], (y * WIDTH + x) * 4);
    }
  }
  return { width: WIDTH, height: HEIGHT, data, scale: 1 };
}

/** The same page as a crooked scan: its lines descend by `ANGLE`. */
const crooked = (image: RgbaImage): RgbaImage => turnImage(image, -ANGLE);

const BLACK = [0, 0, 0] as const;
const RED = [150, 30, 30] as const;

const dark = (image: RgbaImage, from = [0, 0, WIDTH, HEIGHT]): number => {
  let count = 0;
  for (let y = from[1] as number; y < (from[3] as number); y += 1) {
    for (let x = from[0] as number; x < (from[2] as number); x += 1) {
      if ((image.data[(y * image.width + x) * 4] as number) < 100) count += 1;
    }
  }
  return count;
};

const word = (x0: number, y0: number, x1: number, y1: number): OcrWord => ({
  text: 'Word',
  x0,
  y0,
  x1,
  y1,
  confidence: 99,
});

describe('ocrBackground on a crooked scan', () => {
  // the word's ink, a rule 4 px under it (a neighbour the word's erasing must not touch) and a card
  const marks = [
    [100, 100, 220, 112, BLACK],
    [100, 118, 220, 121, BLACK],
    [300, 200, 360, 260, RED],
  ] as const;
  const scan = crooked(upright(marks));
  const copy = turnImage(scan, ANGLE);

  it('erases the word on the scan along its quad, so the neighbour line is left whole', () => {
    const { regions, pageColor } = ocrBackground(copy, [word(100, 100, 220, 112)], { scan, angle: ANGLE });
    expect(pageColor).toBe(0xffffff);
    // the neighbour rule and the card are the regions; the word is gone
    expect(regions).toHaveLength(2);
    const rule = regions.find((region) => !region.solid || region.box[0] < 250) as NonNullable<
      (typeof regions)[number]
    >;
    const alone = crooked(upright([[100, 118, 220, 121, BLACK]]));
    // every dark pixel the rule has on the scan is in its picture: the word's erasing did not nibble it
    expect(dark(rule.rgba, [0, 0, rule.rgba.width, rule.rgba.height])).toBeGreaterThanOrEqual(
      dark(alone) * 0.98,
    );
  });

  it('places each region where the scan has it, and cuts the picture from the scan', () => {
    const { regions } = ocrBackground(copy, [word(100, 100, 220, 112)], { scan, angle: ANGLE });
    const card = regions.find((region) => region.solid && region.box[0] > 250) as NonNullable<
      (typeof regions)[number]
    >;
    // the card's centre in the copy, turned to the scan, is inside the box it is placed in
    const [x, y] = rotateAbout(330, 230, WIDTH / 2, HEIGHT / 2, ANGLE);
    expect(card.placed[0]).toBeLessThan(x);
    expect(card.placed[2]).toBeGreaterThan(x);
    expect(card.placed[1]).toBeLessThan(y);
    expect(card.placed[3]).toBeGreaterThan(y);
    // the region's own box is in the copy's frame, around the card as the copy has it
    expect(Math.abs(card.box[0] - 300)).toBeLessThan(3);
    expect(card.rgba.width).toBe(Math.round(card.placed[2] - card.placed[0]));
    // the card's colour is in the picture's middle
    const middle = ((card.rgba.height >> 1) * card.rgba.width + (card.rgba.width >> 1)) * 4;
    expect(card.rgba.data[middle]).toBe(150);
  });

  it('is the page as it was when it is not turned: placed is the region box', () => {
    const level = upright(marks);
    const { regions } = ocrBackground(level, [word(100, 100, 220, 112)]);
    for (const region of regions) expect(region.placed).toEqual(region.box);
  });
});

describe('eraseRulesTurned', () => {
  // a word, a rule under it crossed by a descender, as the upright copy has them
  const marks = [
    [100, 90, 200, 100, BLACK],
    [100, 104, 200, 106, BLACK],
    [140, 98, 143, 112, BLACK],
  ] as const;
  const rule: Rule = { x0: 100, y0: 104, x1: 200, y1: 106 };
  const scan = crooked(upright(marks));
  const copy = turnImage(scan, ANGLE);

  it('erases the rule along the scan’s line and leaves the letters and the descender', () => {
    const erased = eraseRulesTurned(copy, [rule], scan, ANGLE);
    expect([erased.width, erased.height, erased.scale]).toEqual([scan.width, scan.height, scan.scale]);
    const ruleOnly = crooked(upright([[100, 104, 200, 106, BLACK]]));
    // the rule's ink is gone (all but its crossed columns), the rest of the ink is as it was
    expect(dark(erased)).toBeLessThan(dark(scan) - dark(ruleOnly) * 0.9);
    expect(dark(erased)).toBeGreaterThan(dark(scan) - dark(ruleOnly) - 120);
    // the input is not touched
    expect(dark(scan)).toBeGreaterThan(dark(erased));
  });

  it('erases the rule the same way on the copy itself', () => {
    const level = eraseRules(copy, [rule]);
    expect(dark(level)).toBeLessThan(dark(copy));
  });
});
