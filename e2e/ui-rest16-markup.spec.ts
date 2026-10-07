/**
 * A text markup over a selection that spans several text runs: the runs of one line become
 * one band of the mark, and each further line is a band of its own.
 */

import type { Page } from 'playwright/test';
import { expect, test } from './test';
import { drag, exportBytes, openPdf, rail } from './ui-helpers';
import { expectNear, ofSubtype, readAnnotations } from './ui-layers-helpers';
import { runsPdf } from './ui-rest16-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

const MARKUP_TOOL = 'Mark Up Text (highlight, underline, strike)';

/** Two runs on one baseline, a gap between them, and one run on the line below. */
const PDF = runsPdf([
  { text: 'Alpha', x: 72, y: 700 },
  { text: 'Omega', x: 300, y: 700 },
  { text: 'Beneath', x: 72, y: 640 },
]);

async function runBox(page: Page, text: string) {
  const box = await page.locator('.textLayer span').filter({ hasText: text }).first().boundingBox();
  if (box === null) throw new Error(`the text layer has no run ${text}`);
  return box;
}

/** Press at the left edge of `from` and release just inside the right edge of `to`. */
async function selectFromTo(page: Page, from: string, to: string): Promise<void> {
  const start = await runBox(page, from);
  const end = await runBox(page, to);
  await drag(
    page,
    { x: start.x + 1, y: start.y + start.height / 2 },
    { x: end.x + end.width - 0.25, y: end.y + end.height / 2 },
  );
}

test('a highlight over two runs of one line is one band; over two lines it is two bands', async ({
  page,
}) => {
  await openPdf(page, 'runs.pdf', PDF);
  await rail(page, MARKUP_TOOL).click();

  await selectFromTo(page, 'Alpha', 'Omega');
  await expect(page.locator('[data-ann]')).toHaveCount(1);
  const oneLine = ofSubtype(await readAnnotations(await exportBytes(page, 'one-line.pdf')), 'Highlight');
  expect(oneLine).toHaveLength(1);
  // One quad (eight numbers) that runs from the first run's left edge to the second run's right edge.
  expect(oneLine[0]?.quadPoints).toHaveLength(8);
  expectNear(oneLine[0]?.rect[0], 72, 3);
  expect(oneLine[0]?.rect[2] ?? 0).toBeGreaterThan(300 + 50);

  if ((await rail(page, MARKUP_TOOL).getAttribute('aria-pressed')) !== 'true')
    await rail(page, MARKUP_TOOL).click();
  await selectFromTo(page, 'Alpha', 'Beneath');
  await expect(page.locator('[data-ann]')).toHaveCount(2);
  const both = ofSubtype(await readAnnotations(await exportBytes(page, 'two-lines.pdf')), 'Highlight');
  expect(both).toHaveLength(2);
  // The second mark has a band per line: the long first line and the shorter line under it.
  const quads = both.map((mark) => mark.quadPoints.length).sort((a, b) => a - b);
  expect(quads).toEqual([8, 16]);
});
