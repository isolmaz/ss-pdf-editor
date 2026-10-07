import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { encryptedToolFixturePdf, PAGE_ONE_LINES } from './tool-fixture';
import { CANVAS, pdfFile } from './ui-helpers';

/**
 * Opening a password-protected PDF: the shell asks for the open password in a dialog,
 * keeps it open on a wrong one, opens the document on the right one and opens nothing
 * when the reader cancels or presses Escape.
 */

const NAME = 'locked.pdf';
const PASSWORD = 'parola';

async function offerLockedFile(page: Page): Promise<Locator> {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles(pdfFile(NAME, await encryptedToolFixturePdf(PASSWORD)));
  const prompt = page.getByRole('dialog', { name: `Password required — ${NAME}` });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  return prompt;
}

async function submit(page: Page, password: string): Promise<void> {
  const prompt = page.getByRole('dialog', { name: `Password required — ${NAME}` });
  await prompt.getByLabel('Document open password').fill(password);
  await prompt.getByRole('button', { name: 'Open', exact: true }).click();
}

test('the dialog names the file and keeps the field focused and masked', async ({ page }) => {
  const prompt = await offerLockedFile(page);
  await expect(prompt.getByText('This document is password-protected.', { exact: false })).toBeVisible();
  const field = prompt.getByLabel('Document open password');
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await expect(prompt.getByRole('alert')).toHaveCount(0);
});

test('a wrong password says so, keeps the dialog, and the right one opens the document', async ({ page }) => {
  const prompt = await offerLockedFile(page);
  await submit(page, 'yanlis');
  const again = page.getByRole('dialog', { name: `Password required — ${NAME}` });
  await expect(again.getByRole('alert')).toHaveText('Wrong password.');
  await expect(again.getByLabel('Document open password')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(prompt).toBeVisible();

  await submit(page, PASSWORD);
  await expect(page.getByRole('dialog', { name: /Password required/ })).toHaveCount(0);
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('/ 2', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: NAME, exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.querySelector('.pdfViewer[data-active-viewer] .textLayer')?.textContent ?? '',
      ),
    )
    .toContain(PAGE_ONE_LINES[0].text);
});

test('pressing Enter in the field submits the password', async ({ page }) => {
  const prompt = await offerLockedFile(page);
  await prompt.getByLabel('Document open password').fill(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('dialog', { name: /Password required/ })).toHaveCount(0);
});

test('Cancel closes the dialog and opens nothing', async ({ page }) => {
  const prompt = await offerLockedFile(page);
  await prompt.getByLabel('Document open password').fill(PASSWORD);
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: /Password required/ })).toHaveCount(0);
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(page.getByRole('button', { name: NAME, exact: true })).toHaveCount(0);
});

test('Escape closes the dialog and opens nothing', async ({ page }) => {
  await offerLockedFile(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /Password required/ })).toHaveCount(0);
  await expect(page.locator(CANVAS)).toHaveCount(0);
  await expect(page.getByRole('button', { name: NAME, exact: true })).toHaveCount(0);
});
