/**
 * The XMP reader the PDF/A checker depends on: the `pdfaid` claim in both RDF shapes, list
 * properties, schemas the packet does not describe, and a packet that is not XML.
 */

import { describe, expect, it } from 'vitest';
import { NS_DC, NS_PDF, parseXmp, xmpList, xmpText } from './pdfa-xmp';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const wrap = (attributes: string, body: string): string =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" ${attributes}>${body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

describe('parseXmp', () => {
  it('reads the claim from child elements and from attributes alike', () => {
    const elements = parseXmp(
      encode(
        wrap(
          'xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"',
          '<pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>',
        ),
      ),
    );
    expect(elements.wellFormed).toBe(true);
    expect(elements.claim).toEqual({ part: '3', conformance: 'B' });

    const attributes = parseXmp(
      encode(
        wrap('xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1" pdfaid:conformance="A"', ''),
      ),
    );
    expect(attributes.claim).toEqual({ part: '1', conformance: 'A' });
    expect(attributes.undescribedNamespaces).toEqual([]);

    // A custom namespace declared and used only as an attribute is still a namespace in use.
    const custom = parseXmp(
      encode(
        wrap(
          'xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1" xmlns:acme="http://acme.example/ns/" acme:Flag="1"',
          '',
        ),
      ),
    );
    expect(custom.claim).toEqual({ part: '1', conformance: null });
    expect(custom.undescribedNamespaces).toEqual(['http://acme.example/ns/']);
  });

  it('collects text and list properties and tolerates a byte-order mark', () => {
    const packet = parseXmp(
      encode(
        `﻿${wrap(
          `xmlns:dc="${NS_DC}" xmlns:pdf="${NS_PDF}"`,
          '<dc:creator><rdf:Seq><rdf:li>Ada</rdf:li><rdf:li>Grace</rdf:li></rdf:Seq></dc:creator><pdf:Producer> MuPDF </pdf:Producer>',
        )}`,
      ),
    );
    expect(packet.wellFormed).toBe(true);
    expect(xmpList(packet, NS_DC, 'creator')).toEqual(['Ada', 'Grace']);
    expect(xmpText(packet, NS_PDF, 'Producer')).toBe('MuPDF');
    expect(xmpText(packet, NS_DC, 'title')).toBeNull();
    expect(packet.claim).toEqual({ part: null, conformance: null });
  });

  it('lists a namespace no predefined or extension schema covers, and drops it once described', () => {
    const custom = 'xmlns:acme="http://acme.example/ns/"';
    const undescribed = parseXmp(encode(wrap(custom, '<acme:Flag>1</acme:Flag>')));
    expect(undescribed.undescribedNamespaces).toEqual(['http://acme.example/ns/']);

    const schema =
      'xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"';
    const described = parseXmp(
      encode(
        wrap(
          `${custom} ${schema}`,
          '<acme:Flag>1</acme:Flag><pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource"><pdfaSchema:namespaceURI>http://acme.example/ns/</pdfaSchema:namespaceURI></rdf:li></rdf:Bag></pdfaExtension:schemas>',
        ),
      ),
    );
    expect(described.undescribedNamespaces).toEqual([]);
  });

  it('reports a packet that is not well-formed XML instead of guessing at it', () => {
    const broken = parseXmp(encode('<x:xmpmeta><rdf:Description></x:xmpmeta>'));
    expect(broken.wellFormed).toBe(false);
    expect(broken.claim).toEqual({ part: null, conformance: null });
    expect(parseXmp(encode('')).wellFormed).toBe(false);
  });
});
