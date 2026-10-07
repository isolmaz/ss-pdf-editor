import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright/test';
import { useAdvancedMode } from './settings';
import { makeSignerContainer, readSignature, SIGNER } from './signer-fixture';
import { expect, test } from './test';
import { readProducedPageTexts, readProducedPdf, toolFixturePdf } from './tool-fixture';

/**
 * Keyboard history, the home screen's status bar, reading mode and presentation mode.
 */

test.use({ viewport: { width: 1440, height: 900 } });

const CANVAS = '.pdfViewer[data-active-viewer] .page canvas';

async function open(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  // The page shows before the open finishes (the source is still being stored), and the
  // shell refuses other work until then: a gesture sent earlier is dropped under load.
  await expect(page.getByText('Opening the document…')).toHaveCount(0, { timeout: 30_000 });
}

const thumbs = (page: Page) => page.getByRole('option');
const notice = (page: Page, text: string) => page.locator('[role="status"]').filter({ hasText: text });

test('two Ctrl+Z presses sent back to back undo two steps', async ({ page }) => {
  await open(page, 'undo.pdf', toolFixturePdf());
  for (const count of [3, 4]) {
    await thumbs(page).first().click();
    await page.getByRole('menuitem', { name: 'Page', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Duplicate pages' }).click();
    await expect(thumbs(page)).toHaveCount(count);
  }
  await expect(notice(page, 'duplicated')).toBeVisible();

  // No wait for the first undo's notice: the second press lands while it is in flight.
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(thumbs(page)).toHaveCount(2);
});

test('the status bar shows no zoom once the document is closed', async ({ page }) => {
  await open(page, 'close.pdf', toolFixturePdf());
  await useAdvancedMode(page);
  const bar = page.getByRole('contentinfo');
  await expect(bar.getByText(/\d+%/).first()).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Close tab');
  await page.getByRole('option').filter({ hasText: 'Close tab' }).first().click();
  // The home screen is back: its start tabs, with no document open.
  await expect(page.getByRole('tablist', { name: 'Start something new' })).toBeVisible();
  await expect(bar).not.toContainText('%');
});

test('reading mode shows the page text, pages with the keyboard and closes with Escape', async ({ page }) => {
  await open(page, 'read.pdf', toolFixturePdf());
  await page.keyboard.press('F9');
  const pane = page.getByRole('region', { name: 'Reading mode' });
  await expect(pane).toBeVisible();
  await expect(pane.getByText('Page 1', { exact: true })).toBeVisible();
  await expect(pane.getByText('Fixture line one reads clearly')).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(pane.getByText('Page 2', { exact: true })).toBeVisible();
  await expect(pane.getByText('Second page anchor line')).toBeVisible();
  await expect(pane.getByText('Fixture line one')).toBeHidden();
  await page.keyboard.press('PageUp');
  await expect(pane.getByText('Page 1', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Go to page 2' }).click();
  await expect(pane.getByText('Page 2', { exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(pane).toBeHidden();
  // The viewer behind the pane followed the reader to page 2.
  await expect(page.getByLabel('Page number')).toHaveValue('2');
});

test('presentation mode shows one page full screen, pages with the keyboard and leaves with Escape', async ({
  page,
}) => {
  await open(page, 'present.pdf', toolFixturePdf());
  const fullscreen = () => page.evaluate(() => document.fullscreenElement !== null);
  const topPage = () =>
    page.evaluate(() => {
      const container = document.querySelector('.pdfViewer[data-active-viewer]')?.parentElement;
      const pages = [...document.querySelectorAll('.pdfViewer[data-active-viewer] .page')];
      if (!container) return -1;
      const top = container.getBoundingClientRect().top;
      return pages.findIndex((p) => Math.abs(p.getBoundingClientRect().top - top) < 40);
    });
  await page.getByRole('button', { name: 'Full-screen presentation' }).click();
  await expect.poll(fullscreen).toBe(true);
  await expect(page.locator('.pdfPresentationMode')).toHaveCount(1);
  await expect.poll(topPage).toBe(0);

  await page.keyboard.press('ArrowRight');
  await expect.poll(topPage).toBe(1);
  await page.keyboard.press('Home');
  await expect.poll(topPage).toBe(0);
  await page.keyboard.press('End');
  await expect.poll(topPage).toBe(1);

  await page.keyboard.press('Escape');
  await expect.poll(fullscreen).toBe(false);
  await expect(page.locator('.pdfPresentationMode')).toHaveCount(0);
});

/**
 * The preview server, fronted by a second origin that can ship "a new release": once
 * `release()` is called it serves `/sw.js` with extra bytes, which is all a deploy is to the
 * browser. Playwright's own routing cannot stand in for this: a worker's script fetch (and its
 * periodic update check) never passes through `page.route`.
 */
async function deployableOrigin(upstream: string): Promise<{
  readonly origin: string;
  readonly release: () => void;
  readonly close: () => Promise<void>;
}> {
  let released = false;
  const server = createServer((request, response) => {
    void (async () => {
      const answer = await fetch(new URL(request.url ?? '/', upstream), {
        headers: { accept: request.headers.accept ?? '*/*' },
      });
      const headers = Object.fromEntries(
        [...answer.headers].filter(
          ([name]) => !['content-length', 'content-encoding', 'transfer-encoding'].includes(name),
        ),
      );
      let body = Buffer.from(await answer.arrayBuffer());
      if (released && new URL(request.url ?? '/', upstream).pathname === '/sw.js') {
        body = Buffer.concat([body, Buffer.from('\n// release 2\n')]);
      }
      response.writeHead(answer.status, headers);
      response.end(body);
    })();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://localhost:${port}`,
    release: () => {
      released = true;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test('a new release raises the update banner; Refresh activates its worker and reloads the page', {
  tag: '@service-worker',
}, async ({ page, baseURL }) => {
  const site = await deployableOrigin(baseURL ?? 'http://localhost:4178');
  try {
    await page.goto(`${site.origin}/editor/`);
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, undefined, {
      timeout: 30_000,
    });
    const banner = page.getByRole('status').filter({ hasText: 'A new update is available' });
    await expect(banner).toBeHidden();
    await page.evaluate(() => {
      (window as unknown as { loadedBeforeUpdate: boolean }).loadedBeforeUpdate = true;
    });

    site.release();
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration('/editor/'))?.update();
    });
    await expect(banner).toBeVisible({ timeout: 30_000 });

    // Accepting: the waiting worker takes over and the page reloads onto it, so the marker
    // set before the update is gone and nothing is left waiting.
    await banner.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForFunction(() => !('loadedBeforeUpdate' in window), undefined, { timeout: 30_000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await expect(banner).toBeHidden();
    expect(
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.getRegistration('/editor/');
        return { waiting: registration?.waiting ?? null, active: registration?.active?.state };
      }),
    ).toEqual({ waiting: null, active: 'activated' });
  } finally {
    await site.close();
  }
});

/** Sign the open document with a fresh identity through the Tools menu; the stamp goes bottom right. */
async function signOpenDocument(page: Page, dir: string): Promise<void> {
  const container = makeSignerContainer(dir);
  await page.getByRole('menuitem', { name: 'Tools', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign document' }).click();
  const form = page.getByRole('region', { name: /Sign Document/ });
  await form.locator('input[type="file"]').setInputFiles(container);
  await form.getByRole('textbox', { name: 'PKCS#12 password' }).fill(SIGNER.password);
  await form.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(form.getByRole('heading', { name: 'Operation report' })).toBeVisible({ timeout: 60_000 });
  await form.getByRole('button', { name: 'Apply to document', exact: true }).click();
  await expect(notice(page, `Signature applied (${SIGNER.commonName})`)).toBeVisible({ timeout: 60_000 });
}

/** Export through the header button and read the downloaded bytes back. */
async function exported(page: Page, name: string): Promise<Uint8Array> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const path = test.info().outputPath(name);
  await (await download).saveAs(path);
  return new Uint8Array(readFileSync(path));
}

/** How many pixels of the first page's canvas, inside a page-space box, are not white. */
const inkIn = (page: Page, box: readonly [number, number, number, number]) =>
  page.evaluate(([x0, y0, x1, y1]) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.pdfViewer[data-active-viewer] .page canvas');
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return -1;
    const [sx, sy] = [canvas.width / 595, canvas.height / 842];
    const { data } = context.getImageData(x0 * sx, (842 - y1) * sy, (x1 - x0) * sx, (y1 - y0) * sy);
    let ink = 0;
    for (let at = 0; at < data.length; at += 4) if ((data[at] ?? 255) < 200) ink += 1;
    return ink;
  }, box);

// The default stamp: 200 x 60 pt, 24 pt in from the bottom-right corner of the page box.
const STAMP_BOX = [371, 24, 571, 84] as const;

test('signing stamps the page and writes a signature that an independent verifier accepts', async ({
  page,
}) => {
  const dir = test.info().outputPath('signer');
  await open(page, 'sign.pdf', toolFixturePdf());
  expect(await inkIn(page, STAMP_BOX)).toBe(0);
  await signOpenDocument(page, dir);

  // The stamp is on the page, and the status bar says the document carries a signature.
  await expect.poll(() => inkIn(page, STAMP_BOX)).toBeGreaterThan(0);
  await expect(page.getByRole('contentinfo').getByText('Signatures: 1')).toBeVisible();

  // Exporting the file the signing just wrote is not a change to it: no warning, and the
  // bytes are the signed ones.
  const bytes = await exported(page, 'signed.pdf');
  const signature = readSignature(bytes, dir);
  expect(signature?.coversWholeFile).toBe(true);
  expect(signature?.verifies).toBe(true);
  const produced = await readProducedPdf(bytes);
  const widget = produced.annotations.find(
    (mark) =>
      mark.subtype === 'Widget' && mark.pageIndex === 0 && mark.rect.length === 4 && mark.rect[2] === 571,
  );
  expect(widget?.rect).toEqual([371, 24, 571, 84]);
  const texts = await readProducedPageTexts(bytes);
  expect(texts[0]).toContain('Fixture line one reads clearly');
});

test('editing after signing warns before the save, and saving anyway breaks the signature', async ({
  page,
}) => {
  const dir = test.info().outputPath('signer');
  await open(page, 'resign.pdf', toolFixturePdf());
  await signOpenDocument(page, dir);
  await page.getByRole('button', { name: 'Rotate Page (90°)' }).click();
  await expect(notice(page, '1 page(s) rotated')).toBeVisible();

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const warning = page.getByRole('dialog', { name: 'Saving will invalidate existing signature' });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(SIGNER.commonName);
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await expect(warning).toBeHidden();

  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Save anyway' }).click();
  const path = test.info().outputPath('broken.pdf');
  await (await download).saveAs(path);
  const signature = readSignature(new Uint8Array(readFileSync(path)), dir);
  expect(signature?.verifies).toBe(false);
});

test('view and settings commands from the menu bar act and are named in the interface language', async ({
  page,
}) => {
  await open(page, 'menus.pdf', toolFixturePdf());
  // The interface follows the browser's English, and so does the document's language.
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  await useAdvancedMode(page);
  const menu = async (bar: string, item: string, kind: 'menuitem' | 'menuitemcheckbox' = 'menuitem') => {
    await page.getByRole('menuitem', { name: bar, exact: true }).click();
    await page.getByRole(kind, { name: item }).click();
  };
  const pageWidth = () =>
    page.evaluate(
      () =>
        document.querySelector('.pdfViewer[data-active-viewer] .page')?.getBoundingClientRect().width ?? 0,
    );

  // Two-page spread puts both pages of the fixture side by side; single page undoes it.
  const tops = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.pdfViewer[data-active-viewer] .page')].map((p) =>
        Math.round(p.getBoundingClientRect().top),
      ),
    );
  await menu('View', 'Two-page spread');
  await expect.poll(async () => new Set(await tops()).size).toBe(1);
  await menu('View', 'Single page');
  await expect.poll(async () => new Set(await tops()).size).toBe(2);

  // Fit page shrinks the page so the whole of it is in view.
  await menu('View', 'Fit width');
  const wide = await pageWidth();
  await menu('View', 'Fit page');
  await expect.poll(pageWidth).toBeLessThan(wide);

  // The magnifier's lens control is in the interface language (it was Turkish).
  await menu('View', 'Magnifier', 'menuitemcheckbox');
  await expect(page.getByText('Magnifier', { exact: true })).toBeVisible();
  await menu('View', 'Magnifier', 'menuitemcheckbox');

  // The dark theme reaches the document element, then the light one takes it back.
  await menu('Settings', 'Dark Theme', 'menuitemcheckbox');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await menu('Settings', 'Light Theme', 'menuitemcheckbox');
  await expect(page.locator('html')).not.toHaveAttribute('data-mode', 'dark');

  // The batch dialog opens in the interface language.
  await menu('File', 'Batch operations');
  await expect(page.getByRole('dialog', { name: 'Batch operations' })).toBeVisible();
});
