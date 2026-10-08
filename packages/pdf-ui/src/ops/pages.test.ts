import { describe, expect, it } from 'vitest';
import { pageCountOf, pageTextsOf, runContext, runDialog, textPdf } from '../pdf-fixtures';
import { extractPagesDialog, splitDialog } from './pages';

const five = () => textPdf([['one'], ['two'], ['three'], ['four'], ['five']]);
const bytesOf = (file: { bytes: Uint8Array } | undefined) => file?.bytes ?? new Uint8Array();

describe('extractPagesDialog', () => {
  it('extracts the selected pages into a file named after the range', async () => {
    const result = await runDialog(extractPagesDialog, { scope: 'range:2-3,5' }, await five(), {
      name: 'report.pdf',
    });
    expect(result.files[0]?.name).toBe('report-p2-3_5.pdf');
    expect(result.files[0]?.mime).toBe('application/pdf');
    const texts = await pageTextsOf(bytesOf(result.files[0]));
    expect(texts.map((text) => text.trim())).toEqual(['two', 'three', 'five']);
  });

  it('starts on the pages selected in the viewer', async () => {
    const result = await runDialog(extractPagesDialog, {}, await five(), { selectedPages: [3] });
    expect((await pageTextsOf(bytesOf(result.files[0]))).map((text) => text.trim())).toEqual(['four']);
  });
});

describe('splitDialog', () => {
  it('cuts the document into parts of N pages, named after the document', async () => {
    const result = await runDialog(splitDialog, { mode: 'everyN', chunkSize: 2 }, await five());
    expect(result.noticeKey).toBe('split.done');
    expect(result.noticeParams).toEqual({ count: 3 });
    expect(result.files.map((file) => file.name)).toEqual(['doc-1.pdf', 'doc-2.pdf', 'doc-3.pdf']);
    const counts = await Promise.all(result.files.map((file) => pageCountOf(file.bytes)));
    expect(counts).toEqual([2, 2, 1]);
    expect(result.report.pageCount).toBe(5);
    expect(result.report.outputBytes).toBe(result.files.reduce((sum, file) => sum + file.bytes.length, 0));
    expect(result.report.notes.at(-1)).toEqual({ kind: 'changed', key: 'split.done', params: { count: 3 } });
  });

  it('cuts at the ranges typed, with a stem of its own', async () => {
    const result = await runDialog(
      splitDialog,
      { mode: 'ranges', ranges: '1-2, 4', baseName: '  part  ' },
      await five(),
    );
    const counts = await Promise.all(result.files.map((file) => pageCountOf(file.bytes)));
    expect(counts).toEqual([2, 1]);
    expect(result.files.every((file) => file.name.startsWith('part'))).toBe(true);
  });

  it('cuts by size: a limit beyond the file keeps one part', async () => {
    const result = await runDialog(splitDialog, { mode: 'size', maxSizeMb: 10 }, await five());
    expect(result.files).toHaveLength(1);
    expect(await pageCountOf(bytesOf(result.files[0]))).toBe(5);
  });

  it('folds a document into booklet parts', async () => {
    const result = await runDialog(splitDialog, { mode: 'booklet', chunkSize: 4 }, await five());
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.noticeParams).toEqual({ count: result.files.length });
  });

  it('refuses a rule that would produce more parts than the ceiling, before reading any page', async () => {
    const run = runDialog(splitDialog, { mode: 'everyN', chunkSize: 1 }, new Uint8Array(), {
      pageCount: 201,
    });
    await expect(run).rejects.toMatchObject({
      code: 'range-invalid',
      details: { engineMessage: 'split plan produces 201 parts, over the 200 ceiling' },
    });
  });

  it('names the parts after the document when no stem is given at all', async () => {
    const result = await splitDialog.run(
      { mode: 'everyN', chunkSize: 5 },
      await runContext(await five(), { name: 'book.pdf' }),
    );
    expect(result.files.map((file) => file.name)).toEqual(['book-1.pdf']);
  });
});
