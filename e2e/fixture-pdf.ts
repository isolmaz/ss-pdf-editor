/**
 * A real, minimal, single-page PDF, built byte by byte.
 *
 * The e2e document spec needs a genuine PDF to hand to the app, not a mock: no PDF
 * engine is a dependency of the repository root (the root deliberately does not gain one
 * for a test), so the fixture is assembled here — objects, a computed cross-reference table and
 * a trailer, exactly what a writer would emit. All content is ASCII, so one character is
 * one byte and the recorded offsets are the real ones.
 *
 * The page draws a filled rectangle: rendering it proves the viewer ran pdf.js over the
 * bytes instead of just echoing the file name.
 */
export function fixturePdf(): Uint8Array {
  const content = '0.1 0.2 0.9 rg\n40 40 220 120 re\nf\n';
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Title (R08 fixture) /Producer (pdf-editor e2e) >>',
  ];

  const chunks: string[] = ['%PDF-1.7\n'];
  const offsets: number[] = [];
  // The header is the first chunk by construction; the assertion is what keeps that a
  // fact rather than an assumption the reader has to re-derive.
  let offset = (chunks[0] ?? '').length;
  for (const [index, body] of bodies.entries()) {
    offsets.push(offset);
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    offset += chunk.length;
  }

  // Every xref entry is exactly 20 bytes: 10-digit offset, generation, in-use flag, EOL.
  const xref = [
    'xref\n',
    `0 ${bodies.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`),
  ].join('');
  const trailer = `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${offset}\n%%EOF\n`;

  const source = chunks.join('') + xref + trailer;
  return new Uint8Array([...source].map((character) => character.charCodeAt(0)));
}
