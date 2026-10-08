/**
 * The PDF/A checker against real bytes. A hand-built PDF/A-2b (XMP claim, sRGB-class output
 * intent, trailer `/ID`) must meet every rule it runs; a plain MuPDF file must not; and each
 * mutation must break exactly the rule it targets and no other, so a rule that stops firing,
 * or one that fires for the wrong reason, shows up here.
 */

import { readFileSync } from 'node:fs';
import type { PDFDocument, PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { checkPdfA, PDFA_RULE_IDS, type PdfACheckReport, summariseViolations } from './pdfa-check';

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

  it('accepts a PDF/A-2b file, takes its target from the claim and skips the rule part 1 alone has', async () => {
    const report = await checkPdfA(build());
    expect(report.verdict).toBe('claims-and-meets');
    expect(report.claim).toEqual({ part: '2', conformance: 'B' });
    expect(report.target).toEqual({ part: 2, conformance: 'B' });
    expect(report.targetFromClaim).toBe(true);
    expect(report.violations).toBe(0);
    expect(rule(report, 'transparency')?.state).toBe('pass');
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
    // The same drawing is legal in part 2 when an output intent names the colour space.
    const two = await checkPdfA(build(alpha));
    expect(rule(two, 'transparency')?.state).toBe('pass');
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

/** The `device-colour` details of a page with no output intent that runs `content`. */
async function colourOf(
  content: string,
  resources?: (doc: PDFDocument) => Record<string, unknown>,
): Promise<(string | undefined)[] | undefined> {
  const report = await checkPdfA(build({ claim: null, content, resources }));
  return details(report, 'device-colour');
}
const FILL = '0 0 5 5 re f';

describe('device colour: operators', () => {
  it('reads the colour a fill or stroke operator sets, and the paint operator that uses it', async () => {
    expect(await colourOf('0 g 1 0 0 rg 0 0 0 1 k 0 0 5 5 re f')).toEqual(['DeviceCMYK']);
    expect(await colourOf('0 g 1 0 0 rg 0 0 5 5 re f')).toEqual(['DeviceRGB']);
    expect(await colourOf('1 0 0 rg 0.5 g 0 0 5 5 re f')).toEqual(['DeviceGray']);
    // A page starts out painting in DeviceGray.
    expect(await colourOf(FILL)).toEqual(['DeviceGray']);
    // Stroke and fill are separate: a stroke colour is not used by a fill.
    expect(await colourOf('0 0 0 1 K 0 0 5 5 re f')).toEqual(['DeviceGray']);
    expect(await colourOf('0 0 0 1 K 0 0 5 5 re S')).toEqual(['DeviceCMYK']);
    expect(await colourOf('1 0 0 RG 0 0 5 5 re S')).toEqual(['DeviceRGB']);
    expect(await colourOf('0.5 G 0 0 5 5 re S')).toEqual(['DeviceGray']);
  });

  it.each([
    ['f', ['DeviceCMYK']],
    ['F', ['DeviceCMYK']],
    ['f*', ['DeviceCMYK']],
    ['S', ['DeviceRGB']],
    ['s', ['DeviceRGB']],
    ['B', ['DeviceCMYK', 'DeviceRGB']],
    ['B*', ['DeviceCMYK', 'DeviceRGB']],
    ['b', ['DeviceCMYK', 'DeviceRGB']],
    ['b*', ['DeviceCMYK', 'DeviceRGB']],
    ['n', []],
  ])(
    'uses the fill colour, the stroke colour or both when a path is painted with %s',
    async (op, expected) => {
      expect(await colourOf(`0 0 0 1 k 1 0 0 RG 0 0 5 5 re ${op}`)).toEqual(expected);
    },
  );

  it('restores the colours a q/Q pair saved, and survives a Q with nothing saved', async () => {
    expect(await colourOf(`q 0 0 0 1 k Q ${FILL}`)).toEqual(['DeviceGray']);
    expect(await colourOf(`Q Q 0 0 0 1 k ${FILL}`)).toEqual(['DeviceCMYK']);
  });

  it.each([
    [0, ['DeviceCMYK']],
    [1, ['DeviceRGB']],
    [2, ['DeviceCMYK', 'DeviceRGB']],
    [3, []],
    [4, ['DeviceCMYK']],
    [5, ['DeviceRGB']],
    [6, ['DeviceCMYK', 'DeviceRGB']],
    [7, []],
  ])('uses the colours the text render mode %i paints with', async (mode, expected) => {
    expect(await colourOf(`0 0 0 1 k 1 0 0 RG BT /F 12 Tf ${mode} Tr (a) Tj ET`)).toEqual(expected);
  });

  it.each([['(a) Tj'], ['[(a) 1] TJ'], ["(a) '"], ['1 2 (a) "']])(
    'paints text with the show operator %s',
    async (show) => {
      expect(await colourOf(`0 0 0 1 k BT /F 12 Tf ${show} ET`)).toEqual(['DeviceCMYK']);
    },
  );

  it('reads Tr without an operand as render mode 0', async () => {
    expect(await colourOf('0 0 0 1 k BT Tr (a) Tj ET')).toEqual(['DeviceCMYK']);
  });
});

describe('device colour: colour space operators', () => {
  const spaces = (doc: PDFDocument) => ({
    ColorSpace: {
      IndexedCmyk: ['Indexed', 'DeviceCMYK', 1, doc.newString('abcdefgh')],
      IndexedShort: ['I', 'DeviceRGB', 1, doc.newString('abcdef')],
      PatternCmyk: ['Pattern', 'DeviceCMYK'],
      PatternPlain: ['Pattern'],
      Array: ['DeviceRGB'],
      Icc: ['ICCBased', doc.addStream(new Uint8Array(4), { N: 3 })],
      Number: 5,
      Alias: 'DeviceCMYK',
      Chain0: 'Chain1',
      Chain1: 'Chain2',
      Chain2: 'DeviceCMYK',
      Deep0: 'Deep1',
      Deep1: 'Deep2',
      Deep2: 'Deep3',
      Deep3: 'Deep4',
      Deep4: 'Deep5',
      Deep5: 'Deep6',
      Deep6: 'Deep7',
      Deep7: 'DeviceCMYK',
      Dangling: doc.newIndirect(9999),
    },
  });

  it.each([
    ['/DeviceGray', ['DeviceGray']],
    ['/G', ['DeviceGray']],
    ['/DeviceRGB', ['DeviceRGB']],
    ['/RGB', ['DeviceRGB']],
    ['/DeviceCMYK', ['DeviceCMYK']],
    ['/CMYK', ['DeviceCMYK']],
    ['/Pattern', []],
    ['/Missing', []],
    ['', []],
    ['/IndexedCmyk', ['DeviceCMYK']],
    ['/IndexedShort', ['DeviceRGB']],
    ['/PatternCmyk', ['DeviceCMYK']],
    ['/PatternPlain', []],
    ['/Array', ['DeviceRGB']],
    ['/Icc', []],
    ['/Number', []],
    ['/Alias', ['DeviceCMYK']],
    ['/Chain0', ['DeviceCMYK']],
    ['/Deep0', []],
    ['/Dangling', []],
  ])('classifies the colour space named %s for a fill', async (name, expected) => {
    expect(await colourOf(`${name} cs ${FILL}`, spaces)).toEqual(expected);
  });

  it('classifies a space selected for stroking from its name', async () => {
    expect(await colourOf('/IndexedCmyk CS 0 0 5 5 re S', spaces)).toEqual(['DeviceCMYK']);
    expect(await colourOf('/Icc CS 0 0 5 5 re S', spaces)).toEqual([]);
  });

  it('accepts a Default space, which makes the matching device space managed', async () => {
    const withDefault = (doc: PDFDocument) => ({
      ColorSpace: { DefaultGray: ['CalGray', { WhitePoint: [1, 1, 1] }], DefaultCMYK: ['Pattern'] },
      unused: doc,
    });
    expect(await colourOf(`0 0 0 1 k ${FILL} 1 0 0 rg ${FILL}`, withDefault)).toEqual(['DeviceRGB']);
    expect(await colourOf(`0 0 5 5 re f`, withDefault)).toEqual([]);
  });

  it('counts device colour a shading paints with, and ignores one it cannot resolve', async () => {
    const shadings = (doc: PDFDocument) => ({
      Shading: {
        Cmyk: doc.addObject({ ShadingType: 2, ColorSpace: 'DeviceCMYK' }),
        Plain: doc.addObject({ ShadingType: 2 }),
        Dangling: doc.newIndirect(9999),
      },
    });
    expect(await colourOf('/Cmyk sh', shadings)).toEqual(['DeviceCMYK']);
    expect(await colourOf('/Plain sh', shadings)).toEqual([]);
    expect(await colourOf('/Dangling sh', shadings)).toEqual([]);
    expect(await colourOf('/Absent sh', shadings)).toEqual([]);
    expect(await colourOf('sh', shadings)).toEqual([]);
  });

  it('reads the colour of a device space an output intent covers: gray always, RGB and CMYK only for their own profile', async () => {
    const content = '0 g 1 0 0 rg 0 0 0 1 k 0 0 5 5 re f';
    const rgbIntent = await checkPdfA(build({ content: '0 g 1 0 0 rg 0 0 5 5 re f' }));
    expect(details(rgbIntent, 'device-colour')).toEqual([]);
    const cmykOnRgb = await checkPdfA(build({ content }));
    expect(details(cmykOnRgb, 'device-colour')).toEqual(['DeviceCMYK']);
    const cmykIntent = (doc: PDFDocument) => [
      doc.addObject({
        Type: 'OutputIntent',
        S: 'GTS_PDFA1',
        DestOutputProfile: doc.addStream(icc({ cls: 'prtr', space: 'CMYK' }), { N: 4 }),
      } as never),
    ];
    const rgbOnCmyk = await checkPdfA(build({ content: '1 0 0 rg 0 0 5 5 re f', intents: cmykIntent }));
    expect(details(rgbOnCmyk, 'device-colour')).toEqual(['DeviceRGB']);
    const cmykOnCmyk = await checkPdfA(build({ content: '0 0 0 1 k 0 0 5 5 re f', intents: cmykIntent }));
    expect(details(cmykOnCmyk, 'device-colour')).toEqual([]);
  });

  it('reports a device space once per page and names the page', async () => {
    const doc = new mupdf.PDFDocument();
    for (let index = 0; index < 2; index += 1) {
      doc.insertPage(index, doc.addPage([0, 0, 50, 50], 0, {}, '1 0 0 rg 0 0 5 5 re f 0 0 5 5 re f'));
    }
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    const report = await checkPdfA(bytes);
    expect(rule(report, 'device-colour')?.samples).toEqual([
      { pageIndex: 0, detail: 'DeviceRGB' },
      { pageIndex: 1, detail: 'DeviceRGB' },
    ]);
  });
});

const USE_GS = '/GS gs 0 0 5 5 re f';
const withState = (state: (doc: PDFDocument) => Record<string, unknown>) => (doc: PDFDocument) => ({
  ExtGState: { GS: state(doc) },
});
const transparencyOf = async (state: (doc: PDFDocument) => Record<string, unknown>, claim = '1') =>
  details(await checkPdfA(build({ claim, content: USE_GS, resources: withState(state) })), 'transparency');
const graphicsOf = async (state: (doc: PDFDocument) => Record<string, unknown>) =>
  details(await checkPdfA(build({ content: USE_GS, resources: withState(state) })), 'graphics-state');

describe('graphics state: transparency', () => {
  it('names constant alpha once per page, whichever of CA and ca is below 1', async () => {
    expect(await transparencyOf(() => ({ CA: 0.5, ca: 0.25 }))).toEqual(['/CA 0.5']);
    expect(await transparencyOf(() => ({ ca: 0.25 }))).toEqual(['/ca 0.25']);
    expect(await transparencyOf(() => ({ CA: 1, ca: 1 }))).toEqual([]);
  });

  it('names a soft mask unless it is /None, and a blend mode unless it is Normal or Compatible', async () => {
    expect(await transparencyOf((doc) => ({ SMask: doc.addObject({ S: 'Alpha' }) }))).toEqual(['/SMask']);
    expect(await transparencyOf(() => ({ SMask: 'None' }))).toEqual([]);
    expect(await transparencyOf(() => ({ BM: 'Multiply' }))).toEqual(['/BM']);
    expect(await transparencyOf(() => ({ BM: ['Multiply', 'Normal'] }))).toEqual(['/BM']);
    expect(await transparencyOf(() => ({ BM: 'Normal' }))).toEqual([]);
    expect(await transparencyOf(() => ({ BM: 'Compatible' }))).toEqual([]);
    expect(await transparencyOf(() => ({ BM: ['Normal', 'Multiply'] }))).toEqual([]);
    expect(await transparencyOf(() => ({ BM: ['Compatible'] }))).toEqual([]);
    // A blend mode that is neither a name nor an array has nothing to object to.
    expect(await transparencyOf(() => ({ BM: 3 }))).toEqual([]);
    expect(await transparencyOf(() => ({}))).toEqual([]);
  });

  it('counts a graphics state used by two pages once on each', async () => {
    const doc = new mupdf.PDFDocument();
    const state = doc.addObject({ Type: 'ExtGState', ca: 0.5 });
    for (let index = 0; index < 2; index += 1) {
      doc.insertPage(index, doc.addPage([0, 0, 50, 50], 0, { ExtGState: { GS: state } }, USE_GS));
    }
    const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
    const report = await checkPdfA(bytes, { part: 1 });
    // The second page uses a state already judged, so only the first is named.
    expect(rule(report, 'transparency')?.samples).toEqual([{ pageIndex: 0, detail: '/ca 0.5' }]);
  });

  it('wants parts 2 and 3 to name the blending space when a page uses transparency and has no output intent', async () => {
    const message = 'transparency without an output intent or /Group /CS';
    const plain = (state: (doc: PDFDocument) => Record<string, unknown>) =>
      build({ claim: null, content: USE_GS, resources: withState(state) });
    for (const state of [
      () => ({ ca: 0.5 }),
      () => ({ CA: 0.5 }),
      (doc: PDFDocument) => ({ SMask: doc.addObject({ S: 'Alpha' }) }),
      () => ({ BM: 'Screen' }),
    ]) {
      expect(details(await checkPdfA(plain(state)), 'transparency')).toEqual([message]);
      expect(details(await checkPdfA(plain(state), { part: 3 }), 'transparency')).toEqual([message]);
    }
    expect(
      details(await checkPdfA(plain(() => ({ ca: 1, CA: 1, SMask: 'None', BM: 'Normal' }))), 'transparency'),
    ).toEqual([]);
    // An output intent names the space, and so does a page group's /CS.
    expect(
      details(
        await checkPdfA(build({ content: USE_GS, resources: withState(() => ({ ca: 0.5 })) })),
        'transparency',
      ),
    ).toEqual([]);
    const grouped = build({
      claim: null,
      content: USE_GS,
      resources: withState(() => ({ ca: 0.5 })),
      page: (_doc, page) => page.put('Group', { S: 'Transparency', CS: 'DeviceRGB' } as never),
    });
    expect(details(await checkPdfA(grouped), 'transparency')).toEqual([]);
    const groupWithoutSpace = build({
      claim: null,
      content: USE_GS,
      resources: withState(() => ({ ca: 0.5 })),
      page: (_doc, page) => page.put('Group', { S: 'Transparency' } as never),
    });
    expect(details(await checkPdfA(groupWithoutSpace), 'transparency')).toEqual([message]);
  });

  it('flags a page /Group in part 1 and not in parts 2 and 3', async () => {
    const page = (_doc: PDFDocument, entry: PDFObject) =>
      entry.put('Group', { S: 'Transparency', CS: 'DeviceRGB' } as never);
    expect(details(await checkPdfA(build({ claim: '1', page })), 'transparency')).toEqual(['page /Group']);
    expect(details(await checkPdfA(build({ claim: '2', page })), 'transparency')).toEqual([]);
    const other = (_doc: PDFDocument, entry: PDFObject) => entry.put('Group', { S: 'Other' } as never);
    expect(details(await checkPdfA(build({ claim: '1', page: other })), 'transparency')).toEqual([]);
  });
});

describe('graphics state: forbidden entries', () => {
  it('names transfer functions, halftone entries and a halftone that is not type 1 or 5', async () => {
    expect(await graphicsOf((doc) => ({ TR: doc.addObject({ FunctionType: 2 } as never) }))).toEqual(['/TR']);
    expect(await graphicsOf(() => ({ TR2: 'Default' }))).toEqual([]);
    expect(await graphicsOf(() => ({ TR2: 'Custom' }))).toEqual(['/TR2']);
    expect(await graphicsOf(() => ({ HTP: 'x' }))).toEqual(['/HTP']);
    expect(await graphicsOf(() => ({ HT: { HalftoneType: 1 } }))).toEqual([]);
    expect(await graphicsOf(() => ({ HT: { HalftoneType: 5 } }))).toEqual([]);
    expect(await graphicsOf(() => ({ HT: { HalftoneType: 6 } }))).toEqual(['/HalftoneType 6']);
    expect(await graphicsOf(() => ({ HT: {} }))).toEqual(['/HalftoneType ?']);
    expect(await graphicsOf(() => ({ HT: { HalftoneType: 1, HalftoneName: 'Round' } }))).toEqual([
      '/HalftoneName',
    ]);
    expect(await graphicsOf(() => ({ HT: 'Default' }))).toEqual([]);
  });

  it('ignores a gs operand that names nothing or names something that is not a dictionary', async () => {
    const report = await checkPdfA(
      build({
        content: '/Nope gs gs /Num gs 0 0 5 5 re f',
        resources: () => ({ ExtGState: { Num: 3 } }),
      }),
    );
    expect(report.verdict).toBe('claims-and-meets');
  });

  it('reads the content of a soft mask group, once', async () => {
    const group = (doc: PDFDocument) =>
      doc.addStream('0 0 0 1 k 0 0 5 5 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] });
    const state = (doc: PDFDocument) => ({
      SMask: doc.addObject({ S: 'Luminosity', G: group(doc) } as never),
    });
    const report = await checkPdfA(
      build({ content: `${USE_GS} ${USE_GS}`, resources: withState(state), claim: '2' }),
    );
    expect(details(report, 'device-colour')).toEqual(['DeviceCMYK']);
    const noGroup = await checkPdfA(
      build({
        content: USE_GS,
        resources: withState((doc) => ({ SMask: doc.addObject({ S: 'Alpha', G: 'None' } as never) })),
      }),
    );
    expect(details(noGroup, 'device-colour')).toEqual([]);
  });
});

describe('images', () => {
  const image = (doc: PDFDocument, extra: Record<string, unknown> = {}, bytes = new Uint8Array(3)) =>
    doc.addRawStream(bytes, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 1,
      Height: 1,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceRGB',
      ...extra,
    } as never);
  const withImage =
    (extra: (doc: PDFDocument) => Record<string, unknown>) =>
    (doc: PDFDocument): Record<string, unknown> => ({ XObject: { Im: image(doc, extra(doc)) } });
  const imagesOf = async (extra: (doc: PDFDocument) => Record<string, unknown>, claim = '2') =>
    checkPdfA(build({ claim, content: '/Im Do', resources: withImage(extra) }));

  it('names an alternate image, OPI and interpolation, each once', async () => {
    const report = await imagesOf(() => ({ Alternates: [], OPI: {}, Interpolate: true }));
    expect(details(report, 'images')).toEqual(['/Alternates', '/OPI', '/Interpolate true']);
    expect(details(await imagesOf(() => ({ Interpolate: false })), 'images')).toEqual([]);
  });

  it('names an image soft mask and SMaskInData in part 1 only', async () => {
    const extra = (doc: PDFDocument) => ({ SMask: image(doc, { ColorSpace: 'DeviceGray' }), SMaskInData: 1 });
    expect(details(await imagesOf(extra, '1'), 'transparency')).toEqual(['image /SMask', '/SMaskInData']);
    expect(details(await imagesOf(() => ({ SMaskInData: 0 }), '1'), 'transparency')).toEqual([]);
    expect(details(await imagesOf(extra, '2'), 'transparency')).toEqual([]);
  });

  it('treats an image soft mask or SMaskInData as transparency on the page in parts 2 and 3', async () => {
    const message = 'transparency without an output intent or /Group /CS';
    const noIntent = async (extra: (doc: PDFDocument) => Record<string, unknown>) =>
      details(
        await checkPdfA(build({ claim: null, content: '/Im Do', resources: withImage(extra) })),
        'transparency',
      );
    expect(await noIntent((doc) => ({ SMask: image(doc, { ColorSpace: 'DeviceGray' }) }))).toEqual([message]);
    expect(await noIntent(() => ({ SMaskInData: 2 }))).toEqual([message]);
    expect(await noIntent(() => ({ SMaskInData: 0 }))).toEqual([]);
  });

  it('names an LZW image besides the stream rule that finds the same bytes', async () => {
    const report = await imagesOf(() => ({ Filter: 'LZWDecode' }));
    expect(details(report, 'streams')).toEqual([expect.stringMatching(/^object \d+: LZW$/), 'LZW image']);
    const abbreviated = await imagesOf(() => ({ Filter: ['LZW'] }));
    expect(details(abbreviated, 'streams')).toEqual([
      expect.stringMatching(/^object \d+: LZW$/),
      'LZW image',
    ]);
  });

  it('paints an image mask with the fill colour and any other image with its own colour space', async () => {
    const plain = async (extra: Record<string, unknown>, content = '/Im Do') =>
      details(
        await checkPdfA(
          build({
            claim: null,
            content,
            resources: (doc) => ({ XObject: { Im: image(doc, extra) } }),
          }),
        ),
        'device-colour',
      );
    expect(await plain({ ImageMask: true }, '0 0 0 1 k /Im Do')).toEqual(['DeviceCMYK']);
    expect(await plain({ ImageMask: false, ColorSpace: 'DeviceCMYK' }, '0 0 0 1 k /Im Do')).toEqual([
      'DeviceCMYK',
    ]);
    expect(await plain({ ColorSpace: 'DeviceGray' })).toEqual(['DeviceGray']);
    expect(await plain({ ColorSpace: ['ICCBased'] })).toEqual([]);
  });

  it('reads every use of an image: a mask painted in another colour on another page is still judged', async () => {
    const doc = new mupdf.PDFDocument();
    const mask = image(doc, { ImageMask: true });
    const resources = { XObject: { Im: mask } };
    doc.insertPage(0, doc.addPage([0, 0, 50, 50], 0, resources, '/Im Do'));
    doc.insertPage(1, doc.addPage([0, 0, 50, 50], 0, resources, '0 0 0 1 k /Im Do'));
    const report = await checkPdfA(new Uint8Array(doc.saveToBuffer('').asUint8Array()));
    expect(rule(report, 'device-colour')?.samples).toEqual([
      { pageIndex: 0, detail: 'DeviceGray' },
      { pageIndex: 1, detail: 'DeviceCMYK' },
    ]);
  });

  it('ignores an XObject operand that names nothing, has no name or is neither an image nor a form', async () => {
    const report = await checkPdfA(
      build({
        content: '/Nope Do Do /Other Do /Plain Do 0 0 5 5 re f',
        resources: (doc) => ({
          XObject: {
            Other: doc.addRawStream(new Uint8Array(1), { Type: 'XObject', Subtype: 'Weird' } as never),
            Plain: doc.addObject({ Type: 'XObject' } as never),
          },
        }),
      }),
    );
    expect(report.verdict).toBe('claims-and-meets');
  });
});

describe('inline images', () => {
  const inline = (dictionary: string, data = 'ab') => `q 5 0 0 5 0 0 cm BI ${dictionary} ID ${data} EI Q`;
  const colour = async (content: string) => colourOf(content);

  it('paints an inline image with its colour space (name, abbreviation or an indexed array)', async () => {
    expect(await colour(inline('/W 1 /H 1 /BPC 8 /CS /CMYK'))).toEqual(['DeviceCMYK']);
    expect(await colour(inline('/W 1 /H 1 /BPC 8 /ColorSpace /DeviceRGB'))).toEqual(['DeviceRGB']);
    expect(await colour(inline('/W 1 /H 1 /BPC 8 /CS /G'))).toEqual(['DeviceGray']);
    expect(await colour(inline('/W 1 /H 1 /BPC 8 /CS [/I /CMYK 1 (abcdefgh)]'))).toEqual(['DeviceCMYK']);
    expect(await colour(inline('/W 1 /H 1 /BPC 8 /CS [/Indexed /RGB 1 (abcdef)]'))).toEqual(['DeviceRGB']);
    expect(await colour(inline('/W 1 /H 1 /BPC 8 /CS [/ICCBased 5 0 R]'))).toEqual([]);
    expect(await colour(inline('/W 1 /H 1 /BPC 8 /CS 5'))).toEqual([]);
    expect(await colour(inline('/W 1 /H 1 /BPC 8'))).toEqual([]);
  });

  it('paints an inline image mask with the fill colour', async () => {
    expect(await colour(`0 0 0 1 k ${inline('/W 1 /H 1 /IM true')}`)).toEqual(['DeviceCMYK']);
    expect(await colour(`0 0 0 1 k ${inline('/W 1 /H 1 /ImageMask true')}`)).toEqual(['DeviceCMYK']);
    // /IM false is an ordinary image with no colour space.
    expect(await colour(`0 0 0 1 k ${inline('/W 1 /H 1 /IM false')}`)).toEqual([]);
  });

  it('reads a BI with an empty dictionary as an image with no colour space', async () => {
    expect(await colour('BI ID ab EI')).toEqual([]);
  });

  it('names an inline LZW image whether the filter is one name or a list, and not other filters', async () => {
    const lzwOf = async (dictionary: string, claim: string | null = '2') =>
      details(await checkPdfA(build({ claim, content: inline(dictionary) })), 'streams');
    expect(await lzwOf('/W 1 /H 1 /BPC 8 /CS /G /F /LZW')).toEqual(['LZW inline image']);
    expect(await lzwOf('/W 1 /H 1 /BPC 8 /CS /G /Filter /LZWDecode')).toEqual(['LZW inline image']);
    expect(await lzwOf('/W 1 /H 1 /BPC 8 /CS /G /F [/AHx /LZW]')).toEqual(['LZW inline image']);
    expect(await lzwOf('/W 1 /H 1 /BPC 8 /CS /G /F [/AHx 7]')).toEqual([]);
    expect(await lzwOf('/W 1 /H 1 /BPC 8 /CS /G /F /AHx')).toEqual([]);
    expect(await lzwOf('/W 1 /H 1 /BPC 8 /CS /G')).toEqual([]);
  });
});

describe('form XObjects', () => {
  const form = (doc: PDFDocument, content: string, extra: Record<string, unknown> = {}) =>
    doc.addStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10], ...extra } as never);
  const useForm = async (
    make: (doc: PDFDocument) => PDFObject,
    options: Partial<Build> = {},
    part?: 1 | 2 | 3,
  ) =>
    checkPdfA(
      build({
        claim: null,
        content: '/Fm Do',
        ...options,
        resources: (doc) => ({ XObject: { Fm: make(doc) } }),
      }),
      part === undefined ? {} : { part },
    );

  it('reads the content of a form XObject, which starts without a known colour', async () => {
    const painted = await useForm((doc) => form(doc, '0 0 0 1 k 0 0 5 5 re f'));
    expect(details(painted, 'device-colour')).toEqual(['DeviceCMYK']);
    const unset = await useForm((doc) => form(doc, '0 0 5 5 re f'));
    expect(details(unset, 'device-colour')).toEqual([]);
  });

  it('resolves a form’s names through its own resources, or through the page’s when it has none', async () => {
    const spaces = { ColorSpace: { Cs: 'DeviceCMYK' } };
    const inherited = await checkPdfA(
      build({
        claim: null,
        content: '/Fm Do',
        resources: (doc) => ({ ...spaces, XObject: { Fm: form(doc, '/Cs cs 0 0 5 5 re f') } }),
      }),
    );
    expect(details(inherited, 'device-colour')).toEqual(['DeviceCMYK']);
    const own = await checkPdfA(
      build({
        claim: null,
        content: '/Fm Do',
        resources: (doc) => ({
          ...spaces,
          XObject: {
            Fm: form(doc, '/Cs cs 0 0 5 5 re f', { Resources: { ColorSpace: { Cs: 'DeviceRGB' } } }),
          },
        }),
      }),
    );
    expect(details(own, 'device-colour')).toEqual(['DeviceRGB']);
  });

  it('names a PostScript XObject, whether by subtype or by a /PS entry, and does not read its content', async () => {
    const bySubtype = await useForm((doc) =>
      doc.addStream('0 0 0 1 k 0 0 5 5 re f', { Type: 'XObject', Subtype: 'PS' } as never),
    );
    expect(details(bySubtype, 'graphics-state')).toEqual(['PostScript XObject']);
    expect(details(bySubtype, 'device-colour')).toEqual([]);
    const byEntry = await useForm((doc) => form(doc, '0 0 0 1 k 0 0 5 5 re f', { PS: doc.newString('x') }));
    expect(details(byEntry, 'graphics-state')).toEqual(['PostScript XObject']);
  });

  it('names /Ref, /OPI and, in part 1, a transparency group', async () => {
    const report = await useForm(
      (doc) =>
        form(doc, '', {
          Ref: { F: doc.newString('other.pdf'), Page: 0 },
          OPI: {},
          Group: { S: 'Transparency' },
        }),
      {},
      1,
    );
    expect(details(report, 'graphics-state')).toEqual(['/Ref', '/OPI']);
    expect(details(report, 'transparency')).toEqual(['transparency group']);
    const later = await useForm((doc) => form(doc, '', { Group: { S: 'Transparency' } }), {}, 2);
    expect(details(later, 'transparency')).toEqual([]);
    const otherGroup = await useForm((doc) => form(doc, '', { Group: { S: 'Other' } }), {}, 1);
    expect(details(otherGroup, 'transparency')).toEqual([]);
  });

  it('names an LZW form besides the stream rule that finds the same bytes', async () => {
    const report = await useForm((doc) =>
      doc.addRawStream(new Uint8Array([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 10, 10],
        Filter: 'LZWDecode',
      } as never),
    );
    expect(details(report, 'streams')).toEqual([expect.stringMatching(/^object \d+: LZW$/), 'LZW form']);
  });

  it('reads a form that paints itself once and stops at the depth limit', async () => {
    const selfReferencing = await checkPdfA(
      build({
        claim: null,
        content: '/Fm Do',
        resources: (doc) => {
          const self = doc.newDictionary();
          const stream = form(doc, '0 0 0 1 k 0 0 5 5 re f /Fm Do', { Resources: { XObject: { Fm: self } } });
          self.put('Fm', stream);
          const resources = doc.newDictionary();
          resources.put('Fm', stream);
          stream.get('Resources').put('XObject', self);
          return { XObject: resources };
        },
      }),
    );
    expect(details(selfReferencing, 'device-colour')).toEqual(['DeviceCMYK']);

    // A chain of forms: the colour is found at depth 5 and missed beyond 24 levels.
    const chain = async (length: number) =>
      details(
        await checkPdfA(
          build({
            claim: null,
            content: '/Fm Do',
            resources: (doc) => {
              let inner = form(doc, '0 0 0 1 k 0 0 5 5 re f');
              for (let level = 1; level < length; level += 1) {
                inner = form(doc, '/Fm Do', { Resources: { XObject: { Fm: inner } } });
              }
              return { XObject: { Fm: inner } };
            },
          }),
        ),
        'device-colour',
      );
    expect(await chain(5)).toEqual(['DeviceCMYK']);
    expect(await chain(24)).toEqual(['DeviceCMYK']);
    expect(await chain(26)).toEqual([]);
  });

  it('reports the colour, fonts, transparency, images and graphics-state rules unchecked when a stream cannot be read', async () => {
    const report = await useForm((doc) =>
      doc.addRawStream(new Uint8Array([1, 2, 3]), {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 10, 10],
        ...UNDECODABLE,
      } as never),
    );
    expect(report.unchecked).toEqual(['device-colour', 'transparency', 'fonts', 'images', 'graphics-state']);
    // A form that is a dictionary and not a stream cannot be read either, even when direct.
    const direct = await checkPdfA(
      build({
        claim: null,
        content: '/Fm Do',
        resources: () => ({ XObject: { Fm: { Subtype: 'Form' } } }),
      }),
    );
    expect(direct.unchecked).toEqual(['device-colour', 'transparency', 'fonts', 'images', 'graphics-state']);
  });

  it('reports the same set unchecked when the content budget is spent', async () => {
    const report = await checkPdfA(build({ content: '0 g 0 0 5 5 re f' }), { contentBudget: 4 });
    expect(report.unchecked).toEqual(['device-colour', 'transparency', 'fonts', 'images', 'graphics-state']);
    const enough = await checkPdfA(build({ content: '0 g 0 0 5 5 re f' }), { contentBudget: 1000 });
    expect(enough.unchecked).toEqual([]);
  });
});

describe('patterns', () => {
  const tiling = (doc: PDFDocument, content: string, extra: Record<string, unknown> = {}) =>
    doc.addStream(content, {
      Type: 'Pattern',
      PatternType: 1,
      PaintType: 1,
      TilingType: 1,
      BBox: [0, 0, 5, 5],
      XStep: 5,
      YStep: 5,
      ...extra,
    } as never);
  const patterned = async (
    patterns: (doc: PDFDocument) => Record<string, unknown>,
    content: string,
    claim: string | null = null,
  ) => checkPdfA(build({ claim, content, resources: (doc) => ({ Pattern: patterns(doc) }) }));

  it('reads the content of a tiling pattern for device colour, once', async () => {
    const report = await patterned(
      (doc) => ({ P: tiling(doc, '0 0 0 1 k 0 0 2 2 re f') }),
      '/Pattern cs /P scn 0 0 5 5 re f /P scn 0 0 5 5 re f /P SCN',
    );
    expect(details(report, 'device-colour')).toEqual(['DeviceCMYK']);
  });

  it('gives a tiling pattern its own resources, or the page’s', async () => {
    const own = await patterned(
      (doc) => ({
        P: tiling(doc, '/Cs cs 0 0 2 2 re f', { Resources: { ColorSpace: { Cs: 'DeviceRGB' } } }),
      }),
      '/P scn',
    );
    expect(details(own, 'device-colour')).toEqual(['DeviceRGB']);
    const inherited = await checkPdfA(
      build({
        claim: null,
        content: '/P scn',
        resources: (doc) => ({
          ColorSpace: { Cs: 'DeviceCMYK' },
          Pattern: { P: tiling(doc, '/Cs cs 0 0 2 2 re f') },
        }),
      }),
    );
    expect(details(inherited, 'device-colour')).toEqual(['DeviceCMYK']);
  });

  it('reads a shading pattern’s colour space and its graphics state', async () => {
    const shading = (doc: PDFDocument, extra: Record<string, unknown> = {}) =>
      doc.addObject({
        PatternType: 2,
        Shading: { ShadingType: 2, ColorSpace: 'DeviceCMYK' },
        ...extra,
      } as never);
    const colour = await patterned((doc) => ({ P: shading(doc) }), '/P scn');
    expect(details(colour, 'device-colour')).toEqual(['DeviceCMYK']);

    const state = await patterned(
      (doc) => ({ P: shading(doc, { ExtGState: { ca: 0.5, TR: 'Identity' } }) }),
      '/P scn',
      '1',
    );
    expect(details(state, 'transparency')).toEqual(['/ca 0.5']);
    expect(details(state, 'graphics-state')).toEqual(['/TR']);

    const bare = await patterned((doc) => ({ P: doc.addObject({ PatternType: 2 } as never) }), '/P scn');
    expect(details(bare, 'device-colour')).toEqual([]);
  });

  it('ignores a pattern operand it cannot use', async () => {
    const report = await patterned(
      (doc) => ({
        Dict: doc.addObject({ PatternType: 1 } as never),
        Direct: { PatternType: 1 },
        Cmyk: tiling(doc, '0 0 0 1 k 0 0 2 2 re f'),
      }),
      '/Missing scn 0.5 scn scn /Dict scn /Direct scn /Cmyk SCN',
    );
    // Only the last is a readable pattern; the others neither throw nor report.
    expect(details(report, 'device-colour')).toEqual(['DeviceCMYK']);
    const none = await patterned(
      (doc) => ({ Dict: doc.addObject({ PatternType: 1 } as never) }),
      '/Dict scn 0 0 5 5 re f',
      '2',
    );
    expect(none.unchecked).toEqual([]);
  });
});

describe('fonts', () => {
  const TEXT = 'BT /F 12 Tf 10 100 Td (Hello) Tj ET';
  const descriptor = (doc: PDFDocument, extra: Record<string, unknown> = {}) =>
    doc.addObject({
      Type: 'FontDescriptor',
      FontName: 'Test',
      Flags: 32,
      ...extra,
    } as never);
  const program = (doc: PDFDocument) => doc.addStream(new Uint8Array(4), {});
  const fontsOf = async (
    font: (doc: PDFDocument) => unknown,
    options: { content?: string; claim?: string } = {},
  ) => {
    const report = await checkPdfA(
      build({
        claim: options.claim ?? '2',
        content: options.content ?? TEXT,
        resources: (doc) => ({ Font: { F: font(doc) } }),
      }),
    );
    return details(report, 'fonts');
  };
  const simple = (doc: PDFDocument, base: string, extra: Record<string, unknown> = {}) =>
    ({ Type: 'Font', Subtype: 'Type1', BaseFont: base, FontDescriptor: descriptor(doc, extra) }) as const;

  it('accepts a simple font whose descriptor carries any of the three font programs', async () => {
    for (const key of ['FontFile', 'FontFile2', 'FontFile3']) {
      expect(
        await fontsOf((doc) => doc.addObject(simple(doc, 'Plain', { [key]: program(doc) }) as never)),
      ).toEqual([]);
    }
    expect(await fontsOf((doc) => doc.addObject(simple(doc, 'Bare') as never))).toEqual(['Bare']);
    expect(
      await fontsOf((doc) =>
        doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'NoDescriptor' } as never),
      ),
    ).toEqual(['NoDescriptor']);
    expect(await fontsOf((doc) => doc.addObject({ Type: 'Font', Subtype: 'Type1' } as never))).toEqual([
      '(unnamed)',
    ]);
  });

  it('does not judge a Type 3 font, or a font entry that is not a dictionary', async () => {
    expect(
      await fontsOf((doc) =>
        doc.addObject({ Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 1, 1] } as never),
      ),
    ).toEqual([]);
    expect(await fontsOf(() => 5)).toEqual([]);
  });

  it('judges a Type 0 font by its descendant: present, with a descriptor, with a program', async () => {
    const type0 = (doc: PDFDocument, descendants: unknown, base = 'Composite') =>
      doc.addObject({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: base,
        Encoding: 'Identity-H',
        DescendantFonts: descendants,
      } as never);
    const cid = (doc: PDFDocument, extra: Record<string, unknown> = {}, subtype = 'CIDFontType2') =>
      doc.addObject({ Type: 'Font', Subtype: subtype, BaseFont: 'Composite', ...extra } as never);

    expect(await fontsOf((doc) => type0(doc, []))).toEqual(['Composite']);
    expect(await fontsOf((doc) => type0(doc, [5]))).toEqual(['Composite']);
    expect(await fontsOf((doc) => type0(doc, [cid(doc)]))).toEqual(['Composite']);
    expect(await fontsOf((doc) => type0(doc, [cid(doc, { FontDescriptor: descriptor(doc) })]))).toEqual([
      'Composite',
    ]);
    expect(
      await fontsOf((doc) =>
        type0(doc, [
          cid(doc, { FontDescriptor: descriptor(doc, { FontFile2: program(doc) }), CIDToGIDMap: 'Identity' }),
        ]),
      ),
    ).toEqual([]);
  });

  it('wants a CIDFontType2 with an embedded TrueType program to carry /CIDToGIDMap', async () => {
    const make = (doc: PDFDocument, extra: Record<string, unknown>, subtype = 'CIDFontType2') =>
      doc.addObject({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: 'Composite',
        Encoding: 'Identity-H',
        DescendantFonts: [
          doc.addObject({
            Type: 'Font',
            Subtype: subtype,
            BaseFont: 'Composite',
            FontDescriptor: descriptor(doc, extra),
          } as never),
        ],
      } as never);
    expect(await fontsOf((doc) => make(doc, { FontFile2: program(doc) }))).toEqual([
      'Composite: no /CIDToGIDMap',
    ]);
    // CFF-based CID fonts and programs that are not FontFile2 do not need the map.
    expect(await fontsOf((doc) => make(doc, { FontFile3: program(doc) }, 'CIDFontType0'))).toEqual([]);
    expect(await fontsOf((doc) => make(doc, { FontFile3: program(doc) }))).toEqual([]);
  });

  it('wants part 1 subsets to list their glyphs: /CIDSet for CID fonts, /CharSet for Type 1', async () => {
    const cidFont = (doc: PDFDocument, base: string, extra: Record<string, unknown>) =>
      doc.addObject({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: base,
        Encoding: 'Identity-H',
        DescendantFonts: [
          doc.addObject({
            Type: 'Font',
            Subtype: 'CIDFontType0',
            BaseFont: base,
            FontDescriptor: descriptor(doc, { FontFile3: program(doc), ...extra }),
          } as never),
        ],
      } as never);
    const one = (font: (doc: PDFDocument) => unknown) => fontsOf(font, { claim: '1' });
    expect(await one((doc) => cidFont(doc, 'ABCDEF+Sub', {}))).toEqual(['ABCDEF+Sub: no /CIDSet']);
    expect(await one((doc) => cidFont(doc, 'ABCDEF+Sub', { CIDSet: program(doc) }))).toEqual([]);
    expect(await one((doc) => cidFont(doc, 'Whole', {}))).toEqual([]);
    expect(await fontsOf((doc) => cidFont(doc, 'ABCDEF+Sub', {}))).toEqual([]);

    const type1 = (doc: PDFDocument, base: string, extra: Record<string, unknown>, subtype = 'Type1') =>
      doc.addObject({
        ...simple(doc, base, { FontFile: program(doc), ...extra }),
        Subtype: subtype,
      } as never);
    expect(await one((doc) => type1(doc, 'ABCDEF+Sub', {}))).toEqual(['ABCDEF+Sub: no /CharSet']);
    expect(await one((doc) => type1(doc, 'ABCDEF+Sub', { CharSet: doc.newString('/a') }))).toEqual([]);
    expect(await one((doc) => type1(doc, 'Whole', {}))).toEqual([]);
    expect(await one((doc) => type1(doc, 'ABCDEF+Sub', {}, 'TrueType'))).toEqual([]);
    expect(await fontsOf((doc) => type1(doc, 'ABCDEF+Sub', {}))).toEqual([]);
  });

  it('judges a font used only by invisible text in part 1, not in parts 2 and 3, and once however often it is used', async () => {
    const bare = (doc: PDFDocument) => doc.addObject(simple(doc, 'Ocr') as never);
    const hidden = 'BT /F 12 Tf 3 Tr (a) Tj ET';
    expect(await fontsOf(bare, { content: hidden })).toEqual([]);
    expect(await fontsOf(bare, { content: hidden, claim: '1' })).toEqual(['Ocr']);
    // Visible use after an invisible one, and the other way round, makes it judged.
    expect(await fontsOf(bare, { content: `${hidden} BT /F 12 Tf 0 Tr (a) Tj ET` })).toEqual(['Ocr']);
    expect(await fontsOf(bare, { content: 'BT /F 12 Tf (a) Tj 3 Tr (a) Tj ET (a) Tj BT (b) Tj ET' })).toEqual(
      ['Ocr'],
    );
  });

  it('keys a font that is a direct dictionary by where it is used, and ignores text with no font or an unknown one', async () => {
    expect(
      await fontsOf(() => ({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Direct' }), {
        content: `${TEXT} ${TEXT}`,
      }),
    ).toEqual(['Direct']);
    expect(await fontsOf(() => 5, { content: 'BT (a) Tj /Nope 12 Tf (a) Tj ET' })).toEqual([]);
  });
});

describe('actions', () => {
  const open = (action: (doc: PDFDocument) => unknown) => ({
    catalog: (doc: PDFDocument, root: PDFObject) => root.put('OpenAction', action(doc) as never),
  });
  const actionsOf = async (action: (doc: PDFDocument) => unknown, part?: 1 | 2 | 3) =>
    rule(await checkPdfA(build(open(action)), part === undefined ? {} : { part }), 'actions');

  it.each([
    'Launch',
    'Sound',
    'Movie',
    'ResetForm',
    'ImportData',
    'Hide',
    'SetOCGState',
    'Rendition',
    'Trans',
    'GoTo3DView',
    'JavaScript',
    'SetState',
    'NoOp',
  ])('names a %s action', async (type) => {
    const result = await actionsOf((doc) => doc.addObject({ S: type } as never));
    expect(result?.samples).toEqual([{ detail: type }]);
  });

  it('allows the four page-navigation named actions and names any other, with or without an /N', async () => {
    for (const name of ['NextPage', 'PrevPage', 'FirstPage', 'LastPage']) {
      expect((await actionsOf((doc) => doc.addObject({ S: 'Named', N: name } as never)))?.count).toBe(0);
    }
    expect((await actionsOf((doc) => doc.addObject({ S: 'Named', N: 'Print' } as never)))?.samples).toEqual([
      { detail: 'Named Print' },
    ]);
    expect((await actionsOf((doc) => doc.addObject({ S: 'Named' } as never)))?.samples).toEqual([
      { detail: 'Named ?' },
    ]);
  });

  it('allows navigation actions and ignores a destination array, a non-dictionary and an action with no type', async () => {
    expect((await actionsOf((doc) => doc.addObject({ S: 'GoTo', D: [0, 'Fit'] } as never)))?.count).toBe(0);
    expect(
      (await actionsOf((doc) => doc.addObject({ S: 'URI', URI: doc.newString('https://x.test') } as never)))
        ?.count,
    ).toBe(0);
    expect((await actionsOf(() => [0, 'Fit']))?.count).toBe(0);
    expect((await actionsOf(() => 'Fit'))?.count).toBe(0);
    expect((await actionsOf((doc) => doc.addObject({ Type: 'Action' } as never)))?.count).toBe(0);
  });

  it('follows /Next, a single action or a list, and stops after 16 links', async () => {
    const chain = (doc: PDFDocument, links: number, type: string, array = false): unknown => {
      let next: unknown = doc.addObject({ S: type } as never);
      for (let link = 0; link < links; link += 1) {
        next = doc.addObject({ S: 'GoTo', Next: array ? [next] : next } as never);
      }
      return next;
    };
    expect((await actionsOf((doc) => chain(doc, 3, 'Launch')))?.samples).toEqual([{ detail: 'Launch' }]);
    expect((await actionsOf((doc) => chain(doc, 3, 'Launch', true)))?.samples).toEqual([
      { detail: 'Launch' },
    ]);
    expect((await actionsOf((doc) => chain(doc, 16, 'Launch')))?.count).toBe(1);
    expect((await actionsOf((doc) => chain(doc, 17, 'Launch')))?.count).toBe(0);
  });

  it('names the page an annotation action sits on and the catalog-level triggers', async () => {
    const link = await checkPdfA(
      build({
        page: (doc, page) =>
          page.put('Annots', [
            doc.addObject({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [0, 0, 10, 10],
              F: 4,
              A: { S: 'Launch' },
            } as never),
          ]),
      }),
    );
    expect(rule(link, 'actions')?.samples).toEqual([{ pageIndex: 0, detail: 'Launch' }]);

    const aa = await checkPdfA(
      build({ catalog: (_doc, root) => root.put('AA', { WC: { S: 'GoTo' } } as never) }),
    );
    expect(details(aa, 'actions')).toEqual(['the catalog has /AA']);
  });

  it('names a page /AA in part 1 only', async () => {
    const page = (_doc: PDFDocument, entry: PDFObject) => entry.put('AA', { O: { S: 'GoTo' } } as never);
    expect(details(await checkPdfA(build({ claim: '1', page })), 'actions')).toEqual(['page /AA']);
    expect(details(await checkPdfA(build({ claim: '2', page })), 'actions')).toEqual([]);
  });

  it('reads the actions of outline items, following /First and /Next, once each', async () => {
    const report = await checkPdfA(
      build({
        catalog: (doc, root) => {
          const nested = doc.addObject({ Title: doc.newString('c'), A: { S: 'Sound' } } as never);
          const second = doc.addObject({ Title: doc.newString('b'), A: { S: 'Movie' } } as never);
          const first = doc.addObject({
            Title: doc.newString('a'),
            A: { S: 'Launch' },
            First: nested,
            Next: second,
          } as never);
          // A cycle back to the first item must not loop.
          second.put('Next', first);
          nested.put('Next', nested);
          root.put('Outlines', doc.addObject({ Type: 'Outlines', First: first } as never));
        },
      }),
    );
    expect(new Set(details(report, 'actions'))).toEqual(new Set(['Launch', 'Movie', 'Sound']));
    expect(rule(report, 'actions')?.count).toBe(3);
  });

  it('ignores outline entries that are not dictionaries, and an outline with no items', async () => {
    const report = await checkPdfA(
      build({
        catalog: (doc, root) => {
          const odd = doc.addObject({ Title: doc.newString('odd'), A: { S: 'Launch' } } as never);
          odd.put('Next', 5 as never);
          root.put('Outlines', doc.addObject({ Type: 'Outlines', First: odd } as never));
        },
      }),
    );
    expect(details(report, 'actions')).toEqual(['Launch']);
    const empty = await checkPdfA(
      build({ catalog: (doc, root) => root.put('Outlines', doc.addObject({ Type: 'Outlines' } as never)) }),
    );
    expect(rule(empty, 'actions')?.count).toBe(0);
    const direct = await checkPdfA(
      build({
        catalog: (doc, root) => root.put('Outlines', doc.addObject({ Type: 'Outlines', First: 5 } as never)),
      }),
    );
    expect(rule(direct, 'actions')?.count).toBe(0);
  });

  it('stops reading an outline after 100,000 steps', async () => {
    const report = await checkPdfA(
      build({
        catalog: (doc, root) => {
          const items = 50_100;
          let next: PDFObject | null = null;
          for (let index = items - 1; index >= 0; index -= 1) {
            const entry: Record<string, unknown> = { Title: doc.newString(String(index)) };
            // The first item's action is reached; the last one's is past the step limit.
            if (index === 0 || index === items - 1) entry.A = { S: 'Launch' };
            if (next !== null) entry.Next = next;
            next = doc.addObject(entry as never);
          }
          root.put('Outlines', doc.addObject({ Type: 'Outlines', First: next } as never));
        },
      }),
    );
    expect(rule(report, 'actions')?.count).toBe(1);
  });

  it('names script in the JavaScript name tree even when no action runs it', async () => {
    const report = await checkPdfA(
      build({
        catalog: (doc, root) =>
          root.put(
            'Names',
            doc.addObject({
              JavaScript: doc.addObject({
                Names: [
                  doc.newString('init'),
                  doc.addObject({ S: 'JavaScript', JS: doc.newString('1') } as never),
                ],
              }),
            } as never),
          ),
      }),
    );
    expect(details(report, 'actions')).toEqual(['JavaScript: init']);
  });
});

describe('annotations', () => {
  const annotated = async (
    annotations: (doc: PDFDocument) => Record<string, unknown>[],
    options: { claim?: string | null; part?: 1 | 2 | 3 } = {},
  ) => {
    const claim = options.claim ?? '2';
    const report = await checkPdfA(
      build({
        claim,
        page: (doc, page) =>
          page.put(
            'Annots',
            annotations(doc).map((annotation) => doc.addObject(annotation as never)),
          ),
      }),
      options.part === undefined ? {} : { part: options.part },
    );
    return report;
  };
  const stampLike =
    (extra: Record<string, unknown> = {}) =>
    (doc: PDFDocument) => [
      {
        Type: 'Annot',
        Subtype: 'Stamp',
        Rect: [0, 0, 10, 10],
        F: 4,
        AP: { N: doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }) },
        ...extra,
      },
    ];

  it('accepts a printable annotation with a normal appearance', async () => {
    expect(rule(await annotated(stampLike()), 'annotations')?.count).toBe(0);
  });

  it('names a subtype the part forbids: file attachments in part 1 only, sound and movies in all', async () => {
    const attachment = stampLike({ Subtype: 'FileAttachment' });
    expect(details(await annotated(attachment, { claim: '1' }), 'annotations')).toEqual(['FileAttachment']);
    expect(details(await annotated(attachment, { claim: '2' }), 'annotations')).toEqual([]);
    for (const part of [1, 2, 3] as const) {
      expect(
        details(await annotated(stampLike({ Subtype: 'Sound' }), { claim: String(part) }), 'annotations'),
      ).toEqual(['Sound']);
    }
  });

  it('wants the Print flag set and the Invisible, Hidden and NoView flags clear, except on a popup', async () => {
    const flags = async (value: number | null, subtype = 'Stamp') =>
      details(await annotated(stampLike({ Subtype: subtype, F: value ?? undefined })), 'annotations');
    expect(await flags(4)).toEqual([]);
    expect(await flags(null)).toEqual(['Stamp: no /F']);
    expect(await flags(0)).toEqual(['Stamp: flags 0']);
    expect(await flags(5)).toEqual(['Stamp: flags 5']);
    expect(await flags(6)).toEqual(['Stamp: flags 6']);
    expect(await flags(36)).toEqual(['Stamp: flags 36']);
    expect(await flags(0, 'Popup')).toEqual([]);
    expect(await flags(null, 'Popup')).toEqual([]);
  });

  it('wants an appearance stream unless the rectangle is empty or the annotation is a link or a popup', async () => {
    const appearance = async (extra: Record<string, unknown>) =>
      details(
        await annotated(() => [{ Type: 'Annot', Subtype: 'Stamp', Rect: [0, 0, 10, 10], F: 4, ...extra }]),
        'annotations',
      );
    expect(await appearance({})).toEqual(['Stamp: no appearance stream']);
    expect(await appearance({ AP: {} })).toEqual(['Stamp: no appearance stream']);
    expect(await appearance({ Rect: [5, 5, 5, 5] })).toEqual([]);
    expect(await appearance({ Rect: ['a', 'b', 'c', 'd'] })).toEqual([]);
    expect(await appearance({ Rect: [0, 0, 10] })).toEqual(['Stamp: no appearance stream']);
    expect(await appearance({ Subtype: 'Link' })).toEqual([]);
    expect(await appearance({ Subtype: 'Popup' })).toEqual([]);
    expect(await appearance({ Subtype: undefined })).toEqual(['?: no appearance stream']);
  });

  it('names the extra appearance dictionaries part 1 does not allow', async () => {
    const withExtra = (keys: string[]) => (doc: PDFDocument) => {
      const stream = doc.addStream('', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] });
      return [
        {
          Type: 'Annot',
          Subtype: 'Stamp',
          Rect: [0, 0, 10, 10],
          F: 4,
          AP: { N: stream, ...Object.fromEntries(keys.map((key) => [key, stream])) },
        },
      ];
    };
    expect(details(await annotated(withExtra(['D', 'R']), { claim: '1' }), 'annotations')).toEqual([
      'Stamp: /AP /D /R',
    ]);
    expect(details(await annotated(withExtra(['D']), { claim: '2' }), 'annotations')).toEqual([]);
  });

  it('reads the appearance streams: one stream, or the states of a dictionary of them', async () => {
    const colourOfAppearance = async (normal: (doc: PDFDocument) => unknown) =>
      details(
        await checkPdfA(
          build({
            claim: null,
            content: '0 0 5 5 re n',
            page: (doc, page) =>
              page.put('Annots', [
                doc.addObject({
                  Type: 'Annot',
                  Subtype: 'Stamp',
                  Rect: [0, 0, 10, 10],
                  F: 4,
                  AP: { N: normal(doc) },
                } as never),
              ]),
          }),
        ),
        'device-colour',
      );
    const cmyk = (doc: PDFDocument) =>
      doc.addStream('0 0 0 1 k 0 0 5 5 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] });
    expect(await colourOfAppearance(cmyk)).toEqual(['DeviceCMYK']);
    expect(await colourOfAppearance((doc) => ({ On: cmyk(doc), Off: 'NotAStream' }))).toEqual(['DeviceCMYK']);
    expect(await colourOfAppearance(() => 5)).toEqual([]);
  });

  it('names a widget that has an action or an additional action', async () => {
    const widget = (extra: Record<string, unknown>) => (doc: PDFDocument) =>
      stampLike({ Subtype: 'Widget', FT: 'Tx', T: doc.newString('f'), ...extra })(doc);
    expect(details(await annotated(widget({ A: { S: 'GoTo' } })), 'forms')).toEqual([
      'a widget has /A or /AA',
    ]);
    expect(details(await annotated(widget({ AA: { E: { S: 'GoTo' } } })), 'forms')).toEqual([
      'a widget has /A or /AA',
    ]);
    expect(details(await annotated(widget({})), 'forms')).toEqual([]);
  });

  it('skips an /Annots entry that is not a dictionary or does not exist', async () => {
    const report = await checkPdfA(
      build({
        page: (doc, page) => page.put('Annots', [doc.newInteger(5), doc.newIndirect(9999)] as never),
      }),
    );
    expect(rule(report, 'annotations')?.count).toBe(0);
    const array = await checkPdfA(build({ page: (_doc, page) => page.put('Annots', [[1, 2]] as never) }));
    expect(rule(array, 'annotations')?.count).toBe(0);
  });
});

describe('interactive form', () => {
  const formOf = async (
    acroForm: (doc: PDFDocument) => Record<string, unknown>,
    claim: string | null = '2',
  ) =>
    details(
      await checkPdfA(
        build({
          claim,
          catalog: (doc, root) => root.put('AcroForm', doc.addObject(acroForm(doc) as never)),
        }),
      ),
      'forms',
    );

  it('names NeedAppearances and XFA', async () => {
    expect(await formOf(() => ({ Fields: [], NeedAppearances: true }))).toEqual(['NeedAppearances is true']);
    expect(await formOf(() => ({ Fields: [], NeedAppearances: false }))).toEqual([]);
    expect(await formOf((doc) => ({ Fields: [], XFA: [doc.newString('x'), doc.addStream('', {})] }))).toEqual(
      ['the form has XFA data'],
    );
  });

  it('names a field that has an action or an additional action, however deep in the tree', async () => {
    expect(
      await formOf((doc) => ({ Fields: [doc.addObject({ FT: 'Tx', A: { S: 'GoTo' } } as never)] })),
    ).toEqual(['a field has /A or /AA']);
    expect(
      await formOf((doc) => ({
        Fields: [
          doc.addObject({
            T: doc.newString('parent'),
            Kids: [doc.addObject({ FT: 'Tx', AA: { K: { S: 'GoTo' } } } as never)],
          } as never),
        ],
      })),
    ).toEqual(['a field has /A or /AA']);
    expect(await formOf((doc) => ({ Fields: [doc.addObject({ FT: 'Tx' } as never)] }))).toEqual([]);
  });

  it('reads direct field dictionaries, skips fields that are not dictionaries and does not loop on a cycle', async () => {
    expect(await formOf(() => ({ Fields: [{ FT: 'Tx', A: { S: 'GoTo' } }, 5] }))).toEqual([
      'a field has /A or /AA',
    ]);
    expect(
      await formOf((doc) => {
        const field = doc.addObject({ FT: 'Tx', A: { S: 'GoTo' } } as never);
        field.put('Kids', [field] as never);
        return { Fields: [field, field] };
      }),
    ).toEqual(['a field has /A or /AA']);
  });

  it('stops descending after 24 levels', async () => {
    const nest = (doc: PDFDocument, levels: number) => {
      let field = doc.addObject({ FT: 'Tx', A: { S: 'GoTo' } } as never);
      for (let level = 0; level < levels; level += 1) field = doc.addObject({ Kids: [field] } as never);
      return { Fields: [field] };
    };
    expect(await formOf((doc) => nest(doc, 24))).toEqual(['a field has /A or /AA']);
    expect(await formOf((doc) => nest(doc, 25))).toEqual([]);
  });

  it('has nothing to say about a catalog with no form', async () => {
    expect(await formOf(() => ({}))).toEqual([]);
  });
});

describe('embedded files', () => {
  const attach = (spec: (doc: PDFDocument) => unknown, name = 'a.pdf'): Pick<Build, 'catalog'> => ({
    catalog: (doc, root) =>
      root.put(
        'Names',
        doc.addObject({
          EmbeddedFiles: doc.addObject({ Names: [doc.newString(name), spec(doc)] } as never),
        } as never),
      ),
  });
  const file = (doc: PDFDocument, mime: string | null, extra: Record<string, unknown> = {}, key = 'F') =>
    doc.addObject({
      Type: 'Filespec',
      F: doc.newString('a.pdf'),
      EF: {
        [key]: doc.addStream(
          'x',
          mime === null ? { Type: 'EmbeddedFile' } : { Type: 'EmbeddedFile', Subtype: mime },
        ),
      },
      ...extra,
    } as never);
  const embeddedOf = async (spec: (doc: PDFDocument) => unknown, part: 1 | 2 | 3, name = 'a.pdf') =>
    details(await checkPdfA(build({ claim: String(part), ...attach(spec, name) })), 'embedded-files');

  it('forbids every attachment in part 1', async () => {
    expect(await embeddedOf((doc) => file(doc, 'application/pdf'), 1)).toEqual(['a.pdf']);
  });

  it('allows only PDF attachments in part 2', async () => {
    expect(await embeddedOf((doc) => file(doc, 'application/pdf'), 2)).toEqual([]);
    expect(await embeddedOf((doc) => file(doc, 'text/plain'), 2)).toEqual([
      'a.pdf: only PDF/A files may be embedded',
    ]);
    expect(await embeddedOf((doc) => file(doc, null), 2)).toEqual([
      'a.pdf: only PDF/A files may be embedded',
    ]);
    expect(await embeddedOf((doc) => doc.addObject({ Type: 'Filespec' } as never), 2)).toEqual([
      'a.pdf: only PDF/A files may be embedded',
    ]);
  });

  it('wants a valid /AFRelationship and a /Subtype on the stream in part 3, reading /UF when there is no /F', async () => {
    expect(await embeddedOf((doc) => file(doc, 'text/plain', { AFRelationship: 'Source' }), 3)).toEqual([]);
    expect(await embeddedOf((doc) => file(doc, 'text/plain', { AFRelationship: 'Data' }, 'UF'), 3)).toEqual(
      [],
    );
    expect(await embeddedOf((doc) => file(doc, 'text/plain'), 3)).toEqual([
      'a.pdf: no valid /AFRelationship',
    ]);
    expect(await embeddedOf((doc) => file(doc, 'text/plain', { AFRelationship: 'Other' }), 3)).toEqual([
      'a.pdf: no valid /AFRelationship',
    ]);
    expect(await embeddedOf((doc) => file(doc, null, { AFRelationship: 'Source' }), 3)).toEqual([
      'a.pdf: the embedded stream has no /Subtype',
    ]);
    expect(
      await embeddedOf((doc) => doc.addObject({ Type: 'Filespec', AFRelationship: 'Source' } as never), 3),
    ).toEqual(['a.pdf: the embedded stream has no /Subtype']);
  });

  it('skips a name-tree value that is not a file specification dictionary', async () => {
    expect(await embeddedOf(() => 5, 1)).toEqual([]);
    expect(await embeddedOf((doc) => doc.newIndirect(9999), 1)).toEqual([]);
  });

  it('survives a name tree MuPDF cannot walk', async () => {
    const report = await checkPdfA(
      build({
        catalog: (doc, root) => {
          const loop = doc.addObject({ Limits: [doc.newString('a'), doc.newString('z')] } as never);
          loop.put('Kids', [loop] as never);
          root.put('Names', doc.addObject({ EmbeddedFiles: loop, JavaScript: loop } as never));
        },
      }),
    );
    expect(rule(report, 'embedded-files')?.count).toBe(0);
    expect(rule(report, 'actions')?.count).toBe(0);
  });
});

describe('optional content', () => {
  const layersOf = async (
    properties: (doc: PDFDocument) => Record<string, unknown>,
    claim: string | null = '2',
  ) =>
    details(
      await checkPdfA(
        build({
          claim,
          catalog: (doc, root) => root.put('OCProperties', doc.addObject(properties(doc) as never)),
        }),
      ),
      'layers',
    );

  it('forbids optional content in part 1', async () => {
    expect(await layersOf(() => ({ OCGs: [], D: { Name: 'x' } }), '1')).toEqual(['/OCProperties']);
  });

  it('wants every configuration in parts 2 and 3 to have a /Name and no /AS', async () => {
    expect(await layersOf(() => ({ OCGs: [], D: { Name: 'x' } }))).toEqual([]);
    expect(await layersOf(() => ({ OCGs: [], D: {} }))).toEqual(['a configuration has no /Name']);
    expect(await layersOf(() => ({ OCGs: [], D: { Name: 'x', AS: [] } }))).toEqual([
      'a configuration has /AS',
    ]);
    expect(
      await layersOf((doc) => ({
        OCGs: [],
        D: { Name: 'x' },
        Configs: [doc.addObject({ AS: [] } as never), 5, { Name: 'ok' }],
      })),
    ).toEqual(['a configuration has no /Name', 'a configuration has /AS']);
    expect(await layersOf(() => ({ OCGs: [] }))).toEqual([]);
  });
});

describe('run paths', () => {
  const locked = () => build({ save: 'encrypt=aes-128,owner-password=owner,user-password=secret' });

  it('reports a file that needs a password as unreadable, with every other rule unchecked', async () => {
    const report = await checkPdfA(locked());
    expect(report.verdict).toBe('unreadable');
    expect(report.claim).toBeNull();
    expect(report.pageCount).toBe(0);
    expect(report.target).toEqual({ part: 2, conformance: 'B' });
    expect(failed(report)).toEqual(['encryption']);
    expect(report.unchecked).toEqual(PDFA_RULE_IDS.filter((id) => id !== 'encryption' && id !== 'xmp-info'));
    expect(rule(report, 'xmp-info')?.state).toBe('na');
    expect(report.violations).toBe(1);
    const part1 = await checkPdfA(locked(), { part: 1 });
    expect(part1.target.part).toBe(1);
    expect(part1.unchecked).toEqual(PDFA_RULE_IDS.filter((id) => id !== 'encryption'));
  });

  it('rejects at once when the signal is already aborted, and between pages when it aborts during the run', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(checkPdfA(build(), {}, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' });

    // `aborted` is read once on entry, once per page, and once per content stream a form adds.
    const abortAfter = (reads: number) => {
      const controller = new AbortController();
      let count = 0;
      Object.defineProperty(controller.signal, 'aborted', { get: () => ++count > reads });
      return { signal: controller.signal, count: () => count };
    };
    const twoPages = (() => {
      const doc = new mupdf.PDFDocument();
      for (let index = 0; index < 2; index += 1)
        doc.insertPage(index, doc.addPage([0, 0, 50, 50], 0, {}, '0 g 0 0 5 5 re f'));
      return new Uint8Array(doc.saveToBuffer('').asUint8Array());
    })();
    const betweenPages = abortAfter(2);
    await expect(checkPdfA(twoPages, {}, betweenPages.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(betweenPages.count()).toBe(3);

    const withForm = build({
      content: '/Fm Do',
      resources: (doc) => ({
        XObject: {
          Fm: doc.addStream('0 g 0 0 5 5 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 10, 10] }),
        },
      }),
    });
    const insideForm = abortAfter(2);
    await expect(checkPdfA(withForm, {}, insideForm.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(insideForm.count()).toBe(3);
    const finished = abortAfter(100);
    expect((await checkPdfA(withForm, {}, finished.signal)).verdict).toBe('claims-and-meets');
  });

  it('turns an engine failure while walking the page tree into a ToolError', async () => {
    const bytes = build({
      page: (doc) => {
        const pages = doc.getTrailer().get('Root').get('Pages');
        pages.put('Count', 2);
        pages.put('Kids', [doc.newIndirect(9999)] as never);
      },
    });
    await expect(checkPdfA(bytes)).rejects.toMatchObject({
      name: 'ToolError',
      code: 'internal',
      details: { engine: 'mupdf', engineMessage: expect.stringMatching(/^pdfa check: /) },
    });
  });

  it('reads a page whose content is a list: skipping entries that are not streams and counting unreadable ones', async () => {
    const listed = await checkPdfA(
      build({
        claim: null,
        content: '',
        page: (doc, page) =>
          page.put('Contents', [
            doc.addStream('1 0 0 rg', {}),
            doc.newInteger(5),
            doc.addStream('0 0 5 5 re f', {}),
          ] as never),
      }),
    );
    // The colour set in the first stream is the one the second paints with.
    expect(details(listed, 'device-colour')).toEqual(['DeviceRGB']);

    const broken = await checkPdfA(
      build({
        content: '',
        page: (doc, page) =>
          page.put('Contents', [
            doc.addRawStream(new Uint8Array([1, 2, 3]), UNDECODABLE as never),
            doc.addStream('0 g 0 0 5 5 re f', {}),
          ] as never),
      }),
    );
    expect(broken.unchecked).toEqual(['device-colour', 'transparency', 'fonts', 'images', 'graphics-state']);

    const unreadableOnly = await checkPdfA(
      build({
        content: '',
        page: (doc, page) =>
          page.put('Contents', doc.addRawStream(new Uint8Array([1, 2, 3]), UNDECODABLE as never)),
      }),
    );
    expect(unreadableOnly.unchecked).toContain('device-colour');
  });

  it('takes resources from the page tree when the page has none, and none when they are not a dictionary', async () => {
    const inherited = await checkPdfA(
      build({
        claim: null,
        content: '/Cs cs 0 0 5 5 re f',
        page: (doc, page) => {
          page.delete('Resources');
          doc
            .getTrailer()
            .get('Root')
            .get('Pages')
            .put('Resources', { ColorSpace: { Cs: 'DeviceCMYK' } } as never);
        },
      }),
    );
    expect(details(inherited, 'device-colour')).toEqual(['DeviceCMYK']);
    const none = await checkPdfA(
      build({
        claim: null,
        content: '/Cs cs 0 0 5 5 re f 0 0 0 1 k /Fm Do /F 1 Tf (a) Tj',
        page: (_doc, page) => page.delete('Resources'),
      }),
    );
    expect(details(none, 'device-colour')).toEqual(['DeviceCMYK']);
    const notDictionary = await checkPdfA(
      build({
        claim: null,
        content: '/Cs cs 0 0 5 5 re f',
        page: (_doc, page) => page.put('Resources', 5 as never),
      }),
    );
    expect(details(notDictionary, 'device-colour')).toEqual([]);
  });

  it('reads a packet that is well formed but carries no pdfaid as no claim, and keeps the default target', async () => {
    const packet = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const report = await checkPdfA(build({ packet }));
    expect(report.verdict).toBe('no-claim');
    expect(report.claim).toBeNull();
    expect(details(report, 'xmp-claim')).toEqual(['no pdfaid:part']);
  });

  it('does not fail on objects MuPDF cannot load while scanning every object', async () => {
    const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const objects = [
      '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n',
      '2 0 obj\n<</Type/Pages/Count 1/Kids[3 0 R]>>\nendobj\n',
      '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>\nendobj\n',
      '4 0 obj\n<</Length 99999999>>\nstream\nabc\nendstream\nendobj\n',
      '5 0 obj\n<< /Broken [ >>\nendobj\n',
      '6 0 obj\n@@@ junk ))) \nendobj\n',
    ];
    let body = header;
    const offsets: number[] = [];
    for (const object of objects) {
      offsets.push(body.length);
      body += object;
    }
    const entries = [
      '0000000000 65535 f \n',
      ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    ].join('');
    const file = `${body}xref\n0 ${objects.length + 1}\n${entries}trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${body.length}\n%%EOF\n`;
    const report = await checkPdfA(fromLatin1(file));
    expect(rule(report, 'streams')?.state).toBe('pass');
  });
});

describe('summariseViolations', () => {
  it('lists each failed rule with its count and the first sample’s detail, and leaves passing rules out', async () => {
    const report = await checkPdfA(build({ claim: null }));
    expect(summariseViolations(report)).toBe(
      'trailer×1 (no /ID in the trailer); xmp×1 (the catalog has no /Metadata stream); xmp-claim×1 (no pdfaid:part); device-colour×1 (DeviceRGB)',
    );
    expect(summariseViolations(await checkPdfA(build()))).toBe('');
  });

  it('writes a rule whose first sample has no detail as just its id and count', async () => {
    const report = await checkPdfA(build());
    const noDetail: PdfACheckReport = {
      ...report,
      rules: report.rules.map((entry) =>
        entry.id === 'fonts'
          ? { ...entry, state: 'fail', count: 2, samples: [{ pageIndex: 3 }, { detail: 'x' }] }
          : entry,
      ),
    };
    expect(summariseViolations(noDetail)).toBe('fonts×2');
  });
});
