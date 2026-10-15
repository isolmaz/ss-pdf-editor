import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { pageCountOf, pageSizesOf, pageTextsOf, runContext, runDialog, textPdf } from '../pdf-fixtures';
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

describe('mergeFilesDialog alternating the sides of a double-sided scan', () => {
  const texts = async (bytes: Uint8Array | undefined) =>
    (await pageTextsOf(bytes ?? new Uint8Array())).map((text) => text.trim());

  it('alternates front and back, reading the backs from their last page unless told otherwise', async () => {
    const fronts = await pdfFile('fronts.pdf', 3);
    const backs = await pdfFile('backs.pdf', 3);
    const reversed = await runDialog(
      mergeFilesDialog,
      { mode: 'interleave', fronts: [fronts], backs: [backs] },
      new Uint8Array(),
      { pageCount: 0 },
    );
    expect(await texts(reversed.files[0]?.bytes)).toEqual([
      'fronts.pdf 1',
      'backs.pdf 3',
      'fronts.pdf 2',
      'backs.pdf 2',
      'fronts.pdf 3',
      'backs.pdf 1',
    ]);
    expect(reversed.report.notes.some((entry) => entry.kind === 'warning')).toBe(false);

    const inOrder = await runDialog(
      mergeFilesDialog,
      { mode: 'interleave', fronts: [fronts], backs: [backs], reverseBacks: false },
      new Uint8Array(),
      { pageCount: 0 },
    );
    expect((await texts(inOrder.files[0]?.bytes)).slice(0, 2)).toEqual(['fronts.pdf 1', 'backs.pdf 1']);
  });

  it('puts the pages without a partner at the end and warns about them', async () => {
    const result = await runDialog(
      mergeFilesDialog,
      { mode: 'interleave', fronts: [await pdfFile('f.pdf', 3)], backs: [await pdfFile('b.pdf', 1)] },
      new Uint8Array(),
      { pageCount: 0 },
    );
    expect(await texts(result.files[0]?.bytes)).toEqual(['f.pdf 1', 'b.pdf 1', 'f.pdf 2', 'f.pdf 3']);
    expect(result.report.notes).toContainEqual({
      kind: 'warning',
      key: 'op.note.merge.unequalFronts',
      params: { count: 2 },
    });
  });

  it('needs a file for each side', async () => {
    const onlyFronts = runDialog(
      mergeFilesDialog,
      { mode: 'interleave', fronts: [await pdfFile('f.pdf', 1)] },
      new Uint8Array(),
      { pageCount: 0 },
    );
    await expect(onlyFronts).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'merge-files: a front-sides file and a back-sides file are needed' },
    });
  });
});
