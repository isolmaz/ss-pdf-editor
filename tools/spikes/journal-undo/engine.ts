/**
 * The engine half of spike #2: pdf.js's **real** annotation storage.
 *
 * `PDFDocumentProxy.annotationStorage` (`build/pdf.mjs:16476-16477`) is the same
 * object the viewer's editors commit into — every `AnnotationEditorLayer` edit ends
 * in `annotationStorage.setValue(key, value)` (`build/pdf.mjs:6926`, called from
 * `build/pdf.mjs:3113` / `3498`) and `saveDocument()` serializes exactly that map
 * into the PDF (`build/pdf.mjs:16792-16804`). So the spike does not imitate the
 * bridge: it writes into the engine's own storage.
 *
 * Two things stay engine-side and are therefore *not* part of the persisted draft:
 *  - the `ImageBitmap` cache that pdf.js keeps in its `ImageManager`
 *    (`build/pdf.mjs:2280`+); `EngineImageCache` is this spike's stand-in, since
 *    the real manager needs an `AnnotationEditorUIManager` to construct, and
 *  - the `CommandManager` command/undo function pairs.
 */
import { openWithPdfjs, type PdfDocumentHandle } from 'pdf-core';
import type { JsonValue } from 'pdf-model';
import type { CanonicalView, OpTarget, PageState } from './ops';

/**
 * Structural view of pdf.js's `AnnotationStorage` (the class is not exported from
 * the package types, but every member used here is declared in
 * `types/src/display/annotation_storage.d.ts`).
 */
export interface PdfjsAnnotationStorage {
  getRawValue(key: string): object | undefined;
  setValue(key: string, value: object): void;
  remove(key: string): void;
  has(key: string): boolean;
  readonly size: number;
  [Symbol.iterator](): MapIterator<[string, object]>;
}

export interface OpenedEngine {
  readonly handle: PdfDocumentHandle;
  readonly storage: PdfjsAnnotationStorage;
  readonly storageConstructor: string;
  readonly openMs: number;
}

export async function openEngine(bytes: Uint8Array): Promise<OpenedEngine> {
  const started = performance.now();
  const handle = await openWithPdfjs(bytes);
  const storage = handle.raw.annotationStorage as unknown as PdfjsAnnotationStorage;
  return {
    handle,
    storage,
    storageConstructor: handle.raw.annotationStorage.constructor.name,
    openMs: performance.now() - started,
  };
}

/**
 * Spike stand-in for pdf.js `ImageManager`: engine-side only, holds decoded
 * bitmaps keyed by `bitmapId`, and is empty again after a reload.
 */
export class EngineImageCache {
  #entries = new Map<string, ImageBitmap>();
  decoded = 0;
  dropped = 0;

  get size(): number {
    return this.#entries.size;
  }

  has(bitmapId: string): boolean {
    return this.#entries.has(bitmapId);
  }

  async decodeInto(bitmapId: string, dataUrl: string): Promise<void> {
    if (this.#entries.has(bitmapId)) return;
    // Decoded straight from the journal's payload — no `fetch`, because the
    // production CSP (`connect-src 'self'`) forbids `fetch('data:…')`. Same reason
    // a real bridge must feed the engine from model data, not from a URL.
    const comma = dataUrl.indexOf(',');
    const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png';
    const binary = atob(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    this.#entries.set(bitmapId, bitmap);
    this.decoded += 1;
  }

  delete(bitmapId: string): void {
    const bitmap = this.#entries.get(bitmapId);
    if (!bitmap) return;
    bitmap.close();
    this.#entries.delete(bitmapId);
    this.dropped += 1;
  }

  ids(): string[] {
    return [...this.#entries.keys()].sort();
  }
}

function rasterOf(value: JsonValue): { bitmapId: string; dataUrl: string } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const bitmapId = value.bitmapId;
  const raster = value.raster;
  if (typeof bitmapId !== 'string' || raster === null || typeof raster !== 'object' || Array.isArray(raster))
    return null;
  const dataUrl = raster.dataUrl;
  return typeof dataUrl === 'string' ? { bitmapId, dataUrl } : null;
}

/** pdf.js `annotationStorage` + the working-version page order, in one target. */
export class EngineTarget implements OpTarget {
  readonly pages: PageState[];
  readonly images = new EngineImageCache();
  readonly storage: PdfjsAnnotationStorage;
  writes = 0;

  constructor(storage: PdfjsAnnotationStorage, pages: readonly PageState[]) {
    this.storage = storage;
    this.pages = pages.map((page) => ({ ...page }));
  }

  getAnnotation(key: string): JsonValue | undefined {
    return this.storage.getRawValue(key) as JsonValue | undefined;
  }

  setAnnotation(key: string, value: JsonValue): void {
    this.storage.setValue(key, value as object);
    this.writes += 1;
  }

  removeAnnotation(key: string): void {
    if (!this.storage.has(key)) return;
    this.storage.remove(key);
    this.writes += 1;
  }

  async ensureRaster(value: JsonValue): Promise<void> {
    const raster = rasterOf(value);
    if (!raster) return;
    await this.images.decodeInto(raster.bitmapId, raster.dataUrl);
  }

  dropRaster(value: JsonValue): void {
    const raster = rasterOf(value);
    if (raster) this.images.delete(raster.bitmapId);
  }

  /** The engine's committed view: what pdf.js itself would serialize on save. */
  view(): CanonicalView {
    const annotations: { key: string; value: JsonValue }[] = [];
    for (const [key, value] of this.storage) {
      if (typeof key !== 'string') continue;
      annotations.push({ key, value: value as JsonValue });
    }
    annotations.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    return {
      pages: this.pages.map((page) => ({ id: page.id, srcIndex: page.srcIndex, rotation: page.rotation })),
      annotations,
    };
  }
}
