/**
 * Fixture generation for spike #2.
 *
 * The document is built **in code** with MuPDF at run time and never committed
 * (`tools/spikes/**` is throwaway, `PLAN.md §9/K21`); the draft that this spike
 * persists into IndexedDB deliberately does **not** contain these bytes.
 *
 * Identity across the reload: MuPDF writes neither a date nor an `/ID` of its own
 * (measured: two builds a second apart hash the same), so the raw SHA-256 already
 * proves phase 2 recreated the same base document. The date-normalized hash is still
 * reported next to it — it was the proof while this fixture was written with pdf-lib,
 * which stamped the save time into every file.
 */

import { loadMupdf } from '../load-mupdf';
import { createFixture } from '../mupdf-fixture.mjs';

export const FIXTURE_PAGE_COUNT = 12;

export interface Fixture {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly bytesLength: number;
  readonly sha256: string;
  readonly sha256Identity: string;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Replace a save-time date, should a writer stamp one, so two runs can be compared. */
export function identityText(bytes: Uint8Array): string {
  const text = new TextDecoder('latin1').decode(bytes);
  return text.replace(/\/(ModificationDate|ModDate)\s*\([^)]*\)/g, '/$1 (D:FIXED)');
}

/**
 * 12 A4 pages of deterministic ASCII text. Standard-14 fonts encode WinAnsi only,
 * so Turkish glyphs (ş, ğ, ı) cannot be drawn without an embedded OFL font — this
 * spike is about the journal, so it stays ASCII on purpose.
 */
export async function buildFixture(pageCount: number = FIXTURE_PAGE_COUNT): Promise<Fixture> {
  const document = createFixture(await loadMupdf());
  document.info({
    Title: 'PDF Editor Phase 0 spike #2 fixture',
    Author: 'isolmaz',
    Producer: 'pdf-editor spike #2',
    CreationDate: 'D:19700101000000Z',
    ModDate: 'D:19700101000000Z',
  });

  const lines = [
    'Single chronological journal spike: 150 operations, undo, redo, draft persist, reopen.',
    'The engine history cannot be the store: its commands are function objects.',
    'An image stamp payload is a data URL that lives in the journal, not in the engine.',
    'Page operations (rotate, reorder) are recorded as model entries in the same journal.',
  ];

  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage(595.28, 841.89);
    page.text(`Page ${index + 1} / ${pageCount}`, {
      x: 60,
      y: 760,
      size: 18,
      color: [0.1, 0.15, 0.3],
    });
    for (let line = 0; line < 10; line += 1) {
      const text = lines[(index + line) % lines.length] ?? '';
      page.text(`${text}  (${index + 1}.${line + 1})`, {
        x: 60,
        y: 720 - line * 22,
        size: 9,
        color: [0.15, 0.15, 0.15],
      });
    }
    page.rect({ x: 60, y: 400, width: 200, height: 60, color: [0.9, 0.93, 0.98] });
    page.text('SIGNATURE', { x: 70, y: 425, size: 14, color: [0.2, 0.3, 0.6] });
  }

  const bytes = document.save();
  return {
    bytes,
    pageCount: document.pages.length,
    bytesLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    sha256Identity: await sha256Hex(identityText(bytes)),
  };
}

export interface StampRaster {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly dataUrlBytes: number;
  readonly sha256: string;
}

/**
 * The stamp's pixel payload, produced as a PNG data URL — the form the journal
 * stores. pdf.js's own `StampEditor.serialize()` emits `bitmapId` plus (during a
 * save) an `ImageBitmap` whose pixels live in the engine's `ImageManager`; the
 * point of this spike is that the *model* keeps the raster itself.
 */
export async function buildStampRaster(): Promise<StampRaster> {
  const width = 200;
  const height = 80;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#1d4ed8';
  context.lineWidth = 6;
  context.strokeRect(3, 3, width - 6, height - 6);
  context.fillStyle = '#1d4ed8';
  context.font = 'bold 30px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('APPROVED', width / 2, height / 2);
  const dataUrl = canvas.toDataURL('image/png');
  return {
    dataUrl,
    width,
    height,
    dataUrlBytes: dataUrl.length,
    sha256: await sha256Hex(dataUrl),
  };
}
