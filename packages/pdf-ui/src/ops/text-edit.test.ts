import { ToolError } from 'pdf-shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pageTextsOf,
  removeFontOrigin,
  runContext,
  runDialog,
  textEditSelection,
  textPdf,
  useFontOrigin,
} from '../pdf-fixtures';
import { textEditDialog } from './text-edit';

describe('textEditDialog', () => {
  beforeEach(useFontOrigin);
  afterEach(removeFontOrigin);

  const pdf = () => textPdf([['Old paragraph here', 'second line stays'], ['other page']]);

  it('opens on the pointed block: its text, alignment, size, leading and colour', async () => {
    const bytes = await pdf();
    const textEdit = await textEditSelection(bytes);
    const initial = textEditDialog.initialValues?.(await runContext(bytes, { textEdit }));
    expect(initial).toEqual({
      text: textEdit.block.text,
      align: textEdit.block.align,
      fontSize: textEdit.block.style.fontSize,
      leading: textEdit.block.style.leading,
      color: textEdit.block.style.color,
    });
    expect(initial?.text).toContain('Old paragraph here');
    expect(initial?.fontSize).toBe(12);
  });

  it('opens on the plain defaults when no block was pointed at', async () => {
    const context = await runContext(await pdf());
    expect(textEditDialog.initialValues?.(context)).toEqual({});
  });

  it('replaces the block text with the typed text, in the pointed block only', async () => {
    const bytes = await pdf();
    const textEdit = await textEditSelection(bytes);
    const result = await runDialog(
      textEditDialog,
      { text: '  Brand new words  ', align: 'left', fontSize: 12, leading: 14, font: 'auto' },
      bytes,
      { textEdit },
    );
    expect(result.noticeKey).toBe('textedit.done');
    expect(result.noticeParams).toEqual({ count: 1 });
    expect(result.files[0]?.name).toBe('doc.pdf');
    const [first, second] = await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(first).toContain('Brand new words');
    expect(first).not.toContain('Old paragraph here');
    expect(second).toContain('other page');
  });

  it('draws with the named face and the chosen colour, a justified two-line paragraph', async () => {
    const bytes = await pdf();
    const textEdit = await textEditSelection(bytes);
    const result = await runDialog(
      textEditDialog,
      {
        text: 'Alpha beta gamma delta epsilon zeta',
        align: 'justify',
        fontSize: 14,
        leading: 16,
        font: 'noto-sans-semibold',
        color: '#ff0000',
        hyphenate: true,
      },
      bytes,
      { textEdit },
    );
    const [first] = await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(first).toContain('Alpha');
    expect(first).toContain('zeta');
    expect(result.noticeParams?.count).toBeGreaterThan(1);
  });

  it('falls back to the best match when the named face is not in the catalogue', async () => {
    const bytes = await pdf();
    const textEdit = await textEditSelection(bytes);
    const result = await runDialog(textEditDialog, { text: 'Fallback text', font: 'no-such-face' }, bytes, {
      textEdit,
    });
    const [first] = await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(first).toContain('Fallback text');
  });

  it('counts no lines when the replacement text is empty', async () => {
    const bytes = await pdf();
    const textEdit = await textEditSelection(bytes);
    const result = await runDialog(textEditDialog, { text: '   ' }, bytes, { textEdit });
    expect(result.noticeParams).toEqual({ count: 0 });
    const [first] = await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(first).not.toContain('Old paragraph here');
  });

  it("keeps the block's own values for every setting the dialog leaves out", async () => {
    const bytes = await textPdf([['Top block here'], [], []]);
    const textEdit = await textEditSelection(bytes);
    const result = await textEditDialog.run({ text: 'Kept style' }, await runContext(bytes, { textEdit }));
    const [first] = await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(first).toContain('Kept style');
  });

  it('treats a missing text as an empty replacement that removes the block', async () => {
    const bytes = await textPdf([['Top block here']]);
    const textEdit = await textEditSelection(bytes);
    const result = await textEditDialog.run({}, await runContext(bytes, { textEdit }));
    expect(result.noticeParams).toEqual({ count: 0 });
    const [first] = await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(first).not.toContain('Top block here');
  });

  it('draws other blocks of the page untouched when the colour is cleared', async () => {
    const bytes = await textPdf([['Edited block', '', '', '', 'Far block below']]);
    const textEdit = await textEditSelection(bytes);
    const result = await runDialog(textEditDialog, { text: 'Changed', color: '' }, bytes, { textEdit });
    const [first] = await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(first).toContain('Changed');
    expect(first).toContain('Far block below');
  });

  it('refuses to run without a pointed block', async () => {
    const run = runDialog(textEditDialog, { text: 'x' }, await pdf());
    await expect(run).rejects.toBeInstanceOf(ToolError);
    await expect(run).rejects.toMatchObject({ code: 'selection-empty' });
  });

  it('reports a missing metric table for the chosen face', async () => {
    const bytes = await pdf();
    const textEdit = await textEditSelection(bytes);
    const run = runDialog(textEditDialog, { text: 'x', font: 'noto-sans' }, bytes, {
      textEdit: { ...textEdit, fonts: { catalog: textEdit.fonts.catalog, metrics: {} } },
    });
    await expect(run).rejects.toMatchObject({
      code: 'font-missing',
      details: { engineMessage: expect.stringContaining('no metric table for face') },
    });
  });
});
