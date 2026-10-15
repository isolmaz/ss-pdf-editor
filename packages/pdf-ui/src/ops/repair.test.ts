import { describe, expect, it } from 'vitest';
import { resultNeedsReview } from '../dialogs/review';
import { pageTextsOf, runDialog, textPdf } from '../pdf-fixtures';
import { repairDialog } from './repair';

const none = new Uint8Array();

async function pickedFile(name: string, damaged: boolean): Promise<File> {
  const bytes = await textPdf([['one'], ['two']]);
  const text = new TextDecoder('latin1').decode(bytes);
  const broken = text.replace(/startxref\s+\d+/, 'startxref\n7');
  return new File([new Uint8Array(damaged ? Uint8Array.from(broken, (c) => c.charCodeAt(0)) : bytes)], name);
}

describe('repairDialog', () => {
  it('opens a repaired copy under a name of its own and has the result read first', async () => {
    const result = await runDialog(repairDialog, { file: [await pickedFile('broken.pdf', true)] }, none, {
      pageCount: 0,
    });
    expect(result.files[0]?.name).toBe('broken-repaired.pdf');
    expect(result.files[0]?.mime).toBe('application/pdf');
    expect((await pageTextsOf(result.files[0]?.bytes ?? none)).map((text) => text.trim())).toEqual([
      'one',
      'two',
    ]);
    expect(result.noticeKey).toBe('repair.done');
    expect(result.noticeParams).toEqual({ name: 'broken-repaired.pdf' });
    // A repair can lose what could not be read, so the result is read before it opens.
    expect(resultNeedsReview(result)).toBe(true);
  });

  it('says so when the file needed no repair', async () => {
    const result = await runDialog(repairDialog, { file: [await pickedFile('fine.PDF', false)] }, none, {
      pageCount: 0,
    });
    expect(result.files[0]?.name).toBe('fine-repaired.pdf');
    expect(result.noticeKey).toBe('repair.doneClean');
  });

  it('names a file without a name after the document', async () => {
    const result = await runDialog(repairDialog, { file: [await pickedFile('.pdf', false)] }, none, {
      pageCount: 0,
    });
    expect(result.files[0]?.name).toBe('document-repaired.pdf');
  });

  it('needs a file', async () => {
    await expect(runDialog(repairDialog, {}, none, { pageCount: 0 })).rejects.toMatchObject({
      code: 'input-missing',
      details: { engineMessage: 'repair: no file was picked' },
    });
  });

  it('refuses a file with nothing to rebuild from', async () => {
    const file = new File(['this is not a PDF'], 'text.pdf');
    await expect(runDialog(repairDialog, { file: [file] }, none, { pageCount: 0 })).rejects.toMatchObject({
      code: 'corrupt-document',
    });
  });
});
