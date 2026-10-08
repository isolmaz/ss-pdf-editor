/**
 * The layers tab on a document whose order has a labelled sub-list: the label is the
 * heading of its level, and a layer switched off under it is written into the file as hidden.
 */

import { expect, test } from './test';
import { readProducedEntry } from './tool-fixture';
import { exportBytes, openDockTab, openPdf } from './ui-helpers';
import { assemble } from './ui-panels15-helpers';

const group = (name: string) => `<< /Type /OCG /Name (${name}) >>`;

/** The order is a labelled sub-list holding Alpha and Beta, then Gamma on the top level. */
const PDF = assemble([
  '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R 7 0 R] ' +
    '/D << /Order [[(Section) 5 0 R 6 0 R] 7 0 R] /ON [5 0 R 6 0 R 7 0 R] >> >> >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 4 0 R >>',
  '<< /Length 0 >>\nstream\n\nendstream',
  group('Alpha'),
  group('Beta'),
  group('Gamma'),
]);

test('a labelled sub-list of the order is a level under its heading; a layer off in it is written as hidden', async ({
  page,
}) => {
  await openPdf(page, 'labelled.pdf', PDF);
  await openDockTab(page, 'Layers');
  const layers = page.getByRole('group', { name: 'Layers' });
  await expect(layers.getByRole('checkbox')).toHaveCount(3);
  const heading = layers.getByText('Section', { exact: true });
  await expect(heading).toHaveCount(1);
  // The heading's own level holds Alpha and Beta, and nothing else.
  const level = heading.locator('xpath=..');
  await expect(level.getByRole('checkbox')).toHaveCount(2);
  await expect(level.getByRole('checkbox', { name: 'Alpha' })).toBeVisible();
  await expect(level.getByRole('checkbox', { name: 'Gamma' })).toHaveCount(0);

  await level.getByRole('checkbox', { name: 'Beta' }).uncheck();
  await expect(level.getByRole('checkbox', { name: 'Beta' })).not.toBeChecked();
  await layers.getByRole('button', { name: 'Write layer state to the document' }).click();

  const bytes = await exportBytes(page, 'labelled-out.pdf');
  expect(await readProducedEntry(bytes, null, 'OCProperties', 'D', 'OFF', 0, 'Name')).toContain('Beta');
  expect(await readProducedEntry(bytes, null, 'OCProperties', 'D', 'OFF')).toMatch(/^\[\s*\d+ 0 R\s*\]$/);
});
