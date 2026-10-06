/**
 * The batch runner against real bytes. The wrong answers that matter: `'all'` resolved
 * against the wrong document, a password-locked item that stops the whole run instead of
 * failing on its own, and a step order that does not follow the dependency rule.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BatchRuleSet, runBatch } from './batch';

function notoRegular(): Uint8Array<ArrayBuffer> {
  const require = createRequire(import.meta.url);
  const file = require.resolve('@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf', {
    paths: [process.cwd()],
  });
  return new Uint8Array(readFileSync(file));
}

async function pages(count: number, options = ''): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (let index = 0; index < count; index += 1)
    doc.insertPage(index, doc.addPage([0, 0, 300, 400], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer(options).asUint8Array());
  doc.destroy();
  return bytes;
}

/** Every page's extracted text. */
async function texts(bytes: Uint8Array): Promise<string[]> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return Array.from({ length: doc.countPages() }, (_unused, index) =>
      doc.loadPage(index).toStructuredText('').asText().trim(),
    );
  } finally {
    doc.destroy();
  }
}

const numbering: BatchRuleSet = {
  version: 1,
  name: 'numara',
  steps: [
    {
      kind: 'stamp',
      params: {
        kind: 'bates',
        pages: 'all',
        anchor: 'bottom-right',
        prefix: 'NO-',
        startAt: 1,
        digits: 3,
        fontSize: 10,
        marginMm: 10,
      },
    },
  ],
};

describe('runBatch', () => {
  beforeEach(() => {
    const font = notoRegular();
    vi.stubGlobal('fetch', async () => new Response(font));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves "all" per item and fails a password-locked item on its own', async () => {
    const report = await runBatch(
      [
        { name: 'iki.pdf', bytes: await pages(2) },
        { name: 'kilitli.pdf', bytes: await pages(1, 'encrypt=aes-256,user-password=x,owner-password=y') },
        { name: 'bir.pdf', bytes: await pages(1) },
      ],
      numbering,
      { signal: new AbortController().signal },
    );
    expect(report.completed).toEqual(['iki.pdf', 'bir.pdf']);
    expect(report.failed).toEqual(['kilitli.pdf']);
    const [first, locked, last] = report.results;
    expect(locked).toMatchObject({ status: 'failed', code: 'encrypted-unsupported' });
    if (first?.status !== 'done' || last?.status !== 'done') throw new Error('items did not finish');
    expect(await texts(first.bytes)).toEqual(['NO-001', 'NO-002']);
    expect(await texts(last.bytes)).toEqual(['NO-001']);
  });
});
