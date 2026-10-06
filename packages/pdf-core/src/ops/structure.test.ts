/**
 * The tag editor against real bytes. Each edit is written to a tagged file and the result is read
 * back two ways that do not share the writer's code: the structure model (compared with what the
 * pure edit semantics say it must be) and MuPDF's raw object model and content stream.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { pageContent } from './accessibility';
import { checkPdfUa } from './pdfua';
import { editStructure, readStructure } from './structure';
import {
  applyStructureEdits,
  findNode,
  readingOrder,
  type StructEdit,
  type StructureModel,
  structureSignature,
} from './structure-model';
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
});
