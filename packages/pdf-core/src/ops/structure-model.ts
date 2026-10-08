/**
 * The structure tree of a tagged PDF as plain data, and the edits the tag editor makes to
 * it — **without any engine in the way**.
 *
 * Three jobs, deliberately kept apart from the writer (`structure.ts`):
 *
 *   1. `readStructureModel` walks `/StructTreeRoot` through MuPDF's object API and returns
 *      a tree of `StructNode`s. It reads what the file says — `/S`, `/Alt`, `/K`, `/Pg`,
 *      the table attributes — and nothing else; a tree it cannot walk is reported as
 *      `readable: false`, never as an empty one.
 *   2. `applyStructureEdits` is the **pure** semantics of every edit the editor offers
 *      (move, retag, alt text, scope, group, unwrap, artifact). The panel uses it to show
 *      a draft before anything is written, and the writer uses it to know what the file
 *      must read back as: the produced bytes are re-read and compared with this function's
 *      answer, so the writer is checked against an independent description of the edit
 *      rather than against itself.
 *   3. `structureSignature` flattens a tree to a string for exactly that comparison.
 *
 * ## Identity
 *
 * A node's `key` is its object number (`o17`) when it is an indirect object, which is
 * what every well-formed structure element is (`/P` of its children has to point at it),
 * and its path (`p/0/3`) otherwise. A key survives moves and re-reads of an unchanged
 * file, so a draft's edits keep naming the same element while the user reorders. A node
 * the editor creates gets a key from the caller (`n1`, `n2`, …); the writer maps it to
 * the object it creates.
 *
 * ## What is not modelled
 *
 * Content is represented by the items a node *references* — marked-content ids and
 * annotation object references — never by the content itself. An edit therefore moves
 * and relabels elements, and the only edit that touches page content (`artifact`)
 * is executed by the writer, which holds the page streams.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { resolved } from '../engines/mupdf-write';
import { catalogOf, dictOf, intOf, nameOf, pageNumbers, textOf } from './accessibility';
import { resolveRole, STANDARD_ROLES } from './struct-roles';

export { EDITOR_ROLES, resolveRole, STANDARD_ROLES } from './struct-roles';

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

/** What a structure element references as its own content. */
export type StructContent =
  | {
      readonly kind: 'mcid';
      readonly mcid: number;
      /** The page the marked content is on; `null` when neither the MCR nor its ancestors say. */
      readonly pageIndex: number | null;
      /** True when the content lives in a form XObject (`/Stm`), which the editor cannot rewrite. */
      readonly inStream: boolean;
    }
  | {
      readonly kind: 'objr';
      /** The annotation (or XObject) it points at. */
      readonly objectNumber: number | null;
      readonly pageIndex: number | null;
      readonly subtype: string | null;
    };

export type StructKid =
  | { readonly kind: 'element'; readonly node: StructNode }
  | { readonly kind: 'content'; readonly item: StructContent };

export interface StructNode {
  readonly key: string;
  /** `/S` as written (`''` when the element has none). */
  readonly role: string;
  /** The standard type `role` resolves to through `/RoleMap`; `null` when there is none. */
  readonly standard: string | null;
  /** The page of the element's own content (`/Pg`, inherited from its parent); `null` when unknown. */
  readonly pageIndex: number | null;
  readonly alt: string | null;
  readonly actualText: string | null;
  readonly lang: string | null;
  /** `/A` table attributes: the `/Scope`, spans and `/Headers` ids. */
  readonly scope: string | null;
  readonly colSpan: number;
  readonly rowSpan: number;
  readonly headers: readonly string[];
  /** The element's own `/ID`, which `/Headers` point at. */
  readonly elementId: string | null;
  /** False for a direct (non-indirect) element: its children could not point back at it. */
  readonly editable: boolean;
  /** `/K` in file order: child elements and the content items between them. */
  readonly kids: readonly StructKid[];
}

export interface StructureModel {
  /** `/StructTreeRoot` exists. */
  readonly present: boolean;
  /** It is a dictionary this walk could enter. */
  readonly readable: boolean;
  /** The children of the root, normally one `Document`. */
  readonly roots: readonly StructNode[];
  readonly roleMap: Readonly<Record<string, string>>;
  readonly nodeCount: number;
  /** The walk stopped at its bound: counts are lower bounds and the tree is not editable. */
  readonly truncated: boolean;
  readonly hasParentTree: boolean;
}

export const STRUCT_NODE_LIMIT = 30_000;
const STRUCT_DEPTH_LIMIT = 64;

export const EMPTY_MODEL: StructureModel = {
  present: false,
  readable: false,
  roots: [],
  roleMap: {},
  nodeCount: 0,
  truncated: false,
  hasParentTree: false,
};

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

function readRoleMap(root: PDFObject): Record<string, string> {
  const map: Record<string, string> = {};
  const dict = dictOf(root.get('RoleMap'));
  if (dict === null) return map;
  dict.forEach((value, key) => {
    const target = nameOf(value);
    // A dictionary's keys are names, so `String` only narrows the type.
    if (target !== null) map[String(key)] = target;
  });
  return map;
}

/** `/A`: one attribute dictionary or an array of them (revision numbers between are skipped). */
function attributeDicts(element: PDFObject): readonly PDFObject[] {
  const attributes = resolved(element.get('A'));
  if (attributes === null) return [];
  if (attributes.isDictionary()) return [attributes];
  if (!attributes.isArray()) return [];
  const dicts: PDFObject[] = [];
  for (let index = 0; index < attributes.length; index += 1) {
    const dict = dictOf(attributes.get(index));
    if (dict !== null) dicts.push(dict);
  }
  return dicts;
}

/** The table attributes of an element (`/O /Table`), merged in order. */
function tableAttributes(element: PDFObject): {
  readonly scope: string | null;
  readonly colSpan: number;
  readonly rowSpan: number;
  readonly headers: readonly string[];
} {
  let scope: string | null = null;
  let colSpan = 1;
  let rowSpan = 1;
  const headers: string[] = [];
  for (const dict of attributeDicts(element)) {
    const owner = nameOf(dict.get('O'));
    if (owner !== null && owner !== 'Table') continue;
    scope = nameOf(dict.get('Scope')) ?? scope;
    const cols = intOf(dict, 'ColSpan');
    const rows = intOf(dict, 'RowSpan');
    if (cols !== null && cols >= 1) colSpan = cols;
    if (rows !== null && rows >= 1) rowSpan = rows;
    const list = resolved(dict.get('Headers'));
    if (list?.isArray() === true) {
      for (let index = 0; index < list.length; index += 1) {
        const id = textOf(list.get(index));
        if (id !== null) headers.push(id);
      }
    }
  }
  return { scope, colSpan, rowSpan, headers };
}

interface ReadState {
  readonly pageByObject: ReadonlyMap<number, number>;
  readonly roleMap: Readonly<Record<string, string>>;
  readonly visited: Set<number>;
  count: number;
  truncated: boolean;
  readonly limit: number;
}

function pageOf(value: PDFObject, state: ReadState): number | null {
  if (!value.isIndirect()) return null;
  return state.pageByObject.get(value.asIndirect()) ?? null;
}

/** `/K` as a list of entries, whether it is one entry or an array. */
function kidEntries(owner: PDFObject): readonly PDFObject[] {
  const raw = owner.get('K');
  if (raw.isNull()) return [];
  const target = resolved(raw);
  if (target === null) return [];
  if (target.isArray()) {
    const entries: PDFObject[] = [];
    for (let index = 0; index < target.length; index += 1) entries.push(target.get(index));
    return entries;
  }
  return [raw];
}

function readKids(
  owner: PDFObject,
  path: string,
  inheritedPage: number | null,
  depth: number,
  state: ReadState,
): StructKid[] {
  const kids: StructKid[] = [];
  const entries = kidEntries(owner);
  for (const [index, entry] of entries.entries()) {
    if (state.truncated) break;
    if (entry.isNumber()) {
      kids.push({
        kind: 'content',
        item: { kind: 'mcid', mcid: entry.asNumber(), pageIndex: inheritedPage, inStream: false },
      });
      continue;
    }
    const dict = dictOf(entry);
    if (dict === null) continue;
    const type = nameOf(dict.get('Type'));
    if (type === 'MCR') {
      const mcid = intOf(dict, 'MCID');
      if (mcid === null) continue;
      kids.push({
        kind: 'content',
        item: {
          kind: 'mcid',
          mcid,
          pageIndex: pageOf(dict.get('Pg'), state) ?? inheritedPage,
          inStream: !dict.get('Stm').isNull(),
        },
      });
      continue;
    }
    if (type === 'OBJR') {
      const target = dict.get('Obj');
      const targetDict = dictOf(target);
      kids.push({
        kind: 'content',
        item: {
          kind: 'objr',
          objectNumber: target.isIndirect() ? target.asIndirect() : null,
          pageIndex: pageOf(dict.get('Pg'), state) ?? inheritedPage,
          subtype: targetDict === null ? null : nameOf(targetDict.get('Subtype')),
        },
      });
      continue;
    }
    // A structure element. An object reached twice is read once: the second reach is a
    // cycle or a shared child, and walking it again could never terminate.
    const objectNumber = entry.isIndirect() ? entry.asIndirect() : null;
    if (objectNumber !== null) {
      if (state.visited.has(objectNumber)) continue;
      state.visited.add(objectNumber);
    }
    if (depth >= STRUCT_DEPTH_LIMIT || state.count >= state.limit) {
      state.truncated = true;
      break;
    }
    state.count += 1;
    const childPath = `${path}/${String(index)}`;
    const page = pageOf(dict.get('Pg'), state) ?? inheritedPage;
    const role = nameOf(dict.get('S')) ?? '';
    const table = tableAttributes(dict);
    kids.push({
      kind: 'element',
      node: {
        key: objectNumber === null ? `p${childPath}` : `o${String(objectNumber)}`,
        role,
        standard: resolveRole(role, state.roleMap),
        pageIndex: page,
        alt: textOf(dict.get('Alt')),
        actualText: textOf(dict.get('ActualText')),
        lang: textOf(dict.get('Lang')),
        scope: table.scope,
        colSpan: table.colSpan,
        rowSpan: table.rowSpan,
        headers: table.headers,
        elementId: textOf(dict.get('ID')),
        editable: objectNumber !== null,
        kids: readKids(dict, childPath, page, depth + 1, state),
      },
    });
  }
  return kids;
}

/**
 * The structure tree as a model. `limit` bounds the elements visited; past it the walk
 * stops and `truncated` is set — a tree that large is shown, never edited.
 */
export function readStructureModel(
  doc: PDFDocument,
  pages: readonly PDFObject[],
  limit: number = STRUCT_NODE_LIMIT,
): StructureModel {
  const rootValue = catalogOf(doc).get('StructTreeRoot');
  if (rootValue.isNull()) return EMPTY_MODEL;
  const root = dictOf(rootValue);
  if (root === null) return { ...EMPTY_MODEL, present: true };
  const state: ReadState = {
    pageByObject: pageNumbers(pages),
    roleMap: readRoleMap(root),
    visited: new Set(),
    count: 0,
    truncated: false,
    limit,
  };
  if (rootValue.isIndirect()) state.visited.add(rootValue.asIndirect());
  const kids = readKids(root, '', null, 0, state);
  return {
    present: true,
    readable: true,
    roots: kids.flatMap((kid) => (kid.kind === 'element' ? [kid.node] : [])),
    roleMap: state.roleMap,
    nodeCount: state.count,
    truncated: state.truncated,
    hasParentTree: dictOf(root.get('ParentTree')) !== null,
  };
}

/* ------------------------------------------------------------------ *
 * Walking
 * ------------------------------------------------------------------ */

/** Depth-first, parents before children; `parent` is `null` for a root. */
export function walkNodes(
  model: StructureModel,
  visit: (node: StructNode, parent: StructNode | null, depth: number) => void,
): void {
  const walk = (node: StructNode, parent: StructNode | null, depth: number): void => {
    visit(node, parent, depth);
    for (const kid of node.kids) if (kid.kind === 'element') walk(kid.node, node, depth + 1);
  };
  for (const root of model.roots) walk(root, null, 0);
}

export function elementKids(node: StructNode): readonly StructNode[] {
  return node.kids.flatMap((kid) => (kid.kind === 'element' ? [kid.node] : []));
}

export function findNode(
  model: StructureModel,
  key: string,
): { readonly node: StructNode; readonly parent: StructNode | null } | null {
  let found: { node: StructNode; parent: StructNode | null } | null = null;
  walkNodes(model, (node, parent) => {
    if (found === null && node.key === key) found = { node, parent };
  });
  return found;
}

/** The pages holding content of this node or any node below it, ascending. */
export function nodePages(node: StructNode): readonly number[] {
  const pages = new Set<number>();
  const walk = (current: StructNode): void => {
    for (const kid of current.kids) {
      if (kid.kind === 'element') walk(kid.node);
      else if (kid.item.pageIndex !== null) pages.add(kid.item.pageIndex);
    }
  };
  walk(node);
  return [...pages].sort((left, right) => left - right);
}

/** One element that owns content, in the order a reader meets it. */
export interface ReadingEntry {
  readonly key: string;
  readonly role: string;
  readonly standard: string | null;
  /** The pages its **own** content is on (not its descendants'). */
  readonly pages: readonly number[];
  /** Marked-content ids it owns, per page. */
  readonly mcids: ReadonlyMap<number, readonly number[]>;
  readonly depth: number;
}

/**
 * The elements that own content, depth-first: the order assistive technology reads the
 * page in. Containers with no content of their own (`Sect`, `Table`, `L`) are not entries;
 * their descendants are.
 */
export function readingOrder(model: StructureModel): readonly ReadingEntry[] {
  const entries: ReadingEntry[] = [];
  walkNodes(model, (node, _parent, depth) => {
    const mcids = new Map<number, number[]>();
    for (const kid of node.kids) {
      if (kid.kind !== 'content' || kid.item.kind !== 'mcid' || kid.item.pageIndex === null) continue;
      const list = mcids.get(kid.item.pageIndex) ?? [];
      list.push(kid.item.mcid);
      mcids.set(kid.item.pageIndex, list);
    }
    if (mcids.size === 0) return;
    entries.push({
      key: node.key,
      role: node.role,
      standard: node.standard,
      pages: [...mcids.keys()].sort((left, right) => left - right),
      mcids,
      depth,
    });
  });
  return entries;
}

/* ------------------------------------------------------------------ *
 * Edits
 * ------------------------------------------------------------------ */

export type TableScope = 'Column' | 'Row' | 'Both';

export type StructEdit =
  /** Put `key` under `parentKey`, before the element currently at `index` (element kids only). */
  | { readonly op: 'move'; readonly key: string; readonly parentKey: string; readonly index: number }
  | { readonly op: 'role'; readonly key: string; readonly role: string }
  | { readonly op: 'alt'; readonly key: string; readonly alt: string | null }
  | { readonly op: 'scope'; readonly key: string; readonly scope: TableScope | null }
  /** Wrap sibling elements in a new element (`newKey`) that takes the first one's place. */
  | { readonly op: 'group'; readonly keys: readonly string[]; readonly role: string; readonly newKey: string }
  /** Replace an element that owns no content by its children. */
  | { readonly op: 'unwrap'; readonly key: string }
  /** Mark an element's content (and its descendants') as an artifact and drop the elements. */
  | { readonly op: 'artifact'; readonly key: string };

/** A refused edit; `reason` is a stable word the writer and the panel can branch on. */
export class StructEditError extends Error {
  readonly reason:
    | 'missing'
    | 'not-editable'
    | 'cycle'
    | 'not-siblings'
    | 'role'
    | 'alt'
    | 'has-content'
    | 'interactive'
    | 'in-stream'
    | 'duplicate-key'
    | 'root';
  constructor(reason: StructEditError['reason'], message: string) {
    super(message);
    this.name = 'StructEditError';
    this.reason = reason;
  }
}

interface MutableNode {
  key: string;
  role: string;
  standard: string | null;
  pageIndex: number | null;
  alt: string | null;
  actualText: string | null;
  lang: string | null;
  scope: string | null;
  colSpan: number;
  rowSpan: number;
  headers: readonly string[];
  elementId: string | null;
  editable: boolean;
  kids: MutableKid[];
}
type MutableKid = { kind: 'element'; node: MutableNode } | { kind: 'content'; item: StructContent };

function cloneNode(node: StructNode): MutableNode {
  return {
    ...node,
    kids: node.kids.map(
      (kid): MutableKid =>
        kid.kind === 'element'
          ? { kind: 'element', node: cloneNode(kid.node) }
          : { kind: 'content', item: kid.item },
    ),
  };
}

interface Location {
  readonly node: MutableNode;
  readonly parent: MutableNode | null;
}

function locate(roots: readonly MutableNode[], key: string): Location | null {
  const walk = (node: MutableNode, parent: MutableNode | null): Location | null => {
    if (node.key === key) return { node, parent };
    for (const kid of node.kids) {
      if (kid.kind !== 'element') continue;
      const found = walk(kid.node, node);
      if (found !== null) return found;
    }
    return null;
  };
  for (const root of roots) {
    const found = walk(root, null);
    if (found !== null) return found;
  }
  return null;
}

function contains(node: MutableNode, key: string): boolean {
  return node.kids.some((kid) => kid.kind === 'element' && (kid.node.key === key || contains(kid.node, key)));
}

function rawIndexOf(parent: MutableNode, key: string): number {
  return parent.kids.findIndex((kid) => kid.kind === 'element' && kid.node.key === key);
}

/** The raw `kids` position that is "before the `index`-th element kid" (end when there is none). */
function rawPositionForElementIndex(parent: MutableNode, index: number): number {
  let seen = 0;
  for (const [position, kid] of parent.kids.entries()) {
    if (kid.kind !== 'element') continue;
    if (seen === index) return position;
    seen += 1;
  }
  return parent.kids.length;
}

/** Roots are edited as the kids of a synthetic holder, so "the parent of a root" exists. */
function collectInteractive(node: MutableNode): 'interactive' | 'in-stream' | null {
  for (const kid of node.kids) {
    if (kid.kind === 'element') {
      const inner = collectInteractive(kid.node);
      if (inner !== null) return inner;
    } else if (kid.item.kind === 'objr') {
      return 'interactive';
    } else if (kid.item.inStream) {
      return 'in-stream';
    }
  }
  return null;
}

function validRole(role: string): boolean {
  return STANDARD_ROLES.has(role);
}

/**
 * Apply edits to a model, in order, and return the result. Pure: the input is not
 * modified. A refused edit throws `StructEditError` and applies nothing — the caller
 * validates a whole draft before it writes anything.
 */
export function applyStructureEdits(model: StructureModel, edits: readonly StructEdit[]): StructureModel {
  const roots = model.roots.map(cloneNode);
  // The synthetic holder gives a root a parent for `move`/`group`/`unwrap`. It is never
  // returned, and nothing may be moved *above* the topmost real element.
  const holder: MutableNode = {
    key: '<root>',
    role: '',
    standard: null,
    pageIndex: null,
    alt: null,
    actualText: null,
    lang: null,
    scope: null,
    colSpan: 1,
    rowSpan: 1,
    headers: [],
    elementId: null,
    editable: false,
    kids: roots.map((node): MutableKid => ({ kind: 'element', node })),
  };
  const find = (key: string): Location => {
    const found = locate([holder], key);
    if (found === null) throw new StructEditError('missing', `no element with key ${key}`);
    return found;
  };
  const known = new Set<string>();
  const remember = (node: MutableNode): void => {
    known.add(node.key);
    for (const kid of node.kids) if (kid.kind === 'element') remember(kid.node);
  };
  remember(holder);

  for (const edit of edits) {
    switch (edit.op) {
      case 'role': {
        const { node } = find(edit.key);
        if (!node.editable) throw new StructEditError('not-editable', `${edit.key} cannot be edited`);
        if (!validRole(edit.role)) throw new StructEditError('role', `${edit.role} is not a standard type`);
        node.role = edit.role;
        node.standard = edit.role;
        break;
      }
      case 'alt': {
        const { node } = find(edit.key);
        if (!node.editable) throw new StructEditError('not-editable', `${edit.key} cannot be edited`);
        const value = edit.alt === null ? null : edit.alt.trim();
        if (value === '') throw new StructEditError('alt', 'an empty alternative text is refused');
        node.alt = value;
        break;
      }
      case 'scope': {
        const { node } = find(edit.key);
        if (!node.editable) throw new StructEditError('not-editable', `${edit.key} cannot be edited`);
        node.scope = edit.scope;
        break;
      }
      case 'move': {
        const { node, parent } = find(edit.key);
        // A top-level element may be moved among its siblings like any other, so the
        // holder as a parent is fine here; only a node with no parent at all is refused.
        if (parent === null) throw new StructEditError('root', 'the root cannot be moved');
        if (!node.editable) throw new StructEditError('not-editable', `${edit.key} cannot be moved`);
        const target = find(edit.parentKey).node;
        if (target === node || contains(node, target.key)) {
          throw new StructEditError('cycle', 'an element cannot be moved into itself');
        }
        if (target === holder && parent !== holder) {
          throw new StructEditError('root', 'nothing is moved above the document element');
        }
        // The move rewrites the /K of the parent it leaves and of the one it joins; an
        // element the writer cannot address (a direct one) can be neither. The holder is
        // not written as an element, so moves among the top-level elements stay allowed.
        for (const changed of [parent, target]) {
          if (changed !== holder && !changed.editable) {
            throw new StructEditError('not-editable', `${changed.key} cannot take or give up children`);
          }
        }
        const from = rawIndexOf(parent, node.key);
        parent.kids.splice(from, 1);
        const at = rawPositionForElementIndex(target, edit.index);
        target.kids.splice(at, 0, { kind: 'element', node });
        break;
      }
      case 'group': {
        if (known.has(edit.newKey)) throw new StructEditError('duplicate-key', `${edit.newKey} exists`);
        if (!validRole(edit.role)) throw new StructEditError('role', `${edit.role} is not a standard type`);
        if (edit.keys.length === 0) throw new StructEditError('missing', 'nothing to group');
        const first = find(edit.keys[0] as string);
        const parent = first.parent;
        if (parent === null) throw new StructEditError('root', 'the root cannot be grouped');
        // The wrapper replaces the members in the parent's /K, which must be writable.
        if (parent !== holder && !parent.editable) {
          throw new StructEditError('not-editable', `${parent.key} cannot take a new group`);
        }
        const members: MutableNode[] = [];
        for (const key of edit.keys) {
          const located = find(key);
          if (located.parent !== parent) {
            throw new StructEditError('not-siblings', 'grouped elements must share a parent');
          }
          if (!located.node.editable) throw new StructEditError('not-editable', `${key} cannot be grouped`);
          members.push(located.node);
        }
        // Kept in the order they already have among their siblings, whatever order was named.
        const ordered = parent.kids.flatMap((kid) =>
          kid.kind === 'element' && members.includes(kid.node) ? [kid.node] : [],
        );
        const position = rawIndexOf(parent, (ordered[0] as MutableNode).key);
        const wrapper: MutableNode = {
          key: edit.newKey,
          role: edit.role,
          standard: edit.role,
          pageIndex: ordered.find((node) => node.pageIndex !== null)?.pageIndex ?? null,
          alt: null,
          actualText: null,
          lang: null,
          scope: null,
          colSpan: 1,
          rowSpan: 1,
          headers: [],
          elementId: null,
          editable: true,
          kids: ordered.map((node): MutableKid => ({ kind: 'element', node })),
        };
        parent.kids = parent.kids.filter((kid) => kid.kind !== 'element' || !ordered.includes(kid.node));
        parent.kids.splice(position, 0, { kind: 'element', node: wrapper });
        known.add(edit.newKey);
        break;
      }
      case 'unwrap': {
        const { node, parent } = find(edit.key);
        if (parent === null) throw new StructEditError('root', 'the root cannot be unwrapped');
        if (!node.editable) throw new StructEditError('not-editable', `${edit.key} cannot be unwrapped`);
        if (parent === holder) throw new StructEditError('root', 'the document element stays');
        if (node.kids.some((kid) => kid.kind === 'content')) {
          throw new StructEditError('has-content', 'an element that owns content cannot be unwrapped');
        }
        const position = rawIndexOf(parent, node.key);
        parent.kids.splice(position, 1, ...node.kids);
        break;
      }
      case 'artifact': {
        const { node, parent } = find(edit.key);
        if (parent === null) throw new StructEditError('root', 'the root cannot be removed');
        if (parent === holder) throw new StructEditError('root', 'the document element stays');
        if (!node.editable) throw new StructEditError('not-editable', `${edit.key} cannot be removed`);
        const blocked = collectInteractive(node);
        if (blocked !== null)
          throw new StructEditError(blocked, 'this element holds content that cannot be rewritten');
        parent.kids.splice(rawIndexOf(parent, node.key), 1);
        break;
      }
    }
  }

  const finish = (node: MutableNode): StructNode => ({
    ...node,
    kids: node.kids.map(
      (kid): StructKid =>
        kid.kind === 'element'
          ? { kind: 'element', node: finish(kid.node) }
          : { kind: 'content', item: kid.item },
    ),
  });
  const result = elementKids(finish(holder));
  let count = 0;
  const tally = (node: StructNode): void => {
    count += 1;
    for (const kid of node.kids) if (kid.kind === 'element') tally(kid.node);
  };
  for (const root of result) tally(root);
  return { ...model, roots: result, nodeCount: count };
}

/**
 * A tree as a string: role, alt text, scope and the content each node references, nested.
 * Two trees with the same signature read the same to an assistive technology, which is the
 * comparison the writer's read-back makes against `applyStructureEdits`.
 */
export function structureSignature(model: StructureModel): string {
  const render = (node: StructNode): string => {
    const own = `${node.role}${node.alt === null ? '' : `|alt=${node.alt}`}${node.scope === null ? '' : `|scope=${node.scope}`}`;
    const inner = node.kids
      .map((kid) => {
        if (kid.kind === 'element') return render(kid.node);
        const item = kid.item;
        return item.kind === 'mcid'
          ? `#${String(item.pageIndex)}:${String(item.mcid)}`
          : `@${String(item.objectNumber)}`;
      })
      .join(',');
    return `${own}(${inner})`;
  };
  return model.roots.map(render).join(';');
}
