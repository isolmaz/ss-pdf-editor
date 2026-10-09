import { describe, expect, it } from 'vitest';
import { mupdfForTests, runContext, runDialog, textPdf } from '../pdf-fixtures';
import { sanitizeDialog } from './sanitize';

/**
 * A one-page file that carries something for each choice the dialog offers: document
 * JavaScript, an Author, a link to a web address and a note (comment) annotation.
 */
async function carrier(): Promise<Uint8Array> {
  const mupdf = await mupdfForTests();
  const doc = new mupdf.PDFDocument(await textPdf([['Visible text']]));
  const page = doc.findPage(0);
  const link = doc.addObject({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [72, 700, 200, 720],
    Border: [0, 0, 0],
    A: { S: 'URI', URI: doc.newString('https://example.com/') },
  });
  const note = doc.addObject({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [300, 700, 320, 720],
    Contents: doc.newString('NOTEMARKER'),
  });
  page.put('Annots', [link, note]);
  doc
    .getTrailer()
    .get('Root')
    .put('OpenAction', doc.addObject({ S: 'JavaScript', JS: doc.newString('app.alert(1)') }));
  doc.setMetaData('info:Author', 'AUTHORMARKER');
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** What the produced file still holds of each thing the carrier planted. */
async function inspect(bytes: Uint8Array) {
  const mupdf = await mupdfForTests();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    const pdf = doc.asPDF();
    if (pdf === null) throw new Error('not a PDF');
    const page = doc.loadPage(0) as InstanceType<Awaited<ReturnType<typeof mupdfForTests>>['PDFPage']>;
    const subtypes = page.getAnnotations().map((annot) => annot.getType());
    return {
      openAction: !pdf.getTrailer().get('Root').get('OpenAction').isNull(),
      author: doc.getMetaData('info:Author'),
      links: page.getLinks().length,
      notes: subtypes.filter((type) => type === 'Text').length,
      text: page.toStructuredText('preserve-whitespace').asText(),
    };
  } finally {
    doc.destroy();
  }
}

describe('sanitizeDialog', () => {
  it('removes what hides things by default, keeps links and comments, and says how many items went', async () => {
    const before = await inspect(await carrier());
    expect(before).toMatchObject({ openAction: true, author: 'AUTHORMARKER', links: 1, notes: 1 });

    const result = await runDialog(sanitizeDialog, {}, await carrier(), { name: 'plan.pdf' });
    expect(result.files[0]?.name).toBe('plan.pdf');
    expect(result.files[0]?.mime).toBe('application/pdf');
    expect(result.noticeKey).toBe('sanitize.done');
    const after = await inspect(result.files[0]?.bytes ?? new Uint8Array());
    expect(after).toMatchObject({ openAction: false, author: undefined, links: 1, notes: 1 });
    expect(after.text).toContain('Visible text');
    // The script and the Author; the unused objects the save sweeps are not counted.
    expect(result.noticeParams).toEqual({ count: 2 });
  });

  it('removes links and comments when they are ticked, and takes the form fields out when asked', async () => {
    const result = await runDialog(
      sanitizeDialog,
      { remove: ['links', 'comments'], forms: 'remove' },
      await carrier(),
    );
    const after = await inspect(result.files[0]?.bytes ?? new Uint8Array());
    expect(after).toMatchObject({ openAction: true, author: 'AUTHORMARKER', links: 0, notes: 0 });
    expect(result.noticeParams).toEqual({ count: 2 });
  });

  it('treats a choice the dialog never offers as off: no list means nothing is removed and an unknown form mode keeps the fields', async () => {
    const result = await sanitizeDialog.run(
      { remove: 'javascript', forms: 'burn' },
      await runContext(await carrier()),
    );
    const after = await inspect(result.files[0]?.bytes ?? new Uint8Array());
    expect(after).toMatchObject({ openAction: true, author: 'AUTHORMARKER', links: 1, notes: 1 });
    expect(result.noticeParams).toEqual({ count: 0 });
  });

  it('flattens the form fields when asked, leaving the page and everything else as it was', async () => {
    const result = await runDialog(sanitizeDialog, { remove: [], forms: 'flatten' }, await carrier());
    expect(result.noticeParams).toEqual({ count: 0 });
    const after = await inspect(result.files[0]?.bytes ?? new Uint8Array());
    expect(after).toMatchObject({ openAction: true, author: 'AUTHORMARKER', links: 1, notes: 1 });
    expect(after.text).toContain('Visible text');
  });
});
