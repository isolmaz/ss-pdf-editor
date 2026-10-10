import { describe, expect, it } from 'vitest';
import {
  pageCountOf,
  pageSizesOf,
  pageTextsOf,
  pngBytes,
  runContext,
  runDialog,
  textPdf,
} from '../pdf-fixtures';
import { insertPagesDialog, replacePagesDialog } from './pageedit';

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();

/** Three small pages, 300 x 400 pt, reading p1, p2, p3. */
const three = () => textPdf([['p1'], ['p2'], ['p3']], [300, 400]);

const textsOf = async (result: { files: readonly { bytes: Uint8Array }[] }) =>
  (await pageTextsOf(bytesOf(result))).map((text) => text.trim());

const pdfFile = async (pages: readonly (readonly string[])[], name = 'source.pdf') =>
  new File([(await textPdf(pages, [200, 200])) as BlobPart], name, { type: 'application/pdf' });

const imageFile = async (name: string, width = 40, height = 20) =>
  new File([(await pngBytes(width, height)) as BlobPart], name, { type: 'image/png' });

describe('insertPagesDialog with blank pages', () => {
  it('inserts the requested number of blank pages after the chosen page, on the chosen size', async () => {
    const result = await runDialog(
      insertPagesDialog,
      { position: 1, count: 2, size: 'letter' },
      await three(),
    );
    expect(result.files[0]?.name).toBe('doc.pdf');
    expect(await textsOf(result)).toEqual(['p1', '', '', 'p2', 'p3']);
    expect((await pageSizesOf(bytesOf(result))).map(([width]) => width)).toEqual([300, 612, 612, 300, 300]);
    expect(result.noticeKey).toBe('insert.note.inserted');
    expect(result.noticeParams).toEqual({ count: 2, position: 2 });
  });

  it('gives the pages the size of the page being viewed when asked to match', async () => {
    const result = await runDialog(
      insertPagesDialog,
      { position: 3, count: 1, size: 'match' },
      await textPdf([['p1'], ['p2']], [300, 400]),
      { currentPage: 1 },
    );
    expect(await pageSizesOf(bytesOf(result))).toEqual([
      [300, 400],
      [300, 400],
      [300, 400],
    ]);
  });

  it('matches the insertion point when the viewer has no current page', async () => {
    const result = await runDialog(
      insertPagesDialog,
      { position: 1, count: 1, size: 'match' },
      await three(),
      { currentPage: -1 },
    );
    expect(await pageCountOf(bytesOf(result))).toBe(4);
    expect(await pageSizesOf(bytesOf(result))).toEqual([
      [300, 400],
      [300, 400],
      [300, 400],
      [300, 400],
    ]);
    expect(result.noticeParams).toEqual({ count: 1, position: 2 });
  });

  it('puts the pages in front of everything for a position of zero, a negative one, or one that is not a number', async () => {
    for (const position of [0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await runDialog(insertPagesDialog, { position, count: 1 }, await three());
      expect(await textsOf(result)).toEqual(['', 'p1', 'p2', 'p3']);
      expect(result.noticeParams).toEqual({ count: 1, position: 1 });
    }
    const unset = await insertPagesDialog.run({ count: 1 }, await runContext(await three()));
    expect(await textsOf(unset)).toEqual(['', 'p1', 'p2', 'p3']);
  });

  it('appends at the end when the position is past the last page', async () => {
    const result = await runDialog(insertPagesDialog, { position: 99, count: 1 }, await three());
    expect(await textsOf(result)).toEqual(['p1', 'p2', 'p3', '']);
    expect(result.noticeParams).toEqual({ count: 1, position: 4 });
  });
});

describe('insertPagesDialog with pictures', () => {
  it('makes one page per picked image', async () => {
    const result = await runDialog(
      insertPagesDialog,
      {
        source: 'image',
        position: 0,
        size: 'a4',
        fit: 'stretch',
        marginMm: 5,
        images: [await imageFile('a.png'), await imageFile('b.png')],
      },
      await three(),
    );
    expect(await pageCountOf(bytesOf(result))).toBe(5);
    expect((await pageSizesOf(bytesOf(result))).slice(0, 2)).toEqual([
      [595, 842],
      [595, 842],
    ]);
    expect(result.noticeParams).toEqual({ count: 2, position: 1 });
  });

  it('takes scanned pages as pictures too, with the fit the user chose', async () => {
    const result = await runDialog(
      insertPagesDialog,
      { source: 'scan', position: 3, size: 'letter', fit: 'fill', scans: [await imageFile('scan-1.jpg')] },
      await three(),
    );
    expect(await pageCountOf(bytesOf(result))).toBe(4);
    expect((await pageSizesOf(bytesOf(result)))[3]).toEqual([612, 792]);
  });

  it('says which source is empty when no image was picked and when nothing was scanned', async () => {
    await expect(runDialog(insertPagesDialog, { source: 'image' }, await three())).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'pageedit: no image was picked' },
    });
    await expect(
      runDialog(insertPagesDialog, { source: 'scan', scans: [] }, await three()),
    ).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'pageedit: no page was scanned' },
    });
  });
});

describe('insertPagesDialog with another document', () => {
  it('inserts every page of the picked file when no range is typed', async () => {
    const result = await runDialog(
      insertPagesDialog,
      { source: 'document', position: 1, document: [await pdfFile([['a'], ['b']])] },
      await three(),
    );
    expect(await textsOf(result)).toEqual(['p1', 'a', 'b', 'p2', 'p3']);
    expect(result.noticeParams).toEqual({ count: 2, position: 2 });
  });

  it('inserts only the pages the range names, counted in the source document', async () => {
    const result = await runDialog(
      insertPagesDialog,
      { source: 'document', position: 3, range: ' 2 ', document: [await pdfFile([['a'], ['b'], ['c']])] },
      await three(),
    );
    expect(await textsOf(result)).toEqual(['p1', 'p2', 'p3', 'b']);
  });

  it('refuses a range past the end of the source document, not of the current one', async () => {
    const run = runDialog(
      insertPagesDialog,
      { source: 'document', range: '3', document: [await pdfFile([['a'], ['b']])] },
      await three(),
    );
    await expect(run).rejects.toMatchObject({ code: 'range-invalid' });
  });

  it('asks for a source file when none was picked', async () => {
    await expect(runDialog(insertPagesDialog, { source: 'document' }, await three())).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'pageedit: no source PDF was picked' },
    });
  });
});

describe('a host that sends only the fields it has', () => {
  it('inserts every page of the picked document when the range field is absent', async () => {
    const result = await insertPagesDialog.run(
      { source: 'document', position: 3, document: [await pdfFile([['a'], ['b']])] },
      await runContext(await three()),
    );
    expect(await textsOf(result)).toEqual(['p1', 'p2', 'p3', 'a', 'b']);
  });

  it('treats an absent image list as nothing picked', async () => {
    const run = insertPagesDialog.run({ source: 'image' }, await runContext(await three()));
    await expect(run).rejects.toMatchObject({ code: 'input-missing' });
  });
});

describe('replacePagesDialog', () => {
  it('replaces the selected pages with blank ones the size of the pages they replace', async () => {
    const result = await runDialog(replacePagesDialog, { scope: 'range:2' }, await three());
    expect(await textsOf(result)).toEqual(['p1', '', 'p3']);
    expect(await pageSizesOf(bytesOf(result))).toEqual([
      [300, 400],
      [300, 400],
      [300, 400],
    ]);
    expect(result.noticeKey).toBe('replace.note.replaced');
    expect(result.noticeParams).toEqual({ count: 1 });
  });

  it('gives the blank replacements the chosen paper size instead', async () => {
    const result = await runDialog(replacePagesDialog, { scope: 'range:1-2', size: 'letter' }, await three());
    expect(await textsOf(result)).toEqual(['', '', 'p3']);
    expect(await pageSizesOf(bytesOf(result))).toEqual([
      [612, 792],
      [612, 792],
      [300, 400],
    ]);
    expect(result.noticeParams).toEqual({ count: 2 });
  });

  it('replaces pages with the picked images, one image per page', async () => {
    const result = await runDialog(
      replacePagesDialog,
      {
        scope: 'range:1,3',
        source: 'image',
        size: 'a4',
        fit: 'fit',
        marginMm: 0,
        images: [await imageFile('a.png'), await imageFile('b.png')],
      },
      await three(),
    );
    expect(await textsOf(result)).toEqual(['', 'p2', '']);
    expect((await pageSizesOf(bytesOf(result)))[0]).toEqual([595, 842]);
  });

  it('replaces pages with the pages the range names in the picked document', async () => {
    const result = await runDialog(
      replacePagesDialog,
      {
        scope: 'range:1-2',
        source: 'document',
        range: '2-3',
        document: [await pdfFile([['a'], ['b'], ['c']])],
      },
      await three(),
    );
    expect(await textsOf(result)).toEqual(['b', 'c', 'p3']);
  });

  it('refuses a replacement that would not fill the selection, naming the counts and the images', async () => {
    const withImages = runDialog(
      replacePagesDialog,
      { scope: 'all', source: 'image', images: [await imageFile('a.png')] },
      await three(),
    );
    await expect(withImages).rejects.toMatchObject({
      code: 'selection-empty',
      details: {
        engineMessage: 'replace-pages: 3 page(s) selected, 1 replacement page(s) prepared from 1 image(s)',
      },
    });
    const withDocument = runDialog(
      replacePagesDialog,
      { scope: 'range:1-2', source: 'document', range: '1', document: [await pdfFile([['a'], ['b']])] },
      await three(),
    );
    await expect(withDocument).rejects.toMatchObject({
      code: 'selection-empty',
      details: { engineMessage: 'replace-pages: 2 page(s) selected, 1 replacement page(s) prepared' },
    });
  });

  it('says which source is empty when no image or document was picked', async () => {
    await expect(
      runDialog(replacePagesDialog, { scope: 'all', source: 'image' }, await three()),
    ).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'pageedit: no image was picked' },
    });
    await expect(
      runDialog(replacePagesDialog, { scope: 'all', source: 'document' }, await three()),
    ).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'pageedit: no source PDF was picked' },
    });
  });
});
