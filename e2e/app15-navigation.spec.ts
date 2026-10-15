import { openApp } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';

/** The page field and the open-documents list: what they do with an answer they cannot use. */

test.use({ viewport: { width: 1440, height: 900 } });

test('the page field takes a page that exists, and drops one that does not or is not a number', async ({
  page,
}) => {
  await openApp(page, 'three.pdf', labelledPdf('Three', 3), { advanced: false });
  const field = page.getByRole('textbox', { name: 'Page number' });
  await expect(field).toHaveValue('1');

  for (const refused of ['99', '0', 'abc']) {
    await field.fill(refused);
    await field.press('Enter');
    // The field says so and keeps what was typed; the view stays on page 1, which the field
    // shows again once the focus leaves it.
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').filter({ hasText: 'Enter 1–3' })).toBeVisible();
    await expect(field).toHaveValue(refused);
    await field.blur();
    await expect(field).toHaveValue('1');
  }

  await field.fill('3');
  await field.press('Enter');
  await expect(field).toHaveValue('3');
  await expect(page.locator('.pdfViewer[data-active-viewer] .textLayer').nth(2)).toContainText('Three 3');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const container = document.querySelector('.pdfViewer[data-active-viewer]')?.parentElement;
        const pages = [...document.querySelectorAll('.pdfViewer[data-active-viewer] .page')];
        const top = container?.getBoundingClientRect().top ?? 0;
        const third = pages[2]?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
        return Math.abs(third - top) < 200;
      }),
    )
    .toBe(true);
});

test('Escape closes the list of open documents without choosing one', async ({ page }) => {
  await openApp(page, 'first.pdf', labelledPdf('First', 1), { advanced: false });
  await openApp(page, 'second.pdf', labelledPdf('Second', 2), { advanced: false, navigate: false });
  await page
    .getByRole('button', { name: /^second\.pdf/ })
    .first()
    .click();
  const close = page.getByRole('button', { name: 'Close tab' });
  // The list shows one close control per document.
  await expect(close).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^first\.pdf/ }).first()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(close).toHaveCount(0);
  // Nothing was closed or switched: the second document is still the one on screen.
  await expect(page.getByText('/ 2', { exact: true })).toBeVisible();
});
