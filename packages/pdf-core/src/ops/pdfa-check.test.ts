/**
 * The PDF/A checker against real bytes. A hand-built PDF/A-2b (XMP claim, sRGB-class output
 * intent, trailer `/ID`) must meet every rule it runs; a plain MuPDF file must not; and each
 * mutation must break exactly the rule it targets and no other, so a rule that stops firing,
 * or one that fires for the wrong reason, shows up here.
 */

import { readFileSync } from 'node:fs';
import type { PDFDocument, PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { checkPdfA, type PdfACheckReport } from './pdfa-check';

const mupdf = await import('mupdf');

const xmp = (part: string | null, extra = '', declarations = '', conformance: string | null = 'B'): string =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"${declarations}>${part === null ? '' : `<pdfaid:part>${part}</pdfaid:part>`}${conformance === null ? '' : `<pdfaid:conformance>${conformance}</pdfaid:conformance>`}${extra}</rdf:Description>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

/** The 128-byte header of an RGB display profile: version 2, class `mntr`, signature `acsp`. */
function profileBytes(signature = 'acsp'): Uint8Array {
  const bytes = new Uint8Array(160);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes[8] = 2;
  bytes.set(Buffer.from('mntr'), 12);
  bytes.set(Buffer.from('RGB '), 16);
  bytes.set(Buffer.from(signature), 36);
  return bytes;
}

interface Build {
  /** Part the file claims; `null` leaves the file a plain MuPDF one (no XMP, no intent, no `/ID`). */
  readonly claim?: string | null;
  readonly xmpExtra?: string;
  readonly xmpDeclarations?: string;
  readonly profile?: Uint8Array;
  readonly profileComponents?: number;
  readonly content?: string;
  readonly resources?: (doc: PDFDocument) => Record<string, unknown>;
  readonly catalog?: (doc: PDFDocument, root: PDFObject) => void;
  readonly save?: string;
  /** The `pdfaid:conformance` the packet writes (`null`: none). */
  readonly conformance?: string | null;
  /** The packet text, instead of the one written from `claim`. */
  readonly packet?: string;
  /** The output intents, instead of the single sRGB one. */
  readonly intents?: (doc: PDFDocument) => unknown[];
  /** Runs with the document and the page dictionary, for what the page needs beyond content and resources. */
  readonly page?: (doc: PDFDocument, page: PDFObject) => void;
  /** Rewrites the saved bytes (the file's first and last lines). */
  readonly bytes?: (bytes: Uint8Array) => Uint8Array;
}

function build(options: Build = {}): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const resources = options.resources?.(doc) ?? {};
  doc.insertPage(
    0,
    doc.addPage([0, 0, 200, 200], 0, resources, options.content ?? '1 0 0 rg 10 10 100 100 re f'),
  );
  const root = doc.getTrailer().get('Root');
  if (options.claim !== null) {
    root.put(
      'Metadata',
      doc.addStream(
        options.packet ??
          xmp(options.claim ?? '2', options.xmpExtra, options.xmpDeclarations, options.conformance),
        { Type: 'Metadata', Subtype: 'XML' },
      ),
    );
    root.put(
      'OutputIntents',
      (options.intents?.(doc) ?? [
        doc.addObject({
          Type: 'OutputIntent',
          S: 'GTS_PDFA1',
          OutputConditionIdentifier: doc.newString('sRGB'),
          DestOutputProfile: doc.addStream(options.profile ?? profileBytes(), {
            N: options.profileComponents ?? 3,
          }),
        }),
      ]) as never,
    );
    doc.getTrailer().put('ID', [doc.newString('0123456789abcdef'), doc.newString('0123456789abcdef')]);
  }
  options.catalog?.(doc, root);
  options.page?.(doc, doc.findPage(0));
  const bytes = new Uint8Array(doc.saveToBuffer(options.save ?? '').asUint8Array());
  doc.destroy();
  return options.bytes?.(bytes) ?? bytes;
}

const failed = (report: PdfACheckReport): string[] =>
  report.rules.filter((rule) => rule.state === 'fail').map((rule) => rule.id);
const rule = (report: PdfACheckReport, id: string) => report.rules.find((entry) => entry.id === id);

describe('checkPdfA', () => {
  it('fails a plain MuPDF file on the claim, the metadata and the unmanaged colour', async () => {
    const report = await checkPdfA(build({ claim: null }));
    expect(report.verdict).toBe('no-claim');
    expect(report.claim).toBeNull();
    expect(failed(report)).toEqual(['trailer', 'xmp', 'xmp-claim', 'device-colour']);
    expect(rule(report, 'xmp')?.samples[0]?.detail).toBe('the catalog has no /Metadata stream');
    expect(rule(report, 'device-colour')?.samples[0]?.detail).toBe('DeviceRGB');
    expect(report.notChecked).toEqual([
      'pdfa.notChecked.fontPrograms',
      'pdfa.notChecked.iccBody',
      'pdfa.notChecked.syntax',
      'pdfa.notChecked.xmpValues',
      'pdfa.notChecked.embeddedPdf',
      'pdfa.notChecked.accessibility',
      'pdfa.notChecked.limits',
    ]);
  });

  it('accepts a PDF/A-2b file, takes its target from the claim and skips the rules its part has not', async () => {
    const report = await checkPdfA(build());
    expect(report.verdict).toBe('claims-and-meets');
    expect(report.claim).toEqual({ part: '2', conformance: 'B' });
    expect(report.target).toEqual({ part: 2, conformance: 'B' });
    expect(report.targetFromClaim).toBe(true);
    expect(report.violations).toBe(0);
    expect(rule(report, 'transparency')?.state).toBe('na');
    expect(rule(report, 'xmp-info')?.state).toBe('na');
    expect(report.checked).toContain('output-intent');
    expect(report.checked).toContain('device-colour');
  });

  it('judges a file against the part it is asked for, not the one it claims', async () => {
    const report = await checkPdfA(build(), { part: 3 });
    expect(report.targetFromClaim).toBe(false);
    expect(failed(report)).toEqual(['xmp-claim']);
    expect(rule(report, 'xmp-claim')?.samples[0]?.detail).toBe('pdfaid:part is 2, not 3');
  });

  it('breaks only the encryption rule for an encrypted file', async () => {
    const report = await checkPdfA(build({ save: 'encrypt=aes-128,owner-password=owner,user-password=' }));
    expect(failed(report)).toEqual(['encryption']);
    expect(report.verdict).toBe('claims-with-violations');
  });

  it('breaks only the actions rule for a JavaScript open action', async () => {
    const report = await checkPdfA(
      build({
        catalog: (doc, root) =>
          root.put('OpenAction', doc.addObject({ S: 'JavaScript', JS: doc.newString('app.alert(1)') })),
      }),
    );
    expect(failed(report)).toEqual(['actions']);
    expect(rule(report, 'actions')?.samples[0]?.detail).toContain('JavaScript');
  });

  it('flags constant alpha for part 1 only', async () => {
    const alpha: Build = {
      content: '/GS gs 1 0 0 rg 10 10 100 100 re f',
      resources: () => ({ ExtGState: { GS: { Type: 'ExtGState', ca: 0.5 } } }),
    };
    const one = await checkPdfA(build({ ...alpha, claim: '1' }));
    expect(one.target.part).toBe(1);
    expect(failed(one)).toEqual(['transparency']);
    // The same drawing is legal in part 2, where the rule does not exist.
    const two = await checkPdfA(build(alpha));
    expect(rule(two, 'transparency')?.state).toBe('na');
    expect(two.verdict).toBe('claims-and-meets');
  });

  it('breaks only the fonts rule for text in a font that is not embedded, and only when it is used', async () => {
    const program = new Uint8Array(
      readFileSync(new URL('../../../../public/fonts/noto/NotoSans-Regular.ttf', import.meta.url)),
    );
    const text = 'BT /F 12 Tf 10 100 Td (Hello) Tj ET';
    const helvetica = (doc: PDFDocument) => ({
      Font: {
        F: doc.addObject({
          Type: 'Font',
          Subtype: 'Type1',
          BaseFont: 'Helvetica',
          Encoding: 'WinAnsiEncoding',
        }),
      },
    });
    const bare = await checkPdfA(build({ content: text, resources: helvetica }));
    expect(failed(bare)).toEqual(['fonts']);
    expect(rule(bare, 'fonts')?.samples[0]?.detail).toBe('Helvetica');

    // Declared but never selected by the page: not a violation.
    const unused = await checkPdfA(build({ content: '1 0 0 rg 0 0 5 5 re f', resources: helvetica }));
    expect(unused.verdict).toBe('claims-and-meets');

    // The same text in a font that carries its program passes.
    const embedded = await checkPdfA(
      build({
        content: text,
        resources: (doc) => ({
          Font: { F: doc.addSimpleFont(new mupdf.Font('NotoSans', program), 'Latin') },
        }),
      }),
    );
    expect(embedded.verdict).toBe('claims-and-meets');
  });

  it('names a metadata property whose schema the packet does not describe', async () => {
    const extra = '<custom:Flag>1</custom:Flag>';
    const bad = await checkPdfA(
      build({ xmpExtra: extra, xmpDeclarations: ' xmlns:custom="http://example.com/ns/custom/"' }),
    );
    expect(failed(bad)).toEqual(['xmp-schemas']);
    expect(rule(bad, 'xmp-schemas')?.samples[0]?.detail).toBe('http://example.com/ns/custom/');

    const described = `<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource"><pdfaSchema:namespaceURI>http://example.com/ns/custom/</pdfaSchema:namespaceURI></rdf:li></rdf:Bag></pdfaExtension:schemas>`;
    const good = await checkPdfA(
      build({
        xmpExtra: extra + described,
        xmpDeclarations:
          ' xmlns:custom="http://example.com/ns/custom/" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"',
      }),
    );
    expect(good.verdict).toBe('claims-and-meets');
  });

  it('rejects an output-intent profile with no ICC signature or the wrong component count', async () => {
    const noSignature = await checkPdfA(build({ profile: profileBytes('zzzz') }));
    // With no usable intent, the red the page paints is unmanaged device colour as well.
    expect(failed(noSignature)).toEqual(['output-intent', 'device-colour']);
    expect(rule(noSignature, 'output-intent')?.samples[0]?.detail).toBe('the profile has no ICC signature');

    const wrongN = await checkPdfA(build({ profileComponents: 4 }));
    expect(failed(wrongN)).toEqual(['output-intent']);
    expect(rule(wrongN, 'output-intent')?.samples[0]?.detail).toBe('/N 4 does not match RGB');
  });

  it('treats an unreadable packet as a metadata failure, not a claim', async () => {
    const bytes = build({
      claim: null,
      catalog: (doc, root) => {
        root.put('Metadata', doc.addStream('<<not xml', { Type: 'Metadata', Subtype: 'XML' }));
      },
    });
    const report = await checkPdfA(bytes);
    expect(report.verdict).toBe('no-claim');
    expect(rule(report, 'xmp')?.samples[0]?.detail).toBe('the metadata stream is not well-formed XMP');
  });
});

const details = (report: PdfACheckReport, id: string) =>
  rule(report, id)?.samples.map((entry) => entry.detail);
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');
const fromLatin1 = (text: string) => new Uint8Array(Buffer.from(text, 'latin1'));

describe('header and trailer', () => {
  it('flags a header version above 1.7, a missing header and a second line that is not a binary comment', async () => {
    const newer = await checkPdfA(
      build({
        bytes: (bytes) => {
          const out = bytes.slice();
          out.set(Buffer.from('%PDF-1.9'));
          return out;
        },
      }),
    );
    expect(details(newer, 'header')).toEqual(['PDF 1.9']);

    const headerless = await checkPdfA(build({ bytes: (bytes) => fromLatin1(`junk\n${latin1(bytes)}`) }));
    expect(details(headerless, 'header')).toEqual(['no %PDF-1.x header at the start of the file']);

    // The four high bytes after the first line are what marks the file binary.
    const ascii = await checkPdfA(
      build({
        bytes: (bytes) => {
          const text = latin1(bytes);
          const at = text.indexOf('\n%') + 2;
          return fromLatin1(`${text.slice(0, at)}abcd${text.slice(at + 4)}`);
        },
      }),
    );
    expect(details(ascii, 'header')).toEqual(['no binary comment on the second line']);

    const noComment = await checkPdfA(
      build({
        bytes: (bytes) => {
          const text = latin1(bytes);
          const at = text.indexOf('\n%') + 1;
          return fromLatin1(`${text.slice(0, at)}#${text.slice(at + 1)}`);
        },
      }),
    );
    expect(details(noComment, 'header')).toEqual(['no binary comment on the second line']);
  });

  it('flags a file with no %%EOF and one with data after it', async () => {
    const cut = await checkPdfA(
      build({
        bytes: (bytes) => {
          const text = latin1(bytes);
          return fromLatin1(text.slice(0, text.lastIndexOf('%%EOF')));
        },
      }),
    );
    expect(details(cut, 'trailer')).toEqual(['no %%EOF marker']);

    const trailing = await checkPdfA(
      build({ bytes: (bytes) => fromLatin1(`${latin1(bytes)}trailing junk`) }),
    );
    expect(details(trailing, 'trailer')).toEqual(['data after %%EOF']);
  });

  it('reports a file whose cross-reference table MuPDF had to rebuild', async () => {
    const repaired = await checkPdfA(
      build({
        bytes: (bytes) => {
          const text = latin1(bytes);
          return fromLatin1(text.replace(/startxref\s+\d+/, 'startxref\n7'));
        },
      }),
    );
    expect(details(repaired, 'structure')).toEqual(['the cross-reference table had to be repaired']);
  });
});

describe('stream rules over every object', () => {
  const withStreams = (build_: (doc: PDFDocument) => void): Build => ({
    catalog: (doc) => build_(doc),
  });

  it('names an LZW stream, an external stream and a Crypt filter by object number', async () => {
    let numbers: number[] = [];
    const bytes = build(
      withStreams((doc) => {
        const lzw = doc.addRawStream(new Uint8Array([1]), { Filter: 'LZWDecode' });
        const listed = doc.addRawStream(new Uint8Array([1]), {
          Filter: ['FlateDecode', 'LZWDecode', 7] as never,
        });
        const external = doc.addRawStream(new Uint8Array([1]), { F: doc.newString('x.bin') });
        const crypt = doc.addRawStream(new Uint8Array([1]), { Filter: 'Crypt' });
        const plain = doc.addRawStream(new Uint8Array([1]), { Filter: 'ASCIIHexDecode' });
        numbers = [lzw, listed, external, crypt, plain].map((entry) => entry.asIndirect());
        doc
          .getTrailer()
          .get('Root')
          .put('Extra', [lzw, listed, external, crypt, plain] as never);
      }),
    );
    const report = await checkPdfA(bytes);
    expect(details(report, 'streams')).toEqual([
      `object ${numbers[0]}: LZW`,
      `object ${numbers[1]}: LZW`,
      `object ${numbers[2]}: external stream (/F)`,
      `object ${numbers[3]}: Crypt filter`,
    ]);
    expect(report.rules.find((entry) => entry.id === 'streams')?.count).toBe(4);
  });

  it('reports object and cross-reference streams in part 1 only', async () => {
    const bytes = build({ save: 'objstms' });
    expect(details(await checkPdfA(bytes, { part: 1 }), 'structure')).toEqual([
      expect.stringMatching(/^object \d+: object stream$/),
      expect.stringMatching(/^object \d+: cross-reference stream$/),
    ]);
    expect(failed(await checkPdfA(bytes, { part: 2 }))).not.toContain('structure');
  });

  it('keeps counting but samples only the first eight violations of a rule', async () => {
    const report = await checkPdfA(
      build({
        catalog: (doc, root) => {
          const names = Array.from({ length: 10 }, (_unused, index) => [
            doc.newString(`script${String(index).padStart(2, '0')}`),
            doc.addObject({ S: 'JavaScript', JS: doc.newString('1') }),
          ]).flat();
          root.put('Names', doc.addObject({ JavaScript: doc.addObject({ Names: names }) }));
        },
      }),
    );
    const actions = rule(report, 'actions');
    expect(actions?.count).toBe(10);
    expect(actions?.samples).toHaveLength(8);
    expect(actions?.samples[0]?.detail).toBe('JavaScript: script00');
  });
});

describe('the object scan limit', () => {
  it('reports the streams rule unchecked when the file has more objects than the scan walks', async () => {
    const size = 400_002;
    const objects = [
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n',
      '2 0 obj\n<</Type/Pages/Count 1/Kids[3 0 R]>>\nendobj\n',
      '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>\nendobj\n',
    ];
    const header = '%PDF-1.4\n';
    const offsets: number[] = [];
    let body = header;
    for (const object of objects) {
      offsets.push(body.length);
      body += object;
    }
    const free = '0000000000 00000 f \n';
    const entries = [
      '0000000000 65535 f \n',
      ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    ].join('');
    const xref = `${body.length}`;
    const file = `${body}xref\n0 ${size}\n${entries}${free.repeat(size - 4)}trailer\n<</Size ${size}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
    const report = await checkPdfA(fromLatin1(file));
    expect(rule(report, 'streams')).toEqual({ id: 'streams', state: 'unchecked', count: 0, samples: [] });
    expect(report.unchecked).toEqual(['streams']);
  });
});

/** A 128-byte ICC header with the fields the check reads. */
function icc(fields: { version?: number; cls?: string; space?: string; length?: number } = {}): Uint8Array {
  const bytes = new Uint8Array(fields.length ?? 160);
  bytes[8] = fields.version ?? 2;
  bytes.set(Buffer.from(fields.cls ?? 'mntr'), 12);
  bytes.set(Buffer.from(fields.space ?? 'RGB '), 16);
  bytes.set(Buffer.from('acsp'), 36);
  return bytes;
}

const UNDECODABLE = {
  Filter: 'FlateDecode',
  DecodeParms: { Predictor: 15, Columns: -5, Colors: 1000, BitsPerComponent: 99 },
};

describe('metadata stream and claim', () => {
  const NS =
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"';
  const PROPERTIES =
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Report</rdf:li></rdf:Alt></dc:title>' +
    '<dc:creator><rdf:Seq><rdf:li>Ada</rdf:li><rdf:li>Bob</rdf:li></rdf:Seq></dc:creator>' +
    '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">About</rdf:li></rdf:Alt></dc:description>' +
    '<pdf:Keywords>k1, k2</pdf:Keywords><xmp:CreatorTool>Tool</xmp:CreatorTool><pdf:Producer>Maker</pdf:Producer>';
  const info = (entries: Record<string, string | null>) => (doc: PDFDocument) => {
    const dictionary = doc.newDictionary();
    for (const [key, value] of Object.entries(entries)) {
      dictionary.put(key, value === null ? doc.newName('NotText') : doc.newString(value));
    }
    doc.getTrailer().put('Info', doc.addObject(dictionary));
  };

  it('compares each Information entry with the packet in part 1: equal, differing and missing', async () => {
    const same = await checkPdfA(
      build({
        claim: '1',
        xmpExtra: PROPERTIES,
        xmpDeclarations: NS,
        catalog: (doc) =>
          info({
            Title: 'Report',
            Author: 'Ada, Bob',
            Subject: 'About',
            Keywords: 'k1, k2',
            Creator: 'Tool',
            Producer: 'Maker',
          })(doc),
      }),
    );
    expect(rule(same, 'xmp-info')?.state).toBe('pass');

    const mismatched = await checkPdfA(
      build({
        claim: '1',
        xmpExtra: PROPERTIES.replace(/<dc:description>.*<\/dc:description>/, ''),
        xmpDeclarations: NS,
        catalog: (doc) =>
          info({
            Title: 'Another title',
            Author: '',
            Subject: 'About',
            Keywords: null,
            Creator: 'Tool',
            Producer: ' Maker ',
          })(doc),
      }),
    );
    // Empty and non-text entries are not compared; whitespace around a value does not matter.
    expect(details(mismatched, 'xmp-info')).toEqual([
      'Title: differs from the metadata stream',
      'Subject: missing from the metadata stream',
    ]);

    const noCreator = await checkPdfA(
      build({
        claim: '1',
        catalog: (doc) => info({ Author: 'Ada' })(doc),
      }),
    );
    expect(details(noCreator, 'xmp-info')).toEqual(['Author: missing from the metadata stream']);
  });

  it('asks for the pdfaid part and a conformance that part allows', async () => {
    const noConformance = await checkPdfA(build({ conformance: null }));
    expect(details(noConformance, 'xmp-claim')).toEqual(['no pdfaid:conformance']);

    const invalid = await checkPdfA(build({ conformance: 'Z' }));
    expect(details(invalid, 'xmp-claim')).toEqual(['pdfaid:conformance Z is not valid in part 2']);
    expect(invalid.target).toEqual({ part: 2, conformance: 'B' });

    // U exists from part 2 on.
    const u = await checkPdfA(build({ claim: '1', conformance: 'U' }));
    expect(details(u, 'xmp-claim')).toEqual(['pdfaid:conformance U is not valid in part 1']);
    expect(u.target).toEqual({ part: 1, conformance: 'U' });
    const part3 = await checkPdfA(build({ claim: '3', conformance: 'U' }));
    expect(failed(part3)).toEqual([]);
    expect(part3.target).toEqual({ part: 3, conformance: 'U' });

    // A conformance letter is read case-insensitively for the target, but written case matters for the rule.
    const lower = await checkPdfA(build({ conformance: 'a' }));
    expect(lower.target.conformance).toBe('A');
    expect(details(lower, 'xmp-claim')).toEqual(['pdfaid:conformance a is not valid in part 2']);

    const onlyConformance = await checkPdfA(build({ packet: xmp(null) }));
    expect(onlyConformance.claim).toEqual({ part: null, conformance: 'B' });
    expect(details(onlyConformance, 'xmp-claim')).toEqual(['no pdfaid:part']);
    expect(onlyConformance.targetFromClaim).toBe(false);

    const unknownPart = await checkPdfA(build({ claim: '4' }));
    expect(unknownPart.target.part).toBe(2);
    expect(unknownPart.targetFromClaim).toBe(false);
    expect(details(unknownPart, 'xmp-claim')).toEqual(['pdfaid:part is 4, not 2']);
  });

  it('judges the metadata stream itself: its keys, a filter in part 1 and bytes nobody can decode', async () => {
    const stream = (dictionary: Record<string, unknown>, bytes = fromLatin1(xmp('2'))) =>
      ({
        claim: null,
        catalog: (doc: PDFDocument, root: PDFObject) =>
          root.put('Metadata', doc.addRawStream(bytes, dictionary as never)),
      }) satisfies Build;

    const keys = await checkPdfA(build(stream({ Type: 'Metadata' })));
    expect(details(keys, 'xmp')).toEqual(['/Type /Metadata and /Subtype /XML are required']);

    const hex = fromLatin1(`${Buffer.from(xmp('1')).toString('hex')}>`);
    const filtered = await checkPdfA(
      build(stream({ Type: 'Metadata', Subtype: 'XML', Filter: 'ASCIIHexDecode' }, hex)),
      { part: 1 },
    );
    expect(details(filtered, 'xmp')).toEqual(['the metadata stream has a /Filter']);
    // The same filter is allowed from part 2 on.
    const allowed = await checkPdfA(
      build(stream({ Type: 'Metadata', Subtype: 'XML', Filter: 'ASCIIHexDecode' }, hex)),
      { part: 2 },
    );
    expect(details(allowed, 'xmp')).toEqual([]);

    const broken = await checkPdfA(
      build(stream({ Type: 'Metadata', Subtype: 'XML', ...UNDECODABLE }, new Uint8Array([1, 2, 3]))),
    );
    expect(details(broken, 'xmp')).toEqual(['the metadata stream cannot be decoded']);
    expect(broken.verdict).toBe('no-claim');
  });
});

describe('output intents', () => {
  const intent = (doc: PDFDocument, profile: PDFObject | null, extra: Record<string, unknown> = {}) =>
    doc.addObject({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      OutputConditionIdentifier: doc.newString('x'),
      ...(profile === null ? {} : { DestOutputProfile: profile }),
      ...extra,
    } as never);
  const profile = (doc: PDFDocument, bytes: Uint8Array, components: number | null = 3) =>
    doc.addStream(bytes, components === null ? {} : { N: components });

  it('reads the profile header: version, class, colour space and the component count', async () => {
    const intents =
      (...makers: ((doc: PDFDocument) => PDFObject)[]) =>
      (doc: PDFDocument) =>
        makers.map((make) => make(doc));
    const check = async (maker: (doc: PDFDocument) => PDFObject) =>
      details(await checkPdfA(build({ intents: intents(maker) })), 'output-intent');

    expect(await check((doc) => intent(doc, null))).toEqual([
      'the PDF/A output intent has no /DestOutputProfile',
    ]);
    expect(await check((doc) => intent(doc, profile(doc, new Uint8Array(100))))).toEqual([
      'the profile cannot be read as an ICC profile',
    ]);
    expect(
      await check((doc) => intent(doc, doc.addRawStream(new Uint8Array([1, 2, 3]), UNDECODABLE as never))),
    ).toEqual(['the profile cannot be read as an ICC profile']);
    expect(await check((doc) => intent(doc, profile(doc, icc({ version: 5 }))))).toEqual(['ICC version 5']);
    expect(await check((doc) => intent(doc, profile(doc, icc({ cls: 'scnr' }))))).toEqual([
      'profile class scnr',
    ]);
    expect(await check((doc) => intent(doc, profile(doc, icc({ space: 'Lab ' }))))).toEqual([
      'profile colour space Lab',
    ]);
    expect(await check((doc) => intent(doc, profile(doc, icc(), null)))).toEqual([
      '/N missing does not match RGB',
    ]);
    // A printer profile with the right component count is fine for each colour space it can describe.
    expect(await check((doc) => intent(doc, profile(doc, icc({ cls: 'prtr', space: 'CMYK' }), 4)))).toEqual(
      [],
    );
    expect(await check((doc) => intent(doc, profile(doc, icc({ space: 'GRAY' }), 1)))).toEqual([]);
  });

  it('ignores an entry that is not a dictionary or not a PDF/A intent, and flags two different profiles', async () => {
    const skipped = await checkPdfA(
      build({
        intents: (doc) => [
          doc.newInteger(5),
          doc.addObject({ Type: 'OutputIntent', S: 'GTS_PDFX' } as never),
        ],
      }),
    );
    // No PDF/A intent counts: the red rectangle is unmanaged colour.
    expect(rule(skipped, 'output-intent')?.state).toBe('pass');
    expect(failed(skipped)).toEqual(['device-colour']);

    const two = await checkPdfA(
      build({
        intents: (doc) => [intent(doc, profile(doc, icc())), intent(doc, profile(doc, icc({ version: 4 })))],
      }),
    );
    expect(details(two, 'output-intent')).toEqual(['the PDF/A output intents use different profiles']);
  });
});
