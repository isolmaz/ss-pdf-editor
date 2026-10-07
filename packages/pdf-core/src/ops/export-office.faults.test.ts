/**
 * The export reads its own output back with independent readers (mammoth for the DOCX, the
 * RFC 4180 parser for the CSV) and takes a picture from MuPDF's drawing of it. The real
 * readers agree with the writer, so these tests wrap them at their module seams: the bytes
 * are real, but the reader fails, miscounts, or cannot draw. The export must then refuse to
 * hand back a file it could not confirm (`verification-failed`), and leave out a picture that
 * could not be drawn instead of writing a broken one.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { circle, line, officeDocument, picture } from './export-office-fixtures';

const state: {
  mammoth: 'real' | 'throw' | 'throw-text' | 'short';
  csvRows: number | null;
  dropPng: boolean;
} = {
  mammoth: 'real',
  csvRows: null,
  dropPng: false,
};

vi.mock('mammoth', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof import('mammoth') }>();
  const extractRawText: (typeof actual.default)['extractRawText'] = async (input) => {
    if (state.mammoth === 'throw') throw new Error('the reader broke');
    if (state.mammoth === 'throw-text') throw 'plain text failure';
    if (state.mammoth === 'short') return { value: 'one', messages: [] };
    return actual.default.extractRawText(input);
  };
  return { ...actual, default: { ...actual.default, extractRawText } };
});

vi.mock('./convert-text', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./convert-text')>();
  return {
    ...actual,
    parseCsv: (text: string, delimiter: string) => {
      const rows = actual.parseCsv(text, delimiter);
      return state.csvRows === null ? rows : rows.slice(0, state.csvRows);
    },
  };
});

vi.mock('./page-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./page-layout')>();
  return {
    ...actual,
    readPageLayout: (...args: Parameters<typeof actual.readPageLayout>) => {
      const layout = actual.readPageLayout(...args);
      if (!state.dropPng) return layout;
      return {
        ...layout,
        blocks: layout.blocks.map((block) => (block.kind === 'image' ? { ...block, png: null } : block)),
      };
    },
  };
});

const { exportOffice } = await import('./export-office');
const run = { signal: new AbortController().signal };

afterEach(() => {
  state.mammoth = 'real';
  state.csvRows = null;
  state.dropPng = false;
});

const page = () => officeDocument([{ content: line('courier', 10, 50, 470, 'two words') }]);

describe('exportOffice read-back and picture faults', () => {
  it('refuses a DOCX whose independent reader fails, naming the reader error', async () => {
    state.mammoth = 'throw';
    await expect(
      exportOffice(await page(), { pages: [0], baseName: 'a.pdf', format: 'docx' }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      message: expect.stringContaining('docx read-back failed: the reader broke'),
    });
    state.mammoth = 'throw-text';
    await expect(
      exportOffice(await page(), { pages: [0], baseName: 'a.pdf', format: 'docx' }, run),
    ).rejects.toMatchObject({
      message: expect.stringContaining('docx read-back failed: plain text failure'),
    });
  });

  it('refuses a DOCX whose reader finds other words than were written', async () => {
    state.mammoth = 'short';
    await expect(
      exportOffice(await page(), { pages: [0], baseName: 'a.pdf', format: 'docx' }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      message: expect.stringContaining('docx read-back found 1 words, 2 were written'),
    });
  });

  it('refuses a CSV whose reader finds other rows than were written', async () => {
    state.csvRows = 0;
    await expect(
      exportOffice(await page(), { pages: [0], baseName: 'a.pdf', format: 'csv' }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      message: expect.stringContaining('csv read-back found 0 rows, 1 were written'),
    });
  });

  it('leaves out a picture that MuPDF could not draw, drawing or not, and says so', async () => {
    state.dropPng = true;
    const bytes = await officeDocument([
      {
        images: { Im1: { width: 2, height: 2, rgb: [1, 2, 3] } },
        content: [
          line('courier', 10, 50, 470, 'text'),
          picture('Im1', 300, 420, 20, 20),
          circle(200, 200, 5),
        ].join('\n'),
      },
    ]);
    const { file, notes } = await exportOffice(bytes, { pages: [0], baseName: 'a.pdf', format: 'docx' }, run);
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(file.bytes);
    expect((await zip.file('word/document.xml')?.async('string')) ?? '').not.toContain('<w:drawing>');
    expect(notes.map((entry) => entry.key)).not.toContain('op.note.exportOffice.pictures');
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.picturesLost')).toMatchObject({
      kind: 'lost',
      params: { count: 1 },
    });
  });
});
