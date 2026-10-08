/**
 * The structure tree as a file writes it, and the edits the tag editor is refused. The reader is
 * given trees no tagging tool would produce — a role map entry that is a number, table attributes
 * out of range, marked-content references with no id, an object listed under two parents, a
 * tree deeper than the walk goes — and the pure edits are given every key they must refuse:
 * the synthetic root, elements the writer cannot address, groups that cross parents.
 */

import { PDFDocument } from 'mupdf';
import { describe, expect, it } from 'vitest';
import { pageObjects } from '../engines/mupdf-write';
import { handPdf } from './forms.fixtures';
import {
  applyStructureEdits,
  elementKids,
  findNode,
  nodePages,
  readStructureModel,
  type StructEdit,
  StructEditError,
  type StructKid,
  type StructNode,
  type StructureModel,
  walkNodes,
} from './structure-model';
import { el, mcid, modelOf } from './structure-model.fixtures';

/** A one-page file whose catalog holds `root` as `/StructTreeRoot`, with `extra` objects. */
function tagged(root: string, extra: Readonly<Record<number, string>> = {}): Uint8Array {
  return handPdf({
    1: `<</Type/Catalog/Pages 2 0 R/StructTreeRoot ${root}>>`,
    2: '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    3: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>',
    ...extra,
  });
}

function read(bytes: Uint8Array, limit?: number) {
  const doc = PDFDocument.openDocument(bytes, 'application/pdf').asPDF();
  if (doc === null) throw new Error('not a PDF');
  try {
    return readStructureModel(doc, pageObjects(doc), limit);
  } finally {
    doc.destroy();
  }
}

const kind = (node: StructNode) =>
  node.kids.map((kid) => (kid.kind === 'element' ? kid.node.key : kid.item.kind));

describe('reading a structure tree', () => {
  it('keeps the role map entries that name a role and skips the rest', () => {
    const model = read(
      tagged('5 0 R', { 5: '<</Type/StructTreeRoot/RoleMap<</Custom/P/Heading/H1/Bad 3/Text(x)>>>>' }),
    );
    expect(model.roleMap).toEqual({ Custom: 'P', Heading: 'H1' });
  });

  it('reads table attributes in order, from one dictionary or a list, skipping other owners and revision numbers', () => {
    const model = read(
      tagged('5 0 R', {
        5: '<</Type/StructTreeRoot/K[6 0 R 7 0 R 8 0 R]>>',
        6: '<</Type/StructElem/S/TH/P 5 0 R/A[2 <</O/Layout/ColSpan 9/Scope/Row>> <</O/Table/Scope/Column/ColSpan 3/RowSpan 0/Headers[(a) 5 (b)]>> <</RowSpan 2>> 7]>>',
        7: '<</Type/StructElem/S/TD/P 5 0 R/A<</O/Table/Scope/Row/ColSpan 0>>>>',
        8: '<</Type/StructElem/S/TD/P 5 0 R/A 4>>',
      }),
    );
    const [first, second, third] = model.roots;
    expect([first?.scope, first?.colSpan, first?.rowSpan, first?.headers]).toEqual([
      'Column',
      3,
      2,
      ['a', 'b'],
    ]);
    expect([second?.scope, second?.colSpan, second?.rowSpan]).toEqual(['Row', 1, 1]);
    expect([third?.scope, third?.colSpan, third?.headers]).toEqual([null, 1, []]);
  });

  it('reads marked-content references, annotations and elements in file order, with their pages', () => {
    const model = read(
      tagged('5 0 R', {
        5: '<</Type/StructTreeRoot/K 6 0 R>>',
        6: '<</Type/StructElem/S/Document/P 5 0 R/Pg 3 0 R/K[7 <</Type/MCR/MCID 2/Pg 3 0 R/Stm 9 0 R>> <</Type/MCR>> <</Type/OBJR/Obj 10 0 R>> <</Type/OBJR/Obj<</Subtype/Link>>>> <</Type/OBJR/Obj 99 0 R/Pg 3 0 R>> 11 0 R <</S/Span>> <</Type/StructElem>> null]>>',
        9: '<</Type/XObject/Subtype/Form/BBox[0 0 1 1]/Length 0>>\nstream\n\nendstream',
        10: '<</Type/Annot/Subtype/Link/Rect[0 0 1 1]>>',
        11: '<</Type/StructElem/S/P/P 6 0 R/K 3>>',
      }),
    );
    const document = model.roots[0];
    expect(document?.pageIndex).toBe(0);
    expect(document?.kids.map((entry) => (entry.kind === 'content' ? entry.item : entry.node.key))).toEqual([
      { kind: 'mcid', mcid: 7, pageIndex: 0, inStream: false },
      { kind: 'mcid', mcid: 2, pageIndex: 0, inStream: true },
      { kind: 'objr', objectNumber: 10, pageIndex: 0, subtype: 'Link' },
      { kind: 'objr', objectNumber: null, pageIndex: 0, subtype: 'Link' },
      { kind: 'objr', objectNumber: 99, pageIndex: 0, subtype: null },
      'o11',
      'p/0/7',
      'p/0/8',
    ]);
    const [, span, bare] = (document?.kids ?? []).slice(5);
    expect(
      [span, bare].map((entry) =>
        entry?.kind === 'element' ? [entry.node.role, entry.node.editable] : null,
      ),
    ).toEqual([
      ['Span', false],
      ['', false],
    ]);
    expect(model.nodeCount).toBe(4);
  });

  it('gives the page of a reference that names none its parent’s, and none when nothing does', () => {
    const model = read(
      tagged('5 0 R', {
        5: '<</Type/StructTreeRoot/K 6 0 R>>',
        6: '<</Type/StructElem/S/P/P 5 0 R/K[<</Type/MCR/MCID 1>> 7 0 R]>>',
        7: '<</Type/StructElem/S/Span/P 6 0 R/Pg 3 0 R/K<</Type/MCR/MCID 2>>>>',
      }),
    );
    const paragraph = model.roots[0];
    expect(paragraph?.pageIndex).toBeNull();
    expect(paragraph?.kids[0]).toMatchObject({ item: { mcid: 1, pageIndex: null } });
    expect(nodePages(paragraph as StructNode)).toEqual([0]);
  });

  it('reads an object listed under two parents once, and a cycle without end', () => {
    const model = read(
      tagged('5 0 R', {
        5: '<</Type/StructTreeRoot/K[6 0 R 7 0 R]>>',
        6: '<</Type/StructElem/S/Sect/P 5 0 R/K[8 0 R]>>',
        7: '<</Type/StructElem/S/Sect/P 5 0 R/K[8 0 R]>>',
        8: '<</Type/StructElem/S/P/P 6 0 R/K[6 0 R 5 0 R]>>',
      }),
    );
    expect(model.roots.map(kind)).toEqual([['o8'], []]);
    expect(model.nodeCount).toBe(3);
  });

  it('reads a direct tree root, and drops marked content directly under the root', () => {
    const model = read(
      tagged('<</Type/StructTreeRoot/K[4 6 0 R]/ParentTree<</Nums[]>>>>', {
        6: '<</S/P/Type/StructElem/K 1>>',
      }),
    );
    expect(model.roots.map((node) => node.key)).toEqual(['o6']);
    expect(model.hasParentTree).toBe(true);
    expect(model.truncated).toBe(false);
  });

  it('stops at the element limit, then reads no further siblings of the branch it stopped in', () => {
    const bytes = tagged('5 0 R', {
      5: '<</Type/StructTreeRoot/K[6 0 R 10 0 R]>>',
      6: '<</Type/StructElem/S/Sect/P 5 0 R/K[7 0 R 8 0 R 9 0 R]>>',
      7: '<</Type/StructElem/S/P/P 6 0 R>>',
      8: '<</Type/StructElem/S/P/P 6 0 R>>',
      9: '<</Type/StructElem/S/P/P 6 0 R>>',
      10: '<</Type/StructElem/S/Sect/P 5 0 R>>',
    });
    const model = read(bytes, 2);
    expect(model.truncated).toBe(true);
    expect(model.nodeCount).toBe(2);
    expect(model.roots.map((node) => node.key)).toEqual(['o6']);
    const full = read(bytes);
    expect([full.truncated, full.nodeCount]).toEqual([false, 5]);
  });

  it('stops at the depth limit', () => {
    const chain: Record<number, string> = { 5: '<</Type/StructTreeRoot/K 10 0 R>>' };
    for (let level = 0; level < 70; level += 1) {
      chain[10 + level] = `<</Type/StructElem/S/Div/K ${11 + level} 0 R>>`;
    }
    const model = read(tagged('5 0 R', chain));
    expect(model.truncated).toBe(true);
    expect(model.nodeCount).toBe(64);
  });
});

describe('walking and asking', () => {
  const tree = modelOf(
    el('d', 'Document', [el('a', 'P', [mcid(1, 2), mcid(2, 0)]), el('b', 'P', [mcid(3, 2)])]),
    el('e', 'P', [{ kind: 'content', item: { kind: 'mcid', mcid: 4, pageIndex: null, inStream: false } }]),
  );

  it('lists the element children, finds a node with its parent, and visits parents first', () => {
    expect(elementKids(tree.roots[0] as StructNode).map((node) => node.key)).toEqual(['a', 'b']);
    expect(elementKids(tree.roots[1] as StructNode)).toEqual([]);
    expect(findNode(tree, 'b')).toMatchObject({ node: { key: 'b' }, parent: { key: 'd' } });
    expect(findNode(tree, 'e')?.parent).toBeNull();
    expect(findNode(tree, 'zz')).toBeNull();
    const visited: string[] = [];
    walkNodes(tree, (node, parent, depth) => visited.push(`${node.key}<${parent?.key ?? '-'}@${depth}`));
    expect(visited).toEqual(['d<-@0', 'a<d@1', 'b<d@1', 'e<-@0']);
  });

  it('lists the pages of a node and everything below it, once and ascending; a node with none lists none', () => {
    expect(nodePages(tree.roots[0] as StructNode)).toEqual([0, 2]);
    expect(nodePages(tree.roots[1] as StructNode)).toEqual([]);
  });
});

describe('edits that are refused', () => {
  const fixed = (...editable: [string, boolean][]) => {
    const flags = new Map(editable);
    const node = (key: string, role: string, kids: readonly (StructKid | StructNode)[] = []) =>
      el(key, role, kids, { editable: flags.get(key) ?? true });
    return modelOf(
      node('d', 'Document', [
        node('h', 'H1'),
        node('s', 'Sect', [node('p1', 'P', [mcid(1)]), node('p2', 'P')]),
        node('x', 'Div', [node('y', 'P')]),
      ]),
    );
  };
  const reasonOn = (model: StructureModel, edit: StructEdit): string | null => {
    try {
      applyStructureEdits(model, [edit]);
      return null;
    } catch (error) {
      if (error instanceof StructEditError) return error.reason;
      throw error;
    }
  };
  const direct = fixed(['h', false], ['p2', false], ['x', false]);

  it('refuses to retype, describe or scope an element the writer cannot address', () => {
    expect(reasonOn(direct, { op: 'role', key: 'h', role: 'H2' })).toBe('not-editable');
    expect(reasonOn(direct, { op: 'alt', key: 'h', alt: 'a' })).toBe('not-editable');
    expect(reasonOn(direct, { op: 'scope', key: 'h', scope: 'Row' })).toBe('not-editable');
    expect(reasonOn(direct, { op: 'role', key: 'nope', role: 'H2' })).toBe('missing');
  });

  it('refuses to move the synthetic root, an element that cannot be addressed, or anything above the document element', () => {
    expect(reasonOn(direct, { op: 'move', key: '<root>', parentKey: 's', index: 0 })).toBe('root');
    expect(reasonOn(direct, { op: 'move', key: 'h', parentKey: 's', index: 0 })).toBe('not-editable');
    expect(reasonOn(fixed(), { op: 'move', key: 'h', parentKey: '<root>', index: 0 })).toBe('root');
    expect(reasonOn(fixed(), { op: 'move', key: 's', parentKey: 's', index: 0 })).toBe('cycle');
    expect(reasonOn(fixed(), { op: 'move', key: 'd', parentKey: 'p1', index: 0 })).toBe('cycle');
  });

  it('refuses to move into or out of a parent that cannot take children', () => {
    expect(reasonOn(fixed(['x', false]), { op: 'move', key: 'h', parentKey: 'x', index: 0 })).toBe(
      'not-editable',
    );
    expect(reasonOn(fixed(['x', false]), { op: 'move', key: 'y', parentKey: 's', index: 0 })).toBe(
      'not-editable',
    );
  });

  it('refuses to group nothing, the root, members that cannot be addressed, or into a parent that cannot be written', () => {
    expect(reasonOn(fixed(), { op: 'group', keys: [], role: 'Div', newKey: 'n' })).toBe('missing');
    expect(reasonOn(fixed(), { op: 'group', keys: ['<root>'], role: 'Div', newKey: 'n' })).toBe('root');
    expect(reasonOn(direct, { op: 'group', keys: ['p1', 'p2'], role: 'Div', newKey: 'n' })).toBe(
      'not-editable',
    );
    expect(reasonOn(fixed(['s', false]), { op: 'group', keys: ['p1', 'p2'], role: 'Div', newKey: 'n' })).toBe(
      'not-editable',
    );
  });

  it('refuses to unwrap or remove the root, the document element, an element that cannot be addressed, or one that owns content', () => {
    for (const op of ['unwrap', 'artifact'] as const) {
      expect(reasonOn(fixed(), { op, key: '<root>' })).toBe('root');
      expect(reasonOn(fixed(), { op, key: 'd' })).toBe('root');
      expect(reasonOn(fixed(['s', false]), { op, key: 's' })).toBe('not-editable');
    }
    expect(reasonOn(fixed(), { op: 'unwrap', key: 'p1' })).toBe('has-content');
  });

  it('refuses to remove an element whose content is an annotation or lives in a form, wherever below it that is', () => {
    const objr = {
      kind: 'content',
      item: { kind: 'objr', objectNumber: 9, pageIndex: 0, subtype: 'Link' },
    } as const;
    const stream = {
      kind: 'content',
      item: { kind: 'mcid', mcid: 1, pageIndex: 0, inStream: true },
    } as const;
    const nested = (leaf: typeof objr | typeof stream) =>
      modelOf(
        el('d', 'Document', [el('s', 'Sect', [el('inner', 'P', [leaf]), el('plain', 'P', [mcid(2)])])]),
      );
    expect(reasonOn(nested(objr), { op: 'artifact', key: 's' })).toBe('interactive');
    expect(reasonOn(nested(stream), { op: 'artifact', key: 's' })).toBe('in-stream');
    expect(reasonOn(nested(stream), { op: 'artifact', key: 'plain' })).toBeNull();
  });
});
