/**
 * The "exact layout" Word writer on pages built in the test and read back the way Word would:
 * the section's size and margins in twips, the anchors' stacking (shapes under the picture
 * under the text), the text boxes' words in reading order, the hyperlink relationship, the
 * media in the package, and mammoth's word count against the words written. The wrong answers
 * that matter: text above the wrong drawing, a link that goes nowhere, a page Word would
 * refuse (above 22 inches) or one that spills onto an extra page, and a document.xml that is
 * not well-formed XML (a namespace declared twice makes Word refuse the file).
 */

import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { writeLayoutDocx } from './docx-layout';
import { exportOffice } from './export-office';
import { circle, type FixturePage, line, officeDocument, picture } from './export-office-fixtures';
import type { OperationContext, OperationProgress } from './types';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

const run: OperationContext = { signal: new AbortController().signal };

/** A page of a rectangle, a circle, a picture and two separate paragraphs, the second a link. */
const FIRST: FixturePage = {
  images: { Photo: { width: 8, height: 8, rgb: [10, 200, 30] } },
  content: [
    '0.9 0.2 0.2 rg 40 400 120 60 re f',
    circle(300, 420, 30),
    picture('Photo', 40, 250, 100, 80),
    line('helvetica', 12, 60, 200, 'First paragraph holds these words'),
    line('helvetica', 12, 60, 100, 'Second paragraph links elsewhere'),
  ].join('\n'),
};

/** The PDF of `pages`, the first page's second paragraph under an external link. */
async function linked(pages: readonly FixturePage[]): Promise<Uint8Array> {
  const bytes = await officeDocument(pages);
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    const page = doc.findPage(0);
    page.put('Annots', [
      doc.addObject({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [60, 95, 250, 115],
        Border: [0, 0, 0],
        A: { S: 'URI', URI: '(https://example.com/docs?a=1&b=2)' },
      }),
    ]);
    return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  } finally {
    doc.destroy();
  }
}

interface Written {
  readonly zip: JSZip;
  readonly document: Document;
  readonly xml: string;
  readonly words: number;
  readonly counts: { boxes: number; shapes: number; pictures: number; rasters: number };
}

async function written(
  bytes: Uint8Array,
  pages: readonly number[],
  context: OperationContext = run,
): Promise<Written> {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    const result = await writeLayoutDocx(doc, pages, 'Plan', 'tr-TR', context);
    const zip = await JSZip.loadAsync(result.bytes);
    const xml = await text(zip, 'word/document.xml');
    const failures: string[] = [];
    const document = new DOMParser({
      errorHandler: (level: string, message: string) => failures.push(`${level}: ${message}`),
    }).parseFromString(xml, 'text/xml');
    expect(failures).toEqual([]);
    return {
      zip,
      document,
      xml,
      words: result.words,
      counts: {
        boxes: result.boxes,
        shapes: result.shapes,
        pictures: result.pictures,
        rasters: result.rasters,
      },
    };
  } finally {
    doc.destroy();
  }
}

async function text(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (file === null) throw new Error(`missing ${name}`);
  return file.async('string');
}

/** The files under `word/media/`. */
const mediaFiles = (zip: JSZip): string[] =>
  Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name]?.dir);

const all = (parent: Document | Element, ns: string, name: string): Element[] =>
  Array.from(parent.getElementsByTagNameNS(ns, name));

/** The document's sections, in order: [width, height, orientation, margins]. */
function sections(document: Document) {
  return all(document, W, 'sectPr').map((section) => {
    const size = all(section, W, 'pgSz')[0] as Element;
    const margin = all(section, W, 'pgMar')[0] as Element;
    return {
      w: size.getAttributeNS(W, 'w'),
      h: size.getAttributeNS(W, 'h'),
      margins: ['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'].map((side) =>
        margin.getAttributeNS(W, side),
      ),
    };
  });
}

type AnchorKind = 'shape' | 'picture' | 'text';

/** The anchors (DrawingML only — the VML fallback has none) in document order, with what they hold. */
function anchors(document: Document): { kind: AnchorKind; z: number; text: string }[] {
  return all(document, WP, 'anchor').map((anchor) => {
    const data = all(anchor, A, 'graphicData')[0] as Element;
    const isText = all(anchor, WPS, 'cNvSpPr')[0]?.getAttribute('txBox') === '1';
    const kind: AnchorKind = isText
      ? 'text'
      : data.getAttribute('uri')?.endsWith('/picture') === true
        ? 'picture'
        : 'shape';
    return {
      kind,
      z: Number(anchor.getAttribute('relativeHeight')),
      text: all(anchor, W, 't')
        .map((t) => t.textContent)
        .join(''),
    };
  });
}

describe('exact layout: one page', () => {
  it('is one section of the page size without margins', async () => {
    const { document, xml } = await written(await linked([FIRST]), [0]);
    expect(sections(document)).toEqual([
      { w: '8000', h: '10000', margins: ['0', '0', '0', '0', '0', '0', '0'] },
    ]);
    // The section is the body's own: no paragraph carries one, so no extra page is started.
    expect(xml).not.toContain(
      '<w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:sectPr>',
    );
    const body = all(document, W, 'body')[0] as Element;
    expect(Array.from(body.childNodes).map((node) => node.nodeName)).toEqual(['w:p', 'w:sectPr']);
  });

  it('stacks shapes under the picture under the text', async () => {
    const { document } = await written(await linked([FIRST]), [0]);
    const list = anchors(document);
    const kinds = list.map((anchor) => anchor.kind);
    expect(kinds.filter((kind) => kind === 'shape').length).toBeGreaterThanOrEqual(2);
    expect(kinds.filter((kind) => kind === 'picture')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'text')).toHaveLength(2);
    const rank: Record<AnchorKind, number> = { shape: 0, picture: 1, text: 2 };
    // Document order is paint order, and every later anchor is above every earlier one.
    expect(kinds.map((kind) => rank[kind])).toEqual(kinds.map((kind) => rank[kind]).sort((a, b) => a - b));
    expect(list.map((anchor) => anchor.z)).toEqual([...list.map((anchor) => anchor.z)].sort((a, b) => a - b));
    expect(new Set(list.map((anchor) => anchor.z)).size).toBe(list.length);
    const ids = all(document, WP, 'docPr').map((id) => id.getAttribute('id'));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stacks every anchor above Word's own base height, or LibreOffice paints a page-sized shape over the rest", async () => {
    const { document } = await written(await linked([FIRST]), [0]);
    const zs = anchors(document).map((anchor) => anchor.z);
    expect(zs.length).toBeGreaterThan(0);
    for (const z of zs) expect(z).toBeGreaterThan(251658240);
  });

  it('holds the words in text boxes, in reading order', async () => {
    const { document } = await written(await linked([FIRST]), [0]);
    const texts = anchors(document)
      .filter((anchor) => anchor.kind === 'text')
      .map((anchor) => anchor.text);
    expect(texts).toEqual(['First paragraph holds these words', 'Second paragraph links elsewhere']);
  });

  it('refers to the link by an external hyperlink relationship', async () => {
    const { zip, document } = await written(await linked([FIRST]), [0]);
    const rels = new DOMParser().parseFromString(await text(zip, 'word/_rels/document.xml.rels'), 'text/xml');
    const links = Array.from(rels.getElementsByTagName('Relationship')).filter((rel) =>
      rel.getAttribute('Type')?.endsWith('/relationships/hyperlink'),
    );
    expect(links).toHaveLength(1);
    const [link] = links as [Element];
    expect(link.getAttribute('Target')).toBe('https://example.com/docs?a=1&b=2');
    expect(link.getAttribute('TargetMode')).toBe('External');
    const hyperlinks = all(document, W, 'hyperlink');
    expect(hyperlinks.length).toBeGreaterThan(0);
    for (const hyperlink of hyperlinks) {
      expect(
        hyperlink.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'),
      ).toBe(link.getAttribute('Id'));
    }
  });

  it('packs the picture, declares its type, and every relationship points at a file', async () => {
    const { zip } = await written(await linked([FIRST]), [0]);
    const media = mediaFiles(zip);
    expect(media.length).toBeGreaterThanOrEqual(1);
    const types = await text(zip, '[Content_Types].xml');
    for (const name of media) {
      const extension = name.split('.').pop() as string;
      expect(types).toContain(`Extension="${extension}"`);
    }
    const rels = new DOMParser().parseFromString(await text(zip, 'word/_rels/document.xml.rels'), 'text/xml');
    for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
      if (rel.getAttribute('TargetMode') === 'External') continue;
      expect(zip.file(`word/${rel.getAttribute('Target')}`)).not.toBeNull();
    }
  });

  it('writes the styles with the page text font and the document language, and the title', async () => {
    const { zip } = await written(await linked([FIRST]), [0]);
    const styles = await text(zip, 'word/styles.xml');
    expect(styles).toContain('w:ascii="Arial"');
    expect(styles).toContain('<w:lang w:val="tr-TR"/>');
    expect(styles).toContain('w:after="0"');
    expect(await text(zip, 'docProps/core.xml')).toContain('Plan');
  });

  it('reads back through mammoth with exactly the words written', async () => {
    const result = await written(await linked([FIRST]), [0]);
    expect(result.words).toBe(9);
    const bytes = await result.zip.generateAsync({ type: 'uint8array' });
    const input = { buffer: bytes, arrayBuffer: bytes.buffer } as unknown as Parameters<
      typeof mammoth.extractRawText
    >[0];
    const raw = (await mammoth.extractRawText(input)).value.trim();
    expect(raw.split(/\s+/)).toHaveLength(result.words);
    expect(raw).toContain('First paragraph holds these words');
  });

  it('keeps a page without anything on it as one section', async () => {
    const result = await written(await officeDocument([{ content: '' }]), [0]);
    expect(sections(result.document)).toHaveLength(1);
    expect(result.words).toBe(0);
    expect(anchors(result.document).filter((anchor) => anchor.kind === 'text')).toEqual([]);
  });

  it('declares each namespace once, so the document is well-formed XML', async () => {
    const { xml } = await written(await linked([FIRST]), [0]);
    const root = xml.slice(xml.indexOf('<w:document'), xml.indexOf('>', xml.indexOf('<w:document')));
    const prefixes = [...root.matchAll(/xmlns:(\w+)=/g)].map((match) => match[1]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes).toEqual(
      expect.arrayContaining(['w', 'r', 'wp', 'a', 'pic', 'wps', 'mc', 'v', 'o', 'w10']),
    );
  });
});

describe('exact layout: page sizes and several pages', () => {
  it('shrinks a page above 22 inches and its text with it', async () => {
    const bytes = await officeDocument([
      { size: [1190, 1684], content: line('helvetica', 12, 100, 1500, 'Large drawing sheet') },
    ]);
    const { document, xml } = await written(bytes, [0]);
    expect(sections(document)[0]).toMatchObject({ h: '31680' });
    const scale = 1584 / 1684;
    expect(sections(document)[0]?.w).toBe(String(Math.round(1190 * scale * 20)));
    expect(xml).toContain(`<w:sz w:val="${Math.round(12 * scale * 2)}"/>`);
    expect(xml).not.toContain('<w:sz w:val="24"/>');
  });

  it('writes a section per page, each the size of its page, and only the last in the body', async () => {
    const bytes = await officeDocument([
      { size: [400, 500], content: line('helvetica', 12, 50, 400, 'One') },
      { size: [600, 300], content: line('helvetica', 12, 50, 200, 'Two') },
      { size: [300, 300], content: line('helvetica', 12, 50, 200, 'Three') },
    ]);
    const { document, words } = await written(bytes, [0, 1, 2]);
    expect(words).toBe(3);
    expect(sections(document).map((section) => [section.w, section.h])).toEqual([
      ['8000', '10000'],
      ['12000', '6000'],
      ['6000', '6000'],
    ]);
    const landscape = all(document, W, 'pgSz')[1] as Element;
    expect(landscape.getAttributeNS(W, 'orient')).toBe('landscape');
    const body = all(document, W, 'body')[0] as Element;
    expect(Array.from(body.childNodes).map((node) => node.nodeName)).toEqual([
      'w:p',
      'w:p',
      'w:p',
      'w:sectPr',
    ]);
    // Two of the sections are inside paragraphs; the third is the body's.
    expect(
      all(document, W, 'pPr').filter((properties) => all(properties, W, 'sectPr').length === 1),
    ).toHaveLength(2);
  });

  it('reports each page as read, then the write', async () => {
    const bytes = await officeDocument([{ content: line('helvetica', 12, 50, 400, 'One') }, { content: '' }]);
    const events: OperationProgress[] = [];
    await written(bytes, [0, 1], { signal: run.signal, onProgress: (event) => events.push(event) });
    expect(events.map((event) => [event.phase, event.done, event.total])).toEqual([
      ['read', 0, 2],
      ['read', 1, 2],
      ['write', undefined, undefined],
    ]);
  });

  it('stops with an AbortError, before the first page and between pages', async () => {
    const bytes = await officeDocument([{ content: '' }, { content: '' }]);
    const early = new AbortController();
    early.abort();
    await expect(written(bytes, [0, 1], { signal: early.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const later = new AbortController();
    await expect(
      written(bytes, [0, 1], { signal: later.signal, onProgress: () => later.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('exact layout: exportOffice', () => {
  const options = { pages: [0], baseName: 'plan.pdf', format: 'docx', docxLayout: 'layout' } as const;

  it('writes the file, reads it back, and reports what was kept', async () => {
    const result = await exportOffice(await linked([FIRST]), options, run);
    expect(result.file.name).toBe('plan.docx');
    expect(result.steps).toEqual(['office.read', 'office.write', 'verify']);
    const keys = result.notes.map((note) => note.key);
    expect(keys).toEqual(['op.note.exportOffice.done', 'op.note.exportOffice.layout']);
    expect(result.notes[0]).toMatchObject({ kind: 'changed', params: { format: 'DOCX', pages: 1 } });
    const layout = result.notes[1];
    expect(layout?.kind).toBe('preserved');
    expect(layout?.params).toMatchObject({ boxes: 2, pictures: 1 });
    expect(Number(layout?.params?.shapes)).toBeGreaterThanOrEqual(2);
  });

  it('names the file after the document title when it has one, else after the file', async () => {
    const bytes = await officeDocument([{ content: line('helvetica', 12, 50, 400, 'One') }], {
      title: 'Plan',
    });
    const zip = await JSZip.loadAsync((await exportOffice(bytes, options, run)).file.bytes);
    expect(await text(zip, 'docProps/core.xml')).toContain('Plan');
    const untitled = await exportOffice(
      await officeDocument([{ content: line('helvetica', 12, 50, 400, 'One') }]),
      options,
      run,
    );
    expect(await text(await JSZip.loadAsync(untitled.file.bytes), 'docProps/core.xml')).toContain('plan');
  });

  it('says how much a shrunk page was scaled, and which pages have no text', async () => {
    const bytes = await officeDocument([
      { size: [1190, 1684], content: '0.5 g 10 10 50 50 re f' },
      { content: line('helvetica', 12, 50, 400, 'One') },
    ]);
    const result = await exportOffice(bytes, { ...options, pages: [0, 1] }, run);
    const scaled = result.notes.find((note) => note.key === 'op.note.exportOffice.pageScaled');
    expect(scaled).toMatchObject({ kind: 'changed', params: { pages: '1', percent: 94 } });
    const textless = result.notes.find((note) => note.key === 'op.note.exportOffice.noText');
    expect(textless).toMatchObject({ kind: 'warning', params: { pages: '1' } });
  });

  it('rejects an empty selection and an aborted run', async () => {
    await expect(exportOffice(await linked([FIRST]), { ...options, pages: [] }, run)).rejects.toMatchObject({
      code: 'selection-empty',
    });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      exportOffice(await linked([FIRST]), options, { signal: aborted.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/** A one-page PDF from a raw content stream, with an ExtGState `GS1` that multiplies and a photographic `Im1`. */
async function blended(content: string): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = new mupdf.PDFDocument();
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 64, 64], false);
  const samples = pixmap.getPixels();
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) samples.set([x * 4, y * 4, (x * 7 + y * 3) % 256], (y * 64 + x) * 3);
  }
  const image = new mupdf.Image(pixmap);
  const photo = doc.addImage(image);
  image.destroy();
  pixmap.destroy();
  const page = doc.addPage(
    [0, 0, 400, 500],
    0,
    { ExtGState: { GS1: { Type: 'ExtGState', BM: 'Multiply' } }, XObject: { Im1: photo } },
    content,
  );
  doc.insertPage(0, page);
  const bytes = new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('exact layout: what Word cannot draw', () => {
  const options = { pages: [0], baseName: 'plan.pdf', format: 'docx', docxLayout: 'layout' } as const;
  const content = 'q /GS1 gs 1 0 0 rg 100 100 100 100 re f Q\nq 128 0 0 128 250 300 cm /Im1 Do Q';

  it('places a blend as a picture and a photograph as JPEG, and declares both formats', async () => {
    const result = await written(await blended(content), [0]);
    expect(result.counts).toMatchObject({ shapes: 0, pictures: 1, rasters: 1, boxes: 0 });
    const names = mediaFiles(result.zip);
    expect(names.map((name) => name.split('.').pop()).sort()).toEqual(['jpeg', 'png']);
    const types = await text(result.zip, '[Content_Types].xml');
    expect(types).toContain('Extension="png"');
    expect(types).toContain('Extension="jpeg"');
    // Nothing to read in the text boxes' place: the default font is the fallback.
    expect(await text(result.zip, 'word/styles.xml')).toContain('w:ascii="Arial"');
  });

  it('tells how many regions became pictures, and the characters it could not read', async () => {
    const result = await exportOffice(await blended(content), options, run);
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.layoutRasters')).toEqual({
      kind: 'changed',
      key: 'op.note.exportOffice.layoutRasters',
      params: { count: 1 },
    });
    const mapped = await officeDocument([{ content: line('courierMapped', 10, 50, 470, 'x\u0001y \u0001') }]);
    const { notes } = await exportOffice(mapped, options, run);
    expect(notes.find((note) => note.key === 'op.note.exportOffice.unreadable')).toMatchObject({
      kind: 'lost',
      params: { count: 2 },
    });
  });

  it("counts neither an invisible layer's characters as unreadable nor its page as having text", async () => {
    // Render mode 3: the same unreadable characters, drawn by nothing, on a page that is not a scan.
    const hidden = line('courierMapped', 10, 50, 470, 'x\u0001y \u0001').replace('BT', 'BT 3 Tr');
    const result = await exportOffice(await officeDocument([{ content: hidden }]), options, run);
    expect(result.notes.some((note) => note.key === 'op.note.exportOffice.unreadable')).toBe(false);
    expect(result.notes.find((note) => note.key === 'op.note.exportOffice.noText')).toMatchObject({
      params: { pages: '1' },
    });
  });
});
