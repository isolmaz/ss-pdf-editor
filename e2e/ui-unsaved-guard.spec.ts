import type { Page } from 'playwright/test';
import { notice, openApp, palette, pdfFile, rotateCurrentPage, settled } from './app-helpers';
import { expect, test } from './test';
import { encryptedToolFixturePdf } from './tool-fixture';

/**
 * What a document's session decides about the vault and about the window: a file that only an
 * owner password restricts opens without a password, so it is stored like any other; a document
 * opened with its password is a sensitive session that stores nothing; and a window holding
 * unsaved changes no draft protects asks before the browser closes it, while one whose changes a
 * draft holds does not.
 */

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** The manifests and blobs the vault holds, as the page sees them; empty before anything is written. */
async function vault(page: Page): Promise<{ drafts: string[]; sources: string[] }> {
  return await page.evaluate(async () => {
    const names = async (app: FileSystemDirectoryHandle, directory: string): Promise<string[]> => {
      try {
        // `entries()` is missing from the DOM typings this project compiles against.
        const listing = (await app.getDirectoryHandle(directory)) as unknown as {
          entries(): AsyncIterable<[string, FileSystemHandle]>;
        };
        const found: string[] = [];
        for await (const [name, entry] of listing.entries()) {
          if (entry instanceof FileSystemFileHandle && name.endsWith('.json')) {
            found.push(await (await entry.getFile()).text());
          } else found.push(name);
        }
        return found;
      } catch {
        return [];
      }
    };
    try {
      const app = await (await navigator.storage.getDirectory()).getDirectoryHandle('pdf-editor');
      return { drafts: await names(app, 'drafts'), sources: await names(app, 'sources') };
    } catch {
      return { drafts: [], sources: [] };
    }
  });
}

test('a file that only an owner password restricts is stored like any other document, edits included', async ({
  page,
}) => {
  // Encrypted, with an empty open password: it opens without asking for one.
  await openApp(page, 'owned.pdf', await encryptedToolFixturePdf('own3r', ''));
  await expect(page.getByRole('button', { name: 'owned.pdf', exact: true })).toBeVisible();

  // Its source is stored when it opens, and an edit reaches a manifest that names it.
  await expect.poll(async () => (await vault(page)).sources.length).toBeGreaterThan(0);
  await rotateCurrentPage(page);
  await expect
    .poll(async () =>
      (await vault(page)).drafts.some(
        (manifest) => manifest.includes('"name":"owned.pdf"') && manifest.includes('"dirty":true'),
      ),
    )
    .toBe(true);
});

test('a document opened with its password is a sensitive session: nothing of it reaches the vault', async ({
  page,
}) => {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles(pdfFile('locked.pdf', await encryptedToolFixturePdf('parola')));
  const prompt = page.getByRole('dialog', { name: 'Password required — locked.pdf' });
  await prompt.getByLabel('Document open password').fill('parola');
  await prompt.getByRole('button', { name: 'Open', exact: true }).click();
  await settled(page);

  // Settings shows the session as sensitive, and the vault holds nothing of it.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: /Settings/ }).getByRole('switch', { name: 'Sensitive session' }),
  ).toBeChecked();
  expect(await vault(page)).toEqual({ drafts: [], sources: [] });
});

test('a window with unsaved changes no draft protects asks before the browser closes it, and stays when the question is declined', async ({
  page,
}) => {
  await openApp(page, 'secret.pdf');
  await palette(page, 'Sensitive Session');
  await expect(notice(page, 'Sensitive session: persistent draft disabled.')).toBeVisible();
  await rotateCurrentPage(page);

  const asked = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const question = await asked;
  expect(question.type()).toBe('beforeunload');
  await question.dismiss();

  // Declined: the window is still there, with the document it held (its tab says it is unsaved).
  expect(page.isClosed()).toBe(false);
  await expect(page.getByRole('button', { name: 'secret.pdf Unsaved changes', exact: true })).toBeVisible();
});

test('a window whose changes a draft holds closes without a question', async ({ page }) => {
  await openApp(page, 'drafted.pdf');
  await rotateCurrentPage(page);
  await expect
    .poll(async () => (await vault(page)).drafts.some((manifest) => manifest.includes('"dirty":true')))
    .toBe(true);
  // What the browser's own event would meet, without closing anything: asked until the autosave
  // has written the draft of this very state, and not after.
  await expect
    .poll(() => page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))))
    .toBe(true);

  const questions: string[] = [];
  page.on('dialog', (dialog) => {
    questions.push(dialog.type());
    void dialog.dismiss();
  });
  const closed = page.waitForEvent('close');
  await page.close({ runBeforeUnload: true });
  await closed;
  expect(questions).toEqual([]);
});
