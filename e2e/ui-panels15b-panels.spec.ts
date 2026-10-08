/**
 * Left-dock panels: the layers tree (nesting, headings, toggling, writing the state into
 * the file) and the search panel's remembered queries.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedEntry, toolFixturePdf } from './tool-fixture';
import { exportBytes, openDockTab, openPdf } from './ui-helpers';
import { layerTreePdf } from './ui-panels15-helpers';

const layers = (page: Page): Locator => page.getByRole('group', { name: 'Layers' });

test('the layers tab shows the document order: a level without a heading holds the rest', async ({
  page,
}) => {
  await openPdf(page, 'layers.pdf', layerTreePdf());
  await openDockTab(page, 'Layers');
  await expect(layers(page).getByRole('checkbox')).toHaveCount(4);
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
    await expect(layers(page).getByRole('checkbox', { name })).toBeChecked();
  }
  const top = layers(page).locator('ul').first().locator('> li');
  await expect(top).toHaveCount(2);
  // A bare sub-list of the order is a level with no heading; the layers the order left out join it.
  await expect(top.nth(0).getByRole('checkbox')).toHaveCount(1);
  await expect(top.nth(0).getByRole('checkbox', { name: 'Alpha' })).toBeVisible();
  await expect(top.nth(1).getByRole('checkbox')).toHaveCount(3);
  for (const name of ['Beta', 'Gamma', 'Delta']) {
    await expect(top.nth(1).getByRole('checkbox', { name })).toBeVisible();
  }
});

test('a layer switched off in the tab is written into the file as hidden, with the order kept', async ({
  page,
}) => {
  await openPdf(page, 'layers.pdf', layerTreePdf());
  await openDockTab(page, 'Layers');
  await layers(page).getByRole('checkbox', { name: 'Gamma' }).uncheck();
  await expect(layers(page).getByRole('checkbox', { name: 'Gamma' })).not.toBeChecked();
  await layers(page).getByRole('button', { name: 'Write layer state to the document' }).click();

  const bytes = await exportBytes(page, 'layers-out.pdf');
  const hidden = await readProducedEntry(bytes, null, 'OCProperties', 'D', 'OFF', 0, 'Name');
  expect(hidden).toContain('Gamma');
  expect(await readProducedEntry(bytes, null, 'OCProperties', 'D', 'OFF')).toMatch(/^\[\s*\d+ 0 R\s*\]$/);
});

test('a document without layers says so', async ({ page }) => {
  await openPdf(page, 'plain.pdf', toolFixturePdf());
  await openDockTab(page, 'Layers');
  await expect(page.getByText('This document has no layers.')).toBeVisible();
});

const box = (page: Page): Locator => page.getByRole('textbox', { name: 'Find in document' }).first();
const count = (page: Page): Locator => page.getByText(/^\d+ matches$/);

test('a query typed again after other searches shows the same matches, remembered or searched afresh', async ({
  page,
}) => {
  await openPdf(page);
  await openDockTab(page, 'Results');
  const counts = new Map<string, string>();
  const queries = ['line', 'anchor', 'fixture', 'second', 'reads', 'page', 'line', 'anchor'];
  for (const query of queries) {
    await box(page).fill(query);
    await expect(count(page)).toBeVisible();
    const text = (await count(page).innerText()).trim();
    const earlier = counts.get(query);
    if (earlier === undefined) counts.set(query, text);
    else expect(text, query).toBe(earlier);
  }
  expect(counts.get('line')).toBe('5 matches');
});
