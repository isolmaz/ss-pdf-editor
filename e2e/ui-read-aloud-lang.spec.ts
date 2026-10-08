/**
 * Reading mode's read-aloud looks for a local voice in the document's language: the catalog's
 * `/Lang` when it has one (the primary subtag is enough, so "de-DE" is read by a German voice of
 * any region), else the interface's language. The platform's speech engine is replaced by a
 * recording stand-in, so what is asserted is the voice and language the editor asked it to use.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { menuItem, openPdf } from './ui-helpers';
import { speechLog, stubSpeech } from './ui-panels9-helpers';

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ timeout: 180_000 });

/** A one-page document with one sentence, whose catalog carries `/Lang` only when `lang` is given. */
function sentencePdf(sentence: string, lang: string | null): Uint8Array {
  const content = `BT /F1 24 Tf 72 700 Td (${sentence}) Tj ET\n`;
  const bodies = [
    `<< /Type /Catalog /Pages 2 0 R${lang === null ? '' : ` /Lang (${lang})`} >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let source = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('');
  const xrefAt = source.length;
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${xref}`;
  source += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new Uint8Array([...source].map((character) => character.charCodeAt(0)));
}

const read = (page: Page): Locator =>
  page.locator('.pdf-reading-speech').getByRole('button', { name: 'Read', exact: true });
const stop = (page: Page): Locator =>
  page.locator('.pdf-reading-speech').getByRole('button', { name: 'Stop', exact: true });

async function openReading(page: Page, bytes: Uint8Array, sentence: string): Promise<void> {
  await openPdf(page, 'language.pdf', bytes);
  await menuItem(page, 'View', /Reading mode/);
  await expect(page.getByRole('region', { name: 'Reading mode' }).getByText(sentence)).toBeVisible({
    timeout: 30_000,
  });
}

test('an English interface and a document without /Lang are read with the local English voice', async ({
  page,
}) => {
  await stubSpeech(page, [{ name: 'Local English', lang: 'en-US', localService: true }]);
  await openReading(page, sentencePdf('Hello there.', null), 'Hello there.');
  await expect(page.getByText('read-aloud is unavailable')).toHaveCount(0);
  await expect(read(page)).toBeEnabled();

  await read(page).click();
  expect((await speechLog(page)).utterances).toEqual([
    { text: 'Hello there.', rate: 1, voice: 'Local English', lang: 'en-US' },
  ]);
});

test('a document whose catalog says /Lang de-DE is read with the German voice, not the interface-language one', async ({
  page,
}) => {
  await stubSpeech(page, [
    { name: 'Local English', lang: 'en-US', localService: true },
    { name: 'Cloud German', lang: 'de-DE', localService: false },
    { name: 'Local German', lang: 'de-DE', localService: true },
  ]);
  await openReading(page, sentencePdf('Hallo Welt.', 'de-DE'), 'Hallo Welt.');
  await expect(read(page)).toBeEnabled();

  // The document's language is read from the file a moment after it opens; until then the
  // interface's language (English) is the one in force, so each attempt starts from a stopped queue.
  await expect(async () => {
    if (await stop(page).isEnabled()) await stop(page).click();
    await read(page).click();
    expect((await speechLog(page)).utterances.at(-1)).toEqual({
      text: 'Hallo Welt.',
      rate: 1,
      voice: 'Local German',
      lang: 'de-DE',
    });
  }).toPass({ timeout: 15_000 });
});
