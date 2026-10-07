import { readPageLabels } from 'pdf-core';
import { describe, expect, it } from 'vitest';
import { runContext, runDialog, textPdf } from '../pdf-fixtures';
import { pageLabelsDialog } from './pagelabels';

const five = () => textPdf([['a'], ['b'], ['c'], ['d'], ['e']]);
const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();

describe('pageLabelsDialog', () => {
  it('numbers the pages from the start page on and reads the labels back', async () => {
    const result = await runDialog(
      pageLabelsDialog,
      { range: '2', style: 'roman-lower', prefix: 'p-', start: 3 },
      await five(),
    );
    expect(result.noticeKey).toBe('labels.dialog.done');
    expect(result.noticeParams).toEqual({ count: 4 });
    expect(await readPageLabels(bytesOf(result), 5)).toEqual(['1', 'p-iii', 'p-iv', 'p-v', 'p-vi']);
    const notes = result.report.notes;
    expect(notes).toContainEqual({
      kind: 'changed',
      key: 'labels.note.count',
      params: { count: 4, from: 2 },
    });
    expect(notes).toContainEqual({
      kind: 'preserved',
      key: 'labels.note.verified',
      params: { first: 'p-iii', last: 'p-vi' },
    });
    expect(notes.some((entry) => entry.key === 'labels.note.mismatch')).toBe(false);
  });

  it('writes letters and unlabelled pages in the other styles', async () => {
    const alpha = await runDialog(
      pageLabelsDialog,
      { range: '1', style: 'alpha-upper', start: 27 },
      await five(),
    );
    expect((await readPageLabels(bytesOf(alpha), 5)).slice(0, 2)).toEqual(['AA', 'BB']);
    const none = await runDialog(pageLabelsDialog, { range: '1', style: 'none', prefix: 'X' }, await five());
    expect(await readPageLabels(bytesOf(none), 5)).toEqual(['X', 'X', 'X', 'X', 'X']);
  });

  it('reads a missing prefix as none', async () => {
    const result = await pageLabelsDialog.run(
      { range: '1', style: 'decimal', start: 1 },
      await runContext(await five()),
    );
    expect(await readPageLabels(bytesOf(result), 5)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('warns when the label read back is not the one planned', async () => {
    // A NUL cannot be stored in a label: the file holds "a1", the dialog planned "a\0b1".
    const result = await runDialog(
      pageLabelsDialog,
      { range: '1', style: 'decimal', prefix: 'a\u0000b' },
      await five(),
    );
    expect(result.report.notes.at(-1)).toEqual({
      kind: 'warning',
      key: 'labels.note.mismatch',
      params: { expected: 'a\u0000b1', actual: 'a1' },
    });
  });

  it('refuses a start page outside the document', async () => {
    const run = runDialog(pageLabelsDialog, { range: '9', style: 'decimal' }, await five());
    await expect(run).rejects.toMatchObject({ code: 'range-invalid' });
  });
});
