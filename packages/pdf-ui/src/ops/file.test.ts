import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pageCountOf,
  pageSizesOf,
  pageTextsOf,
  pngBytes,
  runContext,
  runDialog,
  textPdf,
} from '../pdf-fixtures';
import { skia, skiaDocument } from '../skia-canvas.fixtures';
import { addDocumentDialog, exportImagesDialog, exportTextDialog, imagesToPdfDialog } from './file';

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();

const pdfFile = async (lines: readonly string[], name = 'added.pdf') =>
  new File([(await textPdf([lines])) as BlobPart], name, { type: 'application/pdf' });

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

describe('addDocumentDialog', () => {
  const base = () => textPdf([['first'], ['second']]);

  it('adds the picked file after the last page by default and counts the pages it brought', async () => {
    const result = await runDialog(addDocumentDialog, { source: [await pdfFile(['added'])] }, await base(), {
      name: 'plan.pdf',
    });
    expect(result.files[0]?.name).toBe('plan.pdf');
    expect(result.noticeKey).toBe('file.add.done');
    expect(result.noticeParams).toEqual({ count: 1 });
    const texts = await pageTextsOf(bytesOf(result));
    expect(texts.map((text) => text.trim())).toEqual(['first', 'second', 'added']);
  });

  it('puts the file in front of everything when asked for the start', async () => {
    const result = await runDialog(
      addDocumentDialog,
      { source: [await pdfFile(['added'])], insertAt: 'start' },
      await base(),
    );
    const texts = await pageTextsOf(bytesOf(result));
    expect(texts.map((text) => text.trim())).toEqual(['added', 'first', 'second']);
  });

  it('puts the file after the page being viewed when asked for after-current', async () => {
    const result = await runDialog(
      addDocumentDialog,
      { source: [await pdfFile(['added'])], insertAt: 'after-current' },
      await base(),
      { currentPage: 0 },
    );
    const texts = await pageTextsOf(bytesOf(result));
    expect(texts.map((text) => text.trim())).toEqual(['first', 'added', 'second']);
  });

  it('asks for a file when none was picked', async () => {
    const run = addDocumentDialog.run({}, await runContext(await base()));
    await expect(run).rejects.toMatchObject({
      code: 'input-missing',
      details: { engine: 'ui', engineMessage: 'add-document: no file was picked' },
    });
  });
});

describe('imagesToPdfDialog', () => {
  it('makes one page per picked image on the chosen page size, in a file named by the dictionary', async () => {
    const images = [
      new File([(await pngBytes(40, 20)) as BlobPart], 'a.png', { type: 'image/png' }),
      new File([(await pngBytes(20, 40)) as BlobPart], 'b.png', { type: 'image/png' }),
    ];
    const context = await runContext(new Uint8Array(), { pageCount: 0 });
    const result = await runDialog(imagesToPdfDialog, { images, pageSize: 'letter' }, new Uint8Array(), {
      pageCount: 0,
    });
    expect(result.files[0]?.name).toBe(`${context.t('file.createImages.name')}.pdf`);
    expect(result.files[0]?.mime).toBe('application/pdf');
    expect(await pageCountOf(bytesOf(result))).toBe(2);
    expect(await pageSizesOf(bytesOf(result))).toEqual([
      [612, 792],
      [612, 792],
    ]);
  });

  it('keeps the camera orientation out of the picture when asked to ignore it', async () => {
    const images = [new File([(await pngBytes(40, 20)) as BlobPart], 'a.png', { type: 'image/png' })];
    const result = await runDialog(
      imagesToPdfDialog,
      { images, pageSize: 'fit', exif: 'ignore' },
      new Uint8Array(),
      { pageCount: 0 },
    );
    expect(await pageCountOf(bytesOf(result))).toBe(1);
  });

  it('asks for images when none were picked', async () => {
    const run = imagesToPdfDialog.run({ images: [] }, await runContext(new Uint8Array(), { pageCount: 0 }));
    await expect(run).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'images-to-pdf: no images were picked' },
    });
    const none = imagesToPdfDialog.run({}, await runContext(new Uint8Array(), { pageCount: 0 }));
    await expect(none).rejects.toMatchObject({ code: 'input-missing' });
  });
});

describe('exportImagesDialog', () => {
  beforeEach(() => {
    // pdf.js draws on the Skia canvas, and the export reads the encoded picture back from it.
    vi.stubGlobal('document', skiaDocument);
    vi.stubGlobal('Path2D', skia.Path2D);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the pictures after the document when no name was typed, one PNG per page', async () => {
    const input = await textPdf([['one'], ['two']]);
    const result = await runDialog(exportImagesDialog, { format: 'png', dpi: 72 }, input, {
      name: 'plan.pdf',
    });
    expect(result.files.map((file) => file.name)).toEqual(['plan-001.png', 'plan-002.png']);
    for (const file of result.files) expect(Array.from(file.bytes.slice(0, 4))).toEqual(PNG_SIGNATURE);
    expect(result.noticeKey).toBe('export.images.done');
    expect(result.noticeParams).toEqual({ count: 2 });
    expect(result.report).toMatchObject({
      engine: 'pdfjs',
      steps: ['pdfjs.render'],
      inputBytes: input.length,
      outputBytes: result.files.reduce((sum, file) => sum + file.bytes.length, 0),
      pageCount: 2,
      incremental: false,
    });
    expect(result.report.notes).toEqual([{ kind: 'lost', key: 'export.images.loss.text' }]);
  });

  it('names the pictures after the typed name, trimmed', async () => {
    const result = await runDialog(
      exportImagesDialog,
      { format: 'png', dpi: 72, name: '  scan  ', scope: 'all' },
      await textPdf([['one']]),
    );
    expect(result.files.map((file) => file.name)).toEqual(['scan-001.png']);
  });

  it('exports every page named by the scope when the host sends no name field', async () => {
    const context = await runContext(await textPdf([['one'], ['two']]), { currentPage: 1 });
    const result = await exportImagesDialog.run({ scope: 'current', format: 'png', dpi: 72 }, context);
    expect(result.files.map((file) => file.name)).toEqual(['doc-001.png']);
  });
});

describe('exportTextDialog', () => {
  it('delivers the text of the pages and names the file in the notice', async () => {
    const input = await textPdf([['alpha'], ['beta']]);
    const result = await runDialog(exportTextDialog, { format: 'text' }, input, { name: 'plan.pdf' });
    expect(result.files).toHaveLength(1);
    const text = new TextDecoder().decode(bytesOf(result));
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(result.noticeKey).toBe('export.text.done');
    expect(result.noticeParams).toEqual({ name: result.files[0]?.name });
    expect(result.report.steps).toEqual(['pdfjs.getTextContent']);
    expect(result.report.pageCount).toBe(2);
    expect(result.report.outputBytes).toBe(bytesOf(result).length);
    expect(result.report.notes).toEqual([
      { kind: 'preserved', key: 'export.text.covered', params: { count: 2 } },
    ]);
  });

  it('tells the user a page that carries no text looks scanned, instead of reporting it as covered', async () => {
    const input = await textPdf([['alpha'], []]);
    const result = await runDialog(exportTextDialog, { format: 'markdown' }, input);
    expect(result.noticeKey).toBe('export.text.detected');
    expect(result.noticeParams).toBeUndefined();
    expect(result.report.notes).toEqual([
      { kind: 'warning', key: 'export.text.detected', params: { count: 1 } },
    ]);
  });
});
