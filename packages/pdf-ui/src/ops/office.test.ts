/**
 * The PDF → Word/Excel/CSV dialog: the CSV separator it pre-selects from the browser's
 * locale (Excel splits on `;` wherever the decimal mark is a comma, so a Turkish user
 * handed a comma file sees one column), and that the chosen separator, format and the
 * interface language's sheet names reach the export.
 */

import { createRequire } from 'node:module';
import { xlsxToHtml } from 'pdf-core/ops/convert-ooxml';
import { fixturePage, reportPage } from 'pdf-core/ops/layout-fixtures';
import { createTranslator } from 'pdf-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isVisible } from '../dialogs/fields';
import type { OpRunContext } from '../dialogs/types';

interface ZipReader {
  loadAsync(
    data: Uint8Array,
  ): Promise<{ file(name: string): { async(type: 'string'): Promise<string> } | null }>;
}

// pdf-core owns jszip; this package cannot resolve it.
const JSZip = createRequire(new URL('../../../pdf-core/package.json', import.meta.url))('jszip') as ZipReader;

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

  it('offers the Word layout only for Word, the exact layout first and by default', async () => {
    const dialog = await dialogIn('en-US');
    const layout = dialog.fields.find((candidate) => candidate.id === 'layout');
    expect(layout).toMatchObject({
      kind: 'radio',
      labelKey: 'export.office.layout',
      defaultValue: 'layout',
      visibleWhen: { field: 'format', equals: ['docx'] },
    });
    const options = layout !== undefined && 'options' in layout ? layout.options : [];
    expect(Array.isArray(options)).toBe(true);
    if (!Array.isArray(options)) return;
    expect(options.map((option) => option.value)).toEqual(['layout', 'flow', 'page-images']);
    expect(options[0]).toMatchObject({
      labelKey: 'export.office.layout.exact',
      hintKey: 'export.office.layout.exactHint',
    });
  });

  it('writes text boxes for the exact layout (also the default), one picture per page, or flowing text', async () => {
    const dialog = await dialogIn('en-US');
    const pdf = await fixturePage([{ text: 'Merhaba', x: 50, y: 400, size: 12 }]);
    const entries = (bytes: Uint8Array | undefined): string => new TextDecoder('latin1').decode(bytes);
    const documentOf = async (bytes: Uint8Array | undefined): Promise<string> =>
      (await (await JSZip.loadAsync(bytes ?? new Uint8Array())).file('word/document.xml')?.async('string')) ??
      '';

    // The exact layout is the choice, and what an unknown or missing value falls back to.
    const asked: Record<string, string>[] = [
      { scope: 'all', format: 'docx', layout: 'layout' },
      { scope: 'all', format: 'docx', layout: 'sideways' },
      { scope: 'all', format: 'docx' },
    ];
    for (const params of asked) {
      const exact = await dialog.run(params, contextFor(pdf));
      const document = await documentOf(exact.files[0]?.bytes);
      expect(document, JSON.stringify(params)).toContain('<wps:txbx');
      expect(document, JSON.stringify(params)).toContain('Merhaba');
      expect(
        exact.report.notes.map((entry) => entry.key),
        JSON.stringify(params),
      ).toContain('op.note.exportOffice.layout');
    }

    const pictures = await dialog.run(
      { scope: 'all', format: 'docx', layout: 'page-images' },
      contextFor(pdf),
    );
    expect(entries(pictures.files[0]?.bytes)).toContain('word/media/page1.png');
    expect(pictures.report.notes.map((entry) => entry.key)).toContain('op.note.exportOffice.pageImages');

    const flow = await dialog.run({ scope: 'all', format: 'docx', layout: 'flow' }, contextFor(pdf));
    expect(entries(flow.files[0]?.bytes)).not.toContain('word/media/');
    expect(await documentOf(flow.files[0]?.bytes)).not.toContain('<wps:txbx');
    expect(flow.report.notes.map((entry) => entry.key)).toContain('op.note.exportOffice.docxApproximate');
  });

  it('offers the scan languages with the exact layout, Turkish and English by default', async () => {
    const dialog = await dialogIn('en-US');
    const field = dialog.fields.find((candidate) => candidate.id === 'ocrLanguages');
    expect(field).toMatchObject({
      kind: 'checkboxList',
      labelKey: 'export.office.ocrLanguages',
      defaultValue: ['tur', 'eng'],
      visibleWhen: { field: 'layout', equals: ['layout'] },
    });
    const options = field !== undefined && 'options' in field ? field.options : [];
    expect(Array.isArray(options) ? options.map((option) => option.value) : []).toEqual(
      expect.arrayContaining(['tur', 'eng', 'deu']),
    );
  });

  it('offers the scan languages only with the exact Word layout, not for Excel or CSV', async () => {
    const dialog = await dialogIn('en-US');
    const field = dialog.fields.find((candidate) => candidate.id === 'ocrLanguages');
    expect(field).toBeDefined();
    if (field === undefined) return;
    const shown = (format: string) =>
      isVisible(field, { format, layout: 'layout', ocrLanguages: ['eng'] }, dialog.fields);
    expect(shown('docx')).toBe(true);
    // `layout` keeps its default while its own field is hidden, so the format has to hide this one too.
    expect(shown('xlsx')).toBe(false);
    expect(shown('csv')).toBe(false);
    expect(isVisible(field, { format: 'docx', layout: 'flow' }, dialog.fields)).toBe(false);
  });

  it('exports a page with text without reading it with OCR, whatever the scan languages', async () => {
    const dialog = await dialogIn('en-US');
    const pdf = await fixturePage([{ text: 'Merhaba', x: 50, y: 400, size: 12 }]);
    for (const ocrLanguages of [['tur', 'eng'], []]) {
      const result = await dialog.run(
        { scope: 'all', format: 'docx', layout: 'layout', ocrLanguages },
        contextFor(pdf),
      );
      const keys = result.report.notes.map((entry) => entry.key);
      expect(keys).toContain('op.note.exportOffice.layout');
      expect(keys).not.toContain('op.note.exportOffice.ocrPages');
      expect(keys).not.toContain('op.note.exportOffice.ocrUnavailable');
    }
  });
});
