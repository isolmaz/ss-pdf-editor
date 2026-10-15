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
