/**
 * The open font a rebuilt scan can be set in. A scan's text is set in Arial, Times New Roman or
 * Courier New, whichever the word boxes fit best (`ocr-scene.ts`), unless the scan is clearly set
 * in one of the open families the app ships (`ocr-font-catalog.ts`): the words are then drawn
 * again in every candidate (`ocr-font-match.ts`) and the page uses that family by name, its own
 * advances place the letters, and the package carries the faces the runs use — regular, bold,
 * italic, bold italic — obfuscated like a PDF's fonts (`docx-fonts.ts`), so Word and LibreOffice
 * draw the face the scan was set in rather than a stand-in. The families are SIL OFL: their
 * `fsType` says installable, and is kept.
 *
 * The open family has to win twice, by {@link CLEAR_MARGIN}: over the runner-up (another open
 * family may be nearly the same typeface) and over the best of the stand-ins (the app's default
 * keeps its place on a draw). Offline, with a file missing, the page is set in the stand-ins.
 */

import type { Font } from 'mupdf';
import type { Mupdf } from '../engines/mupdf';
import { trueTypeForWord } from './docx-font-sfnt';
import type { FontFile } from './docx-fonts';
import { standardAdvance } from './docx-fonts';
import type { TextBox } from './layout-scene';
import { loadOpenFace, OPEN_FAMILIES, type OpenFaceStyle, type OpenFamily } from './ocr-font-catalog';
import { type FaceCandidate, type MatchWord, matchFamily } from './ocr-font-match';
import type { Advance, MeasuredWord, RgbaImage } from './ocr-scene';

/** Words OCR is at least this sure of (0–100) are drawn to tell the typeface. */
const CONFIDENT = 90;
/** An open family wins by this much (score, 0–1) over the runner-up and over the best stand-in. */
export const CLEAR_MARGIN = 0.05;

/** The stand-ins a scan is set in by default: Word's Arial, Times New Roman and Courier New (the base-14 faces behind them). */
const STANDARD: readonly FaceCandidate[] = [
  { family: 'Arial', kind: 'sans', bytes: null },
  { family: 'Times New Roman', kind: 'serif', bytes: null },
  { family: 'Courier New', kind: 'mono', bytes: null },
];

/** The faces a run can ask for, and the name Word's font table gives each. */
const WEIGHTS = [
  ['regular', 'Regular'],
  ['bold', 'Bold'],
  ['italic', 'Italic'],
  ['boldItalic', 'Bold Italic'],
] as const;
type Weight = (typeof WEIGHTS)[number][0];

/** One face of the family: the program, and MuPDF's reading of it for glyph ids and advances. */
export interface OpenFace {
  readonly bytes: Uint8Array;
  readonly font: Font;
}

/** An open family as the page uses it; a face the family lacks (or that could not be fetched) is absent. */
export interface OpenFont {
  readonly name: string;
  readonly regular: OpenFace;
  readonly bold?: OpenFace;
  readonly italic?: OpenFace;
  readonly boldItalic?: OpenFace;
}

/** Which of the family's faces a run of `bold` and `italic` is drawn in: its own, else the nearest the family has (Word synthesises the rest). */
function weightOf(open: OpenFont, bold: boolean, italic: boolean): Weight {
  const order: readonly Weight[] = bold
    ? italic
      ? ['boldItalic', 'bold', 'italic', 'regular']
      : ['bold', 'regular']
    : italic
      ? ['italic', 'regular']
      : ['regular'];
  return order.find((weight) => open[weight] !== undefined) as Weight;
}

/** The advance (em) in a stand-in, or in `open`'s own face of the weight; `undefined` for a glyph it lacks or a family it is not. */
export function ocrAdvance(open: OpenFont | null): Advance {
  return (family, bold, italic, unicode) => {
    if (open === null || family !== open.name) return standardAdvance(family, bold, italic, unicode);
    const { font } = open[weightOf(open, bold, italic)] as OpenFace;
    const glyph = font.encodeCharacter(unicode);
    return glyph === 0 ? undefined : font.advanceGlyph(glyph, 0);
  };
}

const faceOf = async (
  mupdf: Mupdf,
  family: OpenFamily,
  style: OpenFaceStyle,
): Promise<OpenFace | undefined> => {
  const bytes = await loadOpenFace(family, style);
  return bytes === null ? undefined : { bytes, font: new mupdf.Font(family.name, bytes) };
};

/** The family with the faces the catalog has for it; `null` without its regular (offline, asset missing). */
async function loadFamily(mupdf: Mupdf, family: OpenFamily): Promise<OpenFont | null> {
  const [regular, bold, italic, boldItalic] = await Promise.all(
    WEIGHTS.map(([weight]) => faceOf(mupdf, family, weight)),
  );
  if (regular === undefined) return null;
  return {
    name: family.name,
    regular,
    ...(bold === undefined ? {} : { bold }),
    ...(italic === undefined ? {} : { italic }),
    ...(boldItalic === undefined ? {} : { boldItalic }),
  };
}

/**
 * The open family the scan is set in, or `null` to keep the stand-ins. The words OCR is sure of
 * (regular ones: a candidate carries one program) are compared with every family whose regular
 * face loads and with the three stand-ins; the family wins when it is ahead of the runner-up and
 * of the best stand-in by {@link CLEAR_MARGIN}.
 */
export async function chooseOpenFont(
  mupdf: Mupdf,
  image: RgbaImage,
  words: readonly MeasuredWord[],
): Promise<OpenFont | null> {
  const loaded = await Promise.all(
    OPEN_FAMILIES.map(async (family) => {
      const bytes = await loadOpenFace(family, 'regular');
      return bytes === null ? [] : [{ family: family.name, kind: family.kind, bytes }];
    }),
  );
  const open = loaded.flat();
  if (open.length === 0) return null;
  const confident: MatchWord[] = words.filter((word) => word.confidence >= CONFIDENT);
  const match = matchFamily(mupdf, image, confident, [...STANDARD, ...open]);
  const winner = OPEN_FAMILIES.find((family) => family.name === match.family);
  if (winner === undefined) return null;
  if (match.score - (match.runnerUp?.score ?? 0) < CLEAR_MARGIN) return null;
  const standard = matchFamily(mupdf, image, confident, STANDARD);
  if (match.score - standard.score < CLEAR_MARGIN) return null;
  return loadFamily(mupdf, winner);
}

/**
 * The font files the scan pages' text needs: for each family and each of its faces, the
 * program cut to the characters the runs set in it (the whole program is kept, the `cmap` made
 * to name those alone), or nothing when no run is set in it.
 */
export function openFontFiles(fonts: readonly OpenFont[], boxes: readonly TextBox[]): FontFile[] {
  const files: FontFile[] = [];
  for (const open of fonts) {
    const used = new Map<Weight, Set<number>>();
    for (const box of boxes) {
      for (const paragraph of box.paragraphs) {
        for (const line of paragraph.lines) {
          for (const run of line.runs) {
            if (run.font !== open.name) continue;
            const weight = weightOf(open, run.bold, run.italic);
            const set = used.get(weight) ?? new Set<number>();
            for (const char of run.text) set.add(char.codePointAt(0) as number);
            used.set(weight, set);
          }
        }
      }
    }
    for (const [weight, style] of WEIGHTS) {
      const characters = used.get(weight);
      if (characters === undefined) continue;
      const { bytes, font } = open[weight] as OpenFace;
      const map = [...characters].flatMap((unicode) => {
        const gid = font.encodeCharacter(unicode);
        return gid === 0 ? [] : [{ unicode, gid }];
      });
      const built = trueTypeForWord(bytes, map, { family: open.name, style });
      if (built !== null) files.push({ family: open.name, style, bytes: built });
    }
  }
  return files;
}
