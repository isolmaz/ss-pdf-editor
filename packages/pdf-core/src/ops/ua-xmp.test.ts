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

  it('decodes numeric and hexadecimal character references and leaves an unknown named one as written', () => {
    const text = packet(
      '<rdf:Description dc:title="A&#x41;&#66;&copy;&amp;" xmlns:dc="http://purl.org/dc/elements/1.1/"/>',
    );
    expect(readXmpTitle(text)).toBe('AAB&copy;&');
  });

  it('reads an empty title attribute as no title, and an element title in every shape', () => {
    expect(readXmpTitle(packet('<rdf:Description dc:title=" "/>'))).toBeNull();
    // No x-default entry: the first list item is the title.
    expect(
      readXmpTitle(
        packet(
          '<dc:title><rdf:Alt><rdf:li xml:lang="de">Erste</rdf:li><rdf:li xml:lang="fr">Seconde</rdf:li></rdf:Alt></dc:title>',
        ),
      ),
    ).toBe('Erste');
    // No list at all: the element's own text.
    expect(readXmpTitle(packet('<dc:title>Plain <b>text</b></dc:title>'))).toBe('Plain text');
  });

  it('drops control characters from a written title, keeping tab and line breaks', () => {
    const text = buildUaPacket({ title: 'a\u0001b\tc\nd\re\u001ff' });
    expect(readXmpTitle(text)).toBe('ab\tc\nd\ref');
  });

  it('writes only the part when no title is given, in a fresh packet and in an edited one', () => {
    const fresh = buildUaPacket({ uaPart: 1 });
    expect(readUaPart(fresh)).toBe(1);
    expect(readXmpTitle(fresh)).toBeNull();
    const edited = editUaPacket(packet('<rdf:Description rdf:about=""></rdf:Description>'), { uaPart: 1 });
    expect(readUaPart(edited as string)).toBe(1);
    expect(readXmpTitle(edited as string)).toBeNull();
    expect(reread(edited as string).wellFormed).toBe(true);
  });

  it('replaces a title written as an attribute of the description', () => {
    const edited = editUaPacket(
      packet(
        '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" dc:title="Old &amp; gray"/>',
      ),
      { title: 'New <one>' },
    );
    expect(edited).not.toBeNull();
    expect(readXmpTitle(edited as string)).toBe('New <one>');
    expect(edited as string).not.toContain('Old');
    expect(reread(edited as string).wellFormed).toBe(true);
  });

  it('does not repeat a namespace declaration the description already has', () => {
    const edited = editUaPacket(
      packet(
        `<rdf:Description rdf:about="" xmlns:dc="${DC}" xmlns:pdfuaid="${NS_PDFUAID}"></rdf:Description>`,
      ),
      { title: 'T', uaPart: 1 },
    );
    const text = edited as string;
    expect(text.match(/xmlns:dc=/g)).toHaveLength(1);
    expect(text.match(/xmlns:pdfuaid=/g)).toHaveLength(1);
    expect(readXmpTitle(text)).toBe('T');
    expect(readUaPart(text)).toBe(1);
  });

  it('keeps the about attribute of a self-closing description', () => {
    const edited = editUaPacket(packet('<rdf:Description rdf:about="uuid:1"/>'), { title: 'T' });
    expect(edited as string).toContain('rdf:about="uuid:1"');
    expect((edited as string).match(/rdf:about=/g)).toHaveLength(1);
    expect(reread(edited as string).wellFormed).toBe(true);
  });

  it('refuses a packet whose description is eaten by the title it replaces, or is never closed', () => {
    const swallowed = packet('<dc:title><rdf:Description rdf:about=""/></dc:title>');
    expect(editUaPacket(swallowed, { title: 'T', uaPart: 1 })).toBeNull();
    const unclosed = packet('<rdf:Description rdf:about="">');
    expect(editUaPacket(unclosed, { title: 'T' })).toBeNull();
  });
});
