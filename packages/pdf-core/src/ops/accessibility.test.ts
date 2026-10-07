/**
 * Accessibility against real bytes: the check's facts, the tagger's structure tree over
 * real marked content, and the alt-text writer. The wrong answers that matter: a tree
 * whose MCIDs are not in the content stream, a heading that is not guessed from its size,
 * an image drawn by two pages whose alt text is reported for one, and a field tooltip
 * written as a name instead of text.
 */

import { ToolError } from 'pdf-shared';
import { describe, expect, it } from 'vitest';
import { checkAccessibility, engineFailure, setImageAlt, tagDocument } from './accessibility';

const run = { signal: new AbortController().signal };

/**
 * Two A4 pages. Page 1: a 24 pt heading, a 11 pt paragraph and an image `Im1`. Page 2:
 * another paragraph and the same image. A text field `ad` without a tooltip and a link
 * without `/Contents` complete the facts the check reads.
 */
async function fixture(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
  pixmap.clear(0);
  const image = doc.addImage(new mupdf.Image(pixmap));
  const resources = { Font: { F: font }, XObject: { Im1: image } };
  const first =
    'BT /F 24 Tf 72 760 Td (Annual Report) Tj ET\n' +
    'BT /F 11 Tf 72 700 Td (The year was good for everyone involved.) Tj ET\n' +
    'q 100 0 0 100 72 500 cm /Im1 Do Q';
  const second =
    'BT /F 11 Tf 72 760 Td (Second page body text is here.) Tj ET\nq 50 0 0 50 72 600 cm /Im1 Do Q';
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, resources, first));
  doc.insertPage(1, doc.addPage([0, 0, 595, 842], 0, resources, second));
  const page = doc.findPage(0);
  const field = doc.addObject({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Tx',
    T: doc.newString('ad'),
    Rect: [72, 300, 272, 320],
    P: page,
  });
  const link = doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [72, 200, 172, 220] });
  page.put('Annots', [field, link]);
  doc
    .getTrailer()
    .get('Root')
    .put('AcroForm', { Fields: [field] });
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const states = (report: Awaited<ReturnType<typeof checkAccessibility>>) =>
  Object.fromEntries(report.findings.map((finding) => [finding.id, finding.state]));

describe('accessibility', () => {
  it('reports the facts of an untagged file, the shared image and the field by name', async () => {
    const report = await checkAccessibility(await fixture(), run);
    expect(report.pageCount).toBe(2);
    expect(states(report)).toMatchObject({
      'struct-tree': 'problem',
      'mark-info': 'problem',
      lang: 'problem',
      'image-alt': 'problem',
      'field-tooltip': 'problem',
      'link-contents': 'problem',
      paragraphs: 'unchecked',
    });
    expect(report.images).toHaveLength(1);
    expect(report.images[0]).toMatchObject({ pageIndex: 0, name: 'Im1', pages: [0, 1], alt: null, width: 4 });
    expect(report.fields).toEqual([{ name: 'ad', tooltip: null, pageIndex: 0 }]);
  });

  it('tags headings, paragraphs and figures over real marked content, then the check sees them', async () => {
    const out = await tagDocument(await fixture(), run, { language: 'tr-TR' });
    expect(out.report.steps).toEqual(['load', 'structure', 'producer', 'save', 'verify']);
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).toEqual(expect.arrayContaining(['op.note.a11y.tagged', 'op.note.a11y.langSet']));

    const report = await checkAccessibility(out.bytes, run);
    expect(states(report)).toMatchObject({
      'struct-tree': 'ok',
      'mark-info': 'ok',
      lang: 'ok',
      paragraphs: 'ok',
    });
    expect(report.structure.roles).toMatchObject({ Document: 1, H1: 1, P: 2, Figure: 2 });
    await expect(tagDocument(out.bytes, run)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('writes a structure tree whose MCRs, parent tree and content stream name the same MCIDs', async () => {
    const out = await tagDocument(await fixture(), run, { language: 'tr-TR' });
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const root = doc.getTrailer().get('Root').get('StructTreeRoot');
      const kids = root.get('K').get(0).get('K');
      const parentTree = root.get('ParentTree').get('Nums');
      const elements: { role: string; mcid: number; page: number }[] = [];
      for (let index = 0; index < kids.length; index += 1) {
        const element = kids.get(index);
        const mcr = element.get('K').get(0);
        elements.push({
          role: element.get('S').asName(),
          mcid: mcr.get('MCID').asNumber(),
          page: (() => {
            const target = mcr.get('Pg').asIndirect();
            for (let candidate = 0; candidate < doc.countPages(); candidate += 1)
              if (doc.findPage(candidate).asIndirect() === target) return candidate;
            return -1;
          })(),
        });
      }
      expect(elements.map((element) => `${element.role}@${element.page}`).sort()).toEqual([
        'Figure@0',
        'Figure@1',
        'H1@0',
        'P@0',
        'P@1',
      ]);

      for (let pageIndex = 0; pageIndex < doc.countPages(); pageIndex += 1) {
        const content = doc.findPage(pageIndex).get('Contents');
        const stream = content.isArray() ? content.get(0) : content;
        const text = stream.readStream().asString();
        const started = [...text.matchAll(/\/P <<\/MCID (\d+)>> BDC/g)].map((match) => Number(match[1]));
        const written = elements
          .filter((element) => element.page === pageIndex)
          .map((element) => element.mcid);
        // Page 0 holds H1, P and a figure; page 1 a P and a figure (see the roles above).
        expect(written).toHaveLength(pageIndex === 0 ? 3 : 2);
        // Every MCR points at a marked-content sequence the page really has, and the page has no other.
        expect([...started].sort()).toEqual([...written].sort());
        // The parent tree is indexed by MCID and hands back the element that owns it.
        const structParents = doc.findPage(pageIndex).get('StructParents').asNumber();
        let entry = null;
        for (let at = 0; at < parentTree.length; at += 2)
          if (parentTree.get(at).asNumber() === structParents) entry = parentTree.get(at + 1);
        expect(entry).not.toBeNull();
        for (const mcid of written) {
          const owner = entry?.get(mcid);
          expect(owner?.get('K').get(0).get('MCID').asNumber()).toBe(mcid);
        }
      }
    } finally {
      doc.destroy();
    }
  });

  it('writes an alt text shared by every page that draws the image, and a Turkish tooltip', async () => {
    const out = await setImageAlt(
      await fixture(),
      [
        { kind: 'image', pageIndex: 1, name: 'Im1', alt: 'Şirket logosu' },
        { kind: 'field', name: 'ad', tooltip: 'Adınız ve soyadınız' },
        { kind: 'field', name: 'yok', tooltip: 'x' },
      ],
      run,
    );
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).toEqual(
      expect.arrayContaining(['op.note.a11y.altSet', 'op.note.a11y.altShared', 'op.note.a11y.targetMissing']),
    );
    const report = await checkAccessibility(out.bytes, run);
    expect(report.images[0]?.alt).toBe('Şirket logosu');
    expect(report.fields[0]?.tooltip).toBe('Adınız ve soyadınız');
    await expect(
      setImageAlt(await fixture(), [{ kind: 'image', pageIndex: 0, name: 'Im1', alt: ' ' }], run),
    ).rejects.toMatchObject({ code: 'value-out-of-range' });
  });
});

describe('engineFailure', () => {
  it("hands back the caller's abort and a ToolError as they are, and maps anything else with the step that was running", () => {
    const abort = new Error('operation aborted');
    abort.name = 'AbortError';
    expect(engineFailure(abort, 'step')).toBe(abort);
    const known = new ToolError('corrupt-document', { engine: 'mupdf', engineMessage: 'broken' });
    expect(engineFailure(known, 'step')).toBe(known);
    const mapped = engineFailure(new Error('cannot open file'), 'check things');
    expect(mapped).toBeInstanceOf(ToolError);
    expect(mapped).toMatchObject({
      code: 'corrupt-document',
      details: { engineMessage: 'check things: cannot open file' },
    });
    expect(engineFailure('plain text', 'step')).toMatchObject({
      code: 'internal',
      details: { engineMessage: 'step: plain text' },
    });
  });
});
