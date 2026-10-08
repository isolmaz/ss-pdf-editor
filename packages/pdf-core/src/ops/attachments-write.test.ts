/**
 * Embedded files, added and removed, against real bytes. The wrong answers that matter:
 * an attachment whose Turkish name or payload does not come back as written, a second
 * copy under a name that should have been replaced, an attachment that disappears from
 * the list but stays in the file (its bytes still travel with the document), a removal
 * of a name that is not there that rewrites the file anyway, and a `/Kids` tree that is
 * edited into an illegal shape instead of being refused.
 */

import { PDFDocument } from 'mupdf';
import { isToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { listPdfAttachments, readPdfAttachment } from '../attachments';
import { openWithPdfjs } from '../engines/pdfjs-handle';
import { addAttachments, removeAttachments } from './attachments-write';
import { handPdf } from './forms.fixtures';

const run = { signal: new AbortController().signal };
const encode = (value: string) => new TextEncoder().encode(value);

async function blankPdf(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

/** What a reader lists: name, description and payload text, in the engine's order. */
async function listed(bytes: Uint8Array) {
  const handle = await openWithPdfjs(bytes);
  try {
    const out: { name: string; description: string; text: string }[] = [];
    for (const attachment of await listPdfAttachments(handle)) {
      const payload = await readPdfAttachment(handle, attachment);
      out.push({
        name: attachment.filename,
        description: attachment.description,
        text: new TextDecoder().decode(payload),
      });
    }
    return out;
  } finally {
    await handle.destroy();
  }
}

/** The file's structure as MuPDF sees it: tree shells, `/AF`, and every file object left. */
async function structure(bytes: Uint8Array) {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    const root = doc.getTrailer().get('Root').resolve();
    const names = root.get('Names');
    const embedded = names.isNull() ? null : names.resolve().get('EmbeddedFiles');
    const af = root.get('AF');
    let fileObjects = 0;
    for (let number = 1; number < doc.countObjects(); number += 1) {
      const object = doc.newIndirect(number).resolve();
      if (!object.isDictionary()) continue;
      const type = object.get('Type');
      if (type.isName() && ['Filespec', 'EmbeddedFile'].includes(type.asName())) fileObjects += 1;
    }
    return {
      hasNames: !names.isNull(),
      hasEmbeddedFiles: embedded !== null && !embedded.isNull(),
      afLength: af.isNull() ? null : af.resolve().length,
      fileObjects,
    };
  } finally {
    doc.destroy();
  }
}

describe('addAttachments', () => {
  it('embeds files whose Turkish names, descriptions and payloads read back as written', async () => {
    const out = await addAttachments(
      await blankPdf(),
      [
        {
          name: 'şube-özeti.txt',
          bytes: encode('ığdır ÇÖŞ'),
          mime: 'text/plain',
          description: 'Yıllık özet',
        },
        { name: 'b.csv', bytes: encode('a,b\n1,2'), mime: 'text/csv' },
      ],
      run,
    );
    expect(out.added).toEqual(['şube-özeti.txt', 'b.csv']);
    const files = await listed(out.bytes);
    expect(files).toHaveLength(2);
    expect(files).toContainEqual({ name: 'şube-özeti.txt', description: 'Yıllık özet', text: 'ığdır ÇÖŞ' });
    expect(files).toContainEqual({ name: 'b.csv', description: '', text: 'a,b\n1,2' });
    // PDF/A-3 associated files: every attachment is listed from the catalog too.
    expect(await structure(out.bytes)).toMatchObject({ afLength: 2, fileObjects: 4 });
    expect(out.report.steps).toEqual(['load', 'attach', 'producer', 'save']);
  });

  it('keeps the name tree sorted, so a reader that binary-searches it finds every file', async () => {
    const first = await addAttachments(
      await blankPdf(),
      [
        { name: 'c.txt', bytes: encode('C'), mime: 'text/plain' },
        { name: 'a.txt', bytes: encode('A'), mime: 'text/plain' },
      ],
      run,
    );
    const second = await addAttachments(
      first.bytes,
      [{ name: 'b.txt', bytes: encode('B'), mime: 'text/plain' }],
      run,
    );
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(second.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    const pairs = doc.getTrailer().get('Root').resolve().get('Names').resolve().get('EmbeddedFiles');
    const array = pairs.resolve().get('Names').resolve();
    const keys: string[] = [];
    for (let index = 0; index < array.length; index += 2) keys.push(array.get(index).asString());
    doc.destroy();
    expect(keys).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  it('replaces an attachment of the same name instead of adding a second copy', async () => {
    const first = await addAttachments(
      await blankPdf(),
      [{ name: 'a.txt', bytes: encode('eski'), mime: 'text/plain' }],
      run,
    );
    const second = await addAttachments(
      first.bytes,
      [{ name: 'a.txt', bytes: encode('yeni'), mime: 'text/plain' }],
      run,
    );
    expect(await listed(second.bytes)).toEqual([{ name: 'a.txt', description: '', text: 'yeni' }]);
    expect(second.report.notes.map((entry) => entry.key)).toContain('op.note.attach.replaced');
    // The replaced file's objects do not stay behind in the file.
    expect(await structure(second.bytes)).toMatchObject({ afLength: 1, fileObjects: 2 });
  });
});

describe('removeAttachments', () => {
  async function withTwo(): Promise<Uint8Array> {
    const out = await addAttachments(
      await blankPdf(),
      [
        { name: 'a.txt', bytes: encode('A'), mime: 'text/plain' },
        { name: 'b.txt', bytes: encode('B'), mime: 'text/plain' },
      ],
      run,
    );
    return out.bytes;
  }

  it('removes the named file, reports the one that was not there, and keeps the other', async () => {
    const out = await removeAttachments(await withTwo(), ['a.txt', 'yok.txt'], run);
    expect(out.removed).toEqual(['a.txt']);
    expect(out.missing).toEqual(['yok.txt']);
    expect(await listed(out.bytes)).toEqual([{ name: 'b.txt', description: '', text: 'B' }]);
    expect(await structure(out.bytes)).toMatchObject({ afLength: 1, fileObjects: 2 });
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.attach.missing');
  });

  it('leaves no name tree, no /AF and no file object behind once the last file goes', async () => {
    const out = await removeAttachments(await withTwo(), ['a.txt', 'b.txt'], run);
    expect(await listed(out.bytes)).toEqual([]);
    expect(await structure(out.bytes)).toEqual({
      hasNames: false,
      hasEmbeddedFiles: false,
      afLength: null,
      fileObjects: 0,
    });
  });

  it('hands back the same bytes, untouched, when no name matched', async () => {
    const input = await withTwo();
    const out = await removeAttachments(input, ['yok.txt'], run);
    expect(out.bytes).toBe(input);
    expect(out.report.incremental).toBe(true);
    expect(out.missing).toEqual(['yok.txt']);
  });

  it('refuses a name tree deeper than one level rather than editing it', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
    const spec = doc.addEmbeddedFile('k.txt', 'text/plain', encode('K'), new Date(0), new Date(0));
    const leaf = doc.addObject(doc.newDictionary());
    const pairs = doc.newArray();
    pairs.push(doc.newString('k.txt'));
    pairs.push(spec);
    leaf.put('Names', pairs);
    const limits = doc.newArray();
    limits.push(doc.newString('k.txt'));
    limits.push(doc.newString('k.txt'));
    leaf.put('Limits', limits);
    const kids = doc.newArray();
    kids.push(leaf);
    const tree = doc.newDictionary();
    tree.put('Kids', kids);
    const names = doc.newDictionary();
    names.put('EmbeddedFiles', tree);
    doc.getTrailer().get('Root').resolve().put('Names', names);
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();

    await expect(removeAttachments(bytes, ['k.txt'], run)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      addAttachments(bytes, [{ name: 'x.txt', bytes: encode('X'), mime: 'text/plain' }], run),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('attachment edge cases', () => {
  it('adds nothing and removes nothing for an empty request, handing back the same bytes', async () => {
    const input = await blankPdf();
    const added = await addAttachments(input, [], run);
    expect(added.bytes).toBe(input);
    expect(added.added).toEqual([]);
    expect(added.report.notes.map((entry) => entry.key)).toEqual(['op.note.attach.nothing']);
    const removed = await removeAttachments(input, [], run);
    expect(removed.bytes).toBe(input);
    expect(removed.removed).toEqual([]);
    expect(removed.missing).toEqual([]);
  });

  it('reports a name as missing in a document that has no attachments at all', async () => {
    const input = await blankPdf();
    const out = await removeAttachments(input, ['a.txt'], run);
    expect(out.bytes).toBe(input);
    expect(out.missing).toEqual(['a.txt']);
    expect(out.removed).toEqual([]);
  });

  it('removes every pair of a name the tree lists twice, leaving the other file', async () => {
    const doc = new PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
    const pairs = doc.newArray();
    for (const [name, body] of [
      ['d.txt', 'one'],
      ['d.txt', 'two'],
      ['e.txt', 'kept'],
    ] as const) {
      pairs.push(doc.newString(name));
      pairs.push(doc.addEmbeddedFile(name, 'text/plain', encode(body), new Date(0), new Date(0)));
    }
    const embedded = doc.newDictionary();
    embedded.put('Names', pairs);
    const names = doc.newDictionary();
    names.put('EmbeddedFiles', embedded);
    doc.getTrailer().get('Root').put('Names', names);
    const input = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();

    const out = await removeAttachments(input, ['d.txt'], run);
    expect(out.removed).toEqual(['d.txt']);
    expect(await listed(out.bytes)).toEqual([{ name: 'e.txt', description: '', text: 'kept' }]);
  });

  it('removes a file specification that is a direct dictionary without any embedded stream', async () => {
    const doc = new PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, 200, 200], 0, {}, ''));
    const direct = doc.newDictionary();
    direct.put('Type', doc.newName('Filespec'));
    direct.put('F', doc.newString('d.txt'));
    const pairs = doc.newArray();
    pairs.push(doc.newString('d.txt'));
    pairs.push(direct);
    const embedded = doc.newDictionary();
    embedded.put('Names', pairs);
    const names = doc.newDictionary();
    names.put('EmbeddedFiles', embedded);
    doc.getTrailer().get('Root').put('Names', names);
    const input = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    doc.destroy();

    const out = await removeAttachments(input, ['d.txt'], run);
    expect(out.removed).toEqual(['d.txt']);
    expect(await structure(out.bytes)).toMatchObject({ hasNames: false, hasEmbeddedFiles: false });
  });

  it('refuses a document whose trailer names no catalog', async () => {
    const input = handPdf({ 2: '<</Type/Pages/Kids[]/Count 0>>' });
    const failure = await addAttachments(
      input,
      [{ name: 'a.txt', bytes: encode('A'), mime: 'text/plain' }],
      run,
    ).catch((error: unknown) => error);
    expect(isToolError(failure) && failure.code).toBe('corrupt-document');
  });
});
