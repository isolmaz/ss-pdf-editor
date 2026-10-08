/**
 * The OOXML helpers both DOCX writers share: Word's 22-inch page limit and the factor that
 * brings a page inside it, the page section, and a picture anchored to the page.
 */

import { describe, expect, it } from 'vitest';
import { anchoredPictureXml, pageSectionXml, wordPageScale, xml } from './docx-drawing';

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
