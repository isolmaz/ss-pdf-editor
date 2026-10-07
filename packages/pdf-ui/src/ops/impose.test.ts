import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { pageCountOf, runDialog, textPdf } from '../pdf-fixtures';
import { imposeDialog } from './impose';

const fourPages = () => textPdf([['one'], ['two'], ['three'], ['four']]);

describe('imposeDialog', () => {
  it('lays four pages 2-up on two sheets', async () => {
    const result = await runDialog(imposeDialog, { mode: 'nup', perSheet: '2' }, await fourPages());
    expect(result.noticeKey).toBe('impose.done');
    expect(result.noticeParams).toEqual({ sheets: 2 });
    expect(await pageCountOf(result.files[0]?.bytes ?? new Uint8Array())).toBe(2);
    expect(result.files[0]?.name).toBe('doc.pdf');
  });

  it('keeps the chosen pages only when the scope names a range', async () => {
    const result = await runDialog(
      imposeDialog,
      { mode: 'nup', perSheet: '4', scope: 'range:1-3' },
      await fourPages(),
    );
    expect(result.noticeParams).toEqual({ sheets: 1 });
    expect(await pageCountOf(result.files[0]?.bytes ?? new Uint8Array())).toBe(1);
  });

  it('folds three pages into one booklet sheet, two sides', async () => {
    const result = await runDialog(
      imposeDialog,
      { mode: 'booklet', gutterMm: 4, marginMm: 6 },
      await textPdf([['one'], ['two'], ['three']]),
    );
    expect(result.noticeParams).toEqual({ sheets: 1 });
    expect(await pageCountOf(result.files[0]?.bytes ?? new Uint8Array())).toBe(2);
    expect(result.report.notes.some((entry) => entry.key === 'op.note.impose.padded')).toBe(true);
  });

  it('tiles one page into a poster of columns × rows sheets', async () => {
    const result = await runDialog(
      imposeDialog,
      { mode: 'poster', columns: 3, rows: 2, overlapMm: 8, cropMarks: true },
      await textPdf([['poster']]),
    );
    expect(result.noticeParams).toEqual({ sheets: 6 });
    expect(await pageCountOf(result.files[0]?.bytes ?? new Uint8Array())).toBe(6);
  });

  it('refuses a plan beyond the sheet ceiling before reading any page', async () => {
    const run = runDialog(imposeDialog, { mode: 'poster', columns: 10, rows: 10 }, new Uint8Array(), {
      pageCount: 11,
    });
    await expect(run).rejects.toBeInstanceOf(ToolError);
    await expect(run).rejects.toMatchObject({
      code: 'range-invalid',
      details: { engineMessage: 'imposition plan produces 1100 sheets, over the 1000 ceiling' },
    });
  });
});
