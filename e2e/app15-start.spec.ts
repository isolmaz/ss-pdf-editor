import { expect, test } from './test';

/** The page before any document: what it does when part of it cannot be fetched. */

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('the interface language cannot be fetched', () => {
  test.use({ allowedErrors: [/Failed to load resource|Failed to fetch dynamically imported module/] });

  test('the shell still opens, showing the words it has instead of waiting for a catalogue that never comes', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('pdf-editor.locale', 'tr');
    });
    let refused = 0;
    await page.route('**/assets/tr-*.js', async (route) => {
      refused += 1;
      await route.abort();
    });
    await page.goto('/editor/');
    // Nothing translated Turkish is in memory, so the interface names its controls by their keys.
    await expect(page.getByRole('tablist', { name: 'home.start.title' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('tab', { name: 'home.tab.start' })).toBeVisible();
    expect(refused).toBeGreaterThan(0);
  });
});

test('started offline, the shell fetches its idle chunks when the network comes back, not before', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      get: () => Reflect.get(window, '__online') === true,
    });
    // The warm-up that finds the network down holds back by waiting for the `online` event:
    // that registration is the proof it has run, so the absence of chunk requests below is
    // measured after its idle callback fired rather than after a guessed delay.
    const listen = window.addEventListener.bind(window);
    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      value: (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === 'online') Reflect.set(window, '__onlineWaits', 1);
        listen(type, listener, options);
      },
    });
  });
  const chunks: string[] = [];
  page.on('request', (request) => {
    if (/\/assets\/(PaletteSurface|PrintSurface)-/.test(request.url())) chunks.push(request.url());
  });
  await page.goto('/editor/');
  await expect(page.getByRole('tab', { name: 'Start', exact: true })).toBeVisible();
  // The idle callback's own timeout is 3 s: the warm-up has had its chance and held back.
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, '__onlineWaits')), { timeout: 15_000 })
    .toBe(1);
  expect(chunks).toEqual([]);

  await page.evaluate(() => {
    Reflect.set(window, '__online', true);
    window.dispatchEvent(new Event('online'));
  });
  await expect.poll(() => chunks.length, { timeout: 30_000 }).toBeGreaterThan(0);
});

test('the Start tab comes back after All tools, and a file dialog closed with no file opens nothing', async ({
  page,
}) => {
  await page.goto('/editor/');
  const start = page.getByRole('tab', { name: 'Start', exact: true });
  const tools = page.getByRole('tab', { name: 'All tools', exact: true });
  await tools.click();
  await expect(tools).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('searchbox', { name: 'Search tools…' })).toBeVisible();

  await start.click();
  await expect(start).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('label', { hasText: 'Open a PDF or drop it here' })).toBeVisible();

  // The input reports a change with an empty selection (the user cleared it): nothing opens.
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .evaluate((input) => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  await expect(page.locator('.pdfViewer[data-active-viewer] .page canvas')).toHaveCount(0);
  await expect(page.getByText('Opening the document…')).toHaveCount(0);
  await expect(page.locator('[role="status"]').filter({ hasText: /\S/ })).toHaveCount(0);
});
