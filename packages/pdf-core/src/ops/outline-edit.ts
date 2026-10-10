/**
 * Outlines (bookmarks), written ("Link & outline editing").
 * The read half is the app's own `PdfDocumentHandle.getOutline()`
 * (`engines/pdfjs-handle.ts`), which resolves every entry's destination to a
 * **0-based page index** and keeps the entry when it cannot (`pageIndex: null`); the
 * destinations this file writes use the same convention, so the tree the panel shows
 * and the tree written here are the same tree.
 *
 * The structure is ISO 32000-2 §12.3.4 and nothing else: `/Root /Outlines` with
 * `/Type /Outlines`, `/First`, `/Last`, `/Count`; items carrying `/Title`, `/Parent`,
 * `/Prev`, `/Next`, `/First`, `/Last`, `/Count`, `/Dest` and optionally `/F` (bit 1
 * italic, bit 2 bold) and `/C` (three 0…1 components). Three consequences are built
 * in rather than left to the caller:
 *
 *  - **`/Count` is recomputed, never patched.** The value is the number of *visible*
 *    descendant items — positive for an open subtree, negative for a closed one. Every
 *    tree this file writes is open, so every count is positive, and after any edit the
 *    counts are recomputed from the structure that is actually there
 *    (`applyCounts`), which also repairs a file whose counts were already wrong.
 *    Nothing here writes a closed subtree: the request model has no "collapsed" flag,
 *    and inventing one would make the panel's expansion state a document property.
 *  - **No orphan trees.** Every object a rewrite replaces or removes is deleted, so an
 *    unlinked item cannot travel in the output. `replace-all` with
 *    an empty list, and `remove` of the last remaining item, therefore end with
 *    `/Outlines` gone from the catalog and every item object gone with it.
 *  - **The sibling chain is rebuilt, not nudged.** A removal re-links the neighbours'
 *    `/Prev`/`/Next` and clears `/First`/`/Last` on the container when it empties;
 *    references are compared by their object number, because two handles can name the
 *    same object.
 *
 * Written through MuPDF's object model (`engines/mupdf-write.ts`); titles go through
 * its `text()`. Nested items are chained onto their parent and a removal drops the
 * removed item from the recount; omitting either makes the writer's own read-back refuse
 * the save.
 *
 * ## Coordinates
 *
 * `/XYZ` destination arrays hold `[pageRef /XYZ left top zoom]` in the page's
 * **unrotated** user space with a bottom-left origin, while the point a caller picks
 * comes from the page as the user is looking at it — displayed, top-left origin,
 * `/Rotate` applied. The conversion therefore runs through the page's own `/Rotate`:
 *
 *   rotation   displayed (u, v) → unrotated user (x, y)        (box x, y, W, H)
 *   0          (box.x + u,             box.y + H − v)
 *   90         (box.x + v,             box.y + u)
 *   180        (box.x + W − u,         box.y + v)
 *   270        (box.x + W − v,         box.y + H − u)
 *
 * — the same mapping `pageSpaceToUser` in `ops/page-boxes.ts` applies to MuPDF page
 * space, and the same one `ops/link-edit.ts` uses for a link's `/Rect`. `/Rotate` is
 * never assumed to be 0: a page without one is a plain flip, a rotated page is not.
 *
 * ## Refusals (never a half-rewritten outline)
 *
 * A direct (inline) `/Outlines` dictionary or item is refused with `unsupported`: an
 * item's `/Parent` is required to be an **indirect** reference (Table 153), so such a
 * tree cannot be represented at all, and rewriting what could never have been written
 * correctly is the kind of guess this codebase refuses to make
 * (`ops/attachments-write.ts` sets the same example). A path that does not resolve, an
 * empty title, a `/XYZ` point with only one coordinate, a chain that revisits an object,
 * a tree deeper than 64 levels and one with more than 20 000 items are refusals too —
 * the last two because every walk here is recursive or linear and a hostile file must
 * not turn into a stack overflow or a hang (`ops/compose.ts` bounds its counters for
 * the same reason).
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  openForWrite,
  pageObjects,
  producerKeptNote,
  readNumbers,
  readText,
  resolved,
  saveRewrite,
  text,
} from '../engines/mupdf-write';
import { hexToRgb } from './annotations';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

export interface OutlineNodeInput {
  readonly title: string;
  readonly destination: {
    readonly pageIndex: number;
    readonly x?: number;
    readonly y?: number;
    readonly zoom?: number;
  } | null;
  readonly children?: readonly OutlineNodeInput[];
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly color?: string;
}

export type OutlineEditRequest =
  | { readonly kind: 'replace-all'; readonly nodes: readonly OutlineNodeInput[] }
  | { readonly kind: 'add-child'; readonly parentPath: readonly number[]; readonly node: OutlineNodeInput }
  | { readonly kind: 'rename'; readonly path: readonly number[]; readonly title: string }
  | { readonly kind: 'remove'; readonly path: readonly number[] };

/** Table 153 flag bits: 1 = italic, 2 = bold. */
const FLAG_ITALIC = 1;
const FLAG_BOLD = 2;

/** Guards against a malformed or hostile outline turning a rewrite into a hang or a crash. */
const MAX_OUTLINE_ITEMS = 20_000;
const MAX_OUTLINE_DEPTH = 64;

/** `#rrggbb`, the colour form every other writer here takes (`hexToRgb`). */
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

interface PageDestination {
  readonly pageIndex: number;
  readonly x?: number;
  readonly y?: number;
  readonly zoom?: number;
}

/** What the writers carry along, so the report can state what a rewrite had to do. */
interface WriteContext {
  /** The page dictionaries, read once per call. */
  readonly pages: readonly PDFObject[];
  /** Destination page indices that had to be clamped into the document. */
  clamped: number;
}

/* ------------------------------------------------------------------ *
 * displayed page space → unrotated user space
 * ------------------------------------------------------------------ */

/** The four values `/Rotate` can hold. */
type PageRotation = 0 | 90 | 180 | 270;

interface PageGeometry {
  readonly rotation: PageRotation;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** `/Rotate` is a multiple of 90; anything else is rounded to the nearest quarter turn. */
function quarterTurns(angle: number): PageRotation {
  const normalized = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

/**
 * The visible box (`/CropBox`, `/MediaBox` as fallback, both inheritable) and the page's
 * inheritable `/Rotate`. A page with neither box is treated as US Letter, the default
 * MuPDF itself applies.
 */
function pageGeometry(page: PDFObject): PageGeometry {
  const rotate = resolved(page.getInheritable('Rotate'));
  const corners = [
    readNumbers(page.getInheritable('CropBox')),
    readNumbers(page.getInheritable('MediaBox')),
  ].find((values) => values.length >= 4) ?? [0, 0, 612, 792];
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = corners;
  return {
    rotation: quarterTurns(rotate?.isNumber() === true ? rotate.asNumber() : 0),
    box: { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) },
  };
}

/**
 * Displayed-space point → unrotated user space: the table in the file header, written
 * once. `u` grows right and `v` down from the displayed page's upper-left corner; the
 * box is the unrotated CropBox, so `W`/`H` are its extents before the rotation.
 */
function displayToUserPoint(
  geometry: PageGeometry,
  u: number,
  v: number,
): { readonly x: number; readonly y: number } {
  const { x, y, width, height } = geometry.box;
  switch (geometry.rotation) {
    case 90:
      return { x: x + v, y: y + u };
    case 180:
      return { x: x + width - u, y: y + v };
    case 270:
      return { x: x + width - v, y: y + height - u };
    default:
      return { x: x + u, y: y + height - v };
  }
}

function isFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function refuse(message: string, path: string): never {
  throw new ToolError('unsupported', { engine: 'mupdf', path, engineMessage: message });
}

/** The object number an entry refers to; `null` for a direct value or a missing key. */
function numberOf(value: PDFObject): number | null {
  return value.isIndirect() ? value.asIndirect() : null;
}

/* ------------------------------------------------------------------ *
 * the tree that is there
 * ------------------------------------------------------------------ */

/** One item of the document's outline, as the input file has it — and as the model the writes keep up to date. */
interface OutlineNode {
  /** The indirect reference other items point at. */
  readonly ref: PDFObject;
  readonly number: number;
  readonly dict: PDFObject;
  /** `/Title` as decoded from the file; kept current so a rename can report the old name. */
  readonly title: string;
  readonly children: OutlineNode[];
}

interface OutlineTree {
  /** `null` when the document has no `/Outlines`. */
  readonly rootRef: PDFObject | null;
  readonly root: PDFObject | null;
  readonly items: OutlineNode[];
}

/** A chain entry has to be an indirect reference to a dictionary (§12.3.4, Table 153). */
function itemEntry(value: PDFObject, path: string): { readonly number: number; readonly dict: PDFObject } {
  const number = numberOf(value);
  if (number === null) {
    refuse(`${path} is not an indirect reference; an outline item needs one for its /Parent`, path);
  }
  const dict = resolved(value);
  if (dict === null || !dict.isDictionary())
    refuse(`${path} (${number} 0 R) does not resolve to a dictionary`, path);
  return { number, dict };
}

function catalogOf(doc: PDFDocument): PDFObject {
  const catalog = resolved(doc.getTrailer().get('Root'));
  if (catalog === null)
    throw new ToolError('corrupt-document', { engine: 'mupdf', engineMessage: 'no /Root' });
  return catalog;
}

/**
 * The document's outline as a model. Cycles and size are checked here because the walk
 * reads a file we did not write: a `/Next` chain that revisits an object would
 * otherwise never end, and a 200 000-item tree would make every later pass crawl.
 */
function readTree(doc: PDFDocument): OutlineTree {
  const value = catalogOf(doc).get('Outlines');
  if (value.isNull()) return { rootRef: null, root: null, items: [] };
  if (!value.isIndirect()) {
    refuse(
      'an inline /Outlines dictionary cannot carry item /Parent references; only an indirect one is editable',
      '/Root/Outlines',
    );
  }
  const root = resolved(value);
  if (root === null || !root.isDictionary()) return { rootRef: value, root: null, items: [] };

  const seen = new Set<number>();
  const read = (container: PDFObject, depth: number): OutlineNode[] => {
    if (depth > MAX_OUTLINE_DEPTH) {
      refuse(`the outline is nested deeper than ${MAX_OUTLINE_DEPTH} levels`, '/Root/Outlines');
    }
    const nodes: OutlineNode[] = [];
    let current = container.get('First');
    while (!current.isNull()) {
      const { number, dict } = itemEntry(current, '/Root/Outlines/First');
      if (seen.has(number)) refuse(`the outline chain revisits object ${number} 0 R`, '/Root/Outlines');
      seen.add(number);
      if (seen.size > MAX_OUTLINE_ITEMS) {
        refuse(`the outline carries more than ${MAX_OUTLINE_ITEMS} items`, '/Root/Outlines');
      }
      nodes.push({
        ref: current,
        number,
        dict,
        title: readText(dict.get('Title')) ?? '',
        children: read(dict, depth + 1),
      });
      current = dict.get('Next');
    }
    return nodes;
  };
  return { rootRef: value, root, items: read(root, 0) };
}

/**
 * The node a path names, with everything the four requests need from it.
 *
 * Paths are child indices from the top of the tree: `[]` is the root, `[2]` the third
 * top-level item, `[2, 0]` its first child.
 */
interface ResolvedPath {
  /** The named node; `null` for the root. */
  readonly node: OutlineNode | null;
  /** The named node's children — where a child appended to it goes. */
  readonly children: OutlineNode[];
  /** The level that lists the named node — what a removal takes it out of. */
  readonly siblings: OutlineNode[];
  /** `/Parent` reference for a child appended to the named node. */
  readonly parentRef: PDFObject;
  /** The dictionary a child appended to the named node is chained onto. */
  readonly owner: PDFObject;
  /** The dictionary whose chain lists the named node; the root for a top-level path. */
  readonly container: PDFObject;
}

function resolvePath(tree: OutlineTree, path: readonly number[], label: string): ResolvedPath {
  const root = tree.root;
  if (root === null) {
    refuse('the document has no outline to resolve a path against', label);
  }
  let container = root;
  // `readTree` returns a root dictionary only together with the reference it came from.
  let parentRef = tree.rootRef as PDFObject;
  let children = tree.items;
  let siblings = tree.items;
  let node: OutlineNode | null = null;
  for (const [depth, index] of path.entries()) {
    if (!Number.isInteger(index) || index < 0) {
      refuse(`path step ${depth} is not a non-negative integer: ${String(index)}`, label);
    }
    const found = children[index];
    if (found === undefined) {
      refuse(`path step ${depth} names item ${index}, but that level has ${children.length} item(s)`, label);
    }
    container = node === null ? root : node.dict;
    siblings = children;
    parentRef = found.ref;
    children = found.children;
    node = found;
  }
  return { node, children, siblings, parentRef, owner: node === null ? root : node.dict, container };
}

/* ------------------------------------------------------------------ *
 * writing
 * ------------------------------------------------------------------ */

/** One item to write: everything the input validator has already judged. */
interface OutlineWriteNode {
  readonly title: string;
  readonly destination: PageDestination | null;
  /** `/F` flags; 0 writes no `/F` at all. */
  readonly flags: number;
  readonly colour: readonly [number, number, number] | null;
  readonly children: readonly OutlineWriteNode[];
}

/**
 * The caller's own tree, validated (so a bad request cannot leave a half-rewritten
 * outline) and converted into what the writer consumes.
 */
function buildWriteNodes(
  nodes: readonly OutlineNodeInput[],
  path: string,
): { readonly nodes: readonly OutlineWriteNode[]; readonly total: number } {
  let total = 0;
  const convert = (level: readonly OutlineNodeInput[], at: string, depth: number): OutlineWriteNode[] => {
    if (depth > MAX_OUTLINE_DEPTH) {
      refuse(`the outline is nested deeper than ${MAX_OUTLINE_DEPTH} levels`, at);
    }
    const converted: OutlineWriteNode[] = [];
    for (const [index, node] of level.entries()) {
      const nodePath = `${at}[${index}]`;
      const title = node.title.trim();
      if (title.length === 0) refuse('an outline item needs a title', `${nodePath}.title`);
      let destination: PageDestination | null = null;
      if (node.destination !== null) {
        const requested = node.destination;
        if (!Number.isInteger(requested.pageIndex)) {
          throw new ToolError('value-out-of-range', {
            engine: 'mupdf',
            path: `${nodePath}.destination.pageIndex`,
            engineMessage: `page index must be an integer, got ${String(requested.pageIndex)}`,
          });
        }
        // x and y are one point: half of it cannot be converted through a rotation that
        // swaps the axes, so a lone coordinate is refused instead of guessed.
        if (isFiniteNumber(requested.x) !== isFiniteNumber(requested.y)) {
          refuse(
            'a /XYZ destination point needs both x and y (they are carried together)',
            `${nodePath}.destination`,
          );
        }
        if (requested.zoom !== undefined && !(isFiniteNumber(requested.zoom) && requested.zoom > 0)) {
          throw new ToolError('value-out-of-range', {
            engine: 'mupdf',
            path: `${nodePath}.destination.zoom`,
            engineMessage: `zoom must be a finite number > 0, got ${String(requested.zoom)}`,
          });
        }
        destination = requested;
      }
      if (node.color !== undefined && !HEX_COLOUR.test(node.color)) {
        // `hexToRgb` answers a malformed colour with an `internal` code (it guards the
        // annotation editor's own state); a colour that arrives in a request is a value,
        // so it is judged as one here before the shared helper ever sees it.
        throw new ToolError('value-out-of-range', {
          engine: 'mupdf',
          path: `${nodePath}.color`,
          engineMessage: `outline colour must be #rrggbb, got "${node.color}"`,
        });
      }
      total += 1;
      if (total > MAX_OUTLINE_ITEMS) {
        refuse(`the outline carries more than ${MAX_OUTLINE_ITEMS} items`, at);
      }
      converted.push({
        title,
        destination,
        flags: (node.bold === true ? FLAG_BOLD : 0) | (node.italic === true ? FLAG_ITALIC : 0),
        colour: node.color === undefined ? null : hexToRgb(node.color),
        children: convert(node.children ?? [], `${nodePath}.children`, depth + 1),
      });
    }
    return converted;
  };
  return { nodes: convert(nodes, path, 0), total };
}

/** The `/Dest` array of one item: `[pageRef /XYZ left top zoom]`, nulls for "unchanged". */
function destinationArray(doc: PDFDocument, destination: PageDestination, write: WriteContext): PDFObject {
  const pages = write.pages;
  const index = Math.min(Math.max(destination.pageIndex, 0), Math.max(pages.length - 1, 0));
  const page = pages[index];
  if (page === undefined) refuse('the document has no pages to point an outline item at', '/Root/Outlines');
  if (index !== destination.pageIndex) write.clamped += 1;
  const geometry = pageGeometry(page);
  const point =
    isFiniteNumber(destination.x) && isFiniteNumber(destination.y)
      ? displayToUserPoint(geometry, destination.x, destination.y)
      : null;
  const array = doc.newArray();
  array.push(page);
  array.push('XYZ');
  array.push(point === null ? doc.newNull() : point.x);
  array.push(point === null ? doc.newNull() : point.y);
  array.push(destination.zoom ?? doc.newNull());
  return array;
}

/**
 * Write one item and its subtree: `/Parent` is set here, the item's own children are
 * chained onto it here, and the item itself is chained by the caller.
 *
 * Chaining the children onto their parent (`/First`/`/Last`) is required: without it any
 * nested tree fails its own read-back.
 */
function writeItem(
  doc: PDFDocument,
  parentRef: PDFObject,
  node: OutlineWriteNode,
  write: WriteContext,
): OutlineNode {
  const ref = doc.addObject(doc.newDictionary());
  // A freshly added dictionary resolves to itself.
  const dict = ref.resolve();
  dict.put('Title', text(doc, node.title));
  dict.put('Parent', parentRef);
  if (node.destination !== null) dict.put('Dest', destinationArray(doc, node.destination, write));
  if (node.flags !== 0) dict.put('F', node.flags);
  if (node.colour !== null) dict.put('C', [...node.colour]);
  const children = node.children.map((child) => writeItem(doc, ref, child, write));
  linkChain(dict, children);
  return { ref, number: ref.asIndirect(), dict, title: node.title, children };
}

/** The last item of a container's own chain, `null` when it has none. */
function chainTail(owner: PDFObject): PDFObject | null {
  let current = owner.get('First');
  let tail: PDFObject | null = null;
  // Every chain walked here was already read by `readTree` in this call, which refuses a
  // chain that revisits an item, runs past MAX_OUTLINE_ITEMS, or holds a link that is not an
  // indirect reference to a dictionary; a container built in this call has an empty chain.
  // So the walk terminates and every link resolves to a dictionary.
  while (current.isIndirect()) {
    tail = current;
    current = (resolved(current) as PDFObject).get('Next');
  }
  if (tail !== null) return tail;
  const last = owner.get('Last');
  return last.isIndirect() ? last : null;
}

/**
 * Append a list of new items to the end of a container's own chain and fix the
 * container's `/First`/`/Last`. The tail comes from walking the chain rather than from
 * `/Last`, so a file whose `/Last` is stale is repaired instead of believed.
 */
function linkChain(owner: PDFObject, nodes: readonly OutlineNode[]): void {
  const head = nodes[0];
  if (head === undefined) return;
  let tail = chainTail(owner);
  let last = head.ref;
  for (const node of nodes) {
    if (tail !== null) {
      node.dict.put('Prev', tail);
      resolved(tail)?.put('Next', node.ref);
    }
    tail = node.ref;
    last = node.ref;
  }
  if (!owner.get('First').isIndirect()) owner.put('First', head.ref);
  owner.put('Last', last);
}

/** Unlink one item from a container's chain, leaving its neighbours linked to each other. */
function unlinkItem(container: PDFObject, victim: OutlineNode): void {
  const previousRef = victim.dict.get('Prev');
  const nextRef = victim.dict.get('Next');
  const previous = previousRef.isIndirect() ? previousRef : null;
  const following = nextRef.isIndirect() ? nextRef : null;

  const before = previous === null ? null : resolved(previous);
  if (before !== null) {
    if (following === null) before.delete('Next');
    else before.put('Next', following);
  }
  const after = following === null ? null : resolved(following);
  if (after !== null) {
    if (previous === null) after.delete('Prev');
    else after.put('Prev', previous);
  }

  const isVictim = (value: PDFObject): boolean => numberOf(value) === victim.number;
  if (isVictim(container.get('First'))) {
    if (following === null) container.delete('First');
    else container.put('First', following);
  }
  if (isVictim(container.get('Last'))) {
    if (previous === null) container.delete('Last');
    else container.put('Last', previous);
  }
}

/**
 * `/Count` everywhere, from the model and from the structure that is actually there:
 * a post-order walk that sets the visible-descendant count on every item that has
 * children (and drops a stale `/Count` from one that has none), then `total` on the
 * root. Every subtree written here is open, so every value is positive (§12.3.4).
 */
function applyCounts(nodes: readonly OutlineNode[]): number {
  let total = 0;
  for (const node of nodes) {
    const descendants = applyCounts(node.children);
    if (node.children.length > 0) node.dict.put('Count', descendants);
    else node.dict.delete('Count');
    total += 1 + descendants;
  }
  return total;
}

/** A fresh `/Outlines` root, linked from the catalog. */
function newRoot(doc: PDFDocument): { readonly rootRef: PDFObject; readonly root: PDFObject } {
  const rootRef = doc.addObject(doc.newDictionary());
  // A freshly added dictionary resolves to itself.
  const root = rootRef.resolve();
  root.put('Type', 'Outlines');
  catalogOf(doc).put('Outlines', rootRef);
  return { rootRef, root };
}

/**
 * The root of a document that has no outline yet, created and attached to the catalog.
 * Only `[]` can name a parent in a tree that does not exist, so any other path is a
 * refusal — the caller is describing a place, not a node.
 */
function createRoot(
  doc: PDFDocument,
  path: readonly number[],
  label: string,
): { readonly tree: OutlineTree; readonly resolved: ResolvedPath } {
  if (path.length > 0) refuse('the document has no outline to resolve a path against', label);
  const { rootRef, root } = newRoot(doc);
  const items: OutlineNode[] = [];
  return {
    tree: { rootRef, root, items },
    resolved: {
      node: null,
      children: items,
      siblings: items,
      parentRef: rootRef,
      owner: root,
      container: root,
    },
  };
}

/** Items in a model subtree — the number `/Count` on the root has to agree with. */
function nodeCount(nodes: readonly OutlineNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + nodeCount(node.children);
  return total;
}

/** Delete every object of a subtree; answers how many were deleted. */
function deleteSubtree(doc: PDFDocument, nodes: readonly OutlineNode[]): number {
  let deleted = 0;
  for (const node of nodes) {
    deleted += 1 + deleteSubtree(doc, node.children);
    doc.deleteObject(node.number);
  }
  return deleted;
}

/**
 * Replace the whole tree: the old objects go first, then the new root is allocated, its
 * items are written and the catalog points at it — or, with no items, the catalog key
 * goes and nothing is allocated at all.
 */
function replaceTree(
  doc: PDFDocument,
  tree: OutlineTree,
  nodes: readonly OutlineWriteNode[],
  write: WriteContext,
): OutlineTree {
  if (tree.rootRef !== null) {
    deleteSubtree(doc, tree.items);
    // `readTree` only accepts an indirect `/Outlines`.
    doc.deleteObject(tree.rootRef.asIndirect());
  }
  catalogOf(doc).delete('Outlines');
  if (nodes.length === 0) return { rootRef: null, root: null, items: [] };

  const { rootRef, root } = newRoot(doc);
  const items = nodes.map((node) => writeItem(doc, rootRef, node, write));
  linkChain(root, items);
  return { rootRef, root, items };
}

/**
 * A step that changed nothing: same bytes, and the report says so. The producer note
 * travels with it, because the document was read and is returned untouched.
 */
function nothingToDo(
  bytes: Uint8Array,
  pageCount: number,
  notes: readonly OperationNote[],
): OperationOutcome {
  return {
    bytes,
    report: {
      engine: 'mupdf',
      steps: ['load'],
      notes: [...notes, note('warning', 'op.note.outline.nothing'), producerKeptNote()],
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount,
      // Nothing was rewritten, so the caller's incremental fast path stays open.
      incremental: true,
    },
  };
}

function verificationFailed(message: string, cause?: unknown): ToolError {
  return new ToolError(
    'verification-failed',
    { engine: 'mupdf', engineMessage: message },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Re-open the produced bytes and read the outline back.
 *
 * A file that does not parse, a page count that moved, a node total that is not the one
 * just written, `/Outlines` still present after it was emptied, or a renamed item that
 * does not carry its new title is `verification-failed`: the caller keeps the original
 * file and the session stays dirty.
 */
async function verifyOutput(
  produced: Uint8Array,
  pageCount: number,
  expectedTotal: number,
  request: OutlineEditRequest,
): Promise<void> {
  let doc: PDFDocument;
  try {
    ({ doc } = await openForWrite(produced));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw verificationFailed(`produced file does not re-open: ${message}`, error);
  }
  try {
    if (doc.countPages() !== pageCount) {
      throw verificationFailed(`produced file has ${doc.countPages()} pages, expected ${pageCount}`);
    }
    const tree = readTree(doc);
    const total = nodeCount(tree.items);
    if (total !== expectedTotal) {
      throw verificationFailed(`produced outline holds ${total} items, expected ${expectedTotal}`);
    }
    if (expectedTotal === 0 && tree.rootRef !== null) {
      throw verificationFailed('the produced file still carries /Outlines after the last item was removed');
    }
    if (request.kind === 'rename') {
      const renamed = resolvePath(tree, request.path, 'request.path').node;
      const title = request.title.trim();
      if (renamed === null || renamed.title !== title) {
        throw verificationFailed(
          `produced outline does not carry the new title "${title}" at the renamed path`,
        );
      }
    }
  } catch (error) {
    if (error instanceof ToolError && error.code === 'verification-failed') throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw verificationFailed(`produced outline does not read back: ${message}`, error);
  } finally {
    doc.destroy();
  }
}

/* ------------------------------------------------------------------ *
 * the operation
 * ------------------------------------------------------------------ */

/** The one request applied to the model and the file; `null` when it changed nothing. */
function applyRequest(
  doc: PDFDocument,
  tree: OutlineTree,
  request: OutlineEditRequest,
  write: WriteContext,
  steps: string[],
  notes: OperationNote[],
): OutlineTree | null {
  if (request.kind === 'replace-all') {
    const built = buildWriteNodes(request.nodes, 'request.nodes');
    if (built.total === 0 && tree.root === null) return null;
    const next = replaceTree(doc, tree, built.nodes, write);
    steps.push('outline.replace');
    notes.push(
      built.total === 0
        ? note('changed', 'op.note.outline.cleared')
        : note('changed', 'op.note.outline.replaced', { count: built.total }),
    );
    return next;
  }
  if (request.kind === 'add-child') {
    const built = buildWriteNodes([request.node], 'request.node');
    let next = tree;
    let place: ResolvedPath;
    if (tree.root === null) {
      const created = createRoot(doc, request.parentPath, 'request.parentPath');
      next = created.tree;
      place = created.resolved;
    } else {
      place = resolvePath(tree, request.parentPath, 'request.parentPath');
    }
    const added = built.nodes.map((node) => writeItem(doc, place.parentRef, node, write));
    linkChain(place.owner, added);
    place.children.push(...added);
    steps.push('outline.addChild');
    notes.push(
      note('changed', 'op.note.outline.childAdded', {
        title: (added[0] as OutlineNode).title,
        count: built.total,
      }),
    );
    return next;
  }
  if (request.kind === 'rename') {
    const title = request.title.trim();
    if (title.length === 0) refuse('an outline item needs a title', 'request.title');
    const target = resolvePath(tree, request.path, 'request.path').node;
    if (target === null) refuse('the outline root carries no title; name an item instead', 'request.path');
    if (target.title === title) return null;
    target.dict.put('Title', text(doc, title));
    steps.push('outline.rename');
    notes.push(note('changed', 'op.note.outline.renamed', { from: target.title, to: title }));
    return tree;
  }
  if (request.path.length === 0) {
    refuse('removing the whole outline is replace-all with an empty node list', 'request.path');
  }
  const place = resolvePath(tree, request.path, 'request.path');
  // A non-empty path always ends on an item.
  const removed = place.node as OutlineNode;
  unlinkItem(place.container, removed);
  const count = deleteSubtree(doc, [removed]);
  // Out of the level that listed it, not out of the item's own children — otherwise the
  // item stays in the model and every removal fails its read-back. `siblings` is the
  // list `removed` was found in.
  place.siblings.splice(place.siblings.indexOf(removed), 1);
  steps.push('outline.remove');
  notes.push(note('changed', 'op.note.outline.removed', { title: removed.title, count }));
  return tree;
}

/**
 * Rewrite, extend or cut the document's outline.
 *
 * `add-child` appends to the end of the parent's chain, which is where a reader shows a
 * new child; `remove` takes the node's whole subtree with it and re-links the
 * neighbours; `rename` writes `/Title` only. Every request ends with the counts
 * recomputed and, when the last item is gone, with `/Outlines` removed entirely.
 */
export async function applyOutlineEdit(
  bytes: Uint8Array,
  request: OutlineEditRequest,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);

  const { doc } = await openForWrite(bytes);
  const notes: OperationNote[] = [];
  const steps: string[] = ['load'];
  let out: Uint8Array;
  let pageCount: number;
  let after: number;
  try {
    try {
      const pages = pageObjects(doc);
      pageCount = pages.length;
      const write: WriteContext = { pages, clamped: 0 };
      const tree = readTree(doc);
      /** What the document's outline held before this call, for the report. */
      const before = nodeCount(tree.items);
      context.onProgress?.({ phase: 'outline', labelKey: 'op.progress.outline', done: 0, total: 1 });

      const next = applyRequest(doc, tree, request, write, steps, notes);
      if (next === null) return nothingToDo(bytes, pageCount, []);
      context.onProgress?.({ phase: 'outline', labelKey: 'op.progress.outline', done: 1, total: 1 });

      after = applyCounts(next.items);
      const catalog = catalogOf(doc);
      const rootRef = catalog.get('Outlines');
      const root = resolved(rootRef);
      if (root !== null) {
        if (after === 0) {
          // The last item is gone: the outline itself goes, objects included.
          catalog.delete('Outlines');
          // `/Outlines` is indirect here: `readTree` refuses a direct one and every root written
          // by this call is added as an object.
          doc.deleteObject(rootRef.asIndirect());
        } else {
          root.put('Count', after);
        }
      }

      if (write.clamped > 0)
        notes.push(note('warning', 'op.note.outline.destinationClamped', { count: write.clamped }));
      notes.push(note('changed', 'op.note.outline.nodes', { before, after }));
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'edit outline');
    }

    steps.push('producer');
    notes.push(producerKeptNote());
    throwIfAborted(context.signal);
    out = saveRewrite(doc, 'edit outline');
  } finally {
    doc.destroy();
  }
  steps.push('save');
  await verifyOutput(out, pageCount, after, request);
  steps.push('verify');

  const report: OperationReport = {
    engine: 'mupdf',
    steps,
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: out.byteLength,
    pageCount,
    // Re-serialised: the incremental fast path is over.
    incremental: false,
  };
  return { bytes: out, report };
}
