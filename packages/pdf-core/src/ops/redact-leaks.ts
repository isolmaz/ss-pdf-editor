/**
 * What a redaction run has to clean up that is not under a mark: the other places an attached
 * file lives in, and the places a redacted page keeps a second copy of its text.
 *
 * MuPDF's `applyRedactions` erases glyphs, images and line art. It does not touch any of these,
 * and the saved file kept them:
 *
 *  - **Attachments.** `/Root /Names /EmbeddedFiles` was all the "clean attachments" step removed
 *    (through MuPDF's `deleteEmbeddedFile`, which also leaves an empty name tree and never touches
 *    `/AF`). A file attached by this editor is also listed in `/Root /AF`; a file can be listed in
 *    a page's `/AF` too, as can an annotation's and a structure element's, and a `/FileAttachment`
 *    annotation carries its own file specification.
 *    `purgeAttachments` takes every attached file out of all of them, with the file
 *    specifications and the embedded-file streams (`fileSpecObjects` of `attachments-write.ts`).
 *  - **Thumbnails.** A page's `/Thumb` is a picture of the page as it was.
 *  - **Tag text.** A structure element's `/Alt` and `/ActualText` (and its `/E` expansion), and
 *    the same entries in the property dictionary of a marked-content sequence in the page's
 *    content stream (`/Span <</ActualText (…)>> BDC`) are the page's words spelled a second time,
 *    for a reader that follows the tags. `scrubRedactedPages` removes them from the pages that
 *    carried a mark — and only from those: an element belongs to a page when its `/Pg` or one of
 *    its content references (`/MCR`, `/OBJR`) names it, or when the page's `/ParentTree` entry
 *    lists it. The scope is the page, not the rectangle: which marked-content sequence sat under a
 *    mark is not something the tags say. The page's `/Properties` and the forms in its resources
 *    are scrubbed whole, used or not, and never in place: a form or a property dictionary can be
 *    shared with pages that carried no mark, so the page gets a copy (and a copy of its resources
 *    that points at it) and the other pages keep the original.
 *
 * It also answers one question it cannot fix (`paintResourcesShowText`): whether a tiling pattern or
 * a soft-mask group among a page's resources shows text. Those are content streams of their own
 * that `applyRedactions` never edits, so the text stays in the file after the paint operation
 * under a mark is gone.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { pageContentParts, readName, resolved } from '../engines/mupdf-write';
import { readInstructions } from './accessibility';
import { fileSpecObjects, isEmptyDictionary, objectNumber } from './attachments-write';
import { scanMarkedContent } from './marked-content';
import { finishSweep, newTally, sweepWhere } from './redact-annots';

/** The entries that carry a second copy of a page's text. */
const TEXT_KEYS: ReadonlySet<string> = new Set(['Alt', 'ActualText', 'E']);

/** The entries of an array value, a single value as a one-entry list, nothing for a missing key. */
function entriesOf(value: PDFObject): PDFObject[] {
  if (value.isNull()) return [];
  const array = resolved(value);
  if (array?.isArray() !== true) return [value];
  const entries: PDFObject[] = [];
  for (let index = 0; index < array.length; index += 1) entries.push(array.get(index));
  return entries;
}

interface Reached {
  /** The reference (or direct value) the dictionary was reached by. */
  readonly entry: PDFObject;
  readonly node: PDFObject;
}

/**
 * Every dictionary reachable from `start` through `childrenOf`, each indirect one once: a node
 * listed under two parents, or a cycle, is not walked twice. Iterative, so a deep tree costs
 * memory and not stack.
 */
function reachable(
  start: readonly PDFObject[],
  childrenOf: (node: PDFObject) => readonly PDFObject[],
): Reached[] {
  const reached: Reached[] = [];
  const seen = new Set<number>();
  const stack = [...start];
  while (stack.length > 0) {
    const entry = stack.pop() as PDFObject;
    const number = objectNumber(entry);
    if (number !== null) {
      if (seen.has(number)) continue;
      seen.add(number);
    }
    const node = resolved(entry);
    if (node?.isDictionary() !== true) continue;
    reached.push({ entry, node });
    for (const child of childrenOf(node)) stack.push(child);
  }
  return reached;
}

/**
 * Discard one file specification and the streams behind it, and say whether it counts as one more
 * removed attachment: it does when something is there and no earlier call — the same file reached
 * another way — has counted it already. A direct dictionary is its own file each time.
 */
function discardCounted(doc: PDFDocument, spec: PDFObject, counted: Set<number>): number {
  const number = objectNumber(spec);
  const fresh = resolved(spec) !== null && (number === null || !counted.has(number));
  // `/EF /F` and `/EF /UF` are normally the same stream: the numbers come as a set.
  for (const object of fileSpecObjects(spec)) doc.deleteObject(object);
  if (number !== null) counted.add(number);
  return fresh ? 1 : 0;
}

/**
 * The "clean attachments" step: every attached file of the document goes, wherever it lives — the
 * embedded-file name tree (a `/Kids` tree too), every `/AF` entry of the catalog, the pages, their
 * annotations and the structure elements, and every file-attachment annotation on every page with
 * its popup and replies — together with the file specifications and embedded-file streams behind
 * them. The name tree leaves the catalog, and with it the `/Names` dictionary when nothing else is
 * in it.
 *
 * Returns how many attachments went: a file reachable by more than one way counts once, and a
 * reference to a file that is not there not at all, so a document without attachments answers 0.
 */
export function purgeAttachments(doc: PDFDocument): number {
  const root = doc.getTrailer().get('Root');
  const counted = new Set<number>();
  let removed = 0;

  const names = resolved(root.get('Names'));
  if (names?.isDictionary() === true) {
    for (const { node } of reachable([names.get('EmbeddedFiles')], (tree) => entriesOf(tree.get('Kids')))) {
      // `(key, file specification)` pairs: the specifications stand at the odd positions.
      const pairs = entriesOf(node.get('Names'));
      for (let index = 1; index < pairs.length; index += 2) {
        removed += discardCounted(doc, pairs[index] as PDFObject, counted);
      }
    }
    names.delete('EmbeddedFiles');
    if (isEmptyDictionary(names)) root.delete('Names');
  }

  const pages = Array.from({ length: doc.countPages() }, (_, index) => doc.findPage(index));
  // The selector reads each annotation's `/FS` before the sweep deletes the annotation.
  const swept = newTally();
  const specs: PDFObject[] = [];
  for (const page of pages) {
    sweepWhere(
      page,
      (annotation) => {
        if (annotation.subtype !== 'FileAttachment') return false;
        specs.push(annotation.dict.get('FS'));
        return true;
      },
      swept,
    );
  }
  for (const spec of specs) removed += discardCounted(doc, spec, counted);
  finishSweep(doc, swept);

  const owners = [root, ...pages, ...annotationsOf(pages), ...structureElements(root)];
  for (const owner of owners) {
    for (const spec of entriesOf(owner.get('AF'))) removed += discardCounted(doc, spec, counted);
    owner.delete('AF');
  }
  return removed;
}

/** The annotation dictionaries `pages` list; an entry that is no dictionary is not one. */
function annotationsOf(pages: readonly PDFObject[]): PDFObject[] {
  const annotations: PDFObject[] = [];
  for (const page of pages) {
    for (const entry of entriesOf(page.get('Annots'))) {
      const annotation = resolved(entry);
      if (annotation?.isDictionary() === true) annotations.push(annotation);
    }
  }
  return annotations;
}

/** The dictionaries of the structure tree below `/StructTreeRoot`, none for a document without tags. */
function structureElements(root: PDFObject): PDFObject[] {
  const tree = resolved(root.get('StructTreeRoot'));
  if (tree?.isDictionary() !== true) return [];
  return reachable(entriesOf(tree.get('K')), (node) => entriesOf(node.get('K'))).map(({ node }) => node);
}

/** `/MCR` and `/OBJR` dictionaries: references to content, as opposed to child structure elements. */
function isContentReference(dictionary: PDFObject): boolean {
  const type = readName(dictionary.get('Type'));
  return type === 'MCR' || type === 'OBJR';
}

/**
 * The structure elements `/ParentTree` lists for the pages' marked content (`/StructParents`, an
 * array indexed by MCID) and for their annotations (`/StructParent`, one element), by object number.
 */
function parentTreeElements(root: PDFObject, pages: readonly PDFObject[]): Set<number> {
  const keys = new Set<number>();
  const want = (value: PDFObject | undefined): void => {
    if (value?.isNumber() === true) keys.add(value.asNumber());
  };
  for (const page of pages) {
    want(page.get('StructParents'));
    for (const annotation of entriesOf(page.get('Annots'))) want(resolved(annotation)?.get('StructParent'));
  }

  const found = new Set<number>();
  for (const { node } of reachable([root.get('ParentTree')], (tree) => entriesOf(tree.get('Kids')))) {
    const nums = entriesOf(node.get('Nums'));
    for (let index = 0; index + 1 < nums.length; index += 2) {
      const key = nums[index] as PDFObject;
      if (!key.isNumber() || !keys.has(key.asNumber())) continue;
      for (const element of entriesOf(nums[index + 1] as PDFObject)) {
        const number = objectNumber(element);
        if (number !== null) found.add(number);
      }
    }
  }
  return found;
}

/**
 * `/Alt`, `/ActualText` and `/E` out of every structure element that belongs to one of `pages`.
 * Returns how many entries went.
 */
function scrubStructure(
  doc: PDFDocument,
  pages: readonly PDFObject[],
  pageNumbers: ReadonlySet<number>,
): number {
  const root = resolved(doc.getTrailer().get('Root').get('StructTreeRoot'));
  if (root?.isDictionary() !== true) return 0;

  const listed = parentTreeElements(root, pages);
  const onRedactedPage = (reference: PDFObject): boolean =>
    reference.isIndirect() && pageNumbers.has(reference.asIndirect());

  let removed = 0;
  const elements = reachable(entriesOf(root.get('K')), (node) => entriesOf(node.get('K')));
  for (const { entry, node: element } of elements) {
    if (isContentReference(element)) continue;
    const cited = entriesOf(element.get('K')).some((kid) => {
      const reference = resolved(kid);
      return reference !== null && isContentReference(reference) && onRedactedPage(reference.get('Pg'));
    });
    const belongs =
      (entry.isIndirect() && listed.has(entry.asIndirect())) || onRedactedPage(element.get('Pg')) || cited;
    if (!belongs) continue;
    for (const key of TEXT_KEYS) {
      if (element.get(key).isNull()) continue;
      element.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** What scrubbing a resource dictionary or a form came to: the copy to use instead (`null` when nothing changed) and the entries removed. */
interface Scrubbed {
  readonly copy: PDFObject | null;
  readonly removed: number;
}

const NOTHING: Scrubbed = { copy: null, removed: 0 };

/** Forms already looked at in this run, by object number: pages that draw the same form share its copy. */
type FormMemo = Map<number, Scrubbed>;

/** The groups of a resource dictionary that carry marked-content text or forms. */
const SWAPPED_GROUPS = ['Properties', 'XObject'] as const;

/** The entries of `/Form` streams that describe the old encoding of the content, not the content. */
const REENCODED_KEYS: ReadonlySet<string> = new Set(['Filter', 'DecodeParms', 'Length']);

/**
 * The property dictionaries and the form XObjects of `resources`, scrubbed: a copy of `resources`
 * whose `/Properties` and `/XObject` groups point at the cleaned copies, or `NOTHING` when no
 * dictionary or form in it had text to remove. Neither the resources nor anything in them is
 * edited. Every entry is read, used by the content or not.
 */
function scrubResources(doc: PDFDocument, resources: PDFObject, memo: FormMemo): Scrubbed {
  const swaps = {
    Properties: new Map<string | number, PDFObject>(),
    XObject: new Map<string | number, PDFObject>(),
  };
  let removed = 0;

  resolved(resources.get('Properties'))?.forEach((value, name) => {
    const copy = doc.newDictionary();
    let hits = 0;
    resolved(value)?.forEach((entry, key) => {
      if (TEXT_KEYS.has(String(key))) hits += 1;
      else copy.put(key, entry);
    });
    if (hits === 0) return;
    swaps.Properties.set(name, copy);
    removed += hits;
  });
  resolved(resources.get('XObject'))?.forEach((value, name) => {
    const form = scrubForm(doc, value, memo);
    removed += form.removed;
    if (form.copy !== null) swaps.XObject.set(name, form.copy);
  });
  if (swaps.Properties.size === 0 && swaps.XObject.size === 0) return NOTHING;

  const own = doc.newDictionary();
  resources.forEach((value, key) => {
    own.put(key, value);
  });
  for (const group of SWAPPED_GROUPS) {
    const replaced = swaps[group];
    if (replaced.size === 0) continue;
    const copy = doc.newDictionary();
    resolved(resources.get(group))?.forEach((value, name) => {
      copy.put(name, replaced.get(name) ?? value);
    });
    own.put(group, copy);
  }
  return { copy: own, removed };
}

/**
 * One form XObject: its content's marked-content text entries, and the property dictionaries and
 * forms in its own resources. When anything changes the result is a **new** stream — the form's
 * dictionary minus what described the old encoding, with a resource dictionary that points at the
 * cleaned copies — and the original is untouched. A reference that is no stream, a stream that is
 * no form (an image) and a form without text give `NOTHING`.
 */
function scrubForm(doc: PDFDocument, entry: PDFObject, memo: FormMemo): Scrubbed {
  if (!entry.isStream()) return NOTHING;
  const number = entry.asIndirect();
  const known = memo.get(number);
  if (known !== undefined) return { copy: known.copy, removed: 0 };
  // Until it is done a form stands for "nothing", so a form that draws itself ends the walk.
  memo.set(number, NOTHING);
  const form = entry.resolve();
  if (readName(form.get('Subtype')) !== 'Form') return NOTHING;

  const buffer = entry.readStream();
  let content: Uint8Array;
  try {
    content = new Uint8Array(buffer.asUint8Array());
  } finally {
    buffer.destroy();
  }
  const scan = scanMarkedContent(content, TEXT_KEYS);
  const resources = resolved(form.get('Resources'));
  const inner = resources?.isDictionary() === true ? scrubResources(doc, resources, memo) : NOTHING;
  if (scan.removed === 0 && inner.copy === null) return NOTHING;

  const dictionary = doc.newDictionary();
  form.forEach((value, key) => {
    if (!REENCODED_KEYS.has(String(key))) dictionary.put(key, value);
  });
  if (inner.copy !== null) dictionary.put('Resources', inner.copy);
  const result = { copy: doc.addStream(scan.bytes, dictionary), removed: scan.removed + inner.removed };
  memo.set(number, result);
  return result;
}

/** The content streams one after another, a line feed between them as a reader joins them. */
function joinStreams(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length + 1, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    joined[at + part.length] = 0x0a;
    at += part.length + 1;
  }
  return joined;
}

/**
 * The page's content streams without the text entries of their marked-content property
 * dictionaries, written as one new stream (the page's own streams may be shared with other
 * pages, so none is edited in place), and its resources scrubbed (`scrubResources`) the same way,
 * as a copy. A page without readable content keeps what it has. Returns how many entries went.
 */
function scrubPage(doc: PDFDocument, page: PDFObject, memo: FormMemo): number {
  const parts = pageContentParts(page);
  const scans = (Array.isArray(parts) ? parts : []).map((part) => scanMarkedContent(part, TEXT_KEYS));
  const removed = scans.reduce((sum, scan) => sum + scan.removed, 0);
  if (removed > 0) page.put('Contents', doc.addStream(joinStreams(scans.map((scan) => scan.bytes)), {}));

  const resources = resolved(page.getInheritable('Resources'));
  const inner = resources?.isDictionary() === true ? scrubResources(doc, resources, memo) : NOTHING;
  if (inner.copy !== null) page.put('Resources', inner.copy);
  return removed + inner.removed;
}

/**
 * What a page that carried a mark keeps outside the erased content: its thumbnail goes, and the
 * tag text (structure elements, marked-content properties, forms — see the file comment) with it.
 * Returns how many tag text entries were removed.
 */
export function scrubRedactedPages(doc: PDFDocument, pageIndices: readonly number[]): number {
  const pages = pageIndices.map((index) => doc.findPage(index));
  let removed = scrubStructure(doc, pages, new Set(pages.map((page) => page.asIndirect())));
  const memo: FormMemo = new Map();
  for (const page of pages) {
    page.delete('Thumb');
    removed += scrubPage(doc, page, memo);
  }
  return removed;
}

/** The operators that show text. */
const SHOW_TEXT: ReadonlySet<string> = new Set(['Tj', 'TJ', "'", '"']);

/**
 * A stream a resource dictionary paints through. `showsText` is true for the ones `applyRedactions`
 * does not edit (a tiling pattern, a soft-mask group); a form XObject is only walked through, for
 * the resources of its own.
 */
interface PaintStream {
  readonly entry: PDFObject;
  readonly showsText: boolean;
}

function paintStreams(resources: PDFObject | null): PaintStream[] {
  const streams: PaintStream[] = [];
  if (resources?.isDictionary() !== true) return streams;
  resolved(resources.get('Pattern'))?.forEach((entry) => {
    streams.push({ entry, showsText: true });
  });
  resolved(resources.get('XObject'))?.forEach((entry) => {
    streams.push({ entry, showsText: false });
  });
  resolved(resources.get('ExtGState'))?.forEach((state) => {
    const mask = resolved(resolved(state)?.get('SMask'));
    if (mask?.isDictionary() === true) streams.push({ entry: mask.get('G'), showsText: true });
  });
  return streams;
}

/** Whether a content stream shows text; one this reader cannot delimit may hold text it cannot see. */
function streamShowsText(stream: PDFObject): boolean {
  const buffer = stream.readStream();
  let content: Uint8Array;
  try {
    content = new Uint8Array(buffer.asUint8Array());
  } finally {
    buffer.destroy();
  }
  const instructions = readInstructions(content);
  return instructions === null || instructions.some((instruction) => SHOW_TEXT.has(instruction.operator));
}

/**
 * Whether a tiling pattern or the group of a soft mask that `page`'s resources reach shows text,
 * through the resources of the forms, patterns and groups on the way too. Redaction removes what
 * the engine paints under a mark and does not edit these streams, so their text is still in the
 * file when it is done; a page for which this is true cannot be reported as redacted.
 */
export function paintResourcesShowText(page: PDFObject): boolean {
  const seen = new Set<string>();
  const pending = paintStreams(resolved(page.getInheritable('Resources')));
  while (pending.length > 0) {
    const { entry, showsText } = pending.pop() as PaintStream;
    if (!entry.isStream()) continue;
    const key = `${entry.asIndirect()}/${showsText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (showsText && streamShowsText(entry)) return true;
    pending.push(...paintStreams(resolved(entry.get('Resources'))));
  }
  return false;
}
