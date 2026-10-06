/**
 * The scanner's page model and the work done on it.
 *
 * A page keeps the original photograph as a `Blob` (cheap to hold, and the only copy that
 * has every pixel), a reduced decode for everything on screen, and the choices that make it
 * a scan: four corners, a rotation, a filter. The corners are stored as fractions of the
 * picture so the same outline serves the reduced decode on screen and the full decode the
 * PDF is made from.
 */

import { decodePhoto, rasterToJpeg } from 'pdf-core/ops/scan-browser';
import { detectPage } from 'pdf-core/ops/scan-detect';
import {
  insetQuad,
  type Point,
  type Quad,
  type QuarterTurns,
  type RasterImage,
  scaleQuad,
} from 'pdf-core/ops/scan-geometry';
import { PAGE_LONG_SIDE, renderScanPage, type ScanFilter } from 'pdf-core/ops/scan-image';

/** What every page and every preview is decoded at: sharp on a phone, light enough for twenty pages. */
export const PREVIEW_SOURCE_SIDE = 1400;
/** The scanner keeps the memory it needs in check: a page is a photograph plus its decode. */
export const MAX_SCAN_PAGES = 40;

export interface ScanPageState {
  readonly id: number;
  readonly name: string;
  readonly blob: Blob;
  /** The reduced decode shown on screen and used for the outline. */
  readonly preview: RasterImage;
  /** Corners as fractions of the picture (0…1), clockwise from the top-left. */
  readonly quad: Quad;
  readonly turns: QuarterTurns;
  readonly filter: ScanFilter;
}

export interface Draft {
  readonly name: string;
  readonly blob: Blob;
  readonly preview: RasterImage;
  readonly quad: Quad;
  /** Whether the outline came from the detector (otherwise it is the inset default). */
  readonly detected: boolean;
}

export function normaliseQuad(quad: Quad, width: number, height: number): Quad {
  return scaleQuad(quad, 1 / width, 1 / height);
}

/** Decode a photograph and look for the page in it. */
export async function makeDraft(blob: Blob, name: string): Promise<Draft> {
  const { raster } = await decodePhoto(blob, PREVIEW_SOURCE_SIDE);
  const found = detectPage(raster);
  const quad = found === null ? insetQuad(raster.width, raster.height) : found.quad;
  return {
    name,
    blob,
    preview: raster,
    quad: normaliseQuad(quad, raster.width, raster.height),
    detected: found !== null,
  };
}

/** The corners again, from the picture's own pixels. */
export function redetect(preview: RasterImage): { readonly quad: Quad; readonly detected: boolean } {
  const found = detectPage(preview);
  return found === null
    ? {
        quad: normaliseQuad(insetQuad(preview.width, preview.height), preview.width, preview.height),
        detected: false,
      }
    : { quad: normaliseQuad(found.quad, preview.width, preview.height), detected: true };
}

/** A page as it looks on screen, no more than `longSide` px on its long side. */
export function renderPreview(page: ScanPageState, longSide: number): RasterImage | null {
  return renderScanPage(
    page.preview,
    scaleQuad(page.quad, page.preview.width, page.preview.height),
    page.turns,
    page.filter,
    longSide,
  );
}

export interface ExportedPage {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * The page the PDF is made of: the photograph decoded at full size, straightened, filtered
 * and encoded. Done one page at a time by the caller, so only one full-size decode is alive.
 */
export async function exportPage(page: ScanPageState, quality: number, index: number): Promise<ExportedPage> {
  const { raster } = await decodePhoto(page.blob);
  const rendered = renderScanPage(
    raster,
    scaleQuad(page.quad, raster.width, raster.height),
    page.turns,
    page.filter,
    PAGE_LONG_SIDE,
  );
  if (rendered === null) throw new RangeError(`the outline of page ${index + 1} has no area`);
  const jpeg = await rasterToJpeg(rendered, quality);
  return {
    name: `scan-${String(index + 1).padStart(3, '0')}.jpg`,
    bytes: new Uint8Array(await jpeg.arrayBuffer()),
    width: rendered.width,
    height: rendered.height,
  };
}

export const QUALITY_PRESETS = { low: 0.6, medium: 0.8, high: 0.92 } as const;
export type QualityPreset = keyof typeof QUALITY_PRESETS;

/** Move a corner, keeping it inside the picture. */
export function moveCorner(quad: Quad, index: number, to: Point): Quad {
  const next = quad.map((point, at) =>
    at === index ? { x: Math.min(1, Math.max(0, to.x)), y: Math.min(1, Math.max(0, to.y)) } : point,
  );
  return next as unknown as Quad;
}
