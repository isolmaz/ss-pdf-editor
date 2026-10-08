/**
 * The last step of the preparation saves the cleaned document; MuPDF can refuse to write one.
 * The real engine writes what it is given, so this test replaces the save at the module seam
 * (everything else, the document it opens and the cleaning it does, is real).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../engines/mupdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../engines/mupdf')>();
  return {
    ...actual,
    loadMupdf: () => import('mupdf'),
    savePdf: () => {
      throw new Error('cannot write: out of memory');
    },
  };
});

const { prepareForPdfA } = await import('./pdfa-prepare');
const { handPdf } = await import('./forms.fixtures');

describe('prepareForPdfA when the save fails', () => {
  it('reports the engine failure with its context instead of an unmapped error', async () => {
    const bytes = handPdf({
      1: '<</Type/Catalog/Pages 2 0 R>>',
      2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>',
    });
    await expect(prepareForPdfA(bytes, 1, { signal: new AbortController().signal })).rejects.toMatchObject({
      name: 'ToolError',
      details: { engine: 'mupdf', engineMessage: 'pdfa prepare: cannot write: out of memory' },
    });
  });
});
