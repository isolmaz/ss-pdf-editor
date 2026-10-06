/**
 * Document properties, against real bytes. The wrong answers that matter: a Turkish title
 * that comes back mangled, the producer line lost (a product policy), a "clean" that
 * leaves the old author behind or removes the producer, and an XMP packet duplicated or
 * dropped when it should be merged.
 */

import { describe, expect, it } from 'vitest';
import { PRODUCER_LINE, readMetadata, writeMetadata } from './metadata';

/** A one-page document whose Info carries an author and an odd, non-string key. */
async function fixture(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, {}, ''));
  const info = doc.addObject(doc.newDictionary());
  info.put('Author', doc.newString('Eski Yazar'));
  info.put('Custom', doc.newString('kept unless cleaned'));
  info.put('Trapped', 'False');
  doc.getTrailer().put('Info', info);
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const run = { signal: new AbortController().signal };

describe('writeMetadata', () => {
  it('writes Turkish Info fields that read back unchanged, with the producer line', async () => {
    const out = await writeMetadata(
      await fixture(),
      {
        patch: {
          title: 'Şişli Şubesi — Yıllık Rapor',
          author: 'Ayşe Çağlar',
          subject: 'Özet',
          keywords: ['rapor', 'ığdır'],
          creator: 'Editör',
          creationDate: 'D:20240102030405Z',
          writeXmp: false,
        },
        clean: false,
        cleanXmp: false,
      },
      run,
    );
    const read = await readMetadata(out.bytes);
    expect(read).toMatchObject({
      title: 'Şişli Şubesi — Yıllık Rapor',
      author: 'Ayşe Çağlar',
      subject: 'Özet',
      keywords: ['rapor', 'ığdır'],
      creator: 'Editör',
      producer: PRODUCER_LINE,
    });
    expect(read.creationDate?.startsWith('D:20240102030405')).toBe(true);
    expect(read.xmp).toBeUndefined();
    expect(out.report.steps).toEqual(['load', 'metadata', 'producer', 'save']);
  });

  it('cleans every Info key but the producer line before writing the patch', async () => {
    const out = await writeMetadata(
      await fixture(),
      { patch: { title: 'Yeni', writeXmp: false }, clean: true, cleanXmp: false },
      run,
    );
    const read = await readMetadata(out.bytes);
    expect(read.title).toBe('Yeni');
    expect(read.author).toBeUndefined();
    expect(read.producer).toBe(PRODUCER_LINE);
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.metadata.infoDropped');

    // Every Info key goes, including the ones `readMetadata` has no field for.
    const infoKeys = async (bytes: Uint8Array) => {
      const mupdf = await import('mupdf');
      const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
      if (doc === null) throw new Error('not a PDF');
      try {
        const keys: string[] = [];
        doc
          .getTrailer()
          .get('Info')
          .resolve()
          .forEach((_value, key) => {
            keys.push(String(key));
          });
        return keys.sort();
      } finally {
        doc.destroy();
      }
    };
    expect(await infoKeys(await fixture())).toEqual(['Author', 'Custom', 'Trapped']);
    expect(await infoKeys(out.bytes)).toEqual(['Producer', 'Title']);
  });

  it('creates one XMP packet, then merges into it rather than adding a second', async () => {
    const first = await writeMetadata(
      await fixture(),
      { patch: { title: 'Birinci', writeXmp: true }, clean: false, cleanXmp: false },
      run,
    );
    const second = await writeMetadata(
      first.bytes,
      { patch: { author: 'İkinci Yazar', writeXmp: true }, clean: false, cleanXmp: false },
      run,
    );
    const read = await readMetadata(second.bytes);
    expect(read.xmp).toBeDefined();
    expect(read.xmp?.split('<x:xmpmeta').length).toBe(2);
    expect(read.xmp).toContain('Birinci');
    expect(read.xmp).toContain('İkinci Yazar');
    expect(second.report.notes.map((entry) => entry.key)).toContain('op.note.metadata.xmpMerged');
    // The packet travels uncompressed, so readers and validators that look for it without
    // inflating streams find it as written.
    expect(new TextDecoder('latin1').decode(second.bytes)).toContain('<x:xmpmeta');
  });

  it('drops the XMP packet on request', async () => {
    const withXmp = await writeMetadata(
      await fixture(),
      { patch: { title: 'X', writeXmp: true }, clean: false, cleanXmp: false },
      run,
    );
    // Without this the drop would pass for a packet that was never read in the first place.
    expect((await readMetadata(withXmp.bytes)).xmp).toBeDefined();
    const cleaned = await writeMetadata(
      withXmp.bytes,
      { patch: { writeXmp: false }, clean: false, cleanXmp: true },
      run,
    );
    expect((await readMetadata(cleaned.bytes)).xmp).toBeUndefined();
  });

  it('refuses a creation date that is not a date', async () => {
    await expect(
      writeMetadata(
        await fixture(),
        { patch: { creationDate: 'yesterday-ish', writeXmp: false }, clean: false, cleanXmp: false },
        run,
      ),
    ).rejects.toMatchObject({ code: 'range-invalid' });
  });
});
