/**
 * The PDF → Word/Excel/CSV dialog: the CSV separator it pre-selects from the browser's
 * locale (Excel splits on `;` wherever the decimal mark is a comma, so a Turkish user
 * handed a comma file sees one column), and that the chosen separator, format and the
 * interface language's sheet names reach the export.
 */

import { xlsxToHtml } from 'pdf-core/ops/convert-ooxml';
import { fixturePage, reportPage } from 'pdf-core/ops/layout-fixtures';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpRunContext } from '../dialogs/types';

/** The dialog loaded fresh, since its delimiter default is read when the module loads. */
async function dialogIn(language: string | undefined) {
  vi.resetModules();
  vi.stubGlobal('navigator', language === undefined ? undefined : { language });
  return (await import('./office')).exportOfficeDialog;
}

const delimiterDefault = (dialog: Awaited<ReturnType<typeof dialogIn>>) => {
  const field = dialog.fields.find((candidate) => candidate.id === 'delimiter');
  return field !== undefined && 'defaultValue' in field ? field.defaultValue : undefined;
};

const contextFor = (bytes: Uint8Array): OpRunContext => ({
  signal: new AbortController().signal,
  onProgress: () => {},
  bytes,
  pageCount: 1,
  name: 'rapor.pdf',
  currentPage: 0,
  selectedPages: [],
  t: createTranslator('tr'),
});

describe('export-office dialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pre-selects the semicolon where the decimal mark is a comma, and the comma elsewhere', async () => {
    for (const language of ['tr-TR', 'de-DE', 'fr-FR']) {
      expect(delimiterDefault(await dialogIn(language)), language).toBe('semicolon');
    }
    for (const language of ['en-US', 'ja-JP']) {
      expect(delimiterDefault(await dialogIn(language)), language).toBe('comma');
    }
    // No navigator (a worker, a test) or an invalid tag falls back to the comma.
    expect(delimiterDefault(await dialogIn(undefined))).toBe('comma');
    expect(delimiterDefault(await dialogIn('not a locale!'))).toBe('comma');
  });

  it('runs the export with the chosen separator, the interface language’s sheet names and a Word fallback', async () => {
    const dialog = await dialogIn('en-US');
    const csv = await dialog.run(
      { scope: 'all', format: 'csv', delimiter: 'semicolon' },
      contextFor(await reportPage()),
    );
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(csv.files?.[0]?.bytes);
    expect(csv.files?.[0]?.name).toBe('rapor.csv');
    expect(text).toBe('﻿Ürün;Adet;Fiyat\r\nElma;3;12,5\r\nÇay;5;8\r\n');
    expect(csv.report.pageCount).toBe(1);

    const xlsx = await dialog.run({ scope: 'all', format: 'xlsx' }, contextFor(await reportPage()));
    expect((await xlsxToHtml(xlsx.files?.[0]?.bytes ?? new Uint8Array(), 'r.xlsx')).parts[0]?.html).toContain(
      '<h2>Tablo 1</h2>',
    );

    // An unknown format value is Word, not a crash.
    const word = await dialog.run(
      { scope: 'all', format: 'odt' },
      contextFor(await fixturePage([{ text: 'Merhaba', x: 50, y: 400, size: 12 }])),
    );
    expect(word.files?.[0]?.name).toBe('rapor.docx');
  });

  it('offers the Word layout only for Word, flowing text first', async () => {
    const dialog = await dialogIn('en-US');
    const layout = dialog.fields.find((candidate) => candidate.id === 'layout');
    expect(layout).toMatchObject({
      kind: 'radio',
      labelKey: 'export.office.layout',
      defaultValue: 'flow',
      visibleWhen: { field: 'format', equals: ['docx'] },
    });
    const options = layout !== undefined && 'options' in layout ? layout.options : [];
    expect(Array.isArray(options)).toBe(true);
    if (!Array.isArray(options)) return;
    expect(options.map((option) => option.value)).toEqual(['flow', 'page-images']);
  });

  it('writes one picture per page when the layout says so, and flowing text for anything else', async () => {
    const dialog = await dialogIn('en-US');
    const pdf = await fixturePage([{ text: 'Merhaba', x: 50, y: 400, size: 12 }]);
    // A ZIP names its entries in plain text in their headers.
    const entries = (bytes: Uint8Array | undefined): string => new TextDecoder('latin1').decode(bytes);

    const pictures = await dialog.run(
      { scope: 'all', format: 'docx', layout: 'page-images' },
      contextFor(pdf),
    );
    expect(entries(pictures.files[0]?.bytes)).toContain('word/media/page1.png');
    expect(pictures.report.notes.map((entry) => entry.key)).toContain('op.note.exportOffice.pageImages');

    // Flowing text is the choice, and what an unknown or missing value falls back to.
    const asked: Record<string, string>[] = [
      { scope: 'all', format: 'docx', layout: 'flow' },
      { scope: 'all', format: 'docx', layout: 'sideways' },
      { scope: 'all', format: 'docx' },
    ];
    for (const params of asked) {
      const flow = await dialog.run(params, contextFor(pdf));
      expect(entries(flow.files[0]?.bytes), JSON.stringify(params)).not.toContain('word/media/');
      expect(
        flow.report.notes.map((entry) => entry.key),
        JSON.stringify(params),
      ).toContain('op.note.exportOffice.docxApproximate');
    }
  });
});
