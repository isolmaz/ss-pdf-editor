/**
 * The scanner's page work that starts from a photograph: the draft the crop screen opens (the
 * detector's corners, or the inset default when it finds no page), the on-screen render, and the
 * export a PDF page is made from. The browser's decoder and JPEG encoder are the fakes of
 * `scan.fixtures.ts`; the detector, the warp and the filters are the real ones.
 */

import type { Quad } from 'pdf-core/ops/scan-geometry';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { brokenPhoto, decodeFake, PAGE_FRACTIONS, photo } from './scan.fixtures';
import {
  exportPage,
  makeDraft,
  PREVIEW_SOURCE_SIDE,
  QUALITY_PRESETS,
  renderPreview,
  type ScanPageState,
} from './scan-pages';

const browser = vi.hoisted(() => ({ decodes: [] as Array<{ blob: Blob; maxSide: number | undefined }> }));

vi.mock('pdf-core/ops/scan-browser', async () => {
  // A static import is not initialised yet when vitest hoists this factory above the imports.
  const fixtures = await import('./scan.fixtures');
  return {
    decodePhoto: (blob: Blob, maxSide?: number) => {
      browser.decodes.push({ blob, maxSide });
      return fixtures.decodeFake(blob);
    },
    rasterToJpeg: async (raster: { width: number; height: number }, quality: number) =>
      new Blob([`jpeg:${raster.width}x${raster.height}@${quality}`], { type: 'image/jpeg' }),
  };
});

beforeEach(() => {
  browser.decodes.length = 0;
});

const WHOLE: Quad = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];
const NOTHING: Quad = [
  { x: 0.5, y: 0.5 },
  { x: 0.5, y: 0.5 },
  { x: 0.5, y: 0.5 },
  { x: 0.5, y: 0.5 },
];

async function pageOf(quad: Quad, overrides: Partial<ScanPageState> = {}): Promise<ScanPageState> {
  const blob = photo('page', 400, 300);
  const { raster } = await decodeFake(blob);
  return { id: 1, name: 'one.jpg', blob, preview: raster, quad, turns: 0, filter: 'original', ...overrides };
}

describe('makeDraft', () => {
  it('opens a photograph at the preview size with the corners the detector found, as fractions', async () => {
    const blob = photo('page', 400, 300);
    const draft = await makeDraft(blob, 'desk.jpg');
    expect(browser.decodes).toEqual([{ blob, maxSide: PREVIEW_SOURCE_SIDE }]);
    expect(draft.name).toBe('desk.jpg');
    expect(draft.blob).toBe(blob);
    expect(draft.preview.width).toBe(400);
    expect(draft.preview.height).toBe(300);
    expect(draft.detected).toBe(true);
    const wanted = [
      [PAGE_FRACTIONS.left, PAGE_FRACTIONS.top],
      [PAGE_FRACTIONS.right, PAGE_FRACTIONS.top],
      [PAGE_FRACTIONS.right, PAGE_FRACTIONS.bottom],
      [PAGE_FRACTIONS.left, PAGE_FRACTIONS.bottom],
    ] as const;
    for (const [index, [x, y]] of wanted.entries()) {
      expect(Math.abs((draft.quad[index]?.x ?? 9) - x)).toBeLessThan(0.01);
      expect(Math.abs((draft.quad[index]?.y ?? 9) - y)).toBeLessThan(0.01);
    }
  });

  it('offers the inset outline, marked as not detected, when the photograph shows no page', async () => {
    const draft = await makeDraft(photo('plain', 200, 100), 'blank.jpg');
    expect(draft.detected).toBe(false);
    expect(draft.quad[0].x).toBeCloseTo(0.06, 9);
    expect(draft.quad[0].y).toBeCloseTo(0.06, 9);
    expect(draft.quad[2].x).toBeCloseTo(0.94, 9);
    expect(draft.quad[2].y).toBeCloseTo(0.94, 9);
  });

  it('rejects for a file the browser cannot decode', async () => {
    await expect(makeDraft(brokenPhoto(), 'notes.jpg')).rejects.toThrow(
      'the browser could not decode the photograph',
    );
  });
});

describe('renderPreview', () => {
  it('straightens the outlined page to the requested long side, keeping its proportions', async () => {
    const page = await pageOf([
      { x: PAGE_FRACTIONS.left, y: PAGE_FRACTIONS.top },
      { x: PAGE_FRACTIONS.right, y: PAGE_FRACTIONS.top },
      { x: PAGE_FRACTIONS.right, y: PAGE_FRACTIONS.bottom },
      { x: PAGE_FRACTIONS.left, y: PAGE_FRACTIONS.bottom },
    ]);
    const rendered = renderPreview(page, 110);
    // The outlined page is 240 x 220 px: its long side is cut to 110, the short one follows.
    expect(rendered?.width).toBe(110);
    expect(rendered?.height).toBe(101);
  });

  it('has no picture for an outline with no area', async () => {
    expect(renderPreview(await pageOf(NOTHING), 110)).toBeNull();
  });
});

describe('exportPage', () => {
  it('decodes the photograph at full size and returns the JPEG of the straightened page, numbered', async () => {
    const page = await pageOf(WHOLE);
    const exported = await exportPage(page, QUALITY_PRESETS.high, 2);
    // No size limit is passed: the export decodes every pixel the photograph has.
    expect(browser.decodes).toEqual([{ blob: page.blob, maxSide: undefined }]);
    expect(exported.name).toBe('scan-003.jpg');
    expect(exported.width).toBe(400);
    expect(exported.height).toBe(300);
    expect(new TextDecoder().decode(exported.bytes)).toBe('jpeg:400x300@0.92');
  });

  it('names the page whose outline has no area', async () => {
    await expect(exportPage(await pageOf(NOTHING), 0.8, 1)).rejects.toThrow(
      'the outline of page 2 has no area',
    );
  });
});
