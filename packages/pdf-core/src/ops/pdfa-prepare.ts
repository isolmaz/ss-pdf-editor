/**
 * What the file needs before Ghostscript converts it (`ops/pdfa.ts`).
 *
 * Ghostscript's PDF/A mode is a rewrite, and it is selective about what it carries into the
 * new file. Each step here exists because a fixture lost something, or kept something it
 * should not have, without it (`architecture.md` §5.9):
 *
 *  - **Form fields.** `pdfwrite` drops every widget, field value and all, so a filled form
 *    came back blank. The fields are flattened first (`flattenForm`), which paints each
 *    value into the page, and the leftover widgets (signature fields and push buttons the
 *    flattener refuses) are removed and counted.
 *  - **Script and actions.** An `OpenAction` that ran JavaScript was copied into the new
 *    catalog under a stray `/A` key. Forbidden actions are removed from the catalog, pages,
 *    annotations and outline here, so nothing of them reaches the engine.
 *  - **Annotations.** An annotation without the Print flag was dropped (`Annotation set to
 *    non-printing`), which also took every link and sticky note that never printed. PDF/A
 *    requires the flag, so it is set on the ones that are visible; one that is hidden stays
 *    hidden and is reported as left out. An annotation with no appearance stream (a
 *    highlight some tools write bare) is given one, or removed when none can be drawn.
 *  - **Text mapping.** For a simple TrueType or Type 1 font with an encoding and no
 *    `/ToUnicode`, Ghostscript re-embeds the font as a CID font and loses the character
 *    mapping: copy and search then returned U+FFFD for every letter of those fonts. A
 *    `/ToUnicode` built from the font's own encoding keeps the mapping through.
 *  - **Attachments.** Parts 1 and 2 cannot carry files; part 3 can, but each must name its
 *    relationship to the document and its media type.
 *  - **Encryption.** A PDF/A file cannot be encrypted; a file protected only by an owner
 *    password is written out unprotected, and the report says so.
 *
 * Nothing here touches page content. The pass works on a copy of the bytes it is given.
 */

import type { PDFAnnotation, PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { pageFonts } from '../engines/doc-fonts';
import type { PdfAPartNumber, PdfaDocumentInfo } from '../engines/ghostscript-run';
import { loadMupdf, mapMupdfError, openPdf, savePdf } from '../engines/mupdf';
import { readName, readText, resolved } from '../engines/mupdf-write';
import { flattenForm, readFormFields } from './forms';
import { type OperationContext, throwIfAborted } from './types';

/** What the pass changed, as counts the report turns into sentences. */
export interface PrepareCounters {
  readonly formFieldsFlattened: number;
  /** Widgets left over after flattening (signature fields, push buttons) and removed. */
  readonly widgetsRemoved: number;
  readonly signaturesInvalidated: number;
  /** Script and action entries removed (JavaScript, launch, forms actions…). */
  readonly actionsRemoved: number;
  readonly attachmentsRemoved: readonly string[];
  readonly attachmentsKept: number;
  readonly printFlagged: number;
  readonly appearancesDrawn: number;
  /** Annotation subtype → how many were removed because the part forbids it or no appearance exists. */
  readonly annotationsRemoved: ReadonlyMap<string, number>;
  readonly encryptionRemoved: boolean;
  readonly toUnicodeAdded: number;
}

export interface PreparedInput {
  readonly bytes: Uint8Array;
  readonly info: PdfaDocumentInfo;
  readonly counters: PrepareCounters;
}

const ACTIONS_FORBIDDEN: ReadonlySet<string> = new Set([
  'Launch',
  'Sound',
  'Movie',
  'ResetForm',
  'ImportData',
  'Hide',
  'SetOCGState',
  'Rendition',
  'Trans',
  'GoTo3DView',
  'JavaScript',
  'SetState',
  'NoOp',
]);
const NAMED_ALLOWED: ReadonlySet<string> = new Set(['NextPage', 'PrevPage', 'FirstPage', 'LastPage']);

/** Annotation subtypes no part permits (part 1 also forbids file attachments, handled apart). */
const FORBIDDEN_SUBTYPES: ReadonlySet<string> = new Set([
  'Sound',
  'Movie',
  'Screen',
  '3D',
  'RichMedia',
  'Redact',
  'Watermark',
  'Projection',
]);

function dictionaryAt(parent: PDFObject | null, name: string): PDFObject | null {
  if (parent === null) return null;
  const value = resolved(parent.get(name));
  return value?.isDictionary() === true ? value : null;
}

function numberAt(parent: PDFObject, name: string): number | null {
  const value = resolved(parent.get(name));
  return value?.isNumber() === true ? value.asNumber() : null;
}

/** Whether an action (or a chain of them through `/Next`) holds a type PDF/A forbids. */
function hasForbiddenAction(action: PDFObject | null, depth = 0): boolean {
  const target = resolved(action);
  if (target === null || depth > 16 || !target.isDictionary()) return false;
  const type = readName(target.get('S'));
  if (type !== null && ACTIONS_FORBIDDEN.has(type)) return true;
  if (type === 'Named') {
    const named = readName(target.get('N'));
    if (named === null || !NAMED_ALLOWED.has(named)) return true;
  }
  const next = resolved(target.get('Next'));
  if (next === null) return false;
  if (next.isArray()) {
    for (let index = 0; index < next.length; index += 1) {
      if (hasForbiddenAction(next.get(index), depth + 1)) return true;
    }
    return false;
  }
  return hasForbiddenAction(next, depth + 1);
}

function arrayEntries(array: PDFObject | null): PDFObject[] {
  const target = resolved(array);
  if (target === null || !target.isArray()) return [];
  const out: PDFObject[] = [];
  for (let index = 0; index < target.length; index += 1) out.push(target.get(index));
  return out;
}

/* ------------------------------------------------------------------ *
 * /ToUnicode for simple fonts that have none
 * ------------------------------------------------------------------ */

/** A ToUnicode CMap over one-byte codes. */
export function toUnicodeCMap(byCode: ReadonlyMap<number, number>): string {
  const entries = [...byCode]
    .filter(([code]) => code >= 0 && code <= 0xff)
    .sort(([left], [right]) => left - right)
    .map(([code, point]) => {
      let destination: string;
      if (point > 0xffff) {
        const high = 0xd800 + ((point - 0x10000) >> 10);
        const low = 0xdc00 + ((point - 0x10000) & 0x3ff);
        destination = `${high.toString(16).padStart(4, '0')}${low.toString(16).padStart(4, '0')}`;
      } else destination = point.toString(16).padStart(4, '0');
      return `<${code.toString(16).padStart(2, '0')}> <${destination}>`;
    });
  const blocks: string[] = [];
  for (let at = 0; at < entries.length; at += 100) {
    const chunk = entries.slice(at, at + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<00> <FF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
    '',
  ].join('\n');
}

/** A simple font that lacks a `/ToUnicode`, and the CMap it should get (`toUnicodeCMap`). */
interface ToUnicodeWork {
  readonly id: number;
  readonly cmap: string;
}

/**
 * Find the fonts that need a `/ToUnicode`. This reads **a document of its own**, never the one
 * that is written: reading a page's fonts resolves its XObjects, and MuPDF 1.28.1 saves an
 * image it has resolved as a dictionary without its stream (`doc-fonts.ts`), which turned
 * every picture of a page into a render error. The ids are the same in both documents because
 * both are opened from the same bytes.
 */
function findMissingToUnicode(doc: PDFDocument): ToUnicodeWork[] {
  const work: ToUnicodeWork[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < doc.countPages(); index += 1) {
    for (const font of pageFonts(doc.findPage(index))) {
      const dictionary = resolved(font.ref);
      if (dictionary === null || !dictionary.get('ToUnicode').isNull() || font.codeBytes !== 1) continue;
      // A direct font dictionary cannot be addressed from the other document.
      if (!font.ref.isIndirect()) continue;
      const id = font.ref.asIndirect();
      if (seen.has(id)) continue;
      seen.add(id);
      // `codes` is code point to code; the CMap wants the other way round.
      const byCode = new Map<number, number>();
      for (const [point, code] of font.codes) if (!byCode.has(code)) byCode.set(code, point);
      if (byCode.size > 0) work.push({ id, cmap: toUnicodeCMap(byCode) });
    }
  }
  return work;
}

function addToUnicode(doc: PDFDocument, work: readonly ToUnicodeWork[]): void {
  for (const { id, cmap } of work) {
    doc.newIndirect(id).resolve().put('ToUnicode', doc.addStream(cmap, {}));
  }
}

/* ------------------------------------------------------------------ *
 * Inventory and clean-up
 * ------------------------------------------------------------------ */

function countSignatures(catalog: PDFObject): number {
  const form = dictionaryAt(catalog, 'AcroForm');
  if (form === null) return 0;
  let count = 0;
  const seen = new Set<number>();
  const visit = (field: PDFObject, inherited: string | null, depth: number): void => {
    if (depth > 24) return;
    const id = field.isIndirect() ? field.asIndirect() : -1;
    if (id >= 0) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    const target = resolved(field);
    if (target === null || !target.isDictionary()) return;
    const type = readName(target.get('FT')) ?? inherited;
    if (type === 'Sig' && !target.get('V').isNull()) count += 1;
    for (const kid of arrayEntries(target.get('Kids'))) visit(kid, type, depth + 1);
  };
  for (const field of arrayEntries(form.get('Fields'))) visit(field, null, 0);
  return count;
}

function filespecs(doc: PDFDocument): { readonly name: string; readonly spec: PDFObject }[] {
  let files: Record<string, PDFObject> = {};
  try {
    files = doc.loadNameTree('EmbeddedFiles');
  } catch {
    files = {};
  }
  return Object.entries(files).map(([name, spec]) => ({ name, spec }));
}

/** `/AFRelationship` and a media type on an embedded file, as part 3 requires of each. */
function describeEmbeddedFile(spec: PDFObject): void {
  const target = resolved(spec);
  if (target === null || !target.isDictionary()) return;
  if (readName(target.get('AFRelationship')) === null) target.put('AFRelationship', 'Unspecified');
  const files = dictionaryAt(target, 'EF');
  const stream = files === null ? null : files.get('F').isNull() ? files.get('UF') : files.get('F');
  if (stream !== null && !stream.isNull() && stream.isStream() && readName(stream.get('Subtype')) === null) {
    stream.put('Subtype', 'application/octet-stream');
  }
}

function fileName(spec: PDFObject | null): string {
  const target = resolved(spec);
  if (target === null || !target.isDictionary()) return '?';
  return readText(target.get('UF')) ?? readText(target.get('F')) ?? '?';
}

interface Tally {
  actionsRemoved: number;
  widgetsRemoved: number;
  printFlagged: number;
  attachmentsRemoved: string[];
  attachmentsKept: number;
  annotationsRemoved: Map<string, number>;
}

function removedAnnotation(tally: Tally, subtype: string): void {
  tally.annotationsRemoved.set(subtype, (tally.annotationsRemoved.get(subtype) ?? 0) + 1);
}

function cleanCatalog(doc: PDFDocument, catalog: PDFObject, part: PdfAPartNumber, tally: Tally): void {
  if (hasForbiddenAction(catalog.get('OpenAction'))) {
    catalog.delete('OpenAction');
    tally.actionsRemoved += 1;
  }
  if (!catalog.get('AA').isNull()) {
    catalog.delete('AA');
    tally.actionsRemoved += 1;
  }
  const names = dictionaryAt(catalog, 'Names');
  if (names !== null) {
    let scripts = 0;
    try {
      scripts = Object.keys(doc.loadNameTree('JavaScript')).length;
    } catch {
      scripts = 0;
    }
    if (!names.get('JavaScript').isNull()) {
      names.delete('JavaScript');
      tally.actionsRemoved += Math.max(1, scripts);
    }
  }
  if (!catalog.get('AcroForm').isNull()) catalog.delete('AcroForm');

  const embedded = filespecs(doc);
  if (part === 3) {
    for (const { spec } of embedded) describeEmbeddedFile(spec);
    tally.attachmentsKept += embedded.length;
  } else if (names !== null && !names.get('EmbeddedFiles').isNull()) {
    names.delete('EmbeddedFiles');
    for (const { name } of embedded) tally.attachmentsRemoved.push(name);
  }

  // Outline items with a forbidden action lose the action, not the bookmark.
  const outlines = dictionaryAt(catalog, 'Outlines');
  if (outlines === null) return;
  const seen = new Set<number>();
  const stack: PDFObject[] = [outlines.get('First')];
  let steps = 0;
  while (stack.length > 0 && steps < 100_000) {
    steps += 1;
    const item = stack.pop();
    if (item === undefined || item.isNull()) continue;
    const id = item.isIndirect() ? item.asIndirect() : -1;
    if (id >= 0) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const target = resolved(item);
    if (target === null || !target.isDictionary()) continue;
    if (hasForbiddenAction(target.get('A'))) {
      target.delete('A');
      tally.actionsRemoved += 1;
    }
    stack.push(target.get('Next'));
    stack.push(target.get('First'));
  }
}

function cleanPages(doc: PDFDocument, part: PdfAPartNumber, tally: Tally): void {
  for (let index = 0; index < doc.countPages(); index += 1) {
    const page = doc.findPage(index);
    if (!page.get('AA').isNull()) {
      page.delete('AA');
      tally.actionsRemoved += 1;
    }
    const annotations = resolved(page.get('Annots'));
    if (annotations === null || !annotations.isArray()) continue;
    for (let at = annotations.length - 1; at >= 0; at -= 1) {
      const annotation = resolved(annotations.get(at));
      if (annotation === null || !annotation.isDictionary()) {
        annotations.delete(at);
        continue;
      }
      const subtype = readName(annotation.get('Subtype')) ?? '?';
      if (FORBIDDEN_SUBTYPES.has(subtype)) {
        annotations.delete(at);
        removedAnnotation(tally, subtype);
        continue;
      }
      if (subtype === 'Widget') {
        annotations.delete(at);
        tally.widgetsRemoved += 1;
        continue;
      }
      if (subtype === 'FileAttachment') {
        if (part === 3) {
          describeEmbeddedFile(annotation.get('FS'));
          tally.attachmentsKept += 1;
        } else {
          tally.attachmentsRemoved.push(fileName(annotation.get('FS')));
          annotations.delete(at);
          removedAnnotation(tally, subtype);
          continue;
        }
      }
      if (subtype === 'Popup') continue;
      if (hasForbiddenAction(annotation.get('A'))) {
        annotation.delete('A');
        tally.actionsRemoved += 1;
      }
      if (!annotation.get('AA').isNull()) {
        annotation.delete('AA');
        tally.actionsRemoved += 1;
      }
      // Print on; a hidden, invisible or no-view annotation stays as it is and is left out.
      const flags = numberAt(annotation, 'F') ?? 0;
      if ((flags & 4) === 0 && (flags & (1 | 2 | 32)) === 0) {
        annotation.put('F', flags | 4);
        tally.printFlagged += 1;
      }
    }
  }
}

function hasAppearance(annotation: PDFObject): boolean {
  const appearance = dictionaryAt(annotation, 'AP');
  return appearance !== null && !appearance.get('N').isNull();
}

function isEmptyRect(annotation: PDFObject): boolean {
  const rect = arrayEntries(annotation.get('Rect')).map((entry) => {
    const value = resolved(entry);
    return value?.isNumber() === true ? value.asNumber() : 0;
  });
  return rect.length >= 4 && rect[0] === rect[2] && rect[1] === rect[3];
}

/**
 * Ask MuPDF to draw an annotation's appearance. A bare `update()` does nothing for an
 * annotation read from a file (it is not dirty), so each property setter that does mark it
 * dirty is tried until a stream exists. Each rewrites a property with its own value, so nothing
 * in the annotation changes; `setRect` is left out on purpose: its argument is in page space
 * while `/Rect` is in user space, and writing `getRect()` back moves the annotation.
 */
function drawAppearance(wrapper: PDFAnnotation, drawn: () => boolean): boolean {
  const dirtying: readonly (() => void)[] = [
    () => wrapper.setColor(wrapper.getColor()),
    () => wrapper.setOpacity(wrapper.getOpacity()),
    () => wrapper.setBorderWidth(wrapper.getBorderWidth()),
  ];
  for (const dirty of dirtying) {
    try {
      dirty();
      wrapper.update();
      if (drawn()) return true;
    } catch {
      // This setter does not apply to the annotation's type; the next one may.
    }
  }
  return false;
}

/** Draw the missing appearances; remove an annotation none can be drawn for. */
function drawMissingAppearances(doc: PDFDocument, tally: Tally): number {
  let drawn = 0;
  for (let index = 0; index < doc.countPages(); index += 1) {
    const annotations = resolved(doc.findPage(index).get('Annots'));
    if (annotations === null || !annotations.isArray()) continue;
    const needing: number[] = [];
    for (let at = 0; at < annotations.length; at += 1) {
      const annotation = resolved(annotations.get(at));
      if (annotation === null || !annotation.isDictionary()) continue;
      const subtype = readName(annotation.get('Subtype')) ?? '?';
      if (subtype === 'Popup' || subtype === 'Link' || subtype === 'Widget') continue;
      if (hasAppearance(annotation) || isEmptyRect(annotation)) continue;
      const flags = numberAt(annotation, 'F') ?? 0;
      if ((flags & (1 | 2 | 32)) !== 0) continue; // hidden: left out by the engine
      needing.push(at);
    }
    if (needing.length === 0) continue;
    const page = doc.loadPage(index);
    try {
      const wrappers = page.getAnnotations();
      for (const at of needing.reverse()) {
        const target = annotations.get(at);
        const id = target.isIndirect() ? target.asIndirect() : -1;
        const wrapper = id < 0 ? undefined : wrappers.find((entry) => entry.getObject().asIndirect() === id);
        let ok = false;
        if (wrapper !== undefined) {
          ok = drawAppearance(wrapper, () => hasAppearance(resolved(target) ?? target));
        }
        if (ok) drawn += 1;
        else {
          removedAnnotation(tally, readName(resolved(target)?.get('Subtype')) ?? '?');
          annotations.delete(at);
        }
      }
    } finally {
      page.destroy();
    }
  }
  return drawn;
}

function readInfo(doc: PDFDocument, catalog: PDFObject): PdfaDocumentInfo {
  const text = (key: string): string | null => {
    const value = doc.getMetaData(`info:${key}`);
    return value === undefined || value.trim() === '' ? null : value;
  };
  const date = doc.getMetaData('info:CreationDate')?.trim();
  return {
    title: text('Title'),
    author: text('Author'),
    subject: text('Subject'),
    keywords: text('Keywords'),
    creator: text('Creator'),
    creationDate: date !== undefined && /^D:\d{4}/.test(date) ? date : null,
    language: readText(catalog.get('Lang')),
  };
}

/**
 * Prepare `bytes` for the conversion to PDF/A-`part`. A file that needs a password is refused
 * (`encrypted-unsupported`): its pages cannot be read, so they cannot be converted.
 */
export async function prepareForPdfA(
  bytes: Uint8Array,
  part: PdfAPartNumber,
  context: OperationContext,
): Promise<PreparedInput> {
  throwIfAborted(context.signal);
  const mupdf = await loadMupdf();
  const probe = openPdf(mupdf, bytes);
  let locked: boolean;
  let signatures: number;
  try {
    locked = probe.needsPassword();
    signatures = locked ? 0 : countSignatures(probe.getTrailer().get('Root'));
  } finally {
    probe.destroy();
  }
  if (locked) {
    throw new ToolError('encrypted-unsupported', {
      engine: 'mupdf',
      engineMessage: 'the document needs a password to be read',
    });
  }

  // Fields first: flattening paints each value into its page and rewrites the document.
  let working = bytes;
  let flattened = 0;
  try {
    const fields = await readFormFields(bytes, context.signal);
    const names = fields
      .filter((field) => ['text', 'checkbox', 'dropdown', 'radio', 'optionlist'].includes(field.kind))
      .map((field) => field.name);
    if (names.length > 0) {
      const outcome = await flattenForm(bytes, names, context);
      working = outcome.bytes;
      flattened = names.length;
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    // A form the flattener cannot read is not flattened; its widgets are removed below and
    // the report says the fields were dropped, which is what the output will show.
    flattened = 0;
  }
  throwIfAborted(context.signal);

  const scan = openPdf(mupdf, working);
  let missingToUnicode: ToUnicodeWork[];
  try {
    missingToUnicode = findMissingToUnicode(scan);
  } finally {
    scan.destroy();
  }

  const doc = openPdf(mupdf, working);
  try {
    const catalog = doc.getTrailer().get('Root');
    const encrypted = !doc.getTrailer().get('Encrypt').isNull();
    const tally: Tally = {
      actionsRemoved: 0,
      widgetsRemoved: 0,
      printFlagged: 0,
      attachmentsRemoved: [],
      attachmentsKept: 0,
      annotationsRemoved: new Map(),
    };
    const info = readInfo(doc, catalog);
    cleanCatalog(doc, catalog, part, tally);
    cleanPages(doc, part, tally);
    const appearancesDrawn = drawMissingAppearances(doc, tally);
    addToUnicode(doc, missingToUnicode);
    let prepared: Uint8Array;
    try {
      prepared = savePdf(doc, 'garbage=compact,compress,encrypt=none');
    } catch (error) {
      throw mapMupdfError(error, 'pdfa prepare');
    }
    return {
      bytes: prepared,
      info,
      counters: {
        formFieldsFlattened: flattened,
        widgetsRemoved: tally.widgetsRemoved,
        signaturesInvalidated: signatures,
        actionsRemoved: tally.actionsRemoved,
        attachmentsRemoved: tally.attachmentsRemoved,
        attachmentsKept: tally.attachmentsKept,
        printFlagged: tally.printFlagged,
        appearancesDrawn,
        annotationsRemoved: tally.annotationsRemoved,
        encryptionRemoved: encrypted,
        toUnicodeAdded: missingToUnicode.length,
      },
    };
  } finally {
    doc.destroy();
  }
}
