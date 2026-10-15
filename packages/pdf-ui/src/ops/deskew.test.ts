import { PRODUCER_LINE } from 'pdf-core/engines/mupdf-write';
import { scanDocument, tiltedText } from 'pdf-core/ops/deskew.fixtures';
import { describe, expect, it, vi } from 'vitest';
import { loadMupdf } from '../../../pdf-core/src/engines/mupdf';
import { runDialog } from '../pdf-fixtures';
import { deskewDialog } from './deskew';

// Each case typesets, renders and measures whole pages with MuPDF.
vi.setConfig({ testTimeout: 60_000 });

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();

/** How many content streams each page has: a turned page has its original between two new ones. */
async function streamCounts(bytes: Uint8Array): Promise<number[]> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pdf = doc.asPDF();
    return Array.from({ length: doc.countPages() }, (_unused, index) => {
      const contents = pdf?.findPage(index).get('Contents');
      return contents?.isArray() === true ? contents.length : 1;
    });
  } finally {
    doc.destroy();
  }
}

describe('deskewDialog', () => {
  it('asks only for the pages, and holds the dialog while marks sit on content it would move', () => {
    expect(deskewDialog.fields.map((field) => [field.id, field.kind])).toEqual([['scope', 'pageScope']]);
    expect(deskewDialog.resultKind).toBe('replace');
    expect(deskewDialog.changesPageGeometry).toBe(true);
  });

  it('straightens the pages of the scope and nothing else, and counts them in the notice', async () => {
    const input = await scanDocument([
      { content: tiltedText(3) },
      { content: tiltedText(-2.5) },
      { content: tiltedText(0) },
    ]);
    const result = await runDialog(deskewDialog, { scope: 'range:2-3' }, input);

    expect(result.noticeKey).toBe('deskew.done');
    expect(result.noticeParams).toEqual({ count: 1 });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.name).toBe('doc.pdf');
    expect(result.files[0]?.mime).toBe('application/pdf');
    expect(await streamCounts(bytesOf(result))).toEqual([1, 3, 1]);
    expect(result.report.notes.map((note) => note.key)).toEqual([
      'deskew.note.straightened',
      'deskew.note.level',
      'deskew.note.lossless',
      'op.note.metadata.producerKept',
    ]);
    expect(result.report.notes[0]?.params?.page).toBe(2);
    expect(result.report.notes[3]?.params).toEqual({ producer: PRODUCER_LINE });
  });

  it('straightens the whole document by default', async () => {
    const input = await scanDocument([{ content: tiltedText(3) }, { content: tiltedText(-2.5) }]);
    const result = await runDialog(deskewDialog, {}, input);
    expect(result.noticeParams).toEqual({ count: 2 });
    expect(await streamCounts(bytesOf(result))).toEqual([3, 3]);
  });

  it('hands back no file when no page needed a turn, so applying it journals nothing', async () => {
    const input = await scanDocument([{ content: tiltedText(0) }, { content: '' }]);
    const result = await runDialog(deskewDialog, {}, input);
    expect(result.files).toEqual([]);
    expect(result.noticeKey).toBe('deskew.note.unchanged');
    expect(result.report.notes.map((note) => [note.kind, note.key])).toEqual([
      ['preserved', 'deskew.note.level'],
      ['warning', 'deskew.note.unclear'],
      ['warning', 'deskew.note.unchanged'],
    ]);
  });
});
