/**
 * The pass before Ghostscript: the CMap that keeps a simple font's text mapping through the
 * rewrite, and what is removed or switched on in the document (script, annotations without the
 * Print flag, a missing `/ToUnicode`), read back from the produced bytes.
 */

import { describe, expect, it } from 'vitest';
import { loadMupdf, openPdf } from '../engines/mupdf';
import { blankForm, formPdf, handPdf, widgetBody } from './forms.fixtures';
import { prepareForPdfA, toUnicodeCMap } from './pdfa-prepare';

const run = { signal: new AbortController().signal };

async function fixture(options: { readonly save?: string } = {}): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const page = doc.addPage([0, 0, 200, 200], 0, { Font: { F: font } }, 'BT /F 12 Tf 20 100 Td (ABC) Tj ET');
  doc.insertPage(0, page);
  const link = doc.addObject({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [10, 10, 90, 30],
    F: 0,
    A: { S: 'JavaScript', JS: doc.newString('app.alert(1)') },
  });
  const sound = doc.addObject({ Type: 'Annot', Subtype: 'Sound', Rect: [100, 10, 120, 30], F: 4 });
  doc.findPage(0).put('Annots', [link, sound]);
  doc
    .getTrailer()
    .get('Root')
    .put('OpenAction', doc.addObject({ S: 'JavaScript', JS: doc.newString('app.alert(2)') }));
  const bytes = new Uint8Array(doc.saveToBuffer(options.save ?? '').asUint8Array());
  doc.destroy();
  return bytes;
}

describe('toUnicodeCMap', () => {
  it('maps one-byte codes to UTF-16BE, writes astral points as surrogates and ignores wider codes', () => {
    const cmap = toUnicodeCMap(
      new Map([
        [0x42, 0x20ac],
        [0x41, 0x41],
        [0x43, 0x1f600],
        [0x100, 0x5a],
      ]),
    );
    expect(cmap).toContain('1 begincodespacerange\n<00> <FF>\nendcodespacerange');
    expect(cmap).toContain('3 beginbfchar\n<41> <0041>\n<42> <20ac>\n<43> <d83dde00>\nendbfchar');
    expect(cmap).not.toContain('<100>');
  });

  it('splits more than 100 mappings into blocks of at most 100', () => {
    const cmap = toUnicodeCMap(
      new Map(Array.from({ length: 250 }, (_, code) => [code, 0x100 + code] as const)),
    );
    expect([...cmap.matchAll(/^(\d+) beginbfchar$/gm)].map((match) => Number(match[1]))).toEqual([
      100, 100, 50,
    ]);
  });
});

describe('prepareForPdfA', () => {
  it('removes script, drops a forbidden annotation, sets Print and adds a ToUnicode, as the bytes read back', async () => {
    const prepared = await prepareForPdfA(await fixture(), 2, run);
    expect(prepared.counters).toMatchObject({
      actionsRemoved: 2,
      printFlagged: 1,
      toUnicodeAdded: 1,
      widgetsRemoved: 0,
      encryptionRemoved: false,
    });
    expect([...prepared.counters.annotationsRemoved]).toEqual([['Sound', 1]]);

    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, prepared.bytes);
    try {
      expect(doc.getTrailer().get('Root').get('OpenAction').isNull()).toBe(true);
      const annotations = doc.findPage(0).get('Annots');
      expect(annotations.length).toBe(1);
      const link = annotations.get(0).resolve();
      expect(link.get('Subtype').asName()).toBe('Link');
      expect(link.get('A').isNull()).toBe(true);
      expect(link.get('F').asNumber() & 4).toBe(4);
      const font = doc.findPage(0).get('Resources').get('Font').get('F').resolve();
      const map = new TextDecoder().decode(font.get('ToUnicode').readStream().asUint8Array());
      expect(map).toContain('<41> <0041>');
      expect(map).toContain('<43> <0043>');
    } finally {
      doc.destroy();
    }
  });

  it('refuses a file that needs a password and says an owner-password file was written unprotected', async () => {
    await expect(
      prepareForPdfA(await fixture({ save: 'encrypt=aes-128,owner-password=o,user-password=u' }), 2, run),
    ).rejects.toMatchObject({ code: 'encrypted-unsupported' });

    const owner = await prepareForPdfA(
      await fixture({ save: 'encrypt=aes-128,owner-password=o,user-password=' }),
      2,
      run,
    );
    expect(owner.counters.encryptionRemoved).toBe(true);
    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, owner.bytes);
    try {
      expect(doc.getTrailer().get('Encrypt').isNull()).toBe(true);
    } finally {
      doc.destroy();
    }
  });
});

/** The objects of a hand-written file whose catalog, pages and annotations carry what PDF/A forbids. */
function messy(): Uint8Array {
  const stream = (body: string, dict = '') => `<</Length ${body.length}${dict}>>\nstream\n${body}\nendstream`;
  return handPdf({
    1: '<</Type/Catalog/Pages 2 0 R/Lang(tr-TR)/OpenAction 20 0 R/AA<</WC 21 0 R>>/Names<</JavaScript<</Names[(a) 21 0 R (b) 21 0 R]>>/EmbeddedFiles<</Names[(f.txt) 22 0 R (g.txt) 23 0 R (h.txt) 5 0 R]>>>>/AcroForm 30 0 R/Outlines 40 0 R>>',
    2: '<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>',
    3: `<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/AA<</O 21 0 R>>/Resources<</Font<</F 10 0 R/G <</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>>>>>/Contents 11 0 R/Annots[5 50 0 R 51 0 R 52 0 R 53 0 R 54 0 R 55 0 R 56 0 R 57 0 R 58 0 R 59 0 R 60 0 R 61 0 R 62 0 R]>>`,
    4: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<</Font<</F 10 0 R>>>>/Contents 11 0 R>>',
    10: '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    11: stream('BT /F 12 Tf 20 100 Td (ABC) Tj /G 12 Tf (D) Tj ET'),
    // OpenAction: a chain whose second link, in an array, launches; a deep chain ends the search.
    20: '<</S/GoTo/Next[<</S/URI>> 99 0 R <</S/Launch>>]>>',
    21: '<</S/JavaScript/JS(1)>>',
    22: '<</Type/Filespec/F(f.txt)/UF(ü.txt)/EF<</UF 70 0 R>>>>',
    23: '<</Type/Filespec/F(g.txt)/AFRelationship/Data/EF<</F 71 0 R>>>>',
    70: stream('x'),
    71: stream('y', '/Subtype/text#2Fplain'),
    // Fields: a signed one whose kid inherits the type, a duplicate, a dangling kid and an unsigned one.
    30: '<</Fields[31 0 R 31 0 R 32 0 R 99 0 R]>>',
    31: '<</FT/Sig/T(s)/V 33 0 R/Kids[34 0 R 31 0 R]>>',
    32: '<</FT/Sig/T(u)>>',
    33: '<</Type/Sig/Filter/Adobe.PPKLite>>',
    34: '<</V 33 0 R>>',
    // Outlines: a launching item loses its action and its kids are visited; a cycle is not followed.
    40: '<</Type/Outlines/First 41 0 R>>',
    41: '<</Title(a)/A<</S/Named/N/Bogus>>/First 42 0 R/Next 43 0 R/Parent 40 0 R>>',
    42: '<</Title(b)/A<</S/Named/N/NextPage>>/Next 41 0 R>>',
    43: '<</Title(c)/A<</S/Launch>>/Next 99 0 R>>',
    50: '<</Type/Annot/Subtype/Sound/Rect[1 1 9 9]/F 4>>',
    51: '<</Type/Annot/Subtype/Widget/Rect[1 1 9 9]/F 4>>',
    52: '<</Type/Annot/Subtype/FileAttachment/Rect[1 1 9 9]/F 4/FS 23 0 R/Name/Paperclip>>',
    53: '<</Type/Annot/Subtype/FileAttachment/Rect[1 1 9 9]/F 4/FS 22 0 R/Name/Paperclip>>',
    54: '<</Type/Annot/Subtype/FileAttachment/Rect[1 1 9 9]/F 4/FS 5/Name/Paperclip>>',
    55: '<</Type/Annot/Subtype/Popup/Rect[1 1 9 9]/F 0>>',
    56: '<</Type/Annot/Subtype/Link/Rect[10 10 90 30]/F 0/A<</S/Launch>>/AA<</E 21 0 R>>>>',
    57: '<</Type/Annot/Subtype/Link/Rect[10 10 90 30]/F 2>>',
    58: '<</Type/Annot/Subtype/Square/Rect[20 20 80 80]/C[1 0 0]/F 4>>',
    59: '<</Type/Annot/Subtype/Square/Rect[20 20 20 20]/C[1 0 0]/F 4>>',
    60: '<</Type/Annot/Subtype/Square/Rect[20 20 80 80]/C[1 0 0]/F 2>>',
    61: '<</Type/Annot/Subtype/Foo/Rect[20 20 80 80]/F 4>>',
    62: `<</Type/Annot/Subtype/Stamp/Rect[20 20 80 80]/F 4/AP<</N ${'72 0 R'}>>>>`,
    72: blankForm(60, 60),
    5: '7',
  });
}

/** A signal that reports itself aborted from its `read`-th look at `aborted` on. */
function signalAbortingAt(read: number): AbortSignal {
  const signal = new AbortController().signal;
  let reads = 0;
  Object.defineProperty(signal, 'aborted', {
    get: () => {
      reads += 1;
      return reads >= read;
    },
  });
  return signal;
}

const sorted = (names: readonly string[]) => [...names].sort();

describe('prepareForPdfA on a file with everything PDF/A forbids', () => {
  it('part 1 removes actions, attachments, widgets and annotations it cannot draw, and says what it did', async () => {
    const prepared = await prepareForPdfA(messy(), 1, run);
    expect({
      ...prepared.counters,
      annotationsRemoved: [...prepared.counters.annotationsRemoved].sort(),
    }).toEqual({
      formFieldsFlattened: 0,
      widgetsRemoved: 1,
      // The signed field and its kid, which inherits the type and has a value of its own.
      signaturesInvalidated: 2,
      // OpenAction, catalog /AA, two scripts, page /AA, a link's /A and /AA, two outline actions.
      actionsRemoved: 9,
      attachmentsRemoved: ['f.txt', 'g.txt', 'h.txt', '?', 'ü.txt', 'g.txt'],
      attachmentsKept: 0,
      printFlagged: 1,
      appearancesDrawn: 1,
      annotationsRemoved: [
        ['FileAttachment', 3],
        ['Foo', 1],
        ['Sound', 1],
      ],
      encryptionRemoved: false,
      toUnicodeAdded: 1,
    });
    expect(prepared.info).toMatchObject({ language: 'tr-TR', title: null, creationDate: null });

    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, prepared.bytes);
    try {
      const root = doc.getTrailer().get('Root');
      expect(['OpenAction', 'AA', 'AcroForm'].map((key) => root.get(key).isNull())).toEqual([
        true,
        true,
        true,
      ]);
      expect(root.get('Names').isNull() || root.get('Names').get('EmbeddedFiles').isNull()).toBe(true);
      const subtypes = [0, 1, 2, 3, 4, 5, 6].map((at) => doc.findPage(0).get('Annots').get(at));
      expect(
        subtypes.filter((entry) => !entry.isNull()).map((entry) => entry.resolve().get('Subtype').asName()),
      ).toEqual(['Popup', 'Link', 'Link', 'Square', 'Square', 'Square', 'Stamp']);
      // The square without an appearance now has one; the link got its Print flag, the hidden one did not.
      const [, link, hidden, drawn] = [0, 1, 2, 3].map((at) =>
        doc.findPage(0).get('Annots').get(at).resolve(),
      );
      expect(link?.get('A').isNull()).toBe(true);
      expect(link?.get('F').asNumber()).toBe(4);
      expect(hidden?.get('F').asNumber()).toBe(2);
      expect(drawn?.get('AP').get('N').isNull()).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  it('part 3 keeps the attachments and describes each: relationship and media type', async () => {
    const prepared = await prepareForPdfA(messy(), 3, run);
    expect(prepared.counters.attachmentsRemoved).toEqual([]);
    // Three embedded files and three file-attachment annotations.
    expect(prepared.counters.attachmentsKept).toBe(6);
    expect([...prepared.counters.annotationsRemoved].sort()).toEqual([
      ['Foo', 1],
      ['Sound', 1],
    ]);
    const mupdf = await loadMupdf();
    const doc = openPdf(mupdf, prepared.bytes);
    try {
      const files = doc.loadNameTree('EmbeddedFiles');
      const named = (name: string) => files[name]?.resolve();
      expect(sorted(Object.keys(files))).toEqual(['f.txt', 'g.txt', 'h.txt']);
      expect(named('f.txt')?.get('AFRelationship').asName()).toBe('Unspecified');
      expect(named('f.txt')?.get('EF').get('UF').get('Subtype').asName()).toBe('application/octet-stream');
      expect(named('g.txt')?.get('AFRelationship').asName()).toBe('Data');
      expect(named('g.txt')?.get('EF').get('F').get('Subtype').asName()).toBe('text/plain');
    } finally {
      doc.destroy();
    }
  });

  it('follows a chain of actions through /Next for 16 links and no further', async () => {
    const chain = (launchAt: number) => {
      const objects: Record<number, string> = {
        1: '<</Type/Catalog/Pages 2 0 R/OpenAction 100 0 R>>',
        2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
        3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>',
      };
      for (let depth = 0; depth <= 20; depth += 1) {
        objects[100 + depth] = depth === launchAt ? '<</S/Launch>>' : `<</S/GoTo/Next ${101 + depth} 0 R>>`;
      }
      return handPdf(objects);
    };
    const near = await prepareForPdfA(chain(2), 1, run);
    expect(near.counters.actionsRemoved).toBe(1);
    const far = await prepareForPdfA(chain(18), 1, run);
    expect(far.counters.actionsRemoved).toBe(0);
  });

  it('reads the title, author, creation date and language, and none for blank or malformed values', async () => {
    const mupdf = await import('mupdf');
    const build = (info: Record<string, string>) => {
      const doc = new mupdf.PDFDocument();
      doc.insertPage(0, doc.addPage([0, 0, 100, 100], 0, {}, ''));
      for (const [key, value] of Object.entries(info)) doc.setMetaData(`info:${key}`, value);
      const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
      doc.destroy();
      return bytes;
    };
    const full = await prepareForPdfA(
      build({
        Title: 'T',
        Author: 'A',
        Subject: 'S',
        Keywords: 'K',
        Creator: 'C',
        CreationDate: 'D:20200102030405Z',
      }),
      2,
      run,
    );
    expect(full.info).toEqual({
      title: 'T',
      author: 'A',
      subject: 'S',
      keywords: 'K',
      creator: 'C',
      creationDate: 'D:20200102030405Z',
      language: null,
    });
    const blank = await prepareForPdfA(build({ Title: '   ', CreationDate: 'yesterday' }), 2, run);
    expect(blank.info).toMatchObject({ title: null, creationDate: null });
  });

  it('flattens the fields it can, and drops the widgets of a form it cannot flatten', async () => {
    const form = (field: string, annots: string) =>
      formPdf({
        fields: '[10 0 R]',
        annots,
        extra: { 10: field, 60: blankForm(10, 10) },
      });
    const flattened = await prepareForPdfA(
      form(widgetBody('10 10 50 30', '/FT/Tx/T(t)/V(x)/AP<</N 60 0 R>>'), '[10 0 R]'),
      1,
      run,
    );
    expect(flattened.counters).toMatchObject({ formFieldsFlattened: 1, widgetsRemoved: 0 });
    // A text field with no widget cannot be flattened: the flattener refuses and nothing is flattened.
    const broken = await prepareForPdfA(form('<</FT/Tx/T(t)>>', '[]'), 1, run);
    expect(broken.counters.formFieldsFlattened).toBe(0);
  });

  it('stops when the signal aborts: before the work, while flattening or after it', async () => {
    const withField = formPdf({
      fields: '[10 0 R]',
      annots: '[10 0 R]',
      extra: { 10: widgetBody('10 10 50 30', '/FT/Tx/T(t)/V(x)/AP<</N 60 0 R>>'), 60: blankForm(10, 10) },
    });
    await expect(prepareForPdfA(withField, 1, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(prepareForPdfA(withField, 1, { signal: signalAbortingAt(4) })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(prepareForPdfA(await fixture(), 1, { signal: signalAbortingAt(2) })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
