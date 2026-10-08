/**
 * `listPdfSignatureFields`: which signature fields a document has and which of them carry a
 * signature. The documents are real (MuPDF builds the fields, `signPdf` signs one) and are
 * read by the real pdf.js engine. The engine answers that a healthy pdf.js never gives
 * (no field map, a field list that is not a list, a nameless widget) are produced by wrapping
 * the real handle's `raw` document, because the function has to survive them.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { afterEach, describe, expect, it } from 'vitest';
import { openWithPdfjs, type PdfDocumentHandle } from './engines/pdfjs-handle';
import { signPdf } from './ops/sign';
import { listPdfSignatureFields } from './signature-fields';
import { generateKey, issueCertificate } from './signature-trust.fixtures';

const run = { signal: new AbortController().signal };
const handles: PdfDocumentHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.destroy()));
});

async function open(bytes: Uint8Array): Promise<PdfDocumentHandle> {
  const handle = await openWithPdfjs(bytes);
  handles.push(handle);
  return handle;
}

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

/** A two-page document edited by `prepare`, saved as it is. */
async function build(prepare: (doc: PDFDocument) => void, source?: Uint8Array): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  let doc: PDFDocument;
  if (source === undefined) {
    doc = new mupdf.PDFDocument();
    for (let index = 0; index < 2; index += 1) {
      doc.insertPage(index, doc.addPage([0, 0, 300, 400], 0, {}, ''));
    }
  } else {
    const opened = mupdf.PDFDocument.openDocument(source, 'application/pdf').asPDF();
    if (opened === null) throw new Error('not a PDF');
    doc = opened;
  }
  prepare(doc);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Add a widget to page `pageIndex` and to the AcroForm field list. */
function addField(
  doc: PDFDocument,
  pageIndex: number,
  entries: Record<string, unknown>,
  parent?: PDFObject,
): PDFObject {
  const page = doc.findPage(pageIndex);
  const field = doc.addObject({
    Type: 'Annot',
    Subtype: 'Widget',
    F: 4,
    Rect: [10, 10, 120, 40],
    P: page,
    ...entries,
    ...(parent === undefined ? {} : { Parent: parent }),
  });
  const annots = page.get('Annots');
  if (annots.isNull()) page.put('Annots', [field]);
  else annots.push(field);
  if (parent === undefined) {
    const root = doc.getTrailer().get('Root');
    if (root.get('AcroForm').isNull()) root.put('AcroForm', { Fields: [], SigFlags: 3 });
    root.get('AcroForm').get('Fields').push(field);
  }
  return field;
}

/** A real handle whose `raw` document answers `getFieldObjects` / `getSignatures` as given. */
async function withAnswers(
  bytes: Uint8Array,
  answers: { fields?: unknown; signatures?: unknown; fieldsError?: Error },
): Promise<PdfDocumentHandle> {
  const handle = await open(bytes);
  const raw = new Proxy(handle.raw, {
    get(target, property) {
      if (property === 'getFieldObjects') {
        return async () => {
          if (answers.fieldsError !== undefined) throw answers.fieldsError;
          return answers.fields;
        };
      }
      if (property === 'getSignatures') return async () => answers.signatures;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { ...handle, raw };
}

describe('listPdfSignatureFields', () => {
  it('lists signed and unsigned signature fields with their page and leaves other fields out', async () => {
    const signed = await signPdf(
      await build(() => undefined),
      {
        identity: await identity(),
        field: { name: 'Imzali', pageIndex: 1, rect: { x: 20, y: 20, width: 100, height: 30 } },
      },
      run,
    );
    const bytes = await build((doc) => {
      addField(doc, 0, { FT: 'Sig', T: doc.newString('Bos') });
      addField(doc, 0, { FT: 'Tx', T: doc.newString('Metin'), V: doc.newString('merhaba') });
    }, signed.bytes);
    const fields = await listPdfSignatureFields(await open(bytes));
    const byName = new Map(fields.map((field) => [field.name, field]));
    expect([...byName.keys()].sort()).toEqual(['Bos', 'Imzali']);
    expect(byName.get('Imzali')).toMatchObject({ pageIndex: 1, signed: true });
    expect(byName.get('Bos')).toMatchObject({ pageIndex: 0, signed: false });
    expect(byName.get('Imzali')?.id).toMatch(/^\d+R$/);
  });

  it('answers an empty list for a document without form fields', async () => {
    expect(await listPdfSignatureFields(await open(await build(() => undefined)))).toEqual([]);
  });

  it('answers an empty list when the document has fields but none is a signature', async () => {
    const bytes = await build((doc) => {
      addField(doc, 0, { FT: 'Tx', T: doc.newString('Metin') });
    });
    expect(await listPdfSignatureFields(await open(bytes))).toEqual([]);
  });

  it('matches a signature to a field with a dotted name by the leaf name the signature carries', async () => {
    const signed = await signPdf(
      await build(() => undefined),
      { identity: await identity(), field: { name: 'Imza' } },
      run,
    );
    // Move the signed field under a parent: its full name becomes `Form.Imza`.
    const bytes = await build((doc) => {
      const root = doc.getTrailer().get('Root');
      const fieldList = root.get('AcroForm').get('Fields');
      const leaf = fieldList.get(0);
      const parent = doc.addObject({ T: doc.newString('Form'), Kids: [leaf] });
      leaf.put('Parent', parent);
      fieldList.delete(0);
      fieldList.push(parent);
    }, signed.bytes);
    const fields = await listPdfSignatureFields(await open(bytes));
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ name: 'Form.Imza', pageIndex: 0, signed: true });
  });

  it('uses the widget id as the name of a signature widget that has none', async () => {
    const bytes = await build((doc) => {
      addField(doc, 0, { FT: 'Sig' });
    });
    const fields = await listPdfSignatureFields(await open(bytes));
    expect(fields).toHaveLength(1);
    expect(fields[0]?.name).toBe(fields[0]?.id);
    expect(fields[0]?.signed).toBe(false);
  });

  it('survives engine answers that are not the shapes pdf.js gives', async () => {
    const bytes = await build(() => undefined);
    expect(await listPdfSignatureFields(await withAnswers(bytes, { fields: null }))).toEqual([]);
    expect(await listPdfSignatureFields(await withAnswers(bytes, { fields: undefined }))).toEqual([]);

    const widgets = new Map<string, unknown>([
      ['NotAList', 'text'],
      ['Mixed', [null, 7, { type: 'text', id: '1R' }, { type: 'signature', id: 9, page: 'one' }]],
      ['Named', [{ type: 'signature', id: '5R', page: 2 }]],
    ]);
    const answered = await listPdfSignatureFields(
      await withAnswers(bytes, {
        fields: widgets,
        signatures: [null, 'text', { fieldName: 7 }, { fieldName: '' }, { fieldName: 'Named' }],
      }),
    );
    expect(answered).toEqual([
      { name: 'Mixed', id: '', pageIndex: null, signed: false },
      { name: 'Named', id: '5R', pageIndex: 2, signed: true },
    ]);

    for (const signatures of [null, undefined]) {
      const none = await listPdfSignatureFields(
        await withAnswers(bytes, {
          fields: new Map([['A', [{ type: 'signature', id: '1R', page: 0 }]]]),
          signatures,
        }),
      );
      expect(none).toEqual([{ name: 'A', id: '1R', pageIndex: 0, signed: false }]);
    }
  });

  it('maps an engine failure to a tool error', async () => {
    const handle = await withAnswers(await build(() => undefined), { fieldsError: new Error('boom') });
    await expect(listPdfSignatureFields(handle)).rejects.toMatchObject({
      name: 'ToolError',
      details: { engine: 'pdfjs' },
    });
  });
});
