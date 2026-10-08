/**
 * The "one picture per page" Word layout, on pages built in the test and read back the way
 * Word would: the section sizes in twips, the margins, the anchored picture's extent, and the
 * embedded image decoded with MuPDF and sampled at the page's centre — which proves the
 * picture is the page's own drawing, not just a picture of the right size. The wrong
 * answers that matter: a page whose size Word would refuse (more than 22 inches), a picture
 * that shifts the text onto an extra page, a picture drawn without the page's annotations or
 * at the wrong resolution, and the flowing layout changing under its own name.
 */

import JSZip from 'jszip';
import type { PDFDocument } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { exportOffice } from './export-office';
import { line, officeDocument, picture } from './export-office-fixtures';

const run = { signal: new AbortController().signal };
const options = { pages: [0, 1], baseName: 'plan.pdf', format: 'docx', docxLayout: 'page-images' } as const;

/** Content that paints the whole page (0.8, 0.2, 0.1 of 255: 204, 51, 26). */
const fill = (width: number, height: number): string => `0.8 0.2 0.1 rg 0 0 ${width} ${height} re f\n`;

/** An A4 portrait page, red, with a line of text at its top; then an A4 landscape page holding a blue photograph. */ async function twoPages(): Promise<Uint8Array> {
  return officeDocument([
    { size: [595, 842], content: fill(595, 842) + line('helvetica', 24, 50, 780, 'Merhaba') },
    {
      size: [842, 595],
      images: { Photo: { width: 4, height: 4, rgb: [0, 0, 255] } },
      content: picture('Photo', 0, 0, 842, 595),
    },
  ]);
}

async function text(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (file === null) throw new Error(`missing ${name}`);
  return file.async('string');
}

/** The embedded image's pixel size and the colour of its centre pixel, decoded with MuPDF. */
async function decoded(
  zip: JSZip,
  name: string,
): Promise<{ width: number; height: number; centre: number[] }> {
  const file = zip.file(name);
  if (file === null) throw new Error(`missing ${name}`);
  const mupdf = await loadMupdf();
  const image = new mupdf.Image(await file.async('uint8array'));
  const pixmap = image.toPixmap();
  try {
    const width = pixmap.getWidth();
    const height = pixmap.getHeight();
    const channels = pixmap.getNumberOfComponents();
    const at = (Math.floor(height / 2) * width + Math.floor(width / 2)) * channels;
    return { width, height, centre: Array.from(pixmap.getPixels().slice(at, at + 3)) };
  } finally {
    pixmap.destroy();
    image.destroy();
  }
}

/** Whether every channel of `actual` is within `tolerance` of `expected`. */
function near(actual: readonly number[], expected: readonly number[], tolerance: number): boolean {
  return expected.every((value, index) => Math.abs((actual[index] ?? -999) - value) <= tolerance);
}

/** The PDF after `edit` changed its document. */
async function edited(bytes: Uint8Array, edit: (doc: PDFDocument) => void): Promise<Uint8Array> {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    edit(doc);
    return new Uint8Array(doc.saveToBuffer('compress').asUint8Array());
  } finally {
    doc.destroy();
  }
}

const sizes = (document: string): string[] => document.match(/<w:pgSz [^>]*\/>/g) ?? [];

describe('exportOffice, Word as one picture per page', () => {
  it('writes one zero-margin section per page, the page’s size, with one anchored picture of its extent', async () => {
    const { file, notes, steps } = await exportOffice(await twoPages(), options, run);
    expect(file.name).toBe('plan.docx');
    expect(steps).toContain('verify');
    const zip = await JSZip.loadAsync(file.bytes);
    const document = await text(zip, 'word/document.xml');

    // A4 portrait, then A4 landscape: the sizes in twips, the orientation on the wide one.
    expect(sizes(document)).toEqual([
      '<w:pgSz w:w="11900" w:h="16840"/>',
      '<w:pgSz w:w="16840" w:h="11900" w:orient="landscape"/>',
    ]);
    const margins = document.match(/<w:pgMar [^>]*\/>/g) ?? [];
    expect(margins).toEqual(
      Array(2).fill(
        '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/>',
      ),
    );
    expect(document.match(/<w:type w:val="nextPage"\/>/g)).toHaveLength(2);

    // One picture per page, the page's size in EMU, at the page's corner, behind the text.
    const extents = [...document.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(extents).toEqual([
      [595 * 12700, 842 * 12700],
      [842 * 12700, 595 * 12700],
    ]);
    expect(document.match(/<wp:anchor /g)).toHaveLength(2);
    expect(document.match(/behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"/g)).toHaveLength(2);
    expect(document.match(/<wp:wrapNone\/>/g)).toHaveLength(2);
    expect(document.match(/<wp:positionH relativeFrom="page"><wp:posOffset>0<\/wp:posOffset>/g)).toHaveLength(
      2,
    );
    expect(document.match(/<wp:positionV relativeFrom="page"><wp:posOffset>0<\/wp:posOffset>/g)).toHaveLength(
      2,
    );
    expect(document).not.toContain('<wp:inline');
    const ids = [...document.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);

    // The package: the vector page is a PNG, the page with a photograph a JPEG, both related and typed.
    const names = Object.keys(zip.files).filter(
      (name) => name.startsWith('word/media/') && !zip.files[name]?.dir,
    );
    expect(names.sort()).toEqual(['word/media/page1.png', 'word/media/page2.jpeg']);
    const png = await zip.file('word/media/page1.png')?.async('uint8array');
    const jpeg = await zip.file('word/media/page2.jpeg')?.async('uint8array');
    expect(Array.from(png?.slice(0, 4) ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(Array.from(jpeg?.slice(0, 3) ?? [])).toEqual([0xff, 0xd8, 0xff]);
    const rels = await text(zip, 'word/_rels/document.xml.rels');
    expect(rels).toContain(
      'Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page1.png"',
    );
    expect(rels).toContain(
      'Id="rIdImage2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page2.jpeg"',
    );
    expect(document).toContain('<a:blip r:embed="rIdImage1"/>');
    expect(document).toContain('<a:blip r:embed="rIdImage2"/>');
    const types = await text(zip, '[Content_Types].xml');
    expect(types).toContain('<Default Extension="png" ContentType="image/png"/>');
    expect(types).toContain('<Default Extension="jpeg" ContentType="image/jpeg"/>');

    // The report says what this layout is, and none of the flowing layout's notes.
    expect(notes.map((entry) => entry.key)).toEqual([
      'op.note.exportOffice.done',
      'op.note.exportOffice.pageImages',
    ]);
    expect(notes[0]?.params).toEqual({ format: 'DOCX', pages: 2 });
    expect(notes[1]?.params).toEqual({ dpi: 200 });
  });

  it('carries each page’s section in its own paragraph but the last, whose section is the body’s', async () => {
    const { file } = await exportOffice(await twoPages(), options, run);
    const document = await text(await JSZip.loadAsync(file.bytes), 'word/document.xml');
    const paragraphs = document.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [];
    expect(paragraphs).toHaveLength(2);
    // The paragraph is a point high and its text a point big, so it can never push a page on.
    for (const paragraph of paragraphs) {
      expect(paragraph).toContain('<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/>');
      expect(paragraph).toContain('<w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr>');
    }
    expect(paragraphs[0]).toContain('<w:sectPr>');
    expect(paragraphs[1]).not.toContain('<w:sectPr>');
    expect(
      document.endsWith(
        '</w:p><w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="16840" w:h="11900" w:orient="landscape"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>',
      ),
    ).toBe(true);
  });

  it('writes the anchor’s children in the order the schema fixes', async () => {
    const { file } = await exportOffice(await twoPages(), options, run);
    const document = await text(await JSZip.loadAsync(file.bytes), 'word/document.xml');
    const anchor = /<wp:anchor [\s\S]*?<\/wp:anchor>/.exec(document)?.[0] ?? '';
    const order = [
      '<wp:simplePos ',
      '<wp:positionH ',
      '<wp:positionV ',
      '<wp:extent ',
      '<wp:effectExtent ',
      '<wp:wrapNone/>',
      '<wp:docPr ',
      '<wp:cNvGraphicFramePr>',
      '<a:graphic>',
    ].map((tag) => anchor.indexOf(tag));
    expect(order.every((position) => position > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('puts the page’s own drawing in the picture: its centre has the page’s colour, at 200 dpi', async () => {
    const { file } = await exportOffice(await twoPages(), options, run);
    const zip = await JSZip.loadAsync(file.bytes);
    const first = await decoded(zip, 'word/media/page1.png');
    expect([first.width, first.height]).toEqual([Math.round((595 * 200) / 72), Math.round((842 * 200) / 72)]);
    // The red the page was filled with (0.8, 0.2, 0.1 of 255), not the white of an empty picture.
    expect(near(first.centre, [204, 51, 26], 2)).toBe(true);
    const second = await decoded(zip, 'word/media/page2.jpeg');
    expect([second.width, second.height]).toEqual([
      Math.round((842 * 200) / 72),
      Math.round((595 * 200) / 72),
    ]);
    // The photograph (blue), through JPEG's rounding.
    expect(near(second.centre, [0, 0, 255], 8)).toBe(true);
  });

  it('draws the page as a viewer shows it, annotations included, on white paper', async () => {
    const blank = await officeDocument([{ content: line('helvetica', 12, 20, 470, 'top') }]);
    const marked = await edited(blank, (doc) => {
      const page = doc.loadPage(0);
      try {
        // The square is symmetric about the page's centre, whichever way its y axis runs.
        const square = page.createAnnotation('Square');
        square.setRect([100, 150, 300, 350]);
        square.setColor([0, 1, 0]);
        square.setInteriorColor([0, 1, 0]);
        square.update();
      } finally {
        page.destroy();
      }
    });
    const { file } = await exportOffice(marked, { ...options, pages: [0] }, run);
    const zip = await JSZip.loadAsync(file.bytes);
    const rendered = await decoded(zip, 'word/media/page1.png');
    expect(near(rendered.centre, [0, 255, 0], 2)).toBe(true);
    // Paper without a drawing is white, not transparent black.
    const empty = await exportOffice(
      await officeDocument([{ content: '' }]),
      { ...options, pages: [0] },
      run,
    );
    const white = await decoded(await JSZip.loadAsync(empty.file.bytes), 'word/media/page1.png');
    expect(white.centre).toEqual([255, 255, 255]);
  });

  it('shrinks a page above Word’s 22 inches, both sides by one factor, and renders from the original size', async () => {
    // 1190 x 1684 pt (the owner's poster-size sheet) is 23.4 inches high.
    const pdf = await officeDocument([
      { size: [595, 842], content: '' },
      { size: [1190, 1684], content: fill(1190, 1684) },
    ]);
    const { file, notes } = await exportOffice(pdf, options, run);
    const zip = await JSZip.loadAsync(file.bytes);
    const document = await text(zip, 'word/document.xml');
    const factor = 1584 / 1684;
    expect(sizes(document)).toEqual([
      '<w:pgSz w:w="11900" w:h="16840"/>',
      `<w:pgSz w:w="${Math.round(1190 * factor * 20)}" w:h="31680"/>`,
    ]);
    const extents = [...document.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(extents[1]).toEqual([Math.round(1190 * factor * 12700), 1584 * 12700]);
    const scaled = notes.find((entry) => entry.key === 'op.note.exportOffice.pageScaled');
    expect(scaled?.kind).toBe('changed');
    expect(scaled?.params).toEqual({ pages: '2', percent: 94 });
    // The picture is 200 dpi of the original 1190 x 1684, not of the shrunk page.
    const shrunk = await decoded(zip, 'word/media/page2.png');
    expect([shrunk.width, shrunk.height]).toEqual([
      Math.round((1190 * 200) / 72),
      Math.round((1684 * 200) / 72),
    ]);
    expect(near(shrunk.centre, [204, 51, 26], 2)).toBe(true);
  });

  it('names the most shrunk page’s ratio and every shrunk page', async () => {
    const pdf = await officeDocument([
      { size: [1700, 800], content: '' },
      { size: [600, 800], content: '' },
      { size: [800, 3168], content: '' },
    ]);
    const { notes } = await exportOffice(pdf, { ...options, pages: [0, 1, 2] }, run);
    // 1584/1700 = 93.2 %, and 1584/3168 = 50 %: the smaller is the one named.
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.pageScaled')?.params).toEqual({
      pages: '1, 3',
      percent: 50,
    });
  });

  it('keeps a page within 40 megapixels', async () => {
    // 2400 pt square: 6667 px a side at 200 dpi, 44 megapixels.
    const { file, notes } = await exportOffice(
      await officeDocument([{ size: [2400, 2400], content: '' }]),
      { ...options, pages: [0] },
      run,
    );
    const zip = await JSZip.loadAsync(file.bytes);
    const rendered = await decoded(zip, 'word/media/page1.png');
    // floor(2400 * sqrt(40e6 / 2400^2)) = 6324 px over 2400 pt: 189.7, reported as 190 dpi.
    expect(notes.find((entry) => entry.key === 'op.note.exportOffice.pageImages')?.params).toEqual({
      dpi: 190,
    });
    expect(rendered.width).toBe(rendered.height);
    expect(rendered.width * rendered.height).toBeLessThanOrEqual(40_000_000);
    expect(rendered.width * rendered.height).toBeGreaterThan(39_900_000);
    // The page itself is still shrunk to Word's limit.
    expect(sizes(await text(zip, 'word/document.xml'))).toEqual(['<w:pgSz w:w="31680" w:h="31680"/>']);
  }, 120_000);

  it('takes the page’s size after the crop box and /Rotate, as a viewer shows it', async () => {
    const pdf = await edited(await officeDocument([{ content: fill(400, 500) }]), (doc) => {
      const page = doc.loadPage(0);
      try {
        page.setPageBox('CropBox', [50, 50, 350, 450]);
      } finally {
        page.destroy();
      }
      doc.findPage(0).put('Rotate', 90);
    });
    const { file } = await exportOffice(pdf, { ...options, pages: [0] }, run);
    const zip = await JSZip.loadAsync(file.bytes);
    // 300 x 400 after the crop, 400 x 300 turned on its side.
    expect(sizes(await text(zip, 'word/document.xml'))).toEqual([
      '<w:pgSz w:w="8000" w:h="6000" w:orient="landscape"/>',
    ]);
    const rendered = await decoded(zip, 'word/media/page1.png');
    expect([rendered.width, rendered.height]).toEqual([
      Math.round((400 * 200) / 72),
      Math.round((300 * 200) / 72),
    ]);
  });

  it('exports only the chosen pages, numbering them from the first picture', async () => {
    const { file } = await exportOffice(await twoPages(), { ...options, pages: [1] }, run);
    const zip = await JSZip.loadAsync(file.bytes);
    expect(sizes(await text(zip, 'word/document.xml'))).toEqual([
      '<w:pgSz w:w="16840" w:h="11900" w:orient="landscape"/>',
    ]);
    expect(
      Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name]?.dir),
    ).toEqual(['word/media/page1.jpeg']);
    expect(await text(zip, '[Content_Types].xml')).not.toContain('Extension="png"');
  });

  it('draws a JPEG only when pictures cover half of the page: a small logo or an off-page picture leaves the text lossless', async () => {
    const bytes = await officeDocument([
      {
        // A 60 × 60 logo (under 2 % of the page) beside a line of text.
        images: { Logo: { width: 4, height: 4, rgb: [0, 0, 255] } },
        content: picture('Logo', 20, 420, 60, 60) + line('helvetica', 24, 50, 300, 'Merhaba'),
      },
      {
        // A full-page picture lying entirely beyond the page's edge covers none of it.
        images: { Far: { width: 4, height: 4, rgb: [0, 0, 255] } },
        content: picture('Far', 1000, 1000, 400, 500) + line('helvetica', 24, 50, 300, 'Merhaba'),
      },
      {
        // Four fifths of the page.
        images: { Photo: { width: 4, height: 4, rgb: [0, 0, 255] } },
        content: picture('Photo', 0, 0, 400, 400),
      },
    ]);
    const { file } = await exportOffice(bytes, { ...options, pages: [0, 1, 2] }, run);
    const zip = await JSZip.loadAsync(file.bytes);
    const names = Object.keys(zip.files).filter(
      (name) => name.startsWith('word/media/') && !zip.files[name]?.dir,
    );
    expect(names.sort()).toEqual(['word/media/page1.png', 'word/media/page2.png', 'word/media/page3.jpeg']);
  });

  it('titles the document with the PDF’s title, or the file name', async () => {
    const titled = await officeDocument([{ content: '' }], { title: 'Kat Planı' });
    const named = await exportOffice(titled, { ...options, pages: [0] }, run);
    expect(await text(await JSZip.loadAsync(named.file.bytes), 'docProps/core.xml')).toContain(
      '<dc:title>Kat Planı</dc:title>',
    );
    const bare = await exportOffice(await officeDocument([{ content: '' }]), { ...options, pages: [0] }, run);
    expect(await text(await JSZip.loadAsync(bare.file.bytes), 'docProps/core.xml')).toContain(
      '<dc:title>plan</dc:title>',
    );
  });

  it('stops when cancelled: before reading, between pages and while writing', async () => {
    const bytes = await twoPages();
    const before = new AbortController();
    before.abort();
    await expect(exportOffice(bytes, options, { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    // After the first page was drawn, the loop's check ahead of the second.
    const between = new AbortController();
    await expect(
      exportOffice(bytes, options, {
        signal: between.signal,
        onProgress: (progress) => {
          if (progress.phase === 'read' && progress.done === 0) between.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // When the file is being written.
    const writing = new AbortController();
    await expect(
      exportOffice(bytes, options, {
        signal: writing.signal,
        onProgress: (progress) => {
          if (progress.phase === 'write') writing.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('leaves the flowing layout as it was: named or not, the same document, no pictures of pages', async () => {
    const pdf = await officeDocument([{ content: line('courier', 10, 50, 470, 'two words') }]);
    const plain = await exportOffice(pdf, { pages: [0], baseName: 'a.pdf', format: 'docx' }, run);
    const flow = await exportOffice(
      pdf,
      { pages: [0], baseName: 'a.pdf', format: 'docx', docxLayout: 'flow' },
      run,
    );
    const first = await text(await JSZip.loadAsync(plain.file.bytes), 'word/document.xml');
    expect(await text(await JSZip.loadAsync(flow.file.bytes), 'word/document.xml')).toBe(first);
    expect(first).toContain('two words');
    expect(first).not.toContain('<wp:anchor');
    expect(flow.notes.map((entry) => entry.key)).toContain('op.note.exportOffice.docxApproximate');
    // The layout is Word's: a spreadsheet asked for page pictures is still a spreadsheet.
    const sheet = await exportOffice(
      pdf,
      { pages: [0], baseName: 'a.pdf', format: 'xlsx', docxLayout: 'page-images' },
      run,
    );
    expect(sheet.file.name).toBe('a.xlsx');
  });
});
