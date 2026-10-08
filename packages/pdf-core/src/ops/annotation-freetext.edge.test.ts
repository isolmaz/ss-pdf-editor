/**
 * Free text boxes on marks and pages the main tests do not use: a mark with no size (the
 * default), a size outside the strip's range, whitespace that overflows the box, empty lines,
 * a mark with neither a box nor a quad, a page that already carries other annotations, and a
 * cancelled run.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument } from 'mupdf';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FREETEXT_DEFAULT_SIZE,
  FREETEXT_MAX_SIZE,
  FREETEXT_MIN_SIZE,
  FREETEXT_PADDING,
  freeTextSize,
  planFreeTextLayout,
  writeFreeTextAnnotations,
} from './annotation-freetext';
import type { AnnotationMark } from './annotations';

const run = { signal: new AbortController().signal };

function mark(overrides: Partial<AnnotationMark> = {}): AnnotationMark {
  return {
    id: 'text-1',
    kind: 'freetext',
    pageIndex: 0,
    quads: [],
    rect: [72, 72, 292, 100],
    color: '#1a4dff',
    opacity: 1,
    contents: 'Merhaba',
    author: 'Deneme',
    createdAt: '2026-09-28T10:00:00.000Z',
    fontSize: 12,
    ...overrides,
  };
}

function page(build: (doc: PDFDocument) => void = () => {}, pages = 1): Uint8Array {
  const doc = new PDFDocument();
  for (let index = 0; index < pages; index += 1)
    doc.insertPage(index, doc.addPage([0, 0, 595, 842], 0, {}, ''));
  build(doc);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

function subtypes(bytes: Uint8Array): string[] {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const annots = doc.findPage(0).get('Annots');
    return Array.from({ length: annots.length }, (_unused, index) =>
      annots.get(index).resolve().get('Subtype').asName(),
    );
  } finally {
    doc.destroy();
  }
}

describe('freeTextSize', () => {
  it('uses the default for a mark without a size and clamps one outside the range', () => {
    expect(freeTextSize(mark({ fontSize: undefined }))).toBe(FREETEXT_DEFAULT_SIZE);
    expect(freeTextSize(mark({ fontSize: 1 }))).toBe(FREETEXT_MIN_SIZE);
    expect(freeTextSize(mark({ fontSize: 500 }))).toBe(FREETEXT_MAX_SIZE);
    expect(freeTextSize(mark({ fontSize: 20 }))).toBe(20);
  });
});

describe('planFreeTextLayout', () => {
  it('drops the whitespace that would start a line instead of overflowing the box', () => {
    const measure = (value: string) => value.length;
    // The box holds 4 characters: "ab" fits, "ab      " does not, so the run of blanks is dropped.
    expect(planFreeTextLayout('ab      cd', 4 + 2 * FREETEXT_PADDING, 1, measure).lines).toEqual([
      'ab',
      'cd',
    ]);
  });
});

describe('writeFreeTextAnnotations edge cases', () => {
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
  });

  it('writes a box for a mark without a size, with empty lines kept in the text', async () => {
    const out = await writeFreeTextAnnotations(
      page(),
      [mark({ fontSize: undefined, contents: 'Bir\n\nÜç' })],
      run,
    );
    expect(out.written).toHaveLength(1);
    expect(subtypes(out.bytes)).toEqual(['FreeText']);
  });

  it('writes on one page of several and reads back past the pages without annotations', async () => {
    const out = await writeFreeTextAnnotations(
      page(() => {}, 3),
      [mark({ pageIndex: 1 })],
      run,
    );
    expect(out.written).toHaveLength(1);
  });

  it('takes the first quad as the box when the mark has no rectangle', async () => {
    const out = await writeFreeTextAnnotations(
      page(),
      [mark({ rect: undefined, quads: [[72, 72, 292, 72, 72, 100, 292, 100]] as never })],
      run,
    );
    expect(out.written).toHaveLength(1);
  });

  it('refuses a mark with neither a rectangle nor a quad', async () => {
    await expect(
      writeFreeTextAnnotations(page(), [mark({ rect: undefined, quads: [] })], run),
    ).rejects.toMatchObject({ code: 'selection-empty' });
  });

  it('writes beside annotations the page already has, and finds its own among them when it reads back', async () => {
    const input = page((doc) => {
      const target = doc.findPage(0);
      const link = doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10], P: target });
      const odd = doc.addObject(doc.newInteger(3));
      target.put('Annots', [link, odd]);
    });
    const out = await writeFreeTextAnnotations(input, [mark()], run);
    expect(subtypes(out.bytes).filter((subtype) => subtype === 'FreeText')).toHaveLength(1);
  });

  it('stops with an abort error for an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      writeFreeTextAnnotations(page(), [mark()], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
