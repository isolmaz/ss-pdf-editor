/**
 * Link annotations, written ("Link & outline editing"; the
 * read half is the viewer's own link layer, this file is the one that changes the
 * document).
 *
 * pdf.js has an editor only for its own annotation types, so the dictionary
 * is built here at the object level through MuPDF (`engines/mupdf-write.ts`):
 * `doc.addObject(...)` for the dictionary and its reference, and the page's `/Annots`
 * array as the only place the annotation is attached. What is written is
 * what ISO 32000-2 §12.5.6.5 (link annotations) asks for: `/Type /Annot`,
 * `/Subtype /Link`, `/Rect`, `/Border`, `/F`, `/P`, and exactly one target —
 * `/A << /S /URI /URI … >>` or `/Dest [pageRef /XYZ left top zoom]`.
 *
 * ## Coordinates
 *
 * Every rect and destination point in this file arrives in the space a drag on the
 * **rendered** page measures in: page points, top-left origin, the page as the user
 * sees it — `/Rotate` applied, and the CropBox (MediaBox as fallback) as the box,
 * which is the same box pdf.js hands its viewer as `viewBox`. `/Rect` and `/XYZ` are
 * stored in the page's **unrotated** user space instead, so the conversion runs
 * through the page's own `/Rotate`:
 *
 *   rotation   displayed (u, v) → unrotated user (x, y)        (box x, y, W, H)
 *   0          (box.x + u,             box.y + H − v)
 *   90         (box.x + v,             box.y + u)
 *   180        (box.x + W − u,         box.y + v)
 *   270        (box.x + W − v,         box.y + H − u)
 *
 * `/Rotate 90`/`270` swaps the axes, which is why this is a table and not a y-flip:
 * a page without a rotation is a plain flip, a rotated page is not. The table is
 * written once (`displayToUserPoint`, with `userToDisplayPoint` as its inverse for
 * the removal hit rule); it is the same mapping `pageSpaceToUser` in
 * `ops/page-boxes.ts` applies to MuPDF page space — MuPDF page space *is* the
 * displayed page — so the two cannot drift, and `/Rotate` is never assumed to be 0.
 *
 * ## What a link may point at
 *
 * An added link must not become a script vector: a URI is refused (never rewritten
 * to something "safer", never dropped) unless its scheme is `http:`, `https:` or
 * `mailto:`, and a control character in it is a refusal too. Everything else in a
 * URI is normalised the way RFC 3986 requires — non-ASCII, spaces and the ASCII the
 * standard excludes are percent-encoded. The result is plain ASCII and is written as
 * a literal string, which MuPDF escapes (`(`, `)`, `\`) as it serialises; pdf-lib,
 * the previous writer, did not, which is why this file used to write a hex string.
 *
 * ## Removal
 *
 * Two ways in, both optional and additive: by `/Annots` index, and by rect
 * intersection. The index rule only ever removes an annotation whose `/Subtype` is
 * `/Link` — a stale index from a panel that outlived an edit removes nothing and is
 * reported. The rect rule removes every link on that page whose rectangle overlaps
 * the given one with **positive area** (a rect that only touches an edge selects
 * nothing); the comparison runs in the displayed space both rects are converted
 * into, so the rule is literally "what the drag covers on screen". When a page's
 * `/Annots` array ends up empty it is dropped, and the annotation objects that were
 * unlinked are deleted — an annotation belongs to the page that lists it (there is
 * one `/P`), so nothing else can still reach them.
 *
 * A call that changes nothing returns the **input bytes unchanged** with
 * `incremental: true`: rewriting a file for a no-op would
 * end the incremental fast path for nothing.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  annotsOf,
  openForWrite,
  PRODUCER_LINE,
  pageObjects,
  readName,
  readNumbers,
  resolved,
  saveRewrite,
  text,
} from '../engines/mupdf-write';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  type OperationReport,
  throwIfAborted,
} from './types';

/** A rectangle on one page, in the space a drag on the rendered page measures in. */
export interface LinkTargetRect {
  readonly pageIndex: number;
  /**
   * `[x0, y0, x1, y1]` in **displayed page points with a top-left origin** — the
   * page as the viewer shows it, `/Rotate` applied, origin at the CropBox's
   * upper-left corner. The order of the corners is not significant: both are
   * normalised before the conversion.
   */
  readonly rect: readonly [number, number, number, number];
}

export type LinkDestination =
  | {
      readonly kind: 'page';
      readonly pageIndex: number;
      /** Point to show at the top-left of the window, in the same displayed space. */
      readonly x?: number;
      readonly y?: number;
      /** `/XYZ` zoom factor: 1 = 100 %. */
      readonly zoom?: number;
    }
  | { readonly kind: 'uri'; readonly uri: string };

export interface LinkAdd {
  readonly target: LinkTargetRect;
  readonly destination: LinkDestination;
  /** `/Border [hCornerRadius vCornerRadius width]` (§12.5.4); default `[0 0 1]`. */
  readonly border?: readonly [number, number, number];
}

export interface LinkRemove {
  readonly pageIndex: number;
  /** Indices into the page's `/Annots` array as the input file has it. */
  readonly annotationIndexes?: readonly number[];
  /** Removes every link this rect overlaps; the same space as `LinkTargetRect.rect`. */
  readonly rect?: readonly [number, number, number, number];
}

export interface LinkEditRequest {
  readonly add?: readonly LinkAdd[];
  readonly remove?: readonly LinkRemove[];
}

/** Table 165: bit 3 is Print — a link prints with the page that carries it. */
const PRINT_FLAG = 4;
/** `/Border` (§12.5.4) when the caller does not give one: a 1 pt frame, like Acrobat's. */
const DEFAULT_BORDER: readonly [number, number, number] = [0, 0, 1];
/** The schemes an added link may carry. Anything else is refused, not rewritten. */
const SAFE_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:'];
/** RFC 3986 "excluded" ASCII (§2.2/2.4) plus the space: percent-encoded on the way out. */
const EXCLUDED_ASCII = new Set(['<', '>', '"', '{', '}', '|', '\\', '^', '`', ' ']);

const URI_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

const textEncoder = new TextEncoder();

type LinkRect = readonly [number, number, number, number];
type PageDestination = Extract<LinkDestination, { readonly kind: 'page' }>;

/* ------------------------------------------------------------------ *
 * Displayed page space → unrotated user space
 * ------------------------------------------------------------------ */

/** The four values `/Rotate` can hold. */
type PageRotation = 0 | 90 | 180 | 270;

/**
 * What the conversion needs: the visible box (CropBox, MediaBox as fallback), the
 * page's `/Rotate`, and the extents the page has once that rotation is applied.
 */
interface LinkPageGeometry {
  readonly rotation: PageRotation;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly display: { readonly width: number; readonly height: number };
}

/** `/Rotate` is a multiple of 90; anything else is rounded to the nearest quarter turn. */
function quarterTurns(angle: number): PageRotation {
  const normalized = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

/**
 * `/CropBox`, or `/MediaBox` when there is none — both inheritable through the page
 * tree (§7.7.3.4) — and `/Rotate`, inheritable too. A box that is not four numbers
 * falls through to the next one; a page with neither is treated as US Letter, the
 * default MuPDF itself applies.
 */
function pageGeometry(page: PDFObject): LinkPageGeometry {
  const rotate = resolved(page.getInheritable('Rotate'));
  const rotation = quarterTurns(rotate?.isNumber() === true ? rotate.asNumber() : 0);
  const corners = [
    readNumbers(page.getInheritable('CropBox')),
    readNumbers(page.getInheritable('MediaBox')),
  ].find((values) => values.length >= 4) ?? [0, 0, 612, 792];
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = corners;
  const box = {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
  const swapped = rotation === 90 || rotation === 270;
  return {
    rotation,
    box,
    display: swapped ? { width: box.height, height: box.width } : { width: box.width, height: box.height },
  };
}

/**
 * Displayed-space point → unrotated user space — the table from the file header,
 * and the only place in this file where `/Rotate` is read.
 *
 * `u` grows to the right of the displayed page and `v` downward from its top edge;
 * the box is the unrotated CropBox, so `W`/`H` are the extents *before* the
 * rotation (the displayed ones are `geometry.display`).
 */
function displayToUserPoint(
  geometry: LinkPageGeometry,
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

/**
 * Unrotated user space → displayed space: each row of the table solved for `u`/`v`.
 * Used by the removal hit rule so the comparison happens in the space the user drew
 * in, and by nothing else.
 */
function userToDisplayPoint(
  geometry: LinkPageGeometry,
  x: number,
  y: number,
): { readonly u: number; readonly v: number } {
  const box = geometry.box;
  switch (geometry.rotation) {
    case 90:
      return { u: y - box.y, v: x - box.x };
    case 180:
      return { u: box.x + box.width - x, v: y - box.y };
    case 270:
      return { u: box.y + box.height - y, v: box.x + box.width - x };
    default:
      return { u: x - box.x, v: box.y + box.height - y };
  }
}

/** Ascending corners: a drag may start at any corner and a rotation may mirror both axes. */
function normalizeRect(rect: LinkRect): LinkRect {
  return [
    Math.min(rect[0], rect[2]),
    Math.min(rect[1], rect[3]),
    Math.max(rect[0], rect[2]),
    Math.max(rect[1], rect[3]),
  ];
}

/** A displayed-space rect as the annotation's `/Rect`: two opposite corners through the table. */
function displayRectToUserRect(geometry: LinkPageGeometry, rect: LinkRect): LinkRect {
  const start = normalizeRect(rect);
  const first = displayToUserPoint(geometry, start[0], start[1]);
  const second = displayToUserPoint(geometry, start[2], start[3]);
  return normalizeRect([first.x, first.y, second.x, second.y]);
}

/** A stored `/Rect` (unrotated user space) in the space the caller's rects arrive in. */
function userRectToDisplayRect(geometry: LinkPageGeometry, rect: LinkRect): LinkRect {
  const first = userToDisplayPoint(geometry, rect[0], rect[1]);
  const second = userToDisplayPoint(geometry, rect[2], rect[3]);
  return normalizeRect([first.u, first.v, second.u, second.v]);
}

/** Positive-area overlap: a rect that only touches an edge selects nothing. */
function overlaps(left: LinkRect, right: LinkRect): boolean {
  return (
    Math.min(left[2], right[2]) - Math.max(left[0], right[0]) > 0 &&
    Math.min(left[3], right[3]) - Math.max(left[1], right[1]) > 0
  );
}

function isFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/* ------------------------------------------------------------------ *
 * URIs
 * ------------------------------------------------------------------ */

function refuse(message: string, path: string): never {
  throw new ToolError('unsupported', { engine: 'mupdf', path, engineMessage: message });
}

/**
 * Validate and normalise one link URI: allow-listed scheme, no control character,
 * everything outside printable ASCII (and the ASCII RFC 3986 excludes) percent
 * encoded as UTF-8 triplets. `encoded` counts the characters that had to change, so
 * the report can say the address was written in its standard encoding — the address
 * the user typed is never silently replaced by a different one.
 */
function checkUri(uri: string, path: string): { readonly value: string; readonly encoded: number } {
  const trimmed = uri.trim();
  if (trimmed.length === 0) refuse('link uri is empty', path);

  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      refuse(`link uri carries a control character (U+${code.toString(16).toUpperCase()})`, path);
    }
  }

  const scheme = URI_SCHEME.exec(trimmed);
  if (scheme === null) refuse('link uri has no scheme; http:, https: or mailto: is required', path);
  const name = `${(scheme[1] as string).toLowerCase()}:`;
  if (!SAFE_SCHEMES.includes(name)) {
    refuse(`link uri scheme "${name}" is not one of http:, https:, mailto:`, path);
  }

  let value = '';
  let encoded = 0;
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x7e || EXCLUDED_ASCII.has(character)) {
      for (const byte of textEncoder.encode(character)) {
        value += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
      encoded += 1;
      continue;
    }
    value += character;
  }
  return { value, encoded };
}

/* ------------------------------------------------------------------ *
 * engine plumbing
 * ------------------------------------------------------------------ */

/** A call that changed nothing: same bytes, and the report says so. */
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
      notes: [
        ...notes,
        note('warning', 'op.note.link.nothing'),
        note('preserved', 'op.note.metadata.producerKept', { producer: PRODUCER_LINE }),
      ],
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount,
      // Nothing was rewritten, so the caller's incremental fast path stays open.
      incremental: true,
    },
  };
}

/** One `/Link` annotation as the input file has it. */
interface ExistingLink {
  /** Position in the page's `/Annots` array, as read. */
  readonly position: number;
  /** Object number; `null` when the annotation travels as a direct dictionary. */
  readonly number: number | null;
  /** `/Rect` in the page's unrotated user space; `null` when absent or malformed. */
  readonly rect: LinkRect | null;
}

/**
 * Four finite numbers from an array, or `null`. A malformed `/Rect` is reported as
 * "no rect" rather than guessed at, and a `/Rect` given as an indirect reference is
 * followed.
 */
function readRect(value: PDFObject): LinkRect | null {
  const corners = readNumbers(value);
  if (corners.length < 4 || !corners.slice(0, 4).every((corner) => Number.isFinite(corner))) return null;
  return [corners[0] as number, corners[1] as number, corners[2] as number, corners[3] as number];
}

/** Every `/Link` annotation of one page, in array order; other annotations are ignored. */
function linksOnPage(doc: PDFDocument, page: PDFObject): ExistingLink[] {
  const annots = annotsOf(doc, page);
  if (annots === null) return [];
  const links: ExistingLink[] = [];
  for (let position = 0; position < annots.length; position += 1) {
    const object = annots.get(position);
    const dict = resolved(object);
    if (dict === null || !dict.isDictionary()) continue;
    if (readName(dict.get('Subtype')) !== 'Link') continue;
    links.push({
      position,
      number: object.isIndirect() ? object.asIndirect() : null,
      rect: readRect(dict.get('Rect')),
    });
  }
  return links;
}

/** The annotation dictionary for one added link, with exactly one target key. */
function linkAnnotation(
  doc: PDFDocument,
  page: PDFObject,
  rect: LinkRect,
  border: readonly [number, number, number],
  target: { readonly key: 'A' | 'Dest'; readonly value: PDFObject },
): PDFObject {
  const dict = doc.addObject({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [...rect],
    Border: [...border],
    F: PRINT_FLAG,
    P: page,
  });
  dict.put(target.key, target.value);
  return dict;
}

/**
 * Re-open the produced bytes and check the links that should be there are there.
 *
 * A file that does not parse, a page count that moved, or a page whose link count is
 * not the sum of its additions and removals is `verification-failed`: the caller keeps
 * the original file and the session stays dirty.
 */
async function verifyOutput(
  produced: Uint8Array,
  pageCount: number,
  expected: ReadonlyMap<number, number>,
): Promise<void> {
  let doc: PDFDocument;
  try {
    ({ doc } = await openForWrite(produced));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError('verification-failed', {
      engine: 'mupdf',
      engineMessage: `produced file does not re-open: ${message}`,
    });
  }
  try {
    if (doc.countPages() !== pageCount) {
      throw new ToolError('verification-failed', {
        engine: 'mupdf',
        engineMessage: `produced file has ${doc.countPages()} pages, expected ${pageCount}`,
      });
    }
    for (const [index, count] of expected) {
      const actual = linksOnPage(doc, doc.findPage(index)).length;
      if (actual !== count) {
        throw new ToolError('verification-failed', {
          engine: 'mupdf',
          pageIndex: index,
          engineMessage: `page ${index + 1} carries ${actual} link annotations, expected ${count}`,
        });
      }
    }
  } finally {
    doc.destroy();
  }
}

/* ------------------------------------------------------------------ *
 * the operation
 * ------------------------------------------------------------------ */

/** One addition, with everything that can be judged without the document already judged. */
interface PlannedAdd {
  readonly path: string;
  readonly target: LinkTargetRect;
  readonly rect: LinkRect;
  readonly border: readonly [number, number, number];
  readonly destination: { readonly kind: 'uri'; readonly uri: string } | PageDestination;
}

/**
 * Judge the whole request against integer and area sanity before the document is
 * opened: a refused URI must not leave a half-written file behind, and a request that
 * cannot be satisfied is reported as a whole.
 */
function planRequest(
  adds: readonly LinkAdd[],
  removes: readonly LinkRemove[],
): { readonly plan: PlannedAdd[]; readonly encodedUris: number } {
  let encodedUris = 0;
  const plan: PlannedAdd[] = [];
  for (const [index, item] of adds.entries()) {
    const path = `request.add[${index}]`;
    if (!Number.isInteger(item.target.pageIndex)) {
      throw new ToolError('value-out-of-range', {
        engine: 'mupdf',
        path: `${path}.target.pageIndex`,
        engineMessage: `page index must be an integer, got ${String(item.target.pageIndex)}`,
      });
    }
    const border = item.border ?? DEFAULT_BORDER;
    for (const [position, value] of border.entries()) {
      if (!Number.isFinite(value) || value < 0) {
        throw new ToolError('value-out-of-range', {
          engine: 'mupdf',
          path: `${path}.border[${position}]`,
          engineMessage: `link border value must be a finite number ≥ 0, got ${String(value)}`,
        });
      }
    }
    const rect = normalizeRect(item.target.rect);
    if (!(rect[0] < rect[2] && rect[1] < rect[3])) {
      throw new ToolError('selection-empty', {
        engine: 'mupdf',
        path: `${path}.target.rect`,
        engineMessage: `link rect has no area: [${rect.join(', ')}]`,
      });
    }

    const destination = item.destination;
    if (destination.kind === 'uri') {
      const checked = checkUri(destination.uri, `${path}.destination.uri`);
      if (checked.encoded > 0) encodedUris += 1;
      plan.push({
        path,
        target: item.target,
        rect,
        border,
        destination: { kind: 'uri', uri: checked.value },
      });
      continue;
    }
    if (!Number.isInteger(destination.pageIndex)) {
      throw new ToolError('value-out-of-range', {
        engine: 'mupdf',
        path: `${path}.destination.pageIndex`,
        engineMessage: `page index must be an integer, got ${String(destination.pageIndex)}`,
      });
    }
    // x and y are one point: half of it cannot be converted through a rotation that
    // swaps the axes, so a lone coordinate is refused instead of guessed.
    if (isFiniteNumber(destination.x) !== isFiniteNumber(destination.y)) {
      refuse(
        'a /XYZ destination point needs both x and y (they are carried together)',
        `${path}.destination`,
      );
    }
    if (destination.zoom !== undefined && !(isFiniteNumber(destination.zoom) && destination.zoom > 0)) {
      throw new ToolError('value-out-of-range', {
        engine: 'mupdf',
        path: `${path}.destination.zoom`,
        engineMessage: `link zoom must be a finite number > 0, got ${String(destination.zoom)}`,
      });
    }
    plan.push({ path, target: item.target, rect, border, destination });
  }

  for (const [index, item] of removes.entries()) {
    if (item.annotationIndexes === undefined && item.rect === undefined) {
      refuse('removal request carries neither annotation indexes nor a rect', `request.remove[${index}]`);
    }
    if (!Number.isInteger(item.pageIndex)) {
      throw new ToolError('value-out-of-range', {
        engine: 'mupdf',
        path: `request.remove[${index}].pageIndex`,
        engineMessage: `page index must be an integer, got ${String(item.pageIndex)}`,
      });
    }
  }
  return { plan, encodedUris };
}

/** What the edit pass did, per page, for the report and the read-back. */
interface LinkEditResult {
  readonly notes: OperationNote[];
  readonly steps: string[];
  /** Link count of every touched page before this call. */
  readonly before: Map<number, number>;
  readonly addedOn: Map<number, number>;
  readonly removedOn: Map<number, number>;
}

function removeLinks(
  doc: PDFDocument,
  pages: readonly PDFObject[],
  removes: readonly LinkRemove[],
  result: LinkEditResult,
  touched: (pageIndex: number) => void,
  context: OperationContext,
): void {
  let notFound = 0;
  let notLink = 0;
  const positions = new Map<number, Set<number>>();

  for (const [index, item] of removes.entries()) {
    throwIfAborted(context.signal);
    const page = item.pageIndex >= 0 ? pages[item.pageIndex] : undefined;
    if (page === undefined) {
      // No such page: nothing to look at, nothing removed, and the report says so.
      notFound += 1;
      continue;
    }
    touched(item.pageIndex);
    const annots = annotsOf(doc, page);
    const links = linksOnPage(doc, page);
    const targets = positions.get(item.pageIndex) ?? new Set<number>();

    if (item.annotationIndexes !== undefined) {
      for (const requested of item.annotationIndexes) {
        if (!Number.isInteger(requested) || requested < 0) {
          notFound += 1;
          continue;
        }
        if (links.some((entry) => entry.position === requested)) {
          targets.add(requested);
          continue;
        }
        // Either out of range, or an annotation that is not a link (a highlight, a
        // widget): the index rule never removes anything but a link.
        if (requested < (annots?.length ?? 0)) notLink += 1;
        else notFound += 1;
      }
    }

    if (item.rect !== undefined) {
      const dragged = normalizeRect(item.rect);
      const geometry = pageGeometry(page);
      for (const link of links) {
        if (link.rect === null) continue;
        if (overlaps(dragged, userRectToDisplayRect(geometry, link.rect))) targets.add(link.position);
      }
    }

    if (targets.size === 0) continue;
    positions.set(item.pageIndex, targets);
    context.onProgress?.({
      phase: 'links',
      labelKey: 'op.progress.link.remove',
      done: index + 1,
      total: removes.length,
    });
  }

  const doomed = new Set<number>();
  for (const [pageIndex, targets] of positions) {
    throwIfAborted(context.signal);
    const page = pages[pageIndex];
    const annots = page === undefined ? null : annotsOf(doc, page);
    if (page === undefined || annots === null) continue;
    const links = linksOnPage(doc, page);
    // Descending, so every position collected from the untouched array stays valid.
    for (const position of [...targets].sort((left, right) => right - left)) {
      const link = links.find((entry) => entry.position === position);
      if (link === undefined) continue;
      annots.delete(position);
      if (link.number !== null) doomed.add(link.number);
      result.removedOn.set(pageIndex, (result.removedOn.get(pageIndex) ?? 0) + 1);
    }
  }

  // An annotation belongs to the page that lists it (there is one `/P`), so nothing
  // else can reach an unlinked one; it is deleted rather than left for the save's
  // garbage pass, and the same object listed twice is deleted once.
  for (const number of doomed) doc.deleteObject(number);

  if (result.removedOn.size > 0) result.steps.push('link.remove');
  if (notFound > 0) result.notes.push(note('warning', 'op.note.link.removeNotFound', { count: notFound }));
  if (notLink > 0) result.notes.push(note('warning', 'op.note.link.removeNotLink', { count: notLink }));
}

function addLinks(
  doc: PDFDocument,
  pages: readonly PDFObject[],
  plan: readonly PlannedAdd[],
  encodedUris: number,
  result: LinkEditResult,
  touched: (pageIndex: number) => void,
  context: OperationContext,
): void {
  context.onProgress?.({ phase: 'links', labelKey: 'op.progress.link.add', done: 0, total: plan.length });
  let missingTargets = 0;
  let clamped = 0;

  for (const [index, item] of plan.entries()) {
    throwIfAborted(context.signal);
    const page = pages[item.target.pageIndex];
    if (page === undefined) {
      // A rect can only be written on a page that exists: the addition is skipped,
      // never moved to a neighbouring page.
      missingTargets += 1;
      continue;
    }
    touched(item.target.pageIndex);

    let target: { readonly key: 'A' | 'Dest'; readonly value: PDFObject };
    if (item.destination.kind === 'uri') {
      const action = doc.newDictionary();
      action.put('S', 'URI');
      // MuPDF escapes `(`, `)` and `\` in the literal string it writes; the address is
      // plain ASCII by now (`checkUri`), so this is the exact bytes a reader decodes.
      action.put('URI', text(doc, item.destination.uri));
      target = { key: 'A', value: action };
    } else {
      const requested = item.destination.pageIndex;
      const destinationIndex = Math.min(Math.max(requested, 0), Math.max(pages.length - 1, 0));
      if (destinationIndex !== requested) clamped += 1;
      const destinationPage = pages[destinationIndex];
      if (destinationPage === undefined) {
        missingTargets += 1;
        continue;
      }
      const geometry = pageGeometry(destinationPage);
      const point =
        isFiniteNumber(item.destination.x) && isFiniteNumber(item.destination.y)
          ? displayToUserPoint(geometry, item.destination.x, item.destination.y)
          : null;
      const dest = doc.newArray();
      dest.push(destinationPage);
      dest.push('XYZ');
      dest.push(point === null ? doc.newNull() : point.x);
      dest.push(point === null ? doc.newNull() : point.y);
      dest.push(item.destination.zoom ?? doc.newNull());
      target = { key: 'Dest', value: dest };
    }

    const rect = displayRectToUserRect(pageGeometry(page), item.rect);
    // Appended to `/Annots` directly: a link edit has no reason to touch the page's
    // content, and nothing here rewrites it.
    annotsOf(doc, page, true)?.push(linkAnnotation(doc, page, rect, item.border, target));
    result.addedOn.set(item.target.pageIndex, (result.addedOn.get(item.target.pageIndex) ?? 0) + 1);
    context.onProgress?.({
      phase: 'links',
      labelKey: 'op.progress.link.add',
      done: index + 1,
      total: plan.length,
    });
  }

  if (result.addedOn.size > 0) result.steps.push('link.add');
  if (missingTargets > 0)
    result.notes.push(note('warning', 'op.note.link.targetMissing', { count: missingTargets }));
  if (clamped > 0) result.notes.push(note('warning', 'op.note.link.destinationClamped', { count: clamped }));
  if (encodedUris > 0) result.notes.push(note('changed', 'op.note.link.uriEncoded', { count: encodedUris }));
}

/**
 * Add and remove link annotations.
 *
 * Order inside one call: removals first, then additions — so a "replace this link"
 * request works, and so every `/Annots` index the caller read from the input file
 * still names the annotation it named when the panel listed it.
 */
export async function applyLinkEdit(
  bytes: Uint8Array,
  request: LinkEditRequest,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const adds = request.add ?? [];
  const removes = request.remove ?? [];
  if (adds.length === 0 && removes.length === 0) return nothingToDo(bytes, 0, []);

  const { plan, encodedUris } = planRequest(adds, removes);
  context.onProgress?.({
    phase: 'links',
    labelKey: 'op.progress.link.remove',
    done: 0,
    total: removes.length,
  });

  const { doc } = await openForWrite(bytes);
  const result: LinkEditResult = {
    notes: [],
    steps: ['load'],
    before: new Map(),
    addedOn: new Map(),
    removedOn: new Map(),
  };
  let out: Uint8Array;
  let pageCount: number;
  try {
    let addedTotal: number;
    let removedTotal: number;
    try {
      const pages = pageObjects(doc);
      pageCount = pages.length;
      // What each touched page carried before this call: the report and the verification
      // both need it, and it has to be read before that page's first mutation.
      const touched = (pageIndex: number): void => {
        if (result.before.has(pageIndex)) return;
        const page = pages[pageIndex];
        result.before.set(pageIndex, page === undefined ? 0 : linksOnPage(doc, page).length);
      };

      if (removes.length > 0) removeLinks(doc, pages, removes, result, touched, context);
      if (plan.length > 0) addLinks(doc, pages, plan, encodedUris, result, touched, context);

      addedTotal = [...result.addedOn.values()].reduce((sum, value) => sum + value, 0);
      removedTotal = [...result.removedOn.values()].reduce((sum, value) => sum + value, 0);

      // An `/Annots` array that no longer holds anything is a shell, not a fact — dropped
      // after the writes, so a page that lost its last link keeps no empty array.
      for (const [pageIndex] of result.before) {
        const page = pages[pageIndex];
        if (page !== undefined && annotsOf(doc, page)?.length === 0) page.delete('Annots');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'edit links');
    }

    if (addedTotal === 0 && removedTotal === 0) {
      // Every request was judged and none of them touched a page: the input goes back
      // untouched and the warnings above are the whole answer.
      return nothingToDo(bytes, pageCount, result.notes);
    }

    result.steps.push('producer');
    result.notes.push(note('preserved', 'op.note.metadata.producerKept', { producer: PRODUCER_LINE }));
    if (addedTotal > 0) result.notes.push(note('changed', 'op.note.link.added', { count: addedTotal }));
    if (removedTotal > 0) result.notes.push(note('changed', 'op.note.link.removed', { count: removedTotal }));

    throwIfAborted(context.signal);
    out = saveRewrite(doc, 'edit links');
  } finally {
    doc.destroy();
  }
  result.steps.push('save');

  const expected = new Map<number, number>();
  for (const [pageIndex, value] of result.before) {
    expected.set(
      pageIndex,
      value + (result.addedOn.get(pageIndex) ?? 0) - (result.removedOn.get(pageIndex) ?? 0),
    );
  }
  await verifyOutput(out, pageCount, expected);
  result.steps.push('verify');

  const report: OperationReport = {
    engine: 'mupdf',
    steps: result.steps,
    notes: result.notes,
    inputBytes: bytes.byteLength,
    outputBytes: out.byteLength,
    pageCount,
    // Re-serialised: the incremental fast path is over.
    incremental: false,
  };
  return { bytes: out, report };
}
