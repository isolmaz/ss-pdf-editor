/**
 * Optional content groups, written (`PLAN.md §5/Phase 4`: "layers (OCG) view/edit",
 * `§5/Phase 1`: the layer palette). The reader half is `src/layers.ts` — the viewer's
 * own `OptionalContentConfig`, which toggles the *session*; this file is the one that
 * changes the document, and the two are deliberately separate: a toggle the user made
 * in the panel must not touch the file until a save writes it (`PLAN.md §3.5`).
 *
 * Written is ISO 32000-2 §8.11.4.3 (the default configuration dictionary) and nothing
 * else:
 *
 *  - `/Root /OCProperties /D /ON` and `/D /OFF` carry the document's default on/off
 *    decision. A layer that must be visible comes **out of `/OFF` and into `/ON`**, one
 *    that must be hidden goes the other way — the pair is what a reader that ignores
 *    usage applications looks at first, so both sides are always written.
 *  - `/D /AS` holds usage application dictionaries (Table 102). An entry whose `/Event`
 *    is `/View` states which groups are **on** for the default view and therefore
 *    overrides `/ON`/`/OFF`; a stale entry would make a toggle silently ineffective.
 *    Every toggled group is taken out of the `/View` entries so the arrays decide, and
 *    those removals are reported. Entries for other events (`/Print` and its own
 *    category) are left exactly as the document had them — a print-state override is a
 *    different feature and is not ours to guess at.
 *  - `/D /Order` is rewritten from the requested names: a flat list of the document's
 *    group references in reading order. The reader's tree is per-level (`layers.ts`
 *    renders `/Order` levels and unnamed ones); the request model is flat, so nested
 *    levels and label entries are flattened and the loss is reported rather than hidden.
 *  - `rename` writes the group's own `/Name` — the name every reader shows, the one the
 *    panel lists, and the one `states`/`order` match on — creating it for a group that
 *    has none yet.
 *
 * A document **without** `/OCProperties` is refused with `unsupported` (and so is one
 * whose `/OCProperties` carries no `/D`): there is no optional content to edit, and
 * inventing a structure would give the file a layer tree its author never wrote. The
 * refusal is a `ToolError`, so the panel shows the app's own `error.unsupported.*`
 * copy — a returned report note could only exist for a call that produced bytes.
 *
 * Text (group names) goes through `text()` from `engines/mupdf-write.ts` (the engine's
 * `newString`: PDFDocEncoding when it fits, UTF-16BE otherwise) — the one encoder every
 * MuPDF writer uses, so Turkish names cannot be broken by a second one (`PLAN.md §9/K3`).
 * The file is edited through MuPDF's object model; group identity is the object number,
 * as it was the reference under pdf-lib.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { ToolError } from 'pdf-shared';
import { mapMupdfError } from '../engines/mupdf';
import {
  openForWrite,
  PRODUCER_LINE,
  readName,
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

export interface LayerStateUpdate {
  readonly name: string;
  readonly visible: boolean;
}

export interface LayerWriteRequest {
  readonly states?: readonly LayerStateUpdate[];
  /** Move a layer in the reading order; index is the new position in the array. */
  readonly order?: readonly string[];
  /** Create a new OCGMd dictionary for an existing OCG, or update its name. */
  readonly rename?: { readonly from: string; readonly to: string };
}

/** One optional content group as the document declares it. */
interface LayerGroup {
  /** The indirect entry from `/OCGs` — what the arrays below list. */
  readonly ref: PDFObject;
  readonly number: number;
  readonly dict: PDFObject;
  /** `/Name` as decoded; `null` when the group has none yet. */
  readonly name: string | null;
}

/** The parts of `/OCProperties` this file reads and rewrites. */
interface LayerProperties {
  readonly ocProperties: PDFObject;
  readonly config: PDFObject;
  readonly groups: readonly LayerGroup[];
  readonly on: PDFObject | null;
  readonly off: PDFObject | null;
  readonly order: PDFObject | null;
  readonly as: PDFObject | null;
}

function refuse(message: string, path: string): never {
  throw new ToolError('unsupported', { engine: 'mupdf', path, engineMessage: message });
}

/** The object number an entry refers to; `null` for a direct value. */
function numberOf(value: PDFObject | undefined): number | null {
  return value?.isIndirect() === true ? value.asIndirect() : null;
}

function dictionaryAt(parent: PDFObject, key: string): PDFObject | null {
  const value = resolved(parent.get(key));
  return value?.isDictionary() === true ? value : null;
}

function arrayAt(parent: PDFObject, key: string): PDFObject | null {
  const value = resolved(parent.get(key));
  return value?.isArray() === true ? value : null;
}

/** `/OCProperties /OCGs`: an array, or the PDF-1.4 form that nests it in a dictionary. */
function readGroups(ocProperties: PDFObject): LayerGroup[] {
  const value = resolved(ocProperties.get('OCGs'));
  const array =
    value?.isArray() === true ? value : value?.isDictionary() === true ? arrayAt(value, 'OCGs') : null;
  if (array === null) return [];
  const groups: LayerGroup[] = [];
  for (let index = 0; index < array.length; index += 1) {
    const entry = array.get(index);
    const number = numberOf(entry);
    if (number === null) continue;
    const dict = resolved(entry);
    if (dict === null || !dict.isDictionary()) continue;
    groups.push({ ref: entry, number, dict, name: readText(dict.get('Name')) });
  }
  return groups;
}

/**
 * `/Root /OCProperties` as this file needs it. A missing `/OCProperties`, or one without
 * a default configuration dictionary, is a refusal: there is nothing to edit, and the
 * only way forward would be to invent the structure of a layer tree.
 */
function readProperties(doc: PDFDocument): LayerProperties {
  const catalog = resolved(doc.getTrailer().get('Root'));
  const ocProperties = catalog === null ? null : dictionaryAt(catalog, 'OCProperties');
  if (ocProperties === null) {
    refuse(
      'the document has no optional content (/Root/OCProperties); a layer tree is not invented for it',
      '/Root/OCProperties',
    );
  }
  const config = dictionaryAt(ocProperties, 'D');
  if (config === null) {
    refuse(
      'the document has /OCProperties but no default configuration dictionary (/D); its layer structure is not rewritten',
      '/Root/OCProperties/D',
    );
  }
  return {
    ocProperties,
    config,
    groups: readGroups(ocProperties),
    on: arrayAt(config, 'ON'),
    off: arrayAt(config, 'OFF'),
    order: arrayAt(config, 'Order'),
    as: arrayAt(config, 'AS'),
  };
}

/** An `/ON`-style array, created on the configuration the first time it is needed. */
function listFor(doc: PDFDocument, config: PDFObject, key: string): PDFObject {
  return arrayAt(config, key) ?? config.put(key, doc.newArray());
}

function contains(array: PDFObject | null, number: number): boolean {
  if (array === null) return false;
  for (let index = 0; index < array.length; index += 1) {
    if (numberOf(array.get(index)) === number) return true;
  }
  return false;
}

/** Every entry of an array that matches `number`, removed from the end so indices stay valid. */
function dropRef(array: PDFObject | null, number: number): boolean {
  if (array === null) return false;
  let dropped = false;
  for (let index = array.length - 1; index >= 0; index -= 1) {
    if (numberOf(array.get(index)) === number) {
      array.delete(index);
      dropped = true;
    }
  }
  return dropped;
}

/** Append a group unless the array already lists it. */
function addRef(array: PDFObject, group: LayerGroup): boolean {
  if (contains(array, group.number)) return false;
  array.push(group.ref);
  return true;
}

/** `/Order` as a flat list of object numbers, labels and nested levels dropped (`lost`, reported). */
interface OrderView {
  readonly numbers: readonly number[];
  /** True when the document's own order carried levels or labels this file cannot keep. */
  readonly structured: boolean;
}

function readOrder(array: PDFObject | null): OrderView {
  const numbers: number[] = [];
  let structured = false;
  const visit = (value: PDFObject): void => {
    const target = resolved(value);
    if (target?.isArray() === true) {
      structured = true;
      for (let index = 0; index < target.length; index += 1) visit(target.get(index));
      return;
    }
    const number = numberOf(value);
    if (number !== null) {
      numbers.push(number);
      return;
    }
    if (!value.isNull()) structured = true;
  };
  if (array !== null) {
    for (let index = 0; index < array.length; index += 1) visit(array.get(index));
  }
  return { numbers, structured };
}

/** Names of the `/ON`/`/OFF` entries, in array order, as the report states them. */
function namesOf(array: PDFObject | null, groups: readonly LayerGroup[]): string[] {
  if (array === null) return [];
  const names: string[] = [];
  for (let index = 0; index < array.length; index += 1) {
    const number = numberOf(array.get(index));
    const group = groups.find((entry) => entry.number === number);
    names.push(group?.name ?? `${number ?? '?'} 0 R`);
  }
  return names;
}

/** A report parameter holding a list: long ones are cut, the panel is where the list lives. */
function summarise(values: readonly string[]): string {
  const joined = values.join(', ');
  return joined.length > 300 ? `${joined.slice(0, 297)}…` : joined;
}

/** A call that changed nothing: same bytes, and the report says so. */
function nothingToDo(bytes: Uint8Array, pageCount: number): OperationOutcome {
  return {
    bytes,
    report: {
      engine: 'mupdf',
      steps: ['load'],
      notes: [
        note('warning', 'op.note.layer.nothing'),
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

function verificationFailed(message: string, cause?: unknown): ToolError {
  return new ToolError(
    'verification-failed',
    { engine: 'mupdf', engineMessage: message },
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Re-open the produced bytes and read the layer state back: the arrays have to say what
 * the request asked for, the order has to start with the groups it named, and a renamed
 * group has to carry its new name. A mismatch is `verification-failed` — the caller keeps
 * the original file and the session stays dirty (`PLAN.md §3.3` rule 5/6).
 */
async function verifyOutput(
  produced: Uint8Array,
  pageCount: number,
  expected: {
    readonly toggled: readonly { readonly name: string; readonly visible: boolean }[];
    readonly order: readonly string[] | null;
    readonly renamed: { readonly from: string; readonly to: string } | null;
  },
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

    let properties: LayerProperties;
    try {
      properties = readProperties(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw verificationFailed(`produced file has no readable layer properties: ${message}`, error);
    }

    for (const update of expected.toggled) {
      for (const group of properties.groups) {
        if (group.name !== update.name) continue;
        const isOn = contains(properties.on, group.number);
        const isOff = contains(properties.off, group.number);
        if (update.visible ? !isOn || isOff : !isOff || isOn) {
          throw verificationFailed(
            `layer "${update.name}" is ${isOn ? 'on' : 'off'} in the produced file, expected ${update.visible ? 'on' : 'off'}`,
          );
        }
      }
    }

    if (expected.order !== null) {
      const producedOrder = readOrder(properties.order).numbers;
      for (const [index, name] of expected.order.entries()) {
        const group = properties.groups.find((entry) => entry.name === name);
        if (group === undefined || producedOrder[index] !== group.number) {
          throw verificationFailed(`the produced /Order does not carry "${name}" at position ${index + 1}`);
        }
      }
    }

    const renamed = expected.renamed;
    if (renamed !== null && !properties.groups.some((group) => group.name === renamed.to)) {
      throw verificationFailed(`no optional content group carries the new name "${renamed.to}"`);
    }
  } finally {
    doc.destroy();
  }
}

/** What an edit pass changed, for the report and the read-back. */
interface LayerEdit {
  readonly notes: OperationNote[];
  readonly steps: string[];
  readonly toggled: { readonly name: string; readonly visible: boolean }[];
  appliedOrder: readonly string[] | null;
  appliedRename: { readonly from: string; readonly to: string } | null;
  missing: number;
}

function editLayers(
  doc: PDFDocument,
  properties: LayerProperties,
  request: {
    readonly states: readonly LayerStateUpdate[];
    readonly order: readonly string[] | null;
    readonly rename: { readonly from: string; readonly to: string } | null;
  },
  context: OperationContext,
): LayerEdit {
  const { states, order, rename } = request;
  const edit: LayerEdit = {
    notes: [],
    steps: ['load'],
    toggled: [],
    appliedOrder: null,
    appliedRename: null,
    missing: 0,
  };
  let viewOverrides = 0;

  if (states.length > 0) {
    for (const [index, update] of states.entries()) {
      throwIfAborted(context.signal);
      const matched = properties.groups.filter((group) => group.name === update.name);
      if (matched.length === 0) continue;
      const on = listFor(doc, properties.config, 'ON');
      const off = listFor(doc, properties.config, 'OFF');
      for (const group of matched) {
        // Both sides are considered: a group in neither array states its BaseState, so
        // moving it into one is a change like any other.
        const wanted = update.visible ? on : off;
        const other = update.visible ? off : on;
        const moved = dropRef(other, group.number);
        const placed = addRef(wanted, group);
        if (!moved && !placed && contains(wanted, group.number)) continue;
        // A /View usage application entry overrides /ON and /OFF (Table 101/102): as long
        // as the group is listed there, the toggle would not take effect. The entries are
        // cleaned rather than rewritten, so the arrays stay the one statement of state.
        if (properties.as !== null) {
          for (let entry = 0; entry < properties.as.length; entry += 1) {
            const application = resolved(properties.as.get(entry));
            if (application === null || !application.isDictionary()) continue;
            if (readName(application.get('Event')) !== 'View') continue;
            if (dropRef(arrayAt(application, 'OCGs'), group.number)) viewOverrides += 1;
          }
        }
        edit.toggled.push({ name: update.name, visible: update.visible });
      }
      context.onProgress?.({
        phase: 'layers',
        labelKey: 'op.progress.layer.write',
        done: index + 1,
        total: states.length,
      });
    }
    edit.steps.push('layer.state');
  }

  if (order !== null) {
    const previous = readOrder(properties.order);
    const named: LayerGroup[] = [];
    let unknown = 0;
    for (const name of order) {
      const group = properties.groups.find((entry) => entry.name === name);
      if (group === undefined) {
        unknown += 1;
        continue;
      }
      if (!named.some((entry) => entry.number === group.number)) named.push(group);
    }
    const omitted = properties.groups.filter(
      (group) => !named.some((entry) => entry.number === group.number),
    );
    const next = [...named, ...omitted];
    /**
     * The document's own order is already exactly this and already flat: nothing to
     * write. A nested or labelled tree is never "already this", because writing it flat
     * is a real change the report has to state.
     */
    const sameOrder =
      !previous.structured &&
      previous.numbers.length === next.length &&
      previous.numbers.every((number, index) => next[index]?.number === number);
    if (!sameOrder) {
      const array = doc.newArray();
      for (const group of next) array.push(group.ref);
      properties.config.put('Order', array);
      edit.appliedOrder = order.filter((name) => properties.groups.some((entry) => entry.name === name));
      edit.steps.push('layer.order');
      if (previous.structured) edit.notes.push(note('lost', 'op.note.layer.orderFlattened'));
      if (unknown > 0) edit.notes.push(note('warning', 'op.note.layer.orderUnknown', { count: unknown }));
      if (omitted.length > 0)
        edit.notes.push(note('warning', 'op.note.layer.orderAppended', { count: omitted.length }));
      edit.notes.push(note('changed', 'op.note.layer.order', { order: summarise(edit.appliedOrder) }));
    } else if (unknown > 0) {
      // The order is what the document already says, so nothing was written; the names
      // that matched no group are still worth stating.
      edit.notes.push(note('warning', 'op.note.layer.orderUnknown', { count: unknown }));
    }
  }

  if (rename !== null) {
    const to = rename.to.trim();
    if (to.length === 0) refuse('a layer name cannot be empty', 'request.rename.to');
    const matched = properties.groups.filter((group) => group.name === rename.from);
    if (matched.length > 0) {
      for (const group of matched) group.dict.put('Name', text(doc, to));
      edit.appliedRename = { from: rename.from, to };
      edit.steps.push('layer.rename');
      edit.notes.push(note('changed', 'op.note.layer.renamed', { from: rename.from, to }));
    }
  }

  // Empty shells go: an /ON, /OFF or /AS entry that states nothing is not a fact about
  // the document, and the arrays are re-read below so the report describes the file.
  if (listFor(doc, properties.config, 'ON').length === 0) properties.config.delete('ON');
  if (listFor(doc, properties.config, 'OFF').length === 0) properties.config.delete('OFF');
  if (properties.as !== null) {
    for (let entry = properties.as.length - 1; entry >= 0; entry -= 1) {
      const application = resolved(properties.as.get(entry));
      const groups = application?.isDictionary() === true ? arrayAt(application, 'OCGs') : null;
      if (groups !== null && groups.length === 0) properties.as.delete(entry);
    }
    if (properties.as.length === 0) properties.config.delete('AS');
  }
  if (properties.order !== null && properties.order.length === 0) properties.config.delete('Order');

  edit.missing =
    (states.length > 0
      ? states.filter((update) => !properties.groups.some((group) => group.name === update.name)).length
      : 0) + (rename !== null && edit.appliedRename === null ? 1 : 0);
  if (edit.missing > 0)
    edit.notes.push(note('warning', 'op.note.layer.nameMissing', { count: edit.missing }));

  const changed =
    edit.toggled.length + (edit.appliedOrder === null ? 0 : 1) + (edit.appliedRename === null ? 0 : 1);
  if (changed > 0) {
    edit.notes.push(
      note('changed', 'op.note.layer.states', {
        on: summarise(namesOf(arrayAt(properties.config, 'ON'), properties.groups)),
        off: summarise(namesOf(arrayAt(properties.config, 'OFF'), properties.groups)),
      }),
    );
    if (viewOverrides > 0)
      edit.notes.push(note('changed', 'op.note.layer.viewOverrides', { count: viewOverrides }));
    if (properties.as !== null) edit.notes.push(note('preserved', 'op.note.layer.usageKept'));
  }
  return edit;
}

/**
 * Toggle layers, reorder them and rename them in the document's **default
 * configuration**. Every part of the request is optional; a call that asks for nothing,
 * whose names all miss, **or whose state the document already states** returns the input
 * bytes unchanged with `incremental: true` (`PLAN.md §3.3` rule 3, the no-op route).
 *
 * The third case is not an optimisation: the layers panel sends the state it is showing
 * every time its button is pressed, so without it a click that changed nothing would
 * still re-serialise the file, journal a version and tell the user a write happened.
 */
export async function applyLayerWrite(
  bytes: Uint8Array,
  request: LayerWriteRequest,
  context: OperationContext,
): Promise<OperationOutcome> {
  throwIfAborted(context.signal);
  const states = request.states ?? [];
  // An empty list asks for no order: writing one would hide every layer from the panel.
  const order = request.order === undefined || request.order.length === 0 ? null : request.order;
  const rename = request.rename ?? null;
  if (states.length === 0 && order === null && rename === null) return nothingToDo(bytes, 0);

  const { doc } = await openForWrite(bytes);
  let out: Uint8Array;
  let pageCount: number;
  let edit: LayerEdit;
  try {
    try {
      pageCount = doc.countPages();
      // The refusal happens here, before anything is written (`ToolError('unsupported')`).
      const properties = readProperties(doc);
      context.onProgress?.({ phase: 'layers', labelKey: 'op.progress.layer.write', done: 0, total: 1 });
      edit = editLayers(doc, properties, { states, order, rename }, context);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw mapMupdfError(error, 'write layers');
    }

    if (edit.toggled.length === 0 && edit.appliedOrder === null && edit.appliedRename === null) {
      // Nothing changed: the input goes back untouched and the warnings are the answer —
      // including `nameMissing`, which the pdf-lib writer computed only after this return.
      const untouched = nothingToDo(bytes, pageCount);
      return {
        ...untouched,
        report: { ...untouched.report, notes: [...edit.notes, ...untouched.report.notes] },
      };
    }

    edit.steps.push('producer');
    edit.notes.push(note('preserved', 'op.note.metadata.producerKept', { producer: PRODUCER_LINE }));
    throwIfAborted(context.signal);
    out = saveRewrite(doc, 'write layers');
  } finally {
    doc.destroy();
  }
  edit.steps.push('save');
  await verifyOutput(out, pageCount, {
    toggled: edit.toggled,
    order: edit.appliedOrder,
    renamed: edit.appliedRename,
  });
  edit.steps.push('verify');
  context.onProgress?.({ phase: 'layers', labelKey: 'op.progress.layer.write', done: 1, total: 1 });

  const report: OperationReport = {
    engine: 'mupdf',
    steps: edit.steps,
    notes: edit.notes,
    inputBytes: bytes.byteLength,
    outputBytes: out.byteLength,
    pageCount,
    // Re-serialised: the incremental fast path is over (`PLAN.md §3.3` rule 3).
    incremental: false,
  };
  return { bytes: out, report };
}
