/**
 * The OOXML helpers both DOCX writers share: Word's 22-inch page limit and the factor that
 * brings a page inside it, the page section, and a picture anchored to the page.
 */

import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import {
  anchoredPictureXml,
  documentRelsXml,
  pageSectionXml,
  SHAPE_NAMESPACES,
  wordDocumentXml,
  wordPageScale,
  xml,
  xmlSafe,
} from './docx-drawing';

/** The `Char` production of XML 1.0 (§2.2), which a text node may hold: no lone surrogate, no U+FFFE/U+FFFF. */
const XML_CHARS = /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;

describe('xmlSafe', () => {
  it('replaces a surrogate without its partner with U+FFFD, wherever it stands', () => {
    expect(xmlSafe('a\uD800b')).toBe('a\uFFFDb');
    expect(xmlSafe('a\uDC00b')).toBe('a\uFFFDb');
    expect(xmlSafe('\uD83D')).toBe('\uFFFD');
    expect(xmlSafe('end\uDE00')).toBe('end\uFFFD');
    // A pair in the wrong order is two lone surrogates.
    expect(xmlSafe('\uDE00\uD83D')).toBe('\uFFFD\uFFFD');
  });

  it('keeps every valid pair, and replaces only the stray unit beside it', () => {
    expect(xmlSafe('😀')).toBe('😀');
    expect(xmlSafe('𝐀 \u{10000} \u{10FFFF}')).toBe('𝐀 \u{10000} \u{10FFFF}');
    expect(xmlSafe('\uD83D😀')).toBe('\uFFFD😀');
    expect(xmlSafe('😀\uDE00')).toBe('😀\uFFFD');
    expect(xmlSafe('\uD83D\uD83D\uDE00')).toBe('\uFFFD😀');
  });

  it('still drops the control characters and U+FFFE/U+FFFF, and leaves tab, newline and letters', () => {
    expect(xmlSafe('a\u0000b\u0008c\u000Bd\u000Ce\u001Ff\uFFFEg\uFFFFh')).toBe('abcdefgh');
    expect(xmlSafe('a\tb\nc\rd Şişli ığ')).toBe('a\tb\nc\rd Şişli ığ');
  });

  it('gives text that is valid XML 1.0 for strings that were not', () => {
    const mixed = ['a\uD800b', '\uDC00', '😀\uD83D', '𝐀\uDE00𝐀', '\uD800\uD800\uDC00', 'x\u0000\uFFFEy'];
    for (const value of mixed) {
      expect(XML_CHARS.test(value)).toBe(false);
      expect(XML_CHARS.test(xmlSafe(value))).toBe(true);
    }
  });

  it('is what `xml` escapes after: the entities, with the astral characters kept', () => {
    expect(xml('a\uD800<😀>&')).toBe('a\uFFFD&lt;😀&gt;&amp;');
  });
});

describe('wordPageScale', () => {
  it('leaves a page that fits, even one exactly 22 inches wide, as it is', () => {
    expect(wordPageScale(595, 842)).toBe(1);
    expect(wordPageScale(1584, 1584)).toBe(1);
    expect(wordPageScale(1584, 100)).toBe(1);
  });

  it('shrinks both sides by the factor that brings the longer one to 22 inches', () => {
    expect(wordPageScale(1190, 1684)).toBeCloseTo(1584 / 1684, 12);
    expect(wordPageScale(3168, 400)).toBe(0.5);
    expect(wordPageScale(400, 3168)).toBe(0.5);
    // Both over the limit: the worse one decides.
    expect(wordPageScale(3168, 6336)).toBe(0.25);
  });
});

describe('pageSectionXml', () => {
  it('is the page’s size in twips with no margin, a new page, and landscape only when wider than tall', () => {
    const margins =
      '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/>';
    expect(pageSectionXml(595.28, 841.89)).toBe(
      `<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="11906" w:h="16838"/>${margins}</w:sectPr>`,
    );
    expect(pageSectionXml(841.89, 595.28)).toBe(
      `<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>${margins}</w:sectPr>`,
    );
    // A square page is not landscape.
    expect(pageSectionXml(500, 500)).not.toContain('w:orient');
  });
});

describe('anchoredPictureXml', () => {
  const picture = { id: 3, name: 'a&b.png', rid: 'rIdImage3', x: 10, y: 20, width: 100, height: 50 };

  it('places the picture from the page’s corner, behind the text, without wrapping', () => {
    const drawing = anchoredPictureXml(picture);
    expect(drawing.startsWith('<w:drawing><wp:anchor ')).toBe(true);
    expect(drawing).toContain('behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"');
    expect(drawing).toContain(
      '<wp:positionH relativeFrom="page"><wp:posOffset>127000</wp:posOffset></wp:positionH>',
    );
    expect(drawing).toContain(
      '<wp:positionV relativeFrom="page"><wp:posOffset>254000</wp:posOffset></wp:positionV>',
    );
    expect(drawing).toContain('<wp:extent cx="1270000" cy="635000"/>');
    expect(drawing).toContain('<a:ext cx="1270000" cy="635000"/>');
    expect(drawing).toContain('<wp:wrapNone/>');
    expect(drawing).toContain('<a:blip r:embed="rIdImage3"/>');
  });

  it('escapes the name and never writes an extent of zero', () => {
    expect(anchoredPictureXml(picture)).toContain('<wp:docPr id="3" name="a&amp;b.png"/>');
    expect(xml('a&b')).toBe('a&amp;b');
    expect(anchoredPictureXml({ ...picture, width: 0, height: 0 })).toContain('<wp:extent cx="1" cy="1"/>');
  });
});

describe('documentRelsXml', () => {
  it('lists the styles, the media and then the external links, the link target escaped', () => {
    const rels = documentRelsXml(['a.png'], [{ rid: 'rIdLink1', uri: 'https://example.com/?a=1&b=<2>' }]);
    expect(rels).toContain('Id="rIdImage1"');
    expect(rels).toContain(
      '<Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/?a=1&amp;b=&lt;2&gt;" TargetMode="External"/>',
    );
    expect(rels.indexOf('rIdImage1')).toBeLessThan(rels.indexOf('rIdLink1'));
  });

  it('is unchanged without links', () => {
    expect(documentRelsXml(['a.png'])).not.toContain('hyperlink');
    expect(documentRelsXml(['a.png'])).toBe(documentRelsXml(['a.png'], []));
  });
});

describe('SHAPE_NAMESPACES', () => {
  it('would be caught if a prefix were declared twice', () => {
    const failures: string[] = [];
    new DOMParser({
      errorHandler: (level: string, message: string) => failures.push(`${level}: ${message}`),
    }).parseFromString(wordDocumentXml('<w:p/>', `${SHAPE_NAMESPACES} ${SHAPE_NAMESPACES}`), 'text/xml');
    expect(failures.length).toBeGreaterThan(0);
  });

  it('adds each prefix once to the document root, which parses without a complaint', () => {
    const failures: string[] = [];
    const xmlText = wordDocumentXml('<w:p/>', SHAPE_NAMESPACES);
    new DOMParser({
      errorHandler: (level: string, message: string) => failures.push(`${level}: ${message}`),
    }).parseFromString(xmlText, 'text/xml');
    expect(failures).toEqual([]);
    const prefixes = [...xmlText.matchAll(/xmlns:(\w+)=/g)].map((match) => match[1]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
