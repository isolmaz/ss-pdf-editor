/**
 * The two XMP facts PDF/UA reads and writes (`dc:title`, `pdfuaid:part`) as string functions.
 * What matters: both RDF shapes are read, an edit leaves the rest of the packet alone, a part the
 * file already declares is never rewritten, and every packet written is well-formed XML to an
 * independent parser.
 */

import { describe, expect, it } from 'vitest';
import { parseXmp, xmpText } from './pdfa-xmp';
import { buildUaPacket, NS_DC as DC, editUaPacket, NS_PDFUAID, readUaPart, readXmpTitle } from './ua-xmp';

const packet = (description: string): string =>
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${description}
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

const reread = (text: string) => parseXmp(new TextEncoder().encode(text));

describe('ua-xmp', () => {
  it('reads a title from an attribute or an element, prefers x-default and decodes entities', () => {
    expect(readXmpTitle(packet('<rdf:Description dc:title="A &amp; B"/>'))).toBe('A & B');
    expect(
      readXmpTitle(
        packet(
          '<rdf:Description><dc:title><rdf:Alt><rdf:li xml:lang="de">Bericht</rdf:li><rdf:li xml:lang="x-default">Report &#233;</rdf:li></rdf:Alt></dc:title></rdf:Description>',
        ),
      ),
    ).toBe('Report é');
    expect(
      readXmpTitle(
        packet(
          '<rdf:Description><dc:title><rdf:Alt><rdf:li xml:lang="x-default"> </rdf:li></rdf:Alt></dc:title></rdf:Description>',
        ),
      ),
    ).toBeNull();
    expect(readXmpTitle(packet('<rdf:Description/>'))).toBeNull();
  });

  it('reads the declared part from either shape and nothing when there is none', () => {
    expect(readUaPart(packet('<rdf:Description pdfuaid:part="1"/>'))).toBe(1);
    expect(readUaPart(packet('<rdf:Description><pdfuaid:part> 2 </pdfuaid:part></rdf:Description>'))).toBe(2);
    expect(readUaPart(packet('<rdf:Description/>'))).toBeNull();
  });

  it('builds a fresh packet that an XML parser reads back with the same title and part', () => {
    const fresh = reread(buildUaPacket({ title: 'Q&A <draft>', uaPart: 1 }));
    expect(fresh.wellFormed).toBe(true);
    expect(xmpText(fresh, DC, 'title')).toBe('Q&A <draft>');
    expect(xmpText(fresh, NS_PDFUAID, 'part')).toBe('1');
    expect(readXmpTitle(buildUaPacket({ title: 'Q&A <draft>' }))).toBe('Q&A <draft>');
  });

  it('adds a title and a part to the first description and keeps everything else as it was', () => {
    const original = packet(
      '<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" pdf:Producer="MuPDF"></rdf:Description>',
    );
    const edited = editUaPacket(original, { title: 'Annual <Report>', uaPart: 1 });
    expect(edited).not.toBeNull();
    const text = edited as string;
    expect(text).toContain('pdf:Producer="MuPDF"');
    expect(text.startsWith('<?xpacket begin=""')).toBe(true);
    expect(text.endsWith('<?xpacket end="w"?>')).toBe(true);
    const parsed = reread(text);
    expect(parsed.wellFormed).toBe(true);
    expect(xmpText(parsed, DC, 'title')).toBe('Annual <Report>');
    expect(xmpText(parsed, NS_PDFUAID, 'part')).toBe('1');
    expect(xmpText(parsed, 'http://ns.adobe.com/pdf/1.3/', 'Producer')).toBe('MuPDF');
    expect(readXmpTitle(text)).toBe('Annual <Report>');
    expect(readUaPart(text)).toBe(1);
  });

  it('expands a self-closing description, replaces an existing title and keeps a declared part', () => {
    const selfClosing = editUaPacket(packet('<rdf:Description/>'), { title: 'T' });
    expect(selfClosing).not.toBeNull();
    const parsed = reread(selfClosing as string);
    expect(parsed.wellFormed).toBe(true);
    expect(xmpText(parsed, DC, 'title')).toBe('T');

    const replaced = editUaPacket(
      packet(
        '<rdf:Description xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/" pdfuaid:part="2"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old</rdf:li></rdf:Alt></dc:title></rdf:Description>',
      ),
      { title: 'New', uaPart: 1 },
    );
    expect(replaced).not.toBeNull();
    expect(readXmpTitle(replaced as string)).toBe('New');
    // A file that declares part 2 is not rewritten into part 1.
    expect(readUaPart(replaced as string)).toBe(2);
    expect((replaced as string).match(/Old/g)).toBeNull();
  });

  it('refuses to edit a packet with no description', () => {
    expect(editUaPacket(packet(''), { title: 'T' })).toBeNull();
  });
});
