/**
 * The measurement tool as a user meets it: the settings strip (mode, scale, unit, grid,
 * snapping, style, readout, stop), the click chain with its live reading, the keyboard
 * (Backspace, Escape, Enter), the grid drawn over the page, and the annotations the
 * export carries — read back with MuPDF, in page points.
 */

import type { Locator, Page } from 'playwright/test';
import { expect, test } from './test';
import { exportBytes, menuItem, openPdf } from './ui-helpers';
import {
  clickAt,
  expectNear,
  moveTo,
  ofSubtype,
  readAnnotations,
  type WrittenAnnotation,
} from './ui-layers-helpers';

test.use({ viewport: { width: 1440, height: 1000 } });

const STRIP = 'fieldset[aria-label="Tool settings"]';
const HINT = 'e.g. 1:100 · 1 cm = 5 m';

/** Points per centimetre of a 1:100 drawing: 72 pt per inch, 2.54 cm per inch, ratio 100. */
const POINTS_PER_CM = 72 / 2.54 / 100;

/** The product prints numbers with the Turkish locale: decimal comma, no grouping. */
function turkish(value: number, decimals: number): string {
  return new Intl.NumberFormat('tr', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  }).format(value);
}

function readout(page: Page): Locator {
  return page.locator(`${STRIP} output`);
}

function strip(page: Page): Locator {
  return page.locator(STRIP);
}

async function armMeasure(page: Page, mode: 'Distance' | 'Perimeter' | 'Area'): Promise<void> {
  await menuItem(page, 'Tools', mode);
  await expect(page.getByRole('application', { name: 'Measure', exact: true })).toBeVisible();
  await expect(strip(page).getByRole('button', { name: mode, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
}

function lengthOf(vertices: readonly number[], closed: boolean): number {
  let total = 0;
  const count = vertices.length / 2;
  for (let index = 1; index < count; index += 1) {
    total += Math.hypot(
      (vertices[index * 2] ?? 0) - (vertices[index * 2 - 2] ?? 0),
      (vertices[index * 2 + 1] ?? 0) - (vertices[index * 2 - 1] ?? 0),
    );
  }
  if (closed) {
    total += Math.hypot(
      (vertices[0] ?? 0) - (vertices[count * 2 - 2] ?? 0),
      (vertices[1] ?? 0) - (vertices[count * 2 - 1] ?? 0),
    );
  }
  return total;
}

function areaOf(vertices: readonly number[]): number {
  const count = vertices.length / 2;
  let twice = 0;
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    twice += (vertices[index * 2] ?? 0) * (vertices[next * 2 + 1] ?? 0);
    twice -= (vertices[next * 2] ?? 0) * (vertices[index * 2 + 1] ?? 0);
  }
  return Math.abs(twice) / 2;
}

function only(annotations: readonly WrittenAnnotation[], ...subtypes: string[]): WrittenAnnotation {
  const found = ofSubtype(annotations, ...subtypes);
  expect(found).toHaveLength(1);
  return found[0] as WrittenAnnotation;
}

test('a distance is read live at the pointer, and the exported line carries its points, scale and unit', async ({
  page,
}) => {
  await openPdf(page);
  await armMeasure(page, 'Distance');
  await expect(readout(page)).toHaveText(HINT);

  await clickAt(page, 100, 300);
  await moveTo(page, 300, 300);
  // 200 pt at 1:100 is 705,6 cm; the first segment points along +x.
  expect(200 / POINTS_PER_CM).toBeCloseTo(705.6, 1);
  await expect(readout(page)).toHaveText(/^705,\d cm · 0,0°$/);
  await clickAt(page, 300, 300);
  await page.keyboard.press('Enter');

  const mark = page.locator('button[data-measure]');
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveAttribute('aria-label', 'Distance');
  await expect(mark).toContainText(/^705,\d cm$/);
  await expect(readout(page)).toHaveText(HINT);

  const line = only(await readAnnotations(await exportBytes(page, 'distance.pdf')), 'Line');
  expect(line.pageIndex).toBe(0);
  expect(line.measureSubtype).toBe('RL');
  expect(line.measureRatio).toEqual([1, 100]);
  expect(line.measureUnit).toBe('cm');
  expect(line.contents).toMatch(/^705,\d cm$/);
  expect(line.line[0]).toBeCloseTo(100, 0);
  expect(line.line[1]).toBeCloseTo(300, 0);
  expect(line.line[2]).toBeCloseTo(300, 0);
  expect(line.line[3]).toBeCloseTo(300, 0);
});

test('the strip edits scale, unit, grid, snapping and style; the exported line carries each of them', async ({
  page,
}) => {
  await openPdf(page);
  await armMeasure(page, 'Distance');
  const bar = strip(page);

  // A scale the strip cannot read is named, and the previous scale stays in force.
  const scale = bar.getByRole('textbox', { name: 'Scale', exact: true });
  await scale.fill('1:50');
  await expect(scale).toHaveAttribute('aria-invalid', 'false');
  await scale.fill('1:abc');
  await expect(scale).toHaveAttribute('aria-invalid', 'true');
  await expect(bar.locator('span[role="status"]')).toHaveText(
    'Could not parse scale ratio; previous scale remains active.',
  );
  // The equation form names its own unit, and that unit wins.
  await scale.fill('1 cm = 5 m');
  await expect(scale).toHaveAttribute('aria-invalid', 'false');
  await expect(bar.locator('span[role="status"]')).toHaveCount(0);
  const unit = bar.getByRole('combobox', { name: 'Unit', exact: true });
  await expect(unit).toHaveValue('m');

  // Grid: one path per laid-out page; 50 pt spacing is 12 vertical and 17 horizontal lines.
  await bar.getByRole('checkbox', { name: 'Grid', exact: true }).check();
  await bar.getByRole('combobox', { name: 'Spacing', exact: true }).selectOption('50');
  const grid = page.locator('svg path[stroke-opacity="0.18"]').first();
  await expect(grid).toBeVisible();
  expect(((await grid.getAttribute('d')) ?? '').match(/M/g)).toHaveLength(12 + 17);
  await bar.getByRole('combobox', { name: 'Spacing', exact: true }).selectOption('100');
  await expect.poll(async () => ((await grid.getAttribute('d')) ?? '').match(/M/g)?.length).toBe(6 + 9);
  await bar.getByRole('combobox', { name: 'Spacing', exact: true }).selectOption('50');
  await bar.getByRole('checkbox', { name: 'Snap to grid', exact: true }).check();

  // Both clicks land off the lines and snap onto the 50 pt grid: (100, 292) and (250, 342).
  await clickAt(page, 112, 287);
  await moveTo(page, 263, 342);
  // 158,11 pt drawn is 5,578 cm of paper, 27,89 m at 1 cm = 5 m.
  await expect(readout(page)).toHaveText(/^27,89 m · 18,4°$/);
  // Changing the unit re-reads the chain being clicked: the same ratio in feet.
  await unit.selectOption('ft');
  await expect(readout(page)).toHaveText(/^91,50 ft · 18,4°$/);

  await bar.locator('input[type="color"]').fill('#ff0000');
  await bar.locator('input[type="range"]').fill('0.5');
  await bar.locator('input[type="number"]').fill('6');
  await bar.getByRole('textbox', { name: 'Author', exact: true }).fill('Ada');
  await clickAt(page, 263, 342);
  await page.keyboard.press('Enter');
  await expect(page.locator('button[data-measure]')).toContainText('91,50 ft');

  const line = only(await readAnnotations(await exportBytes(page, 'strip.pdf')), 'Line');
  // The grid counts from the page's top edge: 50 pt rows at 842 − 550 = 292 and 842 − 500 = 342.
  expect(line.line).toEqual([100, 292, 250, 342]);
  expect(line.contents).toBe('91,50 ft');
  expect(line.measureRatio).toEqual([1, 500]);
  expect(line.measureUnit).toBe('ft');
  expect(line.color).toEqual([1, 0, 0]);
  expect(line.opacity).toBe(0.5);
  expect(line.borderWidth).toBe(6);
  expect(line.author).toBe('Ada');
});

test('a grid denser than a few pixels is not drawn', async ({ page }) => {
  await openPdf(page);
  // 75 %: one page point is exactly one CSS pixel, so 5 pt lines are 5 px apart.
  await page.keyboard.press('Control+1');
  await page.keyboard.press('Control+-');
  await expect(page.getByRole('button', { name: /^Fit Width \(75%\)$/ })).toBeVisible();
  await armMeasure(page, 'Distance');
  const bar = strip(page);
  await bar.getByRole('checkbox', { name: 'Grid', exact: true }).check();
  await bar.getByRole('combobox', { name: 'Spacing', exact: true }).selectOption('100');
  const grid = page.locator('svg path[stroke-opacity="0.18"]').first();
  await expect(grid).toBeVisible();
  await bar.getByRole('combobox', { name: 'Spacing', exact: true }).selectOption('5');
  await expect(page.locator('svg path[stroke-opacity="0.18"]')).toHaveCount(0);
  await bar.getByRole('combobox', { name: 'Spacing', exact: true }).selectOption('10');
  await expect(grid).toBeVisible();
  expect(((await grid.getAttribute('d')) ?? '').match(/M/g)).toHaveLength(60 + 85);
  // Leaving the tool takes the grid off the page with it.
  await bar.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('svg path[stroke-opacity="0.18"]')).toHaveCount(0);
});

test('a perimeter snaps onto its own first point, Backspace takes the last point back and Escape clears the chain', async ({
  page,
}) => {
  await openPdf(page);
  await armMeasure(page, 'Perimeter');
  await strip(page).getByRole('checkbox', { name: 'Snap to endpoints', exact: true }).check();

  await clickAt(page, 50, 300);
  await moveTo(page, 150, 300);
  await expect(readout(page)).toHaveText(/^\d+(,\d)? cm · 0,0°$/);
  // Escape ends the chain, not the tool.
  await page.keyboard.press('Escape');
  await expect(readout(page)).toHaveText(HINT);
  await expect(page.getByRole('application', { name: 'Measure', exact: true })).toBeVisible();

  await clickAt(page, 100, 500);
  await clickAt(page, 200, 560);
  await clickAt(page, 300, 500);
  await clickAt(page, 400, 400);
  await page.keyboard.press('Backspace');
  // Four points were clicked and one taken back: three, plus the pointer at (400, 400).
  await moveTo(page, 300, 500);
  // Within 6 pt of the first point: the pointer is drawn onto it.
  await clickAt(page, 103, 498);
  await page.keyboard.press('Enter');

  await expect(page.locator('button[data-measure]')).toHaveAttribute('aria-label', 'Perimeter');
  const polyline = only(await readAnnotations(await exportBytes(page, 'perimeter.pdf')), 'PolyLine');
  expect(polyline.measureSubtype).toBe('P');
  expect(polyline.vertices).toHaveLength(8);
  // The fourth vertex is the first, to the bit: it was snapped, not clicked near.
  expect(polyline.vertices.slice(6, 8)).toEqual(polyline.vertices.slice(0, 2));
  expect(polyline.vertices[0]).toBeCloseTo(100, 0);
  expect(polyline.vertices[1]).toBeCloseTo(500, 0);
  expect(polyline.vertices[2]).toBeCloseTo(200, 0);
  expect(polyline.vertices[3]).toBeCloseTo(560, 0);
  expect(polyline.vertices[4]).toBeCloseTo(300, 0);
  expect(polyline.vertices[5]).toBeCloseTo(500, 0);
  expect(polyline.contents).toBe(`${turkish(lengthOf(polyline.vertices, false) / POINTS_PER_CM, 0)} cm`);
});

test('an area is a rectangle from two corners and a polygon from three; the reading carries area, boundary and bearing', async ({
  page,
}) => {
  await openPdf(page);
  await armMeasure(page, 'Area');

  // Two corners: a rectangle 200 × 100 pt.
  await clickAt(page, 100, 300);
  await moveTo(page, 300, 400);
  await expect(readout(page)).toHaveText(/^\d+(,\d)? cm² · \d+(,\d)? cm · \d+,\d°$/);
  await clickAt(page, 300, 400);
  await page.keyboard.press('Enter');
  await expect(page.locator('button[data-measure]')).toHaveCount(1);

  // Three corners, finished by a double click: a polygon.
  await clickAt(page, 100, 500);
  await clickAt(page, 300, 500);
  await clickAt(page, 100, 600, { clickCount: 2 });
  await expect(page.locator('button[data-measure]')).toHaveCount(2);

  const annotations = await readAnnotations(await exportBytes(page, 'areas.pdf'));
  const square = only(annotations, 'Square');
  expect(square.measureSubtype).toBe('A');
  expectNear(square.rect[0], 100 - 1);
  expectNear(square.rect[1], 300 - 1);
  expectNear(square.rect[2], 300 + 1);
  expectNear(square.rect[3], 400 + 1);
  expect(square.contents).toMatch(/^\d+ cm²$/);
  const polygon = only(annotations, 'Polygon');
  expect(polygon.measureSubtype).toBe('A');
  expect(polygon.vertices.length).toBeGreaterThanOrEqual(6);
  const squareCm = areaOf(polygon.vertices) / (POINTS_PER_CM * POINTS_PER_CM);
  expect(polygon.contents).toBe(`${turkish(squareCm, 0)} cm²`);
});

test('a chain belongs to one page; a click on another page does not extend it', async ({ page }) => {
  await openPdf(page);
  await armMeasure(page, 'Distance');

  await clickAt(page, 100, 300);
  // Bring the second page under the pointer and press there: the chain stays on page one.
  await page.locator('.pdfViewer[data-active-viewer] .page').nth(1).scrollIntoViewIfNeeded();
  await clickAt(page, 100, 700, { index: 1 });
  await page.locator('.pdfViewer[data-active-viewer] .page').first().scrollIntoViewIfNeeded();
  await clickAt(page, 300, 300);
  await page.keyboard.press('Enter');

  // A new measurement can start on page two.
  await page.locator('.pdfViewer[data-active-viewer] .page').nth(1).scrollIntoViewIfNeeded();
  await clickAt(page, 100, 700, { index: 1 });
  await clickAt(page, 400, 700, { index: 1 });
  await page.keyboard.press('Enter');

  const lines = ofSubtype(await readAnnotations(await exportBytes(page, 'pages.pdf')), 'Line');
  expect(lines.map((line) => line.pageIndex)).toEqual([0, 1]);
  expect(lines[0]?.line[0]).toBeCloseTo(100, 0);
  expect(lines[0]?.line[1]).toBeCloseTo(300, 0);
  expect(lines[0]?.line[2]).toBeCloseTo(300, 0);
  expect(lines[0]?.line[3]).toBeCloseTo(300, 0);
  expect(lines[1]?.line[0]).toBeCloseTo(100, 0);
  expect(lines[1]?.line[1]).toBeCloseTo(700, 0);
  expect(lines[1]?.line[2]).toBeCloseTo(400, 0);
  expect(lines[1]?.line[3]).toBeCloseTo(700, 0);
});

test('the strip switches mode, drops a half-clicked chain on stop, and the marks stay on the page', async ({
  page,
}) => {
  await openPdf(page);
  await armMeasure(page, 'Distance');
  await clickAt(page, 100, 300);
  await clickAt(page, 200, 300);
  await page.keyboard.press('Enter');
  await expect(page.locator('button[data-measure]')).toHaveCount(1);

  // Another mode from the strip keeps the tool armed.
  await strip(page).getByRole('button', { name: 'Perimeter', exact: true }).click();
  await expect(strip(page).getByRole('button', { name: 'Perimeter', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(strip(page).getByRole('button', { name: 'Distance', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await clickAt(page, 100, 400);
  await moveTo(page, 200, 420);
  await expect(readout(page)).not.toHaveText(HINT);

  // Pressing the armed mode again ends the tool: the half chain is gone, the mark stays.
  await strip(page).getByRole('button', { name: 'Perimeter', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Measure', exact: true })).toHaveCount(0);
  await expect(page.locator('button[data-measure]')).toHaveCount(1);
  await armMeasure(page, 'Perimeter');
  await expect(readout(page)).toHaveText(HINT);

  // The strip's own Close ends the tool the same way.
  await strip(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('application', { name: 'Measure', exact: true })).toHaveCount(0);
  await expect(page.locator('button[data-measure]')).toHaveCount(1);
});

test('Escape on an empty chain ends the tool', async ({ page }) => {
  await openPdf(page);
  await armMeasure(page, 'Area');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('application', { name: 'Measure', exact: true })).toHaveCount(0);
});
