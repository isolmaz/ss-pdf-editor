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

const xmp = (part: string, extra = '', declarations = ''): string =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"${declarations}><pdfaid:part>${part}</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>${extra}</rdf:Description>
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
      doc.addStream(xmp(options.claim ?? '2', options.xmpExtra, options.xmpDeclarations), {
        Type: 'Metadata',
        Subtype: 'XML',
      }),
    );
    root.put('OutputIntents', [
      doc.addObject({
        Type: 'OutputIntent',
        S: 'GTS_PDFA1',
        OutputConditionIdentifier: doc.newString('sRGB'),
        DestOutputProfile: doc.addStream(options.profile ?? profileBytes(), {
          N: options.profileComponents ?? 3,
        }),
      }),
    ]);
    doc.getTrailer().put('ID', [doc.newString('0123456789abcdef'), doc.newString('0123456789abcdef')]);
  }
  options.catalog?.(doc, root);
  const bytes = new Uint8Array(doc.saveToBuffer(options.save ?? '').asUint8Array());
  doc.destroy();
  return bytes;
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
