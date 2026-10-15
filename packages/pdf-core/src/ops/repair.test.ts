/**
 * Repairing damaged files against real bytes: each fixture is a genuinely broken file that MuPDF
 * has to repair to open (its own `wasRepaired()` says so, checked here before the operation runs),
 * and the output is read back for its pages, its text and its structure.
 */

import { PDFDocument } from 'mupdf';
import { isToolError, type ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { repairDocument } from './repair';

const run = { signal: new AbortController().signal };

const latin1 = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);
const bytesOf = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0));

/** A clean document of `count` pages whose page `n` reads "Page n". */
function clean(count: number): Uint8Array {
  const doc = new PDFDocument();
  const font = doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
  for (let index = 0; index < count; index += 1) {
    doc.insertPage(
      -1,
      doc.addPage(
        [0, 0, 200, 200],
        0,
        { Font: { F1: font } },
        `BT /F1 12 Tf 20 100 Td (Page ${index + 1}) Tj ET`,
      ),
    );
  }
  doc.setMetaData('info:Title', 'Annual report');
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** The three ways a file is commonly damaged: cut short, pointing at the wrong offsets, a wrong `startxref`. */
const DAMAGES: readonly (readonly [string, (source: string) => string])[] = [
  ['cut off before its cross-reference table', (source) => source.slice(0, source.lastIndexOf('xref') - 5)],
  [
    'with every offset of the table shifted',
    (source) =>
      source.replace(
        /(\d{10}) 00000 n/g,
        (_entry, offset: string) => `${String(Number(offset) + 13).padStart(10, '0')} 00000 n`,
      ),
  ],
  ['with a startxref that points nowhere', (source) => source.replace(/startxref\s+\d+/, 'startxref\n7')],
];

/** What MuPDF says about opening `bytes`: whether it had to repair them, and the text of every page. */
function inspect(bytes: Uint8Array): { repaired: boolean; texts: string[]; title: string | null } {
  const doc = PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const texts = Array.from({ length: doc.countPages() }, (_unused, index) =>
      doc.loadPage(index).toStructuredText('preserve-whitespace').asText().trim(),
    );
    // Asked after the pages are read: MuPDF repairs lazily, when an object is not where the table says.
    return { repaired: doc.wasRepaired(), texts, title: doc.getMetaData('info:Title') ?? null };
  } finally {
    doc.destroy();
  }
}

async function refusal(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise;
  } catch (error) {
    if (isToolError(error)) return error;
    throw error;
  }
  throw new Error('the call resolved instead of rejecting');
}

describe('repairDocument', () => {
  it.each(DAMAGES)('writes a clean file from one %s', async (_name, damage) => {
    const damaged = bytesOf(damage(latin1(clean(3))));
    // The fixture is only worth something when it is damaged for real.
    expect(inspect(damaged).repaired).toBe(true);

    const out = await repairDocument(damaged, run);
    expect(out.repaired).toBe(true);
    const read = inspect(out.bytes);
    expect(read.repaired).toBe(false);
    expect(read.texts).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect(read.title).toBe('Annual report');
    expect(out.report.pageCount).toBe(3);
    expect(out.report.steps).toEqual(['load', 'repair', 'save']);
    expect(out.report.inputBytes).toBe(damaged.byteLength);
    expect(out.report.outputBytes).toBe(out.bytes.byteLength);
    expect(out.report.incremental).toBe(false);
    expect(out.report.notes).toEqual(
      expect.arrayContaining([
        { kind: 'changed', key: 'op.note.repair.rebuilt' },
        { kind: 'warning', key: 'op.note.repair.check' },
        { kind: 'preserved', key: 'op.note.repair.verified', params: { pages: 3 } },
      ]),
    );
  });

  it('rewrites a sound file and says it needed no repair', async () => {
    const out = await repairDocument(clean(2), run);
    expect(out.repaired).toBe(false);
    expect(inspect(out.bytes).texts).toEqual(['Page 1', 'Page 2']);
    expect(out.report.steps).toEqual(['load', 'save']);
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).toContain('op.note.repair.rewritten');
    expect(keys).not.toContain('op.note.repair.rebuilt');
    expect(out.report.notes.some((entry) => entry.kind === 'warning' || entry.kind === 'lost')).toBe(false);
  });

  it('says that a signature does not survive the rewrite', async () => {
    const doc = PDFDocument.openDocument(clean(1).slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    const page = doc.findPage(0);
    const value = doc.addObject({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: [0, 0, 0, 0],
      Contents: doc.newString('00'),
    });
    const widget = doc.addObject({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: doc.newString('Signature1'),
      Rect: [0, 0, 0, 0],
      V: value,
      P: page,
    });
    page.put('Annots', [widget]);
    const signed = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();

    const out = await repairDocument(signed, run);
    expect(out.report.notes).toContainEqual({ kind: 'lost', key: 'op.note.repair.signatureBroken' });
    expect(
      (await repairDocument(clean(1), run)).report.notes.some(
        (entry) => entry.key === 'op.note.repair.signatureBroken',
      ),
    ).toBe(false);
  });

  it('refuses what has no object to rebuild from', async () => {
    const error = await refusal(repairDocument(bytesOf('this is not a PDF at all'), run));
    expect(error.code).toBe('corrupt-document');
  });

  it('refuses a file whose pages cannot be found, instead of presenting an empty document as a repair', async () => {
    const error = await refusal(repairDocument(clean(0), run));
    expect(error.code).toBe('corrupt-document');
    expect(error.details.engineMessage).toBe('no page could be read from the file');
  });

  it('stops when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(repairDocument(clean(1), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
