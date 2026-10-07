/**
 * The untagged-document editor: picking a block in the list marks its box on the page, and
 * a block dragged over another shows where it would land until it leaves.
 */

import { expect, test } from './test';
import { openPdf } from './ui-helpers';
import { openTagsView, untaggedFixture } from './ui-tags-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });
// The second page's content stream cannot be delimited: the engine says so on the console.
test.use({ allowedErrors: [/syntax error|encountered syntax/] });

test('a block picked in the list is the one marked on the page; another pick moves the mark', async ({
  page,
}) => {
  await openPdf(page, 'untagged.pdf', await untaggedFixture());
  await openTagsView(page);
  const items = page.locator('[data-plan-id]');
  await expect(items).toHaveCount(4);
  const picker = (at: number) => items.nth(at).locator('button[draggable]');
  const mark = async (at: number) => {
    const id = await items.nth(at).getAttribute('data-plan-id');
    return page.locator(`[data-order-box="${id}"]`);
  };

  await picker(1).click();
  await expect(picker(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(await mark(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(await mark(0)).toHaveAttribute('aria-pressed', 'false');

  await picker(0).click();
  await expect(picker(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(picker(1)).toHaveAttribute('aria-pressed', 'false');
  await expect(await mark(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(await mark(1)).toHaveAttribute('aria-pressed', 'false');
});

test('a block dragged over another row shows the drop line there, and the line goes when it leaves', async ({
  page,
}) => {
  await openPdf(page, 'untagged.pdf', await untaggedFixture());
  await openTagsView(page);
  const items = page.locator('[data-plan-id]');
  await expect(items).toHaveCount(4);
  const target = items.nth(1);
  await expect(target).not.toHaveClass(/border-t-2/);
  await target.dispatchEvent('dragover');
  await expect(target).toHaveClass(/border-t-2/);
  await target.dispatchEvent('dragleave');
  await expect(target).not.toHaveClass(/border-t-2/);
});
