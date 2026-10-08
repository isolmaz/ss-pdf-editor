/**
 * The viewer pane itself: its own find bar (Ctrl+F, Enter, F3, the arrows, the count, Escape),
 * the hand tool's drag-to-pan, and the page the window is on while the user finds and scrolls.
 */

import { expect, test } from './test';
import { openPdf, rail } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

test('the find bar counts matches, walks them forward and back across pages and says when nothing matches', async ({
  page,
}) => {
  await openPdf(page);
  await page.keyboard.press('Control+f');
  const bar = page.getByRole('search');
  const box = bar.getByRole('textbox', { name: 'Find in document' });
  await expect(box).toBeFocused();
  const count = bar.locator('span').first();
  // Nothing typed: no count, and the arrows have nothing to walk.
  await expect(count).toHaveText('');
  await expect(bar.getByRole('button', { name: 'Next match' })).toBeDisabled();

  // An empty Enter searches nothing.
  await box.press('Enter');
  await expect(count).toHaveText('');

  await box.fill('line');
  await box.press('Enter');
  await expect(count).toHaveText('1 of 5 matches');
  await expect(page.locator('.pdfViewer[data-active-viewer] .textLayer .highlight.selected')).toHaveCount(1);
  await expect(
    page.locator('.pdfViewer[data-active-viewer] .page[data-page-number="1"] .textLayer .highlight'),
  ).toHaveCount(4);

  // Enter on the same query steps to the next match; Shift+Enter steps back.
  await box.press('Enter');
  await expect(count).toHaveText('2 of 5 matches');
  await box.press('Shift+Enter');
  await expect(count).toHaveText('1 of 5 matches');
  // Back from the first wraps to the last, which is the line on page 2.
  await bar.getByRole('button', { name: 'Previous match' }).click();
  await expect(count).toHaveText('5 of 5 matches');
  await expect(page.getByRole('textbox', { name: 'Page number' })).toHaveValue('2');
  await bar.getByRole('button', { name: 'Next match' }).click();
  await expect(count).toHaveText('1 of 5 matches');
  await expect(page.getByRole('textbox', { name: 'Page number' })).toHaveValue('1');

  // F3 and Shift+F3 walk the matches from anywhere while the bar is open.
  await page.keyboard.press('F3');
  await expect(count).toHaveText('2 of 5 matches');
  await page.keyboard.press('Shift+F3');
  await expect(count).toHaveText('1 of 5 matches');

  // A query without a hit says so and disables the arrows.
  await box.fill('zzzqx');
  await box.press('Enter');
  await expect(count).toHaveText('No matches');
  await expect(bar.getByRole('button', { name: 'Next match' })).toBeDisabled();
  await expect(bar.getByRole('button', { name: 'Previous match' })).toBeDisabled();
  await expect(page.locator('.pdfViewer[data-active-viewer] .textLayer .highlight')).toHaveCount(0);

  // Close drops the bar and every highlight; the same keys do nothing then.
  await box.fill('anchor');
  await box.press('Enter');
  await expect(count).toHaveText('1 of 1 matches');
  await bar.getByRole('button', { name: 'Close find' }).click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('.pdfViewer[data-active-viewer] .textLayer .highlight')).toHaveCount(0);
  await page.keyboard.press('F3');
  await expect(bar).toHaveCount(0);

  // Escape closes a reopened bar and the query is forgotten.
  await page.keyboard.press('Control+f');
  await expect(box).toHaveValue('');
  await box.fill('line');
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
});

test('with the hand tool a drag pans the page area by the distance travelled; the selection tool does not', async ({
  page,
}) => {
  await openPdf(page);
  const scroller = page.locator('.pdfViewer[data-active-viewer] .page').first().locator('xpath=../..');
  const top = () => scroller.evaluate((element) => element.scrollTop);
  // The first page sits a little below the top edge of the scrolled area.
  const start = await top();
  expect(start).toBeLessThan(40);

  // The selection tool: a drag over blank page area scrolls nothing.
  await page.mouse.move(700, 400);
  await page.mouse.down();
  await page.mouse.move(700, 200, { steps: 6 });
  await page.mouse.up();
  expect(await top()).toBe(start);

  await rail(page, 'Hand / Pan Tool').click();
  await page.mouse.move(700, 600);
  await page.mouse.down();
  await expect(scroller).toHaveClass(/cursor-grabbing/);
  await page.mouse.move(700, 500, { steps: 6 });
  await expect.poll(top).toBe(start + 100);
  await page.mouse.move(700, 600, { steps: 6 });
  await expect.poll(top).toBe(start);
  await page.mouse.up();
  await expect(scroller).toHaveClass(/cursor-grab(?!bing)/);

  // A press of the right button starts no pan.
  await page.mouse.move(700, 600);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(700, 400, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  expect(await top()).toBe(start);
});
