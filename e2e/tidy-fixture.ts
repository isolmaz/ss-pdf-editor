/**
 * Documents for the page tidy-up specs: pages of any size, each with one line of text near
 * the top-left corner or none at all (a blank page). Built byte by byte like `labelledPdf`.
 */

export interface TidyPage {
  readonly size?: readonly [number, number];
  /** The page's one line; a page without it has no content at all. */
  readonly text?: string;
}

export function tidyPdf(pages: readonly TidyPage[]): Uint8Array {
  const bodies: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids: number[] = [];
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const page of pages) {
    const [width, height] = page.size ?? [595, 842];
    const content =
      page.text === undefined ? '' : `BT /F1 24 Tf 72 ${height - 142} Td (${page.text}) Tj ET\n`;
    kids.push(bodies.length + 1);
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${bodies.length + 2} 0 R >>`,
    );
    bodies.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }
  bodies[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;

  let source = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${xref}`;
  source += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${source.indexOf('xref\n')}\n%%EOF\n`;
  return new Uint8Array([...source].map((character) => character.charCodeAt(0)));
}
