/**
 * Page composition (the `extractPages` path).
 *
 * This is the one place where a document's page order, rotation and page count
 * change, and it is the reason a page delete is *real* the moment it is applied
 * rather than at save time: what the viewer shows is what the bytes hold.
 *
 * Two rules from the routing table are encoded here:
 *  - the composition runs on the **document that owns the annotation storage**
 *    (`document: null`), because passing byte sources drops storage-backed
 *    annotations (measured: the same document carries 1
 *    `Highlight` through, a byte source 0);
 *  - merge input documents are passed as bytes and are never touched otherwise.
 *
 * Engine rules this file depends on, read out of the installed pdf.js
 * (worker `ExtractPages` + `PDFEditor.extractPages`) rather than assumed,
 * because each of them decides whether a composition succeeds, silently loses a
 * page, or throws:
 *  - an entry whose `document` is *missing* is skipped outright
 *    (`if (!document) continue;`). The base source must therefore carry
 *    `document: null`, which the worker resolves to the primary document — the
 *    very thing that keeps the annotation storage attached;
 *  - `includePages` is compiled into a **Set** and then scanned in ascending
 *    source order, so one entry can neither repeat nor reorder a page. The k-th
 *    copy of a page needs its own entry — the shape pdf.js builds for itself in
 *    `getPageMappingForSaving`;
 *  - `pageIndices` are consumed in that same ascending order, so the positions
 *    inside one entry must be sorted by source page index, and their union over
 *    all entries must be dense `[0, N)` (`sparse pageIndices` is a hard error);
 *  - the call resolves with **`null`** for *any* internal failure (the worker
 *    catches, warns, returns `null`), so a null result is checked explicitly;
 *  - the produced catalog is built fresh (`#makeRoot`): page tree, outline, page
 *    labels, destinations, embedded files, structure tree, AcroForm. Everything
 *    else the source catalog carried — viewer preferences, `Lang`, output
 *    intents, OCG/`OCProperties`, `OpenAction`, `MarkInfo` — is gone, and the
 *    report says so;
 *  - Info is copied from the base document only when the composition is
 *    single-document, and the engine stamps its own `Creator`/`Producer`
 *    (`PDF.js`/`Firefox`), which is why the rotation pass merges the product
 *    producer line back in.
 *
 * The rotation pass and the merge's metadata step run on MuPDF's object model
 * (`engines/mupdf-write.ts`); a composition that turns nothing is only counted, never
 * re-serialised.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { loadMupdf, mapMupdfError, openPdf } from '../engines/mupdf';
import { openForWrite, pageObjects, resolved, saveRewrite } from '../engines/mupdf-write';
import { openWithPdfjs, type PdfDocumentHandle } from '../engines/pdfjs-handle';
import { readFormFields } from './forms';
import {
  note,
  type OperationContext,
  type OperationNote,
  type OperationOutcome,
  throwIfAborted,
} from './types';

/**
 * A malformed outline, a number tree or a hostile file must not turn a
 * measurement into a hang: the counters stop at these bounds.
 */
const MAX_STRUCTURE_ITEMS = 20_000;
const MAX_STRUCTURE_DEPTH = 32;

type Rotation = 0 | 90 | 180 | 270;

export interface ComposeSource {
  /**
   * Document bytes for a merged source. Omitted for the document the
   * composition is applied to — that is what keeps its form values and
   * annotations (`document: null`). Exactly one source is normally the base; the
   * live document is the `handle` passed to `composeDocument`.
   */
  readonly bytes?: Uint8Array;
  /** 0-based pages to include, in output order; repeats duplicate a page. */
  readonly pages: readonly number[];
  /** Explicit output positions, parallel to `pages`; omitted = fill remaining slots in order. */
  readonly positions?: readonly number[];
  /** Rotation added to each page of this source, keyed by output position. */
  readonly rotations?: Readonly<Record<number, 0 | 90 | 180 | 270>>;
}

export interface ComposeOptions {
  readonly sources: readonly ComposeSource[];
  /** Page count of the composed result; must match the sources' page totals. */
  readonly pageCount: number;
}

/** One page of the composition, resolved before any engine work happens. */
interface PlannedPage {
  /** Index into `ComposeOptions.sources`. */
  readonly source: number;
  /** 0-based page inside that source document. */
  readonly page: number;
  /** 0-based position in the composed output. */
  readonly position: number;
  /** Degrees added to the page's own `/Rotate`. */
  readonly rotation: Rotation;
}

interface ComposedEntry {
  /** `null` = the primary document, i.e. the one the handle belongs to. */
  readonly document: Uint8Array | null;
  readonly includePages: number[];
  readonly pageIndices: number[];
}

/** What the base document contributed, read before its handle goes away. */
interface BaseMetadata {
  readonly info: Record<string, unknown>;
  readonly xmp: string | null;
  readonly outline: number;
}

/**
 * The pdf.js surface `composeDocument` needs; `PdfDocumentHandle.raw` satisfies
 * it. The two optional members are read-only measurements the report needs
 * (original data length, outline size) — neither adds engine work of its own.
 */
export interface PdfComposeHandle {
  /**
   * Page count of the base document. This is pdf.js's own name for it
   * (`PDFDocumentProxy.numPages`); the wrapper's `pageCount` lives on
   * `PdfDocumentHandle`, not on the proxy the caller hands over.
   */
  readonly numPages: number;
  /**
   * pdf.js reports every internal failure of a composition by resolving with
   * `null`, so the result is nullable on purpose.
   */
  extractPages(
    pageInfos: readonly {
      readonly document?: Uint8Array | null;
      readonly includePages?: readonly (number | readonly number[])[];
      readonly pageIndices?: readonly number[];
    }[],
    copyLevels?: Int32Array,
  ): Promise<Uint8Array | null>;
  /** `PDFDocumentProxy.getDownloadInfo` — byte length of the loaded file. */
  getDownloadInfo?(): Promise<{ readonly length: number }>;
  /** `PDFDocumentProxy.getOutline` — counted only, so the shape stays loose. */
  getOutline?(): Promise<readonly unknown[] | null>;
}

/**
 * Compose a document from one or more sources. `pdfjs` provides `extractPages`;
 * per-page rotation is applied afterwards with MuPDF (`/Rotate`), because
 * `extractPages` carries no rotation override. `context` needs the live pdf.js
 * handle, which the caller owns — it is passed as the `handle` of the base.
 */
export async function composeDocument(
  options: ComposeOptions,
  handle: PdfComposeHandle,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const baseIndex = options.sources.findIndex((source) => source.bytes === undefined);
  const planned = planPages(options, handle.numPages);
  const rotated = planned.filter((page) => page.rotation !== 0);
  const extraBytes = options.sources.reduce((sum, source) => sum + (source.bytes?.length ?? 0), 0);

  context.onProgress?.({
    phase: 'extract',
    labelKey: 'op.progress.compose.extract',
    done: 0,
    total: planned.length,
  });
  throwIfAborted(context.signal);

  const produced = await handle.extractPages(
    buildEntries(options, planned),
    buildCopyLevels(planned, baseIndex, handle.numPages),
  );
  if (produced === null) {
    throw new ToolError('verification-failed', {
      engine: 'pdfjs',
      engineMessage:
        'extractPages produced no document (page index outside the source, or a document it cannot compose)',
    });
  }

  // When no rotation is asked for, nothing may be written back at all — the page
  // count is read and the engine's bytes go out as they are.
  let bytes: Uint8Array = produced;
  if (rotated.length > 0) {
    const { doc } = await openForWrite(produced);
    try {
      const pages = pageObjects(doc);
      assertPageCount(pages.length, options.pageCount);
      applyRotation(pages, rotated, context);
      // The engine stamped its own producer line; `saveRewrite` puts ours back.
      bytes = saveRewrite(doc, 'composeDocument.rotate');
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'composeDocument.rotate');
    } finally {
      doc.destroy();
    }
  } else {
    assertPageCount(await countPages(produced), options.pageCount);
  }

  const notes: OperationNote[] = [];
  if (baseIndex >= 0) notes.push(note('preserved', 'op.note.compose.storage'));
  notes.push(note('lost', 'op.note.compose.catalog'));
  if (rotated.length > 0) {
    notes.push(note('changed', 'op.note.compose.rotation', { count: rotated.length }));
  }
  const copies = baseCopyLevelCount(planned, baseIndex);
  if (copies > 1 && handle.getOutline !== undefined) {
    // A repeated page is an extra entry over the same document, and the engine
    // merges the outline once per entry (`#buildOutline` walks every collected
    // document): the tree comes out repeated. Measured, so the report states it
    // instead of hiding it.
    const outline = countOutlineItems(await handle.getOutline());
    if (outline > 0) {
      notes.push(note('changed', 'op.note.compose.outlineCopies', { copies }));
    }
  }
  notes.push(note('preserved', 'op.note.compose.verified', { pages: options.pageCount }));

  return {
    bytes,
    report: {
      engine: 'pdfjs',
      steps: rotated.length > 0 ? ['pdfjs.extractPages', 'compose.rotate', 'save'] : ['pdfjs.extractPages'],
      notes,
      inputBytes: extraBytes + (await downloadInfo(handle)),
      outputBytes: bytes.length,
      pageCount: options.pageCount,
      // A composition is a freshly written file, never an incremental update.
      incremental: false,
    },
  };
}

/**
 * Merge several documents into one, preserving outline/labels/attachments where
 * `extractPages` does (each source contributes `includePages`).
 *
 * This one is **byte-based**, and that is the difference from `composeDocument`:
 * the caller hands over a produced buffer whose engine edits are already baked
 * in (the session materialises annotations and form values before a merge), so
 * no annotation storage is involved. The base is still opened as the pdf.js
 * document the composition runs against — `extractPages` is a method of a live
 * document and a merge owns no handle of its own — while the added documents
 * stay byte sources and are never touched.
 *
 * Metadata comes from the base document only: the added documents' Info and XMP
 * are dropped, and the report says so (the source project
 * took `sources[0]` without ever telling the user).
 */
export async function mergeDocuments(
  base: { readonly bytes: Uint8Array; readonly pageCount: number },
  others: readonly { readonly name: string; readonly bytes: Uint8Array; readonly pageCount: number }[],
  insertAfter: number,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  if (!Number.isSafeInteger(insertAfter) || insertAfter < -1) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `insertAfter ${insertAfter} is not a page position`,
    });
  }
  const pageCount = base.pageCount + others.reduce((sum, other) => sum + other.pageCount, 0);
  if (pageCount === 0) {
    throw new ToolError('selection-empty', { engine: 'model', engineMessage: 'nothing to merge' });
  }

  const handle = await openWithPdfjs(base.bytes, { signal: context.signal });
  try {
    context.onProgress?.({
      phase: 'merge',
      labelKey: 'op.progress.merge.documents',
      done: 0,
      total: others.length + 1,
    });
    throwIfAborted(context.signal);

    const entries = [
      { document: null, includePages: everyPage(base.pageCount) },
      // `insertAfter` is a 0-based index of the base sequence (`-1` = in front of
      // everything). The engine turns it into explicit positions; equal values
      // keep the added documents in the order they were given.
      ...others.map((other) => ({
        document: other.bytes.slice(),
        includePages: everyPage(other.pageCount),
        insertAfter,
      })),
    ];
    const produced = await handle.raw.extractPages(entries);
    if (produced === null) {
      throw new ToolError('verification-failed', {
        engine: 'pdfjs',
        engineMessage: 'extractPages produced no document for the merge',
      });
    }

    const baseMetadata = await readBaseMetadata(handle);
    const { doc: document } = await openForWrite(produced);
    let bytes: Uint8Array;
    let structure: StructureMeasure;
    try {
      const actual = document.countPages();
      if (actual !== pageCount) {
        throw new ToolError('verification-failed', {
          engine: 'pdfjs',
          engineMessage: `merged document has ${actual} pages, expected ${pageCount}`,
        });
      }
      applyBaseMetadata(document, baseMetadata);
      // Measured on the document the caller receives, so the numbers describe the
      // file rather than the engine's intent.
      structure = measureStructure(document);
      bytes = saveRewrite(document, 'mergeDocuments');
    } catch (error) {
      throw mapMupdfError(error, 'mergeDocuments');
    } finally {
      document.destroy();
    }
    const notes: OperationNote[] = [note('lost', 'op.note.merge.metadata')];
    notes.push(
      note('preserved', 'op.note.merge.structure', {
        outline: structure.outline,
        labels: structure.labels,
        fields: structure.fields,
      }),
    );
    if (structure.outline < baseMetadata.outline) {
      notes.push(
        note('lost', 'op.note.merge.outlineLost', {
          expected: baseMetadata.outline,
          actual: structure.outline,
        }),
      );
    }
    const sharedFields = await countSharedFieldNames([base.bytes, ...others.map((other) => other.bytes)]);
    if (sharedFields > 0) notes.push(note('changed', 'op.note.merge.sharedFields', { count: sharedFields }));
    notes.push(note('preserved', 'op.note.merge.verified', { pages: pageCount }));

    return {
      bytes,
      report: {
        engine: 'pdfjs',
        steps: ['pdfjs.extractPages', 'metadata', 'save'],
        notes,
        inputBytes: base.bytes.length + others.reduce((sum, other) => sum + other.bytes.length, 0),
        outputBytes: bytes.length,
        pageCount,
        incremental: false,
      },
    };
  } finally {
    await handle.destroy();
  }
}

/**
 * How many fully qualified field names occur in more than one input document. The merge keeps
 * every field, and fields with one name share one value, so typing in one changes the other.
 */
async function countSharedFieldNames(inputs: readonly Uint8Array[]): Promise<number> {
  const documents = new Map<string, number>();
  for (const bytes of inputs) {
    const names = new Set((await readFormFields(bytes)).map((field) => field.name));
    for (const name of names) documents.set(name, (documents.get(name) ?? 0) + 1);
  }
  return [...documents.values()].filter((count) => count > 1).length;
}

/**
 * Resolve every requested page to an output position *before* the engine runs, so
 * the rotation pass and the verification use the layout the engine was given.
 * Positions the caller omitted fill the remaining slots in ascending order,
 * which is what the engine's own auto-fill does.
 */
function planPages(options: ComposeOptions, basePageCount: number): PlannedPage[] {
  const claimed = new Set<number>();
  const slots: { source: number; sourceRef: ComposeSource; page: number; explicit: number | null }[] = [];
  for (const [sourceIndex, source] of options.sources.entries()) {
    for (const [index, page] of source.pages.entries()) {
      if (!Number.isSafeInteger(page) || page < 0) {
        throw new ToolError('range-invalid', {
          engine: 'model',
          engineMessage: `source ${sourceIndex} asks for page index ${page}`,
          path: String(sourceIndex),
        });
      }
      if (source.bytes === undefined && page >= basePageCount) {
        throw new ToolError('range-invalid', {
          engine: 'model',
          engineMessage: `page ${page + 1} is outside the ${basePageCount}-page document`,
          path: String(sourceIndex),
        });
      }
      const explicit = source.positions?.[index] ?? null;
      if (explicit !== null) {
        if (!Number.isSafeInteger(explicit) || explicit < 0 || explicit >= options.pageCount) {
          throw new ToolError('range-invalid', {
            engine: 'model',
            engineMessage: `output position ${explicit} is outside 0…${options.pageCount - 1}`,
            path: String(sourceIndex),
          });
        }
        if (claimed.has(explicit)) {
          throw new ToolError('range-invalid', {
            engine: 'model',
            engineMessage: `output position ${explicit} is claimed twice`,
            path: String(sourceIndex),
          });
        }
        claimed.add(explicit);
      }
      slots.push({ source: sourceIndex, sourceRef: source, page, explicit });
    }
  }
  if (slots.length !== options.pageCount) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `the sources ask for ${slots.length} pages but the result should hold ${options.pageCount}`,
    });
  }

  let cursor = 0;
  return slots.map((slot) => {
    let position = slot.explicit;
    if (position === null) {
      while (claimed.has(cursor)) cursor += 1;
      claimed.add(cursor);
      position = cursor;
    }
    return {
      source: slot.source,
      page: slot.page,
      position,
      rotation: normalizeRotation(slot.sourceRef.rotations?.[position] ?? 0, position),
    };
  });
}

/** Degrees the caller asked for on one output position, or a rejected value. */
function normalizeRotation(value: number, position: number): Rotation {
  if (!Number.isFinite(value) || value % 90 !== 0) {
    throw new ToolError('range-invalid', {
      engine: 'model',
      engineMessage: `rotation ${value} on output position ${position} is not a multiple of 90`,
    });
  }
  return (((value % 360) + 360) % 360) as Rotation;
}

/** Every 0-based page of a document, the `includePages` of a whole-source entry. */
function everyPage(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_unused, page) => page);
}

/**
 * Turn the planned pages into `pageInfos`. One entry per source *and copy level*:
 * a repeated page cannot live inside a single entry (the engine dedupes and
 * sorts its `includePages`), and both the positions inside an entry and the
 * entries themselves must stay in ascending source order.
 */
function buildEntries(options: ComposeOptions, planned: readonly PlannedPage[]): ComposedEntry[] {
  const entries: ComposedEntry[] = [];
  for (const [sourceIndex, source] of options.sources.entries()) {
    const levels: { page: number; position: number }[][] = [];
    const placed = new Map<number, number>();
    for (const page of planned) {
      if (page.source !== sourceIndex) continue;
      const level = placed.get(page.page) ?? 0;
      placed.set(page.page, level + 1);
      while (levels.length <= level) levels.push([]);
      levels[level]?.push({ page: page.page, position: page.position });
    }
    let shared: Uint8Array | null | undefined;
    const documentFor = (): Uint8Array | null => {
      // One disposable copy per source, shared by its entries: the disposable-copy rule keeps the
      // caller's buffer out of the engine, and the worker clones the buffer per
      // entry, so nothing is gained by slicing once more for every copy level.
      if (shared === undefined) shared = source.bytes === undefined ? null : source.bytes.slice();
      return shared;
    };
    // Every level holds a page: a level only exists because one was placed on it.
    for (const level of levels) {
      const ascending = [...level].sort((a, b) => a.page - b.page);
      entries.push({
        document: documentFor(),
        includePages: ascending.map((page) => page.page),
        pageIndices: ascending.map((page) => page.position),
      });
    }
  }
  return entries;
}

/**
 * The rank of every primary-document page among the output pages it produced,
 * `-1` when the page is not in the composition — the meaning pdf.js documents
 * for `copyLevels`. The transport reads it only when the viewer's page mapper
 * has been altered (the viewer itself deleted or pasted pages); the app remounts
 * a fresh engine handle after every composition, so in the normal path this
 * argument changes nothing, and it is passed so the call stays correct if a
 * composition ever runs on a mapper-altered document.
 */
function buildCopyLevels(
  planned: readonly PlannedPage[],
  baseIndex: number,
  pageCount: number,
): Int32Array | undefined {
  if (baseIndex < 0) return undefined;
  const levels = new Int32Array(pageCount).fill(-1);
  for (const page of planned) {
    // `planPages` refused a base page outside `pageCount`.
    if (page.source === baseIndex) levels[page.page] = 0;
  }
  return levels;
}

/** How many engine entries the base document needs — one per page copy level. */
function baseCopyLevelCount(planned: readonly PlannedPage[], baseIndex: number): number {
  const placed = new Map<number, number>();
  let max = 0;
  for (const page of planned) {
    if (page.source !== baseIndex) continue;
    const count = (placed.get(page.page) ?? 0) + 1;
    placed.set(page.page, count);
    max = Math.max(max, count);
  }
  return max;
}

/**
 * Apply the per-page `/Rotate`. The engine copied each source page's own
 * `/Rotate` into the output (`#makePageCopy`), so the requested angle adds to
 * the rotation the page already carries — user rotation on top of
 * the source rotation.
 */
function applyRotation(
  pages: readonly PDFObject[],
  rotated: readonly PlannedPage[],
  context: OperationContext,
): void {
  for (const [index, planned] of rotated.entries()) {
    throwIfAborted(context.signal);
    // `assertPageCount` made the output exactly as long as the plan, so every position exists.
    const page = pages[planned.position] as PDFObject;
    const own = resolved(page.getInheritable('Rotate'));
    const current = own?.isNumber() === true ? own.asNumber() : 0;
    page.put('Rotate', (((current + planned.rotation) % 360) + 360) % 360);
    context.onProgress?.({
      phase: 'rotate',
      labelKey: 'op.progress.compose.rotate',
      done: index + 1,
      total: rotated.length,
    });
  }
}

/** The page count of produced bytes, read without writing anything back. */
async function countPages(bytes: Uint8Array): Promise<number> {
  const mupdf = await loadMupdf();
  const doc = openPdf(mupdf, bytes);
  try {
    return doc.countPages();
  } catch (error) {
    throw mapMupdfError(error, 'composeDocument.verify');
  } finally {
    doc.destroy();
  }
}

function assertPageCount(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new ToolError('verification-failed', {
      engine: 'pdfjs',
      engineMessage: `composed document has ${actual} pages, expected ${expected}`,
    });
  }
}

/** Original data length of the base document; `0` when the handle cannot say. */
async function downloadInfo(handle: PdfComposeHandle): Promise<number> {
  if (handle.getDownloadInfo === undefined) return 0;
  try {
    return (await handle.getDownloadInfo()).length;
  } catch {
    // A handle already being torn down cannot report its length. The report then
    // counts only the byte sources instead of failing an operation that
    // otherwise succeeded.
    return 0;
  }
}

/** Base Info and XMP, plus the outline size used as the merge loss baseline. */
async function readBaseMetadata(handle: PdfDocumentHandle): Promise<BaseMetadata> {
  const metadata = await handle.raw.getMetadata();
  // pdf.js's `getMetadata` always answers an `info` object (empty for a file without an Info
  // dictionary); its values are engine data and are read through `typeof` checks.
  const info = metadata.info as Record<string, unknown>;
  return {
    info,
    xmp: readXmp(metadata.metadata),
    outline: countOutlineItems(await handle.raw.getOutline()),
  };
}

/** pdf.js's `Metadata` instance, typed loosely because it is engine data. */
interface XmpMetadata {
  getRaw(): unknown;
}

function isXmpMetadata(value: unknown): value is XmpMetadata {
  return (
    typeof value === 'object' && value !== null && 'getRaw' in value && typeof value.getRaw === 'function'
  );
}

/** The raw XMP packet as text, or `null` when the document has none. */
function readXmp(metadata: unknown): string | null {
  if (!isXmpMetadata(metadata)) return null;
  const raw = metadata.getRaw();
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/**
 * Write the base document's metadata into the merge result. Info only reaches the
 * output through this step (the engine's `#makeInfo` copies Info for a
 * single-document composition, and a merge is by definition not one), and the XMP
 * packet is never copied by the engine at all.
 */
function applyBaseMetadata(document: PDFDocument, base: BaseMetadata): void {
  for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
    const value = base.info[key];
    // `setMetaData` writes a text string (PDFDocEncoding or UTF-16BE); the producer is
    // replaced by the product line when the file is saved.
    if (typeof value === 'string' && value !== '') document.setMetaData(`info:${key}`, value);
  }
  if (base.xmp !== null) {
    // A raw stream: MuPDF's `compress` leaves XML metadata uncompressed, so a reader
    // that scans for the packet still finds it (`ops/metadata.ts`).
    const packet = new TextEncoder().encode(base.xmp);
    const stream = document.addRawStream(packet, { Type: 'Metadata', Subtype: 'XML' });
    document.getTrailer().get('Root').put('Metadata', stream);
  }
}

interface StructureMeasure {
  /** Outline items, counted over the whole tree. */
  readonly outline: number;
  /** Page-label ranges (`/PageLabels`), counted over the number tree. */
  readonly labels: number;
  /** Top-level form fields (`/AcroForm /Fields`). */
  readonly fields: number;
}

/** Count what the engine claims to merge, on the document that was produced. */
function measureStructure(document: PDFDocument): StructureMeasure {
  const catalog = document.getTrailer().get('Root').resolve();
  return {
    outline: countOutlineTree(catalog.get('Outlines')),
    labels: countNumberTree(catalog.get('PageLabels')),
    fields: countTopLevelFields(catalog.get('AcroForm')),
  };
}

/** The dictionary an entry resolves to, or `undefined`. */
function dictionaryOf(value: PDFObject): PDFObject | undefined {
  const target = resolved(value);
  return target?.isDictionary() === true ? target : undefined;
}

/** A cycle guard key: the object number of an indirect entry, the object itself otherwise. */
function identity(entry: PDFObject, target: PDFObject): number | PDFObject {
  return entry.isIndirect() ? entry.asIndirect() : target;
}

function countOutlineTree(outlines: PDFObject): number {
  const root = dictionaryOf(outlines);
  if (root === undefined) return 0;
  const visited = new Set<number | PDFObject>();
  let total = 0;
  const walk = (first: PDFObject): void => {
    let entry = first;
    let node = dictionaryOf(entry);
    while (node !== undefined && total <= MAX_STRUCTURE_ITEMS) {
      // A `/Next` cycle must end the walk, not hang the operation.
      const key = identity(entry, node);
      if (visited.has(key)) return;
      visited.add(key);
      total += 1;
      walk(node.get('First'));
      entry = node.get('Next');
      node = dictionaryOf(entry);
    }
  };
  walk(root.get('First'));
  return total;
}

/** Page-label ranges live in a number tree: `/Nums` pairs here, `/Kids` below. */
function countNumberTree(value: PDFObject): number {
  const visited = new Set<number | PDFObject>();
  let total = 0;
  const walk = (entry: PDFObject): void => {
    const node = dictionaryOf(entry);
    if (node === undefined || total > MAX_STRUCTURE_ITEMS) return;
    const key = identity(entry, node);
    if (visited.has(key)) return;
    visited.add(key);
    const numbers = resolved(node.get('Nums'));
    if (numbers?.isArray() === true) total += Math.floor(numbers.length / 2);
    const kids = resolved(node.get('Kids'));
    if (kids?.isArray() === true) {
      for (let index = 0; index < kids.length; index += 1) walk(kids.get(index));
    }
  };
  walk(value);
  return total;
}

function countTopLevelFields(acroForm: PDFObject): number {
  const form = dictionaryOf(acroForm);
  if (form === undefined) return 0;
  const fields = resolved(form.get('Fields'));
  return fields?.isArray() === true ? fields.length : 0;
}

/** Outline size of a document, without trusting the engine's node shape. */
function countOutlineItems(nodes: readonly unknown[] | null, depth = 0): number {
  if (nodes === null || depth > MAX_STRUCTURE_DEPTH) return 0;
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (total > MAX_STRUCTURE_ITEMS) return total;
    const items = node !== null && typeof node === 'object' && 'items' in node ? node.items : null;
    total += countOutlineItems(Array.isArray(items) ? items : null, depth + 1);
  }
  return total;
}
