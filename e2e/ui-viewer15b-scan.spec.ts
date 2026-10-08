/**
 * The scan dialog's camera screen against a scripted camera: `getUserMedia` hands out the
 * stream of a canvas that shows a photographed sheet (or a dark desk), so the live outline,
 * the still-photo path, every refusal the browser can give and the late-resolving stream
 * are all driven without a device.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { readProducedPdf } from './tool-fixture';
import { exportBytes, openPdf, sheetPhotoPng } from './ui-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 120_000 });

/** What the scripted camera records for the specs to read back. */
interface CameraProbe {
  desk: boolean;
  streams: MediaStream[];
  stillRequests: unknown[];
}

declare global {
  interface Window {
    __camera: CameraProbe;
    /** While true, the next `crypto.subtle.digest` rejects (and clears it). */
    __failNextDigest: boolean;
  }
}

interface CameraScript {
  /** `NotFoundError` … : what `getUserMedia` rejects with. */
  readonly fail?: string;
  /** The page has no `navigator.mediaDevices` at all. */
  readonly noMediaDevices?: boolean;
  /** Milliseconds `getUserMedia` takes to answer. */
  readonly delay?: number;
  /** An `ImageCapture` whose sensor still is much larger than the video. */
  readonly stillCapture?: boolean;
  /** `canvas.toBlob` hands back nothing, as a browser that ran out of memory does. */
  readonly encoderFails?: boolean;
}

const SHEET_URL = `data:image/png;base64,${sheetPhotoPng().toString('base64')}`;

/** Install the scripted camera before any page script runs. */
async function scriptCamera(page: Page, script: CameraScript = {}): Promise<void> {
  await page.addInitScript(
    ([sheetUrl, config]: readonly [string, CameraScript]) => {
      const state: CameraProbe = { desk: false, streams: [], stillRequests: [] };
      Object.defineProperty(window, '__camera', { value: state });
      if (config.noMediaDevices === true) {
        Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = 600;
      canvas.height = 800;
      const context = canvas.getContext('2d');
      const sheet = new Image();
      sheet.src = sheetUrl;
      window.setInterval(() => {
        if (context === null) return;
        if (state.desk || !sheet.complete) {
          context.fillStyle = '#262626';
          context.fillRect(0, 0, 600, 800);
        } else {
          context.drawImage(sheet, 0, 0, 600, 800);
        }
      }, 40);
      navigator.mediaDevices.getUserMedia = async () => {
        const pause = Promise.withResolvers<void>();
        window.setTimeout(pause.resolve, config.delay ?? 0);
        await pause.promise;
        if (config.fail !== undefined) throw new DOMException('scripted', config.fail);
        const stream = canvas.captureStream(25);
        state.streams.push(stream);
        return stream;
      };
      if (config.stillCapture === true) {
        class ScriptedCapture {
          async getPhotoCapabilities() {
            return { imageWidth: { max: 4000 }, imageHeight: { max: 3000 } };
          }
          async takePhoto(settings: unknown) {
            state.stillRequests.push(settings);
            const photo = Promise.withResolvers<Blob>();
            canvas.toBlob(
              (blob) => (blob === null ? photo.reject(new Error('no blob')) : photo.resolve(blob)),
              'image/jpeg',
            );
            return photo.promise;
          }
        }
        Object.defineProperty(window, 'ImageCapture', { value: ScriptedCapture, configurable: true });
      }
      if (config.encoderFails === true) {
        HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
          callback(null);
        };
      }
    },
    [SHEET_URL, script] as const,
  );
}

const dialogOf = (page: Page) => page.getByRole('dialog', { name: 'Scan with camera' });

async function openScan(page: Page): Promise<Locator> {
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Scan with camera' }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Press "Create PDF" and wait for the dialog to go. The dialog closing is the product's own
 * signal that the document is open; a sentence in the dialog is its signal that it is not,
 * and that fails the test at once with the sentence instead of after a minute of waiting.
 */
async function createPdf(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Create PDF' }).click();
  await expect
    .poll(
      async () => {
        if ((await dialog.count()) === 0) return 'closed';
        const alerts = await dialog.getByRole('alert').allInnerTexts();
        if (alerts.length > 0) throw new Error(`the scan dialog stayed open and said: ${alerts.join(' ')}`);
        return 'open';
      },
      { timeout: 60_000, message: 'the scan dialog closes once the PDF is open' },
    )
    .toBe('closed');
}

const outlinePoints = (dialog: Locator) =>
  dialog
    .getByTestId('scan-live-outline')
    .locator('polygon')
    .evaluate((polygon) =>
      (polygon.getAttribute('points') ?? '')
        .split(/[ ,]/)
        .filter((part) => part !== '')
        .map(Number),
    );

test('the live outline follows the sheet in front of the camera, settles, and goes when the sheet is taken away', async ({
  page,
}) => {
  await scriptCamera(page);
  await openPdf(page);
  const dialog = await openScan(page);
  await expect(dialog.getByTestId('scan-shutter')).toBeEnabled({ timeout: 30_000 });
  const outline = dialog.getByTestId('scan-live-outline');
  await expect(outline).toBeVisible({ timeout: 30_000 });
  // The sheet's corners are at 15 %/10 %, 85 %/12 %, 82 %/90 %, 18 %/88 % of the picture.
  await expect
    .poll(async () => (await outlinePoints(dialog))[0] ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(8);
  const first = await outlinePoints(dialog);
  expect(first).toHaveLength(8);
  expect(first[0]).toBeLessThan(22);
  // Two more detections later the blended outline has not moved away from the sheet.
  await page.waitForTimeout(900);
  const settled = await outlinePoints(dialog);
  expect(settled[0]).toBeCloseTo(first[0] as number, 0);
  expect(settled[5]).toBeGreaterThan(80);

  await page.evaluate(() => {
    window.__camera.desk = true;
  });
  await expect(outline).toHaveCount(0, { timeout: 15_000 });
});

test('a sensor still much larger than the video is asked for at its full size and becomes the photo', async ({
  page,
}) => {
  await scriptCamera(page, { stillCapture: true });
  await openPdf(page);
  const dialog = await openScan(page);
  const shutter = dialog.getByTestId('scan-shutter');
  await expect(shutter).toBeEnabled({ timeout: 30_000 });
  await shutter.click();
  await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toBeVisible({ timeout: 30_000 });
  const requests = await page.evaluate(() => window.__camera.stillRequests);
  expect(requests).toEqual([{ imageWidth: 4000, imageHeight: 3000 }]);
  await dialog.getByRole('button', { name: 'Add page' }).click();
  await createPdf(dialog);
  expect((await readProducedPdf(await exportBytes(page, 'still.pdf'))).pageCount).toBe(1);
});

test('a PDF the shell fails to open is reported in the dialog, opens no tab, and the retry opens exactly one', async ({
  page,
}) => {
  // The shell fingerprints the produced bytes before it registers a tab, so a rejected digest
  // is a failure with nothing opened: the shell's own notice would sit behind the modal and
  // fade, leaving "Create PDF" silent.
  await page.addInitScript(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let armed = false;
    Object.defineProperty(window, '__failNextDigest', {
      get: () => armed,
      set: (value: boolean) => {
        armed = value;
      },
    });
    crypto.subtle.digest = (...args: Parameters<typeof digest>) => {
      if (!armed) return digest(...args);
      armed = false;
      return Promise.reject(new Error('scripted: the digest failed'));
    };
  });
  await scriptCamera(page, { stillCapture: true });
  await openPdf(page);
  // The header's document switcher names the active document and lists the open ones. The
  // scan dialog is modal, so its button is clicked in the DOM rather than with the pointer.
  const switcher = (name: string) => page.locator(`button[aria-haspopup="true"][title^="${name}"]`);
  const openDocuments = async (name: string): Promise<string> => {
    await switcher(name).evaluate((button: HTMLElement) => button.click());
    const heading = page.getByText(/^Open documents \(\d+\)$/);
    const text = (await heading.textContent()) ?? '';
    await switcher(name).evaluate((button: HTMLElement) => button.click());
    await expect(heading).toHaveCount(0);
    return text;
  };
  expect(await openDocuments('doc.pdf')).toBe('Open documents (1)');
  const dialog = await openScan(page);
  const shutter = dialog.getByTestId('scan-shutter');
  await expect(shutter).toBeEnabled({ timeout: 30_000 });
  await shutter.click();
  await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Add page' }).click();
  const create = dialog.getByRole('button', { name: 'Create PDF' });
  await page.evaluate(() => {
    window.__failNextDigest = true;
  });
  await create.click();
  await expect(dialog.getByRole('alert')).toHaveText('Something unexpected went wrong.', {
    timeout: 30_000,
  });
  // The failure consumed the armed digest, and the shell opened nothing.
  expect(await page.evaluate(() => window.__failNextDigest)).toBe(false);
  await expect(dialog).toBeVisible();
  await expect(switcher('doc.pdf')).toHaveCount(1);
  expect(await openDocuments('doc.pdf')).toBe('Open documents (1)');
  // Nothing is lost: the same dialog, the same page, and the click now makes the PDF.
  await expect(create).toBeEnabled();
  await createPdf(dialog);
  await expect(switcher('Scan ')).toHaveCount(1);
  expect(await openDocuments('Scan ')).toBe('Open documents (2)');
});

test('a photo the browser cannot encode is reported on the camera screen and the shutter stays usable', async ({
  page,
}) => {
  await scriptCamera(page, { encoderFails: true });
  await openPdf(page);
  const dialog = await openScan(page);
  const shutter = dialog.getByTestId('scan-shutter');
  await expect(shutter).toBeEnabled({ timeout: 30_000 });
  await shutter.click();
  await expect(dialog.getByRole('alert')).toHaveText('The photo could not be taken. Try again.');
  await expect(shutter).toBeEnabled();
  await expect(dialog.getByRole('heading', { name: 'Adjust the corners' })).toHaveCount(0);
});

const REFUSALS: readonly { name: string; script: CameraScript; message: string }[] = [
  {
    name: 'no camera on the device',
    script: { fail: 'NotFoundError' },
    message: 'No camera was found on this device.',
  },
  {
    name: 'a camera held by another application',
    script: { fail: 'NotReadableError' },
    message: 'The camera is in use by another application.',
  },
  {
    name: 'a browser that refuses the request',
    script: { fail: 'NotSupportedError' },
    message: 'This browser does not support camera access.',
  },
  {
    name: 'an unknown failure',
    script: { fail: 'DataCloneError' },
    message: 'The camera could not be started.',
  },
  {
    name: 'a page without media devices',
    script: { noMediaDevices: true },
    message: 'This browser does not support camera access.',
  },
];

for (const refusal of REFUSALS) {
  test(`${refusal.name}: the dialog says so and the shutter stays off`, async ({ page }) => {
    await scriptCamera(page, refusal.script);
    await openPdf(page);
    const dialog = await openScan(page);
    await expect(dialog.getByText(refusal.message)).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId('scan-shutter')).toBeDisabled();
  });
}

test('a camera that answers after the dialog was closed is switched off at once', async ({ page }) => {
  await scriptCamera(page, { delay: 1500 });
  await openPdf(page);
  const dialog = await openScan(page);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.waitForFunction(
    () => {
      const { streams } = window.__camera;
      return streams.length === 1 && streams[0]?.getTracks().every((track) => track.readyState === 'ended');
    },
    undefined,
    { timeout: 15_000 },
  );
});
