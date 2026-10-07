/** Hand-built structure trees: elements, marked-content ids and models, for the pure edits and the walks. */

import { EMPTY_MODEL, type StructKid, type StructNode, type StructureModel } from './structure-model';

export const mcid = (id: number, pageIndex = 0): StructKid => ({
  kind: 'content',
  item: { kind: 'mcid', mcid: id, pageIndex, inStream: false },
});

export function el(
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

export function modelOf(...roots: StructNode[]): StructureModel {
  return { ...EMPTY_MODEL, present: true, readable: true, roots, nodeCount: 0 };
}
