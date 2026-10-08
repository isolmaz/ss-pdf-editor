/**
 * What the OCR dialog tells the user when every selected page already has text. Those pages
 * are skipped on purpose; saying "no text found on any page" about them contradicts the
 * page the user is looking at. The dialog, the skip rule and MuPDF are the real ones; the
 * served build's URLs are answered from the installed packages.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fixturePage } from 'pdf-core/ops/layout-fixtures';
import { createTranslator } from 'pdf-shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OpRunContext } from '../dialogs/types';
import { ocrDialog } from './ocr';

describe('ocr dialog notices', () => {
  // The language pack's availability probe (a HEAD request) and the text layer's font.
  beforeAll(() => {
    const font = new Uint8Array(
      readFileSync(
        createRequire(import.meta.url).resolve(
          '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf',
          {
            paths: [process.cwd()],
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(font),
    );
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('says the pages with text were left alone, not that no text was found, when every page was skipped', async () => {
    const bytes = await fixturePage([{ text: 'Already searchable', x: 50, y: 400, size: 24 }]);
    const context: OpRunContext = {
      signal: new AbortController().signal,
      onProgress: () => {},
      bytes,
      pageCount: 1,
      name: 'belge.pdf',
      currentPage: 0,
      selectedPages: [],
      t: createTranslator('en'),
    };
    const result = await ocrDialog.run(
      { languages: ['tur'], quality: 'best', dpi: 150, existingText: 'skip', scope: 'all' },
      context,
    );
    expect(result.noticeKey).toBe('ocr.skipped');
    expect(result.noticeParams).toEqual({ count: 1 });
    const keys = result.report.notes.map((entry) => entry.key);
    expect(keys).toContain('ocr.skipped');
    expect(keys).not.toContain('ocr.empty');
  });
});
