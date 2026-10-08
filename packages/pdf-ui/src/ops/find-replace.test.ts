import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pageTextsOf,
  removeFontOrigin,
  runContext,
  runDialog,
  textPdf,
  useFontOrigin,
} from '../pdf-fixtures';
import { findReplaceDialog } from './find-replace';

describe('findReplaceDialog', () => {
  beforeEach(useFontOrigin);
  afterEach(removeFontOrigin);

  it('replaces the match in the file and reports how many it changed', async () => {
    const bytes = await textPdf([['Total due: 120 EUR'], ['Nothing here']]);
    const result = await runDialog(findReplaceDialog, { find: 'EUR', replace: 'USD' }, bytes);
    expect(result.noticeKey).toBe('findReplace.done');
    expect(result.noticeParams).toEqual({ count: 1 });
    const texts = await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(texts[0]).toContain('Total due: 120 USD');
    expect(texts[0]).not.toContain('EUR');
    expect(texts[1]).toContain('Nothing here');
  });

  it('leaves pages outside the scope alone', async () => {
    const bytes = await textPdf([['Alpha beta'], ['Alpha beta']]);
    const result = await runDialog(
      findReplaceDialog,
      { find: 'Alpha', replace: 'Omega', scope: 'range:2' },
      bytes,
    );
    expect(result.noticeParams).toEqual({ count: 1 });
    const texts = await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(texts[0]).toContain('Alpha beta');
    expect(texts[1]).toContain('Omega beta');
  });

  it('honours match case and whole word', async () => {
    const bytes = await textPdf([['Cat cat concat']]);
    const caseSensitive = await runDialog(
      findReplaceDialog,
      { find: 'cat', replace: 'dog', matchCase: true, wholeWord: true },
      bytes,
    );
    expect(caseSensitive.noticeParams).toEqual({ count: 1 });
    expect((await pageTextsOf(caseSensitive.files[0]?.bytes ?? new Uint8Array()))[0]).toContain(
      'Cat dog concat',
    );
  });

  it('treats a missing replacement as deleting the match', async () => {
    const bytes = await textPdf([['keep drop keep']]);
    const context = await runContext(bytes);
    const result = await findReplaceDialog.run({ find: 'drop', scope: 'all' }, context);
    expect(result.noticeParams).toEqual({ count: 1 });
    expect((await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array()))[0]).not.toContain('drop');
  });

  it('refuses a missing search text like an empty one', async () => {
    const context = await runContext(await textPdf([['x']]));
    await expect(findReplaceDialog.run({ scope: 'all' }, context)).rejects.toBeInstanceOf(ToolError);
  });

  it('refuses an empty search text', async () => {
    const run = runDialog(findReplaceDialog, { find: '', replace: 'x' }, await textPdf([['x']]));
    await expect(run).rejects.toBeInstanceOf(ToolError);
  });
});
