import type { Page } from 'playwright/test';
import { CANVAS, notice, openApp, palette, rotateCurrentPage } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';

/**
 * What the shell says when the browser vault it recovers from is damaged: a draft whose
 * stored document is gone, a manifest nobody can read, and a purge that must not guess.
 */

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** The vault as the page sees it: the manifest names and the blob keys actually stored. */
async function readVault(page: Page): Promise<{ drafts: string[]; sources: string[] }> {
  return await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('pdf-editor');
    const list = async (name: string): Promise<string[]> => {
      const names: string[] = [];
      try {
        const dir = await app.getDirectoryHandle(name);
        for await (const [entry] of (
          dir as unknown as { entries(): AsyncIterable<[string, unknown]> }
        ).entries()) {
          names.push(entry);
        }
      } catch {
        return [];
      }
      return names.sort();
    };
    return { drafts: await list('drafts'), sources: await list('sources') };
  });
}

/**
 * Wait until the autosave has put a manifest that records an edited document, and its source
 * blob, in the vault: a clean document with no history is not restored, so it is not a draft.
 */
async function stored(page: Page): Promise<{ drafts: string[]; sources: string[] }> {
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const app = await root.getDirectoryHandle('pdf-editor');
          const drafts = await app.getDirectoryHandle('drafts');
          const sources = await app.getDirectoryHandle('sources');
          let edited = false;
          for await (const [name, entry] of (
            drafts as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
          ).entries()) {
            if (name.endsWith('.json') && entry instanceof FileSystemFileHandle) {
              edited ||= (await (await entry.getFile()).text()).includes('"dirty":true');
            }
          }
          let blobs = 0;
          for await (const _ of (sources as unknown as { entries(): AsyncIterable<unknown> }).entries()) {
            blobs += 1;
          }
          return edited && blobs > 0;
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  return readVault(page);
}

/** Write or delete a file in one of the vault's directories. */
async function touchVault(
  page: Page,
  directory: 'drafts' | 'sources',
  name: string,
  content: string | null,
): Promise<void> {
  await page.evaluate(
    async ({ directory, name, content }) => {
      const root = await navigator.storage.getDirectory();
      const app = await root.getDirectoryHandle('pdf-editor');
      const dir = await app.getDirectoryHandle(directory, { create: true });
      if (content === null) {
        await dir.removeEntry(name);
        return;
      }
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(content);
      await writable.close();
    },
    { directory, name, content },
  );
}

test('a draft whose stored document is gone is reported as damaged and does not come back', async ({
  context,
  page,
}) => {
  await openApp(page, 'vanished.pdf', labelledPdf('Vanished', 1), { advanced: false });
  await rotateCurrentPage(page);
  const vault = await stored(page);
  // The first window is closed before its blobs are removed: an open window would store its
  // source again with the next autosave.
  const other = await context.newPage();
  await other.goto('/');
  await page.close();
  for (const key of vault.sources) await touchVault(other, 'sources', key, null);

  await other.goto('/editor/');
  await expect(
    notice(other, 'The document looks damaged. Try opening the file in another reader.'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(other.getByRole('button', { name: /^vanished\.pdf/ })).toHaveCount(0);
  await expect(other.getByRole('tab', { name: 'Start', exact: true })).toBeVisible();
});

test('an unreadable manifest is counted, the readable draft still returns, and a purge then deletes nothing', async ({
  page,
}) => {
  await openApp(page, 'kept.pdf', labelledPdf('Kept', 1));
  await rotateCurrentPage(page);
  const vault = await stored(page);
  await touchVault(page, 'drafts', 'broken.json', '{ this is not a manifest');

  await page.reload();
  await expect(notice(page, '1 draft file(s) corrupted and could not be read.')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Open kept.pdf', exact: true }).click();
  await expect(page.locator(CANVAS).first()).toBeVisible();

  // A reference graph with an unreadable member is incomplete: the purge refuses to guess.
  await palette(page, 'Delete Stored Copies of This Document');
  await expect(
    notice(page, 'The vault inventory could not be read completely, so nothing was deleted.'),
  ).toBeVisible({
    timeout: 30_000,
  });
  const after = await readVault(page);
  expect(after.sources).toEqual(vault.sources);
  expect(after.drafts).toEqual([...vault.drafts, 'broken.json'].sort());
});
