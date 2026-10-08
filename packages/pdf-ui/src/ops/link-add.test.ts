import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { linksOf, runContext, runDialog, textPdf } from '../pdf-fixtures';
import { linkAddDialog } from './link-add';

const link = { pageIndex: 0, rect: [100, 100, 200, 120] as const };
const pdf = () => textPdf([['one'], ['two'], ['three']]);

describe('linkAddDialog', () => {
  it('adds a web link over the dragged rectangle', async () => {
    const result = await runDialog(
      linkAddDialog,
      { kind: 'uri', uri: '  https://example.com/a  ' },
      await pdf(),
      {
        link,
      },
    );
    expect(result.noticeKey).toBe('link.done');
    expect(result.files[0]?.name).toBe('doc.pdf');
    expect(await linksOf(result.files[0]?.bytes ?? new Uint8Array())).toEqual([
      { rect: [100, 100, 200, 120], uri: 'https://example.com/a' },
    ]);
  });

  it('adds a link to another page, counted from 1', async () => {
    const result = await runDialog(linkAddDialog, { kind: 'page', page: 3 }, await pdf(), { link });
    const [added] = await linksOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(added?.uri).toBe('#page=3');
  });

  it('reads a missing kind as a web link and a missing page as page 1', async () => {
    const bytes = await pdf();
    const web = await linkAddDialog.run({ uri: 'https://example.org' }, await runContext(bytes, { link }));
    expect((await linksOf(web.files[0]?.bytes ?? bytes))[0]?.uri).toBe('https://example.org');
    const page = await linkAddDialog.run({ kind: 'page' }, await runContext(bytes, { link }));
    expect((await linksOf(page.files[0]?.bytes ?? bytes))[0]?.uri).toBe('#page=1');
  });

  it.each([0, 100_001, 1.5, Number.NaN])('refuses the page number %s', async (page) => {
    const run = runDialog(linkAddDialog, { kind: 'page', page }, await pdf(), { link });
    await expect(run).rejects.toBeInstanceOf(ToolError);
    await expect(run).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { engineMessage: `link destination page ${page} is not a 1-based page number` },
    });
  });

  it('refuses a target kind it does not know', async () => {
    const run = runDialog(linkAddDialog, { kind: 'ftp' }, await pdf(), { link });
    await expect(run).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { engineMessage: 'unknown link target "ftp"' },
    });
  });

  it('refuses an empty address', async () => {
    const run = runDialog(linkAddDialog, { kind: 'uri', uri: '   ' }, await pdf(), { link });
    await expect(run).rejects.toMatchObject({
      code: 'selection-empty',
      details: { engineMessage: 'request.uri is empty' },
    });
    const missing = linkAddDialog.run({}, await runContext(await pdf(), { link }));
    await expect(missing).rejects.toMatchObject({ code: 'selection-empty' });
  });

  it('refuses to invent a rectangle when the host handed none', async () => {
    const run = runDialog(linkAddDialog, { uri: 'https://example.com' }, await pdf());
    await expect(run).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: 'no rectangle was handed to the link dialog' },
    });
  });
});
