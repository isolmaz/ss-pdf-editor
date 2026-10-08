/**
 * Free text is read back after it is written. The real writer writes what it is told to, so the
 * save is wrapped at the writer's module seam: the document is damaged in one chosen way just
 * before the bytes are made, and the read-back has to refuse the file.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument as Doc, type PDFDocument } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ damage: undefined as undefined | 'appearance' | 'marker' }));

vi.mock('../engines/mupdf-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf-write')>();
  return {
    ...actual,
    saveRewrite: (doc: PDFDocument, context?: string, options?: string) => {
      if (state.damage !== undefined) {
        for (let index = 1; index < doc.countObjects(); index += 1) {
          const object = doc.newIndirect(index).resolve();
          if (!object.isDictionary() || object.get('Subtype').isNull()) continue;
          if (object.get('Subtype').asName() !== 'FreeText') continue;
          if (state.damage === 'appearance') object.delete('AP');
          if (state.damage === 'marker') object.delete('NM');
        }
      }
      return actual.saveRewrite(doc, context, options);
    },
  };
});

const { writeFreeTextAnnotations } = await import('./annotation-freetext');

const mark = {
  id: 'text-1',
  kind: 'freetext' as const,
  pageIndex: 0,
  quads: [],
  rect: [72, 72, 292, 100] as [number, number, number, number],
  color: '#1a4dff',
  opacity: 1,
  contents: 'Merhaba',
  author: 'Deneme',
  createdAt: '2026-09-28T10:00:00.000Z',
  fontSize: 12,
};

beforeEach(() => {
  const file = createRequire(import.meta.url).resolve(
    '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
    { paths: [process.cwd()] },
  );
  const font = new Uint8Array(readFileSync(file));
  vi.stubGlobal('fetch', async () => new Response(font));
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.damage = undefined;
});

describe('free text read-back', () => {
  it.each(['appearance', 'marker'] as const)(
    'refuses a file whose annotation lost its %s',
    async (damage) => {
      const doc = new Doc();
      doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, {}, ''));
      const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
      doc.destroy();
      state.damage = damage;
      await expect(
        writeFreeTextAnnotations(bytes, [mark], { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ code: 'verification-failed' });
    },
  );
});
