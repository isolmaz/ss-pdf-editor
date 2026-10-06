/**
 * The pure semantics of the tag editor, on hand-built trees: what each edit does to the tree,
 * which edits are refused and why, that the input is never modified, and the signature the
 * writer's read-back is compared against. (The same edits written to real bytes and re-read are
 * in `structure.test.ts`.)
 */

import { describe, expect, it } from 'vitest';
import {
  applyStructureEdits,
  EMPTY_MODEL,
  readingOrder,
  type StructContent,
  type StructEdit,
  StructEditError,
  type StructKid,
  type StructNode,
  type StructureModel,
  structureSignature,
} from './structure-model';

const mcid = (id: number, pageIndex = 0): StructKid => ({
  kind: 'content',
  item: { kind: 'mcid', mcid: id, pageIndex, inStream: false },
});

function el(
  key: string,
  role: string,
  kids: readonly (StructKid | StructNode)[] = [],
  extra: Partial<StructNode> = {},
): StructNode {
  return {
    key,
    role,
    standard: role,
    pageIndex: 0,
    alt: null,
    actualText: null,
    lang: null,
    scope: null,
    colSpan: 1,
    rowSpan: 1,
    headers: [],
    elementId: null,
    editable: true,
    kids: kids.map((kid): StructKid => ('kind' in kid ? kid : { kind: 'element', node: kid })),
    ...extra,
  };
}

function modelOf(...roots: StructNode[]): StructureModel {
  return { ...EMPTY_MODEL, present: true, readable: true, roots, nodeCount: 0 };
}

/** Document > H1, Sect > (P, P), Figure; every leaf owns one marked-content id on page 0. */
function sample(): StructureModel {
  return modelOf(
    el('d', 'Document', [
      el('h', 'H1', [mcid(0)]),
      el('s', 'Sect', [el('p1', 'P', [mcid(1)]), el('p2', 'P', [mcid(2)])]),
      el('f', 'Figure', [mcid(3)]),
    ]),
  );
}

const sign = (edits: readonly StructEdit[]): string =>
  structureSignature(applyStructureEdits(sample(), edits));
const reason = (edits: readonly StructEdit[]): string | null => {
  try {
    applyStructureEdits(sample(), edits);
    return null;
  } catch (error) {
    if (error instanceof StructEditError) return error.reason;
    throw error;
  }
};

describe('structureSignature and readingOrder', () => {
  it('writes role, alt text, scope and referenced content, nested', () => {
    expect(structureSignature(sample())).toBe('Document(H1(#0:0),Sect(P(#0:1),P(#0:2)),Figure(#0:3))');
    const withAttributes = modelOf(
      el('t', 'TH', [mcid(4, 1)], { alt: 'Total', scope: 'Column' }),
      el('a', 'Link', [
        { kind: 'content', item: { kind: 'objr', objectNumber: 12, pageIndex: 1, subtype: 'Link' } },
      ]),
    );
    expect(structureSignature(withAttributes)).toBe('TH|alt=Total|scope=Column(#1:4);Link(@12)');
  });

  it('lists only the elements that own content, depth first, with their marked-content ids per page', () => {
    const tree = modelOf(
      el('d', 'Document', [el('h', 'H1', [mcid(0)]), el('s', 'Sect', [el('p', 'P', [mcid(1), mcid(2, 1)])])]),
    );
    const order = readingOrder(tree);
    expect(order.map((entry) => [entry.key, entry.depth, entry.pages])).toEqual([
      ['h', 1, [0]],
      ['p', 2, [0, 1]],
    ]);
    expect([...(order[1]?.mcids ?? [])]).toEqual([
      [0, [1]],
      [1, [2]],
    ]);
  });
});

describe('applyStructureEdits', () => {
  it('moves an element before the one at the given index and leaves its subtree intact', () => {
    expect(sign([{ op: 'move', key: 'f', parentKey: 'd', index: 0 }])).toBe(
      'Document(Figure(#0:3),H1(#0:0),Sect(P(#0:1),P(#0:2)))',
    );
    expect(sign([{ op: 'move', key: 'p2', parentKey: 's', index: 0 }])).toBe(
      'Document(H1(#0:0),Sect(P(#0:2),P(#0:1)),Figure(#0:3))',
    );
    // Into another parent, after its existing children (index past the end).
    expect(sign([{ op: 'move', key: 'h', parentKey: 's', index: 9 }])).toBe(
      'Document(Sect(P(#0:1),P(#0:2),H1(#0:0)),Figure(#0:3))',
    );
  });

  it('retypes to a standard type only, and sets, trims and clears alt text', () => {
    const retyped = applyStructureEdits(sample(), [{ op: 'role', key: 'p1', role: 'H2' }]);
    expect(structureSignature(retyped)).toContain('Sect(H2(#0:1),P(#0:2))');
    expect(reason([{ op: 'role', key: 'p1', role: 'Banana' }])).toBe('role');

    const alt = applyStructureEdits(sample(), [{ op: 'alt', key: 'f', alt: '  A bar chart  ' }]);
    expect(structureSignature(alt)).toContain('Figure|alt=A bar chart(#0:3)');
    const cleared = applyStructureEdits(alt, [{ op: 'alt', key: 'f', alt: null }]);
    expect(structureSignature(cleared)).toBe(structureSignature(sample()));
    expect(reason([{ op: 'alt', key: 'f', alt: '   ' }])).toBe('alt');
  });

  it('groups siblings under a new element at the first one place, in their existing order', () => {
    expect(sign([{ op: 'group', keys: ['f', 'h'], role: 'Div', newKey: 'n1' }])).toBe(
      'Document(Div(H1(#0:0),Figure(#0:3)),Sect(P(#0:1),P(#0:2)))',
    );
    expect(reason([{ op: 'group', keys: ['h', 'p1'], role: 'Div', newKey: 'n1' }])).toBe('not-siblings');
    expect(reason([{ op: 'group', keys: ['h'], role: 'Div', newKey: 'f' }])).toBe('duplicate-key');
    expect(reason([{ op: 'group', keys: ['h'], role: 'Nope', newKey: 'n1' }])).toBe('role');
  });

  it('unwraps an element that owns no content and refuses one that does', () => {
    expect(sign([{ op: 'unwrap', key: 's' }])).toBe('Document(H1(#0:0),P(#0:1),P(#0:2),Figure(#0:3))');
    expect(reason([{ op: 'unwrap', key: 'h' }])).toBe('has-content');
    expect(reason([{ op: 'unwrap', key: 'd' }])).toBe('root');
  });

  it('removes an element for the artifact edit, but not one with interactive or stream content', () => {
    expect(sign([{ op: 'artifact', key: 'f' }])).toBe('Document(H1(#0:0),Sect(P(#0:1),P(#0:2)))');
    const interactive = modelOf(
      el('d', 'Document', [
        el('l', 'Link', [
          { kind: 'content', item: { kind: 'objr', objectNumber: 5, pageIndex: 0, subtype: 'Link' } },
        ]),
        el('x', 'Figure', [
          { kind: 'content', item: { kind: 'mcid', mcid: 1, pageIndex: 0, inStream: true } as StructContent },
        ]),
      ]),
    );
    const refusal = (key: string): string | null => {
      try {
        applyStructureEdits(interactive, [{ op: 'artifact', key }]);
        return null;
      } catch (error) {
        return error instanceof StructEditError ? error.reason : null;
      }
    };
    expect(refusal('l')).toBe('interactive');
    expect(refusal('x')).toBe('in-stream');
    expect(reason([{ op: 'artifact', key: 'd' }])).toBe('root');
  });

  it('refuses a cycle, a missing key and an element that is not editable', () => {
    expect(reason([{ op: 'move', key: 's', parentKey: 'p1', index: 0 }])).toBe('cycle');
    expect(reason([{ op: 'move', key: 'zz', parentKey: 'd', index: 0 }])).toBe('missing');
    const locked = modelOf(el('d', 'Document', [el('h', 'H1', [mcid(0)], { editable: false })]));
    expect(() => applyStructureEdits(locked, [{ op: 'role', key: 'h', role: 'P' }])).toThrow(StructEditError);
  });

  it('applies a draft in order, never modifies its input and applies nothing when one edit fails', () => {
    const base = sample();
    const before = structureSignature(base);
    const result = applyStructureEdits(base, [
      { op: 'group', keys: ['p1', 'p2'], role: 'Div', newKey: 'n1' },
      { op: 'move', key: 'n1', parentKey: 'd', index: 0 },
      { op: 'role', key: 'n1', role: 'Sect' },
    ]);
    expect(structureSignature(result)).toBe('Document(Sect(P(#0:1),P(#0:2)),H1(#0:0),Sect(),Figure(#0:3))');
    expect(result.nodeCount).toBe(7);
    expect(structureSignature(base)).toBe(before);
    expect(() =>
      applyStructureEdits(base, [
        { op: 'role', key: 'h', role: 'H2' },
        { op: 'role', key: 'h', role: 'Banana' },
      ]),
    ).toThrow(StructEditError);
    expect(structureSignature(base)).toBe(before);
  });
});
