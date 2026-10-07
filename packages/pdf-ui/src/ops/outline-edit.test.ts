import { describe, expect, it } from 'vitest';
import { outlineOf, runContext, runDialog, textPdf } from '../pdf-fixtures';
import { outlineEditDialog } from './outline-edit';

const threePages = () => textPdf([['one'], ['two'], ['three']]);

async function withOutline(): Promise<Uint8Array> {
  const result = await runDialog(
    outlineEditDialog,
    { mode: 'replace-all', nodes: 'Intro | 1\nBody | 2\n\n  Loose title  ' },
    await threePages(),
  );
  return result.files[0]?.bytes ?? new Uint8Array();
}

const failureOf = (run: Promise<unknown>) =>
  run.then(
    () => {
      throw new Error('expected the dialog to fail');
    },
    (error: unknown) => error as { code: string; details: { engineMessage?: string } },
  );

describe('outlineEditDialog', () => {
  it('rewrites the whole outline from a list: one item per line, pages 1-based, no page means no destination', async () => {
    const result = await runDialog(
      outlineEditDialog,
      { mode: 'replace-all', nodes: 'Intro | 1\r\nBody | 2\n\n  Loose title  \nTiered | 3' },
      await threePages(),
    );
    expect(result.noticeKey).toBe('outline.done');
    expect(await outlineOf(result.files[0]?.bytes ?? new Uint8Array())).toEqual([
      { title: 'Intro', page: 0, children: [] },
      { title: 'Body', page: 1, children: [] },
      { title: 'Loose title', page: null, children: [] },
      { title: 'Tiered', page: 2, children: [] },
    ]);
  });

  it('takes the page after the last bar, so a title may contain bars', async () => {
    const result = await runDialog(
      outlineEditDialog,
      { mode: 'replace-all', nodes: 'A | B | 3' },
      await threePages(),
    );
    expect(await outlineOf(result.files[0]?.bytes ?? new Uint8Array())).toEqual([
      { title: 'A | B', page: 2, children: [] },
    ]);
  });

  it('refuses a list line without a title, naming the line', async () => {
    const error = await failureOf(
      runDialog(outlineEditDialog, { mode: 'replace-all', nodes: 'Fine | 1\n | 2' }, await threePages()),
    );
    expect(error.code).toBe('selection-empty');
    expect(error.details.engineMessage).toBe('outline line 2 has no title');
  });

  it('refuses a list line whose page is not a positive whole number', async () => {
    for (const page of ['0', 'x', '1.5', '']) {
      const error = await failureOf(
        runDialog(outlineEditDialog, { mode: 'replace-all', nodes: `Title | ${page}` }, await threePages()),
      );
      expect(error.code).toBe('value-out-of-range');
      expect(error.details.engineMessage).toBe(`outline line 1 has page "${page}" (expected 1-based)`);
    }
  });

  it('adds a top-level item by default, pointing at the chosen page', async () => {
    const result = await runDialog(
      outlineEditDialog,
      { mode: 'add-child', title: ' Appendix ', page: 3 },
      await withOutline(),
    );
    expect((await outlineOf(result.files[0]?.bytes ?? new Uint8Array())).map((entry) => entry.title)).toEqual(
      ['Intro', 'Body', 'Loose title', 'Appendix'],
    );
  });

  it('adds a child under the item the path names', async () => {
    const result = await runDialog(
      outlineEditDialog,
      { mode: 'add-child', path: '2', title: 'Sub', page: 3 },
      await withOutline(),
    );
    const tree = await outlineOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(tree[1]).toEqual({
      title: 'Body',
      page: 1,
      children: [{ title: 'Sub', page: 2, children: [] }],
    });
  });

  it('refuses a destination page that is not a page number', async () => {
    for (const page of [0, 100_001, 1.5]) {
      const error = await failureOf(
        runDialog(outlineEditDialog, { mode: 'add-child', title: 'X', page }, await withOutline()),
      );
      expect(error.code).toBe('value-out-of-range');
      expect(error.details.engineMessage).toBe(`destination page ${page} is not a 1-based page number`);
    }
  });

  it('renames the item the path names', async () => {
    const result = await runDialog(
      outlineEditDialog,
      { mode: 'rename', path: '1', title: 'Preface' },
      await withOutline(),
    );
    expect((await outlineOf(result.files[0]?.bytes ?? new Uint8Array()))[0]).toEqual({
      title: 'Preface',
      page: 0,
      children: [],
    });
  });

  it('removes the item the path names', async () => {
    const result = await runDialog(outlineEditDialog, { mode: 'remove', path: '2' }, await withOutline());
    expect((await outlineOf(result.files[0]?.bytes ?? new Uint8Array())).map((entry) => entry.title)).toEqual(
      ['Intro', 'Loose title'],
    );
  });

  it('refuses an empty path or title where one is required', async () => {
    const noPath = await failureOf(
      runDialog(outlineEditDialog, { mode: 'remove', path: '  ' }, await withOutline()),
    );
    expect(noPath.code).toBe('selection-empty');
    expect(noPath.details.engineMessage).toBe('request.path is empty');
    const noTitle = await failureOf(
      runDialog(outlineEditDialog, { mode: 'rename', path: '1', title: ' ' }, await withOutline()),
    );
    expect(noTitle.details.engineMessage).toBe('request.title is empty');
    const addNoTitle = await failureOf(
      runDialog(outlineEditDialog, { mode: 'add-child', title: '' }, await withOutline()),
    );
    expect(addNoTitle.details.engineMessage).toBe('request.title is empty');
  });

  it('refuses a path step that is not a typed 1-based integer', async () => {
    for (const path of ['0', '1e2', '0x2', '1.x', 'a', '99999999999999999999']) {
      const error = await failureOf(
        runDialog(outlineEditDialog, { mode: 'remove', path }, await withOutline()),
      );
      expect(error.code).toBe('value-out-of-range');
      expect(error.details.engineMessage).toContain('is not a 1-based index');
    }
  });

  it('refuses a mode the dialog did not offer', async () => {
    const error = await failureOf(runDialog(outlineEditDialog, { mode: 'explode' }, await withOutline()));
    expect(error.code).toBe('value-out-of-range');
    expect(error.details.engineMessage).toBe('unknown outline mode "explode"');
  });

  it('adds under the top level when the path, page and mode are missing from the params', async () => {
    const result = await outlineEditDialog.run({ title: 'Solo' }, await runContext(await threePages()));
    expect(await outlineOf(result.files[0]?.bytes ?? new Uint8Array())).toEqual([
      { title: 'Solo', page: 0, children: [] },
    ]);
  });

  it('treats params missing from the record as empty', async () => {
    const context = await runContext(await withOutline());
    const noPath = await failureOf(outlineEditDialog.run({ mode: 'rename', title: 'T' }, context));
    expect(noPath.details.engineMessage).toBe('request.path is empty');
    const noPathRemove = await failureOf(outlineEditDialog.run({ mode: 'remove' }, context));
    expect(noPathRemove.details.engineMessage).toBe('request.path is empty');
    const noTitle = await failureOf(outlineEditDialog.run({ mode: 'rename', path: '1' }, context));
    expect(noTitle.details.engineMessage).toBe('request.title is empty');
    const cleared = await outlineEditDialog.run({ mode: 'replace-all' }, context);
    expect(await outlineOf(cleared.files[0]?.bytes ?? new Uint8Array())).toEqual([]);
  });
});
