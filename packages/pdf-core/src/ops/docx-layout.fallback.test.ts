/**
 * The layout writer's safety net: a page `readPageScene` fails on is written as one picture
 * under its text boxes, and the other pages are untouched.
 */

import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { writeLayoutDocx } from './docx-layout';
import { circle, line, officeDocument } from './export-office-fixtures';
import * as reader from './layout-scene-read';
import type { OperationContext } from './types';

vi.mock('./layout-scene-read', async (importOriginal) => {
  const original = await importOriginal<typeof import('./layout-scene-read')>();
  return { ...original, readPageScene: vi.fn(original.readPageScene) };
});

const run: OperationContext = { signal: new AbortController().signal };

describe('exact layout: a page the shape reader fails on', () => {
  it('becomes one picture with its text boxes, and the next page is read as shapes', async () => {
    const original = vi.mocked(reader.readPageScene).getMockImplementation();
    vi.mocked(reader.readPageScene).mockImplementationOnce(() => {
      throw new RangeError('a drawing nobody foresaw');
    });
    const bytes = await officeDocument([
      {
        content: [
          '0.9 0.2 0.2 rg 40 400 120 60 re f',
          line('helvetica', 12, 60, 200, 'Words stay text'),
        ].join('\n'),
      },
      { content: [circle(100, 100, 30), line('helvetica', 12, 60, 300, 'Second page')].join('\n') },
    ]);
    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, bytes);
    try {
      // An external link on the first page, an internal one beside it: only the external one is carried.
      doc.findPage(0).put('Annots', [
        doc.addObject({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [60, 195, 250, 215],
          Border: [0, 0, 0],
          A: { S: 'URI', URI: '(https://example.com/fallback)' },
        }),
        doc.addObject({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [60, 295, 250, 315],
          Border: [0, 0, 0],
          Dest: [doc.findPage(1), 'Fit'],
        }),
      ]);
      const result = await writeLayoutDocx(doc, [0, 1], 'Plan', 'en-US', run);
      // Page one: a picture and a text box, no shapes; page two: its circle as a shape and its text.
      expect(result).toMatchObject({ rasters: 1, boxes: 2 });
      expect(result.shapes).toBeGreaterThanOrEqual(1);
      const zip = await JSZip.loadAsync(result.bytes);
      const names = Object.keys(zip.files).filter((name) => name.startsWith('word/media/'));
      expect(names.some((name) => name.endsWith('.png'))).toBe(true);
      const xml = (await (zip.file('word/document.xml') as JSZip.JSZipObject).async('string')).replace(
        /<[^>]+>/g,
        '',
      );
      expect(xml).toContain('Words stay text');
      expect(xml).toContain('Second page');
      const rels = await (zip.file('word/_rels/document.xml.rels') as JSZip.JSZipObject).async('string');
      expect(rels).toContain('Target="https://example.com/fallback"');
      expect(rels.match(/relationships\/hyperlink/g)).toHaveLength(1);
    } finally {
      doc.destroy();
      if (original !== undefined) vi.mocked(reader.readPageScene).mockImplementation(original);
    }
  });
});
