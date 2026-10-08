/**
 * The margin an open family has to win by (`CLEAR_MARGIN`): over the runner-up and over the best
 * stand-in. The matcher is stubbed with the scores each case needs; `docx-ocr-font.test.ts` runs
 * it for real on synthetic scans.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mupdf } from '../engines/mupdf';
import type { FamilyMatch } from './ocr-font-match';
import type { RgbaImage } from './ocr-scene';

const matches: FamilyMatch[] = [];
vi.mock('./ocr-font-match', () => ({
  matchFamily: vi.fn(() => matches.shift()),
}));

const image: RgbaImage = { width: 1, height: 1, data: new Uint8Array(4), scale: 1 };
const mupdf = { Font: class {} } as unknown as Mupdf;

/** The match of all candidates, then the match of the stand-ins alone (when it is asked for). */
async function chosen(all: FamilyMatch, standard?: FamilyMatch): Promise<string | null> {
  matches.length = 0;
  matches.push(all);
  if (standard !== undefined) matches.push(standard);
  vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }));
  const { chooseOpenFont } = await import('./docx-ocr-font');
  const open = await chooseOpenFont(mupdf, image, []);
  return open === null ? null : open.name;
}

const match = (family: string, score: number, runnerUp: number | null): FamilyMatch => ({
  family,
  score,
  runnerUp: runnerUp === null ? null : { family: 'other', score: runnerUp },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the margin an open family wins by', () => {
  it('takes the family that is ahead of the runner-up and of the best stand-in by 0.05', async () => {
    expect(await chosen(match('Roboto', 0.63, 0.5), match('Arial', 0.56, 0.3))).toBe('Roboto');
  });

  it('keeps the stand-ins when a stand-in wins', async () => {
    expect(await chosen(match('Arial', 0.7, 0.4))).toBeNull();
  });

  it('keeps the stand-ins on a close call with the runner-up: another family is nearly as good', async () => {
    expect(await chosen(match('Roboto', 0.63, 0.59))).toBeNull();
  });

  it('keeps the stand-ins on a close call with the best stand-in', async () => {
    expect(await chosen(match('Roboto', 0.6, 0.5), match('Arial', 0.56, 0.3))).toBeNull();
  });

  it('counts a missing runner-up as no score', async () => {
    expect(await chosen(match('Roboto', 0.04, null))).toBeNull();
  });
});
