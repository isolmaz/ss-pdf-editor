import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pageTextsOf,
  pngBytes,
  removeFontOrigin,
  runContext,
  runDialog,
  textPdf,
  useFontOrigin,
} from '../pdf-fixtures';
import { pageNumbersDialog, watermarkDialog } from './stamp';

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();
const three = () => textPdf([['body one'], ['body two'], ['body three']]);

describe('pageNumbersDialog', () => {
  beforeEach(useFontOrigin);
  afterEach(removeFontOrigin);

  it('stamps "n of total" on every page, from the number asked for', async () => {
    const result = await runDialog(
      pageNumbersDialog,
      { template: 'Page {page} of {total}', startAt: 5 },
      await three(),
    );
    expect(result.noticeKey).toBe('stamp.done');
    expect(result.noticeParams).toEqual({ count: 3 });
    const texts = await pageTextsOf(bytesOf(result));
    expect(texts[0]).toContain('Page 5 of 3');
    expect(texts[1]).toContain('Page 6 of 3');
    expect(texts[2]).toContain('Page 7 of 3');
    expect(texts[2]).toContain('body three');
  });

  it('skips the first page and gives it its own template when asked', async () => {
    const result = await runDialog(
      pageNumbersDialog,
      { template: 'N{page}', differentFirst: true, firstTemplate: '  COVER  ' },
      await three(),
    );
    const texts = await pageTextsOf(bytesOf(result));
    expect(texts[0]).toContain('COVER');
    expect(texts[1]).toContain('N2');
    expect(texts[1]).not.toContain('COVER');
  });

  it('leaves the first page without a number when skipFirst is ticked', async () => {
    const result = await runDialog(
      pageNumbersDialog,
      { template: 'N{page}', skipFirst: true },
      await three(),
    );
    const texts = await pageTextsOf(bytesOf(result));
    expect(texts[0]).not.toContain('N');
    // The first stamped page shows the start number.
    expect(texts[1]).toContain('N1');
    expect(texts[2]).toContain('N2');
  });

  it('refuses a different first page without a template for it', async () => {
    const run = pageNumbersDialog.run(
      {
        scope: 'all',
        anchor: 'bottom-center',
        template: 'N{page}',
        fontSize: 12,
        marginMm: 24,
        startAt: 1,
        differentFirst: true,
      },
      await runContext(await three()),
    );
    await expect(run).rejects.toMatchObject({ code: 'selection-empty' });
  });

  it('stamps only the pages of a range scope, and reads a missing template as empty', async () => {
    const result = await runDialog(
      pageNumbersDialog,
      { template: 'S{page}', scope: 'range:2-2' },
      await three(),
    );
    const texts = await pageTextsOf(bytesOf(result));
    expect(texts[0]).not.toContain('S1');
    expect(texts[1]).toContain('S1');
    expect(texts[2]).not.toContain('S');
    const empty = pageNumbersDialog.run(
      { scope: 'all', anchor: 'bottom-center', fontSize: 12, marginMm: 24, startAt: 1 },
      await runContext(await three()),
    );
    await expect(empty).rejects.toMatchObject({ code: 'selection-empty' });
  });
});

describe('watermarkDialog', () => {
  beforeEach(useFontOrigin);
  afterEach(removeFontOrigin);

  it('draws the typed text over the pages, keeping the page text', async () => {
    const result = await runDialog(watermarkDialog, { text: '  CONFIDENTIAL  ' }, await three());
    expect(result.noticeKey).toBe('watermark.done');
    expect(result.noticeParams).toEqual({ count: 3 });
    const texts = await pageTextsOf(bytesOf(result));
    expect(texts[0]).toContain('CONFIDENTIAL');
    expect(texts[0]).toContain('body one');
  });

  it('tiles an image watermark that does not print', async () => {
    const file = new File([new Uint8Array(await pngBytes())], 'logo.png', { type: 'image/png' });
    const result = await runDialog(
      watermarkDialog,
      { type: 'image', image: [file], tile: true, tileSpacing: 20, noPrint: true, scale: 0.2 },
      await three(),
    );
    expect(result.noticeKey).toBe('watermark.done');
    const mupdf = await (await import('../pdf-fixtures')).mupdfForTests();
    const doc = mupdf.PDFDocument.openDocument(bytesOf(result).slice(), 'application/pdf').asPDF();
    expect(doc?.getTrailer().get('Root').get('OCProperties').isDictionary()).toBe(true);
    doc?.destroy();
  });

  it('refuses the image kind without a picked image', async () => {
    const run = runDialog(watermarkDialog, { type: 'image' }, await three());
    await expect(run).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'watermark: image kind without a picked image' },
    });
    const missing = watermarkDialog.run({ type: 'image' }, await runContext(await three()));
    await expect(missing).rejects.toMatchObject({ code: 'input-missing' });
  });

  it('refuses a watermark without text', async () => {
    const run = watermarkDialog.run(
      { opacity: 0.2, rotation: 0, scale: 1, tileSpacing: 50 },
      await runContext(await three()),
    );
    await expect(run).rejects.toMatchObject({ code: 'selection-empty' });
  });
});
