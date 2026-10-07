/**
 * Embedded files, written ("attachments add/remove"). The reader half is `attachments.ts` — this file is the one
 * that changes the document, and both halves go through the operation contract
 * because both produce a file.
 *
 * Written through MuPDF (`engines/mupdf-write.ts`). Adding uses the engine's
 * `addEmbeddedFile`, which writes the file specification (`/Type /Filespec`, an
 * ASCII-safe `/F`, the Unicode `/UF`, `/EF /F` and `/EF /UF`) and the embedded-file
 * stream with its size and dates; this file adds `/Desc`, puts the
 * `(key, fileSpecRef)` pair into `/Root /Names /EmbeddedFiles /Names` **at its sorted
 * position**, and lists the file spec in `/Root /AF` (the PDF/A-3 associated-files
 * array).
 *
 * MuPDF's own `insertEmbeddedFile` / `deleteEmbeddedFile` are **not** used: they rebuild
 * the whole tree from a JavaScript map, which collapses duplicate keys without saying
 * so, flattens a `/Kids` tree and never touches `/AF`. The tree is edited at the object
 * level instead (ISO 32000-2 §7.7.4 name trees, §7.11.3 file specifications, §14.13
 * embedded files):
 *   1. `/Root /Names` and `/Root /Names /EmbeddedFiles` are read as dictionaries.
 *   2. A `/Kids` entry means the tree is deeper than one level. Both operations refuse
 *      it with `unsupported`: appending would write an illegal second `/Names` array
 *      next to the `/Kids`, and removing could not keep the intermediate `/Limits`
 *      correct.
 *   3. `/EmbeddedFiles /Names` is walked as repeated `(key, value)` pairs. A pair is
 *      removed when its key's decoded text equals the requested name; a duplicated key
 *      loses every copy.
 *   4. The file specification behind the pair is deleted together with the `/EF /F`
 *      and `/EF /UF` streams it reaches, and its reference is dropped from `/Root /AF`.
 *   5. The pair is cut out of the array. When the array ends up empty, the shells it
 *      leaves behind (`/EmbeddedFiles /Names`, `/EmbeddedFiles`, `/Root /Names`, an
 *      empty `/Root /AF`) are removed as well, so a document that lost its last
 *      attachment keeps no name tree for nothing.
 *
 * A name that is not in the tree lands in `missing` — a partial removal is reported,
 * never silently completed or silently failed. When a call changes nothing the
 * **input bytes are returned unchanged** with `incremental: true` (the shape
 * `annotations.ts` already uses for a skipped step): rewriting a file for a no-op
 * would end the incremental fast path for nothing.
 *
 * Key order: a new pair goes before the first key that sorts after it (keys compared
 * as decoded text), so a sorted tree stays sorted. pdf-lib, the previous writer,
 * appended at the end; readers that binary-search a name tree could miss such entries.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  openForWrite,
  producerKeptNote,
  readText,
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

export interface AttachmentAdd {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly description?: string;
}

/** The one path through the catalog this file reads and rewrites. */
interface EmbeddedFilesTree {
  readonly catalog: PDFObject;
  readonly names: PDFObject | null;
  readonly embeddedFiles: PDFObject | null;
  /** The flat `(key, value)` array, `null` when the document carries no attachments. */
  readonly entries: PDFObject | null;
}

function dictionaryAt(parent: PDFObject | null, key: string): PDFObject | null {
  const value = resolved(parent?.get(key));
  return value?.isDictionary() === true ? value : null;
}

function readNameTree(doc: PDFDocument): EmbeddedFilesTree {
  const catalog = resolved(doc.getTrailer().get('Root'));
  if (catalog === null) {
    throw new ToolError('corrupt-document', { engine: 'mupdf', engineMessage: 'no /Root' });
  }
  const names = dictionaryAt(catalog, 'Names');
  const embeddedFiles = dictionaryAt(names, 'EmbeddedFiles');
  if (embeddedFiles !== null && !embeddedFiles.get('Kids').isNull()) {
    throw new ToolError('unsupported', {
      engine: 'mupdf',
      path: '/Root/Names/EmbeddedFiles/Kids',
      engineMessage: 'embedded file name tree is deeper than one level (/Kids node)',
    });
  }
  const entries = resolved(embeddedFiles?.get('Names'));
  return { catalog, names, embeddedFiles, entries: entries?.isArray() === true ? entries : null };
}

/** The tree with every shell present, created where the document had none. */
function ensureNameTree(doc: PDFDocument, tree: EmbeddedFilesTree): EmbeddedFilesTree {
  const names = tree.names ?? tree.catalog.put('Names', doc.newDictionary());
  const embeddedFiles = tree.embeddedFiles ?? names.put('EmbeddedFiles', doc.newDictionary());
  const entries = tree.entries ?? embeddedFiles.put('Names', doc.newArray());
  return { catalog: tree.catalog, names, embeddedFiles, entries };
}

/** The indirect object number an entry refers to, or `null` for a direct value. */
function objectNumber(object: PDFObject): number | null {
  return object.isIndirect() ? object.asIndirect() : null;
}

/**
 * One pair's objects: the file specification, the embedded-file streams it points at
 * through `/EF`, and the document-level `/AF` reference. Removing the pair from the
 * array without this would leave the attachment's bytes in the file.
 */
function discardFileSpec(doc: PDFDocument, tree: EmbeddedFilesTree, pair: PDFObject): void {
  const doomed = new Set<number>();
  const ef = dictionaryAt(resolved(pair), 'EF');
  for (const key of ['F', 'UF']) {
    const stream = ef?.get(key);
    const number = stream === undefined ? null : objectNumber(stream);
    if (number !== null) doomed.add(number);
  }
  const spec = objectNumber(pair);
  if (spec !== null) {
    doomed.add(spec);
    const af = resolved(tree.catalog.get('AF'));
    if (af?.isArray() === true) {
      for (let index = af.length - 1; index >= 0; index -= 1) {
        if (objectNumber(af.get(index)) === spec) af.delete(index);
      }
    }
  }
  // `/EF /F` and `/EF /UF` are normally the same stream: each number is deleted once.
  for (const number of doomed) doc.deleteObject(number);
}

/**
 * Every pair whose key equals `name`, cut out of the tree. Removal runs from the end
 * of the array so the indices collected during the scan stay valid.
 */
function removeEntries(doc: PDFDocument, tree: EmbeddedFilesTree, name: string): boolean {
  const entries = tree.entries;
  if (entries === null) return false;

  const pairs: number[] = [];
  // A trailing key without a value is malformed; the loop simply never reaches it.
  for (let index = 0; index + 1 < entries.length; index += 2) {
    if (readText(entries.get(index)) === name) pairs.push(index);
  }
  if (pairs.length === 0) return false;

  for (const index of pairs.sort((left, right) => right - left)) {
    discardFileSpec(doc, tree, entries.get(index + 1));
    entries.delete(index + 1);
    entries.delete(index);
  }
  return true;
}

/** Insert a pair before the first key that sorts after it. */
function insertEntry(doc: PDFDocument, entries: PDFObject, name: string, spec: PDFObject): void {
  let at = entries.length - (entries.length % 2);
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const key = readText(entries.get(index));
    if (key !== null && key > name) {
      at = index;
      break;
    }
  }
  // `PDFObject` has no insert: the tail is rebuilt behind the new pair.
  const tail: PDFObject[] = [];
  while (entries.length > at) {
    tail.push(entries.get(at));
    entries.delete(at);
  }
  entries.push(text(doc, name));
  entries.push(spec);
  for (const value of tail) entries.push(value);
}

function isEmptyDictionary(object: PDFObject): boolean {
  let empty = true;
  object.forEach(() => {
    empty = false;
  });
  return empty;
}

/** Empty shells left behind by the last removal, dropped so the file stays tidy. */
function pruneTree(tree: EmbeddedFilesTree): void {
  const { catalog, names, embeddedFiles, entries } = tree;
  if (names === null || embeddedFiles === null || entries === null) return;
  if (entries.length === 0) embeddedFiles.delete('Names');
  if (isEmptyDictionary(embeddedFiles)) names.delete('EmbeddedFiles');
  if (isEmptyDictionary(names)) catalog.delete('Names');
  const af = resolved(catalog.get('AF'));
  if (af?.isArray() === true && af.length === 0) catalog.delete('AF');
}

/** A call that changed nothing: same bytes, and the report says so. */
function nothingToDo(bytes: Uint8Array): OperationOutcome {
  return {
    bytes,
    report: {
      engine: 'mupdf',
      steps: ['load'],
      notes: [note('warning', 'op.note.attach.nothing')],
      inputBytes: bytes.byteLength,
      outputBytes: bytes.byteLength,
      pageCount: 0,
      incremental: true,
    },
  };
}

/**
 * Attach files to the document. A name that already exists is replaced — a duplicate
 * key would be an illegal name tree — and the replacement is reported by name.
 */
export async function addAttachments(
  bytes: Uint8Array,
  attachments: readonly AttachmentAdd[],
  context: OperationContext,
): Promise<OperationOutcome & { readonly added: readonly string[] }> {
  throwIfAborted(context.signal);
  if (attachments.length === 0) return { ...nothingToDo(bytes), added: [] };

  context.onProgress?.({
    phase: 'attach',
    labelKey: 'op.progress.attach.add',
    done: 0,
    total: attachments.length,
  });

  const { doc } = await openForWrite(bytes);
  const notes: OperationNote[] = [];
  const added: string[] = [];
  let out: Uint8Array;
  let pageCount: number;
  try {
    try {
      // One tree read for the whole call: every iteration mutates the same array, and
      // `readNameTree` refuses a `/Kids` tree before anything is written.
      const tree = ensureNameTree(doc, readNameTree(doc));
      const entries = tree.entries;
      if (entries === null) throw new ToolError('internal', { engine: 'mupdf', engineMessage: 'no tree' });
      const now = new Date();
      for (const [index, attachment] of attachments.entries()) {
        throwIfAborted(context.signal);
        if (removeEntries(doc, tree, attachment.name)) {
          notes.push(note('changed', 'op.note.attach.replaced', { name: attachment.name }));
        }
        // The engine copies the payload into its own stream; the caller's bytes are
        // never mutated.
        const spec = doc.addEmbeddedFile(attachment.name, attachment.mime, attachment.bytes, now, now);
        if (attachment.description !== undefined && attachment.description !== '') {
          resolved(spec)?.put('Desc', text(doc, attachment.description));
        }
        insertEntry(doc, entries, attachment.name, spec);
        const af = resolved(tree.catalog.get('AF'));
        (af?.isArray() === true ? af : tree.catalog.put('AF', doc.newArray())).push(spec);
        added.push(attachment.name);
        context.onProgress?.({
          phase: 'attach',
          labelKey: 'op.progress.attach.add',
          done: index + 1,
          total: attachments.length,
        });
      }
      pageCount = doc.countPages();
    } catch (error) {
      throw mapMupdfError(error, 'add attachments');
    }

    notes.push(producerKeptNote());
    notes.push(note('changed', 'op.note.attach.added', { count: added.length }));
    throwIfAborted(context.signal);
    out = saveRewrite(doc, 'add attachments');
  } finally {
    doc.destroy();
  }

  const report: OperationReport = {
    engine: 'mupdf',
    steps: ['load', 'attach', 'producer', 'save'],
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: out.byteLength,
    pageCount,
    // Re-serialised: the incremental fast path is over.
    incremental: false,
  };
  return { bytes: out, report, added };
}

/**
 * Remove embedded files by name. The result names what went and what was not there:
 * a partial removal is a fact of the outcome, never a silent one.
 */
export async function removeAttachments(
  bytes: Uint8Array,
  names: readonly string[],
  context: OperationContext,
): Promise<OperationOutcome & { readonly removed: readonly string[]; readonly missing: readonly string[] }> {
  throwIfAborted(context.signal);
  if (names.length === 0) return { ...nothingToDo(bytes), removed: [], missing: [] };

  context.onProgress?.({
    phase: 'attach',
    labelKey: 'op.progress.attach.remove',
    done: 0,
    total: names.length,
  });

  const { doc } = await openForWrite(bytes);
  const notes: OperationNote[] = [];
  const removed: string[] = [];
  const missing: string[] = [];
  let out: Uint8Array;
  let pageCount: number;
  try {
    try {
      const tree = readNameTree(doc);
      for (const [index, name] of names.entries()) {
        throwIfAborted(context.signal);
        if (removeEntries(doc, tree, name)) removed.push(name);
        else missing.push(name);
        context.onProgress?.({
          phase: 'attach',
          labelKey: 'op.progress.attach.remove',
          done: index + 1,
          total: names.length,
        });
      }
      pageCount = doc.countPages();
      if (removed.length > 0) pruneTree(tree);
    } catch (error) {
      throw mapMupdfError(error, 'remove attachments');
    }

    if (removed.length === 0) {
      // Nothing matched: the document goes back untouched (`incremental: true`), with
      // the `missing` list as the whole answer.
      const untouched = nothingToDo(bytes);
      return {
        ...untouched,
        report: { ...untouched.report, pageCount, notes: [...notes, ...untouched.report.notes] },
        removed,
        missing,
      };
    }

    notes.push(producerKeptNote());
    notes.push(note('changed', 'op.note.attach.removed', { count: removed.length }));
    if (missing.length > 0) notes.push(note('warning', 'op.note.attach.missing', { count: missing.length }));
    throwIfAborted(context.signal);
    out = saveRewrite(doc, 'remove attachments');
  } finally {
    doc.destroy();
  }

  const report: OperationReport = {
    engine: 'mupdf',
    steps: ['load', 'remove', 'producer', 'save'],
    notes,
    inputBytes: bytes.byteLength,
    outputBytes: out.byteLength,
    pageCount,
    incremental: false,
  };
  return { bytes: out, report, removed, missing };
}
