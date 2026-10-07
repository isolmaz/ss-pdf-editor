/**
 * Accessibility against real bytes: the check's facts, the tagger's structure tree over
 * real marked content, and the alt-text writer. The wrong answers that matter: a tree
 * whose MCIDs are not in the content stream, a heading that is not guessed from its size,
 * an image drawn by two pages whose alt text is reported for one, and a field tooltip
 * written as a name instead of text.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import type { PageTextInput, Rect } from 'pdf-text-engine';
import { describe, expect, it } from 'vitest';
import {
  checkAccessibility,
  claimsFor,
  engineFailure,
  expandToNesting,
  figureClaims,
  intOf,
  matchBlocks,
  nestingOf,
  numbersOf,
  type PagePlan,
  type PageTextReader,
  pageContent,
  pageNumbers,
  planPages,
  readInstructions,
  scanPage,
  setImageAlt,
  spliceMarkedContent,
  tagDocument,
  treeOrder,
} from './accessibility';
import type { OperationContext } from './types';

const run = { signal: new AbortController().signal };

/**
 * Two A4 pages. Page 1: a 24 pt heading, a 11 pt paragraph and an image `Im1`. Page 2:
 * another paragraph and the same image. A text field `ad` without a tooltip and a link
 * without `/Contents` complete the facts the check reads.
 */
async function fixture(): Promise<Uint8Array> {
  const mupdf = await import('mupdf');
  const doc = new mupdf.PDFDocument();
  const font = doc.addObject({
    Type: 'Font',
    Subtype: 'Type1',
    BaseFont: 'Helvetica',
    Encoding: 'WinAnsiEncoding',
  });
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 4, 4], false);
  pixmap.clear(0);
  const image = doc.addImage(new mupdf.Image(pixmap));
  const resources = { Font: { F: font }, XObject: { Im1: image } };
  const first =
    'BT /F 24 Tf 72 760 Td (Annual Report) Tj ET\n' +
    'BT /F 11 Tf 72 700 Td (The year was good for everyone involved.) Tj ET\n' +
    'q 100 0 0 100 72 500 cm /Im1 Do Q';
  const second =
    'BT /F 11 Tf 72 760 Td (Second page body text is here.) Tj ET\nq 50 0 0 50 72 600 cm /Im1 Do Q';
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, resources, first));
  doc.insertPage(1, doc.addPage([0, 0, 595, 842], 0, resources, second));
  const page = doc.findPage(0);
  const field = doc.addObject({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Tx',
    T: doc.newString('ad'),
    Rect: [72, 300, 272, 320],
    P: page,
  });
  const link = doc.addObject({ Type: 'Annot', Subtype: 'Link', Rect: [72, 200, 172, 220] });
  page.put('Annots', [field, link]);
  doc
    .getTrailer()
    .get('Root')
    .put('AcroForm', { Fields: [field] });
  const bytes = new Uint8Array(doc.saveToBuffer('').asUint8Array());
  doc.destroy();
  return bytes;
}

const states = (report: Awaited<ReturnType<typeof checkAccessibility>>) =>
  Object.fromEntries(report.findings.map((finding) => [finding.id, finding.state]));

describe('accessibility', () => {
  it('reports the facts of an untagged file, the shared image and the field by name', async () => {
    const report = await checkAccessibility(await fixture(), run);
    expect(report.pageCount).toBe(2);
    expect(states(report)).toMatchObject({
      'struct-tree': 'problem',
      'mark-info': 'problem',
      lang: 'problem',
      'image-alt': 'problem',
      'field-tooltip': 'problem',
      'link-contents': 'problem',
      paragraphs: 'unchecked',
    });
    expect(report.images).toHaveLength(1);
    expect(report.images[0]).toMatchObject({ pageIndex: 0, name: 'Im1', pages: [0, 1], alt: null, width: 4 });
    expect(report.fields).toEqual([{ name: 'ad', tooltip: null, pageIndex: 0 }]);
  });

  it('tags headings, paragraphs and figures over real marked content, then the check sees them', async () => {
    const out = await tagDocument(await fixture(), run, { language: 'tr-TR' });
    expect(out.report.steps).toEqual(['load', 'structure', 'producer', 'save', 'verify']);
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).toEqual(expect.arrayContaining(['op.note.a11y.tagged', 'op.note.a11y.langSet']));

    const report = await checkAccessibility(out.bytes, run);
    expect(states(report)).toMatchObject({
      'struct-tree': 'ok',
      'mark-info': 'ok',
      lang: 'ok',
      paragraphs: 'ok',
    });
    expect(report.structure.roles).toMatchObject({ Document: 1, H1: 1, P: 2, Figure: 2 });
    await expect(tagDocument(out.bytes, run)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('writes a structure tree whose MCRs, parent tree and content stream name the same MCIDs', async () => {
    const out = await tagDocument(await fixture(), run, { language: 'tr-TR' });
    const mupdf = await import('mupdf');
    const doc = mupdf.PDFDocument.openDocument(out.bytes.slice(), 'application/pdf').asPDF();
    if (doc === null) throw new Error('not a PDF');
    try {
      const root = doc.getTrailer().get('Root').get('StructTreeRoot');
      const kids = root.get('K').get(0).get('K');
      const parentTree = root.get('ParentTree').get('Nums');
      const elements: { role: string; mcid: number; page: number }[] = [];
      for (let index = 0; index < kids.length; index += 1) {
        const element = kids.get(index);
        const mcr = element.get('K').get(0);
        elements.push({
          role: element.get('S').asName(),
          mcid: mcr.get('MCID').asNumber(),
          page: (() => {
            const target = mcr.get('Pg').asIndirect();
            for (let candidate = 0; candidate < doc.countPages(); candidate += 1)
              if (doc.findPage(candidate).asIndirect() === target) return candidate;
            return -1;
          })(),
        });
      }
      expect(elements.map((element) => `${element.role}@${element.page}`).sort()).toEqual([
        'Figure@0',
        'Figure@1',
        'H1@0',
        'P@0',
        'P@1',
      ]);

      for (let pageIndex = 0; pageIndex < doc.countPages(); pageIndex += 1) {
        const content = doc.findPage(pageIndex).get('Contents');
        const stream = content.isArray() ? content.get(0) : content;
        const text = stream.readStream().asString();
        const started = [...text.matchAll(/\/P <<\/MCID (\d+)>> BDC/g)].map((match) => Number(match[1]));
        const written = elements
          .filter((element) => element.page === pageIndex)
          .map((element) => element.mcid);
        // Page 0 holds H1, P and a figure; page 1 a P and a figure (see the roles above).
        expect(written).toHaveLength(pageIndex === 0 ? 3 : 2);
        // Every MCR points at a marked-content sequence the page really has, and the page has no other.
        expect([...started].sort()).toEqual([...written].sort());
        // The parent tree is indexed by MCID and hands back the element that owns it.
        const structParents = doc.findPage(pageIndex).get('StructParents').asNumber();
        let entry = null;
        for (let at = 0; at < parentTree.length; at += 2)
          if (parentTree.get(at).asNumber() === structParents) entry = parentTree.get(at + 1);
        expect(entry).not.toBeNull();
        for (const mcid of written) {
          const owner = entry?.get(mcid);
          expect(owner?.get('K').get(0).get('MCID').asNumber()).toBe(mcid);
        }
      }
    } finally {
      doc.destroy();
    }
  });

  it('writes an alt text shared by every page that draws the image, and a Turkish tooltip', async () => {
    const out = await setImageAlt(
      await fixture(),
      [
        { kind: 'image', pageIndex: 1, name: 'Im1', alt: 'Şirket logosu' },
        { kind: 'field', name: 'ad', tooltip: 'Adınız ve soyadınız' },
        { kind: 'field', name: 'yok', tooltip: 'x' },
      ],
      run,
    );
    const keys = out.report.notes.map((entry) => entry.key);
    expect(keys).toEqual(
      expect.arrayContaining(['op.note.a11y.altSet', 'op.note.a11y.altShared', 'op.note.a11y.targetMissing']),
    );
    const report = await checkAccessibility(out.bytes, run);
    expect(report.images[0]?.alt).toBe('Şirket logosu');
    expect(report.fields[0]?.tooltip).toBe('Adınız ve soyadınız');
    await expect(
      setImageAlt(await fixture(), [{ kind: 'image', pageIndex: 0, name: 'Im1', alt: ' ' }], run),
    ).rejects.toMatchObject({ code: 'value-out-of-range' });
  });
});

describe('engineFailure', () => {
  it("hands back the caller's abort and a ToolError as they are, and maps anything else with the step that was running", () => {
    const abort = new Error('operation aborted');
    abort.name = 'AbortError';
    expect(engineFailure(abort, 'step')).toBe(abort);
    const known = new ToolError('corrupt-document', { engine: 'mupdf', engineMessage: 'broken' });
    expect(engineFailure(known, 'step')).toBe(known);
    const mapped = engineFailure(new Error('cannot open file'), 'check things');
    expect(mapped).toBeInstanceOf(ToolError);
    expect(mapped).toMatchObject({
      code: 'corrupt-document',
      details: { engineMessage: 'check things: cannot open file' },
    });
    expect(engineFailure('plain text', 'step')).toMatchObject({
      code: 'internal',
      details: { engineMessage: 'step: plain text' },
    });
  });
});

const bytesOf = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));
const operators = (text: string) => readInstructions(bytesOf(text))?.map((entry) => entry.operator);

describe('readInstructions', () => {
  it('splits a stream into instructions with their operands and byte ranges', () => {
    const text = 'q 1 0 0 1 5 5 cm /Name#20X gs\n(hi) Tj Q';
    const parsed = readInstructions(bytesOf(text));
    expect(parsed?.map((entry) => entry.operator)).toEqual(['q', 'cm', 'gs', 'Tj', 'Q']);
    expect(parsed?.[1]?.operands).toEqual([1, 0, 0, 1, 5, 5].map((number) => ({ kind: 'number', number })));
    expect(parsed?.[2]?.operands).toEqual([{ kind: 'name', name: 'Name X' }]);
    expect(parsed?.[3]?.operands).toEqual([{ kind: 'other' }]);
    expect(parsed?.map((entry) => text.slice(entry.start, entry.end))).toEqual([
      'q',
      '1 0 0 1 5 5 cm',
      '/Name#20X gs',
      '(hi) Tj',
      'Q',
    ]);
  });

  it('reads numbers with signs and a bare decimal point, and keeps a bad name escape as written', () => {
    const [first, second] = readInstructions(bytesOf('+1 -.5 3. .5 op /A#zz /B#41 op2')) ?? [];
    expect(first?.operands.map((operand) => (operand.kind === 'number' ? operand.number : null))).toEqual([
      1, -0.5, 3, 0.5,
    ]);
    expect(second?.operands).toEqual([
      { kind: 'name', name: 'A#zz' },
      { kind: 'name', name: 'BA' },
    ]);
  });

  it('skips comments up to the end of a line or of the stream', () => {
    expect(operators('% first\nq % trailing\rQ %no newline')).toEqual(['q', 'Q']);
  });

  it('delimits strings, hex strings, dictionaries and arrays without reading inside them', () => {
    expect(
      operators(
        '(a\\)b (nested) c) Tj <48 65> Tj <</A <</B 1>> /C [1 2]>> BDC [(x]) <5d> [1 [2]] <</K [3]>>] TJ',
      ),
    ).toEqual(['Tj', 'Tj', 'BDC', 'TJ']);
    expect(operators('(escaped backslash \\\\) Tj')).toEqual(['Tj']);
  });

  it('refuses a stream whose delimiters do not close or whose operands have no operator', () => {
    expect(readInstructions(bytesOf('(never closed Tj'))).toBeNull();
    expect(readInstructions(bytesOf('<48 65 Tj'))).toBeNull();
    expect(readInstructions(bytesOf('<</A <</B 1>> BDC'))).toBeNull();
    expect(readInstructions(bytesOf('[1 2 TJ'))).toBeNull();
    expect(readInstructions(bytesOf('[(a) [1 2'))).toBeNull();
    expect(readInstructions(bytesOf('1 2 3'))).toBeNull();
    expect(readInstructions(bytesOf('q ] Q'))).toBeNull();
    expect(readInstructions(bytesOf('q > Q'))).toBeNull();
    expect(readInstructions(bytesOf('q } Q'))).toBeNull();
    expect(readInstructions(bytesOf('q { Q'))).toBeNull();
    expect(readInstructions(bytesOf('q ) Q'))).toBeNull();
    expect(readInstructions(bytesOf('<</A <'))).toBeNull();
    expect(readInstructions(new Uint8Array())).toEqual([]);
  });

  it('ends an inline image at an EI between whitespace, and not at one inside its data', () => {
    const text = 'q BI /W 1 /H 1 /BPC 8 /CS /G ID aEIb EI x EI\nQ';
    const parsed = readInstructions(bytesOf(text));
    expect(parsed?.map((entry) => entry.operator)).toEqual(['q', 'BI', 'x', 'EI', 'Q']);
    expect(text.slice(parsed?.[1]?.start, parsed?.[1]?.end)).toBe('BI /W 1 /H 1 /BPC 8 /CS /G ID aEIb EI');
    // The terminator may be followed by a delimiter or by the end of the stream.
    expect(operators('BI /W 1 ID ab EI')).toEqual(['BI']);
    expect(operators('BI /W 1 ID ab EI(x) Tj')).toEqual(['BI', 'Tj']);
    // An inline image that never ends cannot be delimited.
    expect(readInstructions(bytesOf('BI /W 1 ID abc'))).toBeNull();
    expect(readInstructions(bytesOf('BI /W 1 ID abEI'))).toBeNull();
  });

  it('stops at a million instructions', () => {
    expect(readInstructions(bytesOf('q '.repeat(1_000_000)))?.length).toBe(1_000_000);
    expect(readInstructions(bytesOf('q '.repeat(1_000_001)))).toBeNull();
    expect(readInstructions(bytesOf('BI ID EI '.repeat(1_000_001)))).toBeNull();
  });
});

describe('numbersOf', () => {
  const instruction = readInstructions(bytesOf('1 2 /x 4 op'))?.[0] as NonNullable<
    ReturnType<typeof readInstructions>
  >[number];

  it('returns the leading operands when all of them are numbers', () => {
    expect(numbersOf(instruction, 2)).toEqual([1, 2]);
    expect(numbersOf(instruction, 0)).toEqual([]);
  });

  it('returns null for too few operands or a non-number among them', () => {
    expect(numbersOf(instruction, 5)).toBeNull();
    expect(numbersOf(instruction, 3)).toBeNull();
  });
});

describe('matchBlocks', () => {
  const region = (id: string, rect: [number, number, number, number], fontSize = 10) => ({
    id,
    rect,
    fontSize,
    bold: false,
    characters: 5,
    text: id,
  });
  const show = (index: number, x: number, y: number) => ({ index, x, y, fontSize: 10, fontName: null });
  const box = { x: 0, y: 0, width: 200, height: 100 };

  it('gives each show to the block whose ink box is nearest within its slack, flipping y into model space', () => {
    // A show at user y = 90 is model y = 10 (the box is 100 high).
    const regions = [region('a', [0, 0, 50, 20]), region('b', [100, 40, 150, 60])];
    const result = matchBlocks([show(0, 10, 90), show(1, 20, 90), show(2, 120, 50)], regions, box);
    expect(result.matches).toEqual([
      { blockIndex: 0, first: 0, last: 1, count: 2, shows: [0, 1] },
      { blockIndex: 1, first: 2, last: 2, count: 1, shows: [2] },
    ]);
    expect(result).toMatchObject({ matched: 3, unmatched: 0, ambiguous: 0 });
  });

  it('counts a show outside every slack as unmatched, whichever side of the block it is on', () => {
    const regions = [region('a', [50, 40, 100, 60])];
    // left, right, above and below the block (slack 5 pt for a 10 pt font); and inside.
    const result = matchBlocks(
      [show(0, 30, 50), show(1, 130, 50), show(2, 70, 100), show(3, 70, 0), show(4, 70, 50)],
      regions,
      box,
    );
    expect(result).toMatchObject({ matched: 1, unmatched: 4, ambiguous: 0 });
    expect(result.matches.map((entry) => entry.shows)).toEqual([[4]]);
  });

  it('accepts a show within the slack just outside the block, and prefers the nearer block', () => {
    const regions = [region('far', [0, 40, 40, 60]), region('near', [44, 40, 80, 60])];
    const result = matchBlocks([show(0, 43, 50)], regions, box);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.blockIndex).toBe(1);
    expect(result.ambiguous).toBe(0);
    const equal = matchBlocks(
      [show(0, 42, 50)],
      [region('left', [0, 40, 40, 60]), region('right', [44, 40, 80, 60])],
      box,
    );
    // Equidistant: the first block wins and the tie is counted.
    expect(equal.matches[0]?.blockIndex).toBe(0);
    expect(equal.ambiguous).toBe(1);
  });
});

describe('marked-content placement', () => {
  const parsed = (text: string) =>
    readInstructions(bytesOf(text)) as NonNullable<ReturnType<typeof readInstructions>>;

  it('records the text object and the q depth before every instruction', () => {
    const nesting = nestingOf(parsed('q BT (a) Tj ET Q Q BT ET'));
    expect(nesting.object).toEqual([-1, -1, 0, 0, -1, -1, -1, 1, -1]);
    expect(nesting.depth).toEqual([0, 1, 1, 1, 1, 0, 0, 0, 0]);
  });

  it('widens a range to whole text objects and whole q levels, or gives up when the stream does not balance', () => {
    const expand = (text: string, first: number, last: number) => {
      const instructions = parsed(text);
      return expandToNesting(instructions, nestingOf(instructions), first, last);
    };
    // Inside one text object the range stays as it is.
    expect(expand('BT (a) Tj (b) Tj ET', 1, 2)).toEqual({ first: 1, last: 2 });
    // Starting outside and ending inside a text object takes the whole object; so does the reverse.
    expect(expand('(a) Tj BT (b) Tj ET', 0, 2)).toEqual({ first: 0, last: 3 });
    expect(expand('BT (a) Tj ET (b) Tj', 1, 3)).toEqual({ first: 0, last: 3 });
    expect(expand('BT (a) Tj ET BT (b) Tj ET', 1, 4)).toEqual({ first: 0, last: 5 });
    // A text object that never ends cannot be wrapped.
    expect(expand('BT (a) Tj', 0, 1)).toBeNull();
    // A range that starts inside a q level and ends outside takes the whole level.
    expect(expand('q (a) Tj Q (b) Tj', 1, 3)).toEqual({ first: 0, last: 3 });
    // A range that opens a q level it does not close takes the rest of the level.
    expect(expand('(a) Tj q (b) Tj Q', 0, 2)).toEqual({ first: 0, last: 3 });
    expect(expand('(a) Tj q (b) Tj', 0, 2)).toBeNull();
    // Both together.
    expect(expand('q BT (a) Tj ET Q (b) Tj', 2, 5)).toEqual({ first: 0, last: 5 });
  });

  it('gives up on a nesting that names a text object or level the instructions do not hold', () => {
    const instructions = parsed('(a) Tj (b) Tj ET (c) Tj');
    const lies = (object: number[], depth: number[]) =>
      expandToNesting(instructions, { object, depth }, 1, 2);
    const outside = [0, 0, 0, 0, 0];
    // Claims the range starts inside text object 0, which no BT opens.
    expect(lies([-1, 0, 0, -1, -1], outside)).toBeNull();
    // Claims the range ends inside text object 0 with no ET after it.
    expect(lies([-1, -1, -1, 0, 0], outside)).toBeNull();
    // Claims a q level lower than the start's that is never reached before the range.
    expect(lies([-1, -1, -1, -1, -1], [5, 2, 0, 2, 2])).toBeNull();
    // Claims the range ends at a q level that is never left.
    expect(lies([-1, -1, -1, -1, -1], [0, 0, 0, 1, 1])).toBeNull();
  });

  it('inserts the sequences between the original bytes, which stay as they were', () => {
    const text = '(a) Tj (b) Tj';
    const instructions = parsed(text);
    const scan = { bytes: bytesOf(text), instructions, shows: [], draws: [] };
    const out = spliceMarkedContent(scan, [
      { first: 0, last: 0, role: 'P', blockId: 'b0', alt: null, mcid: 7 },
      { first: 1, last: 1, role: 'Artifact', blockId: 'b1', alt: null, mcid: -1 },
    ]);
    expect(Buffer.from(out.bytes).toString('latin1')).toBe(
      '\n/P <</MCID 7>> BDC\n(a) Tj\nEMC\n\n/Artifact BMC\n (b) Tj\nEMC\n',
    );
    expect(out).toMatchObject({ open: 2, close: 2 });
  });
});

const mupdf = await import('mupdf');

/** A PDF whose pages carry `contents`, built and saved with MuPDF's object model. */
function pdfOf(
  contents: readonly string[],
  options: {
    resources?: (doc: PDFDocument) => Record<string, unknown>;
    edit?: (doc: PDFDocument, pages: PDFObject[]) => void;
    save?: string;
  } = {},
): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const resources = options.resources?.(doc) ?? {};
  for (const [index, content] of contents.entries()) {
    doc.insertPage(index, doc.addPage([0, 0, 200, 200], 0, resources, content));
  }
  options.edit?.(
    doc,
    contents.map((_content, index) => doc.findPage(index)),
  );
  const bytes = new Uint8Array(doc.saveToBuffer(options.save ?? '').asUint8Array());
  doc.destroy();
  return bytes;
}

/** Open `bytes`, run `use` on the document and its pages, and release the document. */
function withPages<T>(bytes: Uint8Array, use: (doc: PDFDocument, pages: PDFObject[]) => T): T {
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF() as PDFDocument;
  try {
    return use(
      doc,
      Array.from({ length: doc.countPages() }, (_unused, index) => doc.findPage(index)),
    );
  } finally {
    doc.destroy();
  }
}

const UNDECODABLE = {
  Filter: 'FlateDecode',
  DecodeParms: { Predictor: 15, Columns: -5, Colors: 1000, BitsPerComponent: 99 },
};

describe('scanPage', () => {
  const scanOf = (content: string) =>
    withPages(pdfOf([content]), (_doc, pages) => scanPage(pages[0] as PDFObject));

  it('places every show operator in user space through the CTM, the text matrices and the leading', () => {
    const scan = scanOf(
      [
        'q 2 0 0 2 10 20 cm',
        'BT /F1 12 Tf 14 TL 5 6 Td (a) Tj',
        'T* (b) Tj',
        "(c) '",
        '1 2 (d) "',
        '1 0 0 1 3 4 Tm (e) Tj [(f)] TJ',
        '10 -10 TD (g) Tj T* (h) Tj',
        'ET Q Q',
      ].join('\n'),
    );
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    const placed = scan.scan.shows.map((show) => [show.x, show.y, show.fontSize, show.fontName]);
    expect(placed).toEqual([
      [20, 32, 12, 'F1'],
      [20, 4, 12, 'F1'],
      [20, -24, 12, 'F1'],
      [20, -52, 12, 'F1'],
      [16, 28, 12, 'F1'],
      [16, 28, 12, 'F1'],
      [36, 8, 12, 'F1'],
      [36, -12, 12, 'F1'],
    ]);
    // T* alone moves to the next line and shows nothing.
    expect(scan.scan.shows).toHaveLength(8);
  });

  it('ignores operators with operands of the wrong kind and a Q with nothing saved', () => {
    const scan = scanOf(
      'Q /x cm BT /F 10 Tf 1 2 Tf /G /y Tf TL /z TL /a b Td /a Tm 3 4 5 TL (a) Tj ET /Do Do 5 Do Do',
    );
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    // Each Tf sets only the operand of the right kind: the name from the first, the size from the second
    // (`/a b Td` is a `b` operator and a Td with no numbers, so the text origin stays put).
    expect(scan.scan.shows).toEqual([{ index: 12, x: 0, y: 0, fontSize: 2, fontName: 'G' }]);
    expect(scan.scan.draws).toEqual([{ index: 14, name: 'Do' }]);
  });

  it('collects the names the Do operators draw', () => {
    const scan = scanOf('/A Do q /B Do Q');
    expect(scan.ok && scan.scan.draws).toEqual([
      { index: 0, name: 'A' },
      { index: 2, name: 'B' },
    ]);
  });

  it('reports a page whose content cannot be decoded, or cannot be tokenized', () => {
    const undecodable = withPages(
      pdfOf(['x'], {
        edit: (doc, pages) =>
          pages[0]?.put('Contents', doc.addRawStream(new Uint8Array([1, 2, 3]), UNDECODABLE as never)),
      }),
      (_doc, pages) => scanPage(pages[0] as PDFObject),
    );
    expect(undecodable).toEqual({ ok: false, reason: 'decode' });
    expect(scanOf('q ] Q')).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('pageContent', () => {
  const contentOf = (edit: (doc: PDFDocument, page: PDFObject) => void) =>
    withPages(pdfOf(['x'], { edit: (doc, pages) => edit(doc, pages[0] as PDFObject) }), (_doc, pages) =>
      pageContent(pages[0] as PDFObject),
    );
  const text = (content: ReturnType<typeof pageContent>) =>
    content === null ? null : Buffer.from(content.bytes).toString('latin1');

  it('is empty for a page without /Contents', () => {
    expect(text(contentOf((_doc, page) => page.delete('Contents')))).toBe('');
  });

  it('joins a list of streams with a newline and skips entries that are null', () => {
    const joined = contentOf((doc, page) =>
      page.put('Contents', [doc.addStream('q', {}), doc.newNull(), doc.addStream('Q', {})] as never),
    );
    expect(text(joined)).toBe('q\nQ\n');
    expect(text(contentOf((doc, page) => page.put('Contents', doc.addStream('BT ET', {}))))).toBe('BT ET\n');
  });

  it('is null when a stream cannot be decoded or an entry is not a stream', () => {
    const undecodable = contentOf((doc, page) =>
      page.put('Contents', [
        doc.addStream('q', {}),
        doc.addRawStream(new Uint8Array([1]), UNDECODABLE as never),
      ] as never),
    );
    expect(undecodable).toBeNull();
    expect(contentOf((_doc, page) => page.put('Contents', 'NotAStream' as never))).toBeNull();
    expect(contentOf((doc, page) => page.put('Contents', doc.newInteger(5) as never))).toBeNull();
  });
});

const reportOf = (bytes: Uint8Array, context: OperationContext = run) => checkAccessibility(bytes, context);
const findingsOf = (report: Awaited<ReturnType<typeof reportOf>>, id: string) =>
  report.findings.filter((entry) => entry.id === id);
const catalogOf = (doc: PDFDocument) => doc.getTrailer().get('Root');

describe('checkAccessibility: document facts', () => {
  const edited = (edit: (doc: PDFDocument, root: PDFObject) => void) =>
    pdfOf(['0 0 1 1 re f'], { edit: (doc) => edit(doc, catalogOf(doc)) });

  it('reads the language, the Info title and the XMP title as separate facts', async () => {
    const bare = await reportOf(edited(() => {}));
    expect(findingsOf(bare, 'lang')).toMatchObject([{ state: 'problem' }]);
    expect(findingsOf(bare, 'title-info')).toMatchObject([{ state: 'problem', where: '/Info /Title' }]);
    expect(findingsOf(bare, 'title-xmp')).toMatchObject([{ state: 'problem', where: '/Metadata' }]);

    const set = await reportOf(
      edited((doc, root) => {
        root.put('Lang', doc.newString('tr-TR'));
        doc.getTrailer().put('Info', doc.addObject({ Title: doc.newString('Rapor') } as never));
        root.put(
          'Metadata',
          doc.addStream('<x:xmpmeta><dc:title><rdf:Alt/></dc:title></x:xmpmeta>', {
            Type: 'Metadata',
            Subtype: 'XML',
          }),
        );
      }),
    );
    expect(findingsOf(set, 'lang')).toMatchObject([{ state: 'ok', params: { lang: 'tr-TR' } }]);
    expect(findingsOf(set, 'title-info')).toMatchObject([{ state: 'ok' }]);
    expect(findingsOf(set, 'title-xmp')).toMatchObject([{ state: 'ok' }]);
  });

  it('names a packet with no dc:title, and counts a title written as an attribute', async () => {
    const packet = (text: string) =>
      edited((doc, root) => root.put('Metadata', doc.addStream(text, { Type: 'Metadata', Subtype: 'XML' })));
    const without = await reportOf(packet('<x:xmpmeta><dc:creator/></x:xmpmeta>'));
    expect(findingsOf(without, 'title-xmp')).toMatchObject([{ state: 'problem', where: 'dc:title' }]);
    const attribute = await reportOf(packet('<rdf:Description dc:title="T"/>'));
    expect(findingsOf(attribute, 'title-xmp')).toMatchObject([{ state: 'ok' }]);
    const unreadable = await reportOf(
      edited((doc, root) =>
        root.put('Metadata', doc.addRawStream(new Uint8Array([1, 2]), UNDECODABLE as never)),
      ),
    );
    expect(findingsOf(unreadable, 'title-xmp')).toMatchObject([{ state: 'problem', where: '/Metadata' }]);
  });

  it('tells a missing /MarkInfo from one without /Marked true', async () => {
    const markInfo = async (value: unknown) =>
      findingsOf(
        await reportOf(edited((_doc, root) => value === undefined || root.put('MarkInfo', value as never))),
        'mark-info',
      );
    expect(await markInfo(undefined)).toEqual([
      { id: 'mark-info', state: 'problem', key: 'op.a11y.check.markInfo' },
    ]);
    expect(await markInfo({ Marked: false })).toEqual([
      { id: 'mark-info', state: 'problem', key: 'op.a11y.check.markInfo', where: '/MarkInfo /Marked' },
    ]);
    expect(await markInfo({})).toMatchObject([{ where: '/MarkInfo /Marked' }]);
    expect(await markInfo({ Marked: true })).toEqual([
      { id: 'mark-info', state: 'ok', key: 'op.a11y.check.markInfoOk' },
    ]);
  });

  it('reports progress for every page and a closing event', async () => {
    const events: { done: number; total: number }[] = [];
    await reportOf(pdfOf(['q Q', 'q Q']), {
      signal: run.signal,
      onProgress: (event) => events.push({ done: event.done as number, total: event.total as number }),
    });
    expect(events).toEqual([0, 1, 2, 3].map((done) => ({ done, total: 3 })));
  });

  it('stops for an abort before the check or between pages, and names a document without a catalog', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(reportOf(pdfOf(['q Q']), { signal: aborted.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });

    const controller = new AbortController();
    const context = { signal: controller.signal, onProgress: () => controller.abort() };
    await expect(reportOf(pdfOf(['q Q', 'q Q']), context)).rejects.toMatchObject({ name: 'AbortError' });

    const noRoot = pdfOf(['q Q'], { edit: (doc) => doc.getTrailer().put('Root', doc.newNull() as never) });
    await expect(reportOf(noRoot)).rejects.toMatchObject({ code: 'corrupt-document' });
  });
});

describe('checkAccessibility: structure tree', () => {
  const withTree = (tree: (doc: PDFDocument, root: PDFObject) => unknown) =>
    pdfOf(['q Q'], {
      edit: (doc) => {
        const rootObject = doc.addObject({ Type: 'StructTreeRoot' } as never);
        const value = tree(doc, rootObject);
        if (value !== undefined) rootObject.put('K', value as never);
        catalogOf(doc).put('StructTreeRoot', rootObject);
      },
    });
  const element = (doc: PDFDocument, role: string | null, kids?: unknown) =>
    doc.addObject({
      Type: 'StructElem',
      ...(role === null ? {} : { S: role }),
      ...(kids === undefined ? {} : { K: kids }),
    } as never);

  it('counts the roles of the elements it can enter, and a single /K that is not a list', async () => {
    const report = await reportOf(
      withTree((doc) => [
        element(doc, 'P'),
        element(doc, 'H1', element(doc, 'P')),
        element(doc, null),
        3,
        doc.addObject({ Type: 'MCR' } as never),
      ]),
    );
    expect(report.structure).toEqual({
      present: true,
      readable: true,
      elementCount: 3,
      roles: { P: 2, H1: 1 },
      paragraphCount: 2,
      truncated: false,
    });
    expect(findingsOf(report, 'struct-tree')).toMatchObject([{ state: 'ok', params: { objects: 3 } }]);
    expect(findingsOf(report, 'paragraphs')).toMatchObject([{ state: 'ok', params: { count: 2 } }]);
  });

  it('says a tree with no paragraph has none, and one that is not a dictionary cannot be read', async () => {
    const noParagraph = await reportOf(withTree((doc) => [element(doc, 'H1')]));
    expect(findingsOf(noParagraph, 'paragraphs')).toMatchObject([{ state: 'problem' }]);
    const unreadable = await reportOf(
      pdfOf(['q Q'], { edit: (doc) => catalogOf(doc).put('StructTreeRoot', doc.newInteger(5) as never) }),
    );
    expect(unreadable.structure).toMatchObject({ present: true, readable: false, elementCount: 0 });
    expect(findingsOf(unreadable, 'paragraphs')).toMatchObject([{ state: 'unchecked' }]);
  });

  it('stops descending 64 levels down and says when it stopped counting', async () => {
    const deep = await reportOf(
      withTree((doc) => {
        let inner = element(doc, 'P');
        for (let level = 0; level < 70; level += 1) inner = element(doc, 'Div', inner);
        return inner;
      }),
    );
    expect(deep.structure.elementCount).toBe(65);
    expect(deep.structure.truncated).toBe(false);

    const wide = await reportOf(withTree((doc) => Array.from({ length: 4001 }, () => element(doc, 'P'))));
    expect(wide.structure).toMatchObject({ elementCount: 4000, paragraphCount: 4000, truncated: true });
    expect(findingsOf(wide, 'struct-tree').map((entry) => entry.state)).toEqual(['ok', 'unchecked']);
    expect(findingsOf(wide, 'struct-tree')[1]).toMatchObject({ params: { limit: 4000 } });
  });
});

describe('checkAccessibility: images', () => {
  const image = (doc: PDFDocument, extra: Record<string, unknown> = {}) =>
    doc.addRawStream(new Uint8Array(1), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 3,
      Height: 2,
      BitsPerComponent: 8,
      ColorSpace: 'DeviceGray',
      ...extra,
    } as never);
  const form = (doc: PDFDocument, content: string, resources?: Record<string, unknown>, extra = {}) =>
    doc.addStream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 10, 10],
      ...(resources === undefined ? {} : { Resources: resources }),
      ...extra,
    } as never);

  it('lists an image once for every page that draws it and reads its size and alt text', async () => {
    const report = await reportOf(
      pdfOf(['/Im Do /Im Do', '/Im Do'], {
        resources: (doc) => ({ XObject: { Im: image(doc, { Alt: doc.newString('A cat') }) } }),
      }),
    );
    expect(report.images).toEqual([
      {
        pageIndex: 0,
        name: 'Im',
        ref: expect.stringMatching(/^\d+ 0 R$/),
        pages: [0, 1],
        alt: 'A cat',
        width: 3,
        height: 2,
      },
    ]);
    expect(findingsOf(report, 'image-alt')).toMatchObject([{ state: 'ok', params: { count: 1 } }]);
  });

  it('finds the images a form draws, with the form’s own resources first and the page’s as a fallback', async () => {
    const report = await reportOf(
      pdfOf(['/Own Do /Inherit Do /Twice Do /Twice Do'], {
        resources: (doc) => {
          const inner = image(doc, { Width: 7 });
          const outer = image(doc, { Width: 9 });
          return {
            XObject: {
              Own: form(doc, '/Im Do', { XObject: { Im: inner } }),
              Inherit: form(doc, '/Out Do'),
              Out: outer,
              Twice: form(doc, '/Im2 Do', { XObject: { Im2: image(doc, { Width: 11 }) } }),
            },
          };
        },
      }),
    );
    expect(report.images.map((entry) => [entry.name, entry.width])).toEqual([
      ['Im', 7],
      ['Out', 9],
      ['Im2', 11],
    ]);
  });

  it('skips a Do that names no XObject, a non-stream, a form it cannot decode and one without resources of its own', async () => {
    const report = await reportOf(
      pdfOf(['/None Do /Num Do /Bad Do /Plain Do /Broken Do /Im Do'], {
        resources: (doc) => ({
          XObject: {
            Num: 5,
            Bad: doc.addRawStream(new Uint8Array([1]), {
              Type: 'XObject',
              Subtype: 'Form',
              BBox: [0, 0, 1, 1],
              ...UNDECODABLE,
            } as never),
            Plain: form(doc, 'q Q', undefined, { Subtype: 'Other' }),
            // A form whose content cannot be delimited hides what it would draw.
            Broken: form(doc, 'q ]', { XObject: { Hidden: image(doc, { Width: 5 }) } }),
            Im: image(doc),
          },
        }),
      }),
    );
    expect(report.images.map((entry) => entry.name)).toEqual(['Im']);
    const noResources = await reportOf(
      pdfOf(['/Im Do'], { edit: (_doc, pages) => pages[0]?.delete('Resources') }),
    );
    expect(noResources.images).toEqual([]);
  });

  it('does not follow forms nested more than twice and names the page', async () => {
    const chain = (levels: number) =>
      pdfOf(['/F Do'], {
        resources: (doc) => {
          let inner = form(doc, '/Im Do', { XObject: { Im: image(doc) } });
          for (let level = 1; level < levels; level += 1)
            inner = form(doc, '/F Do', { XObject: { F: inner } });
          return { XObject: { F: inner } };
        },
      });
    const two = await reportOf(chain(2));
    expect(two.images).toHaveLength(1);
    expect(findingsOf(two, 'images')).toEqual([]);
    const three = await reportOf(chain(3));
    expect(three.images).toEqual([]);
    expect(findingsOf(three, 'images')).toEqual([
      {
        id: 'images',
        state: 'unchecked',
        key: 'op.a11y.check.nestedTooDeep',
        pageIndex: 0,
        params: { page: 1, depth: 3 },
      },
    ]);
  });

  it('marks a page it cannot read as unchecked instead of reporting no images', async () => {
    const report = await reportOf(
      pdfOf(['q Q', 'q ] Q', 'q Q'], {
        edit: (doc, pages) =>
          pages[2]?.put('Contents', doc.addRawStream(new Uint8Array([1, 2]), UNDECODABLE as never)),
      }),
    );
    expect(findingsOf(report, 'images')).toEqual([
      {
        id: 'images',
        state: 'unchecked',
        key: 'op.a11y.check.pageUnreadable',
        pageIndex: 1,
        params: { page: 2 },
      },
      {
        id: 'images',
        state: 'unchecked',
        key: 'op.a11y.check.pageUnreadable',
        pageIndex: 2,
        params: { page: 3 },
      },
    ]);
  });

  it('clips the rows of images without alt text at forty and keeps counting', async () => {
    const report = await reportOf(
      pdfOf([Array.from({ length: 45 }, (_unused, index) => `/I${index} Do`).join(' ')], {
        resources: (doc) => ({
          XObject: Object.fromEntries(
            Array.from({ length: 45 }, (_unused, index) => [`I${index}`, image(doc)]),
          ),
        }),
      }),
    );
    expect(report.images).toHaveLength(45);
    const rows = findingsOf(report, 'image-alt');
    expect(rows).toHaveLength(41);
    expect(rows[40]).toMatchObject({ key: 'op.a11y.check.listClipped', params: { count: 45, shown: 40 } });
  });

  it('lists at most 2000 distinct images', async () => {
    const report = await reportOf(
      pdfOf([Array.from({ length: 2005 }, (_unused, index) => `/I${index} Do`).join(' ')], {
        resources: (doc) => ({
          XObject: Object.fromEntries(
            Array.from({ length: 2005 }, (_unused, index) => [`I${index}`, image(doc)]),
          ),
        }),
      }),
    );
    expect(report.images).toHaveLength(2000);
  });

  it('writes a long page list with an ellipsis after eight pages', async () => {
    const report = await reportOf(
      pdfOf(
        Array.from({ length: 9 }, () => '/Im Do'),
        { resources: (doc) => ({ XObject: { Im: image(doc) } }) },
      ),
    );
    expect(findingsOf(report, 'image-alt')).toMatchObject([
      { params: { name: 'Im', pages: '1, 2, 3, 4, 5, 6, 7, 8…', count: 9 } },
    ]);
  });
});

describe('checkAccessibility: fields and links', () => {
  const widget = (doc: PDFDocument, extra: Record<string, unknown> = {}) =>
    doc.addObject({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', Rect: [0, 0, 5, 5], ...extra } as never);
  const withFields = (fields: (doc: PDFDocument, page: PDFObject) => unknown[]) =>
    pdfOf(['q Q', 'q Q'], {
      edit: (doc, pages) => {
        catalogOf(doc).put('AcroForm', { Fields: fields(doc, pages[1] as PDFObject) } as never);
      },
    });

  it('names fields by their qualified name and finds the page a widget sits on, directly or through its kids', async () => {
    const report = await reportOf(
      withFields((doc, page) => {
        const kid = widget(doc, { P: page, TU: doc.newString('Tip') });
        return [
          doc.addObject({
            T: doc.newString('outer'),
            Kids: [doc.addObject({ T: doc.newString('inner'), FT: 'Tx', Kids: [kid] } as never)],
          } as never),
          widget(doc, { T: doc.newString('direct'), P: page }),
          widget(doc, { T: doc.newString('lost'), Kids: [doc.newInteger(2)] }),
          widget(doc, { T: doc.newString('noPage'), P: doc.newInteger(1) }),
          widget(doc, { T: doc.newString('elsewhere'), P: doc.addObject({ Type: 'Page' } as never) }),
          doc.addObject({ Kids: [widget(doc, { T: doc.newString('unnamedParent') })] } as never),
          widget(doc),
          doc.newInteger(5),
        ];
      }),
    );
    expect(report.fields).toEqual([
      { name: 'outer.inner', tooltip: 'Tip', pageIndex: 1 },
      { name: 'direct', tooltip: null, pageIndex: 1 },
      { name: 'lost', tooltip: null, pageIndex: null },
      { name: 'noPage', tooltip: null, pageIndex: null },
      { name: 'elsewhere', tooltip: null, pageIndex: null },
      { name: 'unnamedParent', tooltip: null, pageIndex: null },
    ]);
    const rows = findingsOf(report, 'field-tooltip');
    expect(rows[0]).toMatchObject({ pageIndex: 1, params: { name: 'direct' }, where: 'field direct' });
    expect(rows[1]).not.toHaveProperty('pageIndex');
  });

  it('says fields have tooltips when all do', async () => {
    const report = await reportOf(
      withFields((doc) => [widget(doc, { T: doc.newString('a'), TU: doc.newString('A') })]),
    );
    expect(findingsOf(report, 'field-tooltip')).toMatchObject([{ state: 'ok', params: { count: 1 } }]);
  });

  it('clips the rows of fields without a tooltip at forty, and says when the field walk stopped at its bound', async () => {
    const forty = await reportOf(
      withFields((doc) =>
        Array.from({ length: 45 }, (_unused, index) => widget(doc, { T: doc.newString(`f${index}`) })),
      ),
    );
    expect(findingsOf(forty, 'field-tooltip')).toHaveLength(41);
    expect(findingsOf(forty, 'field-tooltip')[40]).toMatchObject({
      key: 'op.a11y.check.listClipped',
      params: { count: 45, shown: 40 },
    });

    const many = await reportOf(
      withFields((doc) =>
        Array.from({ length: 3001 }, (_unused, index) =>
          widget(doc, { T: doc.newString(`f${index}`), TU: doc.newString('t') }),
        ),
      ),
    );
    expect(many.fields).toHaveLength(3000);
    expect(findingsOf(many, 'field-tooltip').at(-1)).toMatchObject({
      state: 'unchecked',
      key: 'op.a11y.check.fieldTreeTruncated',
      params: { limit: 3000 },
    });
  });

  it('stops for an abort while walking the fields', async () => {
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, 'aborted', { get: () => ++reads > 3 });
    await expect(
      reportOf(
        withFields((doc) => [widget(doc, { T: doc.newString('a') })]),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('counts links with and without /Contents, naming direct annotations with a question mark', async () => {
    const links = (contents: (string | null)[], extra: (doc: PDFDocument) => unknown[] = () => []) =>
      pdfOf(['q Q'], {
        edit: (doc, pages) =>
          pages[0]?.put('Annots', [
            ...contents.map((text) =>
              doc.addObject({
                Type: 'Annot',
                Subtype: 'Link',
                Rect: [0, 0, 5, 5],
                ...(text === null ? {} : { Contents: doc.newString(text) }),
              } as never),
            ),
            ...extra(doc),
          ] as never),
      });
    const ok = await reportOf(links(['Home']));
    expect(findingsOf(ok, 'link-contents')).toMatchObject([{ state: 'ok', params: { count: 1 } }]);
    const mixed = await reportOf(
      links(['Home', '  ', null], (doc) => [
        { Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 5, 5] },
        doc.addObject({ Type: 'Annot', Subtype: 'Text' } as never),
        doc.newInteger(3),
      ]),
    );
    expect(findingsOf(mixed, 'link-contents').map((entry) => entry.where)).toEqual([
      expect.stringMatching(/^annotation \d+ 0 R$/),
      expect.stringMatching(/^annotation \d+ 0 R$/),
      'annotation ?',
    ]);
    const clipped = await reportOf(links(Array.from({ length: 45 }, () => null)));
    expect(findingsOf(clipped, 'link-contents')).toHaveLength(41);
    expect(findingsOf(clipped, 'link-contents')[40]).toMatchObject({
      key: 'op.a11y.check.listClipped',
      params: { count: 45, shown: 40 },
    });
  });
});

describe('readInstructions: operands that follow other operands', () => {
  it('starts an instruction at its first operand whatever kind the later ones are', () => {
    const instructions = readInstructions(bytesOf('5 /Name 3 /Other (s) <</K 1>> [1] op')) ?? [];
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toMatchObject({ operator: 'op', start: 0 });
    expect(instructions[0]?.operands.map((operand) => operand.kind)).toEqual([
      'number',
      'name',
      'number',
      'name',
      'other',
      'other',
      'other',
    ]);
  });
});

describe('matchBlocks: a farther block inside the slack', () => {
  it('keeps the nearer block and does not count a block that is merely close as a tie', () => {
    const regions = [
      { id: 'near', rect: [0, 40, 40, 60] as Rect, fontSize: 10, bold: false, characters: 5, text: 'near' },
      {
        id: 'close',
        rect: [44, 40, 80, 60] as Rect,
        fontSize: 10,
        bold: false,
        characters: 5,
        text: 'close',
      },
    ];
    const result = matchBlocks([{ index: 0, x: 38, y: 50, fontSize: 10, fontName: null }], regions, {
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
    // 38 is inside "near" (distance 0) and 6 pt from "close", which is outside its 5 pt slack;
    // a 3 pt gap would be inside it but is neither nearer nor a tie.
    expect(result.matches.map((entry) => entry.blockIndex)).toEqual([0]);
    const closer = matchBlocks([{ index: 0, x: 41, y: 50, fontSize: 10, fontName: null }], regions, {
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
    expect(closer.matches.map((entry) => entry.blockIndex)).toEqual([0]);
    expect(closer.ambiguous).toBe(0);
  });
});

describe('expandToNesting: ranges that never settle', () => {
  it('gives up on a text object opened inside another one', () => {
    const instructions = readInstructions(bytesOf('BT BT ET')) ?? [];
    expect(expandToNesting(instructions, nestingOf(instructions), 1, 1)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Planning: the text model of every page against its content stream
 * ------------------------------------------------------------------ */

/** One text block as the extractor reports it: one glyph box per character, `size` points high. */
function blockInput(text: string, x: number, top: number, size: number, fontName = 'Helvetica') {
  const width = size / 2;
  const chars = [...text].map((ch, index) => ({
    ch,
    quad: [x + index * width, top, x + (index + 1) * width, top + size] as Rect,
    origin: [x + index * width, top + size * 0.8] as readonly [number, number],
    size,
    fontName,
  }));
  const quad = [x, top, x + chars.length * width, top + size] as Rect;
  return { quad, lines: [{ chars, quad, baseline: top + size * 0.8 }] };
}

const inputOf = (pageIndex: number, ...blocks: ReturnType<typeof blockInput>[]): PageTextInput => ({
  pageIndex,
  width: 200,
  height: 200,
  rotation: 0,
  blocks,
});

/** A reader that answers from a table: a page's input, an error to throw, or an empty page. */
const readerOf =
  (pages: Record<number, PageTextInput | Error>): PageTextReader =>
  async (_bytes, index) => {
    const entry = pages[index];
    if (entry instanceof Error) throw entry;
    return entry ?? inputOf(index);
  };

async function planned(
  bytes: Uint8Array,
  reader: PageTextReader,
  context: OperationContext = run,
): Promise<Awaited<ReturnType<typeof planPages>>> {
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF() as PDFDocument;
  try {
    return await planPages(doc, bytes, context, reader);
  } finally {
    doc.destroy();
  }
}

const HELLO = 'BT /F 12 Tf 10 150 Td (Hello) Tj ET';
/** Where HELLO's text sits in the model: a 12 pt block whose ink box holds the show point (10, 50). */
const HELLO_BLOCK = blockInput('Hello', 10, 40, 12);
const abortError = (): Error => Object.assign(new Error('operation aborted'), { name: 'AbortError' });

describe('planPages: the body size and the heading roles', () => {
  it('takes the size with the most characters as the body and ranks heading sizes from the largest', async () => {
    const reader = readerOf({
      0: inputOf(
        0,
        blockInput('x'.repeat(30), 10, 10, 10),
        blockInput('Medium', 10, 40, 12),
        blockInput('Big heading', 10, 60, 20),
        blockInput('Bold sub', 10, 90, 13, 'Helvetica-Bold'),
        blockInput('Bold small', 10, 110, 11, 'Helvetica-Bold'),
      ),
    });
    const result = await planned(pdfOf(['q Q']), reader);
    expect(result.body).toBe(10);
    // 20 pt is 2x the body; 13 pt bold is 1.3x (>= 1.2x for bold); 12 pt plain and 11 pt bold are not headings.
    expect([...result.roles]).toEqual([
      [20, 'H1'],
      [13, 'H2'],
    ]);
  });

  it('ignores blocks without a size and writes no more than six heading levels', async () => {
    const sizes = [22, 21, 20, 19, 18, 17, 16, 15];
    const reader = readerOf({
      0: inputOf(
        0,
        blockInput('x'.repeat(200), 10, 10, 10),
        // Rounds to 0 pt: no vote, and no heading.
        blockInput('tiny', 10, 30, 0.3),
        ...sizes.map((size, index) => blockInput('H', 10, 40 + index * 20, size)),
      ),
    });
    const result = await planned(pdfOf(['q Q']), reader);
    expect(result.body).toBe(10);
    expect([...result.roles]).toEqual([
      [22, 'H1'],
      [21, 'H2'],
      [20, 'H3'],
      [19, 'H4'],
      [18, 'H5'],
      [17, 'H6'],
    ]);
  });

  it('has no heading when all the text is too small to count as a size', async () => {
    const result = await planned(
      pdfOf(['q Q']),
      readerOf({ 0: inputOf(0, blockInput('tiny', 10, 10, 0.3)) }),
    );
    expect(result.body).toBe(0);
    expect(result.roles.size).toBe(0);
  });

  it('has no body size for a document without text', async () => {
    const result = await planned(pdfOf(['q Q']), readerOf({}));
    expect(result.body).toBe(0);
    expect(result.roles.size).toBe(0);
  });
});

describe('planPages: pages that cannot be tagged are named', () => {
  const withImage = (doc: PDFDocument): Record<string, unknown> => {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 2, 2], false);
    pixmap.clear(0);
    return { XObject: { Im: doc.addImage(new mupdf.Image(pixmap)) } };
  };

  it('names a page whose content cannot be decoded and one that cannot be tokenized', async () => {
    const bytes = pdfOf(['x', 'q ]'], {
      edit: (doc, pages) =>
        pages[0]?.put('Contents', doc.addRawStream(new Uint8Array([1, 2, 3]), UNDECODABLE as never)),
    });
    const result = await planned(bytes, readerOf({}));
    expect(result.plans).toEqual([]);
    expect(result.notes).toEqual([
      { kind: 'warning', key: 'op.note.a11y.pageUnreadable', params: { page: 1, reason: 'decode' } },
      { kind: 'warning', key: 'op.note.a11y.pageUnreadable', params: { page: 2, reason: 'malformed' } },
    ]);
  });

  it('names an empty page and a page whose text could not be read, and keeps a page that draws a picture', async () => {
    const bytes = pdfOf(['q Q', 'q Q', 'q 50 0 0 50 0 0 cm /Im Do Q'], {
      resources: withImage,
    });
    const result = await planned(
      bytes,
      readerOf({ 1: new Error('glyph walk failed'), 2: new Error('glyph walk failed') }),
    );
    expect(result.notes).toEqual([
      { kind: 'warning', key: 'op.note.a11y.pageNoBlocks', params: { page: 1 } },
      { kind: 'warning', key: 'op.note.a11y.textReadFailed', params: { page: 2 } },
    ]);
    // The third page's text failed to read as well, yet its picture is content: it stays in the plan.
    expect(result.plans.map((plan) => plan.pageIndex)).toEqual([2]);
    expect(result.plans[0]?.regions).toEqual([]);
    expect(result.plans[0]?.draws).toMatchObject([{ role: 'Figure', alt: null }]);
  });

  it('names a page none of whose text shows lands on a block', async () => {
    const result = await planned(
      pdfOf(['BT /F 12 Tf 150 20 Td (Far) Tj ET']),
      readerOf({ 0: inputOf(0, HELLO_BLOCK) }),
    );
    expect(result.plans).toEqual([]);
    expect(result.notes).toEqual([
      { kind: 'warning', key: 'op.note.a11y.pageUnmatched', params: { page: 1, blocks: 1, shows: 1 } },
    ]);
  });

  it('counts the shows that matched no block and the ones two blocks claimed at once', async () => {
    const stray = `${HELLO}\nBT /F 12 Tf 150 20 Td (Stray) Tj ET`;
    const overlapping = 'BT /F 12 Tf 10 150 Td (Both) Tj ET';
    const result = await planned(
      pdfOf([stray, overlapping]),
      readerOf({
        0: inputOf(0, HELLO_BLOCK),
        1: inputOf(1, blockInput('Both', 10, 40, 12), blockInput('Both', 10, 40, 12)),
      }),
    );
    expect(result.plans.map((plan) => plan.pageIndex)).toEqual([0, 1]);
    expect(result.notes).toEqual([
      {
        kind: 'warning',
        key: 'op.note.a11y.placement',
        params: { page: 1, matched: 1, ambiguous: 0, unmatched: 1 },
      },
      {
        kind: 'warning',
        key: 'op.note.a11y.placement',
        params: { page: 2, matched: 1, ambiguous: 1, unmatched: 0 },
      },
    ]);
  });

  it('stops planning at 5000 elements and says so', async () => {
    const figures = Array.from({ length: 5001 }, () => '/Im Do').join('\n');
    const result = await planned(pdfOf([figures, HELLO], { resources: withImage }), readerOf({}));
    expect(result.plans.map((plan) => plan.pageIndex)).toEqual([0]);
    expect(result.plans[0]?.draws).toHaveLength(5001);
    expect(result.notes).toEqual([
      { kind: 'warning', key: 'op.note.a11y.elementLimit', params: { limit: 5000 } },
    ]);
  });

  it('lets a caller abort pass through unchanged instead of naming a page', async () => {
    const abort = abortError();
    await expect(planned(pdfOf(['q Q']), readerOf({ 0: abort }))).rejects.toBe(abort);
  });
});

describe('claimsFor and treeOrder', () => {
  const imageResources = (doc: PDFDocument, alt?: string): Record<string, unknown> => {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 2, 2], false);
    pixmap.clear(0);
    const image = doc.addImage(new mupdf.Image(pixmap));
    if (alt !== undefined) image.put('Alt', doc.newString(alt));
    return { XObject: { Im: image } };
  };
  const planOf = async (content: string, input: PageTextInput, alt?: string) => {
    const result = await planned(
      pdfOf([content], { resources: (doc) => imageResources(doc, alt) }),
      readerOf({ 0: input }),
    );
    return { plan: result.plans[0] as PagePlan, roles: result.roles };
  };

  it('joins the shows of one block inside one text object into one claim', async () => {
    const { plan, roles } = await planOf(
      'BT /F 12 Tf 10 150 Td (A) Tj (B) Tj ET',
      inputOf(0, blockInput('AB', 10, 40, 12)),
    );
    expect(claimsFor(plan, roles)).toEqual({
      claims: [{ first: 3, last: 4, role: 'P', blockId: 'b0', alt: null, mcid: 0 }],
      skipped: 0,
    });
  });

  it('splits a block around another block’s show and keeps both pieces in one element', async () => {
    const content = 'BT /F 12 Tf 10 150 Td (A1) Tj 0 -50 Td (B) Tj 0 50 Td (A2) Tj ET';
    const { plan, roles } = await planOf(
      content,
      inputOf(0, blockInput('A1A2', 10, 40, 12), blockInput('B', 10, 90, 12)),
    );
    const { claims, skipped } = claimsFor(plan, roles);
    expect(skipped).toBe(0);
    expect(claims).toEqual([
      { first: 3, last: 3, role: 'P', blockId: 'b0', alt: null, mcid: 0 },
      { first: 5, last: 5, role: 'P', blockId: 'b1', alt: null, mcid: 1 },
      { first: 7, last: 7, role: 'P', blockId: 'b0', alt: null, mcid: 2 },
    ]);
    expect(treeOrder(claims)).toEqual([
      { role: 'P', blockId: 'b0', alt: null, mcids: [0, 2] },
      { role: 'P', blockId: 'b1', alt: null, mcids: [1] },
    ]);
  });

  it('applies the editor’s plan: roles, artifacts, element order and figure alt text', async () => {
    const content = 'BT /F 12 Tf 10 150 Td (A) Tj 0 -50 Td (B) Tj ET\nq 10 0 0 10 0 0 cm /Im Do Q';
    const { plan, roles } = await planOf(
      content,
      inputOf(0, blockInput('A', 10, 40, 12), blockInput('B', 10, 90, 12)),
      'Logo',
    );
    const figureId = `f${plan.draws[0]?.index}`;
    const pagePlan = {
      roles: { b0: 'H2', b1: 'Artifact', [figureId]: 'Bogus' },
      alts: { [figureId]: ' Company logo ' },
      order: ['zzz', figureId, 'b0'],
    };
    const { claims } = claimsFor(plan, roles, pagePlan);
    expect(claims.map((claim) => [claim.role, claim.mcid, claim.alt])).toEqual([
      ['H2', 0, null],
      ['Artifact', -1, null],
      // An unknown role falls back to the figure's own.
      ['Figure', 1, 'Company logo'],
    ]);
    expect(treeOrder(claims, pagePlan).map((group) => group.blockId)).toEqual([figureId, 'b0']);
    // Without the plan's alt the XObject's own /Alt is the figure's, and a blank plan alt does not erase it.
    expect(claimsFor(plan, roles).claims.at(-1)?.alt).toBe('Logo');
    expect(claimsFor(plan, roles, { alts: { [figureId]: '   ' } }).claims.at(-1)?.alt).toBe('Logo');
  });

  it('numbers the new marked content after the ids the stream already uses', async () => {
    const content = '/Span <</MCID 4>> BDC BT /F 12 Tf 10 150 Td (A) Tj ET EMC';
    const { plan, roles } = await planOf(content, inputOf(0, blockInput('A', 10, 40, 12)));
    expect(claimsFor(plan, roles).claims.map((claim) => claim.mcid)).toEqual([5]);
  });

  it('drops a picture drawn inside a run of text it would cut in half', async () => {
    const content = 'BT /F 12 Tf 10 150 Td (A) Tj /Im Do (B) Tj ET';
    const { plan, roles } = await planOf(content, inputOf(0, blockInput('AB', 10, 40, 12)));
    const { claims, skipped } = claimsFor(plan, roles);
    expect(claims.map((claim) => [claim.first, claim.last, claim.role])).toEqual([[3, 5, 'P']]);
    expect(skipped).toBe(1);
  });

  it('skips a run that no marked-content sequence can wrap because a q level never closes', async () => {
    const { plan, roles } = await planOf(
      'q BT /F 12 Tf 10 150 Td (A) Tj Q q (B) Tj ET',
      inputOf(0, blockInput('AB', 10, 40, 12)),
    );
    expect(claimsFor(plan, roles)).toEqual({ claims: [], skipped: 1 });
  });
});

describe('figureClaims', () => {
  const claimsOf = (
    content: string,
    resources: (doc: PDFDocument) => Record<string, unknown> | null,
  ): ReturnType<typeof figureClaims> =>
    withPages(
      pdfOf([content], {
        edit: (doc, pages) => {
          const made = resources(doc);
          if (made !== null) pages[0]?.put('Resources', made as never);
        },
      }),
      (_doc, pages) => {
        const scanned = scanPage(pages[0] as PDFObject);
        if (!scanned.ok) throw new Error('unreadable');
        return figureClaims(pages[0] as PDFObject, scanned.scan);
      },
    );

  it('finds no figure without XObject resources, for a name that is not a stream, or for a form', () => {
    expect(claimsOf('/Im Do', () => null)).toEqual([]);
    expect(
      withPages(
        pdfOf(['/Im Do'], { edit: (_doc, pages) => pages[0]?.delete('Resources') }),
        (_doc, pages) => {
          const scanned = scanPage(pages[0] as PDFObject);
          if (!scanned.ok) throw new Error('unreadable');
          return figureClaims(pages[0] as PDFObject, scanned.scan);
        },
      ),
    ).toEqual([]);
    expect(claimsOf('/Im Do', () => ({ XObject: { Other: 1 } }))).toEqual([]);
    expect(claimsOf('/Im Do', () => ({ XObject: { Im: 3 } }))).toEqual([]);
    expect(
      claimsOf('/Fm Do', (doc) => ({
        XObject: { Fm: doc.addStream('q Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }) },
      })),
    ).toEqual([]);
  });
});

describe('tagDocument: what the notes say', () => {
  const imageResources = (doc: PDFDocument): Record<string, unknown> => {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 2, 2], false);
    pixmap.clear(0);
    return {
      Font: { F: doc.addObject({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }) },
      XObject: { Im: doc.addImage(new mupdf.Image(pixmap)) },
    };
  };
  const keysOf = (outcome: Awaited<ReturnType<typeof tagDocument>>) =>
    outcome.report.notes.map((entry) => entry.key);
  const options = (pages: Record<number, PageTextInput | Error>, language?: string) => ({
    pageText: readerOf(pages),
    ...(language === undefined ? {} : { language }),
  });

  it('hands the file back untouched when no run of text can be wrapped', async () => {
    const bytes = pdfOf(['q BT /F 12 Tf 10 150 Td (A) Tj Q q (B) Tj ET'], { resources: imageResources });
    const outcome = await tagDocument(bytes, run, options({ 0: inputOf(0, blockInput('AB', 10, 40, 12)) }));
    expect(outcome.bytes).toBe(bytes);
    expect(outcome.report).toMatchObject({
      steps: ['load', 'text', 'scan'],
      incremental: true,
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount: 1,
    });
    expect(outcome.report.notes).toMatchObject([
      { key: 'op.note.a11y.pageOverlap', params: { page: 1, skipped: 1 } },
      { key: 'op.note.a11y.nothingTagged' },
      { key: 'op.note.metadata.producerKept' },
    ]);
  });

  it('says nothing about a page whose pictures name no image, and tags nothing', async () => {
    const bytes = pdfOf(['/Missing Do'], { resources: imageResources });
    const outcome = await tagDocument(bytes, run, options({}));
    expect(keysOf(outcome)).toEqual(['op.note.a11y.nothingTagged', 'op.note.metadata.producerKept']);
    expect(outcome.bytes).toBe(bytes);
  });

  it('names a picture that had to be dropped because it sits inside a run of text', async () => {
    const bytes = pdfOf(['BT /F 12 Tf 10 150 Td (A) Tj /Im Do (B) Tj ET'], { resources: imageResources });
    const outcome = await tagDocument(
      bytes,
      run,
      options({ 0: inputOf(0, blockInput('AB', 10, 40, 12)) }, 'tr'),
    );
    expect(outcome.report.notes).toContainEqual({
      kind: 'warning',
      key: 'op.note.a11y.pageOverlap',
      params: { page: 1, skipped: 1 },
    });
    const report = await checkAccessibility(outcome.bytes, run);
    expect(report.structure.roles).toMatchObject({ P: 1 });
    expect(report.structure.roles).not.toHaveProperty('Figure');
  });

  it('keeps the language the file has and writes none when it is not given one', async () => {
    const withLang = pdfOf([HELLO], {
      resources: imageResources,
      edit: (doc) => catalogOf(doc).put('Lang', doc.newString('de-DE')),
    });
    const kept = await tagDocument(withLang, run, options({ 0: inputOf(0, HELLO_BLOCK) }, 'tr-TR'));
    expect(kept.report.notes).toContainEqual({
      kind: 'preserved',
      key: 'op.note.a11y.langKept',
      params: { lang: 'de-DE' },
    });
    expect(findingsOf(await checkAccessibility(kept.bytes, run), 'lang')).toMatchObject([
      { state: 'ok', params: { lang: 'de-DE' } },
    ]);

    for (const language of [undefined, '   ']) {
      const bare = await tagDocument(
        pdfOf([HELLO], { resources: imageResources }),
        run,
        options({ 0: inputOf(0, HELLO_BLOCK) }, language),
      );
      expect(keysOf(bare)).toContain('op.note.a11y.langNoLanguage');
      expect(keysOf(bare)).not.toContain('op.note.a11y.langSet');
      expect(findingsOf(await checkAccessibility(bare.bytes, run), 'lang')).toMatchObject([
        { state: 'problem' },
      ]);
    }
  });

  it('counts the pictures that carry no alt text and the headings it guessed', async () => {
    const bytes = pdfOf(
      ['BT /F 24 Tf 10 150 Td (Title) Tj ET\nBT /F 10 Tf 10 100 Td (Body text goes here) Tj ET\n/Im Do'],
      {
        resources: imageResources,
      },
    );
    const outcome = await tagDocument(
      bytes,
      run,
      options({
        0: inputOf(0, blockInput('Title', 10, 26, 24), blockInput('Body text goes here', 10, 92, 10)),
      }),
    );
    expect(outcome.report.notes).toEqual(
      expect.arrayContaining([
        { kind: 'warning', key: 'op.note.a11y.headingGuess', params: { body: 10, count: 1 } },
        { kind: 'warning', key: 'op.note.a11y.figureNoAlt', params: { count: 1 } },
      ]),
    );
    const report = await checkAccessibility(outcome.bytes, run);
    expect(report.structure.roles).toMatchObject({ H1: 1, P: 1, Figure: 1 });
  });

  it('writes the editor’s plan: a heading role, an artifact without an element, a figure with its alt', async () => {
    const bytes = pdfOf(['BT /F 12 Tf 10 150 Td (A) Tj 0 -50 Td (B) Tj ET\nq 10 0 0 10 0 0 cm /Im Do Q'], {
      resources: imageResources,
    });
    const outcome = await tagDocument(bytes, run, {
      pageText: readerOf({ 0: inputOf(0, blockInput('A', 10, 40, 12), blockInput('B', 10, 90, 12)) }),
      plan: { pages: { 0: { roles: { b0: 'H3', b1: 'Artifact' }, alts: { f9: 'A logo' } } } },
    });
    const report = await checkAccessibility(outcome.bytes, run);
    expect(report.structure.roles).toMatchObject({ H3: 1, Figure: 1 });
    expect(report.structure.roles).not.toHaveProperty('P');
    expect(report.images[0]?.alt).toBeNull();
    const doc = mupdf.PDFDocument.openDocument(
      outcome.bytes.slice(),
      'application/pdf',
    ).asPDF() as PDFDocument;
    try {
      const kids = catalogOf(doc).get('StructTreeRoot').get('K').get(0).get('K');
      expect(kids.length).toBe(2);
      expect(kids.get(1).get('S').asName()).toBe('Figure');
      expect(kids.get(1).get('Alt').asString()).toBe('A logo');
      expect(kids.get(0).get('Alt').isNull()).toBe(true);
    } finally {
      doc.destroy();
    }
  });

  it('leaves the parent-tree slots of ids the stream already used empty', async () => {
    const bytes = pdfOf(['/Span <</MCID 2>> BDC BT /F 12 Tf 10 150 Td (Hello) Tj ET EMC'], {
      resources: imageResources,
    });
    const outcome = await tagDocument(bytes, run, options({ 0: inputOf(0, HELLO_BLOCK) }));
    const doc = mupdf.PDFDocument.openDocument(
      outcome.bytes.slice(),
      'application/pdf',
    ).asPDF() as PDFDocument;
    try {
      const slots = catalogOf(doc).get('StructTreeRoot').get('ParentTree').get('Nums').get(1);
      expect(Array.from({ length: slots.length }, (_unused, index) => slots.get(index).isNull())).toEqual([
        true,
        true,
        true,
        false,
      ]);
      const mcr = catalogOf(doc).get('StructTreeRoot').get('K').get(0).get('K').get(0).get('K').get(0);
      expect(mcr.get('MCID').asNumber()).toBe(3);
    } finally {
      doc.destroy();
    }
  });

  it('lets a caller abort during the page reads pass through the tagger unchanged', async () => {
    const abort = abortError();
    await expect(tagDocument(pdfOf(['q Q']), run, options({ 0: abort }))).rejects.toBe(abort);
  });

  it('refuses a file that already has a structure tree', async () => {
    const tagged = pdfOf([HELLO], {
      edit: (doc) => catalogOf(doc).put('StructTreeRoot', doc.addObject({ Type: 'StructTreeRoot' } as never)),
    });
    await expect(tagDocument(tagged, run, options({}))).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('setImageAlt', () => {
  const pictureOf = (doc: PDFDocument, extra: Record<string, unknown> = {}, side = 2) => {
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, side, side], false);
    pixmap.clear(0);
    const image = doc.addImage(new mupdf.Image(pixmap));
    for (const [key, value] of Object.entries(extra)) image.put(key, value as never);
    return image;
  };
  const image = (pageIndex: number, name: string, alt = 'Alt text') => ({
    kind: 'image' as const,
    pageIndex,
    name,
    alt,
  });

  it('refuses an empty tooltip or alt text by the field it was meant for', async () => {
    await expect(
      setImageAlt(pdfOf(['q Q']), [{ kind: 'field', name: 'a', tooltip: '  ' }], run),
    ).rejects.toMatchObject({ code: 'value-out-of-range', details: { path: 'edit.tooltip' } });
    await expect(setImageAlt(pdfOf(['q Q']), [image(0, 'Im', '')], run)).rejects.toMatchObject({
      code: 'value-out-of-range',
      details: { path: 'edit.alt' },
    });
  });

  it('hands the file back when no edit names anything, counting what it did not find', async () => {
    const bytes = pdfOf(['/Im Do'], { resources: (doc) => ({ XObject: { Im: pictureOf(doc) } }) });
    const outcome = await setImageAlt(
      bytes,
      [image(0, 'Nope'), { kind: 'field', name: 'missing', tooltip: 'x' }],
      run,
    );
    expect(outcome.bytes).toBe(bytes);
    expect(outcome.report).toMatchObject({ steps: ['load'], incremental: true, pageCount: 1 });
    expect(outcome.report.notes).toMatchObject([
      { key: 'op.note.image.noneFound', params: { count: 2 } },
      { key: 'op.note.metadata.producerKept' },
    ]);
  });

  it('does not find an image by a page that does not exist, a fractional page, a name that is no image or no stream', async () => {
    const bytes = pdfOf(['/Im Do /Fm Do'], {
      resources: (doc) => ({
        XObject: {
          Im: pictureOf(doc),
          Fm: doc.addStream('q Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] }),
          Num: 4,
        },
      }),
    });
    const outcome = await setImageAlt(
      bytes,
      [image(7, 'Im'), image(0.5, 'Im'), image(-1, 'Im'), image(0, 'Fm'), image(0, 'Num'), image(0, 'Im')],
      run,
    );
    expect(outcome.report.notes).toEqual(
      expect.arrayContaining([{ kind: 'warning', key: 'op.note.a11y.targetMissing', params: { count: 5 } }]),
    );
    const report = await checkAccessibility(outcome.bytes, run);
    expect(report.images[0]?.alt).toBe('Alt text');
  });

  it('finds nothing on a page without resources, and no field in a file without a form', async () => {
    const bare = pdfOf(['q Q'], { edit: (_doc, pages) => pages[0]?.delete('Resources') });
    const outcome = await setImageAlt(
      bare,
      [image(0, 'Im'), { kind: 'field', name: 'a', tooltip: 't' }],
      run,
    );
    expect(outcome.report.notes[0]).toMatchObject({ key: 'op.note.image.noneFound', params: { count: 2 } });
    const empty = await setImageAlt(pdfOf(['q Q']), [image(0, 'Im')], run);
    expect(empty.report.notes[0]).toMatchObject({ key: 'op.note.image.noneFound', params: { count: 1 } });
  });

  it('warns when the image is in the resources but no content stream draws it', async () => {
    const bytes = pdfOf(['q Q'], { resources: (doc) => ({ XObject: { Im: pictureOf(doc) } }) });
    const outcome = await setImageAlt(bytes, [image(0, 'Im')], run);
    expect(outcome.report.notes).toEqual(
      expect.arrayContaining([
        { kind: 'warning', key: 'op.note.a11y.altNotDrawn', params: { name: 'Im', page: 1 } },
      ]),
    );
    expect(outcome.report.steps).toEqual(['load', 'alt', 'producer', 'save', 'verify']);
  });

  it('names the pages that draw the image, skipping pages it cannot read and other pictures', async () => {
    const bytes = pdfOf(['/Im Do', 'q ]', 'x', '/Other Do /Im Do'], {
      resources: (doc) => ({ XObject: { Im: pictureOf(doc), Other: pictureOf(doc, {}, 3) } }),
      edit: (doc, pages) =>
        pages[2]?.put('Contents', doc.addRawStream(new Uint8Array([1, 2, 3]), UNDECODABLE as never)),
    });
    const outcome = await setImageAlt(bytes, [image(0, 'Im')], run);
    expect(outcome.report.notes).toEqual(
      expect.arrayContaining([
        {
          kind: 'changed',
          key: 'op.note.a11y.altSet',
          params: { name: 'Im', page: 1, alt: 'Alt text', pages: '1, 4' },
        },
        { kind: 'warning', key: 'op.note.a11y.altShared', params: { name: 'Im', count: 2, pages: '1, 4' } },
      ]),
    );
  });

  it('writes a tooltip on a nested field and finds a field by its qualified name only', async () => {
    const bytes = pdfOf(['q Q'], {
      edit: (doc) => {
        const leaf = doc.addObject({ T: doc.newString('leaf'), FT: 'Tx' } as never);
        const widgetWithKids = doc.addObject({
          Subtype: 'Widget',
          T: doc.newString('w'),
          Kids: [doc.addObject({ T: doc.newString('hidden') } as never)],
        } as never);
        catalogOf(doc).put('AcroForm', {
          Fields: [
            doc.newInteger(3),
            doc.addObject({ T: doc.newString('empty'), Kids: [doc.newInteger(1)] } as never),
            doc.addObject({ T: doc.newString('group'), Kids: [leaf] } as never),
            doc.addObject({
              Kids: [doc.addObject({ T: doc.newString('anon'), FT: 'Tx' } as never)],
            } as never),
            widgetWithKids,
          ],
        } as never);
      },
    });
    const outcome = await setImageAlt(
      bytes,
      [
        { kind: 'field', name: 'group.leaf', tooltip: 'Leaf' },
        { kind: 'field', name: 'leaf', tooltip: 'unqualified' },
        { kind: 'field', name: 'w.hidden', tooltip: 'under a widget' },
        { kind: 'field', name: 'anon', tooltip: 'Under an unnamed parent' },
      ],
      run,
    );
    expect(outcome.report.notes).toEqual(
      expect.arrayContaining([
        { kind: 'changed', key: 'op.note.a11y.tooltipSet', params: { name: 'group.leaf', tooltip: 'Leaf' } },
        {
          kind: 'changed',
          key: 'op.note.a11y.tooltipSet',
          params: { name: 'anon', tooltip: 'Under an unnamed parent' },
        },
        { kind: 'warning', key: 'op.note.a11y.targetMissing', params: { count: 2 } },
      ]),
    );
    expect((await checkAccessibility(outcome.bytes, run)).fields).toEqual([
      { name: 'group.leaf', tooltip: 'Leaf', pageIndex: null },
      { name: 'anon', tooltip: 'Under an unnamed parent', pageIndex: null },
      { name: 'w', tooltip: null, pageIndex: null },
    ]);
  });

  it('finds no field in a form without a field list, and stops 32 levels down', async () => {
    const noList = pdfOf(['q Q'], { edit: (doc) => catalogOf(doc).put('AcroForm', { Fields: 3 } as never) });
    expect(
      (await setImageAlt(noList, [{ kind: 'field', name: 'a', tooltip: 't' }], run)).report.notes[0],
    ).toMatchObject({ key: 'op.note.image.noneFound' });
    const deep = pdfOf(['q Q'], {
      edit: (doc) => {
        let kids: unknown[] = [doc.addObject({ T: doc.newString('end') } as never)];
        for (let level = 0; level < 34; level += 1) {
          kids = [doc.addObject({ T: doc.newString(`n${level}`), Kids: kids } as never)];
        }
        catalogOf(doc).put('AcroForm', { Fields: kids } as never);
      },
    });
    const name = `${Array.from({ length: 34 }, (_unused, level) => `n${33 - level}`).join('.')}.end`;
    expect(
      (await setImageAlt(deep, [{ kind: 'field', name, tooltip: 't' }], run)).report.notes[0],
    ).toMatchObject({ key: 'op.note.image.noneFound' });
  });

  it('stops for an abort between two edits, and names a document without a catalog', async () => {
    const controller = new AbortController();
    let reads = 0;
    Object.defineProperty(controller.signal, 'aborted', { get: () => ++reads > 1 });
    await expect(
      setImageAlt(pdfOf(['q Q']), [image(0, 'Im')], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    const noRoot = pdfOf(['q Q'], { edit: (doc) => doc.getTrailer().put('Root', doc.newNull() as never) });
    await expect(setImageAlt(noRoot, [image(0, 'Im')], run)).rejects.toMatchObject({
      code: 'corrupt-document',
    });
  });
});

describe('small readers', () => {
  it('reads an integer entry, and nothing from a missing or non-numeric one', () => {
    withPages(
      pdfOf(['q Q'], { edit: (doc, pages) => pages[0]?.put('Rotate', doc.newInteger(90)) }),
      (_doc, pages) => {
        const page = pages[0] as PDFObject;
        expect(intOf(page, 'Rotate')).toBe(90);
        expect(intOf(page, 'Missing')).toBeNull();
        expect(intOf(page, 'Type')).toBeNull();
        expect(intOf(null, 'Rotate')).toBeNull();
      },
    );
  });

  it('maps only indirect pages to their index', () => {
    withPages(pdfOf(['q Q', 'q Q']), (doc, pages) => {
      const direct = doc.newDictionary();
      const map = pageNumbers([pages[0] as PDFObject, direct, pages[1] as PDFObject]);
      expect([...map.values()]).toEqual([0, 2]);
    });
  });
});
