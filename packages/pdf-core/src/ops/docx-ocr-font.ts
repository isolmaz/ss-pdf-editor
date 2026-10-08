/**
 * The open font a rebuilt scan can be set in. A scan's text is set in Arial, Times New Roman or
 * Courier New, whichever the word boxes fit best (`ocr-scene.ts`); when the page is set in the
 * sans the app ships (Noto Sans, SIL OFL: `public/fonts/noto`, regular and semi-bold, the files
 * every other writer loads through `engines/noto.ts`) the page uses it by name and the package
 * carries it, obfuscated like a PDF's fonts (`docx-fonts.ts`), so Word and LibreOffice draw the
 * face the scan was measured against rather than a stand-in.
 *
 * Semi-bold is the bold of the family (Word draws `w:b` runs with the embedded bold); italic is
 * the synthesised slant Word makes of the regular, which is what the advances assume.
 */

import type { Font } from 'mupdf';
import type { Mupdf } from '../engines/mupdf';
import { notoSansBytes } from '../engines/noto';
import { trueTypeForWord } from './docx-font-sfnt';
import type { FontFile } from './docx-fonts';
import { standardAdvance } from './docx-fonts';
import type { TextBox } from './layout-scene';
import type { Advance } from './ocr-scene';

/** The family name the runs and the font table carry. */
export const OPEN_FONT = 'Noto Sans';

/** The shipped programs, and MuPDF's reading of them for glyph ids and advances. */
export interface OpenFont {
  readonly regular: { readonly bytes: Uint8Array; readonly font: Font };
  readonly bold: { readonly bytes: Uint8Array; readonly font: Font };
}

/**
 * The shipped Noto Sans, or `null` when it cannot be had (offline, asset missing): the page is
 * then set in the stand-ins, as before.
 */
export async function loadOpenFont(mupdf: Mupdf): Promise<OpenFont | null> {
  try {
    const [regular, bold] = await Promise.all([notoSansBytes(), notoSansBytes(true)]);
    return {
      regular: { bytes: regular, font: new mupdf.Font('NotoSans-Regular', regular) },
      bold: { bytes: bold, font: new mupdf.Font('NotoSans-SemiBold', bold) },
    };
  } catch {
    return null;
  }
}

/** The advance (em) in a stand-in, or in Noto Sans when `open` is there; `undefined` for a glyph or a family it has none of. */
export function ocrAdvance(open: OpenFont | null): Advance {
  return (family, bold, italic, unicode) => {
    if (family !== OPEN_FONT) return standardAdvance(family, bold, italic, unicode);
    if (open === null) return undefined;
    const { font } = bold ? open.bold : open.regular;
    const glyph = font.encodeCharacter(unicode);
    return glyph === 0 ? undefined : font.advanceGlyph(glyph, 0);
  };
}

/**
 * The font files the scan pages' text needs: for each of regular and bold, Noto Sans cut to
 * the characters the runs set in it (the whole program is kept, the `cmap` made to name those
 * alone), or nothing when no run is set in it.
 */
export function openFontFiles(open: OpenFont, boxes: readonly TextBox[]): FontFile[] {
  const used = { regular: new Set<number>(), bold: new Set<number>() };
  for (const box of boxes) {
    for (const paragraph of box.paragraphs) {
      for (const line of paragraph.lines) {
        for (const run of line.runs) {
          if (run.font !== OPEN_FONT) continue;
          for (const char of run.text) used[run.bold ? 'bold' : 'regular'].add(char.codePointAt(0) as number);
        }
      }
    }
  }
  const files: FontFile[] = [];
  for (const [weight, style] of [
    ['regular', 'Regular'],
    ['bold', 'Bold'],
  ] as const) {
    if (used[weight].size === 0) continue;
    const { bytes, font } = open[weight];
    const map = [...used[weight]].flatMap((unicode) => {
      const gid = font.encodeCharacter(unicode);
      return gid === 0 ? [] : [{ unicode, gid }];
    });
    const built = trueTypeForWord(bytes, map, { family: OPEN_FONT, style });
    if (built !== null) files.push({ family: OPEN_FONT, style, bytes: built });
  }
  return files;
}
