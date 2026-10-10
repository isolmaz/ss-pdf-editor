/**
 * What the OCR dialog tells the user when every selected page already has text. Those pages
 * are skipped on purpose; saying "no text found on any page" about them contradicts the
 * page the user is looking at. The dialog, the skip rule and MuPDF are the real ones; the
 * recognition engine is replaced at its loading boundary and the page raster is drawn on the
 * Skia canvas pdf.js itself uses in Node (`skia-canvas.fixtures`).
 */

import { terminateOcrWorkers } from 'pdf-core/engines/tesseract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  pageTextsOf,
  removeFontOrigin,
  runContext,
  runDialog,
  textPdf,
  useFontOrigin,
} from '../pdf-fixtures';
import { SkiaOffscreen, skia } from '../skia-canvas.fixtures';
import { ocrDialog } from './ocr';

const state = vi.hoisted(() => ({ created: [] as string[][], recognized: 0 }));

vi.mock('/engines/tesseract/tesseract.esm.min.js', () => ({
  default: undefined,
  createWorker: async (languages: string[]) => {
    state.created.push(languages);
    return {
      setParameters: async () => {},
      recognize: async () => {
        state.recognized += 1;
        return {
          data: {
            confidence: 91,
            blocks: [
              {
                paragraphs: [
                  {
                    lines: [
                      {
                        words: [
                          { text: 'Okundu', bbox: { x0: 100, y0: 100, x1: 300, y1: 140 }, confidence: 95 },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      },
      terminate: async () => {},
    };
  },
}));

describe('ocrDocument dialog', () => {
  // The language pack's availability probe is a HEAD request; everything else is the font origin.
  beforeEach(() => {
    state.created.length = 0;
    state.recognized = 0;
    useFontOrigin();
    const answerFont = fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'HEAD' ? new Response(null, { status: 200 }) : answerFont(input, init),
    );
    vi.stubGlobal('OffscreenCanvas', SkiaOffscreen);
    vi.stubGlobal('Path2D', skia.Path2D);
  });
  afterEach(async () => {
    await terminateOcrWorkers();
    removeFontOrigin();
  });

  it('says the pages with text were left alone, not that no text was found, when every page was skipped', async () => {
    const bytes = await textPdf([['Already searchable']]);
    const result = await runDialog(
      ocrDialog,
      { languages: ['tur'], existingText: 'skip', scope: 'all' },
      bytes,
    );
    expect(result.noticeKey).toBe('ocr.skipped');
    expect(result.noticeParams).toEqual({ count: 1 });
    const keys = result.report.notes.map((entry) => entry.key);
    expect(keys).toContain('ocr.skipped');
    expect(keys).not.toContain('ocr.empty');
    expect(state.recognized).toBe(0);
  });

  it('reads the pages that already have text again when the user chose to overwrite them, and says nothing was skipped', async () => {
    const bytes = await textPdf([['Already searchable']]);
    const result = await runDialog(
      ocrDialog,
      { languages: ['tur'], existingText: 'overwrite', scope: 'all' },
      bytes,
    );
    expect(state.recognized).toBe(1);
    expect(state.created).toEqual([['tur']]);
    expect(result.noticeKey).toBe('ocr.done');
    expect(result.noticeParams).toEqual({ count: 1 });
    expect(result.report.notes.map((entry) => entry.key)).not.toContain('ocr.skipped');
    const [text = ''] = await pageTextsOf(result.files[0]?.bytes ?? new Uint8Array());
    expect(text).toContain('Okundu');
  });

  it.each([
    { label: 'an empty list', languages: [] },
    { label: 'no list at all', languages: undefined },
  ])(
    'refuses to run with $label of languages, naming the missing pack rather than writing no text layer',
    async ({ languages }) => {
      const bytes = await textPdf([['x']]);
      const run = ocrDialog.run(
        { existingText: 'skip', scope: 'all', ...(languages === undefined ? {} : { languages }) },
        await runContext(bytes),
      );
      await expect(run).rejects.toMatchObject({
        code: 'ocr-language-missing',
        details: { engine: 'ui', engineMessage: 'ocr: no language was selected' },
      });
      expect(state.recognized).toBe(0);
    },
  );
});
