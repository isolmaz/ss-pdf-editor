/**
 * Signing and verifying against real bytes and real cryptography: a certificate made
 * with WebCrypto (`signature-trust.fixtures.ts`), the writer's fixed-width placeholders,
 * and the product's own verifier reading the result. The wrong answers that matter: a
 * signature that does not verify, a tampered byte that still verifies, a placeholder that
 * moved when it was filled, and an encrypted file whose placeholders would be encrypted.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { Extension } from 'pkijs';
import { describe, expect, it } from 'vitest';
import { readText } from '../engines/mupdf-write';
import { generateKey, issueCertificate } from '../signature-trust.fixtures';
import { signPdf } from './sign';
import { verifySignatures } from './signature-status';

const run = { signal: new AbortController().signal };

const abortsAtRead = (limit: number): AbortSignal => {
  let reads = 0;
  return {
    get aborted() {
      reads += 1;
      return reads >= limit;
    },
  } as AbortSignal;
};

async function identity() {
  const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
  const certificate = await issueCertificate({
    subject: 'İmza Deneme',
    keyPair,
    notBefore: new Date(Date.UTC(2026, 0, 1)),
    notAfter: new Date(Date.UTC(2027, 0, 1)),
    keyUsage: ['digitalSignature'],
  });
  return { certificate: certificate.der, privateKey: keyPair.privateKey };
}

async function blank(options = '', pages = 1, prepare?: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  for (let index = 0; index < pages; index += 1) {
    doc.insertPage(index, doc.addPage([0, 0, 300, 400], 0, {}, ''));
  }
  prepare?.(doc);
  const bytes = new Uint8Array(doc.saveToBuffer(options).asUint8Array());
  doc.destroy();
  return bytes;
}

/** The signature widget of a produced file, with its `/V` dictionary and page index. */
async function widgetsOf(
  bytes: Uint8Array,
): Promise<{ widget: PDFObject; page: number; doc: PDFDocument }[]> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes, 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  const found: { widget: PDFObject; page: number; doc: PDFDocument }[] = [];
  for (let page = 0; page < doc.countPages(); page += 1) {
    const annots = doc.findPage(page).get('Annots');
    if (annots.isNull()) continue;
    for (let index = 0; index < annots.length; index += 1) {
      found.push({ widget: annots.get(index).resolve(), page, doc });
    }
  }
  return found;
}

/** The appearance content stream of the first widget. */
async function appearanceText(bytes: Uint8Array): Promise<string> {
  const [first] = await widgetsOf(bytes);
  const content = first?.widget.get('AP').get('N').readStream().asString() ?? '';
  first?.doc.destroy();
  return content;
}

/** A document with one empty signature field already in it, as a form author leaves it. */
async function withEmptyField(): Promise<Uint8Array> {
  return blank('', 2, (doc) => {
    const page = doc.findPage(1);
    const field = doc.addObject({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: doc.newString('Mevcut'),
      F: 4,
      Rect: [10, 10, 120, 40],
      P: page,
    });
    page.put('Annots', [field]);
    doc
      .getTrailer()
      .get('Root')
      .put('AcroForm', { Fields: [field], SigFlags: 3 });
  });
}

describe('signPdf', () => {
  it('writes a visible signature that the product’s verifier reads as intact', async () => {
    const out = await signPdf(
      await blank(),
      {
        identity: await identity(),
        field: { name: 'Onay', rect: { x: 20, y: 20, width: 160, height: 50 }, pageIndex: 0 },
        reason: 'Onaylandı',
        signerName: 'İmza Deneme',
        date: new Date(Date.UTC(2026, 5, 1, 12)),
      },
      run,
    );
    expect(out.report.steps).toEqual(['load', 'field.create', 'producer', 'save', 'cms', 'verify']);
    const verdicts = await verifySignatures(out.bytes, run.signal, { now: new Date(Date.UTC(2026, 5, 2)) });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      fieldName: 'Onay',
      integrity: 'valid',
      subFilter: 'ETSI.CAdES.detached',
    });
    expect(verdicts[0]?.signer).toBe('İmza Deneme');

    // One byte inside the signed range changed: the verdict has to change with it.
    const tampered = out.bytes.slice();
    tampered[20] = (tampered[20] ?? 0) ^ 0x01;
    const broken = await verifySignatures(tampered, run.signal);
    expect(broken[0]?.integrity).toBe('invalid');
  });

  it('answers an unsigned file without a verdict and refuses to sign an encrypted one', async () => {
    expect(await verifySignatures(await blank(), run.signal)).toEqual([]);
    await expect(
      signPdf(await blank('encrypt=aes-256,owner-password=x'), { identity: await identity() }, run),
    ).rejects.toMatchObject({ code: 'encrypted-unsupported' });
  });

  it('fills an empty signature field the document already has, on the page it sits on', async () => {
    const events: string[] = [];
    const out = await signPdf(
      await withEmptyField(),
      { identity: await identity(), date: new Date(Date.UTC(2026, 5, 1, 12)) },
      { signal: run.signal, onProgress: (entry) => events.push(entry.labelKey) },
    );
    expect(out.report.steps).toEqual(['load', 'field.reuse', 'producer', 'save', 'cms', 'verify']);
    expect(out.report.notes[0]).toEqual({
      kind: 'changed',
      key: 'op.note.sign.fieldFilled',
      params: { name: 'Mevcut' },
    });
    // An AcroForm with a field list is announced before the digest.
    expect(events).toEqual([
      'op.progress.sign.prepare',
      'op.progress.sign.digest',
      'op.progress.sign.verify',
    ]);
    const verdicts = await verifySignatures(out.bytes, run.signal);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ fieldName: 'Mevcut', integrity: 'valid' });
    const widgets = await widgetsOf(out.bytes);
    expect(widgets.map((entry) => entry.page)).toEqual([1]);
    widgets[0]?.doc.destroy();
  });

  it('signs with the digest asked for and says which', async () => {
    const out = await signPdf(await blank(), { identity: await identity(), digest: 'SHA-512' }, run);
    expect(out.report.notes.find((entry) => entry.key === 'op.note.sign.signed')?.params).toMatchObject({
      digest: 'SHA-512',
    });
    expect((await verifySignatures(out.bytes, run.signal))[0]?.integrity).toBe('valid');
  });

  it('skips annotations that are not dictionaries or not signature widgets when looking for a field', async () => {
    const source = await blank('', 1, (doc) => {
      const page = doc.findPage(0);
      const link = doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] });
      const filled = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: doc.newString('Dolu'),
        V: doc.addObject({ Type: 'Sig' }),
        Rect: [0, 0, 0, 0],
      });
      const empty = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: doc.newString('Bos'),
        Rect: [0, 0, 0, 0],
        P: page,
      });
      page.put('Annots', [5, link, filled, empty]);
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', { Fields: [filled, empty], SigFlags: 3 });
    });
    const out = await signPdf(source, { identity: await identity() }, run);
    expect(out.report.steps[1]).toBe('field.reuse');
    expect(out.report.notes[0]?.params).toEqual({ name: 'Bos' });
  });

  it('creates an invisible field on the chosen page under a name of its own when none is given', async () => {
    const out = await signPdf(
      await blank('', 2),
      { identity: await identity(), field: { pageIndex: 1 } },
      run,
    );
    const widgets = await widgetsOf(out.bytes);
    expect(widgets.map((entry) => entry.page)).toEqual([1]);
    const widget = widgets[0]?.widget;
    expect(widget?.get('Rect').length).toBe(4);
    expect([0, 1, 2, 3].map((index) => widget?.get('Rect').get(index).asNumber())).toEqual([0, 0, 0, 0]);
    expect(widget?.get('AP').isNull()).toBe(true);
    expect(widget?.get('F').asNumber()).toBe(132);
    expect(readText(widget?.get('T'))).toMatch(/^Signature\d+$/);
    expect(out.report.notes[0]).toMatchObject({ key: 'op.note.sign.fieldCreated' });
    widgets[0]?.doc.destroy();
    expect((await verifySignatures(out.bytes, run.signal))[0]?.integrity).toBe('valid');
  });

  it('refuses a page for the new field that the document does not have', async () => {
    for (const pageIndex of [2, -1, 0.5]) {
      await expect(
        signPdf(await blank('', 2), { identity: await identity(), field: { pageIndex } }, run),
      ).rejects.toMatchObject({
        code: 'value-out-of-range',
        details: { path: 'request.field.pageIndex' },
      });
    }
  });

  it('stores the reason, location, contact and signer name as text in the signature dictionary', async () => {
    const out = await signPdf(
      await blank(),
      {
        identity: await identity(),
        reason: 'Şartname onayı',
        location: 'İstanbul',
        contactInfo: 'imza@example.test',
        signerName: 'Çağlar Öztürk',
      },
      run,
    );
    const [entry] = await widgetsOf(out.bytes);
    const signature = entry?.widget.get('V').resolve();
    expect(readText(signature?.get('Reason'))).toBe('Şartname onayı');
    expect(readText(signature?.get('Location'))).toBe('İstanbul');
    expect(readText(signature?.get('ContactInfo'))).toBe('imza@example.test');
    expect(readText(signature?.get('Name'))).toBe('Çağlar Öztürk');
    entry?.doc.destroy();

    const bare = await signPdf(await blank(), { identity: await identity() }, run);
    const [plain] = await widgetsOf(bare.bytes);
    const dictionary = plain?.widget.get('V').resolve();
    for (const key of ['Reason', 'Location', 'ContactInfo', 'Name']) {
      expect(dictionary?.get(key).isNull(), key).toBe(true);
    }
    plain?.doc.destroy();
  });

  it('draws the reason, location and date into a visible appearance when no lines are given', async () => {
    const out = await signPdf(
      await blank(),
      {
        identity: await identity(),
        field: { rect: { x: 10, y: 10, width: 200, height: 60 } },
        reason: 'Ok (1)',
        location: 'Ankara',
        date: new Date(Date.UTC(2026, 5, 1, 12, 0, 5)),
      },
      run,
    );
    const content = await appearanceText(out.bytes);
    expect(content).toContain('(Ok \\(1\\)) Tj');
    expect(content).toContain('(Ankara) Tj');
    expect(content).toContain('(D:20260601120005Z) Tj');
    expect(content).toContain('/Helv 9 Tf');

    const dated = await signPdf(
      await blank(),
      {
        identity: await identity(),
        field: { rect: { x: 10, y: 10, width: 200, height: 60 }, lines: [] },
        date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
      },
      run,
    );
    expect(await appearanceText(dated.bytes)).toContain('(D:20260102030405Z) Tj');
  });

  it('draws given lines as ASCII text with escapes, shrinks past three, drops the rows that do not fit', async () => {
    const out = await signPdf(
      await blank(),
      {
        identity: await identity(),
        field: {
          rect: { x: 10, y: 10, width: 200, height: 60 },
          lines: ['Ünal \\ (x)', 'ikinci', 'üçüncü', 'dördüncü', 'beşinci'],
        },
      },
      run,
    );
    const content = await appearanceText(out.bytes);
    expect(content).toContain('/Helv 8 Tf 0 0 0 rg 6 48.00 Td (?nal \\\\ \\(x\\)) Tj');
    expect(content).toContain('6 37.00 Td (ikinci) Tj');
    expect(content).toContain('6 26.00 Td (???nc?) Tj');
    expect(content).toContain('6 15.00 Td (d?rd?nc?) Tj');
    // The fifth row would start at y = 4, below the 6 pt margin: it is not drawn.
    expect(content).not.toContain('6 4.00 Td');
    expect(content).not.toContain('be?inci');
  });

  it('keeps a long list to six rows', async () => {
    const out = await signPdf(
      await blank(),
      {
        identity: await identity(),
        field: {
          rect: { x: 10, y: 10, width: 200, height: 200 },
          lines: ['bir', 'iki', 'uc', 'dort', 'bes', 'alti', 'yedi'],
        },
      },
      run,
    );
    const content = await appearanceText(out.bytes);
    expect(content).toContain('(alti) Tj');
    expect(content).not.toContain('(yedi) Tj');
  });

  it('fills an empty signature field that has no name and reports an empty one', async () => {
    const source = await blank('', 1, (doc) => {
      const field = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        F: 4,
        Rect: [10, 10, 120, 40],
        P: doc.findPage(0),
      });
      doc.findPage(0).put('Annots', [field]);
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', { Fields: [field], SigFlags: 3 });
    });
    const out = await signPdf(source, { identity: await identity() }, run);
    expect(out.report.notes[0]).toEqual({
      kind: 'changed',
      key: 'op.note.sign.fieldFilled',
      params: { name: '' },
    });
    expect((await verifySignatures(out.bytes, run.signal))[0]?.integrity).toBe('valid');
  });

  it('writes a second signature after an earlier one, and reports the new one', async () => {
    const first = await signPdf(
      await blank(),
      { identity: await identity(), field: { name: 'Birinci' } },
      run,
    );
    const second = await signPdf(first.bytes, { identity: await identity(), field: { name: 'Ikinci' } }, run);
    const verdicts = await verifySignatures(second.bytes, run.signal);
    expect(verdicts.map((entry) => entry.fieldName)).toEqual(['Birinci', 'Ikinci']);
    expect(verdicts[1]?.integrity).toBe('valid');
  });

  it('stops when the signal is aborted, with the abort itself and not an engine error', async () => {
    const source = await blank();
    for (const limit of [1, 2]) {
      await expect(
        signPdf(source, { identity: await identity() }, { signal: abortsAtRead(limit) }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    }
  });

  it('refuses a file that already holds a zero placeholder of the reserved size', async () => {
    const source = await blank('', 1, (doc) => {
      doc
        .getTrailer()
        .get('Root')
        .put('Padding', doc.newByteString(new Uint8Array(16 * 1024)));
    });
    await expect(signPdf(source, { identity: await identity() }, run)).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: 'the file already carries a zero /Contents placeholder of this size' },
    });
  });

  it('refuses a certificate chain too large for the reserved signature space', async () => {
    const keyPair = await generateKey({ kind: 'EC', curve: 'P-256' });
    const certificate = await issueCertificate({
      subject: 'Büyük',
      keyPair,
      extraExtensions: [
        new Extension({ extnID: '1.3.6.1.4.1.99999.2', critical: false, extnValue: new ArrayBuffer(20_000) }),
      ],
    });
    await expect(
      signPdf(
        await blank(),
        { identity: { certificate: certificate.der, privateKey: keyPair.privateKey } },
        run,
      ),
    ).rejects.toMatchObject({
      code: 'internal',
      details: { engineMessage: expect.stringMatching(/larger than the 32768-character reservation/) },
    });
  });

  it('never returns a signature that does not verify, naming why', async () => {
    const real = await identity();
    const other = await generateKey({ kind: 'EC', curve: 'P-256' });
    await expect(
      signPdf(
        await blank(),
        { identity: { certificate: real.certificate, privateKey: other.privateKey } },
        run,
      ),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      details: {
        engineMessage: expect.stringMatching(/^the produced signature does not verify: integrity "invalid"/),
      },
    });
  });
});
