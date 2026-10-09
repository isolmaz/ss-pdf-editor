/**
 * Pages built in a test for the Office export (`export-office.test.ts`): monospaced
 * Courier lines, whose width is exactly 0.6 × size per character, so alignment, indents
 * and justification can be asserted to the point; vector and raster pictures; several
 * pages with their own sizes.
 */

import type { PDFObject } from 'mupdf';
import { loadMupdf } from '../engines/mupdf';

export type FixtureFont =
  | 'courier'
  | 'courierBold'
  | 'helvetica'
  | 'helveticaBold'
  | 'timesItalic'
  | 'courierMapped';

const RESOURCE: Readonly<Record<FixtureFont, { name: string; base: string }>> = {
  courier: { name: 'F1', base: 'Courier' },
  courierBold: { name: 'F2', base: 'Courier-Bold' },
  helvetica: { name: 'F3', base: 'Helvetica' },
  helveticaBold: { name: 'F4', base: 'Helvetica-Bold' },
  timesItalic: { name: 'F5', base: 'Times-Italic' },
  // Courier whose `/ToUnicode` hands code 1 over as U+0001, code 2 as a tab and code 3 as a soft hyphen.
  courierMapped: { name: 'F6', base: 'Courier' },
};

const TO_UNICODE = [
  '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
  '/CMapName /Adobe-Identity-UCS def /CMapType 2 def',
  '1 begincodespacerange <00> <FF> endcodespacerange',
  '4 beginbfchar <01> <0001> <02> <0009> <03> <00AD> <04> <FFFE> endbfchar',
  'endcmap end end',
].join('\n');

/** WinAnsi codes the fixtures need beyond Latin-1. */
const WIN_ANSI: Readonly<Record<string, number>> = { '•': 149, '–': 150, '—': 151 };

/** The literal-string body of `text` in WinAnsi: octal escapes for everything outside ASCII. */
function winAnsi(text: string): string {
  return [...text]
    .map((character) => {
      if (character === '\\' || character === '(' || character === ')') return `\\${character}`;
      const code = WIN_ANSI[character] ?? character.charCodeAt(0);
      return code > 127 || code < 32 ? `\\${code.toString(8).padStart(3, '0')}` : character;
    })
    .join('');
}

/** One text line, its baseline `y` from the bottom edge; `color` is `r g b` in 0…1. */
export function line(
  font: FixtureFont,
  size: number,
  x: number,
  y: number,
  text: string,
  color = '0 0 0',
): string {
  return `${color} rg BT /${RESOURCE[font].name} ${size} Tf ${x} ${y} Td (${winAnsi(text)}) Tj ET`;
}

/** A raster picture drawn into the box `[x, y, width, height]` (PDF space, from the bottom). */
export function picture(name: string, x: number, y: number, width: number, height: number): string {
  return `q ${width} 0 0 ${height} ${x} ${y} cm /${name} Do Q`;
}

/** A filled circle of radius `r` at `(cx, cy)` drawn with curves: a vector figure. */
export function circle(cx: number, cy: number, r: number, color = '0.2 0.4 0.8'): string {
  const k = 0.5523 * r;
  return [
    `${color} rg`,
    `${cx + r} ${cy} m`,
    `${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c`,
    `${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c`,
    `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c`,
    `${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c f`,
  ].join('\n');
}

export interface FixtureImage {
  readonly width: number;
  readonly height: number;
  readonly rgb: readonly [number, number, number];
}

export interface FixturePage {
  /** Points; 400 × 500 when left out. */
  readonly size?: readonly [number, number];
  /** Content stream operators: `line(…)`, `circle(…)`, `picture(…)`, rules. */
  readonly content: string;
  /** Names `picture(…)` draws: a solid-colour RGB image of `width × height` pixels each. */
  readonly images?: Readonly<
    Record<string, { width: number; height: number; rgb: readonly [number, number, number] }>
  >;
}

/** A PDF of the pages, with the document title and the catalog language when given. */
export async function officeDocument(
  pages: readonly FixturePage[],
  meta: { readonly title?: string; readonly lang?: string } = {},
): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const fonts: Record<string, PDFObject> = {};
  for (const font of Object.values(RESOURCE)) {
    fonts[font.name] = doc.addObject({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: font.base,
      Encoding: 'WinAnsiEncoding',
      ...(font.name === RESOURCE.courierMapped.name ? { ToUnicode: doc.addStream(TO_UNICODE, {}) } : {}),
    });
  }
  // `/GS1 gs` in a page's content draws what follows at 40 % opacity.
  const translucent = doc.addObject({ Type: 'ExtGState', ca: 0.4, CA: 0.4 });
  pages.forEach((page, index) => {
    const xobjects: Record<string, PDFObject> = {};
    for (const [name, spec] of Object.entries(page.images ?? {})) {
      const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, spec.width, spec.height], false);
      const samples = pixmap.getPixels();
      for (let at = 0; at < spec.width * spec.height; at += 1) {
        samples.set(spec.rgb, at * 3);
      }
      const image = new mupdf.Image(pixmap);
      xobjects[name] = doc.addImage(image);
      image.destroy();
      pixmap.destroy();
    }
    const [width, height] = page.size ?? [400, 500];
    doc.insertPage(
      index,
      doc.addPage(
        [0, 0, width, height],
        0,
        { Font: fonts, XObject: xobjects, ExtGState: { GS1: translucent } },
        page.content,
      ),
    );
  });
  if (meta.title !== undefined) doc.setMetaData('info:Title', meta.title);
  if (meta.lang !== undefined) doc.getTrailer().get('Root').put('Lang', doc.newString(meta.lang));
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}
