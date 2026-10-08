/**
 * The text of a page as Word text boxes (`docx-layout-text.ts`), on pages built in the test:
 * how MuPDF's lines group into paragraphs and boxes (columns, alignment, bullets, runs,
 * links) and what the text-box XML says (anchor order, exact spacing, half-point sizes, the
 * VML fallback mammoth reads). A wrong grouping puts text in the wrong place on the page; a
 * wrong word count fails the export's read-back.
 */

import mammoth from 'mammoth';
import { describe, expect, it } from 'vitest';
import { loadMupdf } from '../engines/mupdf';
import {
  contentTypesXml,
  documentRelsXml,
  PACKAGE_RELS,
  SHAPE_NAMESPACES,
  wordDocumentXml,
  zipped,
} from './docx-drawing';
import { textBoxes, textBoxXml, wordsInBoxes } from './docx-layout-text';
import { wordFontName } from './export-office';
import { line, officeDocument } from './export-office-fixtures';
import { DocxRegistry, type SceneLink, type TextBox, type TextRun } from './layout-scene';
import { type LayoutChar, type PageLayout, readPageLayout } from './page-layout';

/** Page height of the fixtures: `line(…, y)` is from the bottom, the layout is from the top. */
const PAGE = 500;
const WIDTH = 400;

async function layoutOf(content: string): Promise<PageLayout> {
  const bytes = await officeDocument([{ content }]);
  const mupdf = await loadMupdf();
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf');
  return readPageLayout(mupdf, doc.loadPage(0), { images: false });
}

const textOf = (box: TextBox) =>
  box.paragraphs.map((paragraph) =>
    paragraph.lines.map((item) => item.runs.map((run) => run.text).join('')).join('\n'),
  );

/** Courier is 0.6 × size wide per character: the x of a text of `count` characters ending at `right`. */
const endingAt = (right: number, size: number, count: number) => right - 0.6 * size * count;
const centredAt = (middle: number, size: number, count: number) => middle - 0.3 * size * count;

const run = (text: string, overrides: Partial<TextRun> = {}): TextRun => ({
  text,
  font: 'Arial',
  size: 10,
  bold: false,
  italic: false,
  color: 0,
  link: null,
  ...overrides,
});

const handMade = (overrides: Partial<TextBox> = {}): TextBox => ({
  box: [100, 200, 300, 260],
  rotation: 0,
  paragraphs: [
    {
      align: 'left',
      lineHeight: 12.5,
      lines: [{ runs: [run('Merhaba dünya')] }, { runs: [run('ikinci satır', { bold: true })] }],
    },
  ],
  ...overrides,
});

describe('grouping lines into text boxes', () => {
  it('keeps the columns of a two-column page apart and reads them column by column', async () => {
    const left = ['Birinci sütunun', 'ilk paragraf burada', 'üç satir olur'];
    const right = ['Ikinci sütunun', 'metni sag tarafta', 'yer alir'];
    const layout = await layoutOf(
      [
        ...left.map((text, at) => line('courier', 11, 40, 440 - at * 14, text)),
        ...right.map((text, at) => line('courier', 11, 220, 440 - at * 14, text)),
      ].join('\n'),
    );
    const boxes = textBoxes(layout, []);
    expect(boxes.map((box) => textOf(box).join('|'))).toEqual([left.join('\n'), right.join('\n')]);
    const [first, second] = boxes as [TextBox, TextBox];
    expect(first.box[2]).toBeLessThan(220);
    expect(second.box[0]).toBeGreaterThanOrEqual(219);
    expect(first.paragraphs[0]?.lineHeight).toBeCloseTo(14, 1);
  });

  it('finds a centred title, a left, a justified and a right-aligned paragraph', async () => {
    const title = 'Özet Rapor';
    const ragged = ['kisa satir bir', 'bu biraz daha uzun bir satir', 'son'];
    const justified = [
      'aaaa bbbb cccc dddd eeee ffff',
      'gggg hhhh iiii jjjj kkkk llll',
      'mmmm nnnn oooo',
      '',
    ];
    const right = ['saga yasli uzun satir', 'kisa'];
    const content = [
      line('courier', 16, centredAt(200, 16, title.length), 450, title),
      ...ragged.map((text, at) => line('courier', 10, 40, 400 - at * 13, text)),
      ...justified
        .filter((text) => text !== '')
        .map((text, at) => line('courier', 10, 40, 330 - at * 13, text)),
      ...right.map((text, at) => line('courier', 10, endingAt(360, 10, text.length), 250 - at * 13, text)),
    ].join('\n');
    const boxes = textBoxes(await layoutOf(content), []);
    expect(boxes.map((box) => box.paragraphs.map((paragraph) => paragraph.align))).toEqual([
      ['center'],
      ['left'],
      ['both'],
      ['right'],
    ]);
    // The justified box is hardly wider than its lines (30 characters × 6 pt): little to stretch into.
    const [, , justifiedBox] = boxes as [TextBox, TextBox, TextBox, TextBox];
    expect(justifiedBox.box[2] - justifiedBox.box[0]).toBeLessThan(180);
    expect(justifiedBox.box[2] - justifiedBox.box[0]).toBeGreaterThan(176);
    expect(textOf(justifiedBox)).toEqual([justified.filter((text) => text !== '').join('\n')]);
  });

  it('joins the pieces MuPDF cuts a stretched justified line into', async () => {
    const full = 'x'.repeat(50);
    // Three 4-letter words spread over 20…320 (gaps of 114 pt): MuPDF reports each as a line.
    const spread = (y: number, words: string[]) =>
      words.map((word, at) => line('courier', 10, 20 + at * 138, y, word));
    const layout = await layoutOf(
      [
        line('courier', 10, 20, 440, full),
        ...spread(427, ['aaaa', 'bbbb', 'cccc']),
        line('courier', 10, 20, 414, full),
        line('courier', 10, 20, 401, 'son'),
      ].join('\n'),
    );
    const boxes = textBoxes(layout, []);
    expect(boxes.map(textOf)).toEqual([[`${full}\naaaa bbbb cccc\n${full}\nson`]]);
    expect((boxes[0] as TextBox).paragraphs.map((paragraph) => paragraph.align)).toEqual(['both']);
  });

  it('does not join columns of one row that are not evenly spread', async () => {
    const layout = await layoutOf(
      [
        line('courier', 10, 20, 440, 'x'.repeat(50)),
        line('courier', 10, 20, 427, 'Ad'),
        line('courier', 10, 120, 427, 'Deger'),
        line('courier', 10, 300, 427, 'Son'),
        line('courier', 10, 20, 414, 'x'.repeat(50)),
      ].join('\n'),
    );
    const text = textBoxes(layout, []).flatMap(textOf).join('|');
    expect(text).toContain('Deger');
    expect(text).not.toContain('Ad Deger');
  });

  it('joins two pieces only when together they span the block from edge to edge', async () => {
    const full = 'x'.repeat(50);
    const joined = textBoxes(
      await layoutOf(
        [
          line('courier', 10, 20, 440, full),
          line('courier', 10, 20, 427, 'Ad'),
          line('courier', 10, 296, 427, 'Sonn'),
          line('courier', 10, 20, 414, full),
        ].join('\n'),
      ),
      [],
    );
    expect(joined.flatMap(textOf)).toEqual([`${full}\nAd Sonn\n${full}`]);
    const apart = textBoxes(
      await layoutOf(
        [
          line('courier', 10, 20, 440, full),
          line('courier', 10, 60, 427, 'Ad'),
          line('courier', 10, 296, 427, 'Sonn'),
          line('courier', 10, 20, 414, full),
        ].join('\n'),
      ),
      [],
    );
    expect(apart.flatMap(textOf).join('|')).not.toContain('Ad Sonn');
    const short = textBoxes(
      await layoutOf(
        [
          line('courier', 10, 20, 440, full),
          line('courier', 10, 20, 427, 'Ad'),
          line('courier', 10, 200, 427, 'Son'),
          line('courier', 10, 20, 414, full),
        ].join('\n'),
      ),
      [],
    );
    expect(short.flatMap(textOf).join('|')).not.toContain('Ad Sonn');
  });

  it('keeps the two ends of a footer apart: nothing else in its block to measure against', async () => {
    const boxes = textBoxes(
      await layoutOf(
        [
          line('courier', 10, 20, 440, 'x'.repeat(50)),
          line('courier', 10, 20, 60, 'Yayin 15'),
          line('courier', 10, 272, 60, 'Sayfa 3'),
        ].join('\n'),
      ),
      [],
    );
    expect(boxes.flatMap(textOf)).toEqual(['x'.repeat(50), 'Yayin 15', 'Sayfa 3']);
  });

  it('justifies a paragraph whose lines all reach the column edge, the last too', async () => {
    const full = 'x'.repeat(50);
    const boxes = textBoxes(
      await layoutOf([440, 427, 414].map((y) => line('courier', 10, 20, y, full)).join('\n')),
      [],
    );
    expect(boxes.flatMap((box) => box.paragraphs.map((paragraph) => paragraph.align))).toEqual(['both']);
  });

  it('justifies a short paragraph like the justified ones of its column', async () => {
    const full = 'x'.repeat(50);
    const boxes = textBoxes(
      await layoutOf(
        [
          line('courier', 10, 20, 440, full),
          line('courier', 10, 20, 427, full),
          line('courier', 10, 20, 414, 'abc'),
          // A paragraph of two lines: the first reaches the column edge, the last does not.
          line('courier', 10, 20, 380, full),
          line('courier', 10, 20, 367, 'def'),
          // Another that does not reach it, and one in the next column that has nothing to follow.
          line('courier', 10, 20, 330, 'x'.repeat(40)),
          line('courier', 10, 20, 317, 'ghi'),
          line('courier', 10, 20, 300, 'x'.repeat(48)),
          line('courier', 10, 20, 287, 'jkl'),
          line('courier', 10, 220, 150, 'x'.repeat(20)),
          line('courier', 10, 220, 137, 'mno'),
        ].join('\n'),
      ),
      [],
    );
    const aligns = boxes.flatMap((box) =>
      box.paragraphs.map((paragraph) => [textOf(box)[0]?.slice(0, 3), paragraph.align]),
    );
    expect(aligns).toContainEqual(['xxx', 'both']);
    expect(aligns.filter(([, align]) => align === 'both')).toHaveLength(2);
    expect(aligns.filter(([, align]) => align === 'left').length).toBeGreaterThanOrEqual(3);
  });

  it('makes one paragraph of each bullet and numbered item, and keeps the list in one box', async () => {
    const items = ['• birinci madde', '• ikinci madde', '1. numarali madde', '2. bir sonraki'];
    const boxes = textBoxes(
      await layoutOf(items.map((text, at) => line('courier', 11, 40, 440 - at * 15, text)).join('\n')),
      [],
    );
    expect(boxes).toHaveLength(1);
    const [box] = boxes as [TextBox];
    expect(box.paragraphs.map((paragraph) => paragraph.lines.length)).toEqual([1, 1, 1, 1]);
    expect(textOf(box)).toEqual(items);
    // The box's line spacing reproduces the 15 pt between the items.
    for (const paragraph of box.paragraphs) expect(paragraph.lineHeight).toBeCloseTo(15, 1);
  });

  it('starts a new paragraph at a size change and does not stack across a gap', async () => {
    const boxes = textBoxes(
      await layoutOf(
        [
          line('courier', 20, 40, 450, 'Baslik'),
          line('courier', 10, 40, 420, 'gövde bir'),
          line('courier', 10, 40, 407, 'gövde iki'),
          line('courier', 10, 40, 330, 'uzak satir'),
        ].join('\n'),
      ),
      [],
    );
    expect(boxes.map(textOf)).toEqual([['Baslik'], ['gövde bir\ngövde iki'], ['uzak satir']]);
  });

  it('splits a line into runs at every change of weight, colour and size', async () => {
    const layout = await layoutOf(
      [
        line('courier', 10, 40, 400, 'Merhaba '),
        line('courierBold', 10, 88, 400, 'güçlü '),
        line('courier', 10, 124, 400, 'kirmizi ', '1 0 0'),
        line('courier', 14, 172, 400, 'büyük'),
      ].join('\n'),
    );
    const [box] = textBoxes(layout, []) as [TextBox];
    const runs = box.paragraphs[0]?.lines[0]?.runs ?? [];
    expect(runs.map((item) => item.text)).toEqual(['Merhaba ', 'güçlü ', 'kirmizi ', 'büyük']);
    expect(runs.map((item) => item.bold)).toEqual([false, true, false, false]);
    expect(runs.map((item) => item.color)).toEqual([0, 0, 0xff0000, 0]);
    expect(runs.map((item) => item.size)).toEqual([10, 10, 10, 14]);
    expect(runs.map((item) => item.font)).toEqual(Array(4).fill(wordFontName('Courier')));
  });

  it('inserts a space where two words are set apart without a space character', () => {
    const char = (c: string, x: number): LayoutChar => ({
      c,
      box: [x, 90, x + 6, 102],
      size: 10,
      font: 'Arial',
      bold: false,
      italic: false,
      mono: false,
      serif: false,
      color: 0,
    });
    // "ab" at 40…52, "cd" at 60…72: the gap of 8 pt is wider than a quarter of the size.
    const chars = [char('a', 40), char('b', 46), char('c', 60), char('d', 66)];
    const layout: PageLayout = {
      width: WIDTH,
      height: PAGE,
      blocks: [{ kind: 'text', box: [40, 90, 72, 102], lines: [{ box: [40, 90, 72, 102], chars }] }],
      rulings: [],
      marks: [],
    };
    const [box] = textBoxes(layout, []) as [TextBox];
    expect(textOf(box)).toEqual(['ab cd']);
    // Touching characters stay one word.
    const tight = {
      ...layout,
      blocks: [
        {
          kind: 'text' as const,
          box: [40, 90, 64, 102] as const,
          lines: [
            {
              box: [40, 90, 64, 102] as const,
              chars: [char('a', 40), char('b', 46), char('c', 52), char('d', 58)],
            },
          ],
        },
      ],
    };
    expect(textOf(textBoxes(tight, [])[0] as TextBox)).toEqual(['abcd']);
  });

  it('names a family Word does not know by the class its font flags say', () => {
    const char = (c: string, x: number, overrides: Partial<LayoutChar>): LayoutChar => ({
      c,
      box: [x, 90, x + 6, 102],
      size: 10,
      font: 'Mystery',
      bold: false,
      italic: false,
      mono: false,
      serif: false,
      color: 0,
      ...overrides,
    });
    const page = (chars: LayoutChar[]): PageLayout => ({
      width: WIDTH,
      height: PAGE,
      blocks: [{ kind: 'text', box: [40, 90, 100, 102], lines: [{ box: [40, 90, 100, 102], chars }] }],
      rulings: [],
      marks: [],
    });
    const fontsOf = (layout: PageLayout) =>
      (textBoxes(layout, [])[0] as TextBox).paragraphs[0]?.lines[0]?.runs.map((item) => item.font);
    // A sans family whose bold style is flagged serif (as MuPDF reports for some embedded fonts)
    // stays one family: the regular characters outvote it.
    expect(
      fontsOf(
        page([
          char('a', 40, {}),
          char('b', 46, {}),
          char('c', 52, { bold: true, serif: true }),
          char('d', 58, { font: 'MinionPro', serif: true }),
          char('e', 64, { font: 'Unknown2', serif: true }),
          char('f', 70, { font: 'Unknown3', mono: true }),
        ]),
      ),
    ).toEqual(['Arial', 'Arial', 'Times New Roman', 'Courier New']);
  });

  it('drops lines of whitespace only', async () => {
    const boxes = textBoxes(
      await layoutOf([line('courier', 10, 40, 400, '   '), line('courier', 10, 40, 380, 'metin')].join('\n')),
      [],
    );
    expect(boxes.map(textOf)).toEqual([['metin']]);
  });

  it('makes a box of its own, rotated, for a line that runs up the page', async () => {
    const content = [
      line('courier', 10, 40, 450, 'yatay metin'),
      `BT /F1 10 Tf 0 1 -1 0 300 100 Tm (dikey metin) Tj ET`,
    ].join('\n');
    const boxes = textBoxes(await layoutOf(content), []);
    expect(boxes.map((box) => [box.rotation, textOf(box).join('')])).toEqual([
      [0, 'yatay metin'],
      [270, 'dikey metin'],
    ]);
    const rotated = boxes[1] as TextBox;
    // Upward text is 11 characters × 6 pt long and a line high.
    expect(rotated.box[3] - rotated.box[1]).toBeGreaterThan(66);
    expect(rotated.box[2] - rotated.box[0]).toBeLessThan(20);
  });

  it('puts the box so that the first baseline lands on the PDF baseline', async () => {
    const [box] = textBoxes(await layoutOf(line('courier', 20, 40, 400, 'Satır')), []) as [TextBox];
    const lineHeight = box.paragraphs[0]?.lineHeight ?? 0;
    // Baseline 400 from the bottom of a 500 pt page = 100 from the top; it sits 0.8 line heights below the box top.
    expect(box.box[1] + 0.8 * lineHeight).toBeCloseTo(PAGE - 400, 0);
    expect(lineHeight).toBeGreaterThanOrEqual(1.15 * 20);
    expect(box.box[0]).toBeCloseTo(40, 0);
    expect(box.box[2] - box.box[0]).toBeCloseTo(5 * 12 * 1.03 + 2, 0);
  });

  it('links the characters inside a link box, and only those', async () => {
    const layout = await layoutOf(line('courier', 10, 40, 400, 'bkz örnek baglanti sonra'));
    const link: SceneLink = { box: [40 + 6 * 4, 90, 40 + 6 * 18, 102], uri: 'https://example.com/a' };
    const [box] = textBoxes(layout, [link]) as [TextBox];
    const runs = box.paragraphs[0]?.lines[0]?.runs ?? [];
    expect(runs.map((item) => [item.text, item.link])).toEqual([
      ['bkz ', null],
      ['örnek baglanti', 'https://example.com/a'],
      [' sonra', null],
    ]);
  });
});

describe('text box XML', () => {
  const registry = () => new DocxRegistry();

  it('writes the anchor children in the order Word requires, with no wrapping and no insets', () => {
    const xmlText = textBoxXml(handMade(), 1, registry());
    const order = [
      '<w:r><mc:AlternateContent><mc:Choice Requires="wps">',
      '<wp:anchor ',
      '<wp:simplePos',
      '<wp:positionH relativeFrom="page">',
      '<wp:positionV relativeFrom="page">',
      '<wp:extent ',
      '<wp:effectExtent ',
      '<wp:wrapNone/>',
      '<wp:docPr id="1"',
      '<wp:cNvGraphicFramePr/>',
      '<a:graphic>',
      'uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
      '<wps:wsp><wps:cNvSpPr txBox="1"/>',
      '<wps:spPr><a:xfrm>',
      '<a:prstGeom prst="rect">',
      '<a:noFill/><a:ln><a:noFill/></a:ln>',
      '<wps:txbx><w:txbxContent>',
      '<wps:bodyPr rot="0" vert="horz" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0"><a:noAutofit/>',
      '<mc:Fallback><w:pict><v:shape ',
      '<v:textbox inset="0,0,0,0">',
    ];
    let at = -1;
    for (const part of order) {
      const found = xmlText.indexOf(part, at + 1);
      expect(found, part).toBeGreaterThan(at);
      at = found;
    }
    expect(xmlText).toContain('behindDoc="0"');
    expect(xmlText).toContain('relativeHeight="1"');
    expect(xmlText).toContain('<wp:posOffset>1270000</wp:posOffset>');
    expect(xmlText).toContain('<wp:posOffset>2540000</wp:posOffset>');
    expect(xmlText).toContain('<wp:extent cx="2540000" cy="762000"/>');
  });

  it('sets exact line spacing in twips, half-point sizes and a space before every break', () => {
    const xmlText = textBoxXml(handMade(), 1, registry());
    expect(xmlText).toContain('w:spacing w:before="0" w:after="0" w:line="250" w:lineRule="exact"');
    expect(xmlText).toContain('<w:jc w:val="left"/>');
    expect(xmlText).toContain('<w:sz w:val="20"/><w:szCs w:val="20"/>');
    expect(xmlText).toContain('<w:b/><w:bCs/>');
    expect(xmlText).toContain('<w:color w:val="000000"/>');
    expect(xmlText).toContain('w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"');
    // The text before the break ends with a space.
    expect(xmlText).toContain('Merhaba dünya</w:t></w:r><w:r><w:rPr>');
    expect(xmlText).toMatch(/<w:t xml:space="preserve"> <\/w:t><\/w:r><w:r><w:br\/><\/w:r>/);
    // One break in the drawing, one in the fallback.
    expect(xmlText.match(/<w:br\/>/g)).toHaveLength(2);
  });

  it('puts the same content in the fallback as in the drawing', () => {
    const xmlText = textBoxXml(handMade(), 1, registry());
    const contents = xmlText.match(/<w:txbxContent>.*?<\/w:txbxContent>/g) ?? [];
    expect(contents).toHaveLength(2);
    expect(contents[0]).toBe(contents[1]);
    expect(xmlText).toContain(
      'style="position:absolute;margin-left:100pt;margin-top:200pt;width:200pt;height:60pt;mso-position-horizontal-relative:page;mso-position-vertical-relative:page;z-index:1" stroked="f" filled="f"',
    );
  });

  it('applies the page scale to offsets, sizes, fonts and line spacing', () => {
    const xmlText = textBoxXml(handMade(), 0.5, registry());
    expect(xmlText).toContain('<wp:posOffset>635000</wp:posOffset>');
    expect(xmlText).toContain('<wp:posOffset>1270000</wp:posOffset>');
    expect(xmlText).toContain('<wp:extent cx="1270000" cy="381000"/>');
    expect(xmlText).toContain('w:line="125"');
    expect(xmlText).toContain('<w:sz w:val="10"/>');
    expect(xmlText).toContain('margin-left:50pt;margin-top:100pt;width:100pt;height:30pt');
  });

  it('numbers drawings and stacks boxes in the order they are written', () => {
    const shared = registry();
    const first = textBoxXml(handMade(), 1, shared);
    const second = textBoxXml(handMade(), 1, shared);
    expect(first).toContain('<wp:docPr id="1"');
    expect(second).toContain('<wp:docPr id="2"');
    expect(first).toContain('relativeHeight="1"');
    expect(second).toContain('relativeHeight="2"');
  });

  it('rotates the frame about its centre: sides swapped, rot in 60000ths of a degree', () => {
    const upward = handMade({ box: [100, 200, 120, 300], rotation: 270 });
    const xmlText = textBoxXml(upward, 1, registry());
    expect(xmlText).toContain('<a:xfrm rot="16200000">');
    // The 20 × 100 visual box is a 100 × 20 frame with the same centre (110, 250).
    expect(xmlText).toContain('<wp:extent cx="1270000" cy="254000"/>');
    expect(xmlText).toContain(`<wp:posOffset>${60 * 12700}</wp:posOffset>`);
    expect(xmlText).toContain(`<wp:posOffset>${240 * 12700}</wp:posOffset>`);
    expect(xmlText).toContain('rotation:270;');
  });

  it('writes links as hyperlinks with one relationship per URI, the run style unchanged', () => {
    const shared = registry();
    const box = handMade({
      paragraphs: [
        {
          align: 'left',
          lineHeight: 12,
          lines: [
            {
              runs: [
                run('önce '),
                run('bağ', { link: 'https://example.com/x?a=1&b=2', color: 0x0000ff }),
                run(' ve '),
                run('yine', { link: 'https://example.com/x?a=1&b=2', color: 0x0000ff }),
                run(' öbürü', { link: 'mailto:a@b.c' }),
              ],
            },
          ],
        },
      ],
    });
    const xmlText = textBoxXml(box, 1, shared);
    expect(shared.links).toEqual([
      { rid: 'rIdLink1', uri: 'https://example.com/x?a=1&b=2' },
      { rid: 'rIdLink2', uri: 'mailto:a@b.c' },
    ]);
    expect(xmlText).toContain('<w:hyperlink r:id="rIdLink1"><w:r><w:rPr>');
    expect(xmlText.match(/<w:hyperlink r:id="rIdLink1">/g)).toHaveLength(4);
    expect(xmlText.match(/<w:hyperlink r:id="rIdLink2">/g)).toHaveLength(2);
    expect(xmlText).toContain('<w:color w:val="0000FF"/>');
    expect(xmlText).not.toContain('<w:u ');
  });

  it('escapes markup and keeps Turkish letters as they are', () => {
    const box = handMade({
      paragraphs: [
        {
          align: 'center',
          lineHeight: 12,
          lines: [{ runs: [run('Çalışma & <İş> "ğüşöç" ı', { font: 'Segoe "UI"' })] }],
        },
      ],
    });
    const xmlText = textBoxXml(box, 1, registry());
    expect(xmlText).toContain('Çalışma &amp; &lt;İş&gt; &quot;ğüşöç&quot; ı');
    expect(xmlText).toContain('w:ascii="Segoe &quot;UI&quot;"');
    expect(xmlText).toContain('<w:jc w:val="center"/>');
  });
});

describe('words written against words read back', () => {
  async function readBack(boxes: readonly TextBox[]): Promise<{ text: string; shared: DocxRegistry }> {
    const shared = new DocxRegistry();
    const body = `<w:p>${boxes.map((box) => textBoxXml(box, 1, shared)).join('')}</w:p>`;
    const links = shared.links
      .map(
        (link) =>
          `<Relationship Id="${link.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${link.uri}" TargetMode="External"/>`,
      )
      .join('');
    const bytes = await zipped({
      '[Content_Types].xml': contentTypesXml([]),
      '_rels/.rels': PACKAGE_RELS('word/document.xml'),
      'word/_rels/document.xml.rels': documentRelsXml([]).replace(
        '</Relationships>',
        `${links}</Relationships>`,
      ),
      'word/document.xml': wordDocumentXml(body, SHAPE_NAMESPACES),
      'word/styles.xml':
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
    });
    const copy = bytes.slice();
    const input = { buffer: copy, arrayBuffer: copy.buffer } as unknown as Parameters<
      typeof mammoth.extractRawText
    >[0];
    return { text: (await mammoth.extractRawText(input)).value, shared };
  }

  const count = (text: string) => (text.trim() === '' ? 0 : text.trim().split(/\s+/).length);

  it('counts what mammoth reads, line breaks, hyphens, links and Turkish text included', async () => {
    const layout = await layoutOf(
      [
        line('courier', 12, 40, 450, 'Özet rapor baslik'),
        line('courier', 10, 40, 420, 'bu satir tire ile bitiyor ya da sur-'),
        line('courier', 10, 40, 407, 'duruluyor ve burada devam eder'),
        line('courier', 10, 40, 394, 'ucuncu satir'),
        line('courier', 10, 40, 340, '• madde bir'),
        line('courier', 10, 40, 327, '• madde iki'),
      ].join('\n'),
    );
    const links: SceneLink[] = [{ box: [40, 50, 100, 90], uri: 'https://example.com' }];
    const boxes = textBoxes(layout, links);
    expect(boxes.length).toBeGreaterThan(1);
    const { text, shared } = await readBack(boxes);
    expect(count(text)).toBe(wordsInBoxes(boxes));
    expect(wordsInBoxes(boxes)).toBe(3 + 8 + 5 + 2 + 3 + 3);
    expect(shared.links.map((link) => link.uri)).toEqual(['https://example.com']);
  });

  it('counts a hand-made box of several paragraphs the same way', async () => {
    const boxes = [
      handMade(),
      handMade({
        paragraphs: [
          {
            align: 'both',
            lineHeight: 12,
            lines: [{ runs: [run('a-')] }, { runs: [run('b c'), run(' d')] }],
          },
          { align: 'right', lineHeight: 12, lines: [{ runs: [run('Çok güzel')] }] },
        ],
      }),
    ];
    const { text } = await readBack(boxes);
    expect(wordsInBoxes(boxes)).toBe(2 + 2 + 1 + 3 + 2);
    expect(count(text)).toBe(wordsInBoxes(boxes));
  });
});
