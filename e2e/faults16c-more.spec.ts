/**
 * Failures of the browser's and the engines' own services under flows that have no panel of
 * their own: reading mode's page text (pdf.js) and the XFA flatten's page pictures (the canvas
 * that cannot encode one). Each says so in words, changes nothing, and works on the next try.
 */

import { failNext, firedCount, injectEngineFaults } from './engine-faults';
import { expect, test } from './test';
import { labelledPdf, readProducedPageTexts } from './tool-fixture';
import { exportBytes, menuItem, openPdf } from './ui-helpers';
import { dynamicXfaPdf } from './ui-xfa-helpers';

test.use({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
test.describe.configure({ timeout: 180_000 });

const UNEXPECTED = 'Something unexpected went wrong.';

test('reading mode whose page text pdf.js cannot read says so in the pane; the next page reads', async ({
  page,
}) => {
  await injectEngineFaults(page);
  await openPdf(page, 'speech.pdf', labelledPdf('Alpha one. Beta two.', 2));
  await failNext(page, 'pdfjs', 'GetTextContent', 'text stream broke');
  await menuItem(page, 'View', /Reading mode/);
  await expect.poll(() => firedCount(page, 'pdfjs', 'GetTextContent')).toBe(1);
  const pane = page.locator('.pdf-reading-pane');
  await expect(pane.getByText(UNEXPECTED)).toBeVisible();
  await expect(pane.getByText('Alpha one')).toHaveCount(0);

  await page.keyboard.press('PageDown');
  await expect(pane.getByText('Alpha one. Beta two.')).toBeVisible({ timeout: 30_000 });
  await expect(pane.getByText(UNEXPECTED)).toHaveCount(0);
});

test('flatten XFA when the browser cannot encode a page picture says so and opens nothing; the next try flattens', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback, type, quality) {
      if (Reflect.get(window, '__noBlobs') === true) callback(null);
      else encode.call(this, callback, type, quality);
    };
  });
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  await page.evaluate(() => Reflect.set(window, '__noBlobs', true));
  await menuItem(page, 'Tools', 'Flatten XFA form to a normal PDF…');
  const form = page.getByRole('region', { name: 'Flatten XFA form to a normal PDF' });
  await expect(form).toBeVisible();
  await form.getByRole('radio').first().check();
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(form.getByRole('alert')).toBeVisible({ timeout: 60_000 });
  await expect(form.getByRole('alert')).toContainText('Not enough memory.');
  await expect(form.getByRole('heading', { name: 'Operation report' })).toHaveCount(0);
  await expect(page).not.toHaveTitle('xfa-flat.pdf');

  await page.evaluate(() => Reflect.set(window, '__noBlobs', false));
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(page).toHaveTitle('xfa-flat.pdf', { timeout: 60_000 });
  expect((await readProducedPageTexts(await exportBytes(page, 'flat.pdf'))).join(' ')).toContain('Customer');
});
