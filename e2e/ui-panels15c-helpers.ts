/** Fixtures of the round-15c panel specs. */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildTagged, type TPage, tagged } from '../packages/pdf-core/src/ops/tagged.fixtures';
import { assemble } from './ui-panels15-helpers';

const BASE_FONTS = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Courier',
  'Courier-Bold',
  'Courier-Oblique',
  'Symbol',
] as const;

export const UNEMBEDDED_FONTS = BASE_FONTS.length;

/** One page that shows a line in each of ten base-14 fonts, none of them embedded. */
export function manyFontsPdf(): Uint8Array {
  const resources = BASE_FONTS.map((_, index) => `/F${index} ${index + 5} 0 R`).join(' ');
  const content = BASE_FONTS.map(
    (_, index) => `BT /F${index} 12 Tf 72 ${760 - index * 20} Td (Line ${index}) Tj ET\n`,
  ).join('');
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << ${resources} >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    ...BASE_FONTS.map((name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} >>`),
  ]);
}

const line = (mcid: number, tag: string, y: number, text: string): string =>
  tagged(tag, mcid, `BT /F1 12 Tf 20 ${y} Td (${text}) Tj ET`);

/** The root does not declare `mupdf`; its types are reached through the fixture builder's own. */
type FontBuilder = NonNullable<NonNullable<TPage['fonts']>[string]['build']>;
type MupdfFont = Parameters<Parameters<FontBuilder>[0]['addSimpleFont']>[0];

interface FontModule {
  readonly Font: new (name: string, program: Uint8Array) => MupdfFont;
}

/** `mupdf` is a dependency of `packages/pdf-core`, not of the repository root. */
const coreRequire = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url));

/**
 * A small tagged document whose automated PDF/UA rules pass except the title (the XMP has none)
 * and the identifier: an embedded font (the pinned Noto Sans), a language, a title-bar title, a
 * heading and a paragraph in one tagged tree.
 */
export async function almostConformingPdf(): Promise<Uint8Array> {
  const mupdf = (await import(pathToFileURL(coreRequire.resolve('mupdf')).href)) as FontModule;
  const program = new Uint8Array(
    readFileSync(new URL('../public/fonts/noto/NotoSans-Regular.ttf', import.meta.url)),
  );
  const built = await buildTagged({
    pages: [
      {
        content: line(0, 'H1', 270, 'Annual report') + line(1, 'P', 245, 'First paragraph'),
        fonts: {
          F1: { dict: {}, build: (doc) => doc.addSimpleFont(new mupdf.Font('NotoSans', program), 'Latin') },
        },
        box: [0, 0, 300, 300],
        structParents: 0,
      },
    ],
    tree: [
      {
        s: 'Document',
        pg: 0,
        k: [
          { s: 'H1', k: [0] },
          { s: 'P', k: [1] },
        ],
      },
    ],
    parentTree: true,
    markInfo: true,
    lang: 'en-US',
    title: 'Conforming report',
    displayTitle: true,
  });
  return built.bytes;
}
