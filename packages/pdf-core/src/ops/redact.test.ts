/**
 * Redaction against the real MuPDF engine: pages are built in the test, redacted, and the
 * produced bytes are read back. The wrong answers that matter: erased text still
 * extractable, neighbouring text lost with it, a mark that erased nothing reported as a
 * success, a verification that waves a leftover through, a rotated page that erases the
 * wrong area, and metadata or attachments the user asked to clear that survive.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { PRODUCER_LINE } from './metadata';
import { type RedactOptions, type RedactRect, redactDocument, verifyRedaction } from './redact';
import { build, mark, pageTexts, TWO_LINES } from './redact.fixtures';

const run = { signal: new AbortController().signal };

const BASE: Omit<RedactOptions, 'marks'> = {
  imageMethod: 0,
  textMethod: 0,
  cleanMetadata: false,
  cleanAttachments: [],
};

/** Covers the second line only: its baseline sits 200 pt below the top. */
const SECRET_MARK = mark([40, 185, 200, 210]);

describe('redactDocument', () => {
  it('erases the marked glyphs, keeps the neighbouring line and reports what it did', async () => {
    const source = await build([TWO_LINES]);
    const events: string[] = [];
    const outcome = await redactDocument(
      source,
      { ...BASE, marks: [SECRET_MARK] },
      {
        signal: run.signal,
        onProgress: (entry) => events.push(`${entry.labelKey}:${entry.done}/${entry.total}`),
      },
    );
    expect(await pageTexts(outcome.bytes)).toEqual(['Public line']);
    expect(outcome.verification).toEqual({ marksCleared: true, remaining: [] });
    expect(events).toEqual([
      'op.progress.redact:1/1',
      'op.progress.redact.save:0/1',
      'op.progress.redact.save:1/1',
    ]);
    expect(outcome.report).toMatchObject({
      engine: 'mupdf',
      steps: [
        'open',
        'annotate(Redact)',
        'applyRedactions',
        'save(garbage=compact,compress,clean)',
        'verify',
      ],
      inputBytes: source.byteLength,
      outputBytes: outcome.bytes.byteLength,
      incremental: false,
      pageCount: 1,
    });
    expect(outcome.report.notes).toEqual([
      { kind: 'lost', key: 'op.note.redact.contentErased', params: { marks: 1, pages: 1 } },
      { kind: 'preserved', key: 'op.note.redact.singleRevision' },
      { kind: 'preserved', key: 'op.note.redact.verified' },
      { kind: 'warning', key: 'op.note.redact.imagesUntouched' },
      { kind: 'preserved', key: 'op.note.redact.producerKept', params: { producer: PRODUCER_LINE } },
    ]);
  });

  it('erases on a rotated page, where the mark is given in the unrotated space', async () => {
    for (const rotate of [90, 180, 270] as const) {
      const source = await build([{ ...TWO_LINES, rotate }]);
      const outcome = await redactDocument(source, { ...BASE, imageMethod: 1, marks: [SECRET_MARK] }, run);
      expect(await pageTexts(outcome.bytes), `rotation ${rotate}`).toEqual(['Public line']);
      expect(outcome.report.notes.some((entry) => entry.key === 'op.note.redact.imagesUntouched')).toBe(
        false,
      );
    }
  });

  it('marks several pages in page order and counts marks and pages', async () => {
    const source = await build([TWO_LINES, TWO_LINES]);
    const outcome = await redactDocument(
      source,
      { ...BASE, marks: [mark([40, 185, 200, 210], 1), mark([40, 85, 200, 110], 0)] },
      run,
    );
    expect(await pageTexts(outcome.bytes)).toEqual(['Secret 4711', 'Public line']);
    expect(outcome.report.notes[0]).toEqual({
      kind: 'lost',
      key: 'op.note.redact.contentErased',
      params: { marks: 2, pages: 2 },
    });
  });

  it('warns about a mark that covered nothing drawable instead of claiming an erasure', async () => {
    const source = await build([TWO_LINES, TWO_LINES]);
    const outcome = await redactDocument(
      source,
      {
        ...BASE,
        marks: [mark([300, 10, 390, 40], 0), mark([300, 10, 390, 40], 1), mark([40, 185, 200, 210], 1)],
      },
      run,
    );
    expect(outcome.report.notes).toContainEqual({
      kind: 'warning',
      key: 'op.note.redact.emptyMarks',
      params: { pages: '0' },
    });
    expect(await pageTexts(outcome.bytes)).toEqual(['Public line Secret 4711', 'Public line']);
  });

  it('refuses a redaction without marks', async () => {
    await expect(redactDocument(await build([TWO_LINES]), { ...BASE, marks: [] }, run)).rejects.toMatchObject(
      {
        code: 'selection-empty',
      },
    );
  });

  it('refuses marks whose geometry is unknown, not a page, or not a rectangle', async () => {
    const source = await build([TWO_LINES]);
    const legacy = { pageIndex: 0, rect: [0, 0, 10, 10] } as unknown as RedactRect;
    await expect(redactDocument(source, { ...BASE, marks: [legacy] }, run)).rejects.toMatchObject({
      code: 'redaction-geometry-unknown',
    });
    for (const bad of [
      mark([10, 10, 50, 50], 0.5),
      mark([50, 10, 10, 50]),
      mark([10, 50, 50, 10]),
      mark([10, 10, Number.NaN, 50]),
    ]) {
      await expect(redactDocument(source, { ...BASE, marks: [bad] }, run)).rejects.toMatchObject({
        code: 'range-invalid',
      });
    }
  });

  it('names the page when a mark points past the document or before it', async () => {
    const source = await build([TWO_LINES]);
    await expect(
      redactDocument(source, { ...BASE, marks: [mark([10, 10, 50, 50], 1)] }, run),
    ).rejects.toMatchObject({
      code: 'range-invalid',
      details: { pageIndex: 1, engineMessage: 'page index 1 outside 0..0' },
    });
    await expect(
      redactDocument(source, { ...BASE, marks: [mark([10, 10, 50, 50], -1)] }, run),
    ).rejects.toMatchObject({
      code: 'range-invalid',
      details: { pageIndex: -1 },
    });
  });

  it('refuses a file that is not a PDF', async () => {
    await expect(
      redactDocument(new TextEncoder().encode('not a pdf'), { ...BASE, marks: [SECRET_MARK] }, run),
    ).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engine: 'mupdf' },
    });
  });

  it('never returns a file whose marks still hold text', async () => {
    // `textMethod: 1` tells the engine to leave the text alone: the verification has to catch it.
    const source = await build([TWO_LINES]);
    await expect(
      redactDocument(source, { ...BASE, textMethod: 1, marks: [SECRET_MARK] }, run),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      details: { engineMessage: 'redaction left text inside marks on page(s) 0' },
    });
  });

  it('stops at every checkpoint when the signal is aborted', async () => {
    const source = await build([TWO_LINES]);
    const abortsAtRead = (limit: number): AbortSignal => {
      let reads = 0;
      return {
        get aborted() {
          reads += 1;
          return reads >= limit;
        },
      } as AbortSignal;
    };
    // Reads: entry, after the engine loads, per page, after the marks, after the save. The two
    // inside the engine's try block surface as the engine-mapped `aborted` ToolError.
    const outcomes = { 1: 'AbortError', 2: 'AbortError', 3: 'ToolError', 4: 'ToolError', 5: 'AbortError' };
    for (const [limit, name] of Object.entries(outcomes)) {
      await expect(
        redactDocument(source, { ...BASE, marks: [SECRET_MARK] }, { signal: abortsAtRead(Number(limit)) }),
      ).rejects.toMatchObject({ name, ...(name === 'ToolError' ? { code: 'aborted' } : {}) });
    }
    const finished = await redactDocument(
      source,
      { ...BASE, marks: [SECRET_MARK] },
      { signal: abortsAtRead(99) },
    );
    expect(finished.verification.marksCleared).toBe(true);
  });

  it('clears the content-bearing Info keys and an indirect XMP packet but keeps the producer line', async () => {
    const source = await build([TWO_LINES], (doc) => {
      doc.setMetaData('info:Title', 'Gizli başlık');
      doc.setMetaData('info:Author', 'Ayşe');
      doc.setMetaData('info:Producer', 'Some Producer 1.0');
      const root = doc.getTrailer().get('Root');
      root.put(
        'Metadata',
        doc.addStream('<?xpacket begin?><x:xmpmeta>XMPSECRET</x:xmpmeta>', {
          Type: 'Metadata',
          Subtype: 'XML',
        }),
      );
    });
    const outcome = await redactDocument(source, { ...BASE, cleanMetadata: true, marks: [SECRET_MARK] }, run);
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(outcome.bytes, 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    expect(doc.getMetaData('info:Title') ?? '').toBe('');
    expect(doc.getMetaData('info:Author') ?? '').toBe('');
    expect(doc.getMetaData('info:Producer')).toBe(PRODUCER_LINE);
    expect(doc.getTrailer().get('Root').get('Metadata').isNull()).toBe(true);
    doc.destroy();
    expect(new TextDecoder('latin1').decode(outcome.bytes)).not.toContain('XMPSECRET');
    expect(outcome.report.steps).toContain('clean(Info+XMP)');
    expect(outcome.report.notes).toContainEqual({ kind: 'lost', key: 'op.note.redact.metadataCleared' });
  });

  it('clears a direct XMP entry, and reports no metadata clean-up for a document without any', async () => {
    const direct = await build([TWO_LINES], (doc) => {
      doc.getTrailer().get('Root').put('Metadata', { Type: 'Metadata' });
    });
    const cleared = await redactDocument(direct, { ...BASE, cleanMetadata: true, marks: [SECRET_MARK] }, run);
    expect(cleared.report.steps).toContain('clean(Info+XMP)');

    const bare = await build([TWO_LINES]);
    const untouched = await redactDocument(bare, { ...BASE, cleanMetadata: true, marks: [SECRET_MARK] }, run);
    expect(untouched.report.steps).not.toContain('clean(Info+XMP)');
    expect(untouched.report.notes.some((entry) => entry.key === 'op.note.redact.metadataCleared')).toBe(
      false,
    );
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(untouched.bytes, 'application/pdf').asPDF();
    expect(doc?.getMetaData('info:Producer')).toBe(PRODUCER_LINE);
    doc?.destroy();
  });

  it('removes the named attachments and counts only the ones that existed', async () => {
    const source = await build([TWO_LINES], (doc) => {
      const bytes = new TextEncoder().encode('ATTACHED');
      doc.insertEmbeddedFile(
        'gizli.txt',
        doc.addEmbeddedFile('gizli.txt', 'text/plain', bytes, new Date(0), new Date(0)),
      );
      doc.insertEmbeddedFile(
        'kalsin.txt',
        doc.addEmbeddedFile('kalsin.txt', 'text/plain', bytes, new Date(0), new Date(0)),
      );
    });
    const outcome = await redactDocument(
      source,
      { ...BASE, cleanAttachments: ['gizli.txt', 'yok.txt'], marks: [SECRET_MARK] },
      run,
    );
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(outcome.bytes, 'application/pdf').asPDF();
    expect(Object.keys(doc?.getEmbeddedFiles() ?? {})).toEqual(['kalsin.txt']);
    doc?.destroy();
    expect(outcome.report.steps).toContain('clean(attachments)');
    expect(outcome.report.notes).toContainEqual({
      kind: 'lost',
      key: 'op.note.redact.attachmentsRemoved',
      params: { count: 1 },
    });
  });
});

describe('verifyRedaction', () => {
  it('finds the page whose mark still holds text and passes the one that is empty', async () => {
    const source = await build([TWO_LINES, TWO_LINES]);
    expect(
      await verifyRedaction(source, [mark([40, 185, 200, 210], 1), mark([300, 10, 390, 40], 0)]),
    ).toEqual({
      marksCleared: false,
      remaining: [1],
    });
    expect(await verifyRedaction(source, [mark([300, 10, 390, 40], 0)])).toEqual({
      marksCleared: true,
      remaining: [],
    });
  });

  it('counts a glyph only when half of it lies inside the mark', async () => {
    const source = await build([TWO_LINES]);
    // "Secret 4711" starts at x 50; a mark ending at 51 touches the first glyph by a sliver.
    expect(await verifyRedaction(source, [mark([40, 185, 51, 210])])).toEqual({
      marksCleared: true,
      remaining: [],
    });
    expect(await verifyRedaction(source, [mark([40, 185, 58, 210])])).toEqual({
      marksCleared: false,
      remaining: [0],
    });
  });

  it('reports a page that does not exist as remaining content, and reads rotated pages in the stored space', async () => {
    const rotated = await build([{ ...TWO_LINES, rotate: 90 }]);
    expect(
      await verifyRedaction(rotated, [mark([40, 185, 200, 210], 3), mark([40, 185, 200, 210], -1)]),
    ).toEqual({
      marksCleared: false,
      remaining: [-1, 3],
    });
    expect(await verifyRedaction(rotated, [SECRET_MARK])).toEqual({ marksCleared: false, remaining: [0] });
  });

  it('refuses a mark with an unknown geometry space', async () => {
    const legacy = { pageIndex: 0, rect: [0, 0, 10, 10] } as unknown as RedactRect;
    await expect(verifyRedaction(await build([TWO_LINES]), [legacy])).rejects.toMatchObject({
      code: 'redaction-geometry-unknown',
    });
  });

  it('does not count a glyph without extent as remaining text', async () => {
    // Horizontal scaling 0 leaves glyph quads with no width: nothing inside the mark is drawn.
    const source = await build([TWO_LINES], (doc) => {
      doc.findPage(0).put('Contents', doc.addStream('BT /F1 12 Tf 0 Tz 50 300 Td (Hidden) Tj ET', {}));
    });
    expect(await verifyRedaction(source, [SECRET_MARK])).toEqual({ marksCleared: true, remaining: [] });
  });

  it('refuses a page without a readable box as a damaged document', async () => {
    const source = await build([TWO_LINES], (doc) => {
      doc.findPage(0).delete('MediaBox');
    });
    await expect(verifyRedaction(source, [SECRET_MARK])).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engineMessage: 'page has no readable CropBox/MediaBox' },
    });
  });

  it('maps an engine failure on bytes that are not a PDF', async () => {
    await expect(verifyRedaction(new TextEncoder().encode('nope'), [SECRET_MARK])).rejects.toMatchObject({
      code: 'corrupt-document',
      details: { engine: 'mupdf' },
    });
  });
});
