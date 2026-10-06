import { expect, test } from 'playwright/test';
import { fixturePdf } from './fixture-pdf';

/**
 * Opening a document.
 *
 * **Boundary:** a native OS file picker cannot be automated, so this spec drives the
 * `<input type="file">` the home screen already renders — the one its "choose from device"
 * label points at. Everything after that boundary is the real application: the same
 * `openFile` path, pdf.js parsing the real bytes, the viewer painting them.
 */
test.describe('opening a document', () => {
  test('a one-page PDF opens in the viewer with its page count', async ({ page }) => {
    await page.goto('/editor/');

    const input = page.locator('input[type="file"][accept="application/pdf"]');
    await input.setInputFiles({
      name: 'fixture.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(fixturePdf()),
    });

    // The document names the window, and the editor header shows it.
    await expect(page).toHaveTitle('fixture.pdf');
    await expect(page.getByTitle('fixture.pdf').first()).toBeVisible();

    // pdf.js renders into `.pdfViewer`: a canvas on screen is not proof of a paint (a blank
    // canvas is also visible), so the pixels are read back: the fixture's blue rectangle
    // (rgb 26,51,230) has to be on the canvas, on an otherwise white sheet.
    const canvas = page.locator('.pdfViewer .page canvas').first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          canvas.evaluate((node) => {
            const element = node as HTMLCanvasElement;
            const context = element.getContext('2d');
            if (context === null) return false;
            const { data } = context.getImageData(0, 0, element.width, element.height);
            let blue = 0;
            let white = 0;
            for (let at = 0; at < data.length; at += 4) {
              const [red = 0, green = 0, blueChannel = 0] = [data[at], data[at + 1], data[at + 2]];
              if (Math.abs(red - 26) < 12 && Math.abs(green - 51) < 12 && Math.abs(blueChannel - 230) < 12) {
                blue += 1;
              } else if (red > 245 && green > 245 && blueChannel > 245) {
                white += 1;
              }
            }
            // The rectangle covers 44% of the sheet and the rest is white.
            const total = data.length / 4;
            return blue / total > 0.3 && white / total > 0.3;
          }),
        { timeout: 30_000 },
      )
      .toBe(true);

    // The page stepper reads "/ 1" for the single-page fixture.
    await expect(page.getByText('/ 1', { exact: true }).first()).toBeVisible();
  });
});
