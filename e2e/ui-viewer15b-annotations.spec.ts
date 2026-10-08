/**
 * A drawing gesture the system interrupts (a touch taken over by a scroll or a call): the
 * partial shape is discarded, a release afterwards adds nothing, and the next drag draws.
 */

import { expect, test } from './test';
import { drag, openPdf, pageFrame, rail, toClient } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

const SHAPE_TOOL = 'Draw Shape (Rectangle)';

test('a pointercancel in the middle of a shape drag discards the shape; the next drag still draws one', async ({
  page,
}) => {
  await openPdf(page);
  const frame = await pageFrame(page);
  await rail(page, SHAPE_TOOL).click();
  await page.evaluate(() => {
    window.addEventListener('pointerdown', (event) => {
      Object.assign(window, { lastPointerId: event.pointerId });
    });
  });

  const start = toClient(frame, 120, 330);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 90, start.y + 60, { steps: 5 });
  const preview = page.locator('span.pointer-events-none.border-kumo-focus');
  await expect(preview).toBeVisible();
  await page.evaluate(() => {
    const id: unknown = Reflect.get(window, 'lastPointerId');
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: typeof id === 'number' ? id : 1 }));
  });
  await expect(preview).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator('[data-ann]')).toHaveCount(0);
  await expect(rail(page, SHAPE_TOOL)).toHaveAttribute('aria-pressed', 'true');

  await drag(page, start, toClient(frame, 220, 280), 6);
  await expect(page.locator('[data-ann]')).toHaveCount(1);
});
