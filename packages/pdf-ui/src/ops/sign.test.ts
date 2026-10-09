type PDFObject = ReturnType<
  Awaited<ReturnType<typeof import('../pdf-fixtures').mupdfForTests>>['PDFDocument']['prototype']['newNull']
>;

import { verifySignatures } from 'pdf-core/ops/signature-status';
import { describe, expect, it } from 'vitest';
import type { OperationProgress } from '../../../pdf-core/src/ops/types';
import { pkcs12Fixture } from '../../../pdf-core/src/signature-pkcs12.fixtures';
import { mupdfForTests, runContext, runDialog, textPdf } from '../pdf-fixtures';
import { signDialog } from './sign';

const PASSWORD = 'gizli';
const p12File = async (options: Parameters<typeof pkcs12Fixture>[0] = {}) =>
  new File([(await pkcs12Fixture(options)).bytes as BlobPart], 'kimlik.p12', {
    type: 'application/x-pkcs12',
  });

const bytesOf = (result: { files: readonly { bytes: Uint8Array }[] }) =>
  result.files[0]?.bytes ?? new Uint8Array();

interface Signed {
  readonly page: number;
  readonly rect: number[];
  readonly fieldName: string;
  readonly reason: string | null;
  readonly location: string | null;
  readonly name: string | null;
  readonly signedAt: string | null;
}

const text = (object: PDFObject): string | null => (object.isNull() ? null : object.asString());

/** The signature fields of a produced file as its dictionaries state them. */
async function signaturesOf(bytes: Uint8Array): Promise<Signed[]> {
  const mupdf = await mupdfForTests();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const found: Signed[] = [];
    for (let page = 0; page < doc.countPages(); page += 1) {
      const annots = doc.findPage(page).get('Annots');
      for (let index = 0; !annots.isNull() && index < annots.length; index += 1) {
        const widget = annots.get(index).resolve();
        const value = widget.get('V');
        found.push({
          page,
          rect: [0, 1, 2, 3].map((at) => widget.get('Rect').get(at).asNumber()),
          fieldName: widget.get('T').asString(),
          reason: text(value.get('Reason')),
          location: text(value.get('Location')),
          name: text(value.get('Name')),
          signedAt: text(value.get('M')),
        });
      }
    }
    return found;
  } finally {
    doc.destroy();
  }
}

const base = (pages = 1, size: readonly [number, number] = [300, 400]) =>
  textPdf(
    Array.from({ length: pages }, (_unused, page) => [`page ${page + 1}`]),
    size,
  );

describe('signDialog', () => {
  it('signs with the picked identity, stamps the page being viewed, and reports who signed and until when', async () => {
    const progress: OperationProgress[] = [];
    const input = await base(2);
    const params = {
      file: [await p12File()],
      password: PASSWORD,
      visible: true,
      place: 'bottom-right',
      reason: '  Onay  ',
      location: ' Ankara ',
      fieldName: ' Imza1 ',
      digest: 'SHA-384',
    };
    const context = await runContext(input, {
      name: 'sozlesme.pdf',
      onProgress: (event) => progress.push(event),
    });
    const initial = signDialog.initialValues?.({ ...context, currentPage: 1 }) ?? {};
    const result = await signDialog.run({ ...initial, ...params }, context);

    expect(result.files[0]?.name).toBe('sozlesme.pdf');
    expect(result.files[0]?.mime).toBe('application/pdf');
    expect(result.noticeKey).toBe('sign.done');
    expect(result.noticeParams).toEqual({ signer: 'İmza Deneme', expires: '2027-01-01T00:00:00.000Z' });
    expect(progress[0]).toEqual({ phase: 'sign', labelKey: 'op.progress.sign.prepare', done: 0, total: 1 });

    const [signed, ...rest] = await signaturesOf(bytesOf(result));
    expect(rest).toEqual([]);
    expect(signed).toMatchObject({
      page: 1,
      // 200 x 60 stamp, 24 pt in from the lower right corner of a 300 x 400 page.
      rect: [76, 24, 276, 84],
      fieldName: 'Imza1',
      reason: 'Onay',
      location: 'Ankara',
      name: 'İmza Deneme',
    });
    const verdicts = await verifySignatures(bytesOf(result));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ integrity: 'valid' });
  });

  it.each([
    { place: 'bottom-left', rect: [24, 24, 224, 84] },
    { place: 'top-right', rect: [76, 316, 276, 376] },
    { place: 'top-left', rect: [24, 316, 224, 376] },
    // A corner the dialog never offers falls back to the default, bottom right.
    { place: 'middle', rect: [76, 24, 276, 84] },
  ])('puts the stamp in the $place corner inset by the margin', async ({ place, rect }) => {
    const result = await runDialog(
      signDialog,
      { file: [await p12File()], password: PASSWORD, place },
      await base(),
    );
    const [signed] = await signaturesOf(bytesOf(result));
    expect(signed?.rect).toEqual(rect);
  });

  it('reads the page box from the page: a media box that starts below zero moves the stamp with it', async () => {
    const mupdf = await mupdfForTests();
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, -20, 300, 380], 0, {}, ''));
    const input = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();
    const result = await runDialog(
      signDialog,
      { file: [await p12File()], password: PASSWORD, place: 'bottom-left' },
      input,
    );
    const [signed] = await signaturesOf(bytesOf(result));
    expect(signed?.rect).toEqual([24, 4, 224, 64]);
  });

  it('shrinks the stamp to fit a page smaller than the stamp and its margins', async () => {
    const result = await runDialog(
      signDialog,
      { file: [await p12File()], password: PASSWORD, place: 'bottom-left' },
      await base(1, [40, 40]),
    );
    const [signed] = await signaturesOf(bytesOf(result));
    expect(signed?.rect).toEqual([24, 24, 25, 25]);
  });

  it('clamps the page number into the document, and falls back to the first page when none is sent', async () => {
    const identity = await p12File();
    const far = await signDialog.run(
      { file: [identity], password: PASSWORD, visible: true, page: 99 },
      await runContext(await base(3)),
    );
    expect((await signaturesOf(bytesOf(far)))[0]?.page).toBe(2);
    const before = await signDialog.run(
      { file: [identity], password: PASSWORD, visible: true, page: -5 },
      await runContext(await base(3)),
    );
    expect((await signaturesOf(bytesOf(before)))[0]?.page).toBe(0);
    const unset = await signDialog.run(
      { file: [identity], password: PASSWORD, visible: true },
      await runContext(await base(3)),
    );
    expect((await signaturesOf(bytesOf(unset)))[0]?.page).toBe(0);
  });

  it('refuses a page the document does not have, instead of stamping elsewhere', async () => {
    const run = signDialog.run(
      { file: [await p12File()], password: PASSWORD, visible: true, page: 5 },
      await runContext(await base(1), { pageCount: 5 }),
    );
    await expect(run).rejects.toMatchObject({ code: 'range-invalid' });
  });

  it('signs without a visible stamp when asked, with the default field name and no reason or place', async () => {
    const result = await runDialog(
      signDialog,
      {
        file: [await p12File()],
        password: PASSWORD,
        visible: false,
        fieldName: '   ',
        reason: '',
        location: '',
      },
      await base(),
    );
    const [signed] = await signaturesOf(bytesOf(result));
    expect(signed).toMatchObject({ rect: [0, 0, 0, 0], reason: null, location: null, name: 'İmza Deneme' });
    expect(signed?.fieldName).not.toBe('');
    expect((await verifySignatures(bytesOf(result)))[0]).toMatchObject({ integrity: 'valid' });
  });

  it('names no signer when the certificate carries no common name', async () => {
    const result = await signDialog.run(
      { file: [await p12File({ subject: null })], password: PASSWORD, visible: true },
      await runContext(await base()),
    );
    expect(result.noticeParams).toEqual({ signer: '', expires: '2027-01-01T00:00:00.000Z' });
    const [signed] = await signaturesOf(bytesOf(result));
    expect(signed?.name).toBeNull();
  });

  it('opens a container with no password when the dialog sends none, signing with the default digest', async () => {
    const result = await signDialog.run(
      { file: [await p12File({ password: '' })], visible: false },
      await runContext(await base()),
    );
    expect(result.noticeKey).toBe('sign.done');
    expect((await verifySignatures(bytesOf(result)))[0]).toMatchObject({ integrity: 'valid' });
  });

  it('refuses a wrong password as the container does, without signing', async () => {
    const run = runDialog(signDialog, { file: [await p12File()], password: 'yanlis' }, await base());
    await expect(run).rejects.toThrow('Integrity for the PKCS#12 data is broken!');
  });

  it('asks for the identity file when none was picked', async () => {
    const expected = {
      code: 'input-missing',
      details: { engine: 'ui', engineMessage: 'no PKCS#12 file was chosen' },
    };
    await expect(runDialog(signDialog, { file: [] }, await base())).rejects.toMatchObject(expected);
    await expect(signDialog.run({}, await runContext(await base()))).rejects.toMatchObject(expected);
  });
});
