/**
 * Shared code of the `ui-rest16-*.spec.ts` specs: a hand-built one-page PDF whose text runs
 * sit exactly where a spec wants them, so a text selection has a known number of spans.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** One text run: drawn in Helvetica at `size` points with its baseline at (`x`, `y`). */
export interface Run {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly size?: number;
  /** The text matrix's `a b c d` (a turn or skew of the run); the run's origin is still `x`, `y`. */
  readonly matrix?: readonly [number, number, number, number];
}

/**
 * A single A4-size page (595 × 842) with `runs`, each in its own text object so the viewer's
 * text layer gets one span per run. All content is ASCII, so offsets are byte offsets.
 */
export function runsPdf(runs: readonly Run[]): Uint8Array {
  const content = runs
    .map(
      (run) =>
        `BT /F1 ${run.size ?? 18} Tf ${(run.matrix ?? [1, 0, 0, 1]).join(' ')} ${run.x} ${run.y} Tm (${run.text}) Tj ET\n`,
    )
    .join('');
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  const chunks: string[] = ['%PDF-1.7\n'];
  const offsets: number[] = [];
  let offset = (chunks[0] ?? '').length;
  for (const [index, body] of bodies.entries()) {
    offsets.push(offset);
    const chunk = `${index + 1} 0 obj\n${body}\nendobj\n`;
    chunks.push(chunk);
    offset += chunk.length;
  }
  const xref = [
    'xref\n',
    `0 ${bodies.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`),
  ].join('');
  const trailer = `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  const source = chunks.join('') + xref + trailer;
  return new Uint8Array([...source].map((character) => character.charCodeAt(0)));
}

interface StreamObject {
  isNull(): boolean;
  isArray(): boolean;
  isStream(): boolean;
  resolve(): StreamObject;
  get(...path: (string | number)[]): StreamObject;
  readStream(): { asString(): string };
  readonly length: number;
}

interface StreamPdf {
  findPage(index: number): StreamObject;
  destroy(): void;
}

interface StreamMupdf {
  readonly PDFDocument: {
    openDocument(bytes: Uint8Array, magic: string): { asPDF(): StreamPdf | null };
  };
}

/** The decoded content stream(s) of page `index` of `bytes`, joined, as MuPDF reads them. */
export async function pageContentOf(bytes: Uint8Array, index = 0): Promise<string> {
  const coreRequire = createRequire(new URL('../packages/pdf-core/package.json', import.meta.url));
  const mupdf: StreamMupdf = await import(pathToFileURL(coreRequire.resolve('mupdf')).href);
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('the produced file is not a PDF');
  try {
    // A stream is read through the reference to it: resolving one answers its dictionary.
    const contents = doc.findPage(index).get('Contents');
    if (!contents.isArray()) return contents.readStream().asString();
    const parts: string[] = [];
    for (let at = 0; at < contents.length; at += 1) parts.push(contents.get(at).readStream().asString());
    return parts.join('\n');
  } finally {
    doc.destroy();
  }
}
