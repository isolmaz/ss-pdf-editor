/**
 * What the OCR dialog tells the user when every selected page already has text. Those pages
 * are skipped on purpose; saying "no text found on any page" about them contradicts the
 * page the user is looking at. The dialog, the skip rule and MuPDF are the real ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeFontOrigin, runDialog, textPdf, useFontOrigin } from '../pdf-fixtures';
import { ocrDialog } from './ocr';

describe('ocrDialog', () => {
  // The language pack's availability probe is a HEAD request; everything else is the font origin.
  beforeEach(() => {
    useFontOrigin();
    const answerFont = fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'HEAD' ? new Response(null, { status: 200 }) : answerFont(input, init),
    );
  });
  afterEach(removeFontOrigin);

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
  });
});
