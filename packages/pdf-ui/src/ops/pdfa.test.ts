import { checkPdfA } from 'pdf-core/ops/pdfa-check';
import { describe, expect, it } from 'vitest';
import { pageTextsOf, runContext, runDialog, textPdf } from '../pdf-fixtures';
import { pdfaDialog } from './pdfa';

describe('pdfaDialog', () => {
  it('converts to PDF/A-2b into a new file named after the level, then recognises the result as done', async () => {
    const input = await textPdf([['Quarterly results were published today']], [300, 200]);
    const converted = await runDialog(pdfaDialog, { level: '2b' }, input, { name: 'report.pdf' });
    expect(converted.noticeKey).toBe('pdfa.done');
    expect(converted.noticeParams).toEqual({ name: 'report-pdfa-2b.pdf' });
    expect(converted.files[0]?.name).toBe('report-pdfa-2b.pdf');
    const bytes = converted.files[0]?.bytes ?? new Uint8Array();
    const check = await checkPdfA(bytes);
    expect(check.verdict).toBe('claims-and-meets');
    expect(check.claim).toEqual({ part: '2', conformance: 'B' });
    expect((await pageTextsOf(bytes))[0]).toContain('Quarterly results were published today');

    // Again, on the converted file: nothing to rewrite, and the notice says so.
    const again = await runDialog(pdfaDialog, { level: '2b' }, bytes, { name: '.pdf' });
    expect(again.noticeKey).toBe('pdfa.doneAlready');
    expect(again.noticeParams).toEqual({ level: 'PDF/A-2b' });
    expect(again.files[0]?.name).toBe('document-pdfa-2b.pdf');
    expect(again.files[0]?.bytes).toEqual(bytes);

    // A level the dialog does not offer falls back to part 2.
    const unknown = await pdfaDialog.run({ level: 'bogus' }, await runContext(bytes, { name: 'x.PDF' }));
    expect(unknown.files[0]?.name).toBe('x-pdfa-2b.pdf');
    expect(unknown.noticeKey).toBe('pdfa.doneAlready');
  }, 120_000);
});
