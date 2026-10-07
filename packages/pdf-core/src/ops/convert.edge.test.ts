/**
 * Conversion at its edges: the margin it will accept, the files it refuses before reading them,
 * the HTML MuPDF reads itself (remote references it will not fetch, a title it does not report,
 * links that become link annotations and links that are left out), and a layout that runs past
 * the page limit. The output is read back from the bytes with MuPDF.
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import { type ConvertRequest, convertToPdf, MAX_CONVERT_INPUT, MAX_CONVERT_PAGES } from './convert';

const run = { signal: new AbortController().signal };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const base = { pageSize: 'a4', orientation: 'portrait', marginMm: 15 } as const;
const request = (patch: Partial<ConvertRequest>): ConvertRequest => ({
  ...base,
  name: 'a.txt',
  bytes: encode('x'),
  ...patch,
});
const keys = (outcome: { readonly report: { readonly notes: readonly { readonly key: string }[] } }) =>
  outcome.report.notes.map((entry) => entry.key);
const page = (body: string, head = '') =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

/** A two-chapter EPUB 2 with a title and a table of contents whose second entry has a child. */
async function epub(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  zip.file(
    'OEBPS/content.opf',
    '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Kitap Adı</dc:title><dc:identifier id="id">x</dc:identifier><dc:language>tr</dc:language></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
  );
  zip.file(
    'OEBPS/toc.ncx',
    '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>Kitap Adı</text></docTitle><navMap><navPoint id="n1" playOrder="1"><navLabel><text>Birinci</text></navLabel><content src="c1.xhtml"/></navPoint><navPoint id="n2" playOrder="2"><navLabel><text>İkinci</text></navLabel><content src="c2.xhtml"/><navPoint id="n3" playOrder="3"><navLabel><text>Alt</text></navLabel><content src="c2.xhtml#alt"/></navPoint></navPoint></navMap></ncx>',
  );
  const chapter = (title: string, id = '') =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1><p${id}>Metin ${title}.</p></body></html>`;
  zip.file('OEBPS/c1.xhtml', chapter('Birinci'));
  zip.file('OEBPS/c2.xhtml', chapter('İkinci', ' id="alt"'));
  return zip.generateAsync({ type: 'uint8array' });
}

/** The links of every page of a produced file: URI or the page index of the destination. */
async function linksOf(bytes: Uint8Array) {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    return Array.from({ length: doc.countPages() }, (_value, index) =>
      doc
        .loadPage(index)
        .getLinks()
        .map((link) => (link.isExternal() ? link.getURI() : doc.resolveLink(link))),
    );
  } finally {
    doc.destroy();
  }
}

/** Where the first character of the first page starts, from the left edge. */
async function firstCharacterX(bytes: Uint8Array): Promise<number> {
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  try {
    let x = Number.NaN;
    doc
      .loadPage(0)
      .toStructuredText('preserve-whitespace')
      .walk({
        onChar: (_character, origin) => {
          if (Number.isNaN(x)) x = origin[0];
        },
      });
    return x;
  } finally {
    doc.destroy();
  }
}

describe('what is refused before anything is read', () => {
  it('refuses an input past the size limit by name', async () => {
    await expect(
      convertToPdf(request({ bytes: new Uint8Array(MAX_CONVERT_INPUT + 1) }), run),
    ).rejects.toMatchObject({ code: 'file-too-large', details: { engine: 'model', path: 'a.txt' } });
  });

  it('refuses an aborted signal', async () => {
    await expect(convertToPdf(request({}), { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('the margin', () => {
  it('is the chosen number of millimetres, clamped to 0–50, and 15 when it is not a number', async () => {
    const xAt = async (marginMm: number) =>
      firstCharacterX((await convertToPdf(request({ marginMm, bytes: encode('Margin') }), run)).bytes);
    const [zero, below, fifteen, nan, fifty, above] = await Promise.all(
      [0, -5, 15, Number.NaN, 50, 80].map(xAt),
    );
    expect(below).toBeCloseTo(zero ?? Number.NaN, 3);
    expect(nan).toBeCloseTo(fifteen ?? Number.NaN, 3);
    expect(above).toBeCloseTo(fifty ?? Number.NaN, 3);
    expect(zero).toBeLessThan(fifteen ?? 0);
    expect(fifteen).toBeLessThan(fifty ?? 0);
    // 15 mm is 42.5 points; the glyph sits at or just right of it.
    expect(fifteen ?? 0).toBeGreaterThanOrEqual(42.5);
    expect(fifteen ?? 0).toBeLessThan(46);
  });
});

describe('titles', () => {
  it('names the document after the file when the source states none, whatever folder it came from', async () => {
    for (const [name, title] of [
      ['C:\\Users\\x\\notes.v2.txt', 'notes.v2'],
      ['dir/more/ liste .txt', 'liste'],
      ['.txt', '.txt'],
    ] as const) {
      expect((await convertToPdf(request({ name }), run)).title).toBe(title);
    }
  });

  it("takes an HTML page's own <title>, with entities decoded and white space collapsed", async () => {
    const out = await convertToPdf(
      request({
        name: 'a.html',
        bytes: encode(
          page(
            'Body',
            '<title>  Ünlü &amp; &#x130;stanbul\n  &#304; &lt;x&gt; &quot;q&quot; &apos;s&apos; </title>',
          ),
        ),
      }),
      run,
    );
    expect(out.title).toBe('Ünlü & İstanbul İ <x> "q" \'s\'');
  });

  it('falls back to the file name for an HTML page with no title or an empty one', async () => {
    for (const head of ['', '<title></title>', '<title>   </title>']) {
      const out = await convertToPdf(request({ name: 'sayfa.htm', bytes: encode(page('Body', head)) }), run);
      expect(out.title).toBe('sayfa');
    }
  });

  it('takes the title the format itself carries when the page states none, and keeps its table of contents as the outline', async () => {
    const out = await convertToPdf(request({ name: 'kitap.epub', bytes: await epub() }), run);
    expect(out.format).toBe('epub');
    expect(out.title).toBe('Kitap Adı');
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      const outline = doc.loadOutline() ?? [];
      expect(outline.map((item) => item.title)).toEqual(['Birinci', 'İkinci']);
      expect(outline[1]?.down?.map((child) => child.title)).toEqual(['Alt']);
    } finally {
      doc.destroy();
    }
  });
});

describe('HTML', () => {
  it.each([
    ['an image', '<img src="https://example.com/a.png">'],
    ['a protocol-relative link', '<a href="//cdn.example.com/x">x</a>'],
    ['a stylesheet', '<style>p { background: url( "http://example.com/b.png") }</style>'],
  ])('says it did not fetch %s', async (_name, body) => {
    const out = await convertToPdf(request({ name: 'r.html', bytes: encode(page(`${body}Text`)) }), run);
    expect(keys(out)).toContain('op.note.convert.remoteSkipped');
  });

  it('says nothing about remote references when there are none', async () => {
    const out = await convertToPdf(
      request({ name: 'r.html', bytes: encode(page('<a href="#x">x</a>')) }),
      run,
    );
    expect(keys(out)).not.toContain('op.note.convert.remoteSkipped');
  });

  it('turns web and mail links into link annotations and leaves every other scheme out, counting them', async () => {
    const out = await convertToPdf(
      request({
        name: 'l.html',
        bytes: encode(
          page(
            [
              '<p><a href="https://example.com/a">web</a></p>',
              '<p><a href="MAILTO:a@b.c">mail</a></p>',
              '<p><a href="javascript:alert(1)">script</a></p>',
              '<p><a href="ftp://example.com/f">ftp</a></p>',
            ].join(''),
          ),
        ),
      }),
      run,
    );
    expect([...((await linksOf(out.bytes))[0] ?? [])].sort()).toEqual([
      'MAILTO:a@b.c',
      'https://example.com/a',
    ]);
    expect(out.report.notes.find((entry) => entry.key === 'op.note.convert.linksSkipped')?.params).toEqual({
      count: 2,
    });
    expect(out.report.steps).toContain('convert.links');
  });

  it('turns a link inside the document into a link to the page that holds its target, and drops one to nothing', async () => {
    const out = await convertToPdf(
      request({
        name: 'i.html',
        bytes: encode(
          page(
            '<p><a href="#later">go</a> <a href="#nowhere">lost</a></p><div style="page-break-after:always"></div><p id="later">Target</p>',
          ),
        ),
      }),
      run,
    );
    const links = await linksOf(out.bytes);
    expect(links[0]).toEqual([1]);
  });

  it('builds an outline from the headings of a page, nested, with positions', async () => {
    const out = await convertToPdf(
      request({
        name: 'h.html',
        bytes: encode(
          page(
            '<h1 id="a">Bir</h1><h2 id="b">Alt</h2><div style="page-break-after:always"></div><h1>İki</h1>',
          ),
        ),
      }),
      run,
    );
    const mupdf = await loadMupdf();
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf');
    try {
      expect(doc.loadOutline()?.map((item) => [item.title, item.down?.map((child) => child.title)])).toEqual(
        expect.arrayContaining([['Bir', ['Alt']]]),
      );
    } finally {
      doc.destroy();
    }
    expect(out.report.steps).toContain('convert.outline');
  });

  it('stops a layout that runs past the page limit, naming the file', async () => {
    const pages = '<div style="page-break-after:always">p</div>'.repeat(MAX_CONVERT_PAGES + 1);
    await expect(
      convertToPdf(request({ name: 'big.html', bytes: encode(page(pages)) }), run),
    ).rejects.toMatchObject({ code: 'page-limit', details: { engine: 'mupdf', path: 'big.html' } });
  }, 120_000);
});

describe('what MuPDF refuses to open', () => {
  it('reports an EPUB that is not a ZIP as an error that says what failed', async () => {
    await expect(
      convertToPdf(request({ name: 'b.epub', bytes: encode('not a zip') }), run),
    ).rejects.toMatchObject({
      details: { engine: 'mupdf' },
    });
  });
});
