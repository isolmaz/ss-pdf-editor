import { menu, notice, openApp } from './app-helpers';
import { expect, test } from './test';
import { labelledPdf, readProducedPdf, toolFixturePdf } from './tool-fixture';
import { exportBytes } from './ui-helpers';
import { dynamicXfaPdf } from './ui-xfa-helpers';

/**
 * Commands that act on a selection, run from the menu bar: what each leaves selected and what
 * the file holds afterwards.
 */

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

test('Clear selection empties the page selection that Select all made', async ({ page }) => {
  await openApp(page, 'three.pdf', labelledPdf('Three', 3));
  const selected = page.locator('[role="option"][aria-selected="true"]');
  await menu(page, 'Edit', 'Select all');
  await expect(selected).toHaveCount(3);

  await menu(page, 'Edit', 'Clear selection');
  await expect(selected).toHaveCount(0);
});

test('Select all marks takes every mark of the page, and Delete then removes them from the exported file', async ({
  page,
}) => {
  await openApp(page, 'marks.pdf', toolFixturePdf());
  const before = await readProducedPdf(await exportBytes(page, 'before.pdf'));
  const marks = before.annotations.filter((item) => ['Highlight', 'Ink', 'FreeText'].includes(item.subtype));
  expect(marks.length).toBeGreaterThan(0);

  // The command is offered once the file's own marks are listed; it answers false before.
  await expect(async () => {
    await menu(page, 'Edit', 'Select all marks');
    await menu(page, 'Edit', /^Delete(?! page)/);
    await expect(notice(page, /mark\(s\) removed\./)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });

  const after = await readProducedPdf(await exportBytes(page, 'after.pdf'));
  // Every mark the file carried is gone — links included, they are the link tool's marks — and
  // the form field's widget, which is the field and not a mark, stays with its value.
  expect(after.annotations.map((item) => item.subtype)).toEqual(['Widget']);
  expect(after.formValue).toBe(before.formValue);
});

test('the XFA banner explains what is supported, and its buttons open the flatten and data forms', async ({
  page,
}) => {
  await openApp(page, 'xfa.pdf', dynamicXfaPdf());
  const banner = page.getByTestId('xfa-banner');
  const more = banner.getByRole('button', { name: 'What is supported?' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(banner).toContainText('supported');
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'false');

  await banner.getByRole('button', { name: 'Flatten to a normal PDF' }).click();
  await expect(page.getByRole('region', { name: 'Flatten XFA form to a normal PDF' })).toBeVisible();

  await banner.getByRole('button', { name: 'XFA data…' }).click();
  await expect(page.getByRole('region', { name: /XFA data/i })).toBeVisible();
});
