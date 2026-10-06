/**
 * Slice verification — printing, reading mode, and (when present) the tools slices,
 * exercised in the assembled app in Chromium (throwaway tooling, `PLAN.md §9/K21`).
 *
 * Usage: node tools/spikes/browser-check-slices.mjs [fixture.pdf]
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const fixture =
  args.find((value) => value.endsWith('.pdf')) ??
  'C:/Users/isolm/AppData/Local/Temp/pdf-editor-fixture-u4L2dW/fixture-5p.pdf';
const origin = process.env.VERIFY_ORIGIN ?? 'http://localhost:4178';
const outcome = { fixture, steps: [], errors: [] };

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
  headless: true,
});

const step = async (label, fn) => {
  try {
    outcome.steps.push({ label, result: await fn() });
  } catch (error) {
    outcome.steps.push({ label, error: String(error?.message ?? error).slice(0, 240) });
  }
};

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => outcome.errors.push(`pageerror: ${error.message.slice(0, 200)}`));
  page.on('console', (message) => {
    if (message.type() === 'error') outcome.errors.push(`console: ${message.text().slice(0, 200)}`);
  });

  await page.goto(`${origin}/editor/`, { waitUntil: 'load' });
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 30_000 });
  await page.setInputFiles('input[type="file"]', fixture);
  await page.waitForSelector('.pdfViewer .page canvas', { timeout: 60_000 });
  await page.waitForTimeout(2000);

  const clickByLabel = (label) =>
    page.evaluate((text) => {
      const button = [...document.querySelectorAll('button')].find(
        (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').trim() === text,
      );
      if (button === undefined) throw new Error(`no button labelled ${text}`);
      button.click();
    }, label);

  await step('reading mode: pane opens with reflowed text', async () => {
    await clickByLabel('Okuma modu');
    await page.waitForSelector('.pdf-reading-pane, [data-reading-pane], .pdf-reading-root', {
      timeout: 15_000,
    });
    await page.waitForTimeout(1200);
    return page.evaluate(() => {
      const pane = document.querySelector('.pdf-reading-pane, [data-reading-pane], .pdf-reading-root');
      const text = pane?.innerText.split('\n').filter((line) => line.trim().length > 0) ?? [];
      const voice = [...document.querySelectorAll('[role="status"], [class*="reading"]')]
        .map((el) => el.textContent ?? '')
        .join(' | ');
      return {
        paneFound: pane !== null,
        firstLines: text.slice(0, 8),
        lineCount: text.length,
        speaksOfVoice: /yerel Türkçe ses/.test(voice),
        buttons: [...(pane?.querySelectorAll('button') ?? [])].map((b) =>
          (b.getAttribute('aria-label') ?? b.textContent ?? '').trim(),
        ),
        emptyNotice: text.some((line) => line.includes('okunacak metin')),
      };
    });
  });

  await step('reading mode: Escape closes it', async () => {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    return page.evaluate(
      () => document.querySelector('.pdf-reading-pane, [data-reading-pane], .pdf-reading-root') === null,
    );
  });

  await step('reading mode: page navigation inside the pane', async () => {
    await clickByLabel('Okuma modu');
    await page.waitForTimeout(1200);
    const before = await page.evaluate(
      () => document.querySelector('footer')?.innerText.split('|')[0].trim() ?? '',
    );
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(800);
    const after = await page.evaluate(
      () => document.querySelector('footer')?.innerText.split('|')[0].trim() ?? '',
    );
    await page.keyboard.press('Escape');
    return { before, after };
  });

  await step('print: dialog, page range, sheets', async () => {
    await page.keyboard.press('Control+p');
    await page.waitForTimeout(800);
    const dialogText = await page.evaluate(
      () => document.querySelector('[role="dialog"]')?.innerText.replace(/\n/g, ' | ') ?? null,
    );
    const startButton = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].filter(
        (candidate) => (candidate.textContent ?? '').trim() === 'Yazdır',
      );
      const target = buttons.at(-1);
      const report = buttons.map((button) => ({
        text: button.textContent?.trim(),
        disabled: button.disabled,
      }));
      target?.click();
      return { count: buttons.length, report };
    });
    outcome.steps.push({ label: 'print: start button state', result: startButton });
    await page.waitForTimeout(6000);
    const printState = await page.evaluate(() => {
      const root = document.querySelector('.pdf-print-root');
      return {
        sheets: root?.querySelectorAll('.pdf-print-page').length ?? 0,
        images: root?.querySelectorAll('img').length ?? 0,
        imageBytes: [...(root?.querySelectorAll('img') ?? [])].map((img) => img.src.length),
        visible: root === null ? null : getComputedStyle(root).display,
      };
    });
    return { dialogText, ...printState };
  });

  await step('print: afterprint removes the container', async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.waitForTimeout(1200);
    return page.evaluate(() => ({
      root: document.querySelector('.pdf-print-root') !== null,
      sheets: document.querySelectorAll('.pdf-print-root .pdf-print-page').length,
    }));
  });

  await step('tools: view history back/forward', async () => {
    const _label = (text) =>
      [...document.querySelectorAll('button')].find(
        (candidate) => (candidate.getAttribute('aria-label') ?? '').trim() === text,
      );
    const backDisabledBefore = await page.evaluate(
      () =>
        [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Geri')
          ?.disabled ?? null,
    );
    // A view jump: two page downs, then back should land on the intermediate page.
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(700);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label') === 'Geri',
      );
      button?.click();
    });
    await page.waitForTimeout(1200);
    return {
      backDisabledBefore,
      pageAfterTwoDowns: await page.evaluate(
        () => document.querySelector('footer')?.innerText.split('\n')[0] ?? '',
      ),
      pageAfterBack: await page.evaluate(
        () => document.querySelector('footer')?.innerText.split('\n')[0] ?? '',
      ),
      buttons: await page.evaluate(() =>
        [...document.querySelectorAll('button')]
          .map((b) => b.getAttribute('aria-label'))
          .filter((label) => label !== null)
          .slice(0, 24),
      ),
    };
  });

  await step('tools: snapshot dialog and magnifier toggle', async () => {
    const click = (label) =>
      page.evaluate((text) => {
        const button = [...document.querySelectorAll('button')].find(
          (candidate) => (candidate.getAttribute('aria-label') ?? '').trim() === text,
        );
        button?.click();
        return button !== undefined;
      }, label);
    const snapshotOpened = await click('Görüntü al');
    await page.waitForTimeout(2500);
    const snapshot = await page.evaluate(() => {
      const canvases = [...document.querySelectorAll('canvas')].filter((canvas) => canvas !== undefined);
      const panel = document.querySelector('.pdf-snapshot-panel, [class*="snapshot"]');
      return {
        panelFound: panel !== null,
        panelText: (panel?.textContent ?? '').slice(0, 160),
        canvasCount: canvases.length,
      };
    });
    await page.keyboard.press('Escape');
    const magnifierOn = await click('Büyüteç');
    await page.waitForTimeout(600);
    const magnifier = await page.evaluate(() => {
      const lens = document.querySelector('.pdf-magnifier-lens, [class*="magnifier"]');
      return { lensFound: lens !== null, display: lens === null ? null : getComputedStyle(lens).display };
    });
    return { snapshotOpened, snapshot, magnifierOn, magnifier };
  });

  await step('tools: presentation mode toggles', async () => {
    const toggled = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        ['Sunum modu', 'Sunumdan çık'].includes((b.getAttribute('aria-label') ?? '').trim()),
      );
      button?.click();
      return button?.getAttribute('aria-label') ?? null;
    });
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({
      fullscreen: document.fullscreenElement !== null,
      label: [...document.querySelectorAll('button')]
        .map((b) => (b.getAttribute('aria-label') ?? '').trim())
        .find((label) => label === 'Sunumdan çık' || label === 'Sunum modu'),
    }));
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (b) => (b.getAttribute('aria-label') ?? '').trim() === 'Sunumdan çık',
      );
      button?.click();
    });
    return { toggled, after };
  });

  await step('print: the dialog state after the job', async () => {
    await page.waitForTimeout(2000);
    return page.evaluate(() => ({
      dialogOpen: document.querySelector('[role="dialog"]') !== null,
      sheetsAfter: document.querySelectorAll('.pdf-print-root .pdf-print-page').length,
    }));
  });

  await context.close();
} finally {
  await browser.close();
}

console.log(JSON.stringify(outcome, null, 1));
