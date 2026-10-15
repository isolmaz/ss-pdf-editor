/**
 * Signing and verifying against real bytes and real cryptography: a certificate made
 * with WebCrypto (`signature-trust.fixtures.ts`), the writer's fixed-width placeholders,
 * and the product's own verifier reading the result. The wrong answers that matter: a
 * signature that does not verify, a tampered byte that still verifies, a placeholder that
 * moved when it was filled, and an encrypted file whose placeholders would be encrypted.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { Extension } from 'pkijs';
import { describe, expect, it, vi } from 'vitest';
import { readNumbers, readText } from '../engines/mupdf-write';
import { readSignedData } from '../signature-evidence';
import { generateKey, issueCertificate } from '../signature-trust.fixtures';
import { byteRangeText, signPdf } from './sign';
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

/**
 * A one-page document with an empty signature field per name, listed in `/Fields` in this
 * order. `rect` of `null` leaves the widgets without an area, as a hidden field is.
 */
async function withEmptyFields(
  names: readonly string[],
  rect: readonly [number, number, number, number] | null = [10, 10, 120, 40],
  pages = 1,
): Promise<Uint8Array> {
  return blank('', pages, (doc) => {
    const page = doc.findPage(0);
    const fields = names.map((name) =>
      doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: doc.newString(name),
        F: 4,
        Rect: rect ?? [0, 0, 0, 0],
        P: page,
      }),
    );
    page.put('Annots', fields);
    doc.getTrailer().get('Root').put('AcroForm', { Fields: fields, SigFlags: 3 });
  });
}

/** A form whose only signature field is `kidName`, a kid of the non-terminal field `form`. */
async function withNestedField(kidName: string): Promise<Uint8Array> {
  return blank('', 1, (doc) => {
    const page = doc.findPage(0);
    const parent = doc.addObject({ T: doc.newString('form') });
    const kid = doc.addObject({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: doc.newString(kidName),
      F: 4,
      Rect: [10, 10, 120, 40],
      P: page,
      Parent: parent,
    });
    parent.put('Kids', [kid]);
    page.put('Annots', [kid]);
    doc
      .getTrailer()
      .get('Root')
      .put('AcroForm', { Fields: [parent], SigFlags: 3 });
  });
}

/** The `/T` of every signature widget on every page of a produced file, with its page. */
async function fieldPages(bytes: Uint8Array): Promise<[string | null, number][]> {
  const widgets = await widgetsOf(bytes);
  const found = widgets.map((entry): [string | null, number] => [
    readText(entry.widget.get('T')),
    entry.page,
  ]);
  widgets[0]?.doc.destroy();
  return found;
}

describe('byteRangeText', () => {
  it('pads every number to the width of the placeholder it overwrites', () => {
    expect(byteRangeText([0, 1234, 5678, 90], 45)).toBe('[0000000000 0000001234 0000005678 0000000090]');
  });

  it('refuses a number the fixed width cannot hold instead of shifting the bytes after it', () => {
    let failure: unknown;
    try {
      byteRangeText([0, 123, 456, 10 ** 10], 45);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'internal',
      details: {
        engineMessage:
          'the /ByteRange [0000000000 0000000123 0000000456 10000000000] is 46 characters wide ' +
          'but the placeholder it overwrites is 45',
      },
    });
  });
});

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

  it('signs an already signed file by appending, so the earlier signature stays valid', async () => {
    const first = await signPdf(
      await blank(),
      { identity: await identity(), field: { name: 'Birinci' } },
      run,
    );
    expect(first.report.incremental).toBe(false);
    const second = await signPdf(first.bytes, { identity: await identity(), field: { name: 'Ikinci' } }, run);
    // Every byte the first signature covers is still where it was.
    expect(Buffer.from(second.bytes.subarray(0, first.bytes.length)).equals(Buffer.from(first.bytes))).toBe(
      true,
    );
    expect(second.report.incremental).toBe(true);
    expect(second.report.notes.filter((entry) => entry.key.startsWith('op.note.sign.earlier'))).toEqual([
      { kind: 'preserved', key: 'op.note.sign.earlierKept', params: { count: 1 } },
    ]);
    const verdicts = await verifySignatures(second.bytes, run.signal);
    expect(verdicts.map((entry) => [entry.fieldName, entry.integrity, entry.changesAfterSigning])).toEqual([
      ['Birinci', 'valid', 1],
      ['Ikinci', 'valid', 0],
    ]);
  });

  it('rewrites a signed file MuPDF cannot append to, and reports the earlier signature as lost', async () => {
    const first = await signPdf(
      await blank(),
      { identity: await identity(), field: { name: 'Birinci' } },
      run,
    );
    // A cross-reference table that points nowhere: MuPDF repairs the file on open and cannot append.
    const damaged = Buffer.from(first.bytes)
      .toString('latin1')
      .replace(/startxref\s+\d+/, 'startxref\n7');
    const second = await signPdf(
      new Uint8Array(Buffer.from(damaged, 'latin1')),
      { identity: await identity(), field: { name: 'Ikinci' } },
      run,
    );
    expect(second.report.incremental).toBe(false);
    expect(second.report.notes.filter((entry) => entry.key.startsWith('op.note.sign.earlier'))).toEqual([
      { kind: 'lost', key: 'op.note.sign.earlierLost', params: { count: 1 } },
    ]);
    const verdicts = await verifySignatures(second.bytes, run.signal);
    expect(verdicts.find((entry) => entry.fieldName === 'Ikinci')?.integrity).toBe('valid');
  });

  it('gives a second unnamed signature a field name of its own, even within the same second', async () => {
    // The default name is `Signature<seconds>`: pin the clock so both signatures get the same
    // second and the second one has to step past the name the first one took.
    const now = new Date(Date.UTC(2026, 5, 1, 12));
    const seconds = Math.floor(now.getTime() / 1000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    try {
      const first = await signPdf(await blank(), { identity: await identity() }, run);
      const second = await signPdf(first.bytes, { identity: await identity() }, run);
      const verdicts = await verifySignatures(second.bytes, run.signal);
      expect(verdicts.map((entry) => [entry.fieldName, entry.integrity])).toEqual([
        [`Signature${seconds}`, 'valid'],
        [`Signature${seconds + 1}`, 'valid'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a field name that another field of the document already uses', async () => {
    const first = await signPdf(
      await blank(),
      { identity: await identity(), field: { name: 'Birinci' } },
      run,
    );
    await expect(
      signPdf(first.bytes, { identity: await identity(), field: { name: 'Birinci' } }, run),
    ).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { path: 'request.field.name' },
    });
  });

  it('fills an empty field nested under a parent by its full name, and keeps that name as a parent’s', async () => {
    const source = await withNestedField('sig');
    const out = await signPdf(source, { identity: await identity(), field: { name: 'form.sig' } }, run);
    expect(out.report.steps[1]).toBe('field.reuse');
    expect(out.report.notes[0]).toEqual({
      kind: 'changed',
      key: 'op.note.sign.fieldFilled',
      params: { name: 'form.sig' },
    });
    expect(
      (await verifySignatures(out.bytes, run.signal)).map((entry) => [entry.fieldName, entry.integrity]),
    ).toEqual([['form.sig', 'valid']]);

    // The leaf name alone is not the field's name, and the parent's name is taken.
    const byLeaf = await signPdf(source, { identity: await identity(), field: { name: 'sig' } }, run);
    expect(byLeaf.report.steps[1]).toBe('field.create');
    await expect(
      signPdf(source, { identity: await identity(), field: { name: 'form' } }, run),
    ).rejects.toMatchObject({ code: 'value-out-of-range', details: { path: 'request.field.name' } });
  });

  it('reads an empty /T as no name, the way the verifier does', async () => {
    const out = await signPdf(await withNestedField(''), { identity: await identity() }, run);
    expect(out.report.notes[0]).toEqual({
      kind: 'changed',
      key: 'op.note.sign.fieldFilled',
      params: { name: 'form' },
    });
    expect(
      (await verifySignatures(out.bytes, run.signal)).map((entry) => [entry.fieldName, entry.integrity]),
    ).toEqual([['form', 'valid']]);
  });

  it('creates a named field in a form whose lists hold odd entries, repeats and loops', async () => {
    const source = await blank('', 1, (doc) => {
      const page = doc.findPage(0);
      const link = doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 10, 10] });
      const unnamed = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        Rect: [0, 0, 5, 5],
        P: page,
      });
      const looped = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: doc.newString('Dongu'),
        Rect: [0, 0, 5, 5],
        P: page,
      });
      looped.put('Parent', looped);
      const orphan = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Tx',
        T: doc.newString('Yetim'),
        Rect: [0, 0, 5, 5],
        P: page,
        Parent: 5,
      });
      const empty = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: doc.newString('Mevcut'),
        Rect: [10, 10, 120, 40],
        P: page,
      });
      page.put('Annots', [5, link, unnamed, looped, orphan, empty]);
      // The same field twice, a number, a PDF null, two fields written inline (one with no
      // name) and a chain of fields far deeper than a form is.
      const chain = Array.from({ length: 36 }, (_, index) =>
        doc.addObject({ T: doc.newString(`d${index}`) }),
      );
      chain.forEach((node, index) => {
        const next = chain[index + 1];
        if (next !== undefined) node.put('Kids', [next]);
      });
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', {
          Fields: [empty, empty, 7, null, { T: doc.newString('Satir') }, { FT: 'Tx' }, chain[0]],
          SigFlags: 3,
        });
    });
    const out = await signPdf(source, { identity: await identity(), field: { name: 'Yeni' } }, run);
    expect(out.report.steps[1]).toBe('field.create');
    expect(out.report.notes[0]).toMatchObject({ key: 'op.note.sign.fieldCreated', params: { name: 'Yeni' } });
    expect(await fieldPages(out.bytes)).toContainEqual(['Yeni', 0]);
    expect((await verifySignatures(out.bytes, run.signal)).map((entry) => entry.fieldName)).toEqual(['Yeni']);
    // A widget whose `/Parent` is no dictionary keeps its own name, and that name is taken;
    // so is the name of a field written inline in `/Fields`.
    for (const name of ['Yetim', 'Satir']) {
      await expect(
        signPdf(source, { identity: await identity(), field: { name } }, run),
      ).rejects.toMatchObject({ code: 'value-out-of-range', details: { path: 'request.field.name' } });
    }
    // The chain is followed 33 levels down (the verifier's own bound) and not further.
    const chained = (levels: number): string => Array.from({ length: levels }, (_, i) => `d${i}`).join('.');
    await expect(
      signPdf(source, { identity: await identity(), field: { name: chained(33) } }, run),
    ).rejects.toMatchObject({ code: 'value-out-of-range', details: { path: 'request.field.name' } });
    const beyond = await signPdf(source, { identity: await identity(), field: { name: chained(34) } }, run);
    expect(beyond.report.steps[1]).toBe('field.create');
  });

  it('treats an empty field name as none: the first empty field is filled', async () => {
    const out = await signPdf(
      await withEmptyFields(['Bir', 'Iki']),
      { identity: await identity(), field: { name: '' } },
      run,
    );
    expect(out.report.steps[1]).toBe('field.reuse');
    expect(out.report.notes[0]).toMatchObject({ key: 'op.note.sign.fieldFilled', params: { name: 'Bir' } });
  });

  it('fills a hidden empty field in place when no rectangle is asked for, and draws no appearance', async () => {
    const out = await signPdf(await withEmptyFields(['Gizli'], null), { identity: await identity() }, run);
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.sign.fieldPlaceKept');
    const [entry] = await widgetsOf(out.bytes);
    expect(readNumbers(entry?.widget.get('Rect'))).toEqual([0, 0, 0, 0]);
    expect(entry?.widget.get('AP').isNull()).toBe(true);
    entry?.doc.destroy();
    expect((await verifySignatures(out.bytes, run.signal))[0]).toMatchObject({
      fieldName: 'Gizli',
      integrity: 'valid',
    });
  });

  it('gives an empty field that has no /Rect at all the requested rectangle on its own page', async () => {
    const source = await blank('', 1, (doc) => {
      const page = doc.findPage(0);
      const field = doc.addObject({
        Type: 'Annot',
        Subtype: 'Widget',
        FT: 'Sig',
        T: doc.newString('SizRect'),
        P: page,
      });
      page.put('Annots', [field]);
      doc
        .getTrailer()
        .get('Root')
        .put('AcroForm', { Fields: [field], SigFlags: 3 });
    });
    const out = await signPdf(
      source,
      { identity: await identity(), field: { rect: { x: 5, y: 6, width: 70, height: 20 }, lines: ['Ayse'] } },
      run,
    );
    expect(await fieldPages(out.bytes)).toEqual([['SizRect', 0]]);
    const [entry] = await widgetsOf(out.bytes);
    expect(readNumbers(entry?.widget.get('Rect'))).toEqual([5, 6, 75, 26]);
    expect(entry?.widget.get('AP').get('N').readStream().asString()).toContain('(Ayse) Tj');
    entry?.doc.destroy();
  });

  it('creates the field it was named for, with an appearance, although another empty one exists', async () => {
    const out = await signPdf(
      await withEmptyField(),
      {
        identity: await identity(),
        field: { name: 'Onay', rect: { x: 20, y: 20, width: 160, height: 50 }, pageIndex: 0 },
        reason: 'Onaylandi',
      },
      run,
    );
    expect(out.report.steps[1]).toBe('field.create');
    expect(out.report.notes[0]).toEqual({
      kind: 'changed',
      key: 'op.note.sign.fieldCreated',
      params: { name: 'Onay' },
    });
    const verdicts = await verifySignatures(out.bytes, run.signal);
    expect(verdicts.map((entry) => [entry.fieldName, entry.integrity])).toEqual([['Onay', 'valid']]);

    const widgets = await widgetsOf(out.bytes);
    const named = widgets.find((entry) => readText(entry.widget.get('T')) === 'Onay');
    const other = widgets.find((entry) => readText(entry.widget.get('T')) === 'Mevcut');
    expect(named?.page).toBe(0);
    expect(named?.widget.get('AP').get('N').readStream().asString()).toContain('(Onaylandi) Tj');
    // The other empty field is untouched: still empty, still on its page.
    expect(other?.page).toBe(1);
    expect(other?.widget.get('V').isNull()).toBe(true);
    widgets[0]?.doc.destroy();
  });

  it('fills only the empty field it was named for, drawing the appearance in the field’s own rectangle', async () => {
    const out = await signPdf(
      await withEmptyFields(['Bos', 'Hedef']),
      {
        identity: await identity(),
        field: {
          name: 'Hedef',
          rect: { x: 200, y: 300, width: 50, height: 20 },
          lines: ['Ayse', 'Onay'],
        },
      },
      run,
    );
    expect(out.report.steps[1]).toBe('field.reuse');
    expect(out.report.notes.slice(0, 2)).toEqual([
      { kind: 'changed', key: 'op.note.sign.fieldFilled', params: { name: 'Hedef' } },
      { kind: 'preserved', key: 'op.note.sign.fieldPlaceKept', params: { name: 'Hedef' } },
    ]);
    const widgets = await widgetsOf(out.bytes);
    const target = widgets.find((entry) => readText(entry.widget.get('T')) === 'Hedef')?.widget;
    const untouched = widgets.find((entry) => readText(entry.widget.get('T')) === 'Bos')?.widget;
    expect(readNumbers(target?.get('Rect'))).toEqual([10, 10, 120, 40]);
    expect(readNumbers(target?.get('AP').get('N').get('BBox'))).toEqual([0, 0, 110, 30]);
    const content = target?.get('AP').get('N').readStream().asString() ?? '';
    expect(content).toContain('(Ayse) Tj');
    expect(content).toContain('(Onay) Tj');
    expect(untouched?.get('V').isNull()).toBe(true);
    expect(untouched?.get('AP').isNull()).toBe(true);
    widgets[0]?.doc.destroy();
  });

  it('makes a hidden empty field visible at the requested rectangle, on the requested page', async () => {
    const out = await signPdf(
      await withEmptyFields(['Gizli'], null, 2),
      {
        identity: await identity(),
        field: { rect: { x: 30, y: 40, width: 100, height: 30 }, pageIndex: 1, lines: ['Ayse'] },
      },
      run,
    );
    expect(out.report.notes.map((entry) => entry.key)).not.toContain('op.note.sign.fieldPlaceKept');
    expect(await fieldPages(out.bytes)).toEqual([['Gizli', 1]]);
    const [entry] = await widgetsOf(out.bytes);
    expect(readNumbers(entry?.widget.get('Rect'))).toEqual([30, 40, 130, 70]);
    expect(entry?.widget.get('AP').get('N').readStream().asString()).toContain('(Ayse) Tj');
    entry?.doc.destroy();
    expect((await verifySignatures(out.bytes, run.signal))[0]).toMatchObject({
      fieldName: 'Gizli',
      integrity: 'valid',
    });
  });

  it('judges the signature it wrote, not whichever signature field comes last', async () => {
    const real = await identity();
    const other = await generateKey({ kind: 'EC', curve: 'P-256' });
    // `Hedef` is signed first, so it is a valid signature listed *after* the empty `Bos`.
    const first = await signPdf(
      await withEmptyFields(['Bos', 'Hedef']),
      { identity: real, field: { name: 'Hedef' } },
      run,
    );
    await expect(
      signPdf(
        first.bytes,
        { identity: { certificate: real.certificate, privateKey: other.privateKey }, field: { name: 'Bos' } },
        run,
      ),
    ).rejects.toMatchObject({
      code: 'verification-failed',
      details: {
        engineMessage: expect.stringMatching(/^the produced signature does not verify: integrity "invalid"/),
      },
    });
    const ok = await signPdf(first.bytes, { identity: real, field: { name: 'Bos' } }, run);
    expect(
      (await verifySignatures(ok.bytes, run.signal)).map((entry) => [entry.fieldName, entry.integrity]),
    ).toEqual([
      ['Bos', 'valid'],
      ['Hedef', 'valid'],
    ]);
  });

  it('writes no signingTime attribute: the time of a PAdES B-B signature is the /M of its dictionary', async () => {
    const out = await signPdf(
      await blank(),
      { identity: await identity(), date: new Date(Date.UTC(2026, 5, 1, 12, 0, 5)) },
      run,
    );
    const [entry] = await widgetsOf(out.bytes);
    const signature = entry?.widget.get('V').resolve();
    const contents = new Uint8Array(signature?.get('Contents').asByteString() ?? []);
    const attributes = readSignedData(contents)?.signerInfos[0]?.signedAttrs?.attributes ?? [];
    expect(attributes.map((attribute) => attribute.type).sort()).toEqual([
      '1.2.840.113549.1.9.16.2.47', // signingCertificateV2
      '1.2.840.113549.1.9.3', // contentType
      '1.2.840.113549.1.9.4', // messageDigest
    ]);
    expect(readText(signature?.get('M'))).toBe('D:20260601120005Z');
    entry?.doc.destroy();
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
