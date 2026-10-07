/**
 * Driving code shared by the `app-*.spec.ts` specs: open a document the way a user does,
 * stand in for the browser's file pickers with real (origin-private) file handles, read
 * what an export wrote, and run commands from the palette.
 *
 * The pickers are the one thing Playwright cannot drive: `showOpenFilePicker` and
 * `showSaveFilePicker` open a native dialog. The stand-ins hand the application a real
 * `FileSystemFileHandle` (OPFS), so the code under test still reads, compares and writes
 * a genuine file through the genuine API.
 */

import { readFileSync } from 'node:fs';
import type { Locator, Page } from 'playwright/test';
import { useAdvancedMode } from './settings';
import { expect, test } from './test';
import { toolFixturePdf } from './tool-fixture';

export const CANVAS = '.pdfViewer[data-active-viewer] .page canvas';

export const pdfFile = (name: string, bytes: Uint8Array, mimeType = 'application/pdf') => ({
  name,
  mimeType,
  buffer: Buffer.from(bytes),
});

/** A notice or status line carrying `text`. */
export const notice = (page: Page, text: string | RegExp): Locator =>
  page.locator('[role="status"]').filter({ hasText: text });

/** Wait for the shell to finish opening (the source is still being stored when the page shows). */
export async function settled(page: Page): Promise<void> {
  await expect(page.locator(CANVAS).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Opening the document…')).toHaveCount(0, { timeout: 30_000 });
}

/**
 * Open the file staged for the open picker with Ctrl+O and wait for it to show. The press is
 * repeated until the picker has taken the handle: one that lands before the shell has
 * attached its shortcuts does nothing, and a repeat after the take is a cancelled picker.
 */
export async function openStaged(page: Page): Promise<void> {
  await expect(async () => {
    await page.keyboard.press('Control+o');
    const waiting = await page.evaluate(() => {
      const picks: { open: unknown[] } = Reflect.get(window, '__picks');
      return picks.open.length;
    });
    expect(waiting).toBe(0);
  }).toPass({ timeout: 30_000 });
  await settled(page);
}

/** Open bytes through the home screen's file input; `advanced` switches the interface mode afterwards. */
export async function openApp(
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
  await settled(page);
  if (options.advanced !== false) await useAdvancedMode(page);
}

/** Run a command by name from the command palette (Ctrl+K). */
export async function palette(page: Page, command: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill(command);
  await page.keyboard.press('Enter');
}

/** Open a menu-bar menu and click one of its items. */
export async function menu(page: Page, name: string, item: string | RegExp): Promise<void> {
  await page.getByRole('menuitem', { name, exact: true }).click();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: item })
    .or(page.getByRole('menu').getByRole('menuitemcheckbox', { name: item }))
    .first()
    .click();
}

/** Export through the header button and read the downloaded bytes back. */
export async function exportBytes(page: Page, name: string): Promise<Uint8Array> {
  const download = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const path = test.info().outputPath(name);
  await (await download).saveAs(path);
  return new Uint8Array(readFileSync(path));
}

/**
 * Replace the browser's file pickers with queues of real OPFS file handles. Must run before
 * the page loads. `window.__picks.open` and `window.__picks.save` hold the handles the next
 * picker calls return; an empty queue is a cancelled picker (`AbortError`), exactly what the
 * browser throws when the user dismisses it. With `savePicker: false` the save picker is
 * removed altogether, which is how a browser without the File System Access API looks.
 */
export async function installPickers(
  page: Page,
  options: { readonly savePicker?: boolean } = {},
): Promise<void> {
  await page.addInitScript((withSave: boolean) => {
    const picks: { open: unknown[]; save: unknown[] } = { open: [], save: [] };
    const pick = (queue: unknown[]) => async () => {
      const next = queue.shift();
      if (next === undefined) throw new DOMException('The user aborted a request.', 'AbortError');
      return next;
    };
    Object.assign(window, {
      __picks: picks,
      showOpenFilePicker: async () => [await pick(picks.open)()],
    });
    if (withSave) Object.assign(window, { showSaveFilePicker: pick(picks.save) });
    else Reflect.deleteProperty(window, 'showSaveFilePicker');
  }, options.savePicker !== false);
}

/** Create (or overwrite) a real file in the origin-private file system and queue its handle for a picker. */
export async function stageFile(
  page: Page,
  queue: 'open' | 'save',
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  await page.evaluate(
    async ({ queue, name, bytes }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('e2e-files', { create: true });
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(new Uint8Array(bytes));
      await writable.close();
      const picks: Record<string, unknown[]> = Reflect.get(window, '__picks');
      picks[queue]?.push(handle);
    },
    { queue, name, bytes: [...bytes] },
  );
}

/** Overwrite a staged file behind the application's back. */
export async function rewriteFile(page: Page, name: string, bytes: Uint8Array): Promise<void> {
  await page.evaluate(
    async ({ name, bytes }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('e2e-files');
      const handle = await dir.getFileHandle(name);
      const writable = await handle.createWritable();
      await writable.write(new Uint8Array(bytes));
      await writable.close();
    },
    { name, bytes: [...bytes] },
  );
}

/** What a staged file holds now. */
export async function readFile(page: Page, name: string): Promise<Uint8Array> {
  const values = await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('e2e-files');
    const handle = await dir.getFileHandle(name);
    return [...new Uint8Array(await (await handle.getFile()).arrayBuffer())];
  }, name);
  return new Uint8Array(values);
}

/** Rotate the page on screen from the status bar (a real, journaled page action). */
export async function rotateCurrentPage(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Rotate Page (90°)', exact: true }).click();
  await expect(notice(page, 'Applied')).toBeVisible({ timeout: 30_000 });
}

/** The first page's painted box on screen, and the scale from page points to client pixels. */
export interface PageFrame {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export async function pageFrame(page: Page, width = 595, index = 0): Promise<PageFrame> {
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
  return { x: box.x, y: box.y, scale: box.width / width };
}

/** A page point (PDF user space, origin bottom-left, page height `height`) as a client point. */
export function atPage(frame: PageFrame, x: number, y: number, height = 842): { x: number; y: number } {
  return { x: frame.x + x * frame.scale, y: frame.y + (height - y) * frame.scale };
}

/** A press, a travel and a release between two page points of the first page. */
export async function dragOnPage(
  page: Page,
  from: readonly [number, number],
  to: readonly [number, number],
  size: { readonly width: number; readonly height: number } = { width: 595, height: 842 },
): Promise<void> {
  const frame = await pageFrame(page, size.width);
  const start = atPage(frame, from[0], from[1], size.height);
  const end = atPage(frame, to[0], to[1], size.height);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

/** Click one page point of the first page. */
export async function clickOnPage(
  page: Page,
  x: number,
  y: number,
  size: { readonly width: number; readonly height: number } = { width: 595, height: 842 },
): Promise<void> {
  const frame = await pageFrame(page, size.width);
  const point = atPage(frame, x, y, size.height);
  await page.mouse.click(point.x, point.y);
}

/** The tools-rail button with this accessible name. */
export function rail(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: true });
}
