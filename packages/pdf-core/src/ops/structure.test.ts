/**
 * The tag editor against real bytes. Each edit is written to a tagged file and the result is read
 * back two ways that do not share the writer's code: the structure model (compared with what the
 * pure edit semantics say it must be) and MuPDF's raw object model and content stream.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import type { PageTextInput, Rect } from 'pdf-text-engine';
import { describe, expect, it } from 'vitest';
import { pageContent } from './accessibility';
import { checkPdfUa } from './pdfua';
import { editStructure, readPageLayout, readStructure, readTagCandidates, resourceHooks } from './structure';
import {
  applyStructureEdits,
  findNode,
  readingOrder,
  type StructEdit,
  type StructNode,
  type StructureModel,
  structureSignature,
} from './structure-model';
import { buildTagged, tagged } from './tagged.fixtures';
import { run, taggedFixture, untaggedFixture } from './ua.fixtures';

const BASE = 'Document(H1(#0:0),P(#0:1),Figure(#0:2),P(#1:0),Figure(#1:1))';

/** Keys of the tagged fixture's elements, found by role and marked-content id, never by number. */
function keysOf(model: StructureModel) {
  const document = model.roots[0];
  if (document === undefined) throw new Error('no Document element');
  const kids = document.kids.flatMap((kid) => (kid.kind === 'element' ? [kid.node] : []));
  const at = (index: number): string => (kids[index] as (typeof kids)[number]).key;
  return { document: document.key, h1: at(0), p1: at(1), figure1: at(2), p2: at(3), figure2: at(4) };
}

async function open(bytes: Uint8Array): Promise<PDFDocument> {
  const mupdf = await import('mupdf');
  const doc = mupdf.PDFDocument.openDocument(bytes.slice(), 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  return doc;
}

/** The roles of the Document element's children, read from the raw object model. */
function documentRoles(doc: PDFDocument): string[] {
  const document = doc.getTrailer().get('Root').get('StructTreeRoot').get('K').get(0);
  const kids = document.get('K');
  const roles: string[] = [];
  for (let index = 0; index < kids.length; index += 1) roles.push(kids.get(index).get('S').asName());
  return roles;
}

const objectOf = (doc: PDFDocument, number: number): PDFObject => doc.newIndirect(number).resolve();

describe('readStructure', () => {
  it('reads the tree the tagger wrote and reports an untagged file as having none', async () => {
    const view = await readStructure(await taggedFixture(), run);
    expect(view.pageCount).toBe(2);
    expect(view.model.readable).toBe(true);
    expect(structureSignature(view.model)).toBe(BASE);
    expect(readingOrder(view.model).map((entry) => entry.role)).toEqual(['H1', 'P', 'Figure', 'P', 'Figure']);

    const untagged = await readStructure(await untaggedFixture(), run);
    expect(untagged.model.present).toBe(false);
    expect(untagged.model.roots).toEqual([]);
  });
});

describe('editStructure', () => {
  it('reorders and retypes, and the file reads back as the edit says, tree and raw objects alike', async () => {
    const tagged = await taggedFixture();
    const base = (await readStructure(tagged, run)).model;
    const keys = keysOf(base);
    const edits: StructEdit[] = [
      { op: 'move', key: keys.figure2, parentKey: keys.document, index: 0 },
      { op: 'role', key: keys.p1, role: 'H2' },
    ];
    const out = await editStructure(tagged, edits, run);
    expect(out.report.steps).toEqual(['load', 'tags', 'producer', 'save', 'verify']);

    const expected = structureSignature(applyStructureEdits(base, edits));
    expect(expected).toBe('Document(Figure(#1:1),H1(#0:0),H2(#0:1),Figure(#0:2),P(#1:0))');
    expect(structureSignature((await readStructure(out.bytes, run)).model)).toBe(expected);

    const doc = await open(out.bytes);
    try {
      expect(documentRoles(doc)).toEqual(['Figure', 'H1', 'H2', 'Figure', 'P']);
    } finally {
      doc.destroy();
    }
  });

  it('writes alt text that a second reader finds, and the PDF/UA figure rule follows it', async () => {
    const tagged = await taggedFixture();
    const keys = keysOf((await readStructure(tagged, run)).model);
    const before = await checkPdfUa(tagged, run);
    expect(before.rules.find((rule) => rule.id === 'figure-alt')?.count).toBe(2);

    const out = await editStructure(
      tagged,
      [{ op: 'alt', key: keys.figure1, alt: 'Revenue by quarter' }],
      run,
    );
    const doc = await open(out.bytes);
    try {
      const figure = objectOf(doc, Number(keys.figure1.slice(1)));
      expect(figure.get('S').asName()).toBe('Figure');
      expect(figure.get('Alt').asString()).toBe('Revenue by quarter');
    } finally {
      doc.destroy();
    }
    const after = await checkPdfUa(out.bytes, run);
    expect(after.rules.find((rule) => rule.id === 'figure-alt')?.count).toBe(1);
  });

  it('groups elements under a new one whose children point back at it', async () => {
    const tagged = await taggedFixture();
    const base = (await readStructure(tagged, run)).model;
    const keys = keysOf(base);
    const edits: StructEdit[] = [{ op: 'group', keys: [keys.p1, keys.figure1], role: 'Sect', newKey: 'n1' }];
    const out = await editStructure(tagged, edits, run);

    const view = (await readStructure(out.bytes, run)).model;
    expect(structureSignature(view)).toBe(
      'Document(H1(#0:0),Sect(P(#0:1),Figure(#0:2)),P(#1:0),Figure(#1:1))',
    );
    const doc = await open(out.bytes);
    try {
      expect(documentRoles(doc)).toEqual(['H1', 'Sect', 'P', 'Figure']);
      const sect = doc.getTrailer().get('Root').get('StructTreeRoot').get('K').get(0).get('K').get(1);
      const members = sect.get('K');
      expect(members.length).toBe(2);
      for (let index = 0; index < members.length; index += 1) {
        // Every child's /P names the new element, not the old parent.
        expect(members.get(index).get('P').asIndirect()).toBe(sect.asIndirect());
      }
    } finally {
      doc.destroy();
    }
  });

  it('turns an element into an artifact: its marked content is rewritten and the file still checks as tagged', async () => {
    const tagged = await taggedFixture();
    const keys = keysOf((await readStructure(tagged, run)).model);
    const doc0 = await open(tagged);
    let beforeText: string;
    try {
      beforeText = new TextDecoder('latin1').decode(
        pageContent(doc0.findPage(0))?.bytes ?? new Uint8Array(0),
      );
    } finally {
      doc0.destroy();
    }
    expect(beforeText).toContain('/MCID 2');

    const out = await editStructure(tagged, [{ op: 'artifact', key: keys.figure1 }], run);
    expect(out.report.steps).toContain('tags.artifact');

    const doc = await open(out.bytes);
    try {
      const text = new TextDecoder('latin1').decode(pageContent(doc.findPage(0))?.bytes ?? new Uint8Array(0));
      expect(text).not.toContain('/MCID 2');
      expect(text).toContain('/Artifact');
      expect(documentRoles(doc)).toEqual(['H1', 'P', 'P', 'Figure']);
    } finally {
      doc.destroy();
    }
    const view = (await readStructure(out.bytes, run)).model;
    expect(findNode(view, keys.figure1)).toBeNull();
    const report = await checkPdfUa(out.bytes, run);
    const states = Object.fromEntries(report.rules.map((rule) => [rule.id, rule.state]));
    expect(states).toMatchObject({
      'tagged-content': 'pass',
      'mcid-references': 'pass',
      'struct-tree': 'pass',
    });
  });

  it('refuses an empty draft, an invalid role and an untagged file before writing anything', async () => {
    const tagged = await taggedFixture();
    const keys = keysOf((await readStructure(tagged, run)).model);
    await expect(editStructure(tagged, [], run)).rejects.toMatchObject({ code: 'selection-empty' });
    await expect(
      editStructure(tagged, [{ op: 'role', key: keys.p1, role: 'Banana' }], run),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      editStructure(tagged, [{ op: 'alt', key: keys.figure1, alt: '  ' }], run),
    ).rejects.toMatchObject({ code: 'value-out-of-range' });
    await expect(
      editStructure(await untaggedFixture(), [{ op: 'role', key: 'o1', role: 'P' }], run),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('refuses to take an element out of a parent the file holds as a direct dictionary', async () => {
    const { bytes } = await buildTagged({
      pages: [{ content: tagged('P', 0, 'BT /F1 12 Tf 10 100 Td (Alpha) Tj ET') }],
      tree: [{ s: 'Document', direct: true, k: [{ s: 'P', k: [0] }] }],
    });
    const model = (await readStructure(bytes, run)).model;
    const document = model.roots[0];
    const kid = document?.kids[0];
    if (document === undefined || kid === undefined || kid.kind !== 'element')
      throw new Error('unexpected model');
    expect(document.key.startsWith('o')).toBe(false);
    expect(kid.node.key.startsWith('o')).toBe(true);
    await expect(editStructure(bytes, [{ op: 'artifact', key: kid.node.key }], run)).rejects.toMatchObject({
      code: 'selection-empty',
    });
  });
});

/* ------------------------------------------------------------------ *
 * Reading order and layout
 * ------------------------------------------------------------------ */

const HELV = { F1: { dict: { Subtype: 'Type1', BaseFont: 'Helvetica' } } };
const shown = (x: number, y: number, text: string, size = 12): string =>
  `BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET`;

/** A one-line page text with one glyph per character, laid out on `baseline` from `x`. */
function lineOf(
  text: string,
  x: number,
  baseline: number,
  size = 12,
  width = 400,
  height = 200,
): PageTextInput {
  const chars = [...text].map((ch, index) => {
    const left = x + index * 6;
    return {
      ch,
      quad: [left, baseline - size * 0.8, left + 6, baseline + size * 0.2] as Rect,
      origin: [left, baseline] as readonly [number, number],
      size,
      fontName: 'Helvetica',
    };
  });
  const quad: Rect = [x, baseline - size * 0.8, x + chars.length * 6, baseline + size * 0.2];
  return {
    pageIndex: 0,
    width,
    height,
    rotation: 0,
    blocks: [{ quad, lines: [{ chars, quad, baseline }] }],
  };
}

describe('resourceHooks', () => {
  async function resources(): Promise<{ doc: PDFDocument; dict: PDFObject }> {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    const form = (extra: Record<string, unknown>) =>
      doc.addStream('0 0 m', { Type: 'XObject', Subtype: 'Form', ...extra } as never);
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 2, 2], false);
    pixmap.clear(0);
    const dict = doc.addObject({
      Properties: { MC0: { MCID: 7 }, Plain: { Other: 1 }, NotADict: 3 },
      XObject: {
        Im: doc.addImage(new mupdf.Image(pixmap)),
        Fm: form({ BBox: [0, 0, 10, 20], Matrix: [2, 0, 0, 2, 5, 6] }),
        Bare: form({}),
        Short: form({ BBox: [0, 0, 10], Matrix: [1, 0, 0] }),
        Ps: doc.addStream('x', { Type: 'XObject', Subtype: 'PS' } as never),
        NotStream: doc.addObject({ Subtype: 'Form' } as never),
      },
    } as never);
    return { doc, dict };
  }

  it('reads the MCID of a named property list, and nothing when the list or its MCID is missing', async () => {
    const { doc, dict } = await resources();
    const hooks = resourceHooks(dict);
    expect(hooks.properties?.('MC0')).toBe(7);
    expect(hooks.properties?.('Plain')).toBeNull();
    expect(hooks.properties?.('NotADict')).toBeNull();
    expect(hooks.properties?.('Absent')).toBeNull();
    doc.destroy();
  });

  it('describes the XObjects a Do can name: images, forms with their box and matrix, and the rest', async () => {
    const { doc, dict } = await resources();
    const hooks = resourceHooks(dict);
    expect(hooks.xobject?.('Im')).toEqual({ kind: 'image' });
    expect(hooks.xobject?.('Fm')).toEqual({
      kind: 'form',
      bbox: [0, 0, 10, 20],
      matrix: [2, 0, 0, 2, 5, 6],
    });
    expect(hooks.xobject?.('Bare')).toEqual({ kind: 'form' });
    // A box or matrix with too few numbers is not a box or a matrix.
    expect(hooks.xobject?.('Short')).toEqual({ kind: 'form' });
    expect(hooks.xobject?.('Ps')).toEqual({ kind: 'other' });
    expect(hooks.xobject?.('NotStream')).toBeNull();
    expect(hooks.xobject?.('Absent')).toBeNull();
    doc.destroy();
  });

  it('knows nothing of a page without resources', async () => {
    const mupdf = await import('mupdf');
    const doc = new mupdf.PDFDocument();
    const hooks = resourceHooks(null);
    expect(hooks.properties?.('MC0')).toBeNull();
    expect(hooks.xobject?.('Im')).toBeNull();
    doc.destroy();
  });
});

describe('readPageLayout', () => {
  const none = async (): Promise<PageTextInput> => lineOf('', 0, 0);

  it('numbers the blocks of a tagged page with their text and where they sit', async () => {
    const layout = await readPageLayout(await taggedFixture(), 0, run);
    expect(layout).toMatchObject({
      pageIndex: 0,
      width: 595,
      height: 842,
      rotation: 0,
      textFailed: false,
      unreadable: false,
    });
    expect(layout.items.map((item) => [item.mcid, item.text])).toEqual([
      [0, 'Annual Report'],
      [1, 'The year was good for everyone involved.'],
      [2, ''],
    ]);
    const [heading, body, figure] = layout.items;
    // The picture's box is the unit square under `100 0 0 100 72 500 cm`, y down from the top.
    expect(figure?.rect).toEqual([72, 242, 172, 342]);
    expect(heading?.rect?.[0]).toBeCloseTo(72, 0);
    expect(heading?.rect?.[3]).toBeLessThan(body?.rect?.[1] ?? 0);
  });

  it('gives every glyph to the operator that started its run, and never to a tagged neighbour of untagged text', async () => {
    const built = await buildTagged({
      pages: [
        {
          fonts: HELV,
          box: [0, 0, 400, 200],
          content:
            `${tagged('P', 0, shown(10, 150, 'Hello there'))}` +
            `/Span BMC\n${shown(100, 150, 'Gap')}\nEMC\n` +
            `${tagged('Span', 1, shown(150, 150, 'World'))}`,
        },
      ],
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'P', pg: 0, k: [0] },
            { s: 'P', pg: 0, k: [1] },
          ],
        },
      ],
    });
    const layout = await readPageLayout(built.bytes, 0, run);
    expect(layout.items.map((item) => [item.mcid, item.text])).toEqual([
      [0, 'Hello there'],
      [1, 'World'],
    ]);
    // Boxes are page-relative with the top-left origin: the 12 pt line at baseline 150 of 200.
    for (const item of layout.items) {
      expect(item.rect?.[1]).toBeGreaterThan(30);
      expect(item.rect?.[3]).toBeLessThan(60);
    }
    expect(layout.items[0]?.rect?.[0]).toBeCloseTo(10, 0);
    expect(layout.items[1]?.rect?.[0]).toBeGreaterThan(140);
  });

  it('clips a long label to 120 characters with an ellipsis', async () => {
    const long = 'abcdefghij'.repeat(15);
    const built = await buildTagged({
      pages: [
        {
          fonts: HELV,
          box: [0, 0, 700, 200],
          content: tagged('P', 0, shown(10, 150, long, 6)),
        },
      ],
      tree: [{ s: 'Document', k: [{ s: 'P', pg: 0, k: [0] }] }],
    });
    const item = (await readPageLayout(built.bytes, 0, run)).items[0];
    expect(item?.text).toBe(`${long.slice(0, 119)}…`);
  });

  it('boxes a picture, a form and a drawing by the geometry they paint, merged per marked-content id', async () => {
    const built = await buildTagged({
      pages: [
        {
          image: true,
          forms: { Fm: { content: '0 0 m' } },
          box: [10, 20, 210, 220],
          content:
            `${tagged('Figure', 0, 'q 40 0 0 40 50 60 cm /Im1 Do Q\n20 150 30 10 re f')}` +
            `${tagged('Figure', 1, 'q 1 0 0 1 100 100 cm /Fm Do Q')}` +
            `${tagged('Figure', 2, '/Sh0 sh')}` +
            '5 5 20 20 re f\n',
        },
      ],
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'Figure', pg: 0, k: [0] },
            { s: 'Figure', pg: 0, k: [1] },
            { s: 'Figure', pg: 0, k: [2] },
          ],
        },
      ],
    });
    const layout = await readPageLayout(built.bytes, 0, run);
    // The page box starts at (10, 20): both sequences are re-based on it, y measured down from 220.
    expect(layout.items).toEqual([
      // image [50..90]×[60..100] ∪ rectangle [20..50]×[150..160]
      { mcid: 0, rect: [10, 60, 80, 160], text: '' },
      // the form's own 100 × 100 box under the translate
      { mcid: 1, rect: [90, 20, 190, 120], text: '' },
      // a shading has no box at all
      { mcid: 2, rect: null, text: '' },
    ]);
  });

  it('reads the MCID of a property list named in the page resources', async () => {
    const built = await buildTagged({
      pages: [{ content: '/P /MC0 BDC\n10 10 20 20 re f\nEMC\n' }],
      tree: [{ s: 'Document', k: [{ s: 'P', pg: 0, k: [4] }] }],
      setup: (doc, _root, pages) => {
        const page = pages[0] as PDFObject;
        page.put('Resources', doc.addObject({ Properties: { MC0: { MCID: 4 } } } as never));
      },
    });
    const layout = await readPageLayout(built.bytes, 0, run);
    expect(layout.items).toEqual([{ mcid: 4, rect: [10, 170, 30, 190], text: '' }]);
  });

  it('lets the earliest of two operators at one origin own the run', async () => {
    // Two operators 1 pt apart vertically: the second row is visited first by the glyph, yet the
    // operator that comes first in the stream (the tagged one) keeps the run.
    const built = await buildTagged({
      pages: [
        {
          fonts: HELV,
          box: [0, 0, 400, 200],
          content: `${tagged('P', 0, shown(10, 100, 'X'))}${tagged('P', 1, shown(10, 99, 'Y'))}`,
        },
      ],
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'P', pg: 0, k: [0] },
            { s: 'P', pg: 0, k: [1] },
          ],
        },
      ],
    });
    const reader = async (): Promise<PageTextInput> => lineOf('Z', 10, 100.5);
    const layout = await readPageLayout(built.bytes, 0, run, { pageText: reader });
    expect(layout.items.find((item) => item.mcid === 0)?.text).toBe('Z');
    expect(layout.items.find((item) => item.mcid === 1)?.text).toBe('');
  });

  it('marks text the glyph model could not place with a small box at the operator origin', async () => {
    const built = await buildTagged({
      pages: [{ fonts: HELV, box: [0, 0, 400, 200], content: tagged('P', 0, shown(30, 120, 'Hello', 10)) }],
      tree: [{ s: 'Document', k: [{ s: 'P', pg: 0, k: [0] }] }],
    });
    const layout = await readPageLayout(built.bytes, 0, run, { pageText: none });
    expect(layout.textFailed).toBe(false);
    // size = max(4, 10); top = 200 − 120; box = [x, top − size, x + 2·size, top + size/4].
    expect(layout.items).toEqual([{ mcid: 0, rect: [30, 70, 50, 82.5], text: '' }]);

    const tiny = await buildTagged({
      pages: [{ fonts: HELV, box: [0, 0, 400, 200], content: tagged('P', 0, shown(30, 120, 'Hello', 2)) }],
      tree: [{ s: 'Document', k: [{ s: 'P', pg: 0, k: [0] }] }],
    });
    expect((await readPageLayout(tiny.bytes, 0, run, { pageText: none })).items[0]?.rect).toEqual([
      30, 76, 38, 81,
    ]);
  });

  it('keeps the drawings and says so when the page text cannot be read, and rethrows an abort', async () => {
    const built = await buildTagged({
      pages: [
        {
          fonts: HELV,
          content: `${tagged('P', 0, shown(30, 120, 'Hello', 10))}${tagged('Figure', 1, '10 10 30 30 re f')}`,
        },
      ],
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'P', pg: 0, k: [0] },
            { s: 'Figure', pg: 0, k: [1] },
          ],
        },
      ],
    });
    const broken = async (): Promise<PageTextInput> => {
      throw new Error('no text');
    };
    const layout = await readPageLayout(built.bytes, 0, run, { pageText: broken });
    expect(layout.textFailed).toBe(true);
    expect(layout.unreadable).toBe(false);
    expect(layout.items.map((item) => item.mcid)).toEqual([0, 1]);
    expect(layout.items[1]?.rect).toEqual([10, 160, 40, 190]);

    const aborted = async (): Promise<PageTextInput> => {
      throw Object.assign(new Error('stop'), { name: 'AbortError' });
    };
    await expect(readPageLayout(built.bytes, 0, run, { pageText: aborted })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('does not read the page text when the page paints none', async () => {
    const built = await buildTagged({
      pages: [{ content: tagged('Figure', 0, '10 10 30 30 re f') }],
      tree: [{ s: 'Document', k: [{ s: 'Figure', pg: 0, k: [0] }] }],
    });
    let calls = 0;
    const reader = async (): Promise<PageTextInput> => {
      calls += 1;
      return lineOf('', 0, 0);
    };
    await readPageLayout(built.bytes, 0, run, { pageText: reader });
    expect(calls).toBe(0);
  });

  it('reports a page with no content as empty, and one it cannot tokenize as unreadable', async () => {
    const empty = await buildTagged({ pages: [{}], tree: [{ s: 'Document', k: [] }] });
    expect(await readPageLayout(empty.bytes, 0, run)).toMatchObject({
      items: [],
      textFailed: false,
      unreadable: false,
    });
    const broken = await buildTagged({ pages: [{ content: 'q ]' }], tree: [{ s: 'Document', k: [] }] });
    expect(await readPageLayout(broken.bytes, 0, run)).toMatchObject({
      items: [],
      textFailed: false,
      unreadable: true,
    });
  });

  it('reports the rotation and the unrotated size of a rotated page', async () => {
    const built = await buildTagged({
      pages: [{ box: [0, 0, 300, 100], content: '' }],
      tree: [{ s: 'Document', k: [] }],
      setup: (_doc, _root, pages) => (pages[0] as PDFObject).put('Rotate', 90),
    });
    expect(await readPageLayout(built.bytes, 0, run)).toMatchObject({
      width: 300,
      height: 100,
      rotation: 90,
    });
  });

  it('reports a page whose content stream cannot be decoded as unreadable', async () => {
    const built = await buildTagged({
      pages: [{}],
      tree: [{ s: 'Document', k: [] }],
      setup: (doc, _root, pages) =>
        (pages[0] as PDFObject).put(
          'Contents',
          doc.addRawStream(new Uint8Array([1, 2, 3]), {
            Filter: 'FlateDecode',
            DecodeParms: { Predictor: 15, Columns: -5, Colors: 1000, BitsPerComponent: 99 },
          } as never),
        ),
    });
    expect(await readPageLayout(built.bytes, 0, run)).toMatchObject({ items: [], unreadable: true });
  });

  it('refuses a page the document does not have and an aborted signal', async () => {
    const tagged1 = await taggedFixture();
    await expect(readPageLayout(tagged1, 2, run)).rejects.toMatchObject({ code: 'range-invalid' });
    const controller = new AbortController();
    controller.abort();
    await expect(readPageLayout(tagged1, 0, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(readStructure(tagged1, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('readTagCandidates', () => {
  it('lists what the tagger would claim in an untagged file, in content order, with the role it would give', async () => {
    const candidates = await readTagCandidates(await untaggedFixture(), run);
    expect(candidates.bodySize).toBe(11);
    expect(candidates.notes).toEqual([]);
    expect(
      candidates.pages.map((page) => ({
        pageIndex: page.pageIndex,
        size: [page.width, page.height],
        skipped: page.skipped,
        found: page.candidates.map((entry) => [entry.kind, entry.role, entry.text, entry.alt]),
      })),
    ).toEqual([
      {
        pageIndex: 0,
        size: [595, 842],
        skipped: 0,
        found: [
          ['text', 'H1', 'Annual Report', null],
          ['text', 'P', 'The year was good for everyone involved.', null],
          ['figure', 'Figure', '', null],
        ],
      },
      {
        pageIndex: 1,
        size: [595, 842],
        skipped: 0,
        found: [
          ['text', 'P', 'Second page body text is here.', null],
          ['figure', 'Figure', '', null],
        ],
      },
    ]);
    const [heading, , figure] = candidates.pages[0]?.candidates ?? [];
    expect(heading?.rect?.[0]).toBeCloseTo(72, 0);
    expect(figure?.rect).toEqual([72, 242, 172, 342]);
  });

  it('gives a block of several text objects one candidate, carries the alt a picture has, and leaves a page with nothing out', async () => {
    const built = await buildTagged({
      pages: [
        {
          fonts: HELV,
          image: true,
          box: [0, 0, 400, 300],
          content:
            `${shown(10, 250, 'First part')}\n` +
            'q 40 0 0 40 50 60 cm /Im1 Do Q\n' +
            `${shown(10, 235, 'second part of the same paragraph')}\n`,
        },
        { content: '' },
      ],
      setup: (doc, _root, pages) => {
        const image = (pages[0] as PDFObject).get('Resources').get('XObject').get('Im1');
        image.put('Alt', doc.newString('A logo'));
      },
    });
    const candidates = await readTagCandidates(built.bytes, run);
    expect(candidates.notes).toEqual([
      { kind: 'warning', key: 'op.note.a11y.pageNoBlocks', params: { page: 2 } },
    ]);
    expect(candidates.pages).toHaveLength(1);
    expect(
      candidates.pages[0]?.candidates.map((entry) => [entry.id, entry.kind, entry.text, entry.alt]),
    ).toEqual([
      ['b0', 'text', 'First part second part of the same paragraph', null],
      ['f7', 'figure', '', 'A logo'],
    ]);
  });

  it('has no box for a picture whose matrix cannot be evaluated', async () => {
    const huge = `1${'0'.repeat(400)}`;
    const built = await buildTagged({
      pages: [{ image: true, content: `q ${huge} 0 0 ${huge} 0 0 cm /Im1 Do Q` }],
    });
    const candidates = await readTagCandidates(built.bytes, run);
    expect(candidates.pages[0]?.candidates).toEqual([
      { id: 'f2', kind: 'figure', role: 'Figure', text: '', alt: null, rect: null },
    ]);
  });

  it('stops for an aborted signal, whether it arrives before or while the pages are read', async () => {
    const bytes = await untaggedFixture();
    const before = new AbortController();
    before.abort();
    await expect(readTagCandidates(bytes, { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const during = new AbortController();
    const abortingReader = async (): Promise<PageTextInput> => {
      during.abort();
      return lineOf('', 0, 0);
    };
    await expect(
      readTagCandidates(bytes, { signal: during.signal }, { pageText: abortingReader }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/* ------------------------------------------------------------------ *
 * Writing, on trees a tagger never writes
 * ------------------------------------------------------------------ */

/** The key of the `nth` element with this role, depth first. */
function keyOfRole(model: StructureModel, role: string, nth = 0): string {
  const keys: string[] = [];
  const walk = (nodes: readonly StructNode[]): void => {
    for (const node of nodes) {
      if (node.role === role) keys.push(node.key);
      walk(node.kids.flatMap((kid) => (kid.kind === 'element' ? [kid.node] : [])));
    }
  };
  walk(model.roots);
  const key = keys[nth];
  if (key === undefined) throw new Error(`no ${role} #${nth}`);
  return key;
}

const modelOfBytes = async (bytes: Uint8Array): Promise<StructureModel> =>
  (await readStructure(bytes, run)).model;

/** The raw element behind a model key (`o17`). */
const elementOf = (doc: PDFDocument, key: string): PDFObject => objectOf(doc, Number(key.slice(1)));
/** The reference to it, which is what a `/P` or `/Pg` entry is compared with. */
const refOf = (doc: PDFDocument, key: string): PDFObject => doc.newIndirect(Number(key.slice(1)));

async function withDoc<T>(bytes: Uint8Array, use: (doc: PDFDocument) => T): Promise<T> {
  const doc = await open(bytes);
  try {
    return use(doc);
  } finally {
    doc.destroy();
  }
}

const TABLE = {
  pages: [
    { fonts: HELV, content: `${tagged('P', 0, shown(10, 100, 'a'))}${tagged('P', 1, shown(10, 80, 'b'))}` },
  ],
  tree: [
    {
      s: 'Document',
      pg: 0,
      k: [
        {
          s: 'Table',
          k: [
            {
              s: 'TR',
              k: [
                { s: 'TH', k: [0], attrs: { scope: 'Row', colSpan: 2 } },
                { s: 'TD', k: [1] },
              ],
            },
          ],
        },
      ],
    },
  ],
} as const;

describe('editStructure: table scope', () => {
  it('changes the scope of a table header and keeps the span next to it', async () => {
    const built = await buildTagged(TABLE);
    const th = keyOfRole(await modelOfBytes(built.bytes), 'TH');
    const out = await editStructure(built.bytes, [{ op: 'scope', key: th, scope: 'Column' }], run);
    expect(out.report.notes.map((entry) => [entry.key, entry.params])).toContainEqual([
      'op.note.tags.scopeSet',
      { count: 1 },
    ]);
    await withDoc(out.bytes, (doc) => {
      const attributes = elementOf(doc, th).get('A');
      expect(attributes.get('O').asName()).toBe('Table');
      expect(attributes.get('Scope').asName()).toBe('Column');
      expect(attributes.get('ColSpan').asNumber()).toBe(2);
    });
    expect(structureSignature(await modelOfBytes(out.bytes))).toContain('TH|scope=Column(#0:0)');
  });

  it('clears a scope without touching the other attributes, and does nothing to an element that has none', async () => {
    const built = await buildTagged(TABLE);
    const model = await modelOfBytes(built.bytes);
    const th = keyOfRole(model, 'TH');
    const td = keyOfRole(model, 'TD');
    const out = await editStructure(
      built.bytes,
      [
        { op: 'scope', key: th, scope: null },
        { op: 'scope', key: td, scope: null },
      ],
      run,
    );
    await withDoc(out.bytes, (doc) => {
      const attributes = elementOf(doc, th).get('A');
      expect(attributes.get('Scope').isNull()).toBe(true);
      expect(attributes.get('ColSpan').asNumber()).toBe(2);
      expect(elementOf(doc, td).get('A').isNull()).toBe(true);
    });
    expect(structureSignature(await modelOfBytes(out.bytes))).toBe(
      structureSignature(applyStructureEdits(model, [{ op: 'scope', key: th, scope: null }])),
    );
  });

  it('adds a table attribute to an element without one, next to the ones it has, or around a lone one', async () => {
    const built = await buildTagged({
      ...TABLE,
      setup: (doc, root) => {
        const rows = root.get('StructTreeRoot').get('K').get(0).get('K').get(0).get('K').get(0).get('K');
        const tds = [rows.get(1)];
        // TD: `/A` is an array of other owners' attributes.
        tds[0]?.put('A', doc.newArray());
        tds[0]?.get('A').push(doc.newDictionary());
        tds[0]?.get('A').get(0).put('O', doc.newName('Layout'));
        // A revision number between the dictionaries, as `/A` arrays have.
        tds[0]?.get('A').push(doc.newInteger(2));
        // TH: `/A` is something that is neither a dictionary nor an array.
        rows.get(0).put('A', doc.newInteger(3));
      },
    });
    const model = await modelOfBytes(built.bytes);
    const th = keyOfRole(model, 'TH');
    const td = keyOfRole(model, 'TD');
    const out = await editStructure(
      built.bytes,
      [
        { op: 'scope', key: td, scope: 'Both' },
        { op: 'scope', key: th, scope: 'Row' },
      ],
      run,
    );
    await withDoc(out.bytes, (doc) => {
      const tdAttrs = elementOf(doc, td).get('A');
      expect(tdAttrs.length).toBe(3);
      expect(tdAttrs.get(0).get('O').asName()).toBe('Layout');
      expect(tdAttrs.get(1).asNumber()).toBe(2);
      expect(tdAttrs.get(2).get('O').asName()).toBe('Table');
      expect(tdAttrs.get(2).get('Scope').asName()).toBe('Both');
      const thAttrs = elementOf(doc, th).get('A');
      expect(thAttrs.length).toBe(2);
      expect(thAttrs.get(0).asNumber()).toBe(3);
      expect(thAttrs.get(1).get('Scope').asName()).toBe('Row');
    });
  });

  it('creates the attribute dictionary of an element that has none, and updates the table entry of an array', async () => {
    const built = await buildTagged({
      ...TABLE,
      setup: (doc, root) => {
        const th = root.get('StructTreeRoot').get('K').get(0).get('K').get(0).get('K').get(0).get('K').get(0);
        const array = doc.newArray();
        array.push(doc.newDictionary());
        array.get(0).put('O', doc.newName('Table'));
        array.get(0).put('Scope', doc.newName('Row'));
        th.put('A', array);
      },
    });
    const model = await modelOfBytes(built.bytes);
    const th = keyOfRole(model, 'TH');
    const td = keyOfRole(model, 'TD');
    const out = await editStructure(
      built.bytes,
      [
        { op: 'scope', key: th, scope: 'Column' },
        { op: 'scope', key: td, scope: 'Row' },
      ],
      run,
    );
    await withDoc(out.bytes, (doc) => {
      const thAttrs = elementOf(doc, th).get('A');
      expect(thAttrs.length).toBe(1);
      expect(thAttrs.get(0).get('Scope').asName()).toBe('Column');
      const created = elementOf(doc, td).get('A');
      expect(created.get('O').asName()).toBe('Table');
      expect(created.get('Scope').asName()).toBe('Row');
    });
  });
});

describe('editStructure: alt text', () => {
  it('trims the text it writes, clears it on request, and says how many of each', async () => {
    const built = await buildTagged({
      pages: [{ content: `${tagged('Figure', 0, '1 1 5 5 re f')}${tagged('Figure', 1, '9 9 5 5 re f')}` }],
      tree: [
        {
          s: 'Document',
          pg: 0,
          k: [
            { s: 'Figure', alt: 'Old text', k: [0] },
            { s: 'Figure', k: [1] },
          ],
        },
      ],
    });
    const model = await modelOfBytes(built.bytes);
    const first = keyOfRole(model, 'Figure', 0);
    const second = keyOfRole(model, 'Figure', 1);
    const out = await editStructure(
      built.bytes,
      [
        { op: 'alt', key: first, alt: null },
        { op: 'alt', key: second, alt: '  A chart  ' },
      ],
      run,
    );
    expect(out.report.notes.map((entry) => entry.key)).toEqual([
      'op.note.tags.altSet',
      'op.note.tags.altCleared',
      'op.note.metadata.producerKept',
    ]);
    await withDoc(out.bytes, (doc) => {
      expect(elementOf(doc, first).get('Alt').isNull()).toBe(true);
      expect(elementOf(doc, second).get('Alt').asString()).toBe('A chart');
    });
  });
});

describe('editStructure: moving, grouping and unwrapping', () => {
  const LISTS = {
    pages: [
      {
        fonts: HELV,
        content: [0, 1, 2, 3].map((id) => tagged('P', id, shown(10, 150 - id * 20, `t${id}`))).join(''),
      },
      { content: '' },
    ],
    tree: [
      {
        s: 'Document',
        k: [
          {
            s: 'Sect',
            pg: 0,
            k: [
              { s: 'P', k: [0] },
              { s: 'P', k: [1] },
              { s: 'P', k: [2] },
            ],
          },
          { s: 'Sect', pg: 1, k: [{ s: 'P', pg: 0, k: [3] }] },
        ],
      },
      { s: 'Sect', k: [] },
    ],
  } as const;

  it('moves an element to another parent, keeping the page it was drawn on and pointing its /P at the new parent', async () => {
    const built = await buildTagged(LISTS);
    const model = await modelOfBytes(built.bytes);
    const p0 = keyOfRole(model, 'P', 0);
    const second = keyOfRole(model, 'Sect', 1);
    const out = await editStructure(built.bytes, [{ op: 'move', key: p0, parentKey: second, index: 0 }], run);
    expect(structureSignature(await modelOfBytes(out.bytes))).toBe(
      'Document(Sect(P(#0:1),P(#0:2)),Sect(P(#0:0),P(#0:3)));Sect()',
    );
    await withDoc(out.bytes, (doc) => {
      const moved = elementOf(doc, p0);
      expect(moved.get('P').asIndirect()).toBe(refOf(doc, second).asIndirect());
      // It inherited page 0 from the section it left; the new section is on page 1.
      expect(moved.get('Pg').asIndirect()).toBe(doc.findPage(0).asIndirect());
    });
  });

  it('puts an element before the n-th element of its new parent, past the content items between them, or last', async () => {
    const built = await buildTagged({
      pages: LISTS.pages,
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'Sect', pg: 0, k: [0, { mcr: 1, pg: 0 }, { s: 'P', k: [2] }, 3, { s: 'P', k: [] }] },
            {
              s: 'Sect',
              pg: 0,
              k: [
                { s: 'H1', k: [] },
                { s: 'H2', k: [] },
              ],
            },
          ],
        },
      ],
    });
    const model = await modelOfBytes(built.bytes);
    const target = keyOfRole(model, 'Sect', 0);
    const mover = keyOfRole(model, 'H1');
    const second = await editStructure(
      built.bytes,
      [{ op: 'move', key: mover, parentKey: target, index: 1 }],
      run,
    );
    expect(structureSignature(await modelOfBytes(second.bytes))).toBe(
      'Document(Sect(#0:0,#0:1,P(#0:2),#0:3,H1(),P()),Sect(H2()))',
    );
    const last = await editStructure(
      built.bytes,
      [{ op: 'move', key: mover, parentKey: target, index: 9 }],
      run,
    );
    const roles = await withDoc(last.bytes, (doc) => {
      const kids = elementOf(doc, target).get('K');
      return Array.from({ length: kids.length }, (_, index) => {
        const kid = kids.get(index);
        return kid.isNumber() ? '#' : kid.get('Type').asName() === 'MCR' ? 'MCR' : kid.get('S').asName();
      });
    });
    expect(roles).toEqual(['#', 'MCR', 'P', '#', 'P', 'H1']);
  });

  it('moves an element into one that has no /K yet, and past a /K entry that is neither a dictionary nor a number', async () => {
    const built = await buildTagged({
      pages: LISTS.pages,
      tree: [
        {
          s: 'Document',
          pg: 0,
          k: [
            {
              s: 'Sect',
              k: [
                { s: 'P', k: [0] },
                { s: 'P', k: [1] },
              ],
            },
            { s: 'Sect', k: [] },
          ],
        },
      ],
      setup: (doc, root) => {
        // A stray string between the two paragraphs.
        const sect = root.get('StructTreeRoot').get('K').get(0).get('K').get(0);
        const kids = doc.newArray();
        kids.push(sect.get('K').get(0));
        kids.push(doc.newString('stray'));
        kids.push(sect.get('K').get(1));
        sect.put('K', kids);
      },
    });
    const model = await modelOfBytes(built.bytes);
    const [empty, full] = [keyOfRole(model, 'Sect', 1), keyOfRole(model, 'Sect', 0)];
    const p0 = keyOfRole(model, 'P', 0);
    const p1 = keyOfRole(model, 'P', 1);
    const out = await editStructure(
      built.bytes,
      [
        { op: 'move', key: p0, parentKey: empty, index: 0 },
        { op: 'move', key: p0, parentKey: full, index: 0 },
      ],
      run,
    );
    expect(structureSignature(await modelOfBytes(out.bytes))).toBe('Document(Sect(P(#0:0),P(#0:1)),Sect())');
    await withDoc(out.bytes, (doc) => {
      const kids = elementOf(doc, full).get('K');
      expect(kids.length).toBe(3);
      expect(kids.get(0).asString()).toBe('stray');
      expect(kids.get(1).asIndirect()).toBe(refOf(doc, p0).asIndirect());
      expect(kids.get(2).asIndirect()).toBe(refOf(doc, p1).asIndirect());
    });
  });

  it('reorders top-level elements, whose parent is the structure root', async () => {
    const built = await buildTagged(LISTS);
    const model = await modelOfBytes(built.bytes);
    const document = model.roots[0]?.key as string;
    const out = await editStructure(
      built.bytes,
      [{ op: 'move', key: model.roots[1]?.key as string, parentKey: '<root>', index: 0 }],
      run,
    );
    expect(structureSignature(await modelOfBytes(out.bytes))).toBe(
      'Sect();Document(Sect(P(#0:0),P(#0:1),P(#0:2)),Sect(P(#0:3)))',
    );
    expect(document).toMatch(/^o\d+$/);
  });

  it('writes the content of a single-entry /K and of a /K that points at nothing', async () => {
    const built = await buildTagged({
      pages: LISTS.pages,
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'Sect', pg: 0, single: true, k: [{ s: 'P', k: [0] }] },
            { s: 'Sect', k: [{ s: 'P', k: [1] }] },
          ],
        },
      ],
      setup: (doc, root) => {
        const sects = root.get('StructTreeRoot').get('K').get(0).get('K');
        // The second section's /K names an object that does not exist.
        sects.get(1).put('K', doc.newIndirect(9999));
      },
    });
    const model = await modelOfBytes(built.bytes);
    const p = keyOfRole(model, 'P', 0);
    const empty = keyOfRole(model, 'Sect', 1);
    const out = await editStructure(built.bytes, [{ op: 'move', key: p, parentKey: empty, index: 0 }], run);
    expect(structureSignature(await modelOfBytes(out.bytes))).toBe('Document(Sect(),Sect(P(#0:0)))');
  });

  it('groups siblings under a new element in their own order, around content items, pinning the page they inherited', async () => {
    const built = await buildTagged({
      pages: LISTS.pages,
      tree: [
        {
          s: 'Document',
          pg: 0,
          k: [{ s: 'P', k: [0] }, 9, { s: 'P', k: [1] }, { s: 'P', k: [2] }],
        },
        { s: 'Sect', k: [] },
      ],
    });
    const model = await modelOfBytes(built.bytes);
    const [p0, p1, p2] = [0, 1, 2].map((index) => keyOfRole(model, 'P', index)) as [string, string, string];
    const out = await editStructure(
      built.bytes,
      [{ op: 'group', keys: [p2, p0], role: 'L', newKey: 'n1' }],
      run,
    );
    expect(structureSignature(await modelOfBytes(out.bytes))).toBe(
      'Document(L(P(#0:0),P(#0:2)),#0:9,P(#0:1));Sect()',
    );
    await withDoc(out.bytes, (doc) => {
      for (const key of [p0, p2]) {
        expect(elementOf(doc, key).get('Pg').asIndirect()).toBe(doc.findPage(0).asIndirect());
      }
      expect(elementOf(doc, p1).get('Pg').isNull()).toBe(true);
    });
  });

  it('groups top-level elements under a new one whose parent is the structure root', async () => {
    const built = await buildTagged(LISTS);
    const model = await modelOfBytes(built.bytes);
    const keys = model.roots.map((root) => root.key);
    const out = await editStructure(built.bytes, [{ op: 'group', keys, role: 'Part', newKey: 'n9' }], run);
    expect(structureSignature(await modelOfBytes(out.bytes))).toBe(
      'Part(Document(Sect(P(#0:0),P(#0:1),P(#0:2)),Sect(P(#0:3))),Sect())',
    );
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.tags.grouped');
  });

  it('replaces an element that owns no content by its children, which keep their page and point at the new parent', async () => {
    const built = await buildTagged(LISTS);
    const model = await modelOfBytes(built.bytes);
    const sect = keyOfRole(model, 'Sect', 0);
    const [p0, p1, p2] = [0, 1, 2].map((index) => keyOfRole(model, 'P', index)) as [string, string, string];
    const out = await editStructure(built.bytes, [{ op: 'unwrap', key: sect }], run);
    expect(structureSignature(await modelOfBytes(out.bytes))).toBe(
      'Document(P(#0:0),P(#0:1),P(#0:2),Sect(P(#0:3)));Sect()',
    );
    expect(out.report.notes.map((entry) => entry.key)).toContain('op.note.tags.unwrapped');
    await withDoc(out.bytes, (doc) => {
      const document = refOf(doc, model.roots[0]?.key as string);
      for (const key of [p0, p1, p2]) {
        expect(elementOf(doc, key).get('P').asIndirect()).toBe(document.asIndirect());
        expect(elementOf(doc, key).get('Pg').asIndirect()).toBe(doc.findPage(0).asIndirect());
      }
    });
  });
});

describe('editStructure: refusals', () => {
  it('refuses a move into a direct element, which no child could point back at', async () => {
    const built = await buildTagged({
      pages: [{ content: tagged('P', 0, '1 1 5 5 re f') }],
      tree: [
        {
          s: 'Document',
          pg: 0,
          k: [
            { s: 'P', k: [0] },
            { s: 'Sect', direct: true, k: [] },
          ],
        },
      ],
    });
    const model = await modelOfBytes(built.bytes);
    const direct = keyOfRole(model, 'Sect');
    expect(direct).toMatch(/^p\//);
    await expect(
      editStructure(
        built.bytes,
        [{ op: 'move', key: keyOfRole(model, 'P'), parentKey: direct, index: 0 }],
        run,
      ),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: expect.stringMatching(/^not-editable: /) },
    });
  });

  it('refuses a draft the model refuses, with the reason as its message', async () => {
    const built = await buildTagged(TABLE);
    const model = await modelOfBytes(built.bytes);
    await expect(
      editStructure(built.bytes, [{ op: 'role', key: 'o99999', role: 'P' }], run),
    ).rejects.toMatchObject({
      code: 'selection-empty',
      details: { engine: 'model', path: 'edits', engineMessage: 'missing: no element with key o99999' },
    });
    await expect(
      editStructure(
        built.bytes,
        [{ op: 'group', keys: [keyOfRole(model, 'TH')], role: 'Banana', newKey: 'n1' }],
        run,
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('refuses a file whose structure root is not a dictionary, and a tree too deep to be edited safely', async () => {
    const named = await buildTagged({
      pages: [{}],
      tree: [{ s: 'Document', k: [] }],
      rootAsName: true,
    });
    await expect(
      editStructure(named.bytes, [{ op: 'role', key: 'o1', role: 'P' }], run),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: 'the document has no readable structure tree to edit' },
    });

    let deep: { s: string; k: unknown[] } = { s: 'Span', k: [] };
    for (let level = 0; level < 70; level += 1) deep = { s: 'Span', k: [deep] };
    const built = await buildTagged({ pages: [{}], tree: [{ s: 'Document', k: [deep as never] }] });
    expect((await modelOfBytes(built.bytes)).truncated).toBe(true);
    await expect(
      editStructure(built.bytes, [{ op: 'role', key: 'o1', role: 'P' }], run),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: 'the structure tree is too large to be edited safely' },
    });
  });

  it('reports progress per edit and stops for an abort between edits or before the save', async () => {
    const built = await buildTagged(TABLE);
    const model = await modelOfBytes(built.bytes);
    const th = keyOfRole(model, 'TH');
    const edits: StructEdit[] = [
      { op: 'scope', key: th, scope: 'Row' },
      { op: 'scope', key: th, scope: 'Column' },
    ];
    const seen: unknown[] = [];
    await editStructure(built.bytes, edits, { signal: run.signal, onProgress: (event) => seen.push(event) });
    expect(seen).toEqual([
      { phase: 'tags', labelKey: 'op.progress.tags.write', done: 1, total: 4 },
      { phase: 'tags', labelKey: 'op.progress.tags.write', done: 2, total: 4 },
      { phase: 'tags', labelKey: 'op.progress.tags.verify', done: 4, total: 4 },
    ]);

    const between = new AbortController();
    await expect(
      editStructure(built.bytes, edits, { signal: between.signal, onProgress: () => between.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const last = new AbortController();
    await expect(
      editStructure(built.bytes, edits.slice(0, 1), { signal: last.signal, onProgress: () => last.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const before = new AbortController();
    before.abort();
    await expect(editStructure(built.bytes, edits, { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('editStructure: artifacts', () => {
  const PAGE =
    '/P /MC0 BDC\n10 10 5 5 re f\nEMC\n' +
    `${tagged('P', 1, '20 10 5 5 re f')}` +
    `${tagged('P', 2, '30 10 5 5 re f')}` +
    '/Span BMC\n40 10 5 5 re f\nEMC\n' +
    '/OC /Missing BDC\n50 10 5 5 re f\nEMC\n';

  interface Refs {
    readonly treeRoot: PDFObject;
    readonly p0: PDFObject;
    readonly p1: PDFObject;
    readonly p2: PDFObject;
  }

  /** Document(Sect(P#0, P#1), P#2) on one page that names the first sequence through `/Properties`. */
  function artifactSpec(parentTree?: (doc: PDFDocument, refs: Refs) => void, structParents?: number) {
    return {
      pages: [{ content: PAGE, ...(structParents === undefined ? {} : { structParents }) }],
      tree: [
        {
          s: 'Document',
          pg: 0,
          k: [
            {
              s: 'Sect',
              k: [
                { s: 'P', k: [0] },
                { s: 'P', k: [1] },
              ],
            },
            { s: 'P', k: [2] },
          ],
        },
      ],
      setup: (doc: PDFDocument, root: PDFObject, pages: readonly PDFObject[]) => {
        (pages[0] as PDFObject)
          .get('Resources')
          .put('Properties', doc.addObject({ MC0: { MCID: 0 } } as never));
        const treeRoot = root.get('StructTreeRoot');
        const document = treeRoot.get('K').get(0);
        const sect = document.get('K').get(0);
        parentTree?.(doc, {
          treeRoot,
          p0: sect.get('K').get(0),
          p1: sect.get('K').get(1),
          p2: document.get('K').get(1),
        });
      },
    };
  }

  const slots = (array: PDFObject): boolean[] =>
    Array.from({ length: array.length }, (_, index) => array.get(index).isNull());
  const pageText = (doc: PDFDocument): string =>
    new TextDecoder('latin1').decode(pageContent(doc.findPage(0))?.bytes ?? new Uint8Array(0));

  it('rewrites every sequence of an element subtree, named inline or through /Properties, and clears its parent-tree slots', async () => {
    const built = await buildTagged(
      artifactSpec((doc, refs) => {
        const values = doc.newArray();
        for (const ref of [refs.p0, refs.p1, refs.p2]) values.push(ref);
        // The tree: a junk kid, a leaf whose limits exclude the key, one with short limits,
        // and the leaf that holds it (after a non-number candidate).
        const leaf = (limits: number[] | null, nums: unknown[]) =>
          doc.addObject({ ...(limits === null ? {} : { Limits: limits }), Nums: nums } as never);
        const parentTree = doc.addObject({
          Kids: [
            42,
            leaf([5, 9], [5, values]),
            leaf([0], []),
            leaf([6, 7], [8, doc.newDictionary()]),
            leaf([0, 0], [doc.newString('k'), 5, 0, values]),
          ],
        } as never);
        refs.treeRoot.put('ParentTree', parentTree);
      }, 0),
    );
    const sect = keyOfRole(await modelOfBytes(built.bytes), 'Sect');
    const out = await editStructure(built.bytes, [{ op: 'artifact', key: sect }], run);

    expect(out.report.steps).toEqual(['load', 'tags', 'tags.artifact', 'producer', 'save', 'verify']);
    expect(out.report.notes.map((entry) => [entry.key, entry.params])).toEqual([
      ['op.note.tags.artifact', { count: 1, sequences: 2 }],
      ['op.note.tags.contentRewritten', { pages: 1 }],
      ['op.note.tags.parentTreeCleared', { count: 2 }],
      ['op.note.metadata.producerKept', { producer: expect.any(String) }],
    ]);
    await withDoc(out.bytes, (doc) => {
      const text = pageText(doc);
      expect(text.match(/\/Artifact BMC/g)).toHaveLength(2);
      expect(text).not.toContain('/MC0 BDC');
      expect(text).not.toContain('/MCID 1');
      // The sequence of the element that stays, and the `BMC` that was never an MCID, are as written.
      expect(text).toContain('/P <</MCID 2>> BDC');
      expect(text).toContain('/Span BMC');
      expect(text).toContain('/OC /Missing BDC');
      const parentTree = doc.getTrailer().get('Root').get('StructTreeRoot').get('ParentTree');
      const values = parentTree.get('Kids').get(4).get('Nums').get(3);
      expect(slots(values)).toEqual([true, true, false]);
    });
    expect(structureSignature(await modelOfBytes(out.bytes))).toBe('Document(P(#0:2))');
  });

  it('leaves a parent tree it cannot walk to the end alone and still rewrites the content', async () => {
    const built = await buildTagged(
      artifactSpec((doc, refs) => {
        const values = doc.newArray();
        for (const ref of [refs.p0, refs.p1, refs.p2]) values.push(ref);
        // A parent tree whose only node lists itself as its kid: the walk must end.
        const loop = doc.addObject({ Kids: [] } as never);
        loop.get('Kids').push(loop);
        refs.treeRoot.put('ParentTree', loop);
        // The page's slot is somewhere the walk never reaches.
        loop.put('Nums', doc.newArray());
        loop.get('Nums').push(doc.newInteger(7));
        loop.get('Nums').push(values);
      }, 0),
    );
    const sect = keyOfRole(await modelOfBytes(built.bytes), 'Sect');
    const out = await editStructure(built.bytes, [{ op: 'artifact', key: sect }], run);
    await withDoc(out.bytes, (doc) => {
      expect(pageText(doc).match(/\/Artifact BMC/g)).toHaveLength(2);
      const values = doc.getTrailer().get('Root').get('StructTreeRoot').get('ParentTree').get('Nums').get(1);
      expect(slots(values)).toEqual([false, false, false]);
    });
  });

  it('rewrites the content of a page that has no parent-tree entry, or one that is not an array', async () => {
    const without = await buildTagged(artifactSpec(undefined, 0));
    const sect = keyOfRole(await modelOfBytes(without.bytes), 'Sect');
    const noTree = await editStructure(without.bytes, [{ op: 'artifact', key: sect }], run);
    await withDoc(noTree.bytes, (doc) => expect(pageText(doc).match(/\/Artifact BMC/g)).toHaveLength(2));

    const dictionary = await buildTagged(
      artifactSpec((doc, refs) => {
        refs.treeRoot.put('ParentTree', doc.addObject({ Nums: [0, doc.newDictionary()] } as never));
      }, 0),
    );
    const out = await editStructure(
      dictionary.bytes,
      [{ op: 'artifact', key: keyOfRole(await modelOfBytes(dictionary.bytes), 'Sect') }],
      run,
    );
    await withDoc(out.bytes, (doc) => {
      expect(pageText(doc).match(/\/Artifact BMC/g)).toHaveLength(2);
      const entry = doc.getTrailer().get('Root').get('StructTreeRoot').get('ParentTree').get('Nums').get(1);
      expect(entry.isDictionary()).toBe(true);
    });
  });

  it('keeps a parent-tree array shorter than the sequence id untouched', async () => {
    const built = await buildTagged(
      artifactSpec((doc, refs) => {
        const short = doc.newArray();
        short.push(refs.p0);
        refs.treeRoot.put('ParentTree', doc.addObject({ Nums: [0, short] } as never));
      }, 0),
    );
    const sect = keyOfRole(await modelOfBytes(built.bytes), 'Sect');
    const out = await editStructure(built.bytes, [{ op: 'artifact', key: sect }], run);
    await withDoc(out.bytes, (doc) => {
      const values = doc.getTrailer().get('Root').get('StructTreeRoot').get('ParentTree').get('Nums').get(1);
      expect(slots(values)).toEqual([true]);
    });
  });

  it('warns about content it could not rewrite: an id the page does not draw and an element with no page', async () => {
    const built = await buildTagged({
      pages: [{ content: tagged('P', 0, '1 1 5 5 re f') }],
      tree: [
        {
          s: 'Document',
          k: [
            { s: 'P', pg: 0, k: [0] },
            { s: 'P', pg: 0, k: [7] },
            { s: 'P', k: [5] },
          ],
        },
      ],
    });
    const model = await modelOfBytes(built.bytes);
    const out = await editStructure(
      built.bytes,
      [
        { op: 'artifact', key: keyOfRole(model, 'P', 1) },
        { op: 'artifact', key: keyOfRole(model, 'P', 2) },
      ],
      run,
    );
    expect(out.report.notes.map((entry) => [entry.kind, entry.key, entry.params])).toContainEqual([
      'warning',
      'op.note.tags.contentPartlyMissing',
      { count: 2 },
    ]);
    expect(out.report.notes.map((entry) => [entry.key, entry.params])).toContainEqual([
      'op.note.tags.artifact',
      { count: 2, sequences: 0 },
    ]);
    expect(structureSignature(await modelOfBytes(out.bytes))).toBe('Document(P(#0:0))');
  });

  it('refuses to rewrite a page whose content it cannot read', async () => {
    const tree = [
      {
        s: 'Document',
        pg: 0,
        k: [
          { s: 'P', k: [0] },
          { s: 'P', k: [1] },
        ],
      },
    ];
    const garbled = await buildTagged({ pages: [{ content: '/P <</MCID 0>> BDC q ] EMC' }], tree });
    await expect(
      editStructure(
        garbled.bytes,
        [{ op: 'artifact', key: keyOfRole(await modelOfBytes(garbled.bytes), 'P', 1) }],
        run,
      ),
    ).rejects.toMatchObject({
      code: 'unsupported',
      details: { engineMessage: 'page 1 content cannot be read, so its marked content cannot be rewritten' },
    });

    const undecodable = await buildTagged({
      pages: [{ content: tagged('P', 0, '1 1 5 5 re f') }],
      tree,
      setup: (doc, _root, pages) =>
        (pages[0] as PDFObject).put(
          'Contents',
          doc.addRawStream(new Uint8Array([1, 2, 3]), {
            Filter: 'FlateDecode',
            DecodeParms: { Predictor: 15, Columns: -5, Colors: 1000, BitsPerComponent: 99 },
          } as never),
        ),
    });
    await expect(
      editStructure(
        undecodable.bytes,
        [{ op: 'artifact', key: keyOfRole(await modelOfBytes(undecodable.bytes), 'P', 0) }],
        run,
      ),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});
