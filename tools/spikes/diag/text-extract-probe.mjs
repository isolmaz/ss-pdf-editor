import { readFileSync } from 'node:fs';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const data = new Uint8Array(readFileSync(process.argv[2]));
const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise;
console.log('pages', doc.numPages);
for (let i = 1; i <= doc.numPages; i += 1) {
  const page = await doc.getPage(i);
  const content = await page.getTextContent();
  console.log(`--- page ${i} ---`);
  console.log(
    content.items
      .map((it) => it.str)
      .join('|')
      .slice(0, 400),
  );
}
await doc.destroy();
