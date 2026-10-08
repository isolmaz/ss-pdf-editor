/**
 * The XMP reader on packets a producer (or an attacker) may write: list containers with
 * foreign children, attribute-form extension schemas, properties in machinery namespaces,
 * elements without a namespace, an empty list, and nesting deep enough to exhaust the stack.
 */

import { describe, expect, it } from 'vitest';
import { NS_DC, parseXmp, xmpList, xmpText } from './pdfa-xmp';

const encode = (text: string) => new TextEncoder().encode(text);

const RDF = 'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"';

function packet(description: string, attributes = ''): Uint8Array {
  return encode(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ${RDF}><rdf:Description rdf:about="" ${attributes}>${description}</rdf:Description></rdf:RDF></x:xmpmeta>`,
  );
}

describe('parseXmp edge cases', () => {
  it('reads the items of every container kind, skips children that are not list items, and joins repeated properties', () => {
    const parsed = parseXmp(
      packet(
        `<dc:creator xmlns:dc="${NS_DC}"><rdf:Seq><rdf:li>Ayşe</rdf:li><rdf:other>skipped</rdf:other><rdf:li> Mehmet </rdf:li></rdf:Seq></dc:creator>
         <dc:subject xmlns:dc="${NS_DC}"><rdf:Bag><rdf:li>a</rdf:li></rdf:Bag><rdf:Alt><rdf:li>b</rdf:li></rdf:Alt></dc:subject>
         <dc:title xmlns:dc="${NS_DC}"><rdf:Alt></rdf:Alt></dc:title>
         <dc:format xmlns:dc="${NS_DC}">application/pdf</dc:format>`,
      ),
    );
    expect(xmpList(parsed, NS_DC, 'creator')).toEqual(['Ayşe', 'Mehmet']);
    expect(xmpList(parsed, NS_DC, 'subject')).toEqual(['a', 'b']);
    // An empty list is a list with no item, and there is no text to give.
    expect(xmpList(parsed, NS_DC, 'title')).toEqual([]);
    expect(xmpText(parsed, NS_DC, 'title')).toBeNull();
    expect(xmpText(parsed, NS_DC, 'format')).toBe('application/pdf');
    expect(xmpText(parsed, NS_DC, 'absent')).toBeNull();
    expect(xmpList(parsed, NS_DC, 'absent')).toBeNull();
  });

  it('ignores attributes without a namespace and machinery, and elements without a namespace or in a machinery namespace', () => {
    const parsed = parseXmp(
      packet(
        '<plain>text</plain><m:thing xmlns:m="adobe:ns:meta/">machinery</m:thing>',
        `plainAttribute="x" xml:lang="tr" dc:format="application/pdf" xmlns:dc="${NS_DC}"`,
      ),
    );
    expect(parsed.wellFormed).toBe(true);
    expect([...parsed.properties.keys()]).toEqual([`${NS_DC}format`]);
    expect(parsed.undescribedNamespaces).toEqual([]);
  });

  it('counts an extension schema that describes a namespace as an attribute, and ignores an empty description', () => {
    const schema = 'http://www.aiim.org/pdfa/ns/schema#';
    const parsed = parseXmp(
      packet(
        `<own:field xmlns:own="http://example.test/a/">1</own:field>
         <own2:field xmlns:own2="http://example.test/b/">2</own2:field>
         <own3:field xmlns:own3="http://example.test/c/">3</own3:field>
         <ext:schemas xmlns:ext="http://www.aiim.org/pdfa/ns/extension/"><s:namespaceURI xmlns:s="${schema}">http://example.test/a/</s:namespaceURI><s:namespaceURI xmlns:s="${schema}">   </s:namespaceURI><rdf:Description xmlns:s="${schema}" s:namespaceURI="http://example.test/b/"/><rdf:Description xmlns:s="${schema}" s:namespaceURI=""/></ext:schemas>`,
      ),
    );
    expect(parsed.undescribedNamespaces).toEqual(['http://example.test/c/']);
  });

  it('reads the claim from attributes and an absent claim as nulls', () => {
    const none = parseXmp(packet(''));
    expect(none.claim).toEqual({ part: null, conformance: null });
  });

  it('calls a packet with a repeated attribute or an unknown entity not well-formed', () => {
    for (const text of ['<a b="1" b="2"/>', '<a>&bogus;</a>', '', '<a>', 'not xml']) {
      expect(parseXmp(encode(text)).wellFormed).toBe(false);
    }
  });

  it('does not throw on a packet nested far deeper than the stack allows', () => {
    const depth = 200_000;
    const parsed = parseXmp(encode(`<a>${'<b>'.repeat(depth)}${'</b>'.repeat(depth)}</a>`));
    expect(parsed.wellFormed).toBe(true);
    expect(parsed.properties.size).toBe(0);
  });

  it('reads a packet with a very large number of siblings', () => {
    const siblings = '<b/>'.repeat(300_000);
    const parsed = parseXmp(encode(`<a>${siblings}</a>`));
    expect(parsed.wellFormed).toBe(true);
  });
});
