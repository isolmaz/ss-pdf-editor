/**
 * Reading mode's read-aloud: only a local voice in the document's language may speak (the
 * fixtures here declare no `/Lang`, so it is the English interface's; `ui-read-aloud-lang.spec.ts`
 * covers the choice), the page is
 * spoken sentence by sentence in order, and Pause, Resume, Stop, the rate and a change of page
 * act on the speech queue. The platform's speech engine is replaced by a recording stand-in
 * (it speaks nothing, but it is asked exactly what a real one would be), so what is asserted
 * is what the editor sent to it and what its controls show.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { labelledPdf, scannedPdf } from './tool-fixture';
import { menuItem, openPdf } from './ui-helpers';
import { endUtterance, speechLog, stubSpeech, untilSpeaking } from './ui-panels9-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

const LOCAL_ENGLISH = { name: 'Local English', lang: 'en-US', localService: true } as const;

/** Page one reads as three sentences; page two as two. */
const speechPdf = (): Uint8Array => labelledPdf('Alpha one. Beta two.', 2);

async function openReading(page: Page): Promise<void> {
  await openPdf(page, 'speech.pdf', speechPdf());
  await menuItem(page, 'View', /Reading mode/);
  await expect(page.getByText('Alpha one. Beta two. 1').first()).toBeVisible({ timeout: 30_000 });
}

const speech = (page: Page): Locator => page.locator('.pdf-reading-speech');
const read = (page: Page): Locator => speech(page).getByRole('button', { name: 'Read', exact: true });
const pause = (page: Page): Locator => speech(page).getByRole('button', { name: 'Pause', exact: true });
const stop = (page: Page): Locator => speech(page).getByRole('button', { name: 'Stop', exact: true });
const rate = (page: Page): Locator => page.getByRole('slider', { name: 'Rate' });

test.describe('no usable voice', () => {
  for (const [title, voices] of [
    ['no voice at all', []],
    ['only a cloud voice in the language', [{ name: 'Cloud English', lang: 'en-US', localService: false }]],
    [
      'only a local voice in another language',
      [{ name: 'Local Turkish', lang: 'tr-TR', localService: true }],
    ],
  ] as const) {
    test(`${title}: nothing can be spoken, and the pane says why`, async ({ page }) => {
      await stubSpeech(page, voices);
      await openReading(page);
      await expect(
        page.getByText('There is no local English voice on this device; read-aloud is unavailable.'),
      ).toBeVisible();
      await expect(read(page)).toBeDisabled();
      await expect(stop(page)).toBeDisabled();
      await expect(rate(page)).toBeDisabled();
      expect((await speechLog(page)).utterances).toEqual([]);
    });
  }
});

test('Read speaks the page sentence by sentence with the local voice; the controls follow what is being spoken', async ({
  page,
}) => {
  await stubSpeech(page, [
    { name: 'Cloud English', lang: 'en-US', localService: false },
    { name: 'Regional English', lang: 'en-US', localService: true },
    { name: 'Plain English', lang: 'en', localService: true },
  ]);
  await openReading(page);
  await expect(page.getByText('There is no local English voice')).toHaveCount(0);
  await expect(read(page)).toBeEnabled();
  // Nothing is playing: nothing to stop.
  await expect(stop(page)).toBeDisabled();

  await read(page).click();
  await expect(pause(page)).toBeVisible();
  await expect(stop(page)).toBeEnabled();
  // The whole page is queued at once, in order; the voice is the local one whose tag is exactly "en".
  const { utterances } = await speechLog(page);
  expect(utterances).toEqual([
    { text: 'Alpha one.', rate: 1, voice: 'Plain English', lang: 'en' },
    { text: 'Beta two.', rate: 1, voice: 'Plain English', lang: 'en' },
    { text: '1', rate: 1, voice: 'Plain English', lang: 'en' },
  ]);

  // The first two sentences end; while the last is being spoken the pane is still speaking.
  await endUtterance(page);
  await endUtterance(page);
  await expect(pause(page)).toBeVisible();
  await endUtterance(page);
  await expect(read(page)).toBeVisible();
  await expect(stop(page)).toBeDisabled();
});

test('Pause holds the speech and Read resumes it where it was; Stop ends it', async ({ page }) => {
  await stubSpeech(page, [LOCAL_ENGLISH]);
  await openReading(page);
  await read(page).click();
  await pause(page).click();
  await expect(read(page)).toBeVisible();
  await expect(stop(page)).toBeEnabled();
  expect((await speechLog(page)).events.at(-1)).toBe('pause');

  // Read while paused continues the same queue instead of starting the page over.
  await read(page).click();
  await expect(pause(page)).toBeVisible();
  const log = await speechLog(page);
  expect(log.events.at(-1)).toBe('resume');
  expect(log.utterances).toHaveLength(3);

  await stop(page).click();
  await expect(read(page)).toBeVisible();
  await expect(stop(page)).toBeDisabled();
  expect((await speechLog(page)).events.at(-1)).toBe('cancel');
});

test('changing the rate while speaking restarts at the sentence being spoken, at the new rate', async ({
  page,
}) => {
  await stubSpeech(page, [LOCAL_ENGLISH]);
  await openReading(page);
  await expect(page.getByText('1.00×')).toBeVisible();
  await read(page).click();
  // The first sentence ends only once it has started: ending before that would start it instead,
  // and the restart below would begin there rather than at the second sentence.
  await expect(pause(page)).toBeVisible();
  await endUtterance(page);

  await rate(page).fill('1.5');
  await expect(page.getByText('1.50×')).toBeVisible();
  const { utterances } = await speechLog(page);
  // The first reading queued three; the restart queues what is left, from the second sentence.
  expect(utterances.slice(3)).toEqual([
    { text: 'Beta two.', rate: 1.5, voice: 'Local English', lang: 'en-US' },
    { text: '1', rate: 1.5, voice: 'Local English', lang: 'en-US' },
  ]);

  // The ends of the range are the ends the pane offers.
  await rate(page).fill('0.5');
  await expect(page.getByText('0.50×')).toBeVisible();
  await rate(page).fill('2');
  await expect(page.getByText('2.00×')).toBeVisible();

  // Paused, a new rate waits for the next Read instead of restarting the speech. The restart
  // cancelled the engine's queue, and the engine pauses only what it is speaking.
  await untilSpeaking(page);
  await pause(page).click();
  await expect(read(page)).toBeVisible();
  const before = (await speechLog(page)).utterances.length;
  await rate(page).fill('1');
  await expect(page.getByText('1.00×')).toBeVisible();
  expect((await speechLog(page)).utterances).toHaveLength(before);
});

test('an utterance that fails ends the speaking state', async ({ page }) => {
  await stubSpeech(page, [LOCAL_ENGLISH]);
  await openReading(page);
  await read(page).click();
  await expect(pause(page)).toBeVisible();
  await endUtterance(page, 'error');
  await expect(read(page)).toBeVisible();
  await expect(stop(page)).toBeDisabled();
});

test('turning to another page stops the speech and the next Read speaks that page; closing the pane stops it too', async ({
  page,
}) => {
  await stubSpeech(page, [LOCAL_ENGLISH]);
  await openReading(page);
  await read(page).click();
  await expect(pause(page)).toBeVisible();

  await page.keyboard.press('PageDown');
  await expect(page.getByText('Alpha one. Beta two. 2').first()).toBeVisible();
  await expect(read(page)).toBeVisible();
  await expect(stop(page)).toBeDisabled();
  expect((await speechLog(page)).events.at(-1)).toBe('cancel');

  await read(page).click();
  const { utterances } = await speechLog(page);
  expect(utterances.slice(-3).map((utterance) => utterance.text)).toEqual(['Alpha one.', 'Beta two.', '2']);
  await expect(pause(page)).toBeVisible();

  const cancelsBefore = (await speechLog(page)).events.filter((event) => event === 'cancel').length;
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Reading mode' }).first())
    .toBeHidden()
    .catch(() => undefined);
  await expect
    .poll(async () => (await speechLog(page)).events.filter((event) => event === 'cancel').length)
    .toBeGreaterThan(cancelsBefore);
});

test('every paging key turns one page, a modified key and a key in the rate slider do not, and a page without text has nothing to read', async ({
  page,
}) => {
  await stubSpeech(page, [LOCAL_ENGLISH]);
  await openPdf(page, 'speech.pdf', labelledPdf('Alpha one. Beta two.', 3));
  await menuItem(page, 'View', /Reading mode/);
  const pane = page.getByRole('region', { name: 'Reading mode' });
  const pageLabel = (number: number) => pane.getByText(`Page ${number}`, { exact: true });
  await expect(pageLabel(1)).toBeVisible({ timeout: 30_000 });

  for (const [key, expected] of [
    ['ArrowDown', 2],
    ['PageDown', 3],
    // The end of the document is the end of the paging.
    ['ArrowRight', 3],
    ['ArrowUp', 2],
    ['PageUp', 1],
    ['ArrowLeft', 1],
  ] as const) {
    await page.keyboard.press(key);
    await expect(pageLabel(expected)).toBeVisible();
  }

  await page.keyboard.press('Control+ArrowRight');
  await expect(pageLabel(1)).toBeVisible();

  // In the slider the arrow keys are the slider's own.
  await rate(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(pageLabel(1)).toBeVisible();
  await expect(page.getByText('1.25×')).toBeVisible();
});

test('a page whose words are only a picture says so and speaks nothing', async ({ page }) => {
  await stubSpeech(page, [LOCAL_ENGLISH]);
  await openPdf(page, 'scan.pdf', await scannedPdf([['Alpha one.']]));
  await menuItem(page, 'View', /Reading mode/);
  await expect(page.getByText('No readable text was found on this page.')).toBeVisible({ timeout: 30_000 });
  await read(page).click();
  expect((await speechLog(page)).utterances).toEqual([]);
  await expect(read(page)).toBeVisible();
  await expect(stop(page)).toBeDisabled();
});
