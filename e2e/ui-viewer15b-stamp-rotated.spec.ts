/**
 * A picture placed on a page the file turns a quarter: it is drawn upright for the reader,
 * so in the page's own coordinates its box is turned.
 */

import { expect, test } from './test';
import { labelledPdf, readProducedPdf } from './tool-fixture';
import { encodePng, exportBytes, menuItem, openPdf } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

for (const rotation of [90, 270]) {
  test(`a wide picture on a page turned ${rotation} degrees reads wide on screen and is stored turned`, async ({
    page,
  }) => {
    await openPdf(page, 'turned.pdf', labelledPdf('Turned', 1, { rotations: [rotation] }));
    await menuItem(page, 'Tools', 'Add an image');
    await page.locator('input[type="file"][accept*="image/png"]').setInputFiles({
      name: 'wide.png',
      mimeType: 'image/png',
      buffer: encodePng(80, 40, (x) => (x < 40 ? [200, 30, 30] : [30, 30, 200])),
    });
    const sheet = await page.locator('.pdfViewer[data-active-viewer] .page').first().boundingBox();
    if (sheet === null) throw new Error('no page box');
    const centre = { x: sheet.x + sheet.width / 2, y: sheet.y + sheet.height / 2 };
    await page.mouse.move(centre.x, centre.y, { steps: 4 });
    const ghost = page.locator('[data-stamp-placement] img');
    await expect(ghost).toBeVisible();
    const shown = await ghost.boundingBox();
    expect((shown?.width ?? 0) / (shown?.height ?? 1)).toBeCloseTo(2, 1);
    await page.mouse.click(centre.x, centre.y);
    await expect(page.locator('[data-stamp-placement]')).toHaveCount(0);

    const bytes = await exportBytes(page, `turned-${rotation}.pdf`);
    const [stamp] = (await readProducedPdf(bytes)).annotations.filter(
      (annotation) => annotation.subtype === 'Stamp',
    );
    const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = stamp?.rect ?? [];
    // Landscape on the reader's screen, portrait in the page's own space.
    expect((y1 - y0) / (x1 - x0)).toBeCloseTo(2, 1);
  });
}
