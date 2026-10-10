import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageCountOf, pageTextsOf, runContext, runDialog, textPdf } from '../pdf-fixtures';
import { skia, skiaDocument } from '../skia-canvas.fixtures';
import { compressDialog } from './optimize';

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();

describe('compressDialog structure mode', () => {
  it('says how much the file shrank, in the notice and in the report', async () => {
    const input = await textPdf([['Hello'], ['again']]);
    const result = await runDialog(compressDialog, {}, input, { name: 'plan.pdf' });
    expect(result.files[0]?.name).toBe('plan.pdf');
    expect(result.files[0]?.mime).toBe('application/pdf');
    expect(result.report.inputBytes).toBe(input.length);
    expect(result.report.outputBytes).toBe(bytesOf(result).length);
    expect(result.noticeKey).toBe('optimize.saved');
    expect(result.noticeParams).toEqual({
      before: '992 B',
      after: '892 B',
      percent: 10,
    });
    expect(await pageTextsOf(bytesOf(result))).toEqual([
      expect.stringContaining('Hello'),
      expect.stringContaining('again'),
    ]);
  });

  it('says there was no gain when a file that was already optimised comes back the same size', async () => {
    const once = await runDialog(compressDialog, {}, await textPdf([['Hello']]));
    const twice = await runDialog(compressDialog, {}, bytesOf(once));
    expect(twice.noticeKey).toBe('optimize.noGain');
    expect(twice.noticeParams).toEqual({
      before: twice.noticeParams?.after,
      after: twice.noticeParams?.after,
      percent: 0,
    });
    expect(bytesOf(twice).length).toBe(bytesOf(once).length);
  });
});

describe('compressDialog on an empty file', () => {
  it('refuses it instead of reporting a size change against nothing', async () => {
    const run = compressDialog.run({}, await runContext(new Uint8Array(), { pageCount: 0 }));
    await expect(run).rejects.toThrow('no objects found');
  });
});

describe('compressDialog raster mode', () => {
  beforeEach(() => {
    // pdf.js draws on the Skia canvas, and the operation reads JPEG bytes back from it.
    vi.stubGlobal('document', skiaDocument);
    vi.stubGlobal('Path2D', skia.Path2D);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warns that the file grew when the pictures of its pages outweigh the text they replace', async () => {
    const input = await textPdf([['Hello'], ['again']]);
    const result = await runDialog(
      compressDialog,
      { mode: 'raster', dpi: 200, quality: 0.9, greyscale: true, scope: 'all' },
      input,
    );
    expect(result.noticeKey).toBe('optimize.grew');
    expect(result.report.inputBytes).toBe(input.length);
    expect(result.report.outputBytes).toBeGreaterThan(input.length);
    const percent = Math.round((1 - result.report.outputBytes / input.length) * 100);
    expect(percent).toBeLessThan(0);
    expect(result.noticeParams).toMatchObject({ percent });
    // The pages are pictures now: they keep their count but lose their text layer.
    expect(await pageCountOf(bytesOf(result))).toBe(2);
    expect(await pageTextsOf(bytesOf(result))).toEqual(['', '']);
  });
});
