/**
 * Reading order and tags: the reader of a document's structure and the writer of the
 * edits the tag editor makes (`structure-model.ts` holds the data model and the pure
 * semantics of every edit).
 *
 * ## What is read
 *
 *   - `readStructure` — the structure tree of a tagged file, as a `StructureModel`.
 *   - `readPageLayout` — where each marked-content id of one page sits (a box and the
 *     text it holds), so the panel can number the page's blocks in reading order. The
 *     boxes come from the page's glyphs (the text model) and from the geometry of the
 *     pictures and paths the sequence paints; a sequence the page paints with something
 *     this reader cannot bound simply has no box.
 *   - `readTagCandidates` — for an **untagged** file, the blocks and figures the tagger
 *     would claim, in content order, with the role it would give each. This is the
 *     reading order such a file has today (a reader without tags falls back to content
 *     order), and the starting point of an edited order.
 *
 * ## What is written
 *
 * `editStructure` applies `StructEdit`s to the file's own objects: `/S` for a retag,
 * `/Alt`, the table `/Scope`, the order of `/K`, the `/P` back pointers, and new elements
 * for a group. Content is rewritten for exactly one edit — marking an element as an
 * artifact — by turning its `BDC` into `/Artifact BMC` and clearing the parent-tree slot.
 * The edited tree is **re-read from the saved bytes** and compared, signature for
 * signature, with what `applyStructureEdits` says the edit must produce; a difference is
 * `verification-failed`.
 *
 * ## What it does not do
 *
 * It never invents content: no block is added to a tagged page, and an element's content
 * ids are never renumbered. A tree it cannot read to the end (`truncated`), an element
 * that is a direct object, and marked content inside a form XObject are shown but not
 * edited.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import type { MessageKey } from 'pdf-shared';
import { ToolError } from 'pdf-shared';
import type { PageTextInput, Rect } from 'pdf-text-engine';
import { buildTextPage } from 'pdf-text-engine';
import { mapMupdfError } from '../engines/mupdf';
import {
  openForWrite,
  pageObjects,
  pageOutOfRange,
  producerKeptNote,
  readNumbers,
  resolved,
  saveRewrite,
  text,
} from '../engines/mupdf-write';
import { readPageText } from '../text-source';
import {
  catalogOf,
  claimsFor,
  dictOf,
  intOf,
  isAbort,
  nameOf,
  type PageTextReader,
  pageContent,
  planPages,
  readInstructions,
} from './accessibility';
import {
  type ContentHooks,
  mcidOf,
  mcidOfInstruction,
  type PaintOp,
  scanContent,
  type UserRect,
} from './content-scan';
import { pageGeometry } from './stamp';
import {
  applyStructureEdits,
  findNode,
  readStructureModel,
  type StructEdit,
  StructEditError,
  type StructNode,
  type StructureModel,
  structureSignature,
} from './structure-model';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

export type { TagPlan } from './accessibility';

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

/**
 * The `MessageKey` seam of this module, the same one `A11Y_KEYS` uses: every key is
 * declared in `packages/shared/src/i18n/parts/uatags.ts` and `en-parts/uatags.ts`.
 */
function dictKey(value: string): MessageKey {
  return value as MessageKey;
}

export const STRUCT_KEYS = {
  progressWrite: dictKey('op.progress.tags.write'),
  progressVerify: dictKey('op.progress.tags.verify'),
  reordered: dictKey('op.note.tags.reordered'),
  retagged: dictKey('op.note.tags.retagged'),
  altSet: dictKey('op.note.tags.altSet'),
  altCleared: dictKey('op.note.tags.altCleared'),
  scopeSet: dictKey('op.note.tags.scopeSet'),
  grouped: dictKey('op.note.tags.grouped'),
  unwrapped: dictKey('op.note.tags.unwrapped'),
  artifact: dictKey('op.note.tags.artifact'),
  contentRewritten: dictKey('op.note.tags.contentRewritten'),
  parentTreeCleared: dictKey('op.note.tags.parentTreeCleared'),
  contentPartlyMissing: dictKey('op.note.tags.contentPartlyMissing'),
} as const;

/* ------------------------------------------------------------------ *
 * Page geometry and content hooks
 * ------------------------------------------------------------------ */

/** The page's resources as the scan needs them: `/Properties` MCIDs and the `Do` targets. */
export function contentHooks(page: PDFObject): ContentHooks {
  return resourceHooks(dictOf(page.getInheritable('Resources')));
}

/** The same for any resource dictionary — a form XObject's own, for instance. */
export function resourceHooks(resources: PDFObject | null): ContentHooks {
  return {
    properties: (name) => {
      const properties = dictOf(resources?.get('Properties'));
      const entry = properties === null ? null : dictOf(properties.get(name));
      return entry === null ? null : intOf(entry, 'MCID');
    },
    xobject: (name) => {
      const xobjects = dictOf(resources?.get('XObject'));
      if (xobjects === null) return null;
      const entry = xobjects.get(name);
      if (entry.isNull() || !entry.isStream()) return null;
      const dict = resolved(entry);
      if (dict === null) return null;
      const subtype = nameOf(dict.get('Subtype'));
      if (subtype === 'Image') return { kind: 'image' };
      if (subtype !== 'Form') return { kind: 'other' };
      const box = readNumbers(dict.get('BBox'));
      const matrix = readNumbers(dict.get('Matrix'));
      const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = box;
      const [m0 = 1, m1 = 0, m2 = 0, m3 = 1, m4 = 0, m5 = 0] = matrix;
      return {
        kind: 'form',
        ...(box.length >= 4 ? { bbox: [b0, b1, b2, b3] as const } : {}),
        ...(matrix.length >= 6 ? { matrix: [m0, m1, m2, m3, m4, m5] as const } : {}),
      };
    },
  };
}

/** A user-space box (y up) as a page-relative rect: origin at the page box's top-left, y down. */
function relativeUserRect(box: { x: number; y: number; height: number }, rect: UserRect): Rect {
  const top = box.y + box.height;
  return [rect[0] - box.x, top - rect[3], rect[2] - box.x, top - rect[1]];
}

function unionRect(current: Rect | null, next: Rect): Rect {
  if (current === null) return next;
  return [
    Math.min(current[0], next[0]),
    Math.min(current[1], next[1]),
    Math.max(current[2], next[2]),
    Math.max(current[3], next[3]),
  ];
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export interface StructureView {
  readonly pageCount: number;
  readonly model: StructureModel;
}

/** The structure tree of a file. Never modifies `bytes`. */
export async function readStructure(bytes: Uint8Array, context: OperationContext): Promise<StructureView> {
  throwIfAborted(context.signal);
  const { doc } = await openForWrite(bytes);
  try {
    const pages = pageObjects(doc);
    return { pageCount: pages.length, model: readStructureModel(doc, pages) };
  } catch (error) {
    if (isAbort(error)) throw error;
    throw mapMupdfError(error, 'read structure');
  } finally {
    doc.destroy();
  }
}

/** One marked-content sequence of a page: where it is and what it says. */
export interface LayoutItem {
  readonly mcid: number;
  /** Page-relative, top-left origin, unrotated points; `null` when nothing could bound it. */
  readonly rect: Rect | null;
  /** The text of its glyphs, clipped; `''` for a picture or a drawing. */
  readonly text: string;
}

export interface PageLayout {
  readonly pageIndex: number;
  /** The visible page box, unrotated. */
  readonly width: number;
  readonly height: number;
  readonly rotation: 0 | 90 | 180 | 270;
  readonly items: readonly LayoutItem[];
  /** The page's text could not be read: boxes come from drawings and pictures only. */
  readonly textFailed: boolean;
  /** The content stream could not be tokenized: no item is known. */
  readonly unreadable: boolean;
}

const LABEL_LIMIT = 120;

interface GlyphRef {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly rect: Rect;
  readonly ch: string;
  readonly word: number;
}

function glyphsOf(input: PageTextInput): readonly GlyphRef[] {
  const page = buildTextPage(input);
  const glyphs: GlyphRef[] = [];
  let word = 0;
  for (const block of page.blocks) {
    for (const line of block.lines) {
      for (const entry of line.words) {
        word += 1;
        for (const glyph of entry.glyphs) {
          glyphs.push({
            x: glyph.origin?.[0] ?? glyph.rect[0],
            y: glyph.origin?.[1] ?? glyph.rect[3],
            size: glyph.size ?? Math.max(1, glyph.rect[3] - glyph.rect[1]),
            rect: glyph.rect,
            ch: glyph.ch,
            word,
          });
        }
      }
    }
  }
  return glyphs;
}

/**
 * The marked-content items of one page with their boxes.
 *
 * A glyph belongs to the text-showing operator whose origin is the nearest one at or
 * before it on its baseline — the operator that started the run it is part of. Operators
 * that sit in no marked-content id (artifacts, untagged text) take part in that choice too,
 * so a glyph is never handed to a tagged neighbour just because that one was closer.
 * Consecutive operators with the same origin (advances inside a run are not computed here)
 * are one run for this purpose and the first of them owns it.
 */
export async function readPageLayout(
  bytes: Uint8Array,
  pageIndex: number,
  context: OperationContext,
  options: { readonly pageText?: PageTextReader } = {},
): Promise<PageLayout> {
  throwIfAborted(context.signal);
  const { doc } = await openForWrite(bytes);
  let geometry: ReturnType<typeof pageGeometry>;
  let marks: ReturnType<typeof scanContent> | null = null;
  try {
    const pages = pageObjects(doc);
    const page = pages[pageIndex];
    if (page === undefined) throw pageOutOfRange(pageIndex, 'read page layout');
    geometry = pageGeometry(page);
    const content = pageContent(page);
    const instructions = content === null ? null : readInstructions(content.bytes);
    if (content !== null && instructions !== null) {
      marks = scanContent(content.bytes, instructions, contentHooks(page));
    }
  } catch (error) {
    if (isAbort(error)) throw error;
    throw mapMupdfError(error, 'read page layout');
  } finally {
    doc.destroy();
  }
  const base = {
    pageIndex,
    width: geometry.box.width,
    height: geometry.box.height,
    rotation: geometry.rotation,
  };
  if (marks === null) return { ...base, items: [], textFailed: false, unreadable: true };

  let glyphs: readonly GlyphRef[] = [];
  let textFailed = false;
  const hasText = marks.paints.some((paint) => paint.kind === 'text');
  if (hasText) {
    try {
      glyphs = glyphsOf(await (options.pageText ?? readPageText)(bytes, pageIndex, context));
    } catch (error) {
      if (isAbort(error)) throw error;
      textFailed = true;
    }
  }
  return { ...base, items: layoutItems(marks, glyphs, geometry.box), textFailed, unreadable: false };
}

function layoutItems(
  marks: ReturnType<typeof scanContent>,
  glyphs: readonly GlyphRef[],
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): readonly LayoutItem[] {
  const rects = new Map<number, Rect | null>();
  const texts = new Map<number, string[]>();
  const touch = (mcid: number): void => {
    if (!rects.has(mcid)) {
      rects.set(mcid, null);
      texts.set(mcid, []);
    }
  };
  for (const span of marks.spans) if (span.mcid !== null) touch(span.mcid);

  /* ---- text: every operator competes, only the tagged ones keep what they win ---- */
  const runs = marks.paints
    .filter(
      (paint): paint is PaintOp & { origin: { x: number; y: number } } =>
        paint.kind === 'text' && paint.origin !== null,
    )
    .map((paint) => ({
      index: paint.index,
      x: paint.origin.x,
      y: 2 * box.y + box.height - paint.origin.y,
      size: paint.fontSize,
      mcid: mcidOf(marks, paint),
      origin: paint.origin,
    }));
  const rows = new Map<number, typeof runs>();
  for (const run of runs) {
    const key = Math.round(run.y);
    const row = rows.get(key);
    if (row === undefined) rows.set(key, [run]);
    else row.push(run);
  }
  const used = new Set<number>();
  let previousWord = -1;
  let previousMcid: number | null = null;
  for (const glyph of glyphs) {
    const tolerance = Math.max(1.5, Math.min(glyph.size, 40) * 0.4);
    let best: (typeof runs)[number] | null = null;
    for (let key = Math.round(glyph.y - tolerance); key <= Math.round(glyph.y + tolerance); key += 1) {
      for (const run of rows.get(key) ?? []) {
        if (Math.abs(run.y - glyph.y) > tolerance || run.x > glyph.x + 0.75) continue;
        if (
          best === null ||
          run.x > best.x + 0.01 ||
          (Math.abs(run.x - best.x) <= 0.01 && run.index < best.index)
        ) {
          best = run;
        }
      }
    }
    if (best === null || best.mcid === null) {
      previousWord = glyph.word;
      previousMcid = null;
      continue;
    }
    used.add(best.index);
    const mcid = best.mcid;
    touch(mcid);
    rects.set(
      mcid,
      unionRect(rects.get(mcid) ?? null, [
        glyph.rect[0] - box.x,
        glyph.rect[1] - box.y,
        glyph.rect[2] - box.x,
        glyph.rect[3] - box.y,
      ]),
    );
    const parts = texts.get(mcid) as string[];
    if (previousMcid === mcid && previousWord !== glyph.word && parts.length > 0) parts.push(' ');
    parts.push(glyph.ch);
    previousWord = glyph.word;
    previousMcid = mcid;
  }
  // Text the glyph model could not place still leaves a mark on the page: a small box at
  // the operator's origin, so the block is not missing from the overlay altogether.
  for (const run of runs) {
    if (run.mcid === null || used.has(run.index) || rects.get(run.mcid) !== null) continue;
    const size = Math.max(4, run.size);
    const top = box.y + box.height - run.origin.y;
    rects.set(run.mcid, [
      run.origin.x - box.x,
      top - size,
      run.origin.x - box.x + size * 2,
      top + size * 0.25,
    ]);
  }

  /* ---- pictures, forms and drawings ---- */
  for (const paint of marks.paints) {
    if (paint.kind === 'text' || paint.bbox === null) continue;
    const mcid = mcidOf(marks, paint);
    if (mcid === null) continue;
    touch(mcid);
    rects.set(mcid, unionRect(rects.get(mcid) ?? null, relativeUserRect(box, paint.bbox)));
  }

  const items: LayoutItem[] = [];
  for (const [mcid, rect] of rects) {
    const label = (texts.get(mcid) ?? []).join('').replace(/\s+/g, ' ').trim();
    items.push({
      mcid,
      rect,
      text: label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT - 1)}…` : label,
    });
  }
  return items.sort((left, right) => left.mcid - right.mcid);
}

/** A block or picture the tagger would claim in an untagged file. */
export interface TagCandidate {
  /** The text model's block id (`b3`), or `f<instruction>` for a picture. */
  readonly id: string;
  readonly kind: 'text' | 'figure';
  /** The role the tagger would give it: a size-based heading guess, `P`, or `Figure`. */
  readonly role: string;
  readonly text: string;
  /** The alt text the picture's XObject already carries. */
  readonly alt: string | null;
  /** Page-relative, top-left origin, unrotated points. */
  readonly rect: Rect | null;
}

export interface TagCandidatePage {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: 0 | 90 | 180 | 270;
  /** In content-stream order — the order a reader without tags meets them in. */
  readonly candidates: readonly TagCandidate[];
  /** Blocks the tagger could not wrap without crossing a text object or `q` level. */
  readonly skipped: number;
}

export interface TagCandidates {
  readonly pages: readonly TagCandidatePage[];
  /** Why pages were left out (no text layer, unreadable stream, …). */
  readonly notes: readonly OperationNote[];
  readonly bodySize: number;
}

/**
 * What an untagged file would be tagged with, per page, in content order. The same
 * planning pass `tagDocument` runs, so the editor shows exactly the blocks the write can
 * claim — never a block the writer would then drop.
 */
export async function readTagCandidates(
  bytes: Uint8Array,
  context: OperationContext,
  options: { readonly pageText?: PageTextReader } = {},
): Promise<TagCandidates> {
  throwIfAborted(context.signal);
  const { doc } = await openForWrite(bytes);
  try {
    const planned = await planPages(doc, bytes, context, options.pageText ?? readPageText);
    const pages: TagCandidatePage[] = [];
    for (const plan of planned.plans) {
      throwIfAborted(context.signal);
      const page = pageObjects(doc)[plan.pageIndex];
      if (page === undefined) continue;
      const geometry = pageGeometry(page);
      const box = geometry.box;
      const marks = scanContent(plan.scan.bytes, plan.scan.instructions, contentHooks(page));
      const claimed = claimsFor(plan, planned.roles);
      const candidates: TagCandidate[] = [];
      const listed = new Set<string>();
      for (const claim of claimed.claims) {
        // A block spanning several text objects has several claims and one candidate.
        if (listed.has(claim.blockId)) continue;
        listed.add(claim.blockId);
        const region = plan.regions.find((entry) => entry.id === claim.blockId);
        if (region !== undefined) {
          candidates.push({
            id: claim.blockId,
            kind: 'text',
            role: claim.role,
            text: region.text,
            alt: null,
            rect: [
              region.rect[0] - box.x,
              region.rect[1] - box.y,
              region.rect[2] - box.x,
              region.rect[3] - box.y,
            ],
          });
          continue;
        }
        const paint = marks.paints.find((entry) => entry.index === claim.first || entry.index === claim.last);
        candidates.push({
          id: claim.blockId,
          kind: 'figure',
          role: claim.role,
          text: '',
          alt: claim.alt,
          rect: paint?.bbox == null ? null : relativeUserRect(box, paint.bbox),
        });
      }
      pages.push({
        pageIndex: plan.pageIndex,
        width: box.width,
        height: box.height,
        rotation: geometry.rotation,
        candidates,
        skipped: claimed.skipped,
      });
    }
    return { pages, notes: planned.notes, bodySize: planned.body };
  } catch (error) {
    if (isAbort(error)) throw error;
    throw mapMupdfError(error, 'read tag candidates');
  } finally {
    doc.destroy();
  }
}

/* ------------------------------------------------------------------ *
 * Writing: object helpers
 * ------------------------------------------------------------------ */

function sameObject(left: PDFObject, right: PDFObject): boolean {
  return left.isIndirect() && right.isIndirect() && left.asIndirect() === right.asIndirect();
}

/** `/K` as a list of entries, whether it is a single entry or an array. */
function kidsOf(owner: PDFObject): PDFObject[] {
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

function writeKids(doc: PDFDocument, owner: PDFObject, entries: readonly PDFObject[]): void {
  const array = doc.newArray();
  for (const entry of entries) array.push(entry);
  owner.put('K', array);
}

/** A structure element, as opposed to a content item (`MCR`, `OBJR`, an integer MCID). */
function isElementEntry(entry: PDFObject): boolean {
  if (entry.isNumber()) return false;
  const dict = dictOf(entry);
  if (dict === null) return false;
  const type = nameOf(dict.get('Type'));
  return type !== 'MCR' && type !== 'OBJR';
}

/** The position that is "before the `index`-th element entry" (the end when there is none). */
function positionBeforeElement(entries: readonly PDFObject[], index: number): number {
  let seen = 0;
  for (const [position, entry] of entries.entries()) {
    if (!isElementEntry(entry)) continue;
    if (seen === index) return position;
    seen += 1;
  }
  return entries.length;
}

/** The parent-tree value for a `/StructParents` key (a number tree: `/Nums` leaves, `/Kids` nodes). */
function parentTreeValue(root: PDFObject, key: number): PDFObject | null {
  const tree = dictOf(root.get('ParentTree'));
  if (tree === null) return null;
  const visit = (node: PDFObject, depth: number): PDFObject | null => {
    if (depth > 24) return null;
    const nums = resolved(node.get('Nums'));
    if (nums?.isArray() === true) {
      for (let index = 0; index + 1 < nums.length; index += 2) {
        const candidate = resolved(nums.get(index));
        if (candidate?.isNumber() === true && candidate.asNumber() === key) return nums.get(index + 1);
      }
    }
    const kids = resolved(node.get('Kids'));
    if (kids?.isArray() === true) {
      for (let index = 0; index < kids.length; index += 1) {
        const kid = dictOf(kids.get(index));
        if (kid === null) continue;
        const limits = readNumbers(kid.get('Limits'));
        if (limits.length >= 2 && (key < (limits[0] as number) || key > (limits[1] as number))) continue;
        const found = visit(kid, depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return visit(tree, 0);
}

/** Set (or clear) the `/Scope` of an element's table attributes, keeping any other attribute. */
function writeScope(doc: PDFDocument, element: PDFObject, scope: string | null): void {
  const attributes = resolved(element.get('A'));
  const dicts: PDFObject[] = [];
  if (attributes?.isDictionary() === true) dicts.push(attributes);
  else if (attributes?.isArray() === true) {
    for (let index = 0; index < attributes.length; index += 1) {
      const dict = dictOf(attributes.get(index));
      if (dict !== null) dicts.push(dict);
    }
  }
  const table = dicts.find((dict) => nameOf(dict.get('O')) === 'Table');
  if (table !== undefined) {
    if (scope === null) table.delete('Scope');
    else table.put('Scope', doc.newName(scope));
    return;
  }
  if (scope === null) return;
  const created = doc.newDictionary();
  created.put('O', doc.newName('Table'));
  created.put('Scope', doc.newName(scope));
  if (attributes === null) {
    element.put('A', created);
  } else if (attributes.isArray()) {
    attributes.push(created);
  } else {
    const array = doc.newArray();
    array.push(attributes);
    array.push(created);
    element.put('A', array);
  }
}

/* ------------------------------------------------------------------ *
 * Writing: the edits
 * ------------------------------------------------------------------ */

interface WriteState {
  readonly doc: PDFDocument;
  readonly pages: readonly PDFObject[];
  /** The `/StructTreeRoot`, as the object the catalog points at. */
  readonly root: PDFObject;
  readonly handles: Map<string, PDFObject>;
  /** Marked-content ids to turn into artifacts, per page. */
  readonly artifacts: Map<number, Set<number>>;
  counts: {
    moves: number;
    roles: number;
    alts: number;
    altsCleared: number;
    scopes: number;
    groups: number;
    unwraps: number;
    artifacts: number;
  };
  /** Content ids an `artifact` edit named but the tree already had no page for. */
  missingContent: number;
}

function refuseWrite(reason: string): never {
  throw new ToolError('unsupported', { engine: 'mupdf', path: 'edits', engineMessage: reason });
}

function handleOf(state: WriteState, key: string): PDFObject {
  const known = state.handles.get(key);
  if (known !== undefined) return known;
  if (key.startsWith('o')) {
    const number = Number(key.slice(1));
    if (Number.isInteger(number)) {
      const handle = state.doc.newIndirect(number);
      state.handles.set(key, handle);
      return handle;
    }
  }
  throw new StructEditError('missing', `no element with key ${key}`);
}

function parentHandle(state: WriteState, parent: StructNode | null): PDFObject {
  return parent === null ? state.root : handleOf(state, parent.key);
}

/** An explicit `/Pg`, so an element that inherited its page from the parent it leaves keeps it. */
function pinPage(state: WriteState, element: PDFObject, pageIndex: number | null): void {
  if (pageIndex === null || !element.get('Pg').isNull()) return;
  const page = state.pages[pageIndex];
  if (page !== undefined) element.put('Pg', page);
}

function subtreeContent(node: StructNode, into: { page: number | null; mcid: number }[]): void {
  for (const kid of node.kids) {
    if (kid.kind === 'element') subtreeContent(kid.node, into);
    else if (kid.item.kind === 'mcid') into.push({ page: kid.item.pageIndex, mcid: kid.item.mcid });
  }
}

function applyEdit(state: WriteState, edit: StructEdit, current: StructureModel): void {
  const { doc } = state;
  switch (edit.op) {
    case 'role': {
      handleOf(state, edit.key).put('S', doc.newName(edit.role));
      state.counts.roles += 1;
      break;
    }
    case 'alt': {
      const element = handleOf(state, edit.key);
      if (edit.alt === null) {
        element.delete('Alt');
        state.counts.altsCleared += 1;
      } else {
        element.put('Alt', text(doc, edit.alt.trim()));
        state.counts.alts += 1;
      }
      break;
    }
    case 'scope': {
      writeScope(doc, handleOf(state, edit.key), edit.scope);
      state.counts.scopes += 1;
      break;
    }
    case 'move': {
      const found = findNode(current, edit.key);
      if (found === null) throw new StructEditError('missing', `no element with key ${edit.key}`);
      const node = handleOf(state, edit.key);
      const from = parentHandle(state, found.parent);
      writeKids(
        doc,
        from,
        kidsOf(from).filter((entry) => !sameObject(entry, node)),
      );
      const target = edit.parentKey === '<root>' ? state.root : handleOf(state, edit.parentKey);
      const entries = kidsOf(target);
      entries.splice(positionBeforeElement(entries, edit.index), 0, node);
      writeKids(doc, target, entries);
      node.put('P', target);
      pinPage(state, node, found.node.pageIndex);
      state.counts.moves += 1;
      break;
    }
    case 'group': {
      const first = findNode(current, edit.keys[0] as string);
      if (first === null) throw new StructEditError('missing', 'nothing to group');
      const parent = parentHandle(state, first.parent);
      const members = edit.keys.map((key) => handleOf(state, key));
      const entries = kidsOf(parent);
      const inOrder = entries.filter((entry) => members.some((member) => sameObject(entry, member)));
      const position = entries.findIndex((entry) => sameObject(entry, inOrder[0] as PDFObject));
      const wrapper = doc.addObject(doc.newDictionary());
      wrapper.put('Type', doc.newName('StructElem'));
      wrapper.put('S', doc.newName(edit.role));
      wrapper.put('P', parent);
      const children = doc.newArray();
      for (const member of inOrder) children.push(member);
      wrapper.put('K', children);
      state.handles.set(edit.newKey, wrapper);
      for (const member of inOrder) {
        member.put('P', wrapper);
        const model = edit.keys.map((key) => findNode(current, key)).find((entry) => entry !== null);
        pinPage(state, member, model?.node.pageIndex ?? null);
      }
      const rest = entries.filter((entry) => !inOrder.some((member) => sameObject(entry, member)));
      rest.splice(position, 0, wrapper);
      writeKids(doc, parent, rest);
      state.counts.groups += 1;
      break;
    }
    case 'unwrap': {
      const found = findNode(current, edit.key);
      if (found === null) throw new StructEditError('missing', `no element with key ${edit.key}`);
      const node = handleOf(state, edit.key);
      const parent = parentHandle(state, found.parent);
      const entries = kidsOf(parent);
      const position = entries.findIndex((entry) => sameObject(entry, node));
      const children = kidsOf(node).filter(isElementEntry);
      entries.splice(position, 1, ...children);
      writeKids(doc, parent, entries);
      for (const child of children) child.put('P', parent);
      for (const kid of found.node.kids) {
        if (kid.kind !== 'element') continue;
        const child = state.handles.get(kid.node.key) ?? handleOf(state, kid.node.key);
        pinPage(state, child, kid.node.pageIndex);
      }
      state.counts.unwraps += 1;
      break;
    }
    case 'artifact': {
      const found = findNode(current, edit.key);
      if (found === null) throw new StructEditError('missing', `no element with key ${edit.key}`);
      const node = handleOf(state, edit.key);
      const parent = parentHandle(state, found.parent);
      writeKids(
        doc,
        parent,
        kidsOf(parent).filter((entry) => !sameObject(entry, node)),
      );
      const content: { page: number | null; mcid: number }[] = [];
      subtreeContent(found.node, content);
      for (const item of content) {
        if (item.page === null) {
          state.missingContent += 1;
          continue;
        }
        const set = state.artifacts.get(item.page) ?? new Set<number>();
        set.add(item.mcid);
        state.artifacts.set(item.page, set);
      }
      state.counts.artifacts += 1;
      break;
    }
    default:
      break;
  }
}

/**
 * Turn the `BDC` of the named marked-content ids into `/Artifact BMC`: the same nesting,
 * the same `EMC`, no id. Everything else in the stream is copied byte for byte.
 */
function artifactifyPage(
  state: WriteState,
  pageIndex: number,
  mcids: ReadonlySet<number>,
): { readonly replaced: number } {
  const page = state.pages[pageIndex];
  if (page === undefined) throw pageOutOfRange(pageIndex, 'mark as artifact');
  const content = pageContent(page);
  const instructions = content === null ? null : readInstructions(content.bytes);
  if (content === null || instructions === null) {
    refuseWrite(`page ${pageIndex + 1} content cannot be read, so its marked content cannot be rewritten`);
  }
  const hooks = contentHooks(page);
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  let cursor = 0;
  let replaced = 0;
  for (const instruction of instructions) {
    if (instruction.operator !== 'BDC') continue;
    const props = instruction.operands[1];
    const mcid =
      props?.kind === 'name'
        ? (hooks.properties?.(props.name) ?? null)
        : mcidOfInstruction(content.bytes, instruction);
    if (mcid === null || !mcids.has(mcid)) continue;
    chunks.push(content.bytes.subarray(cursor, instruction.start), encoder.encode('/Artifact BMC'));
    cursor = instruction.end;
    replaced += 1;
  }
  chunks.push(content.bytes.subarray(cursor));
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  resolved(page)?.put('Contents', state.doc.addStream(out, {}));

  const structParents = intOf(resolved(page), 'StructParents');
  const entry = structParents === null ? null : parentTreeValue(state.root, structParents);
  const array = entry === null ? null : resolved(entry);
  if (array?.isArray() === true) {
    for (const mcid of mcids) if (mcid < array.length) array.put(mcid, state.doc.newNull());
  }
  return { replaced };
}

/* ------------------------------------------------------------------ *
 * Public: editStructure
 * ------------------------------------------------------------------ */

function toolErrorOf(error: StructEditError): ToolError {
  const code =
    error.reason === 'alt'
      ? 'value-out-of-range'
      : error.reason === 'missing'
        ? 'selection-empty'
        : 'unsupported';
  return new ToolError(code, {
    engine: 'model',
    path: 'edits',
    engineMessage: `${error.reason}: ${error.message}`,
  });
}

/**
 * Apply tag-editor edits to a tagged file and verify them by reading the result back.
 *
 * The edits are validated against the file's own tree first (`applyStructureEdits`), so a
 * draft that cannot be applied is refused before a byte is written. The returned notes
 * say what changed; the report's steps include `tags.artifact` only when page content was
 * rewritten.
 */
export async function editStructure(
  bytes: Uint8Array,
  edits: readonly StructEdit[],
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  if (edits.length === 0) {
    throw new ToolError('selection-empty', { engine: 'model', path: 'edits', engineMessage: 'no edits' });
  }
  const { doc } = await openForWrite(bytes);
  const notes: OperationNote[] = [];
  const steps: string[] = ['load'];
  let out: Uint8Array;
  let pageCount: number;
  let expected: StructureModel;
  const rewritten = new Map<number, Set<number>>();
  try {
    const pages = pageObjects(doc);
    pageCount = pages.length;
    const base = readStructureModel(doc, pages);
    if (!base.present || !base.readable) {
      refuseWrite('the document has no readable structure tree to edit');
    }
    if (base.truncated) refuseWrite('the structure tree is too large to be edited safely');
    try {
      expected = applyStructureEdits(base, edits);
    } catch (error) {
      if (error instanceof StructEditError) throw toolErrorOf(error);
      throw error;
    }
    const rootValue = catalogOf(doc).get('StructTreeRoot');
    const state: WriteState = {
      doc,
      pages,
      root: rootValue,
      handles: new Map(),
      artifacts: new Map(),
      counts: { moves: 0, roles: 0, alts: 0, altsCleared: 0, scopes: 0, groups: 0, unwraps: 0, artifacts: 0 },
      missingContent: 0,
    };
    let current = base;
    for (const [index, edit] of edits.entries()) {
      throwIfAborted(context.signal);
      context.onProgress?.({
        phase: 'tags',
        labelKey: STRUCT_KEYS.progressWrite,
        done: index + 1,
        total: edits.length + 2,
      });
      try {
        applyEdit(state, edit, current);
        current = applyStructureEdits(current, [edit]);
      } catch (error) {
        if (error instanceof StructEditError) throw toolErrorOf(error);
        throw error;
      }
    }
    steps.push('tags');
    let replacedTotal = 0;
    for (const [pageIndex, mcids] of state.artifacts) {
      const { replaced } = artifactifyPage(state, pageIndex, mcids);
      replacedTotal += replaced;
      rewritten.set(pageIndex, new Set(mcids));
      if (replaced < mcids.size) state.missingContent += mcids.size - replaced;
    }
    if (state.artifacts.size > 0) steps.push('tags.artifact');

    const { counts } = state;
    if (counts.moves > 0) notes.push(note('changed', STRUCT_KEYS.reordered, { count: counts.moves }));
    if (counts.roles > 0) notes.push(note('changed', STRUCT_KEYS.retagged, { count: counts.roles }));
    if (counts.alts > 0) notes.push(note('changed', STRUCT_KEYS.altSet, { count: counts.alts }));
    if (counts.altsCleared > 0) {
      notes.push(note('changed', STRUCT_KEYS.altCleared, { count: counts.altsCleared }));
    }
    if (counts.scopes > 0) notes.push(note('changed', STRUCT_KEYS.scopeSet, { count: counts.scopes }));
    if (counts.groups > 0) notes.push(note('changed', STRUCT_KEYS.grouped, { count: counts.groups }));
    if (counts.unwraps > 0) notes.push(note('changed', STRUCT_KEYS.unwrapped, { count: counts.unwraps }));
    if (counts.artifacts > 0) {
      notes.push(
        note('changed', STRUCT_KEYS.artifact, { count: counts.artifacts, sequences: replacedTotal }),
      );
      notes.push(note('changed', STRUCT_KEYS.contentRewritten, { pages: state.artifacts.size }));
      notes.push(note('changed', STRUCT_KEYS.parentTreeCleared, { count: replacedTotal }));
    }
    if (state.missingContent > 0) {
      notes.push(note('warning', STRUCT_KEYS.contentPartlyMissing, { count: state.missingContent }));
    }
    steps.push('producer');
    notes.push(producerKeptNote());
    throwIfAborted(context.signal);
    out = saveRewrite(doc, 'edit structure');
    steps.push('save');
  } catch (error) {
    if (isAbort(error) || error instanceof ToolError) throw error;
    throw mapMupdfError(error, 'edit structure');
  } finally {
    doc.destroy();
  }

  await verifyStructure(out, expected, rewritten, context);
  steps.push('verify');
  context.onProgress?.({
    phase: 'tags',
    labelKey: STRUCT_KEYS.progressVerify,
    done: edits.length + 2,
    total: edits.length + 2,
  });
  return {
    bytes: out,
    report: {
      engine: 'mupdf',
      steps,
      notes,
      inputBytes: bytes.byteLength,
      outputBytes: out.byteLength,
      pageCount,
      incremental: false,
    },
  };
}

/**
 * Re-open the produced file and compare what it reads as with what the edits must
 * produce: the tree signature (roles, alt texts, scopes, order, the content each element
 * references), and — for an artifact edit — that the named marked-content ids are gone
 * from the page streams while the stream is still balanced.
 */
async function verifyStructure(
  produced: Uint8Array,
  expected: StructureModel,
  artifacts: ReadonlyMap<number, ReadonlySet<number>>,
  context: OperationContext,
): Promise<void> {
  let opened: Awaited<ReturnType<typeof openForWrite>>;
  try {
    opened = await openForWrite(produced);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: `the edited file does not re-open: ${message}`,
    });
  }
  const { doc } = opened;
  try {
    const pages = pageObjects(doc);
    const actual = readStructureModel(doc, pages);
    const want = structureSignature(expected);
    const got = structureSignature(actual);
    if (actual.truncated || got !== want) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `the structure tree reads back differently from the edit (${got.length} vs ${want.length} characters)`,
      });
    }
    for (const [pageIndex, mcids] of artifacts) {
      throwIfAborted(context.signal);
      const page = pages[pageIndex];
      const content = page === undefined ? null : pageContent(page);
      const instructions = content === null ? null : readInstructions(content.bytes);
      if (page === undefined || content === null || instructions === null) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `page ${pageIndex + 1} content is unreadable after the write`,
        });
      }
      const marks = scanContent(content.bytes, instructions, contentHooks(page));
      if (marks.unbalanced) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          engineMessage: `page ${pageIndex + 1} has unbalanced marked content after the write`,
        });
      }
      for (const span of marks.spans) {
        if (span.mcid !== null && mcids.has(span.mcid)) {
          throw new ToolError('verification-failed', {
            engine: 'mupdf',
            engineMessage: `page ${pageIndex + 1} still marks /MCID ${span.mcid} after it was made an artifact`,
          });
        }
      }
    }
  } finally {
    doc.destroy();
  }
}
