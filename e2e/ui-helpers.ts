/**
 * Shared driving code of the `ui-*.spec.ts` component specs: open a document, export it
 * and read the bytes back, run a command from the palette, and turn page points into
 * client points. Everything here goes through the controls a user touches.
 */

import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import type { Locator, Page } from 'playwright/test';
import { useAdvancedMode } from './settings';
import { expect, test } from './test';
import { FIXTURE_PAGE, toolFixturePdf } from './tool-fixture';

export const CANVAS = '.pdfViewer[data-active-viewer] .page canvas';

export const pdfFile = (name: string, bytes: Uint8Array) => ({
  name,
  mimeType: 'application/pdf',
  buffer: Buffer.from(bytes),
});

/** Open bytes through the home screen's input and wait until the shell finished opening them. */
export async function openPdf(
  page: Page,
  name = 'doc.pdf',
  bytes: Uint8Array = toolFixturePdf(),
  options: { readonly advanced?: boolean; readonly navigate?: boolean } = {},
): Promise<void> {
  if (options.navigate !== false) await page.goto('/editor/');
  await page
    .locator('input[type="file"][accept*="application/pdf"]')
    .first()
    .setInputFiles(pdfFile(name, bytes));
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Opening the document…')).toHaveCount(0, { timeout: 30_000 });
  if (options.advanced !== false) await useAdvancedMode(page);
}

/** Export through the header button and read the downloaded bytes back. */
export async function exportBytes(page: Page, name: string): Promise<Uint8Array> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const path = test.info().outputPath(name);
  await (await download).saveAs(path);
  return new Uint8Array(readFileSync(path));
}

/** Run a command by name from the command palette (Ctrl+K). */
export async function runCommand(page: Page, command: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill(command);
  await page.keyboard.press('Enter');
}

/** Open a menu-bar menu and click one of its items. */
export async function menuItem(page: Page, menu: string, item: string | RegExp): Promise<void> {
  await page.getByRole('menuitem', { name: menu, exact: true }).click();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: item })
    .or(page.getByRole('menu').getByRole('menuitemcheckbox', { name: item }))
    .first()
    .click();
}

export interface PageFrame {
  readonly box: { readonly x: number; readonly y: number };
  readonly scale: number;
}

/** The first page's painted box, once the tool settings are not locked. */
export async function pageFrame(page: Page, size = FIXTURE_PAGE, index = 0): Promise<PageFrame> {
  await expect(page.locator(CANVAS).nth(index)).toBeVisible();
  const box = await page
    .locator('.pdfViewer[data-active-viewer] .page')
    .nth(index)
    .evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.x + element.clientLeft,
        y: bounds.y + element.clientTop,
        width: element.clientWidth,
      };
    });
  return { box, scale: box.width / size.width };
}

/** A page point (PDF user space, origin bottom-left) as a client point. */
export function toClient(
  frame: PageFrame,
  x: number,
  y: number,
  size: { readonly height: number } = FIXTURE_PAGE,
): { x: number; y: number } {
  return { x: frame.box.x + x * frame.scale, y: frame.box.y + (size.height - y) * frame.scale };
}

/** A press, a travel and a release. */
export async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
}

/** Drag between two page points of the first page. */
export async function dragPage(
  page: Page,
  from: readonly [number, number],
  to: readonly [number, number],
  steps = 12,
): Promise<void> {
  const frame = await pageFrame(page);
  await drag(page, toClient(frame, from[0], from[1]), toClient(frame, to[0], to[1]), steps);
}

/** Click one page point of the first page. */
export async function clickPage(page: Page, x: number, y: number): Promise<void> {
  const frame = await pageFrame(page);
  const point = toClient(frame, x, y);
  await page.mouse.click(point.x, point.y);
}

/** A button of the tools rail, by its accessible name. */
export function rail(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}

/** A dock tab, by its label. */
export async function openDockTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** An RGB PNG, deflated and checksummed here (the repository root has no image library). */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) row.set(pixel(x, y), 1 + x * 3);
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A white field with a dark diagonal bar: the shape of a photographed signature. */
export function inkPng(
  width = 120,
  height = 40,
  ink: readonly [number, number, number] = [20, 20, 20],
): Buffer {
  return encodePng(width, height, (x, y) => {
    const onBar = x > 10 && x < width - 10 && Math.abs(y - ((x - 10) * (height - 10)) / (width - 20) - 5) < 2;
    return onBar ? ink : [255, 255, 255];
  });
}

/**
 * A photograph of a sheet of paper on a dark desk: a white page with text-like dark lines,
 * its corners at the given fractions of the picture (clockwise from the top-left).
 */
export function sheetPhotoPng(
  corners: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ] = [
    [0.15, 0.1],
    [0.85, 0.12],
    [0.82, 0.9],
    [0.18, 0.88],
  ],
  width = 600,
  height = 800,
): Buffer {
  const quad = corners.map(([x, y]) => [x * width, y * height] as const);
  const inside = (px: number, py: number): boolean => {
    let sign = 0;
    for (let index = 0; index < 4; index += 1) {
      const a = quad[index] as readonly [number, number];
      const b = quad[(index + 1) % 4] as readonly [number, number];
      const cross = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
      if (cross !== 0) {
        if (sign === 0) sign = Math.sign(cross);
        else if (Math.sign(cross) !== sign) return false;
      }
    }
    return true;
  };
  return encodePng(width, height, (x, y) => {
    if (!inside(x, y)) return [38, 30, 26];
    // Lines of text on the paper.
    if (y % 40 < 6 && x % 90 < 70 && y > height * 0.2 && y < height * 0.8) return [30, 30, 30];
    return [244, 244, 240];
  });
}
