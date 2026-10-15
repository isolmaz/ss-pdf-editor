import { describe, expect, it } from 'vitest';
import { resultNeedsReview } from '../dialogs/review';
import { pageSizesOf, pageTextsOf, runDialog, textPdf } from '../pdf-fixtures';
import { removeBlankPagesDialog, splitTwoUpDialog } from './tidy';

const trimmed = async (bytes: Uint8Array | undefined) =>
  (await pageTextsOf(bytes ?? new Uint8Array())).map((text) => text.trim());

describe('removeBlankPagesDialog', () => {
  it('removes the blank pages, keeps the others in order, and names them in a loss to be read first', async () => {
    const result = await runDialog(
      removeBlankPagesDialog,
      {},
      await textPdf([['one'], [], ['three'], [], []]),
    );
    expect(await trimmed(result.files[0]?.bytes)).toEqual(['one', 'three']);
    expect(result.report.pageCount).toBe(2);
    expect(result.report.notes[0]).toEqual({
      kind: 'lost',
      key: 'tidy.blank.removed',
      params: { count: 3, pages: '2, 4-5' },
    });
    expect(result.noticeKey).toBe('tidy.blank.done');
    expect(result.noticeParams).toEqual({ count: 3 });
    expect(resultNeedsReview(result)).toBe(true);
  });

  it('says so and writes nothing when no page is blank', async () => {
    const result = await runDialog(removeBlankPagesDialog, {}, await textPdf([['one'], ['two']]));
    expect(result.files).toEqual([]);
    expect(result.noticeKey).toBe('tidy.blank.none');
    expect(result.report.notes).toEqual([{ kind: 'preserved', key: 'tidy.blank.none' }]);
  });

  it('refuses to empty the document when every page is blank', async () => {
    const result = await runDialog(removeBlankPagesDialog, {}, await textPdf([[], []]));
    expect(result.files).toEqual([]);
    expect(result.noticeKey).toBe('tidy.blank.all');
    expect(result.report.notes).toEqual([{ kind: 'warning', key: 'tidy.blank.all' }]);
  });
});

describe('splitTwoUpDialog', () => {
  it('cuts every landscape page into its left and right page, left first', async () => {
    const result = await runDialog(splitTwoUpDialog, {}, await textPdf([['left a'], ['left b']], [800, 400]));
    expect(await pageSizesOf(result.files[0]?.bytes ?? new Uint8Array())).toEqual([
      [400, 400],
      [400, 400],
      [400, 400],
      [400, 400],
    ]);
    // The text sits at x = 72, in the left half of its page.
    expect(await trimmed(result.files[0]?.bytes)).toEqual(['left a', '', 'left b', '']);
    expect(result.noticeKey).toBe('tidy.split.done');
    expect(result.noticeParams).toEqual({ count: 2, pages: '1-2' });
    expect(resultNeedsReview(result)).toBe(false);
  });

  it('cuts only the pages in the scope', async () => {
    const result = await runDialog(
      splitTwoUpDialog,
      { scope: 'range:2' },
      await textPdf([['one'], ['two']], [800, 400]),
    );
    expect(await pageSizesOf(result.files[0]?.bytes ?? new Uint8Array())).toEqual([
      [800, 400],
      [400, 400],
      [400, 400],
    ]);
    expect(result.noticeParams).toEqual({ count: 1, pages: '2' });
  });

  it('says so and writes nothing when no page in the scope is landscape', async () => {
    const result = await runDialog(splitTwoUpDialog, {}, await textPdf([['one']]));
    expect(result.files).toEqual([]);
    expect(result.noticeKey).toBe('tidy.split.none');
    expect(result.report.notes).toEqual([
      { kind: 'preserved', key: 'tidy.split.portrait', params: { count: 1 } },
    ]);
  });
});
