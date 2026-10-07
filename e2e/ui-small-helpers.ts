/**
 * Driving code of `ui-small.spec.ts`: documents built in Node with the pinned MuPDF.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright/test';
import { toolFixturePdf } from './tool-fixture';
import { dynamicXfaPdf } from './ui-xfa-helpers';

/** `mupdf` is a dependency of `packages/pdf-core`, not of the repository root. */
const coreRequire = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url));

interface MupdfAnnotation {
  getType(): string;
  setContents(text: string): void;
}

interface MupdfPage {
  getAnnotations(): MupdfAnnotation[];
}

interface MupdfDocument {
  loadPage(index: number): MupdfPage;
  saveToBuffer(options: string): { asUint8Array(): Uint8Array };
  destroy(): void;
}

interface MupdfModule {
  readonly PDFDocument: { openDocument(bytes: Uint8Array, magic: string): MupdfDocument };
}

/**
 * The tool fixture whose saved highlight carries `contents` as its `/Contents`: a file an
 * older version of the editor wrote has the identity marker there, ahead of the words.
 */
export async function withHighlightContents(contents: string): Promise<Uint8Array> {
  const mupdf: MupdfModule = await import(pathToFileURL(coreRequire.resolve('mupdf')).href);
  const doc = mupdf.PDFDocument.openDocument(toolFixturePdf().slice(), 'application/pdf');
  try {
    const highlight = doc
      .loadPage(0)
      .getAnnotations()
      .find((annotation) => annotation.getType() === 'Highlight');
    if (highlight === undefined) throw new Error('the tool fixture has no highlight');
    highlight.setContents(contents);
    return new Uint8Array(doc.saveToBuffer('').asUint8Array());
  } finally {
    doc.destroy();
  }
}

/**
 * A dynamic XFA form (`dynamicXfaPdf`) whose catalog does not ask the reader to render it:
 * MuPDF still sees a form without fields, pdf.js lays no template out. The entry is blanked
 * in place, so every recorded offset stays true.
 */
export function xfaWithoutNeedsRendering(): Uint8Array {
  const bytes = dynamicXfaPdf();
  const text = String.fromCharCode(...bytes);
  const entry = ' /NeedsRendering true';
  if (!text.includes(entry)) throw new Error('the XFA fixture has no /NeedsRendering entry');
  return new Uint8Array(
    [...text.replace(entry, ' '.repeat(entry.length))].map((character) => character.charCodeAt(0)),
  );
}

/** A PDF printed by Chromium from HTML: a real producer's output, with real text and drawn lines. */
export async function printedPdf(page: Page, html: string): Promise<Uint8Array> {
  const printer = await page.context().newPage();
  try {
    await printer.setContent(html);
    return new Uint8Array(await printer.pdf({ format: 'A4', printBackground: true, outline: false }));
  } finally {
    await printer.close();
  }
}

/** A flat form: captions followed by drawn blanks and two tick squares, no form fields at all. */
export const FLAT_FORM = `<!doctype html><html lang="en"><head><title>Flat form</title></head>
<body style="font: 14pt sans-serif; margin: 40pt">
<h1>Registration</h1>
${['Full name', 'Street address', 'City', 'Phone number']
  .map(
    (label) =>
      `<p>${label}: <span style="display:inline-block;width:320px;border-bottom:1px solid #000">&nbsp;</span></p>`,
  )
  .join('\n')}
<p><span style="display:inline-block;width:14px;height:14px;border:1px solid #000"></span> I agree
&nbsp;&nbsp; <span style="display:inline-block;width:14px;height:14px;border:1px solid #000"></span> I decline</p>
</body></html>`;

/**
 * A page that is one picture of a sheet over the whole sheet of paper, with the text a
 * recognised scan carries over it (none when `text` is empty).
 */
export function pictureOnlyHtml(photo: Uint8Array, text = ''): string {
  return `<!doctype html><html lang="en"><head><title>Picture</title></head>
<body style="margin:0"><img alt="" style="display:block;width:793px;height:1122px" src="data:image/png;base64,${Buffer.from(photo).toString('base64')}">${
    text === ''
      ? ''
      : `<p style="position:absolute;top:300px;left:100px;font:14pt sans-serif;margin:0">${text}</p>`
  }</body></html>`;
}
