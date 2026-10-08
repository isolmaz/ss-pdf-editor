import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { pageCountOf, pageSizesOf, runContext, runDialog, textPdf } from '../pdf-fixtures';
import { mergeFilesDialog, newDocumentDialog } from './start';

const pdfFile = async (name: string, pages: number) =>
  new File(
    [new Uint8Array(await textPdf(Array.from({ length: pages }, (_, index) => [`${name} ${index + 1}`])))],
    name,
  );

describe('newDocumentDialog', () => {
  it('makes a blank A4 portrait page named after the dictionary', async () => {
    const context = await runContext(new Uint8Array(), { pageCount: 0 });
    const result = await newDocumentDialog.run({ size: 'a4', orientation: 'portrait', pages: 1 }, context);
    expect(result.files[0]?.name).toBe(`${context.t('start.blank.name')}.pdf`);
    expect(result.files[0]?.mime).toBe('application/pdf');
    expect(await pageSizesOf(result.files[0]?.bytes ?? new Uint8Array())).toEqual([[595, 842]]);
  });

  it('makes several landscape Letter pages', async () => {
    const result = await runDialog(
      newDocumentDialog,
      { size: 'letter', orientation: 'landscape', pages: 3 },
      new Uint8Array(),
      { pageCount: 0 },
    );
    expect(await pageSizesOf(result.files[0]?.bytes ?? new Uint8Array())).toEqual([
      [792, 612],
      [792, 612],
      [792, 612],
    ]);
  });
});

describe('mergeFilesDialog', () => {
  it('appends the files in the order given and names the result after the dictionary', async () => {
    const files = [await pdfFile('a.pdf', 2), await pdfFile('b.pdf', 1)];
    const context = await runContext(new Uint8Array(), { pageCount: 0 });
    const result = await mergeFilesDialog.run({ files }, context);
    expect(result.files[0]?.name).toBe(`${context.t('start.merge.name')}.pdf`);
    expect(await pageCountOf(result.files[0]?.bytes ?? new Uint8Array())).toBe(3);
  });

  it('needs two files', async () => {
    const one = runDialog(mergeFilesDialog, { files: [await pdfFile('a.pdf', 1)] }, new Uint8Array(), {
      pageCount: 0,
    });
    await expect(one).rejects.toBeInstanceOf(ToolError);
    await expect(one).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'merge-files: 1 file(s) picked, two are needed' },
    });
    const none = mergeFilesDialog.run({}, await runContext(new Uint8Array(), { pageCount: 0 }));
    await expect(none).rejects.toMatchObject({
      details: { engineMessage: 'merge-files: 0 file(s) picked, two are needed' },
    });
  });
});
