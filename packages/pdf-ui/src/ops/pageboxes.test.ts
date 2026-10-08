import { describe, expect, it } from 'vitest';
import { firstLineOf, pageBoxesOf, pageSizesOf, runDialog, textPdf } from '../pdf-fixtures';
import { pageBoxesDialog } from './pageboxes';

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();
const two = () => textPdf([['hello box'], ['second']], [400, 600]);

describe('pageBoxesDialog', () => {
  it('sets the crop box from a corner and the extents, on the pages of the scope only', async () => {
    const result = await runDialog(
      pageBoxesDialog,
      { mode: 'set', box: 'crop', x: 10, y: 20, rectWidth: 200, rectHeight: 300, scope: 'range:2-2' },
      await two(),
    );
    expect(result.noticeKey).toBe('boxes.dialog.done');
    expect(result.noticeParams).toEqual({ count: 1 });
    expect((await pageBoxesOf(bytesOf(result), 0)).crop).toBeNull();
    expect((await pageBoxesOf(bytesOf(result), 1)).crop).toEqual([10, 20, 210, 320]);
  });

  it('resizes the pages to A4 around the content', async () => {
    const result = await runDialog(
      pageBoxesDialog,
      { mode: 'resize', width: 300, height: 400, fit: 'fit', marginMm: 0 },
      await two(),
    );
    expect(await pageSizesOf(bytesOf(result))).toEqual([
      [300, 400],
      [300, 400],
    ]);
  });

  it('scales the pages by a factor', async () => {
    const result = await runDialog(
      pageBoxesDialog,
      { mode: 'scale', factor: 0.5, scaleBoxes: true },
      await two(),
    );
    expect(await pageSizesOf(bytesOf(result))).toEqual([
      [200, 300],
      [200, 300],
    ]);
  });

  it('crops to the content with padding, and trims the trim box too when asked', async () => {
    const result = await runDialog(
      pageBoxesDialog,
      { mode: 'auto-crop', paddingMm: 2, alsoTrim: true },
      await two(),
    );
    const [width, height] = (await pageSizesOf(bytesOf(result)))[0] ?? [0, 0];
    expect(width).toBeLessThan(400);
    expect(height).toBeLessThan(600);
    expect((await pageBoxesOf(bytesOf(result))).trim).not.toBeNull();
  });

  it('shifts the content by millimetres', async () => {
    const before = await two();
    const result = await runDialog(pageBoxesDialog, { mode: 'shift', offsetXmm: 10, offsetYmm: -5 }, before);
    expect(result.noticeParams).toEqual({ count: 2 });
    const moved = await firstLineOf(bytesOf(result));
    const start = await firstLineOf(before);
    expect(moved.text).toBe('hello box');
    expect(moved.x - start.x).toBeCloseTo(28.35, 0);
    expect(Math.abs(moved.y - start.y)).toBeCloseTo(14.17, 0);
    expect(await pageSizesOf(bytesOf(result))).toEqual([
      [400, 600],
      [400, 600],
    ]);
  });

  it('turns the pages a quarter, so they show sideways', async () => {
    const result = await runDialog(pageBoxesDialog, { mode: 'rotate-content', degrees: '90' }, await two());
    expect((await pageBoxesOf(bytesOf(result))).rotate).toBe(90);
    expect(await pageSizesOf(bytesOf(result))).toEqual([
      [600, 400],
      [600, 400],
    ]);
  });
});
