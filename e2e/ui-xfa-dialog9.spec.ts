/**
 * The XFA fill dialog's edges and the flatten command's picture of a richer form: a form the
 * renderer will not lay out is refused with the reason, the Escape key follows the unsaved-values
 * question, a save with nothing new says so, and every control kind — a ticked box, a choice, a
 * several-line field, a serif and a monospace face, a form that runs onto a second page — comes
 * out of the flatten as words the produced PDF can be searched for.
 */

import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedPageTexts, toolFixturePdf } from './tool-fixture';
import { exportBytes, menuItem, openPdf } from './ui-helpers';
import { xfaWithoutNeedsRendering } from './ui-small-helpers';
import { dynamicXfaPdf } from './ui-xfa-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 180_000 });

const field = (name: string, ui: string, caption: string, font = 'Helvetica', height = '0.35in') =>
  `<field name="${name}" w="3in" h="${height}"><ui>${ui}</ui><font typeface="${font}" size="12pt"/><caption placement="left" reserve="1in"><value><text>${caption}</text></value></caption></field>`;

/** Five kinds of control over a content area so short that the form runs onto a second page. */
const RICH_TEMPLATE = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
<subform name="form1" layout="tb" locale="en_US" restoreState="auto">
<pageSet><pageArea id="Page1" name="Page1"><contentArea x="0.25in" y="0.25in" w="7.5in" h="1.6in"/><medium stock="default" short="8.5in" long="11in"/></pageArea></pageSet>
<subform layout="tb" w="7.5in">
<draw name="Heading" w="5in" h="0.4in"><ui><textEdit/></ui><value><text>Order form</text></value><font typeface="Times New Roman" size="16pt" weight="bold"/></draw>
${field('Serif', '<textEdit><border><edge/></border></textEdit>', 'Serif', 'Times New Roman')}
${field('Mono', '<textEdit><border><edge/></border></textEdit>', 'Mono', 'Courier New')}
${field('Notes', '<textEdit multiLine="1"><border><edge/></border></textEdit>', 'Notes', 'Helvetica', '0.9in')}
${field('Color', '<choiceList open="onEntry"><border><edge/></border></choiceList>', 'Colour').replace('</ui>', '</ui><items><text>Red</text><text>Green</text></items>')}
${field('Agree', '<checkButton/>', 'Agree').replace('</ui>', '</ui><items><text>yes</text><text>no</text></items>')}
</subform>
</subform>
</template>`;

const RICH_DATA =
  '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Serif>Quill</Serif><Mono>Typewriter</Mono><Notes>Deliver at dawn&#10;Ring twice</Notes><Color>Green</Color><Agree>yes</Agree></form1></xfa:data></xfa:datasets>';

async function openFill(page: Page) {
  await menuItem(page, 'Tools', 'Fill XFA form…');
  const dialog = page.getByRole('dialog', { name: /Fill/ }).first();
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a document without XFA is refused before any dialog opens', async ({ page }) => {
  await openPdf(page, 'plain.pdf', toolFixturePdf());
  await menuItem(page, 'Tools', 'Fill XFA form…');
  await expect(
    page
      .getByText('This document has no XFA form. This operation only works on PDF forms that contain XFA.')
      .first(),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: /Fill/ })).toHaveCount(0);
});

test('a form the renderer will not lay out is refused with the reason, and closing it asks nothing', async ({
  page,
}) => {
  await openPdf(page, 'unrendered.pdf', xfaWithoutNeedsRendering());
  const dialog = await openFill(page);
  await expect(dialog.getByRole('alert')).toContainText(
    'This is a static XFA form: its pages are already in the PDF.',
    { timeout: 60_000 },
  );
  await expect(dialog.getByRole('button', { name: 'Export data (XML)' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Save to document', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('Escape follows the unsaved-values question; exporting reports how many values; saving what is unchanged says so', async ({
  page,
}) => {
  await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
  const dialog = await openFill(page);
  const inputs = dialog.getByTestId('xfa-viewer').locator('input');
  await expect(inputs).toHaveCount(2, { timeout: 60_000 });
  const save = dialog.getByRole('button', { name: 'Save to document', exact: true });

  // Typing and then restoring the original text: the form counts as touched, the data is as it was.
  await inputs.first().fill('Changed');
  await inputs.first().blur();
  await inputs.first().fill('Ada Lovelace');
  await inputs.first().blur();
  await expect(save).toBeEnabled();

  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export data (XML)' }).click();
  await download;
  await expect(dialog.getByText('2 data value(s) exported.')).toBeVisible();

  await save.click();
  await expect(dialog.getByText('The form has no change to save.')).toBeVisible();
  await expect(dialog).toBeVisible();

  // Escape asks once, with the same words as the Close button; a second Escape leaves.
  await page.keyboard.press('Escape');
  await expect(dialog.getByText(/What you typed is not saved into the document yet\./)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close without saving' })).toBeVisible();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('flatten draws every kind of control, both faces and the second page as words of the produced PDF', async ({
  page,
}) => {
  await openPdf(page, 'rich.pdf', dynamicXfaPdf(RICH_TEMPLATE, RICH_DATA));
  await menuItem(page, 'Tools', 'Flatten XFA form to a normal PDF…');
  const form = page.getByRole('region', { name: 'Flatten XFA form to a normal PDF' });
  await form.getByRole('radio').first().check();
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 90_000 });
  await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
  await expect(page).toHaveTitle('rich-flat.pdf', { timeout: 60_000 });
  const texts = await readProducedPageTexts(await exportBytes(page, 'rich-flat.pdf'));
  expect(texts.length).toBeGreaterThanOrEqual(2);
  const all = texts.join(' ');
  for (const word of ['Order', 'Quill', 'Typewriter', 'Deliver', 'dawn', 'Ring', 'twice', 'Green']) {
    expect(all).toContain(word);
  }
});

// The page's own service worker would answer the font request itself; blocking it lets the test refuse the file.
test.describe('without the service worker', () => {
  test.use({ serviceWorkers: 'block', allowedErrors: [/status of 404.*LiberationSans-Regular\.ttf/] });

  test('a missing engine font stops the flatten with a reason, and the next try fetches it again', async ({
    page,
  }) => {
    await page.route('**/LiberationSans-Regular.ttf', (route) =>
      route.fulfill({ status: 404, body: 'gone' }),
    );
    await openPdf(page, 'xfa.pdf', dynamicXfaPdf());
    await menuItem(page, 'Tools', 'Flatten XFA form to a normal PDF…');
    const form = page.getByRole('region', { name: 'Flatten XFA form to a normal PDF' });
    await form.getByRole('radio').first().check();
    await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('A required engine package is not downloaded.', {
      timeout: 90_000,
    });
    await expect(form.getByRole('heading', { name: 'Operation report' })).toHaveCount(0);

    await page.unroute('**/LiberationSans-Regular.ttf');
    await form.getByRole('button', { name: 'Open in new tab', exact: true }).click();
    await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 90_000 });
    await expect(form).toContainText('1 XFA page(s) became normal PDF pages.');
  });
});
