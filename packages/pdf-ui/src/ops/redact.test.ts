import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { mupdfForTests, pageTextsOf, runContext, runDialog, textPdf } from '../pdf-fixtures';
import { redactDialog } from './redact';

/** Covers the first line of `textPdf` (baseline 72 pt below the top) and nothing else. */
const FIRST_LINE = { pageIndex: 0, space: 'app-v1', rect: [60, 60, 300, 77] } as const;

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();

async function withAttachments(bytes: Uint8Array): Promise<Uint8Array> {
  const mupdf = await mupdfForTests();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  doc.setMetaData('info:Title', 'Secret title');
  const data = new TextEncoder().encode('ATTACHED');
  for (const name of ['secret.txt', 'keep.txt']) {
    doc.insertEmbeddedFile(name, doc.addEmbeddedFile(name, 'text/plain', data, new Date(0), new Date(0)));
  }
  const out = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return out;
}

async function attachmentNames(bytes: Uint8Array): Promise<string[]> {
  const mupdf = await mupdfForTests();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  const names = Object.keys(doc?.getEmbeddedFiles() ?? {});
  doc?.destroy();
  return names.sort();
}

describe('redactDialog', () => {
  it('erases the marked text for real and keeps the rest, saying the check passed', async () => {
    const bytes = await textPdf([['Secret line', '', '', '', 'Public line']]);
    const result = await runDialog(redactDialog, {}, bytes, { redactions: [FIRST_LINE] });
    expect((await pageTextsOf(bytesOf(result))).map((text) => text.trim())).toEqual(['Public line']);
    expect(result.files[0]?.name).toBe('doc.pdf');
    expect(result.noticeKey).toBe('redact.verify.done');
    const keys = result.report.notes.map((entry) => entry.key);
    expect(keys).toContain('redact.markCount');
    expect(keys.slice(-3)).toEqual(['redact.markCount', 'redact.verify.done', 'redact.warning.localTrace']);
    expect(result.report.notes.find((entry) => entry.key === 'redact.markCount')?.params).toEqual({
      count: 1,
    });
  });

  it('refuses to write anything without marks', async () => {
    const run = runDialog(redactDialog, {}, await textPdf([['Secret line']]));
    await expect(run).rejects.toBeInstanceOf(ToolError);
    await expect(run).rejects.toMatchObject({
      code: 'selection-empty',
      details: { engineMessage: 'redact: no marks were drawn' },
    });
  });

  it('removes the attachments of the document and clears the info dictionary when asked', async () => {
    const bytes = await withAttachments(await textPdf([['Secret line', '', '', '', 'Public line']]));
    expect(await attachmentNames(bytes)).toEqual(['keep.txt', 'secret.txt']);
    const result = await runDialog(
      redactDialog,
      { clean: ['info', 'attachments'], imageMethod: 'pixels' },
      bytes,
      { redactions: [FIRST_LINE] },
    );
    expect(await attachmentNames(bytesOf(result))).toEqual([]);
    expect(result.report.steps).toContain('clean(attachments)');
    expect(result.report.steps).toContain('clean(Info+XMP)');
  });

  it('keeps the attachments unless asked, and treats an unknown image method as leaving images alone', async () => {
    const bytes = await withAttachments(await textPdf([['Secret line', '', '', '', 'Public line']]));
    const result = await redactDialog.run(
      { imageMethod: 'bogus' },
      await runContext(bytes, { redactions: [FIRST_LINE] }),
    );
    expect(await attachmentNames(bytesOf(result))).toEqual(['keep.txt', 'secret.txt']);
    expect(result.report.notes.map((entry) => entry.key)).toContain('op.note.redact.imagesUntouched');
  });

  it('refuses marks in a geometry it cannot place, writing nothing', async () => {
    const run = runDialog(redactDialog, {}, await textPdf([['Secret line']]), {
      redactions: [{ pageIndex: 0, space: 'legacy', rect: [0, 0, 10, 10] } as never],
    });
    await expect(run).rejects.toMatchObject({ code: 'redaction-geometry-unknown' });
  });
});
