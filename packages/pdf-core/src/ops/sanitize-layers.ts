/**
 * Hidden layers, cut out of the file (`sanitize.ts`, "hidden layers").
 *
 * **What is decided here, and how far it can be trusted.** An optional-content group is
 * *hidden* when the document's default configuration switches it off (`/OCProperties /D`:
 * `/BaseState`, `/ON`, `/OFF`, then the `/AS` usage applications of the `/View` event, whose
 * groups follow their own `/Usage /View /ViewState`). Anything drawn under a hidden group is
 * invisible in every viewer that opens the file as it is — and still in the file, which is
 * the leak. Three things carry a group's membership, and each is handled:
 *
 *  1. **Marked content** `/OC /Name BDC … EMC` in a page's or a form XObject's content stream;
 *  2. **A drawn object** whose own dictionary says `/OC` — an image or form `Do`-ne by name;
 *  3. **An annotation** with `/OC`.
 *
 * **Membership dictionaries** (`/OCMD`) are evaluated by their policy (`/P`: AnyOn, AllOn,
 * AnyOff, AllOff). One carrying a visibility expression (`/VE`) is *not* evaluated: the
 * expression language is a second interpreter, and a wrong answer deletes content the reader
 * sees. Such an item is counted as `undecided` and left alone.
 *
 * **Cutting content out without moving anything else.** Removal works at the instruction
 * boundaries of the page's own bytes (`readContentInstructions`, the scanner tagging uses) and
 * keeps every instruction that is not drawing: graphics-state operators (`cm gs Tf rg …`),
 * `q`/`Q`, `BT`/`ET`, text positioning. Only what *puts ink on the page* goes — path painting
 * (a path that is also a clip stays as `… W n`, because a clip is state), text showing, `Do`,
 * `sh` and inline images — so the state the visible content that follows runs under is
 * exactly the state it ran under before. A region is cut only when that argument holds:
 *
 *  - it is closed (its `EMC` exists);
 *  - a text object that shows text starts and ends inside it (a `Tj` removed from a text
 *    object that continues after the region would shift the text that follows, because every
 *    show advances the text matrix);
 *  - it contains no `"` operator (which sets word and character spacing as well as drawing);
 *  - no path is left open at its end.
 *
 * A hidden region that fails one of these stays, and is reported as `left`.
 *
 * **What the removal frees.** A drawing operator that goes takes its resource name with it; a
 * name no remaining content of the same resource dictionary uses is dropped from
 * `/XObject` (and from `/Properties`), which is what lets a hidden picture's bytes leave the
 * file at the save's garbage collection. Resource dictionaries are grouped by identity (a
 * dictionary shared by several pages is judged against all of them). Finally a hidden group
 * nothing else in the file refers to is taken out of `/OCProperties` — a layer name such as
 * "internal comments" is itself information — and the properties go with the last group.
 *
 * **Not handled, said plainly:** content inside tiling patterns, Type 3 glyph procedures and
 * annotation appearance streams is not searched; a group that is hidden only for *printing* or
 * *export* (`/Usage`) is judged by the view state alone.
 */

import type { PDFDocument, PDFObject } from 'mupdf';
import { readName } from '../engines/mupdf-write';
import { type ContentInstruction, readContentInstructions } from './accessibility';
import {
  arrayUnder,
  catalogOf,
  deref,
  dictionaryUnder,
  entriesOf,
  keysOf,
  liveObject,
  reachableObjects,
  referencesInside,
} from './sanitize-graph';
import { throwIfAborted } from './types';

export interface LayerSweep {
  /** Hidden optional-content groups the default configuration switches off. */
  groups: number;
  /** Hidden items met: marked-content sections, drawn objects, annotations. */
  found: number;
  /** Items cut out (a mutating sweep only). */
  removed: number;
  /** Hidden items that stay because cutting them out could not be shown to be exact. */
  left: number;
  /** Items whose visibility the sweep did not decide (visibility expressions, unknown groups). */
  undecided: number;
  /** Content streams the scanner could not delimit; nothing in them was touched. */
  unreadable: number;
  /** Hidden groups whose definition left `/OCProperties`. */
  groupsDropped: number;
}

type Visibility = 'visible' | 'hidden' | 'unknown';

/** The default viewing configuration of the document's optional content. */
class OptionalContent {
  readonly hidden = new Set<number>();
  private readonly off = new Set<number>();

  constructor(
    readonly properties: PDFObject,
    readonly groups: readonly number[],
  ) {}

  static read(doc: PDFDocument): OptionalContent | null {
    const properties = dictionaryUnder(catalogOf(doc), 'OCProperties');
    if (properties === null) return null;
    const groups: number[] = [];
    const list = arrayUnder(properties, 'OCGs');
    if (list !== null) {
      for (const entry of entriesOf(list)) if (entry.isIndirect()) groups.push(entry.asIndirect());
    }
    const content = new OptionalContent(properties, groups);
    content.configure(dictionaryUnder(properties, 'D'));
    return content;
  }

  private configure(config: PDFObject | null): void {
    const numbersIn = (key: string): Set<number> => {
      const list = arrayUnder(config, key);
      const numbers = new Set<number>();
      if (list !== null) {
        for (const entry of entriesOf(list)) if (entry.isIndirect()) numbers.add(entry.asIndirect());
      }
      return numbers;
    };
    const baseOff = readName(config?.get('BaseState')) === 'OFF';
    const on = numbersIn('ON');
    const off = numbersIn('OFF');
    for (const number of this.groups) {
      const isOff = baseOff ? !on.has(number) : off.has(number);
      if (isOff) this.off.add(number);
    }
    // A usage application for the view event hands the decision to each group's own
    // `/Usage /View /ViewState` — the configuration's lists are then only the starting point.
    const applications = arrayUnder(config, 'AS');
    if (applications !== null) {
      for (const entry of entriesOf(applications)) {
        const application = deref(entry);
        if (application === null || !application.isDictionary()) continue;
        if (readName(application.get('Event')) !== 'View') continue;
        const categories = arrayUnder(application, 'Category');
        const viewing =
          categories !== null && entriesOf(categories).some((category) => readName(category) === 'View');
        if (!viewing) continue;
        const members = arrayUnder(application, 'OCGs');
        if (members === null) continue;
        for (const member of entriesOf(members)) {
          if (!member.isIndirect()) continue;
          const state = readName(
            dictionaryUnder(dictionaryUnder(deref(member), 'Usage'), 'View')?.get('ViewState'),
          );
          if (state === 'OFF') this.off.add(member.asIndirect());
          else if (state === 'ON') this.off.delete(member.asIndirect());
        }
      }
    }
    for (const number of this.off) this.hidden.add(number);
  }

  /** Whether a group is drawn: `null` for an entry that is not a group reference. */
  private groupVisible(entry: PDFObject): boolean | null {
    if (!entry.isIndirect()) return null;
    return !this.off.has(entry.asIndirect());
  }

  /** The visibility `/OC` (a group or a membership dictionary) gives what carries it. */
  visibility(entry: PDFObject): Visibility {
    const target = deref(entry);
    if (target === null || !target.isDictionary()) return 'unknown';
    if (readName(target.get('Type')) !== 'OCMD') {
      const visible = this.groupVisible(entry);
      return visible === null ? 'unknown' : visible ? 'visible' : 'hidden';
    }
    if (!target.get('VE').isNull()) return 'unknown';
    const members = target.get('OCGs');
    const listed = deref(members);
    if (listed === null) return 'visible';
    const entries = listed.isArray() ? entriesOf(listed) : [members];
    if (entries.length === 0) return 'visible';
    const states: boolean[] = [];
    for (const member of entries) {
      const visible = this.groupVisible(member);
      if (visible === null) return 'unknown';
      states.push(visible);
    }
    const policy = readName(target.get('P')) ?? 'AnyOn';
    const visible =
      policy === 'AllOn'
        ? states.every(Boolean)
        : policy === 'AnyOff'
          ? states.some((state) => !state)
          : policy === 'AllOff'
            ? states.every((state) => !state)
            : states.some(Boolean);
    return visible ? 'visible' : 'hidden';
  }
}

/** A resource dictionary and what the content that shares it draws with. */
interface ResourceGroup {
  readonly resources: PDFObject | null;
  readonly usedXObjects: Set<string>;
  readonly usedProperties: Set<string>;
  readonly droppedXObjects: Set<string>;
  readonly droppedProperties: Set<string>;
}

interface Context {
  readonly doc: PDFDocument;
  readonly content: OptionalContent;
  readonly mutate: boolean;
  readonly sweep: LayerSweep;
  readonly groups: Map<string, ResourceGroup>;
  readonly forms: Set<number>;
  readonly signal: AbortSignal | undefined;
}

const encoder = new TextEncoder();

/** The scan's cap on nested form XObjects: a document cannot make the walk run away. */
const FORM_DEPTH = 24;

const PAINT_OPERATORS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const PATH_OPERATORS = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
const SHOW_OPERATORS = new Set(['Tj', 'TJ', "'"]);

function groupFor(context: Context, key: string, resources: PDFObject | null): ResourceGroup {
  let group = context.groups.get(key);
  if (group === undefined) {
    group = {
      resources,
      usedXObjects: new Set(),
      usedProperties: new Set(),
      droppedXObjects: new Set(),
      droppedProperties: new Set(),
    };
    context.groups.set(key, group);
  }
  return group;
}

function nameOperand(instruction: ContentInstruction, index: number): string | null {
  const operand = instruction.operands[index];
  return operand?.kind === 'name' ? operand.name : null;
}

/** The entry `/Properties /Name` or `/XObject /Name` of a resource dictionary. */
function resourceEntry(resources: PDFObject | null, category: string, name: string): PDFObject | null {
  const entry = dictionaryUnder(resources, category)?.get(name);
  return entry === undefined || entry.isNull() ? null : entry;
}

interface Region {
  readonly start: number;
  readonly end: number;
  readonly safe: boolean;
  /** The `/Properties` name the region's `BDC` hides itself under. */
  readonly property: string;
}

/**
 * Hidden marked-content sections of one stream: where each starts and ends, and whether
 * cutting it out is exact (see the header). Visibility is asked of `/Properties`.
 */
function findRegions(
  context: Context,
  instructions: readonly ContentInstruction[],
  resources: PDFObject | null,
): Region[] {
  const regions: Region[] = [];
  const stack: boolean[] = [];
  let hiddenDepth = 0;
  let current: { start: number; textStart: number; shows: boolean; quote: boolean; property: string } | null =
    null;
  let text = 0;
  let pathOpen = false;
  for (const [index, instruction] of instructions.entries()) {
    const operator = instruction.operator;
    if (operator === 'BDC') {
      let hiddenBy: string | null = null;
      const property = nameOperand(instruction, 1);
      if (nameOperand(instruction, 0) === 'OC' && property !== null) {
        const entry = resourceEntry(resources, 'Properties', property);
        if (entry !== null) {
          const visibility = context.content.visibility(entry);
          if (visibility === 'hidden') hiddenBy = property;
          else if (visibility === 'unknown') context.sweep.undecided += 1;
        }
      }
      stack.push(hiddenBy !== null);
      if (hiddenBy !== null) {
        hiddenDepth += 1;
        if (hiddenDepth === 1) {
          current = { start: index, textStart: text, shows: false, quote: false, property: hiddenBy };
        }
      }
    } else if (operator === 'BMC') {
      stack.push(false);
    } else if (operator === 'EMC') {
      if (stack.pop() === true) {
        hiddenDepth -= 1;
        if (hiddenDepth === 0 && current !== null) {
          const balanced = text === current.textStart && !pathOpen;
          const safe = balanced && !current.quote && !(current.shows && current.textStart !== 0);
          regions.push({ start: current.start, end: index, safe, property: current.property });
          current = null;
        }
      }
    } else if (operator === 'BT') {
      text += 1;
    } else if (operator === 'ET') {
      text = Math.max(0, text - 1);
    } else if (SHOW_OPERATORS.has(operator)) {
      if (current !== null) current.shows = true;
    } else if (operator === '"') {
      if (current !== null) current.quote = true;
    } else if (PATH_OPERATORS.has(operator)) {
      pathOpen = true;
    } else if (PAINT_OPERATORS.has(operator)) {
      pathOpen = false;
    }
  }
  // A region that never closes cannot be cut: where it would have ended is unknown.
  if (current !== null) {
    regions.push({ start: current.start, end: instructions.length, safe: false, property: current.property });
  }
  return regions;
}

/**
 * What stays of a hidden region once its drawing is gone: every state-setting instruction,
 * unchanged, in order; a clip path as `path W n`; `'` as `T*` (its line move is state).
 */
function keptFromRegion(
  instructions: readonly ContentInstruction[],
  from: number,
  to: number,
  bytes: Uint8Array,
  out: Uint8Array[],
): void {
  let path: ContentInstruction[] = [];
  let clip: string | null = null;
  const copy = (instruction: ContentInstruction): void => {
    out.push(bytes.subarray(instruction.start, instruction.end));
  };
  for (let index = from; index < to; index += 1) {
    const instruction = instructions[index] as ContentInstruction;
    const operator = instruction.operator;
    if (PATH_OPERATORS.has(operator)) {
      path.push(instruction);
    } else if (operator === 'W' || operator === 'W*') {
      clip = operator;
    } else if (PAINT_OPERATORS.has(operator)) {
      if (clip !== null) {
        for (const part of path) copy(part);
        out.push(encoder.encode(`${clip} n`));
      }
      path = [];
      clip = null;
    } else if (operator === "'") {
      out.push(encoder.encode('T*'));
    } else if (
      operator === 'Tj' ||
      operator === 'TJ' ||
      operator === 'Do' ||
      operator === 'sh' ||
      operator === 'BI'
    ) {
      // Ink: dropped.
    } else {
      copy(instruction);
    }
  }
}

function readStreamBytes(stream: PDFObject): Uint8Array | null {
  if (!stream.isStream()) return null;
  const buffer = stream.readStream();
  try {
    return new Uint8Array(buffer.asUint8Array());
  } finally {
    buffer.destroy();
  }
}

function join(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    joined[at + part.length] = 0x0a;
    at += part.length + 1;
  }
  return joined;
}

/**
 * One content stream: finds its hidden regions and hidden `Do`s, follows the visible forms,
 * and returns the stream's new bytes — or `null` when nothing in it changes.
 */
function processStream(
  context: Context,
  bytes: Uint8Array,
  resources: PDFObject | null,
  groupKey: string,
  depth: number,
): Uint8Array | null {
  const instructions = readContentInstructions(bytes);
  if (instructions === null) {
    context.sweep.unreadable += 1;
    return null;
  }
  const group = groupFor(context, groupKey, resources);
  const regions = findRegions(context, instructions, resources);
  const out: Uint8Array[] = [];
  let changed = false;
  let next = 0;
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index] as ContentInstruction;
    const region = regions[next];
    if (region !== undefined && region.start === index) {
      next += 1;
      context.sweep.found += 1;
      if (region.safe) {
        context.sweep.removed += context.mutate ? 1 : 0;
        changed = true;
        const inner = region.end;
        keptFromRegion(instructions, index + 1, inner, bytes, out);
        // Properties and XObjects used only inside the region are released with it; the
        // ones the kept (nested marked-content) instructions name are counted below.
        for (let at = index + 1; at < inner; at += 1) {
          const inside = instructions[at] as ContentInstruction;
          const name = nameOperand(inside, 0);
          if (inside.operator === 'Do' && name !== null) group.droppedXObjects.add(name);
          else noteUse(group, inside);
        }
        group.droppedProperties.add(region.property);
        index = inner;
        continue;
      }
      context.sweep.left += 1;
      // An unreadable-to-cut region stays whole; what it names is still used.
      for (let at = index; at <= region.end && at < instructions.length; at += 1) {
        noteUse(group, instructions[at] as ContentInstruction);
      }
      for (let at = index; at <= region.end && at < instructions.length; at += 1) {
        out.push(
          bytes.subarray(
            (instructions[at] as ContentInstruction).start,
            (instructions[at] as ContentInstruction).end,
          ),
        );
      }
      index = Math.min(region.end, instructions.length - 1);
      continue;
    }
    if (instruction.operator === 'Do') {
      const name = nameOperand(instruction, 0);
      const entry = name === null ? null : resourceEntry(resources, 'XObject', name);
      if (name !== null && entry !== null) {
        const visibility = ocVisibility(context, entry);
        if (visibility === 'hidden') {
          context.sweep.found += 1;
          context.sweep.removed += context.mutate ? 1 : 0;
          group.droppedXObjects.add(name);
          changed = true;
          continue;
        }
        if (visibility === 'unknown') context.sweep.undecided += 1;
        group.usedXObjects.add(name);
        visitForm(context, entry, resources, groupKey, depth + 1);
      }
    } else {
      noteUse(group, instruction);
    }
    out.push(bytes.subarray(instruction.start, instruction.end));
  }
  return changed ? join(out) : null;
}

/** Names a kept instruction draws with, so a resource it still needs is not dropped. */
function noteUse(group: ResourceGroup, instruction: ContentInstruction): void {
  if (instruction.operator === 'Do') {
    const name = nameOperand(instruction, 0);
    if (name !== null) group.usedXObjects.add(name);
  } else if (instruction.operator === 'BDC' || instruction.operator === 'DP') {
    const name = nameOperand(instruction, 1);
    if (name !== null) group.usedProperties.add(name);
  }
}

/** The visibility an XObject's own `/OC` gives it (`visible` when it has none). */
function ocVisibility(context: Context, entry: PDFObject): Visibility {
  const target = deref(entry);
  if (target === null || !target.isDictionary()) return 'visible';
  const oc = target.get('OC');
  return oc.isNull() ? 'visible' : context.content.visibility(oc);
}

/** A visible form XObject: its own content is searched for hidden sections too. */
function visitForm(
  context: Context,
  entry: PDFObject,
  parent: PDFObject | null,
  parentKey: string,
  depth: number,
): void {
  if (!entry.isIndirect() || depth > FORM_DEPTH) return;
  const number = entry.asIndirect();
  if (context.forms.has(number)) return;
  context.forms.add(number);
  const dictionary = deref(entry);
  if (dictionary === null || readName(dictionary.get('Subtype')) !== 'Form') return;
  const own = dictionary.get('Resources');
  const resources = own.isNull() ? parent : deref(own);
  const key = own.isNull() ? parentKey : own.isIndirect() ? `r${own.asIndirect()}` : `f${number}`;
  const bytes = readStreamBytes(entry);
  if (bytes === null) return;
  const rewritten = processStream(context, bytes, resources, key, depth);
  if (rewritten !== null && context.mutate) {
    dictionary.delete('Filter');
    dictionary.delete('DecodeParms');
    entry.writeStream(rewritten);
  }
}

/** Which resource dictionary a page draws with: shared ones share a key. */
function pageResourceKey(page: PDFObject): { key: string; resources: PDFObject | null } {
  let node: PDFObject | null = page;
  for (let guard = 0; node !== null && guard < 64; guard += 1) {
    const own = node.get('Resources');
    if (!own.isNull()) {
      const resources = deref(own);
      const holder = node.isIndirect() ? node.asIndirect() : -1;
      return { key: own.isIndirect() ? `r${own.asIndirect()}` : `p${holder}`, resources };
    }
    node = deref(node.get('Parent'));
  }
  return { key: 'none', resources: null };
}

/** A page's content streams, joined; `null` when it has none, `undefined` when one is not a stream. */
function pageContent(page: PDFObject): Uint8Array | null | undefined {
  const contents = page.get('Contents');
  if (contents.isNull()) return null;
  const entries: PDFObject[] = [];
  const target = contents.isStream() ? null : deref(contents);
  if (target?.isArray() === true) entries.push(...entriesOf(target));
  else entries.push(contents);
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const bytes = readStreamBytes(entry);
    if (bytes === null) return undefined;
    parts.push(bytes);
  }
  return join(parts);
}

/** Hidden annotations of a page. A widget stays (taking it out would orphan its field). */
function sweepAnnotations(context: Context, page: PDFObject): void {
  const annotations = arrayUnder(page, 'Annots');
  if (annotations === null) return;
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const entry = annotations.get(index);
    const annotation = deref(entry);
    if (annotation === null || !annotation.isDictionary()) continue;
    const oc = annotation.get('OC');
    if (oc.isNull()) continue;
    const visibility = context.content.visibility(oc);
    if (visibility === 'unknown') {
      context.sweep.undecided += 1;
      continue;
    }
    if (visibility !== 'hidden') continue;
    context.sweep.found += 1;
    if (readName(annotation.get('Subtype')) === 'Widget') {
      context.sweep.left += 1;
      continue;
    }
    if (!context.mutate) continue;
    annotations.delete(index);
    if (entry.isIndirect()) context.doc.deleteObject(entry.asIndirect());
    context.sweep.removed += 1;
  }
}

/** Drop the resource names nothing draws with any more. */
function pruneResources(groups: ReadonlyMap<string, ResourceGroup>): void {
  for (const group of groups.values()) {
    if (group.resources === null) continue;
    const prune = (category: string, dropped: ReadonlySet<string>, used: ReadonlySet<string>): void => {
      const entries = dictionaryUnder(group.resources, category);
      if (entries === null) return;
      for (const name of dropped) if (!used.has(name)) entries.delete(name);
    };
    prune('XObject', group.droppedXObjects, group.usedXObjects);
    prune('Properties', group.droppedProperties, group.usedProperties);
  }
}

/** Remove a set of group references from an array, nested arrays included. */
function dropGroups(array: PDFObject, doomed: ReadonlySet<number>): void {
  for (let index = array.length - 1; index >= 0; index -= 1) {
    const entry = array.get(index);
    if (entry.isIndirect()) {
      if (doomed.has(entry.asIndirect())) array.delete(index);
    } else if (entry.isArray()) {
      dropGroups(entry, doomed);
    }
  }
}

/**
 * Take hidden groups nothing else refers to out of `/OCProperties`. A group something still
 * refers to — a membership dictionary that could not be evaluated, a resource entry that was
 * kept — stays: dropping it would leave that reference pointing at nothing.
 */
function dropHiddenGroups(context: Context): number {
  const { doc, content } = context;
  const doomed = new Set<number>();
  if (content.hidden.size === 0) return 0;
  const { reached } = reachableObjects(doc, 'OCProperties', context.signal);
  const stillUsed = new Set<number>();
  const root = doc.getTrailer().get('Root');
  const rootNumber = root.isIndirect() ? root.asIndirect() : -1;
  for (const number of reached) {
    // The catalog is read below, without its `/OCProperties` entry.
    if (number === rootNumber) continue;
    const object = liveObject(doc, number);
    if (object === null || object === 'unreadable') continue;
    referencesInside(object, (target) => {
      if (content.hidden.has(target)) stillUsed.add(target);
    });
  }
  // The catalog itself is walked without its `/OCProperties` entry but its other entries count.
  referencesInside(
    root,
    (target) => {
      if (content.hidden.has(target)) stillUsed.add(target);
    },
    (key) => key === 'OCProperties',
  );
  for (const number of content.hidden) if (!stillUsed.has(number)) doomed.add(number);
  if (doomed.size === 0) return 0;

  const properties = content.properties;
  // Something is hidden, and only the default configuration's lists and applications hide a
  // group (`configure`), so `/D` is there.
  const configs: PDFObject[] = [dictionaryUnder(properties, 'D') as PDFObject];
  const alternates = arrayUnder(properties, 'Configs');
  if (alternates !== null) {
    for (const entry of entriesOf(alternates)) {
      const config = deref(entry);
      if (config?.isDictionary() === true) configs.push(config);
    }
  }
  const lists = arrayUnder(properties, 'OCGs');
  if (lists !== null) dropGroups(lists, doomed);
  for (const config of configs) {
    for (const key of keysOf(config)) {
      const value = deref(config.get(key));
      if (value?.isArray() !== true) continue;
      if (key === 'AS') {
        // Usage applications name groups inside their own `/OCGs` arrays.
        for (const application of entriesOf(value)) {
          const members = arrayUnder(deref(application), 'OCGs');
          if (members !== null) dropGroups(members, doomed);
        }
      } else {
        dropGroups(value, doomed);
      }
    }
  }
  for (const number of doomed) doc.deleteObject(number);
  if (lists !== null && lists.length === 0) catalogOf(doc)?.delete('OCProperties');
  return doomed.size;
}

/**
 * Find (and, when `mutate`, cut out) the content of every hidden layer. A document without
 * optional content answers all zeros without reading a content stream.
 */
export function sweepHiddenLayers(doc: PDFDocument, mutate: boolean, signal?: AbortSignal): LayerSweep {
  const sweep: LayerSweep = {
    groups: 0,
    found: 0,
    removed: 0,
    left: 0,
    undecided: 0,
    unreadable: 0,
    groupsDropped: 0,
  };
  const content = OptionalContent.read(doc);
  if (content === null) return sweep;
  sweep.groups = content.hidden.size;
  const context: Context = {
    doc,
    content,
    mutate,
    sweep,
    groups: new Map(),
    forms: new Set(),
    signal,
  };

  const pages = doc.countPages();
  for (let pageIndex = 0; pageIndex < pages; pageIndex += 1) {
    if (signal !== undefined) throwIfAborted(signal);
    const page = doc.findPage(pageIndex);
    sweepAnnotations(context, page);
    const bytes = pageContent(page);
    if (bytes === null) continue;
    if (bytes === undefined) {
      sweep.unreadable += 1;
      continue;
    }
    const { key, resources } = pageResourceKey(page);
    const rewritten = processStream(context, bytes, resources, key, 0);
    if (rewritten !== null && mutate) page.put('Contents', doc.addStream(rewritten, {}));
  }

  if (mutate) {
    pruneResources(context.groups);
    sweep.groupsDropped = dropHiddenGroups(context);
  }
  return sweep;
}
