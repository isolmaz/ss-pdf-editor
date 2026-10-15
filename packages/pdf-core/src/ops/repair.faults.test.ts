/**
 * The repair reads its output back before returning it. The real engine writes a sound file, so
 * the writer is replaced at its seam: it hands back a file that is not what the repair was
 * asked to write, and everything else (the reading back, both readers) is real.
 */

import { PDFDocument } from 'mupdf';
import { afterEach, describe, expect, it, vi } from 'vitest';

const written = vi.hoisted(() => ({ bytes: null as Uint8Array | null }));

vi.mock('../engines/mupdf-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf-write')>();
  return {
    ...actual,
    saveRewrite: (...args: Parameters<typeof actual.saveRewrite>) =>
      written.bytes ?? actual.saveRewrite(...args),
  };
});

const { repairDocument } = await import('./repair');

const run = { signal: new AbortController().signal };

function pages(count: number): Uint8Array {
  const doc = new PDFDocument();
  for (let index = 0; index < count; index += 1) {
    doc.insertPage(-1, doc.addPage([0, 0, 100, 100], 0, {}, ''));
  }
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** A file MuPDF opens but cannot count the pages of: its page tree claims five pages and lists none. */
function uncountable(): Uint8Array {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 5 >>'];
  let text = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) text += `${String(offset).padStart(10, '0')} 00000 n \n`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

afterEach(() => {
  written.bytes = null;
});

describe('repairDocument reads its output back', () => {
  it('refuses a file with fewer pages than the document had', async () => {
    written.bytes = pages(1);
    await expect(repairDocument(pages(3), run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: {
        engineMessage: 'the repaired file has 1 pages (1 in the viewer) and opens as it is, expected 3',
      },
    });
  });

  it('reports a written file whose pages cannot be counted as a failed read-back, keeping the cause', async () => {
    written.bytes = uncountable();
    await expect(repairDocument(pages(3), run)).rejects.toMatchObject({
      details: { engineMessage: expect.stringContaining('Invalid number of pages') },
    });
  });

  it('refuses a file that still has to be repaired to open', async () => {
    const source = pages(3);
    const text = new TextDecoder('latin1').decode(source);
    written.bytes = Uint8Array.from(text.replace(/startxref\s+\d+/, 'startxref\n7'), (c) => c.charCodeAt(0));
    await expect(repairDocument(source, run)).rejects.toMatchObject({
      code: 'verification-failed',
      details: {
        engineMessage: 'the repaired file has 3 pages (3 in the viewer) and still needs a repair, expected 3',
      },
    });
  });
});
