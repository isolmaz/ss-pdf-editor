/**
 * Marking layers across page boundaries: a redaction drag that starts on one page and ends
 * on another is not a mark, because a mark belongs to one page.
 */

import { expect, test } from './test';
import { labelledPdf } from './tool-fixture';
import { drag, openPdf, rail } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

const REDACT_TOOL = 'Redact (permanent removal)';

test('a redaction drag from one page into the next marks nothing and keeps the tool armed', async ({
  page,
}) => {
  await openPdf(page, 'two.pdf', labelledPdf('Two', 2));
  const pages = page.locator('.pdfViewer[data-active-viewer] .page');
  // The boundary between the pages in the middle of the screen.
  await pages.nth(1).evaluate((element: HTMLElement) => {
    const scroller = element.parentElement?.parentElement;
    if (scroller !== null && scroller !== undefined) {
      scroller.scrollTop = element.offsetTop - scroller.clientHeight / 2;
    }
  });
  await expect
    .poll(async () => (await pages.nth(1).boundingBox())?.y ?? 0, { timeout: 10_000 })
    .toBeLessThan(700);
  const first = await pages.nth(0).boundingBox();
  const second = await pages.nth(1).boundingBox();
  if (first === null || second === null) throw new Error('both pages must be on screen');
  expect(first.y + first.height).toBeGreaterThan(200);

  await rail(page, REDACT_TOOL).click();
  const layer = page.getByRole('application', { name: 'Draw rectangle', exact: true });
  await expect(layer).toBeVisible();
  await drag(
    page,
    { x: first.x + first.width / 2 - 60, y: first.y + first.height - 60 },
    { x: second.x + second.width / 2 + 60, y: second.y + 60 },
  );
  await expect(page.locator('[data-mark-family="redaction"]')).toHaveCount(0);
  await expect(layer).toBeVisible();
});
